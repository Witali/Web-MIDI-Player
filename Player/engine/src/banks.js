// Transport only: expand losslessly packed pages in the compilation Worker.
// Spectral processing happens offline; note envelopes and ROM linking live in C.
export const decode64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export function prepareBank(data){return new Map(data.instruments.map(s=>[s.id,{...s,bytes:decode64(s.tables)}]));}
export function prepareQualityBank(base,data){
  if(data.schema!==1||!['natural','detailed','extra512','extra1024'].includes(data.tier)||!['pdm','r2r'].includes(data.mode)||data.instruments.length!==base.size)throw new Error('Некорректный банк качества.');
  const extra=data.tier.startsWith('extra'),result=new Map(),frames=data.tier==='natural'?1:10;
  if(extra&&data.max_points!==Number(data.tier.slice(5)))throw new Error('Некорректное разрешение сэмплов.');
  for(const row of data.instruments){
    const sample=base.get(row.id),pages=decode64(row.pages);
    const notes=sample?sample.last_note-sample.first_note+1:0;
    if(extra&&(!Array.isArray(row.grain_points)||row.grain_points.length!==notes||row.grain_points.some(n=>n!==256&&n!==data.max_points)))throw new Error('Некорректные размеры сэмплов.');
    if(!sample||result.has(row.id)||row.frames!==frames||pages.length%256||row.indices.length!==(extra?row.grain_points.reduce((sum,n)=>sum+n/256,0):notes)*frames)throw new Error('Некорректные страницы сэмплов.');
    const rich=new Uint8Array(row.indices.length*256);
    row.indices.forEach((page,i)=>{if(!Number.isInteger(page)||page<0||(page+1)*256>pages.length)throw new Error('Индекс сэмпла за пределами банка.');rich.set(pages.subarray(page*256,(page+1)*256),i*256);});
    result.set(row.id,{...sample,rich,family:row.family,frames,envelope:row.envelope,...(extra?{grainPoints:row.grain_points}:{} )});
  }
  result.quality={tier:data.tier,mode:data.mode,player:data.player,sources:data.sources_sha256_lf};return result;
}
// Expand PCM16 bytes in the Worker; note timing, resampling and ROM page
// construction belong to C. Melodic banks and their existing hashes stay intact.
export function prepareDrumBank(base,data){
  if(data.schema!==1||data.pcm_rate_hz!==12000||!['pdm','r2r'].includes(data.mode)||data.instruments.length!==47)throw new Error('Некорректный банк ударных.');
  const result=new Map(base);if(base.quality)result.quality=base.quality;
  for(const row of data.instruments){
    const pcm=decode64(row.pcm);
    if(!/^drum-(?:[3-7][0-9]|8[01])$/.test(row.id)||row.key<35||row.key>81||row.id!==`drum-${row.key}`||result.has(row.id)||!pcm.length||pcm.length%2||pcm.length>28800)throw new Error('Некорректный PCM-сэмпл ударных.');
    const bytes=Uint8Array.from({length:256},(_,i)=>{const j=Math.min(i,pcm.length/2-1),word=pcm[j*2]|pcm[j*2+1]<<8;return 64+Math.round((word>=32768?word-65536:word)/32768*62);});
    const frames=base.quality&&base.quality.tier!=='natural'?10:1,rich=new Uint8Array(frames*256);for(let i=0;i<frames;i++)rich.set(bytes,i*256);
    result.set(row.id,{...row,pcm,bytes,rich,first_note:69,last_note:69,cycles:1,frames,family:4,envelope:'recorded-one-shot',...(base.quality?.tier.startsWith('extra')?{grainPoints:[256]}:{})});
  }
  result.drums={mode:data.mode,rate:data.pcm_rate_hz,sources:data.sources_sha256_lf};return result;
}
