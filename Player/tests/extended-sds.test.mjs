import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Worker,MessageChannel} from 'node:worker_threads';
import {once} from 'node:events';
import {SampleDumpReceiver} from '../sample-dump.js';
import {processSampleDump} from '../sample-dump-oscillator.js';
import {createSampleDumpBank,installSampleDumpBank,normalizeSampleDumpMappings} from '../sample-dump-bank.js';
import {SpessaSynthProcessor,SpessaLog,BasicSoundBank,BasicSample,BasicInstrument,BasicPreset,GeneratorTypes,SampleTypes} from '../vendor/spessasynth.js';
import {BrowserSoundBank} from '../lazy-bank.js';
import {createSoundFontPreview} from '../soundfont-preview.js';
import {captureSynthCheckpoint} from '../synth-checkpoint.js';
import {installVoiceDSP} from '../voice-dsp.js';
import {midi,midiTracks,vlq} from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
// Independent CA-019 encoder; BigInt preserves all five 7-bit count bytes.
const le=(value,count)=>Array.from({length:count},(_,i)=>Number(BigInt(value)>>BigInt(i*7)&127n));
const header=({sample=1,bits=16,rate=48000,fraction=0,length=256,start=0,end=0,type=127,channels=1,device=127}={})=>Uint8Array.from([126,device,5,5,...le(sample,2),bits,...le(rate,4),...le(fraction,4),...le(length,5),...le(start,5),...le(end,5),type,channels,247]);
const loop=(type,start,end,{sample=1,number=0,device=127}={})=>Uint8Array.from([126,device,5,6,...le(sample,2),...le(number,2),type,...le(start,5),...le(end,5),247]);
const name=(text,{sample=1,tag=[],device=127}={})=>Uint8Array.from([126,device,5,3,...le(sample,2),tag.length,...tag,text.length,...Array.from(text,c=>c.charCodeAt(0)),247]);
function packets(words,bits=16,device=127){const width=Math.ceil(bits/7),per=120/width,result=[];for(let at=0;at<words.length;at+=per){const payload=Array(120).fill(0);for(let i=0;i<Math.min(per,words.length-at);i++){const left=BigInt(words[at+i])<<BigInt(width*7-bits);for(let j=0;j<width;j++)payload[i*width+j]=Number(left>>BigInt(7*(width-1-j))&127n);}const d=[126,device,2,at/per%128,...payload];result.push(Uint8Array.from([...d,d.reduce((a,b)=>a^b,0),247]));}return result;}
const received=(maxBytes)=>{const errors=[],replies=[],r=new SampleDumpReceiver({maxBytes,onReply:bytes=>replies.push([...bytes])}),log={gmInfo(){},unsupported:(_,data,reason)=>errors.push(reason)};return {r,errors,replies,send:(bytes,port=0)=>r.receive(bytes,port,log)};};
const types=[0,1,2,3,64,65,66,67,126,127];
const mapping={sample:1,rootKey:60,program:81,loopEnd:'exclusive'},mappings=normalizeSampleDumpMappings([mapping]);
const event=(data,ticks=0)=>[...vlq(ticks),240,...vlq(data.length),...data],eot=[0,255,47,0],setup=[[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0]];
const left=Array.from({length:256},(_,i)=>Math.round(32768+22000*Math.sin(i*Math.PI/16))),right=Array.from({length:256},(_,i)=>Math.round(32768+14000*Math.cos(i*Math.PI/11))),stereo=left.flatMap((v,i)=>[v,right[i]]);
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),plain=midi([...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],eot]),prepared=await loader.load(plain);
async function synth(dsp='js',settings=mappings,interpolation=2){const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,sys)=>prepared.bank.getPreset(p,sys);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installSampleDumpBank(s,settings);s.programChange(0,81);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);s.setSystemParameter('interpolationType',interpolation);if(dsp!=='js')await installVoiceDSP(s,dsp);return s;}
const render=(s,frames)=>{const out=[new Float32Array(frames),new Float32Array(frames)];for(let i=0;i<frames;i+=128)s.process(...out,i,Math.min(128,frames-i));return out;};
const same=(a,b,label='')=>{assert.equal(a.length,b.length);for(let c=0;c<a.length;c++)assert.deepEqual(a[c],b[c],label);};
const energy=pcm=>pcm.reduce((s,row)=>s+row.reduce((a,v)=>a+v*v,0),0);
function dump(s,words=stereo,options={}){s.systemExclusive(header({length:words.length/(options.channels??2),channels:2,type:3,start:20,end:150,...options}));for(const p of packets(words,options.bits??16,options.device??127))s.systemExclusive(p);}

