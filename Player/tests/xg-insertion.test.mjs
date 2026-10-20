import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath}from'node:url';
import {Worker,MessageChannel}from'node:worker_threads';
import {once}from'node:events';
import {SpessaSynthProcessor,SpessaLog,GeneratorTypes}from'../vendor/spessasynth.js';
import {BrowserSoundBank}from'../lazy-bank.js';
import {createSoundFontPreview}from'../soundfont-preview.js';
import {installXGVariation}from'../xg-variation.js';
import {installVoiceDSP}from'../voice-dsp.js';
import {midi,midiTracks,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const sysex=(a1,a2,a3,data)=>new Uint8Array([0x43,0x10,0x4c,a1,a2,a3,...data,0xf7]);
const packet=(a,data)=>sysex(2,1,a,data),part=(n,a,data)=>sysex(8,n,a,data);
const parameter=(p,value)=>packet(p<=10?0x42+(p-1)*2:0x70+p-11,p<=10?[value>>7,value&127]:[value]);
const event=(data,ticks=0)=>[...vlq(ticks),0xf0,...vlq(data.length),...data];
const reset=sysex(0,0,0x7e,[0]),end=[0,255,47,0];
const neutral=[[0,0xb0,7,127],[0,0xb0,39,127],[0,0xb0,11,127],[0,0xb0,43,127],[0,0xb0,10,64],[0,0xb0,91,0],[0,0xb0,93,0]];
const tone=[...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const base=[event(reset),event(packet(0,[0,0])),event(packet(0x20,[0,0]))];
const settings=[[1,1000],[2,1000],[3,1000],[4,1000],[5,64],[6,10],[10,127],[13,28],[14,64],[15,46],[16,64]];
const setup=[...base,event(packet(0x40,[6,0])),...settings.map(([p,v])=>event(parameter(p,v))),event(packet(0x5a,[0,0]))];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
async function synth(dsp='js',insert=true,bank=prepared.bank){
  const s=new SpessaSynthProcessor(48000,{effectsEnabled:true,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,system)=>bank.getPreset(p,system);s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;installXGVariation(s);
  for(const command of [reset,packet(0,[0,0]),packet(0x20,[0,0]),...(insert?[packet(0x40,[6,0]),...settings.map(([p,v])=>parameter(p,v)),packet(0x5a,[0,0])]:[])])s.systemExclusive(command);
  for(const [cc,value]of [[7,127],[39,127],[11,127],[43,127],[10,64],[91,0],[93,0]])s.controllerChange(0,cc,value);s.programChange(0,81);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);
  if(dsp!=='js')await installVoiceDSP(s,dsp);return s;
}
function render(s,n){const out=[new Float32Array(n),new Float32Array(n)];for(let at=0;at<n;at+=128)s.process(...out,at,Math.min(128,n-at));return out;}
const energy=pcm=>pcm.reduce((sum,row)=>sum+row.reduce((s,n)=>s+n*n,0),0);
const error=(a,b)=>{let d=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)d=Math.max(d,Math.abs(a[c][i]-b[c][i]));}return d;};
const same=(a,b,label='')=>assert.equal(error(a,b),0,label);
const notices=fn=>{const rows=[],old=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=old;}return rows;};

// MU100 Owner pp.136-141: Insertion is before part volume/expression/pan,
// uses Dry/Wet, and ignores the System-only Variation return/pan/sends.
test('wet-only insertion delay matches an independent delayed dry PCM reference on JS, WASM and SIMD',async()=>{
  const wet=midi([...setup,...tone]),dry=midi([...base,...tone]);
  for(const dsp of ['js','wasm','wasm-simd']){const a=await createSoundFontPreview(wet,prepared.bank,{dsp}),b=await createSoundFontPreview(dry,prepared.bank,{dsp,effects:false});
    try{assert.equal(a.stats.diagnostics.summary.unsupported,0);assert.equal(a.stats.diagnostics.summary.unverified,0);const actual=a.read(60000),source=b.read(60000);let difference=0;
      for(let c=0;c<2;c++)for(let i=0;i<60000;i++)difference=Math.max(difference,Math.abs(actual[c][i]-(i>=4800?source[c][i-4800]:0)));assert.ok(difference<1e-6,dsp+' maximum '+difference);
    }finally{a.close();b.close();}}
});

