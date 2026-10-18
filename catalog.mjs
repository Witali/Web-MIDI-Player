import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary } from './src/library.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.argv[2] || path.join(root, 'downloads'));
const library = await buildLibrary(directory, { onProgress: (done, total) => console.log(`Catalog: ${done}/${total}`) });
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');
const json = JSON.stringify(library).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const core = read('src/midi-metadata.mjs').replace(/^export\s+/gm, '');
const html = read('catalog/index.template.html')
  .replace('/* CATALOG_STYLES */', () => read('catalog/styles.css'))
  .replace('/* CATALOG_DATA */', () => json)
  .replace('/* MIDI_CORE */', () => `(() => {\n${core}\nwindow.MidiCore = {readMidi, instrumentFamily};\n})();`)
  .replace('/* CATALOG_APP */', () => read('catalog/app.js'));
fs.writeFileSync(path.join(directory, 'index.html'), html);
console.log(JSON.stringify({ ...library.stats, catalog: path.join(directory, 'index.html') }, null, 2));
