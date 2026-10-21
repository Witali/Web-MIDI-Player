import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../catalog/pwa/', import.meta.url));
const hash = content => createHash('sha256').update(content).digest('hex');

export function writePwa(directory, { publicLibrary = false } = {}) {
  fs.copyFileSync(path.join(source, 'manifest.webmanifest'), path.join(directory, 'manifest.webmanifest'));
  fs.copyFileSync(path.join(source, 'client.js'), path.join(directory, 'pwa-client.js'));
  fs.mkdirSync(path.join(directory, 'icons'), { recursive: true });
  for (const size of [192, 512]) fs.copyFileSync(path.join(source, 'icon-' + size + '.png'), path.join(directory, 'icons/icon-' + size + '.png'));
  const assets = [];
  function collect(relative) {
    const full = path.join(directory, relative);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('PWA assets must be regular files: ' + file);
      if (entry.isDirectory()) {
        if (file === 'player' || file.startsWith('player/') || file === 'icons' || (publicLibrary && ['midi', 'sources'].includes(file))) collect(file);
      } else if (['index.html', 'manifest.webmanifest', 'pwa-client.js', 'library.json', 'library.csv'].includes(file) || file.startsWith('icons/') ||
        (file.startsWith('player/') && /\.(js|json|wasm|sf3|ogg|pcm|txt)$/.test(file)) ||
        (publicLibrary && /^(midi|sources)\//.test(file))) {
        const bytes = fs.readFileSync(path.join(directory, file));
        assets.push({ file, bytes: bytes.length, sha256: hash(bytes), core: !file.includes('/samples/') && !/^(midi|sources)\//.test(file) });
      }
    }
  }
  collect(''); assets.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const template = fs.readFileSync(path.join(source, 'sw.js'), 'utf8');
  const version = hash(JSON.stringify(assets) + template).slice(0, 20);
  fs.writeFileSync(path.join(directory, 'sw.js'), template.replace("'__PWA_VERSION__'", JSON.stringify(version)).replace('/* PWA_ASSETS */ []', JSON.stringify(assets)));
}
