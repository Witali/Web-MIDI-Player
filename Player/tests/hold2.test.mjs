import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GeneratorTypes, SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { installVoiceDSP } from '../voice-dsp.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const bytes=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
async function synth(dsp='js',slow=false){
 const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false,maxBufferSize:128});s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;s.programChange(0,81);
 if(slow){const ch=s.midiChannels[0];for(const [gen,v] of [[GeneratorTypes.delayModEnv,-12000],[GeneratorTypes.attackVolEnv,1200],[GeneratorTypes.attackModEnv,1200],[GeneratorTypes.modEnvToPitch,1200]])ch.setGeneratorOverride(gen,v);}
 if(dsp!=='js')await installVoiceDSP(s,dsp);return s;
}
const voices=(s,note,ch=0)=>s.synthCore.voices.filter(v=>v.isActive&&v.channel===ch&&(note===undefined||v.midiNote===note));
function render(s,count=1){const L=new Float32Array(128),R=new Float32Array(128);for(let i=0;i<count;i++){L.fill(0);R.fill(0);s.process(L,R);}return [L,R];}

test('Hold 2 freezes both envelope clocks while samples and controllers continue; later notes are not captured',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){
  const s=await synth(dsp,true);try{
   s.noteOn(0,60,100);render(s,100);s.controllerChange(0,69,63);assert.ok(voices(s,60).every(v=>v.hold2FreezeTime===null));
   s.controllerChange(0,69,64);const group=voices(s,60),before=group.map(v=>({samples:v.volEnv.sampleTime,gain:v.volEnv.outputGain,mod:v.hold2ModValue,cursor:v.wavetable.cursor}));
   assert.ok(group.length);render(s,1);const pitch=group.map(v=>v.tuningRatio);render(s,99);
   group.forEach((v,i)=>assert.equal(v.tuningRatio,pitch[i],'The modulation envelope must stop changing audible pitch'));
   group.forEach((v,i)=>{assert.equal(v.volEnv.sampleTime,before[i].samples);assert.equal(v.volEnv.outputGain,before[i].gain);assert.equal(v.hold2ModValue,before[i].mod);assert.notEqual(v.wavetable.cursor,before[i].cursor);});
   s.noteOn(0,67,100);render(s,10);const later=voices(s,67),times=later.map(v=>v.volEnv.sampleTime);s.controllerChange(0,69,127);render(s,10);
   later.forEach((v,i)=>{assert.equal(v.hold2FreezeTime,null);assert.equal(v.volEnv.sampleTime,times[i]+1280);});
   s.controllerChange(0,7,0);render(s,2);group.forEach((v,i)=>{assert.equal(v.volEnv.sampleTime,before[i].samples);assert.ok(v.volEnv.outputGain<before[i].gain*1e-4);});
   s.controllerChange(0,7,100);render(s,2);group.forEach((v,i)=>assert.equal(v.volEnv.outputGain,before[i].gain));
   s.controllerChange(0,69,63);render(s,1);group.forEach((v,i)=>{assert.equal(v.hold2FreezeTime,null);assert.equal(v.volEnv.sampleTime,before[i].samples+128);assert.ok(v.volEnv.outputGain>before[i].gain);});
   render(s,10);assert.ok(group.some((v,i)=>v.tuningRatio!==pitch[i]),'The modulation envelope resumes after OFF');
  }finally{s.stopAllChannels(true);}
 }
});

test('Note Off during a frozen attack is recorded and enters release immediately when Hold 2 is lifted',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){
  const s=await synth(dsp,true);try{
   s.noteOn(0,60,100);render(s,50);s.controllerChange(0,69,127);const group=voices(s,60),time=group[0].volEnv.sampleTime;
   render(s,30);s.noteOff(0,60);render(s,100);
   assert.ok(group.every(v=>!v.keyDown&&!v.isInRelease&&v.volEnv.sampleTime===time));
   const now=s.currentTime;s.controllerChange(0,69,0);assert.ok(group.every(v=>v.releaseStartTime===now));render(s,1);
   assert.ok(group.every(v=>v.isInRelease&&v.volEnv.sampleTime===time+128));
  }finally{s.stopAllChannels(true);}
 }
});

