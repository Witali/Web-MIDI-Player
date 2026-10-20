import { WebMidiPorts, midiMessages } from './web-midi.js';
const emit=(target,type,detail)=>target.dispatchEvent(new CustomEvent(type,{detail}));
export class LiveMidiPlayer extends EventTarget {
  constructor({ volume=.55, effects=true, dsp='auto', soundfontUrl, sampleManifestUrl, releaseVelocityProfiles, sampleDumpMappings, ports=new WebMidiPorts() }={}) {
    super();if(soundfontUrl&&sampleManifestUrl)throw new TypeError('Choose soundfontUrl or sampleManifestUrl.');
    if(!['auto','js','wasm','wasm-simd'].includes(dsp))throw new TypeError('Unknown voice DSP backend.');
    this.ports=ports;this.options={effects,dsp,releaseVelocityProfiles,sampleDumpMappings};
    for(const [key,value]of Object.entries({soundfontUrl,sampleManifestUrl}))if(value)this.options[key]=new URL(value,globalThis.location?.href||import.meta.url).href;
    this.state='stopped';this._generation=0;this._epoch=0;this._sequence=0;this._pending=new Map();this._volume=.55;this.volume=volume;
    this._input=event=>{if(this.state==='running')this.send(event.detail.data,{timestamp:event.detail.timestamp}).catch(error=>{if(error.name!=='AbortError')emit(this,'error',error);});};
    this._selection=event=>{if(event.detail.previous&&this.state==='running')this.panic().catch(error=>emit(this,'error',error));};
    this.ports.addEventListener('midimessage',this._input);this.ports.addEventListener('inputchange',this._selection);
  }
  get volume(){return this._volume;}
  set volume(value){if(!Number.isFinite(value)||value<0||value>1)throw new RangeError('Volume must be between 0 and 1.');this._volume=value;if(this._gain)this._gain.gain.setTargetAtTime(value,this._context.currentTime,.01);}
  _state(value){this.state=value;emit(this,'statechange',value);}
  _alive(){if(this.state==='disposed')throw new Error('Live MIDI player disposed.');}
  _call(type,data={},transfer=[]){
    const id=++this._sequence;
    return new Promise((resolve,reject)=>{this._pending.set(id,{resolve,reject});try{this._worker.postMessage({type,id,...data},transfer);}catch(error){this._pending.delete(id);reject(error);}});
  }
  start(){
    this._alive();if(this.state==='running')return Promise.resolve(this.metadata);if(this._opening)return this._opening;
    const generation=++this._generation;this._state('starting');
    const opening=this._start(generation).finally(()=>{if(this._opening===opening)this._opening=null;});this._opening=opening;return opening;
  }
  async _start(generation){
    try{
      const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Audio||!globalThis.AudioWorkletNode)throw new Error('Live audio requires Web Audio on HTTPS or localhost.');
      const context=this._context=new Audio({sampleRate:48000,latencyHint:'interactive'});
      // Resume synchronously from the UI gesture, before fetching any resources.
      const resumed=context.resume();
      const worker=this._worker=new Worker(new URL('./live-worker.js',import.meta.url),{type:'module'});
      this._worker.onmessage=({data})=>{
        if(this._worker!==worker)return;
        const pending=this._pending.get(data.id);
        if(pending){this._pending.delete(data.id);if(data.error){const error=new Error(data.error);error.name=data.name||'Error';pending.reject(error);}else pending.resolve(data.result);}
        else if(data.type==='error')emit(this,'error',new Error(data.message));
      };
      this._worker.onerror=event=>{
        if(this._worker!==worker)return;
        const error=new Error(event.message||'Live MIDI Worker failed.');
        for(const p of this._pending.values())p.reject(error);this._pending.clear();this.stop().catch(()=>{});emit(this,'error',error);
      };
      const [metadata]=await Promise.all([this._call('init',{...this.options,sampleRate:48000}),context.audioWorklet.addModule(new URL('./live-worklet.js',import.meta.url)),resumed]);
      if(generation!==this._generation)throw new DOMException('Live audio cancelled.','AbortError');
      this.metadata=metadata;this._gain=context.createGain();this._gain.gain.value=this.volume;
      this._node=new AudioWorkletNode(context,'live-midi-output',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
      const channel=new MessageChannel();
      this._node.port.postMessage({type:'connect',port:channel.port1},[channel.port1]);
      this._worker.postMessage({type:'connect',port:channel.port2,epoch:this._epoch},[channel.port2]);
      this._node.connect(this._gain);this._gain.connect(context.destination);
      this._node.port.postMessage({type:'reset',epoch:this._epoch,running:true});this._state('running');return metadata;
    }catch(error){if(generation===this._generation){await this.stop();emit(this,'error',error);}throw error;}
  }
  async send(input,{timestamp}={}){
    this._alive();if(this.state!=='running')throw new Error('Start live audio before sending MIDI.');
    const generation=this._generation,{data}=midiMessages(input);const metadata=await this._call('midi',{bytes:data,timestamp},[data.buffer]);
    if(generation!==this._generation)throw new DOMException('Live audio cancelled.','AbortError');
    this.metadata=metadata;return metadata;
  }
  async panic(){
    this._alive();if(this.state!=='running')return;const epoch=++this._epoch,generation=this._generation;
    this._node.port.postMessage({type:'reset',epoch,running:false});await this._call('panic',{epoch});
    if(generation===this._generation&&epoch===this._epoch&&this.state==='running')this._node.port.postMessage({type:'reset',epoch,running:true});
  }
  async stop(){
    if(this.state==='disposed')return;this._generation++;this._opening=null;
    for(const p of this._pending.values())p.reject(new DOMException('Live audio stopped.','AbortError'));this._pending.clear();
    this._worker?.terminate();this._worker=null;this._node?.disconnect();this._node?.port.close();this._node=null;this._gain?.disconnect();this._gain=null;
    const context=this._context;this._context=null;this.metadata=null;this._state('stopped');await context?.close();
  }
  async dispose(){
    if(this.state==='disposed')return;
    this.ports.removeEventListener('midimessage',this._input);this.ports.removeEventListener('inputchange',this._selection);
    const stopped=this.stop();this._state('disposed');await stopped;await this.ports.dispose();
  }
}
