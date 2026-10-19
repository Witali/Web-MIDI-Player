import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, vlq, panned, smptePanned } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const bytes = fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const energy = samples => samples.reduce((sum, n) => sum + n * n, 0);

test('the freely redistributable bank contains and renders every GM instrument and standard drum', async () => {
  const melodic = bank.presets.filter(p => !p.isGMGSDrum && p.bankMSB === 0 && p.bankLSB === 0);
  assert.deepEqual(melodic.map(p => p.program).sort((a,b) => a-b), Array.from({length:128},(_,i)=>i));
  const synth = new SpessaSynthProcessor(48000, { effectsEnabled: false, eventsEnabled: false });
  synth.soundBankManager.addSoundBank(bank, 'main'); await synth.processorInitialized;
  const left = new Float32Array(128), right = new Float32Array(128);
  const render = () => { let total = 0; for (let i=0;i<80;i++) { synth.process(left,right); total += energy(left)+energy(right); } return total; };
  for (let program=0;program<128;program++) {
    synth.stopAllChannels(true); synth.programChange(0,program); synth.noteOn(0,60,110);
    assert.ok(render()>1e-9, `Silent GM program ${program+1}`);
  }
  for (let key=35;key<=81;key++) {
    synth.stopAllChannels(true); synth.noteOn(9,key,110); assert.ok(render()>1e-9, `Silent GM drum ${key}`);
  }
  synth.stopAllChannels(true);
});
test('SoundFont playback preserves stereo pan and its changes during a held note', async () => {
  // Use a mono source patch here: stereo patches intentionally keep their
  // intrinsic SoundFont image, independently of channel CC10 and wet effects.
  const bytes = panned(0,true); bytes[28] = 81;
  const preview = await createSoundFontPreview(bytes, bank, {effects:false});
  try {
    let before=[0,0], after=[0,0];
    while(preview.stats.position<.95) {
      const time=preview.stats.position,channels=preview.read(128);
      if(time>.15&&time<.4)before=before.map((n,i)=>n+energy(channels[i]));
      if(time>.8&&time<.95)after=after.map((n,i)=>n+energy(channels[i]));
    }
    assert.ok(before[0]>before[1]*1000, JSON.stringify(before));
    assert.ok(after[1]>after[0]*1000, JSON.stringify(after));
    assert.equal(preview.stats.channels,2);
    await preview.reset(); assert.equal(preview.stats.position,0);
  } finally { preview.close(); }
});
test('exact seeking restores CC10 and preserves a held note', async () => {
  const bytes = panned(0,true); bytes[28] = 81;
  const preview = await createSoundFontPreview(bytes,bank,{effects:false});
  try {
    const result=await preview.seek(.75); assert.equal(result.seconds,.75);
    const sum=[0,0]; for(let i=0;i<30;i++)preview.read(128).forEach((c,j)=>sum[j]+=energy(c));
    assert.ok(sum[1]>sum[0]*1000,JSON.stringify(sum));
    assert.ok(sum[1]>.001,'A held note must still sound after seeking');
    await preview.seek(.25); const before=preview.read(4096); assert.ok(energy(before[0])>energy(before[1])*1000);
  }finally{preview.close();}
});

test('SMPTE SoundFont playback keeps absolute note and pan times despite tempo changes', async t => {
  for (const frameCode of [24, 25, 29, 30]) await t.test(`frame code -${frameCode}`, async () => {
    const factor = frameCode === 29 ? 1.001 : 1;
    const preview = await createSoundFontPreview(smptePanned(frameCode), bank, { effects: false });
    try {
      assert.ok(Math.abs(preview.stats.sourceDuration - 1.25 * factor) < 1e-9, `Wrong duration: ${preview.stats.sourceDuration}`);
      const silence = [0, 0], left = [0, 0], right = [0, 0], released = [0, 0], continuous = [[], []];
      while (preview.stats.position < 1.8) {
        const time = preview.stats.position, channels = preview.read(128);
        channels.forEach((samples, c) => continuous[c].push(...samples));
        const window = time < .2 ? silence : time > .35 && time < .5 ? left :
          time > 1.1 && time < 1.2 ? right : time > 1.6 ? released : null;
        if (window) channels.forEach((samples, i) => window[i] += energy(samples));
      }
      assert.equal(silence[0] + silence[1], 0, 'Preserve the initial quarter-second silence');
      assert.ok(left[0] > .001 && left[0] > left[1] * 1000, JSON.stringify({ left }));
      assert.ok(right[1] > .001 && right[1] > right[0] * 1000, JSON.stringify({ right }));
      assert.ok(released[0] + released[1] < 1e-8, JSON.stringify({ released }));
      await preview.seek(.95 * factor);
      const held = preview.read(3840), start = Math.round(.95 * factor * 48000);
      held.forEach((samples, c) => assert.deepEqual(samples, Float32Array.from(continuous[c].slice(start, start + 3840)), 'Seek must preserve the actual phase and pan smoothing'));
      assert.ok(energy(held[1]) > .001 && energy(held[1]) > energy(held[0]), 'The held note must remain panned right');
      await preview.seek(.1);
      const beforeNote = preview.read(4096);
      assert.equal(energy(beforeNote[0]) + energy(beforeNote[1]), 0, 'Seek before the first note must stay silent');
    } finally { preview.close(); }
  });
});

