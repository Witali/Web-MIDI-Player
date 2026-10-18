import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { panned, smptePanned } from './fixtures.mjs';
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
test('fast seeking restores CC10 and retriggers a held note without rendering the prefix', async () => {
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
      const silence = [0, 0], left = [0, 0], right = [0, 0], released = [0, 0];
      while (preview.stats.position < 1.8) {
        const time = preview.stats.position, channels = preview.read(128);
        const window = time < .2 ? silence : time > .35 && time < .5 ? left :
          time > 1.1 && time < 1.2 ? right : time > 1.6 ? released : null;
        if (window) channels.forEach((samples, i) => window[i] += energy(samples));
      }
      assert.equal(silence[0] + silence[1], 0, 'Preserve the initial quarter-second silence');
      assert.ok(left[0] > .001 && left[0] > left[1] * 1000, JSON.stringify({ left }));
      assert.ok(right[1] > .001 && right[1] > right[0] * 1000, JSON.stringify({ right }));
      assert.ok(released[0] + released[1] < 1e-8, JSON.stringify({ released }));
      await preview.seek(.95 * factor);
      const held = [0, 0];
      for (let i = 0; i < 30; i++) preview.read(128).forEach((samples, j) => held[j] += energy(samples));
      assert.ok(held[1] > .001 && held[1] > held[0] * 1000, 'Seek must restore the held note and right pan');
      await preview.seek(.1);
      const beforeNote = preview.read(4096);
      assert.equal(energy(beforeNote[0]) + energy(beforeNote[1]), 0, 'Seek before the first note must stay silent');
    } finally { preview.close(); }
  });
});
