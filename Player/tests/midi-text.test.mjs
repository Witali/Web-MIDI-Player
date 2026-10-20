import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BasicMIDI, SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { MidiTextCollector, MidiTextTimeline, decodeDisplay } from '../midi-text.js';
import { diagnoseMidi } from '../midi-diagnostics.js';
import { normalizeSmpteTiming } from '../midi-timing.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { MidiPlayer } from '../index.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const source = fs.readFileSync(new URL('../soundfonts/fluidr3-gm/bank.sf3', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
const end = [0, 255, 47, 0], utf8 = text => Array.from(new TextEncoder().encode(text));
const meta = (type, text, delta = 0) => { const bytes = typeof text === 'string' ? utf8(text) : text; return [...vlq(delta), 255, type, ...vlq(bytes.length), ...bytes]; };
const sysex = (body, delta = 0) => [...vlq(delta), 0xf0, ...vlq(body.length), ...body];
const gs = (type, offset, bytes) => { const data = [0x10, type, offset, ...bytes]; return [0x41, 0x10, 0x45, 0x12, ...data, (-data.reduce((a, b) => a + b, 0)) & 127, 0xf7]; };
const xg = (type, offset, bytes, device = 0) => [0x43, 0x10 | device, 0x4c, type, 0, offset, ...bytes, 0xf7];
async function inspect(bytes, encoding = 'auto') {
  const parsed = normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const before = parsed.writeMIDI(), collector = new MidiTextCollector(parsed, encoding);
  const report = await diagnoseMidi(parsed, bank, { textCollector: collector });
  assert.deepEqual(parsed.writeMIDI(), before, 'inspection must not rewrite meta events');
  return { parsed, text: collector.finish(), report };
}
const loader = () => new BrowserSoundBank(undefined, { fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url))) });
const song = midi([meta(3, 'Тестовая дорожка'), meta(4, 'Флейта'), meta(6, 'Начало'), [0, 0xc0, 73], [0, 0x90, 69, 100],
  meta(5, 'Hel', 240), meta(5, 'lo', 240), meta(7, 'Занавес', 240), [0, 0x80, 69, 64], meta(6, 'Конец', 240), end]);

test('SMF text types retain byte content, event order, source track, channel prefixes and timed MIDI ports', async () => {
  const bytes = midiTracks([
    [meta(3, 'Sequence'), meta(2, '(C) Example'), [0, 255, 32, 1, 4], meta(4, 'Instrument'), meta(5, 'One'),
     [0, 0x94, 60, 100], meta(5, 'Two'), [0, 255, 33, 1, 7], meta(6, 'Mark'),
     [0, 255, 32, 1, 2], [0, 0xf7, 3, 0x92, 67, 100], meta(7, 'Cue'), meta(10, [0, 255, 127]), [...vlq(240), 0xb2, 123, 0], end],
    [meta(3, 'Second track'), meta(1, 'Other text'), end]
  ]);
  const { text } = await inspect(bytes);
  assert.deepEqual(text.tracks.map(t => t.name), ['Sequence', 'Second track']);
  assert.deepEqual(text.events.filter(e => e.track === 1).map(e => [e.kind, e.channel, e.port]), [
    ['trackName', null, 0], ['copyright', null, 0], ['instrumentName', 5, 0], ['lyric', 5, 0],
    ['lyric', null, 0], ['marker', null, 7], ['cue', null, 7], ['reservedText', null, 7]
  ]);
  assert.deepEqual(text.events.find(e => e.metaType === 10).bytes, [0, 255, 127]);
  assert.deepEqual(text.events.map(e => e.id), Array.from({ length: text.events.length }, (_, i) => i));
});

test('lyrics, markers and trailing cues follow PPQN tempo changes and all four SMPTE clocks', async () => {
  const ppqn = midi([meta(6, 'A'), [0, 255, 81, 3, 7, 161, 32], meta(5, 'B', 480),
    [0, 255, 81, 3, 3, 208, 144], meta(7, 'C', 480), end]);
  assert.deepEqual((await inspect(ppqn)).text.events.map(e => e.seconds), [0, .5, .75]);
  for (const code of [24, 25, 29, 30]) {
    const ticks = (code === 29 ? 30 : code) * 40;
    const bytes = midi([meta(5, 'Start'), [0, 255, 81, 3, 3, 208, 144], meta(5, 'End', ticks), end], ((256 - code) << 8) | 40);
    assert.ok(Math.abs((await inspect(bytes)).text.events.at(-1).seconds - (code === 29 ? 1.001 : 1)) < 1e-12);
  }
  const tail = await inspect(midi([[0, 0x90, 60, 100], [120, 0x80, 60, 0], meta(7, 'After last note', 480), end]));
  assert.equal(tail.text.events.at(-1).seconds, .625);
});

