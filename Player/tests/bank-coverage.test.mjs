import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { BrowserSoundBank } from '../lazy-bank.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { FLUID_MAPPINGS, FLUID_PROFILE, fluidProfile, installBankMappings } from '../fluid-bank-mappings.js';
import { BasicSoundBank, SoundBankLoader, SpessaSynthProcessor } from '../vendor/spessasynth.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
const root = new URL('../soundfonts/fluidr3-gm/',import.meta.url), manifest = JSON.parse(fs.readFileSync(new URL('manifest.json',root)));
const load = () => new BrowserSoundBank(undefined,{fetcher:async url=>new Response(fs.readFileSync(fileURLToPath(url)))});
const end=[0,255,47,0], sx=data=>[0,0xf0,...vlq(data.length),...data];
const mode=system=>system==='xg'?sx([0x43,0x10,0x4c,0,0,0x7e,0,0xf7]):system==='gm2'?sx([0x7e,0x7f,9,3,0xf7]):sx([0x41,0x10,0x42,0x12,0x40,0,0x7f,0,0x41,0xf7]);
const address=p=>[p.bankMSB,p.bankLSB,p.program,!!p.isGMGSDrum].join(':');
const select=p=>[[0,0xb0,0,p.bankMSB],[0,0xb0,32,p.bankLSB],[0,0xc0,p.program]];
const song=(system,p)=>midi([mode(system),...select(p),[0,0x90,60,100],[...vlq(480),0x80,60,64],end]);
async function preview(bytes,dsp='js') { const prepared=await load().load(bytes); return createSoundFontPreview(bytes,prepared.bank,{prepared,effects:false,dsp}); }

test('GS source profile and all original GM recordings are authenticated, with real preset/mapping tables',()=>{
  assert.equal(fluidProfile(manifest),FLUID_PROFILE);assert.throws(()=>fluidProfile({...manifest,profile:'other'}));
  assert.throws(()=>fluidProfile({...manifest,supplements:[]}));
  // Merge reindexes samples; identities, source frames and encoded bytes must stay exact.
  const original=manifest.samples.slice(0,1418).map(({file,frames,sample_rate_hz,source_pcm_sha256})=>({file,frames,sample_rate_hz,source_pcm_sha256})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'),'3892430027603fe1481af16bc64fdd00ebb72aa7a9801677a2f71c2c1597493f','every original encoded GM recording and frame map is unchanged');
  const metadata=fs.readFileSync(new URL('bank.sf3',root)),bank=SoundBankLoader.fromArrayBuffer(metadata.buffer.slice(metadata.byteOffset,metadata.byteOffset+metadata.byteLength));
  assert.equal(bank.presets.length,222);assert.equal(bank.samples.length,1466);
  const table=JSON.parse(fs.readFileSync(new URL('mappings.json',root)));assert.equal(table.mappings.length,FLUID_MAPPINGS.length);
  assert.deepEqual(table.mappings.map(({source:{name,...source},...row})=>({...row,source})),FLUID_MAPPINGS);
  for(const row of table.mappings)assert.ok(bank.presets.some(p=>address(p)===address(row.source)),JSON.stringify(row));
  assert.equal(fs.readFileSync(new URL('presets.csv',root),'utf8').trim().split('\n').length,223);
});

test('all 33 added GS presets load their actual samples and produce finite audible stereo on each DSP',async()=>{
  const inventory=JSON.parse(fs.readFileSync(new URL('../soundfonts/inventory.json',import.meta.url))),added=inventory.presets.slice(189);
  assert.equal(added.length,33);
  for(const item of added){
    const channel=item.drum?9:0,bytes=midi([mode('gs'),[0,0xb0|channel,0,item.bankMSB],[0,0xc0|channel,item.program-1],[0,0x90|channel,60,100],[...vlq(960),0x80|channel,60,64],end]);
    const prepared=await load().load(bytes);assert.ok(prepared.sampleBank.samples>0&&prepared.sampleBank.samples<50);
    const actual=prepared.diagnostics.parts[0].sourceInstruments[0];assert.equal(actual.name,item.name);
    assert.equal(prepared.diagnostics.summary.substituted,0);
    for(const dsp of ['js','wasm','wasm-simd']){
      const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,effects:false,dsp});
      try {const pcm=p.read(72000);assert.ok(pcm.every(c=>c.every(Number.isFinite)));assert.ok(pcm.some(c=>c.some(v=>Math.abs(v)>1e-5)),item.name+' '+dsp);}
      finally{p.close();}
    }
  }
});