function timedScore(events, program = 81) {
  let previous = 0;
  return midi([[0, 255, 81, 3, 15, 66, 64], [0, 0xc0, program], ...events.map(([time, ...message]) => {
    const event = [...vlq(time - previous), ...message]; previous = time; return event;
  }), [0, 255, 47, 0]], 1000);
}

function renderUntil(preview, seconds) {
  while (preview.stats.position < seconds) preview.read(128);
}

test('dense polyphony grows beyond the initial voice pool and survives a seek with 1024 held notes', async () => {
  const count = 1024;
  const events = [...Array.from({ length: count }, () => [0, 0x90, 69, 16]),
    ...Array.from({ length: count }, () => [1000, 0x80, 69, 0])];
  const single = await createSoundFontPreview(timedScore([[0, 0x90, 69, 16], [1000, 0x80, 69, 0]]), bank, { effects: false });
  const dense = await createSoundFontPreview(timedScore(events), bank, { effects: false });
  try {
    const one = single.read(4096).reduce((sum, samples) => sum + energy(samples), 0);
    const many = dense.read(4096).reduce((sum, samples) => sum + energy(samples), 0);
    assert.ok(Math.abs(Math.sqrt(many / one) - count) < .05, `Expected ${count} complete notes, got ${Math.sqrt(many / one)}`);
    await dense.seek(.25);
    const after = dense.read(4096).reduce((sum, samples) => sum + energy(samples), 0);
    assert.ok(after > one * count * count * .5, 'The held notes must survive seeking beyond 512 notes on one channel');
  } finally { single.close(); dense.close(); }
});

test('a repeated note mixes with the previous release envelope instead of cutting its tail', async () => {
  const first = [[0, 0x90, 60, 100], [250, 0x80, 60, 0]];
  const second = [[350, 0x90, 60, 100], [450, 0x80, 60, 0]];
  const previews = await Promise.all([first, second, [...first, ...second]].map(events =>
    createSoundFontPreview(timedScore(events, 0), bank, { effects: false })));
  try {
    const channels = previews.map(preview => { const pcm = [[], []]; while (preview.stats.position < .65) {
      preview.read(128).forEach((samples, i) => pcm[i].push(...samples));
    } return pcm; });
    for (let c = 0; c < 2; c++) {
      let residual = 0, tailEnergy = 0;
      for (let i = Math.ceil(.37 * 48000); i < Math.floor(.43 * 48000); i++) {
        const tail = channels[0][c][i], next = channels[1][c][i], mixed = channels[2][c][i];
        tailEnergy += tail * tail; residual += (mixed - tail - next) ** 2;
      }
      assert.ok(tailEnergy > .001, 'The piano release must still be audible when the new note starts');
      assert.ok(residual < tailEnergy * 1e-7, `Release tail lost: ${residual}/${tailEnergy}`);
    }
  } finally { previews.forEach(preview => preview.close()); }
});

test('MIDI Note Off and All Notes Off respect sustain; pedal release starts the release envelope', async () => {
  const preview = await createSoundFontPreview(timedScore([[0, 0x90, 69, 100], [100, 0xb0, 64, 127],
    [200, 0x80, 69, 0], [300, 0xb0, 123, 0], [1000, 0xb0, 64, 0]]), bank, { effects: false });
  try {
    renderUntil(preview, .7);
    assert.ok(preview.read(2048).some(samples => energy(samples) > .001), 'The pedal must hold a released note');
    renderUntil(preview, 1.05);
    assert.ok(preview.read(128).some(samples => energy(samples) > 1e-8), 'Pedal release must allow the instrument release tail');
    renderUntil(preview, 1.5);
    assert.ok(preview.read(2048).every(samples => energy(samples) < 1e-12), 'The note must end after pedal release');
  } finally { preview.close(); }
});

test('MIDI All Sound Off silences sounding and sustained notes', async () => {
  const preview = await createSoundFontPreview(timedScore([[0, 0x90, 69, 100], [100, 0xb0, 64, 127],
    [200, 0x80, 69, 0], [500, 0xb0, 120, 0]]), bank, { effects: false });
  try {
    renderUntil(preview, .3); assert.ok(preview.read(2048).some(samples => energy(samples) > .001));
    renderUntil(preview, .65); assert.ok(preview.read(2048).every(samples => energy(samples) < 1e-12));
  } finally { preview.close(); }
});

