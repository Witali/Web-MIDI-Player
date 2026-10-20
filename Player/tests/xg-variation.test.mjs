import { Worker,MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpessaSynthProcessor,SpessaLog } from '../vendor/spessasynth.js';
import { installXGVariation,xgLevel } from '../xg-variation.js';
import { XGDelay } from '../xg-delay.js';
import { XG_EQ_FREQUENCY } from '../xg-effect-values.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi,midiTracks,vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const end=[0,255,47,0],packet=(address,data,device=0)=>new Uint8Array([0x43,0x10|device,0x4c,2,1,address,...data,0xf7]);
const event=(data,ticks=0)=>[...vlq(ticks),0xf0,...vlq(data.length),...data];
const reset=new Uint8Array([0x43,0x10,0x4c,0,0,0x7e,0,0xf7]);
const parameter=(p,value)=>packet(p<=10?0x42+(p-1)*2:0x70+p-11,p<=10?[value>>7,value&127]:[value]);
const tone=[[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0],[0,0xb0,94,127],[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))});
const prepared=await loader.load(midi(tone));
async function synth(){const s=new SpessaSynthProcessor(48000,{eventsEnabled:false,effectsEnabled:true,maxBufferSize:128});s.onMissingPreset=(p,system)=>prepared.bank.getPreset(p,system);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;installXGVariation(s);s.systemExclusive(reset);return s;}
const notices=fn=>{const rows=[],before=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=before;}return rows;};
const send=(s,address,data)=>s.systemExclusive(packet(address,data));
const set=(s,p,value)=>s.systemExclusive(parameter(p,value));
const params=type=>type===5?[[1,1000],[2,2000],[3,1500],[4,2500],[5,96],[6,80],[7,10],[10,127],[13,28],[14,64],[15,46],[16,64]]:
  type===6?[[1,1000],[2,2000],[3,2500],[4,3000],[5,96],[6,10],[10,127],[13,28],[14,64],[15,46],[16,64]]:
  type===7?[[1,1000],[2,96],[3,2000],[4,90],[5,10],[6,3000],[7,4000],[8,64],[10,127],[13,28],[14,64],[15,46],[16,64]]:
  [[1,1000],[2,2000],[3,96],[4,2],[5,10],[10,127],[13,28],[14,64],[15,46],[16,64]];
const setup=type=>[event(reset),event(packet(0x40,[type,0])),event(packet(0x56,[96,64,0,0,1])),...params(type).map(([p,v])=>event(parameter(p,v)))];
const samePCM=(a,b,label='')=>{let maximum=0,first=-1;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++){const delta=Math.abs(a[c][i]-b[c][i]);if(delta>maximum)maximum=delta;if(delta>0&&first<0)first=i;}}assert.equal(maximum,0,label+' first different frame '+first);};
const energy=rows=>rows.reduce((sum,row)=>sum+row.reduce((s,n)=>s+n*n,0),0);

test('MU100 Effect1 defaults, 14-bit units and partial parameter/type writes follow the published address map',async()=>{
  const s=await synth(),fx=s.synthCore.xgVariation;
  assert.deepEqual(Array.from(fx.parameters),[3333,1667,5000,5000,74,100,10,0,0,32,0,60,28,64,46,64]);
  assert.deepEqual(Array.from(fx.raw.slice(0x42,0x4a)),[0x1a,5,0x0d,3,0x27,8,0x27,8]);
  const rows=notices(()=>{send(s,0x42,[0x0f,0x50,0x1f,0x20]);send(s,0x43,[0x51]);send(s,0x42,[0x10]);send(s,0x41,[1]);send(s,0x41,[0]);});
  assert.ok(rows.some(r=>r.reason?.includes('Thru')));assert.equal(fx.processor.type,5);
  // Selecting a new type resets its program parameters before later overrides.
  send(s,0x42,[0x0f,0x50,0x1f,0x20]);assert.equal(fx.parameters[0],2000);assert.equal(fx.parameters[1],4000);
  send(s,0x43,[0x51]);assert.equal(fx.parameters[0],2001);send(s,0x42,[0x10]);assert.equal(fx.parameters[0],2129);
  send(s,0x70,[0,0,28,64,46,64]);assert.equal(fx.parameters[12],28);assert.equal(fx.parameters[15],64);
  assert.equal(XG_EQ_FREQUENCY[4],32);assert.equal(XG_EQ_FREQUENCY[28],500);assert.equal(XG_EQ_FREQUENCY[40],2000);assert.equal(XG_EQ_FREQUENCY[58],16000);
});

