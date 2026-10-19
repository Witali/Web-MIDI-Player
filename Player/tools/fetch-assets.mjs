import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = 'https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-5.3_all.deb';
const expected = '6f531493ac4e4d9772fd96b2488ea1790af81c196135fbdd25997da0781fc60e';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = path.join(root, 'soundfonts', 'FluidR3_GM.sf2');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'PROVENANCE.json'), 'utf8'));
const expectedFont = manifest.soundfont.sha256;
try {
  if (hash(await fs.readFile(destination)) === expectedFont) { console.log('FluidR3 GM is already present and verified.'); process.exit(0); }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('Downloading the MIT-licensed FluidR3 GM bank (114 MiB package)…');
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
  const entry = './usr/share/sounds/sf2/FluidR3_GM.sf2';
  const result = spawnSync('tar', ['-xf', packed, '-C', temporary, entry], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'The tar program is required to extract the bank.');
  const font = await fs.readFile(path.join(temporary, entry));
  if (hash(font) !== expectedFont) throw new Error('Extracted SoundFont checksum mismatch.');
  await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, font);
  console.log('FluidR3 GM installed; both checksums verified.');
} finally {
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('midi-player-assets-')) throw new Error('Unexpected temporary path.');
  await fs.rm(temporary, { recursive: true, force: true });
}
