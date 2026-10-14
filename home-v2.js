'use strict';
// Interações da home v2: seção ativa no trilho, abas de recursos e calculadora de upload.

// ---- Trilho lateral: destaca a seção visível ----
(function () {
  const links = document.querySelectorAll('.trilho-nav a');
  const secoes = [...links].map((a) => document.getElementById(a.dataset.sec)).filter(Boolean);
  if (!('IntersectionObserver' in window) || !secoes.length) return;
  const obs = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.toggle('ativo', a.dataset.sec === e.target.id));
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  secoes.forEach((s) => obs.observe(s));
})();

// ---- Abas de recursos ----
(function () {
  const botoes = document.querySelectorAll('.v2-abas-lista button');
  const paineis = document.querySelectorAll('.v2-abas-painel article');
  botoes.forEach((b) => b.addEventListener('click', () => {
    botoes.forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    paineis.forEach((p) => p.classList.toggle('on', p.dataset.painel === b.dataset.aba));
  }));
})();

// ---- Calculadora de upload (mesma fórmula do app) ----
(function () {
  const RES = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };
  const est = { res: 720, fps: 30, n: 4 };
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => v.toFixed(1).replace('.', ',');

  function posicao(mbps) { // escala não linear: 0-10-25-50-100
    const t = [0, 10, 25, 50, 100];
    const m = Math.min(mbps, 100);
    for (let i = 1; i < t.length; i++) {
      if (m <= t[i]) return ((i - 1) + (m - t[i - 1]) / (t[i] - t[i - 1])) * 25;
    }
    return 100;
  }

  function calcular() {
    const [w, h] = RES[est.res];
    const base = Math.round((w * h * est.fps * 0.075) / 1000);
    const fator = est.n >= 7 ? 0.5 : est.n >= 4 ? 0.7 : 1;
    const kbps = Math.max(300, Math.round(base * fator));
    const total = (kbps * est.n) / 1000;
    const indicado = total * 1.3;

    $('c-n-val').textContent = est.n;
    $('c-total').textContent = fmt(total);
    const barra = $('c-barra');
    barra.style.width = Math.max(3, posicao(total)) + '%';
    barra.className = total > 50 ? 'muito' : total > 20 ? 'alto' : '';

    let msg;
    if (total <= 10) msg = 'Uma conexão residencial comum costuma atender bem.';
    else if (total <= 25) msg = 'Exige uma boa conexão de fibra, com upload estável.';
    else if (total <= 50) msg = 'Consumo alto: use apenas com upload dedicado e poucos espectadores.';
    else msg = 'Consumo muito alto. Reduza a resolução, os quadros por segundo ou o número de espectadores.';
    $('c-texto').textContent = `Deixe pelo menos ${fmt(indicado)} Mbps de upload livres. ${msg}`;
  }

  function seg(id, chave) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      est[chave] = Number(b.dataset.v);
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      calcular();
    });
  }
  seg('c-res', 'res');
  seg('c-fps', 'fps');
  $('c-n').addEventListener('input', (e) => { est.n = Number(e.target.value); calcular(); });
  calcular();
})();
