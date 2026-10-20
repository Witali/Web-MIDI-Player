// MIDI Tuning Updated Specification (MIDI Association), pp.1-8.
// Stored key frequencies and direct channel scale offsets are independent.
export const decodeTuning=(a,b,c)=>a===127&&b===127&&c===127?null:a+((b<<7)|c)/16384;
const key=(bank,program)=>bank*128+program;
function table(core,bank,program,create=false){
 const id=key(bank,program);let row=core.tuningPrograms.get(id);
 if(!row&&create){const values=bank===0?core.tunings.subarray(program*128,(program+1)*128):new Float64Array(128).fill(NaN);row={values,name:'',format:'key'};core.tuningPrograms.set(id,row);}
 return row;
}
export function tuningFor(core,channel,note){
 const p=channel.midiParameters;
 const value=p.tuningBank===0?core.tunings[p.tuningProgram*128+note]:table(core,p.tuningBank,p.tuningProgram)?.values[note];
 return Number.isFinite(value)?value:null;
}
export function bindVoiceTuning(core,channel,voice){voice.mtsTuning=tuningFor(core,channel,voice.midiNote);voice.mtsScale=channel.mtsScale[voice.midiNote%12];}
export function updateTuningVoices(core,channel,notes){
 for(const voice of core.activeVoices)if(voice.isActive&&voice.channel===channel.channel&&(!notes||notes.has(voice.midiNote)))voice.mtsTuning=tuningFor(core,channel,voice.midiNote);
}
export function selectTuning(core,channel,parameter,value){
 // Bank0/program0 is an initially available equal-tempered program. Other
 // addresses become available on receipt, including an all-no-change dump.
 const p=channel.midiParameters;
 const available=parameter==='tuningBank'?value===0||[...core.tuningPrograms.keys()].some(id=>(id>>7)===value):
  (p.tuningBank===0&&value===0)||!!table(core,p.tuningBank,value);
 if(!available)return false;
 channel.setMIDIParameter(parameter,value);return true;
}
const scale=(data,start,wide)=>Float64Array.from({length:12},(_,i)=>wide?(((data[start+2*i]<<7)|data[start+2*i+1])-8192)*100/8192:data[start+i]-64);
function channels(core,mask,offset){
 const result=new Set();for(let bit=0;bit<16;bit++)if(mask&(1<<bit)){
  const index=offset+bit;if(core.customChannelNumbers){for(const channel of core.midiChannels)if(channel.midiParameters.rxChannel===index)result.add(channel);}
  else if(core.midiChannels[index])result.add(core.midiChannels[index]);
 }
 return result;
}
// Log is injected to keep this decoder independent of the vendored module.
export function receiveMIDITuning(core,data,offset,log){
 const reject=reason=>log.unsupported('MIDI Tuning Standard',data,reason),done=detail=>log.gmInfo('MIDI Tuning Standard',detail);
 if(data.length<5||![126,127].includes(data[0])||data.at(-1)!==247||data.slice(0,-1).some(v=>!Number.isInteger(v)||v<0||v>127)){reject('Malformed tuning message; no tuning changed.');return;}
 const kind=data[3],realTime=data[0]===127;
 if([0,3].includes(kind)){reject('Tuning dump requests require a MIDI output; stored tuning data was not changed.');return;}
 if([1,4,5,6].includes(kind)){
  if(realTime){reject('Tuning dumps require the Non-Real-Time header.');return;}
  const banked=kind!==1,bank=banked?data[4]:0,program=data[banked?5:4],start=banked?22:21,length=[1,4].includes(kind)?384:kind===5?12:24;
  if(data.length!==start+length+2){reject('Tuning dump length does not match its defined format.');return;}
  // p.6 permits receivers to ignore the ambiguous original01 checksum.
  // All later dump formats use the specified full-message XOR checksum.
  if(kind!==1){let check=0;for(let i=0;i<data.length-2;i++)check^=data[i];if((check&127)!==data.at(-2)){reject('Tuning dump checksum mismatch.');return;}}
  const row=table(core,bank,program,true);row.name=String.fromCharCode(...data.slice(start-16,start));row.format=kind<=4?'key':kind===5?'scale-1':'scale-2';
  if(kind<=4)for(let note=0;note<128;note++){const at=start+note*3,value=decodeTuning(data[at],data[at+1],data[at+2]);if(value!==null)row.values[note]=value;}
  else{const offsets=scale(data,start,kind===6);for(let note=0;note<128;note++)row.values[note]=note+offsets[note%12]/100;}
  done(`Stored bank ${bank}, program ${program}, ${row.format}`);return;
 }
 if(kind===2||kind===7){
  if(kind===2&&!realTime){reject('Unbanked Single Note Tuning requires the Real-Time header.');return;}
  const banked=kind===7,start=banked?7:6,bank=banked?data[4]:0,program=data[banked?5:4],count=data[start-1];
  if(count===undefined||data.length!==start+4*count+1){reject('Single Note Tuning count does not match the payload length.');return;}
  if(count){const row=table(core,bank,program,true),changed=new Set();for(let i=0;i<count;i++){const at=start+i*4,note=data[at],value=decodeTuning(data[at+1],data[at+2],data[at+3]);if(value!==null){row.values[note]=value;changed.add(note);}}
   if(realTime)for(const channel of core.midiChannels)if(channel.midiParameters.tuningBank===bank&&channel.midiParameters.tuningProgram===program)updateTuningVoices(core,channel,changed);
  }
  done(`${realTime?'Real-Time':'Non-Real-Time'} bank ${bank}, program ${program}, changes ${count}`);return;
 }
 if(kind===8||kind===9){
  if(data.length!==(kind===8?20:32)||data[4]>3){reject('Invalid Scale/Octave length or reserved channel-mask bits.');return;}
  const offsets=scale(data,7,kind===9),mask=(data[4]<<14)|(data[5]<<7)|data[6];
  for(const channel of channels(core,mask,offset)){channel.mtsScale.set(offsets);if(realTime)for(const voice of core.activeVoices)if(voice.isActive&&voice.channel===channel.channel)voice.mtsScale=offsets[voice.midiNote%12];}
  done(`${realTime?'Real-Time':'Non-Real-Time'} Scale/Octave mask ${mask}`);return;
 }
 reject('Unknown tuning sub-ID; no tuning changed.');
}
export function tuningSnapshot(core){return {legacy:core.tunings.slice(),programs:[...core.tuningPrograms].map(([id,row])=>[id,{...row,values:row.values.slice()}])};}
export function applyTuningSnapshot(core,snapshot){
 core.tunings.set(snapshot.legacy);core.tuningPrograms.clear();for(const [id,row]of snapshot.programs){const bank=id>>7,program=id&127;core.tuningPrograms.set(id,{...row,values:bank===0?core.tunings.subarray(program*128,(program+1)*128):Float64Array.from(row.values)});}
}
