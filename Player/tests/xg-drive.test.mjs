import test from'node:test';import assert from'node:assert/strict';
import { XGDrive } from'../xg-drive.js';import { createXGEffect,xgEffectRange } from'../xg-effect-types.js';

test('XG Distortion factory program exactly transcribes Effect2, with distinct overdrive and insertion ranges',()=>{
  const fx=createXGEffect(48000,0x49,0,'insertion');assert.deepEqual(Array.from(fx.parameters),[40,20,72,53,64,0,43,74,10,127,120,0,0,0,0,0]);
  assert.equal(fx.family,'drive');assert.equal(createXGEffect(48000,0x49,1,'insertion'),undefined);
  for(const type of [1,2,3,4,5,6,7,8,0x41,0x42,0x43,0x49,0x4a]){const p=createXGEffect(48000,type,0,'insertion');for(let n=1;n<=16;n++){const range=xgEffectRange(p,n);if(range)assert.ok(p.parameters[n-1]>=range[0]&&p.parameters[n-1]<=range[1],type+' parameter '+n);}}
  assert.deepEqual(xgEffectRange(createXGEffect(48000,5,0,'insertion'),1),[1,7429]);assert.deepEqual(xgEffectRange(createXGEffect(48000,8,0,'insertion'),1),[1,3714]);assert.deepEqual(xgEffectRange(createXGEffect(48000,1,0,'insertion'),12),[0,2]);
});

test('XG Drive edge, mono sum, output level and untouched dry taps match an independent nonlinear reference',()=>{
  for(const type of [0x49,0x4a])for(const edge of [0,64,127]){
    const fx=new XGDrive(48000,type,'insertion');for(const [p,v]of [[1,127],[3,64],[4,60],[5,127],[8,64],[11,edge]])fx.setParameter(p,v);
    const l=new Float32Array([0,.01,-.01,.2,-.5,1]),r=new Float32Array([.01,0,.1,.2,.4,-1]),out=Array.from({length:4},()=>new Float32Array(l.length));fx.process(l,r,out[0],out[1],l.length,out[2],out[3]);
    for(let i=0;i<l.length;i++){const input=(l[i]+r[i])*.5*(type===0x49?64:32),expected=Math.tanh(input)*(1-edge/127)+Math.max(-1,Math.min(1,input))*edge/127;assert.ok(Math.abs(out[0][i]-expected)<1e-7);assert.equal(out[0][i],out[1][i]);assert.equal(out[2][i],l[i]);assert.equal(out[3][i],r[i]);}
  }
});

test('drive filter gains use real Hz/dB, output level0 mutes wet but does not change dry and reset clears state',()=>{
  const fx=new XGDrive(48000,0x49,'insertion');for(const [p,v]of [[1,0],[3,64],[4,60],[5,127],[7,34],[8,76],[9,10],[11,127]])fx.setParameter(p,v);
  const input=Float32Array.from({length:48000},(_,i)=>.01*Math.sin(i*2*Math.PI*1000/48000)),out=[new Float32Array(48000),new Float32Array(48000)],dry=[new Float32Array(48000),new Float32Array(48000)];fx.process(input,input,...out,48000,...dry);let a=0,b=0;for(let i=24000;i<48000;i++){a+=input[i]*input[i];b+=out[0][i]*out[0][i];}assert.ok(Math.abs(10*Math.log10(b/a)-12)<.002);
  fx.setParameter(5,0);fx.process(input,input,...out,48000,...dry);assert.ok(out.every(row=>row.every(v=>v===0)));assert.deepEqual(dry[0],input);
  fx.clear();fx.setParameter(5,127);const zero=new Float32Array(48000);fx.process(zero,zero,...out,48000);assert.ok(out.every(row=>row.every(v=>v===0)));
});

test('only Variation Drive uses the documented gate; separate insertion preserves very quiet signals',()=>{
  const signal=Float32Array.from({length:128},()=>1e-8),zero=new Float32Array(128),result=[];
  for(const block of ['variation','insertion']){const fx=new XGDrive(48000,0x4a,block),out=[new Float32Array(128),new Float32Array(128)];fx.process(signal,zero,...out,128);result.push(out);}
  assert.ok(result[0].every(row=>row.every(v=>v===0)));assert.ok(result[1].some(row=>row.some(v=>Math.abs(v)>0)));
});
