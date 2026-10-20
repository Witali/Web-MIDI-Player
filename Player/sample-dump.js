// MIDI1.0 Detailed Specification4.2.1, printed pp.35-39. A receiver stores
// exact offset-binary words; normalization to Float32 is a playback choice.
const number=(data,at,n)=>{let value=0;for(let i=n-1;i>=0;i--)value=value*128+data[at+i];return value;};
const streamKey=(port,device)=>port+':'+device;
const sampleKey=(port,device,sample)=>port+':'+device+':'+sample;
const xor=data=>data.reduce((value,byte)=>value^byte,0);
export class SampleDumpReceiver {
 constructor({maxBytes=64*1024*1024,onReply,onSample}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new RangeError('Invalid SDS memory budget.');
  this.maxBytes=maxBytes;this.onReply=onReply;this.onSample=onSample;this.sessions=new Map();this.samples=new Map();this.pendingBytes=0;
  this.resources={cache:new Map(),bytes:0};
 }
 get usedBytes(){return this.resources.bytes+this.pendingBytes;}
 reserve(bytes){if(this.usedBytes+bytes>this.maxBytes)return false;this.resources.bytes+=bytes;return true;}
 resetTransfers(){for(const row of this.sessions.values())if(!row.complete)this.pendingBytes-=row.reserved;this.sessions.clear();}
 reply(device,kind,packet,port){this.onReply?.(new Uint8Array([240,126,device,kind,packet,247]),port);}
 changed(row){this.samples.set(sampleKey(row.port,row.device,row.sample),row);this.onSample?.(row);}
 complete(row){
  // Completed data is immutable and shared across repeated playback/seek.
  // Verify words after hashing, so a collision cannot substitute a waveform.
  let resource=row.candidates?.[0];
  if(!resource){let hash=2166136261;for(const word of row.words)hash=Math.imul(hash^word,16777619)>>>0;
   const key=[row.bits,row.period,row.length,hash].join(':'),bucket=this.resources.cache.get(key)??[];
   resource=bucket.find(item=>item.words.every((word,i)=>word===row.words[i]));
   if(!resource){const words=row.words.slice(),middle=2**(row.bits-1),pcm=Float32Array.from(words,value=>(value-middle)/middle);resource={words,pcm};bucket.push(resource);this.resources.cache.set(key,bucket);this.resources.bytes+=row.length*8;}
  }
  this.pendingBytes-=row.reserved;row.reserved=0;row.words=resource.words;row.candidates=undefined;const pcm=resource.pcm;
  const result={port:row.port,device:row.device,sample:row.sample,bits:row.bits,period:row.period,length:row.length,sampleRate:1e9/row.period,words:row.words,pcm,loops:row.loops};
  row.complete=true;this.changed(result);
 }
 finish(log){for(const row of this.sessions.values())if(!row.complete&&!row.reported){row.reported=true;log.unsupported('SDS incomplete transfer',[row.sample,row.expected],`Received ${row.received} of ${row.length} words.`);}}
 describe(){return [...this.samples.values()].map(({words,pcm,loops,...row})=>({...row,loops:[...loops].map(([number,loop])=>({number,...loop}))}));}
 receive(data,port,log){
  if(data[0]!==126||![1,2,3,5,123,124,125,126,127].includes(data[2]))return false;
  const fail=reason=>log.unsupported('Sample Dump Standard',data,reason),info=value=>log.gmInfo('Sample Dump Standard',value);
  if(data[0]!==126||data.length<4||data.at(-1)!==247||data.slice(0,-1).some(v=>!Number.isInteger(v)||v<0||v>127)){fail('Malformed Non-Real-Time SDS message.');return true;}
  const device=data[1],kind=data[2],id=streamKey(port,device),row=this.sessions.get(id);
  if(kind===1){
   if(data.length!==20){fail('Dump Header must contain exactly20 bytes excluding F0.');return true;}
   const sample=number(data,3,2),bits=data[5],period=number(data,6,3),length=number(data,9,3),start=number(data,12,3),end=number(data,15,3),type=data[18];
   if(bits<8||bits>28||!period||![0,1,127].includes(type)||(type!==127&&(!length||start>end||end>length))){fail('Invalid sample format, period or loop points.');this.reply(device,125,0,port);return true;}
   // Known resource candidates can be verified packet by packet without a
   // writable full-size copy, including when a later seek finds a full cache.
   const candidates=[];for(const [key,bucket]of this.resources.cache)if(key.startsWith([bits,period,length].join(':')+':'))candidates.push(...bucket);
   const reserved=candidates.length?0:length*8,reclaim=row&&!row.complete?row.reserved:0;
   if(this.usedBytes-reclaim+reserved>this.maxBytes){fail('SDS memory budget exhausted.');this.reply(device,125,0,port);return true;}
   let words=null;try{if(!candidates.length)words=new Uint32Array(length);}catch{fail('Cannot allocate SDS sample memory.');this.reply(device,125,0,port);return true;}
   this.pendingBytes+=reserved-reclaim;const current={port,device,sample,bits,period,length,words,reserved,candidates:candidates.length?candidates:undefined,loops:new Map(type===127?[]:[[0,{type,start,end}]]),received:0,expected:0,complete:false};
   this.sessions.set(id,current);if(row&&!row.complete)fail('A new Dump Header replaced an incomplete transfer.');
   info(`Header sample ${sample}, ${bits}-bit, ${length} words`);this.reply(device,127,0,port);if(!length)this.complete(current);return true;
  }
  if(kind===2){
   if(data.length!==126){fail('A Data Packet requires120 data bytes and checksum.');return true;}
   const packet=data[3];if(xor(data.slice(0,-2))!==data.at(-2)){fail('SDS checksum mismatch; packet was not committed.');this.reply(device,126,packet,port);return true;}
   if(!row){fail('Data Packet without an active Dump Header.');this.reply(device,125,packet,port);return true;}
   if(row.lastPacket&&packet===((row.expected+127)&127)&&data.every((value,i)=>value===row.lastPacket[i])){info('Duplicate packet acknowledged without adding words');this.reply(device,127,packet,port);return true;}
   if(row.complete||packet!==row.expected){fail(`Out-of-order packet ${packet}; expected ${row.expected}.`);this.reply(device,126,row.expected,port);return true;}
   const width=Math.ceil(row.bits/7),padding=width*7-row.bits,perPacket=120/width,take=Math.min(perPacket,row.length-row.received),factor=2**padding;
   // Check all significant words and final zero padding before touching storage.
   const values=new Uint32Array(take);
   for(let i=0;i<perPacket;i++){let word=0;for(let byte=0;byte<width;byte++)word=word*128+data[4+i*width+byte];if((i>=take&&word!==0)||(i<take&&word%factor!==0)){fail('Nonzero unused word/padding bits.');this.reply(device,126,packet,port);return true;}if(i<take)values[i]=word/factor;}
   if(row.candidates){const matches=row.candidates.filter(item=>values.every((word,i)=>item.words[row.received+i]===word));
    if(matches.length)row.candidates=matches;
    else{if(this.usedBytes+row.length*8>this.maxBytes){fail('New SDS data exceeds the sample memory budget.');this.sessions.delete(id);this.reply(device,125,packet,port);return true;}
     try{row.words=new Uint32Array(row.length);}catch{fail('Cannot allocate replacement SDS sample memory.');this.sessions.delete(id);this.reply(device,125,packet,port);return true;}
     row.words.set(row.candidates[0].words.subarray(0,row.received));row.candidates=undefined;row.reserved=row.length*8;this.pendingBytes+=row.reserved;
    }
   }
   if(row.words)row.words.set(values,row.received);row.received+=take;row.expected=(row.expected+1)&127;row.lastPacket=data.slice();row.reported=false;
   if(row.received===row.length)this.complete(row);info(`Data packet ${packet}, ${row.received}/${row.length}`);this.reply(device,127,packet,port);return true;
  }
  if(kind===5){
   if(data[3]!==1){fail(data[3]===2?'Loop Point Requests require MIDI output.':'This SDS extension needs its own decoder.');return true;}
   if(data.length!==16){fail('Loop Point Transmission length mismatch.');return true;}
   const sample=number(data,4,2),loop=number(data,6,2),type=data[8],start=number(data,9,3),end=number(data,12,3),key=sampleKey(port,device,sample);
   const target=row&&!row.complete&&row.sample===sample?row:this.samples.get(key);
   if(!target||![0,1,127].includes(type)||(loop!==16383&&type!==127&&(start>end||end>target.length||!target.length))){fail('Unknown sample or invalid loop points/type.');return true;}
   const loops=new Map(target.loops);if(loop===16383)loops.clear();else if(type===127)loops.delete(loop);else loops.set(loop,{type,start,end});
   if(target===row)row.loops=loops;else this.changed({...target,loops});info(`Loop ${loop} for sample ${sample}`);return true;
  }
  if(kind===125){if(data.length!==5){fail('CANCEL handshake length mismatch.');return true;}if(row){if(!row.complete)this.pendingBytes-=row.reserved;this.sessions.delete(id);}info('Transfer cancelled; previously committed sample retained');return true;}
  if(kind===3){fail('Dump Requests require an outbound SDS transfer and MIDI output.');return true;}
  fail(kind===123?'EOF belongs to File Dump and does not complete SDS.':'No outbound SDS transfer for this handshake.');return true;
 }
}
