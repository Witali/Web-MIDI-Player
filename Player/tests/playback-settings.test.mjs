import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { BasicMIDI, GeneratorTypes, SpessaLog } from '../vendor/spessasynth.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { createLoopPreview } from '../loop-preview.js';
import { resolvePlayback, normalizePlaybackPatch } from '../playback-settings.js';
import { TransportTimeline } from '../transport-timeline.js';
import { MidiPlayer } from '../index.js';
import { midi, midiTracks, vlq, smptePanned } from './fixtures.mjs';
const end = [0, 255, 47, 0];
const loader = () => new BrowserSoundBank(undefined, { fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url))) });
const timed = midi([[0, 255, 81, 3, 7, 161, 32], [0, 0xc0, 73], [0, 0x90, 69, 100],
  [...vlq(240), 0xb0, 10, 0], [...vlq(240), 255, 81, 3, 3, 208, 144],
  [0, 0xb0, 64, 127], [...vlq(240), 0x80, 69, 23], [...vlq(240), 0xb0, 10, 127],
  [0, 0xb0, 64, 0], [0, 255, 81, 3, 15, 66, 64], [...vlq(240), 255, 6, 3, 69, 110, 100], end]);
async function preview(bytes, playback = {}, options = {}) {
  const prepared = await loader().load(bytes);
  return createSoundFontPreview(bytes, prepared.bank, { prepared, effects: false, dsp: 'js', playback, ...options });
}

test('settings reject invalid rates, transpose and loop bounds without mutating inputs', () => {
  for (const p of [{ rate: 0 }, { rate: NaN }, { rate: 5 }, { transpose: .5 }, { transpose: 49 }, { loop: { start: 1, end: 1 } }, { loop: [] }, { loop: { start: 0, end: 1, typo: 0 } }, { typo: 1 }]) assert.throws(() => normalizePlaybackPatch(p));
  assert.throws(() => resolvePlayback({ loop: true }, 0));
  assert.throws(() => resolvePlayback({ loop: { start: 0, end: 2 } }, 1));
  assert.throws(() => resolvePlayback({ rate: 4, loop: { start: 0, end: .001 } }, 1));
  const input = { loop: { start: .1, end: .5 } }, output = resolvePlayback(input, 1); input.loop.start = .4;
  assert.equal(output.loop.start, .1); assert.deepEqual(resolvePlayback({ loop: true }, 1).loop, { start: 0, end: 1 });
});

test('rate follows every PPQN tempo event without resampling pitch and exact seek uses original source seconds', async () => {
  for (const rate of [.5, 2]) {
    const parsed = BasicMIDI.fromArrayBuffer(timed.buffer);
    for (const track of parsed.tracks) for (const event of track.events) if (event.statusByte === 81) {
      const tempo = ((event.data[0] << 16) | (event.data[1] << 8) | event.data[2]) / rate;
      event.data.set([tempo >> 16, tempo >> 8 & 255, tempo & 255]);
    }
    const rewritten = new Uint8Array(parsed.writeMIDI());
    for (const dsp of ['js', 'wasm', 'wasm-simd']) {
      const a = await preview(timed, { rate }, { dsp, effects: true }), b = await preview(rewritten, {}, { dsp, effects: true });
      try {
        const expected = b.read(96000); assert.deepEqual(a.read(96000), expected);
        assert.equal(a.stats.position, 2 * rate); assert.ok(Math.abs(a.stats.sourceDuration - b.stats.sourceDuration * rate) < 1e-9);
        for (const seconds of [.133, .501, .03]) { await a.seek(seconds); const at = Math.round(seconds / rate * 48000); assert.deepEqual(a.read(512), expected.map(c => c.slice(at, at + 512))); }
      } finally { a.close(); b.close(); }
    }
  }
});

test('host rate scales all SMPTE clocks while tempo meta events remain ineffective', async () => {
  for (const code of [24, 25, 29, 30]) {
    const source = smptePanned(code), reference = source.slice();
    const view = new DataView(reference.buffer); view.setUint16(12, ((256 - code) << 8) | 80);
    const a = await preview(source, { rate: 2 }), b = await preview(reference);
    try {
      assert.deepEqual(a.read(48000), b.read(48000));
      await a.seek(.731); await b.seek(.731 / 2); assert.deepEqual(a.read(256), b.read(256));
    } finally { a.close(); b.close(); }
  }
});

