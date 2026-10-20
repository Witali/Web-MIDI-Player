import { SpessaLog } from './vendor/spessasynth.js';
import { Biquad } from './effect-dsp.js';

// Roland SC-8850 pp.93-94,216,237,245. Addresses and type bytes are hexadecimal.
const ranges = (...rows) => new Map(rows.map(([address, min = 0, max = 127]) => [address, [min, max]]));
const gain = [52, 76];
const common = ranges([0x30,0,7],[0x31,0,7],[0x32,0,7],[0x33],[0x34],[0x35],[0x37],
  [0x38,0,7],[0x39,0,7],[0x3a],[0x3b],[0x3c],[0x3d],[0x3e],[0x3f],[0x40],
  [0x50,0,9],[0x51,0,7],[0x52,1,115],[0x53,1,120],[0x54,1,120],[0x55],[0x56],[0x57],[0x58],[0x59],[0x5a]);
const driveRanges = ranges([3],[4,0,3],[5,0,1],[19,...gain],[20,...gain],[21],[22]);
const insertion = new Map([
  [0, ranges()],
  [0x100,ranges([3,0,1],[4,...gain],[5,0,1],[6,...gain],[7],[8,0,4],[9,...gain],[10],[11,0,4],[12,...gain],[22])],
  [0x110,driveRanges],[0x111,driveRanges],
  [0x120,ranges([3],[4],[5],[6],[7],[19,...gain],[20,...gain],[22])],
  [0x121,ranges([3,0,1],[4],[5],[6],[7],[8],[9,0,1],[19,...gain],[20,...gain],[21],[22])],
  [0x125,ranges([3,0,4],[4],[5],[19,...gain],[20,...gain],[22])],
  [0x126,ranges([3,0,4],[4],[5],[19,...gain],[20,...gain],[22])]
]);

export class GSOverdrive {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.type = 0x110;
    this.lowEQ = new Biquad(); this.highEQ = new Biquad(); this.reset();
  }
  reset() {
    const hard = this.type === 0x111;
    this.drive = hard ? 76 : 48; this.ampType = hard ? 3 : 1; this.ampSwitch = 1;
    this.lowGain = 0; this.highGain = hard ? -8 : 0; this.pan = 64; this.level = (hard ? 84 : 96) / 127;
    this.sendLevelToReverb = 80 / 127; this.sendLevelToChorus = this.sendLevelToDelay = 0;
    this.cabinetLow = this.cabinetHigh = this.cabinetPrevious = 0;
    this.lowEQ.clear(); this.highEQ.clear(); this.update();
  }
  setParameter(address, value) {
    switch (address) {
      case 3: this.drive = value; break;
      case 4: this.ampType = value; break;
      case 5: this.ampSwitch = value; break;
      case 19: this.lowGain = value - 64; break;
      case 20: this.highGain = value - 64; break;
      case 21: this.pan = value; break;
      case 22: this.level = value / 127; break;
    }
    this.update();
  }
  update() {
    this.lowEQ.shelf(this.sampleRate, 200, this.lowGain);
    this.highEQ.shelf(this.sampleRate, 4000, this.highGain, true);
    const position = this.pan <= 64 ? this.pan / 128 : .5 + (this.pan - 64) / 126;
    this.left = Math.cos(position * Math.PI / 2); this.right = Math.sin(position * Math.PI / 2);
    this.preGain = 1 + this.drive / 127 * (this.type === 0x111 ? 60 : 24);
    // Four explicit host cabinet models; the manual defines categories, not IRs.
    this.cabinetLP = 1 - Math.exp(-2 * Math.PI * [3200,4800,6200,7200][this.ampType] / this.sampleRate);
    this.cabinetHP = Math.exp(-2 * Math.PI * [180,110,80,60][this.ampType] / this.sampleRate);
  }
  process(inputLeft,inputRight,outputLeft,outputRight,outputReverb,outputChorus,outputDelay,startIndex,sampleCount) {
    for (let i=0;i<sampleCount;i++) {
      // Both Roland block diagrams sum L+R before their mono distortion stage.
      const driven = (inputLeft[i] + inputRight[i]) * this.preGain;
      let value = this.type === 0x111 ? Math.max(-1,Math.min(1,driven)) : Math.tanh(driven);
      if (this.ampSwitch) {
        this.cabinetLow += this.cabinetLP * (value - this.cabinetLow);
        this.cabinetHigh = this.cabinetHP * (this.cabinetHigh + this.cabinetLow - this.cabinetPrevious);
        this.cabinetPrevious = this.cabinetLow; value = this.cabinetHigh;
      }
      value = this.highEQ.process(this.lowEQ.process(value)) * this.level;
      const l = value * this.left, r = value * this.right, mono = (l+r) * .5, at=startIndex+i;
      outputLeft[at] += l; outputRight[at] += r;
      outputReverb[i] += mono * this.sendLevelToReverb;
      outputChorus[i] += mono * this.sendLevelToChorus;
      outputDelay[i] += mono * this.sendLevelToDelay;
    }
  }
}
export class GSDistortion extends GSOverdrive {
  constructor(sampleRate) { super(sampleRate); this.type=0x111; this.reset(); }
}

