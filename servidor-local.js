// Servidor estático mínimo só para testes locais (node servidor-local.js [porta]).
// http://localhost é tratado como contexto seguro, então getDisplayMedia e o PWA funcionam.
const http = require('http');
const fs = require('fs');
const path = require('path');

const raiz = __dirname;
const porta = Number(process.argv[2]) || 8080;
const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const arquivo = path.join(raiz, path.normalize(p));
  const rel = path.relative(raiz, arquivo);
  // fora da pasta do projeto, o próprio servidor ou arquivos/pastas ocultos (.git, .env...) não são servidos
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || arquivo.endsWith('servidor-local.js') || rel.split(path.sep).some((s) => s.startsWith('.'))) { res.writeHead(403); return res.end(); }
  fs.readFile(arquivo, (err, dados) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(dados);
  });
}).listen(porta, () => console.log(`Servindo em http://localhost:${porta}`));
