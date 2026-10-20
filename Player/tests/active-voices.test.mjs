import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import {fileURLToPath}from'node:url';
import {OrderedVoicePool}from'../active-voices.js';import {SpessaSynthProcessor,SpessaLog}from'../vendor/spessasynth.js';import {BrowserSoundBank}from'../lazy-bank.js';import {installVoiceDSP}from'../voice-dsp.js';import {installGSEffects}from'../gs-effects.js';import {installXGVariation}from'../xg-variation.js';import {captureSynthCheckpoint}from'../synth-checkpoint.js';import {midi,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const end=[0,255,47,0],fixture=midi([[0,0xc0,81],...Array.from({length:36},(_,i)=>[[0,0x90,48+i,100],[0,0x80,48+i,64]]).flat(),[0,0xc0,73],[0,0x90,60,100],[0,0x80,60,64],[0,0x99,42,100],[0,0x99,46,100],[120,0xb0,120,0],end]);
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(fixture);
const layers=prepared.bank.getPreset({bankMSB:0,bankLSB:0,program:81,isGMGSDrum:false},'gs').getVoiceParameters(60,100).length;
async function synth(dsp='js',scan=false){const s=new SpessaSynthProcessor(48000,{effectsEnabled:true,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,system)=>prepared.bank.getPreset(p,system);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installGSEffects(s);installXGVariation(s);s.setSystemParameter('autoAllocateVoices',true);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);for(let ch=0;ch<16;ch++)if(ch!==9)s.programChange(ch,81);
 if(scan){const core=s.synthCore;core.voicePool={get active(){return core.voices.slice(0,core.systemParameters.voiceCap);},dirty:false,add(v){v.poolIndex=core.voices.length-1;},prune(){},rebuild(){},clear(){},retire(v){v.isActive=false;},take(cap){for(let i=0;i<cap;i++)if(!core.voices[i].isActive)return core.voices[i];}};}
 if(dsp!=='js')await installVoiceDSP(s,dsp);return s;
}
const render=(s,n)=>{const out=[new Float32Array(n),new Float32Array(n)];for(let i=0;i<n;i+=128)s.process(...out,i,Math.min(128,n-i));return out;};
const same=(a,b,label='')=>{let max=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)max=Math.max(max,Math.abs(a[c][i]-b[c][i]));}assert.equal(max,0,label);};
const voiceState=s=>s.synthCore.voices.flatMap((v,i)=>v.isActive?[[i,v.channel,v.midiNote,v.noteID,v.keyDown,v.isHeld,v.isSostenuto,v.isInRelease]]:[]);
function invariant(core){const live=core.voices.filter(v=>v.isActive);assert.deepEqual(core.activeVoices.map(v=>v.poolIndex),live.map(v=>v.poolIndex));assert.equal(new Set(core.activeVoices).size,live.length);assert.equal(new Set(core.voicePool.free).size,core.voicePool.free.length);assert.equal(core.voicePool.free.length+live.length,core.voices.length);assert.ok(core.voicePool.free.every(i=>!core.voices[i].isActive));}

test('ordered active pool matches a linear first-free oracle through irregular holes, growth, pruning and cap boundaries',()=>{
 const voices=[],pool=new OrderedVoicePool(voices);for(let i=0;i<37;i++){const v={isActive:false};voices.push(v);pool.add(v);}let seed=0x12345678;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let step=0;step<4000;step++){const cap=1+random()%voices.length;if(random()%3){const index=voices.findIndex((v,i)=>i<cap&&!v.isActive),actual=pool.take(cap);assert.equal(actual,index<0?undefined:voices[index]);if(actual)actual.isActive=true;}else{const index=random()%voices.length;pool.retire(voices[index]);}
  if(step%7===0){pool.prune();assert.deepEqual(pool.active,voices.filter(v=>v.isActive));}
  if(step%131===0){const v={isActive:false};voices.push(v);pool.add(v);}
  if(step%193===0)pool.rebuild();
 }
 pool.prune();assert.deepEqual(pool.active,voices.filter(v=>v.isActive));for(const voice of voices)pool.retire(voice);pool.prune();assert.equal(pool.active.length,0);for(let i=0;i<voices.length;i++){const v=pool.take(voices.length);assert.equal(v,voices[i]);v.isActive=true;}
});