test('transpose matches independent SoundFont pitch generators, keeps portamento/legato and sample regions, and leaves percussion unchanged', async () => {
  const bytes = midiTracks([
    [[0, 0xc0, 81], [0, 0xf0, 11, 0x7f, 0x7f, 8, 2, 81, 1, 60, 62, 0, 0, 0xf7], [0, 0xb0, 101, 0], [0, 0xb0, 100, 3], [0, 0xb0, 6, 81], [0, 0x90, 60, 100], [60, 0xb0, 65, 127], [0, 0xb0, 5, 50], [0, 0xb0, 68, 127],
     [60, 0x90, 67, 90], [60, 0x80, 67, 23], [60, 0x80, 60, 64], [0, 0xb0, 68, 0], end],
    [[0, 255, 33, 1, 7], [0, 0xc0, 73], [0, 0x90, 69, 100], [120, 0xe0, 0, 80], [120, 0x80, 69, 127], end],
    [[0, 0x99, 36, 100], [120, 0x99, 46, 100], [120, 0x89, 46, 64], end]
  ]);
  const prepared = await loader().load(bytes), reference = await loader().load(bytes);
  for (const preset of reference.bank.presets.filter(p => !p.isDrum)) {
    const gen = GeneratorTypes.coarseTune;
    preset.globalZone.setGenerator(gen, preset.globalZone.getGenerator(gen, 0) + 12);
    for (const zone of preset.zones) { const value = zone.getGenerator(gen, undefined); if (value !== undefined) zone.setGenerator(gen, value + 12); }
  }
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const a = await createSoundFontPreview(bytes, prepared.bank, { prepared, playback: { transpose: 12 }, effects: false, dsp });
    const b = await createSoundFontPreview(bytes, reference.bank, { prepared: reference, effects: false, dsp });
    try {
      const actual = a.read(48000), expected = b.read(48000);
      let max = 0; actual.forEach((c, i) => c.forEach((v, n) => { max = Math.max(max, Math.abs(v - expected[i][n])); }));
      assert.ok(max < 1e-5, 'pitch generator reference error ' + max); assert.equal(a.stats.sampleBank.samples, b.stats.sampleBank.samples);
      await a.seek(.133); const at = Math.round(.133 * 48000); assert.deepEqual(a.read(512), actual.map(c => c.slice(at, at + 512)));
    } finally { a.close(); b.close(); }
  }
  const drums = midi([[0, 0x99, 36, 100], [120, 0x99, 46, 100], [120, 0x89, 46, 64], end]);
  const a = await preview(drums, { transpose: 48 }), b = await preview(drums);
  try { assert.deepEqual(a.read(48000), b.read(48000)); } finally { a.close(); b.close(); }
  for (const transpose of [-48, 48]) {
    const edges = await preview(midi([[0, 0xc0, 81], [0, 0x90, 0, 100], [0, 0x90, 127, 100], [120, 0xb0, 123, 0], end]), { transpose });
    try { assert.ok(edges.read(16000).every(c => c.every(Number.isFinite))); } finally { edges.close(); }
  }
});

