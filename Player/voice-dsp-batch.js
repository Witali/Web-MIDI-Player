// Batch extension 1: wasm32 pointers/words followed by Float64 parameters.
// Only preparation stays in JS; C renders commands in original pool order.
const BYTES = 136, WORDS = BYTES / 4, DOUBLES = BYTES / 8, QUANTUM = 128;
export function installVoiceBatch(core, api, arena, memory, samplePointer) {
  if (!api.dsp_process_batch) return null;
  if (api.dsp_batch_abi_version() !== 1 || api.dsp_voice_command_size() !== BYTES)
    throw new Error('Unsupported C voice batch ABI.');
  let pointer = 0, capacity = 0, words, doubles, payloadPointer = 0, payloadCapacity = 0, payload;
  let used = 0, count = 0, running = false;
  const entries = [], stats = { calls: 0, voices: 0, lastVoices: 0 };
  function refresh() {
    if (capacity) {
      words = new Uint32Array(memory.buffer, pointer, capacity * WORDS);
      doubles = new Float64Array(memory.buffer, pointer, capacity * DOUBLES);
    }
    if (payloadCapacity) {
      payload = new Float32Array(memory.buffer, payloadPointer, payloadCapacity * QUANTUM);
      for (let i = 0; i < entries.length; i++) entries[i].audio = i < payloadCapacity
        ? new Float32Array(memory.buffer, payloadPointer + i * QUANTUM * 4, QUANTUM) : null;
    }
  }
  function reserve(size, audio) {
    if (size > capacity) {
      const saved = words?.slice(0, used * WORDS), next = Math.max(16, capacity * 2, size);
      const offset = arena.alloc(next * BYTES);
      pointer = offset; capacity = next;
      while (entries.length < capacity) entries.push({});
      refresh(); if (saved) words.set(saved);
    }
    if (audio && capacity > payloadCapacity) {
      const saved = payload?.slice(0, used * QUANTUM), offset = arena.alloc(capacity * QUANTUM * 4);
      payloadPointer = offset; payloadCapacity = capacity;
      refresh(); if (saved) payload.set(saved);
      // Queued input/capture pointers must follow the expanded payload too.
      for (let i = 0; i < used; i++) {
        const at = i * WORDS, p = payloadPointer + i * QUANTUM * 4;
        if (words[at + 4]) words[at + 4] = p;
        if (words[at + 5]) words[at + 5] = p;
      }
    }
  }
  function enqueue(filter, enabled, gain, increment, n, left, right, reverb, chorus, delay, insertion,
    wave, tuningRatio, envelope, target, voice, route, captureLeft, captureRight, effects, xgReverb, xgChorus, xgDelay) {
    if (!running || n !== count) throw new Error('Voice outside its DSP batch.');
    const capture = !!route || effects && !!(core.xgVariation?.active || core.xgSystemEffects?.active);
    reserve(used + 1, !wave || capture);
    const source = wave ? samplePointer(wave.sampleData) : 0;
    const entry = entries[used], at = used * WORDS, d = used * DOUBLES;
    const audio = !wave || capture ? payloadPointer + used * QUANTUM * 4 : 0;
    // All allocations precede these accesses: memory.grow can detach views.
    words[at] = source; words[at + 1] = filter._cFilterPointer || 0;
    words[at + 2] = envelope?._cState || 0; words[at + 3] = envelope?._cTable || 0;
    words[at + 4] = wave ? 0 : audio; words[at + 5] = capture ? audio : 0;
    words[at + 6] = +enabled | (+insertion << 1); words[at + 7] = wave ? +wave.isLooping : 0;
    words[at + 8] = wave?.loopEnd || 0; words[at + 9] = wave?.loopLength || 0;
    words[at + 10] = wave?.end || 0; words[at + 11] = 0;
    doubles[d + 6] = wave?.cursor || 0; doubles[d + 7] = wave ? tuningRatio * wave.playbackStep : 0;
    doubles[d + 8] = gain; doubles[d + 9] = increment; doubles[d + 10] = target;
    doubles[d + 11] = left; doubles[d + 12] = right; doubles[d + 13] = reverb;
    doubles[d + 14] = chorus; doubles[d + 15] = delay;
    if (enabled) {
      const f = filter._cFilter.data;
      if (filter._cFilterDirty) {
        f[5] = filter.x1; f[6] = filter.x2; f[7] = filter.y1; f[8] = filter.y2;
        filter._cFilterDirty = false;
      }
      f[0] = filter.a0; f[1] = filter.a1; f[2] = filter.a2; f[3] = filter.a3; f[4] = filter.a4;
    }
    if (!wave) entry.audio.set(core.voiceBuffer.subarray(0, count));
    entry.voice = voice; entry.filter = enabled ? filter : null; entry.wave = wave; entry.envelope = envelope;
    entry.active = voice.isActive; entry.capture = capture;
    if (capture) {
      entry.route = route; entry.left = captureLeft; entry.right = captureRight;
      entry.reverb = xgReverb; entry.chorus = xgChorus; entry.delay = xgDelay;
    }
    used++;
  }
  function flush() {
    if (!running) return;
    stats.lastVoices = used;
    if (!used) return;
    const process = core.voiceDSP.independentSIMD === false && api.dsp_process_batch_scalar ? api.dsp_process_batch_scalar : api.dsp_process_batch;
    if (process(pointer, used, count) !== 0) throw new Error('Invalid C voice batch.');
    stats.calls++; stats.voices += used;
    for (let i = 0; i < used; i++) {
      const entry = entries[i], active = words[i * WORDS + 11] !== 0;
      entry.envelope?._cSync();
      if (entry.wave && active) entry.wave.cursor = doubles[i * DOUBLES + 16];
      if (entry.filter) {
        const f = entry.filter, data = f._cFilter.data;
        f.x1 = data[5]; f.x2 = data[6]; f.y1 = data[7]; f.y2 = data[8];
      }
      entry.voice.isActive = entry.active && active;
      if (!entry.voice.isActive) core.voicePool.retire(entry.voice);
      if (entry.capture) {
        if (entry.route) entry.route.capture(entry.audio, count, entry.left, entry.right, entry.voice);
        else {
          core.xgVariation?.capture(entry.audio, count, entry.left, entry.right, entry.delay);
          core.xgSystemEffects?.capture(entry.audio, count, entry.left, entry.right, entry.reverb, entry.chorus);
        }
      }
      // Descriptors are temporary, not part of a checkpoint or resource cache.
      entry.voice = entry.filter = entry.wave = entry.envelope = entry.route = null;
    }
    core.voicePool.prune(); used = 0;
  }
  return { refresh, enqueue, flush, stats, get running() { return running; },
    get capacity() { return capacity; }, get payloadCapacity() { return payloadCapacity; },
    begin(n) { used = 0; count = n; running = true; stats.lastVoices = 0; },
    end() { running = false; used = 0; } };
}
