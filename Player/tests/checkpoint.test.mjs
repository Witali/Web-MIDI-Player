import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
const end = [0, 255, 47, 0];
const loader = () => new BrowserSoundBank(undefined, { fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url))) });
const score = midiTracks([
  [[0, 0xc0, 81], [0, 0x90, 60, 100], [60, 0xb0, 66, 127], [0, 0x90, 64, 90], [60, 0x80, 60, 23],
   [0, 0xb0, 64, 127], [0, 0xc0, 19], [0, 0x90, 67, 100], [60, 0xb0, 69, 127], [0, 0x80, 67, 70],
   [60, 0xb0, 69, 0], [0, 0xb0, 66, 0], [0, 0xb0, 64, 0], [0, 0x80, 64, 64],
   [0, 0xf0, 4, 0x7e, 0x7f, 9, 1], [120, 0xf7, 1, 0xf7], [0, 0xc0, 73], [0, 0x90, 72, 100], [120, 0x80, 72, 90], end],
  [[0, 0x99, 42, 100], [120, 0x99, 46, 100], [120, 0x89, 46, 64], end],
  [[0, 255, 33, 1, 7], [0, 0xc0, 81], [0, 0x90, 48, 100], [120, 0x80, 48, 64],
   [120, 0xb0, 68, 127], [0, 0x90, 60, 100], [60, 0x90, 64, 100], [60, 0x80, 64, 64], [0, 0x80, 60, 64], [0, 0xb0, 68, 0], end],
  [[0, 255, 33, 1, 9], [120, 0xb1, 7, 33], end]
]);

test('checkpoints restore exact PCM at arbitrary read positions, including pedals, ports, partial SysEx and wet tails on every DSP', async () => {
  const prepared = await loader().load(score);
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const p = await createSoundFontPreview(score, prepared.bank, { prepared, effects: true, dsp });
    try {
      for (const at of [1, 6001, 17001, 31001, 52801]) {
        await p.seek(at / 48000); const checkpoint = p.capture();
        const expected = p.read(12001);
        assert.ok(checkpoint.bytes > 10000 && checkpoint.bytes < 16 * 1024 * 1024);
        for (let repeat = 0; repeat < 3; repeat++) {
          checkpoint.restore(); assert.equal(p.stats.position, at / 48000);
          assert.deepEqual(p.read(12001), expected, dsp + ' at frame ' + at + ', repeat ' + repeat);
        }
      }
    } finally { p.close(); }
  }
});

test('a saved state survives later voice-pool and WASM memory growth without copying immutable sample PCM', async () => {
  const events = [[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(240), 0x80, 60, 64]];
  for (let program = 0; program < 128; program++) events.push([0, 0xc0, program], [0, 0x90, 48 + program % 36, 100]);
  for (let i = 0; i < 700; i++) events.push([0, 0x91, 48 + i % 36, 100]);
  events.push([...vlq(240), 0xb0, 123, 0], [0, 0xb1, 123, 0], end);
  const bytes = midi(events), prepared = await loader().load(bytes);
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const p = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: false, dsp });
    try {
      p.read(1001); const checkpoint = p.capture(), before = p.read(16000);
      checkpoint.restore(); assert.deepEqual(p.read(16000), before);
      checkpoint.restore(); assert.deepEqual(p.read(16000), before);
      const after = p.capture(); if (dsp !== 'js') assert.ok(after.memoryBytes > checkpoint.memoryBytes, 'the WASM arena must actually grow after A');
      assert.ok(after.bytes < 16 * 1024 * 1024, 'state size is independent of the complete PCM bank');
    } finally { p.close(); }
  }
});

test('checkpoint restores seeded random pan and remains usable after a reset/rebuild of the current preview', async () => {
  const sysex = [0x41, 0x10, 0x42, 0x12, 0x40, 0x11, 0x1c, 0, 0x13, 0xf7];
  const bytes = midi([[0, 0xf0, sysex.length, ...sysex], [0, 0xc0, 81], [0, 0x90, 60, 100],
    [60, 0x80, 60, 64], [60, 0x90, 67, 100], [60, 0x80, 67, 64], end]);
  const prepared = await loader().load(bytes), p = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: true, dsp: 'wasm' });
  try {
    p.read(1001); const checkpoint = p.capture(), expected = p.read(24000);
    await p.reset(); p.read(6000); checkpoint.restore(); assert.deepEqual(p.read(24000), expected);
  } finally { p.close(); }
});
