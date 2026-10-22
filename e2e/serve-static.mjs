// Serves static folders on 127.0.0.1, one port each: node serve-static.mjs 5191:dir 5192:dir …
// A path without a file falls back to the folder's index.html.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf(':');
  const port = Number(arg.slice(0, i));
  const root = resolve(arg.slice(i + 1));
  createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      if (file.endsWith('.md')) throw new Error('not served');
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, '127.0.0.1', () => console.log(`${root} on http://127.0.0.1:${port}/`));
}
