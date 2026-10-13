'use strict';

// ---------- Configuração ----------
const MAX_ESPECTADORES = 10;
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
const escolha = { res: 720, fps: 30, audio: true };
try { Object.assign(escolha, JSON.parse(localStorage.getItem('escolha') || '{}')); } catch {}

// Bitrate-base ≈ pixels × fps × 0,075 bits/pixel (720p30 ≈ 2 Mbps).
function kbpsBase(res, fps) {
  const [w, h] = RESOLUCOES[res];
  return Math.round((w * h * fps * 0.075) / 1000);
}

// Reduz conforme o nº de espectadores (o upload de quem compartilha é o gargalo).
function perfil(n) {
  const base = kbpsBase(escolha.res, escolha.fps);
  let fator = 1, escala = 1;
  if (n >= 7) { fator = 0.5; escala = escolha.res >= 720 ? 1.5 : 1; }
  else if (n >= 4) fator = 0.7;
  const kbps = Math.max(300, Math.round(base * fator));
  const alt = Math.round(RESOLUCOES[escolha.res][1] / escala);
  const mbps = kbps >= 1000 ? (kbps / 1000).toFixed(1).replace('.', ',') + ' Mbps' : kbps + ' kbps';
  return { kbps, fps: escolha.fps, escala, rotulo: `${alt}p · ${escolha.fps} fps · ${mbps}`, curto: `${alt}p·${escolha.fps}` };
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

  // bitrate inicial = alvo; mínimo = 55% do alvo (não nos codecs de retransmissão "apt=")
  const extra = `x-google-start-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps * 0.55)}`;
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
  const mbps = kbpsBase(escolha.res, escolha.fps) / 1000;
  const dica = $('dica-qualidade');
  const txt = `Cada espectador usa ~${mbps.toFixed(1).replace('.', ',')} Mbps do seu upload (com poucos espectadores).`;
  const pesado = mbps >= 4;
  dica.className = 'dica' + (pesado ? ' aviso' : '');
  dica.textContent = pesado ? txt + ' Qualidade alta: use com poucas pessoas e boa internet.' : txt;
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
  $('chk-audio').checked = !!escolha.audio;
  atualizarDica();
  $('seg-res').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    escolha.res = Number(b.dataset.v); marcarSeg('seg-res', escolha.res); salvarEscolha();
  };
  $('seg-fps').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    escolha.fps = Number(b.dataset.v); marcarSeg('seg-fps', escolha.fps); salvarEscolha();
  };
  $('chk-audio').onchange = (e) => { escolha.audio = e.target.checked; salvarEscolha(); };
}

// ---------- Quem compartilha ----------
let host = null; // { peer, stream, viewers: Map<peerId, {conn, call, num}>, codigo, contador, timer }
let conteudo = 'motion'; // 'motion' (fluidez) | 'detail' (nitidez)

async function iniciarHost() {
  const [w, h] = RESOLUCOES[escolha.res];
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: escolha.fps, max: escolha.fps } },
      audio: escolha.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Não foi possível capturar a tela: ' + e.message);
    return;
  }

  mostrar('tela-host');
  const st = $('host-status');
  status(st, 'Criando sala…');
  $('host-max').textContent = MAX_ESPECTADORES;
  $('host-qtd').textContent = '0';
  $('preview').srcObject = stream;

  const vt = stream.getVideoTracks()[0];
  try { await vt.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: escolha.fps, max: escolha.fps } }); } catch {}
  vt.addEventListener('ended', pararHost); // botão "Parar compartilhamento" do navegador

  host = { stream, viewers: new Map(), peer: null, codigo: '', contador: 0, timer: null };
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
  if (escolha.audio && !stream.getAudioTracks().length) {
    status(st, 'Sala criada, mas sem áudio (marque "compartilhar áudio" ao escolher tela inteira ou aba).');
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
    status($('host-status'), 'Sala aberta. Envie o código ou o link.', 'ok');
    atualizarQualidade();
  });

  peer.on('connection', (conn) => aceitarEspectador(h, conn));
  peer.on('disconnected', () => { if (host === h && !peer.destroyed) peer.reconnect(); });

  peer.on('error', (err) => {
    if (host !== h) return;
    if (err.type === 'unavailable-id' && tentativa < 5) {
      peer.destroy();
      return abrirSala(h, tentativa + 1);
    }
    if (err.type === 'peer-unavailable') return; // espectador sumiu antes da chamada
    status($('host-status'), 'Erro de conexão com o servidor de sinalização (' + err.type + ').', 'erro');
  });
}