test('CA-019 header preserves all rate/count bits, interleaves channels across packet boundaries and shares rate-independent PCM',()=>{
 for(let bits=8;bits<=28;bits++){const x=received(),words=Array.from({length:129},(_,i)=>Number(BigInt(i)*713173n%((1n<<BigInt(bits))-1n)));x.send(header({bits,length:43,channels:3,rate:0,fraction:1}));for(const p of packets(words,bits))x.send(p);const row=x.r.samples.get('0:127:1');assert.deepEqual([...row.words],words);assert.equal(row.length,43);assert.equal(row.wordLength,129);assert.equal(row.sampleRate,2**-28);assert.equal(row.rateInteger,0);assert.equal(row.rateFraction,1);for(let c=0;c<3;c++)assert.deepEqual([...row.channelData[c]],words.filter((_,i)=>i%3===c).map(v=>Math.fround((v-2**(bits-1))/2**(bits-1))));
 x.send(header({bits,length:43,channels:3,rate:2**28-1,fraction:2**28-1}));for(const p of packets(words,bits))x.send(p);const again=x.r.samples.get('0:127:1');assert.equal(again.words,row.words);assert.equal(again.pcm,row.pcm);assert.equal(again.channelData,row.channelData);assert.equal(x.r.resources.cache.size,1);assert.equal(x.r.usedBytes,129*12);assert.equal(again.rateInteger,268435455);assert.equal(again.rateFraction,268435455);assert.equal(x.errors.length,0);}
});

test('35-bit lengths/loops are never truncated; bad rates/channels/types and oversized replacement headers are atomic',()=>{
 const x=received(1024);x.send(header({length:1}));x.send(packets([40000])[0]);const prior=x.r.samples.get('0:127:1');x.send(header({length:80}));const current=x.r.sessions.get('0:127');
 for(const options of [{rate:0,fraction:0},{channels:0},{bits:29},{type:4},{length:10,type:0,end:10},{length:2**32+3},{length:2**35-1,channels:127},{length:12,type:0,start:2**32+1,end:2**32+2}]){const errors=x.errors.length;x.send(header(options));assert.equal(x.errors.length,errors+1);assert.equal(x.r.sessions.get('0:127'),current);assert.equal(x.r.samples.get('0:127:1'),prior);assert.equal(x.r.pendingBytes,640);}
 assert.ok(x.errors.some(v=>v.includes('34359738367'))||x.errors.some(v=>v.includes('4363686772609')));x.send(loop(0,0,2**32+1));assert.equal(current.loops.size,0);assert.equal(x.r.samples.get('0:127:1'),prior);
});

test('name framing, raw future language tags, temporal replacement and port/device isolation',()=>{
 const x=received();for(const [port,device,text]of [[0,1,'Left'],[0,2,'Right'],[16,1,'Other']]){x.send(name(text,{device}),port);x.send(header({length:1,device}),port);x.send(packets([32768],16,device)[0],port);assert.equal(x.r.samples.get(`${port}:${device}:1`).name,text);}
 x.send(name('New',{device:1}));assert.equal(x.r.samples.get('0:1:1').name,'New');const before=x.r.samples.get('0:1:1');const malformed=name('Bad',{device:1});malformed[7]=4;x.send(malformed);assert.equal(x.r.samples.get('0:1:1'),before);
 x.send(name('Raw',{device:1,tag:[102,114]}));const row=x.r.samples.get('0:1:1');assert.equal(row.name,null);assert.deepEqual(row.languageTag,[102,114]);assert.deepEqual(row.nameBytes,[82,97,119]);assert.ok(x.errors.at(-1).includes('raw bytes'));assert.equal(x.r.describe().find(r=>r.device===2).name,'Right');assert.ok(!('channelData'in x.r.describe()[0]));
 x.send(name(''));assert.equal(x.r.names.get('0:127:1').name,'');const long='x'.repeat(127);x.send(name(long));assert.equal(x.r.names.get('0:127:1').name,long);
});