test('an already releasing voice resumes its existing release instead of restarting or jumping past it',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){
  const s=await synth(dsp);try{
   s.noteOn(0,60,100);render(s,50);s.noteOff(0,60);render(s,3);s.controllerChange(0,69,127);
   const group=voices(s,60),before=group.map(v=>({gain:v.volEnv.outputGain,samples:v.volEnv.sampleTime,release:v.releaseStartTime})),start=s.currentTime;
   render(s,150);group.forEach((v,i)=>{assert.equal(v.volEnv.sampleTime,before[i].samples);assert.equal(v.volEnv.outputGain,before[i].gain);});
   const elapsed=s.currentTime-start;s.controllerChange(0,69,0);group.forEach((v,i)=>assert.equal(v.releaseStartTime,before[i].release+elapsed));render(s,1);
   group.forEach((v,i)=>{assert.ok(v.isInRelease);assert.equal(v.volEnv.sampleTime,before[i].samples+128);assert.ok(v.volEnv.outputGain<before[i].gain&&v.volEnv.outputGain>0);});
  }finally{s.stopAllChannels(true);}
 }
});

test('Hold 2 coexists with sustain/sostenuto, All Notes Off and CC121; CC120 and exclusive choke remain immediate',async()=>{
 const s=await synth();try{
  s.noteOn(0,60,100);render(s,40);s.controllerChange(0,66,127);s.controllerChange(0,64,127);s.controllerChange(0,69,127);s.controllerChange(0,123,0);render(s,20);
  const group=voices(s,60);assert.ok(group.every(v=>v.isHeld&&!v.isInRelease));s.controllerChange(0,69,0);render(s,1);assert.ok(group.every(v=>v.isHeld&&!v.isInRelease));
  s.controllerChange(0,69,127);s.controllerChange(0,121,0);render(s,1);assert.ok(group.every(v=>v.hold2FreezeTime===null&&v.isInRelease));
  s.stopAllChannels(true);s.noteOn(0,60,100);render(s,20);s.controllerChange(0,69,127);s.controllerChange(0,120,0);assert.equal(voices(s,60).length,0);
  s.noteOn(9,46,100);render(s,1);s.controllerChange(9,69,127);const open=voices(s,46,9);s.noteOn(9,42,100);render(s,1);assert.ok(open.every(v=>v.hold2FreezeTime===null&&(v.isInRelease||!v.isActive)));
 }finally{s.stopAllChannels(true);}
});

test('Hold 2 is channel/port scoped and repeated ON does not reset the frozen point',async()=>{
 const s=await synth();try{
  while(s.midiChannels.length<32)s.createMIDIChannel();s.programChange(16,81);s.noteOn(0,60,100);s.noteOn(16,60,100);render(s,20);
  s.controllerChange(16,69,127);const a=voices(s,60,0),b=voices(s,60,16),at=a[0].volEnv.sampleTime,bt=b[0].volEnv.sampleTime;
  render(s,20);s.controllerChange(16,69,64);render(s,20);assert.equal(a[0].volEnv.sampleTime,at+5120);assert.equal(b[0].volEnv.sampleTime,bt);
 }finally{s.stopAllChannels(true);}
});

test('actual frozen-envelope audio, dynamic volume and exact seeking agree on JS, scalar WASM and SIMD with effects',async()=>{
 const score=midi([[0,0xc0,81],[0,0xb0,73,100],[0,0xb0,72,0],[0,0x90,60,100],
  [...vlq(120),0xb0,69,127],[...vlq(120),0x80,60,64],[...vlq(120),0x90,67,90],
  [...vlq(120),0xb0,7,60],[...vlq(120),0x80,67,64],[...vlq(120),0xb0,7,100],
  [...vlq(240),0xb0,69,0],[...vlq(240),255,47,0]]);
 let reference;
 for(const dsp of ['js','wasm','wasm-simd']){
  const preview=await createSoundFontPreview(score,bank,{effects:true,dsp});try{
   const pcm=preview.read(96000);if(!reference)reference=pcm;else assert.deepEqual(pcm,reference);
   assert.ok(!preview.stats.diagnostics.entries.some(e=>e.controller===69));
   for(const time of [.15,.45,.85,1.03,.01]){await preview.seek(time);const start=Math.round(time*48000);assert.deepEqual(preview.read(1024),reference.map(c=>c.slice(start,start+1024)));}
  }finally{preview.close();}
 }
});
