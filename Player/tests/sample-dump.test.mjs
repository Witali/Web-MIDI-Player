import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import {fileURLToPath}from'node:url';import {Worker,MessageChannel}from'node:worker_threads';import {once}from'node:events';
import {MidiPlayer}from'../index.js';
import {SampleDumpReceiver}from'../sample-dump.js';import {createSampleDumpBank,installSampleDumpBank}from'../sample-dump-bank.js';import {normalizeSampleDumpMappings}from'../sample-dump-settings.js';import {BrowserSoundBank}from'../lazy-bank.js';import {createSoundFontPreview}from'../soundfont-preview.js';import {MIDIByteStream,SpessaSynthProcessor,SpessaLog,BasicSoundBank,BasicSample,BasicInstrument,BasicPreset,GeneratorTypes,SampleTypes}from'../vendor/spessasynth.js';import {installVoiceDSP}from'../voice-dsp.js';import {captureSynthCheckpoint}from'../synth-checkpoint.js';import {midi,midiTracks,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const little=(v,n=3)=>Array.from({length:n},(_,i)=>Math.floor(v/128**i)&127);
const header=({sample=1,bits=16,length=256,period=20000,start=0,end=0,type=127,device=127}={})=>new Uint8Array([126,device,1,...little(sample,2),bits,...little(period),...little(length),...little(start),...little(end),type,247]);
function packets(words,bits=16,device=127){const width=Math.ceil(bits/7),out=[],per=120/width;for(let at=0;at<words.length;at+=per){const payload=[];for(let i=0;i<per;i++){let word=at+i<words.length?words[at+i]*2**(width*7-bits):0;const bytes=Array(width);for(let j=width-1;j>=0;j--){bytes[j]=word%128;word=Math.floor(word/128);}payload.push(...bytes);}const d=[126,device,2,(at/per)&127,...payload];out.push(new Uint8Array([...d,d.reduce((a,b)=>a^b,0),247]));}return out;}
const loop=(sample,n,type,start,end,device=127)=>new Uint8Array([126,device,5,1,...little(sample,2),...little(n,2),type,...little(start),...little(end),247]);
const event=(d,t=0)=>[...vlq(t),240,...vlq(d.length),...d],end=[0,255,47,0],setup=[[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0]],tone=[...setup,[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const wave=Array.from({length:256},(_,i)=>Math.round(32768+Math.sin(i*Math.PI/16)*22000));
const mapping={sample:1,rootKey:60,program:81,loopEnd:'exclusive'},mappings=normalizeSampleDumpMappings([mapping]);
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
async function synth(dsp='js',opts=mappings){const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,sys)=>prepared.bank.getPreset(p,sys);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installSampleDumpBank(s,opts);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);s.programChange(0,81);if(dsp!=='js')await installVoiceDSP(s,dsp);return s;}
const render=(s,n)=>{const out=[new Float32Array(n),new Float32Array(n)];for(let i=0;i<n;i+=128)s.process(...out,i,Math.min(128,n-i));return out;};
const energy=a=>a.reduce((sum,r)=>sum+r.reduce((s,v)=>s+v*v,0),0),error=(a,b)=>{let max=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)max=Math.max(max,Math.abs(a[c][i]-b[c][i]));}return max;};const same=(a,b,label='')=>assert.equal(error(a,b),0,label);
const received=()=>{const rows=[],sent=[],r=new SampleDumpReceiver({onReply:(bytes,port)=>sent.push({bytes:[...bytes],port})}),log={gmInfo:(feature,value)=>rows.push({kind:'implemented',feature,value}),unsupported:(feature,data,reason)=>rows.push({kind:'unsupported',feature,reason})};return{r,log,rows,sent,send:(d,p=0)=>r.receive(d,p,log)};};
const dump=(s,words=wave,opts={})=>{s.systemExclusive(header({length:words.length,...opts}));for(const data of packets(words,opts.bits??16,opts.device??127))s.systemExclusive(data);};

