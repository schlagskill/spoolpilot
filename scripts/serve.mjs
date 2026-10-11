import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const allowed = new Set(['index.html', 'app.js', 'core.js', 'style.css']);
const server = http.createServer(async (req, res) => {
  try {
    const filename = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!allowed.has(filename)) { res.writeHead(404); res.end('Not found'); return; }
    const content = await readFile(path.join(root, filename));
    res.writeHead(200, { 'Content-Type': `${types[path.extname(filename)]}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(500); res.end('Server error'); }
});
const port = Number(process.env.PORT || 43761);
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
