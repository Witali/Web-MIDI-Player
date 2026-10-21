import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../dist/public-library/', import.meta.url));
const basePath = '/Web-MIDI-Player/';
// Keep Windows profile paths short: CacheStorage adds several hashed subfolders.
const profileRoot = fileURLToPath(new URL('../../.cache/', import.meta.url));
const newProfile = () => fs.mkdtempSync(path.join(profileRoot, 'pwa-profile-'));
function removeProfile(profile) {
  const resolved = fs.realpathSync(profile), root = fs.realpathSync(profileRoot);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('pwa-profile-')) throw new Error('Unexpected browser test profile');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const reviewed = JSON.parse(fs.readFileSync(new URL('../../public-library/manifest.json', import.meta.url), 'utf8')).tracks;
const types = { '.mxl': 'application/vnd.recordare.musicxml', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
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

const localMidi = { name: 'My local song.MID', mimeType: 'audio/midi',
  buffer: fs.readFileSync(new URL('../../public-library/midi/beethoven-fur-elise.mid', import.meta.url)) };

async function shell(page) {
  await page.goto(siteURL);
  await expect(page.locator('#open-local')).toBeEnabled();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function readyFile(page, name = localMidi.name) {
  await expect(page.locator('#player-title')).toHaveText(name);
  await expect(page.locator('#player-toggle')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', 'Продолжить');
}

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


test('Bumblebee is searchable, credits its CC0 source, downloads the score and plays', async ({ page }) => {
  await page.goto(siteURL);
  for (const query of ['Полёт шмеля', 'Полет шмеля', 'Bumblebee', 'Римский-Корсаков']) {
    await page.locator('#search').fill(query);
    await expect(page.locator('#rows tr')).toHaveCount(1);
    await expect(page.locator('.song-button')).toHaveText('Полёт шмеля');
  }
  await page.locator('.song-button').click();
  await expect(page.locator('#detail-body')).toContainText('CC0 1.0');
  const declaration = page.getByRole('link', { name: 'Подтверждение прав ↗' });
  await expect(declaration).toHaveAttribute('href', 'https://noctavepiano.com/en/sheet-music/rimski-vol-du-bourdon/');
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Исходные ноты ↓' }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('rimsky-korsakov-flight-of-the-bumblebee.mxl');
  expect(await downloaded.failure()).toBeNull();
  await page.locator('#detail-play').click();
  await expect(page.locator('#player-title')).toHaveText('Полёт шмеля');
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', 'Пауза');
  await expect(page.locator('#current-time')).not.toHaveText('0:00', { timeout: 30000 });
});

test('the application is installable with scoped file associations and uniform large branding', async ({ playwright }, testInfo) => {
  const profile = newProfile();
  const context = await playwright.chromium.launchPersistentContext(profile, { channel: testInfo.project.use.channel || 'chromium', headless: true });
  const page = context.pages()[0];
  try {
    await shell(page);
    const session = await page.context().newCDPSession(page);
    const manifest = await session.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    const data = JSON.parse(manifest.data);
    expect(data.name).toBe('Web-MIDI-Player');
    const favicon = page.locator('link[rel=icon][type="image/svg+xml"]');
    await expect(favicon).toHaveAttribute('href', 'icons/icon.svg');
    const icon = await page.request.get(new URL(await favicon.getAttribute('href'), siteURL).href);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()['content-type']).toBe('image/svg+xml');
    expect(await icon.text()).toBe(fs.readFileSync(new URL('../../catalog/pwa/icon.svg', import.meta.url), 'utf8'));
    for (const size of [32, 192, 512]) {
      const image = await page.evaluate(async url => {
        const icon = new Image(); icon.src = url; await icon.decode();
        return { width: icon.naturalWidth, height: icon.naturalHeight };
      }, new URL('icons/icon-' + size + '.png', siteURL).href);
      expect(image).toEqual({ width: size, height: size });
    }
    expect(new URL(data.start_url, manifest.url).pathname).toBe(basePath);
    expect(new URL(data.file_handlers[0].action, manifest.url).pathname).toBe(basePath);
    expect(data.file_handlers[0].accept['audio/midi']).toEqual(['.mid', '.midi', '.rmi', '.kar']);
    expect((await session.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    for (const width of [1280, 1000, 375]) {
      await page.setViewportSize({ width, height: 800 });
      const brand = await page.locator('.brand').evaluate(node => {
        const style = getComputedStyle(node), child = getComputedStyle(node.firstElementChild);
        return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight),
          childSize: child.fontSize, parentSize: style.fontSize, childWeight: child.fontWeight,
          parentWeight: style.fontWeight, fits: node.scrollWidth <= node.clientWidth };
      });
      expect(brand.size).toBeGreaterThanOrEqual(22);
      expect(brand.weight).toBeGreaterThanOrEqual(700);
      expect(brand.childSize).toBe(brand.parentSize);
      expect(brand.childWeight).toBe(brand.parentWeight);
      expect(brand.fits).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: testInfo.outputPath('pwa-preview.png') });
  } finally { await context.close(); removeProfile(profile); }
});

test('local picker plays files privately and accepts selecting the same file again', async ({ page }) => {
  await shell(page);
  expect(await page.evaluate(async () => {
    for (const key of await caches.keys()) if (key.startsWith('web-midi-player:')) {
      if ((await (await caches.open(key)).keys()).some(request => request.url.includes('/samples/'))) return false;
    }
    return true;
  })).toBe(true);
  const mutations = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#open-local').click();
  await (await chooser).setFiles(localMidi);
  await readyFile(page);
  await page.locator('#player-toggle').click();
  await expect(page.locator('#current-time')).not.toHaveText('0:00', { timeout: 20000 });
  await page.locator('#local-file').setInputFiles(localMidi);
  await readyFile(page);
  await expect(page.locator('#current-time')).toHaveText('0:00');
  await expect(page.locator('#rows tr')).toHaveCount(reviewed.length);
  expect(mutations).toEqual([]);
  await page.locator('#local-file').setInputFiles({ name: 'broken.mid', mimeType: 'audio/midi', buffer: Buffer.from('invalid') });
  await expect(page.locator('#toast')).toContainText('заголовок MIDI');
  await expect(page.locator('#player-title')).toHaveText(localMidi.name);
  await expect(page.locator('#player-toggle')).toBeEnabled();
});

test('dragged files and OS file launches use the same local player', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'launchQueue', { value: { setConsumer(consumer) { window.launchFile = consumer; } } });
  });
  await shell(page);
  await page.evaluate(({ bytes }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(bytes)], 'dropped.midi', { type: 'audio/midi' }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, { bytes: [...localMidi.buffer] });
  await readyFile(page, 'dropped.midi');
  await page.evaluate(async ({ bytes }) => {
    await window.launchFile({ files: [{ getFile: async () => new File([new Uint8Array(bytes)], 'from-desktop.mid', { type: 'audio/midi' }) }] });
  }, { bytes: [...localMidi.buffer] });
  await readyFile(page, 'from-desktop.mid');
  await page.locator('#player-toggle').click();
  await expect(page.locator('#current-time')).not.toHaveText('0:00', { timeout: 20000 });
});

