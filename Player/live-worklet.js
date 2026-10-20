import { AudioQueue } from './audio-queue.js';
class LiveMidiOutput extends AudioWorkletProcessor {
  constructor() {
    super();this.queues=[new AudioQueue(48000, 256),new AudioQueue(48000, 256)];this.epoch=0;this.pending=false;this.running=false;
    this.port.onmessage=({data})=>{
      if(data.type==='connect'){
        this.stream=data.port;this.stream.onmessage=({data})=>{
          if(data.epoch!==this.epoch)return;
          this.pending=false;this.queues.forEach((q,i)=>q.push(data.channels[i]));this.request();
        };this.stream.start();
      }
      if(data.type==='reset'){
        this.epoch=data.epoch;this.pending=false;this.running=data.running;this.queues.forEach(q=>q.reset());this.request();
      }
    };
  }
  request(){if(this.running&&this.stream&&!this.pending&&this.queues[0].length<512){this.pending=true;this.stream.postMessage({epoch:this.epoch});}}
  process(_inputs,outputs){
    const channels=outputs[0];if(!channels?.length)return true;
    if(!this.running)channels.forEach(c=>c.fill(0));
    else{channels.forEach((c,i)=>this.queues[i]?.pull(c,sampleRate));this.request();}
    return true;
  }
}
registerProcessor('live-midi-output',LiveMidiOutput);
