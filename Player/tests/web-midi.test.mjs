import test from 'node:test';
import assert from 'node:assert/strict';
import { WebMidiPorts, midiMessages } from '../web-midi.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
class Port extends EventTarget {
  constructor(id, type) { super(); Object.assign(this, { id, type, name: id, manufacturer: 'Test', version: '1', state: 'connected', connection: 'closed', sent: [], opens: 0, closes: 0, clears: 0 }); }
  async open() { this.opens++; await this.gate?.promise; this.connection='open'; return this; }
  async close() { this.closes++; this.connection='closed'; return this; }
  send(data, time=0) { this.sent.push({ data: [...data], time }); }
  clear() { this.clears++; }
  message(data, time=0) { const event=new Event('midimessage'); Object.defineProperties(event,{data:{value:Uint8Array.from(data)},timeStamp:{value:time}}); this.dispatchEvent(event); return event; }
}
class Access extends EventTarget {
  constructor(sysex=false) { super(); this.sysexEnabled=sysex; this.inputs=new Map(['a','b'].map(id=>[id,new Port(id,'input')])); this.outputs=new Map(['x','y'].map(id=>[id,new Port(id,'output')])); }
  change(port,state) { port.state=state; this.dispatchEvent(new Event('statechange')); }
}
function fixture(sysex=false) {
  const access=new Access(sysex), requests=[];
  const midi=new WebMidiPorts({navigator:{requestMIDIAccess(options){requests.push(options);return Promise.resolve(access);}}});
  return {access,midi,requests};
}

