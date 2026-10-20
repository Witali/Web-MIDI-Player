import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
import {fileURLToPath}from'node:url';
import {Worker,MessageChannel}from'node:worker_threads';
import {once}from'node:events';
import {SpessaSynthProcessor,SpessaLog,MIDIUtils}from'../vendor/spessasynth.js';
import {decodeTuning,tuningFor}from'../midi-tuning.js';
import {installVoiceDSP}from'../voice-dsp.js';
import {BrowserSoundBank}from'../lazy-bank.js';
import {createSoundFontPreview}from'../soundfont-preview.js';
import {midi,midiTracks,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const message=(kind,payload,rt=true,device=127)=>new Uint8Array([rt?127:126,device,8,kind,...payload,247]);
const note=(pitch=60,hi=0,lo=0,program=0,bank=null,rt=true)=>message(bank===null?2:7,[...(bank===null?[]:[bank]),program,1,60,pitch,hi,lo],rt);
const event=(bytes,ticks=0)=>[...vlq(ticks),240,...vlq(bytes.length),...bytes],end=[0,255,47,0];
const setup=[[0,0xb0,91,0],[0,0xb0,93,0],[0,0xc0,81]],tone=[...setup,[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
async function synth(dsp='js'){const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,sys)=>prepared.bank.getPreset(p,sys);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;s.programChange(0,81);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);if(dsp!=='js')await installVoiceDSP(s,dsp);return s;}
const rpn=(s,n,value,ch=0)=>{s.controllerChange(ch,101,0);s.controllerChange(ch,100,n);s.controllerChange(ch,6,value);};
const render=(s,n)=>{const pcm=[new Float32Array(n),new Float32Array(n)];for(let at=0;at<n;at+=128)s.process(...pcm,at,Math.min(128,n-at));return pcm;};
const energy=pcm=>pcm.reduce((sum,row)=>sum+row.reduce((s,v)=>s+v*v,0),0);
const error=(a,b)=>{let d=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)d=Math.max(d,Math.abs(a[c][i]-b[c][i]));}return d;};
const same=(a,b,label='')=>assert.equal(error(a,b),0,label);
const notices=fn=>{const rows=[],old=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=old;}return rows;};
const name=Array.from('MTS test program',c=>c.charCodeAt(0)).concat(32).slice(0,16);
function dump(kind,{bank=0,program=0,data}={}){const d=[126,127,8,kind,...(kind===1?[]:[bank]),program,...name,...data];return new Uint8Array([...d,d.reduce((a,b)=>a^b,0)&127,247]);}
const frequencies=()=>Array.from({length:128},(_,n)=>[n,0,0]).flat();
const scale=(wide=false,value=0,rt=true,mask=[0,0,1])=>message(wide?9:8,[...mask,...Array.from({length:12},()=>wide?[(8192+value)>>7,(8192+value)&127]:[64+value]).flat()],rt);

// Updated MTS pp.1-3: 14-bit semitone fraction and all-7F no-change sentinel.
test('MTS frequency words retain the exact fraction, legal endpoints and no-change semantics',async()=>{
 assert.equal(decodeTuning(60,0,1),60+1/16384);assert.equal(decodeTuning(69,0,0),69);assert.equal(decodeTuning(127,127,126),127+16382/16384);assert.equal(decodeTuning(127,127,127),null);
 const s=await synth();s.systemExclusive(note(60,64,1));assert.equal(s.synthCore.tunings[60],60+8193/16384);s.systemExclusive(note(127,127,127));assert.equal(s.synthCore.tunings[60],60+8193/16384);s.systemExclusive(message(2,[0,3,60,61,0,0,60,62,0,0,61,63,0,0]));assert.equal(s.synthCore.tunings[60],62);assert.equal(s.synthCore.tunings[61],63);
});

test('banked and legacy dumps decode every key/name, preserve no-change entries and validate the defined checksums',async()=>{
 const s=await synth(),core=s.synthCore;const data=frequencies();data.splice(60*3,3,60,64,1);s.systemExclusive(dump(4,{bank:3,program:5,data}));const stored=core.tuningPrograms.get(3*128+5);assert.equal(stored.name,'MTS test program');assert.equal(stored.values[60],60+8193/16384);
 const bad=dump(4,{bank:3,program:5,data});bad[bad.length-2]^=1;assert.ok(notices(()=>s.systemExclusive(bad)).some(r=>r.reason?.includes('checksum')));assert.equal(stored.values[60],60+8193/16384);
 data.splice(60*3,3,127,127,127);s.systemExclusive(dump(4,{bank:3,program:5,data}));assert.equal(stored.values[60],60+8193/16384);const legacy=dump(1,{program:7,data:frequencies()});legacy[legacy.length-2]^=15;assert.ok(notices(()=>s.systemExclusive(legacy)).every(r=>r.kind==='implemented'),'p.6 permits ignoring the ambiguous original01 checksum');assert.equal(core.tunings[7*128+60],60);
});

