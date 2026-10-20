import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyBrowserBank } from './verify-browser-bank.mjs';
import { buildBrowserBank } from './build-browser-bank.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'PROVENANCE.json'), 'utf8'));
async function ensureOriginalBank(config) {
  const destination = path.join(root, config.file), expectedFont = config.sha256;
  const url = config.packageUrl, expected = config.packageSha256;
  try {
    if (hash(await fs.readFile(destination)) === expectedFont) { console.log(config.name + ' is already present and verified.'); return; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Downloading the MIT-licensed ' + config.name + ' bank…');
  console.log(`Source: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== expected) throw new Error('Debian package checksum mismatch.');
  if (archive.toString('ascii', 0, 8) !== '!<arch>\n') throw new Error('Invalid Debian package.');
  let payload;
  for (let offset = 8; offset + 60 <= archive.length;) {
    const name = archive.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '');
    const size = Number(archive.toString('ascii', offset + 48, offset + 58).trim());
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > archive.length) throw new Error('Invalid archive entry.');
    if (name === 'data.tar.xz') payload = archive.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + size % 2;
  }
  if (!payload) throw new Error('Package has no data archive.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'midi-player-assets-'));
  try {
    const packed = path.join(temporary, 'data.tar.xz'); await fs.writeFile(packed, payload);
    const entry = './usr/share/sounds/sf2/' + path.basename(config.file);
    const result = spawnSync('tar', ['-xf', packed, '-C', temporary, entry], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || 'The tar program is required to extract the bank.');
    const font = await fs.readFile(path.join(temporary, entry));
    if (hash(font) !== expectedFont) throw new Error('Extracted SoundFont checksum mismatch.');
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, font);
    console.log(config.name + ' installed; both checksums verified.');
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('midi-player-assets-')) throw new Error('Unexpected temporary path.');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
await ensureOriginalBank(manifest.soundfont);
for (const extension of manifest.soundfontExtensions ?? []) await ensureOriginalBank(extension);
try {
  const browser = verifyBrowserBank();
  console.log(`Browser samples verified: ${browser.total.unique_files} files, ${browser.total.encoded_bytes} bytes.`);
} catch (error) {
  console.log(error.message);
  await buildBrowserBank();
  verifyBrowserBank();
}
