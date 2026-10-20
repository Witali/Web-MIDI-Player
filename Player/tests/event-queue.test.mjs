import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {FIFOQueue, TimedEventQueue} from '../event-queue.js';
import {BasicMIDI, SpessaSynthProcessor, SpessaLog} from '../vendor/spessasynth.js';
import {BrowserSoundBank} from '../lazy-bank.js';
import {installVoiceDSP} from '../voice-dsp.js';
import {installGSEffects} from '../gs-effects.js';
import {installXGVariation} from '../xg-variation.js';
import {captureSynthCheckpoint} from '../synth-checkpoint.js';
import {readMidi} from '../../src/midi-metadata.mjs';
import {midi} from './fixtures.mjs';
import vm from 'node:vm';
import {renderCatalog} from '../../src/catalog-output.mjs';
SpessaLog.setLogLevel(false, false, false);

class ShiftQueue {
  items = [];
  get length() { return this.items.length; }
  push(value) { this.items.push(value); this.items.sort((a, b) => a.time - b.time); }
  peek() { return this.items[0]; }
  take() { return this.items.shift(); }
}

test('FIFO releases consumed references, preserves falsey values and compacts without changing its backing identity', () => {
  const q = new FIFOQueue(), rows = Array.from({length: 5000}, (_, id) => ({id}));
  rows.forEach(row => q.push(row)); const storage = q.items;
  for (let i = 0; i < 2000; i++) assert.equal(q.take(), rows[i]);
  assert.equal(q.head, 2000); assert.ok(q.items.slice(0, q.head).every(v => v === undefined));
  for (let i = 2000; i < 2500; i++) assert.equal(q.take(), rows[i]);
  assert.equal(q.items, storage); assert.equal(q.head, 0); assert.equal(q.length, 2500);
  assert.deepEqual([...q], rows.slice(2500));
  for (let i = 2500; i < rows.length; i++) assert.equal(q.take(), rows[i]);
  assert.equal(q.head, 0); assert.equal(q.items.length, 0); assert.equal(q.take(), undefined);
  for (const value of [0, false, null, undefined, '']) { assert.equal(q.push(value), 1); assert.equal(q.take(), value); assert.equal(q.length, 0); }
});

test('FIFO dequeue touches only its head before compaction, with no reads or shifts of remaining values', () => {
  const q = new FIFOQueue(); for (let i = 0; i < 20000; i++) q.push(i);
  let reads = 0;
  q.items.shift = () => { throw new Error('Unexpected shift'); };
  q.items = new Proxy(q.items, {get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); }});
  for (let i = 0; i < 500; i++) assert.equal(q.take(), i);
  assert.equal(reads, 500); assert.equal(q.length, 19500);
});

test('timed queue avoids monotonic sorts and performs one stable sort for a disordered burst, including after a consumed prefix', () => {
  const q = new TimedEventQueue(); let sorts = 0;
  q.items.sort = compare => { sorts++; return Array.prototype.sort.call(q.items, compare); };
  for (let i = 0; i < 6000; i++) q.push({time: Math.floor(i / 3), id: i});
  for (let i = 0; i < 500; i++) assert.equal(q.take().id, i);
  assert.equal(sorts, 0);
  const extra = [{time: 1000, id: 6000}, {time: '2', id: 6001}, {time: Infinity, id: 6002}, {time: '10', id: 6003}, {time: 1000, id: 6004}];
  extra.forEach(e => q.push(e)); assert.equal(sorts, 0);
  const expected = [...Array.from({length: 5500}, (_, i) => ({time: Math.floor((i + 500) / 3), id: i + 500})), ...extra].sort((a, b) => a.time - b.time);
  for (const row of expected) { assert.equal(q.peek().id, row.id); assert.equal(q.take().id, row.id); }
  assert.equal(sorts, 1); assert.equal(q.length, 0); assert.equal(q.sorted, true);
});

test('timed queue matches the previous sort/shift oracle through enqueue, equal-time, clear, partial drain and compaction', () => {
  const q = new TimedEventQueue(), reference = new ShiftQueue(); let seed = 0x12345678;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 16000; i++) {
    if (random() % 11 < 7) { const value = {time: random() % 31, id: i}; q.push(value); reference.push(value); }
    else assert.equal(q.take(), reference.take());
    if (i % 71 === 0) { assert.equal(q.peek(), reference.peek()); assert.deepEqual([...q], reference.items); }
    assert.equal(q.length, reference.length);
    if (i % 4001 === 0) { q.clear(); reference.items.length = 0; }
  }
  while (reference.length) assert.equal(q.take(), reference.take()); assert.equal(q.length, 0);
});

