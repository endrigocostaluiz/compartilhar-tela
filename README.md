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

- `assistente/compartilhar-audio.bat`: **instalador de uso único** (texto puro, janela fecha em ~6 s). Compila no próprio
  computador, a partir do código-fonte contido no arquivo, o programa `%LOCALAPPDATA%CompartilharTelaAssistenteAudio.exe`
  (sem janela) e registra o endereço `compartilhartela-audio://` (somente no usuário atual, sem administrador).
- Depois de instalado, a página abre o assistente sozinha quando o usuário escolhe **Escolher aplicativos**
  (o navegador pede confirmação na primeira vez). O assistente roda em segundo plano e **fecha sozinho ~15 s depois que a página é fechada**.
- Usa a captura de áudio por aplicativo do Windows 10 (2004+) / 11 e entrega o som à página por WebSocket **local** (`127.0.0.1:17653`).
  Só aceita conexões da própria página (cabeçalho `Origin`; a lista fica em `OrigensPermitidas`).
- `assistente/remover-assistente.bat` desfaz tudo (encerra o programa, apaga a pasta e o endereço registrado).
- `assistente.js` é o cliente (WebSocket + AudioWorklet que vira a faixa de áudio da transmissão). A conexão local só é aberta
  quando a opção **Escolher aplicativos** é escolhida.
- Os `.bat` precisam ficar com quebras de linha **CRLF** (por isso `*.bat -text` no `.gitattributes`).
- Log de diagnóstico: `%LOCALAPPDATA%CompartilharTelaassistente.log`.

### Segurança com jogos e anti-cheat

O assistente foi escrito para **não tocar nos processos dos jogos**:

- Captura o áudio pela API do Windows de captura por aplicativo (`ActivateAudioInterfaceAsync` com `PROCESS_LOOPBACK`), a mesma
  que o OBS usa em "Captura de áudio de aplicativo". É o serviço de áudio do Windows que entrega o som; o assistente não anexa
  nada ao jogo.
- A lista de aplicativos vem das sessões de áudio do Windows (`IAudioSessionManager2`) e a árvore de processos de um instantâneo
  do sistema (`CreateToolhelp32Snapshot`). **O nome de cada app é lido do arquivo no disco**, cujo caminho vem do identificador da
  sessão de áudio. Versões anteriores usavam `Process.MainModule`, que abre o processo com permissão de leitura de memória; isso
  foi removido justamente para não gerar esse tipo de acesso a processos de jogos.
- O código-fonte (dentro do `.bat`) não contém `OpenProcess`, `ReadProcessMemory`, `WriteProcessMemory`, `CreateRemoteThread`,
  `LoadLibrary`, hooks nem injeção de DLL. Dá para conferir com uma busca de texto.
- Verificado em execução: varrendo a tabela de handles do Windows durante a listagem e a captura, o assistente não mantém nenhum
  handle aberto para outros processos (e a mesma verificação detecta um handle de leitura de memória num teste de controle).

Mesmo assim, **nenhum teste substitui a regra do próprio jogo**: não há como garantir o comportamento de todos os anti-cheats
(BattlEye, EAC, Vanguard etc.), e eles mudam com o tempo. Não conhecemos casos de punição por captura de áudio por aplicativo
(o OBS faz o mesmo), mas, em jogos competitivos com regras rígidas, vale conferir o FAQ do anti-cheat do jogo antes de usar.