test('volume/expression/pan and host gain alter an already stored tail, while neutral instrument input and voices continue',async()=>{
  for(const dsp of ['js','wasm','wasm-simd']){
    const a=await synth(dsp),b=await synth(dsp);for(const s of [a,b]){s.systemExclusive(parameter(5,110));s.noteOn(0,60,100);}
    render(a,512);render(b,512);a.controllerChange(0,7,0);a.controllerChange(0,11,0);a.controllerChange(0,10,127);a.midiChannels[0].setSystemParameter('gain',.5);
    const muted=render(a,7000),reference=render(b,7000);assert.equal(energy(muted),0);assert.ok(energy(reference)>.001);assert.ok(a.synthCore.voices.some(v=>v.isActive));
    assert.equal(a.midiChannels[0].midiControllers[7],0);assert.equal(a.midiChannels[0].midiControllers[11],0);
    same([a.synthCore.xgVariation.processor.left,a.synthCore.xgVariation.processor.right],[b.synthCore.xgVariation.processor.left,b.synthCore.xgVariation.processor.right],'part controls must not enter the feedback input');
    for(const [cc,v]of [[7,127],[39,127],[11,127],[43,127],[10,64]])a.controllerChange(0,cc,v);a.midiChannels[0].setSystemParameter('gain',1);
    assert.ok(error(render(a,4000),render(b,4000))<1e-6,dsp+' unmuted prefix');a.stopAllChannels(true);b.stopAllChannels(true);
  }
});

test('post-effect pan moves a prior delayed note to the new side and 14-bit volume LSB changes its gain',async()=>{
  for(const dsp of ['js','wasm','wasm-simd']){
    const a=await synth(dsp),b=await synth(dsp);for(const s of [a,b])s.noteOn(0,60,100);render(a,2560);render(b,2560);
    a.controllerChange(0,10,127);const right=render(a,5000),center=render(b,5000);assert.ok(energy([right[0]])<1e-20);assert.ok(energy([right[1]])>.001);
    const expected=Float32Array.from(center[0],(v,i)=>(v+center[1][i])*Math.SQRT1_2);assert.ok(error([right[1]],[expected])<1e-6);
    a.controllerChange(0,10,64);a.controllerChange(0,7,100);a.controllerChange(0,39,64);const quiet=render(a,2048),full=render(b,2048),gain=((100*128+64)/16256)**2;
    assert.ok(error(quiet,full.map(row=>Float32Array.from(row,v=>v*gain)))<1e-6);a.stopAllChannels(true);b.stopAllChannels(true);
  }
});

test('Dry/Wet is insertion-only; zero return and System send controls cannot mute the inserted part',async()=>{
  const dry=midi([...setup,event(parameter(10,1)),event(packet(0x56,[0,1,127,127])),...tone]);
  const plain=midi([...base,...tone]);for(const dsp of ['js','wasm','wasm-simd']){
    const a=await createSoundFontPreview(dry,prepared.bank,{dsp}),b=await createSoundFontPreview(plain,prepared.bank,{dsp,effects:false});
    try{assert.ok(error(a.read(60000),b.read(60000))<1e-6);}finally{a.close();b.close();}}
});

