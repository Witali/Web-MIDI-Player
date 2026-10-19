import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BasicMIDI, MIDIByteStream, SpessaLog, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { diagnoseMidi } from '../midi-diagnostics.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const parse=bytes=>BasicMIDI.fromArrayBuffer(bytes instanceof ArrayBuffer?bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const end=[0,255,47,0], name=[0,255,3,1,84];
const packets=data=>data.tracks.map(t=>t.events.map(e=>[e.ticks,e.statusByte,[...e.data]]));
const bytes=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const energy=pcm=>pcm.reduce((sum,n)=>sum+n*n,0);

// SMF RP-001 pp. 6-7: F7 has its own length and either continues SysEx or
// escapes arbitrary wire bytes. Meta and SysEx cancel SMF running status.
test('SMF roundtrip preserves F0/F7 packet boundaries, unknown meta, full payloads and final EOT delay',()=>{
 const data=parse(midi([name,[0,0xf0,3,0x43,0x12,0],[...vlq(200),0xf7,6,0x43,0x12,0,0x43,0x12,0],
  [...vlq(100),0xf7,4,0x43,0x12,0,0xf7],[0,255,0x7d,5,255,0,128,42,99],
  [0,0xf7,5,0xb0,7,100,0xf8,0xfa],[...vlq(1920),255,47,0]]));
 assert.deepEqual(packets(parse(data.writeMIDI())),packets(data));
 assert.equal(data.duration,2220/960,'End Of Track, rather than the last voice message, defines sequence length');
});

test('SMF running status crosses deltas but is cancelled by every meta and F0/F7 event',()=>{
 const valid=parse(midi([name,[0,0x90,60,100],[...vlq(240),64,110],[0,0x90,60,0],[0,64,0],end]));
 assert.equal(valid.tracks[0].events.filter(e=>e.statusByte===0x90).length,4);
 for(const event of [[0,255,1,0],[0,0xf0,5,0x7e,0x7f,9,1,0xf7],[0,0xf7,1,0xf8]]){
  assert.throws(()=>parse(midi([[0,0x90,60,100],event,[0,64,100],end])),/no running status/);
  assert.doesNotThrow(()=>parse(midi([[0,0x90,60,100],event,[0,0x90,64,100],end])));
 }
});

test('SMF honours extended headers and alien chunk lengths and rejects truncated or illegal events',()=>{
 const source=midi([name,[0,0x90,60,100],[...vlq(480),0x80,60,64],end]);
 const extended=Buffer.from(source.subarray(0,14));extended.writeUInt32BE(9,4);
 const alien=Buffer.from('4a554e4b0000000380ff00','hex');
 const future=new Uint8Array(Buffer.concat([extended,Buffer.from([42,0,255]),alien,source.subarray(14)]));
 assert.deepEqual(packets(parse(future)),packets(parse(source)));
 const invalid=[
  midi([[0,0xf0,6,0x43,0x7f]]),midi([[0,0xf7,4,0xf8]]),midi([[0,255,1,5,65]]),
  midi([[128,128,128,128,0,255,47,0]]),midi([[0,0x90,60]]),midi([[0,0x90,60,128],end]),
  midi([[0,255,128,0],end]),midi([[0,0xf8],end]),midi([[0,255,1,0]]),midi([end,[0,0xc0,1],end]),
  source.subarray(0,source.length-1)
 ];
 for(const bytes of invalid)assert.throws(()=>parse(bytes),SyntaxError);
});

test('wire decoder preserves running status and partial messages across real-time interrupts and packets',()=>{
 const stream=new MIDIByteStream(),actual=[],emit=(status,data)=>actual.push([status,[...data]]);
 stream.write([0xb0,7,0xf8],emit);stream.write([100,10,0xfa,127,0xf2,1,0xfb,2],emit);
 stream.write([0xf0,0x7e,0xfe],emit);stream.write([0x7f,9],emit);stream.write([1,0xf7,0xff],emit);
 assert.deepEqual(actual,[[0xf8,[]],[0xb0,[7,100]],[0xfa,[]],[0xb0,[10,127]],
  [0xfb,[]],[0xf2,[1,2]],[0xfe,[]],[0xf0,[0x7e,0x7f,9,1,0xf7]],[0xff,[]]]);
});

test('F7 escape commands reach the synth in wire order, including running-status controllers and notes',async()=>{
 const data=parse(midi([name,[0,0xc0,81],[0,0xf7,6,0xb0,7,20,10,127,0xf8],
  [0,0xf7,4,0x90,69,100,0xfe],[...vlq(480),0xf7,3,69,0,0xf8],end]));
 const synth=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});
 synth.soundBankManager.addSoundBank(bank,'main');await synth.processorInitialized;
 const sequence=new SpessaSynthSequencer(synth);sequence.skipToFirstNoteOn=false;sequence.loopCount=0;sequence.loadNewSongList([data]);
 const actual=[];sequence.onEventCall=({type,data})=>{if(type==='midiEvent')actual.push([data.event.statusByte,[...data.event.data]]);};
 try{
  sequence.play();const L=new Float32Array(128),R=new Float32Array(128);let power=[0,0];
  for(let n=0;!sequence.isFinished;n++){assert.ok(n<400);sequence.processTick();L.fill(0);R.fill(0);synth.process(L,R);power[0]+=energy(L);power[1]+=energy(R);}
  assert.deepEqual(actual,[[0xc0,[81]],[0xb0,[7,20]],[0xb0,[10,127]],[0xf8,[]],[0x90,[69,100]],[0xfe,[]],[0x90,[69,0]],[0xf8,[]]]);
  assert.ok(power[1]>.01&&power[1]>power[0]*1000,'Escaped notes and CC10 must produce real right-panned audio');
 }finally{synth.stopAllChannels(true);}
});

