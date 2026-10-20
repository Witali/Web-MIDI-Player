// Host playback settings are independent of the MIDI controller/program state.
const byte = n => Number.isInteger(n) && n >= 0 && n < 128;
export const instrumentKey = p => JSON.stringify([p.bankMSB, p.bankLSB, p.program, p.percussion]);
export function normalizePartPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Expected part settings.');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'muted' || key === 'solo') {
      if (typeof value !== 'boolean') throw new TypeError(key + ' must be boolean.');
      result[key] = value;
    } else if (key === 'volume' || key === 'pan') {
      if (!Number.isFinite(value) || value < (key === 'pan' ? -1 : 0) || value > 1) throw new RangeError('Invalid part ' + key + '.');
      result[key] = value;
    } else if (key === 'instrument') {
      if (value === null) { result.instrument = null; continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['program', 'bankMSB', 'bankLSB', 'percussion'].includes(k))) throw new TypeError('Invalid instrument.');
      const { program, bankMSB = 0, bankLSB = 0, percussion = false } = value;
      if (![program, bankMSB, bankLSB].every(byte) || typeof percussion !== 'boolean') throw new RangeError('Invalid instrument address.');
      result.instrument = { program, bankMSB, bankLSB, percussion };
    } else throw new TypeError('Unknown part setting: ' + key);
  }
  return result;
}
export function updatePartSettings(parts, instruments, settings, id, patch) {
  if (!parts.some(p => p.id === id)) throw new RangeError('Unknown MIDI part: ' + id);
  const change = normalizePartPatch(patch);
  if (change.instrument && !instruments.some(p => instrumentKey(p) === instrumentKey(change.instrument))) throw new RangeError('Instrument is not available in this SoundFont.');
  return { ...settings, [id]: { ...settings[id], ...change } };
}
export function describeInstruments(bank) {
  return bank.presets.map(p => ({ name: p.name, bankMSB: p.bankMSB, bankLSB: p.bankLSB,
    program: p.program, percussion: !!p.isGMGSDrum }));
}
export function describeParts(parts, settings = {}) {
  return parts.map(p => ({ ...p, muted: false, solo: false, volume: 1, pan: 0, instrument: null, ...settings[p.id] }));
}
export function installPartControls(synth, bank, parts, settings = {}) {
  const rows = describeParts(parts, settings), anySolo = rows.some(p => p.solo);
  const overrides = new Map(), core = synth.synthCore;
  for (const row of rows) {
    while (synth.midiChannels.length <= row.synthChannel) synth.createMIDIChannel();
    const channel = synth.midiChannels[row.synthChannel];
    // Gain zero retains voices, phase, gates, pedals and every incoming command.
    channel.setSystemParameter('gain', row.muted || (anySolo && !row.solo) ? 0 : row.volume);
    channel.setSystemParameter('pan', row.pan);
    if (row.instrument) {
      const preset = bank.presets.find(p => instrumentKey({ ...p, percussion: !!p.isGMGSDrum }) === instrumentKey(row.instrument));
      const mapping=core.sampleDumpBank?.mappingForPatch(row.instrument);
      if (!preset&&!mapping) throw new RangeError('Instrument is not available in this SoundFont.');
      overrides.set(row.synthChannel, mapping?()=>core.sampleDumpBank.presetForAddress(row.instrument)??preset:()=>preset);
    }
  }
  const getVoices = core.getVoices.bind(core);
  core.getVoices = (channel, key, velocity) => {
    const preset = overrides.get(channel)?.();
    // Select the exact bank preset independently of subsequent GS/XG mode and
    // bank-selection interpretation; MIDI's own patch continues to update.
    return preset ? core.getVoicesForPreset(preset, key, velocity) : getVoices(channel, key, velocity);
  };
}
