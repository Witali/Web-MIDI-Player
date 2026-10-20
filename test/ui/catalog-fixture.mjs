import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCatalog } from '../../src/catalog-output.mjs';
import { buildPublicLibrary } from '../../src/public-library.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const playerRoot = path.join(root, 'Player');

// Serve the production template, CSS, application and modules on an ephemeral
// port. Tests need neither a private MIDI collection nor downloaded sound banks.
export const test = base.extend({
  catalogURL: [async ({}, use) => {
    const html = renderCatalog(buildPublicLibrary(path.join(root, 'public-library')));
    const server = http.createServer((request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(html);
          return;
        }
        if (pathname.startsWith('/player/')) {
          const filename = path.resolve(playerRoot, pathname.slice('/player/'.length));
          if (filename.startsWith(playerRoot + path.sep) && path.extname(filename) === '.js') {
            const source = fs.readFileSync(filename);
            response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            response.end(source);
            return;
          }
        }
      } catch { /* Missing fixture asset. */ }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      await use('http://127.0.0.1:' + server.address().port);
    } finally {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }, { scope: 'worker' }],
});

export { expect };
