import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath}from'node:url';
import {Worker,MessageChannel}from'node:worker_threads';
import {once}from'node:events';
import {SpessaSynthProcessor,SpessaLog}from'../vendor/spessasynth.js';
import {BrowserSoundBank}from'../lazy-bank.js';
import {createSoundFontPreview}from'../soundfont-preview.js';
import {installXGVariation}from'../xg-variation.js';
import {installVoiceDSP}from'../voice-dsp.js';
import {midi,midiTracks,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const sysex=(a,b,c,data)=>new Uint8Array([0x43,0x10,0x4c,a,b,c,...data,0xf7]);
const slot=(n,a,data)=>sysex(3,n,a,data),variation=(a,data)=>sysex(2,1,a,data),part=(n,a,data)=>sysex(8,n,a,data);
const parameter=(n,p,v,wide=true)=>slot(n,p>10?0x20+p-11:wide?0x30+(p-1)*2:p+1,p<=10&&wide?[v>>7,v&127]:[v]);
const vp=(p,v)=>variation(p<=10?0x42+(p-1)*2:0x70+p-11,p<=10?[v>>7,v&127]:[v]);
const event=(data,t=0)=>[...vlq(t),0xf0,...vlq(data.length),...data],end=[0,255,47,0],reset=sysex(0,0,0x7e,[0]);
const neutral=[[0,0xb0,7,127],[0,0xb0,39,127],[0,0xb0,11,127],[0,0xb0,43,127],[0,0xb0,10,64],[0,0xb0,91,0],[0,0xb0,93,0]];
const tone=[...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const base=[event(reset),event(variation(0,[0,0])),event(variation(0x20,[0,0]))];
const delay=(n,time=100)=>[slot(n,0,[6,0]),...[1,2,3,4].map(p=>parameter(n,p,time)),...[[5,64],[6,10],[10,127],[13,28],[14,64],[15,46],[16,64]].map(([p,v])=>parameter(n,p,v)),slot(n,12,[0])];
const drive=n=>[slot(n,0,[0x49,0]),...[[1,100],[2,28],[3,64],[4,36],[5,64],[7,40],[8,64],[9,10],[10,127],[11,100]].map(([p,v])=>parameter(n,p,v,false)),slot(n,12,[0])];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
async function synth(dsp='js',bank=prepared.bank){const s=new SpessaSynthProcessor(48000,{effectsEnabled:true,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,sys)=>bank.getPreset(p,sys);s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;installXGVariation(s);for(const cmd of [reset,variation(0,[0,0]),variation(0x20,[0,0])])s.systemExclusive(cmd);for(const e of neutral)s.controllerChange(0,e[2],e[3]);s.programChange(0,81);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);if(dsp!=='js')await installVoiceDSP(s,dsp);return s;}
function render(s,n){const out=[new Float32Array(n),new Float32Array(n)];for(let at=0;at<n;at+=128)s.process(...out,at,Math.min(128,n-at));return out;}
const energy=a=>a.reduce((sum,r)=>sum+r.reduce((s,v)=>s+v*v,0),0);
const error=(a,b)=>{let e=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)e=Math.max(e,Math.abs(a[c][i]-b[c][i]));}return e;};
const same=(a,b,label='')=>assert.equal(error(a,b),0,label);
const notices=fn=>{const rows=[],old=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=old;}return rows;};

// Independently transcribed MU100 pp.43-45: both Effect2 defaults, address
// forms, ignored alternative forms, partial writes and family-specific limits.
test('both Effect2 slots use published defaults and receive only the parameter representation specified for their type',async()=>{
 const s=await synth(),slots=s.synthCore.xgInsertion.slots;
 for(let n=0;n<2;n++){const fx=slots[n];assert.equal(fx.type,0x4900);assert.equal(fx.raw[12],127);assert.deepEqual([...fx.raw.slice(13,18)],[64,64,64,64,64]);assert.deepEqual([...fx.parameters],[40,20,72,53,64,0,43,74,10,127,120,0,0,0,0,0]);
  s.systemExclusive(parameter(n,1,127));assert.equal(fx.parameters[0],40,'wide representation ignored for drive');s.systemExclusive(parameter(n,1,80,false));assert.equal(fx.parameters[0],80);
  s.systemExclusive(slot(n,0,[6,0]));s.systemExclusive(parameter(n,1,20,false));assert.equal(fx.parameters[0],2500,'small representation ignored for delay');s.systemExclusive(slot(n,0x30,[15,80,31,32]));assert.equal(fx.parameters[0],2000);assert.equal(fx.parameters[1],4000);
  s.systemExclusive(slot(n,0x31,[81]));s.systemExclusive(slot(n,0x30,[16]));assert.equal(fx.parameters[0],2129);
  const bad=notices(()=>s.systemExclusive(parameter(n,1,7430)));assert.equal(bad.length,1);assert.notEqual(bad[0].kind,'implemented');assert.equal(fx.parameters[0],2129);
  s.systemExclusive(parameter(n,1,7429));assert.equal(fx.parameters[0],7429);s.systemExclusive(slot(n,0,[7,0]));const badEcho=notices(()=>s.systemExclusive(parameter(n,1,3715)));assert.notEqual(badEcho[0].kind,'implemented');s.systemExclusive(parameter(n,1,3714));assert.equal(fx.parameters[0],3714);
  s.systemExclusive(slot(n,0,[1,0]));s.systemExclusive(parameter(n,12,2));const density=notices(()=>s.systemExclusive(parameter(n,12,3)));assert.notEqual(density[0].kind,'implemented');assert.equal(fx.parameters[11],2);
 }
});