test('SDS independently packed8..28-bit words decode exactly, offset-binary zero is centred and final padding is excluded',()=>{
 for(let bits=8;bits<=28;bits++){const {r,send,sent}=received(),middle=2**(bits-1),max=2**bits-1,words=[0,middle-1,middle,middle+1,max,1,...Array.from({length:91},(_,i)=>(i*17)%(max+1))];send(header({bits,length:words.length,sample:300,period:20833}));for(const p of packets(words,bits))send(p);const row=r.samples.get('0:127:300');assert.deepEqual([...row.words],words);assert.equal(row.pcm.length,words.length);assert.equal(row.pcm[0],-1);assert.equal(row.pcm[2],0);assert.equal(row.pcm[4],Math.fround((max-middle)/middle));assert.equal(row.sampleRate,1e9/20833);assert.equal(sent.length,1+packets(words,bits).length);assert.ok(sent.every(v=>v.bytes[3]===127));}
});

test('SDS checksum, sequence, duplicate retransmission and127→0 wrap never append invalid or duplicate data',()=>{
 const {r,send,rows,sent}=received(),words=Array.from({length:40*130+7},(_,i)=>(i*797)&65535),parts=packets(words);send(header({length:words.length}));const corrupt=parts[0].slice();corrupt[124]^=1;send(corrupt);assert.equal(r.sessions.get('0:127').received,0);send(parts[1]);assert.equal(r.sessions.get('0:127').received,0);send(parts[0]);send(parts[0]);assert.equal(r.sessions.get('0:127').received,40);for(const p of parts.slice(1))send(p);send(parts.at(-1));assert.deepEqual([...r.samples.get('0:127:1').words],words);assert.ok(rows.some(v=>v.reason?.includes('checksum')));assert.ok(rows.some(v=>v.reason?.includes('Out-of-order')));assert.deepEqual(sent[2].bytes,[240,126,127,126,0,247]);
});

test('SDS final/non-significant padding, malformed headers, memory exhaustion and packets without header are explicit and atomic',()=>{
 const {r,send,rows}=received();send(header({bits:7}));send(header({period:0}));send(header({length:3,start:4,end:5,type:0}));assert.equal(r.sessions.size,0);send(packets(wave)[0]);assert.equal(r.samples.size,0);send(header({length:1,bits:8}));const bad=packets([128],8)[0];bad[5]|=1;bad[124]=bad.slice(0,124).reduce((a,b)=>a^b,0);send(bad);assert.equal(r.sessions.get('0:127').received,0);const trailing=packets([128],8)[0];trailing[8]=1;trailing[124]=trailing.slice(0,124).reduce((a,b)=>a^b,0);send(trailing);assert.equal(r.sessions.get('0:127').received,0);send(packets([128],8)[0]);assert.deepEqual([...r.samples.get('0:127:1').words],[128]);assert.ok(rows.filter(v=>v.kind==='unsupported').length>=6);
 const small=new SampleDumpReceiver({maxBytes:8});small.receive(header({length:2}),0,{gmInfo(){},unsupported(){}});assert.equal(small.sessions.size,0);assert.equal(small.usedBytes,0);
});

test('ports/devices have independent transfer/sample state; CANCEL and new headers preserve prior committed data',()=>{
 const {r,send}=received();for(const [port,device]of [[0,1],[0,2],[16,1]]){send(header({length:1,device}),port);send(packets([port+device],16,device)[0],port);}assert.equal(r.samples.size,3);send(header({length:80,device:1}));send(packets(wave,16,1)[0]);send(new Uint8Array([126,1,125,0,247]));assert.equal(r.samples.get('0:1:1').words[0],1);assert.equal(r.sessions.has('0:1'),false);send(header({length:80,device:1}));send(header({length:1,device:1,sample:3}));send(packets([44],16,1)[0]);assert.equal(r.samples.get('0:1:3').words[0],44);assert.equal(r.samples.get('16:1:1').words[0],17);
});

