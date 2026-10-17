'use strict';

// ---------- Configuração ----------
const MAX_ESPECTADORES = 10;
const MAX_DIRETOS = 3; // conexões que o host codifica; os demais recebem repassado por outro espectador
const MAX_FILHOS = 3; // quantos espectadores cada repassador atende
const PREFIXO_ID = 'ctela-'; // evita colisão de IDs no servidor público do PeerJS
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
const RESOLUCOES = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };

// STUN público. Para conexões que não fecham direto, dá para acrescentar um TURN
// próprio guardando em localStorage 'iceExtra' um JSON, ex.:
// [{"urls":"turn:meu.servidor:3478","username":"u","credential":"s"}]
function iceServers() {
  const base = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  try {
    const extra = JSON.parse(localStorage.getItem('iceExtra') || '[]');
    if (Array.isArray(extra)) base.push(...extra);
  } catch {}
  return base;
}

// ---------- Qualidade ----------
// Escolha do usuário (resolução/fps/áudio), guardada entre visitas.
const escolha = { res: 720, fps: 30, audio: true, auto: true, repasse: true, audioModo: 'captura', appsSel: [], appsModo: 'incluir' };
try { Object.assign(escolha, JSON.parse(localStorage.getItem('escolha') || '{}')); } catch {}
// O áudio sempre começa em "todo o áudio" (o padrão); escolher aplicativos é opcional e só vale na sessão.
escolha.audioModo = 'captura';
if (!Array.isArray(escolha.appsSel)) escolha.appsSel = [];
if (escolha.appsModo !== 'excluir') escolha.appsModo = 'incluir';

// Bitrate-base ≈ pixels × fps × 0,075 bits/pixel (720p30 ≈ 2 Mbps).
function kbpsBase(res, fps) {
  const [w, h] = RESOLUCOES[res];
  return Math.round((w * h * fps * 0.075) / 1000);
}

// Níveis de degradação automática (0 = qualidade escolhida). Cada nível reduz bitrate, fps e resolução.
const NIVEIS = [
  { f: 1,   fpsMax: 60, esc: 1 },
  { f: 0.7, fpsMax: 60, esc: 1 },
  { f: 0.5, fpsMax: 30, esc: 1.25 },
  { f: 0.35, fpsMax: 24, esc: 1.5 },
  { f: 0.2, fpsMax: 15, esc: 2 },
];

// Reduz conforme o nº de espectadores (o upload de quem compartilha é o gargalo)
// e conforme o nível de degradação causado pela rede.
function perfil(n) {
  const nivel = host && escolha.auto !== false ? host.nivel || 0 : 0;
  const N = NIVEIS[nivel];
  const base = kbpsBase(escolha.res, escolha.fps);
  let fator = 1, escala = 1;
  if (n >= 7) { fator = 0.5; escala = escolha.res >= 720 ? 1.5 : 1; }
  else if (n >= 4) fator = 0.7;
  const kbps = Math.max(150, Math.round(base * fator * N.f));
  const fps = Math.min(escolha.fps, N.fpsMax);
  escala *= N.esc;
  const alt = Math.round(RESOLUCOES[escolha.res][1] / escala);
  const mbps = kbps >= 1000 ? (kbps / 1000).toFixed(1).replace('.', ',') + ' Mbps' : kbps + ' kbps';
  return { kbps, fps, escala, nivel, rotulo: `${alt}p · ${fps} fps · ${mbps}`, curto: `${alt}p·${fps}` };
}

// Ajusta o SDP do vídeo: prefere H.264 (codificação por hardware na maioria dos PCs)
// e define bitrate inicial/mínimo, senão o WebRTC começa em ~300 kbps e fica borrado.
function ajustarSdp(sdp, kbps) {
  const linhas = sdp.split('\r\n');
  const ini = linhas.findIndex((l) => l.startsWith('m=video'));
  if (ini < 0) return sdp;
  let fim = linhas.findIndex((l, i) => i > ini && l.startsWith('m='));
  if (fim < 0) fim = linhas.length;
  const bloco = linhas.slice(ini, fim);

  // coloca os payloads H.264 na frente da lista de preferência
  const h264 = [];
  bloco.forEach((l) => {
    const m = l.match(/^a=rtpmap:(\d+) H264\/90000/);
    if (m) h264.push(m[1]);
  });
  const pts = bloco[0].split(' ');
  let fmts = pts.slice(3);
  if (h264.length) fmts = [...h264.filter((p) => fmts.includes(p)), ...fmts.filter((p) => !h264.includes(p))];
  bloco[0] = [...pts.slice(0, 3), ...fmts].join(' ');

  // início em 60% do alvo e mínimo baixo: com internet ruim o navegador precisa poder descer
  // bastante, senão ele insiste em enviar mais do que a rede aguenta e a imagem trava.
  const extra = `x-google-start-bitrate=${Math.round(kbps * 0.6)};x-google-min-bitrate=${Math.min(150, Math.round(kbps * 0.15))}`;
  const comFmtp = new Set();
  for (let i = 0; i < bloco.length; i++) {
    const m = bloco[i].match(/^a=fmtp:(\d+) (.*)$/);
    if (m && !/apt=/.test(m[2])) { bloco[i] = `a=fmtp:${m[1]} ${m[2]};${extra}`; comFmtp.add(m[1]); }
  }
  const saida = [...bloco];
  bloco.forEach((l) => {
    const m = l.match(/^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//);
    if (m && !comFmtp.has(m[1])) saida.splice(saida.indexOf(l) + 1, 0, `a=fmtp:${m[1]} ${extra}`);
  });
  return [...linhas.slice(0, ini), ...saida, ...linhas.slice(fim)].join('\r\n');
}

// ---------- Utilidades ----------
const $ = (id) => document.getElementById(id);
const telas = ['tela-inicio', 'tela-host', 'tela-viewer'];
function mostrar(id) {
  telas.forEach((t) => ($(t).hidden = t !== id));
  document.body.classList.toggle('foco', id !== 'tela-inicio');
  document.body.classList.toggle('assistindo', id === 'tela-viewer');
  document.body.classList.toggle('transmitindo', id === 'tela-host');
  if (id !== 'tela-viewer') sairModos();
  if (id !== 'tela-inicio') window.scrollTo({ top: 0 });
}
function status(el, texto, tipo = '') { el.textContent = texto; el.className = 'status ' + tipo; }
function novoCodigo() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
}
function limparCodigo(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
function criarPeer(id) { return new Peer(id, { config: { iceServers: iceServers() } }); }
function trocarIcone(btn, icone) { btn.querySelector('use').setAttribute('href', '#' + icone); }
async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch { return false; }
}

// ---------- Escolha de qualidade (tela inicial) ----------
function marcarSeg(idSeg, valor) {
  $(idSeg).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(valor)));
}
function atualizarDica() {
  // só avisa quando a qualidade escolhida é pesada; sem a linha fixa de consumo
  const pesado = kbpsBase(escolha.res, escolha.fps) / 1000 >= 4;
  const dica = $('dica-qualidade');
  dica.className = 'dica aviso';
  dica.hidden = !pesado;
  dica.textContent = 'Qualidade alta: use com poucas pessoas e boa internet.';
}
function salvarEscolha() {
  try { localStorage.setItem('escolha', JSON.stringify(escolha)); } catch {}
  atualizarDica();
}
function iniciarSeletores() {
  if (!RESOLUCOES[escolha.res]) escolha.res = 720;
  if (![15, 24, 30, 60].includes(escolha.fps)) escolha.fps = 30;
  marcarSeg('seg-res', escolha.res);
  marcarSeg('seg-fps', escolha.fps);
  marcarSeg('seg-audio', escolha.audioModo);
  atualizarDica();
  $('seg-res').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    escolha.res = Number(b.dataset.v); marcarSeg('seg-res', escolha.res); salvarEscolha();
  };
  $('seg-fps').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    escolha.fps = Number(b.dataset.v); marcarSeg('seg-fps', escolha.fps); salvarEscolha();
  };
  $('seg-audio').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    escolha.audioModo = b.dataset.v; escolha.audio = escolha.audioModo !== 'nenhum';
    marcarSeg('seg-audio', escolha.audioModo);
    mostrarAppsAudio();
    // o clique conta como gesto do usuário: pede ao Windows para abrir o assistente (sem janela)
    if (escolha.audioModo === 'aplicativos' && ehWindows && Assistente.estado !== 'conectado') Assistente.abrirPeloProtocolo();
  };
}

