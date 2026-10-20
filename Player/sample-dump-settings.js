export const patchKey=p=>[p.bankMSB,p.bankLSB,p.program,Number(p.percussion??p.isGMGSDrum??false)].join(':');
export function normalizeSampleDumpMappings(rows=[]){
 if(!Array.isArray(rows))throw new TypeError('sampleDumpMappings must be an array.');const destinations=new Set();
 return rows.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['sample','sourcePort','deviceID','rootKey','program','bankMSB','bankLSB','percussion','loop','loopEnd','name','release'].includes(k)))throw new TypeError('Invalid SDS mapping.');
  const result={sample:row.sample,sourcePort:row.sourcePort??0,deviceID:row.deviceID??null,rootKey:row.rootKey,program:row.program,bankMSB:row.bankMSB??0,bankLSB:row.bankLSB??0,percussion:row.percussion??false,loop:row.loop===undefined?0:row.loop,loopEnd:row.loopEnd??'inclusive',name:row.name??`SDS sample ${row.sample}`,release:row.release??.1};
  const integer=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max;
  if(!integer(result.sample,16383)||!['sourcePort','rootKey','program','bankMSB','bankLSB'].every(k=>integer(result[k],127))||(result.deviceID!==null&&!integer(result.deviceID,127))||(result.loop!==null&&!integer(result.loop,16382))||typeof result.percussion!=='boolean'||!['inclusive','exclusive'].includes(result.loopEnd)||typeof result.name!=='string'||!result.name.length||result.name.length>80||!Number.isFinite(result.release)||result.release<=0||result.release>60)throw new RangeError('Invalid SDS mapping value.');
  const key=patchKey(result);if(destinations.has(key))throw new TypeError('SDS destination instrument is assigned more than once.');destinations.add(key);return Object.freeze(result);
 });
}