test('explicit offline download survives browser restart and opens a new local MIDI without a network', async ({ playwright }, testInfo) => {
  test.setTimeout(120000);
  const profile = newProfile();
  const options = { channel: testInfo.project.use.channel || 'chromium', headless: true };
  let context = await playwright.chromium.launchPersistentContext(profile, options);
  let page = context.pages()[0];
  try {
    // Seed another application's cache before this service worker activates.
    await page.goto(siteURL + 'manifest.webmanifest');
    await page.evaluate(() => caches.open('another-app-v1').then(cache => cache.put('/unrelated', new Response('keep'))));
    await shell(page);
    await expect(page.locator('#offline-app')).toBeEnabled();
    await page.locator('#offline-app').click();
    await expect(page.locator('#offline-app')).toHaveText('Офлайн готов', { timeout: 90000 });
    await context.close();
    context = await playwright.chromium.launchPersistentContext(profile, options);
    await context.setOffline(true);
    page = context.pages()[0];
    await page.goto(siteURL + '?open-file');
    await expect(page.locator('#open-local')).toBeEnabled();
    await page.locator('#local-file').setInputFiles(localMidi);
    await readyFile(page);
    await page.locator('#player-toggle').click();
    await expect(page.locator('#current-time')).not.toHaveText('0:00', { timeout: 30000 });
    expect(await page.evaluate(() => caches.has('another-app-v1'))).toBe(true);
    await expect(page.locator('#rows tr')).toHaveCount(reviewed.length);
  } finally { await context.close(); removeProfile(profile); }
});
