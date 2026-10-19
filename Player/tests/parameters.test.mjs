import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GeneratorTypes, MIDIUtils, SoundBankLoader, SpessaLog, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false,false,false);
const bytes=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url));
const bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
async function synth(){const s=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;return s;}
const rpn=(s,n,ch=0)=>{s.controllerChange(ch,101,n>>7);s.controllerChange(ch,100,n&127);};
const nrpn=(s,n,ch=0)=>{s.controllerChange(ch,99,n>>7);s.controllerChange(ch,98,n&127);};
const data=(s,msb,lsb=0,ch=0)=>{s.controllerChange(ch,6,msb);s.controllerChange(ch,38,lsb);};
const end=[0,255,47,0];

test('RPN/NRPN wait for the first complete number; selection and null never alter parameter values',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  s.controllerChange(0,100,0);s.controllerChange(0,6,12);s.controllerChange(0,96,127);assert.equal(ch.midiParameters.pitchWheelRange,2);
  s.controllerChange(0,101,0);assert.equal(ch.midiParameters.pitchWheelRange,2);
  s.controllerChange(0,96,127);assert.equal(ch.midiParameters.pitchWheelRange,2.01,'The increment value byte is ignored');
  s.controllerChange(0,100,1);assert.equal(ch.midiParameters.fineTune,0);
  s.controllerChange(0,96,0);assert.equal(ch.midiParameters.fineTune,100/8192);
  rpn(s,0);assert.equal(ch.midiParameters.pitchWheelRange,2.01);
  rpn(s,16383);data(s,40,99);s.controllerChange(0,96,65);assert.equal(ch.midiParameters.pitchWheelRange,2.01);
  s.controllerChange(0,99,1);data(s,80);assert.equal(ch.midiControllers[76]>>7,64,'NRPN also waits for both selector bytes');
  s.controllerChange(0,98,8);s.controllerChange(0,96,37);assert.equal(ch.midiControllers[76]>>7,65);
  nrpn(s,16383);data(s,10);s.controllerChange(0,97,0);assert.equal(ch.midiControllers[76]>>7,65);
 }finally{s.stopAllChannels(true);}
});

test('pitch bend sensitivity uses semitones plus cents and RP-018 increments carry in base 100',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  rpn(s,0);data(s,2,99);assert.equal(ch.midiParameters.pitchWheelRange,2.99);
  s.controllerChange(0,96,127);assert.equal(ch.midiParameters.pitchWheelRange,3);
  assert.equal(ch.midiControllers[6],3<<7);s.controllerChange(0,97,1);assert.equal(ch.midiParameters.pitchWheelRange,2.99);
  data(s,0,0);s.controllerChange(0,97,127);assert.equal(ch.midiParameters.pitchWheelRange,0);
  data(s,127,127);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.pitchWheelRange,128.27);
  data(s,2,50);s.controllerChange(0,6,4);assert.equal(ch.midiParameters.pitchWheelRange,4,'A new MSB clears the former LSB');
  assert.equal(MIDIUtils.analyzeRPN(0,0,(2<<7)|50).value,2.5);
  const encoded=MIDIUtils.setChannelMIDIParameter(0,0,'gm','pitchWheelRange',2.5);
  assert.deepEqual(encoded.slice(-2).map(e=>[...e.data]),[[6,2],[38,50]]);
 }finally{s.stopAllChannels(true);}
});

test('fine/coarse tuning retain separate values and saturate at their endpoints with the specified step sizes',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  rpn(s,1);s.controllerChange(0,96,127);assert.equal(ch.midiParameters.fineTune,100/8192);
  data(s,127,127);s.controllerChange(0,96,1);assert.equal(ch.midiParameters.fineTune,8191*100/8192);
  data(s,0,0);s.controllerChange(0,97,127);assert.equal(ch.midiParameters.fineTune,-100);
  rpn(s,2);s.controllerChange(0,96,2);assert.equal(ch.midiParameters.keyShift,1,'RPN 2 increments the MSB, not the LSB');
  data(s,70);s.controllerChange(0,97,1);assert.equal(ch.midiParameters.keyShift,5);
  rpn(s,1);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.fineTune,-100+100/8192,'Switching parameters must not reuse the coarse-tuning data register');
  rpn(s,2);data(s,127);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.keyShift,63);
  data(s,0);s.controllerChange(0,97,127);assert.equal(ch.midiParameters.keyShift,-64);
  rpn(s,5);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.modulationDepth,50+1/1.28);
 }finally{s.stopAllChannels(true);}
});

test('14-bit controllers cover all LSBs and clear old fine values on MSB receipt while respecting locks',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  for(const cc of [1,7,10,11,16,19,20,31]){
   s.controllerChange(0,cc,42);s.controllerChange(0,cc+32,99);assert.equal(ch.midiControllers[cc],(42<<7)|99);
   s.controllerChange(0,cc,43);assert.equal(ch.midiControllers[cc],43<<7);assert.equal(ch.midiControllers[cc+32],0);
  }
  ch.lockController(16,true);s.controllerChange(0,48,127);assert.equal(ch.midiControllers[16],43<<7);
  ch.lockController(16,false);ch.lockController(48,true);s.controllerChange(0,48,127);assert.equal(ch.midiControllers[16],43<<7);
  for(const [cc,v] of [[-1,0],[128,0],[1,128],[1,-1],[1,1.5]])assert.throws(()=>s.controllerChange(0,cc,v),/Invalid MIDI Controller/);
 }finally{s.stopAllChannels(true);}
});