test('Extended Loop Point accepts all CA-019 types, inclusive endpoints and delete-all, without exposing malformed changes',()=>{
 const x=received();x.send(header({length:5}));for(const p of packets([1,2,3,4,5]))x.send(p);for(const type of types){x.send(loop(type,1,4));assert.deepEqual(x.r.samples.get('0:127:1').loops.get(0),{type,start:1,end:4,extended:true});}
 x.send(loop(0,1,5));assert.equal(x.r.samples.get('0:127:1').loops.get(0).type,127);x.send(loop(0,0,0,{number:16383}));assert.equal(x.r.samples.get('0:127:1').loops.size,0);
 const partial=received();partial.send(header({length:80}));partial.send(loop(67,1,40));for(const p of packets(left.slice(0,80)))partial.send(p);assert.equal(partial.r.samples.get('0:127:1').loops.get(0).type,67);
 for(const sub of [2,4,7]){const count=x.errors.length;x.send(Uint8Array.from([126,127,5,sub,1,0,247]));assert.equal(x.errors.length,count+1);assert.match(x.errors.at(-1),/excluded from file playback/);}
});

// Explicit source-frame oracles derived from CA-019 descriptions, not from
// the sampler's modulo arithmetic. Sustain loops keep looping after key-up.
const held={0:[0,1,2,3,4,2,3,4,2,3,4,2],1:[0,1,2,3,4,3,2,3,4,3,2,3],64:[6,5,4,3,2,4,3,2,4,3,2,4],65:[6,5,4,3,2,3,4,3,2,3,4,3],126:[6,5,4,3,2,1,0],127:[0,1,2,3,4,5,6]};
test('all ten CA-019 playback types follow independent frame sequences; release at either leg reaches the correct tail',()=>{
 for(const type of types){const wave={sampleData:Float32Array.from([10,11,12,13,14,15,16]),sdsPlayback:{type,start:2,end:4},cursor:0,playbackStep:1,sdsExit:null,sdsInterpolation:1},voice={wavetable:wave,isInRelease:false};const indices=held[type]??held[type-2],out=new Float32Array(indices.length);processSampleDump(voice,out.length,1,out);assert.deepEqual([...out],indices.map(i=>10+i));}
 for(const [type,at,want]of [[2,6,[3,4,5,6,null,null]],[3,5,[3,2,3,4,5,6]],[3,7,[3,4,5,6,null,null]],[66,6,[3,2,1,0,null,null]],[67,5,[3,4,3,2,1,0]],[67,7,[3,2,1,0,null,null]]]){const wave={sampleData:Float32Array.from([10,11,12,13,14,15,16]),sdsPlayback:{type,start:2,end:4},cursor:0,playbackStep:1,sdsExit:null,sdsInterpolation:1},voice={wavetable:wave,isInRelease:false};processSampleDump(voice,at,1,new Float32Array(at));voice.isInRelease=true;const out=new Float32Array(want.length);processSampleDump(voice,out.length,1,out);assert.deepEqual([...out],want.map((i,k)=>i===null?0:10+i),`type ${type}, phase ${at}`);}
 for(const type of [0,1,64,65]){const wave={sampleData:Float32Array.from([10,11,12,13,14,15,16]),sdsPlayback:{type,start:2,end:4},cursor:0,playbackStep:1,sdsExit:null,sdsInterpolation:1},voice={wavetable:wave,isInRelease:true},out=new Float32Array(12);processSampleDump(voice,12,1,out);assert.deepEqual([...out],held[type].map(i=>10+i));}
});

test('bidirectional single-frame loops, fractional steps and all three interpolation modes remain finite across release and capture',()=>{
 for(const interpolation of [0,1,2])for(const type of [1,3,65,67]){const wave={sampleData:Float32Array.from([.1,.2,.3,.4,.5]),sdsPlayback:{type,start:2,end:2},cursor:0,playbackStep:.75,sdsExit:null,sdsInterpolation:interpolation},voice={wavetable:wave,isInRelease:false},out=new Float32Array(128);processSampleDump(voice,128,1,out);assert.ok(out.every(Number.isFinite));voice.isInRelease=true;processSampleDump(voice,128,1,out);assert.ok(out.every(Number.isFinite));if(type&2)assert.equal(out.at(-1),0);else assert.equal(out.at(-1),Math.fround(.3));}
});

