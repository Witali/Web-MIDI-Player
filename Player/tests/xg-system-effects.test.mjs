import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker,MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { GeneratorTypes,SpessaLog,SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { installVoiceDSP } from '../voice-dsp.js';
import { installXGVariation } from '../xg-variation.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { XGChorus } from '../xg-chorus.js';
import { XGReverb } from '../xg-reverb.js';
import { Biquad } from '../effect-dsp.js';
import { XG_REVERB_TIME,XG_INITIAL_DELAY,XG_DELAY_OFFSET,XG_LFO_FREQUENCY } from '../xg-effect-values.js';
import { midi,midiTracks,vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const end=[0,255,47,0],packet=(a,data)=>new Uint8Array([0x43,0x10,0x4c,2,1,a,...data,0xf7]);
const event=(data,ticks=0)=>[...vlq(ticks),0xf0,...vlq(data.length),...data];
const reset=new Uint8Array([0x43,0x10,0x4c,0,0,0x7e,0,0xf7]);
const tone=[[0,0xc0,81],[0,0x90,60,100],[...vlq(240),0x80,60,64],end];
const loader=new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))}),prepared=await loader.load(midi(tone));
async function synth(dsp='js',effects=true){
  const s=new SpessaSynthProcessor(48000,{effectsEnabled:effects,eventsEnabled:false,maxBufferSize:128});
  s.onMissingPreset=(p,sys)=>prepared.bank.getPreset(p,sys);s.soundBankManager.addSoundBank(prepared.bank,'main');await s.processorInitialized;
  installXGVariation(s);s.systemExclusive(reset);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);
  s.programChange(0,81);if(dsp!=='js')await installVoiceDSP(s,dsp);return s;
}
const send=(s,a,data)=>s.systemExclusive(packet(a,data));
const parameter=(s,block,p,value)=>send(s,block+(p<=10?p+1:p+5),[value]);
const notices=fn=>{const rows=[],before=SpessaLog.onDiagnostic;SpessaLog.onDiagnostic=e=>rows.push(e);try{fn();}finally{SpessaLog.onDiagnostic=before;}return rows;};
const energy=rows=>rows.reduce((sum,row)=>sum+row.reduce((s,v)=>s+v*v,0),0);
const maximum=(a,b)=>{let error=0;for(let c=0;c<a.length;c++){assert.equal(a[c].length,b[c].length);for(let i=0;i<a[c].length;i++)error=Math.max(error,Math.abs(a[c][i]-b[c][i]));}return error;};
const equal=(a,b,label='')=>assert.equal(maximum(a,b),0,label);
function render(s,frames){const pcm=[new Float32Array(frames),new Float32Array(frames)];for(let at=0;at<frames;at+=128)s.process(...pcm,at,Math.min(128,frames-at));return pcm;}

// Values are independently transcribed from MU100 printed pp.11,13-14,25-26,41-42.
test('System factory programs and physical parameter tables match Yamaha defaults and lookup endpoints',async()=>{
  const s=await synth(),fx=s.synthCore.xgSystemEffects;
  assert.equal(fx.reverb.type,0x100);assert.equal(fx.chorus.type,0x4100);
  assert.deepEqual(Array.from(fx.reverb.parameters),[18,10,8,13,49,0,0,0,0,0,0,4,50,8,64,0]);
  assert.deepEqual(Array.from(fx.chorus.parameters),[6,54,77,106,0,28,64,46,64,64,46,64,10,0,0,0]);
  assert.equal(XG_REVERB_TIME[0],.3);assert.equal(XG_REVERB_TIME[18],2.1);assert.equal(XG_REVERB_TIME[69],30);
  assert.equal(XG_INITIAL_DELAY[0],.1);assert.equal(XG_INITIAL_DELAY[63],99.3);
  assert.equal(XG_DELAY_OFFSET[63],6.3);assert.equal(XG_DELAY_OFFSET[127],50);assert.equal(XG_LFO_FREQUENCY[64],2.69);assert.equal(XG_LFO_FREQUENCY[127],39.7);
  parameter(s,0,1,69);parameter(s,0,3,63);parameter(s,0x20,1,127);parameter(s,0x20,4,127);
  assert.equal(fx.reverb.processor.reverbTime,30);assert.equal(fx.reverb.processor.initialDelay,99.3*48);assert.equal(fx.chorus.processor.frequency,39.7);assert.equal(fx.chorus.processor.offset,2400);
});