test('multipart SysEx applies at final-packet time and produces identical continuous and seek PCM',async()=>{
 const volume=[0x7f,0x7f,4,1,0,0,0xf7];
 const prefix=[name,[0,0xc0,81],[0,0x90,60,100]];
 const source=midi([...prefix,[0,0xf0,3,...volume.slice(0,3)],
  [...vlq(240),255,1,1,65],[...vlq(240),0xf7,4,...volume.slice(3)],
  [...vlq(480),0x80,60,64],end]);
 const reference=midi([...prefix,[...vlq(480),0xf0,volume.length,...volume],[...vlq(480),0x80,60,64],end]);
 for(const dsp of ['js','wasm','wasm-simd']){
  const split=await createSoundFontPreview(source,bank,{effects:false,dsp});
  const whole=await createSoundFontPreview(reference,bank,{effects:false,dsp});
  try{
   assert.equal(split.stats.diagnostics.summary.unverified,0,'An unfinished packet must not be diagnosed as an unknown SysEx command');
   let before=0,after=0;
   while(split.stats.position<.9){const t=split.stats.position,pcm=split.read(128);assert.deepEqual(pcm,whole.read(128));
    if(t>.15&&t<.35)before+=energy(pcm[0]);if(t>.65&&t<.85)after+=energy(pcm[0]);}
   assert.ok(before>.01&&after<before*1e-7,'Master volume must change at the last packet, not at F0');
   await split.seek(.63);await whole.seek(.63);assert.deepEqual(split.read(2048),whole.read(2048));
  }finally{split.close();whole.close();}
 }
});

test('diagnostics inspect escaped controllers and completed SysEx and report incomplete streams explicitly',async()=>{
 const data=parse(midi([name,[0,0xf7,3,0xb2,22,127],[0,0xf0,2,1,0x7f],
  [...vlq(480),0xf7,3,0,0,0xf7],[0,0xf0,2,0x43,0x10],end]));
 const report=await diagnoseMidi(data,bank);
 assert.ok(report.entries.some(e=>e.controller===22&&e.first.channel===3));
 assert.ok(report.entries.some(e=>e.feature==='System Exclusive'&&e.first.tick===480&&e.reason.includes('manufacturer')));
 assert.ok(report.entries.some(e=>e.feature==='Incomplete SysEx'&&e.reason.includes('End of sequence')));
 assert.ok(!report.entries.some(e=>e.code==='unverified-sysex'));
});

test('late SysEx and metadata beyond the last note are reached by the public audio reader',async()=>{
 const source=midi([name,[0,0xc0,81],[0,0x90,60,100],[...vlq(240),0x80,60,64],
  [...vlq(3600),0xf0,7,0x7f,0x7f,4,1,0,0,0xf7],[...vlq(480),255,6,1,65],end]);
 const data=parse(source);assert.equal(data.duration,4.5);
 const preview=await createSoundFontPreview(source,bank,{effects:false});
 try{assert.equal(preview.stats.sourceDuration,4.5);await preview.seek(4.6);assert.equal(preview.stats.position,4.6);assert.equal(preview.read(128)[0].length,128);}
 finally{preview.close();}
});


test('large SysEx payloads are retained without spreading them into function arguments',()=>{
 const payload=Array.from({length:180000},(_,i)=>i%128);payload.push(0xf7);
 const data=parse(midi([name,[0,0xf0,...vlq(payload.length),...payload],end]));
 assert.deepEqual([...data.tracks[0].events.find(e=>e.statusByte===0xf0).data],payload);
 assert.deepEqual(packets(parse(data.writeMIDI())),packets(data));
});

test('multipart SysEx streams remain independent on different output ports',async()=>{
 const source=midiTracks([
  [name,[0,255,33,1,17],[0,0xf0,2,0x7f,0x7f],[...vlq(480),0xf7,5,4,1,10,20,0xf7],end],
  [name,[0,255,33,1,42],[0,0xf0,3,0x7f,0x7f,4],[...vlq(240),0xf7,4,1,30,40,0xf7],end]
 ]);
 const data=parse(source),synth=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});
 synth.soundBankManager.addSoundBank(bank,'main');await synth.processorInitialized;
 const sequence=new SpessaSynthSequencer(synth);sequence.skipToFirstNoteOn=false;sequence.loopCount=0;sequence.loadNewSongList([data]);
 const actual=[];synth.systemExclusive=(bytes,offset)=>actual.push([[...bytes],offset]);
 try{sequence.play();const L=new Float32Array(128),R=new Float32Array(128);
  for(let i=0;!sequence.isFinished;i++){assert.ok(i<300);sequence.processTick();synth.process(L,R);}
  assert.deepEqual(actual,[[[0x7f,0x7f,4,1,30,40,0xf7],sequence.midiPortChannelOffsets[42]],
   [[0x7f,0x7f,4,1,10,20,0xf7],sequence.midiPortChannelOffsets[17]]]);
 }finally{synth.stopAllChannels(true);}
});
