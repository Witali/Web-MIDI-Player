import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const bytes=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
async function synth(){const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;s.programChange(0,81);return s;}
const active=(s,note,ch=0)=>s.synthCore.voices.filter(v=>v.isActive&&v.channel===ch&&v.midiNote===note);
const block=s=>{const L=new Float32Array(128),R=new Float32Array(128);s.process(L,R);return [L,R];};
const energy=a=>a.reduce((n,x)=>n+x*x,0);

test('Note Off and Note On zero release a short gate at dispatch without an added 30 ms minimum',async()=>{
 for(const zero of [false,true]){
  const s=await synth();try{
   s.noteOn(0,69,100);block(s);const voices=active(s,69),time=s.currentTime;assert.ok(time<.03&&voices.length);
   if(zero)s.noteOn(0,69,0);else s.noteOff(0,69);
   assert.ok(voices.every(v=>v.releaseStartTime===time),'The command timestamp must be retained');
   const pcm=block(s);assert.ok(voices.every(v=>v.isInRelease));assert.ok(energy(pcm[0])>0,'Release enters the envelope rather than hard-cutting PCM');
  }finally{s.stopAllChannels(true);}
 }
});

test('a newly closed hi-hat starts exclusive release of an earlier open hat without a 70 ms gate extension',async()=>{
 const s=await synth();try{
  s.noteOn(9,46,100);block(s);const open=active(s,46,9),time=s.currentTime;assert.ok(open.length&&open.some(v=>v.exclusiveClass>0));
  s.noteOn(9,42,100);assert.ok(open.every(v=>v.releaseStartTime===time));block(s);assert.ok(open.every(v=>v.isInRelease||!v.isActive));
 }finally{s.stopAllChannels(true);}
});

test('All Sound Off silences PCM without consuming future Note Off identities or altering pedals/controllers',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  s.noteOn(0,60,100);block(s);s.controllerChange(0,64,127);s.controllerChange(0,7,70);s.controllerChange(0,120,0);
  assert.equal(active(s,60).length,0);assert.equal(ch.midiControllers[64]>>7,127);assert.equal(ch.midiControllers[7]>>7,70);
  s.noteOn(0,60,100);block(s);s.noteOff(0,60);block(s);
  assert.ok(active(s,60).some(v=>v.noteID===1&&v.keyDown&&!v.isHeld),'An old Note Off must not release the subsequent press');
  s.noteOff(0,60);block(s);assert.ok(active(s,60).every(v=>v.isHeld&&!v.keyDown));
  s.controllerChange(0,64,0);block(s);assert.ok(active(s,60).every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('short-gate audio differs from a 30 ms held note and exact seeking preserves its real release on all DSP backends',async()=>{
 const score=ticks=>midi([[0,0xc0,81],[0,0xb0,72,0],[0,0x90,69,100],[...vlq(ticks),0x80,69,64],[...vlq(288-ticks),255,47,0]]);
 for(const dsp of ['js','wasm','wasm-simd']){
  const short=await createSoundFontPreview(score(6),bank,{effects:false,dsp}),long=await createSoundFontPreview(score(30),bank,{effects:false,dsp});
  try{
   const a=short.read(4800),b=long.read(4800),lo=Math.round(.018*48000),hi=Math.round(.025*48000);
   assert.ok(energy(a[0].subarray(lo,hi))<energy(b[0].subarray(lo,hi))*.7,'A short note must already be releasing before 30 ms');
   await short.seek(.015);const pcm=short.read(128);assert.deepEqual(pcm,a.map(c=>c.slice(720,848)));
  }finally{short.close();long.close();}
 }
});
