import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { BasicMIDI, SoundBankLoader, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from '../vendor/spessasynth.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { diagnoseMidi } from '../midi-diagnostics.js';
import { installPartControls, normalizePartPatch, updatePartSettings, describeInstruments } from '../part-controls.js';
import { MidiPlayer } from '../index.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const bytes = fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const end = [0, 255, 47, 0];
const flute = { program: 73, bankMSB: 0, bankLSB: 0, percussion: false };
const score = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(240), 0xb0, 64, 127],
  [0, 0x80, 60, 23], [0, 0xc0, 19], [0, 0x90, 67, 90], [...vlq(240), 0xb0, 7, 80],
  [0, 0xb0, 10, 100], [...vlq(240), 0x80, 67, 80], [0, 0xb0, 64, 0], [...vlq(240), 255, 47, 0]]);
const multi = midiTracks([
  [[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(240), 0x80, 60, 64],
   [0, 255, 33, 1, 7], [0, 0xc0, 73], [0, 0xf7, 3, 0x90, 72, 100], [...vlq(240), 0x80, 72, 0], end],
  [[0, 0x90, 67, 100], [...vlq(240), 0x80, 67, 64], end],
  [[0, 255, 33, 1, 2], [0, 0xc0, 19], [0, 0x90, 48, 100], [...vlq(480), 0x80, 48, 64], end]
]);
const loader = () => new BrowserSoundBank(undefined, { fetcher: async (url, { signal } = {}) => { signal?.throwIfAborted(); return new Response(fs.readFileSync(fileURLToPath(url))); } });
async function synth() {
  const s = new SpessaSynthProcessor(48000, { effectsEnabled: false, eventsEnabled: true, maxBufferSize: 128 });
  s.onMissingPreset = (p, system) => bank.getPreset(p, system); s.soundBankManager.addSoundBank(bank, 'main');
  await s.processorInitialized; s.setSystemParameter('autoAllocateVoices', true); s.setSystemParameter('blackMIDIMode', false);
  return s;
}
function render(s, count = 128) {
  const pcm = [new Float32Array(count), new Float32Array(count)];
  for (let at = 0; at < count; at += 128) s.process(pcm[0], pcm[1], at, Math.min(128, count - at));
  return pcm;
}
const parts = [{ id: '0:1', port: 0, channel: 1, synthChannel: 0, tracks: [1], sourceInstruments: [] }];

test('part metadata merges tracks by receiver channel and keeps timed ports and escaped notes distinct', async () => {
  const report = await diagnoseMidi(BasicMIDI.fromArrayBuffer(multi.buffer), bank);
  assert.ok(report.complete);
  assert.deepEqual(report.parts.map(p => [p.id, p.synthChannel, p.tracks]), [['0:1', 0, [1, 2]], ['2:1', 16, [3]], ['7:1', 32, [1]]]);
  assert.deepEqual(report.parts.map(p => p.sourceInstruments[0].program), [81, 19, 73]);
  const s = await synth();
  try {
    // GS: receiver part 2 listens to channel 1 as well as part 1.
    const data = midi([[0, 0xf0, 10, 0x41, 0x10, 0x42, 0x12, 0x40, 0x12, 2, 0, 0x2c, 0xf7],
      [0, 0x90, 60, 100], [...vlq(480), 0x80, 60, 64], end]);
    const routed = await diagnoseMidi(BasicMIDI.fromArrayBuffer(data.buffer), bank);
    assert.deepEqual(routed.parts.map(p => p.id), ['0:1', '0:2']);
  } finally { s.stopAllChannels(true); }
});

test('part validation copies addresses, rejects invalid controls and validates actual available instruments', () => {
  const p = { instrument: { program: 73 } }, normalized = normalizePartPatch(p); p.instrument.program = 1;
  assert.deepEqual(normalized.instrument, flute);
  const instruments = describeInstruments(bank);
  for (const bad of [{ volume: NaN }, { volume: 2 }, { pan: -2 }, { solo: 1 }, { muted: 'yes' }, { unknown: 1 }, { instrument: { program: 128 } }, { instrument: { program: 1, typo: 0 } }]) assert.throws(() => normalizePartPatch(bad));
  assert.throws(() => updatePartSettings(parts, instruments, {}, '7:1', {}), /Unknown MIDI part/);
  assert.throws(() => updatePartSettings(parts, instruments, {}, '0:1', { instrument: { program: 73, bankMSB: 127 } }), /not available/);
  assert.equal(updatePartSettings(parts, instruments, {}, '0:1', { instrument: flute })['0:1'].instrument.program, 73);
});

