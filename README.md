# Compartilhar Tela

Transmissão de tela e áudio direto no navegador (WebRTC ponto a ponto), sem conta, sem instalação e sem servidor de vídeo. Até 10 espectadores por sala. Instalável como PWA.

Desenvolvido por Endrigo Costa.

## Testar localmente

```
node servidor-local.js 8080
```

Abra http://localhost:8080 (o `localhost` é contexto seguro, necessário para `getDisplayMedia`).

## Publicar

Site estático: basta servir esta pasta por HTTPS (por exemplo, GitHub Pages). O arquivo `servidor-local.js` é só para testes.

## Estrutura

- `index.html`, `style.css`, `home.css`, `home.js`, `fx.js`, `app.js`: página, efeitos visuais e lógica
- `vendor/peerjs.min.js`: PeerJS 1.5.4 (sinalização via PeerJS Cloud público)
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA
