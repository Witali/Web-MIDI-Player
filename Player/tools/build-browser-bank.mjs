// Keep SF2 mapping/loops intact; encode original native-rate PCM for the browser.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {SoundBankLoader,BasicSoundBank,SpessaLog} from '../vendor/spessasynth.js';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const FONT_SHA=JSON.parse(fs.readFileSync(join(ROOT,'PROVENANCE.json'))).soundfont.sha256;
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function buildBrowserBank({ffmpeg='ffmpeg'}={}){
  SpessaLog.setLogLevel(false,false,false);
  const source=fs.readFileSync(join(ROOT,'soundfonts/FluidR3_GM.sf2'));
  if(hash(source)!==FONT_SHA)throw Error('Unexpected source SoundFont');
  const bank=SoundBankLoader.fromArrayBuffer(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength));
  await BasicSoundBank.isSF3DecoderReady;
  const output=join(ROOT,'soundfonts/fluidr3-gm');
  fs.mkdirSync(join(output,'samples'),{recursive:true});
  const license=fs.readFileSync(join(ROOT,'licenses/FluidR3-MIT.txt'));
  fs.writeFileSync(join(output,'LICENSE.txt'),license);
  const version=spawnSync(ffmpeg,['-version'],{encoding:'utf8',windowsHide:true});
  if(version.status!==0)throw Error(version.error?.message||'FFmpeg with libvorbis is required');
  const manifest={schema:1,id:'fluidr3-browser',source_sha256:FONT_SHA,license:'MIT',license_sha256:hash(license),codec:'Ogg Vorbis',settings:{bitrate_bps:128000,low_rate_quality:8,pcm_below_bytes:4096,resampling:'none; original native sample rate'},encoder:version.stdout.split(/\r?\n/)[0],generator_sha256_lf:hash(fs.readFileSync(new URL(import.meta.url),'utf8').replaceAll('\r\n','\n')),samples:[]};
  const encoded=new Map();
  const previous=new Map();
  try{
    const saved=JSON.parse(fs.readFileSync(join(output,'manifest.json')));
    if(saved.source_sha256===FONT_SHA&&JSON.stringify(saved.settings)===JSON.stringify(manifest.settings))
      for(const row of saved.samples)previous.set(`${row.sample_rate_hz}:${row.source_pcm_sha256}`,row);
  }catch{}
  let totalSource=0;
  for(const [index,sample] of bank.samples.entries()){
    const pcm=Buffer.from(sample.getRawData(false)),sourceHash=hash(pcm),key=`${sample.sampleRate}:${sourceHash}`;
    let record=encoded.get(key);
    if(!record){
      const compressed=pcm.length>=4096&&sample.sampleRate>=8000&&sample.sampleRate<=96000;
      let bytes=pcm;
      const cached=previous.get(key);
      if(cached&&fs.existsSync(join(output,cached.file))&&hash(fs.readFileSync(join(output,cached.file)))===cached.sha256)bytes=fs.readFileSync(join(output,cached.file));
      else if(compressed){
        const rate=sample.sampleRate>=32000?['-b:a','128k']:['-q:a','8'];
        const args=['-hide_banner','-loglevel','error','-fflags','+bitexact','-f','s16le','-ar',String(sample.sampleRate),'-ac','1','-i','pipe:0','-map_metadata','-1','-c:a','libvorbis',...rate,'-flags:a','+bitexact','-f','ogg','pipe:1'];
        const result=spawnSync(ffmpeg,args,{input:pcm,maxBuffer:32*1024*1024,windowsHide:true});
        if(result.status!==0)throw Error(`${sample.name}: ${result.error?.message||result.stderr?.toString()}`);
        bytes=result.stdout;
      }
      const format=compressed?'vorbis':'pcm16',digest=hash(bytes),file=`samples/${digest}.${compressed?'ogg':'pcm'}`;
      fs.writeFileSync(join(output,file),bytes);
      const original=sample.getAudioData();
      if(compressed)sample.setCompressedData(new Uint8Array(bytes));
      const decoded=sample.getAudioData();
      if(decoded.length<original.length||decoded.some(v=>!Number.isFinite(v)))throw Error(`${sample.name}: decoded sample is truncated/invalid (${original.length} -> ${decoded.length})`);
      let signal=0,error=0;
      for(let i=0;i<original.length;i++){signal+=original[i]**2;error+=(original[i]-decoded[i])**2;}
      record={file,format,sha256:digest,bytes:bytes.length,frames:original.length,decoded_frames:decoded.length,sample_rate_hz:sample.sampleRate,source_pcm_sha256:sourceHash,snr_db:error?Number((10*Math.log10(signal/error)).toFixed(3)):null};
      encoded.set(key,record);totalSource+=pcm.length;
    }
    manifest.samples.push({index,name:sample.name,...record});
    if((index+1)%100===0)console.log(`Browser samples: ${index+1}/${bank.samples.length}`);
  }
  // Empty payloads retain the complete original preset/zone/link/loop metadata.
  // The browser fills selected samples before handing the bank to the synth.
  for(const sample of bank.samples)sample.setCompressedData(new Uint8Array(0));
  bank.soundBankInfo.version={major:3,minor:0};
  const metadata=Buffer.from(bank.writeSF2());
  fs.writeFileSync(join(output,'bank.sf3'),metadata);
  manifest.metadata={file:'bank.sf3',bytes:metadata.length,sha256:hash(metadata)};
  manifest.total={presets:bank.presets.length,samples:bank.samples.length,unique_files:encoded.size,source_pcm_bytes:totalSource,encoded_bytes:[...encoded.values()].reduce((n,r)=>n+r.bytes,0)};
  const retained=new Set(manifest.samples.map(row=>row.file));
  for(const name of fs.readdirSync(join(output,'samples'))){
    const file=`samples/${name}`;
    if(!retained.has(file)&&/^[a-f0-9]{64}\.(ogg|pcm)$/.test(name)&&hash(fs.readFileSync(join(output,file)))===name.split('.')[0])fs.unlinkSync(join(output,file));
  }
  fs.writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify(manifest.total));
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const at=process.argv.indexOf('--ffmpeg');
  await buildBrowserBank({ffmpeg:at<0?'ffmpeg':process.argv[at+1]});
}
