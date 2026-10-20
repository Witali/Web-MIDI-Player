import {parentPort}from'node:worker_threads';
import fs from'node:fs/promises';
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>String(url).startsWith('file:')?new Response(await fs.readFile(new URL(url))):originalFetch(url,options);
globalThis.self={postMessage:(data,transfers)=>parentPort.postMessage(data,transfers)};
await import('../live-worker.js');parentPort.on('message',data=>self.onmessage({data}));