function referencePreset(channels,rate){const bank=new BasicSoundBank(),inst=new BasicInstrument();for(let c=0;c<channels.length;c++){const sample=new BasicSample('Independent',rate,60,0,SampleTypes.monoSample,0,0);sample.setAudioData(Float32Array.from(channels[c],v=>(v-32768)/32768),rate);bank.addSamples(sample);const zone=inst.createZone(sample);zone.setGenerator(GeneratorTypes.releaseVolEnv,1200*Math.log2(.1));if(channels.length===2)zone.setGenerator(GeneratorTypes.pan,c?500:-500);if(channels.length>2)zone.setGenerator(GeneratorTypes.initialAttenuation,Math.round(200*Math.log10(channels.length)));}bank.addInstruments(inst);const preset=new BasicPreset(bank);preset.program=81;preset.createZone(inst);bank.addPresets(preset);bank.flush();return preset;}

test('stereo fractional-rate reverse one-shot matches independently reversed banks exactly on JS/WASM/SIMD',async()=>{
 for(const dsp of ['js','wasm','wasm-simd'])for(const interpolation of [0,1,2]){const a=await synth(dsp,mappings,interpolation),b=await synth(dsp,[],interpolation);dump(a,stereo,{rate:22050,fraction:2**27+1,type:126});b.midiChannels[0].preset=referencePreset([left.slice().reverse(),right.slice().reverse()],22050.5+2**-28);a.noteOn(0,60,100);b.noteOn(0,60,100);const actual=render(a,300),expected=render(b,300);same(actual,expected,dsp+' interpolation '+interpolation);assert.ok(energy(actual)>0);const core=a.synthCore,bank=core.sampleDumpBank.ready.values().next().value;assert.equal(bank.samples.length,2);assert.equal(bank.samples[0].sampleRate,22050.5+2**-28);assert.equal(core.sampleDumps.usedBytes,stereo.length*12);a.stopAllChannels(true);b.stopAllChannels(true);}
});

const score=midi([...setup,event(name('Stereo Test')),event(header({channels:2,type:3,start:20,end:150,rate:24000,fraction:2**27+1})),...packets(stereo).map((p,i)=>event(p,i?4:0)),[0,0x90,60,100],[90,0xb0,64,127],[60,0x80,60,64],event(loop(67,40,120),60),event(name('Later')), [0,0x90,67,90],[120,0x80,67,64],[90,0xb0,64,0],[...vlq(480),255,47,0]]);
test('Extended SDS file preparation, diagnostics, timed edits, checkpointed PCM and exact seeks work on all DSP backends',async()=>{
 const ready=await loader.load(score,{sampleDumpMappings:mappings});assert.equal(ready.sampleBank.samples,0);assert.equal(ready.diagnostics.summary.unsupported,0);assert.equal(ready.diagnostics.summary.unverified,0);const row=ready.diagnostics.sampleDumps[0];assert.equal(row.channels,2);assert.equal(row.name,'Later');assert.equal(row.rateFraction,2**27+1);assert.equal(row.loops[0].type,67);
 const outputs=[];for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,ready.bank,{prepared:ready,effects:false,dsp});try{const pcm=p.read(72000);outputs.push(pcm);assert.ok(energy(pcm)>1);for(const frame of [31,8001,18001,30001]){await p.seek(frame/48000);const saved=p.capture(),actual=p.read(18001);same(actual,pcm.map(ch=>ch.slice(frame,frame+18001)),dsp);saved.restore();same(p.read(18001),actual,dsp+' capture');}}finally{p.close();}}same(outputs[0],outputs[1]);same(outputs[0],outputs[2]);
});

test('Extended SDS stereo resources and pending names/loops are restored without copying immutable audio or replacing held notes',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);s.systemExclusive(name('First'));s.systemExclusive(header({channels:2,type:3,start:20,end:150}));const data=packets(stereo);s.systemExclusive(data[0]);const partial=captureSynthCheckpoint(s,{},{});s.systemExclusive(loop(67,40,120));s.systemExclusive(name('Second'));for(const p of data.slice(1))s.systemExclusive(p);s.noteOn(0,60,100);render(s,256);const active=s.synthCore.voices.filter(v=>v.isActive),before=captureSynthCheckpoint(s,{},{}),banks=s.synthCore.sampleDumpBank.resources.size;s.systemExclusive(name('Third'));assert.equal(s.synthCore.sampleDumpBank.resources.size,banks,'metadata rename reuses the playable bank');s.systemExclusive(loop(2,30,90));assert.ok(active.every(v=>v.wavetable.sdsPlayback.type===67));s.noteOff(0,60,64);const pcm=render(s,2048);before.restore();s.systemExclusive(name('Third'));s.systemExclusive(loop(2,30,90));s.noteOff(0,60,64);same(render(s,2048),pcm,dsp);
 partial.restore();assert.equal(s.synthCore.sampleDumps.names.get('0:127:1').name,'First');assert.equal(s.synthCore.sampleDumps.samples.size,0);for(const p of data.slice(1))s.systemExclusive(p);s.noteOn(0,60,100);assert.equal(s.synthCore.sampleDumps.samples.get('0:127:1').name,'First');assert.equal(s.synthCore.sampleDumps.resources.cache.size,1);assert.equal(s.synthCore.sampleDumps.usedBytes,stereo.length*12);s.stopAllChannels(true);}
});

