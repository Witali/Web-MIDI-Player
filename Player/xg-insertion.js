import { GeneratorTypes,SpessaLog } from './vendor/spessasynth.js';

const volumeSource=(source)=>source.isCC&&(source.index===7||source.index===11);
const panSource=(source)=>source.isCC&&source.index===10;
const bounded=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
class PartBus {
  constructor(manager,channel){
    this.manager=manager;this.channel=channel;const n=manager.core.maxBufferSize;
    this.left=new Float32Array(n);this.right=new Float32Array(n);this.values=new Float64Array(2);
    this.controllers=new Int16Array(128);this.context=Object.create(channel);
    Object.defineProperty(this.context,'midiControllers',{value:this.controllers});this.chain=[];this.processing=false;
  }
  begin(chain){
    this.chain=chain;this.processing=chain.some(effect=>effect.mode!=='thru');this.left.fill(0);this.right.fill(0);
    this.controllers.set(this.channel.midiControllers);this.controllers[7]=this.controllers[11]=16383;this.controllers[10]=8192;
  }
  voiceParameters(voice){
    const ch=this.channel,g=voice.generators,attenuation=GeneratorTypes.initialAttenuation,pan=GeneratorTypes.pan;
    let a=g[attenuation],p=g[pan];if(ch.generators.offsetsEnabled){a+=ch.generators.offsets[attenuation];p+=ch.generators.offsets[pan];}
    const pitch=ch.perNotePitch?ch.pitchWheels[voice.midiNote]:ch.midiParameters.pitchWheel;
    for(let i=0;i<voice.modulators.length;i++){
      const mod=voice.modulators[i];if(mod.destination!==attenuation&&mod.destination!==pan)continue;
      const relevant=mod.destination===attenuation?volumeSource:panSource;
      let value=voice.modulatorValues[i];
      if(relevant(mod.primarySource)||relevant(mod.secondarySource)){
        value=mod.primarySource.getValue(this.context,pitch,voice)*mod.secondarySource.getValue(this.context,pitch,voice)*mod.transformAmount;
        if(mod.transformType===2)value=Math.abs(value);value=(value<<16)>>16;
      }
      if(mod.destination===attenuation)a+=value;else p+=value;
    }
    this.values[0]=bounded(a,0,1440);this.values[1]=bounded(p,-500,500);return this.values;
  }
  capture(buffer,count,left,right){for(let i=0;i<count;i++){this.left[i]+=buffer[i]*left;this.right[i]+=buffer[i]*right;}}
}