test('every explicit GM2/XG mapping selects the documented actual preset and reports the substitution',async()=>{
  for(const system of ['gm2','xg']){
    const rows=FLUID_MAPPINGS.filter(r=>r.system===system),events=[mode(system)];
    for(const row of rows)events.push(...select(row.requested),[0,0x90,60,100],[1,0x80,60,64]);events.push(end);
    const prepared=await load().load(midi(events));assert.equal(prepared.diagnostics.complete,true);assert.equal(prepared.diagnostics.omitted,0);
    const notices=prepared.diagnostics.entries.filter(e=>e.mapping===FLUID_PROFILE);
    for(const row of rows){const notice=notices.find(e=>address(e.requested)===address(row.requested));assert.ok(notice,system+' '+address(row.requested));assert.equal(address(notice.actual),address(row.source));}
  }
});

test('mapped XG/GM2 audio equals independent GS MIDI addresses on JS/WASM/SIMD, including exact seeking',async()=>{
  const cases=[['xg',{bankMSB:64,bankLSB:0,program:32},{bankMSB:1,bankLSB:0,program:122}],
    ['xg',{bankMSB:0,bankLSB:96,program:25},{bankMSB:16,bankLSB:0,program:25}],
    ['gm2',{bankMSB:121,bankLSB:2,program:122},{bankMSB:2,bankLSB:0,program:122}],
    ['gm2',{bankMSB:121,bankLSB:2,program:80},{bankMSB:8,bankLSB:0,program:80}]];
  for(const[system,request,source]of cases)for(const dsp of ['js','wasm','wasm-simd']){
    const a=await preview(song(system,request),dsp),b=await preview(song('gs',source),dsp);
    try{const pcm=b.read(36000);assert.deepEqual(a.read(36000),pcm);await a.seek(.137);const at=Math.round(.137*48000);assert.deepEqual(a.read(512),pcm.map(c=>c.slice(at,at+512)));}
    finally{a.close();b.close();}
  }
});

test('bank selects wait for Program Change, ports remain separate, and absent/native addresses retain honest diagnostics',async()=>{
  const bytes=midiTracks([
    [mode('gm2'),...select({bankMSB:121,bankLSB:1,program:122}),[0,0x90,60,100],[120,0x80,60,64],
      [0,0xb0,32,2],[0,0x90,60,100],[120,0x80,60,64],[0,0xc0,122],[0,0x90,60,100],[120,0x80,60,64],end],
    [[0,255,33,1,7],...select({bankMSB:121,bankLSB:5,program:125}),[0,0x90,60,100],[...vlq(360),0x80,60,64],end]
  ]);
  const prepared=await load().load(bytes),parts=prepared.diagnostics.parts;
  assert.deepEqual(parts.find(p=>p.port===0).sourceInstruments.map(p=>p.name),['Rain','Thunder']);
  assert.equal(parts.find(p=>p.port===7).sourceInstruments[0].name,'Siren');
  const p=await createSoundFontPreview(bytes,prepared.bank,{prepared,effects:true,dsp:'wasm'});
  try{const pcm=p.read(30000);await p.seek(.13);assert.deepEqual(p.read(512),pcm.map(c=>c.slice(6240,6752)));}finally{p.close();}
  const missing=await load().load(song('xg',{bankMSB:64,bankLSB:0,program:54}));
  assert.ok(missing.diagnostics.entries.some(e=>e.code==='preset-substitution'&&!e.mapping&&e.requested.program===54));
  const native=await load().load(song('gs',{bankMSB:1,bankLSB:0,program:122}));assert.equal(native.diagnostics.summary.substituted,0);
});

test('a real native patch takes precedence over host mapping and mappings never apply to an unprofiled bank',async()=>{
  const bytes=fs.readFileSync(new URL('bank.sf3',root)),bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const synth=new SpessaSynthProcessor(48000,{effectsEnabled:false,eventsEnabled:false});synth.soundBankManager.addSoundBank(bank,'main');await synth.processorInitialized;
  const original=synth.soundBankManager.getPreset;installBankMappings(synth,bank);assert.equal(synth.soundBankManager.getPreset,original);
  bank.hostProfile=FLUID_PROFILE;installBankMappings(synth,bank);
  const manager=synth.soundBankManager,target=manager.selectablePresetList.find(p=>p.bankMSB===1&&p.program===122);
  const native={...target,bankMSB:64,bankLSB:0,program:32,name:'Native XG fixture',isGMGSDrum:false};manager.selectablePresetList.unshift(native);
  assert.equal(manager.getPreset({bankMSB:64,bankLSB:0,program:32,isGMGSDrum:false},'xg'),native);synth.stopAllChannels(true);
});