test('documented NRPN steps use independent part, drum and SF2 parameter state without accumulating absolute fine tune',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  nrpn(s,(1<<7)|8);s.controllerChange(0,96,50);assert.equal(ch.midiControllers[76]>>7,65);
  nrpn(s,(1<<7)|9);s.controllerChange(0,97,127);assert.equal(ch.midiControllers[77]>>7,63);
  nrpn(s,(1<<7)|8);s.controllerChange(0,96,0);assert.equal(ch.midiControllers[76]>>7,66);
  nrpn(s,(25<<7)|60);data(s,70);assert.equal(ch.drumParams[60].pitch,6);data(s,70);assert.equal(ch.drumParams[60].pitch,6,'Repeated absolute Data Entry must be idempotent');
  s.controllerChange(0,96,127);assert.equal(ch.drumParams[60].pitch,7);
  nrpn(s,(120<<7)|GeneratorTypes.initialFilterFc);data(s,64);s.controllerChange(0,96,99);
  assert.equal(ch.generators.offsets[GeneratorTypes.initialFilterFc],2);
  nrpn(s,(120<<7)|GeneratorTypes.fineTune);data(s,64);s.controllerChange(0,96,127);s.controllerChange(0,96,1);
  assert.equal(ch.generators.offsets[GeneratorTypes.fineTune],2);
  nrpn(s,(120<<7)|GeneratorTypes.initialFilterFc);s.controllerChange(0,96,0);assert.equal(ch.generators.offsets[GeneratorTypes.initialFilterFc],4);
 }finally{s.stopAllChannels(true);}
});

test('CC121 resets selectors, pressure and pedals but preserves patch, mix and actual RPN/NRPN values',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  rpn(s,0);data(s,12,25);rpn(s,1);data(s,70,30);nrpn(s,(1<<7)|8);data(s,71);
  s.programChange(0,81);for(const [cc,v] of [[7,55],[10,100],[11,44],[1,127],[64,127],[65,127],[66,127],[67,127],[91,42]])s.controllerChange(0,cc,v);
  s.noteOn(0,60,100);s.polyPressure(0,60,90);s.channelPressure(0,80);s.pitchWheel(0,12000);
  s.controllerChange(0,121,0);
  assert.equal(ch.preset.program,81);assert.equal(ch.midiControllers[7]>>7,55);assert.equal(ch.midiControllers[10]>>7,100);assert.equal(ch.midiControllers[91]>>7,42);
  assert.equal(ch.midiControllers[11]>>7,127);for(const cc of [1,64,65,66,67])assert.equal(ch.midiControllers[cc],0);
  for(const cc of [98,99,100,101])assert.equal(ch.midiControllers[cc]>>7,127);
  assert.equal(ch.midiParameters.pitchWheel,8192);assert.equal(ch.midiParameters.pressure,0);
  assert.ok(s.synthCore.voices.filter(v=>v.isActive&&v.channel===0).every(v=>v.pressure===0));
  assert.equal(ch.midiParameters.pitchWheelRange,12.25);assert.equal(ch.midiParameters.fineTune,((70<<7)+30-8192)/81.92);assert.equal(ch.midiControllers[76]>>7,71);
  s.controllerChange(0,96,0);assert.equal(ch.midiControllers[76]>>7,71);
  rpn(s,0);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.pitchWheelRange,12.26);
  ch.reset(false);rpn(s,0);s.controllerChange(0,96,0);assert.equal(ch.midiParameters.pitchWheelRange,2.01,'A complete system reset restores defaults instead');
 }finally{s.stopAllChannels(true);}
});

test('snapshots preserve the selected parameter and remembered values for later relative changes',async()=>{
 const s=await synth(),ch=s.midiChannels[0];try{
  nrpn(s,(120<<7)|GeneratorTypes.initialFilterFc);data(s,64,5);const snapshot=ch.getSnapshot();
  ch.reset(false);ch.applySnapshot(snapshot);s.controllerChange(0,96,127);
  assert.equal(ch.generators.offsets[GeneratorTypes.initialFilterFc],12);
  assert.equal(snapshot.parameterValues.find(([key])=>key==='sf'+GeneratorTypes.initialFilterFc)[1],8197,'Restoring and changing a snapshot must not mutate its saved value');
 }finally{s.stopAllChannels(true);}
});

test('relative pitch-bend changes affect a held note and match absolute commands and seeking on every DSP backend',async()=>{
 const prefix=[[0,0xc0,81],[0,0xb0,101,0],[0,0xb0,100,0],[0,0xb0,6,2],[0,0xb0,38,99],[0,0xe0,127,127],[0,0x90,69,100]];
 const suffix=[[...vlq(480),0x80,69,64],end];
 const relative=midi([...prefix,[...vlq(480),0xb0,96,127],...suffix]);
 const absolute=midi([...prefix,[...vlq(480),0xb0,6,3],[0,0xb0,38,0],...suffix]);
 const unchanged=midi([...prefix,[...vlq(480),255,1,0],...suffix]);
 for(const dsp of ['js','wasm','wasm-simd']){
  const a=await createSoundFontPreview(relative,bank,{effects:false,dsp}),b=await createSoundFontPreview(absolute,bank,{effects:false,dsp}),c=await createSoundFontPreview(unchanged,bank,{effects:false,dsp});
  let difference=0;
  try{
   while(a.stats.position<.9){const time=a.stats.position,x=a.read(128),y=b.read(128),z=c.read(128);assert.deepEqual(x,y);
    if(time>.65)for(let i=0;i<128;i++)difference+=Math.abs(x[0][i]-z[0][i]);}
   assert.ok(difference>.01,'Changing the bend range must retune an already sounding voice');
   assert.equal(a.stats.diagnostics.summary.unsupported,0);
   await a.seek(.67);await b.seek(.67);assert.deepEqual(a.read(2048),b.read(2048));
  }finally{a.close();b.close();c.close();}
 }
});