test('SDS loop-point messages replace/delete selected/all loops and retain exact raw positions',()=>{
 const {r,send,rows}=received();send(header({length:wave.length,start:10,end:100,type:0}));for(const p of packets(wave))send(p);send(loop(1,1,1,20,80));send(loop(1,0,0,12,90));let row=r.samples.get('0:127:1');assert.equal(row.loops.size,2);assert.deepEqual(row.loops.get(0),{type:0,start:12,end:90});send(loop(1,1,127,0,0));assert.equal(r.samples.get('0:127:1').loops.size,1);send(loop(1,0,0,200,300));assert.ok(rows.at(-1).kind==='unsupported');assert.equal(r.samples.get('0:127:1').loops.get(0).end,90);send(loop(1,16383,0,0,0));assert.equal(r.samples.get('0:127:1').loops.size,0);
});

test('explicit SDS mappings validate root/address/port/loop policy and build actual forward/bidirectional SF2-compatible wave banks',()=>{
 for(const value of [{...mapping,rootKey:128},{...mapping,sample:16384},{...mapping,sourcePort:-1},{...mapping,release:0},{...mapping,loopEnd:'guess'},{...mapping,unknown:1}])assert.throws(()=>normalizeSampleDumpMappings([value]));assert.throws(()=>normalizeSampleDumpMappings([mapping,mapping]));
 const row={length:6,pcm:Float32Array.from([0,.1,.2,.3,.4,.5]),sampleRate:50000,loops:new Map([[0,{type:1,start:1,end:4}]])};const bank=createSampleDumpBank(row,mappings[0]);assert.deepEqual([...bank.samples[0].getAudioData()],[...Float32Array.from([0,.1,.2,.3,.2,.4,.5])]);assert.equal(bank.samples[0].loopStart,1);assert.equal(bank.samples[0].loopEnd,5);assert.equal(bank.presets[0].program,81);assert.equal(bank.samples[0].originalKey,60);assert.equal(bank.instruments[0].zones[0].getGenerator(GeneratorTypes.sampleModes),3);
});

function referencePreset(){const bank=new BasicSoundBank(),sample=new BasicSample('Reference',50000,60,0,SampleTypes.monoSample,0,wave.length);sample.setAudioData(Float32Array.from(wave,n=>(n-32768)/32768),50000);bank.addSamples(sample);const instrument=new BasicInstrument(),zone=instrument.createZone(sample);zone.setGenerator(GeneratorTypes.releaseVolEnv,1200*Math.log2(.1));zone.setGenerator(GeneratorTypes.sampleModes,3);bank.addInstruments(instrument);const preset=new BasicPreset(bank);preset.name='Reference';preset.program=81;preset.createZone(instrument);bank.addPresets(preset);bank.flush();return preset;}
test('received SDS bank produces exact PCM versus an independently constructed reference on JS/WASM/SIMD',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp,[]);dump(a,wave,{type:0,start:0,end:wave.length});b.midiChannels[0].preset=referencePreset();a.noteOn(0,60,100);b.noteOn(0,60,100);const actual=render(a,8000);assert.ok(energy(actual)>1);same(actual,render(b,8000),dsp);a.noteOff(0,60,90);b.noteOff(0,60,90);same(render(a,16000),render(b,16000),dsp+' release');a.stopAllChannels(true);b.stopAllChannels(true);}
});

test('incomplete/replacement dumps never replace held voices or expose future data; checkpoints restore partially filled transfers and dynamic mappings',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);s.noteOn(0,60,100);render(s,256);const original=s.synthCore.voices.filter(v=>v.isActive).map(v=>v.wavetable.sampleData);s.systemExclusive(header({length:wave.length,type:0,end:wave.length}));const p=packets(wave);s.systemExclusive(p[0]);assert.equal(s.synthCore.sampleDumpBank.ready.size,0);const saved=captureSynthCheckpoint(s,{},{});for(const part of p.slice(1))s.systemExclusive(part);assert.equal(s.synthCore.sampleDumpBank.ready.size,1);assert.ok(s.synthCore.voices.filter(v=>v.isActive).every(v=>original.includes(v.wavetable.sampleData)));const completed=captureSynthCheckpoint(s,{},{});saved.restore();assert.equal(s.synthCore.sampleDumpBank.ready.size,0);assert.equal(s.synthCore.sampleDumps.samples.size,0);assert.equal(s.synthCore.sampleDumps.sessions.get('0:127').received,40);const partialAgain=captureSynthCheckpoint(s,{},{});for(const part of p.slice(1))s.systemExclusive(part);s.noteOn(0,60,90);const pcm=render(s,12000);partialAgain.restore();for(const part of p.slice(1))s.systemExclusive(part);s.noteOn(0,60,90);same(render(s,12000),pcm,dsp);completed.restore();assert.equal(s.synthCore.sampleDumpBank.ready.size,1);assert.deepEqual([...s.synthCore.sampleDumps.samples.get('0:127:1').words],wave);s.stopAllChannels(true);}
});

