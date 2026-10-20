import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { GSOverdrive, GSDistortion, installGSEffects } from '../gs-effects.js';
import { Biquad } from '../effect-dsp.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const end=[0,255,47,0];
const dt1=(a2,a3,data,a1=0x40)=>{
  const address=[a1,a2,a3,...data];return new Uint8Array([0x41,0x10,0x42,0x12,...address,(-address.reduce((s,n)=>s+n,0))&127,0xf7]);
};
const event=(packet,tick=0)=>[...vlq(tick),0xf0,...vlq(packet.length),...packet];
const assign=dt1(0x41,0x22,[1]); // Roland SC-8850 p.128: Part 1, not channel 10.
const tone=[[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0],[0,0x90,60,100],[...vlq(480),0x80,60,64],end];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))});
const prepared=await loader.load(midi(tone));
async function synth() {
  const s=new SpessaSynthProcessor(48000,{effectsEnabled:true,eventsEnabled:false,maxBufferSize:128});
  s.onMissingPreset=(p,system)=>prepared.bank.getPreset(p,system);
  s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installGSEffects(s);return s;
}
const notices=fn=>{ const rows=[],before=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=before;}return rows; };
const send=(s,a2,a3,data)=>s.systemExclusive(dt1(a2,a3,data));
const energy=pcm=>pcm.reduce((sum,row)=>sum+row.reduce((s,n)=>s+n*n,0),0);
const different=(a,b)=>a.some((row,c)=>row.some((v,i)=>Math.abs(v-b[c][i])>1e-5));

// Message bytes and defaults below are independently transcribed from the
// SC-8850 pp.93-94,128,216,235-237,245, not generated from the implementation.
test('Roland published Distortion example selects the real processor and all factory parameters',async()=>{
  const s=await synth();
  const rows=notices(()=>{s.systemExclusive(new Uint8Array([0x41,0x10,0x42,0x12,0x40,3,0,1,0x11,0x2b,0xf7]));s.systemExclusive(assign);});
  const fx=s.synthCore.insertionProcessor;
  assert.ok(fx instanceof GSDistortion);assert.equal(fx.drive,76);assert.equal(fx.ampType,3);assert.equal(fx.ampSwitch,1);
  assert.equal(fx.lowGain,0);assert.equal(fx.highGain,-8);assert.equal(fx.pan,64);assert.equal(fx.level,84/127);
  assert.equal(s.midiChannels[0].midiParameters.efxAssign,true);assert.equal(s.midiChannels[9].midiParameters.efxAssign,false);
  assert.ok(rows.every(row=>row.kind==='implemented'));
  send(s,3,3,[127]);assert.equal(fx.drive,127);
  send(s,3,0,[1,0x10]);const soft=s.synthCore.insertionProcessor;
  assert.ok(soft instanceof GSOverdrive);assert.equal(soft.drive,48);assert.equal(soft.ampType,1);assert.equal(soft.highGain,0);assert.equal(soft.level,96/127);
});

test('DT1 applies every byte in address order; macros precede their following parameter overrides',async()=>{
  const s=await synth();
  const rows=notices(()=>{
    send(s,1,0x38,[5,2,90,50,8,70,100,90,80]);
    send(s,3,0,[1,0x10,0,99,2,0]); // 02 is reserved; the bytes following it must still execute.
    send(s,3,0x13,[52,76,127,110,0,100,127]);
  });
  const core=s.synthCore,fx=core.insertionProcessor,ch=core.chorusProcessor;
  assert.equal(ch.preLowpass,2);assert.equal(ch.level,90);assert.equal(ch.feedback,50);assert.equal(ch.delay,8);
  assert.equal(ch.rate,70);assert.equal(ch.depth,100);assert.equal(ch.sendLevelToReverb,90);assert.equal(ch.sendLevelToDelay,80);
  assert.equal(fx.drive,99);assert.equal(fx.ampType,2);assert.equal(fx.ampSwitch,0);
  assert.equal(fx.lowGain,-12);assert.equal(fx.highGain,12);assert.equal(fx.pan,127);assert.equal(fx.level,110/127);
  assert.equal(fx.sendLevelToReverb,0);assert.ok(Math.abs(fx.sendLevelToChorus-200/127)<1e-15);assert.ok(Math.abs(fx.sendLevelToDelay-2)<1e-15);
  assert.equal(rows.filter(row=>row.kind!=='implemented').length,1);assert.match(rows.find(row=>row.kind!=='implemented').reason,/reserved/);
});

