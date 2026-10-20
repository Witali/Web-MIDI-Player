import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SpessaSynthProcessor, SpessaLog} from '../vendor/spessasynth.js';
import {BrowserSoundBank} from '../lazy-bank.js';
import {installVoiceDSP} from '../voice-dsp.js';
import {installGSEffects} from '../gs-effects.js';
import {installXGVariation} from '../xg-variation.js';
import {captureSynthCheckpoint} from '../synth-checkpoint.js';
import {midi} from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const fixture = midi([...Array.from({length: 4}, (_, ch) => [[0, 0xc0 + ch, 81],
  ...Array.from({length: 36}, (_, i) => [0, 0x90 + ch, 48 + i, 100])]).flat(), [0, 0x99, 42, 100], [0, 255, 47, 0]]);
const loader = new BrowserSoundBank(undefined, {fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url)))});
const prepared = await loader.load(fixture);
const xg = (a, b, c, ...data) => new Uint8Array([0x43, 0x10, 0x4c, a, b, c, ...data, 0xf7]);
async function synth(backend, batch, minimum = 0) {
  const s = new SpessaSynthProcessor(48000, {effectsEnabled: true, eventsEnabled: false, maxBufferSize: 128});
  s.onMissingPreset = (p, system) => prepared.bank.getPreset(p, system);
  s.soundBankManager.addSoundBank(prepared.bank, 'main'); await s.processorInitialized;
  installGSEffects(s); installXGVariation(s);
  s.setSystemParameter('autoAllocateVoices', true); s.setSystemParameter('blackMIDIMode', false);
  s.setSystemParameter('monophonicRetrigger', false);
  await installVoiceDSP(s, backend);
  s.synthCore.voiceDSP.batchEnabled = batch; s.synthCore.voiceDSP.batchMinimumVoices = minimum;
  return s;
}
function render(s, count) {
  const out = [new Float32Array(count + 7).fill(.123), new Float32Array(count + 7).fill(.123)];
  s.process(...out, 3, count);
  for (const row of out) { assert.equal(row[2], Math.fround(.123)); assert.equal(row[count + 3], Math.fround(.123)); }
  return out;
}
function state(s) {
  return s.synthCore.voices.map(v => [v.isActive, v.wavetable.cursor, v.volEnv.outputGain, v.volEnv.state,
    v.volEnv.sampleTime, v.filter.x1, v.filter.x2, v.filter.y1, v.filter.y2]);
}
function same(a, b, count, label = '') {
  assert.deepEqual(render(a, count), render(b, count), label);
  assert.deepEqual(state(a), state(b), label + ' voice states');
}

test('one C batch preserves mixed interpolation, original voice order, partial blocks and every XG capture', async () => {
  for (const backend of ['wasm', 'wasm-simd']) {
    const a = await synth(backend, true), b = await synth(backend, false);
    for (const s of [a, b]) {
      s.systemExclusive(xg(0, 0, 0x7e, 0));
      // Variation insertion on part 0; other parts feed the system buses.
      s.systemExclusive(xg(2, 1, 0x40, 6, 0)); s.systemExclusive(xg(2, 1, 0x5a, 0, 0));
      for (let ch = 0; ch < 4; ch++) {
        s.programChange(ch, 81); s.midiChannels[ch].setSystemParameter('interpolationType', ch % 3);
        s.controllerChange(ch, 91, 70); s.controllerChange(ch, 93, 50);
      }
      for (let i = 0; i < 181; i++) s.noteOn(i % 4, 48 + i % 36, 70 + i % 30);
    }
    for (const n of [1, 3, 127, 128, 37, 128]) {
      const before = a.synthCore.voiceDSP.batchStats;
      same(a, b, n, backend);
      const after = a.synthCore.voiceDSP.batchStats;
      assert.equal(after.calls - before.calls, 1);
      assert.equal(after.voices - before.voices, a.synthCore.voices.filter(v => v.isActive).length);
    }
    assert.ok(a.synthCore.voiceDSP.batchStats.capacity >= 362);
    assert.ok(a.synthCore.voiceDSP.batchStats.payloadCapacity >= 362);
    for (const s of [a, b]) {
      s.controllerChange(0, 69, 127); s.controllerChange(1, 64, 127);
      s.controllerChange(1, 123, 0); s.noteOff(0, 48, 96); s.controllerChange(2, 120, 0);
      s.systemExclusive(xg(2, 1, 0x5a, 1, 127));
    }
    for (let i = 0; i < 16; i++) same(a, b, 127);
    for (const s of [a, b]) { s.controllerChange(0, 69, 0); s.controllerChange(1, 64, 0); }
    for (let i = 0; i < 16; i++) same(a, b, 128);
    a.stopAllChannels(true); b.stopAllChannels(true);
  }
});

test('queued pointers and checkpoints survive later sample, command, payload and voice pool growth', async () => {
  for (const backend of ['wasm', 'wasm-simd']) {
    const a = await synth(backend, true), b = await synth(backend, false);
    for (const s of [a, b]) { for (let ch = 0; ch < 4; ch++) s.programChange(ch, 81); s.noteOn(0, 60, 100); }
    same(a, b, 127);
    const saved = [a, b].map(s => captureSynthCheckpoint(s, {}, {}));
    const previousMemory = a.synthCore.voiceDSP.memoryBuffer;
    const large = Float32Array.from({length: 1 << 20}, (_, i) => Math.sin(i * .03) * .5);
    let expected;
    for (let repeat = 0; repeat < 2; repeat++) {
      saved.forEach(s => s.restore());
      for (const s of [a, b]) {
        for (let i = 0; i < 350; i++) s.noteOn(i % 4, 48 + i % 36, 100);
        // A late voice grows memory after many commands have been prepared.
        const voice = s.synthCore.activeVoices.at(-1);
        voice.wavetable.sampleData = large; voice.wavetable.end = large.length;
        voice.wavetable.loopEnd = large.length; voice.wavetable.loopLength = large.length;
      }
      same(a, b, 128, backend + ' grow');
      const pcm = render(a, 37); assert.deepEqual(pcm, render(b, 37));
      if (expected) assert.deepEqual(pcm, expected); else expected = pcm;
      assert.ok(a.synthCore.voiceDSP.batchStats.capacity >= 702);
    }
    assert.notEqual(a.synthCore.voiceDSP.memoryBuffer, previousMemory);
    a.stopAllChannels(true); b.stopAllChannels(true);
  }
});

test('automatic sparse fallback switches to/from batches without losing filter history or last EOF audio', async () => {
  for (const backend of ['wasm', 'wasm-simd']) {
    const a = await synth(backend, true, 16), b = await synth(backend, false);
    for (const s of [a, b]) { for (let ch = 0; ch < 4; ch++) s.programChange(ch, 81); s.noteOn(0, 60, 100); s.noteOn(9, 42, 100); }
    same(a, b, 128); assert.equal(a.synthCore.voiceDSP.batchStats.calls, 0);
    for (const s of [a, b]) for (let i = 0; i < 20; i++) s.noteOn(1, 48 + i, 90);
    same(a, b, 128); assert.equal(a.synthCore.voiceDSP.batchStats.calls, 1);
    for (const s of [a, b]) s.controllerChange(1, 120, 0);
    for (let i = 0; i < 400; i++) same(a, b, 127);
    assert.equal(a.synthCore.activeVoices.filter(v => v.channel === 9).length, 0);
    a.stopAllChannels(true); b.stopAllChannels(true);
  }
});