function aceitarEspectador(h, conn) {
  conn.on('open', () => {
    if (host !== h) return conn.close();
    if (h.viewers.size >= MAX_ESPECTADORES) {
      conn.send({ tipo: 'cheio' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    const kbps = perfil(h.viewers.size + 1).kbps;
    const call = h.peer.call(conn.peer, h.stream, {
      metadata: { kbps },
      sdpTransform: (sdp) => ajustarSdp(sdp, kbps),
    });
    const v = { conn, call, num: ++h.contador };
    h.viewers.set(conn.peer, v);
    const remover = () => {
      if (h.viewers.get(conn.peer) === v) {
        h.viewers.delete(conn.peer);
        atualizarQualidade();
      }
      try { call.close(); } catch {}
    };
    conn.on('close', remover);
    conn.on('error', remover);
    call.on('close', remover);
    call.on('error', remover);
    atualizarQualidade();
    esperarConexao(call);
  });
}

// O peerConnection só existe/conecta depois de um instante: espera e aplica os limites.
function esperarConexao(call, tentativas = 0) {
  const pc = call.peerConnection;
  if (!pc) {
    if (tentativas < 50) setTimeout(() => esperarConexao(call, tentativas + 1), 200);
    return;
  }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') aplicarEmSender(call);
  });
  if (pc.connectionState === 'connected') aplicarEmSender(call);
}

function aplicarEmSender(call) {
  if (!host) return;
  const p = perfil(host.viewers.size);
  const pc = call.peerConnection;
  if (!pc) return;
  const altura = host.stream.getVideoTracks()[0].getSettings().height || RESOLUCOES[escolha.res][1];
  const escalaBase = Math.max(1, altura / RESOLUCOES[escolha.res][1]); // se a captura veio maior que o escolhido
  pc.getSenders().forEach((s) => {
    if (!s.track || s.track.kind !== 'video') return;
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = p.kbps * 1000;
    params.encodings[0].maxFramerate = p.fps;
    params.encodings[0].scaleResolutionDownBy = escalaBase * p.escala;
    params.degradationPreference = conteudo === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    s.setParameters(params).catch(() => {});
  });
}

function atualizarQualidade() {
  if (!host) return;
  const n = host.viewers.size;
  const p = perfil(n);
  $('host-qtd').textContent = n;
  $('host-qualidade').textContent = p.curto;
  $('host-qualidade').title = p.rotulo;
  const up = (p.kbps * n) / 1000;
  $('host-upload').textContent = up.toFixed(1).replace('.', ',') + ' Mbps';
  host.viewers.forEach((v) => aplicarEmSender(v.call));
  renderLista();
}

function renderLista() {
  const ul = $('host-lista');
  ul.textContent = '';
  host.viewers.forEach((v) => {
    const li = document.createElement('li');
    const av = document.createElement('span'); av.className = 'avatar'; av.textContent = v.num;
    const nome = document.createElement('span'); nome.className = 'nome'; nome.textContent = 'Espectador ' + v.num;
    const on = document.createElement('i'); on.className = 'on';
    const x = document.createElement('button'); x.className = 'tirar'; x.title = 'Remover da sala';
    x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    x.onclick = () => {
      try { v.conn.send({ tipo: 'fim' }); } catch {}
      setTimeout(() => { try { v.conn.close(); v.call.close(); } catch {} }, 200);
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
  $('host-lista').textContent = '';
  h.viewers.forEach((v) => { try { v.conn.send({ tipo: 'fim' }); } catch {} });
  setTimeout(() => { try { h.peer.destroy(); } catch {} }, 300);
  h.stream.getTracks().forEach((t) => t.stop());
  $('preview').srcObject = null;
  mostrar('tela-inicio');
}

// ---------- Quem assiste ----------
let viewer = null; // { peer, conn, call, ok }

function overlay(modo, msg) {
  // modo: 'carregando' | 'erro' | 'some'
  const o = $('overlay');
  o.classList.toggle('some', modo === 'some');
  $('carregando').hidden = modo !== 'carregando';
  $('ic-aviso').hidden = modo !== 'erro';
  $('btn-voltar').hidden = modo !== 'erro';
  if (msg) $('overlay-msg').textContent = msg;
}

function assistir(codigo) {
  codigo = limparCodigo(codigo);
  if (codigo.length !== 6) return alert('Informe o código de 6 caracteres.');
  mostrar('tela-viewer');
  const st = $('viewer-status');
  const video = $('remoto');
  video.srcObject = null;
  video.muted = true;
  atualizarSom();
  $('viewer-codigo').textContent = codigo;
  $('badge-res').hidden = true;
  status(st, 'Conectando…');
  overlay('carregando', 'Conectando à sala ' + codigo + '…');

  const v = { peer: criarPeer(), conn: null, call: null, ok: false };
  viewer = v;
  const falhar = (msg) => {
    if (viewer !== v) return;
    status(st, 'Desconectado', 'erro');
    overlay('erro', msg);
  };

  v.peer.on('open', () => {
    const conn = v.peer.connect(PREFIXO_ID + codigo, { reliable: true });
    v.conn = conn;
    const prazo = setTimeout(() => { if (!v.ok) falhar('Sala não encontrada ou sem resposta.'); }, 15000);
    conn.on('open', () => overlay('carregando', 'Aguardando a imagem…'));
    conn.on('data', (m) => {
      if (m && m.tipo === 'cheio') { v.ok = true; falhar('A sala está cheia (máx. ' + MAX_ESPECTADORES + ').'); }
      if (m && m.tipo === 'fim') { falhar('A transmissão terminou.'); }
    });
    conn.on('close', () => { clearTimeout(prazo); if (v.ok) falhar('A transmissão terminou.'); });
  });

  v.peer.on('call', (call) => {
    v.call = call;
    const kbps = (call.metadata && call.metadata.kbps) || 1500;
    call.answer(undefined, { sdpTransform: (sdp) => ajustarSdp(sdp, kbps) }); // não envia nada de volta
    call.on('stream', (stream) => {
      v.ok = true;
      video.srcObject = stream;
      video.muted = false;
      video.volume = prefs.vol;
      status(st, 'Ao vivo', 'ok');
      // tenta com som; se o navegador bloquear o autoplay, entra mudo
      video.play().catch(() => {
        video.muted = true;
        atualizarSom();
        status(st, 'Ao vivo · toque no alto-falante para ativar o som', 'ok');
        return video.play();
      }).catch(() => {});
      atualizarSom();
      acordar();
      overlay('some');
      reduzirAtraso(call);
    });
    call.on('close', () => falhar('A transmissão terminou.'));
  });

  v.peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') falhar('Sala não encontrada. Confira o código.');
    else falhar('Erro de conexão (' + err.type + ').');
  });
}

function reduzirAtraso(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  pc.getReceivers().forEach((r) => {
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = 50; } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = 0.05; } catch {}
  });
}


