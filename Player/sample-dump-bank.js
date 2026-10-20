import {BasicSoundBank,BasicSample,BasicInstrument,BasicPreset,GeneratorTypes,SampleTypes,SpessaLog}from'./vendor/spessasynth.js';
import {normalizeSampleDumpMappings,patchKey}from'./sample-dump-settings.js';
export {normalizeSampleDumpMappings}from'./sample-dump-settings.js';
export function createSampleDumpBank(row,mapping){
 if(!row.length)throw new Error('An empty SDS sample cannot form a playable instrument.');
 const loop=mapping.loop===null?null:row.loops.get(mapping.loop);let pcm=row.pcm,start=0,end=pcm.length;
 if(loop){start=loop.start;end=Math.min(pcm.length,loop.end+(mapping.loopEnd==='inclusive'?1:0));if(end<=start)throw new Error('Selected SDS loop has no playable span.');
  if(loop.type===1&&end-start>2){const reversed=end-start-2,expanded=new Float32Array(pcm.length+reversed);expanded.set(pcm.subarray(0,end));for(let i=0;i<reversed;i++)expanded[end+i]=pcm[end-2-i];expanded.set(pcm.subarray(end),end+reversed);pcm=expanded;end+=reversed;}
 }
 const bank=new BasicSoundBank(),sample=new BasicSample(mapping.name,row.sampleRate,mapping.rootKey,0,SampleTypes.monoSample,start,end);
 sample.setAudioData(pcm,row.sampleRate);bank.addSamples(sample);const instrument=new BasicInstrument();instrument.name=mapping.name;const zone=instrument.createZone(sample);
 zone.setGenerator(GeneratorTypes.sampleModes,loop?3:0);zone.setGenerator(GeneratorTypes.releaseVolEnv,1200*Math.log2(mapping.release));
 bank.addInstruments(instrument);const preset=new BasicPreset(bank);Object.assign(preset,{name:mapping.name,program:mapping.program,bankMSB:mapping.bankMSB,bankLSB:mapping.bankLSB,isGMGSDrum:mapping.percussion});preset.createZone(instrument);bank.addPresets(preset);bank.soundBankInfo.name='MIDI Sample Dump';bank.flush();return bank;
}
export function sampleDumpInstruments(bank,mappings=[]){const out=new Map(bank.presets.map(p=>[patchKey(p),{name:p.name,program:p.program,bankMSB:p.bankMSB,bankLSB:p.bankLSB,percussion:!!p.isGMGSDrum}]));for(const m of mappings)out.set(patchKey(m),{name:m.name,program:m.program,bankMSB:m.bankMSB,bankLSB:m.bankLSB,percussion:m.percussion});return [...out.values()];}
export function installSampleDumpBank(synth,options=[],portForOffset=offset=>offset/16){
 const mappings=normalizeSampleDumpMappings(options),core=synth.synthCore;if(core.sampleDumpBank)throw new Error('SDS bank adapter is already installed.');
 const state={mappings,ready:new Map(),resources:new Set(),cache:new Map(),mappingForPatch:patch=>mappings.find(m=>patchKey(m)===patchKey(patch)),presetForAddress:patch=>state.ready.get(patchKey(patch))?.presets[0],presetForChannel:channel=>state.presetForAddress({...channel.patch,percussion:channel.drumChannel})};core.sampleDumpBank=state;
 core.sampleDumps.onSample=row=>{
  for(const mapping of mappings)if(mapping.sample===row.sample&&mapping.sourcePort===portForOffset(row.port)&&(mapping.deviceID===null||mapping.deviceID===row.device)){
   try{let cache=state.cache.get(row.words);if(!cache)state.cache.set(row.words,cache=new Map());const id=JSON.stringify([mapping,row.loops.get(mapping.loop)??null,row.sampleRate]);let bank=cache.get(id);
    if(!bank){bank=createSampleDumpBank(row,mapping);const extra=bank.samples[0].getAudioData()===row.pcm?0:bank.samples[0].getAudioData().byteLength;
     if(!core.sampleDumps.reserve(extra))throw new Error('SDS playback expansion exceeds the sample memory budget.');state.resources.add(bank);cache.set(id,bank);}
    state.ready.set(patchKey(mapping),bank);
   }catch(error){SpessaLog.unsupported('SDS instrument',[row.sample],error.message);}
  }
 };
 if(!mappings.length)return state;
 const getPreset=core.soundBankManager.getPreset.bind(core.soundBankManager);core.soundBankManager.getPreset=(patch,...args)=>state.presetForAddress(patch)??getPreset(patch,...args);
 const getVoices=core.getVoices.bind(core);core.getVoices=(channel,key,velocity)=>{const ch=core.midiChannels[channel],preset=state.presetForChannel(ch);return preset?core.getVoicesForPreset(preset,key,velocity):getVoices(channel,key,velocity);};
 return state;
}
