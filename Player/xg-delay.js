import { Biquad } from './effect-dsp.js';
import { XG_EQ_FREQUENCY } from './xg-effect-values.js';

// Yamaha MU100 Sound List & MIDI Data p.12, algorithms 05..08, LSB 00.
// Delay units are 0.1 ms, not milliseconds and not a 7-bit macro lookup.
export function delayParameterRange(type, parameter) {
  if(parameter>=13) return [[4,40],[52,76],[28,58],[52,76]][parameter-13];
  if(parameter===10) return [1,127];
  if(type===5) return parameter<=4?[1,14860]:parameter===5?[1,127]:parameter===6?[0,127]:parameter===7?[1,10]:undefined;
  if(type===6) return parameter<=4?[1,14860]:parameter===5?[1,127]:parameter===6?[1,10]:undefined;
  if(type===7) return [1,3,6,7].includes(parameter)?[1,7430]:[2,4].includes(parameter)?[1,127]:parameter===5?[1,10]:parameter===8?[0,127]:undefined;
  if(type===8) return parameter<=2?[1,7430]:parameter===3?[1,127]:parameter===4?[0,2]:parameter===5?[1,10]:undefined;
}
export function delayDefaults(type) {
  // The published Effect1 default is Delay LCR. Other program defaults are
  // explicit host choices; compositions can set each documented parameter.
  const p=type===5?[3333,1667,5000,5000,74,100,10,0,0,32,0,60,28,64,46,64]:
    type===6?[2500,3750,2500,3750,74,10,0,0,0,64,0,0,28,64,46,64]:
    type===7?[2500,74,3750,74,10,5000,6500,64,0,64,0,0,28,64,46,64]:
    [2500,3750,74,2,10,0,0,0,0,64,0,0,28,64,46,64];
  return Int32Array.from(p);
}
export class XGDelay {
  constructor(sampleRate,type=5) {
    this.sampleRate=sampleRate; this.type=type; this.parameters=delayDefaults(type);
    this.left=new Float32Array(Math.ceil(sampleRate*1.49)+3);this.right=new Float32Array(this.left.length);
    this.lowL=new Biquad();this.lowR=new Biquad();this.highL=new Biquad();this.highR=new Biquad();
    this.clear();this.update();
  }
  clear() { this.left.fill(0);this.right.fill(0);this.position=0;this.dampL=this.dampR=0;for(const name of ['lowL','lowR','highL','highR'])this[name].clear(); }
  setParameter(parameter,value) { this.parameters[parameter-1]=value;this.update(); }
  update() {
    const p=this.parameters;
    this.lowL.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[12]],p[13]-64);this.lowR.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[12]],p[13]-64);
    this.highL.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[14]],p[15]-64,true);this.highR.shelf(this.sampleRate,XG_EQ_FREQUENCY[p[14]],p[15]-64,true);
    const damp=(this.type===5?p[6]:this.type===6?p[5]:p[4])/10;
    // Hardware LPF coefficients/feedback gain law are not published. Ratio 1
    // leaves feedback unfiltered; smaller ratios increase high-frequency loss.
    this.damping=damp===1?1:1-Math.exp(-2*Math.PI*(200+18000*damp*damp)/this.sampleRate);
  }
  tap(buffer,value) {
    let position=this.position-value*this.sampleRate/10000;
    position=(position%buffer.length+buffer.length)%buffer.length;
    const at=Math.floor(position),fraction=position-at;
    return buffer[at]+(buffer[(at+1)%buffer.length]-buffer[at])*fraction;
  }
  process(inputL,inputR,outputL,outputR,count,dryL,dryR) {
    const p=this.parameters,feedback=value=>(value-64)/64;
    for(let i=0;i<count;i++) {
      const l=this.highL.process(this.lowL.process(inputL[i])),r=this.highR.process(this.lowR.process(inputR[i]));
      if(dryL){dryL[i]=l;dryR[i]=r;}
      let outL,outR,writeL,writeR;
      if(this.type===5) {
        const center=this.tap(this.left,p[2])*p[5]/127*Math.SQRT1_2,feed=this.tap(this.left,p[3]);
        outL=this.tap(this.left,p[0])+center;outR=this.tap(this.left,p[1])+center;
        this.dampL+=this.damping*(feed-this.dampL);writeL=(l+r)*.5+this.dampL*feedback(p[4]);writeR=0;
      } else if(this.type===6 || this.type===7) {
        const echo=this.type===7,feedL=this.tap(this.left,p[echo?0:2]),feedR=this.tap(this.right,p[echo?2:3]);
        outL=this.tap(this.left,p[0]);outR=this.tap(this.right,p[echo?2:1]);
        if(echo) { outL+=this.tap(this.left,p[5])*p[7]/127;outR+=this.tap(this.right,p[6])*p[7]/127; }
        this.dampL+=this.damping*(feedL-this.dampL);this.dampR+=this.damping*(feedR-this.dampR);
        writeL=l+this.dampL*feedback(p[echo?1:4]);writeR=r+this.dampR*feedback(p[echo?3:4]);
      } else {
        outL=this.tap(this.right,p[1]);outR=this.tap(this.left,p[0]);
        this.dampL+=this.damping*(outL-this.dampL);this.dampR+=this.damping*(outR-this.dampR);
        writeL=(p[3]===1?0:l)+this.dampL*feedback(p[2]);writeR=(p[3]===0?0:r)+this.dampR*feedback(p[2]);
      }
      this.left[this.position]=writeL;this.right[this.position]=writeR;
      this.position=(this.position+1)%this.left.length;outputL[i]=outL;outputR[i]=outR;
    }
  }
}
