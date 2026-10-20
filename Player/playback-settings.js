export const defaultPlayback = () => ({ rate: 1, transpose: 0, loop: null });
export function normalizePlaybackPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Expected playback settings.');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'rate') {
      if (!Number.isFinite(value) || value < .25 || value > 4) throw new RangeError('Playback rate must be between 0.25 and 4.');
      result.rate = value;
    } else if (key === 'transpose') {
      if (!Number.isInteger(value) || Math.abs(value) > 48) throw new RangeError('Transpose must be an integer from -48 to 48.');
      result.transpose = value;
    } else if (key === 'loop') {
      if (value === null || value === false) result.loop = null;
      else if (value === true) result.loop = true;
      else if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => k === 'start' || k === 'end') && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start)
        result.loop = { start: value.start, end: value.end };
      else throw new RangeError('Loop must be false, true or { start, end } in source seconds.');
    } else throw new TypeError('Unknown playback setting: ' + key);
  }
  return result;
}
export function resolvePlayback(settings, sourceDuration) {
  const result = { ...defaultPlayback(), ...normalizePlaybackPatch(settings) };
  if (result.loop === true) result.loop = { start: 0, end: sourceDuration };
  if (result.loop) {
    const { start, end } = result.loop;
    if (!Number.isFinite(sourceDuration) || end > sourceDuration || end <= start) throw new RangeError('Loop must fit within the MIDI sequence, excluding the effect tail.');
    if (Math.round(end / result.rate * 48000) - Math.round(start / result.rate * 48000) < 128) throw new RangeError('Loop must contain at least 128 output samples.');
  }
  return result;
}