function sairViewer() {
  if (!viewer) return;
  try { viewer.peer.destroy(); } catch {}
  viewer = null;
  $('remoto').srcObject = null;
  history.replaceState(null, '', location.pathname);
  mostrar('tela-inicio');
}

// ---------- Eventos ----------
$('btn-compartilhar').onclick = iniciarHost;
$('btn-parar').onclick = pararHost;
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
$('btn-voltar').onclick = sairViewer;

// ---------- Player: som, modos de exibição, ajuste e tamanho ----------
const prefs = { vol: 1, fit: 'contain', tam: '100' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('viewPrefs') || '{}')); } catch {}
function salvarPrefs() { try { localStorage.setItem('viewPrefs', JSON.stringify(prefs)); } catch {} }

let modoView = 'normal'; // normal | cinema | janela (tela cheia no monitor e PiP são independentes)

function atualizarSom() {
  const v = $('remoto');
  const mudo = v.muted || v.volume === 0;
  trocarIcone($('btn-som'), mudo ? 'i-mute' : 'i-volume');
  $('btn-som').title = mudo ? 'Ativar som (M)' : 'Silenciar (M)';
  $('vol').value = v.muted ? 0 : v.volume;
}
function alternarMudo() {
  const v = $('remoto');
  if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = prefs.vol || 1; }
  else v.muted = true;
  atualizarSom();
}
$('btn-som').onclick = alternarMudo;
$('vol').oninput = (e) => {
  const v = $('remoto'), n = Number(e.target.value);
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
$('player').addEventListener('dblclick', alternarMonitor);
$('remoto').addEventListener('resize', () => {
  const v = $('remoto');
  if (!v.videoWidth) return;
  $('badge-res').textContent = `${v.videoWidth}×${v.videoHeight}`;
  $('badge-res').hidden = false;
});
window.addEventListener('beforeunload', () => { if (host) host.stream.getTracks().forEach((t) => t.stop()); });

iniciarSeletores();

// Compartilhar exige getDisplayMedia (indisponível em celulares).
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  $('btn-compartilhar').disabled = true;
  $('btn-compartilhar').lastChild.textContent = 'Compartilhar (indisponível neste dispositivo)';
}

// Entrar direto por link ?sala=CODIGO (página focada só no player)
const salaUrl = new URLSearchParams(location.search).get('sala');
if (salaUrl) assistir(salaUrl);

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
