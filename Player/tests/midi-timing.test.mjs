import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicMIDI, SpessaLog } from '../vendor/spessasynth.js';
import { normalizeSmpteTiming } from '../midi-timing.js';
import { midi, smptePanned, vlq } from './fixtures.mjs';

SpessaLog.setLogLevel(false, false, false);
const load = bytes => BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

test('SMPTE clocks keep exact long durations with minimal and maximal ticks per frame and no tempo event', () => {
  for (const code of [24, 25, 29, 30]) for (const ticksPerFrame of [1, 40, 255]) {
    const ticks = (code === 29 ? 30 : code) * ticksPerFrame * 3600;
    const bytes = midi([[0, 0x90, 60, 100], [...vlq(ticks), 0x80, 60, 0], [0, 255, 47, 0]], ((256 - code) << 8) | ticksPerFrame);
    const original = bytes.slice(), sequence = normalizeSmpteTiming(load(bytes));
    const seconds = code === 29 ? 3603.6 : 3600;
    assert.ok(Math.abs(sequence.duration - seconds) < 1e-9, `-${code}/${ticksPerFrame}: ${sequence.duration}`);
    assert.ok(Math.abs(sequence.midiTicksToSeconds(ticks) - seconds) < 1e-9);
    assert.equal(sequence.secondsToMIDITicks(seconds), ticks);
    assert.deepEqual(bytes, original, 'The source MIDI bytes must stay unchanged');
  }
});

test('SMPTE conversion preserves events and track metadata, is idempotent and also works in RMID', () => {
  const bytes = smptePanned(29), parsed = load(bytes);
  const voiceEvents = sequence => sequence.tracks.map(track => track.events.filter(event => event.statusByte >= 0x80)
    .map(event => [event.ticks, event.statusByte, [...event.data]]));
  const before = voiceEvents(parsed), normalized = normalizeSmpteTiming(parsed);
  assert.deepEqual(voiceEvents(normalized), before);
  const serialized = normalized.writeMIDI();
  assert.equal(normalizeSmpteTiming(normalized), normalized);
  assert.deepEqual(normalized.writeMIDI(), serialized);
  const riff = Buffer.alloc(20 + bytes.length + (bytes.length % 2));
  riff.write('RIFF'); riff.writeUInt32LE(riff.length - 8, 4); riff.write('RMIDdata', 8);
  riff.writeUInt32LE(bytes.length, 16); riff.set(bytes, 20);
  const wrapped = normalizeSmpteTiming(load(riff));
  assert.ok(Math.abs(wrapped.duration - 1.25125) < 1e-9);
  assert.deepEqual(voiceEvents(wrapped), before);
});

test('PPQN tempo changes and source events remain unchanged', () => {
  const bytes = midi([[0, 0x90, 60, 100], [...vlq(480), 255, 81, 3, 15, 66, 64],
    [...vlq(480), 0x80, 60, 0], [0, 255, 47, 0]]);
  const parsed = load(bytes), serialized = parsed.writeMIDI();
  assert.equal(normalizeSmpteTiming(parsed), parsed);
  assert.equal(parsed.duration, 1.5);
  assert.deepEqual(parsed.writeMIDI(), serialized);
});

test('invalid SMPTE frame codes and zero ticks per frame fail explicitly', () => {
  for (const division of [0xe628, 0xff28, 0x8028, 0xe700]) {
    const parsed = load(midi([[0, 0x90, 60, 100], [...vlq(100), 0x80, 60, 0], [0, 255, 47, 0]], division));
    assert.throws(() => normalizeSmpteTiming(parsed), /Invalid MIDI SMPTE time division/);
  }
});