test('complete and partial type records apply in order, preserve routing controls and reject undocumented values',async()=>{
  const s=await synth(),fx=s.synthCore.xgSystemEffects;
  const good=notices(()=>{send(s,0,[2,1,30,4,6,0,60]);send(s,0x0c,[96,127]);send(s,0x20,[0x43,1,10,40,100,20]);send(s,0x30,[30,64,10,124]);});
  assert.ok(good.every(r=>r.kind==='implemented'));assert.equal(fx.reverb.type,0x201);assert.equal(fx.reverb.parameters[0],30);assert.equal(fx.chorus.parameters[3],20);assert.equal(fx.chorus.parameters[13],124);
  send(s,1,[2]);assert.equal(fx.reverb.type,0x202);assert.equal(fx.reverb.raw[12],96);assert.equal(fx.reverb.raw[13],127);assert.equal(fx.reverb.parameters[0],18,'type macro resets before following overrides');
  const before=Array.from(fx.chorus.parameters),rows=notices(()=>{parameter(s,0x20,4,64);parameter(s,0x20,14,3);parameter(s,0x20,7,51);parameter(s,0,1,70);parameter(s,0,14,0);send(s,0x0d,[0]);});
  assert.equal(rows.length,6);assert.ok(rows.every(r=>r.kind!=='implemented'));assert.deepEqual(Array.from(fx.chorus.parameters),before);
  const bad=notices(()=>send(s,0,[0x7f,0x7f]));assert.equal(fx.reverb.mode,'thru');assert.ok(bad.some(r=>r.reason?.includes('Thru')));send(s,0,[1]);assert.equal(fx.reverb.type,0x17f);send(s,1,[1]);assert.equal(fx.reverb.type,0x101);
});

test('RBJ HPF/LPF use physical Hz, Butterworth cutoff gain and explicit Thru',()=>{
  for(const high of [false,true]){
    const f=new Biquad();f.filter(48000,1000,high);let input=0,output=0;
    for(let i=0;i<48000;i++){const x=Math.sin(2*Math.PI*1000*i/48000),y=f.process(x);if(i>24000){input+=x*x;output+=y*y;}}
    assert.ok(Math.abs(10*Math.log10(output/input)+3.01029995664)<.002);f.filter(48000,0,high);assert.equal(f.process(.42),.42);
  }
});

test('Chorus mono/stereo input and Celeste three-phase taps match independent fractional impulse positions',()=>{
  const process=(type,mode)=>{const fx=new XGChorus(10000,type);for(const [p,v]of [[1,0],[2,127],[3,64],[4,0],[15,mode]])fx.setParameter(p,v);
    const input=new Float32Array(128),zero=new Float32Array(128),out=[new Float32Array(128),new Float32Array(128)];input[0]=1;fx.process(input,zero,...out,128);return out;};
  const stereo=process(0x42,1),mono=process(0x42,0);assert.ok(stereo[1].every(v=>v===0));
  const expected=new Float32Array(128);for(const phase of [0,2*Math.PI/3,4*Math.PI/3]){const delay=(1+Math.sin(phase))*30,at=Math.floor(delay),fraction=delay-at;expected[at]+=(1-fraction)/3;expected[at+1]+=fraction/3;}
  assert.ok(maximum([stereo[0]],[expected])<1e-7);assert.ok(maximum([mono[0]],[Float32Array.from(expected,v=>v*.5)])<1e-7);assert.ok(energy([mono[1]])>0);
  const plain=process(0x41,1);assert.ok(maximum(plain,stereo)>.01,'Celeste is not a renamed single chorus tap');
});

test('Flanger phase difference controls independent channels in three-degree units; reset removes feedback history',()=>{
  const fx=new XGChorus(48000,0x43);for(const [p,v]of [[1,64],[2,127],[3,110],[4,16],[14,64]])fx.setParameter(p,v);
  const input=Float32Array.from({length:10000},(_,i)=>Math.sin(i*.13)*.1),out=[new Float32Array(10000),new Float32Array(10000)];fx.process(input,input,...out,10000);equal([out[0]],[out[1]]);
  fx.clear();fx.setParameter(14,124);assert.ok(Math.abs(fx.phaseDifference-Math.PI)<1e-14);fx.process(input,input,...out,10000);assert.ok(maximum([out[0]],[out[1]])>.01);
  fx.clear();const zero=new Float32Array(10000);fx.process(zero,zero,...out,10000);assert.ok(out.every(row=>row.every(v=>v===0)));
});

