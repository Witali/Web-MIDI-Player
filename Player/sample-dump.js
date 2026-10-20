// MIDI1.0 Detailed Specification4.2.1, pp.35-39 and CA-019, pp.2-4.
// Extended counts are 35-bit; use arithmetic, never truncating bitwise reads.
// A receiver stores
// exact offset-binary words; normalization to Float32 is a playback choice.
const number=(data,at,n)=>{let value=0;for(let i=n-1;i>=0;i--)value=value*128+data[at+i];return value;};
const streamKey=(port,device)=>port+':'+device;
const sampleKey=(port,device,sample)=>port+':'+device+':'+sample;
const extendedTypes=[0,1,2,3,64,65,66,67,126,127];
const storageBytes=row=>row.wordLength*(row.channels>1?12:8);
const resourcePrefix=row=>[row.bits,row.channels,row.length].join(':')+':';
const xor=data=>data.reduce((value,byte)=>value^byte,0);
export class SampleDumpReceiver {
 constructor({maxBytes=64*1024*1024,onReply,onSample}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new RangeError('Invalid SDS memory budget.');
  this.maxBytes=maxBytes;this.onReply=onReply;this.onSample=onSample;this.sessions=new Map();this.samples=new Map();this.names=new Map();this.pendingBytes=0;
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
   const key=resourcePrefix(row)+hash,bucket=this.resources.cache.get(key)??[];
   resource=bucket.find(item=>item.words.every((word,i)=>word===row.words[i]));
   if(!resource){const words=row.words.slice(),middle=2**(row.bits-1),pcm=Float32Array.from(words,value=>(value-middle)/middle);const channelData=row.channels>1?Array.from({length:row.channels},(_,channel)=>Float32Array.from({length:row.length},(_,frame)=>pcm[frame*row.channels+channel])):null;resource={words,pcm,channelData};bucket.push(resource);this.resources.cache.set(key,bucket);this.resources.bytes+=storageBytes(row);}
  }
  this.pendingBytes-=row.reserved;row.reserved=0;row.words=resource.words;row.candidates=undefined;const pcm=resource.pcm;
  const result={port:row.port,device:row.device,sample:row.sample,bits:row.bits,period:row.period,length:row.length,wordLength:row.wordLength,channels:row.channels,sampleRate:row.sampleRate,extended:row.extended,rateInteger:row.rateInteger,rateFraction:row.rateFraction,playbackType:row.playbackType,words:row.words,pcm,channelData:resource.channelData,loops:row.loops,...this.names.get(sampleKey(row.port,row.device,row.sample))};
  row.complete=true;this.changed(result);
 }
 finish(log){for(const row of this.sessions.values())if(!row.complete&&!row.reported){row.reported=true;log.unsupported('SDS incomplete transfer',[row.sample,row.expected],`Received ${row.received} of ${row.wordLength} words.`);}}
 describe(){return [...this.samples.values()].map(({words,pcm,channelData,loops,...row})=>({...row,loops:[...loops].map(([number,loop])=>({number,...loop}))}));}
 receive(data,port,log){
  if(data[0]!==126||![1,2,3,5,123,124,125,126,127].includes(data[2]))return false;
  const fail=reason=>log.unsupported('Sample Dump Standard',data,reason),info=value=>log.gmInfo('Sample Dump Standard',value);
  if(data[0]!==126||data.length<4||data.at(-1)!==247||data.slice(0,-1).some(v=>!Number.isInteger(v)||v<0||v>127)){fail('Malformed Non-Real-Time SDS message.');return true;}
  const device=data[1],kind=data[2],id=streamKey(port,device),row=this.sessions.get(id);
  const extended=kind===5&&data[3]===5;
  if(kind===1||extended){
   if(data.length!==(extended?33:20)){fail('Dump Header length mismatch.');return true;}
   const sample=number(data,extended?4:3,2),bits=data[extended?6:5],period=extended?null:number(data,6,3),length=number(data,extended?15:9,extended?5:3),start=number(data,extended?20:12,extended?5:3),end=number(data,extended?25:15,extended?5:3),type=data[extended?30:18],channels=extended?data[31]:1;
   const rateInteger=extended?number(data,7,4):null,rateFraction=extended?number(data,11,4):null,sampleRate=extended?rateInteger+rateFraction/2**28:1e9/period;
   if(bits<8||bits>28||!channels||!(sampleRate>0)||!Number.isFinite(sampleRate)||!(extended?extendedTypes:[0,1,127]).includes(type)||(type<126&&(!length||start>end||(extended?end>=length:end>length)))){fail('Invalid sample format, rate, channels or loop points.');this.reply(device,125,0,port);return true;}
   const format={bits,channels,length,wordLength:length*channels},candidates=[];
   for(const [key,bucket]of this.resources.cache)if(key.startsWith(resourcePrefix(format)))candidates.push(...bucket);
   const reserved=candidates.length?0:storageBytes(format),reclaim=row&&!row.complete?row.reserved:0;
   if(this.usedBytes-reclaim+reserved>this.maxBytes){fail('SDS memory budget exhausted: '+format.wordLength+' words.');this.reply(device,125,0,port);return true;}
   let words=null;try{if(!candidates.length)words=new Uint32Array(format.wordLength);}catch{fail('Cannot allocate SDS sample memory.');this.reply(device,125,0,port);return true;}
   this.pendingBytes+=reserved-reclaim;const current={port,device,sample,...format,period,sampleRate,extended,rateInteger,rateFraction,playbackType:type,words,reserved,candidates:candidates.length?candidates:undefined,loops:new Map(type>=126?[]:[[0,{type,start,end,...(extended?{extended:true}:{})}]]),received:0,expected:0,complete:false};
   this.sessions.set(id,current);if(row&&!row.complete)fail('A new Dump Header replaced an incomplete transfer.');
   info('Header sample '+sample+', '+bits+'-bit, '+format.wordLength+' words, '+channels+' channel(s)');this.reply(device,127,0,port);if(!length)this.complete(current);return true;
  }
  if(kind===2){
   if(data.length!==126){fail('A Data Packet requires120 data bytes and checksum.');return true;}
   const packet=data[3];if(xor(data.slice(0,-2))!==data.at(-2)){fail('SDS checksum mismatch; packet was not committed.');this.reply(device,126,packet,port);return true;}
   if(!row){fail('Data Packet without an active Dump Header.');this.reply(device,125,packet,port);return true;}
   if(row.lastPacket&&packet===((row.expected+127)&127)&&data.every((value,i)=>value===row.lastPacket[i])){info('Duplicate packet acknowledged without adding words');this.reply(device,127,packet,port);return true;}
   if(row.complete||packet!==row.expected){fail(`Out-of-order packet ${packet}; expected ${row.expected}.`);this.reply(device,126,row.expected,port);return true;}
   const width=Math.ceil(row.bits/7),padding=width*7-row.bits,perPacket=120/width,take=Math.min(perPacket,row.wordLength-row.received),factor=2**padding;
   // Check all significant words and final zero padding before touching storage.
   const values=new Uint32Array(take);
   for(let i=0;i<perPacket;i++){let word=0;for(let byte=0;byte<width;byte++)word=word*128+data[4+i*width+byte];if((i>=take&&word!==0)||(i<take&&word%factor!==0)){fail('Nonzero unused word/padding bits.');this.reply(device,126,packet,port);return true;}if(i<take)values[i]=word/factor;}
   if(row.candidates){const matches=row.candidates.filter(item=>values.every((word,i)=>item.words[row.received+i]===word));
    if(matches.length)row.candidates=matches;
    else{if(this.usedBytes+storageBytes(row)>this.maxBytes){fail('New SDS data exceeds the sample memory budget.');this.sessions.delete(id);this.reply(device,125,packet,port);return true;}
     try{row.words=new Uint32Array(row.wordLength);}catch{fail('Cannot allocate replacement SDS sample memory.');this.sessions.delete(id);this.reply(device,125,packet,port);return true;}
     row.words.set(row.candidates[0].words.subarray(0,row.received));row.candidates=undefined;row.reserved=storageBytes(row);this.pendingBytes+=row.reserved;
    }
   }
   if(row.words)row.words.set(values,row.received);row.received+=take;row.expected=(row.expected+1)&127;row.lastPacket=data.slice();row.reported=false;
   if(row.received===row.wordLength)this.complete(row);info(`Data packet ${packet}, ${row.received}/${row.wordLength}`);this.reply(device,127,packet,port);return true;
  }
  if(kind===5){
   const sub=data[3];
   if(sub===3){
    const tagLength=data[6],nameAt=7+tagLength;
    if(data.length<9||nameAt>=data.length-1||data.length!==nameAt+data[nameAt]+2){fail('Sample Name Transmission length mismatch.');return true;}
    const sample=number(data,4,2),key=sampleKey(port,device,sample),languageTag=Array.from(data.slice(7,nameAt)),nameBytes=Array.from(data.slice(nameAt+1,-1)),name=languageTag.length?null:String.fromCharCode(...nameBytes),metadata={name,nameBytes,languageTag};
    this.names.set(key,metadata);const target=this.samples.get(key);if(target)this.changed({...target,...metadata});
    info('Sample name '+sample+' received');if(languageTag.length)fail('Language-tagged sample name retained as raw bytes; CA-019 defines only default ASCII.');return true;
   }
   if(sub!==1&&sub!==6){fail([2,4,7].includes(sub)?'SDS requests require MIDI output; excluded from file playback.':'Unknown SDS extension.');return true;}
   const wide=sub===6,width=wide?5:3;
   if(data.length!==(wide?20:16)){fail('Loop Point Transmission length mismatch.');return true;}
   const sample=number(data,4,2),loop=number(data,6,2),type=data[8],start=number(data,9,width),end=number(data,9+width,width),key=sampleKey(port,device,sample);
   const target=row&&!row.complete&&row.sample===sample?row:this.samples.get(key);
   if(!target||!(wide?extendedTypes:[0,1,127]).includes(type)||(loop!==16383&&type<126&&(start>end||(wide?end>=target.length:end>target.length)||!target.length))){fail('Unknown sample or invalid loop points/type.');return true;}
   const loops=new Map(target.loops);if(loop===16383)loops.clear();else if(type===127&&!wide)loops.delete(loop);else loops.set(loop,{type,start,end,...(wide?{extended:true}:{})});
   if(target===row)row.loops=loops;else this.changed({...target,loops});info('Loop '+loop+' for sample '+sample);return true;
  }
  if(kind===125){if(data.length!==5){fail('CANCEL handshake length mismatch.');return true;}if(row){if(!row.complete)this.pendingBytes-=row.reserved;this.sessions.delete(id);}info('Transfer cancelled; previously committed sample retained');return true;}
  if(kind===3){fail('Dump Requests require an outbound SDS transfer and MIDI output.');return true;}
  fail(kind===123?'EOF belongs to File Dump and does not complete SDS.':'No outbound SDS transfer for this handshake.');return true;
 }
}
