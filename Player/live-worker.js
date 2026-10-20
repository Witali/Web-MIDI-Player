import { BrowserSoundBank } from './lazy-bank.js';
import { createLiveSynth } from './live-synth.js';
let live, port, epoch=0;
async function command(data) {
  if(data.type==='init') {
    live?.close();
    let bank,prepare,isPrepared,bankStats;
    if(data.soundfontUrl) {
      const [{SoundBankLoader},response]=await Promise.all([import('./vendor/spessasynth.js'),fetch(data.soundfontUrl)]);
      if(!response.ok)throw new Error('Cannot load live SoundFont: HTTP '+response.status);
      bank=SoundBankLoader.fromArrayBuffer(await response.arrayBuffer());
    } else {
      const prepared=await new BrowserSoundBank(data.sampleManifestUrl).openLive();
      bank=prepared.bank;prepare=prepared.prepare;isPrepared=prepared.isPrepared;bankStats=prepared.stats;
    }
    live=await createLiveSynth(bank,{...data,prepare,isPrepared}); live.bankStats=bankStats;
    return {...live.stats,sampleBank:bankStats};
  }
  if(!live)throw new Error('Start live audio before sending MIDI.');
  if(data.type==='midi') { await live.send(data.bytes,{timestamp:data.timestamp}); return {...live.stats,sampleBank:live.bankStats}; }
  if(data.type==='panic') { epoch=data.epoch;live.panic();return; }
  throw new Error('Unknown live MIDI command.');
}
self.onmessage=({data})=>{
  if(data.type==='connect') {
    port?.close();port=data.port;epoch=data.epoch;
    port.onmessage=({data})=>{
      if(data.epoch!==epoch||!live)return;
      try { const channels=live.read(256);port.postMessage({epoch,channels},channels.map(c=>c.buffer)); }
      catch(error){self.postMessage({type:'error',message:error.message});}
    };port.start();return;
  }
  // send() owns the ordered FIFO; panic must be able to cancel a sample fetch.
  command(data).then(result=>self.postMessage({id:data.id,result}),error=>self.postMessage({id:data.id,error:error.message,name:error.name}));
};