test('UTF-8, legacy encodings and unrecognized text preserve original bytes and invalid encoding fails early', async () => {
  const bytes = midi([meta(3, 'Привет'), meta(5, [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), end]);
  const automatic = (await inspect(bytes)).text;
  assert.equal(automatic.events[0].text, 'Привет'); assert.equal(automatic.events[0].encoding, 'utf-8');
  assert.equal(automatic.events[1].encoding, 'windows-1252'); assert.deepEqual(automatic.events[1].bytes, [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  assert.equal((await inspect(bytes, 'windows-1251')).text.events[1].text, 'Привет');
  assert.throws(() => new MidiPlayer({ textEncoding: 'not-an-encoding' }));
});

test('karaoke presentation preserves original lyric meta types and rebuilds lines after backward seeks', async () => {
  const bytes = midi([meta(1, '@KMIDI KARAOKE FILE'), meta(5, 'Hello'), meta(1, ' world', 240), meta(1, '/Second', 240), meta(1, '\\Page', 240), end]);
  const { parsed, text } = await inspect(bytes);
  assert.equal(parsed.tracks[0].events.find(e => e.data[0] === 72).statusByte, 5);
  const rewritten = BasicMIDI.fromArrayBuffer(parsed.writeMIDI()); assert.equal(rewritten.tracks[0].events.find(e => e.data[0] === 72).statusByte, 5);
  const timeline = new MidiTextTimeline(text);
  assert.equal(timeline.at(.25).state.lyrics[0].line, 'Hello world');
  assert.equal(timeline.at(.5).state.lyrics[0].line, 'Second');
  assert.equal(timeline.at(.75).state.lyrics[0].line, 'Page');
  assert.equal(timeline.at(.1).state.lyrics[0].line, 'Hello');
  assert.equal(timeline.at(-.1).state.lyrics.length, 0);
});

test('GS/XG letter and bitmap updates validate addresses and GS checksum and restore partial display state', async () => {
  const bytes = midi([sysex(gs(0, 0, utf8('Hello'))), sysex(gs(0, 6, utf8('!')), 120),
    sysex(gs(1, 0, [16])), sysex(gs(1, 48, [16])),
    sysex(xg(6, 0, utf8('Yamaha'))), sysex(xg(7, 0, [64])), sysex(xg(7, 32, [32])), end]);
  const { text, report } = await inspect(bytes);
  assert.equal(text.events.length, 7); assert.ok(text.events.every(e => e.kind === 'display' && e.display.format !== 'raw'));
  assert.equal(report.summary.unverified, 0);
  const timeline = new MidiTextTimeline(text), state = timeline.at(.125).state;
  assert.equal(state.displays.find(d => d.family === 'gs' && d.format === 'letters').text, 'Hello !'.padEnd(32));
  assert.equal(state.displays.find(d => d.family === 'xg' && d.format === 'letters').text.trimEnd(), 'Yamaha');
  for (const family of ['gs', 'xg']) assert.equal(state.displays.find(d => d.family === family && d.format === 'bitmap').pixels[0], '1000000000000001');
  assert.equal(timeline.at(0).state.displays.length, 1);
  const invalid = gs(0, 0, utf8('Bad')); invalid[invalid.length - 2] ^= 1;
  assert.equal(decodeDisplay(invalid).format, 'raw');
  assert.equal(decodeDisplay(xg(6, 31, utf8('Too long'))).format, 'raw');
  assert.equal(decodeDisplay(xg(7, 0, [128])).format, 'raw');
});

test('fragmented F0/F7 display messages appear at completion and independent ports/devices never share display memory', async () => {
  const message = xg(6, 0, utf8('First'));
  const bytes = midiTracks([
    [[0, 0xf0, 5, ...message.slice(0, 5)], [...vlq(480), 0xf7, message.length - 5, ...message.slice(5)], end],
    [[0, 255, 33, 1, 3], sysex(xg(6, 0, utf8('Other port'))), sysex(xg(6, 0, utf8('Other device'), 1)), end]
  ]);
  const { text } = await inspect(bytes);
  assert.equal(text.events.length, 3); assert.equal(text.events.at(-1).seconds, .5); assert.equal(text.events.at(-1).port, 0);
  const timeline = new MidiTextTimeline(text);
  assert.equal(timeline.at(.49).state.displays.length, 2);
  assert.deepEqual(timeline.at(.5).state.displays.map(d => [d.event.port, d.text.trimEnd()]), [[3, 'Other port'], [3, 'Other device'], [0, 'First']]);
});

test('text inspection is silent and leaves PCM, DSP and exact seeks unchanged', async () => {
  const plain = midi([[0, 0xc0, 73], [0, 0x90, 69, 100], [...vlq(720), 0x80, 69, 64], [...vlq(240), 255, 47, 0]]);
  const prepared = await loader().load(song), reference = await loader().load(plain);
  assert.equal(prepared.text.events.at(-1).kind, 'marker');
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const a = await createSoundFontPreview(song, prepared.bank, { prepared, effects: true, dsp });
    const b = await createSoundFontPreview(plain, reference.bank, { prepared: reference, effects: true, dsp });
    try {
      const pcm = b.read(96000); assert.deepEqual(a.read(96000), pcm);
      for (const seconds of [.43, .01, .91]) { await a.seek(seconds); const at = Math.round(seconds * 48000); assert.deepEqual(a.read(256), pcm.map(c => c.slice(at, at + 256))); }
      assert.deepEqual(a.stats.text, prepared.text);
    } finally { a.close(); b.close(); }
  }
});

test('public Worker API emits every crossed text event and restores lyrics/markers after seek, stop, part edits and new loads', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { this.worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)); this.worker.on('message', data => this.onmessage?.({ data })); }
    postMessage(data, transfers) { this.worker.postMessage(data, transfers); }
    terminate() { return this.worker.terminate(); }
  };
  const player = new MidiPlayer({ effects: false }), events = [];
  player.addEventListener('textchange', e => events.push(e.detail));
  try {
    const metadata = await player.load(song); assert.equal(metadata.text.tracks[0].name, 'Тестовая дорожка'); assert.equal(player.textState.marker.text, 'Начало');
    player.currentTime = .6; player._updateText(); assert.equal(player.textState.lyrics[0].line, 'Hello');
    assert.deepEqual(events.at(-1).events.filter(e => e.lyric).map(e => e.text), ['Hel', 'lo']);
    const count = events.length; player._updateText(); assert.equal(events.length, count);
    await player.seek(.4); assert.equal(player.textState.lyrics[0].line, 'Hel'); assert.equal(events.at(-1).reason, 'seek');
    const copy = player.textEvents; copy[0].bytes[0] = 0; assert.notEqual(player.textEvents[0].bytes[0], 0);
    const state = player.textState; state.lyrics[0].line = 'Changed'; assert.equal(player.textState.lyrics[0].line, 'Hel');
    await player.setPart('0:1', { muted: true }); assert.equal(player.textState.lyrics[0].line, 'Hel');
    await player.seek(.9); assert.equal(player.textState.cue.text, 'Занавес');
    await player.stop(); assert.equal(player.textState.lyrics.length, 0); assert.equal(player.textState.marker.text, 'Начало');
    await player.load(midi([[0, 0x90, 60, 100], [120, 0x80, 60, 0], end])); assert.deepEqual(player.textEvents, []); assert.equal(player.textState.marker, null);
  } finally { await player.dispose(); globalThis.Worker = original; }
});

test('the full-bank preview path includes text, and invalid display packets retain an unverified report and original bytes', async () => {
  const preview = await createSoundFontPreview(song, bank, { dsp: 'js', effects: false });
  try { assert.equal(preview.stats.text.tracks[0].name, 'Тестовая дорожка'); assert.equal(preview.stats.text.events.at(-1).text, 'Конец'); }
  finally { preview.close(); }
  const invalid = gs(0, 0, utf8('Bad')); invalid[invalid.length - 2] ^= 1;
  const inspected = await inspect(midi([sysex(invalid), end]));
  assert.equal(inspected.report.summary.unverified, 1); assert.deepEqual(inspected.text.events[0].display.bytes, invalid);
});

test('fractional-frame markers stay active at the rounded audio seek position', () => {
  const marker = { id: 0, kind: 'marker', text: 'Fractional', seconds: 50.0001 / 48000 };
  const timeline = new MidiTextTimeline({ events: [marker] });
  assert.equal(timeline.at(49 / 48000).state.marker, null);
  assert.equal(timeline.at(50 / 48000).state.marker.text, 'Fractional');
  assert.equal(timeline.at(49 / 48000).state.marker, null);
});