test('SoundFont instruments retain their own attack and release envelopes', async () => {
  const events = [[0, 0x90, 69, 100], [1000, 0x80, 69, 0]];
  const pad = await createSoundFontPreview(timedScore(events, 89), bank, { effects: false });
  const lead = await createSoundFontPreview(timedScore(events, 81), bank, { effects: false });
  try {
    const measure = preview => {
      const windows = [0, 0, 0, 0];
      while (preview.stats.position < 1.6) {
        const time = preview.stats.position, pcm = preview.read(128);
        const index = time > .02 && time < .08 ? 0 : time > .65 && time < .71 ? 1 :
          time > 1.05 && time < 1.11 ? 2 : time > 1.5 && time < 1.56 ? 3 : -1;
        if (index >= 0) windows[index] += pcm.reduce((sum, samples) => sum + energy(samples), 0);
      }
      return windows;
    };
    const slow = measure(pad), fast = measure(lead);
    assert.ok(slow[1] > slow[0] * 10, `The warm pad must keep its slow attack: ${slow}`);
    assert.ok(slow[2] > slow[3] && slow[3] > 1e-8, `The warm pad must retain a decaying release: ${slow}`);
    assert.ok(fast[0] > .001 && fast[3] < 1e-12, `The lead must retain its fast attack and shorter release: ${fast}`);
  } finally { pad.close(); lead.close(); }
});

test('WASM and SIMD match reference audio across all 128 GM programs, drums, pan and effects', async () => {
  const events = [];
  for (let program = 0; program < 128; program++) {
    const at = program * 80, key = 48 + program % 36;
    events.push([at, 0xc0, program], [at, 0xb0, 10, program * 13 % 128],
      [at, 0xb0, 91, 64], [at, 0xb0, 93, 48], [at, 0x90, key, 80], [at + 40, 0x80, key, 0]);
  }
  for (let key = 35; key <= 81; key++) {
    const at = 10240 + (key - 35) * 40;
    events.push([at, 0xb9, 10, key * 13 % 128], [at, 0x99, key, 100], [at + 20, 0x89, key, 0]);
  }
  const source = timedScore(events);
  for (const effects of [false, true]) {
    const previews = await Promise.all(['js', 'wasm', 'wasm-simd'].map(dsp => createSoundFontPreview(source, bank, { effects, dsp })));
    try {
      assert.deepEqual(previews.map(p => p.stats.dsp), ['js', 'wasm', 'wasm-simd']);
      while (previews[0].stats.position < previews[0].stats.duration) {
        const audio = previews.map(p => p.read(2047)); // Exercise odd final quanta.
        for (let backend = 1; backend < 3; backend++) for (let channel = 0; channel < 2; channel++) {
          assert.deepEqual(audio[backend][channel], audio[0][channel],
            `PCM differs: effects=${effects}, DSP=${previews[backend].stats.dsp}, channel=${channel}, time=${previews[0].stats.position}`);
        }
      }
    } finally { previews.forEach(p => p.close()); }
  }
});

test('automatic DSP falls back to JavaScript when WebAssembly is unavailable', async () => {
  const original = WebAssembly.instantiate;
  WebAssembly.instantiate = async () => { throw new Error('Simulated unavailable WASM'); };
  let preview;
  try {
    preview = await createSoundFontPreview(panned(), bank, { effects: false });
    assert.equal(preview.stats.dsp, 'js'); assert.ok(preview.stats.warnings.some(message => message.includes('using JavaScript')));
    assert.ok(preview.read(4096).some(samples => energy(samples) > .001));
    await assert.rejects(createSoundFontPreview(panned(), bank, { dsp: 'wasm' }), /Simulated unavailable WASM/);
  } finally { WebAssembly.instantiate = original; preview?.close(); }
});

test('long instrument releases and reverb extend playback beyond the initial two-second tail', async () => {
  const preview = await createSoundFontPreview(timedScore([[0, 0x90, 69, 110],
    [1000, 0x80, 69, 0]], 88), bank, { effects: true, dsp: 'wasm-simd' });
  try {
    let lastPeak = 0, audibleAfterInitialEnd = false;
    while (preview.stats.position < preview.stats.duration) {
      const time = preview.stats.position, channels = preview.read(128);
      lastPeak = Math.max(...channels.map(samples => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)));
      if (time > 3.05 && lastPeak > 1e-6) audibleAfterInitialEnd = true;
      assert.ok(preview.stats.position < 30, 'A released note must finish naturally');
    }
    assert.ok(audibleAfterInitialEnd, 'The real release must remain audible after source duration + 2 seconds');
    assert.ok(lastPeak < 1e-6, `The ending must be quiet, not cut at peak ${lastPeak}`);
    assert.ok(preview.stats.duration > 3);
    assert.equal(preview.read(128)[0].length, 0);
  } finally { preview.close(); }
});