// ---------- Aplicativos no áudio (assistente opcional, só Windows) ----------

function sincronizarSelecaoApps() {
  Assistente.definirSelecao(escolha.appsSel, escolha.appsModo);
  marcarSeg('seg-apps-modo', escolha.appsModo);
  marcarSeg('seg-apps-modo-live', escolha.appsModo);
  renderizarApps();
}

// Liga/desliga a conexão com o assistente só quando o usuário escolhe "Escolher aplicativos".
function mostrarAppsAudio() {
  const usa = escolha.audioModo === 'aplicativos';
  $('apps-audio').hidden = !usa;
  if (usa) { Assistente.definirSelecao(escolha.appsSel, escolha.appsModo); Assistente.ligar(); }
  else if (!host) Assistente.desligar();
  marcarSeg('seg-apps-modo', escolha.appsModo);
  renderizarApps();
}

const ehWindows = /Windows/i.test(navigator.userAgent);
function textoStatusAssistente() {
  if (!ehWindows) return { t: 'O assistente de áudio funciona só no Windows. Neste sistema, use "Todo o áudio".', c: 'erro' };
  if (Assistente.estado === 'conectado') {
    const e = Assistente.estadoHelper;
    return e && e.erros && e.erros.length ? { t: 'Assistente conectado, mas o Windows recusou: ' + e.erros[0], c: 'erro' } : { t: 'Assistente de áudio conectado ✓', c: 'ok' };
  }
  if (Assistente.estado === 'procurando') return { t: Assistente.jaUsou ? 'Abrindo o assistente de áudio…' : 'Procurando o assistente de áudio neste computador…', c: '' };
  return { t: '', c: '' };
}

function atualizarListaApps(ul) {
  if (!ul._itens) ul._itens = new Map();
  const nomes = escolha.appsSel.map((x) => x.toLowerCase());
  const vistos = new Set();
  const lista = Assistente.apps.map((a) => ({ chave: a.exe.toLowerCase(), exe: a.exe, nome: a.nome, nivel: a.nivel, tocando: a.tocando, aberto: true }));
  // escolhidos que não estão abertos agora continuam aparecendo (para não "perder" a escolha)
  escolha.appsSel.forEach((x) => { if (!lista.some((a) => a.chave === x.toLowerCase())) lista.push({ chave: x.toLowerCase(), exe: x, nome: x, nivel: 0, tocando: false, aberto: false }); });
  lista.forEach((a) => {
    vistos.add(a.chave);
    let it = ul._itens.get(a.chave);
    if (!it) {
      const li = document.createElement('li');
      const lab = document.createElement('label');
      const cx = document.createElement('input'); cx.type = 'checkbox';
      const nome = document.createElement('span'); nome.className = 'nome';
      const vu = document.createElement('span'); vu.className = 'vu-app'; vu.innerHTML = '<i></i>';
      lab.append(cx, nome); li.append(lab, vu);
      cx.onchange = () => {
        const k = a.chave;
        if (escolha.appsModo === 'excluir') escolha.appsSel = cx.checked ? [a.exe] : [];
        else escolha.appsSel = cx.checked ? [...new Set([...escolha.appsSel, a.exe])] : escolha.appsSel.filter((x) => x.toLowerCase() !== k);
        salvarEscolha(); sincronizarSelecaoApps();
      };
      ul.append(li);
      it = { li, cx, nome, barra: vu.firstChild };
      ul._itens.set(a.chave, it);
    }
    it.cx.checked = nomes.includes(a.chave);
    const repetido = lista.filter((x) => x.nome === a.nome).length > 1; // vários apps com o mesmo nome: mostra o executável
    it.nome.textContent = a.nome + (repetido ? ' · ' + a.exe : '') + (a.aberto ? '' : ' (fechado)');
    it.li.classList.toggle('tocando', a.tocando);
    it.li.classList.toggle('fechado', !a.aberto);
    it.barra.style.width = Math.min(100, Math.round(a.nivel * 140)) + '%';
  });
  [...ul._itens.keys()].forEach((k) => { if (!vistos.has(k)) { ul._itens.get(k).li.remove(); ul._itens.delete(k); } });
  // mantém a ordem estável (só mexe no DOM se a ordem mudou, para não atrapalhar cliques)
  const esperados = lista.map((a) => ul._itens.get(a.chave).li);
  if (esperados.some((li, i) => ul.children[i] !== li)) esperados.forEach((li) => ul.append(li));
}

function renderizarApps() {
  const st = textoStatusAssistente();
  const conectado = Assistente.estado === 'conectado';
  ['apps-status', 'apps-status-live'].forEach((id) => { const el = $(id); if (el) { el.textContent = st.t; el.className = 'apps-status ' + st.c; } });
  if (conectado || !ehWindows) $('apps-baixar').hidden = true;
  else {
    // Já instalado: a página abre o assistente sozinha; só oferece reinstalar se passar de ~12 s sem abrir.
    // Primeira vez: mostra o instalador (é o único passo manual, uma vez só).
    const espera = Assistente.procurandoDesde ? Date.now() - Assistente.procurandoDesde : 0;
    const jaUsou = Assistente.jaUsou;
    const mostrar = !jaUsou || espera > 12000;
    $('apps-baixar').hidden = !mostrar;
    if (mostrar) {
      $('apps-baixar-txt').innerHTML = jaUsou
        ? 'Não foi possível abrir o assistente de áudio. Instale-o de novo (leva alguns segundos); depois a página volta a abri-lo sozinha.'
        : '<b>Primeira vez?</b> Para escolher aplicativos (por exemplo, <b>só o jogo</b>, ou <b>tudo menos o Discord</b>) o navegador precisa de um pequeno <b>assistente de áudio</b>. Você instala uma vez e, daí em diante, a página o abre sozinha.';
      $('apps-passos').hidden = jaUsou;
    }
  }
  $('apps-painel').hidden = !conectado;
  if (conectado) {
    atualizarListaApps($('apps-lista'));
    $('apps-dica').textContent = escolha.appsSel.length ? ''
      : escolha.appsModo === 'excluir' ? 'Marque o aplicativo que fica de fora do som (ex.: Discord). Todo o resto entra.'
      : 'Marque ao menos um aplicativo (ex.: seu jogo). Sem isso a transmissão segue sem áudio.';
  }
  if (host && host.audioOrigem === 'aplicativos') atualizarListaApps($('apps-lista-live'));
}
Assistente.aoMudar(renderizarApps);
setInterval(() => { if (!$('apps-audio').hidden && Assistente.estado !== 'conectado') renderizarApps(); }, 1000);

function mostrarAppsLive() {
  const ativo = !!host && host.audioOrigem === 'aplicativos';
  $('host-audio-apps').hidden = !ativo;
  if (ativo) { marcarSeg('seg-apps-modo-live', escolha.appsModo); renderizarApps(); }
}
$('seg-apps-modo').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  escolha.appsModo = b.dataset.v; if (escolha.appsModo === 'excluir') escolha.appsSel = escolha.appsSel.slice(0, 1);
  salvarEscolha(); sincronizarSelecaoApps();
};
$('seg-apps-modo-live').onclick = $('seg-apps-modo').onclick;

// ---------- Quem compartilha ----------
let host = null; // { peer, stream, viewers: Map<peerId, {conn, call, num}>, codigo, contador, timer }
let conteudo = 'motion'; // 'motion' (fluidez) | 'detail' (nitidez)

