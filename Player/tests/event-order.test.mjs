import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const bytes=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const parse=bytes=>BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const energy=samples=>samples.reduce((sum,n)=>sum+n*n,0);
const end=[0,255,47,0];

test('sequencer visits every event in track order, including same-tick and delayed commands after final notes',async()=>{
 const data=parse(midiTracks([
  [[0,255,81,3,7,161,32],[...vlq(480),255,81,3,3,208,144],[...vlq(480),255,6,3,69,78,68],end],
  [[0,0xc0,81],[0,0xb0,64,127],[0,0x90,60,100],[...vlq(480),0x80,60,64],[0,0xb0,123,0],
   [0,0xb0,64,0],[0,0xb0,10,127],[...vlq(240),0xb0,7,20],[0,0xb0,120,0],[...vlq(240),255,1,4,100,111,110,101],end]
 ]));
 const synth=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});
 synth.soundBankManager.addSoundBank(bank,'main');await synth.processorInitialized;
 const sequence=new SpessaSynthSequencer(synth);sequence.skipToFirstNoteOn=false;sequence.loopCount=0;
 sequence.loadNewSongList([data]);
 const expected=data.timeline.map(({tr,ev})=>[tr,data.tracks[tr].events[ev].ticks,data.tracks[tr].events[ev].statusByte,[...data.tracks[tr].events[ev].data]]);
 const observed=[],original=sequence.processEvent;
 sequence.processEvent=(event,track)=>{observed.push([track,event.ticks,event.statusByte,[...event.data]]);original(event,track);};
 sequence.play();
 const left=new Float32Array(128),right=new Float32Array(128);
 try{
  for(let blocks=0;!sequence.isFinished;blocks++){
   assert.ok(blocks<1000,'The complete timeline must finish');left.fill(0);right.fill(0);sequence.processTick();synth.process(left,right);
  }
  assert.deepEqual(observed,expected,'Every original event must be executed in the sorted timeline order');
  assert.equal(synth.midiChannels[0].midiControllers[7]>>7,20);
  assert.equal(synth.midiChannels[0].midiControllers[10]>>7,127);
 }finally{synth.stopAllChannels(true);}
});

test('a controller-only track controls the declared port without being discarded or turning new ports into drums',async()=>{
 const tracks=[
  [[0,255,33,1,42],[0,0xc0,81],[0,0xb0,10,127],[0,0xb0,7,0],[...vlq(480),0xb0,7,100],end],
  [[0,255,33,1,17],end],
  [[0,255,33,1,42],[0,0x90,69,110],[...vlq(960),0x80,69,0],end]
 ];
 const source=midiTracks(tracks);
 const reference=await createSoundFontPreview(midiTracks(tracks.map(track=>track.filter(event=>!(event[1]===255&&event[2]===33)))),bank,{effects:false});
 const preview=await createSoundFontPreview(source,bank,{effects:false});
 try{
  let before=0,after=[0,0];
  while(preview.stats.position<.85){
   const time=preview.stats.position,pcm=preview.read(128);
   assert.deepEqual(pcm,reference.read(128),'New-port playback must match the same controller sequence on port 0');
   if(time>.15&&time<.35)before+=energy(pcm[0])+energy(pcm[1]);
   if(time>.65&&time<.8)after=after.map((n,c)=>n+energy(pcm[c]));
  }
  assert.ok(before<(after[0]+after[1])*1e-7,'CC7 from a track without notes must attenuate its target port');
  assert.ok(after[1]>.01&&after[1]>after[0]*1000,'The restored melodic patch must play on the commanded right pan');
  assert.equal(preview.stats.diagnostics.summary.substituted,0,'Creating a new port must not select a drum kit on melodic channel 1');
 }finally{preview.close();reference.close();}
});

test('a timed port switch affects subsequent events and does not reroute an earlier held note',async()=>{
 const source=midiTracks([
  [[0,255,33,1,17],[0,0xc0,81],[0,0xb0,10,0],[0,0x90,60,100],
   [...vlq(480),255,33,1,42],[0,0xc0,81],[0,0xb0,10,127],[0,0x90,67,100],
   [...vlq(240),0x80,67,0],[...vlq(240),255,33,1,17],[0,0x80,60,0],end]
 ]);
 const preview=await createSoundFontPreview(source,bank,{effects:false});
 try{
  let before=[0,0],both=[0,0];
  while(preview.stats.position<.7){const time=preview.stats.position,pcm=preview.read(128);
   if(time>.15&&time<.35)before=before.map((n,c)=>n+energy(pcm[c]));
   if(time>.58&&time<.68)both=both.map((n,c)=>n+energy(pcm[c]));
  }
  assert.ok(before[0]>.001&&before[0]>before[1]*1000);
  assert.ok(both.every(n=>n>.001),'Changing the output port must leave the old note alive on its previous port');
 }finally{preview.close();}
});


test('zero-duration controller files execute their setup messages instead of being declared finished on load',async()=>{
 const source=midiTracks([[[0,0xc0,81],[0,0xb0,7,57],[0,0xb0,10,127],end]]);
 const data=parse(source),synth=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});
 synth.soundBankManager.addSoundBank(bank,'main');await synth.processorInitialized;
 const sequence=new SpessaSynthSequencer(synth);sequence.skipToFirstNoteOn=false;sequence.loopCount=0;sequence.loadNewSongList([data]);
 const actual=[],original=sequence.processEvent;
 sequence.processEvent=(event,track)=>{actual.push([event.statusByte,[...event.data]]);original(event,track);};
 sequence.play();
 const L=new Float32Array(128),R=new Float32Array(128);
 try{
  for(let i=0;i<4&&!sequence.isFinished;i++){sequence.processTick();synth.process(L,R);}
  assert.equal(actual.length,data.timeline.length);
  assert.equal(synth.midiChannels[0].preset.program,81);
  assert.equal(synth.midiChannels[0].midiControllers[7]>>7,57);
  assert.equal(synth.midiChannels[0].midiControllers[10]>>7,127);
 }finally{synth.stopAllChannels(true);}
});
