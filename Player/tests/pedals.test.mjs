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
const voices=(s,note,ch=0)=>s.synthCore.voices.filter(v=>v.isActive&&v.channel===ch&&(note===undefined||v.midiNote===note));
const render=(s,blocks=50)=>{const L=new Float32Array(128),R=new Float32Array(128);for(let i=0;i<blocks;i++){L.fill(0);R.fill(0);s.process(L,R);}return [L,R];};
const end=[0,255,47,0];

test('sostenuto captures only currently held keys on the rising edge and later notes release normally',async()=>{
 const s=await synth();try{
  s.noteOn(0,60,100);render(s);s.controllerChange(0,66,63);s.noteOff(0,60);render(s,1);
  assert.ok(voices(s,60).every(v=>v.isInRelease),'63 means pedal off');s.stopAllChannels(true);
  s.noteOn(0,60,100);render(s);s.controllerChange(0,66,64);s.noteOn(0,67,100);render(s);s.controllerChange(0,66,127);
  s.noteOff(0,60);s.noteOff(0,67);render(s,1);
  assert.ok(voices(s,60).length&&voices(s,60).every(v=>!v.isInRelease&&v.isHeld),'The originally held chord remains held');
  assert.ok(voices(s,67).length&&voices(s,67).every(v=>v.isInRelease),'Repeated ON must not capture a subsequently played note');
  s.controllerChange(0,66,63);render(s,1);assert.ok(voices(s,60).every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('repeated notes on the same key keep their own sostenuto membership and corresponding Note Offs',async()=>{
 const s=await synth();try{
  s.noteOn(0,60,100);render(s);s.controllerChange(0,66,127);s.noteOn(0,60,100);render(s);
  s.noteOff(0,60);s.noteOff(0,60);render(s,1);
  const first=voices(s,60).filter(v=>v.noteID===0),second=voices(s,60).filter(v=>v.noteID===1);
  assert.ok(first.length&&first.every(v=>v.isHeld&&!v.isInRelease));assert.ok(second.length&&second.every(v=>v.isInRelease));
  s.controllerChange(0,66,0);render(s,1);assert.ok(first.every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('sostenuto and sustain release independently, exclude pedal-only tails from capture, and respect All Notes/Sound Off',async()=>{
 const s=await synth();try{
  s.noteOn(0,60,100);render(s);s.controllerChange(0,64,127);s.noteOff(0,60);s.controllerChange(0,66,127);s.controllerChange(0,64,0);render(s,1);
  assert.ok(voices(s,60).every(v=>v.isInRelease),'Sostenuto must not capture an already released sustain-only voice');
  s.controllerChange(0,66,0);s.stopAllChannels(true);
  for(const firstUp of [64,66]){
   s.noteOn(0,60,100);render(s);s.controllerChange(0,66,127);s.controllerChange(0,64,127);s.controllerChange(0,123,0);render(s,1);
   assert.ok(voices(s,60).some(v=>v.isHeld&&!v.isInRelease));s.controllerChange(0,firstUp,0);render(s,1);
   assert.ok(voices(s,60).some(v=>v.isHeld&&!v.isInRelease),'The other pedal still holds the voice');
   s.controllerChange(0,firstUp===64?66:64,0);render(s,1);assert.ok(voices(s,60).every(v=>v.isInRelease));s.stopAllChannels(true);
  }
  s.noteOn(0,60,100);render(s);s.controllerChange(0,66,127);s.noteOff(0,60);s.controllerChange(0,121,0);render(s,1);assert.ok(voices(s,60).every(v=>v.isInRelease));
  s.stopAllChannels(true);s.noteOn(0,60,100);s.controllerChange(0,66,127);s.noteOff(0,60);s.controllerChange(0,120,0);assert.equal(voices(s).length,0);
 }finally{s.stopAllChannels(true);}
});

test('sostenuto is channel scoped, including newly created MIDI ports',async()=>{
 const s=await synth();try{
  while(s.midiChannels.length<32)s.createMIDIChannel();s.programChange(16,81);
  s.noteOn(0,60,100);s.noteOn(16,60,100);render(s);s.controllerChange(16,66,127);s.noteOff(0,60);s.noteOff(16,60);render(s,1);
  assert.ok(voices(s,60,0).every(v=>v.isInRelease));assert.ok(voices(s,60,16).some(v=>v.isHeld&&!v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('sostenuto PCM matches delayed Note Offs and exact seeks before/after pedal changes on all backends',async()=>{
 const prefix=[[0,0xc0,81],[0,0x90,60,100],[...vlq(120),0xb0,66,127],[...vlq(120),0x90,67,100]];
 const source=midi([...prefix,[...vlq(120),0x80,60,64],[...vlq(120),0x80,67,64],[...vlq(240),0xb0,66,0],[...vlq(240),255,47,0]]);
 const reference=midi([...prefix,[...vlq(240),0x80,67,64],[...vlq(240),0xb0,66,0],[0,0x80,60,64],[...vlq(240),255,47,0]]);
 for(const dsp of ['js','wasm','wasm-simd']){
  const a=await createSoundFontPreview(source,bank,{effects:false,dsp}),b=await createSoundFontPreview(reference,bank,{effects:false,dsp});
  try{
   assert.equal(a.stats.diagnostics.summary.partial,2,'Only Note Off velocity remains partial in this fixture');
   while(a.stats.position<1.1)assert.deepEqual(a.read(128),b.read(128));
   for(const time of [.43,.8,.2]){await a.seek(time);await b.seek(time);assert.deepEqual(a.read(2048),b.read(2048));}
  }finally{a.close();b.close();}
 }
});