test('both EFX type bytes accept partial writes and unknown types use explicit Thru without losing their address',async()=>{
  const s=await synth();send(s,3,0,[1,0x10]);send(s,3,1,[0x11]);assert.equal(s.synthCore.insertionProcessor.type,0x111);
  let rows=notices(()=>send(s,3,0,[2]));assert.equal(s.synthCore.gsEffects.selectedType,0x211);
  assert.equal(s.synthCore.insertionProcessor.type,0);assert.ok(rows.some(r=>r.reason?.includes('Thru')));
  rows=notices(()=>send(s,3,1,[0x10]));assert.equal(s.synthCore.gsEffects.selectedType,0x210);assert.ok(rows.some(r=>r.reason?.includes('Thru')));
  send(s,3,0,[1]);assert.equal(s.synthCore.insertionProcessor.type,0x110);
  send(s,3,0x18,[127]);send(s,3,0,[1,0x10]);assert.equal(s.synthCore.insertionProcessor.sendLevelToChorus,0);
  s.synthCore.reset();send(s,3,1,[0x10]);assert.equal(s.synthCore.gsEffects.selectedType,0x10,'GS reset clears the previous MSB');
});

test('bad checksum, malformed messages and out-of-range effect values never mutate the processor',async()=>{
  const s=await synth();send(s,3,0,[1,0x10]);const fx=s.synthCore.insertionProcessor;
  const bad=dt1(3,3,[100,2,0]);bad[bad.length-2]^=1;
  const rows=notices(()=>{
    s.systemExclusive(bad);s.systemExclusive(dt1(3,3,[0x80]));s.systemExclusive(new Uint8Array([0x41,0x10,0x42,0x12,0x40,3,3,5,0xf7]));
    send(s,3,4,[4]);send(s,3,5,[2]);send(s,3,19,[51]);send(s,1,0x30,[8]);send(s,1,0x52,[0]);send(s,1,0x53,[121]);
  });
  assert.equal(fx.drive,48);assert.equal(fx.ampType,1);assert.equal(fx.ampSwitch,1);assert.equal(fx.lowGain,0);
  assert.equal(rows.length,9);assert.ok(rows.every(r=>r.kind!=='implemented'));assert.match(rows[0].reason,/checksum/);
  s.setSystemParameter('deviceID',0x11);send(s,3,3,[120]);assert.equal(fx.drive,48,'device filtering still runs before the effect receiver');
});

function runEffect(fx,left,right,count=left.length,start=0) {
  const buffers=Array.from({length:5},()=>new Float32Array(count+start));
  fx.process(left,right,...buffers,start,count);return buffers;
}
test('mono drive, pan, level and all sends match an independent sample-by-sample reference',()=>{
  for(const Type of [GSOverdrive,GSDistortion])for(const pan of [0,64,127]) {
    const fx=new Type(48000);fx.setParameter(3,127);fx.setParameter(5,0);fx.setParameter(19,64);fx.setParameter(20,64);fx.setParameter(21,pan);fx.setParameter(22,127);
    fx.sendLevelToReverb=.25;fx.sendLevelToChorus=.5;fx.sendLevelToDelay=1;
    const l=new Float32Array([0,.01,-.04,.1,.8,-1]),r=new Float32Array([.01,0,.1,-.1,.3,-.9]);
    const [ol,or,rev,cho,del]=runEffect(fx,l,r,l.length,7);
    const angle=(pan===0?0:pan===64?.5:1)*Math.PI/2;
    for(let i=0;i<l.length;i++) {
      const input=(l[i]+r[i])*(Type===GSDistortion?61:25);
      const v=Type===GSDistortion?Math.max(-1,Math.min(1,input)):Math.tanh(input);
      assert.ok(Math.abs(ol[i+7]-v*Math.cos(angle))<1e-7);assert.ok(Math.abs(or[i+7]-v*Math.sin(angle))<1e-7);
      const mono=v*(Math.cos(angle)+Math.sin(angle))*.5;
      assert.ok(Math.abs(rev[i]-mono*.25)<1e-7);assert.ok(Math.abs(cho[i]-mono*.5)<1e-7);assert.ok(Math.abs(del[i]-mono)<1e-7);
    }
    assert.ok(ol.subarray(0,7).every(n=>n===0));
  }
});

test('EQ gains use dB correctly; cabinet choices alter PCM, reset clears their complete filter history',()=>{
  for(const high of [false,true])for(const gain of [-12,12]) {
    const filter=new Biquad();filter.shelf(48000,high?4000:200,gain,high);
    let input=0,output=0;const frequency=high?18000:10;
    for(let i=0;i<96000;i++){const x=Math.sin(2*Math.PI*frequency*i/48000),y=filter.process(x);if(i>48000){input+=x*x;output+=y*y;}}
    assert.ok(Math.abs(10*Math.log10(output/input)-gain)<.02);
  }
  const signal=Float32Array.from({length:2048},(_,i)=>Math.sin(i*.09)*.3),zero=new Float32Array(signal.length),outputs=[];
  for(let type=0;type<4;type++){
    const fx=new GSDistortion(48000);fx.setParameter(4,type);const pcm=runEffect(fx,signal,zero);outputs.push(pcm);
    assert.ok(pcm.every(row=>row.every(Number.isFinite)));fx.reset();assert.deepEqual(runEffect(fx,zero,zero),Array.from({length:5},()=>zero));
  }
  for(let i=1;i<4;i++)assert.ok(different(outputs[0],outputs[i]));
});

