import { XGDrive,driveRange } from './xg-drive.js';
import { XGDelay,delayParameterRange } from './xg-delay.js';
import { XGReverb,reverbRange } from './xg-reverb.js';
import { XGChorus,chorusRange } from './xg-chorus.js';
// Exact MSB/LSB membership from MU100 pp.5-10. A family match alone must
// never make an unknown variation appear implemented.
export function createXGEffect(sampleRate,msb,lsb,block='variation'){
  let processor,family;
  if(msb>=5&&msb<=8&&lsb===0){processor=new XGDelay(sampleRate,msb);family='delay';}
  else if(msb>=1&&msb<=4&&lsb<=[1,2,1,0][msb-1]){processor=new XGReverb(sampleRate,msb,lsb,block);family='reverb';}
  else if([0x41,0x42,0x43].includes(msb)&&(msb===0x43?[0,1,8]:[0,1,2,8]).includes(lsb)){processor=new XGChorus(sampleRate,msb,lsb,block);family='chorus';}
  if(!processor&&[0x49,0x4a].includes(msb)&&lsb===0){processor=new XGDrive(sampleRate,msb,block);family='drive';}
  if(processor){processor.family=family;processor.block=block;if(block==='insertion')for(let p=1;p<=16;p++){const range=xgEffectRange(processor,p);if(range&&(processor.parameters[p-1]<range[0]||processor.parameters[p-1]>range[1]))processor.setParameter(p,Math.max(range[0],Math.min(range[1],processor.parameters[p-1])));}}return processor;
}
export function xgEffectRange(processor,parameter){
  if(processor.family==='delay'){const range=delayParameterRange(processor.type,parameter);if(range&&processor.block==='insertion'&&range[1]>127)return [range[0],processor.type<=6?7429:3714];return range;}
  if(processor.family==='reverb')return parameter===10?[1,127]:parameter===12&&processor.block==='insertion'?[0,2]:reverbRange(parameter);
  if(processor.family==='chorus')return chorusRange(processor.type,parameter);
  if(processor.family==='drive')return driveRange(parameter);
}
