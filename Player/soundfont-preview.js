import { BasicMIDI, SpessaSynthProcessor, SpessaSynthSequencer, SpessaLog } from './vendor/spessasynth.js';
import { parseMidi } from './engine/src/midi.js';
import { normalizeSmpteTiming } from './midi-timing.js';
import { installVoiceDSP } from './voice-dsp.js';
import { diagnoseMidi } from './midi-diagnostics.js';

// The portable transport also accepts a complete SF2 bank when all GM timbres
// are required. Stereo, controllers and SoundFont modulators stay in the synth.
export async function createSoundFontPreview(bytes, bank, { effects = true, dsp = 'auto' } = {}) {
  if (!['auto', 'wasm', 'wasm-simd', 'js'].includes(dsp)) throw new TypeError('Unknown voice DSP backend.');
  SpessaLog.setLogLevel(false, false, false);
  const midi = normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const diagnostics = await diagnoseMidi(midi, bank, { effects });
  let heldNotes = [];
  try { heldNotes = parseMidi(new Uint8Array(midi.writeMIDI())).notes; } catch { /* Extended multi-port files still play through the native sequencer. */ }
  let synth, sequence, frames = 0, quietTailFrames = 0;
  const warnings = new Set();
  let duration = midi.duration + 2;
  async function reset() {
    synth?.stopAllChannels(true);
    synth = new SpessaSynthProcessor(48000, { effectsEnabled: effects, eventsEnabled: false, maxBufferSize: 128 });
    synth.onMissingPreset = (patch, system) => {
      warnings.add(`Missing bank ${patch.bankMSB}:${patch.bankLSB}, program ${patch.program + 1}; using a SoundFont fallback.`);
      return bank.getPreset(patch, system);
    };
    synth.soundBankManager.addSoundBank(bank, 'main');
    await synth.processorInitialized;
    // The initial pool is reusable storage, not a musical voice limit. Grow
    // instead of stealing old notes, and retain each instrument's envelopes.
    synth.setSystemParameter('autoAllocateVoices', true);
    synth.setSystemParameter('blackMIDIMode', false);
    synth.setSystemParameter('monophonicRetrigger', false);
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
    sequence = new SpessaSynthSequencer(synth);
    sequence.skipToFirstNoteOn = false; sequence.loopCount = 0;
    sequence.loadNewSongList([midi]); sequence.play(); frames = quietTailFrames = 0;
  }
  await reset();
  return {
    get stats() { return { duration, sourceDuration: midi.duration, position: frames / 48000, channels: 2,
      sampleRate: 48000, engine: 'soundfont', dsp: synth.synthCore.voiceDSP?.backend || 'js', dspCore: synth.synthCore.voiceDSP?.core || 'js', bank: bank.soundBankInfo.name, warnings: [...warnings], diagnostics, parts: [], title: midi.getName() }; },
    read(capacity = 2048) {
      const count = Math.max(0, Math.min(capacity, Math.ceil(duration * 48000) - frames));
      const channels = [new Float32Array(count), new Float32Array(count)];
      for (let at = 0; at < count; at += 128) {
        const size = Math.min(128, count - at);
        sequence.processTick(); synth.process(channels[0], channels[1], at, size);
        const endFrame = frames + at + size;
        if (endFrame >= Math.ceil(midi.duration * 48000)) {
          let peak = 0;
          for (let i = at; i < at + size; i++) peak = Math.max(peak, Math.abs(channels[0][i]), Math.abs(channels[1][i]));
          quietTailFrames = synth.voiceCount || peak > 1e-6 ? 0 : quietTailFrames + size;
          // A two-second estimate must never truncate a real voice or wet tail.
          // Wait for 250 ms of quiet and grow the advertised duration as needed.
          if (endFrame >= Math.ceil(duration * 48000) && quietTailFrames < 12000) duration = endFrame / 48000 + 1;
        }
      }
      frames += count; return channels;
    },
    reset,
    async seek(seconds) {
      await reset();
      sequence.currentTime = Math.min(seconds, midi.duration); sequence.play();
      // The sequencer restores bank/program/controller/pitch state without
      // rendering all preceding PCM. Retrigger notes whose effective gate is
      // still open, including notes held by the sustain pedal.
      for (const note of heldNotes) if (!note.percussion && note.start < seconds && note.end > seconds) {
        synth.noteOn(note.channel, note.pitch, note.velocity);
        if (note.keyOff < seconds) synth.noteOff(note.channel, note.pitch);
      }
      frames = Math.round(seconds * 48000); quietTailFrames = 0;
      return { seconds: frames / 48000 };
    },
    close() { synth?.stopAllChannels(true); synth = sequence = null; }
  };
}
