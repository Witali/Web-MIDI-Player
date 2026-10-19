import { BasicMIDI, BasicSoundBank, SoundBankLoader, SpessaLog } from './vendor/spessasynth.js';
import { normalizeSmpteTiming } from './midi-timing.js';
import { diagnoseMidi } from './midi-diagnostics.js';

export const FLUIDR3_SOURCE_SHA256 = '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0';
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Invalid browser SoundFont assets. Run npm run setup or git lfs pull.');

// Encoded recordings have a bounded LRU cache. Decoded PCM belongs only to the
// current song's bank; loading many different songs cannot retain every PCM.
export class BrowserSoundBank {
  constructor(url = new URL('./soundfonts/fluidr3-gm/manifest.json', import.meta.url), {
    fetcher = globalThis.fetch, expectedSource = FLUIDR3_SOURCE_SHA256,
    cacheBytes = 32 * 1024 * 1024, concurrency = 4
  } = {}) {
    if (!integer(cacheBytes) || !integer(concurrency, 1) || concurrency > 16) throw new RangeError('Invalid sample cache/concurrency.');
    this.url = new URL(url, import.meta.url); this.fetcher = fetcher;
    this.expectedSource = expectedSource; this.limit = cacheBytes; this.concurrency = concurrency;
    this.cache = new Map(); this.cacheSize = 0;
  }
  async response(file, signal) {
    signal?.throwIfAborted();
    const fetcher = this.fetcher; // Native browser fetch must not receive this bank as its receiver.
    const response = await fetcher(file, { signal });
    if (!response.ok) throw new Error('Cannot load SoundFont asset: HTTP ' + response.status + ' (' + new URL(file).pathname + ').');
    return response;
  }
  async verified(row, signal) {
    const bytes = await (await this.response(new URL(row.file, this.url), signal)).arrayBuffer();
    if (bytes.byteLength !== row.bytes || await hash(bytes) !== row.sha256) throw invalid();
    signal?.throwIfAborted(); return bytes;
  }
  async assets(signal) {
    if (this.description) return this.description;
    let manifest;
    try { manifest = await (await this.response(this.url, signal)).json(); }
    catch (error) { signal?.throwIfAborted(); throw new Error('Cannot read browser SoundFont manifest. Run npm run setup. ' + error.message, { cause: error }); }
    const validRow = row => row && digest(row.sha256) && integer(row.bytes, 1) && row.bytes < 8 * 1024 * 1024;
    if (manifest.schema !== 1 || manifest.source_sha256 !== this.expectedSource ||
        !validRow(manifest.metadata) || manifest.metadata.file !== 'bank.sf3' || !Array.isArray(manifest.samples) ||
        !manifest.samples.length || !manifest.total || !integer(manifest.total.encoded_bytes, 1) || manifest.samples.some((row, i) => !validRow(row) || row.index !== i ||
          !integer(row.frames, 1) || !integer(row.sample_rate_hz, 1) ||
          !['pcm16', 'vorbis'].includes(row.format) ||
          row.file !== 'samples/' + row.sha256 + (row.format === 'vorbis' ? '.ogg' : '.pcm') ||
          (row.format === 'pcm16' && row.bytes !== row.frames * 2))) throw invalid();
    const metadata = await this.verified(manifest.metadata, signal);
    signal?.throwIfAborted();
    this.description = { manifest, metadata }; return this.description;
  }
  async sample(row, signal, stats) {
    const cached = this.cache.get(row.sha256);
    if (cached && cached.byteLength !== row.bytes) throw invalid();
    if (cached) {
      this.cache.delete(row.sha256); this.cache.set(row.sha256, cached);
      stats.cacheHits++; return cached;
    }
    const bytes = await this.verified(row, signal); stats.downloadedBytes += bytes.byteLength;
    if (bytes.byteLength <= this.limit) {
      while (this.cacheSize + bytes.byteLength > this.limit) {
        const [key, value] = this.cache.entries().next().value;
        this.cache.delete(key); this.cacheSize -= value.byteLength;
      }
      this.cache.set(row.sha256, bytes); this.cacheSize += bytes.byteLength;
    }
    return bytes;
  }
  async load(bytes, { effects = true, signal: outerSignal } = {}) {
    const abort = new AbortController();
    const signal = outerSignal ? AbortSignal.any([outerSignal, abort.signal]) : abort.signal;
    const workers = [];
    try {
      SpessaLog.setLogLevel(false, false, false);
      const midi = normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      const { manifest, metadata } = await this.assets(signal);
      const bank = SoundBankLoader.fromArrayBuffer(metadata.slice(0));
      if (bank.samples.length !== manifest.samples.length || bank.samples.some((s, i) => s.sampleRate !== manifest.samples[i].sample_rate_hz)) throw invalid();
      const needed = new Set();
      const onSample = sample => { needed.add(sample); if (sample.linkedSample) needed.add(sample.linkedSample); };
      const diagnostics = await diagnoseMidi(midi, bank, { effects, onSample, signal });
      if (!diagnostics.complete) throw new Error('Cannot prepare samples: MIDI analysis failed.');
      const entries = bank.samples.map((sample, index) => ({ sample, row: manifest.samples[index] })).filter(({ sample }) => needed.has(sample));
      const files = new Map(entries.map(({ row }) => [row.file, row]));
      const sampleBank = { mode: 'samples', samples: entries.length, files: files.size,
        encodedBytes: [...files.values()].reduce((n, row) => n + row.bytes, 0),
        totalSamples: bank.samples.length, totalEncodedBytes: manifest.total.encoded_bytes,
        downloadedBytes: 0, cacheHits: 0 };
      await BasicSoundBank.isSF3DecoderReady;
      const inFlight = new Map(); let cursor = 0;
      for (let i = 0; i < Math.min(this.concurrency, entries.length); i++) workers.push((async () => {
        while (cursor < entries.length) {
          signal.throwIfAborted();
          const { sample, row } = entries[cursor++];
          if (!inFlight.has(row.file)) inFlight.set(row.file, this.sample(row, signal, sampleBank));
          const data = await inFlight.get(row.file); signal.throwIfAborted();
          let pcm;
          if (row.format === 'vorbis') { sample.setCompressedData(new Uint8Array(data)); pcm = sample.getAudioData(); }
          else { const view = new DataView(data); pcm = Float32Array.from({ length: row.frames }, (_, i) => view.getInt16(i * 2, true) / 32768); }
          if (pcm.length < row.frames || pcm.some(v => !Number.isFinite(v))) throw invalid();
          // Vorbis pads its final block. Keep the original frame and loop indices.
          sample.setAudioData(pcm.subarray(0, row.frames), row.sample_rate_hz);
        }
      })());
      await Promise.all(workers); signal.throwIfAborted();
      // A missed dependency must be an explicit error, never a silently lost note.
      for (const sample of bank.samples) if (!needed.has(sample)) sample.getAudioData = () => { throw new Error('SoundFont sample was not prepared: ' + sample.name); };
      return { bank, midi, diagnostics, sampleBank };
    } catch (error) {
      abort.abort(error); await Promise.allSettled(workers); throw error;
    }
  }
}
