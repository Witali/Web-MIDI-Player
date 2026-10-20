import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const counts = [1, 3, 127, 128];
const binaries = new Map();
async function fixture(file, voices = 5, flags = 'filtered') {
  if (!binaries.has(file)) binaries.set(file, await WebAssembly.compile(await fs.readFile(new URL('../dsp/' + file, import.meta.url))));
  const e = (await WebAssembly.instantiate(binaries.get(file))).exports, base = e.dsp_get_layout();
  let next = Number(e.__heap_base.value);
  const alloc = n => { const p = next; next = Math.ceil((next + n) / 8) * 8; return p; };
  const commands = alloc(136 * voices), filters = alloc(72 * voices), env = alloc(128 * voices);
  const input = alloc(512 * voices), captures = alloc(512 * voices), source = alloc(257 * 4), table = alloc(32601 * 4);
  if (next > e.memory.buffer.byteLength) e.memory.grow(Math.ceil((next - e.memory.buffer.byteLength) / 65536));
  const words = () => new Uint32Array(e.memory.buffer, commands, voices * 34);
  const doubles = () => new Float64Array(e.memory.buffer, commands, voices * 17);
  new Float32Array(e.memory.buffer, source, 257).set(Float32Array.from({length: 257}, (_, i) => ((i * 13 + 31) % 127 - 64) / 64));
  new Float32Array(e.memory.buffer, table, 32601).set(Float32Array.from({length: 32601}, (_, i) => (i % 31 + 1) / 32));
  const w = words(), d = doubles();
  for (let i = 0; i < voices; i++) {
    const j = i % 5, at = i * 34, n = i * 17, oscillator = j % 2 === 0;
    const f = new Float64Array(e.memory.buffer, filters + i * 72, 9);
    f.set([.5 + j / 256, .125, .0625, -.25, .03125, .0625, -.125, .03125, -.0625]);
    const state = new Float64Array(e.memory.buffer, env + i * 128, 16);
    state[0] = (j + 1) / 16; state[2] = 4; state[4] = 50; state[8] = 100; state[9] = j * 20; state[14] = +(j === 2);
    new Float32Array(e.memory.buffer, input + i * 512, 128).set(Float32Array.from({length: 128}, (_, k) => ((j * 17 + k * 11) % 61 - 30) / 32));
    w[at] = oscillator ? source : 0; w[at + 1] = filters + i * 72;
    w[at + 2] = oscillator ? env + i * 128 : 0; w[at + 3] = table;
    w[at + 4] = oscillator ? 0 : input + i * 512; w[at + 5] = captures + i * 512;
    w[at + 6] = (flags === 'mixed' ? +(i % 4 !== 0) : flags === 'unfiltered' ? 0 : 1) | (j === 3 ? 2 : 0);
    w[at + 7] = +(j === 0); w[at + 8] = 17; w[at + 9] = 7; w[at + 10] = 257;
    d.set([j === 2 ? 254 : j === 0 ? 10.25 : .25, .7, (j + 1) / 16, .003 * (j - 1), .75, .71, .27, .12, .08, .03, 0], n + 6);
  }
  function result(count) {
    const data = [], bytes = (offset, n) => new Uint8Array(e.memory.buffer, offset, n).slice();
    for (let i = 1; i < 8; i++) data.push(bytes(base + i * 512, count * 4));
    data.push(bytes(filters, voices * 72), bytes(env, voices * 128));
    const w = words(), d = doubles(), cursor = new Float64Array(voices), active = new Int32Array(voices);
    for (let i = 0; i < voices; i++) { data.push(bytes(w[i * 34 + 5], count * 4)); cursor[i] = d[i * 17 + 16]; active[i] = w[i * 34 + 11]; }
    data.push(new Uint8Array(cursor.buffer), new Uint8Array(active.buffer));
    return data;
  }
  function run(count, scalar = false) {
    // Clear only the output/send buses. Filters/envelopes remain persistent.
    new Float32Array(e.memory.buffer, base + 512, 7 * 128).fill(0);
    e.dsp_begin_block();
    assert.equal((scalar ? e.dsp_process_batch_scalar : e.dsp_process_batch)(commands, voices, count), 0);
    return result(count);
  }
  return {e, base, commands, voices, filters, env, input, captures, source, words, doubles, run,
    stats: () => [...new Uint32Array(e.memory.buffer, e.dsp_get_voice_simd_stats(), 2)],
    advance() { const w = words(), d = doubles(); for (let i = 0; i < voices; i++) if (w[i * 34] && w[i * 34 + 11]) d[i * 17 + 6] = d[i * 17 + 16]; } };
}
const fnv = chunks => { let hash = 2166136261; for (const chunk of chunks) for (const byte of chunk) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash; };

test('independent f64x2 voices match a native sequential oracle, including EOF, release, odd blocks and captures', async () => {
  const golden = JSON.parse(await fs.readFile(new URL('./native-dsp-golden.json', import.meta.url), 'utf8'));
  for (const file of ['voice-mixer.wasm', 'voice-mixer-simd.wasm']) for (const [i, count] of counts.entries()) {
    const f = await fixture(file); f.e.memory.grow(2);
    assert.equal(fnv(f.run(count)), golden.independentVoices[i], file + ' count=' + count);
    assert.deepEqual(f.stats(), file.includes('-simd') ? [2, 1] : [0, 5]);
  }
});

test('SIMD and sequential exports in one module preserve every voice/state byte across mixed flags and more than 2048 voices', async () => {
  for (const voices of [1, 2, 3, 17, 41, 2053]) for (const flags of ['filtered', 'mixed', 'unfiltered']) {
    const a = await fixture('voice-mixer-simd.wasm', voices, flags), b = await fixture('voice-mixer-simd.wasm', voices, flags);
    for (const count of counts) {
      a.e.memory.grow(1); b.e.memory.grow(1);
      assert.deepEqual(a.run(count), b.run(count, true), 'voices=' + voices + ' flags=' + flags + ' count=' + count);
      if (flags === 'filtered') assert.deepEqual(a.stats(), [Math.floor(voices / 2), voices % 2]);
      if (flags === 'unfiltered') assert.deepEqual(a.stats(), [0, voices]);
      assert.deepEqual(b.stats(), [0, voices]); a.advance(); b.advance();
    }
  }
});

test('dependent/shared/overlapping memory uses ordered scalar fallback and retains inter-voice read-after-write behavior', async () => {
  const aliases = [
    f => { f.words()[35] = f.filters; }, // shared complete filter
    f => { f.words()[35] = f.filters + 8; }, // overlapping filter histories
    f => { f.words()[36] = f.env; }, // shared volume envelope
    f => { f.words()[5] = f.input + 512; }, // A capture becomes B input
    f => { f.words()[39] = f.filters; }, // B capture overwrites A filter
    f => { f.words()[38] = f.base + 512; }, // B reads output mixed by A
    f => { f.words()[39] = f.input; f.words()[4] = f.input; f.words()[0] = 0; },
    f => { f.words()[0] = 0; f.words()[4] = f.env; }, // Own input must be copied before updating its envelope.
    f => { f.words()[1] = f.commands + 136; }, // A history write changes B's non-pointer parameters.
  ];
  for (const [i, alias] of aliases.entries()) {
    const a = await fixture('voice-mixer-simd.wasm'), b = await fixture('voice-mixer-simd.wasm'); alias(a); alias(b);
    for (const count of [3, 128]) {
      assert.deepEqual(a.run(count), b.run(count, true), 'alias=' + i + ' count=' + count);
      assert.ok(a.stats()[1] >= 1); a.advance(); b.advance();
    }
  }
});
