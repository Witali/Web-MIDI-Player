import { BasicMIDI, SpessaSynthProcessor, SpessaSynthSequencer, SpessaLog } from './vendor/spessasynth.js';
import { parseMidi } from './engine/src/midi.js';
import { normalizeSmpteTiming } from './midi-timing.js';

// The portable transport also accepts a complete SF2 bank when all GM timbres
// are required. Stereo, controllers and SoundFont modulators stay in the synth.
export async function createSoundFontPreview(bytes, bank, { effects = true } = {}) {
  SpessaLog.setLogLevel(false, false, false);
  const midi = normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  let heldNotes = [];
  try { heldNotes = parseMidi(new Uint8Array(midi.writeMIDI())).notes; } catch { /* Extended multi-port files still play through the native sequencer. */ }
  let synth, sequence, frames = 0;
  const warnings = new Set();
  const duration = midi.duration + 2;
  async function reset() {
    synth?.stopAllChannels(true);
    synth = new SpessaSynthProcessor(48000, { effectsEnabled: effects, eventsEnabled: false, maxBufferSize: 128 });
    synth.onMissingPreset = (patch, system) => {
      warnings.add(`Missing bank ${patch.bankMSB}:${patch.bankLSB}, program ${patch.program + 1}; using a SoundFont fallback.`);
      return bank.getPreset(patch, system);
    };
    synth.soundBankManager.addSoundBank(bank, 'main');
    await synth.processorInitialized;
    synth.setSystemParameter('autoAllocateVoices', true);
    sequence = new SpessaSynthSequencer(synth);
    sequence.skipToFirstNoteOn = false; sequence.loopCount = 0;
    sequence.loadNewSongList([midi]); sequence.play(); frames = 0;
  }
  await reset();
  return {
    get stats() { return { duration, sourceDuration: midi.duration, position: frames / 48000, channels: 2,
      sampleRate: 48000, engine: 'soundfont', bank: bank.soundBankInfo.name, warnings: [...warnings], parts: [], title: midi.getName() }; },
    read(capacity = 2048) {
      const count = Math.max(0, Math.min(capacity, Math.ceil(duration * 48000) - frames));
      const channels = [new Float32Array(count), new Float32Array(count)];
      for (let at = 0; at < count; at += 128) {
        sequence.processTick(); synth.process(channels[0], channels[1], at, Math.min(128, count - at));
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
      frames = Math.round(seconds * 48000);
      return { seconds: frames / 48000 };
    },
    close() { synth?.stopAllChannels(true); synth = sequence = null; }
  };
}
