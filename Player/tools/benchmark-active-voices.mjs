import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import {pathToFileURL}from'node:url';import {createHash}from'node:crypto';
import {SpessaSynthProcessor,SoundBankLoader,SpessaLog}from'../vendor/spessasynth.js';import {installVoiceDSP}from'../voice-dsp.js';import {installGSEffects}from'../gs-effects.js';import {installXGVariation}from'../xg-variation.js';
const args=process.argv.slice(2),option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const baseline=option('--baseline',null);if(!baseline)throw new Error('Pass --baseline PATH to the previous Player directory.');
const root=pathToFileURL(path.resolve(baseline)+path.sep),old=await import(new URL('vendor/spessasynth.js',root)),oldDSP=await import(new URL('voice-dsp.js',root)),oldGS=await import(new URL('gs-effects.js',root)),oldXG=await import(new URL('xg-variation.js',root));SpessaLog.setLogLevel(false,false,false);old.SpessaLog.setLogLevel(false,false,false);
const rounds=Number(option('--rounds',5)),seconds=Number(option('--seconds',1)),notes=Number(option('--notes',1024)),backends=option('--backends','wasm').split(','),scenarios=option('--scenarios','dense,sparse-after-burst,controls-after-burst,silence-after-burst').split(',');
if(!Number.isInteger(rounds)||rounds<1||!Number.isInteger(notes)||notes<1||!Number.isFinite(seconds)||seconds<=0)throw new RangeError('Invalid benchmark dimensions.');
const warmSparseFrames=Number(option('--warm-sparse-frames',0));if(!Number.isInteger(warmSparseFrames)||warmSparseFrames<0)throw new RangeError('Invalid sparse warmup.');
const data=await fs.readFile(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url)),bank=SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
const current=[SpessaSynthProcessor,installVoiceDSP,installGSEffects,installXGVariation],previous=[old.SpessaSynthProcessor,oldDSP.installVoiceDSP,oldGS.installGSEffects,oldXG.installXGVariation];
const median=values=>[...values].sort((a,b)=>a-b)[values.length>>1],frames=Math.round(seconds*48000),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function prepare(version,dsp,effects,scenario){const [Ctor,voiceDSP,gs,xg]=version,s=new Ctor(48000,{effectsEnabled:effects,eventsEnabled:false,maxBufferSize:128});s.onMissingPreset=(p,system)=>bank.getPreset(p,system);s.soundBankManager.addSoundBank(bank,'main');await s.processorInitialized;gs(s);xg(s);s.setSystemParameter('autoAllocateVoices',true);s.setSystemParameter('blackMIDIMode',false);s.setSystemParameter('monophonicRetrigger',false);for(let ch=0;ch<4;ch++){s.programChange(ch,81);s.controllerChange(ch,91,48);s.controllerChange(ch,93,32);s.controllerChange(ch,10,16+ch*30);}if(dsp!=='js')await voiceDSP(s,dsp);
 if(warmSparseFrames){for(let i=0;i<4;i++)s.noteOn(i,60+i,90);render(s,warmSparseFrames,false);s.stopAllChannels(true);render(s,128,false);}
 for(let i=0;i<notes;i++)s.noteOn(i%4,48+i%36,70+i%30);render(s,4096,false);
 if(scenario!=='dense'){s.stopAllChannels(true);render(s,128,false);if(scenario!=='silence-after-burst')for(let i=0;i<4;i++)s.noteOn(i,60+i,90);render(s,1024,false);}
 return s;
}
function render(s,count,controls){const out=[new Float32Array(count),new Float32Array(count)];for(let at=0;at<count;at+=128){if(controls){const tick=at/128;for(let ch=0;ch<4;ch++){s.controllerChange(ch,1,(tick*7+ch*13)&127);s.controllerChange(ch,10,(tick*11+ch*17)&127);s.controllerChange(ch,11,64+((tick+ch)&63));}}s.process(...out,at,Math.min(128,count-at));}return out;}
const result={date:new Date().toISOString(),cpu:os.cpus()[0].model,node:process.version,rounds,notes,seconds,frames,warmSparseFrames,explicitGc:!!global.gc,baselineRoot:path.resolve(baseline),baselineCommit:option('--baseline-commit',null),sourceHashes:{before:sha(await fs.readFile(new URL('vendor/spessasynth.js',root))),after:sha(await fs.readFile(new URL('../vendor/spessasynth.js',import.meta.url))),activePool:sha(await fs.readFile(new URL('../active-voices.js',import.meta.url))),voiceDSPBefore:sha(await fs.readFile(new URL('voice-dsp.js',root))),voiceDSPAfter:sha(await fs.readFile(new URL('../voice-dsp.js',import.meta.url))),voiceBatch:sha(await fs.readFile(new URL('../voice-dsp-batch.js',import.meta.url))),scalarWasm:sha(await fs.readFile(new URL('../dsp/voice-mixer.wasm',import.meta.url))),simdWasm:sha(await fs.readFile(new URL('../dsp/voice-mixer-simd.wasm',import.meta.url)))},scope:'Actual before/after synth/DSP modules and shared parsed bank; paired128-frame blocks alternate order; initialization/warmup and explicit GC excluded; exact full PCM checked on every pair. CPU time is the combined pair because the host timer is coarse.',cases:[]};
for(const dsp of backends)for(const effects of [false,true])for(const scenario of scenarios){if(!['dense','sparse-after-burst','controls-after-burst','silence-after-burst'].includes(scenario))throw new Error('Unknown scenario');const times={before:[],after:[]},cpu={before:[],after:[]};let poolSize,activeVoices,hash,batchCalls,batchVoices;
 for(let round=0;round<rounds;round++){
  global.gc?.();const pair={};for(const mode of round%2?['after','before']:['before','after'])pair[mode]=await prepare(mode==='before'?previous:current,dsp,effects,scenario);
  try{const core=pair.after.synthCore;poolSize=core.voices.length;activeVoices=core.voices.filter(v=>v.isActive).length;const batchStart=core.voiceDSP?.batchStats;global.gc?.();
   const pcm={before:[new Float32Array(frames),new Float32Array(frames)],after:[new Float32Array(frames),new Float32Array(frames)]},elapsed={before:0,after:0},startedCpu=process.cpuUsage();
   for(let at=0;at<frames;at+=128){const tick=at/128,order=(tick+round)%2?['after','before']:['before','after'];for(const mode of order){const s=pair[mode],started=performance.now();
     if(scenario==='controls-after-burst')for(let ch=0;ch<4;ch++){s.controllerChange(ch,1,(tick*7+ch*13)&127);s.controllerChange(ch,10,(tick*11+ch*17)&127);s.controllerChange(ch,11,64+((tick+ch)&63));}
     s.process(...pcm[mode],at,Math.min(128,frames-at));elapsed[mode]+=performance.now()-started;
   }}
   const batchEnd=core.voiceDSP?.batchStats;batchCalls=batchEnd?batchEnd.calls-batchStart.calls:0;batchVoices=batchEnd?batchEnd.voices-batchStart.voices:0;
   const used=process.cpuUsage(startedCpu);for(const mode of ['before','after'])times[mode].push(elapsed[mode]);cpu.before.push((used.user+used.system)/1000);
   const digest=mode=>sha(Buffer.concat(pcm[mode].map(row=>Buffer.from(row.buffer,row.byteOffset,row.byteLength))));hash=digest('before');if(hash!==digest('after'))throw new Error('PCM mismatch: '+dsp+' '+effects+' '+scenario+' round '+round);
  }finally{pair.before.stopAllChannels(true);pair.after.stopAllChannels(true);}
 }

 const medians=Object.fromEntries(Object.entries(times).map(([k,v])=>[k,median(v)])),pairedSpeedup=median(times.before.map((v,i)=>v/times.after[i])),entry={dsp,effects,scenario,poolSize,activeVoices,times,pairCpuMilliseconds:cpu.before,medians,pairedSpeedup,pcmSha256:hash,exactPCM:true,batchCalls,batchVoices};result.cases.push(entry);console.log(JSON.stringify({dsp,effects,scenario,poolSize,activeVoices,medians,pairedSpeedup,exactPCM:true}));
}
await fs.writeFile(path.resolve(option('--output','.cache/active-voices-benchmark.json')),JSON.stringify(result,null,2)+'\n');