// Alvo da captura. Com muitos espectadores ou rede ruim, reduz aqui (uma vez) e não em cada envio (N vezes).
function alvoCaptura() {
  const [w, h] = RESOLUCOES[escolha.res];
  const p = host ? perfil(diretos()) : { escala: 1, fps: escolha.fps };
  return { largura: Math.round(w / p.escala), altura: Math.round(h / p.escala), fps: p.fps };
}
function restricoesVideo() {
  const t = alvoCaptura();
  return { width: { ideal: t.largura }, height: { ideal: t.altura }, frameRate: { ideal: t.fps, max: t.fps } };
}
async function aplicarCaptura(forcar) {
  if (!host) return;
  const t = alvoCaptura();
  const chave = `${t.largura}x${t.altura}@${t.fps}`;
  if (!forcar && chave === host.capChave) return;
  host.capChave = chave;
  try { await host.stream.getVideoTracks()[0].applyConstraints(restricoesVideo()); } catch {}
  atualizarTagResolucao();
}

// Abre o seletor do navegador. Devolve null se o usuário cancelar.
async function capturarTela() {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: restricoesVideo(),
      audio: escolha.audioModo === 'captura' ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Não foi possível capturar a tela: ' + e.message);
    return null;
  }
}

// Faixa de áudio muda: mantém sempre uma faixa de áudio na conexão, assim dá para
// trocar para uma fonte com som depois, sem renegociar com os espectadores.
// Contexto de áudio do host (faixa muda e medidor de nível), criado sob demanda.
function garantirCtx(h) {
  if (!h.ctx) h.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (h.ctx.state === 'suspended') h.ctx.resume().catch(() => {});
  return h.ctx;
}
function faixaSilenciosa(h) {
  garantirCtx(h);
  return h.ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
}

async function iniciarHost() {
  const [w, h] = RESOLUCOES[escolha.res];
  if (escolha.audioModo === 'aplicativos' && ehWindows && Assistente.estado !== 'conectado') Assistente.abrirPeloProtocolo();
  const capt = await capturarTela();
  if (!capt) return;

  // áudio: todo o áudio (da captura), aplicativos escolhidos (assistente) ou nenhum
  let faixaA = null, avisoAudio = '';
  if (escolha.audioModo === 'captura') faixaA = capt.getAudioTracks()[0] || null;
  else if (escolha.audioModo === 'aplicativos') {
    try { faixaA = await Assistente.iniciarCaptura(); }
    catch { avisoAudio = 'Assistente de áudio não encontrado: transmitindo sem áudio. Abra o assistente e use "Escolher aplicativos" de novo.'; }
  }

  mostrar('tela-host');
  const st = $('host-status');
  status(st, 'Criando sala…');
  $('host-max').textContent = MAX_ESPECTADORES;
  $('host-qtd').textContent = '0';
  const vt = capt.getVideoTracks()[0];
  try { await vt.applyConstraints(restricoesVideo()); } catch {}
  vt.onended = pararHost; // botão "Parar compartilhamento" do navegador

  // O stream enviado aos espectadores é estável: só as faixas dentro dele são trocadas.
  const stream = new MediaStream([vt]);
  host = { stream, viewers: new Map(), peer: null, codigo: '', contador: 0, timer: null, ctx: null, audioReal: false, audioLigado: true, nivel: 0, ruim: 0, bom: 0, monitor: null, sinal: null, repasse: escolha.repasse !== false, capChave: '' };
  host.monitor = setInterval(monitorarRede, 2000);
  host.audioReal = !!faixaA;
  host.audioOrigem = faixaA ? escolha.audioModo : 'nenhum';
  host.avisoAudio = avisoAudio;
  stream.addTrack(faixaA || faixaSilenciosa(host));
  mostrarAppsLive();
  iniciarVU();
  $('preview').srcObject = stream;
  sincronizarAjustesAoVivo();
  const t0 = Date.now();
  $('host-tempo').textContent = '00:00';
  host.timer = setInterval(() => {
    const seg = Math.floor((Date.now() - t0) / 1000);
    const f = (n) => String(n).padStart(2, '0');
    $('host-tempo').textContent = (seg >= 3600 ? f(Math.floor(seg / 3600)) + ':' : '') + f(Math.floor(seg / 60) % 60) + ':' + f(seg % 60);
  }, 1000);
  const cfg = vt.getSettings();
  $('host-res').textContent = `${cfg.width || w}×${cfg.height || h} · ${Math.round(cfg.frameRate || escolha.fps)} fps`;
  $('btn-enviar').hidden = !navigator.share;
  aplicarConteudo();
  abrirSala(host, 0);
  if (escolha.audioModo === 'captura' && !host.audioReal) {
    host.avisoAudio = 'Sem áudio: marque "compartilhar áudio" ao escolher a tela inteira ou uma aba.';
  }
}

function abrirSala(h, tentativa) {
  const codigo = novoCodigo();
  const peer = criarPeer(PREFIXO_ID + codigo);
  h.peer = peer;

  peer.on('open', () => {
    if (host !== h) return peer.destroy();
    h.codigo = codigo;
    $('host-codigo').textContent = codigo;
    $('host-link').value = `${location.origin}${location.pathname}?sala=${codigo}`;
    status($('host-status'), 'Sala aberta. Envie o código ou o link.' + (h.avisoAudio ? ' ⚠ ' + h.avisoAudio : ''), 'ok');
    atualizarQualidade();
  });

  peer.on('connection', (conn) => aceitarEspectador(h, conn));
  // Se a conexão com o servidor de sinalização cair, tenta voltar até conseguir.
  // A imagem dos espectadores já conectados continua (é direta entre navegadores).
  const religar = () => {
    if (host !== h || peer.destroyed || h.sinal) return;
    status($('host-status'), 'Reconectando ao servidor da sala…', 'erro');
    h.sinal = setInterval(() => {
      if (host !== h || peer.destroyed) { clearInterval(h.sinal); h.sinal = null; return; }
      if (!peer.disconnected) {
        clearInterval(h.sinal); h.sinal = null;
        status($('host-status'), 'Sala aberta. Envie o código ou o link.', 'ok');
        return;
      }
      try { peer.reconnect(); } catch {}
    }, 3000);
    try { peer.reconnect(); } catch {}
  };
  peer.on('disconnected', religar);

  peer.on('error', (err) => {
    if (host !== h) return;
    if (err.type === 'unavailable-id' && tentativa < 5) {
      peer.destroy();
      return abrirSala(h, tentativa + 1);
    }
    if (err.type === 'peer-unavailable') return; // espectador sumiu antes da chamada
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) return religar();
    status($('host-status'), 'Erro de conexão com o servidor de sinalização (' + err.type + ').', 'erro');
  });
}

// Quantas conexões o host está de fato codificando (cada uma custa CPU/GPU, que o jogo também usa).
function diretos(h = host) {
  let n = 0;
  if (h) h.viewers.forEach((v) => { if (v.call) n++; });
  return n;
}
const maxDiretos = (h) => (h.repasse === false ? MAX_ESPECTADORES : MAX_DIRETOS);

// Espectador já recebendo a imagem direto do host e com vaga para repassar.
function escolherRepassador(h) {
  let melhor = null;
  h.viewers.forEach((v) => {
    if (!v.call || !v.pronto || v.filhos.size >= MAX_FILHOS) return;
    if (!melhor || v.filhos.size < melhor.filhos.size) melhor = v;
  });
  return melhor;
}

function removerEspectador(h, v) {
  if (v.removido) return;
  v.removido = true;
  if (h.viewers.get(v.conn.peer) === v) h.viewers.delete(v.conn.peer);
  try { v.call && v.call.close(); } catch {}
  try { v.conn.close(); } catch {}
  // quem recebia por ele precisa de outra rota: refaz a conexão (e é encaixado de novo)
  v.filhos.forEach((id) => {
    const f = h.viewers.get(id);
    if (f) { f.relay = null; try { f.conn.send({ tipo: 'refazer' }); } catch {} }
  });
  if (v.relay) { const r = h.viewers.get(v.relay); if (r) r.filhos.delete(v.conn.peer); }
  if (host === h) atualizarQualidade();
}

function ligarDireto(h, v) {
  const kbps = perfil(diretos(h) + 1).kbps;
  const call = h.peer.call(v.conn.peer, h.stream, { metadata: { kbps }, sdpTransform: (sdp) => ajustarSdp(sdp, kbps) });
  v.call = call;
  call.on('close', () => removerEspectador(h, v));
  call.on('error', () => removerEspectador(h, v));
  esperarConexao(call, v);
}