const parts=packets(wave),score=midi([...setup,event(header({length:wave.length,type:0,end:wave.length})),...parts.map((p,i)=>event(p,i?20:0)),[0,0x90,60,100],[60,0xb0,64,127],[60,0x80,60,64],event(loop(1,0,1,20,120),120),[0,0x90,67,90],[120,0x80,67,64],[120,0xb0,64,0],[...vlq(480),255,47,0]]);
test('SDS files use selective sample preparation, public metadata and exact seeks/checkpoints including loop edits on all DSPs',async()=>{
 const prepared=await loader.load(score,{sampleDumpMappings:mappings});assert.equal(prepared.sampleBank.samples,0,'all played notes use the actual received sample');assert.equal(prepared.diagnostics.sampleDumps.length,1);assert.equal(prepared.diagnostics.summary.unsupported,0);assert.equal(prepared.diagnostics.summary.unverified,0);
 for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp,effects:false,sampleDumpMappings:mappings});try{assert.equal(p.stats.sampleDumps[0].length,256);assert.ok(p.stats.instruments.some(i=>i.name==='SDS sample 1'&&i.program===81));const pcm=p.read(96000);assert.ok(energy(pcm)>1);for(const frame of [1001,12001,24001]){await p.seek(frame/48000);const saved=p.capture(),actual=p.read(36001);same(actual,pcm.map(row=>row.slice(frame,frame+36001)),dsp);saved.restore();same(p.read(36001),actual);}}finally{p.close();}}
});

test('unfinished SDS is diagnosed at End Of Track, and F0/F7 applies a completed packet only at its final byte',async()=>{
 const truncated=midi([...setup,event(header({length:256})),event(parts[0]),...tone]),a=await loader.load(truncated,{sampleDumpMappings:mappings});assert.ok(a.diagnostics.entries.some(r=>r.feature==='SDS incomplete transfer'));
 const first=parts[0],split=midi([...setup,event(header({length:1,bits:16})),[0,240,60,...packets([32768])[0].slice(0,60)],[120,247,66,...packets([32768])[0].slice(60)],[0,0x90,60,100],[120,0x80,60,64],end]);const b=await loader.load(split,{sampleDumpMappings:mappings});assert.equal(b.diagnostics.summary.unsupported,0);assert.equal(b.diagnostics.sampleDumps.length,1);
});

test('actual Worker passes SDS mappings into preparation/playback and returns exact received-sample PCM',async()=>{
 const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};const prepared=await loader.load(score,{sampleDumpMappings:mappings}),reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm',effects:false,sampleDumpMappings:mappings});
 try{const loaded=await call('load',{bytes:score,epoch:1,effects:false,dsp:'wasm',sampleDumpMappings:mappings});assert.equal(loaded.sampleBank.samples,0);assert.equal(loaded.sampleDumps.length,1);worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);for(const [epoch,seconds]of [[2,.31],[3,.71],[4,.01]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});same((await pending)[0].channels,reference.read(2048));}}finally{reference.close();channel.port1.close();await worker.terminate();}
});


