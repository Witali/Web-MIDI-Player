import { Biquad } from './effect-dsp.js';
import { XG_EQ_FREQUENCY } from './xg-effect-values.js';
// MU100 p.16 and Effect2 factory data pp.43-45. The transfer/gate curves
// and filter coefficients are host models; Yamaha publishes the controls.
export function driveRange(parameter){return ({1:[0,127],2:[4,40],3:[52,76],4:[34,60],5:[0,127],7:[14,54],8:[52,76],9:[10,120],10:[1,127],11:[0,127]})[parameter];}
export class XGDrive {
  constructor(sampleRate,type=0x49,block='variation'){
    this.sampleRate=sampleRate;this.type=type;this.block=block;
    this.parameters=Int32Array.from([40,20,72,53,64,0,43,74,10,127,120,0,0,0,0,0]);
    if(type===0x4a){this.parameters[0]=32;this.parameters[2]=64;this.parameters[7]=64;this.parameters[10]=64;}
    this.low=new Biquad();this.mid=new Biquad();this.lpf=new Biquad();this.clear();this.update();
  }
  clear(){this.follower=0;this.low.clear();this.mid.clear();this.lpf.clear();}
  setParameter(parameter,value){this.parameters[parameter-1]=value;this.update();}
  update(){const p=this.parameters;this.preGain=1+p[0]/127*(this.type===0x49?63:31);
    this.low.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[1]],p[2]-64);this.mid.peak(this.sampleRate,XG_EQ_FREQUENCY[p[6]],p[7]-64,p[8]/10);
    this.lpf.filter(this.sampleRate,p[3]===60?0:XG_EQ_FREQUENCY[p[3]]);this.level=p[4]/127;this.edge=p[10]/127;
    this.attack=1-Math.exp(-1/(this.sampleRate*.003));this.release=1-Math.exp(-1/(this.sampleRate*.05));
  }
  process(inputL,inputR,outputL,outputR,count,dryL,dryR){
    for(let i=0;i<count;i++){
      if(dryL){dryL[i]=inputL[i];dryR[i]=inputR[i];}
      let signal=(inputL[i]+inputR[i])*.5;
      // Variation includes the documented envelope-follower gate; the
      // separate Insertion blocks do not (MU100 p.16 diagrams).
      if(this.block==='variation'){const magnitude=Math.abs(signal);this.follower+=(magnitude>this.follower?this.attack:this.release)*(magnitude-this.follower);if(this.follower<=1e-5)signal=0;}
      const driven=signal*this.preGain,soft=Math.tanh(driven),hard=Math.max(-1,Math.min(1,driven));
      const value=this.lpf.process(this.mid.process(this.low.process(soft*(1-this.edge)+hard*this.edge)))*this.level;
      outputL[i]=value;outputR[i]=value;
    }
  }
}
