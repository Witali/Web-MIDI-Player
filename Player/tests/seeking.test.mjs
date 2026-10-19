import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const data = fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
function timed(events) {
  let previous = 0;
  return [...events.map(([tick, ...message]) => { const event = [...vlq(tick - previous), ...message]; previous = tick; return event; }), [0, 255, 47, 0]];
}
function fixture() {
  return midiTracks([
    timed([[0, 255, 81, 3, 15, 66, 64], [800, 255, 81, 3, 7, 161, 32]]),
    timed([[0, 255, 33, 1, 17], [0, 0xc0, 88], [0, 0xb0, 10, 0], [0, 0xb0, 91, 110], [0, 0xb0, 93, 60],
      [0, 0x90, 60, 100], [180, 0xb0, 64, 127], [250, 0xc0, 81], [300, 0x90, 67, 90],
      [400, 0x80, 60, 64], [450, 0x90, 67, 85], [500, 0xb0, 10, 127], [650, 0x80, 67, 0],
      [1000, 0x80, 67, 64], [1200, 0xb0, 64, 0], [1800, 0xb0, 1, 40]]),
    timed([[0, 255, 33, 1, 42], [0, 0xc0, 89], [0, 0xb0, 10, 96], [0, 0x90, 72, 100],
      [200, 0x99, 49, 100], [240, 0x89, 49, 64], [700, 0xc0, 0], [1100, 0x80, 72, 64]])
  ], 1000);
}
const energy = samples => samples.reduce((sum, n) => sum + n * n, 0);
const bytes = channels => channels.map(channel => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
function render(preview, frames, sizes = [2048]) {
  const output = [new Float32Array(frames), new Float32Array(frames)];
  let at = 0, block = 0;
  while (at < frames) {
    const pcm = preview.read(Math.min(sizes[block++ % sizes.length], frames - at));
    assert.ok(pcm[0].length, 'The fixture must still have audio headroom');
    pcm.forEach((channel, c) => output[c].set(channel, at)); at += pcm[0].length;
  }
  return output;
}

test('seek reproduces continuous presets, pedals, repeated notes, multi-port parts, percussion and effect tails', async () => {
  for (const effects of [false, true]) for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const reference = await createSoundFontPreview(fixture(), bank, { effects, dsp });
    const sought = await createSoundFontPreview(fixture(), bank, { effects, dsp });
    try {
      const continuous = render(reference, 4 * 48000);
      // Include forward/backward seeks, an unaligned sample, an active old
      // preset, pedal-held notes, drum decay and a position beyond MIDI data.
      for (const target of [12001, 42000, 85001, 6000, 120001]) {
        const result = await sought.seek(target / 48000);
        assert.equal(result.seconds, target / 48000);
        const actual = bytes(sought.read(3073));
        continuous.forEach((channel, c) => assert.deepEqual(actual[c], bytes([channel.subarray(target, target + 3073)])[0],
          'Seek must reproduce continuous PCM exactly: ' + JSON.stringify({ effects, dsp, target, channel: c })));
      }
      assert.ok(continuous.some(channel => energy(channel.subarray(120001, 123074)) > 1e-6), 'An actual tail must be tested');
    } finally { reference.close(); sought.close(); }
  }
});

test('consumer buffer boundaries cannot change synth phase, envelopes, controllers or effects', async () => {
  const previews = await Promise.all([0, 1].map(() => createSoundFontPreview(fixture(), bank, { effects: true })));
  try {
    const a = bytes(render(previews[0], 63001));
    const b = bytes(render(previews[1], 63001, [1, 127, 129, 2047, 17, 4096]));
    assert.deepEqual(b, a);
    await previews[1].reset();
    assert.deepEqual(bytes(render(previews[1], 63001, [43, 3001])), a);
  } finally { previews.forEach(preview => preview.close()); }
});

test('GS random pan is isolated per synth and restored by replay', async () => {
  const sysex = [0x41, 0x10, 0x42, 0x12, 0x40, 0x10, 0x1c, 0, 0x14, 0xf7];
  const source = midi([[0, 0xf0, sysex.length, ...sysex], [0, 0xc0, 81], [0, 0x90, 60, 100],
    [...vlq(240), 0x90, 67, 100], [...vlq(240), 0x80, 60, 64], [0, 0x80, 67, 64], [0, 255, 47, 0]]);
  const a = await createSoundFontPreview(source, bank, { effects: false });
  const b = await createSoundFontPreview(source, bank, { effects: false });
  try {
    const continuous = render(a, 36000);
    await b.seek(12001 / 48000);
    continuous.forEach((channel, c) => assert.deepEqual(bytes(b.read(0))[c], Buffer.alloc(0)));
    const actual = b.read(2048);
    continuous.forEach((channel, c) => assert.deepEqual(actual[c], channel.subarray(12001, 14049)));
    await b.seek(0); render(b, 12001);
    const replay = b.read(2048);
    replay.forEach((channel, c) => assert.deepEqual(channel, actual[c]));
  } finally { a.close(); b.close(); }
});

test('a cancelled reconstruction stops promptly and a subsequent seek remains exact', async () => {
  const preview = await createSoundFontPreview(fixture(), bank, { effects: true });
  try {
    let checks = 0;
    const result = await preview.seek(2.5, { isCurrent: () => ++checks < 4 });
    assert.equal(result.cancelled, true);
    assert.ok(preview.stats.position < 2.5);
    const expected = preview.read(1024);
    const at = preview.stats.position - 1024 / 48000;
    await preview.seek(0); await preview.seek(at);
    assert.deepEqual(preview.read(1024), expected);
    await assert.rejects(preview.seek(NaN), /finite/);
  } finally { preview.close(); }
});
