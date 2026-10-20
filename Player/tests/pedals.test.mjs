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
   assert.equal(a.stats.diagnostics.summary.partial,0,'Pedals and Note Off velocity are handled');
   while(a.stats.position<1.1)assert.deepEqual(a.read(128),b.read(128));
   for(const time of [.43,.8,.2]){await a.seek(time);await b.seek(time);assert.deepEqual(a.read(2048),b.read(2048));}
  }finally{a.close();b.close();}
 }
});


test('CC68 retunes overlapping notes without restarting the sample, volume or modulation envelopes',async()=>{
 const s=await synth();try{
  s.controllerChange(0,68,64);s.noteOn(0,60,100);render(s);
  const group=voices(s,60),before=group.map(v=>({cursor:v.wavetable.cursor,start:v.startTime,samples:v.volEnv.sampleTime,modAttack:v.modEnv.attackEnd,ratio:v.tuningRatio}));
  assert.ok(group.length);s.noteOn(0,72,20);
  assert.deepEqual(voices(s,72),group);
  group.forEach((v,i)=>{assert.equal(v.wavetable.cursor,before[i].cursor);assert.equal(v.startTime,before[i].start);assert.equal(v.volEnv.sampleTime,before[i].samples);assert.equal(v.modEnv.attackEnd,before[i].modAttack);assert.equal(v.velocity,100,'A legato overlap retains the original attack velocity');});
  render(s,1);group.forEach((v,i)=>{assert.ok(Math.abs(v.tuningRatio/before[i].ratio-2)<.002);assert.equal(v.volEnv.sampleTime,before[i].samples+128);});
  s.noteOff(0,60);render(s,1);assert.ok(group.every(v=>v.keyDown&&!v.isInRelease),'The earlier note-off must not release the new pitch');
  s.noteOff(0,72);render(s,1);assert.ok(group.every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('legato pairs repeated-key Note Offs and returns to the last key still held without reattack',async()=>{
 const s=await synth();try{
  s.controllerChange(0,68,127);s.noteOn(0,60,100);render(s);const group=voices(s,60);
  s.noteOn(0,64,90);s.noteOn(0,64,80);render(s,1);const time=group[0].volEnv.sampleTime;
  s.noteOff(0,64);assert.ok(group.every(v=>v.midiNote===64&&v.noteID===1&&v.keyDown));
  s.noteOff(0,64);assert.ok(group.every(v=>v.midiNote===60&&v.noteID===0&&v.keyDown));
  assert.equal(group[0].volEnv.sampleTime,time);s.noteOff(0,60);render(s,1);assert.ok(group.every(v=>v.isInRelease));
  assert.deepEqual(s.midiChannels[0].keyPresses,[]);
 }finally{s.stopAllChannels(true);}
});

test('releasing legato restores the underlying poly/mono allocation and reset clears the footswitch',async()=>{
 for(const poly of [true,false]){
  const s=await synth(),ch=s.midiChannels[0];try{
   s.controllerChange(0,poly?127:126,0);s.controllerChange(0,68,64);s.noteOn(0,60,100);render(s);s.noteOn(0,64,100);render(s,1);
   assert.equal(new Set(voices(s).filter(v=>v.keyDown).map(v=>v.midiNote)).size,1);
   assert.equal(ch.midiParameters.polyMode,poly,'CC68 overlays, rather than overwrites, the channel mode');
   s.controllerChange(0,68,63);s.noteOn(0,67,100);render(s,1);
   assert.equal(new Set(voices(s).filter(v=>v.keyDown).map(v=>v.midiNote)).size,poly?2:1);
   s.controllerChange(0,68,127);s.controllerChange(0,121,0);assert.equal(ch.midiControllers[68],0);assert.equal(ch.legatoState,null);assert.equal(ch.midiParameters.polyMode,poly);
  }finally{s.stopAllChannels(true);}
 }
});

test('legato starts a new attack after a gap and preserves the started timbre only while notes overlap',async()=>{
 const s=await synth();try{
  s.controllerChange(0,68,127);s.noteOn(0,60,100);render(s);const old=voices(s,60),sample=old[0].wavetable.sampleData;
  s.programChange(0,0);s.noteOn(0,67,100);assert.equal(voices(s,67)[0].wavetable.sampleData,sample);
  s.noteOff(0,60);s.noteOff(0,67);render(s,1);s.noteOn(0,72,100);const fresh=voices(s,72);
  assert.ok(fresh.length&&fresh.every(v=>v.volEnv.sampleTime===0&&v.wavetable.cursor===0));assert.notEqual(fresh[0].wavetable.sampleData,sample);
 }finally{s.stopAllChannels(true);}
});

test('enabling legato during a chord retains the most recent held key and does not replay old attacks',async()=>{
 const s=await synth();try{
  s.noteOn(0,60,100);render(s);s.noteOn(0,64,100);render(s);const recent=voices(s,64),time=recent[0].volEnv.sampleTime;
  s.controllerChange(0,68,127);render(s,1);
  assert.ok(voices(s,60).every(v=>v.isInRelease));assert.ok(recent.every(v=>v.keyDown&&!v.isInRelease));assert.equal(recent[0].volEnv.sampleTime,time+128);
  s.noteOff(0,64);assert.ok(recent.every(v=>v.midiNote===60&&v.keyDown));s.noteOff(0,60);render(s,1);assert.ok(recent.every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('legato portamento gets its own glide clock while the original envelopes continue',async()=>{
 const s=await synth();try{
  s.controllerChange(0,68,127);s.controllerChange(0,5,64);s.controllerChange(0,65,127);s.noteOn(0,60,100);render(s,100);
  const v=voices(s,60)[0],before=v.tuningRatio,start=v.startTime,samples=v.volEnv.sampleTime;
  s.noteOn(0,72,100);assert.equal(v.startTime,start);assert.equal(v.volEnv.sampleTime,samples);assert.ok(v.portamentoStartTime>start);
  render(s,1);assert.ok(v.tuningRatio/before<1.1,'The glide begins at the preceding pitch');
  render(s,Math.ceil(v.portamentoDuration*48000/128)+2);assert.ok(Math.abs(v.tuningRatio/before-2)<.002);assert.ok(v.volEnv.sampleTime>samples);
 }finally{s.stopAllChannels(true);}
});

test('legato audio equals a phase-continuous semitone tuning and exact seek on every DSP backend',async()=>{
 const prefix=[[0,0xc0,81],[0,0xb0,68,127],[0,0x90,69,100]];
 const source=midi([...prefix,[...vlq(480),0x90,68,20],[...vlq(240),0x80,69,64],[...vlq(240),0x80,68,64],end]);
 const reference=midi([...prefix,[...vlq(480),0xb0,101,0],[0,0xb0,100,1],[0,0xb0,6,0],[0,0xb0,38,0],[...vlq(480),0x80,69,64],end]);
 for(const dsp of ['js','wasm','wasm-simd']){
  const a=await createSoundFontPreview(source,bank,{effects:false,dsp}),b=await createSoundFontPreview(reference,bank,{effects:false,dsp});
  try{
   while(a.stats.position<1.15){const time=a.stats.position,x=a.read(128),y=b.read(128);assert.ok(x.every((channel,c)=>channel.every((n,i)=>n===y[c][i])),`PCM at ${time}s on ${dsp}`);}
   for(const time of [.65,.93,.1]){await a.seek(time);await b.seek(time);assert.deepEqual(a.read(2048),b.read(2048));}
   assert.ok(!a.stats.diagnostics.entries.some(e=>e.controller===68));
  }finally{a.close();b.close();}
 }
});


test('legato stays channel/port scoped and pedals preserve the logical captured-key identity',async()=>{
 const s=await synth();try{
  while(s.midiChannels.length<32)s.createMIDIChannel();s.programChange(16,81);
  s.controllerChange(0,68,127);s.noteOn(0,60,100);s.noteOn(16,60,100);render(s);const original=voices(s,60,0);
  s.controllerChange(0,66,127);s.noteOn(0,64,100);s.noteOn(16,64,100);render(s,1);
  assert.ok(original.every(v=>!v.isSostenuto),'A later legato key must not inherit capture from the previous key');
  assert.equal(new Set(voices(s,undefined,16).filter(v=>v.keyDown).map(v=>v.midiNote)).size,2);
  s.noteOff(0,64);assert.ok(original.every(v=>v.midiNote===60&&v.isSostenuto));
  s.noteOff(0,60);render(s,1);assert.ok(original.every(v=>v.isHeld&&!v.isInRelease));
  s.controllerChange(0,64,127);s.controllerChange(0,66,0);render(s,1);assert.ok(original.every(v=>v.isHeld&&!v.isInRelease));
  s.controllerChange(0,64,0);render(s,1);assert.ok(original.every(v=>v.isInRelease));
 }finally{s.stopAllChannels(true);}
});

test('fast mono retrigger retains owed Note Offs and All Notes Off makes progress on fast-release channels',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  s.setSystemParameter('monophonicRetrigger',true);s.noteOn(0,60,100);render(s);s.noteOn(0,60,100);render(s,1);
  s.noteOff(0,60);render(s,1);assert.ok(voices(s,60).some(v=>v.noteID===1&&v.keyDown&&!v.isInRelease));
  s.noteOff(0,60);render(s,20);assert.ok(voices(s,60).every(v=>v.isInRelease));
  s.stopAllChannels(true);s.setSystemParameter('blackMIDIMode',true);s.noteOn(0,60,100);s.noteOn(0,64,100);
  let calls=0;const off=ch.noteOff;ch.noteOff=(...args)=>{assert.ok(++calls<=2,'Each forced-release Note Off must advance the pending-ID counter');off(...args);};
  s.controllerChange(0,123,0);assert.equal(calls,2);assert.deepEqual(ch.keyPresses,[]);
 }finally{s.stopAllChannels(true);}
});