function ligarPorRepasse(h, v, r) {
  v.relay = r.conn.peer;
  r.filhos.add(v.conn.peer);
  try {
    r.conn.send({ tipo: 'repassar', para: v.conn.peer, kbps: perfil(1).kbps });
    v.conn.send({ tipo: 'via-relay' });
  } catch {}
}

function aceitarEspectador(h, conn) {
  conn.on('open', () => {
    if (host !== h) return conn.close();
    // mesmo espectador reconectando: derruba a conexão antiga para não ocupar uma vaga à toa
    const cid = conn.metadata && conn.metadata.cid;
    if (cid) [...h.viewers.values()].filter((a) => a.cid === cid).forEach((a) => removerEspectador(h, a));
    if (h.viewers.size >= MAX_ESPECTADORES) {
      conn.send({ tipo: 'cheio' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    const v = { conn, nome: limparNome(conn.metadata && conn.metadata.nome), call: null, num: ++h.contador, cid, relay: null, filhos: new Set(), pronto: false, removido: false };
    h.viewers.set(conn.peer, v);
    conn.on('close', () => removerEspectador(h, v));
    conn.on('error', () => removerEspectador(h, v));
    conn.on('data', (m) => { if (m && m.tipo === 'nome') { v.nome = limparNome(m.nome); if (host === h) renderLista(); } });

    // até MAX_DIRETOS o host envia direto; acima disso, outro espectador repassa (poupa o PC de quem joga)
    const r = diretos(h) >= maxDiretos(h) ? escolherRepassador(h) : null;
    if (r) ligarPorRepasse(h, v, r); else ligarDireto(h, v);
    atualizarQualidade();
  });
}

// O peerConnection só existe/conecta depois de um instante: espera e aplica os limites.
function esperarConexao(call, v, tentativas = 0) {
  const pc = call.peerConnection;
  if (!pc) {
    if (tentativas < 50) setTimeout(() => esperarConexao(call, v, tentativas + 1), 200);
    return;
  }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') { v.pronto = true; aplicarEmSender(call); }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { try { call.close(); } catch {} }
  });
  if (pc.connectionState === 'connected') { v.pronto = true; aplicarEmSender(call); }
}

function aplicarEmSender(call) {
  if (!host) return;
  const p = perfil(diretos());
  const pc = call.peerConnection;
  if (!pc) return;
  const altura = (host.stream.getVideoTracks()[0].getSettings().height) || RESOLUCOES[escolha.res][1];
  const escalaBase = Math.max(1, altura / alvoCaptura().altura); // normalmente 1: a captura já está no tamanho alvo
  pc.getSenders().forEach((s) => {
    if (!s.track || s.track.kind !== 'video') return;
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = p.kbps * 1000;
    params.encodings[0].maxFramerate = p.fps;
    params.encodings[0].scaleResolutionDownBy = escalaBase;
    params.degradationPreference = conteudo === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    s.setParameters(params).catch(() => {});
  });
}

// ---- Adaptação automática à rede de quem transmite ----
async function medirEspectador(call) {
  const pc = call.peerConnection;
  if (!pc || pc.connectionState !== 'connected') return null;
  let perda = 0, rtt = 0, disp = 0, enc = null;
  try {
    const st = await pc.getStats();
    const codecs = {};
    st.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
    st.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        enc = { codec: codecs[r.codecId], impl: r.encoderImplementation, he: r.powerEfficientEncoder, limite: r.qualityLimitationReason, frames: r.framesEncoded, tempo: r.totalEncodeTime };
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') { perda = r.fractionLost || 0; rtt = r.roundTripTime || 0; }
      else if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.availableOutgoingBitrate) disp = Math.max(disp, r.availableOutgoingBitrate);
    });
  } catch { return null; }
  return { perda, rtt, disp, enc };
}

// Mostra como o vídeo está sendo codificado: hardware (leve para o jogo) ou software (usa a CPU).
function mostrarCodificador(h, vs, brutas) {
  const el = $('host-enc');
  if (!el) return;
  const i = brutas.findIndex((m) => m && m.enc);
  if (i < 0) { el.textContent = vs.length ? 'Codificação: medindo…' : 'Codificação: aguardando o primeiro espectador'; el.className = 'codec-info'; return; }
  const v = vs[i], e = brutas[i].enc;
  let ms = null;
  if (v.encAnt && e.frames > v.encAnt.frames) ms = ((e.tempo - v.encAnt.tempo) / (e.frames - v.encAnt.frames)) * 1000;
  v.encAnt = { frames: e.frames, tempo: e.tempo };
  const impl = String(e.impl || '');
  const hw = e.he === true || /external|hardware|mediafoundation|nvenc|videotoolbox|d3d|vaapi|accelerat/i.test(impl);
  const sw = !hw && (e.he === false || /libvpx|openh264|software|libaom|ffmpeg/i.test(impl));
  const codec = (e.codec || '').replace('video/', '') || '?';
  const modo = hw ? 'hardware' : sw ? 'software' : 'tipo não informado';
  const envios = diretos(h);
  el.className = 'codec-info' + (sw ? ' aviso' : hw ? ' ok' : '');
  el.textContent = `Codificação: ${codec} · ${modo}` + (ms !== null ? ` · ${ms.toFixed(1)} ms/quadro` : '') + ` · ${envios} ${envios === 1 ? 'envio direto' : 'envios diretos'}`
    + (sw ? ' — usa a CPU e pode custar FPS no jogo; confira a aceleração de hardware do navegador.' : '');
}

function mostrarRede(estado) {
  const el = $('host-rede');
  if (!el) return;
  const n = host ? host.nivel : 0;
  el.className = 'tag tag-rede' + (n > 0 ? ' ruim' : '');
  el.textContent = escolha.auto === false ? 'Ajuste automático desligado'
    : n === 0 ? 'Rede estável' : `Rede instável · qualidade reduzida (${n}/${NIVEIS.length - 1})`;
}

async function monitorarRede() {
  const h = host;
  if (!h) return;
  if (escolha.auto === false) { if (h.nivel) { h.nivel = 0; atualizarQualidade(); } mostrarRede(); return; }
  const vs = [...h.viewers.values()].filter((v) => v.call);
  const brutas = await Promise.all(vs.map((v) => medirEspectador(v.call)));
  const medidas = brutas.filter(Boolean);
  if (host === h) mostrarCodificador(h, vs, brutas);
  if (host !== h || !medidas.length) { mostrarRede(); return; }

  const perda = Math.max(...medidas.map((m) => m.perda));
  const rtt = Math.max(...medidas.map((m) => m.rtt));
  const disps = medidas.map((m) => m.disp).filter(Boolean);
  const disp = disps.length ? Math.min(...disps) : 0;
  const alvo = perfil(diretos(h)).kbps * 1000;
  const cpuLimitada = medidas.some((m) => m.enc && m.enc.limite === 'cpu'); // o codificador não dá conta: alivia

  const ruim = perda > 0.05 || rtt > 0.8 || (disp > 0 && disp < alvo * 0.7) || cpuLimitada;
  const bom = perda < 0.015 && rtt < 0.4 && (!disp || disp > alvo * 1.3) && !cpuLimitada;

  if (ruim) {
    h.bom = 0; h.ruim++;
    if (h.ruim >= 2 && h.nivel < NIVEIS.length - 1) { h.nivel++; h.ruim = 0; atualizarQualidade(); }
  } else if (bom) {
    h.ruim = 0; h.bom++;
    if (h.bom >= 8 && h.nivel > 0) { h.nivel--; h.bom = 0; atualizarQualidade(); } // sobe um nível após ~16 s estável
  } else {
    h.ruim = Math.max(0, h.ruim - 1); h.bom = 0;
  }
  mostrarRede();
}

function atualizarQualidade() {
  if (!host) return;
  const n = host.viewers.size, d = diretos();
  const p = perfil(d);
  $('host-qtd').textContent = n;
  $('host-qualidade').textContent = p.curto;
  $('host-qualidade').title = p.rotulo;
  const up = (p.kbps * d) / 1000; // só o que o host realmente envia (os demais recebem repassado)
  $('host-upload').textContent = up.toFixed(1).replace('.', ',') + ' Mbps';
  $('host-upload').title = d + (d === 1 ? ' envio direto' : ' envios diretos') + (n > d ? ' · ' + (n - d) + ' por repasse' : '');
  aplicarCaptura();
  host.viewers.forEach((v) => v.call && aplicarEmSender(v.call));
  mostrarRede();
  renderLista();
}

