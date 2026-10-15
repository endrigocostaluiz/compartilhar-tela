'use strict';
// Efeitos de fundo interativos (inspirados em animações do CodePen, recriados e adaptados à paleta).
//
// REGRA Nº 1: nunca atrapalhar a transmissão nem o FPS dos jogos. Por isso:
//  - só animam com a página visível, em foco e em tela; ao perder o foco (alt-tab para o jogo) PARAM;
//  - nunca rodam durante uma transmissão ou ao assistir (body.foco);
//  - no máx. 30 quadros/s, sem escala de alta densidade de pixels;
//  - os efeitos de mouse só trabalham enquanto o mouse se mexe e depois ficam parados (custo zero);
//  - se um efeito demorar demais por quadro, todos se desligam sozinhos;
//  - respeitam "reduzir movimento", "economia de dados" e uma chave "Efeitos visuais" ligada/desligada.
(function () {
  const html = document.documentElement;
  const body = document.body;
  const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches || !!(navigator.connection && navigator.connection.saveData);
  const comMouse = matchMedia('(hover: hover)').matches;

  // ---------- estado e travas ----------
  const estado = { usuario: true, pesado: false };
  try { estado.usuario = localStorage.getItem('fx') !== 'off'; } catch {}
  try { estado.pesado = sessionStorage.getItem('fx-pesado') === '1'; } catch {}

  const habilitado = () => !reduzido && comMouse && estado.usuario && !estado.pesado;
  const focado = () => window.__fxForcar || document.hasFocus();
  const podeAnimar = () => habilitado() && !document.hidden && focado() && !body.classList.contains('foco');

  const fxs = [];
  function aplicarEstado() {
    html.classList.toggle('fx-off', !habilitado());
    fxs.forEach((f) => f.reavaliar());
    atualizarBotoes();
  }
  function marcarPesado() {
    estado.pesado = true;
    try { sessionStorage.setItem('fx-pesado', '1'); } catch {}
    aplicarEstado();
  }
  function atualizarBotoes() {
    document.querySelectorAll('[data-fx-toggle]').forEach((b) => {
      const on = habilitado();
      b.textContent = reduzido ? 'Efeitos visuais: desativados (movimento reduzido)'
        : !comMouse ? 'Efeitos visuais: indisponíveis neste dispositivo'
        : estado.pesado ? 'Efeitos visuais: desligados (automático)'
        : on ? 'Efeitos visuais: ligados' : 'Efeitos visuais: desligados';
      b.setAttribute('aria-pressed', String(on));
      b.disabled = reduzido || !comMouse;
    });
  }
  document.querySelectorAll('[data-fx-toggle]').forEach((b) => b.addEventListener('click', () => {
    if (estado.pesado) { estado.pesado = false; try { sessionStorage.removeItem('fx-pesado'); } catch {} estado.usuario = true; }
    else estado.usuario = !estado.usuario;
    try { localStorage.setItem('fx', estado.usuario ? 'on' : 'off'); } catch {}
    aplicarEstado();
  }));

  // ---------- laço de animação com limite de 30 fps e auto-proteção ----------
  function criarLoop(quadro) {
    let id = 0, ult = 0; const custos = [];
    const tick = (t) => {
      id = requestAnimationFrame(tick);
      if (t - ult < 32) return;
      const dt = Math.min(t - ult, 100); ult = t;
      if (!podeAnimar()) return parar();
      const a = performance.now();
      const seguir = quadro(dt);
      custos.push(performance.now() - a);
      if (custos.length >= 90) {
        const media = custos.reduce((x, y) => x + y, 0) / custos.length;
        custos.length = 0;
        loop.custoMedio = media;
        if (media > 7) return marcarPesado(); // efeito pesado demais para esta máquina
      }
      if (seguir === false) parar();
    };
    function parar() { if (id) { cancelAnimationFrame(id); id = 0; } }
    const loop = {
      custoMedio: 0,
      iniciar() { if (!id && podeAnimar()) { ult = 0; id = requestAnimationFrame(tick); } },
      parar,
      ativo: () => !!id,
    };
    return loop;
  }

  function observar(el, fx) {
    fx.vis = false;
    if (!('IntersectionObserver' in window)) { fx.vis = true; return; }
    new IntersectionObserver(([e]) => { fx.vis = e.isIntersecting; fx.reavaliar(); }, { rootMargin: '40px' }).observe(el);
  }
  const exibido = (el) => el.getClientRects().length > 0;
  function ajustarCanvas(canvas, w, h) { if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h; }
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------- 1) Constelação (hero): pontos ligados por linhas, o mouse vira mais um ponto ----------
  function constelacao(canvas) {
    const ctx = canvas.getContext('2d');
    const fx = { aoMover: null }; let w = 0, h = 0, nos = [];
    const mouse = { x: 0, y: 0, dentro: false };
    const DIST = 175, DIST_M = 210;

    function medir() {
      w = canvas.clientWidth; h = canvas.clientHeight; ajustarCanvas(canvas, w, h);
      const n = Math.min(72, Math.max(22, Math.round((w * h) / 15000)));
      nos = Array.from({ length: n }, () => ({ x: rnd(0, w), y: rnd(0, h), vx: rnd(-0.28, 0.28), vy: rnd(-0.28, 0.28) }));
    }
    const loop = criarLoop((dt) => {
      const k = dt / 33;
      ctx.clearRect(0, 0, w, h);
      for (const n of nos) {
        n.x += n.vx * k; n.y += n.vy * k;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < nos.length; i++) {
        const a = nos[i];
        for (let j = i + 1; j < nos.length; j++) {
          const b = nos[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 < DIST * DIST) {
            ctx.strokeStyle = `rgba(52,211,153,${(1 - Math.sqrt(d2) / DIST) * 0.45})`;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        if (mouse.dentro) {
          const dx = a.x - mouse.x, dy = a.y - mouse.y, d2 = dx * dx + dy * dy;
          if (d2 < DIST_M * DIST_M) {
            ctx.strokeStyle = `rgba(110,231,183,${(1 - Math.sqrt(d2) / DIST_M) * 0.75})`;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(16,185,129,.85)';
      for (const n of nos) { ctx.beginPath(); ctx.arc(n.x, n.y, 2.1, 0, 6.2832); ctx.fill(); }
      if (mouse.dentro) { ctx.fillStyle = 'rgba(167,243,208,.95)'; ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 2.6, 0, 6.2832); ctx.fill(); }
    });
    fx.aoMover = (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      mouse.dentro = mouse.x >= 0 && mouse.y >= 0 && mouse.x <= r.width && mouse.y <= r.height;
    };
    fx.reavaliar = () => {
      if (podeAnimar() && fx.vis && exibido(canvas)) { if (!nos.length) medir(); loop.iniciar(); }
      else { loop.parar(); if (w) ctx.clearRect(0, 0, w, h); }
    };
    fx.loop = loop;
    window.addEventListener('resize', () => { if (fx.vis) medir(); }, { passive: true });
    observar(canvas, fx); fxs.push(fx);
  }

  // ---------- 2) Grade luminosa (Em ação): casas acendem sob o mouse e apagam ----------
  function grade(canvas, secao) {
    const ctx = canvas.getContext('2d'), fx = {}; const C = 72; const acesas = new Map();
    function medir() { ajustarCanvas(canvas, canvas.clientWidth, canvas.clientHeight); }
    const loop = criarLoop((dt) => {
      const k = dt / 33, agora = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const [chave, c] of acesas) {
        if (agora - c.t > 350) c.a -= 0.04 * k;
        if (c.a <= 0) { acesas.delete(chave); continue; }
        const x = c.cx * C, y = c.cy * C;
        ctx.fillStyle = `rgba(16,185,129,${c.a * 0.07})`; ctx.fillRect(x, y, C, C);
        ctx.strokeStyle = `rgba(52,211,153,${c.a * 0.75})`; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, C - 1, C - 1);
      }
      return acesas.size > 0;
    });
    fx.aoMover = (e) => {
      if (!podeAnimar() || !fx.vis) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      if (canvas.width !== Math.round(r.width)) medir();
      const cx = Math.floor(x / C), cy = Math.floor(y / C), t = performance.now();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const a = dx === 0 && dy === 0 ? 1 : (dx !== 0 && dy !== 0 ? 0.25 : 0.5);
        const chave = (cx + dx) + ',' + (cy + dy), atual = acesas.get(chave);
        if (!atual || atual.a < a) acesas.set(chave, { cx: cx + dx, cy: cy + dy, a, t });
      }
      loop.iniciar();
    };
    fx.loop = loop;
    fx.reavaliar = () => { if (!(podeAnimar() && fx.vis)) { loop.parar(); acesas.clear(); ctx.clearRect(0, 0, canvas.width, canvas.height); } };
    observar(secao, fx); fxs.push(fx);
  }

  // ---------- 3) Atração (Conexão): partículas atraídas pelo mouse, "explodem" ao chegar ----------
  function atracao(canvas, caixa) {
    const ctx = canvas.getContext('2d'), fx = {}; let w = 0, h = 0, ps = [], alvo = { x: 0, y: 0 }, ativoAte = 0;
    function nova() {
      return { x: rnd(0, w), y: rnd(0, h), tam: rnd(1, 4.5), v: 0, alpha: 0, tom: rnd(150, 188), mudou: false, q: 0 };
    }
    function medir() { w = canvas.clientWidth; h = canvas.clientHeight; ajustarCanvas(canvas, w, h); ps = Array.from({ length: 52 }, nova); alvo = { x: w / 2, y: h / 2 }; ps.forEach((p) => (p.v = p.tam * 0.5)); }
    const loop = criarLoop(() => {
      const agora = performance.now();
      ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      const parado = agora > ativoAte;
      for (const p of ps) {
        ctx.strokeStyle = `hsla(${p.tom},80%,58%,${p.alpha})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.tam, 0, 6.2832); ctx.stroke();
        if (p.mudou) {
          p.alpha *= 0.92; p.tam += 2; p.q++;
          if (p.q > 40) Object.assign(p, nova());
        } else if (Math.hypot(alvo.x - p.x, alvo.y - p.y) < 40) p.mudou = true;
        else {
          const ang = Math.atan2(alvo.y - p.y, alvo.x - p.x);
          p.alpha = Math.min(0.9, p.alpha + 0.012); p.x += p.v * Math.cos(ang); p.y += p.v * Math.sin(ang); p.v += 0.02;
        }
      }
      if (parado && agora > ativoAte + 1800) { ctx.clearRect(0, 0, w, h); ps.forEach((p) => Object.assign(p, nova())); return false; }
    });
    fx.aoMover = (e) => {
      if (!podeAnimar() || !fx.vis) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      if (!w) medir();
      alvo.x = x; alvo.y = y; ativoAte = performance.now() + 2200; loop.iniciar();
    };
    fx.loop = loop;
    fx.reavaliar = () => { if (!(podeAnimar() && fx.vis)) { loop.parar(); if (w) ctx.clearRect(0, 0, w, h); } };
    observar(caixa, fx); fxs.push(fx);
  }

  // ---------- 4) Malha de triângulos com brilho (chamada final): só CSS + 1 transform, sem laço ----------
  function malha(caixa) {
    const fx = {}; let montado = false, brilho, pend = null;
    const BASE = 48, GAP = 2, LARG = BASE * 2 + GAP, ALT = 83;
    function montar() {
      if (montado) return; montado = true;
      caixa.textContent = '';
      brilho = document.createElement('div'); brilho.className = 'fx-brilho';
      const grid = document.createElement('div'); grid.className = 'fx-malha';
      const col = Math.ceil(caixa.clientWidth / LARG) + 1, lin = Math.ceil(caixa.clientHeight / ALT) + 1;
      grid.style.setProperty('--col', col);
      for (let y = 0; y < lin; y++) for (let x = 0; x < col; x++) {
        const t = document.createElement('div'); t.className = 'fx-tri' + (y % 2 === 0 ? ' desl' : ''); grid.append(t);
      }
      caixa.append(brilho, grid);
      mover(caixa.clientWidth / 2, caixa.clientHeight / 2);
    }
    function mover(x, y) { brilho.style.transform = `translate3d(${x}px,${y}px,0)`; }
    fx.aoMover = (e) => {
      if (!podeAnimar() || !fx.vis) return;
      const r = caixa.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < -40 || y < -40 || x > r.width + 40 || y > r.height + 40) return;
      montar();
      if (!pend) pend = requestAnimationFrame(() => { pend = null; mover(x, y); });
    };
    fx.reavaliar = () => { if (podeAnimar() && fx.vis) montar(); };
    window.addEventListener('resize', () => { montado = false; if (fx.vis) montar(); }, { passive: true });
    observar(caixa, fx); fxs.push(fx);
  }

  // ---------- inicialização ----------
  const q = (s) => document.querySelector(s);
  if (q('.fx-hero')) constelacao(q('.fx-hero'));
  if (q('.fx-grid')) grade(q('.fx-grid'), q('#acao'));
  if (q('.fx-atracao')) atracao(q('.fx-atracao'), q('.v2-rede-vis'));
  if (q('.fx-malha-caixa')) malha(q('.fx-malha-caixa'));
  if (q('.fx-app')) constelacao(q('.fx-app')); // mesmo efeito do topo da página, em tela cheia no app instalado

  // um único ouvinte de mouse para todos (barato; cada efeito só reage se estiver ativo)
  let ultimo = 0;
  window.addEventListener('mousemove', (e) => {
    const t = e.timeStamp; if (t - ultimo < 16) return; ultimo = t;
    if (!habilitado()) return;
    for (const f of fxs) f.aoMover && f.aoMover(e);
  }, { passive: true });

  window.addEventListener('blur', aplicarEstado);
  window.addEventListener('focus', aplicarEstado);
  document.addEventListener('visibilitychange', aplicarEstado);
  new MutationObserver(aplicarEstado).observe(body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(aplicarEstado).observe(html, { attributes: true, attributeFilter: ['class'] }); // entrou/saiu do modo app
  aplicarEstado();

  window.Fx = { estado, fxs, custos: () => fxs.map((f) => f.loop && f.loop.custoMedio) };
})();