test('XG malformed/range failures, unknown algorithms and valid insertion selection are explicit and never silently accepted',async()=>{
  const s=await synth(),fx=s.synthCore.xgVariation;send(s,0x5a,[1]);
  const rows=notices(()=>{
    s.systemExclusive(new Uint8Array([0x43,0x10,0x4c,2,1,0x42,1,128,0xf7]));
    s.systemExclusive(new Uint8Array([0x43,0x10,0x4c,2,1,0x42,0xf7]));
    set(s,1,14861);set(s,5,0);set(s,7,11);set(s,13,3);send(s,0x57,[0]);send(s,0x5b,[64]);send(s,0x61,[0]);send(s,0x5c,[127]);
  });
  assert.equal(rows.length,10);assert.ok(rows.every(r=>r.kind!=='implemented'));assert.equal(fx.parameters[0],3333);assert.equal(fx.raw[0x57],64);assert.equal(fx.raw[0x5b],127);
  const insertion=notices(()=>{send(s,0x5a,[0]);send(s,0x5b,[0]);});assert.ok(insertion.every(r=>r.kind==='implemented'));
  const unknown=notices(()=>send(s,0x40,[0x7f,0x7f]));assert.equal(fx.mode,'thru');assert.ok(unknown.some(r=>r.reason?.includes('Thru')));
  const unsupported=notices(()=>send(s,0x16,[1,0,10,11]));assert.equal(unsupported.filter(r=>r.kind!=='implemented').length,4,'all bytes of a reserved Effect1 record must still be diagnosed');
});

test('Yamaha device number is the low header nibble; GS/universal device filtering retains its own numbering',async()=>{
  const s=await synth(),fx=s.synthCore.xgVariation;s.setSystemParameter('deviceID',0);
  s.systemExclusive(packet(0x56,[100],0));assert.equal(fx.raw[0x56],100);
  s.systemExclusive(packet(0x56,[20],1));assert.equal(fx.raw[0x56],100);
  s.systemExclusive(packet(0x56,[30],15));assert.equal(fx.raw[0x56],100,'Yamaha device 15 is not the universal all-call 127');
  s.setSystemParameter('deviceID',16);s.systemExclusive(new Uint8Array([0x41,0x10,0x42,0x12,0x40,0,4,100,0x58,0xf7]));assert.equal(s.synthCore.midiParameters.volume,100/127);
});

function impulse(type,parameters,left=true,right=true,count=100){
  const fx=new XGDelay(10000,type);for(const [p,v]of parameters)fx.setParameter(p,v);
  const il=new Float32Array(count),ir=new Float32Array(count),ol=new Float32Array(count),or=new Float32Array(count);il[0]=+left;ir[0]=+right;fx.process(il,ir,ol,or,count);return [ol,or];
}
const near=(v,w)=>assert.ok(Math.abs(v-w)<1e-7,v+' versus '+w);
const spikes=row=>Array.from(row).flatMap((v,i)=>Math.abs(v)>1e-6?[i]:[]);
test('LCR, LR, Echo and Cross Delay impulse timing and feedback follow four different Yamaha block diagrams',()=>{
  const lcr=impulse(5,[[1,10],[2,20],[3,30],[4,40],[5,64],[6,127],[7,10]]);
  assert.deepEqual(spikes(lcr[0]),[10,30]);assert.deepEqual(spikes(lcr[1]),[20,30]);near(lcr[0][10],1);near(lcr[0][30],Math.SQRT1_2);
  const lr=impulse(6,[[1,10],[2,20],[3,30],[4,40],[5,96],[6,10]],true,true,130);
  assert.deepEqual(spikes(lr[0]),[10,40,70,100]);assert.deepEqual(spikes(lr[1]),[20,60,100]);near(lr[0][40],.5);near(lr[1][100],.25);
  const echo=impulse(7,[[1,10],[2,64],[3,20],[4,64],[5,10],[6,30],[7,40],[8,64]]);
  assert.deepEqual(spikes(echo[0]),[10,30]);assert.deepEqual(spikes(echo[1]),[20,40]);near(echo[0][30],64/127);
  const cross=impulse(8,[[1,10],[2,20],[3,32],[4,0],[5,10]],true,true,100);
  assert.deepEqual(spikes(cross[0]),[30,60,90]);assert.deepEqual(spikes(cross[1]),[10,40,70]);near(cross[1][10],1);near(cross[0][30],-.5);near(cross[1][40],.25);
});

