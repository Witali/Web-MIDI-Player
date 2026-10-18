import fs from 'node:fs/promises';
import os from 'node:os';
import { SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
SpessaLog.setLogLevel(false, false, false);
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const rounds = Number(option('--rounds', 5)), seconds = Number(option('--seconds', 1));
const backends = option('--backends', 'js,wasm,wasm-simd').split(',');
const counts = option('--notes', '64,256,1024').split(',').map(Number);
const bytes = await fs.readFile(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const vlq = value => { const out = [value & 127]; while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 128); return out; };
function score(count) {
  const channels = Array.from({ length: 15 }, (_, i) => i < 9 ? i : i + 1);
  const events = [[0, 255, 81, 3, 15, 66, 64], ...channels.flatMap((channel, i) =>
    [[0, 0xc0 | channel, [0, 48, 73, 89][i % 4]], [0, 0xb0 | channel, 10, (i * 23) % 128],
      [0, 0xb0 | channel, 91, 64], [0, 0xb0 | channel, 93, 48]])];
  for (let i = 0; i < count; i++) events.push([0, 0x90 | channels[i % 15], 48 + i % 36, 30]);
  for (let i = 0; i < count; i++) events.push([...vlq(i === 0 ? 4000 : 0), 0x80 | channels[i % 15], 48 + i % 36, 0]);
  events.push([0, 255, 47, 0]);
  const body = Buffer.from(events.flat()), header = Buffer.from('4d546864000000060000000103e84d54726b00000000', 'hex');
  header.writeUInt32BE(body.length, 18); return new Uint8Array(Buffer.concat([header, body]));
}
const result = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model,
  rounds, seconds, warmupSeconds: .25, scope: 'steady-state offline rendering; initialization excluded; no audio device', cases: [] };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const notes of counts) for (const effects of [false, true]) {
  const data = score(notes), measurements = Object.fromEntries(backends.map(backend => [backend, []]));
  for (let round = 0; round < rounds; round++) {
    // Rotate order to reduce JIT, thermal and clock bias.
    const order = backends.map((_, i) => backends[(i + round) % backends.length]);
    for (const dsp of order) {
      const preview = await createSoundFontPreview(data, bank, { effects, dsp });
      try {
        if (preview.stats.dsp !== dsp) throw new Error(`Requested ${dsp}, got ${preview.stats.dsp}`);
        while (preview.stats.position < .25) preview.read(2048);
        const end = preview.stats.position + seconds, start = performance.now();
        while (preview.stats.position < end) preview.read(2048);
        measurements[dsp].push(performance.now() - start);
      } finally { preview.close(); }
    }
  }
  const medians = Object.fromEntries(backends.map(dsp => [dsp, median(measurements[dsp])]));
  const entry = { notes, effects, milliseconds: measurements, medians,
    speedup: Object.fromEntries(backends.filter(dsp => dsp !== 'js').map(dsp => [dsp, medians.js / medians[dsp]])) };
  result.cases.push(entry); console.log(JSON.stringify({ notes, effects, medians, speedup: entry.speedup }));
}
const output = option('--output', null);
if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