// ---- Ajustes durante a transmissão ----
function atualizarTagResolucao() {
  if (!host) return;
  const cfg = host.stream.getVideoTracks()[0].getSettings();
  const [w, h] = RESOLUCOES[escolha.res];
  $('host-res').textContent = `${cfg.width || w}×${cfg.height || h} · ${Math.round(cfg.frameRate || escolha.fps)} fps`;
}

function sincronizarAjustesAoVivo() {
  marcarSeg('live-res', escolha.res);
  marcarSeg('live-fps', escolha.fps);
  marcarSeg('seg-res', escolha.res);
  marcarSeg('seg-fps', escolha.fps);
  atualizarTagResolucao();
  atualizarBotaoAudio();
}

// Muda resolução e fps da captura em andamento e reaplica os limites de envio.
async function aplicarQualidadeAoVivo() {
  salvarEscolha();
  sincronizarAjustesAoVivo();
  if (!host) return;
  host.nivel = 0; host.ruim = 0; host.bom = 0;
  await aplicarCaptura(true);
  atualizarQualidade();
}

function atualizarBotaoAudio() {
  const b = $('btn-audio-host');
  const ligado = host && host.audioReal && host.audioLigado;
  b.disabled = !host || !host.audioReal;
  trocarIcone(b, ligado ? 'i-volume' : 'i-mute');
  b.querySelector('span').textContent = !host || !host.audioReal ? 'Sem áudio' : ligado ? 'Áudio ligado' : 'Áudio desligado';
  b.classList.toggle('desligado', !!host && host.audioReal && !host.audioLigado);
}

// Escolhe outra tela, janela ou aba e a coloca no lugar da atual, na mesma conexão.
async function trocarFonte() {
  if (!host) return;
  const h = host;
  const btn = $('btn-trocar');
  btn.disabled = true;
  try {
    const capt = await capturarTela(); // o navegador abre o seletor outra vez
    if (!capt || host !== h) { if (capt) capt.getTracks().forEach((t) => t.stop()); return; }

    const novoV = capt.getVideoTracks()[0];
    try { await novoV.applyConstraints(restricoesVideo()); } catch {}
    novoV.onended = pararHost;
    if ('contentHint' in novoV) novoV.contentHint = conteudo;

    const velhoV = h.stream.getVideoTracks()[0];
    const velhoA = h.stream.getAudioTracks()[0];
    // Áudio de aplicativos (ou "nenhum") não depende da captura de tela: continua o mesmo.
    // Todo o áudio (captura): usa o da nova fonte, ou a faixa muda se ela não tiver som.
    let novoA = velhoA;
    if (h.audioOrigem === 'captura') {
      const audioCapt = capt.getAudioTracks()[0];
      novoA = audioCapt || faixaSilenciosa(h);
      h.audioReal = !!audioCapt;
      h.audioLigado = true;
    }

    // troca dentro do stream (prévia local e espectadores que entrarem depois)
    velhoV.onended = null;
    h.stream.removeTrack(velhoV); h.stream.addTrack(novoV);
    if (novoA !== velhoA) { h.stream.removeTrack(velhoA); h.stream.addTrack(novoA); }

    // troca na conexão de quem já está assistindo, sem renegociar
    const trocas = [];
    h.viewers.forEach((v) => {
      const pc = v.call && v.call.peerConnection;
      if (!pc) return;
      pc.getSenders().forEach((s) => {
        if (!s.track) return;
        if (s.track === velhoV) trocas.push(s.replaceTrack(novoV));
        else if (novoA !== velhoA && s.track === velhoA) trocas.push(s.replaceTrack(novoA));
      });
    });
    await Promise.allSettled(trocas);

    velhoV.stop(); if (novoA !== velhoA) velhoA.stop();
    $('preview').srcObject = h.stream;
    sincronizarAjustesAoVivo();
    atualizarQualidade();
    iniciarVU();
    status($('host-status'), 'Tela trocada. A transmissão continua.', 'ok');
    if (h.audioOrigem === 'captura' && !h.audioReal) status($('host-status'), 'Tela trocada, mas a nova fonte está sem áudio.', 'ok');
  } finally {
    btn.disabled = false;
  }
}

// ---- Medidor do áudio que está sendo enviado (mostra na hora se há som ou não) ----
let vuTimer = null, vuNodes = null;
function textoAudioSemFaixa() {
  if (escolha.audioModo === 'nenhum') return 'Você escolheu transmitir sem áudio.';
  if (escolha.audioModo === 'aplicativos') return host && host.avisoAudio ? host.avisoAudio : 'Assistente de áudio indisponível: transmitindo sem áudio.';
  return 'Nenhum áudio está sendo enviado. Ao compartilhar a tela inteira, marque "Compartilhar áudio do sistema" na janela do navegador (janelas não enviam som). O som do próprio navegador pode ficar de fora da captura do sistema.';
}
function iniciarVU() {
  clearInterval(vuTimer);
  if (vuNodes) { try { vuNodes.src.disconnect(); } catch {} vuNodes = null; }
  const barra = $('vu').firstElementChild, txt = $('audio-txt'), box = $('audio-info');
  barra.style.width = '0%';
  if (!host) return;
  const h = host;
  if (!h.audioReal) { txt.textContent = textoAudioSemFaixa(); box.className = 'audio-info aviso'; return; }
  const ctx = garantirCtx(h);
  const src = ctx.createMediaStreamSource(new MediaStream([h.stream.getAudioTracks()[0]]));
  const an = ctx.createAnalyser(); an.fftSize = 256;
  src.connect(an); // não conecta ao destino: nada toca nas caixas de som
  vuNodes = { src, an };
  h.silencioDesde = Date.now();
  const buf = new Uint8Array(an.fftSize);
  vuTimer = setInterval(() => {
    if (host !== h) return clearInterval(vuTimer);
    if (document.hidden) return;
    an.getByteTimeDomainData(buf);
    let pico = 0;
    for (let i = 0; i < buf.length; i++) pico = Math.max(pico, Math.abs(buf[i] - 128));
    const nivel = h.audioLigado ? Math.min(100, Math.round((pico / 128) * 140)) : 0;
    barra.style.width = nivel + '%';
    if (!h.audioLigado) { txt.textContent = 'Áudio desligado: os espectadores não ouvem nada.'; box.className = 'audio-info aviso'; return; }
    if (nivel > 3) { h.silencioDesde = Date.now(); txt.textContent = 'Enviando áudio ✓'; box.className = 'audio-info ok'; }
    else if (Date.now() - h.silencioDesde > 8000) {
      txt.textContent = h.audioOrigem === 'aplicativos'
        ? 'Sem som no momento. Confira se o aplicativo marcado está tocando.'
        : 'Sem som no momento. Se esperava ouvir algo, confira se o áudio do sistema foi marcado ao compartilhar.';
      box.className = 'audio-info aviso';
    }
  }, 140);
}

function renderLista() {
  const ul = $('host-lista');
  ul.textContent = '';
  host.viewers.forEach((v) => {
    const li = document.createElement('li');
    const av = document.createElement('span'); av.className = 'avatar'; av.textContent = v.num;
    const nome = document.createElement('span'); nome.className = 'nome';
    const via = v.relay && host.viewers.get(v.relay);
    nome.textContent = (v.nome || 'Espectador ' + v.num) + (via ? ' · via ' + via.num : v.filhos.size ? ' · repassa para ' + v.filhos.size : '');
    const on = document.createElement('i'); on.className = 'on';
    const x = document.createElement('button'); x.className = 'tirar'; x.title = 'Remover da sala';
    x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    x.onclick = () => {
      try { v.conn.send({ tipo: 'fim' }); } catch {}
      setTimeout(() => { if (host) removerEspectador(host, v); }, 200);
    };
    li.append(av, nome, on, x);
    ul.append(li);
  });
}

