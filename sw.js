// Service worker: só guarda o "casco" do app para instalação/abertura rápida.
// Nunca intercepta WebSocket/WebRTC (não passam pelo fetch do SW).
const CACHE = 'compartilhar-tela-v34';
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
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
