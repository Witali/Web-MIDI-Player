import { installSampleDumpBank, normalizeSampleDumpMappings, sampleDumpInstruments } from './sample-dump-bank.js';
import { installXGVariation } from './xg-variation.js';
import { installGSEffects } from './gs-effects.js';
import { installBankMappings } from './fluid-bank-mappings.js';
import { resolvePlayback } from './playback-settings.js';
import { captureSynthCheckpoint } from './synth-checkpoint.js';
import { describeParts, installPartControls } from './part-controls.js';
import { MidiTextCollector } from './midi-text.js';
import { BasicMIDI, SpessaSynthProcessor, SpessaSynthSequencer, SpessaLog } from './vendor/spessasynth.js';
import { normalizeSmpteTiming } from './midi-timing.js';
import { installVoiceDSP } from './voice-dsp.js';
import { diagnoseMidi } from './midi-diagnostics.js';
import { normalizeReleaseVelocityProfiles, installReleaseVelocityProfiles } from './release-velocity.js';

// Complete SF2 and selectively prepared banks share the same playback path.
// Stereo, controllers and SoundFont modulators stay in the synth.
export async function createSoundFontPreview(bytes, bank, { effects = true, dsp = 'auto', prepared, releaseVelocityProfiles, parts, partSettings = {}, textEncoding, playback: playbackOptions = {}, sampleDumpMappings } = {}) {
  if (!['auto', 'wasm', 'wasm-simd', 'js'].includes(dsp)) throw new TypeError('Unknown voice DSP backend.');
  const profiles = normalizeReleaseVelocityProfiles(releaseVelocityProfiles);
  const mappings = normalizeSampleDumpMappings(sampleDumpMappings ?? prepared?.sampleDumpMappings);
  if(prepared?.sampleDumpMappings&&JSON.stringify(prepared.sampleDumpMappings)!==JSON.stringify(mappings))throw new Error('Prepared sampleDumpMappings differ from playback configuration.');
  SpessaLog.setLogLevel(false, false, false);
  const midi = prepared?.midi ?? normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const textCollector = new MidiTextCollector(midi, textEncoding);
  const diagnostics = prepared?.diagnostics ?? await diagnoseMidi(midi, bank, { effects, textCollector, sampleDumpMappings: mappings });
  const text = prepared?.text ?? textCollector.finish();
  parts ??= diagnostics.parts;
  const playback = resolvePlayback(playbackOptions, midi.duration), { rate, transpose } = playback;
  const configuredParts = describeParts(parts, partSettings), instruments = sampleDumpInstruments(bank,mappings);
  let synth, sequence, frames = 0, renderedFrames = 0, quietTailFrames = 0;
  let pending = [new Float32Array(128), new Float32Array(128)], pendingAt = 128;
  let closed = false;
  const warnings = new Set();
  let duration = midi.duration / rate + 2;
  async function reset() {
    if (closed) throw new Error('Preview has been closed.');
    synth?.stopAllChannels(true);
    synth = new SpessaSynthProcessor(48000, { effectsEnabled: effects, eventsEnabled: false, maxBufferSize: 128 });
    synth.onMissingPreset = (patch, system) => {
      warnings.add(`Missing bank ${patch.bankMSB}:${patch.bankLSB}, program ${patch.program + 1}; using a SoundFont fallback.`);
      return bank.getPreset(patch, system);
    };
    synth.soundBankManager.addSoundBank(bank, 'main');
    await synth.processorInitialized;
    installBankMappings(synth, bank);
    installGSEffects(synth);
    installXGVariation(synth);
    installReleaseVelocityProfiles(synth, profiles);
    // The initial pool is reusable storage, not a musical voice limit. Grow
    // instead of stealing old notes, and retain each instrument's envelopes.
    synth.setSystemParameter('autoAllocateVoices', true);
    synth.setSystemParameter('blackMIDIMode', false);
    synth.setSystemParameter('monophonicRetrigger', false);
    // Host pitch offset leaves note/gate identities, sample regions, MTS,
    // portamento and key-dependent modulators intact. Drum channels ignore it.
    synth.setSystemParameter('fineTune', transpose * 100);
    if (dsp !== 'js') {
      try {
        if (dsp === 'auto') {
          // The C scalar kernel won most representative measurements on the
          // target machine. Keep SIMD selectable rather than assuming a win.
          try { await installVoiceDSP(synth, 'wasm'); }
          catch { await installVoiceDSP(synth, 'wasm-simd'); }
        } else await installVoiceDSP(synth, dsp);
      }
      catch (error) {
        if (dsp === 'wasm') throw error;
        warnings.add(`WASM voice DSP unavailable; using JavaScript: ${error.message}`);
      }
    }
    while (synth.midiChannels.length < diagnostics.channelCount) synth.createMIDIChannel();
    sequence = new SpessaSynthSequencer(synth);
    // Samples were selected through the complete ordered command handlers.
    // The upstream approximate program scan must not touch empty regions.
    sequence.preload = sequence.skipToFirstNoteOn = false; sequence.loopCount = 0;
    sequence.playbackRate = rate;
    sequence.loadNewSongList([midi]);
    installSampleDumpBank(synth,mappings,offset=>Number(Object.keys(sequence.midiPortChannelOffsets).find(port=>sequence.midiPortChannelOffsets[port]===offset)));
    installPartControls(synth, bank, parts, partSettings); sequence.play();
    frames = renderedFrames = quietTailFrames = 0; pendingAt = 128;
  }
  function renderQuantum() {
    pending[0].fill(0); pending[1].fill(0);
    sequence.processTick(); synth.process(pending[0], pending[1], 0, 128);
    renderedFrames += 128; pendingAt = 0;
    if (renderedFrames >= Math.ceil(midi.duration / rate * 48000)) {
      let peak = 0;
      for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(pending[0][i]), Math.abs(pending[1][i]));
      quietTailFrames = synth.voiceCount || peak > 1e-6 ? 0 : quietTailFrames + 128;
      if (renderedFrames >= Math.ceil(duration * 48000) && quietTailFrames < 12000) duration = renderedFrames / 48000 + 1;
    }
  }
  function read(capacity = 2048) {
    if (closed) throw new Error('Preview has been closed.');
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('Read capacity must be a nonnegative integer.');
    const count = Math.max(0, Math.min(capacity, Math.ceil(duration * 48000) - frames));
    const channels = [new Float32Array(count), new Float32Array(count)];
    for (let at = 0; at < count;) {
      // Fixed synthesis quanta make state and PCM independent of consumer
      // reads and non-aligned seeks. Preserve the unconsumed part of a quantum.
      if (pendingAt === 128) renderQuantum();
      const take = Math.min(count - at, 128 - pendingAt);
      for (let c = 0; c < 2; c++) channels[c].set(pending[c].subarray(pendingAt, pendingAt + take), at);
      pendingAt += take; at += take; frames += take;
    }
    return channels;
  }
  await reset();
  return {
    get frame() { return frames; },
    get stats() { return { duration: duration * rate, sourceDuration: midi.duration, position: frames / 48000 * rate, playback, channels: 2,
      sampleDumps: diagnostics.sampleDumps ?? [], sampleDumpMappings: mappings,
      sampleRate: 48000, engine: 'soundfont', dsp: synth.synthCore.voiceDSP?.backend || 'js', dspCore: synth.synthCore.voiceDSP?.core || 'js', bank: bank.soundBankInfo.name, sampleBank: prepared?.sampleBank ?? { mode: 'full' }, warnings: [...warnings], diagnostics, parts: configuredParts, instruments, text, title: midi.getName() }; },
    read,
    flushThrough(seconds) {
      const now = synth.synthCore.currentTime;
      synth.synthCore.currentTime = seconds / rate + sequence.absoluteStartTime;
      try { sequence.processTick(seconds); } finally { synth.synthCore.currentTime = now; }
    },
    reset,
    capture() {
      if (closed) throw new Error('Preview has been closed.');
      const savedSynth = synth, savedSequence = sequence, state = captureSynthCheckpoint(synth, sequence, midi);
      const savedFrames = frames, savedRendered = renderedFrames, savedQuiet = quietTailFrames, savedAt = pendingAt;
      const savedPCM = pending.map(c => c.slice());
      return { bytes: state.bytes + 1024, memoryBytes: state.memoryBytes, restore() {
        if (closed) throw new Error('Preview has been closed.');
        if (synth !== savedSynth) synth.stopAllChannels(true);
        state.restore(); synth = savedSynth; sequence = savedSequence;
        frames = savedFrames; renderedFrames = savedRendered; quietTailFrames = savedQuiet; pendingAt = savedAt;
        pending.forEach((c, i) => c.set(savedPCM[i]));
      } };
    },
    async seek(seconds, { isCurrent = () => true } = {}) {
      if (!Number.isFinite(seconds)) throw new TypeError('Seek position must be finite.');
      const target = Math.round(Math.max(0, Math.min(seconds / rate, duration)) * 48000);
      if (!isCurrent()) return { cancelled: true };
      // MIDI specifies event/gate/controller semantics, not a seek algorithm.
      // Replay the same synthesis path: current channel state alone cannot
      // reconstruct an earlier preset, envelope, sample cursor or wet effect.
      if (target < frames) await reset();
      let lastYield = performance.now();
      while (frames < target) {
        if (!isCurrent()) return { cancelled: true };
        const channels = read(Math.min(2048, target - frames));
        if (!channels[0].length) break;
        if (performance.now() - lastYield >= 12) {
          await new Promise(resolve => setTimeout(resolve, 0));
          lastYield = performance.now();
        }
      }
      return isCurrent() ? { seconds: frames / 48000 * rate } : { cancelled: true };
    },
    close() { synth?.stopAllChannels(true); synth = sequence = null; closed = true; }
  };
}
