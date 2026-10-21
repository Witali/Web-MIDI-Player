import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../dist/public-library/', import.meta.url));
const basePath = '/Web-MIDI-Player/';
const reviewed = JSON.parse(fs.readFileSync(new URL('../../public-library/manifest.json', import.meta.url), 'utf8')).tracks;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.mid': 'audio/midi', '.ogg': 'audio/ogg', '.sf3': 'application/octet-stream' };
let server, siteURL;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(directory, 'index.html'))) throw new Error('Build the site with npm run test:pages.');
  // Model a static project site: nothing is available outside its repository
  // prefix. Real exported modules, WASM and recordings must retain that prefix.
  server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith(basePath)) throw new Error('Outside the project site');
      const relative = pathname.slice(basePath.length) || 'index.html';
      const filename = path.resolve(directory, relative);
      if (!filename.startsWith(path.resolve(directory) + path.sep)) throw new Error('Outside the export');
      const contents = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
      response.end(contents);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  siteURL = 'http://127.0.0.1:' + server.address().port + basePath;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
});

test('the built library plays MIDI below the GitHub Pages repository path', async ({ page }) => {
  const errors = [], failures = [], requested = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 400 && !pathname.endsWith('/favicon.ico')) failures.push(pathname + ': ' + response.status());
  });
  await page.goto(siteURL);
  await expect(page).toHaveTitle('Web-MIDI-Player — библиотека');
  await expect(page.locator('#page-title')).toHaveText('Библиотека');
  await expect(page.locator('#rows tr')).toHaveCount(reviewed.length);
  const title = await page.locator('.song-button').first().textContent();
  await page.locator('.row-play').first().click();
  await expect(page.locator('#player-title')).toHaveText(title, { timeout: 30000 });
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', 'Пауза');
  await expect(page.locator('#current-time')).not.toHaveText('0:00', { timeout: 30000 });
  await page.locator('#player-toggle').click();
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', 'Продолжить');

  expect(requested.some(url => url.startsWith(basePath + 'midi/') && url.endsWith('.mid'))).toBe(true);
  expect(requested.some(url => url === basePath + 'player/soundfonts/fluidr3-gm/manifest.json')).toBe(true);
  expect(requested.some(url => url.startsWith(basePath + 'player/soundfonts/fluidr3-gm/samples/'))).toBe(true);
  expect(requested.some(url => url.startsWith(basePath + 'player/dsp/') && url.endsWith('.wasm'))).toBe(true);
  expect(requested.filter(url => !url.startsWith(basePath) && !url.endsWith('/favicon.ico'))).toEqual([]);
  expect(requested.filter(url => url.endsWith('.sf2'))).toEqual([]);
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});