function aplicarConteudo() {
  if (!host) return;
  const vt = host.stream.getVideoTracks()[0];
  if (vt && 'contentHint' in vt) vt.contentHint = conteudo;
  atualizarQualidade();
}

function pararHost() {
  if (!host) return;
  const h = host;
  host = null;
  clearInterval(h.timer);
  clearInterval(h.monitor);
  clearInterval(h.sinal);
  clearInterval(vuTimer); vuNodes = null;
  Assistente.pararCaptura();
  $('host-audio-apps').hidden = true;
  $('host-lista').textContent = '';
  h.viewers.forEach((v) => { try { v.conn.send({ tipo: 'fim' }); } catch {} });
  setTimeout(() => { try { h.peer.destroy(); } catch {} }, 300);
  h.stream.getTracks().forEach((t) => t.stop());
  if (h.ctx) h.ctx.close().catch(() => {});
  $('preview').srcObject = null;
  mostrar('tela-inicio');
  if (escolha.audioModo !== 'aplicativos') Assistente.desligar();
}

// Prévia local só enquanto a janela está visível: com o jogo na frente ela não gasta decodificação/GPU à toa.
document.addEventListener('visibilitychange', () => {
  if (!host) return;
  const pv = $('preview');
  if (document.hidden) pv.srcObject = null;
  else if (!pv.srcObject) pv.srcObject = host.stream;
});

// ---------- Quem assiste ----------
let viewer = null; // { peer, conn, call, ok }

function overlay(modo, msg) {
  // modo: 'carregando' | 'erro' | 'some'
  const o = $('overlay');
  o.classList.toggle('some', modo === 'some');
  $('carregando').hidden = modo !== 'carregando';
  $('ic-aviso').hidden = modo !== 'erro';
  $('btn-voltar').hidden = modo !== 'erro';
  $('btn-tentar').hidden = modo !== 'erro' || !viewer || viewer.fatal;
  if (msg) $('overlay-msg').textContent = msg;
}

// Nome do espectador: guardado por 1 ano (localStorage + cookie de reserva).
function limparNome(n) { return String(n || '').replace(/[ -<>]/g, '').trim().slice(0, 24); }
function lerNome() {
  try { const n = limparNome(localStorage.getItem('nomeViewer')); if (n) return n; } catch {}
  const m = document.cookie.match(/(?:^|; )nomeViewer=([^;]*)/);
  try { return m ? limparNome(decodeURIComponent(m[1])) : ''; } catch { return ''; }
}
function gravarNome(n) {
  try { localStorage.setItem('nomeViewer', n); } catch {}
  try { document.cookie = 'nomeViewer=' + encodeURIComponent(n) + '; max-age=31536000; path=/; SameSite=Lax'; } catch {}
}

// Identificador estável deste navegador: permite ao host reconhecer uma reconexão.
function cidCliente() {
  try {
    let c = sessionStorage.getItem('cid');
    if (!c) { c = novoCodigo() + novoCodigo(); sessionStorage.setItem('cid', c); }
    return c;
  } catch { return novoCodigo() + novoCodigo(); }
}

function assistir(codigo) {
  codigo = limparCodigo(codigo);
  if (codigo.length !== 6) return alert('Informe o código de 6 caracteres.');
  mostrar('tela-viewer');
  definirModo('cinema'); // modo padrão de quem assiste
  const video = $('remoto');
  video.srcObject = null;
  video.muted = true;
  atualizarSom();
  $('viewer-codigo').textContent = codigo;
  $('badge-res').hidden = true;
  status($('viewer-status'), 'Conectando…');
  overlay('carregando', 'Conectando à sala ' + codigo + '…');

  if (typeof RTCPeerConnection === 'undefined') {
    overlay('erro', 'Este navegador não suporta transmissão ao vivo (WebRTC). Use Chrome, Edge ou Firefox atualizados.');
    return;
  }
  const v = { codigo, peer: null, conn: null, call: null, ok: false, jaConectou: false, fim: false, aguardando: false, tentativas: 0, bytes: -1, parado: 0, vigia: null, stream: null, fila: [], filhos: new Map() };
  viewer = v;
  abrirConexao(v);
  v.vigia = setInterval(() => vigiar(v), 2000);
}

function encerrarViewer(v, msg, fatal) {
  if (viewer !== v) return;
  v.fim = true; v.fatal = !!fatal;
  status($('viewer-status'), 'Desconectado', 'erro');
  overlay('erro', msg);
}

// Perdeu a conexão (internet instável, queda do servidor...): tenta voltar sozinho, sem F5.
function reconectar(v, motivo) {
  if (viewer !== v || v.fim || v.aguardando) return;
  if (v.tentativas >= 6) return encerrarViewer(v, 'Não foi possível conectar. ' + motivo + ' Dicas: desative VPN/bloqueador de anúncios para este site, tente outra rede (ex.: dados do celular) ou outro navegador.' + (v.diag ? ' [' + v.diag + ']' : ''));
  v.tentativas++;
  v.aguardando = true;
  v.stream = null; v.fila = []; v.filhos.clear();
  status($('viewer-status'), `Reconectando… (${v.tentativas}/6)`, 'erro');
  overlay('carregando', `${motivo} Reconectando… (${v.tentativas}/6)`);
  const velho = v.peer;
  v.peer = null; v.call = null; v.conn = null; v.ok = false; v.bytes = -1; v.parado = 0;
  try { velho && velho.destroy(); } catch {}
  setTimeout(() => {
    v.aguardando = false;
    if (viewer === v && !v.fim) abrirConexao(v);
  }, Math.min(1000 * v.tentativas, 5000));
}

function abrirConexao(v) {
  const st = $('viewer-status');
  const video = $('remoto');
  const peer = criarPeer();
  v.peer = peer;
  const atual = () => viewer === v && v.peer === peer; // ignora eventos de conexões antigas
  v.diag = 'servidor';
  // servidor de salas que nunca responde: não espera o PeerJS desistir sozinho (~20 s)
  setTimeout(() => { if (atual() && !peer.open && !v.ok) { v.diag = 'sem resposta do servidor de salas'; reconectar(v, 'Sem resposta do servidor de salas.'); } }, 10000);

  peer.on('open', () => {
    if (!atual()) return;
    v.diag = 'sala';
    overlay('carregando', 'Procurando a sala ' + v.codigo + '…');
    const conn = peer.connect(PREFIXO_ID + v.codigo, { reliable: true, metadata: { cid: cidCliente(), nome: lerNome() } });
    v.conn = conn;
    const prazo = setTimeout(() => { if (atual() && !v.ok) reconectar(v, 'A sala não respondeu.'); }, 15000);
    v.conn.nomeEnviar = () => { try { conn.open && conn.send({ tipo: 'nome', nome: lerNome() }); } catch {} };
    conn.on('open', () => { v.diag = 'imagem'; if (atual() && !v.ok) overlay('carregando', 'Estabelecendo a conexão direta…'); });
    conn.on('data', (m) => {
      if (!atual() || !m) return;
      if (m.tipo === 'cheio') encerrarViewer(v, 'A sala está cheia (máx. ' + MAX_ESPECTADORES + ').', true);
      if (m.tipo === 'fim') encerrarViewer(v, 'A transmissão terminou.', true);
      if (m.tipo === 'via-relay' && !v.ok) overlay('carregando', 'Recebendo a imagem por repasse…');
      if (m.tipo === 'repassar') { v.fila.push(m); repassarFila(v); }
      if (m.tipo === 'refazer') reconectar(v, 'O repasse caiu.');
    });
    conn.on('close', () => { clearTimeout(prazo); if (atual() && !v.fim) reconectar(v, 'A conexão com a sala caiu.'); });
  });

  peer.on('call', (call) => {
    if (!atual()) return;
    v.call = call;
    const kbps = (call.metadata && call.metadata.kbps) || 1500;
    call.answer(undefined, { sdpTransform: (sdp) => ajustarSdp(sdp, kbps) }); // não envia nada de volta
    call.on('stream', (stream) => {
      if (!atual()) return;
      v.ok = true; v.jaConectou = true; v.tentativas = 0; v.parado = 0; v.bytes = -1;
      v.stream = stream;
      repassarFila(v);
      video.srcObject = stream;
      video.muted = false;
      video.volume = prefs.vol;
      status(st, 'Ao vivo', 'ok');
      // tenta com som; se o navegador bloquear o autoplay, entra mudo
      video.play().catch(() => {
        video.muted = true;
        video.dataset.autoMudo = '1'; // o navegador bloqueou o som automático: mostra o botão de ativar
        atualizarSom();
        status(st, 'Ao vivo · toque no alto-falante para ativar o som', 'ok');
        return video.play();
      }).catch(() => {});
      atualizarSom();
      acordar();
      overlay('some');
      reduzirAtraso(call);
      const pc = call.peerConnection;
      if (pc) pc.addEventListener('iceconnectionstatechange', () => {
        if (!atual()) return;
        const e = pc.iceConnectionState;
        if (e === 'failed') { v.diag = 'ice-failed'; reconectar(v, 'A conexão direta falhou (rede/firewall bloqueando).'); }
        else if (e === 'disconnected') status(st, 'Conexão instável…', 'erro');
        else if (e === 'connected' || e === 'completed') status(st, 'Ao vivo', 'ok');
      });
    });
    call.on('close', () => { if (atual() && !v.fim) reconectar(v, 'A transmissão foi interrompida.'); });
  });

  // se a sinalização cair com a imagem já chegando, a conexão direta continua: não derruba
  peer.on('disconnected', () => { if (atual() && !v.ok) reconectar(v, 'Conexão com o servidor perdida.'); });
  peer.on('error', (err) => {
    if (!atual()) return;
    if (err.type === 'peer-unavailable') {
      if (!v.jaConectou) return encerrarViewer(v, 'Sala não encontrada. Confira o código.', true);
      return reconectar(v, 'A sala não respondeu.'); // o host pode estar voltando
    }
    v.diag = (err.type || 'erro');
    reconectar(v, 'Erro de conexão.');
  });
}

