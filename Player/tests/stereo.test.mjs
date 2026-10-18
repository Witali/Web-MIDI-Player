import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as engine from '../engine/src/compiler.js';
import { panGains, createStereoPreview } from '../stereo-preview.js';
import { midi, panned, vlq } from './fixtures.mjs';
const json = name => JSON.parse(fs.readFileSync(new URL(`../engine/data/${name}`, import.meta.url)));
const bank = engine.prepareDrumBank(engine.prepareQualityBank(engine.prepareBank(json('bank.json')), json('quality-detailed-r2r.json')), json('drums-r2r.json'));
const players = json('players.json');
function open(bytes) {
  const score = engine.parseMidi(bytes), parts = score.parts.map(p => ({ ...p, sample: engine.suggestedSample(p.program, p), enabled: true, volume: 1 }));
  return createStereoPreview(engine, score, bank, players, { mode: 'r2r', quality: 'detailed', voices: 4, parts, releaseTails: true });
}
function render(bytes) {
  const preview = open(bytes), blocks = [[], []];
  try {
    while (preview.stats.position < preview.stats.duration) preview.read(4096).forEach((samples, i) => blocks[i].push(...samples));
    return blocks.map(samples => Float32Array.from(samples));
  } finally { preview.close(); }
}
const energy = (samples, begin = 0, end = samples.length) => samples.slice(begin, end).reduce((sum, n) => sum + n * n, 0);

test('equal-power pan has exact endpoints and a centered CC10=64', () => {
  assert.deepEqual(panGains(0), [1, 0]);
  assert.ok(panGains(127)[0] < 1e-15); assert.equal(panGains(127)[1], 1);
  assert.ok(Math.abs(panGains(64)[0] - panGains(64)[1]) < 1e-15);
  for (let pan = 0; pan < 128; pan++) assert.ok(Math.abs(panGains(pan).reduce((s, n) => s + n * n, 0) - 1) < 1e-14);
});
test('real WASM audio respects hard left, center, hard right and intermediate channel balance', () => {
  for (const pan of [0, 32, 64, 96, 127]) {
    const channels = render(panned(pan)), energies = channels.map(samples => energy(samples));
    assert.ok(Math.max(...energies) > 0.01);
    const expected = panGains(pan).map(n => n * n);
    const actual = energies[0] / (energies[0] + energies[1]);
    assert.ok(Math.abs(actual - expected[0]) < 1e-6, `pan=${pan}, ratio=${actual}`);
    assert.equal(channels[0].length, channels[1].length);
  }
});
test('CC10 changes move an already held note, including the release tail', () => {
  const channels = render(panned(0, true));
  assert.ok(energy(channels[0], 1000, 20000) > .01);
  assert.ok(energy(channels[1], 1000, 20000) < 1e-20);
  assert.ok(energy(channels[0], 28000, 45000) < 1e-7);
  assert.ok(energy(channels[1], 28000, 45000) > .01);
});
test('pan is channel scoped and applies to GM percussion', () => {
  const bytes = midi([[0, 0xb9, 10, 127], [0, 0x99, 38, 120], [...vlq(480), 0x89, 38, 0], [0, 255, 47, 0]]);
  const channels = render(bytes);
  assert.ok(energy(channels[0]) < 1e-20); assert.ok(energy(channels[1]) > .01);
  assert.equal(engine.parseMidi(panned()).notes[0].pan[0].value, 64);
});
test('SMPTE timing ignores tempo events and preserves real seconds', () => {
  const bytes = midi([[0, 255, 81, 3, 3, 208, 144], [0, 0x90, 60, 100], [...vlq(1000), 0x80, 60, 0], [0, 255, 47, 0]], 0xe728);
  assert.equal(engine.parseMidi(bytes).notes[0].end, 1);
});
test('reset and seek reconstruction reproduce both channels exactly', () => {
  const preview = open(panned(0, true));
  try {
    const first = preview.read(2048); preview.reset(); const repeated = preview.read(2048);
    assert.deepEqual(first, repeated);
    preview.read(4096); const later = preview.read(1000);
    preview.reset(); preview.read(2048); preview.read(4096);
    assert.deepEqual(preview.read(1000), later);
  } finally { preview.close(); }
});

test('the compact WASM preview mixes 1024 voices without a four-voice allocator', () => {
  const count = 1024;
  const bytes = midi([[0, 0xc0, 73], ...Array.from({ length: count }, () => [0, 0x90, 69, 20]),
    ...Array.from({ length: count }, (_, i) => [...vlq(i === 0 ? 960 : 0), 0x80, 69, 0]), [0, 255, 47, 0]]);
  const preview = open(bytes);
  try {
    assert.equal(preview.stats.notes, count); assert.equal(preview.stats.polyphony, count);
    assert.ok(preview.read(1024).every(samples => energy(samples) > .001));
  } finally { preview.close(); }
});
