import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createLiveSynth} from '../live-synth.js';
import {BrowserSoundBank} from '../lazy-bank.js';
import {BasicSoundBank,BasicPreset,BasicInstrument,BasicSample,SampleTypes,GeneratorTypes,SpessaLog}from'../vendor/spessasynth.js';
SpessaLog.setLogLevel(false,false,false);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function bank(){
 const b=new BasicSoundBank(),sample=new BasicSample('live sine',48000,60,0,SampleTypes.monoSample,0,240);
 sample.setAudioData(Float32Array.from({length:240},(_,i)=>Math.sin(i/240*2*Math.PI)*.4),48000);b.addSamples(sample);
 const instrument=new BasicInstrument();instrument.name='Live';const zone=instrument.createZone(sample);zone.setGenerator(GeneratorTypes.sampleModes,1);zone.setGenerator(GeneratorTypes.releaseVolEnv,-2400);b.addInstruments(instrument);
 for(const drum of[false,true])for(const program of[0,73]){const preset=new BasicPreset(b);Object.assign(preset,{name:'Live',program,isGMGSDrum:drum});preset.createZone(instrument);b.addPresets(preset);}
 b.flush();return b;
}
const energy=pcm=>pcm.reduce((n,c)=>n+c.reduce((sum,v)=>sum+v*v,0),0);
const sequence=[[0xc0,73],[0xb0,10,20],[0x90,60,100],[0x90,64,120],[0xb0,64,127],[0xe0,0,66],[0xd0,30],[0xa0,60,42],[0x80,60,44],[0x90,64,0],[0xb0,64,0]];

test('live command FIFO waits for sample preparation and never overtakes Note On with Note Off',async()=>{
 const gate=deferred(),seen=[];let prepares=0;
 const live=await createLiveSynth(bank(),{effects:false,dsp:'js',prepare:async()=>{if(!prepares++)await gate.promise;}});
 const original=live.synth.processMessage.bind(live.synth);live.synth.processMessage=m=>{seen.push([...m]);return original(m);};
 const jobs=sequence.map(m=>live.send(m));await Promise.resolve();assert.deepEqual(seen,[]);assert.equal(energy(live.read(256)),0);
 gate.resolve();await Promise.all(jobs);assert.deepEqual(seen,sequence);live.close();
});
test('live synthesis preserves exact PCM across queued and synchronous handlers on each DSP',async()=>{
 for(const dsp of['js','wasm','wasm-simd']){
  const b=bank(),live=await createLiveSynth(b,{effects:false,dsp}),reference=await createLiveSynth(b,{effects:false,dsp});
  for(const messages of[sequence.slice(0,4),sequence.slice(4,8),sequence.slice(8)]){
   await Promise.all(messages.map(m=>live.send(m)));for(const message of messages)reference.synth.processMessage(Uint8Array.from(message));
   const actual=live.read(1536),expected=reference.read(1536);assert.deepEqual(actual,expected,dsp);assert.ok(actual.every(c=>c.every(Number.isFinite)));
  }
  live.panic();assert.equal(energy(live.read(256)),0);live.close();reference.close();
 }
});
test('live PCM is independent of read size and does not access past a synthesis quantum',async()=>{
 const b=bank(),a=await createLiveSynth(b,{effects:false,dsp:'wasm'}),c=await createLiveSynth(b,{effects:false,dsp:'wasm'});
 await a.send([0x90,60,100]);await c.send([0x90,60,100]);const whole=a.read(4096),chunks=[[],[]];
 let left=4096;for(const n of[1,127,259,3,1000,2706]){const take=Math.min(left,n);const part=c.read(take);part.forEach((p,i)=>chunks[i].push(...p));left-=take;}
 assert.equal(left,0);whole.forEach((p,i)=>assert.deepEqual([...p],chunks[i]));assert.ok(energy(whole)>0);a.close();c.close();
});
test('panic cancels pending sample preparation and clears voices without executing queued notes later',async()=>{
 const gate=deferred();let first=true;const live=await createLiveSynth(bank(),{effects:false,dsp:'js',prepare:async()=>{if(first){first=false;await gate.promise;}}});
 const pending=live.send([0x90,60,127]);await Promise.resolve();live.panic();const next=live.send([0xc0,73]);gate.resolve();await assert.rejects(pending,{name:'AbortError'});await next;assert.equal(live.stats.voices,0);
 await live.send([0x90,67,100]);assert.ok(energy(live.read(256))>0);live.close();assert.throws(()=>live.read(),/closed/);
});
test('sample failure is explicit and halts subsequent commands until an explicit panic/retry',async()=>{
 let fail=true;const seen=[];const live=await createLiveSynth(bank(),{effects:false,dsp:'js',prepare:async()=>{if(fail)throw new Error('network sample error');}});
 const original=live.synth.processMessage.bind(live.synth);live.synth.processMessage=m=>{seen.push([...m]);original(m);};
 const a=live.send([0x90,60,127]),b=live.send([0x80,60,0]);await assert.rejects(a,/network/);await assert.rejects(b,/network/);assert.deepEqual(seen,[]);assert.match(live.stats.failed,/network/);
 fail=false;live.panic();await live.send([0x90,60,127]);assert.equal(seen.length,1);live.close();
});
test('live browser bank loads separate selected-instrument recordings and reuses prepared regions',async()=>{
 const url=new URL('../soundfonts/fluidr3-gm/manifest.json',import.meta.url),requests=[];
 const loader=new BrowserSoundBank(url,{fetcher:async(url,{signal}={})=>{signal?.throwIfAborted();requests.push(String(url));return new Response(fs.readFileSync(url));}});
 const prepared=await loader.openLive();assert.equal(prepared.stats.samples,0);assert.equal(requests.length,2);
 const p=prepared.bank.getPreset({program:73,bankMSB:0,bankLSB:0,isGMGSDrum:false},'gs');await prepared.prepare([p]);
 assert.ok(prepared.stats.samples>0&&prepared.stats.samples<40);const count=requests.length;await prepared.prepare([p]);assert.equal(requests.length,count);
 for(const zone of p.zones)for(const region of zone.instrument.zones)assert.ok(region.sample.getAudioData().length);
 assert.throws(()=>prepared.bank.samples.find(s=>!p.zones.some(z=>z.instrument.zones.some(r=>r.sample===s))).getAudioData(),/not prepared/);
 assert.ok(!requests.some(p=>p.endsWith('.sf2')));assert.equal(new Set(requests).size,requests.length);
 const live=await createLiveSynth(prepared.bank,{effects:false,dsp:'wasm',prepare:prepared.prepare});await live.send([0xc0,73]);await live.send([0x90,69,110]);assert.ok(energy(live.read(1024))>0);live.close();
});

