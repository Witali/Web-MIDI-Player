import { xgEffectRange } from './xg-effect-types.js';
// MU100 pp.11-16 Control dots: Drive for distortion, Dry/Wet for all other
// implemented families. Depth data64 is zero, not a source/controller number.
export function applyXGEffectControl(effect,channel){
  const processor=effect.processor;if(!processor)return;
  const parameter=processor.family==='drive'?1:10,range=xgEffectRange(processor,parameter);if(!range)return;
  const raw=effect.raw,start=effect.controlAddress??0x5c,cc=channel?.midiControllers;
  const normalized=raw=>Math.max(0,Math.min(1,raw/16256));
  let amount=0;
  if(channel){
    const pitch=channel.midiParameters.pitchWheel,pressure=channel.midiParameters.pressure;
    const values=[normalized(cc[1]),pitch<=8192?(pitch-8192)/8192:(pitch-8192)/8191,pressure/127,
      normalized(cc[channel.xgAC1??16]),normalized(cc[channel.xgAC2??17])];
    for(let i=0;i<5;i++){const depth=raw[start+i]-64;amount+=values[i]*(depth<0?depth/64:depth/63);}
  }
  // The device's interpolation law is unpublished. Use additive normalized
  // depth in parameter-data space and clamp to the documented legal range.
  const value=Math.max(range[0],Math.min(range[1],Math.round(effect.parameters[parameter-1]+amount*(range[1]-range[0]))));
  if(processor.parameters[parameter-1]!==value)processor.setParameter(parameter,value);
  if(effect.bypassProcessor&&effect.bypassProcessor.parameters[parameter-1]!==value)effect.bypassProcessor.setParameter(parameter,value);
}
export function restoreXGEffectBase(effect){
  if(!effect.processor)return;const p=effect.processor.family==='drive'?1:10;
  if(effect.processor.parameters[p-1]!==effect.parameters[p-1])effect.processor.setParameter(p,effect.parameters[p-1]);
}