test('Web MIDI access is explicit; enumerating ports never picks a device',async()=>{
 const {midi,access,requests}=fixture(); assert.equal(requests.length,0); assert.equal(midi.supported,true);
 assert.deepEqual(await midi.request(),midi.ports); assert.deepEqual(requests,[{sysex:false,software:false}]);
 assert.equal(midi.selection.input,null); assert.equal(midi.selection.output,null);
 assert.equal([...access.inputs.values(),...access.outputs.values()].reduce((n,p)=>n+p.opens,0),0);
 await midi.selectInput('b'); await midi.selectOutput('y');
 assert.equal(midi.selection.input.id,'b');assert.equal(midi.selection.output.id,'y');
 await midi.dispose(); assert.equal(access.inputs.get('b').closes,1);assert.equal(access.outputs.get('y').closes,1);
});
test('complete wire messages include channel, common, realtime, and realtime within SysEx',()=>{
 const {messages,data,sysex}=midiMessages([0x90,60,0xf8,100,0xc0,7,0xd0,40,0xf1,2,0xf2,3,4,0xf3,5,0xf6,0xf0,0x7e,0xfe,0x7f,0xf7,0xff]);
 assert.deepEqual(messages.map(m=>[...m]),[[0xf8],[0x90,60,100],[0xc0,7],[0xd0,40],[0xf1,2],[0xf2,3,4],[0xf3,5],[0xf6],[0xfe],[0xf0,0x7e,0x7f,0xf7],[0xff]]);
 assert.equal(data.length,22);assert.equal(sysex,true);
 for(const bad of [[],[60,1],[0x90,60],[0xf0,1],[0xf7],[0xf4],[0xf5],[0xf9],[0xfd],[0x90,128,1],[0xf0,1,0x90,2,0xf7],[256],[NaN],[-1],[1.5]]) assert.throws(()=>midiMessages(bad),TypeError);
});
test('input/thru retains every message and timestamp, independent of later input buffer mutation',async()=>{
 const {midi,access}=fixture(true);await midi.request({sysex:true});await midi.selectInput('a');await midi.selectOutput('x');midi.thru=true;
 const received=[];midi.addEventListener('midimessage',e=>received.push(e.detail));
 const sequence=[[0x90,60,1],[0xb0,64,127],[0xf8],[0xf1,0x12],[0xf0,0x7e,0x7f,6,1,0xf7],[0x90,60,0],[0xfe]];
 for(const data of sequence) access.inputs.get('a').message(data,42);
 access.inputs.get('b').message([0x90,70,127],42);
 assert.deepEqual(received.map(r=>[...r.data]),sequence);assert.ok(received.every(r=>r.timestamp===42&&r.port.id==='a'));
 assert.deepEqual(access.outputs.get('x').sent.map(s=>s.data),sequence);assert.ok(access.outputs.get('x').sent.every(s=>s.time===42));
 const event=access.inputs.get('a').message([0xc0,5]);event.data[1]=99;assert.equal(received.at(-1).data[1],5);
 await midi.dispose();
});
test('output preserves equal-time ordering, requires SysEx permission, rejects invalid bytes atomically',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectOutput('x');const p=access.outputs.get('x');
 for(let i=0;i<2000;i++)midi.send([0xb0,1,i%128],100);
 assert.deepEqual(p.sent.map(s=>s.data[2]),Array.from({length:2000},(_,i)=>i%128));
 assert.throws(()=>midi.send([0xf0,1,0xf7]),{name:'InvalidAccessError'});
 assert.throws(()=>midi.send([0x90,60,1,61,2]),TypeError);assert.equal(p.sent.length,2000);
 assert.throws(()=>midi.send([0xf8],-1),RangeError);assert.throws(()=>midi.send([0xf8],Infinity),RangeError);
 midi.clearOutput();assert.equal(p.clears,1);await midi.dispose();
});
test('switch output clears pending sends and releases used channels before closing',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectOutput('x');midi.send([0x93,60,127],0);midi.send([0x93,62,127],1000);
 await midi.selectOutput('y');const p=access.outputs.get('x');
 assert.deepEqual(p.sent.slice(2).map(s=>s.data),[64,66,69,120].map(cc=>[0xb3,cc,0]));assert.equal(p.clears,1);assert.equal(p.closes,1);
 midi.panic();assert.equal(access.outputs.get('y').sent.length,64);await midi.dispose();
});
test('disconnect unselects input/output; reconnect never silently chooses them again',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectInput('a');await midi.selectOutput('x');let count=0;midi.addEventListener('midimessage',()=>count++);
 const a=access.inputs.get('a'),x=access.outputs.get('x');access.change(a,'disconnected');access.change(x,'disconnected');
 assert.deepEqual(midi.selection,{input:null,output:null});access.change(a,'connected');access.change(x,'connected');a.message([0xfe]);assert.equal(count,0);
 const replacement=new Port('a','input');await midi.selectInput('a');access.inputs.set('a',replacement);access.change(replacement,'connected');assert.equal(midi.input,null);await midi.dispose();
});
test('failed selection retains old input and a pending open cannot steal a newer selection',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectInput('a');const b=access.inputs.get('b');b.gate=deferred();
 const pending=midi.selectInput('b');await midi.selectInput('a');b.gate.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(midi.input.id,'a');assert.equal(b.closes,1);
 b.gate=deferred();const failed=midi.selectInput('b');b.gate.reject(new Error('busy'));await assert.rejects(failed,/busy/);assert.equal(midi.input.id,'a');await midi.dispose();
});
test('disconnect or dispose during native open cannot attach a listener afterward',async()=>{
 for(const action of ['disconnect','dispose']){
  const {midi,access}=fixture();await midi.request();const a=access.inputs.get('a');a.gate=deferred();const pending=midi.selectInput('a');
  if(action==='disconnect')access.change(a,'disconnected');else await midi.dispose();a.gate.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(midi.input,null);assert.equal(a.closes,1);await midi.dispose();
 }
});
test('permission denial is surfaced and does not discard an existing session',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectInput('a');midi.navigator.requestMIDIAccess=()=>Promise.reject(new DOMException('denied','NotAllowedError'));
 await assert.rejects(midi.request({sysex:true}),{name:'NotAllowedError'});assert.equal(midi.access,access);assert.equal(midi.input.id,'a');assert.equal(midi.state,'ready');await midi.dispose();
});
test('late permission result cannot revive disposed ports or supersede a newer request',async()=>{
 const first=deferred(),second=deferred();let n=0;const midi=new WebMidiPorts({navigator:{requestMIDIAccess(){return ++n===1?first.promise:second.promise;}}});
 const p1=midi.request();const p2=midi.request({sysex:true});second.resolve(new Access(true));await p2;first.resolve(new Access());await assert.rejects(p1,{name:'AbortError'});assert.equal(midi.sysexEnabled,true);
 const late=deferred();midi.navigator.requestMIDIAccess=()=>late.promise;const p3=midi.request();await midi.dispose();late.resolve(new Access());await assert.rejects(p3,{name:'AbortError'});assert.equal(midi.state,'disposed');
});
test('unsupported browser, missing ports and use after dispose have useful errors',async()=>{
 const midi=new WebMidiPorts({navigator:{}});assert.equal(midi.supported,false);await assert.rejects(midi.request(),/HTTPS/);await assert.rejects(midi.selectInput('a'),/Request MIDI/);assert.throws(()=>midi.send([0xfe]),/Select/);await midi.dispose();await assert.rejects(midi.request(),/disposed/);
});

test('superseded permission refresh cannot close an output selected under a newer permission result',async()=>{
 const {midi,access}=fixture();await midi.request();await midi.selectInput('a');await midi.selectOutput('x');
 const closing=deferred(),release=deferred(),a=access.inputs.get('a');a.close=async()=>{closing.resolve();await release.promise;};
 const firstAccess=new Access(),newAccess=new Access(true);let n=0;midi.navigator.requestMIDIAccess=async()=>++n===1?firstAccess:newAccess;
 const first=midi.request();await closing.promise;await midi.request({sysex:true});await midi.selectOutput('y');release.resolve();await assert.rejects(first,{name:'AbortError'});
 assert.equal(midi.output,newAccess.outputs.get('y'));assert.equal(midi.output.closes,0);await midi.dispose();
});
