import { SpessaSynthProcessor, SpessaLog } from './vendor/spessasynth.js';
import { installBankMappings } from './fluid-bank-mappings.js';
import { installGSEffects } from './gs-effects.js';
import { installXGVariation } from './xg-variation.js';
import { installReleaseVelocityProfiles, normalizeReleaseVelocityProfiles } from './release-velocity.js';
import { installSampleDumpBank } from './sample-dump-bank.js';
import { installVoiceDSP } from './voice-dsp.js';
import { FIFOQueue } from './event-queue.js';
import { midiMessages } from './web-midi.js';

// A separate live synth cannot change a loaded file's seek/checkpoint state.
export async function createLiveSynth(bank, { sampleRate = 48000, effects = true, dsp = 'auto', prepare, isPrepared = prepare ? () => false : () => true, releaseVelocityProfiles, sampleDumpMappings } = {}) {
  if (!['auto','js','wasm','wasm-simd'].includes(dsp)) throw new TypeError('Unknown voice DSP backend.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Invalid live sample rate.');
  const profiles = normalizeReleaseVelocityProfiles(releaseVelocityProfiles);
  SpessaLog.setLogLevel(false,false,false);
  const synth = new SpessaSynthProcessor(sampleRate,{effectsEnabled:effects,eventsEnabled:false,maxBufferSize:128});
  synth.onMissingPreset = (patch,system) => bank.getPreset(patch,system);
  synth.soundBankManager.addSoundBank(bank,'live'); await synth.processorInitialized;
  installBankMappings(synth,bank); installGSEffects(synth); installXGVariation(synth);
  installReleaseVelocityProfiles(synth,profiles); installSampleDumpBank(synth,sampleDumpMappings);
  synth.setSystemParameter('autoAllocateVoices',true); synth.setSystemParameter('blackMIDIMode',false); synth.setSystemParameter('monophonicRetrigger',false);
  if (dsp !== 'js') {
    if (dsp === 'auto') {
      try { await installVoiceDSP(synth,'wasm'); }
      catch { try { await installVoiceDSP(synth,'wasm-simd'); } catch {} }
    } else await installVoiceDSP(synth,dsp);
  }
  const pending=[new Float32Array(128),new Float32Array(128)]; let pendingAt=128;
  const commands=new FIFOQueue(); let revision=0,closed=false,failure=null,abort=new AbortController(),draining=false;
  let originTimestamp,originTime=0,lastTimestamp=0,delay=0;
  const alive=()=>{if(closed)throw new Error('Live synth closed.');};
  const timeFor=job=>job.timestamp===undefined?-Infinity:originTime+(job.timestamp-originTimestamp)/1000+delay;
  function rejectAll(error){while(commands.length)commands.take().reject(error);}
  function fail(error){failure=error;synth.stopAllChannels(true);rejectAll(error);}
  function drain(){
    if(draining||closed||failure)return;draining=true;
    try{
      while(commands.length){
        const job=commands.peek();
        if(job.preparing)return;
        if(!job.prepared){
          const selected=synth.midiChannels.map(ch=>ch.preset);
          if(isPrepared(selected))job.prepared=true;
          else{
            job.preparing=true;const version=revision,signal=abort.signal;
            Promise.resolve().then(()=>prepare?.(selected,{signal})).then(()=>{
              if(version!==revision||closed)return;
              // A cold sample fetch shifts the waiting timeline together. A
              // buffered Note Off keeps its gate interval after the Note On.
              const target=timeFor(job);
              if(Number.isFinite(target))delay+=Math.max(0,synth.synthCore.currentTime-target);
              job.prepared=true;job.preparing=false;drain();
            },error=>{if(version===revision&&!closed)fail(error);});
            return;
          }
        }
        if(timeFor(job)-synth.synthCore.currentTime>1e-9)return;
        commands.take();
        try{synth.processMessage(job.message);job.resolve();}
        catch(error){job.reject(error);fail(error);return;}
      }
    }finally{draining=false;}
  }
  const resetQueue=()=>{
    revision++;abort.abort();abort=new AbortController();
    rejectAll(new DOMException('Live MIDI cancelled.','AbortError'));failure=null;pendingAt=128;
    originTimestamp=undefined;originTime=lastTimestamp=delay=0;synth.stopAllChannels(true);
  };
  return {
    synth,
    get stats(){return{sampleRate,channels:2,voices:synth.synthCore.activeVoices.reduce((n,v)=>n+Number(v.isActive),0),queued:commands.length,dsp:synth.synthCore.voiceDSP?.backend??'js',failed:failure?.message??null};},
    send(input,{timestamp}={}){
      alive();const {messages}=midiMessages(input);
      if(timestamp!==undefined&&(!Number.isFinite(timestamp)||timestamp<0))throw new RangeError('Live timestamp must be nonnegative milliseconds.');
      if(failure)return Promise.reject(failure);
      if(timestamp!==undefined){
        if(originTimestamp===undefined||!commands.length){originTimestamp=timestamp;originTime=synth.synthCore.currentTime;lastTimestamp=timestamp;delay=0;}
        timestamp=Math.max(timestamp,lastTimestamp);lastTimestamp=timestamp;
      }
      const jobs=messages.map(message=>new Promise((resolve,reject)=>commands.push({message,timestamp,resolve,reject})));
      drain();return Promise.all(jobs).then(()=>{});
    },
    read(frames=256){
      alive();if(!Number.isSafeInteger(frames)||frames<0)throw new RangeError('Invalid live read size.');
      const out=[new Float32Array(frames),new Float32Array(frames)];
      for(let at=0;at<frames;){
        if(pendingAt===128){drain();pending.forEach(c=>c.fill(0));synth.process(pending[0],pending[1],0,128);pendingAt=0;}
        const take=Math.min(frames-at,128-pendingAt);
        out.forEach((c,i)=>c.set(pending[i].subarray(pendingAt,pendingAt+take),at));pendingAt+=take;at+=take;
      }
      return out;
    },
    panic(){alive();resetQueue();},
    close(){if(closed)return;resetQueue();closed=true;}
  };

}
