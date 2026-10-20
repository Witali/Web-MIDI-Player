import { Biquad } from './effect-dsp.js';
import { XG_EQ_FREQUENCY, XG_INITIAL_DELAY, XG_REVERB_TIME } from './xg-effect-values.js';

export const reverbDefaults=()=>Int32Array.from([18,10,8,13,49,0,0,0,0,0,0,4,50,8,64,0]);
export function reverbRange(parameter){
  return ({1:[0,69],2:[0,10],3:[0,63],4:[0,52],5:[34,60],10:[0,127],11:[0,63],12:[0,4],13:[1,127],14:[1,10],15:[1,127]})[parameter];
}
const lengths=[.0297,.0371,.0411,.0437,.0531,.0617,.0719,.0797];
const early=[0,.007,.011,.019,.029,.037,.043,.053];
// A host eight-line orthogonal FDN, not a reconstruction of Yamaha's DSP.
// Per-line gain 10^(-3*delay/RT60) supplies the requested low-frequency decay.
export class XGReverb {
  constructor(sampleRate,type=1,lsb=0,block='system'){
    this.sampleRate=sampleRate;this.block=block;this.type=type;this.lsb=lsb;this.parameters=reverbDefaults();if(block!=='system')this.parameters[9]=64;
    this.scale=type===1?(lsb?1.2:1):type===2?[.45,.6,.8][lsb]:type===3?(lsb?1.1:.9):.75;
    this.left=new Float32Array(Math.ceil(sampleRate*.23)+4);this.right=new Float32Array(this.left.length);
    this.revDelay=new Float32Array(Math.ceil(sampleRate*.11)+4);
    this.lines=lengths.map(length=>new Float32Array(Math.max(2,Math.round(length*this.scale*sampleRate))));
    this.positions=new Uint32Array(8);this.damped=new Float64Array(8);this.values=new Float64Array(8);this.gains=new Float64Array(8);
    this.diffusers=[.005,.007,.011].map(length=>({buffer:new Float32Array(Math.max(1,Math.round(length*sampleRate))),position:0}));
    this.hpL=new Biquad();this.hpR=new Biquad();this.lpL=new Biquad();this.lpR=new Biquad();this.clear();this.update();
  }
  clear(){this.left.fill(0);this.right.fill(0);this.revDelay.fill(0);this.position=this.revPosition=0;this.positions.fill(0);this.damped.fill(0);this.values.fill(0);
    for(const line of this.lines)line.fill(0);for(const diffuser of this.diffusers){diffuser.buffer.fill(0);diffuser.position=0;}
    for(const name of ['hpL','hpR','lpL','lpR'])this[name].clear();
  }
  setParameter(parameter,value){this.parameters[parameter-1]=value;this.update();}
  update(){
    const p=this.parameters;this.reverbTime=XG_REVERB_TIME[p[0]];
    this.initialDelay=XG_INITIAL_DELAY[p[2]]*this.sampleRate/1000;this.lateDelay=XG_INITIAL_DELAY[p[10]]*this.sampleRate/1000;
    this.hpL.filter(this.sampleRate,p[3]===0?0:XG_EQ_FREQUENCY[p[3]],true);this.hpR.filter(this.sampleRate,p[3]===0?0:XG_EQ_FREQUENCY[p[3]],true);
    this.lpL.filter(this.sampleRate,p[4]===60?0:XG_EQ_FREQUENCY[p[4]]);this.lpR.filter(this.sampleRate,p[4]===60?0:XG_EQ_FREQUENCY[p[4]]);
    for(let i=0;i<8;i++)this.gains[i]=10**(-3*this.lines[i].length/this.sampleRate/this.reverbTime);
    this.damping=p[13]===10?1:1-Math.exp(-2*Math.PI*(200+18000*(p[13]/10)**2)/this.sampleRate);
  }
  tap(buffer,position,delay,current){
    if(delay<1)return current*(1-delay)+buffer[(position+buffer.length-1)%buffer.length]*delay;
    const at=(position-delay+buffer.length)%buffer.length,index=Math.floor(at),fraction=at-index;
    return buffer[index]+(buffer[(index+1)%buffer.length]-buffer[index])*fraction;
  }
  process(inputL,inputR,outputL,outputR,count){
    const p=this.parameters,feedback=(p[14]-64)/64,reflectionCount=2+p[11];
    const earlyGain=p[12]<=64?1:(127-p[12])/63,lateGain=p[12]>=64?1:(p[12]-1)/63;
    const values=this.values;
    for(let frame=0;frame<count;frame++){
      const mono=(inputL[frame]+inputR[frame])*.5;
      const l=this.lpL.process(this.hpL.process(this.block==='system'?inputL[frame]:mono)),r=this.lpR.process(this.hpR.process(this.block==='system'?inputR[frame]:mono));
      const firstL=this.tap(this.left,this.position,this.initialDelay,l),firstR=this.tap(this.right,this.position,this.initialDelay,r);
      this.left[this.position]=l+firstL*feedback;this.right[this.position]=r+firstR*feedback;
      let erL=0,erR=0;
      for(let tap=0;tap<reflectionCount;tap++){
        const delay=this.initialDelay+early[tap]*this.scale*this.sampleRate;
        erL+=this.tap(this.left,this.position,delay,l)/Math.sqrt(reflectionCount);
        erR+=this.tap(this.right,this.position,delay*(tap?1.07:1),r)/Math.sqrt(reflectionCount);
      }
      this.position=(this.position+1)%this.left.length;
      let source=this.tap(this.revDelay,this.revPosition,this.lateDelay,(erL+erR)*.5);
      this.revDelay[this.revPosition]=(erL+erR)*.5;this.revPosition=(this.revPosition+1)%this.revDelay.length;
      for(const diffuser of this.diffusers){
        const previous=diffuser.buffer[diffuser.position],gain=p[1]/10*.7;
        const value=gain===0?source:previous-gain*source;
        diffuser.buffer[diffuser.position]=gain===0?source:source+gain*value;
        diffuser.position=(diffuser.position+1)%diffuser.buffer.length;source=value;
      }
      let lateL=0,lateR=0;
      for(let line=0;line<8;line++){
        const sample=this.lines[line][this.positions[line]];
        this.damped[line]+=this.damping*(sample-this.damped[line]);values[line]=this.damped[line]*this.gains[line];
        lateL+=sample*(line%2?-.25:.25);lateR+=sample*(line%3? .25:-.25);
      }
      // In-place normalized Hadamard feedback; its norm cannot amplify energy.
      for(let size=1;size<8;size*=2)for(let base=0;base<8;base+=2*size)for(let j=0;j<size;j++){
        const a=values[base+j],b=values[base+j+size];values[base+j]=a+b;values[base+j+size]=a-b;
      }
      for(let line=0;line<8;line++){
        this.lines[line][this.positions[line]]=values[line]*Math.SQRT1_2*.5+source*(line%3?1:-1)/Math.sqrt(8);
        this.positions[line]=(this.positions[line]+1)%this.lines[line].length;
      }
      outputL[frame]=erL*earlyGain+lateL*lateGain;outputR[frame]=erR*earlyGain+lateR*lateGain;
    }
  }
}