test('A/B repeats the exact continuous PCM slice on arbitrary boundaries and DSPs, with inclusive B commands and exclusive later commands', async () => {
  const gs = [0x41, 0x10, 0x42, 0x12, 0x40, 0x11, 0x1c, 0, 0x13, 0xf7];
  const bytes = midiTracks([
    [[0, 0xf0, gs.length, ...gs], [0, 0xc0, 81], [0, 0x90, 60, 100], [120, 0xb0, 64, 127],
     [0, 0x80, 60, 23], [0, 0x90, 67, 100], [120, 0xb0, 64, 0], [0, 0x80, 67, 64],
     [0, 0xc0, 73], [0, 0x90, 72, 100], [...vlq(240), 0x80, 72, 64], [...vlq(480), 255, 47, 0]],
    [[0, 255, 33, 1, 7], [0, 0x99, 36, 100], [120, 0x99, 46, 100], [120, 0x89, 46, 64], end]
  ]);
  for (const rate of [1, 2]) for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const start = 6001 * rate / 48000, end = 17017 * rate / 48000;
    const options = resolvePlayback({ rate, transpose: 2, loop: { start, end } }, 1), prepared = await loader().load(bytes);
    const base = await createSoundFontPreview(bytes, prepared.bank, { prepared, playback: options, effects: true, dsp });
    const loop = createLoopPreview(base, options), reference = await createSoundFontPreview(bytes, prepared.bank, { prepared, playback: { rate, transpose: 2 }, effects: true, dsp });
    try {
      const pcm = reference.read(30000), count = 51000, expected = pcm.map(c => Float32Array.from({ length: count }, (_, n) => c[n < 17017 ? n : 6001 + (n - 17017) % (17017 - 6001)]));
      let at = 0;
      for (const size of [1, 127, 8191, 123, 6000, 10001, 2048, 24509]) {
        const length = Math.min(size, count - at), actual = loop.read(length);
        actual.forEach((c, i) => assert.deepEqual(c, expected[i].slice(at, at + length), dsp + ' at ' + at)); at += length;
      }
      assert.equal(at, count); assert.ok(loop.stats.iteration >= 3);
      await loop.seek(start); assert.deepEqual(loop.read(1024), pcm.map(c => c.slice(6001, 7025)));
      await loop.seek(end); assert.deepEqual(loop.read(1024), pcm.map(c => c.slice(6001, 7025)));
      await loop.seek(0); assert.deepEqual(loop.read(17), pcm.map(c => c.slice(0, 17))); assert.equal(loop.stats.iteration, 0);
    } finally { loop.close(); reference.close(); }
  }
  const boundary = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(240), 0xb0, 0, 119], [0, 0xc0, 73],
    [0, 0xb0, 0, 120], [0, 0xc0, 73], [60, 0xb0, 0, 121], [0, 0xc0, 73], [...vlq(180), 0x80, 60, 64], end]);
  const settings = { rate: 1, transpose: 0, loop: { start: .1, end: .25 } }, base = await preview(boundary, settings), loop = createLoopPreview(base, settings);
  try {
    const before = SpessaLog.onDiagnostic, selected = [];
    SpessaLog.onDiagnostic = detail => { if (detail.kind === 'substituted') selected.push(detail.requested.bankMSB); };
    try { loop.read(12000); } finally { SpessaLog.onDiagnostic = before; }
    assert.deepEqual(selected, [119, 120], 'every B command executes in order; later commands stay outside A/B');
    assert.equal(loop.stats.position, .1);
  } finally { loop.close(); }
});

test('transport timeline maps audible loops and rate exactly and bounds its metadata queue', () => {
  const timeline = new TransportTimeline(.2, 2);
  timeline.push(2048, [{ offset: 0, seconds: .2, iteration: 0 }, { offset: 1000, seconds: .1, iteration: 1, loopEnd: .2 }]);
  assert.equal(timeline.advance(500).seconds, .2 + 1000 / 48000);
  const wrapped = timeline.advance(1100); assert.equal(wrapped.seconds, .1 + 200 / 48000); assert.equal(wrapped.loops.length, 1); assert.equal(wrapped.iteration, 1);
  assert.equal(timeline.advance(1200).loops.length, 0);
  const plain = new TransportTimeline(0, 1.5);
  for (let n = 0; n < 10000; n++) { plain.push(2048, [{ offset: 0, seconds: n * 2048 * 1.5 / 48000, iteration: 0 }]); plain.advance((n + 1) * 2048); }
  assert.equal(plain.entries.length, 1);
});

function calls(worker) { const pending = new Map(); let id = 0; worker.on('message', data => { const p = pending.get(data.id); if (p) { pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); } }); return (type, values) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); worker.postMessage({ type, id: n, ...values }); }); }