test('scale dumps store all octaves including negative low-key frequencies and full two-byte precision',async()=>{
 const s=await synth(),core=s.synthCore;for(const [kind,data]of [[5,[0,...Array(11).fill(64)]],[6,[0,0,...Array(11).fill([64,1]).flat()]]]){
  s.systemExclusive(dump(kind,{bank:2,program:kind,data}));const row=core.tuningPrograms.get(2*128+kind);assert.equal(row.values[0],kind===5?-.64:-1);assert.equal(row.values[12],kind===5?11.36:11);if(kind===6)assert.equal(row.values[61],61+1/8192);
 }
 rpn(s,4,2);rpn(s,3,6);assert.equal(tuningFor(core,s.midiChannels[0],0),-1,'a legitimate negative scale frequency is not the absent-entry sentinel');
});

test('tuning program and bank RPNs are independent of timbre/bank selection and use MSB increment/decrement steps',async()=>{
 assert.equal(MIDIUtils.analyzeRPN(0,3,5<<7).parameter,'tuningProgram');assert.equal(MIDIUtils.analyzeRPN(0,4,2<<7).value,2);assert.deepEqual(MIDIUtils.setChannelMIDIParameter(0,0,'gm','tuningProgram',5).slice(-2).map(e=>[...e.data]),[[6,5],[38,0]]);
 const s=await synth(),ch=s.midiChannels[0];for(const [bank,program,pitch]of [[0,0,60],[0,1,61],[2,0,62],[2,1,63]])s.systemExclusive(note(pitch,0,0,program,bank,false));
 rpn(s,3,1);assert.equal(ch.midiParameters.tuningProgram,1);s.programChange(0,80);assert.equal(tuningFor(s.synthCore,ch,60),61);s.controllerChange(0,0,1);s.controllerChange(0,32,1);assert.equal(ch.midiParameters.tuningBank,0);
 rpn(s,4,2);assert.equal(tuningFor(s.synthCore,ch,60),63);rpn(s,3,0);s.controllerChange(0,96,127);assert.equal(ch.midiParameters.tuningProgram,1);s.controllerChange(0,97,0);assert.equal(ch.midiParameters.tuningProgram,0);rpn(s,3,127);assert.equal(ch.midiParameters.tuningProgram,0,'undefined programs ignored');rpn(s,4,127);assert.equal(ch.midiParameters.tuningBank,2,'undefined banks ignored');
 s.controllerChange(0,121,0);assert.equal(ch.midiParameters.tuningBank,2);assert.equal(ch.midiParameters.tuningProgram,0);assert.equal(tuningFor(s.synthCore,ch,60),62);
});

test('Real-Time changes retune held/released voices in place; Non-Real-Time changes affect only future notes',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);s.noteOn(0,60,100);render(s,1024);const old=s.synthCore.voices.filter(v=>v.isActive),clocks=old.map(v=>[v.startTime,v.wavetable.cursor,v.noteID]);s.systemExclusive(note(60,64,0,0,0,false));assert.ok(old.every(v=>v.mtsTuning===null));s.controllerChange(0,101,0);s.controllerChange(0,100,3);s.controllerChange(0,38,127);assert.ok(old.every(v=>v.mtsTuning===null),'LSB cannot reload a 7-bit tuning program');s.noteOn(0,60,90);const fresh=s.synthCore.voices.filter(v=>v.isActive&&!old.includes(v));assert.ok(fresh.length>0&&fresh.every(v=>v.mtsTuning===60.5));
  s.noteOff(0,60);render(s,128);s.systemExclusive(note(60,96,0,0,0,true));assert.ok(s.synthCore.voices.filter(v=>v.isActive).every(v=>v.mtsTuning===60.75));old.forEach((v,i)=>{assert.equal(v.startTime,clocks[i][0]);assert.equal(v.noteID,clocks[i][2]);assert.notEqual(v.wavetable.cursor,0);});s.stopAllChannels(true);
 }
});

test('real PCM of an instantaneous half-semitone retune matches independent channel fine tuning on all DSPs',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp);a.noteOn(0,60,100);b.noteOn(0,60,100);same(render(a,2048),render(b,2048));a.systemExclusive(note(60,64,0));b.midiChannels[0].setMIDIParameter('fineTune',50);const actual=render(a,12000),expected=render(b,12000);assert.ok(energy(actual)>1);same(actual,expected,dsp);a.stopAllChannels(true);b.stopAllChannels(true);}
});

