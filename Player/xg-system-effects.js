import { SpessaLog } from './vendor/spessasynth.js';
import { XGChorus,chorusDefaults,chorusRange } from './xg-chorus.js';
import { XGReverb,reverbDefaults,reverbRange } from './xg-reverb.js';
import { xgLevel } from './xg-effect-values.js';
const fail=(feature,data,reason)=>SpessaLog.xgFail(feature,data,reason);
class SystemBlock {
  constructor(owner,kind){this.owner=owner;this.kind=kind;const n=owner.core.maxBufferSize;
    this.inputL=new Float32Array(n);this.inputR=new Float32Array(n);this.outputL=new Float32Array(n);this.outputR=new Float32Array(n);this.raw=new Uint8Array(32);this.reset();
  }
  reset(){this.raw.fill(0);this.raw[12]=this.raw[13]=64;this.select(this.kind==='Reverb'?1:0x41,0,false);this.begin();}
  begin(){this.inputL.fill(0);this.inputR.fill(0);}
  select(msb,lsb,report=true){
    this.raw[0]=msb;this.raw[1]=lsb;this.type=(msb<<8)|lsb;
    const reverb=this.kind==='Reverb',supported=reverb?msb>=1&&msb<=4&&lsb<=[1,2,1,0][msb-1]:
      [0x41,0x42,0x43].includes(msb)&&(msb===0x43?[0,1,8]:[0,1,2,8]).includes(lsb);
    this.processor=supported?(reverb?new XGReverb(this.owner.core.sampleRate,msb,lsb):new XGChorus(this.owner.core.sampleRate,msb,lsb)):null;
    this.mode=this.processor?'effect':msb===0&&lsb===0?'off':'thru';this.parameters=this.processor?.parameters??new Int32Array(16);
    const defaults=this.processor?(reverb?reverbDefaults():chorusDefaults(msb,lsb)):this.parameters;
    for(let p=1;p<=16;p++)this.raw[p<=10?p+1:p+5]=defaults[p-1];
    if(report){if(this.mode==='thru')fail(this.kind+' effect',[msb,lsb],'Unsupported effect type. Using Thru.');else SpessaLog.xgInfo(this.kind+' type',[msb,lsb]);}
  }
  parameter(p,value){
    const range=this.processor&&(this.kind==='Reverb'?reverbRange(p):chorusRange(this.type>>8,p));
    if(!range&&!this.processor){if(this.type===0){SpessaLog.xgInfo(this.kind+' parameter inactive',p);return;}fail(this.kind+' parameter',[p,value],'Selected effect is unavailable. Using Thru.');return;}
    if(range&&(value<range[0]||value>range[1])){fail(this.kind+' parameter',[p,value],'Value outside documented range '+range.join('..')+'.');return;}
    this.raw[p<=10?p+1:p+5]=value;this.processor.setParameter(p,value);SpessaLog.xgInfo(this.kind+' parameter '+p,value);
  }
  render(count){
    if(this.processor)this.processor.process(this.inputL,this.inputR,this.outputL,this.outputR,count);
    else if(this.mode==='thru'){this.outputL.set(this.inputL);this.outputR.set(this.inputR);}
    else{this.outputL.fill(0);this.outputR.fill(0);}
  }
  mix(left,right,start,count){
    const gain=xgLevel(this.raw[12]),angle=(this.raw[13]-1)/126*Math.PI/2,l=Math.cos(angle)*Math.SQRT2*gain,r=Math.sin(angle)*Math.SQRT2*gain;
    for(let i=0;i<count;i++){left[start+i]+=this.outputL[i]*l;right[start+i]+=this.outputR[i]*r;}
  }
}
export class XGSystemEffects {
  constructor(core){this.core=core;this.reverb=new SystemBlock(this,'Reverb');this.chorus=new SystemBlock(this,'Chorus');}
  get active(){return this.core.midiParameters.system==='xg';}
  reset(){this.reverb.reset();this.chorus.reset();}
  begin(){this.reverb.begin();this.chorus.begin();}
  write(address,value,next){
    const chorus=address>=0x20,block=chorus?this.chorus:this.reverb,a=address-(chorus?0x20:0);
    let consumed=1;
    if(a===0||a===1){let msb=block.raw[0],lsb=block.raw[1];if(a===0){msb=value;if(next!==undefined){lsb=next;consumed=2;}}else lsb=value;block.select(msb,lsb);}
    else if((a>=2&&a<=11)||(a>=16&&a<=21))block.parameter(a<=11?a-1:a-5,value);
    else if(a===12||a===13||(chorus&&a===14)){
      if(a===13&&value<1)fail(block.kind+' pan',[value],'Pan must be 1..127.');
      else{block.raw[a]=value;SpessaLog.xgInfo(block.kind+' control '+a.toString(16),value);}
    }else fail('Effect1 address',[address,value],'Reserved address in the System effect block.');
    if(!this.active)fail('System effect mode',[],'Configured XG System effect outside XG mode. Audio routing requires XG System On.');
    return consumed;
  }
  capture(buffer,count,left,right,reverb,chorus){
    if(!this.active)return;reverb=Math.max(0,reverb);chorus=Math.max(0,chorus);if(!reverb&&!chorus)return;const rv=this.reverb,ch=this.chorus;
    for(let i=0;i<count;i++){const l=buffer[i]*left,r=buffer[i]*right;rv.inputL[i]+=l*reverb;rv.inputR[i]+=r*reverb;ch.inputL[i]+=l*chorus;ch.inputR[i]+=r*chorus;}
  }
  variation(left,right,toReverb,toChorus,index){
    this.reverb.inputL[index]+=left*toReverb;this.reverb.inputR[index]+=right*toReverb;
    this.chorus.inputL[index]+=left*toChorus;this.chorus.inputR[index]+=right*toChorus;
  }
  process(left,right,start,count){
    const ch=this.chorus,rv=this.reverb;ch.render(count);const send=xgLevel(ch.raw[14]);
    for(let i=0;i<count;i++){rv.inputL[i]+=ch.outputL[i]*send;rv.inputR[i]+=ch.outputR[i]*send;}
    ch.mix(left,right,start,count);rv.render(count);rv.mix(left,right,start,count);
  }
}