test('muted voices still execute notes, programs, pedals, controllers and release, and retain the exact phase', async () => {
  const a = await synth(), b = await synth();
  try {
    installPartControls(a, bank, parts, { '0:1': { muted: true } });
    const events = [];
    for (const s of [a, b]) {
      s.onEventCall = e => { if (s === a) events.push(e.type); };
      s.programChange(0, 81); s.controllerChange(0, 64, 127); s.noteOn(0, 60, 100);
      s.controllerChange(0, 7, 80); s.controllerChange(0, 10, 100); s.noteOff(0, 60, 23); s.programChange(0, 19);
    }
    assert.ok(render(a, 6144).every(c => c.every(v => v === 0))); render(b, 6144);
    assert.ok(a.voiceCount > 0); assert.ok(events.includes('noteOn') && events.includes('noteOff') && events.includes('programChange'));
    assert.deepEqual(a.midiChannels[0].midiControllers, b.midiChannels[0].midiControllers);
    assert.equal(a.midiChannels[0].patch.program, 19);
    a.midiChannels[0].setSystemParameter('gain', 1);
    assert.deepEqual(render(a, 2048), render(b, 2048));
    a.controllerChange(0, 64, 0); b.controllerChange(0, 64, 0);
    assert.deepEqual(render(a, 2048), render(b, 2048));
  } finally { a.stopAllChannels(true); b.stopAllChannels(true); }
});

test('solo is a union across ports, mute takes priority, and volume/pan leave MIDI state intact through reset', async () => {
  const s = await synth();
  const rows = [0, 16, 32].map((n, i) => ({ ...parts[0], id: i + ':1', port: i, synthChannel: n }));
  try {
    installPartControls(s, bank, rows, { '0:1': { solo: true, volume: .25, pan: -.5 }, '1:1': { solo: true, muted: true } });
    for (const [n, gain] of [[0, .25], [16, 0], [32, 0]]) assert.equal(s.midiChannels[n].systemParameters.gain, gain);
    s.controllerChange(0, 7, 77); s.controllerChange(0, 10, 90); s.controllerChange(0, 121, 0);
    assert.equal(s.midiChannels[0].midiControllers[7] >> 7, 77); assert.equal(s.midiChannels[0].midiControllers[10] >> 7, 90);
    s.synthCore.reset('gm');
    assert.equal(s.midiChannels[0].systemParameters.gain, .25); assert.equal(s.midiChannels[0].systemParameters.pan, -.5);
    assert.equal(s.midiChannels[16].systemParameters.gain, 0);
  } finally { s.stopAllChannels(true); }
});

test('instrument overrides select an exact preset across MIDI mode changes without suppressing file programs', async () => {
  const s = await synth();
  try {
    installPartControls(s, bank, parts, { '0:1': { instrument: flute } });
    const presets = [], original = s.synthCore.getVoicesForPreset.bind(s.synthCore);
    s.synthCore.getVoicesForPreset = (preset, ...args) => { presets.push(preset); return original(preset, ...args); };
    for (const system of ['gm', 'gs', 'xg']) {
      s.synthCore.reset(system); s.programChange(0, 19); s.noteOn(0, 60, 100); s.noteOff(0, 60, 64);
      assert.equal(s.midiChannels[0].patch.program, 19);
    }
    assert.ok(presets.length >= 3 && presets.every(p => p.program === 73 && !p.isDrum));
  } finally { s.stopAllChannels(true); }
});

