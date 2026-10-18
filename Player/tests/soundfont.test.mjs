import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { panned } from './fixtures.mjs';
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