test('Worker settings keep source position, reuse samples, combine part controls, loop without EOF and cancel obsolete reconstruction', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel(), call = calls(worker);
  const read = async epoch => { const p = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch }); return (await p)[0]; };
  try {
    const loaded = await call('load', { bytes: timed, effects: false, epoch: 1 });
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    const options = { rate: 2, transpose: 12, loop: { start: .13, end: .37 } };
    const changed = await call('playback', { settings: options, seconds: .23, epoch: 2 });
    assert.ok(Math.abs(changed.seconds - .23) < 2 / 48000); assert.equal(changed.metadata.sampleBank.downloadedBytes, 0);
    const prepared = await loader().load(timed), base = await createSoundFontPreview(timed, prepared.bank, { prepared, playback: options, effects: false }), reference = createLoopPreview(base, options);
    try {
      await reference.seek(.23);
      for (let i = 0; i < 10; i++) { const block = await read(2); assert.equal(block.done, false); assert.deepEqual(block.channels, reference.read(2048)); assert.deepEqual(block.spans, reference.lastSpans); }
    } finally { reference.close(); }
    const muted = await call('parts', { part: loaded.parts[0].id, changes: { muted: true }, seconds: .2, epoch: 3 }); assert.equal(muted.metadata.playback.rate, 2);
    assert.ok((await read(3)).channels.every(c => c.every(v => v === 0)));
    const next = await call('load', { bytes: timed, effects: false, epoch: 4 }); assert.deepEqual(next.playback, { rate: 1, transpose: 0, loop: null });
    const long = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(700 * 960), 0x80, 60, 64], end]);
    await call('load', { bytes: long, effects: false, epoch: 5 });
    const first = call('playback', { settings: { rate: .5, loop: { start: 599, end: 601 } }, seconds: 600, epoch: 6 });
    const last = call('seek', { seconds: .13, epoch: 7 });
    assert.equal((await first).cancelled, true); const result = await last; assert.ok(Math.abs(result.seconds - .13) < 1e-9); assert.equal(result.metadata.playback.rate, .5);
  } finally { channel.port1.close(); await worker.terminate(); }
});

test('public playback API validates before suspension and keeps source-time text and configured defaults across stop/seek', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)); this.worker.on('message', data => this.onmessage?.({ data })); } postMessage(data, transfer) { this.worker.postMessage(data, transfer); } terminate() { return this.worker.terminate(); } };
  const player = new MidiPlayer({ effects: false, playbackRate: .5, transpose: -2 });
  try {
    await player.load(timed); assert.equal(player.playbackRate, .5); player.currentTime = .2;
    const epoch = player._epoch; await assert.rejects(player.setPlayback({ rate: 0 })); assert.equal(player._epoch, epoch);
    await player.setPlayback({ rate: 2, transpose: 12, loop: { start: .1, end: .4 } });
    assert.equal(player.playbackRate, 2); assert.ok(Math.abs(player.currentTime - .2) < 1e-9);
    await player.seek(.8); assert.ok(Math.abs(player.currentTime - .1) < 1e-9);
    await player.stop(); assert.equal(player.currentTime, 0); assert.equal(player.loop.end, .4);
    const copy = player.playback; copy.loop.end = .2; assert.equal(player.loop.end, .4);
    await player.load(timed); assert.equal(player.playbackRate, .5); assert.equal(player.transpose, -2); assert.equal(player.loop, null);
  } finally { await player.dispose(); globalThis.Worker = original; }
});