test('Effect2 consumes ordered type/parameter/part/depth records and rejects malformed, reserved and analogue destinations',async()=>{
 const s=await synth(),fx=s.synthCore.xgInsertion.slots[0];
 const rows=notices(()=>s.systemExclusive(slot(0,0,[0x49,0,90,28,64,36,64,0,40,64,10,127,1,0,127,32,96,64])));
 assert.ok(rows.every(r=>r.kind==='implemented'),JSON.stringify(rows));assert.equal(fx.parameters[0],90);assert.equal(fx.raw[12],1);assert.deepEqual([...fx.raw.slice(13,18)],[0,127,32,96,64]);
 const before=[...fx.raw],p=[...fx.parameters];for(const message of [slot(0,2,[12,128]),slot(0,2,[]),slot(0,2,[12]).slice(0,-1)]){const result=notices(()=>s.systemExclusive(message));assert.ok(result.some(r=>r.kind!=='implemented'));assert.deepEqual([...fx.raw],before);assert.deepEqual([...fx.parameters],p);}
 for(const message of [slot(2,0,[0x49,0]),slot(0,12,[64]),slot(0,18,[1])])assert.ok(notices(()=>s.systemExclusive(message)).some(r=>r.kind!=='implemented'));
 assert.equal(fx.raw[12],1);const unknown=notices(()=>s.systemExclusive(slot(0,0,[0x49,1])));assert.equal(fx.mode,'thru');assert.ok(unknown.some(r=>r.reason?.includes('Thru')));
 s.systemExclusive(slot(0,0,[0x40,0]));assert.ok(notices(()=>s.systemExclusive(slot(0,2,[80]))).every(r=>r.kind==='implemented'));
});

test('two inserted stereo delays and Variation form the documented serial path with independent delayed PCM on every DSP',async()=>{
 const settings=[...delay(0,100),...delay(1,200),variation(0x40,[6,0]),...[1,2,3,4].map(p=>vp(p,300)),...[[5,64],[6,10],[10,127],[13,28],[14,64],[15,46],[16,64]].map(([p,v])=>vp(p,v)),variation(0x5a,[0,0])];
 for(const dsp of ['js','wasm','wasm-simd']){const a=await createSoundFontPreview(midi([...base,...settings.map(c=>event(c)),...tone]),prepared.bank,{dsp}),b=await createSoundFontPreview(midi([...base,...tone]),prepared.bank,{dsp,effects:false});try{assert.equal(a.stats.diagnostics.summary.unsupported,0);assert.equal(a.stats.diagnostics.summary.unverified,0);const actual=a.read(60000),dry=b.read(60000),expected=dry.map(row=>Float32Array.from(row,(_,i)=>i>=2880?row[i-2880]:0));assert.ok(error(actual,expected)<1e-6,dsp+' max '+error(actual,expected));}finally{a.close();b.close();}}
});

test('serial slot order is audible with nonlinear drive and feedback; separate part assignments cannot affect another part',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp);for(const c of [...drive(0),...delay(1),parameter(1,5,110)])a.systemExclusive(c);for(const c of [...delay(0),parameter(0,5,110),...drive(1)])b.systemExclusive(c);a.noteOn(0,60,100);b.noteOn(0,60,100);assert.ok(error(render(a,12000),render(b,12000))>1e-3,dsp);a.stopAllChannels(true);b.stopAllChannels(true);
  const c=await synth(dsp),d=await synth(dsp);for(const cmd of [...drive(0),...delay(1),slot(0,12,[1]),slot(1,12,[2])])c.systemExclusive(cmd);c.noteOn(0,60,100);d.noteOn(0,60,100);same(render(c,10000),render(d,10000));c.stopAllChannels(true);d.stopAllChannels(true);
 }
});

