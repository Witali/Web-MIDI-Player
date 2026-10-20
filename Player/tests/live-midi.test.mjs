import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker,MessageChannel}from'node:worker_threads';
import {once}from'node:events';
import {LiveMidiPlayer}from'../live-midi.js';
import {WebMidiPorts}from'../web-midi.js';
function calls(worker){let id=0;const pending=new Map();worker.on('message',data=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);if(data.error){const e=new Error(data.error);e.name=data.name;p.reject(e);}else p.resolve(data.result);});return(type,data={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});worker.postMessage({type,id:key,...data});});}
const energy=channels=>channels.reduce((sum,c)=>sum+c.reduce((n,v)=>n+v*v,0),0);
test('real live Worker initializes lazily, renders raw notes, and rejects stale PCM epochs after panic',async()=>{
 const worker=new Worker(new URL('./live-worker-fixture.mjs',import.meta.url)),call=calls(worker),channel=new MessageChannel();
 try{
  const initial=await call('init',{effects:false,dsp:'wasm'});assert.equal(initial.sampleBank.samples,0);
  worker.postMessage({type:'connect',port:channel.port2,epoch:1},[channel.port2]);
  const read=async epoch=>{const next=once(channel.port1,'message');channel.port1.postMessage({epoch});return(await next)[0];};
  assert.equal(energy((await read(1)).channels),0);
  const sent=await call('midi',{bytes:Uint8Array.from([0xc0,73,0x90,69,110])});assert.ok(sent.voices>0);assert.ok(sent.sampleBank.samples>0&&sent.sampleBank.samples<200);
  assert.ok(energy((await read(1)).channels)>0);
  await call('midi',{bytes:Uint8Array.from([0xb0,64,127,0x90,69,0])});assert.ok(energy((await read(1)).channels)>0);
  await call('panic',{epoch:2});channel.port1.postMessage({epoch:1});const silent=await read(2);assert.equal(silent.epoch,2);assert.equal(energy(silent.channels),0);
  await assert.rejects(call('midi',{bytes:Uint8Array.of(0x90,60)}),/Incomplete/);
  await call('midi',{bytes:Uint8Array.from([0x90,60,100])});assert.ok(energy((await read(2)).channels)>0);
 }finally{channel.port1.close();await worker.terminate();}
});
test('public live API uses a real Worker; selected input feeds it, panic flushes PCM and disposal releases resources',async()=>{
 const original=[globalThis.Worker,globalThis.AudioContext,globalThis.AudioWorkletNode],workers=[],contexts=[],nodes=[];
 globalThis.Worker=class{constructor(){this.worker=new Worker(new URL('./live-worker-fixture.mjs',import.meta.url));this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.(error));workers.push(this);}postMessage(d,t){this.worker.postMessage(d,t);}terminate(){this.terminated=true;return this.worker.terminate();}};
 globalThis.AudioContext=class{constructor(){this.sampleRate=44100;this.currentTime=0;this.destination={};this.audioWorklet={addModule:async()=>{}};contexts.push(this);}resume(){this.resumed=true;return Promise.resolve();}createGain(){return{gain:{value:0,setTargetAtTime(){}},connect(){},disconnect(){}};}async close(){this.closed=true;}};
 globalThis.AudioWorkletNode=class{constructor(){this.messages=[];this.port={postMessage:d=>{this.messages.push(d);if(d.type==='connect')this.stream=d.port;},close:()=>this.stream?.close()};nodes.push(this);}connect(){}disconnect(){this.disconnected=true;}};
 const ports=new WebMidiPorts({navigator:{}}),live=new LiveMidiPlayer({effects:false,dsp:'wasm',ports});
 try{
  assert.equal(workers.length,0);await live.start();assert.equal(live.state,'running');assert.equal(live.metadata.sampleRate,48000);assert.equal(contexts[0].resumed,true);
  const messages=[];const send=live.send.bind(live);live.send=data=>{messages.push([...data]);return send(data);};
  ports.dispatchEvent(new CustomEvent('midimessage',{detail:{data:Uint8Array.from([0x90,60,100])}}));
  await live.send([0x80,60,0]);assert.deepEqual(messages,[[0x90,60,100],[0x80,60,0]]);
  const epoch=live._epoch;await live.panic();assert.equal(live._epoch,epoch+1);assert.equal(nodes[0].messages.at(-2).running,false);assert.equal(nodes[0].messages.at(-1).running,true);
  await live.stop();assert.equal(live.state,'stopped');assert.equal(contexts[0].closed,true);assert.equal(workers[0].terminated,true);assert.equal(nodes[0].disconnected,true);
  await live.start();assert.equal(workers.length,2);await live.dispose();assert.equal(live.state,'disposed');assert.equal(ports.state,'disposed');await assert.rejects(live.send([0xfe]),/disposed/);
 }finally{await live.dispose();await Promise.all(workers.map(w=>w.worker.terminate()));[globalThis.Worker,globalThis.AudioContext,globalThis.AudioWorkletNode]=original;}
});
test('stopping pending audio initialization cannot revive a stale session or overwrite a new start',async()=>{
 const original=[globalThis.Worker,globalThis.AudioContext,globalThis.AudioWorkletNode];const workers=[];let release;
 globalThis.Worker=class{constructor(){workers.push(this);}postMessage(data){if(data.type==='init')this.id=data.id;}terminate(){}};
 globalThis.AudioContext=class{constructor(){this.audioWorklet={addModule:async()=>{}};this.destination={};}resume(){return Promise.resolve();}async close(){}createGain(){return{gain:{},connect(){},disconnect(){}};}};
 globalThis.AudioWorkletNode=class{constructor(){this.port={postMessage:d=>{if(d.type==='connect')this.stream=d.port;},close:()=>this.stream?.close()};}connect(){}disconnect(){}};
 const live=new LiveMidiPlayer({ports:new WebMidiPorts({navigator:{}})});
 try{
  const first=live.start();const rejected=assert.rejects(first,{name:'AbortError'});await live.stop();const second=live.start();workers[0].onmessage({data:{id:workers[0].id,result:{stale:true}}});workers[1].onmessage({data:{id:workers[1].id,result:{fresh:true}}});await rejected;await second;
  assert.equal(live.state,'running');assert.equal(live.metadata.fresh,true);await live.dispose();
 }finally{await live.dispose();[globalThis.Worker,globalThis.AudioContext,globalThis.AudioWorkletNode]=original;}
});
test('live Worklet keeps a bounded short queue, stereo, silence and epoch cancellation at 48/44.1 kHz',async()=>{
 const original=[globalThis.sampleRate,globalThis.AudioWorkletProcessor,globalThis.registerProcessor];let Processor;
 globalThis.AudioWorkletProcessor=class{constructor(){this.port={postMessage(){}};}};globalThis.registerProcessor=(_n,p)=>Processor=p;
 try{
  await import('../live-worklet.js');
  for(const rate of[48000,44100]){
   globalThis.sampleRate=rate;const p=new Processor();let reads=0;const stream={start(){},postMessage(data){reads++;const left=new Float32Array(256).fill(.25);stream.onmessage({data:{epoch:data.epoch,channels:[left,left.map(x=>-x)]}});}};
   p.port.onmessage({data:{type:'connect',port:stream}});p.port.onmessage({data:{type:'reset',epoch:1,running:true}});
   const output=[new Float32Array(128),new Float32Array(128)];for(let i=0;i<300;i++){p.process([],[output]);assert.ok(output[0].every((v,n)=>v===-output[1][n]));assert.ok(p.queues[0].length<=768);}
   assert.ok(reads>100);const queued=p.queues[0].length;stream.onmessage({data:{epoch:0,channels:[new Float32Array(256),new Float32Array(256)]}});assert.equal(p.queues[0].length,queued);
   p.port.onmessage({data:{type:'reset',epoch:2,running:false}});p.process([],[output]);assert.equal(energy(output),0);assert.equal(p.queues[0].length,0);
  }
 }finally{[globalThis.sampleRate,globalThis.AudioWorkletProcessor,globalThis.registerProcessor]=original;}
});