test('audible loop messages flush crossed lyrics and reconstruct A without emitting text at excluded B', async () => {
  const original = [globalThis.Worker, globalThis.AudioContext, globalThis.AudioWorkletNode];
  globalThis.Worker = class { constructor() { this.worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)); this.worker.on('message', data => this.onmessage?.({ data })); } postMessage(data, transfer) { this.worker.postMessage(data, transfer); } terminate() { return this.worker.terminate(); } };
  globalThis.AudioContext = class {
    constructor() { this.audioWorklet = { addModule: async () => {} }; this.destination = {}; this.currentTime = 0; }
    async resume() {} async suspend() {} async close() {}
    createGain() { return { gain: { setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
  };
  globalThis.AudioWorkletNode = class {
    constructor() { this.port = { postMessage(data) { if (data.type === 'connect') this.stream = data.port; }, close() { this.stream?.close(); } }; }
    connect() {} disconnect() {}
  };
  const player = new MidiPlayer({ effects: false }), texts = [], loops = [];
  player.addEventListener('textchange', e => texts.push(e.detail)); player.addEventListener('loop', e => loops.push(e.detail));
  const lyric = (text, delta = 96) => [delta, 255, 5, text.length, ...Buffer.from(text)];
  const source = midi([lyric('A', 0), [0, 0x90, 60, 100], lyric('B'), lyric('C'), lyric('D'), lyric('Boundary'), [96, 0x80, 60, 64], end]);
  try {
    await player.unlock(); await player.load(source); await player.setPlayback({ rate: 2, loop: { start: .1, end: .4 } }); await player.seek(.15);
    assert.equal(player.textState.lyrics[0].line, 'AB'); texts.length = 0;
    const send = data => player._node.port.onmessage({ data: { epoch: player._epoch, ...data } });
    send({ type: 'loop', start: .1, end: .4, iteration: 1 });
    assert.equal(texts[0].reason, 'playback'); assert.deepEqual(texts[0].events.filter(e => e.lyric).map(e => e.text), ['C', 'D']);
    assert.equal(texts[1].reason, 'loop'); assert.equal(texts[1].state.lyrics[0].line, 'AB');
    assert.equal(player.currentTime, .1); assert.equal(player.iteration, 1); assert.equal(loops.length, 1);
    send({ type: 'position', seconds: .12, iteration: 1, underruns: 0 });
    assert.equal(player.currentTime, .12); assert.equal(texts.length, 2); assert.equal(player.textState.lyrics[0].line, 'AB');
    player._node.port.onmessage({ data: { type: 'loop', epoch: player._epoch - 1, start: 0, end: .4, iteration: 99 } });
    assert.equal(player.iteration, 1); assert.equal(loops.length, 1);
  } finally { await player.dispose(); [globalThis.Worker, globalThis.AudioContext, globalThis.AudioWorkletNode] = original; }
});


test('whole-song repeat ends at the final End Of Track and restores zero with setup commands intact', async () => {
  const bytes = midi([[0, 0xf0, 5, 0x7e, 0x7f, 9, 1, 0xf7], [0, 0xc0, 81], [0, 0x90, 60, 100],
    [120, 0x80, 60, 64], [...vlq(360), 0xb0, 7, 0], end]);
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const settings = resolvePlayback({ rate: 2, transpose: 7, loop: true }, .5);
    const prepared = await loader().load(bytes);
    const base = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: true, dsp, playback: settings });
    const reference = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: true, dsp, playback: settings });
    const loop = createLoopPreview(base, settings);
    try {
      const count = Math.round(.5 / 2 * 48000), pcm = reference.read(count), repeated = loop.read(count * 3 + 17);
      repeated.forEach((c, channel) => assert.deepEqual(c, Float32Array.from({ length: c.length }, (_, i) => pcm[channel][i % count])));
      assert.equal(loop.stats.iteration, 3); assert.equal(loop.stats.position, 17 / 48000 * 2);
      await loop.seek(.5); assert.equal(loop.stats.position, 0); assert.deepEqual(loop.read(512), pcm.map(c => c.slice(0, 512)));
    } finally { loop.close(); reference.close(); }
  }
});


test('B dispatch uses the absolute tempo map instead of accumulated floating-point tick drift', async () => {
  const events = []; let seed = 4;
  for (let i = 0; i < 300; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const us = 200000 + seed % 700000;
    events.push([i ? 7 : 0, 255, 81, 3, us >> 16, us >> 8 & 255, us & 255], [1, 0xb0, 1, i % 128]);
  }
  const tick = 299 * 8 + 1;
  events.push([0, 0xb0, 0, 119], [0, 0xc0, 73], [1, 0xb0, 0, 120], [0, 0xc0, 73], [120, 255, 47, 0]);
  const bytes = midi(events), parsed = BasicMIDI.fromArrayBuffer(bytes.buffer), end = parsed.midiTicksToSeconds(tick);
  const settings = { rate: 1, transpose: 0, loop: { start: 0, end } }, base = await preview(bytes, settings), loop = createLoopPreview(base, settings);
  const before = SpessaLog.onDiagnostic, selected = [];
  SpessaLog.onDiagnostic = detail => { if (detail.kind === 'substituted') selected.push(detail.requested.bankMSB); };
  try { loop.read(Math.round(end * 48000)); assert.deepEqual(selected, [119]); }
  finally { SpessaLog.onDiagnostic = before; loop.close(); }
});