const sources=[s=>s.controllerChange(0,1,127),s=>s.pitchWheel(0,16383),s=>s.channelPressure(0,127),s=>s.controllerChange(0,20,127),s=>s.controllerChange(0,21,127)];
test('all five XG effect control sources target Drive or Dry/Wet and preserve base parameters, with per-part AC assignments',async()=>{
 for(const type of [1,6,0x41,0x49])for(const which of [0,1,'variation'])for(let source=0;source<5;source++){
  const s=await synth(),isVariation=which==='variation',fx=isVariation?s.synthCore.xgVariation:s.synthCore.xgInsertion.slots[which],p=type===0x49?1:10;
  for(const cmd of [part(0,0x59,[20]),part(0,0x60,[21]),isVariation?variation(0x40,[type,0]):slot(which,0,[type,0]),isVariation?variation(0x5a,[0,0]):slot(which,12,[0]),isVariation?vp(p,40):parameter(which,p,40,type===6),isVariation?variation(0x5c+source,[127]):slot(which,13+source,[127])])s.systemExclusive(cmd);
  const raw=[...fx.raw],base=[...fx.parameters];render(s,128);assert.equal(fx.processor.parameters[p-1],40);sources[source](s);render(s,128);assert.equal(fx.processor.parameters[p-1],127,`type ${type} slot ${which} source ${source}`);assert.deepEqual([...fx.parameters],base);assert.deepEqual([...fx.raw],raw);
  if(!isVariation)assert.equal(fx.bypassProcessor.parameters[p-1],127);
 }
 const s=await synth();const result=notices(()=>s.systemExclusive(part(0,0x59,[96])));assert.notEqual(result[0].kind,'implemented');assert.equal(s.midiChannels[0].xgAC1,16);
});

test('controller depths have signed centre, do not listen to other parts, and are inactive for System Variation',async()=>{
 const s=await synth();for(const c of [...delay(0),parameter(0,10,64),slot(0,13,[0])])s.systemExclusive(c);const fx=s.synthCore.xgInsertion.slots[0];s.controllerChange(1,1,127);render(s,128);assert.equal(fx.processor.parameters[9],64);s.controllerChange(0,1,127);render(s,128);assert.equal(fx.processor.parameters[9],1);s.systemExclusive(slot(0,13,[64,127]));s.pitchWheel(0,0);render(s,128);assert.equal(fx.processor.parameters[9],1);s.pitchWheel(0,8192);render(s,128);assert.equal(fx.processor.parameters[9],64);
 for(const c of [variation(0x40,[6,0]),vp(10,40),variation(0x5a,[0,0]),variation(0x5c,[127])])s.systemExclusive(c);render(s,128);assert.equal(s.synthCore.xgVariation.processor.parameters[9],127);s.systemExclusive(variation(0x5a,[1]));render(s,128);assert.equal(s.synthCore.xgVariation.processor.parameters[9],40,'system connection must restore base value');
});

test('controller modulation changes a stored wet tail without sounding voices on every DSP',async()=>{
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp),b=await synth(dsp);for(const s of [a,b]){for(const c of [...delay(0,1000),parameter(0,5,110),parameter(0,10,1),slot(0,15,[127])])s.systemExclusive(c);s.noteOn(0,60,100);render(s,512);s.stopAllChannels(true);assert.ok(!s.synthCore.voices.some(v=>v.isActive));render(s,512);}a.channelPressure(0,127);const on=render(a,12000),off=render(b,12000);assert.ok(energy(on)>.001,dsp);assert.equal(energy(off),0);assert.equal(a.synthCore.xgInsertion.slots[0].parameters[9],1);}
});

test('per-drum Variation OFF survives preceding nonlinear insertion; Thru and effects:false retain their defined PCM',async()=>{
 const bytes=midi([event(reset),[0,0x99,42,100],[...vlq(240),0x89,42,64],end]),drum=await loader.load(bytes);
 for(const dsp of ['js','wasm','wasm-simd']){const a=await synth(dsp,drum.bank),b=await synth(dsp,drum.bank),c=await synth(dsp,drum.bank);for(const s of [a,b,c]){for(const cmd of [...drive(0),slot(0,12,[9]),variation(0x40,[0,0]),variation(0x5a,[0,9])])s.systemExclusive(cmd);for(const [cc,v]of [[99,31],[98,42],[6,0],[91,0],[93,0]])s.controllerChange(9,cc,v);}b.systemExclusive(variation(0x40,[0x40,0]));c.controllerChange(9,6,127);for(const s of [a,b,c])s.noteOn(9,42,100);const actual=render(a,8000),reference=render(b,8000),muted=render(c,8000);assert.ok(energy(actual)>.001);assert.ok(error(actual,reference)<1e-7,dsp);assert.equal(energy(muted),0);for(const s of [a,b,c])s.stopAllChannels(true);}
 for(const dsp of ['js','wasm','wasm-simd']){const x=await createSoundFontPreview(midi([...base,...drive(0).map(c=>event(c)),...tone]),prepared.bank,{dsp,effects:false}),y=await createSoundFontPreview(midi([...base,...tone]),prepared.bank,{dsp,effects:false});try{same(x.read(40000),y.read(40000));}finally{x.close();y.close();}}
});

