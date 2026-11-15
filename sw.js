// Service worker: só guarda o "casco" do app para instalação/abertura rápida.
// Nunca intercepta WebSocket/WebRTC (não passam pelo fetch do SW).
const CACHE = 'compartilhar-tela-v56';
const ARQUIVOS = [
  './',
  './index.html',
  './style.css',
  './home.css',
  './home.js',
  './fx.js',
  './assistente.js',
  './app.js',
  './vendor/peerjs.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.svg',
  './favicon.ico',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Rede primeiro (para sempre pegar a versão nova), cache como reserva.
// A chave do cache ignora a query string: links de sala (?sala=CODIGO) não geram uma entrada por código
// e os códigos não ficam guardados no cache. Só respostas válidas (200) são guardadas.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  url.search = '';
  const chave = url.href;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && r.type === 'basic') {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(chave, copia));
        }
        return r;
      })
      .catch(() => caches.match(chave).then((r) => r || caches.match('./index.html')))
  );
});
