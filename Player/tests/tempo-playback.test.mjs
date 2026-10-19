import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const data=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
// SMF 1.0 pp. 4-5: PPQN uses tempo (default 120 BPM) and format 1 tracks
// share that clock. The second/third phrases accelerate; the fourth slows.
// Explicit All Sound Off after each gate isolates timing from an instrument's
// legitimate release envelope; release-tail behavior has separate audio tests.
const score=midiTracks([
 [[0,255,81,3,7,161,32],[...vlq(480),255,81,3,3,208,144],[...vlq(960),255,81,3,15,66,64],[0,255,47,0]],
 [[0,0xc0,81],[0,0x90,60,110],[...vlq(240),0x80,60,0],[0,0xb0,120,0],
  [...vlq(240),0x90,64,110],[...vlq(240),0x80,64,0],[0,0xb0,120,0],
  [...vlq(240),0x90,67,110],[...vlq(240),0x80,67,0],[0,0xb0,120,0],
  [...vlq(240),0x90,72,110],[...vlq(240),0x80,72,0],[0,0xb0,120,0],[0,255,47,0]]
]);
const energy=samples=>samples.reduce((sum,n)=>sum+n*n,0);

test('actual PPQN audio accelerates 120 to 240 BPM, slows to 60 BPM and seeks on the tempo map',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']) {
  const preview=await createSoundFontPreview(score,bank,{effects:false,dsp});
  try {
   assert.equal(preview.stats.sourceDuration,1.5);
   const pcm=[new Float32Array(96000),new Float32Array(96000)];
   let at=0;
   while(at<96000){const channels=preview.read(Math.min(2048,96000-at));channels.forEach((c,i)=>pcm[i].set(c,at));at+=channels[0].length;}
   const measure=(from,to)=>pcm.reduce((sum,c)=>sum+energy(c.subarray(Math.round(from*48000),Math.round(to*48000))),0);
   for(const [from,to] of [[.05,.15],[.52,.58],[.78,.82],[1.07,1.15],[1.35,1.45]]) assert.ok(measure(from,to)>.001,'Missing note at '+from+' s, DSP '+dsp);
   for(const [from,to] of [[.4,.45],[.73,.745],[.98,.995],[1.75,1.85]]) assert.ok(measure(from,to)<1e-9,'Note timing did not follow tempo at '+from+' s, DSP '+dsp);
   for(const time of [.55,.8,1.15]){
    await preview.seek(time);const after=preview.read(2048),start=Math.round(time*48000);
    after.forEach((channel,c)=>assert.deepEqual(channel,pcm[c].subarray(start,start+2048),'Tempo-aware seek must match continuous PCM'));
   }
  }finally{preview.close();}
 }
});