// Repasse: o host pede que este espectador envie a imagem que já recebe a outro espectador.
// Assim o PC de quem joga codifica poucas vezes, e o resto da sala é atendido pelos espectadores.
function repassarFila(v) {
  while (v.fila.length && v.stream && v.peer) {
    const m = v.fila.shift();
    const kbps = Math.min(m.kbps || 1500, 3500);
    const c = v.peer.call(m.para, v.stream, { metadata: { kbps }, sdpTransform: (sdp) => ajustarSdp(sdp, kbps) });
    v.filhos.set(m.para, c);
    const largar = () => v.filhos.delete(m.para);
    c.on('close', largar); c.on('error', largar);
    limitarEnvio(c, kbps);
  }
}
function limitarEnvio(call, kbps, tentativas = 0) {
  const pc = call.peerConnection;
  if (!pc || pc.connectionState !== 'connected') { if (tentativas < 60) setTimeout(() => limitarEnvio(call, kbps, tentativas + 1), 250); return; }
  pc.getSenders().forEach((snd) => {
    if (!snd.track || snd.track.kind !== 'video') return;
    const p = snd.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = kbps * 1000;
    snd.setParameters(p).catch(() => {});
  });
}

// Vigia: se pararem de chegar dados por ~10 s com a conexão aparentemente viva, reconecta.
async function vigiar(v) {
  if (viewer !== v || v.fim || v.aguardando || !v.ok || !v.call || !v.call.peerConnection) return;
  try {
    const st = await v.call.peerConnection.getStats();
    let total = 0;
    st.forEach((r) => { if (r.type === 'inbound-rtp') total += r.bytesReceived || 0; });
    if (total === v.bytes) v.parado++; else v.parado = 0;
    v.bytes = total;
    if (v.parado >= 5) { v.parado = 0; reconectar(v, 'A imagem parou de chegar.'); }
  } catch {}
}

function reduzirAtraso(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  pc.getReceivers().forEach((r) => {
    const ms = r.track && r.track.kind === 'audio' ? 120 : 50; // áudio com mais folga: evita falhas e cortes
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms; } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = ms / 1000; } catch {}
  });
}


function sairViewer() {
  if (!viewer) return;
  viewer.fim = true;
  clearInterval(viewer.vigia);
  try { viewer.peer && viewer.peer.destroy(); } catch {}
  viewer = null;
  $('remoto').srcObject = null;
  history.replaceState(null, '', location.pathname);
  mostrar('tela-inicio');
}

// ---------- Eventos ----------
$('btn-compartilhar').onclick = iniciarHost;
$('btn-parar').onclick = pararHost;
$('btn-trocar').onclick = trocarFonte;
function atualizarBotaoRepasse() {
  const b = $('btn-repasse'), lig = escolha.repasse !== false;
  b.querySelector('span').textContent = lig ? 'Repasse entre espectadores: ligado' : 'Repasse entre espectadores: desligado';
  b.classList.toggle('desligado', !lig);
}
$('btn-repasse').onclick = () => {
  escolha.repasse = escolha.repasse === false;
  if (host) host.repasse = escolha.repasse;
  salvarEscolha(); atualizarBotaoRepasse();
};
atualizarBotaoRepasse();
function atualizarBotaoAuto() {
  const b = $('btn-auto'), lig = escolha.auto !== false;
  b.querySelector('span').textContent = lig ? 'Ajuste automático: ligado' : 'Ajuste automático: desligado';
  b.classList.toggle('desligado', !lig);
}
$('btn-auto').onclick = () => {
  escolha.auto = escolha.auto === false;
  if (escolha.auto === false && host) { host.nivel = 0; host.ruim = 0; host.bom = 0; atualizarQualidade(); }
  salvarEscolha(); atualizarBotaoAuto(); mostrarRede();
};
atualizarBotaoAuto();
$('live-res').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  escolha.res = Number(b.dataset.v); aplicarQualidadeAoVivo();
};
$('live-fps').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  escolha.fps = Number(b.dataset.v); aplicarQualidadeAoVivo();
};
$('btn-audio-host').onclick = () => {
  if (!host || !host.audioReal) return;
  host.audioLigado = !host.audioLigado;
  host.stream.getAudioTracks().forEach((t) => (t.enabled = host.audioLigado));
  atualizarBotaoAudio();
  if (host.audioLigado) host.silencioDesde = Date.now();
};
$('seg-conteudo').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  conteudo = b.dataset.v; marcarSeg('seg-conteudo', conteudo); aplicarConteudo();
};
$('btn-copiar').onclick = async () => {
  const btn = $('btn-copiar'), rot = btn.querySelector('span');
  if (await copiar($('host-link').value)) {
    rot.textContent = 'Link copiado!'; btn.classList.add('ok'); trocarIcone(btn, 'i-check');
  } else { $('host-link').select(); rot.textContent = 'Selecione e copie (Ctrl+C)'; }
  setTimeout(() => { rot.textContent = 'Copiar link da sala'; btn.classList.remove('ok'); trocarIcone(btn, 'i-copy'); }, 2000);
};
$('btn-copiar-codigo').onclick = async () => {
  const b = $('btn-copiar-codigo');
  await copiar(host ? host.codigo : '');
  b.lastChild.textContent = 'Copiado!';
  setTimeout(() => (b.lastChild.textContent = 'Código'), 1500);
};
$('btn-enviar').onclick = () => {
  navigator.share({ title: 'Compartilhar Tela', text: 'Assista minha tela ao vivo:', url: $('host-link').value }).catch(() => {});
};
$('form-assistir').onsubmit = (e) => { e.preventDefault(); assistir($('codigo').value); };
$('codigo').oninput = (e) => { e.target.value = limparCodigo(e.target.value); };
$('btn-sair').onclick = sairViewer;
// mede a barra de controles para o modo cinema deixar o vídeo ocupar exatamente o resto da tela
if (window.ResizeObserver) {
  new ResizeObserver(() => document.documentElement.style.setProperty('--barra-h', Math.ceil($('barra-vista').getBoundingClientRect().height) + 'px')).observe($('barra-vista'));
}
const campoNome = $('viewer-nome');
campoNome.value = lerNome();
campoNome.addEventListener('input', () => {
  const n = limparNome(campoNome.value);
  gravarNome(n);
  clearTimeout(campoNome.t);
  campoNome.t = setTimeout(() => { if (viewer && viewer.conn && viewer.conn.nomeEnviar) viewer.conn.nomeEnviar(); }, 400);
});
$('btn-voltar').onclick = sairViewer;
$('btn-tentar').onclick = () => { if (viewer) { const c = viewer.codigo; sairViewer(); assistir(c); } };
$('btn-sair-vista').onclick = sairViewer;