test('actual Worker prepares and restores Extended SDS with stereo, names, fractional rate and release loops',async()=>{
 const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};const ready=await loader.load(score,{sampleDumpMappings:mappings}),reference=await createSoundFontPreview(score,ready.bank,{prepared:ready,dsp:'wasm',effects:false});try{const loaded=await call('load',{bytes:score,epoch:1,effects:false,dsp:'wasm',sampleDumpMappings:mappings});assert.equal(loaded.sampleBank.samples,0);assert.equal(loaded.sampleDumps[0].channels,2);assert.equal(loaded.sampleDumps[0].name,'Later');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);for(const [epoch,seconds]of [[2,.1],[3,.41],[4,.8]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});same((await pending)[0].channels,reference.read(2048));}}finally{reference.close();channel.port1.close();await worker.terminate();}
});

// Independent discrete direction-switching oracle. This has no modulo phase
// or unrolled-coordinate calculation in common with processSampleDump.
function trace(type,data,length,releaseAt){const reverse=type>=64&&type!==127,bidi=!!(type&1),loops=type<126,canExit=!!(type&2),n=data.length,lo=reverse?n-1-180:32,hi=reverse?n-1-32:180;let pos=0,direction=1,tail=!loops;const out=[];for(let i=0;i<length;i++){out.push(pos>=n?32768:data[reverse?n-1-pos:pos]);if(!tail&&i>=releaseAt&&canExit&&direction===1&&pos===hi)tail=true;if(tail)pos++;else if(direction===1&&pos===hi){if(bidi){direction=-1;pos--;}else pos=lo;}else if(direction===-1&&pos===lo){direction=1;pos++;}else pos+=direction;}return out;}
test('every CA-019 loop and direction produces exact audible PCM against independent direction-switching reference instruments',async()=>{
 for(const dsp of ['js','wasm','wasm-simd'])for(const type of types){const a=await synth(dsp,mappings,1),b=await synth(dsp,[],1);dump(a,left,{channels:1,rate:48000,type,start:32,end:180});b.midiChannels[0].preset=referencePreset([trace(type,left,12000,384)],48000);a.noteOn(0,60,110);b.noteOn(0,60,110);same(render(a,384),render(b,384),dsp+' type '+type+' held');a.noteOff(0,60,64);b.noteOff(0,60,64);same(render(a,512),render(b,512),dsp+' type '+type+' release');a.stopAllChannels(true);b.stopAllChannels(true);}
});

test('dense Extended SDS stereo notes retain exact PCM through native batching, pedals and released reverse loops',async()=>{
 const results=[];for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);dump(s,stereo,{type:67,start:32,end:180,rate:36000,fraction:2**26+7});for(let note=50;note<74;note++)s.noteOn(0,note,70+note%30);const first=render(s,2048);if(dsp!=='js')assert.ok(s.synthCore.voiceDSP.batchStats.voices>=48);s.controllerChange(0,64,127);for(let note=50;note<74;note++)s.noteOff(0,note,64);const held=render(s,1024),saved=captureSynthCheckpoint(s,{},{});s.controllerChange(0,64,0);const released=render(s,4096);saved.restore();s.controllerChange(0,64,0);same(render(s,4096),released,dsp+' restore');results.push([...first,...held,...released]);s.stopAllChannels(true);}same(results[0],results[1],'scalar batch');same(results[0],results[2],'SIMD batch');
});