test('configured selective banks load replacement regions only and match an independent MIDI rewrite on every DSP and exact seek', async () => {
  const settings = { '0:1': { instrument: flute, volume: .5, pan: -.4 } };
  const original = await loader().load(score);
  const prepared = await loader().load(score, { parts: original.diagnostics.parts, partSettings: settings });
  assert.ok(prepared.sampleBank.samples > 0 && prepared.sampleBank.samples < 15);
  // The original file has two programs. The oracle writes the chosen program
  // into each command, and applies host gain/pan directly rather than our API.
  const referenceBytes = score.slice();
  const parsed = BasicMIDI.fromArrayBuffer(referenceBytes.buffer);
  for (const track of parsed.tracks) for (const event of track.events) if ((event.statusByte & 0xf0) === 0xc0) event.data[0] = 73;
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const actual = await createSoundFontPreview(score, prepared.bank, { effects: false, dsp, prepared, parts: original.diagnostics.parts, partSettings: settings });
    const s = await synth();
    if (dsp !== 'js') { const { installVoiceDSP } = await import('../voice-dsp.js'); await installVoiceDSP(s, dsp); }
    const seq = new SpessaSynthSequencer(s); seq.preload = seq.skipToFirstNoteOn = false; seq.loopCount = 0; seq.loadNewSongList([parsed]); seq.play();
    s.midiChannels[0].setSystemParameter('gain', .5); s.midiChannels[0].setSystemParameter('pan', -.4);
    const expected = [new Float32Array(96000), new Float32Array(96000)];
    try {
      // Use a separate instance of the same compressed assets, without the
      // host instrument-override path, as the PCM oracle.
      const oracleBank = await loader().load(score, { parts: original.diagnostics.parts, partSettings: settings });
      s.soundBankManager.deleteSoundBank('main'); s.soundBankManager.addSoundBank(oracleBank.bank, 'oracle');
      for (let at = 0; at < 96000; at += 128) { seq.processTick(); s.process(expected[0], expected[1], at, 128); }
      assert.deepEqual(actual.read(96000), expected);
      assert.ok(expected.some(c => c.some(v => Math.abs(v) > .001)));
      for (const time of [.613, .04, 1.13]) { await actual.seek(time); const at = Math.round(time * 48000); assert.deepEqual(actual.read(512), expected.map(c => c.slice(at, at + 512))); }
    } finally { actual.close(); s.stopAllChannels(true); }
  }
});

test('Worker part updates restore audible position, combine changes, isolate ports and clear settings on a new song', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel();
  let id = 0;
  const call = async (type, values) => { const pending = once(worker, 'message'); worker.postMessage({ type, id: ++id, ...values }); const reply = (await pending)[0]; assert.equal(reply.error, undefined); return reply.result; };
  const read = async epoch => { const pending = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch }); return (await pending)[0]; };
  try {
    const loaded = await call('load', { bytes: multi, effects: false, epoch: 1 }); assert.equal(loaded.parts.length, 3);
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    const changed = await call('parts', { part: '7:1', changes: { solo: true, instrument: flute }, seconds: .3, epoch: 2 });
    assert.equal(changed.seconds, .3); assert.equal(changed.metadata.parts.find(p => p.id === '7:1').solo, true);
    const reference = await loader().load(multi, { parts: loaded.parts, partSettings: { '7:1': { solo: true, instrument: flute } } });
    const p = await createSoundFontPreview(multi, reference.bank, { prepared: reference, effects: false, parts: loaded.parts, partSettings: { '7:1': { solo: true, instrument: flute } } });
    try { await p.seek(.3); assert.deepEqual((await read(2)).channels, p.read(2048)); } finally { p.close(); }
    const muted = await call('parts', { part: '7:1', changes: { muted: true }, seconds: .3, epoch: 3 });
    assert.equal(muted.metadata.parts.find(p => p.id === '7:1').instrument.program, 73);
    assert.ok((await read(3)).channels.every(c => c.every(v => v === 0)));
    const back = await call('seek', { seconds: .1, epoch: 4 }); assert.equal(back.metadata.parts.find(p => p.id === '7:1').solo, true);
    const next = await call('load', { bytes: score, effects: false, epoch: 5 }); assert.ok(next.parts.every(p => !p.solo && !p.muted && p.instrument === null));
  } finally { channel.port1.close(); await worker.terminate(); }
});

test('public API exports defensive part snapshots and rejects invalid changes before suspending playback', async () => {
  const p = new MidiPlayer(); p.metadata = { parts, instruments: describeInstruments(bank) };
  const snapshot = p.parts; snapshot[0].tracks.push(9); assert.deepEqual(p.parts[0].tracks, [1]);
  await assert.rejects(p.setPart('missing', { muted: true }), /Unknown MIDI part/); assert.equal(p.state, 'empty');
  await assert.rejects(p.setPart('0:1', { volume: -1 }), /Invalid part/);
  const compact = new MidiPlayer({ engine: 'z80' }); await assert.rejects(compact.setPart('0:1', {}), /SoundFont/);
  await compact.dispose(); await p.dispose();
});

function workerCalls(worker) {
  const pending = new Map(); let id = 0;
  worker.on('message', data => { const request = pending.get(data.id); if (request) { pending.delete(data.id); data.error ? request.reject(new Error(data.error)) : request.resolve(data.result); } });
  return (type, values) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); worker.postMessage({ type, id: next, ...values }); });
}

