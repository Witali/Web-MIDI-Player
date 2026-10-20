import { XGInsertionRouting } from './xg-insertion.js';
import { XGSystemEffects } from './xg-system-effects.js';
import { xgLevel } from './xg-effect-values.js';
export { xgLevel } from './xg-effect-values.js';
import { SpessaLog } from './vendor/spessasynth.js';
import { createXGEffect,xgEffectRange } from './xg-effect-types.js';

// MU100 Effect1 pp.41-42 and Owner's Manual pp.136-141. Return/send anchors
// are specified; interpolation below 0 dB is an explicit host gain curve.
const fail=(feature,data,reason)=>SpessaLog.xgFail(feature,data,reason);
class XGVariation {
  constructor(core) {
    this.core=core;this.inputL=new Float32Array(core.maxBufferSize);this.inputR=new Float32Array(core.maxBufferSize);
    this.outputL=new Float32Array(core.maxBufferSize);this.outputR=new Float32Array(core.maxBufferSize);
    this.raw=new Uint8Array(128);this.reset();
  }
  get active() { return this.enabled && this.core.midiParameters.system==='xg'; }
  reset() {
    this.enabled=false;this.raw.fill(0);this.raw[0x56]=this.raw[0x57]=64;this.raw[0x5b]=127;
    this.raw.fill(64,0x5c,0x61);this.partOffset=0;this.select(5,0,false);this.begin();
  }
  begin() { this.inputL.fill(0);this.inputR.fill(0); }
  select(msb,lsb,report=true) {
    this.raw[0x40]=msb;this.raw[0x41]=lsb;this.type=(msb<<8)|lsb;
    this.processor=createXGEffect(this.core.sampleRate,msb,lsb);
    this.mode=this.processor?'effect':msb===0&&lsb===0?'off':'thru';
    this.parameters=this.processor?.parameters??new Int32Array(16);
    const defaults=this.processor?.parameters??new Int32Array(16);
    for(let p=1;p<=16;p++) {
      if(p<=10) {this.raw[0x42+(p-1)*2]=defaults[p-1]>>7;this.raw[0x43+(p-1)*2]=defaults[p-1]&127;}
      else this.raw[0x70+p-11]=defaults[p-1];
    }
    if(report && this.mode==='thru' && !(msb===0x40 && lsb===0)) fail('Variation effect',[msb,lsb],'Unsupported effect type. Using Thru.');
    else if(report)SpessaLog.xgInfo('Variation type',[msb,lsb]);
  }
  receive(syx,channelOffset,dispatch) {
    if(syx[2]!==0x4c || syx[3]!==2 || syx[4]!==1) return false;
    if((syx[1]&0xf0)!==0x10) {fail('Effect message',Array.from(syx),'Only XG Parameter Change is implemented; bulk dumps require their own decoder.');return true;}
    if(syx.length<8 || syx.at(-1)!==0xf7 || syx.slice(1,-1).some(v=>!Number.isInteger(v)||v<0||v>127)) {
      fail('Effect message',Array.from(syx),'Malformed XG Parameter Change. No effect parameters changed.');return true;
    }
    const data=syx.slice(6,-1),base=syx[5];
    for(let i=0;i<data.length;i++) {
      const address=base+i,value=data[i];
      if(address>=128) {fail('Effect address',[2,1,address],'Address outside supported Effect1 block.');continue;}
      if(address<0x40) {i+=this.core.xgSystemEffects.write(address,value,i+1<data.length?data[i+1]:undefined)-1;continue;}
      if(address===0x40 || address===0x41) {
        let msb=this.raw[0x40],lsb=this.raw[0x41];
        if(address===0x40){msb=value;if(i+1<data.length)lsb=data[++i];}else lsb=value;
        this.enabled=true;this.select(msb,lsb);continue;
      }
      if((address>=0x42&&address<=0x55)||(address>=0x70&&address<=0x75)) {
        this.raw[address]=value;let parameter,decoded;
        if(address<=0x55){parameter=Math.floor((address-0x42)/2)+1;const at=0x42+(parameter-1)*2;
          if(address===at && i+1<data.length)this.raw[at+1]=data[++i];decoded=(this.raw[at]<<7)|this.raw[at+1];
        }else{parameter=address-0x70+11;decoded=value;}
        const range=this.processor && xgEffectRange(this.processor,parameter);
        if(!range){fail('Variation parameter',[parameter,decoded],'Parameter is reserved, unused, or its effect type is unavailable.');continue;}
        if(decoded<range[0] || decoded>range[1]){fail('Variation parameter',[parameter,decoded],'Value outside documented range '+range.join('..')+'.');continue;}
        this.enabled=true;this.processor.setParameter(parameter,decoded);SpessaLog.xgInfo('Variation parameter '+parameter,decoded);continue;
      }
      const range=address===0x57?[1,127]:address===0x5a?[0,1]:address>=0x56&&address<=0x5b?[0,127]:null;
      if(!range) {fail('Variation parameter',[address,value],'Reserved address or unsupported controller modulation.');continue;}
      if(value<range[0]||value>range[1] || (address===0x5b&&value>31&&value!==127)) {
        fail('Variation parameter',[address,value],'Value outside supported MIDI-part range; analogue inputs are unavailable.');continue;
      }
      this.raw[address]=value;this.enabled=true;if(address===0x5b)this.partOffset=channelOffset;
      SpessaLog.xgInfo('Variation control '+address.toString(16),value);
    }
    if(this.enabled && !this.active) fail('Variation system mode',[],'Configured XG Variation outside XG mode. Audio routing requires XG System On.');
    return true;
  }
  capture(buffer,count,left,right,amount) {
    if(!this.active || this.raw[0x5a]!==1 || !amount) return;
    for(let i=0;i<count;i++){this.inputL[i]+=buffer[i]*left*amount;this.inputR[i]+=buffer[i]*right*amount;}
  }
  process(outputL,outputR,reverb,chorus,start,count) {
    if(!this.active) return;
    // The part routing stage processes insertion connection before the mixer.
    if(this.raw[0x5a]!==1) return;
    if(this.processor)this.processor.process(this.inputL,this.inputR,this.outputL,this.outputR,count);
    else if(this.mode==='thru'){this.outputL.set(this.inputL);this.outputR.set(this.inputR);}
    else{this.outputL.fill(0);this.outputR.fill(0);}
    const gain=xgLevel(this.raw[0x56]),angle=(this.raw[0x57]-1)/126*Math.PI/2;
    const left=Math.cos(angle)*Math.SQRT2*gain,right=Math.sin(angle)*Math.SQRT2*gain;
    const toReverb=xgLevel(this.raw[0x58]),toChorus=xgLevel(this.raw[0x59]);
    for(let i=0;i<count;i++) {
      const l=this.outputL[i],r=this.outputR[i],mono=(l+r)*.5;
      // System send taps precede Variation pan and return (MU100 p.140).
      reverb[i]+=mono*toReverb;chorus[i]+=mono*toChorus;
      if(this.core.xgSystemEffects.active)this.core.xgSystemEffects.variation(l,r,toReverb,toChorus,i);
      outputL[start+i]+=l*left;outputR[start+i]+=r*right;
    }
  }
}
export function installXGVariation(synth) {
  const core=synth.synthCore;if(core.xgVariation)return core.xgVariation;
  core.xgSystemEffects=new XGSystemEffects(core);
  core.xgVariation=new XGVariation(core);
  core.xgInsertion=new XGInsertionRouting(core);
  const reset=core.reset.bind(core);core.reset=(...args)=>{reset(...args);core.xgVariation.reset();core.xgSystemEffects.reset();core.xgInsertion.reset();};
  return core.xgVariation;
}
