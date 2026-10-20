import { installCStateDSP } from './voice-dsp-state.js';
const compiled = new Map();
async function module(backend) {
  if (!compiled.has(backend)) compiled.set(backend, (async () => {
    const url = new URL(backend === 'wasm-simd' ? './dsp/voice-mixer-simd.wasm' : './dsp/voice-mixer.wasm', import.meta.url);
    let bytes;
    if (url.protocol === 'file:' && globalThis.process?.versions?.node) {
      bytes = await (await import('node:fs/promises')).readFile(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Voice DSP: HTTP ${response.status}.`);
      bytes = await response.arrayBuffer();
    }
    return WebAssembly.compile(bytes);
  })().catch(error => { compiled.delete(backend); throw error; }));
  return compiled.get(backend);
}

export async function installVoiceDSP(synth, backend = 'wasm') {
  const code = await module(backend);
  const { exports } = await WebAssembly.instantiate(code);
  const { memory } = exports;
  const processVoice = exports.dsp_process_voice || exports.processVoice;
  const base = exports.dsp_get_layout ? exports.dsp_get_layout() : 0;
  if (exports.dsp_abi_version && exports.dsp_abi_version() !== 1) throw new Error('Unsupported C DSP ABI.');
  const core = synth.synthCore;
  const bindings = [];
  let left, right, state, cursor;
  const refresh = () => {
    const view = offset => new Float32Array(memory.buffer, base + offset, 128);
    core.voiceBuffer = view(0); left = view(512); right = view(1024);
    core.reverbInput = view(1536); core.chorusInput = view(2048); core.delayInput = view(2560);
    core.insertionInputL = view(3072); core.insertionInputR = view(3584);
    state = new Float64Array(memory.buffer, base + 4096, 9); cursor = new Float64Array(memory.buffer, base + 4200, 1);
    for (const item of bindings) item.object[item.key] = new item.Type(memory.buffer, item.offset, item.length);
  };
  refresh();
  const sampleCache = new WeakMap();
  let nextSample = Math.max(65536, Number(exports.__heap_base?.value || 65536));
  const external = new WeakMap();
  const arena = {
    alloc(size) {
      const pointer = Math.ceil(nextSample / 8) * 8; nextSample = pointer + size;
      const missing = nextSample - memory.buffer.byteLength;
      if (missing > 0) { memory.grow(Math.ceil(missing / 65536)); refresh(); }
      return pointer;
    },
    bind(object, key) {
      const original = object[key], Type = original.constructor, offset = this.alloc(original.byteLength);
      const view = new Type(memory.buffer, offset, original.length); view.set(original);
      bindings.push({ object, key, offset, Type, length: original.length }); object[key] = view; return offset;
    },
    pointer(array) {
      if (array.buffer === memory.buffer) return { offset: array.byteOffset };
      let offset = external.get(array);
      if (offset === undefined) { offset = this.alloc(array.byteLength); external.set(array, offset); }
      new array.constructor(memory.buffer, offset, array.length).set(array);
      return { offset, copyBack: () => array.set(new array.constructor(memory.buffer, offset, array.length)) };
    }
  };
  const nativeProcess = synth.process;
  synth.process = (outputL, outputR, start = 0, count = outputL.length - start) => {
    if (count < 1 || count > 128) throw new RangeError('Voice DSP blocks must contain 1–128 samples.');
    left.fill(0); right.fill(0);
    exports.dsp_begin_block?.();
    nativeProcess(left, right, 0, count);
    outputL.set(left.subarray(0, count), start); outputR.set(right.subarray(0, count), start);
  };
  core.voiceDSP = {
    backend,
    core: exports.dsp_abi_version ? 'c' : 'wat',
    stateful: !!exports.dsp_process_voice_envelope,
    get left() { return left; }, get right() { return right; },
    get memoryBuffer() { return memory.buffer; },
    checkpoint() {
      // Copy mutable bindings and the C static layout, not immutable PCM or
      // the monotonic allocation/cache bookkeeping held by this closure.
      const blocks = [{ offset: 0, bytes: new Uint8Array(memory.buffer, 0, Math.max(65536, Number(exports.__heap_base?.value || 65536))).slice() },
        ...bindings.map(b => ({ offset: b.offset, bytes: new Uint8Array(memory.buffer, b.offset, b.length * b.Type.BYTES_PER_ELEMENT).slice() }))];
      return { buffer: memory.buffer, bytes: blocks.reduce((n, b) => n + b.bytes.length, 0), restore() {
        for (const block of blocks) new Uint8Array(memory.buffer, block.offset, block.bytes.length).set(block.bytes);
        refresh();
      } };
    },
    render(filter, enabled, gain, increment, count, gainLeft, gainRight, reverb, chorus, delay, insertion, wave, tuningRatio, envelope, target) {
      let pointer = 0;
      if (wave) {
        pointer = sampleCache.get(wave.sampleData);
        if (pointer === undefined) {
          pointer = arena.alloc(wave.sampleData.byteLength);
          new Float32Array(memory.buffer, pointer, wave.sampleData.length).set(wave.sampleData);
          sampleCache.set(wave.sampleData, pointer);
        }
      }
      if (enabled) {
        state[0] = filter.a0; state[1] = filter.a1; state[2] = filter.a2; state[3] = filter.a3; state[4] = filter.a4;
        state[5] = filter.x1; state[6] = filter.x2; state[7] = filter.y1; state[8] = filter.y2;
      }
      let active;
      if (envelope?._cState && exports.dsp_process_voice_envelope) {
        active = exports.dsp_process_voice_envelope(count, +enabled, envelope._cState, target, envelope._cTable,
          gainLeft, gainRight, reverb, chorus, delay, +insertion, pointer, wave ? +wave.isLooping : 0,
          wave?.loopEnd || 0, wave?.loopLength || 0, wave?.end || 0, wave?.cursor || 0, wave ? tuningRatio * wave.playbackStep : 0);
        envelope._cSync();
      } else active = processVoice(count, +enabled, gain, increment, gainLeft, gainRight, reverb, chorus, delay, +insertion,
          pointer, wave ? +wave.isLooping : 0, wave?.loopEnd || 0, wave?.loopLength || 0,
          wave?.end || 0, wave?.cursor || 0, wave ? tuningRatio * wave.playbackStep : 0);
      if (wave && active) wave.cursor = cursor[0];
      if (enabled) { filter.x1 = state[5]; filter.x2 = state[6]; filter.y1 = state[7]; filter.y2 = state[8]; }
      return !!active;
    }
  };
  if (exports.dsp_volume_envelope && core.voices) installCStateDSP(core, exports, arena);
}
