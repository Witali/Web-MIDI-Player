// MIDI leaves the audible release-velocity response to the receiving instrument.
// SF2 has no standard Note Off source; these explicit host profiles do not
// reinterpret reserved SF2 modulator numbers or alter the Note On velocity.
const key = p => [p.bankMSB, p.bankLSB, p.program, Number(p.percussion ?? p.isDrum)].join(':');
export function normalizeReleaseVelocityProfiles(profiles = []) {
  if (!Array.isArray(profiles)) throw new TypeError('releaseVelocityProfiles must be an array.');
  const seen = new Set();
  const byte = (value, name) => {
    if (!Number.isInteger(value) || value < 0 || value > 127) throw new RangeError(name + ' must be an integer from 0 to 127.');
    return value;
  };
  return Object.freeze(Array.from(profiles, row => {
    if (!row || typeof row !== 'object') throw new TypeError('Invalid release velocity profile.');
    const profile = { bankMSB: byte(row.bankMSB ?? 0, 'bankMSB'), bankLSB: byte(row.bankLSB ?? 0, 'bankLSB'),
      program: byte(row.program, 'program'), percussion: row.percussion ?? false };
    if (typeof profile.percussion !== 'boolean') throw new TypeError('percussion must be boolean.');
    for (const name of ['volumeRelease', 'modulationRelease']) {
      const curve = row[name]; if (curve === undefined) continue;
      if (!Array.isArray(curve) || curve.length !== 128 || Array.from(curve).some(n => !Number.isFinite(n) || Math.abs(n) > 12000))
        throw new RangeError(name + ' must contain 128 finite timecent offsets from -12000 to 12000.');
      profile[name] = Object.freeze([...curve]);
    }
    if (!profile.volumeRelease && !profile.modulationRelease) throw new TypeError('A release velocity profile needs a release curve.');
    const id = key(profile); if (seen.has(id)) throw new TypeError('Duplicate release velocity profile: ' + id);
    seen.add(id); return Object.freeze(profile);
  }));
}

export function installReleaseVelocityProfiles(synth, profiles = []) {
  const rows = normalizeReleaseVelocityProfiles(profiles), table = new Map(rows.map(p => [key(p), p]));
  synth.synthCore.releaseVelocityProfileForPreset = preset => table.get(key(preset));
  // Existing voices retain their original instrument's profile; later attacks
  // get the new one even if their key/velocity was already cached.
  synth.clearCache();
}