test('dense burst, immediate MIDI kills, sparse reuse and modulation preserve exact pool-order PCM against a full scan on every DSP',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp,true);for(const s of [a,b])for(let i=0;i<1024;i++)s.noteOn(i%4,48+i%36,70+i%30);same(render(a,2048),render(b,2048),dsp+' dense');assert.deepEqual(voiceState(a),voiceState(b));assert.ok(a.synthCore.voices.length>350);
  for(const s of [a,b]){s.controllerChange(0,120,0);s.controllerChange(2,120,0);for(let i=0;i<20;i++)s.noteOn(4,48+i%36,90);s.controllerChange(1,64,127);for(let i=0;i<256;i++)s.noteOff(1,48+(1+4*i)%36,23);s.controllerChange(1,64,0);}
  same(render(a,2048),render(b,2048),dsp+' holes');assert.deepEqual(voiceState(a),voiceState(b));invariant(a.synthCore);
  for(const s of [a,b]){s.stopAllChannels(true);s.noteOn(0,60,100);s.noteOn(1,67,90);for(const [cc,value]of [[1,80],[10,12],[11,65],[74,90],[66,127],[69,127]])s.controllerChange(0,cc,value);s.noteOff(0,60,110);}
  same(render(a,4096),render(b,4096),dsp+' sparse after burst');assert.equal(a.synthCore.activeVoices.length,layers*2);invariant(a.synthCore);for(const s of [a,b]){s.controllerChange(0,69,0);s.controllerChange(0,66,0);s.noteOff(1,67,90);}same(render(a,48000),render(b,48000),dsp+' release');invariant(a.synthCore);a.stopAllChannels(true);b.stopAllChannels(true);
 }
});

test('render, pedals and controller changes do not read inactive pooled voices after the first compaction',async()=>{
 const s=await synth();for(let i=0;i<2048;i++)s.noteOn(i%4,48+i%36,80);render(s,128);s.stopAllChannels(true);render(s,128);s.noteOn(0,60,100);render(s,128);const core=s.synthCore;invariant(core);assert.equal(core.activeVoices.length,layers);let inactiveReads=0;
 for(const v of core.voices)if(!v.isActive)Object.defineProperty(v,'isActive',{configurable:true,get(){inactiveReads++;return false;},set(value){assert.equal(value,false);}});
 render(s,4096);for(const [cc,value]of [[1,100],[74,40],[64,127],[66,127],[69,127],[69,0],[66,0],[64,0]])s.controllerChange(0,cc,value);s.polyPressure(0,60,100);s.channelPressure(0,100);s.noteOff(0,60,70);assert.equal(inactiveReads,0,'render and MIDI handlers must traverse the active subset');s.stopAllChannels(true);
});

test('sample EOF and silent release recycle slots, and auto growth reuses storage retained above a temporary cap',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp),core=s.synthCore;s.noteOn(9,42,100);render(s,48000);assert.equal(core.activeVoices.length,0);invariant(core);s.setSystemParameter('voiceCap',1);s.noteOn(0,60,100);s.noteOn(1,67,90);render(s,128);assert.equal(core.activeVoices.length,layers*2);assert.equal(core.systemParameters.voiceCap,layers*2);assert.equal(core.voices.length,350);assert.deepEqual(core.activeVoices.map(v=>v.poolIndex),Array.from({length:layers*2},(_,i)=>i));s.setSystemParameter('voiceCap',1);render(s,128);assert.equal(core.activeVoices.length,1);invariant(core);s.stopAllChannels(true);render(s,128);assert.equal(core.activeVoices.length,0);}
});

test('checkpoint rebuild retains original allocation/PCM after later pool and WASM growth, repeated restores and dirty kills',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp),core=s.synthCore;s.noteOn(0,60,100);render(s,1001);const saved=captureSynthCheckpoint(s,{},{});let expected;
  for(let repeat=0;repeat<3;repeat++){saved.restore();for(let i=0;i<700;i++)s.noteOn(i%4,48+i%36,90);s.controllerChange(2,120,0);s.noteOn(5,67,100);const pcm=render(s,4096);if(expected)same(pcm,expected,dsp+' growth restore');else expected=pcm;invariant(core);}
  s.stopAllChannels(true);const dirty=captureSynthCheckpoint(s,{},{});s.noteOn(0,60,100);render(s,128);dirty.restore();assert.equal(core.activeVoices.length,0);invariant(core);s.noteOn(0,60,100);assert.equal(core.activeVoices[0].poolIndex,0);s.stopAllChannels(true);
 }
});


test('explicit fixed-cap priority replacement preserves the old slot-order PCM policy',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp,true);for(const s of [a,b]){s.setSystemParameter('autoAllocateVoices',false);s.setSystemParameter('voiceCap',8);for(let i=0;i<20;i++)s.noteOn(i%4,48+i,70+i);}same(render(a,4096),render(b,4096),dsp+' initial capped replacement');for(const s of [a,b]){s.noteOff(0,48,64);s.noteOn(3,72,127);s.noteOn(2,67,90);}same(render(a,4096),render(b,4096),dsp+' priority replacement');assert.deepEqual(voiceState(a),voiceState(b));invariant(a.synthCore);a.stopAllChannels(true);b.stopAllChannels(true);}
});