test('Reverb separates stereo early reflections, applies predelay and preserves an orthogonal RT60 feedback network',()=>{
  const fx=new XGReverb(10000,1);for(const [p,v]of [[2,0],[3,1],[4,0],[5,60],[11,0],[12,0],[13,1],[14,10],[15,64]])fx.setParameter(p,v);
  const input=new Float32Array(100),zero=new Float32Array(100),out=[new Float32Array(100),new Float32Array(100)];input[0]=1;fx.process(input,zero,...out,100);
  assert.ok(out[0].subarray(0,17).every(v=>v===0));assert.ok(Math.abs(out[0][17]-.70710678118)<1e-7);assert.ok(out[1].every(v=>v===0),'early reflection stays on the source side');
  fx.setParameter(1,7);assert.equal(fx.reverbTime,1);for(let i=0;i<8;i++)assert.ok(Math.abs(fx.gains[i]-10**(-3*fx.lines[i].length/10000))<1e-14);
  const tail=time=>{const effect=new XGReverb(10000,1);for(const [p,v]of [[1,time],[4,0],[5,60],[13,127],[14,10]])effect.setParameter(p,v);
    const signal=new Float32Array(40000),silence=new Float32Array(40000),result=[new Float32Array(40000),new Float32Array(40000)];signal[0]=1;effect.process(signal,silence,...result,40000);assert.ok(result.every(row=>row.every(Number.isFinite)));return result;};
  const short=tail(0),long=tail(47);assert.ok(energy(long.map(row=>row.slice(10000,20000)))>1000*energy(short.map(row=>row.slice(10000,20000))));
  fx.clear();fx.process(zero,zero,...out,100);assert.ok(out.every(row=>row.every(v=>v===0)));
});

test('Chorus-to-Reverb taps precede Chorus pan/return and Variation preserves stereo serial sends',async()=>{
  const s=await synth(),fx=s.synthCore.xgSystemEffects;
  send(s,0,[0,0]);for(const [p,v]of [[1,0],[2,0],[3,64],[4,0],[15,1]])parameter(s,0x20,p,v);
  send(s,0x2c,[0,127,96]);fx.begin();fx.chorus.inputL[0]=1;const out=[new Float32Array(128),new Float32Array(128)];fx.process(...out,0,128);
  assert.equal(fx.reverb.inputL[0],1);assert.equal(fx.reverb.inputR[0],0);assert.ok(out.every(row=>row.every(v=>v===0)),'return=0 mutes output while the serial send still receives it');
  fx.begin();fx.variation(.5,.25,1,.5,3);assert.equal(fx.reverb.inputL[3],.5);assert.equal(fx.reverb.inputR[3],.25);assert.equal(fx.chorus.inputL[3],.25);assert.equal(fx.chorus.inputR[3],.125);
});

test('actual JS/WASM/SIMD System Chorus PCM equals an independent dry stereo/mono reference at zero modulation',async()=>{
  for(const dsp of ['js','wasm','wasm-simd'])for(const mode of [0,1]){
    const wet=await synth(dsp),dry=await synth(dsp,false);
    send(wet,0,[0,0]);for(const [p,v]of [[1,0],[2,0],[3,64],[4,0],[15,mode]])parameter(wet,0x20,p,v);send(wet,0x2c,[96,64,0]);
    for(const s of [wet,dry]){s.midiChannels[0].setGeneratorOverride(GeneratorTypes.chorusEffectsSend,1000);s.controllerChange(0,10,0);s.noteOn(0,60,100);}
    const actual=render(wet,12000),source=render(dry,12000),expected=source.map(row=>row.slice());
    for(let i=0;i<12000;i++)for(let c=0;c<2;c++)expected[c][i]+=mode?source[c][i]:(source[0][i]+source[1][i])*.5;
    assert.ok(maximum(actual,expected)<1e-6,dsp+' input mode '+mode+' error '+maximum(actual,expected));wet.stopAllChannels(true);dry.stopAllChannels(true);
  }
});

const setup=[event(reset),event(packet(0,[1,0,30,8,6,0,60])),event(packet(0x10,[4,4,64,10,64])),event(packet(0x0c,[96,64])),
  event(packet(0x20,[0x42,0,15,100,90,100])),event(packet(0x2c,[96,64,90])),event(packet(0x34,[1]))];
