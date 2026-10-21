// The SVG is the source of truth for browser and installed-app icons.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const svg = fs.readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [32, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>' + svg);
    await page.screenshot({ path: fileURLToPath(new URL('./icon-' + size + '.png', import.meta.url)), omitBackground: true });
  }
} finally { await browser.close(); }
// Chrome compares icon URLs to detect installed-app icon updates.
const manifestURL = new URL('./manifest.webmanifest', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestURL, 'utf8'));
for (const icon of manifest.icons) {
  const file = 'icon-' + parseInt(icon.sizes, 10) + '.png';
  const version = createHash('sha256').update(fs.readFileSync(new URL('./' + file, import.meta.url))).digest('hex').slice(0, 12);
  icon.src = 'icons/' + file + '?v=' + version;
}
fs.writeFileSync(manifestURL, JSON.stringify(manifest, null, 2) + '\n');
