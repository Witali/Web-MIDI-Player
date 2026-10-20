import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath}from'node:url';
import {Worker,MessageChannel}from'node:worker_threads';
import {once}from'node:events';
import {SpessaLog,SpessaSynthProcessor}from'../vendor/spessasynth.js';
import {BrowserSoundBank}from'../lazy-bank.js';
import {createSoundFontPreview}from'../soundfont-preview.js';
import {installXGVariation}from'../xg-variation.js';
import {createXGEffect}from'../xg-effect-types.js';
import {midi,midiTracks,vlq}from'./fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const packet=(address,data)=>new Uint8Array([0x43,0x10,0x4c,2,1,address,...data,0xf7]);
const event=(data,tick=0)=>[...vlq(tick),0xf0,...vlq(data.length),...data];
const reset=new Uint8Array([0x43,0x10,0x4c,0,0,0x7e,0,0xf7]),end=[0,255,47,0];
const parameter=(p,value)=>packet(p<=10?0x42+2*(p-1):0x70+p-11,p<=10?[value>>7,value&127]:[value]);
const tone=[[0,0xc0,81],[0,0xb0,94,127],[0,0xb0,10,0],[0,0x90,60,100],[...vlq(240),0xb0,10,127],[...vlq(240),0x80,60,64],end];
const base=[event(reset),event(packet(0,[0,0])),event(packet(0x20,[0,0]))];
const setup=(msb,lsb=0)=>[...base,event(packet(0x40,[msb,lsb])),event(packet(0x56,[96,64,0,0,1]))];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
const notices=fn=>{const rows=[],before=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=before;}return rows;};
async function synth(){const s=new SpessaSynthProcessor(48000,{eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,system)=>prepared.bank.getPreset(p,system);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installXGVariation(s);s.systemExclusive(reset);return s;}
const equal=(a,b,label='')=>{let error=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)error=Math.max(error,Math.abs(a[c][i]-b[c][i]));}assert.equal(error,0,label);};
const programs=[[1,[0,1]],[2,[0,1,2]],[3,[0,1]],[4,[0]],[5,[0]],[6,[0]],[7,[0]],[8,[0]],[0x41,[0,1,2,8]],[0x42,[0,1,2,8]],[0x43,[0,1,8]],[0x49,[0]],[0x4a,[0]]];

test('all 25 Variation programs have explicit MSB/LSB membership; unsupported subtypes remain diagnosed Thru',async()=>{
  const s=await synth(),fx=s.synthCore.xgVariation;let count=0;
  for(const [msb,lsbs]of programs)for(const lsb of lsbs){const rows=notices(()=>s.systemExclusive(packet(0x40,[msb,lsb])));assert.ok(rows.every(r=>r.kind==='implemented'));assert.ok(fx.processor);assert.equal(fx.processor.block,'variation');count++;}
  assert.equal(count,25);for(const [msb,lsb]of [[1,2],[2,3],[4,1],[5,1],[0x41,3],[0x42,3],[0x43,2]]){const rows=notices(()=>s.systemExclusive(packet(0x40,[msb,lsb])));assert.equal(fx.mode,'thru');assert.ok(rows.some(r=>r.reason?.includes('Thru')));}
});

test('Variation retains 14-bit pairs for seven-bit algorithms and rejects out-of-range combined values without clamping',async()=>{
  const s=await synth(),fx=s.synthCore.xgVariation;s.systemExclusive(packet(0x40,[0x41,0]));
  assert.equal(fx.raw[0x42],0);assert.equal(fx.raw[0x43],6);assert.equal(fx.parameters[9],64);
  s.systemExclusive(parameter(1,127));assert.equal(fx.processor.frequency,39.7);
  const rows=notices(()=>{s.systemExclusive(packet(0x42,[1]));s.systemExclusive(packet(0x43,[0]));});assert.equal(rows.length,2);assert.ok(rows.every(r=>r.kind!=='implemented'));assert.equal(fx.parameters[0],127);
  s.systemExclusive(packet(0x42,[0]));assert.equal(fx.parameters[0],0);
  s.systemExclusive(packet(0x40,[1,0]));assert.equal(fx.parameters[9],64);const bad=notices(()=>s.systemExclusive(parameter(10,0)));assert.equal(bad.length,1);assert.equal(fx.parameters[9],64);
  s.systemExclusive(parameter(1,69));assert.equal(fx.processor.reverbTime,30);
});

test('Variation Reverb sums L/R before HPF/LPF and ER, while System Reverb preserves stereo ER',()=>{
  const signal=new Float32Array(4000),inverse=new Float32Array(4000);signal[0]=1;inverse[0]=-1;
  const outputs=[];for(const block of ['system','variation']){
    const fx=createXGEffect(10000,1,0,block);for(const [p,v]of [[4,0],[5,60],[13,1],[15,64]])fx.setParameter(p,v);
    const pcm=[new Float32Array(4000),new Float32Array(4000)];fx.process(signal,inverse,...pcm,4000);outputs.push(pcm);
  }
  assert.ok(outputs[0].some(row=>row.some(v=>Math.abs(v)>.01)));assert.ok(outputs[1].every(row=>row.every(v=>v===0)));
});