const score=midi([...setup,...tone.slice(0,-1),event(packet(0x20,[0x43,1]),120),event(packet(0x33,[124])),event(packet(0,[2,2]),120),[...vlq(1440),255,47,0]]);
test('all eight Reverb and eleven Chorus/Celeste/Flanger programs produce finite distinct PCM through published addresses',async()=>{
  const s=await synth(),fx=s.synthCore.xgSystemEffects;
  for(const [msb,variants]of [[1,[0,1]],[2,[0,1,2]],[3,[0,1]],[4,[0]],[0x41,[0,1,2,8]],[0x42,[0,1,2,8]],[0x43,[0,1,8]]]){
    let last;for(const lsb of variants){const rows=notices(()=>send(s,msb<5?0:0x20,[msb,lsb]));assert.ok(rows.every(r=>r.kind==='implemented'));
      const block=msb<5?fx.reverb:fx.chorus,input=new Float32Array(16000),zero=new Float32Array(16000),out=[new Float32Array(16000),new Float32Array(16000)];input[0]=1;block.processor.process(input,zero,...out,16000);
      assert.ok(energy(out)>1e-8);assert.ok(out.every(row=>row.every(Number.isFinite)));if(last)assert.ok(maximum(last,out)>1e-6);last=out;
    }
  }
});

test('full MIDI System parameters, both DSP histories and type reallocations restore exact seeks/checkpoints on every backend',async()=>{
  const prepared=await loader.load(score);for(const dsp of ['js','wasm','wasm-simd']){
    const p=await createSoundFontPreview(score,prepared.bank,{prepared,dsp});try{
      assert.equal(p.stats.diagnostics.summary.unsupported,0);assert.equal(p.stats.diagnostics.summary.unverified,0);const reference=p.read(144000);assert.ok(energy(reference)>1);
      for(const frame of [6001,24001,60001]){await p.seek(frame/48000);const saved=p.capture(),block=p.read(48001);equal(block,reference.map(row=>row.slice(frame,frame+48001)),dsp+' seek');
        for(let repeat=0;repeat<2;repeat++){saved.restore();equal(p.read(48001),block,dsp+' type allocation checkpoint');}
      }
    }finally{p.close();}
  }
});

test('timed F0/F7 across ports and dry-only System parameters keep command order and waveform identity',async()=>{
  const command=packet(0x22,[40,120,64,100]),track=[...setup,...tone.slice(0,2),[60,0xf0,7,...command.slice(0,7)],[60,0xf7,...vlq(command.length-7),...command.slice(7)],event(packet(0x2b,[1])),[120,0x80,60,64],end];
  const other=[[0,255,33,1,7],[0,0xc1,81],[0,0x91,64,90],[...vlq(480),0x81,64,64],end];
  const bytes=midiTracks([track,other]),plain=midiTracks([[...setup,...tone.slice(0,2),event(command,120),event(packet(0x2b,[127])),[120,0x80,60,64],end],other]);
  const prepared=await loader.load(bytes);for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp}),q=await createSoundFontPreview(plain,prepared.bank,{dsp});
    try{equal(p.read(60000),q.read(60000));assert.equal(p.stats.diagnostics.summary.unsupported,0);}finally{p.close();q.close();}}
});

test('System None and effects:false preserve dry PCM; actual Worker supplies full diagnostics and exact wet seeks',async()=>{
  const prepared=await loader.load(score),worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;
  const call=async(type,data)=>{const pending=once(worker,'message');worker.postMessage({type,id:++id,...data});const reply=(await pending)[0];assert.equal(reply.error,undefined);return reply.result;};
  const reference=await createSoundFontPreview(score,prepared.bank,{prepared,dsp:'wasm'});
  try{const loaded=await call('load',{bytes:score,epoch:1,effects:true,dsp:'wasm'});assert.equal(loaded.diagnostics.summary.unsupported,0);assert.equal(loaded.sampleBank.mode,'samples');worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);
    await call('seek',{seconds:.71,epoch:2});await reference.seek(.71);const pending=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch:2});equal((await pending)[0].channels,reference.read(2048));
  }finally{reference.close();channel.port1.close();await worker.terminate();}
  const off=midi([event(reset),event(packet(0,[0,0])),event(packet(0x20,[0,0])),...tone]);
  for(const dsp of ['js','wasm','wasm-simd']){const p=await createSoundFontPreview(off,prepared.bank,{dsp}),q=await createSoundFontPreview(off,prepared.bank,{dsp,effects:false});try{equal(p.read(60000),q.read(60000));}finally{p.close();q.close();}}
});
