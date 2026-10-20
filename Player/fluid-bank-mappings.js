import { SpessaLog } from './vendor/spessasynth.js';
export const FLUID_GS_SHA256 = 'aadb5597fb95ea5f7d336999e3c68ad32aa6357027aed7d4d9ff0ac75f2988e6';
export const FLUID_PROFILE = 'fluidr3-gm-gs-v1';
// These are explicit category-equivalent FluidR3 substitutions, not hardware
// sample emulations. Addresses are zero-based; references are in BANK-COVERAGE.md.
const rows = [];
const add = (system, msb, lsb, program, sourceMSB, sourceProgram = program, sourceDrum = false) => rows.push({
  system, requested: { bankMSB: msb, bankLSB: lsb, program, isGMGSDrum: false },
  source: { bankMSB: sourceMSB, bankLSB: 0, program: sourceProgram, isGMGSDrum: sourceDrum }
});
for (let p = 0; p < 128; p++) add('gm2', 121, 0, p, 0);
// GM2 Appendix A: the same categories use LSB variations, not GS MSB numbers.
for (const [p, lsb, gs] of [[4,1,8],[5,1,8],[6,1,8],[14,1,8],[16,1,8],[17,1,8],[19,1,8],[21,1,8],
  [24,1,8],[25,1,8],[25,2,16],[26,1,8],[28,1,8],[30,1,8],[31,1,8],[38,2,8],[39,1,8],
  [40,1,8],[48,1,8],[50,1,8],[61,1,8],[62,1,8],[63,1,8],[80,2,8],[107,1,8],
  [115,1,8],[116,1,8],[117,1,8],[118,1,8],[125,9,9]]) add('gm2',121,lsb,p,gs);
// Every added GS melodic SFX category appears in GM2 Appendix A p.31.
for (const [p, count] of [[120,2],[121,1],[122,5],[123,3],[124,5],[125,8],[126,5],[127,3]])
  for (let variation = 1; variation <= count; variation++) add('gm2',121,variation,p,variation);
// Yamaha PSR-2000/1000 Data List, XG voices, pp.7-9.
for (const [p, lsb, gs] of [[4,32,8],[5,32,8],[14,96,8],[16,32,8],[17,32,8],[19,35,8],[21,32,8],
  [24,96,8],[25,35,8],[25,96,16],[30,40,8],[31,65,8],[80,65,8],[107,96,8],
  [115,96,8],[116,96,8],[117,64,8],[118,64,8]]) add('xg',0,lsb,p,gs);
const xgSfx = [[0,120,1],[3,120,2],[16,121,1],[32,122,1],[33,122,2],[34,122,3],[35,122,4],[36,122,5],
  [48,123,1],[49,123,2],[50,123,3],[64,124,1],[65,124,2],[66,124,3],[67,124,4],[69,124,5],
  [80,125,1],[81,125,2],[82,125,3],[83,125,4],[84,125,5],[85,125,6],[86,125,7],[87,125,8],[88,125,9],
  [96,126,1],[97,126,2],[98,126,3],[99,126,4],[100,126,5],[112,127,1],[113,127,2],[114,127,3]];
for (const [xgProgram, gsProgram, variation] of xgSfx) add('xg',64,0,xgProgram,variation,gsProgram);
// Main kit categories only. XG SFX kits have a different key map and must not
// be represented as an exact GS kit; unknown addresses retain diagnostics.
for (const p of [0,8,16,24,25,32,40,48]) { add('gm2',120,0,p,0,p,true); add('xg',127,0,p,0,p,true); }
add('gm2',120,0,56,0,56,true);
export const FLUID_MAPPINGS = Object.freeze(rows.map(r => Object.freeze({ ...r, requested: Object.freeze(r.requested), source: Object.freeze(r.source) })));
const key = p => [!!p.isGMGSDrum,p.bankMSB,p.bankLSB,p.program].join(':');
const byAddress = new Map(FLUID_MAPPINGS.map(row => [row.system+':'+key(row.requested), row]));
const matches = (a,b) => !!a.isGMGSDrum === !!b.isGMGSDrum && a.program === b.program && (a.isGMGSDrum || (a.bankMSB === b.bankMSB && a.bankLSB === b.bankLSB));
export function fluidProfile(manifest) {
  if (manifest.profile === undefined) return undefined; // Existing GM-only custom deployments.
  if (manifest.profile !== FLUID_PROFILE || !Array.isArray(manifest.supplements) || manifest.supplements.length !== 1 || manifest.supplements[0].sha256 !== FLUID_GS_SHA256)
    throw new Error('Invalid FluidR3 GS source profile.');
  return FLUID_PROFILE;
}
export function installBankMappings(synth, bank) {
  if (bank.hostProfile !== FLUID_PROFILE) return;
  const manager = synth.soundBankManager, select = manager.getPreset.bind(manager);
  manager.getPreset = (incoming, system) => {
    const requested = incoming.isGMGSDrum && (system === 'xg' || system === 'gm2')
      ? { ...incoming, isGMGSDrum: false, bankMSB: system === 'xg' ? 127 : 120, bankLSB: 0 } : incoming;
    // A real preset at the requested address always takes precedence, including
    // an embedded bank. Mappings never lock a channel or discard MIDI commands.
    if (!manager.selectablePresetList.some(p => matches(p,requested))) {
      const row = byAddress.get(system+':'+key(requested));
      const target = row && manager.selectablePresetList.find(p => matches(p,row.source));
      if (target) {
        const describe = p => ({ bankMSB:p.bankMSB, bankLSB:p.bankLSB, program:p.program, isGMGSDrum:!!p.isGMGSDrum, name:p.name });
        SpessaLog.onDiagnostic?.({ kind:'substituted', feature:'preset', requested:describe(requested), actual:describe(target), system, mapping:FLUID_PROFILE });
        return target;
      }
    }
    return select(incoming,system);
  };
}