test('successive sub-cent MTS and two-byte scale steps update the live pitch ratio without integer-cent caching',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);s.noteOn(0,60,100);render(s,128);const voices=s.synthCore.voices.filter(v=>v.isActive),base=voices.map(v=>v.tuningRatio);
  for(const value of [1,2,3]){s.systemExclusive(note(60,0,value));render(s,128);voices.forEach((v,i)=>assert.ok(Math.abs(v.tuningRatio/base[i]-2**(value/16384/12))<1e-12,dsp));}
  s.systemExclusive(scale(true,1));render(s,128);voices.forEach((v,i)=>assert.ok(Math.abs(v.tuningRatio/base[i]-2**((3/16384+1/8192)/12))<1e-12,dsp));s.stopAllChannels(true);
 }
});

test('direct scale offsets add to the selected preset, replace prior offsets, respect all channel-mask bits and Non-Real-Time rules',async()=>{
 const s=await synth();s.noteOn(0,60,100);render(s,128);const held=s.synthCore.voices.filter(v=>v.isActive);s.systemExclusive(scale(false,25,false));assert.ok(held.every(v=>v.mtsScale===0));s.noteOn(0,60,90);assert.ok(s.synthCore.voices.filter(v=>v.isActive&&!held.includes(v)).every(v=>v.mtsScale===25));s.systemExclusive(scale(false,30));assert.ok(s.synthCore.voices.filter(v=>v.isActive).every(v=>v.mtsScale===30));s.systemExclusive(scale(false,30));assert.equal(s.midiChannels[0].mtsScale[0],30,'absolute offsets, not cumulative');
 s.systemExclusive(scale(false,-10,true,[3,65,65]));for(const n of [0,6,7,13,14,15])assert.equal(s.midiChannels[n].mtsScale[0],-10);for(const n of [1,5,8,12])assert.equal(s.midiChannels[n].mtsScale[0],0);s.stopAllChannels(true);
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp);a.systemExclusive(note(60,64,0));a.systemExclusive(scale(false,25));b.midiChannels[0].setMIDIParameter('fineTune',75);a.noteOn(0,60,100);b.noteOn(0,60,100);same(render(a,12000),render(b,12000),dsp+' preset plus scale');a.stopAllChannels(true);b.stopAllChannels(true);}
});

test('malformed tuning records, counts, dump header/checksum, masks and unknown commands leave all state unchanged',async()=>{
 const s=await synth();s.systemExclusive(note(60,64,0));const invalid=[message(2,[0,2,60,61,0,0]),message(2,[0,1,60,61,0,128]),message(2,[0,1,60,61,0,0],false),note().slice(0,-1),message(4,[0,0,...name,...frequencies(),0],true),scale(false,10,true,[4,0,1]),scale(true).slice(0,-2),message(99,[])];
 for(const data of invalid){assert.ok(notices(()=>s.systemExclusive(data)).some(r=>r.kind!=='implemented'),[...data].join());assert.equal(s.synthCore.tunings[60],60.5);assert.ok(s.midiChannels[0].mtsScale.every(v=>v===0));assert.equal(s.synthCore.tuningPrograms.size,1);}
 for(const kind of [0,3])assert.ok(notices(()=>s.systemExclusive(message(kind,kind===0?[0]:[0,0],false))).some(r=>r.reason?.includes('MIDI output')));
 s.setSystemParameter('deviceID',16);s.systemExclusive(message(2,[0,1,60,65,0,0],true,15));assert.equal(s.synthCore.tunings[60],60.5);
});

test('ordinary snapshots retain tuning banks, program selection and fractional channel offsets; full reset restores defaults',async()=>{
 const s=await synth();s.systemExclusive(note(61,64,1,3,2,false));rpn(s,4,2);rpn(s,3,3);s.systemExclusive(scale(true,1));const snap=s.getSnapshot();s.systemExclusive(note(70,0,0,3,2,false));s.systemExclusive(scale(false,50));s.applySnapshot(snap);assert.equal(s.midiChannels[0].midiParameters.tuningBank,2);assert.equal(s.midiChannels[0].midiParameters.tuningProgram,3);assert.equal(tuningFor(s.synthCore,s.midiChannels[0],60),61+8193/16384);assert.equal(s.midiChannels[0].mtsScale[0],100/8192);
 s.systemExclusive(new Uint8Array([126,127,9,1,247]));assert.equal(s.synthCore.tuningPrograms.size,0);assert.equal(s.midiChannels[0].midiParameters.tuningProgram,0);assert.equal(s.midiChannels[0].midiParameters.tuningBank,0);assert.ok(s.midiChannels[0].mtsScale.every(v=>v===0));assert.ok(s.synthCore.tunings.every(Number.isNaN));
});

