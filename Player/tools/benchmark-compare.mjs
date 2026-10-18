import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { createSoundFontPreview as after } from '../soundfont-preview.js';
SpessaLog.setLogLevel(false, false, false);
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const baseline = option('--baseline', null);
if (!baseline) throw new Error('Pass --baseline PATH to the previous Player directory.');
const baselineRoot = pathToFileURL(path.resolve(baseline) + path.sep);
const { createSoundFontPreview: before } = await import(new URL('soundfont-preview.js', baselineRoot));
const rounds = Number(option('--rounds', 7)), seconds = Number(option('--seconds', 1));
const counts = option('--notes', '64,256,1024').split(',').map(Number);
const scenario = option('--scenario', 'mixed'), warmup = Number(option('--warmup', scenario === 'staggered' ? 1.25 : .25));
if (!['mixed', 'unison', 'staggered'].includes(scenario)) throw new Error('Unknown scenario.');
const bytes = await fs.readFile(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const vlq = value => { const out = [value & 127]; while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 128); return out; };
function score(count) {
  const channels = Array.from({ length: 15 }, (_, i) => i < 9 ? i : i + 1), pitch = i => scenario === 'unison' ? 60 : 48 + i % 36;
  const events = [[0, 255, 81, 3, 15, 66, 64], ...channels.flatMap((channel, i) =>
    [[0, 0xc0 | channel, [0, 48, 73, 89][i % 4]], [0, 0xb0 | channel, 10, i * 23 % 128],
      [0, 0xb0 | channel, 91, 64], [0, 0xb0 | channel, 93, 48]])];
  for (let i = 0; i < count; i++) events.push([scenario === 'staggered' && i ? 1 : 0, 0x90 | channels[i % 15], pitch(i), 30]);
  for (let i = 0; i < count; i++) events.push([...vlq(i === 0 ? 4000 : 0), 0x80 | channels[i % 15], pitch(i), 0]);
  events.push([0, 255, 47, 0]);
  const body = Buffer.from(events.flat()), header = Buffer.from('4d546864000000060000000103e84d54726b00000000', 'hex');
  header.writeUInt32BE(body.length, 18); return new Uint8Array(Buffer.concat([header, body]));
}
const modes = option('--modes', 'before,after').split(',');
const factories = { before: [before, 'wasm'], after: [after, 'wasm'], simd: [after, 'wasm-simd'], 'before-simd': [before, 'wasm-simd'], js: [after, 'js'] };
const render = (preview, seconds) => { for (let left = Math.round(seconds * 48000); left > 0;) {
  const size = Math.min(2048, left); preview.read(size); left -= size;
} };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const output = { cpu: os.cpus()[0].model, node: process.version, date: new Date().toISOString(), rounds, seconds,
  scenario, warmupSeconds: warmup, measuredFrames: Math.round(seconds * 48000), explicitGc: !!global.gc,
  manifests: { before: JSON.parse(await fs.readFile(new URL('dsp/build.json', baselineRoot))),
    after: JSON.parse(await fs.readFile(new URL('../dsp/build.json', import.meta.url))) }, cases: [] };
for (const notes of counts) for (const effects of [false, true]) {
  const data = score(notes), values = Object.fromEntries(modes.map(name => [name, []])), cpu = Object.fromEntries(modes.map(name => [name, []]));
  for (let round = 0; round < rounds; round++) for (const mode of modes.map((_, i) => modes[(i + round) % modes.length])) {
    global.gc?.();
    const [factory, dsp] = factories[mode], preview = await factory(data, bank, { effects, dsp });
    try {
      if (preview.stats.dsp !== dsp) throw new Error(`Requested ${dsp}, got ${preview.stats.dsp}.`);
      render(preview, warmup); const startedCpu = process.cpuUsage(), started = performance.now(); render(preview, seconds);
      values[mode].push(performance.now() - started);
      const used = process.cpuUsage(startedCpu); cpu[mode].push((used.user + used.system) / 1000);
    } finally { preview.close(); }
  }
  const medians = Object.fromEntries(modes.map(name => [name, median(values[name])]));
  const cpuMedians = Object.fromEntries(modes.map(name => [name, median(cpu[name])]));
  const ratios = values.before?.map((value, i) => value / values.after[i]);
  const entry = { notes, effects, milliseconds: values, cpuMilliseconds: cpu, medians, cpuMedians,
    pairedSpeedup: ratios ? median(ratios) : null, medianSpeedup: medians.before / medians.after };
  output.cases.push(entry); console.log(JSON.stringify({ notes, effects, medians, cpuMedians, pairedSpeedup: entry.pairedSpeedup }));
}
await fs.writeFile(path.resolve(option('--output', 'comparison.json')), JSON.stringify(output, null, 2) + '\n');