const fail = (feature, data, reason) => SpessaLog.gsFail(feature, data, reason);
export function installGSEffects(synth) {
  const core = synth.synthCore;
  if (core.gsEffects) return core.gsEffects;
  core.registerInsertionProcessor(GSOverdrive); core.registerInsertionProcessor(GSDistortion);
  // The selected processor is authoritative, including after resets/snapshots.
  // No type bytes or DSP state are kept in opaque mutable closures.
  core.gsEffects = { receive(syx, dispatch) {
    if (syx[2] !== 0x42 || syx[3] !== 0x12 || ![0x40,0x50].includes(syx[4]) ||
        !(syx[5] === 3 || (syx[5] === 1 && syx[6] >= 0x30 && syx[6] <= 0x5a))) return false;
    if (syx.length < 10 || syx.at(-1) !== 0xf7 || syx.slice(1,-1).some(v => !Number.isInteger(v) || v<0 || v>127)) {
      fail('Effect DT1',Array.from(syx),'Malformed data. No effect parameters changed.'); return true;
    }
    if ((syx.slice(4,-1).reduce((sum,v)=>sum+v,0) & 127) !== 0) {
      fail('Effect DT1',Array.from(syx),'Invalid Roland checksum. No effect parameters changed.'); return true;
    }
    const send = (a1,a2,a3,data) => {
      const packet=[...syx.slice(0,4),a1,a2,a3,...data];
      packet.push((-packet.slice(4).reduce((sum,v)=>sum+v,0)) & 127,0xf7);
      dispatch(new Uint8Array(packet));
    };
    const base=(syx[4]<<14)|(syx[5]<<7)|syx[6], data=syx.slice(7,-2);
    if(base+data.length>0x200000) { fail('Effect DT1',Array.from(syx.slice(0,10)),'Address overflow. No effect parameters changed.'); return true; }
    for(let i=0;i<data.length;i++) {
      const address=base+i,a1=(address>>14)&127,a2=(address>>7)&127,a3=address&127,value=data[i];
      if (![0x40,0x50].includes(a1) || ![1,3].includes(a2)) {
        fail('Effect address',[a1,a2,a3],'Address outside the supported effect blocks.'); continue;
      }
      if(a2===3 && (a3===0 || a3===1)) {
        if(core.systemParameters.insertionEffectLock) continue;
        let msb=core.insertionProcessor.type>>8,lsb=core.insertionProcessor.type&127;
        // Retain an unknown selected type too: later single-byte writes must
        // not accidentally use the fallback processor's 00 00 address.
        if(core.insertionProcessor.type === 0 && core.gsEffects.selectedType !== undefined) { msb=core.gsEffects.selectedType>>8;lsb=core.gsEffects.selectedType&127; }
        if(a3===0) { msb=value; if(i+1<data.length) lsb=data[++i]; } else lsb=value;
        core.gsEffects.selectedType=(msb<<8)|lsb;
        send(a1,a2,0,[msb,lsb]);
        core.insertionProcessor.sendLevelToReverb=80/127;
        core.insertionProcessor.sendLevelToChorus=core.insertionProcessor.sendLevelToDelay=0;
        core.updateActiveEffects(); continue;
      }
      const supported=a2===1 ? common : insertion.get(core.insertionProcessor.type);
      // Composite Phaser/AutoWah has its own 20-parameter map in the pinned
      // engine; preserve it until its individual parameter audit is complete.
      if(a2===3 && core.insertionProcessor.type===0x1108 && a3>=3 && a3<=22) { send(a1,a2,a3,[value]); continue; }
      const range=a2===3 && a3>=23 && a3<=25 ? [0,127] : supported?.get(a3);
      if(!range) {
        fail(a2===1?'System Effect parameter':'EFX parameter',[a3,value],
          a2===3 && core.gsEffects.selectedType !== core.insertionProcessor.type ? 'Selected effect is unavailable; using Thru.' : 'Parameter is reserved or unused by this effect.');
        continue;
      }
      if(value<range[0] || value>range[1]) { fail('Effect parameter',[a3,value], 'Value outside the documented range '+range.join('..')+'.'); continue; }
      send(a1,a2,a3,[value]);
    }
    return true;
  } };
  const reset=core.resetInsertion.bind(core);
  core.resetInsertion=()=>{ reset(); if(!core.systemParameters.insertionEffectLock) delete core.gsEffects.selectedType; };
  return core.gsEffects;
}
