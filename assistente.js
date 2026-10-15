'use strict';
// Cliente do "assistente de áudio" (opcional, só Windows): deixa escolher quais aplicativos entram no som
// da transmissão. Fala com o assistente por WebSocket LOCAL (127.0.0.1) e só conecta quando o usuário
// escolhe "Escolher aplicativos", então quem usa o áudio normal nunca toca nisso.
//
// Fluxo do áudio: assistente (captura por aplicativo do Windows) -> PCM 16 bits/48 kHz -> AudioWorklet aqui
// -> MediaStreamAudioDestination -> faixa de áudio da transmissão.
(function () {
  const PORTA = 17653;
  const URL_WS = 'ws://127.0.0.1:' + PORTA;

  const CODIGO_WORKLET = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000; this.L = new Float32Array(this.cap); this.R = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.n = 0; this.tocando = false;
    this.port.onmessage = (e) => {
      const i16 = new Int16Array(e.data), frames = i16.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.n >= this.cap) { this.r = (this.r + 1) % this.cap; this.n--; }
        this.L[this.w] = i16[2 * i] / 32768; this.R[this.w] = i16[2 * i + 1] / 32768;
        this.w = (this.w + 1) % this.cap; this.n++;
      }
      if (this.n > 12000) { const d = this.n - 3840; this.r = (this.r + d) % this.cap; this.n -= d; } // atraso demais: volta ao "ao vivo"
    };
  }
  process(inputs, outputs) {
    const o = outputs[0], L = o[0], R = o[1] || o[0];
    if (!this.tocando && this.n >= 2400) this.tocando = true; // espera ~50 ms de folga antes de tocar
    for (let i = 0; i < L.length; i++) {
      if (this.tocando && this.n > 0) { L[i] = this.L[this.r]; R[i] = this.R[this.r]; this.r = (this.r + 1) % this.cap; this.n--; }
      else { L[i] = 0; R[i] = 0; this.tocando = false; }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);`;

  const A = {
    estado: 'parado',       // 'parado' | 'procurando' | 'conectado'
    apps: [],               // aplicativos com áudio: { pid, nome, exe, nivel, tocando }
    estadoHelper: null,
    capturando: false,
    sel: [], modo: 'incluir', // seleção: nomes de executáveis (exe) e modo ('incluir' | 'excluir')
    jaUsou: false,          // já conectou alguma vez neste navegador (o assistente está instalado)
    _ws: null, _quer: false, _timer: null, _ctx: null, _node: null, _dest: null, _ultimo: '', _ouvintes: [],
  };

  try { A.jaUsou = localStorage.getItem('assistenteOk') === '1'; } catch {}
  A.aoMudar = (fn) => A._ouvintes.push(fn);
  const avisar = () => A._ouvintes.forEach((f) => { try { f(); } catch {} });

  // ---------- conexão ----------
  A.ligar = function () {
    A._quer = true;
    if (A._ws && (A._ws.readyState === 0 || A._ws.readyState === 1)) return;
    if (A.estado !== 'conectado') { A.estado = 'procurando'; avisar(); }
    let ws;
    try { ws = new WebSocket(URL_WS); } catch { return reagendar(); }
    ws.binaryType = 'arraybuffer';
    A._ws = ws;
    ws.onopen = () => { A.estado = 'conectado'; A._ultimo = ''; A.jaUsou = true; try { localStorage.setItem('assistenteOk', '1'); } catch {} if (A.capturando) A.aplicarSelecao(true); avisar(); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.tipo === 'apps') { A.apps = m.apps || []; A.estadoHelper = m.estado || null; if (A.capturando) A.aplicarSelecao(false); avisar(); }
      } else if (A._node) {
        A._node.port.postMessage(ev.data, [ev.data]);
      }
    };
    ws.onclose = () => { if (A._ws === ws) { A._ws = null; A.apps = []; if (A._quer) { A.estado = 'procurando'; reagendar(); } else A.estado = 'parado'; avisar(); } };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  function reagendar() {
    clearTimeout(A._timer);
    if (A._quer) A._timer = setTimeout(A.ligar, 2500);
  }
// Pede ao Windows para abrir o assistente (endereço registrado pelo instalador). Roda sem janela e fecha sozinho
  // quando a página é fechada. Precisa ser chamado a partir de um clique do usuário.
  A.abrirPeloProtocolo = function () {
    try { location.href = 'compartilhartela-audio://iniciar'; } catch {}
    A.ligar();
  };
  A.desligar = function () {
    A._quer = false; clearTimeout(A._timer);
    if (A._ws) { try { A._ws.close(); } catch {} A._ws = null; }
    A.estado = 'parado'; A.apps = []; avisar();
  };

  // ---------- seleção ----------
  const chave = (s) => String(s || '').toLowerCase();
  // Converte os nomes escolhidos nos PIDs que estão abertos agora (o PID muda a cada vez que o app abre).
  A.pidsSelecionados = function () {
    const nomes = A.sel.map(chave);
    const pids = A.apps.filter((a) => nomes.includes(chave(a.exe))).map((a) => a.pid);
    return A.modo === 'excluir' ? pids.slice(0, 1) : pids;
  };
  A.aplicarSelecao = function (forcar) {
    if (!A._ws || A._ws.readyState !== 1) return;
    const msg = { cmd: 'escolher', modo: A.modo, pids: A.pidsSelecionados() };
    const txt = JSON.stringify(msg);
    if (!forcar && txt === A._ultimo) return;
    A._ultimo = txt;
    A._ws.send(txt);
  };
  A.definirSelecao = function (sel, modo) {
    A.sel = sel.slice(); A.modo = modo;
    A.aplicarSelecao(false);
    avisar();
  };

  // ---------- áudio ----------
  // Cria a faixa de áudio da transmissão alimentada pelo assistente.
  A.iniciarCaptura = async function () {
    if (A.estado !== 'conectado') {
      A.ligar();
      for (let i = 0; i < 40 && A.estado !== 'conectado'; i++) await new Promise((r) => setTimeout(r, 200));
      if (A.estado !== 'conectado') throw new Error('assistente de áudio não encontrado');
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest); // não conecta ao destino padrão: nada toca nas caixas de som
    A._ctx = ctx; A._node = node; A._dest = dest;
    A.capturando = true;
    A.aplicarSelecao(true);
    return dest.stream.getAudioTracks()[0];
  };
  A.pararCaptura = function () {
    const tinha = A.capturando;
    A.capturando = false; A._ultimo = '';
    if (tinha && A._ws && A._ws.readyState === 1) { try { A._ws.send(JSON.stringify({ cmd: 'parar' })); } catch {} }
    if (A._node) { try { A._node.disconnect(); } catch {} A._node = null; }
    if (A._ctx) { A._ctx.close().catch(() => {}); A._ctx = null; }
    A._dest = null;
  };

  window.Assistente = A;
})();
