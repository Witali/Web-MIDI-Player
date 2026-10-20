const resourceGraphs = new WeakMap();
// In-process checkpoint for this pinned synth. Objects and bound DSP closures
// keep their identity; restore their mutable data rather than cloning a synth.
function graph(root, seen) {
  if (!root || typeof root !== 'object' || seen.has(root)) return;
  seen.add(root);
  if (ArrayBuffer.isView(root)) { seen.add(root.buffer); return; }
  if (root instanceof ArrayBuffer || root instanceof Promise) return;
  if (root instanceof Map) { for (const [key, value] of root) { graph(key, seen); graph(value, seen); } }
  else if (root instanceof Set) for (const value of root) graph(value, seen);
  else for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(root))) if ('value' in descriptor) graph(descriptor.value, seen);
}
export function captureSynthCheckpoint(synth, sequence, midi) {
  const core = synth.synthCore, pool = core.voices, poolLength = pool.length, channelCount = core.midiChannels.length;
  let immutable = resourceGraphs.get(core);
  // Presets, PCM, parsed events and cached voice recipes are resources, not
  // playback state. Their monotonic caches remain reusable after restoration.
  if (!immutable) { immutable = new Set(); graph(core.soundBankManager, immutable); graph(midi, immutable); resourceGraphs.set(core, immutable); }
  // Completed SDS waves and constructed banks are immutable resources. Their
  // mutable address/transfer maps remain part of the restored state.
  immutable.add(core.sampleDumps.resources);
  for(const bucket of core.sampleDumps.resources.cache.values())for(const row of bucket){graph(row.words,immutable);graph(row.pcm,immutable);}
  if(core.sampleDumpBank){immutable.add(core.sampleDumpBank.resources);immutable.add(core.sampleDumpBank.cache);for(const bank of core.sampleDumpBank.resources)graph(bank,immutable);}
  immutable.add(core.cachedVoices);
  for (const recipe of core.cachedVoices.values()) graph(recipe, immutable);
  const native = core.voiceDSP?.checkpoint?.(), nativeBuffer = native?.buffer;
  const records = [], seen = new Set(), views = new Map(); let bytes = native?.bytes ?? 0;
  const visit = object => {
    if (!object || typeof object !== 'object' || immutable.has(object) || seen.has(object)) return;
    seen.add(object);
    if (object instanceof Promise || object instanceof Date) return;
    if (object instanceof WeakMap || object instanceof WeakSet) throw new Error('Opaque mutable synth state cannot be checkpointed.');
    if (ArrayBuffer.isView(object)) {
      if (object.buffer === nativeBuffer) views.set(object, { Type: object.constructor, offset: object.byteOffset, length: object.length });
      else visit(object.buffer);
      // Indexed byte streams may have a cursor in addition to numeric data.
      const extra = Object.entries(Object.getOwnPropertyDescriptors(object)).filter(([key]) => !/^[0-9]+$/.test(key));
      if (extra.length) records.push({ object, properties: extra, keys: new Set(extra.map(([key]) => key)) });
      return;
    }
    if (object instanceof ArrayBuffer) {
      const data = new Uint8Array(object).slice(); bytes += data.byteLength; records.push({ object, data }); return;
    }
    if (object instanceof Map || object instanceof Set) {
      const entries = [...object]; records.push({ object, entries });
      for (const entry of entries) if (object instanceof Map) { visit(entry[0]); visit(entry[1]); } else visit(entry);
      return;
    }
    const properties = Object.entries(Object.getOwnPropertyDescriptors(object));
    records.push({ object, properties, keys: new Set(properties.map(([key]) => key)) });
    for (const [, descriptor] of properties) if ('value' in descriptor) visit(descriptor.value);
  };
  visit(synth); visit(sequence);
  const randomState = core.randomGenerator.state;
  const value = object => { const view = views.get(object); return view ? new view.Type(core.voiceDSP.memoryBuffer, view.offset, view.length) : object; };
  return { bytes, memoryBytes: nativeBuffer?.byteLength ?? 0, restore() {
    if (core.midiChannels.length !== channelCount) throw new Error('Synth channel topology changed after checkpoint.');
    for (const record of records) {
      const { object } = record;
      if (record.data) { new Uint8Array(object).set(record.data); continue; }
      if (record.entries) {
        object.clear();
        for (const entry of record.entries) if (object instanceof Map) object.set(value(entry[0]), value(entry[1])); else object.add(value(entry));
        continue;
      }
      const saved = record.keys;
      for (const key of Object.keys(object)) if (!saved.has(key) && !((object === pool || ArrayBuffer.isView(object)) && /^[0-9]+$/.test(key))) delete object[key];
      for (const [key, descriptor] of record.properties) {
        if (!('value' in descriptor) || (object === pool && key === 'length')) continue;
        if (descriptor.writable) object[key] = value(descriptor.value);
      }
    }
    // New voices/bindings are retained as reusable inactive storage. Rewinding
    // the arena/cache allocator would invalidate samples allocated after A.
    for (let i = poolLength; i < pool.length; i++) pool[i].isActive = false;
    core.systemParameters.voiceCap = pool.length;
    core.voicePool.rebuild();
    core.randomGenerator.state = randomState;
    native?.restore();
  } };
}
