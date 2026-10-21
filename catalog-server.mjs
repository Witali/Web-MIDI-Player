import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function createCatalogServer(directory) {
  const root = fs.realpathSync(directory), midiRoot = fs.realpathSync(path.join(root, 'midi'));
  const identity = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const server = http.createServer((request, response) => {
    const fail = status => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(status === 404 ? 'Файл не найден' : 'Запрос не поддерживается'); };
    if (!['GET', 'HEAD'].includes(request.method)) { fail(405); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { fail(400); return; }
    if (pathname === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ application: 'web-midi-player', identity })); return;
    }
    let absolute, type;
    if (['/', '/index.html'].includes(pathname)) { absolute = path.join(root, 'index.html'); type = 'text/html; charset=utf-8'; }
    else if (['/manifest.webmanifest', '/pwa-client.js', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png'].includes(pathname)) {
      absolute = path.join(root, pathname.slice(1));
      type = pathname.endsWith('.webmanifest') ? 'application/manifest+json' : pathname.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8';
    }
    else if (['/library.csv', '/library.json'].includes(pathname)) { absolute = path.join(root, pathname.slice(1)); type = pathname.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8'; }
    else if (pathname.startsWith('/midi/') && /\.(mid|midi|rmi|kar)$/i.test(pathname)) {
      absolute = path.resolve(root, `.${pathname}`); type = 'audio/midi';
      if (!absolute.startsWith(`${midiRoot}${path.sep}`)) { fail(404); return; }
    } else if (pathname.startsWith('/player/')) {
      const playerTypes = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.wasm': 'application/wasm', '.sf2': 'application/octet-stream', '.sf3': 'application/octet-stream',
        '.ogg': 'audio/ogg', '.pcm': 'application/octet-stream', '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
      type = playerTypes[path.extname(pathname).toLowerCase()];
      absolute = path.resolve(root, `.${pathname}`);
      if (!type || !absolute.startsWith(`${path.join(root, 'player')}${path.sep}`)) { fail(404); return; }
    } else if (pathname.startsWith('/sources/')) {
      const sourceTypes = { '.ly': 'text/plain; charset=utf-8', '.zip': 'application/zip' };
      type = sourceTypes[path.extname(pathname).toLowerCase()];
      absolute = path.resolve(root, '.' + pathname);
      if (!type || !absolute.startsWith(path.join(root, 'sources') + path.sep)) { fail(404); return; }
    } else { fail(404); return; }
    try {
      const real = fs.realpathSync(absolute), stat = fs.statSync(real);
      if (!real.startsWith(`${root}${path.sep}`) || !stat.isFile()) { fail(404); return; }
      if (type === 'audio/midi' && !real.startsWith(`${midiRoot}${path.sep}`)) { fail(404); return; }
      if (pathname.startsWith('/player/') && !real.startsWith(`${path.join(root, 'player')}${path.sep}`)) { fail(404); return; }
      if (pathname.startsWith('/sources/') && !real.startsWith(`${path.join(root, 'sources')}${path.sep}`)) { fail(404); return; }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': /^\/player\/soundfonts\/fluidr3-gm\/samples\/[a-f0-9]{64}\.(ogg|pcm)$/.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      if (request.method === 'HEAD') response.end();
      else { const stream = fs.createReadStream(real); stream.on('error', () => response.destroy()); stream.pipe(response); }
    } catch { fail(404); }
  });
  return { server, identity };
}

function openBrowser(url) {
  const program = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => console.error(`Open this URL manually: ${url}\n${error.message}`)); child.unref();
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8765' }, output: { type: 'string' }, open: { type: 'boolean' } } });
  const directory = path.resolve(values.output || path.join(path.dirname(fileURLToPath(import.meta.url)), 'downloads'));
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
  if (!fs.existsSync(path.join(directory, 'index.html'))) throw new Error('Build the catalog first: npm run catalog');
  const { server, identity } = createCatalogServer(directory), url = `http://127.0.0.1:${port}/`;
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && values.open) {
      try {
        const existing = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
        if (existing.application === 'web-midi-player' && existing.identity === identity) { openBrowser(url); return; }
      } catch {}
    }
    console.error(error.message); process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Web-MIDI-Player: ${url}\nOnly local connections are accepted. Ctrl+C stops the catalog.`);
    if (values.open) openBrowser(url);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