test('public player validates/copied SDS mappings and forwards them in its load request',async()=>{
 const source={...mapping},player=new MidiPlayer({sampleDumpMappings:[source]});source.rootKey=12;let sent;player._call=async(type,data)=>{sent={type,data};return{duration:1,parts:[],instruments:[],text:{events:[]}};};await player.load(midi(tone));assert.equal(sent.type,'load');assert.equal(sent.data.sampleDumpMappings[0].rootKey,60);assert.throws(()=>new MidiPlayer({engine:'z80',sampleDumpMappings:[mapping]}));assert.throws(()=>new MidiPlayer({sampleDumpMappings:[{...mapping,program:128}]}));
});

test('replacing a committed SDS wave updates new notes only, and restores both versions across checkpoints',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);dump(s,wave,{type:0,end:256});s.noteOn(0,60,100);render(s,1024);const voices=s.synthCore.voices.filter(v=>v.isActive),old=voices.map(v=>v.wavetable.sampleData),before=captureSynthCheckpoint(s,{},{});const replacement=wave.map(n=>65535-n);dump(s,replacement,{type:0,end:256});assert.ok(voices.every((v,i)=>v.wavetable.sampleData===old[i]));s.noteOn(0,60,90);assert.ok(s.synthCore.voices.some(v=>v.isActive&&!voices.includes(v)&&!old.includes(v.wavetable.sampleData)));const mixed=render(s,4096);before.restore();dump(s,replacement,{type:0,end:256});s.noteOn(0,60,90);same(render(s,4096),mixed,dsp);s.stopAllChannels(true);}
});


test('SDS data completed by F7 changes bank state at that byte, while real-time bytes never enter its checksum',async()=>{
 const s=await synth(),stream=new MIDIByteStream(),emit=(status,data)=>{if(status===240)s.systemExclusive(new Uint8Array(data));};s.systemExclusive(header({length:1}));const p=packets([40000])[0];stream.write(new Uint8Array([240,...p.slice(0,60),248]),emit);assert.equal(s.synthCore.sampleDumps.samples.size,0);assert.equal(s.synthCore.sampleDumpBank.ready.size,0);render(s,128);stream.write(p.slice(60),emit);assert.equal(s.synthCore.sampleDumps.samples.size,1);assert.equal(s.synthCore.sampleDumpBank.ready.size,1);assert.deepEqual([...s.synthCore.sampleDumps.samples.get('0:127:1').words],[40000]);
});

test('explicit source-port mappings isolate an SDS instrument, metadata reports the original SMF port and prepared mappings carry through',async()=>{
 const settings=normalizeSampleDumpMappings([{...mapping,sourcePort:7}]),bytes=midiTracks([[...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],end],[[0,255,33,1,7],...setup,event(header({length:wave.length,type:0,end:256})),...parts.map(p=>event(p)),[0,0x90,60,100],[...vlq(480),0x80,60,64],end]]),plain=midi([...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],end]);const prepared=await loader.load(bytes,{sampleDumpMappings:settings,partSettings:{'7:1':{muted:true}}});assert.equal(prepared.diagnostics.sampleDumps[0].port,7);assert.equal(prepared.diagnostics.sampleDumps[0].channelOffset,16);assert.ok(prepared.diagnostics.parts.find(p=>p.port===7).sourceInstruments.some(p=>p.name==='SDS sample 1'));
 for(const dsp of ['js','wasm','wasm-simd']){const a=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp,effects:false,partSettings:{'7:1':{muted:true}}}),b=await createSoundFontPreview(plain,prepared.bank,{dsp,effects:false});try{same(a.read(60000),b.read(60000),dsp);}finally{a.close();b.close();}}
 await assert.rejects(()=>createSoundFontPreview(bytes,prepared.bank,{prepared,sampleDumpMappings:[]}),/Prepared sampleDumpMappings/);
});