test('cold live input preserves timestamped gate intervals instead of collapsing a buffered Note On/Off',async()=>{
 const gate=deferred();let ready=false;const b=bank(),live=await createLiveSynth(b,{effects:false,dsp:'wasm',isPrepared:()=>ready,prepare:async()=>{await gate.promise;ready=true;}}),reference=await createLiveSynth(b,{effects:false,dsp:'wasm'});
 const seen=[],original=live.synth.processMessage.bind(live.synth);live.synth.processMessage=m=>{seen.push({raw:[...m],time:live.synth.synthCore.currentTime});original(m);};
 const start=live.send([0x90,60,100],{timestamp:100}),off=live.send([0x80,60,44],{timestamp:100+5120/48});
 live.read(12800);assert.equal(seen.length,0);gate.resolve();await start;assert.equal(seen.length,1);
 await reference.send([0x90,60,100]);assert.deepEqual(live.read(5120),reference.read(5120));assert.equal(seen.length,1);
 await reference.send([0x80,60,44]);assert.deepEqual(live.read(256),reference.read(256));await off;assert.equal(seen.length,2);assert.ok(Math.abs(seen[1].time-seen[0].time-5120/48000)<1e-9);
 // An idle stream reanchors to now; a cold-load delay is not permanent latency.
 await live.send([0x90,64,100],{timestamp:2000});assert.equal(seen.length,3);assert.equal(live.stats.queued,0);
 live.close();reference.close();
});
test('timestamped live bursts preserve equal-time command order and reject invalid times',async()=>{
 const live=await createLiveSynth(bank(),{effects:false,dsp:'js'}),seen=[],original=live.synth.processMessage.bind(live.synth);live.synth.processMessage=m=>{seen.push([...m]);original(m);};
 const gate=live.send([0x90,60,100],{timestamp:100});await gate;
 const a=live.send([0xb0,1,1],{timestamp:200});await a; // new idle burst anchors now
 const b=live.send([0xb0,1,2],{timestamp:300}),c=live.send([0xb0,1,3],{timestamp:300});
 // b is also the first arrival of an idle burst; c retains the same-time order.
 await Promise.all([b,c]);assert.deepEqual(seen.slice(-2),[[0xb0,1,2],[0xb0,1,3]]);
 assert.throws(()=>live.send([0xfe],{timestamp:NaN}),RangeError);assert.throws(()=>live.send([0xfe],{timestamp:-1}),RangeError);live.close();
});