test('MTS program changes preserve legato note identities, envelope clocks and sample phase',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const s=await synth(dsp);s.systemExclusive(note(60,64,0,1,0,false));s.controllerChange(0,68,127);s.noteOn(0,60,100);render(s,1024);const old=s.synthCore.voices.filter(v=>v.isActive),start=old.map(v=>v.startTime);rpn(s,3,1);old.forEach((v,i)=>{assert.equal(v.mtsTuning,60.5);assert.equal(v.startTime,start[i]);assert.ok(v.wavetable.cursor>0);});s.noteOn(0,62,100);assert.ok(old.every(v=>v.midiNote===62&&v.mtsTuning===null));s.noteOff(0,62);assert.ok(old.every(v=>v.midiNote===60&&v.mtsTuning===60.5));s.stopAllChannels(true);
  s.systemExclusive(note(62,64,0,1,0,false));rpn(s,3,1);s.noteOn(0,60,100);render(s,128);const shifted=s.synthCore.voices.filter(v=>v.isActive);assert.ok(shifted.every(v=>v.targetKey===60&&v.mtsTuning===62.5));s.noteOn(0,67,100);assert.ok(shifted.every(v=>v.targetKey===67&&v.mtsTuning===null),'legato must not retain the old sample-selection offset');s.noteOff(0,67);assert.ok(shifted.every(v=>v.targetKey===60&&v.mtsTuning===62.5));s.stopAllChannels(true);}
});

const complete=note(60,32,1,1,2,true),score=midi([...setup,event(note(60,64,0,1,2,false)),[0,0xb0,101,0],[0,0xb0,100,4],[0,0xb0,6,2],[0,0xb0,100,3],[0,0xb0,6,1],[0,0x90,60,100],event(scale(true,1),120),event(note(60,96,0,1,2,false),120),[0,0x90,60,90],[0,0xb0,64,127],[120,0x80,60,64],[120,0xb0,6,0],event(note(60,16,1)),[120,0xf0,6,...complete.slice(0,6)],[120,0xf7,...vlq(complete.length-6),...complete.slice(6)],[0,0x80,60,64],[0,0xb0,64,0],[...vlq(480),255,47,0]]);
test('ordered MTS events, NRT voice snapshots, banks, F0/F7 and pedals restore exact checkpoints/seek on all DSPs',async()=>{
 const prepared=await loader.load(score);for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp,effects:false});try{assert.equal(p.stats.diagnostics.summary.unsupported,0,JSON.stringify(p.stats.diagnostics.entries));assert.equal(p.stats.diagnostics.summary.unverified,0);const pcm=p.read(144000);assert.ok(energy(pcm)>1);for(const frame of [1001,18001,36001]){await p.seek(frame/48000);const saved=p.capture(),actual=p.read(36001);same(actual,pcm.map(row=>row.slice(frame,frame+36001)),dsp);saved.restore();same(p.read(36001),actual);}}finally{p.close();}}
});

test('direct Scale/Octave follows the source port and receive routing while tuning memory remains device-wide',async()=>{
 const s=await synth();s.midiChannels[2].setMIDIParameter('rxChannel',-1);s.midiChannels[0].setMIDIParameter('rxChannel',2);s.synthCore.customChannelNumbers=true;s.noteOn(2,60,100);s.systemExclusive(scale(false,25,true,[0,0,4]));assert.equal(s.midiChannels[0].mtsScale[0],25);assert.equal(s.midiChannels[2].mtsScale[0],0);assert.ok(s.synthCore.voices.filter(v=>v.isActive).every(v=>v.mtsScale===25));s.stopAllChannels(true);
 const bytes=midiTracks([[...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],end],[[0,255,33,1,7],event(scale(false,50)),[...vlq(480),255,47,0]]]),plain=midi([...setup,[0,0x90,60,100],[...vlq(480),0x80,60,64],end]);const p=await createSoundFontPreview(bytes,prepared.bank,{effects:false}),q=await createSoundFontPreview(plain,prepared.bank,{effects:false});try{same(p.read(60000),q.read(60000));}finally{p.close();q.close();}
});

test('actual Worker selective sample preparation uses tuned keys and returns exact tuned PCM after seeking',async()=>{
 const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;const call=async(type,data)=>{const wait=once(worker,'message');worker.postMessage({type,id:++id,...data});const response=(await wait)[0];assert.equal(response.error,undefined);return response.result;};const prepared=await loader.load(score),reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm',effects:false});
 try{const loaded=await call('load',{bytes:score,epoch:1,dsp:'wasm',effects:false});assert.equal(loaded.diagnostics.summary.unsupported,0);assert.equal(loaded.sampleBank.mode,'samples');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);for(const [epoch,seconds]of [[2,.31],[3,.71],[4,.01]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const wait=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});same((await wait)[0].channels,reference.read(2048));}}finally{reference.close();channel.port1.close();await worker.terminate();}
});