test('XG System On preserves Effect2 settings while All Parameter Reset restores the published defaults; malformed resets do neither',async()=>{
 const s=await synth(),fx=s.synthCore.xgInsertion.slots[0];for(const c of [...delay(0),slot(0,13,[127])])s.systemExclusive(c);s.noteOn(0,60,100);render(s,1024);const raw=[...fx.raw];s.systemExclusive(reset);assert.deepEqual([...fx.raw],raw);assert.ok(fx.processor.left.every(v=>v===0));assert.ok(fx.bypassProcessor.left.every(v=>v===0));
 for(const c of [sysex(0,0,0x7f,[1]),sysex(0,0,0x7f,[0,0])]){assert.ok(notices(()=>s.systemExclusive(c)).some(r=>r.kind!=='implemented'));assert.deepEqual([...fx.raw],raw);}s.systemExclusive(sysex(0,0,0x7f,[0]));assert.equal(fx.type,0x4900);assert.equal(fx.raw[12],127);assert.equal(fx.parameters[0],40);assert.deepEqual([...fx.raw.slice(13,18)],[64,64,64,64,64]);
});

test('Effect2 assignment follows the source MIDI port and receive-part controls instead of affecting the same channel on another port',async()=>{
 const bytes=midiTracks([[...base,...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(480),0x80,60,64],end],[[0,255,33,1,7],...drive(0).map(c=>event(c)),event(part(0,4,[2])),event(part(2,4,[127])),[0,0xb2,7,0],[0,0xc2,81],[0,0x92,67,100],[...vlq(480),0x82,67,64],end]]);
 const plain=midi([...base,...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(480),0x80,60,64],end]),prepared=await loader.load(bytes);
 for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(plain,prepared.bank,{dsp});try{assert.equal(p.stats.diagnostics.summary.unsupported,0);same(p.read(60000),q.read(60000),dsp);}finally{p.close();q.close();}}
});

const split=parameter(1,1,1500),score=midi([...base,...drive(0).map(c=>event(c)),...delay(1).map(c=>event(c)),event(slot(0,15,[127])),...neutral,[0,0xc0,81],[0,0x90,60,100],[60,0xb0,69,127],[60,0xd0,100],[60,0xf0,8,...split.slice(0,8)],[60,0xf7,...vlq(split.length-8),...split.slice(8)],[60,0xb0,7,0],[0,0x80,60,100],[60,0xb0,69,0],[60,0xb0,7,127],event(slot(0,0,[0x41,0]),120),event(parameter(0,10,100,false)),[...vlq(1440),255,47,0]]);
test('both slot histories and effective controllers restore exact PCM across F0/F7, live types, Hold2, seeks and checkpoints on all DSPs',async()=>{
 const prepared=await loader.load(score);for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp});try{assert.equal(p.stats.diagnostics.summary.unsupported,0,JSON.stringify(p.stats.diagnostics.entries));assert.equal(p.stats.diagnostics.summary.unverified,0);const expected=p.read(144000);assert.ok(energy(expected)>1);for(const frame of [1001,18001,36001]){await p.seek(frame/48000);const saved=p.capture(),actual=p.read(48001);same(actual,expected.map(row=>row.slice(frame,frame+48001)),dsp);saved.restore();same(p.read(48001),actual);}}finally{p.close();}}
});

test('real Worker loads Effect2 samples and restores exact PCM through selective loading',async()=>{
 const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const response=(await pending)[0];assert.equal(response.error,undefined);return response.result;};const prepared=await loader.load(score),reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm'});
 try{const loaded=await call('load',{bytes:score,epoch:1,effects:true,dsp:'wasm'});assert.equal(loaded.diagnostics.summary.unsupported,0);assert.equal(loaded.sampleBank.mode,'samples');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);for(const [epoch,seconds]of [[2,.31],[3,.71],[4,.01]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});same((await pending)[0].channels,reference.read(2048));}}finally{reference.close();channel.port1.close();await worker.terminate();}
});