test('failed replacement downloads preserve the old preview and can be retried', async () => {
  const root = new URL('../soundfonts/fluidr3-gm/', import.meta.url), manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
  const allowed = new Set(['manifest.json', 'bank.sf3', ...manifest.samples.map(p => p.file)]);
  let fail = false, failures = 0;
  const server = createServer((request, response) => {
    const file = request.url.slice(1);
    if (!allowed.has(file)) { response.writeHead(404).end(); return; }
    if (fail && /[.](ogg|pcm)$/.test(file)) { failures++; response.writeHead(503).end(); return; }
    response.end(fs.readFileSync(new URL(file, root)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel(), call = workerCalls(worker);
  const read = async epoch => { const pending = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch }); return (await pending)[0]; };
  try {
    await call('load', { bytes: score, effects: false, epoch: 1, sampleManifestUrl: 'http://127.0.0.1:' + server.address().port + '/manifest.json' });
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    await call('seek', { seconds: .1, epoch: 2 }); const before = await read(2);
    fail = true;
    await assert.rejects(call('parts', { part: '0:1', changes: { instrument: flute }, seconds: .1, epoch: 3 }), /HTTP 503/);
    assert.ok(failures > 0);
    const recovered = await call('seek', { seconds: .1, epoch: 4 });
    assert.equal(recovered.metadata.parts[0].instrument, null); assert.deepEqual((await read(4)).channels, before.channels);
    fail = false;
    const retry = await call('parts', { part: '0:1', changes: { instrument: flute }, seconds: .1, epoch: 5 });
    assert.equal(retry.metadata.parts[0].instrument.program, 73); assert.ok((await read(5)).channels.some(c => c.some(v => Math.abs(v) > .001)));
  } finally { channel.port1.close(); await worker.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('superseded part reconstruction preserves both requested changes for the following seek', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), call = workerCalls(worker);
  try {
    const long = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(700 * 960), 0x80, 60, 64], end]);
    await call('load', { bytes: long, effects: false, epoch: 1 });
    const first = call('parts', { part: '0:1', changes: { muted: true }, seconds: 600, epoch: 2 });
    const second = call('parts', { part: '0:1', changes: { volume: .25 }, seconds: 600, epoch: 3 });
    const last = call('seek', { seconds: .13, epoch: 4 });
    assert.equal((await first).cancelled, true); assert.equal((await second).cancelled, true);
    const result = await last; assert.equal(result.seconds, .13);
    assert.equal(result.metadata.parts[0].muted, true); assert.equal(result.metadata.parts[0].volume, .25);
  } finally { await worker.terminate(); }
});

test('public part API resets queued audio at the audible position, resumes playback and restores after failures', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { this.worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)); this.worker.on('message', data => this.onmessage?.({ data })); this.worker.on('error', error => this.onerror?.(error)); }
    postMessage(data, transfers) { this.worker.postMessage(data, transfers); }
    terminate() { return this.worker.terminate(); }
  };
  const player = new MidiPlayer({ effects: false }), resets = [];
  try {
    await player.load(score); player.currentTime = .133; player.state = 'playing'; player._wantsPlayback = true;
    let suspended = 0, resumed = 0;
    player._context = { suspend: async () => { suspended++; }, resume: async () => { resumed++; }, close: async () => {} };
    player._node = { port: { postMessage: data => resets.push(data), close() {} }, disconnect() {} };
    const events = []; player.addEventListener('partschanged', e => events.push(e.detail.parts));
    const changed = await player.setPart('0:1', { volume: .5, instrument: flute });
    assert.equal(changed.volume, .5); assert.equal(player.state, 'playing'); assert.equal(player.currentTime, .133);
    assert.equal(resets.at(-1).offset, .133); assert.equal(resets.at(-1).epoch, player._epoch); assert.equal(suspended, 1); assert.equal(resumed, 1); assert.equal(events.length, 1);
    const call = player._call.bind(player); player._call = (type, ...args) => type === 'parts' ? Promise.reject(new Error('Sample unavailable')) : call(type, ...args);
    await assert.rejects(player.setPart('0:1', { volume: .25 }), /Sample unavailable/);
    assert.equal(player.parts[0].volume, .5); assert.equal(player.state, 'playing'); assert.equal(resets.at(-1).epoch, player._epoch);
    player._call = call;
    const first = player.setPart('0:1', { muted: true }), last = player.seek(.2);
    await first; await last; assert.equal(player.parts[0].muted, true); assert.equal(player.currentTime, .2); assert.equal(events.length, 2);
  } finally { await player.dispose(); globalThis.Worker = originalWorker; }
});