test('No Effect silences only its selected part and Thru/unsupported types preserve the original path',async()=>{
  const head=[...base,event(packet(0x40,[0,0])),event(packet(0x5a,[0,0]))];
  const two=midi([...head,...neutral,[0,0xc0,81],[0,0xc1,81],[0,0x90,60,100],[0,0x91,67,90],[...vlq(240),0x80,60,64],[0,0x81,67,64],end]);
  const only=midi([...base,...neutral,[0,0xc1,81],[0,0x91,67,90],[...vlq(240),0x81,67,64],end]);const prepared=await loader.load(two);
  for(const dsp of ['js','wasm','wasm-simd']){
    const a=await createSoundFontPreview(two,prepared.bank,{prepared,dsp}),b=await createSoundFontPreview(only,prepared.bank,{dsp});try{same(a.read(60000),b.read(60000));}finally{a.close();b.close();}
    for(const type of [[0x40,0],[0x7f,0x7f]]){const bytes=midi([...head,event(packet(0x40,type)),...tone]),p=await createSoundFontPreview(bytes,prepared.bank,{dsp}),q=await createSoundFontPreview(midi([...base,...tone]),prepared.bank,{dsp});
      try{same(p.read(60000),q.read(60000));if(type[0]===0x7f)assert.ok(p.stats.diagnostics.entries.some(r=>r.reason?.includes('Thru')));}finally{p.close();q.close();}}
  }
});

test('Multi Part writes execute every byte; Dry Level affects only dry return and Variation Send selects insertion independently of CC94',async()=>{
  const s=await synth();const malformed=notices(()=>s.systemExclusive(part(0,0x11,[0,128,0,1])));assert.equal(malformed.length,1);assert.equal(s.midiChannels[0].xgDryLevel??127,127);const invalid=notices(()=>{s.systemExclusive(part(0,4,[32]));s.systemExclusive(part(0,5,[2]));});assert.ok(invalid.every(r=>r.kind!=='implemented'));assert.equal(s.midiChannels[0].midiParameters.rxChannel,0);assert.equal(s.midiChannels[0].midiParameters.polyMode,true);const rows=notices(()=>s.systemExclusive(part(0,0x11,[0,127,0,1])));assert.ok(rows.every(r=>r.kind==='implemented'));
  assert.equal(s.midiChannels[0].xgDryLevel,0);assert.equal(s.midiChannels[0].midiControllers[93]>>7,127);assert.equal(s.midiChannels[0].midiControllers[91],0);assert.equal(s.synthCore.xgVariation.raw[0x5b],0);
  s.controllerChange(0,94,0);s.noteOn(0,60,100);assert.equal(energy(render(s,10000)),0,'Dry Level mutes inserted dry return while Chorus/Reverb are disabled');
  s.systemExclusive(packet(0x20,[0x41,0]));for(const [p,v]of [[1,0],[2,0],[3,64],[4,0],[15,1]])s.systemExclusive(sysex(2,1,p<=10?0x20+p+1:0x20+p+5,[v]));s.systemExclusive(packet(0x2c,[96,64,0]));
  assert.ok(energy(render(s,4000))>.001,'Chorus Send is taken before Dry Level');
  s.systemExclusive(part(1,0x14,[1]));assert.equal(s.synthCore.xgVariation.raw[0x5b],1);s.systemExclusive(part(1,0x14,[0]));assert.equal(s.synthCore.xgVariation.raw[0x5b],127);
  s.systemExclusive(part(0,4,[127]));assert.equal(s.midiChannels[0].midiParameters.rxChannel,-1);s.stopAllChannels(true);
});