const loader = new BrowserSoundBank(undefined, {fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url)))});
const prepared = await loader.load(midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [0, 0x90, 67, 100], [0, 255, 47, 0]]));
async function synth(dsp, shift = false) {
  const s = new SpessaSynthProcessor(48000, {effectsEnabled: true, eventsEnabled: false, maxBufferSize: 128});
  s.onMissingPreset = (p, system) => prepared.bank.getPreset(p, system); s.soundBankManager.addSoundBank(prepared.bank, 'main'); await s.processorInitialized;
  installGSEffects(s); installXGVariation(s); s.setSystemParameter('autoAllocateVoices', true); s.setSystemParameter('blackMIDIMode', false); s.setSystemParameter('monophonicRetrigger', false);
  for (let i = 16; i < 32; i++) s.synthCore.createMIDIChannel(false);
  for (const ch of [0, 16]) s.programChange(ch, 81);
  if (shift) s.synthCore.eventQueue = new ShiftQueue();
  if (dsp !== 'js') await installVoiceDSP(s, dsp);
  return s;
}
function render(s, frames) { const out = [new Float32Array(frames), new Float32Array(frames)]; for (let at = 0; at < frames; at += 128) s.process(...out, at, Math.min(128, frames - at)); return out; }
function record(s) {
  const trace = [], core = s.synthCore, process = core.processMessageInternal.bind(core);
  core.processMessageInternal = (message, offset) => { trace.push([message.token, [...message], offset, s.currentTime]); process(message, offset); };
  return trace;
}
function schedule(s, rows) { for (const [time, bytes, offset = 0, token] of rows) { const raw = new Uint8Array(bytes); raw.token = token; s.processMessage(raw, offset, {time}); } }

test('raw future messages preserve equal-time arrival, ports, immediate times, all controllers and exact PCM on every DSP', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const a = await synth(dsp), b = await synth(dsp, true), traces = [record(a), record(b)];
    const rows = [[.12, [0x80, 60, 19], 0, 1], [.01, [0x90, 60, 100], 0, 2], [.01, [0xb0, 10, 12], 0, 3],
      [.02, [0x90, 67, 100], 16, 4], [0, [0xb0, 7, 100], 0, 5], [NaN, [0xb0, 11, 110], 0, 6],
      [.03, [0xf0, 0x7f, 0x7f, 4, 1, 0, 100, 0xf7], 0, 7], [.13, [0x80, 67, 77], 16, 8]];
    for (let i = 0; i < 2500; i++) rows.push([.04 + Math.floor(i / 500) * .01, [0xb0, [1, 10, 11, 74][i % 4], 1 + i % 127], i % 2 ? 16 : 0, 100 + i]);
    schedule(a, rows); schedule(b, rows);
    assert.deepEqual(render(a, 10001), render(b, 10001), dsp); assert.deepEqual(traces[0], traces[1]);
    assert.equal(traces[0].length, rows.length); assert.equal(a.synthCore.eventQueue.length, 0);
    const expected = [...rows.filter(r => !(r[0] > 0)), ...rows.filter(r => r[0] > 0).sort((x, y) => x[0] - y[0])].map(r => r[3]);
    assert.deepEqual(traces[0].map(r => r[0]), expected); a.stopAllChannels(true); b.stopAllChannels(true);
  }
});

test('pending head, unsorted entries and raw bytes restore through later compaction/growth and repeated checkpoints', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const s = await synth(dsp); s.noteOn(0, 60, 100);
    const rows = Array.from({length: 2400}, (_, i) => [i < 600 ? .01 : .1 + i / 48000, [0xb0, 11, 50 + i % 70], 0, i]);
    schedule(s, rows); render(s, 2048); const q = s.synthCore.eventQueue;
    assert.equal(q.head, 600); assert.equal(q.length, 1800);
    schedule(s, [[.08, [0xb0, 10, 100], 0, 3000]]); assert.equal(q.sorted, false);
    const saved = captureSynthCheckpoint(s, {}, {}); let expected;
    for (const entry of q.items) if (entry) entry.message[2] ^= 127;
    for (let repeat = 0; repeat < 3; repeat++) {
      saved.restore(); assert.equal(q.head, 600); assert.equal(q.sorted, false);
      schedule(s, Array.from({length: 3000}, (_, i) => [.09 + i / 100000, [0xb0, 1, i % 128], 0, 4000 + i]));
      const pcm = render(s, 16003); if (expected) assert.deepEqual(pcm, expected, dsp); else expected = pcm;
      assert.equal(q.length, 0); assert.equal(q.items.length, 0); assert.equal(q.head, 0);
    }
    s.stopAllChannels(true);
  }
});

