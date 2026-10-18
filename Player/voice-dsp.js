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
  const { exports: { memory, processVoice } } = await WebAssembly.instantiate(code);
  const core = synth.synthCore;
  let left, right, state, cursor;
  const refresh = () => {
    const view = offset => new Float32Array(memory.buffer, offset, 128);
    core.voiceBuffer = view(0); left = view(512); right = view(1024);
    core.reverbInput = view(1536); core.chorusInput = view(2048); core.delayInput = view(2560);
    core.insertionInputL = view(3072); core.insertionInputR = view(3584);
    state = new Float64Array(memory.buffer, 4096, 9); cursor = new Float64Array(memory.buffer, 4200, 1);
  };
  refresh();
  const sampleCache = new WeakMap();
  let nextSample = 65536;
  const nativeProcess = synth.process;
  synth.process = (outputL, outputR, start = 0, count = outputL.length - start) => {
    if (count < 1 || count > 128) throw new RangeError('Voice DSP blocks must contain 1–128 samples.');
    left.fill(0); right.fill(0);
    nativeProcess(left, right, 0, count);
    outputL.set(left.subarray(0, count), start); outputR.set(right.subarray(0, count), start);
  };
  core.voiceDSP = {
    backend,
    get left() { return left; }, get right() { return right; },
    render(filter, enabled, gain, increment, count, gainLeft, gainRight, reverb, chorus, delay, insertion, wave, tuningRatio) {
      let pointer = 0;
      if (wave) {
        pointer = sampleCache.get(wave.sampleData);
        if (pointer === undefined) {
          pointer = nextSample; nextSample += wave.sampleData.byteLength;
          const missing = nextSample - memory.buffer.byteLength;
          if (missing > 0) { memory.grow(Math.ceil(missing / 65536)); refresh(); }
          new Float32Array(memory.buffer, pointer, wave.sampleData.length).set(wave.sampleData);
          sampleCache.set(wave.sampleData, pointer);
        }
      }
      if (enabled) {
        state[0] = filter.a0; state[1] = filter.a1; state[2] = filter.a2; state[3] = filter.a3; state[4] = filter.a4;
        state[5] = filter.x1; state[6] = filter.x2; state[7] = filter.y1; state[8] = filter.y2;
      }
      const active = processVoice(count, +enabled, gain, increment, gainLeft, gainRight, reverb, chorus, delay, +insertion,
        pointer, wave ? +wave.isLooping : 0, wave?.loopEnd || 0, wave?.loopLength || 0,
        wave?.end || 0, wave?.cursor || 0, wave ? tuningRatio * wave.playbackStep : 0);
      if (wave && active) wave.cursor = cursor[0];
      if (enabled) { filter.x1 = state[5]; filter.x2 = state[6]; filter.y1 = state[7]; filter.y2 = state[8]; }
      return !!active;
    }
  };
}