// ---------- Player: som, modos de exibição, ajuste e tamanho ----------
const prefs = { vol: 1, fit: 'contain', tam: '100' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('viewPrefs') || '{}')); } catch {}
function salvarPrefs() { try { localStorage.setItem('viewPrefs', JSON.stringify(prefs)); } catch {} }

let modoView = 'normal'; // normal | cinema | janela (tela cheia no monitor e PiP são independentes)

function atualizarSom() {
  const v = $('remoto');
  const mudo = v.muted || v.volume === 0;
  $('btn-ativar-som').hidden = !(mudo && v.dataset.autoMudo === '1' && v.srcObject && v.srcObject.getAudioTracks().length > 0);
  trocarIcone($('btn-som'), mudo ? 'i-mute' : 'i-volume');
  $('btn-som').title = mudo ? 'Ativar som (M)' : 'Silenciar (M)';
  $('vol').value = v.muted ? 0 : v.volume;
}
function alternarMudo() {
  const v = $('remoto');
  delete v.dataset.autoMudo;
  if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = prefs.vol || 1; }
  else v.muted = true;
  atualizarSom();
}
$('btn-som').onclick = alternarMudo;
$('btn-ativar-som').onclick = (e) => { e.stopPropagation(); alternarMudo(); };
$('vol').oninput = (e) => {
  const v = $('remoto'), n = Number(e.target.value);
  delete v.dataset.autoMudo;
  v.volume = n; v.muted = n === 0;
  if (n > 0) { prefs.vol = n; salvarPrefs(); }
  atualizarSom();
};

// Destaca na barra o modo atual e esconde o seletor de tamanho fora do modo "na página".
function atualizarVista() {
  const fs = !!document.fullscreenElement;
  const pip = !!document.pictureInPictureElement;
  $('seg-modo').querySelectorAll('button').forEach((b) => {
    const m = b.dataset.modo;
    b.classList.toggle('on', m === 'monitor' ? fs : m === 'pip' ? pip : (!fs && m === modoView));
  });
  $('btn-tela-cheia').classList.toggle('on', fs);
  $('g-tam').hidden = modoView !== 'normal' || fs;
}

// Em cinema/janela o palco é movido para o <body>: assim o position:fixed é sempre
// relativo à janela do navegador, sem ser afetado por nenhum elemento pai.
const marcadorPalco = document.createComment('palco');
$('palco').before(marcadorPalco);

function definirModo(m) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  modoView = m;
  const palco = $('palco');
  if (m === 'normal') {
    if (palco.parentNode === document.body) marcadorPalco.after(palco);
  } else if (palco.parentNode !== document.body) {
    document.body.append(palco);
  }
  palco.classList.toggle('m-cinema', m === 'cinema');
  palco.classList.toggle('m-janela', m === 'janela');
  document.body.classList.toggle('cinema-ativo', m === 'cinema');
  document.body.classList.toggle('janela-ativa', m === 'janela');
  atualizarVista();
}
function alternarModo(m) { definirModo(modoView === m ? 'normal' : m); }

function alternarMonitor() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('player').requestFullscreen().catch(() => {});
}
async function alternarPip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await $('remoto').requestPictureInPicture();
  } catch {}
}
function sairModos() {
  definirModo('normal');
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
}

$('btn-tela-cheia').onclick = alternarMonitor;
if (!document.pictureInPictureEnabled) document.querySelector('#seg-modo [data-modo="pip"]').hidden = true;
$('seg-modo').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const m = b.dataset.modo;
  if (m === 'monitor') alternarMonitor();
  else if (m === 'pip') alternarPip();
  else definirModo(m);
};

function aplicarPrefs() {
  $('player').style.setProperty('--fit', prefs.fit);
  $('palco').style.setProperty('--larg', prefs.tam === '100' ? '100%' : prefs.tam + 'px');
  marcarSeg('seg-fit', prefs.fit);
  marcarSeg('seg-tam', prefs.tam);
}
$('seg-fit').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.fit = b.dataset.v; salvarPrefs(); aplicarPrefs();
};
$('seg-tam').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.tam = b.dataset.v; salvarPrefs(); aplicarPrefs();
};
aplicarPrefs();
atualizarVista();

document.addEventListener('fullscreenchange', atualizarVista);
$('remoto').addEventListener('enterpictureinpicture', atualizarVista);
$('remoto').addEventListener('leavepictureinpicture', atualizarVista);

// Atalhos: F monitor · T janela cheia · C cinema · P flutuar · M mudo · Esc volta
document.addEventListener('keydown', (e) => {
  if (!viewer || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.tagName === 'INPUT' && e.target.id !== 'vol') return;
  const k = e.key.toLowerCase();
  if (k === 'f') alternarMonitor();
  else if (k === 't') alternarModo('janela');
  else if (k === 'c') alternarModo('cinema');
  else if (k === 'p' && document.pictureInPictureEnabled) alternarPip();
  else if (k === 'm') alternarMudo();
  else if (k === 'escape') { if (modoView !== 'normal') definirModo('normal'); }
  else return;
  acordar();
});

// Controles do vídeo somem quando o mouse fica parado
let ociosoTimer;
function acordar() {
  const p = $('player');
  p.classList.remove('ocioso');
  clearTimeout(ociosoTimer);
  ociosoTimer = setTimeout(() => { if (viewer && viewer.ok) p.classList.add('ocioso'); }, 2800);
}
['mousemove', 'touchstart', 'click'].forEach((ev) => $('player').addEventListener(ev, acordar, { passive: true }));
// o primeiro clique no vídeo também ativa o som quando o navegador o bloqueou
$('player').addEventListener('click', (e) => { const v = $('remoto'); if (v.dataset.autoMudo === '1' && !e.target.closest('.controles')) alternarMudo(); });
$('player').addEventListener('dblclick', alternarMonitor);
$('remoto').addEventListener('resize', () => {
  const v = $('remoto');
  if (!v.videoWidth) return;
  $('badge-res').textContent = `${v.videoWidth}×${v.videoHeight}`;
  $('badge-res').hidden = false;
});
// (não paramos as capturas no beforeunload: o navegador as encerra sozinho ao fechar a página, e navegar para um
// endereço externo como compartilhartela-audio:// também dispara esse evento sem sair da página)

iniciarSeletores();

// Compartilhar exige getDisplayMedia (indisponível em celulares).
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  $('btn-compartilhar').disabled = true;
  $('btn-compartilhar').lastChild.textContent = 'Compartilhar (indisponível neste dispositivo)';
}

// Entrar direto por link ?sala=CODIGO (página focada só no player)
const salaUrl = new URLSearchParams(location.search).get('sala');
if (salaUrl) {
  // links de sala são temporários: não devem aparecer no Google
  const robots = document.createElement('meta');
  robots.name = 'robots'; robots.content = 'noindex, nofollow';
  document.head.append(robots);
  assistir(salaUrl);
}

// Animações de entrada ao rolar
(function () {
  const itens = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) return itens.forEach((i) => i.classList.add('visivel'));
  const obs = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('visivel'); obs.unobserve(e.target); }
  }), { threshold: 0.12 });
  itens.forEach((i) => obs.observe(i));
})();

// ---------- PWA ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let promptInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptInstalar = e;
  $('btn-instalar').hidden = false;
});
$('btn-instalar').onclick = async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt();
  await promptInstalar.userChoice;
  promptInstalar = null;
  $('btn-instalar').hidden = true;
};

// Destaque de luz que acompanha o mouse nos cards da página inicial
document.addEventListener('mousemove', (e) => {
  const alvo = e.target.closest && e.target.closest('.bx, .uso');
  if (!alvo) return;
  const r = alvo.getBoundingClientRect();
  alvo.style.setProperty('--mx', e.clientX - r.left + 'px');
  alvo.style.setProperty('--my', e.clientY - r.top + 'px');
}, { passive: true });
