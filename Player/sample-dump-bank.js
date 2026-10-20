import {BasicSoundBank,BasicSample,BasicInstrument,BasicPreset,GeneratorTypes,SampleTypes,SpessaLog}from'./vendor/spessasynth.js';
import {normalizeSampleDumpMappings,patchKey}from'./sample-dump-settings.js';
export {normalizeSampleDumpMappings}from'./sample-dump-settings.js';
export function createSampleDumpBank(row,mapping){
 if(!row.length)throw new Error('An empty SDS sample cannot form a playable instrument.');
 const loop=mapping.loop===null?null:row.loops.get(mapping.loop),extended=row.extended||loop?.extended;
 const bank=new BasicSoundBank(),instrument=new BasicInstrument();instrument.name=mapping.name;
 const channels=row.channels??1,streams=row.channelData??[row.pcm];
 for(let channel=0;channel<channels;channel++){
  let pcm=streams[channel],start=0,end=pcm.length;
  if(loop&&loop.type<126){start=loop.start;end=Math.min(pcm.length,loop.end+((extended||mapping.loopEnd==='inclusive')?1:0));if(end<=start)throw new Error('Selected SDS loop has no playable span.');
   if(!extended&&loop.type===1&&end-start>2){const reversed=end-start-2,expanded=new Float32Array(pcm.length+reversed);expanded.set(pcm.subarray(0,end));for(let i=0;i<reversed;i++)expanded[end+i]=pcm[end-2-i];expanded.set(pcm.subarray(end),end+reversed);pcm=expanded;end+=reversed;}
  }
  const sample=new BasicSample(mapping.name,row.sampleRate,mapping.rootKey,0,SampleTypes.monoSample,start,end);
  if(extended){const type=loop?.type??(row.playbackType>=64&&row.playbackType!==127?126:127);sample.sdsPlayback={type,start:loop?.start??0,end:loop?.end??pcm.length-1};}
  sample.setAudioData(pcm,row.sampleRate);bank.addSamples(sample);const zone=instrument.createZone(sample);
  zone.setGenerator(GeneratorTypes.sampleModes,loop&&loop.type<126?(extended?(loop.type&2?3:1):3):0);zone.setGenerator(GeneratorTypes.releaseVolEnv,1200*Math.log2(mapping.release));
  if(channels===2)zone.setGenerator(GeneratorTypes.pan,channel?500:-500);
  // CA-019 supplies no speaker positions for >2 channels. The stereo host
  // preserves every channel using an equal-weight centre downmix.
  if(channels>2)zone.setGenerator(GeneratorTypes.initialAttenuation,Math.round(200*Math.log10(channels)));
 }
 bank.addInstruments(instrument);const preset=new BasicPreset(bank);Object.assign(preset,{name:mapping.name,program:mapping.program,bankMSB:mapping.bankMSB,bankLSB:mapping.bankLSB,isGMGSDrum:mapping.percussion});preset.createZone(instrument);bank.addPresets(preset);bank.soundBankInfo.name='MIDI Sample Dump';bank.flush();return bank;
}

export function sampleDumpInstruments(bank,mappings=[]){const out=new Map(bank.presets.map(p=>[patchKey(p),{name:p.name,program:p.program,bankMSB:p.bankMSB,bankLSB:p.bankLSB,percussion:!!p.isGMGSDrum}]));for(const m of mappings)out.set(patchKey(m),{name:m.name,program:m.program,bankMSB:m.bankMSB,bankLSB:m.bankLSB,percussion:m.percussion});return [...out.values()];}
export function installSampleDumpBank(synth,options=[],portForOffset=offset=>offset/16){
 const mappings=normalizeSampleDumpMappings(options),core=synth.synthCore;if(core.sampleDumpBank)throw new Error('SDS bank adapter is already installed.');
 const state={mappings,ready:new Map(),resources:new Set(),cache:new Map(),mappingForPatch:patch=>mappings.find(m=>patchKey(m)===patchKey(patch)),presetForAddress:patch=>state.ready.get(patchKey(patch))?.presets[0],presetForChannel:channel=>state.presetForAddress({...channel.patch,percussion:channel.drumChannel})};core.sampleDumpBank=state;
 core.sampleDumps.onSample=row=>{
  for(const mapping of mappings)if(mapping.sample===row.sample&&mapping.sourcePort===portForOffset(row.port)&&(mapping.deviceID===null||mapping.deviceID===row.device)){
   try{let cache=state.cache.get(row.words);if(!cache)state.cache.set(row.words,cache=new Map());const id=JSON.stringify([mapping,row.loops.get(mapping.loop)??null,row.sampleRate,row.extended,row.playbackType]);let bank=cache.get(id);
    if(!bank){bank=createSampleDumpBank(row,mapping);const extra=bank.samples.reduce((sum,sample)=>{const pcm=sample.getAudioData();return sum+(pcm===row.pcm||row.channelData?.includes(pcm)?0:pcm.byteLength);},0);
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
