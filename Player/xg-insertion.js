import { XGInsertionSlot } from './xg-insertion-slots.js';
import { applyXGEffectControl } from './xg-effect-control.js';
import { GeneratorTypes,SpessaLog } from './vendor/spessasynth.js';

const volumeSource=(source)=>source.isCC&&(source.index===7||source.index===11);
const panSource=(source)=>source.isCC&&source.index===10;
const bounded=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
class PartBus {
  constructor(manager,channel){
    this.manager=manager;this.channel=channel;const n=manager.core.maxBufferSize;
    this.left=new Float32Array(n);this.right=new Float32Array(n);this.offLeft=new Float32Array(n);this.offRight=new Float32Array(n);this.varLeft=new Float32Array(n);this.varRight=new Float32Array(n);this.mixedLeft=new Float32Array(n);this.mixedRight=new Float32Array(n);this.values=new Float64Array(2);
    this.controllers=new Int16Array(128);this.context=Object.create(channel);
    Object.defineProperty(this.context,'midiControllers',{value:this.controllers});this.chain=[];this.processing=false;
  }
  begin(chain){
    this.chain=chain;this.processing=chain.some(effect=>effect.mode!=='thru');this.left.fill(0);this.right.fill(0);this.offLeft.fill(0);this.offRight.fill(0);
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
  capture(buffer,count,left,right,voice){
    const depth=Math.max(0,Math.min(1,voice.delaySend)),insertion=this.manager.core.xgVariation.raw[0x5a]===0,without=insertion?(depth===0?1:0):1-depth;
    for(let i=0;i<count;i++){const l=buffer[i]*left,r=buffer[i]*right;this.left[i]+=l;this.right[i]+=r;this.offLeft[i]+=l*without;this.offRight[i]+=r*without;}
  }
}

// A single part mixer follows all insertion stages (MU100 Owner's Manual
// pp.140-141). MIDI control state is retained; only its audio stage moves.
export class XGInsertionRouting {
  constructor(core){this.core=core;this.parts=new Map();this.stages=[];this.slots=[new XGInsertionSlot(core,0),new XGInsertionSlot(core,1)];this.silence=new Float32Array(core.maxBufferSize);}
  get active(){return this.core.midiParameters.system==='xg'&&this.core.systemParameters.effectsEnabled;}
  effects(){const v=this.core.xgVariation;return [...this.slots,...(v.active&&v.raw[0x5a]===0?[v]:[])];}
  partOf(effect){const part=effect.raw[effect.partAddress??0x5b];return part===127?-1:part+effect.partOffset;}
  reset(preserveSlots=false){this.parts.clear();for(const slot of this.slots)preserveSlots?slot.clearHistory():slot.reset();for(const channel of this.core.midiChannels){channel.xgDryLevel=127;channel.xgAC1=16;channel.xgAC2=17;}}
  begin(){
    for(const bus of this.parts.values()){bus.processing=false;bus.chain=[];bus.left.fill(0);bus.right.fill(0);bus.offLeft.fill(0);bus.offRight.fill(0);}
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
    if(voice.delaySend===0&&bus.chain.includes(this.core.xgVariation)&&!bus.chain.some(effect=>effect!==this.core.xgVariation&&effect.mode!=='thru'))return;return bus;
  }
  dryLevel(channel){return this.core.midiParameters.system==='xg'?(channel.xgDryLevel??127)/127:1;}
  render(effect,inputL,inputR,count,bypass=false){
    const n=this.core.maxBufferSize,keys=bypass?['offInsertL','offInsertR','offDryL','offDryR']:['insertL','insertR','dryL','dryR'];
    for(const key of keys)effect[key]??=new Float32Array(n);const [l,r,dL,dR]=keys.map(key=>effect[key]),processor=bypass?effect.bypassProcessor:effect.processor;
    if(effect.mode==='off'){l.fill(0);r.fill(0);}
    else if(effect.mode==='thru'){l.set(inputL);r.set(inputR);}
    else{processor.process(inputL,inputR,l,r,count,dL,dR);const wet=(processor.parameters[9]-1)/126,dry=1-wet;for(let i=0;i<count;i++){l[i]=l[i]*wet+dL[i]*dry;r[i]=r[i]*wet+dR[i]*dry;}}
    return [l,r];
  }
  process(outputL,outputR,start,count){
    if(!this.active||!this.stages.length)return;const done=new Set(),variation=this.core.xgVariation;
    for(const bus of this.parts.values()){
      if(!bus.processing)continue;let l=bus.left,r=bus.right,offL=bus.offLeft,offR=bus.offRight;
      for(const effect of bus.chain){
        applyXGEffectControl(effect,bus.channel);
        if(effect===variation){
          if(effect.mode!=='thru'){
            // Separate the no-send component after preceding nonlinear slots.
            // The subtraction/attribution policy is documented in the notes.
            for(let i=0;i<count;i++){bus.varLeft[i]=l[i]-offL[i];bus.varRight[i]=r[i]-offR[i];}
            const wet=this.render(effect,bus.varLeft,bus.varRight,count);
            for(let i=0;i<count;i++){bus.mixedLeft[i]=wet[0][i]+offL[i];bus.mixedRight[i]=wet[1][i]+offR[i];}
            l=bus.mixedLeft;r=bus.mixedRight;
          }
        }else{[l,r]=this.render(effect,l,r,count);[offL,offR]=this.render(effect,offL,offR,count,true);}
        done.add(effect);
      }
      // Gain and pan interpolation are host policies; MIDI fixes the ranges.
      const channel=bus.channel,cc=channel.midiControllers,volume=Math.max(0,Math.min(1,cc[7]/16256))**2,expression=Math.max(0,Math.min(1,cc[11]/16256))**2;
      const gain=channel.currentGain*volume*expression,midiPan=cc[10]<=8192?(cc[10]-8192)/8192:(cc[10]-8192)/8064;
      const pan=bounded(midiPan+channel.currentPan/500,-1,1),angle=(pan+1)*Math.PI/4,cos=Math.cos(angle),sin=Math.sin(angle),width=Math.cos(pan*Math.PI/2),dryLevel=this.dryLevel(channel);
      const toReverb=(cc[91]/128/127)*this.core.systemParameters.reverbGain,toChorus=(cc[93]/128/127)*this.core.systemParameters.chorusGain;
      const toVariation=variation.active&&variation.raw[0x5a]===1?(cc[94]/128/127)*this.core.systemParameters.delayGain:0;
      for(let i=0;i<count;i++){
        const mid=(l[i]+r[i])*Math.SQRT1_2,side=(l[i]-r[i])*Math.SQRT1_2*width,left=(mid*cos+side*sin)*gain,right=(mid*sin-side*cos)*gain;
        outputL[start+i]+=left*dryLevel;outputR[start+i]+=right*dryLevel;this.core.xgSystemEffects.variation(left,right,toReverb,toChorus,i);
        if(toVariation){const offMid=(offL[i]+offR[i])*Math.SQRT1_2,offSide=(offL[i]-offR[i])*Math.SQRT1_2*width;
          variation.inputL[i]+=(left-(offMid*cos+offSide*sin)*gain)*toVariation;variation.inputR[i]+=(right-(offMid*sin-offSide*cos)*gain)*toVariation;}
      }
    }
    // Unassigned histories keep aging rather than resume from a frozen tail.
    for(const effect of this.stages)if(!done.has(effect)&&effect.processor){applyXGEffectControl(effect,undefined);effect.processor.process(this.silence,this.silence,effect.outputL,effect.outputR,count);effect.bypassProcessor?.process(this.silence,this.silence,effect.outputL,effect.outputR,count);}
  }
  receiveSlots(syx,channelOffset){
    if(syx[2]!==0x4c||syx[3]!==3)return false;
    if((syx[1]&0xf0)!==0x10||syx.length<8||syx.at(-1)!==0xf7||syx.slice(1,-1).some(v=>!Number.isInteger(v)||v<0||v>127)){SpessaLog.xgFail('Insertion message',Array.from(syx),'Malformed XG Parameter Change.');return true;}
    const slot=this.slots[syx[4]];if(!slot){SpessaLog.xgFail('Insertion slot',[syx[4]],'Only MU100 insertion slots0/1 are implemented.');return true;}
    slot.receive(syx,channelOffset);return true;
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
      if(address===0x59||address===0x60){if(value>95){SpessaLog.xgFail('Assignable controller',[value],'Controller number must be0..95.');continue;}channel[address===0x59?'xgAC1':'xgAC2']=value;SpessaLog.xgInfo('Assignable controller number',value);continue;}
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