test('wide loop/name/header packets spanning F0/F7 apply only at final-byte time and honour original SMF ports',async()=>{
 const hdr=header({length:256,channels:2,type:65,start:10,end:200}),chunk=(data)=>[[0,240,...vlq(10),...data.slice(0,10)],[...vlq(8),247,...vlq(data.length-10),...data.slice(10)]],bytes=midiTracks([[...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],eot],[[0,255,33,1,7],...setup,...chunk(hdr),...packets(stereo).map(p=>event(p)),...chunk(name('Port seven')),...chunk(loop(66,30,150)),[0,0x90,60,100],[...vlq(480),0x80,60,64],eot]]),settings=normalizeSampleDumpMappings([{...mapping,sourcePort:7}]);const ready=await loader.load(bytes,{sampleDumpMappings:settings});assert.equal(ready.diagnostics.summary.unsupported,0);assert.equal(ready.diagnostics.summary.unverified,0);assert.equal(ready.diagnostics.sampleDumps[0].port,7);assert.equal(ready.diagnostics.sampleDumps[0].name,'Port seven');assert.equal(ready.diagnostics.sampleDumps[0].loops[0].type,66);
 for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(bytes,ready.bank,{prepared:ready,dsp,effects:false});try{const pcm=p.read(40000);assert.ok(energy(pcm)>1);await p.seek(10001/48000);same(p.read(16000),pcm.map(ch=>ch.slice(10001,26001)));}finally{p.close();}}
});

test('all multichannel words survive playback banks, with explicit equal-weight stereo downmix above two channels',()=>{
 for(const channels of [3,127]){const x=received(),words=Array.from({length:channels*2},(_,i)=>32768+i);x.send(header({length:2,channels}));for(const p of packets(words))x.send(p);const row=x.r.samples.get('0:127:1'),bank=createSampleDumpBank(row,mappings[0]);assert.equal(bank.samples.length,channels);for(let c=0;c<channels;c++){assert.deepEqual([...bank.samples[c].getAudioData()],[c/32768,(c+channels)/32768]);assert.equal(bank.instruments[0].zones[c].getGenerator(GeneratorTypes.initialAttenuation),Math.round(200*Math.log10(channels)));}assert.equal(x.r.usedBytes,words.length*12);}
});

test('large interleaved resources reuse deinterleaved PCM through WASM growth, full budgets and repeated restoration',async()=>{
 const frames=150000,words=Array.from({length:frames*2},(_,i)=>(i%2?right:left)[Math.floor(i/2)%256]),data=packets(words),hdr=header({length:frames,channels:2,type:65,start:10,end:frames-1});for(const dsp of ['wasm','wasm-simd']){const s=await synth(dsp),core=s.synthCore,initial=core.voiceDSP.memoryBuffer.byteLength;core.sampleDumps.maxBytes=words.length*12;const before=captureSynthCheckpoint(s,{},{});let expected,stable;for(let repeat=0;repeat<3;repeat++){before.restore();s.systemExclusive(hdr);for(const p of data)s.systemExclusive(p);s.noteOn(0,60,100);const pcm=render(s,4096);if(!repeat){expected=pcm;const point=captureSynthCheckpoint(s,{},{});s.midiChannels[1].preset=referencePreset([Array(400000).fill(34000)],48000);s.noteOn(1,60,80);render(s,128);assert.ok(core.voiceDSP.memoryBuffer.byteLength>initial);point.restore();stable=core.voiceDSP.memoryBuffer.byteLength;}else{same(pcm,expected);assert.equal(core.voiceDSP.memoryBuffer.byteLength,stable);}assert.equal(core.sampleDumps.usedBytes,words.length*12);assert.equal(core.sampleDumpBank.resources.size,1);assert.equal(core.sampleDumps.resources.cache.size,1);const after=captureSynthCheckpoint(s,{},{});assert.ok(after.bytes-before.bytes<words.length);}s.stopAllChannels(true);}
});

test('three interleaved channels produce the independent equal-weight centre downmix on every DSP',async()=>{
 const channels=[left,right,left.map(v=>65535-v)],words=left.flatMap((_,i)=>channels.map(ch=>ch[i]));for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp,mappings,1),b=await synth(dsp,[],1);dump(a,words,{channels:3,type:127,rate:48000});b.midiChannels[0].preset=referencePreset(channels,48000);a.noteOn(0,60,100);b.noteOn(0,60,100);same(render(a,200),render(b,200));a.stopAllChannels(true);b.stopAllChannels(true);}
});
