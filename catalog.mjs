import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary } from './src/library.mjs';
import { writeCatalog } from './src/catalog-output.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.argv[2] || path.join(root, 'downloads'));
const library = await buildLibrary(directory, { onProgress: (done, total) => console.log('Catalog: ' + done + '/' + total) });
writeCatalog(directory, library);
console.log(JSON.stringify({ ...library.stats, catalog: path.join(directory, 'index.html') }, null, 2));