function midEnergy(block,gain,width=10,frequency=1000){
  const fx=createXGEffect(48000,0x41,0,block);for(const [p,v]of [[1,0],[2,0],[3,64],[4,0],[11,34],[12,gain],[13,width],[15,1]])fx.setParameter(p,v);
  const input=Float32Array.from({length:48000},(_,i)=>.01*Math.sin(2*Math.PI*frequency*i/48000)),zero=new Float32Array(48000),pcm=[new Float32Array(48000),new Float32Array(48000)];fx.process(input,zero,...pcm,48000);
  let a=0,b=0;for(let i=24000;i<48000;i++){a+=input[i]*input[i];b+=pcm[0][i]*pcm[0][i];}return 10*Math.log10(b/a);
}
test('middle EQ is audible only for Variation, preserves dB gain and uses the configured width',()=>{
  for(const gain of [52,76]){assert.ok(Math.abs(midEnergy('variation',gain)-(gain-64))<.002);assert.ok(Math.abs(midEnergy('system',gain))<.002);assert.ok(Math.abs(midEnergy('insertion',gain))<.002);}
  assert.ok(midEnergy('variation',76,10,1500)>midEnergy('variation',76,120,1500)+3);
});

test('all added Variation families execute real MIDI without unsupported notices and produce finite wet PCM',async()=>{
  for(const [msb,lsbs]of programs.filter(([msb])=>msb<5||msb>=0x41))for(const lsb of lsbs){
    const bytes=midi([...setup(msb,lsb),...tone]),p=await createSoundFontPreview(bytes,prepared.bank,{dsp:'wasm'});
    try{assert.equal(p.stats.diagnostics.summary.unsupported,0);assert.equal(p.stats.diagnostics.summary.unverified,0);const pcm=p.read(24000);assert.ok(pcm.every(row=>row.every(Number.isFinite)));assert.ok(pcm.some(row=>row.some(v=>Math.abs(v)>.001)));}finally{p.close();}
  }
});

test('zero-modulation stereo Variation chorus equals independently doubled dry PCM on every backend; System ignores Dry/Wet',async()=>{
  const params=[[1,0],[2,0],[3,64],[4,0],[12,64],[15,1]],a=midi([...setup(0x41),...params.map(([p,v])=>event(parameter(p,v))),event(parameter(10,1)),...tone]);
  const b=midi([...setup(0x41),...params.map(([p,v])=>event(parameter(p,v))),event(parameter(10,127)),...tone]);
  const dry=midi([...base,...tone]);
  for(const dsp of ['js','wasm','wasm-simd']){
    const previews=await Promise.all([a,b,dry].map((bytes,i)=>createSoundFontPreview(bytes,prepared.bank,{dsp,effects:i!==2})));
    try{const pcm=previews.map(p=>p.read(60000));equal(pcm[0],pcm[1]);let error=0;for(let c=0;c<2;c++)for(let i=0;i<60000;i++)error=Math.max(error,Math.abs(pcm[0][c][i]-pcm[2][c][i]*2));assert.ok(error<1e-6,dsp+' doubled dry error '+error);}finally{previews.forEach(p=>p.close());}
  }
});

const change=parameter(3,50),first=[...setup(1),...tone.slice(0,4),[60,0xf0,8,...change.slice(0,8)],[60,0xf7,...vlq(change.length-8),...change.slice(8)],
  event(packet(0x40,[0x42,1]),120),event(parameter(12,70)),event(packet(0x40,[0x43,8]),120),event(parameter(14,124)),[120,0x80,60,64],end];
const second=[[0,255,33,1,9],[0,0xc1,81],[0,0xb1,94,127],[0,0x91,67,90],[...vlq(480),0x81,67,64],end];
const score=midiTracks([first,second]);
test('Variation input/EQ/filter/LFO state survives type allocations, F0/F7, ports and repeated exact checkpoint/seek PCM',async()=>{
  const prepared=await loader.load(score);for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp});
    try{assert.equal(p.stats.diagnostics.summary.unsupported,0);const pcm=p.read(144000);for(const frame of [6001,24001,60001]){await p.seek(frame/48000);const saved=p.capture(),block=p.read(48001);equal(block,pcm.map(row=>row.slice(frame,frame+48001)),dsp+' seek');for(let i=0;i<2;i++){saved.restore();equal(p.read(48001),block,dsp+' checkpoint');}}}finally{p.close();}
  }
});

test('real selectively loaded Worker renders expanded Variation types with complete diagnostics and exact wet seeks',async()=>{
  const prepared=await loader.load(score),worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;
  const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};
  const reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm'});
  try{const loaded=await call('load',{bytes:score,epoch:1,effects:true,dsp:'wasm'});assert.equal(loaded.diagnostics.summary.unsupported,0);assert.equal(loaded.diagnostics.summary.unverified,0);assert.equal(loaded.sampleBank.mode,'samples');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);
    for(const [epoch,seconds]of [[2,.31],[3,.71],[4,.01]]){await call('seek',{seconds,epoch});await reference.seek(seconds);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});equal((await pending)[0].channels,reference.read(2048));}
  }finally{reference.close();channel.port1.close();await worker.terminate();}
});