test('SDS waves/banks reuse immutable resources across replay, WASM memory growth and repeated checkpoint restoration',async()=>{
 const large=Array.from({length:300000},(_,i)=>wave[i%wave.length]),data=packets(large),hdr=header({length:large.length,type:0,end:large.length});
 for(const dsp of ['wasm','wasm-simd']){const s=await synth(dsp),core=s.synthCore;s.noteOn(0,60,100);render(s,512);const before=captureSynthCheckpoint(s,{},{}),initial=core.voiceDSP.memoryBuffer.byteLength;let expected,stableMemory;
  for(let repeat=0;repeat<4;repeat++){before.restore();s.systemExclusive(hdr);for(const p of data)s.systemExclusive(p);s.noteOn(0,60,90);const actual=render(s,4096);if(!expected){expected=actual;stableMemory=core.voiceDSP.memoryBuffer.byteLength;assert.ok(stableMemory>initial,'new received wave grows WASM memory');}else{same(actual,expected,dsp);assert.equal(core.voiceDSP.memoryBuffer.byteLength,stableMemory,'identical replay must reuse native PCM allocation');}assert.equal(core.sampleDumpBank.resources.size,1);assert.equal(core.sampleDumps.resources.cache.size,1);assert.equal(core.sampleDumps.pendingBytes,0);}
  const captured=captureSynthCheckpoint(s,{},{});assert.ok(captured.bytes-before.bytes<large.length,'complete waves must not enlarge checkpoint copies: '+before.bytes+' -> '+captured.bytes);s.stopAllChannels(true);
 }
});


test('received samples occupy explicit non-GM bank addresses and remain selectable through host part controls',async()=>{
 const destination={bankMSB:100,bankLSB:4,program:22,percussion:false},map=normalizeSampleDumpMappings([{...mapping,...destination}]),prefix=[event(header({length:wave.length,type:0,end:256})),...parts.map(p=>event(p))],notes=[[0,0x90,60,100],[...vlq(240),0x80,60,64],end],bytes=midi([...prefix,[0,0xb0,0,100],[0,0xb0,32,4],[0,0xc0,22],...notes]),host=midi([...prefix,...setup,...notes]);
 const prepared=await loader.load(bytes,{sampleDumpMappings:map});assert.equal(prepared.sampleBank.samples,0);assert.equal(prepared.diagnostics.summary.unsupported,0);assert.equal(prepared.diagnostics.summary.substituted,0,'the received preset must precede GM bank fallback');
 for(const dsp of ['js','wasm','wasm-simd']){const a=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp,effects:false}),configured=await loader.load(host,{parts:prepared.diagnostics.parts,sampleDumpMappings:map,partSettings:{'0:1':{instrument:destination}}}),b=await createSoundFontPreview(host,configured.bank,{prepared:configured,dsp,effects:false,partSettings:{'0:1':{instrument:destination}}});try{assert.equal(configured.sampleBank.samples,0);same(a.read(60000),b.read(60000),dsp);}finally{a.close();b.close();}}
});


test('a full SDS resource cache accepts identical replays without reservation and cancels genuinely new data without publishing it',()=>{
 const r=new SampleDumpReceiver({maxBytes:wave.length*8}),rows=[],reply=[],log={gmInfo(){},unsupported:(feature,data,reason)=>rows.push(reason)};r.onReply=bytes=>reply.push([...bytes]);const send=data=>r.receive(data,0,log);send(header({length:wave.length}));for(const p of packets(wave))send(p);assert.equal(r.usedBytes,wave.length*8);const pcm=r.samples.get('0:127:1').pcm;
 for(let repeat=0;repeat<3;repeat++){send(header({length:wave.length}));assert.equal(r.pendingBytes,0);for(const p of packets(wave))send(p);assert.equal(r.samples.get('0:127:1').pcm,pcm);assert.equal(r.resources.cache.size,1);assert.equal(r.usedBytes,wave.length*8);}
 send(header({length:wave.length}));send(new Uint8Array([126,127,125,0,247]));assert.equal(r.pendingBytes,0);send(header({length:wave.length}));r.resetTransfers();assert.equal(r.pendingBytes,0);
 const changed=wave.slice();changed[81]^=1;send(header({length:wave.length}));for(const p of packets(changed))send(p);assert.ok(rows.some(s=>s.includes('budget')));assert.ok(reply.some(p=>p[3]===125));assert.equal(r.samples.get('0:127:1').pcm,pcm);assert.equal(r.resources.cache.size,1);
});