test('fractional 0.1ms delays interpolate samples; High Damp attenuates high-frequency feedback and reset clears buffers',()=>{
  const fx=new XGDelay(48000,6);for(const [p,v]of [[1,1],[2,1],[3,1],[4,1],[5,64],[6,10]])fx.setParameter(p,v);
  const input=new Float32Array(128);input[0]=1;const out=[new Float32Array(128),new Float32Array(128)];fx.process(input,input,...out,128);
  assert.deepEqual(spikes(out[0]),[4,5]);near(out[0][4],.2);near(out[0][5],.8);
  const hard=impulse(6,[[1,10],[2,10],[3,10],[4,10],[5,120],[6,10]]),soft=impulse(6,[[1,10],[2,10],[3,10],[4,10],[5,120],[6,1]]);
  assert.ok(hard[0][20]>soft[0][20]);fx.clear();fx.process(new Float32Array(128),new Float32Array(128),...out,128);assert.ok(out.every(row=>row.every(v=>v===0)));
});

test('System return/pan follow send taps; mute return does not mute Variation-to-Reverb/Chorus sends',async()=>{
  assert.equal(xgLevel(0),0);assert.equal(xgLevel(96),1);near(xgLevel(127),10**.3);
  const s=await synth(),fx=s.synthCore.xgVariation;send(s,0x5a,[1]);
  for(const [p,v]of [[1,10],[2,20],[3,1000],[4,1000],[5,64],[6,0],[7,10]])set(s,p,v);
  send(s,0x56,[0,127,96,96]);fx.begin();const signal=new Float32Array(128);signal[0]=1;fx.capture(signal,128,1,0,1);
  const output=Array.from({length:4},()=>new Float32Array(150));fx.process(...output,10,128);
  assert.ok(output[0].every(v=>v===0)&&output[1].every(v=>v===0));near(output[2][48],.25);near(output[3][48],.25);
  fx.processor.clear();send(s,0x56,[96,1,0,0]);fx.begin();fx.capture(signal,128,1,0,1);const p=Array.from({length:4},()=>new Float32Array(150));fx.process(...p,10,128);
  near(p[0][58],Math.SQRT1_2);assert.ok(p[1].every(v=>Math.abs(v)<1e-15));
});

test('System Variation retains stereo CC94 sends and ignores insertion-only Dry/Wet on JS, WASM and SIMD',async()=>{
  for(const type of [5,6,7,8])for(const dsp of ['js','wasm','wasm-simd']){
    const bytes=midi([...setup(type),...tone]),prepared=await loader.load(bytes);
    const other=midi([...setup(type),event(parameter(10,1)),...tone]);
    const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(other,prepared.bank,{dsp});
    const dry=await createSoundFontPreview(bytes,prepared.bank,{dsp,effects:false});
    try{assert.equal(p.stats.diagnostics.summary.unsupported,0);assert.equal(p.stats.diagnostics.summary.unverified,0);
      const pcm=p.read(72000),dryPcm=dry.read(72000);samePCM(pcm,q.read(72000),'type '+type+' '+dsp);assert.ok(energy(pcm)>1);assert.ok(pcm.some((row,c)=>{const other=dryPcm[c];return row.some((v,i)=>Math.abs(v-other[i])>1e-5);}));;
    }finally{p.close();q.close();dry.close();}
  }
});

test('insertion Thru retains original PCM; No Effect disables the System bus; effects:false preserves exact dry PCM',async()=>{
  const plain=midi([event(reset),...tone]);
  const insert=midi([...setup(5),event(packet(0x40,[0x40,0])),event(packet(0x5a,[0,0])),...tone]);
  const off=midi([...setup(5),event(packet(0x40,[0,0])),...tone]);
  const wet=midi([...setup(5),...tone]);
  for(const dsp of ['js','wasm','wasm-simd']){
    const previews=await Promise.all([plain,insert,off,wet,plain].map((bytes,i)=>createSoundFontPreview(bytes,prepared.bank,{dsp,effects:i<3})));
    try{assert.equal(previews[1].stats.diagnostics.summary.unsupported,0);
      const pcm=previews.map(p=>p.read(72000));samePCM(pcm[0],pcm[1],'insertion fallback');samePCM(pcm[0],pcm[2],'System No Effect');samePCM(pcm[3],pcm[4],'effects:false dry identity');
    }finally{previews.forEach(p=>p.close());}
  }
});

test('fragmented F0/F7 and MIDI ports retain exact final-byte timing for live Variation changes',async()=>{
  const command=parameter(1,3500),track=[...setup(6),...tone.slice(0,5),[60,0xf0,8,...command.slice(0,8)],[60,0xf7,...vlq(command.length-8),...command.slice(8)],[120,0x80,60,64],end];
  const second=[[0,255,33,1,7],[0,0xc1,81],[0,0xb1,94,127],[0,0x91,67,90],[...vlq(480),0x81,67,64],end];
  const bytes=midiTracks([track,second]),direct=midiTracks([[...setup(6),...tone.slice(0,5),event(command,120),[120,0x80,60,64],end],second]);
  const prepared=await loader.load(bytes);
  for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(direct,prepared.bank,{dsp});
    try{samePCM(p.read(100000),q.read(100000));assert.equal(p.stats.diagnostics.summary.unsupported,0);}finally{p.close();q.close();}}
});

