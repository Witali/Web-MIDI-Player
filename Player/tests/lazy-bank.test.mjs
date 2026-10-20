import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BrowserSoundBank } from '../lazy-bank.js';
import { BasicSoundBank, SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { verifyBrowserBank } from '../tools/verify-browser-bank.mjs';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const url = new URL('../soundfonts/fluidr3-gm/manifest.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(url));
const fetchFile = async (url, { signal } = {}) => { signal?.throwIfAborted(); return new Response(fs.readFileSync(fileURLToPath(url))); };
const array = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parseMetadata = () => SoundBankLoader.fromArrayBuffer(array(fs.readFileSync(new URL(manifest.metadata.file, url))));
const end = [0, 255, 47, 0];
const piano = midi([[0, 0x90, 60, 100], [...vlq(480), 0x80, 60, 0], end]);
const flute = midi([[0, 0xc0, 73], [0, 0x90, 69, 110], [...vlq(480), 0x80, 69, 0], end]);
let complete;
async function fullCompressedBank() {
  if (!complete) complete = (async () => {
    const bank = parseMetadata(); await BasicSoundBank.isSF3DecoderReady;
    for (const row of manifest.samples) {
      const sample = bank.samples[row.index], bytes = fs.readFileSync(new URL(row.file, url));
      let pcm;
      if (row.format === 'vorbis') { sample.setCompressedData(new Uint8Array(bytes)); pcm = sample.getAudioData(); }
      else { const view = new DataView(array(bytes)); pcm = Float32Array.from({ length: row.frames }, (_, i) => view.getInt16(i * 2, true) / 32768); }
      sample.setAudioData(pcm.subarray(0, row.frames), row.sample_rate_hz);
    }
    return bank;
  })();
  return complete;
}

test('browser bank has authenticated independent recordings and complete maps without embedded PCM', () => {
  assert.equal(verifyBrowserBank().total.samples, 1466);
  assert.equal(manifest.total.presets, 222); assert.equal(manifest.total.unique_files, 1454);
  assert.ok(manifest.total.encoded_bytes < manifest.total.source_pcm_bytes / 4);
  const bank = parseMetadata(); assert.equal(bank.presets.length, 222);
  assert.ok(bank.samples.every(sample => sample.getRawData(true).length === 0));
});

test('one piano key loads only its regions and stereo links, deduplicates repeats and reuses verified cache', async () => {
  const requests = [], loader = new BrowserSoundBank(url, { fetcher: async (...args) => { requests.push(String(args[0])); return fetchFile(...args); } });
  const bytes = midi([[0, 0x90, 60, 100], [0, 0x90, 60, 100], [...vlq(480), 0xb0, 123, 0], end]);
  const prepared = await loader.load(bytes);
  const selected = new Set(), preset = prepared.bank.getPreset({ program: 0, bankMSB: 0, bankLSB: 0, isGMGSDrum: false }, 'gs');
  for (const voice of preset.getVoiceParameters(60, 100)) { selected.add(voice.sample); if (voice.sample.linkedSample) selected.add(voice.sample.linkedSample); }
  assert.equal(prepared.sampleBank.samples, selected.size);
  const files = requests.filter(p => /\.(ogg|pcm)$/.test(p));
  assert.equal(new Set(files).size, files.length); assert.ok(files.length > 0 && files.length < 10);
  assert.ok(prepared.sampleBank.encodedBytes < 1024 * 1024);
  assert.ok(!requests.some(p => p.endsWith('.sf2')));
  for (const sample of selected) assert.ok(sample.getAudioData().length);
  assert.throws(() => prepared.bank.samples.find(s => !selected.has(s)).getAudioData(), /not prepared/);
  const count = requests.length, again = await loader.load(bytes);
  assert.equal(requests.length, count); assert.equal(again.sampleBank.downloadedBytes, 0);
  assert.equal(again.sampleBank.cacheHits, files.length); assert.notEqual(again.bank, prepared.bank);
  const next = await loader.load(flute); assert.ok(next.sampleBank.samples < 10);
  assert.ok(next.sampleBank.downloadedBytes > 0); assert.ok(loader.cacheSize <= loader.limit);
});

const complex = midiTracks([
  [[0, 0xc0, 0], [0, 0x90, 60, 30], [...vlq(120), 0x80, 60, 0],
   [0, 0xb0, 0, 8], [0, 0xc0, 0], [0, 0x90, 72, 125], [...vlq(120), 0x80, 72, 0],
   [0, 0xf7, 8, 0xb0, 0, 0, 0xc0, 19, 0x90, 64, 100], [...vlq(120), 0xf7, 3, 0x80, 64, 0],
   [0, 255, 33, 1, 1], [0, 0xc0, 73], [0, 0xb0, 68, 127], [0, 0x90, 69, 100],
   [...vlq(120), 0xc0, 81], [0, 0x90, 81, 100], [...vlq(120), 0x80, 81, 0], [0, 0x80, 69, 0],
   [0, 0xb0, 68, 0], [0, 0x90, 72, 110], [...vlq(120), 0x80, 72, 0],
   [0, 255, 33, 1, 0], [0, 0xf0, 5, 0x7e, 0x7f, 9, 1, 0xf7], [0, 0x90, 60, 100],
   [...vlq(120), 0x80, 60, 0], end],
  [[0, 0x99, 36, 110], [...vlq(240), 0x89, 36, 0], [0, 0x99, 42, 50],
   [...vlq(240), 0x89, 42, 0], [0, 0xc9, 8], [0, 0x99, 38, 127], [...vlq(120), 0x89, 38, 0], end],
  [[0, 255, 81, 3, 7, 161, 32], [...vlq(360), 255, 81, 3, 3, 208, 144], end]
]);

test('program/bank changes, escaped notes, drum kits, timed ports, legato and resets match a full bank on every DSP and seek', async () => {
  const loader = new BrowserSoundBank(url, { fetcher: fetchFile });
  const prepared = await loader.load(complex), full = await fullCompressedBank();
  assert.ok(prepared.sampleBank.samples > 4 && prepared.sampleBank.samples < 100);
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const lazy = await createSoundFontPreview(complex, prepared.bank, { prepared, effects: true, dsp });
    const reference = await createSoundFontPreview(complex, full, { effects: true, dsp });
    try {
      const pcm = reference.read(96000); assert.deepEqual(lazy.read(96000), pcm);
      assert.ok(pcm.some(c => c.some(v => Math.abs(v) > .001)));
      for (const time of [.13, .43, .68, .9, 1.17, .01]) {
        await lazy.seek(time); const at = Math.round(time * 48000);
        assert.deepEqual(lazy.read(1024), pcm.map(c => c.slice(at, at + 1024)));
      }
      assert.deepEqual(lazy.stats.diagnostics, reference.stats.diagnostics);
    } finally { lazy.close(); reference.close(); }
  }
});

test('selective loading covers all 128 GM programs and 47 standard drum keys without missing regions', async () => {
  const events = [];
  for (let program = 0; program < 128; program++) {
    events.push([0, 0xc0, program]);
    for (const [key, velocity] of [[48, 30], [60, 100], [84, 127]]) events.push([0, 0x90, key, velocity], [6, 0x80, key, 0]);
  }
  for (let key = 35; key <= 81; key++) events.push([0, 0x99, key, 110], [6, 0x89, key, 0]);
  const bytes = midi([...events, end]);
  const prepared = await new BrowserSoundBank(url, { fetcher: fetchFile }).load(bytes);
  const lazy = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: false, dsp: 'wasm' });
  const reference = await createSoundFontPreview(bytes, await fullCompressedBank(), { effects: false, dsp: 'wasm' });
  try { while (reference.stats.position < reference.stats.sourceDuration + .3) assert.deepEqual(lazy.read(2048), reference.read(2048)); }
  finally { lazy.close(); reference.close(); }
});