test('dispatch callbacks may insert later equal-time messages without losing or reordering pending events', async () => {
  const a = await synth('js'), b = await synth('js', true), traces = [record(a), record(b)];
  for (const s of [a, b]) {
    const core = s.synthCore, process = core.processMessageInternal.bind(core);
    core.processMessageInternal = (raw, offset) => { process(raw, offset); if (raw.token === 1) schedule(s, [[.03, [0xb0, 11, 90], 0, 4]]); };
    schedule(s, [[.01, [0xb0, 11, 100], 0, 1], [.03, [0xb0, 11, 70], 0, 2], [.04, [0xb0, 11, 80], 0, 3]]);
  }
  render(a, 4096); render(b, 4096); assert.deepEqual(traces[0], traces[1]); assert.deepEqual(traces[0].map(r => r[0]), [1, 2, 4, 3]);
  a.stopAllChannels(true); b.stopAllChannels(true);
});

test('both note-time readers retain FIFO note zero, zero-velocity offs and only the remaining notes at EOF', () => {
  const events = [[0, 0xc0, 81], [0, 0x90, 60, 40], [10, 0x90, 60, 50], [10, 0x90, 60, 60], [10, 0x90, 60, 70], [10, 0x90, 60, 80],
    [10, 0x80, 60, 64], [10, 0x90, 60, 0], [10, 0x80, 60, 80], [30, 255, 47, 0]];
  const bytes = midi(events), parsed = BasicMIDI.fromArrayBuffer(bytes.buffer), notes = parsed.getNoteTimes()[0];
  const times = [[0, 50], [10, 50], [20, 50], [30, 70], [40, 60]];
  assert.equal(notes.length, times.length);
  notes.forEach((n, i) => { assert.ok(Math.abs(n.start - times[i][0] / 960) < 1e-15); assert.ok(Math.abs(n.length - times[i][1] / 960) < 1e-15); });
  const metadata = readMidi(bytes); assert.equal(metadata.notes.length, times.length);
  metadata.notes.forEach((n, i) => { assert.ok(Math.abs(n.start - times[i][0] / 960) < 1e-15); assert.ok(Math.abs(n.end - (times[i][0] + times[i][1]) / 960) < 1e-15); });
});


test('queued Note Ons preserve exact PCM and pending checkpoints through native memory and voice-pool growth', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const a = await synth(dsp), b = await synth(dsp, true), models = [a, b];
    const oldMemory = a.synthCore.voiceDSP?.memoryBuffer;
    for (const s of models) schedule(s, [...Array.from({length: 600}, (_, i) => [.01, [0x90, i % 2 ? 60 : 67, 80], i % 2 ? 16 : 0, i]),
      [.04, [0xb0, 11, 80], 0, 8000], [.06, [0xb0, 120, 0], 0, 8001], [.06, [0xb0, 120, 0], 16, 8002]]);
    assert.deepEqual(render(a, 1024), render(b, 1024));
    assert.ok(a.synthCore.voices.length >= 1200);
    if (oldMemory) assert.notEqual(a.synthCore.voiceDSP.memoryBuffer, oldMemory);
    const saved = models.map(s => captureSynthCheckpoint(s, {}, {})); let expected;
    for (let repeat = 0; repeat < 2; repeat++) {
      saved.forEach(c => c.restore());
      for (const s of models) schedule(s, Array.from({length: 700}, (_, i) => [.03, [0x90, i % 2 ? 60 : 67, 80], i % 2 ? 16 : 0, 9000 + i]));
      const pcm = render(a, 4099); assert.deepEqual(pcm, render(b, 4099));
      if (expected) assert.deepEqual(pcm, expected); else expected = pcm;
      assert.equal(a.synthCore.eventQueue.length, 0); assert.equal(b.synthCore.eventQueue.length, 0);
    }
    models.forEach(s => s.stopAllChannels(true));
  }
});

test('standalone catalog embeds the FIFO dependency and executes its note reader without a module loader', () => {
  const html = renderCatalog({mode: 'local', items: []}), marker = 'window.MidiCore = {readMidi, instrumentFamily};';
  const end = html.indexOf(marker), start = html.lastIndexOf('(() => {', end);
  assert.ok(start >= 0 && end > start);
  const code = html.slice(start, end + marker.length) + '\n})();';
  const context = {window: {}, Uint8Array, DataView, TextDecoder}; vm.runInNewContext(code, context);
  const bytes = midi([[0, 0x90, 60, 80], [1, 0x90, 60, 90], [1, 0x80, 60, 64], [1, 255, 47, 0]]);
  assert.equal(JSON.stringify(context.window.MidiCore.readMidi(bytes)), JSON.stringify(readMidi(bytes)));
});