test('XG delay memory, parameter changes and wet tails survive exact seeks and checkpoints on every DSP',async()=>{
  const bytes=midi([...setup(8),...tone.slice(0,-1),event(parameter(3,110),120),[...vlq(1920),255,47,0]]),prepared=await loader.load(bytes);
  for(const dsp of ['js','wasm','wasm-simd']){
    const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp});
    try{const pcm=p.read(144000);for(const frame of [6001,24001,60001,96001]){
      await p.seek(frame/48000);const saved=p.capture(),actual=p.read(12001);samePCM(actual,pcm.map(row=>row.slice(frame,frame+12001)),dsp+' seek '+frame);
      saved.restore();samePCM(p.read(12001),actual);saved.restore();samePCM(p.read(12001),actual);
    }}finally{p.close();}
  }
});


test('complete MIDI PCM matches an independent delayed dry-stereo reference, including live part pan on every DSP',async()=>{
  const notes=[[0,0xc0,81],[0,0xb0,91,0],[0,0xb0,93,0],[0,0xb0,94,127],[0,0xb0,10,0],[0,0x90,60,100],
    [120,0xb0,10,127],[120,0xb0,10,64],[...vlq(240),0x80,60,64],end];
  const baseline=midi([event(reset),...notes]),settings=[event(reset),event(packet(0x40,[6,0])),event(packet(0x56,[96,64,0,0,1])),
    ...[[1,1000],[2,1000],[3,1000],[4,1000],[5,64],[6,10],[13,28],[14,64],[15,46],[16,64]].map(([p,v])=>event(parameter(p,v)))];
  const wet=midi([...settings,...notes]),prepared=await loader.load(wet),references=[];
  for(const dsp of ['js','wasm','wasm-simd']){
    const p=await createSoundFontPreview(wet,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(baseline,prepared.bank,{dsp}),r=await createSoundFontPreview(baseline,prepared.bank,{dsp,effects:false});
    try{
      const actual=p.read(96000),ordinary=q.read(96000),dry=r.read(96000);let maximum=0;
      for(let c=0;c<2;c++)for(let i=0;i<actual[c].length;i++){
        const expected=ordinary[c][i]+(i>=4800?dry[c][i-4800]:0);maximum=Math.max(maximum,Math.abs(actual[c][i]-expected));
      }
      assert.ok(maximum<1e-6,dsp+' stereo delayed PCM maximum error '+maximum);references.push(actual);
      if(references.length>1){let delta=0;for(let c=0;c<2;c++)for(let i=0;i<actual[c].length;i++)delta=Math.max(delta,Math.abs(references[0][c][i]-actual[c][i]));assert.ok(delta<1e-6,dsp+' versus JS maximum '+delta);}
    }finally{p.close();q.close();r.close();}
  }
});


test('XG configuration outside XG mode reports inactive audio routing instead of claiming an audible effect',async()=>{
  const s=await synth();s.synthCore.reset('gs');
  let rows=notices(()=>send(s,0x5a,[1]));assert.ok(rows.some(r=>r.reason?.includes('requires XG System On')));assert.equal(s.synthCore.xgVariation.active,false);
  s.systemExclusive(reset);rows=notices(()=>send(s,0x5a,[1]));assert.ok(rows.every(r=>r.kind==='implemented'));assert.equal(s.synthCore.xgVariation.active,true);
});

test('real Worker selective loading exports XG diagnostics and exact wet PCM after seeking',async()=>{
  const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;
  const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};
  const bytes=midi([...setup(8),...tone.slice(0,-1),event(packet(0x41,[1]),240),[...vlq(960),255,47,0]]),prepared=await loader.load(bytes);
  const reference=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp:'wasm'});
  try{
    const loaded=await call('load',{bytes,epoch:1,dsp:'wasm',effects:true});assert.equal(loaded.sampleBank.mode,'samples');
    assert.ok(loaded.diagnostics.entries.some(r=>r.reason?.includes('Unsupported effect type. Using Thru.')));
    worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);
    for(const [epoch,time]of [[2,.31],[3,.71],[4,.01]]){
      await call('seek',{seconds:time,epoch});await reference.seek(time);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch});
      samePCM((await pending)[0].channels,reference.read(2048),'Worker seek '+time);
    }
  }finally{reference.close();channel.port1.close();await worker.terminate();}
});
