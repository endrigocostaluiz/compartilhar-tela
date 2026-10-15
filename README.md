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

## Assistente de áudio (opcional, só Windows)

Por padrão a transmissão envia **todo o áudio** do sistema (ou da aba), como qualquer site faz. O navegador não
consegue escolher aplicativos, então existe um assistente opcional para quem quer isso (ex.: só o jogo, ou tudo menos o Discord):

- `assistente/compartilhar-audio.bat`: um arquivo de texto (PowerShell + C# compilado na hora; não instala nada) que usa a
  captura de áudio por aplicativo do Windows 10 (2004+) / 11 e entrega o som à página por WebSocket **local** (`127.0.0.1:17653`).
- Só aceita conexões da própria página (verifica o cabeçalho `Origin`; a lista fica em `OrigensPermitidas` no arquivo).
- Na página: áudio → **Escolher aplicativos**. A conexão local só é aberta quando essa opção é escolhida.
- `assistente.js` é o cliente (WebSocket + AudioWorklet que vira a faixa de áudio da transmissão).
- O `.bat` precisa ficar com quebras de linha **CRLF** (por isso `*.bat -text` no `.gitattributes`).
