// The source project renders PCM in C/WASM. Keep it off the website's UI thread.
import { createStereoPreview } from './stereo-preview.js';
import { BrowserSoundBank } from './lazy-bank.js';
import { createLoopPreview } from './loop-preview.js';
import { defaultPlayback, normalizePlaybackPatch, resolvePlayback } from './playback-settings.js';
import { updatePartSettings } from './part-controls.js';
let enginePromise, preview, port, epoch = 0, queue = Promise.resolve();
let latestSeek = 0, changing = false;
const soundfonts = new Map(), browserBanks = new Map();
let loadAbort, source;
async function soundfont(url, signal) {
  const location = url || new URL('./soundfonts/FluidR3_GM.sf2', import.meta.url).href;
  if (!soundfonts.has(location)) soundfonts.set(location, (async () => {
    const [{ SoundBankLoader, SpessaLog }, response] = await Promise.all([import('./vendor/spessasynth.js'), fetch(location, { signal })]);
    if (!response.ok) throw new Error(`Cannot load SoundFont: HTTP ${response.status}.`);
    SpessaLog.setLogLevel(false, false, false);
    return SoundBankLoader.fromArrayBuffer(await response.arrayBuffer());
  })().catch(error => { soundfonts.delete(location); throw error; }));
  return soundfonts.get(location);
}
async function resources() {
  if (!enginePromise) enginePromise = (async () => {
    const json = async name => {
      const response = await fetch(new URL(`./engine/data/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`Cannot load sample bank: HTTP ${response.status}.`);
      return response.json();
    };
    const [engine, base, quality, players, drums] = await Promise.all([
      import('./engine/src/compiler.js'), json('bank.json'), json('quality-detailed-r2r.json'), json('players.json'), json('drums-r2r.json')
    ]);
    const bank = engine.prepareDrumBank(engine.prepareQualityBank(engine.prepareBank(base), quality), drums);
    return { engine, bank, players };
  })().catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}
export function unwrapMidi(bytes) {
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'RMID') return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = view.getUint32(at + 4, true);
    if (at + 8 + length > bytes.length) throw new Error('Truncated RMID container.');
    if (tag(at) === 'data') return bytes.slice(at + 8, at + 8 + length);
    at += 8 + length + length % 2;
  }
  throw new Error('RMID has no MIDI data.');
}
function render(data) {
  if (changing || data.epoch !== epoch || data.epoch !== latestSeek || !preview) return;
  try {
    const channels = preview.read(2048);
    const stats = preview.stats;
    port.postMessage({ epoch, channels, spans: preview.lastSpans, duration: stats.duration, done: !stats.playback?.loop && stats.position >= stats.duration }, channels.map(samples => samples.buffer));
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
}
async function soundFontPreview(data) {
  const { createSoundFontPreview } = await import('./soundfont-preview.js');
  let prepared, bank;
  if (data.soundfontUrl) bank = await soundfont(data.soundfontUrl, data.signal);
  else {
    const url = data.sampleManifestUrl || new URL('./soundfonts/fluidr3-gm/manifest.json', import.meta.url).href;
    if (!browserBanks.has(url)) browserBanks.set(url, new BrowserSoundBank(url));
    prepared = await browserBanks.get(url).load(data.bytes, { effects: data.effects, signal: data.signal,
      parts: data.parts, partSettings: data.partSettings, textEncoding: data.textEncoding, sampleDumpMappings: data.sampleDumpMappings });
    bank = prepared.bank;
  }
  data.signal?.throwIfAborted();
  const base = await createSoundFontPreview(data.bytes, bank, { effects: data.effects, dsp: data.dsp, prepared,
    releaseVelocityProfiles: data.releaseVelocityProfiles, parts: data.parts, partSettings: data.partSettings, textEncoding: data.textEncoding, playback: data.playback, sampleDumpMappings: data.sampleDumpMappings });
  return createLoopPreview(base, base.stats.playback);
}
async function command(data) {
  if (data.type === 'load' && data.engine !== 'z80') {
    data.signal?.throwIfAborted();
    preview?.close(); preview = null; source = null;
    const options = { ...data, partSettings: {}, playback: data.playback ?? defaultPlayback() };
    preview = await soundFontPreview(options);
    source = options; source.parts = preview.stats.parts;
    epoch = data.epoch; return preview.stats;
  }
  if (data.type === 'parts' || data.type === 'playback') {
    if (!source || !preview) throw new Error('Playback settings require a loaded SoundFont song.');
    const patch = data.type === 'parts'
      ? { partSettings: updatePartSettings(source.parts, preview.stats.instruments, source.partSettings, data.part, data.changes) }
      : { playback: resolvePlayback({ ...source.playback, ...normalizePlaybackPatch(data.settings) }, preview.stats.sourceDuration) };
    // Keep the previous preview/configuration until preparation succeeds.
    const next = await soundFontPreview({ ...source, ...patch });
    preview.close(); preview = next; Object.assign(source, patch);
    const result = await preview.seek(data.seconds, { isCurrent: () => data.epoch === latestSeek });
    if (!result.cancelled) epoch = data.epoch;
    return { ...result, metadata: preview.stats };
  }
  if (data.type === 'seek') {
    if (data.epoch !== latestSeek) return { cancelled: true };
    if (!preview) throw new Error('No MIDI loaded.');
    if (preview.seek) {
      const result = await preview.seek(data.seconds, { isCurrent: () => data.epoch === latestSeek });
      if (!result.cancelled) epoch = data.epoch;
      return { ...result, metadata: preview.stats };
    }
    await preview.reset(); epoch = data.epoch;
    let remaining = Math.round(Math.min(data.seconds, preview.stats.duration) * 48000), blocks = 0;
    while (remaining > 0) {
      const samples = preview.read(Math.min(4096, remaining));
      if (!samples[0].length) break;
      remaining -= samples[0].length;
      if (++blocks % 128 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (data.epoch !== latestSeek) return { cancelled: true };
      }
    }
    return { seconds: preview.stats.position };
  }
  const { engine, bank, players } = await resources();
  if (data.type === 'load') {
    source = null;
    data.signal?.throwIfAborted();
    const score = engine.parseMidi(unwrapMidi(data.bytes));
    if (!score.notes.length) throw new Error('No supported notes in this MIDI.');
    const parts = score.parts.map(part => ({ ...part, sample: engine.suggestedSample(part.program, part), enabled: true, volume: 1 }));
    preview?.close(); preview = createStereoPreview(engine, score, bank, players, {
      mode: 'r2r', quality: 'detailed', voices: 4, parts, start: 0, end: score.duration,
      trimLeadingSilence: false, compactSamples: false, releaseTails: true
    });
    epoch = data.epoch;
    return { ...preview.stats, sourceDuration: score.duration, warnings: score.warnings, sampleRate: 48000,
      parts: parts.map(({ id, channel, program, sample, percussion }) => ({ id, channel, program, sample, percussion: !!percussion })) };
  }
  throw new Error('Unknown player command.');
}
self.onmessage = ({ data }) => {
  if (data.type === 'cancelLoad') { loadAbort?.abort(); return; }
  if (data.type === 'load') {
    loadAbort?.abort(); loadAbort = new AbortController(); data.signal = loadAbort.signal;
  }
  if (data.type === 'seek' || data.type === 'parts' || data.type === 'playback' || data.type === 'load') latestSeek = data.epoch;
  if (data.type === 'connect') {
    port?.close(); port = data.port; port.onmessage = ({ data }) => render(data); port.start(); return;
  }
  // Serialize score replacement/seeking while audio uses its own MessagePort.
  queue = queue.then(async () => {
    changing = true;
    try { self.postMessage({ id: data.id, result: await command(data) }); }
    catch (error) { self.postMessage({ id: data.id, error: error.message }); }
    finally { changing = false; }
  });
};