test('independent source ports, receive-part routing and drum per-note Variation OFF preserve other voices',async()=>{
  const bytes=midiTracks([
    [...base,...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(480),0x80,60,64],end],
    [[0,255,33,1,7],event(packet(0x40,[0,0])),event(packet(0x5a,[0,0])),[0,0xc0,81],[0,0x90,67,90],[...vlq(480),0x80,67,64],end]
  ]),plain=midi([...base,...neutral,[0,0xc0,81],[0,0x90,60,100],[...vlq(480),0x80,60,64],end]),prepared=await loader.load(bytes);
  for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(plain,prepared.bank,{dsp});try{assert.equal(p.stats.diagnostics.summary.unsupported,0);same(p.read(60000),q.read(60000));}finally{p.close();q.close();}}
  const drum=await loader.load(midi([event(reset),[0,0x99,42,100],[...vlq(120),0x89,42,64],end]));const s=await synth('js',true,drum.bank);s.systemExclusive(packet(0x40,[0,0]));s.systemExclusive(packet(0x5b,[9]));assert.equal(s.midiChannels[9].drumParams[42].delayGain,1,'MU100 drum Variation Send defaults to127');for(const [cc,v]of [[99,31],[98,42],[6,0]])s.controllerChange(9,cc,v);s.noteOn(9,42,100);assert.ok(energy(render(s,4000))>0);s.controllerChange(9,120,0);s.controllerChange(9,6,127);s.noteOn(9,42,100);assert.equal(energy(render(s,4000)),0,'NRPN31 turns only this key into the selected No Effect insertion');s.stopAllChannels(true);
  const routed=await synth();routed.systemExclusive(packet(0x40,[0,0]));routed.systemExclusive(part(2,4,[127]));routed.systemExclusive(part(0,4,[2]));routed.noteOn(2,60,100);assert.equal(energy(render(routed,2000)),0);assert.ok(routed.synthCore.voices.some(v=>v.isActive&&v.channel===0));assert.ok(!routed.synthCore.voices.some(v=>v.isActive&&v.channel===2));routed.systemExclusive(packet(0x40,[0x40,0]));assert.ok(energy(render(routed,2000))>.001,'the received note kept running through No Effect and resumes through Thru');routed.stopAllChannels(true);
});

const tailCommand=parameter(1,2000),score=midi([...setup,...neutral,[0,0xc0,81],[0,0x90,60,100],[60,0xb0,69,127],[60,0xf0,8,...tailCommand.slice(0,8)],[60,0xf7,...vlq(tailCommand.length-8),...tailCommand.slice(8)],
  [60,0xb0,7,0],[0,0xb0,10,127],[0,0x80,60,100],[60,0xb0,69,0],[60,0xb0,7,127],[0,0xb0,10,64],event(packet(0x40,[0x42,0]),120),event(parameter(10,64)),[...vlq(1440),255,47,0]]);
test('insertion buses, pre-part envelopes, Hold2, live type changes and F0/F7 restore exact checkpoints/seek on all DSPs',async()=>{
  const prepared=await loader.load(score);for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp});
    try{assert.equal(p.stats.diagnostics.summary.unsupported,0);const pcm=p.read(144000);assert.ok(energy(pcm)>1);for(const frame of [1001,6001,18001,36001]){await p.seek(frame/48000);const saved=p.capture(),actual=p.read(48001);same(actual,pcm.map(row=>row.slice(frame,frame+48001)));for(let i=0;i<2;i++){saved.restore();same(p.read(48001),actual);}}}finally{p.close();}}
});

test('real Worker renders/loads insertion and host effects:false retains original dry PCM',async()=>{
  const prepared=await loader.load(score),worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;
  const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};
  const reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm'});
  try{const loaded=await call('load',{bytes:score,epoch:1,effects:true,dsp:'wasm'});assert.equal(loaded.diagnostics.summary.unsupported,0);assert.equal(loaded.sampleBank.mode,'samples');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);
    for(const [epoch,seconds]of [[2,.31],[3,.71],[4,.01]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});same((await pending)[0].channels,reference.read(2048));}
  }finally{reference.close();channel.port1.close();await worker.terminate();}
  for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(midi([...setup,...tone]),prepared.bank,{dsp,effects:false}),q=await createSoundFontPreview(midi([...base,...tone]),prepared.bank,{dsp,effects:false});try{same(p.read(60000),q.read(60000));}finally{p.close();q.close();}}
});
