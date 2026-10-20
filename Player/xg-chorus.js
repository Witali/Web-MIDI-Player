import { Biquad } from './effect-dsp.js';
import { XG_EQ_FREQUENCY, XG_DELAY_OFFSET, XG_LFO_FREQUENCY } from './xg-effect-values.js';

// MU100 pp.13-14: System Chorus/Celeste/Flanger. The hardware modulation
// depth/gain curves are not published; these are deterministic host models.
export function chorusRange(type, parameter) {
  if(parameter===1||parameter===2)return [0,127];
  if(parameter===3)return [1,127];
  if(parameter===4)return [0,type===0x43?63:127];
  if(parameter===6)return [4,40];
  if(parameter===7||parameter===9||parameter===12)return [52,76];
  if(parameter===8)return [28,58];
  if(parameter===10)return [1,127]; // insertion-only, retained but not mixed here
  if(parameter===11)return [14,54]; // mid EQ applies only to the Variation block
  if(parameter===13)return [10,120];
  if(parameter===14&&type===0x43)return [4,124];
  if(parameter===15&&type!==0x43)return [0,1];
}
export function chorusDefaults(type, lsb=0) {
  const p=Int32Array.from([6,54,77,106,0,28,64,46,64,64,46,64,10,0,0,0]);
  if(type===0x42){p[0]=12;p[1]=64;p[2]=64;p[3]=100;}
  if(type===0x43){p[0]=8;p[1]=64;p[2]=100;p[3]=16;p[13]=64;}
  // Only Chorus1's factory program is published in the Effect1 table.
  // Other presets are host defaults within each program's documented range.
  if(lsb){p[0]+=lsb===8?10:lsb*4;p[1]+=lsb===8?20:lsb*8;}
  return p;
}
export class XGChorus {
  constructor(sampleRate,type=0x41,lsb=0){
    this.sampleRate=sampleRate;this.type=type;this.lsb=lsb;this.parameters=chorusDefaults(type,lsb);
    this.left=new Float32Array(Math.ceil(sampleRate*.09)+4);this.right=new Float32Array(this.left.length);
    this.lowL=new Biquad();this.lowR=new Biquad();this.highL=new Biquad();this.highR=new Biquad();this.clear();this.update();
  }
  clear(){this.left.fill(0);this.right.fill(0);this.position=0;this.phase=0;this.feedbackL=this.feedbackR=0;for(const name of ['lowL','lowR','highL','highR'])this[name].clear();}
  setParameter(parameter,value){this.parameters[parameter-1]=value;this.update();}
  update(){
    const p=this.parameters;this.frequency=XG_LFO_FREQUENCY[p[0]];this.offset=XG_DELAY_OFFSET[p[3]]*this.sampleRate/1000;
    this.depth=p[1]/127*this.sampleRate*(this.type===0x43?.003:.006);
    this.phaseDifference=this.type===0x43?(p[13]-64)*Math.PI/60:Math.PI/2;
    this.lowL.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[5]],p[6]-64);this.lowR.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[5]],p[6]-64);
    this.highL.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[7]],p[8]-64,true);this.highR.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[7]],p[8]-64,true);
  }
  tap(buffer,delay,current){
    if(delay<1)return current*(1-delay)+buffer[(this.position+buffer.length-1)%buffer.length]*delay;
    const at=(this.position-delay+buffer.length)%buffer.length,index=Math.floor(at),fraction=at-index;
    return buffer[index]+(buffer[(index+1)%buffer.length]-buffer[index])*fraction;
  }
  process(inputL,inputR,outputL,outputR,count){
    const p=this.parameters,mono=this.type!==0x43&&p[14]===0,feedback=(p[2]-64)/64,taps=this.type===0x42?3:1;
    for(let i=0;i<count;i++){
      let l=this.highL.process(this.lowL.process(inputL[i])),r=this.highR.process(this.lowR.process(inputR[i]));
      if(mono)l=r=(l+r)*.5;
      const writeL=l+feedback*this.feedbackL,writeR=r+feedback*this.feedbackR;
      let outL=0,outR=0;
      for(let tap=0;tap<taps;tap++){
        const phase=this.phase+tap*Math.PI*2/taps;
        const dL=this.offset+(1+Math.sin(phase))*.5*this.depth;
        const dR=this.offset+(1+Math.sin(phase+this.phaseDifference))*.5*this.depth;
        outL+=this.tap(this.left,dL,writeL)/taps;outR+=this.tap(this.right,dR,writeR)/taps;
      }
      this.left[this.position]=writeL;this.right[this.position]=writeR;this.feedbackL=outL;this.feedbackR=outR;
      this.position=(this.position+1)%this.left.length;this.phase=(this.phase+2*Math.PI*this.frequency/this.sampleRate)%(2*Math.PI);
      outputL[i]=outL;outputR[i]=outR;
    }
  }
}
