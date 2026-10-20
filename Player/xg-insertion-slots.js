import { SpessaLog } from './vendor/spessasynth.js';
import { createXGEffect,xgEffectRange } from './xg-effect-types.js';
const fail=(feature,data,reason)=>SpessaLog.xgFail(feature,data,reason);
export class XGInsertionSlot {
  constructor(core,index){this.core=core;this.index=index;this.partAddress=12;this.controlAddress=13;this.raw=new Uint8Array(128);
    this.outputL=new Float32Array(core.maxBufferSize);this.outputR=new Float32Array(core.maxBufferSize);this.reset();}
  reset(){this.raw.fill(0);this.raw[12]=127;this.raw.fill(64,13,18);this.partOffset=0;this.select(0x49,0,false);}
  clearHistory(){for(const processor of [this.processor,this.bypassProcessor])if(processor){processor.parameters.set(this.parameters);processor.update();processor.clear();}
    for(const name of ['outputL','outputR','insertL','insertR','dryL','dryR','offInsertL','offInsertR','offDryL','offDryR'])this[name]?.fill(0);}
  select(msb,lsb,report=true){
    this.raw[0]=msb;this.raw[1]=lsb;this.type=(msb<<8)|lsb;this.processor=createXGEffect(this.core.sampleRate,msb,lsb,'insertion');
    this.bypassProcessor=createXGEffect(this.core.sampleRate,msb,lsb,'insertion');this.parameters=this.processor?this.processor.parameters.slice():new Int32Array(16);this.mode=this.processor?'effect':'thru';
    for(let p=1;p<=16;p++)this.writeRaw(p,this.parameters[p-1]);
    if(report){if(!this.processor&&this.type!==0x4000)fail('Insertion '+(this.index+1)+' effect',[msb,lsb],'Unsupported effect type. Using Thru.');else SpessaLog.xgInfo('Insertion '+(this.index+1)+' type',[msb,lsb]);}
  }
  writeRaw(p,value){if(p<=10){this.raw[p+1]=value&127;this.raw[0x30+(p-1)*2]=value>>7;this.raw[0x31+(p-1)*2]=value&127;}else this.raw[0x20+p-11]=value;}
  parameter(p,value){
    const range=this.processor&&xgEffectRange(this.processor,p);
    if(!this.processor){if(this.type===0x4000){SpessaLog.xgInfo('Insertion parameter inactive in Thru',p);return;}fail('Insertion parameter',[p,value],'Selected effect is unavailable. Using Thru.');return;}
    if(range&&(value<range[0]||value>range[1])){fail('Insertion parameter',[p,value],'Value outside documented range '+range.join('..')+'.');return;}
    this.parameters[p-1]=value;this.writeRaw(p,value);this.processor.setParameter(p,value);this.bypassProcessor.setParameter(p,value);
    SpessaLog.xgInfo(range?'Insertion parameter '+p:'Insertion unused parameter '+p,value);
  }
  receive(syx,channelOffset){
    const data=syx.slice(6,-1),base=syx[5];
    for(let i=0;i<data.length;i++){
      const address=base+i,value=data[i];if(address>=128){fail('Insertion address',[address],'Address outside Effect2 block.');continue;}
      if(address===0||address===1){let msb=this.raw[0],lsb=this.raw[1];if(address===0){msb=value;if(i+1<data.length)lsb=data[++i];}else lsb=value;this.select(msb,lsb);continue;}
      if((address>=2&&address<=11)||(address>=0x30&&address<=0x43)){
        const wide=address>=0x30,requiresWide=this.processor?.family==='delay';let p,decoded;
        if(wide){p=Math.floor((address-0x30)/2)+1;const at=0x30+(p-1)*2;let hi=this.raw[at],lo=this.raw[at+1];if(address===at){hi=value;if(i+1<data.length)lo=data[++i];}else lo=value;decoded=(hi<<7)|lo;
          if(requiresWide){this.raw[at]=hi;this.raw[at+1]=lo;}
        }else{p=address-1;decoded=value;}
        // MU100 p.44 explicitly says the other parameter representation is
        // not received. This also applies to legacy fields in a delay dump.
        if(this.processor&&wide!==requiresWide){SpessaLog.xgInfo('Insertion parameter representation inactive',p);continue;}
        this.parameter(p,decoded);continue;
      }
      if(address>=0x20&&address<=0x25){this.parameter(address-0x20+11,value);continue;}
      if(address===12){
        if(value>31&&value!==127){fail('Insertion part',[value],'Only MIDI parts0..31 or OFF127 are supported; analogue inputs are unavailable.');continue;}
        if(value!==this.raw[12]||this.partOffset!==channelOffset)this.bypassProcessor?.clear();this.raw[12]=value;this.partOffset=channelOffset;SpessaLog.xgInfo('Insertion part',value);continue;
      }
      if(address>=13&&address<=17){this.raw[address]=value;SpessaLog.xgInfo('Insertion controller depth',value);continue;}
      fail('Insertion address',[address,value],'Reserved Effect2 address.');
    }
    if(this.core.midiParameters.system!=='xg')fail('Insertion system mode',[],'Effect2 audio routing requires XG System On.');
  }
}
