import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => String(url).startsWith('file:') ? new Response(await fs.readFile(new URL(url))) : originalFetch(url);
globalThis.self = { postMessage: (data, transfers) => parentPort.postMessage(data, transfers) };
await import('../worker.js');
parentPort.on('message', data => self.onmessage({ data }));
