import createCompiler from '../wasm/compiler.js';
import {parseMidi,suggestedSample} from './midi.js';
import {encodeRequest} from './request.js';
import {finishResult} from './compile-result.js';
export {parseMidi,suggestedSample,encodeRequest};
export {drumNames,drumSample} from './drums.js';
export {decode64,prepareBank,prepareQualityBank,prepareDrumBank} from './banks.js';
export async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
// A single C module owns the algorithms; this adapter only transports data and
// formats metadata. It is instantiated inside the existing compilation Worker.
const core=await createCompiler();
const textDecoder=new TextDecoder();
function cstring(pointer){const bytes=core.HEAPU8.subarray(pointer,pointer+384),end=bytes.indexOf(0);return textDecoder.decode(end<0?bytes:bytes.subarray(0,end));}
function allocate(bytes){const pointer=core._malloc(Math.max(1,bytes.length));if(!pointer)throw new Error('Не удалось выделить память WASM.');core.HEAPU8.set(bytes,pointer);return pointer;}
export function compileRequest(request,fit=false){
  const pointer=allocate(request);let result;
  try{
    result=(fit?core._fc_fit:core._fc_compile)(pointer,request.length);const message=cstring(core._fc_error(result));if(message){const error=new Error(message);error.code=core._fc_error_code(result);throw error;}
    const blob=kind=>core.HEAPU8.slice(core._fc_blob(result,kind),core._fc_blob(result,kind)+core._fc_size(result,kind));
    const layout=blob(7);
    return {rom:blob(0),descriptors:blob(1),waves:blob(2),pattern:blob(3),hex:textDecoder.decode(blob(4)),gains:blob(5),substitutions:blob(6),
      ...(layout.length?{decoderLayout:{reservedCodeBytes:layout[1]*256,codeBytes:layout[2]*256,descriptorAddress:layout[3]*256,gainAddress:layout[4]*256}}:{}),
      numbers:Array.from({length:40},(_,i)=>core._fc_number(result,i))};
  }finally{if(result)core._fc_free(result);core._free(pointer);}
}
function build(score,bank,players,options,fit){
  const voices=Number(options.voices??4),transpose=Number(options.transpose??0);
  if(!Number.isInteger(voices)||!Number.isInteger(transpose))throw new Error('Проверьте голоса, транспозицию и границы фрагмента (минимум 0,25 мс).');
  return finishResult(score,options,compileRequest(encodeRequest(score,bank,players,options),fit),bank);
}
export const compile=(score,bank,players,options)=>build(score,bank,players,options,false);
export const fitToRom=(score,bank,players,options)=>build(score,bank,players,options,true);
export function intelHex(bytes){
  const input=allocate(bytes);let output;
  try{const size=core._fc_hex(input,bytes.length,0,0);if(!size)throw new Error('Некорректный размер Intel HEX.');output=core._malloc(size);if(!output||core._fc_hex(input,bytes.length,output,size)!==size)throw new Error('Не удалось создать Intel HEX.');return textDecoder.decode(core.HEAPU8.subarray(output,output+size));}
  finally{if(output)core._free(output);core._free(input);}
}
// Audio is rendered incrementally in C. JS owns only the handle and small PCM
// transfers; neither the complete recording nor the score is mixed on the UI.
export function createPreview(request) {
  const pointer=allocate(request);let handle,output;
  try {
    handle=core._fc_preview_create(pointer,request.length);
    const message=cstring(core._fc_preview_error(handle));if(message)throw new Error(message);
    output=core._malloc(4096*4);if(!output)throw new Error('Не удалось выделить буфер прослушивания.');
  } catch(error) {if(handle)core._fc_preview_free(handle);throw error;}
  finally {core._free(pointer);}
  const number=index=>core._fc_preview_number(handle,index);
  const partCount=number(7);
  return {
    get stats(){return {duration:number(0),position:number(1),notes:number(2),outOfRange:number(3),polyphony:number(4),gain:number(5),trimmed:number(6),percussionNotes:number(8)};},
    get levels(){return Array.from({length:partCount},(_,part)=>handle?core._fc_preview_level(handle,part):0);},
    read(capacity=4096) {
      if(!handle)throw new Error('Прослушивание уже закрыто.');
      if(!Number.isInteger(capacity)||capacity<1||capacity>4096)throw new Error('Некорректный размер аудиоблока.');
      const count=core._fc_preview_read(handle,output,capacity);
      return new Float32Array(core.HEAPU8.buffer,output,count).slice();
    },
    gain(part,value) {if(!handle||!Number.isInteger(part)||part<0||!core._fc_preview_gain(handle,part,value))throw new Error('Некорректная громкость партии.');},
    close(){if(handle){core._fc_preview_free(handle);core._free(output);handle=0;}}
  };
}