test('real Worker reports mapped source presets and streams selectively prepared GS audio through configuration',async()=>{
  const worker=new Worker(new URL('./worker-fixture.mjs',import.meta.url)),channel=new MessageChannel();let id=0;
  const call=async(type,values)=>{const reply=once(worker,'message');worker.postMessage({type,id:++id,...values});const data=(await reply)[0];assert.equal(data.error,undefined);return data.result;};
  try{
    const metadata=await call('load',{bytes:song('xg',{bankMSB:64,bankLSB:0,program:32}),epoch:1,effects:false});assert.equal(metadata.parts[0].sourceInstruments[0].name,'Rain');assert.ok(metadata.sampleBank.samples<10);
    const result=await call('playback',{settings:{rate:2,loop:{start:.1,end:.3}},seconds:.1,epoch:2});assert.equal(result.metadata.parts[0].sourceInstruments[0].name,'Rain');assert.equal(result.metadata.sampleBank.downloadedBytes,0);
    worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);const reply=once(channel.port1,'message');channel.port1.postMessage({type:'read',epoch:2});const block=(await reply)[0];assert.equal(block.done,false);assert.ok(block.channels.some(c=>c.some(v=>Math.abs(v)>1e-5)));
  }finally{channel.port1.close();await worker.terminate();}
});


test('every GM program retains exact PCM against the original independent SF2 metadata and the unchanged encoded recordings',async()=>{
  const data=fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2',import.meta.url)),reference=SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
  const byPCM=new Map(manifest.samples.map(row=>[row.sample_rate_hz+':'+row.source_pcm_sha256,row]));
  for(const sample of reference.samples){
    const raw=sample.getRawData(false),digest=createHash('sha256').update(raw).digest('hex'),row=byPCM.get(sample.sampleRate+':'+digest);assert.ok(row,sample.name);
    const bytes=fs.readFileSync(new URL(row.file,root));let pcm;
    if(row.format==='vorbis'){sample.setCompressedData(new Uint8Array(bytes));pcm=sample.getAudioData();}
    else{const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);pcm=Float32Array.from({length:row.frames},(_,i)=>view.getInt16(i*2,true)/32768);}
    sample.setAudioData(pcm.subarray(0,row.frames),row.sample_rate_hz);
  }
  const events=[mode('gs')];for(let p=0;p<128;p++)events.push([0,0xc0,p],[0,0x90,60,100],[32,0x80,60,64]);events.push(end);const bytes=midi(events),prepared=await load().load(bytes);
  for(const dsp of ['js','wasm','wasm-simd']){
    const actual=await createSoundFontPreview(bytes,prepared.bank,{prepared,dsp,effects:true}),expected=await createSoundFontPreview(bytes,reference,{dsp,effects:true});
    try{for(let block=0;block<120;block++)assert.deepEqual(actual.read(2048),expected.read(2048),dsp+' block '+block);}
    finally{actual.close();expected.close();}
  }
});


test('a real XG SFX kit on MSB 126 is recognized as percussion and missing SFX kits report a drum fallback',async()=>{
  const bytes=fs.readFileSync(new URL('bank.sf3',root)),bank=SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const sfx=bank.presets.find(p=>p.isGMGSDrum&&p.program===56);sfx.isGMGSDrum=false;sfx.bankMSB=126;sfx.program=0;
  const rebuilt=new BasicSoundBank();rebuilt.addCompletePresets([sfx]);rebuilt.soundBankInfo.version={major:3,minor:0};
  const native=SoundBankLoader.fromArrayBuffer(rebuilt.writeSF2());assert.equal(native.isXGBank,true);assert.equal(native.presets[0].isDrum,true);
  const missing=await load().load(song('xg',{bankMSB:126,bankLSB:0,program:0}));
  const notice=missing.diagnostics.entries.find(e=>e.code==='preset-substitution'&&e.requested.bankMSB===126);assert.ok(notice);assert.equal(notice.actual.isGMGSDrum,true);
});
