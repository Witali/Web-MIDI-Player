import { MIDIMessage, MIDIMessageTypes } from './vendor/spessasynth.js';

// SpessaSynth 4.3.22 treats the division field as PPQN. Translate SMPTE to an
// equivalent fixed-tempo PPQN clock in memory, keeping every absolute tick.
// SMF RP-001: frame code -29 means 30000/1001 fps, not exactly 29 or 30 fps.
export function normalizeSmpteTiming(midi) {
  const division = midi.timeDivision;
  if (!(division & 0x8000)) return midi;
  const frameCode = 256 - (division >> 8), ticksPerFrame = division & 255;
  if (![24, 25, 29, 30].includes(frameCode) || !ticksPerFrame) {
    throw new Error('Invalid MIDI SMPTE time division: expected frame code -24, -25, -29 or -30 and nonzero ticks per frame.');
  }
  const tempo = frameCode === 29 ? 1001000 : 1000000;
  midi.timeDivision = (frameCode === 29 ? 30 : frameCode) * ticksPerFrame;
  const tempoData = () => new Uint8Array([tempo >> 16, (tempo >> 8) & 255, tempo & 255]);
  // A Set Tempo in any track must not change the SMPTE clock. Replace it at
  // the same tick instead of deleting events or changing their relative order.
  for (const track of midi.tracks) for (const event of track.events) {
    if (event.statusByte === MIDIMessageTypes.setTempo) event.data = tempoData();
  }
  midi.tracks[0].addEvents(0, new MIDIMessage(0, MIDIMessageTypes.setTempo, tempoData()));
  midi.flush(false); // Refresh the duration, tempo map and sequencer timeline.
  return midi;
}