const setup=(bulk=true)=>bulk?[event(dt1(3,0,[1,0x11])),event(dt1(3,3,[110,2,1])),event(dt1(3,0x13,[66,60,64,90,50,40,30])),event(assign)]
  :[event(dt1(3,0,[1,0x11])),...[[3,110],[4,2],[5,1],[19,66],[20,60],[21,64],[22,90],[23,50],[24,40],[25,30]].map(([a,v])=>event(dt1(3,a,[v]))),event(assign)];
test('complete GS compositions render identical bulk/individual commands on JS, WASM and SIMD, and effects:false keeps dry PCM',async()=>{
  const bytes=midi([...setup(),...tone]),split=midi([...setup(false),...tone]),dryBytes=midi(tone);
  for(const dsp of ['js','wasm','wasm-simd']) {
    const wet=await createSoundFontPreview(bytes,prepared.bank,{dsp,effects:true});
    const ref=await createSoundFontPreview(split,prepared.bank,{dsp,effects:true});
    const dry=await createSoundFontPreview(bytes,prepared.bank,{dsp,effects:false});
    const plain=await createSoundFontPreview(dryBytes,prepared.bank,{dsp,effects:false});
    try{
      assert.equal(wet.stats.diagnostics.summary.unsupported,0);assert.equal(wet.stats.diagnostics.summary.unverified,0);
      const pcm=wet.read(72000);assert.deepEqual(pcm,ref.read(72000));assert.ok(energy(pcm)>1);
      const dryPcm=dry.read(72000);assert.deepEqual(dryPcm,plain.read(72000));assert.ok(different(pcm,dryPcm));
    }finally{wet.close();ref.close();dry.close();plain.close();}
  }
});

test('fragmented F0/F7, port assignment and live parameter changes execute at the original final-byte time',async()=>{
  const packet=dt1(3,3,[127]),part=event(dt1(0x42,0x22,[1])); // channel 2
  const fragmented=midiTracks([
    [...setup(),part,[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0],[0,0x90,60,100],
      [60,0xf0,8,...packet.slice(0,8)],[60,0xf7,...vlq(packet.length-8),...packet.slice(8)],
      [60,0xf0,...vlq(dt1(3,0x15,[127]).length),...dt1(3,0x15,[127])],[...vlq(300),0x80,60,64],end],
    [[0,255,33,1,7],[0,0xc1,81],[0,0x91,60,90],[...vlq(480),0x81,60,64],end]
  ]);
  const direct=midiTracks([
    [...setup(),part,[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0],[0,0x90,60,100],event(packet,120),event(dt1(3,0x15,[127]),60),[...vlq(300),0x80,60,64],end],
    [[0,255,33,1,7],[0,0xc1,81],[0,0x91,60,90],[...vlq(480),0x81,60,64],end]
  ]);
  const multi=await loader.load(fragmented);
  for(const dsp of ['js','wasm','wasm-simd']){
    const p=await createSoundFontPreview(fragmented,multi.bank,{prepared:multi,dsp}),q=await createSoundFontPreview(direct,multi.bank,{dsp});
    try{
      assert.equal(p.stats.diagnostics.summary.unverified,0);assert.equal(p.stats.diagnostics.summary.unsupported,0);
      assert.deepEqual(p.read(60000),q.read(60000));
    }finally{p.close();q.close();}
  }
});

test('drive, cabinet, EQ and system-effect tails retain exact PCM through seek and repeated checkpoints on every DSP',async()=>{
  const bytes=midi([...setup(),...tone.slice(0,-1),event(dt1(3,0x13,[55,75,0,100]),120),[...vlq(1440),255,47,0]]);
  for(const dsp of ['js','wasm','wasm-simd']){
    const p=await createSoundFontPreview(bytes,prepared.bank,{dsp});
    try{
      const continuous=p.read(120000);
      for(const frame of [6001,24001,36001,72001]){
        await p.seek(frame/48000);const saved=p.capture(),block=p.read(12001);
        assert.deepEqual(block,continuous.map(row=>row.slice(frame,frame+12001)),dsp+' seek '+frame);
        saved.restore();assert.deepEqual(p.read(12001),block);saved.restore();assert.deepEqual(p.read(12001),block);
      }
    }finally{p.close();}
  }
});