// A single part mixer follows all insertion stages (MU100 Owner's Manual
// pp.140-141). MIDI control state is retained; only its audio stage moves.
export class XGInsertionRouting {
  constructor(core){this.core=core;this.parts=new Map();this.stages=[];this.silence=new Float32Array(core.maxBufferSize);}
  get active(){return this.core.midiParameters.system==='xg'&&this.core.systemParameters.effectsEnabled;}
  effects(){const v=this.core.xgVariation;return v.active&&v.raw[0x5a]===0?[v]:[];}
  partOf(effect){return effect.raw[0x5b]===127?-1:effect.raw[0x5b]+effect.partOffset;}
  reset(){this.parts.clear();for(const channel of this.core.midiChannels)channel.xgDryLevel=127;}
  begin(){
    for(const bus of this.parts.values()){bus.processing=false;bus.chain=[];bus.left.fill(0);bus.right.fill(0);}
    this.stages=this.effects();if(!this.active||!this.stages.length)return;const groups=new Map();
    for(const effect of this.stages){
      const channel=this.partOf(effect);if(channel<0||!this.core.midiChannels[channel])continue;
      let chain=groups.get(channel);if(!chain)groups.set(channel,chain=[]);chain.push(effect);
    }
    for(const [index,chain]of groups){let bus=this.parts.get(index);if(!bus){bus=new PartBus(this,this.core.midiChannels[index]);this.parts.set(index,bus);}bus.begin(chain);}
  }
  route(channel,voice){
    if(!this.active)return;const bus=this.parts.get(channel.channel);if(!bus?.processing)return;
    // XG drum Variation Send is on/off in insertion connection. Other drum
    // notes retain their independent original dry/send path.
    if(channel.drumChannel&&voice.delaySend===0)return;return bus;
  }
  dryLevel(channel){return this.core.midiParameters.system==='xg'?(channel.xgDryLevel??127)/127:1;}
  render(effect,inputL,inputR,count){
    const n=this.core.maxBufferSize;
    for(const key of ['insertL','insertR','dryL','dryR'])effect[key]??=new Float32Array(n);
    if(effect.mode==='off'){effect.insertL.fill(0);effect.insertR.fill(0);}
    else if(effect.mode==='thru'){effect.insertL.set(inputL);effect.insertR.set(inputR);}
    else{
      effect.processor.process(inputL,inputR,effect.insertL,effect.insertR,count,effect.dryL,effect.dryR);
      const wet=(effect.parameters[9]-1)/126,dry=1-wet;
      for(let i=0;i<count;i++){effect.insertL[i]=effect.insertL[i]*wet+effect.dryL[i]*dry;effect.insertR[i]=effect.insertR[i]*wet+effect.dryR[i]*dry;}
    }
    return [effect.insertL,effect.insertR];
  }
  process(outputL,outputR,start,count){
    if(!this.active||!this.stages.length)return;const done=new Set();
    for(const bus of this.parts.values()){
      if(!bus.processing)continue;let l=bus.left,r=bus.right;
      for(const effect of bus.chain){[l,r]=this.render(effect,l,r,count);done.add(effect);}
      const channel=bus.channel,cc=channel.midiControllers;
      // MIDI specifies control ranges, not the manufacturer's gain law.
      // Continuous square gain and a stereo mid/side pan are host policies.
      const volume=bounded(cc[7]/16256,0,1)**2,expression=bounded(cc[11]/16256,0,1)**2;
      const gain=channel.currentGain*volume*expression;
      const midiPan=cc[10]<=8192?(cc[10]-8192)/8192:(cc[10]-8192)/8064;
      const pan=bounded(midiPan+channel.currentPan/500,-1,1),angle=(pan+1)*Math.PI/4;
      const cos=Math.cos(angle),sin=Math.sin(angle),width=Math.cos(pan*Math.PI/2),dryLevel=this.dryLevel(channel);
      const toReverb=(cc[91]/128/127)*this.core.systemParameters.reverbGain,toChorus=(cc[93]/128/127)*this.core.systemParameters.chorusGain;
      for(let i=0;i<count;i++){
        const mid=(l[i]+r[i])*Math.SQRT1_2,side=(l[i]-r[i])*Math.SQRT1_2*width;
        const left=(mid*cos+side*sin)*gain,right=(mid*sin-side*cos)*gain;
        outputL[start+i]+=left*dryLevel;outputR[start+i]+=right*dryLevel;
        this.core.xgSystemEffects.variation(left,right,toReverb,toChorus,i);
      }
    }
    // A bypassed/unassigned processor still ages; later assignment cannot
    // resume a frozen delay, filter or LFO history.
    for(const effect of this.stages)if(!done.has(effect)&&effect.processor)effect.processor.process(this.silence,this.silence,effect.outputL,effect.outputR,count);
  }
  receivePart(syx,channelOffset,dispatch){
    if(syx[2]!==0x4c||syx[3]!==8)return false;
    if((syx[1]&0xf0)!==0x10||syx.length<8||syx.at(-1)!==0xf7||syx.slice(1,-1).some(v=>!Number.isInteger(v)||v<0||v>127)){
      SpessaLog.xgFail('Part setup',Array.from(syx),'Malformed XG Parameter Change.');return true;
    }
    if(syx[4]>31){SpessaLog.xgFail('Part setup',[syx[4]],'MU100 part number must be 0..31.');return true;}
    const index=syx[4]+channelOffset,channel=this.core.midiChannels[index];
    if(!channel){SpessaLog.xgFail('Part setup',[index],'Invalid part number.');return true;}
    const data=syx.slice(6,-1),base=syx[5];let mixerWrite=false;
    for(let i=0;i<data.length;i++){
      const address=base+i,value=data[i];
      if(address>=128){SpessaLog.xgFail('Part address',[address],'Address outside supported Multi Part block.');continue;}
      const limits=({0:[0,64],5:[0,1],6:[0,2],7:[0,5],8:[40,88],35:[40,88]})[address];
      if((limits&&(value<limits[0]||value>limits[1]))||(address===4&&value>31&&value!==127)){SpessaLog.xgFail('Part parameter',[address,value],'Value outside the documented range.');continue;}
      if(address===0x11){mixerWrite=true;channel.xgDryLevel=value;SpessaLog.xgInfo('Part Dry Level',value);continue;}
      if(address===0x14){
        mixerWrite=true;const variation=this.core.xgVariation;
        if(variation.raw[0x5a]===1)channel.controllerChange(94,value);
        else if(value){variation.raw[0x5b]=syx[4];variation.partOffset=channelOffset;variation.enabled=true;}
        else if(this.partOf(variation)===index)variation.raw[0x5b]=127;
        SpessaLog.xgInfo('Part Variation Send',value);continue;
      }
      // Detune is a two-nibble parameter; forward its complete data together.
      if(address===9&&i+1<data.length){dispatch(new Uint8Array([...syx.slice(0,5),address,value,data[++i],0xf7]));continue;}
      if(address===4&&value===127){channel.setMIDIParameter('rxChannel',-1);this.core.customChannelNumbers=true;SpessaLog.xgInfo('Part receive channel','OFF');continue;}
      dispatch(new Uint8Array([...syx.slice(0,5),address,value,0xf7]));
    }
    if(mixerWrite&&this.core.midiParameters.system!=='xg')SpessaLog.xgFail('Part mixer mode',[],'XG part mixer controls require XG System On.');
    return true;
  }
}