test('damaged metadata and recordings, unresolved LFS pointers and mismatched source fail before playback and can be retried', async () => {
  for (const bad of ['bank.sf3', 'sample']) {
    let broken = true;
    const loader = new BrowserSoundBank(url, { fetcher: async (file, options) => {
      if (broken && (bad === 'sample' ? /\.(ogg|pcm)$/.test(String(file)) : String(file).endsWith(bad))) return new Response('version https://git-lfs.github.com/spec/v1\n');
      return fetchFile(file, options);
    } });
    await assert.rejects(loader.load(piano), /Invalid browser SoundFont/);
    broken = false; assert.ok((await loader.load(piano)).sampleBank.samples > 0);
  }
  await assert.rejects(new BrowserSoundBank(url, { fetcher: fetchFile, expectedSource: '0'.repeat(64) }).load(piano), /Invalid browser SoundFont/);
});

test('cancellation aborts in-flight sample requests, bounds concurrency and allows a fresh song to load', async () => {
  let blocked = true, started; const ready = new Promise(resolve => { started = resolve; });
  let active = 0, peak = 0;
  const loader = new BrowserSoundBank(url, { fetcher: async (file, options) => {
    if (blocked && /\.(ogg|pcm)$/.test(String(file))) {
      active++; peak = Math.max(peak, active); started();
      try { await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
      finally { active--; }
    }
    return fetchFile(file, options);
  } });
  const abort = new AbortController(), pending = loader.load(piano, { signal: abort.signal });
  await ready; abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(active, 0); assert.ok(peak > 0 && peak <= 4);
  blocked = false; assert.ok((await loader.load(flute)).sampleBank.samples > 0);
});

test('encoded cache respects its memory limit and evicted files can be loaded again', async () => {
  let requests = 0;
  const loader = new BrowserSoundBank(url, { cacheBytes: 1024, fetcher: async (...args) => { requests++; return fetchFile(...args); } });
  await loader.load(piano); const before = requests;
  assert.ok(loader.cacheSize <= 1024); await loader.load(piano);
  assert.ok(requests > before); assert.ok(loader.cacheSize <= 1024);
});

test('fetch callbacks are invoked without the bank as receiver, matching native browser fetch', async () => {
  let calls = 0;
  const loader = new BrowserSoundBank(url, { fetcher: function (...args) {
    assert.equal(this, undefined); calls++; return fetchFile(...args);
  } });
  assert.ok((await loader.load(piano)).sampleBank.samples > 0);
  assert.ok(calls > 2);
});
