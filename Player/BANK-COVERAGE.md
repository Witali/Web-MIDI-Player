# FluidR3 GM + GS bank coverage

The default browser bank combines the original FluidR3 GM 3.1 and its FluidR3
GS 3.1 supplement, both released under the [MIT license](licenses/FluidR3-MIT.txt).
The supplement adds 32 melodic sound effects and one GS SFX kit: 33 presets,
48 sample entries and 36 additional encoded files (662,466 bytes). Every old
GM recording is unchanged; merging reindexes internal sample references.
The combined bank has 190 melodic presets, 32 drum presets and 1,466 sample
entries in 1,454 independent recordings (32,475,433 encoded bytes).

## Sources and reproducibility

[FluidR3 source and license](https://sources.debian.org/src/fluid-soundfont/3.1-5.3/)
identify both original SF2 files. Pinned package/SF2 hashes, sizes and URLs are
in [PROVENANCE.json](PROVENANCE.json). Setup verifies both original banks;
the builder merges GM first, retaining any existing patch, then GS. It reuses
previous verified recordings only when original PCM hash, sample rate and
encoding settings match. Unused compressed files are removed only after
checking their content-addressed names. The static public export includes the
combined metadata/samples and MIT notice, without either full SF2.

GeneralUser GS was evaluated as another candidate. Its [author's license](https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/documentation/LICENSE.txt)
permits software use but records uncertainty about some sample origins.
It is not bundled; the selected supplement uses the same documented MIT
source as our existing bank. This is a selection policy, not a legal guarantee
that no third party could ever assert a claim.

## Address tables

- [presets.csv](soundfonts/fluidr3-gm/presets.csv): every real preset, bank
  MSB/LSB, zero-based Program Change, percussion flag and actual FluidR3 name.
- [mappings.json](soundfonts/fluidr3-gm/mappings.json): all 258 explicit
  substitutions, with requested system/address and selected source address/name.
- [inventory.json](soundfonts/inventory.json): the same actual preset inventory
  using one-based display programs. Its drum flag is separate from bank MSB.

GS uses its actual MSB/Program addresses. GM2 provides 199 explicit mappings:
128 base melodic categories, 30 existing variations, 32 added SFX categories
and nine main drum kits. XG provides 59: 18 melodic variations, 33 SFX categories
and eight main drum kits, in addition to its 128 directly matching bank-zero
melodic programs. These are category-equivalent FluidR3 substitutions. They
are not Yamaha/Roland recordings or a claim of identical hardware sound.

| Request (zero-based) | Selected FluidR3 preset |
|---|---|
| GS MSB 1, LSB 0, PC 122 | Rain at GS 1:0:122 |
| GM2 MSB 121, LSB 1, PC 122 | Rain at GS 1:0:122 |
| XG MSB 64, LSB 0, PC 32 | Rain at GS 1:0:122 |
| GM2 MSB 121, LSB 2, PC 25 | Mandolin at GS 16:0:25 |
| XG MSB 0, LSB 96, PC 25 | Mandolin at GS 16:0:25 |
| GM2 MSB 120, LSB 0, PC 56 | GS SFX percussion kit |

The profile is enabled only for the verified combined default bank. Native
presets at the requested address take priority, including embedded banks.
Each profile mapping is reported as a preset substitution, including its
requested/actual address, actual name, profile and timeline position. Custom
banks without this profile keep their existing selection behavior.

There is no blind GS-MSB to XG/GM2-LSB conversion. Unlisted requests go through
the existing fallback selector, with an explicit substitution report. A bank
number alone is not proof of the requested instrument's presence. GS map LSBs,
other manufacturers' expansions and every XG variation are not fully covered.
In particular, the XG SFX percussion kits at MSB 126 use a different key map;
they are recognized as drums but are not falsely presented as the GS SFX kit.
Their absence is reported and falls back to an available drum preset.

The portable example includes a generated GS/XG demo for inspecting these
substitutions in a real browser. It contains no downloaded MIDI composition.

## Specification checks and tests

[MIDI 1.0](specs/README.md) p.13: Bank Select does not change the sounding
preset until Program Change. [GM2 v1.2a](https://midi.org/general-midi-2)
pp.5-6 defines melody bank 121, rhythm bank 120 and their program-change
commit point. Appendix A pp.25-31 supplies variation/SFX addresses; Appendix B
pp.32-34 supplies percussion. Recommended fallback to the base category does
not certify a bank as implementing the entire GM2 sound set.

[Yamaha PSR-2000/1000 Data List](https://usa.yamaha.com/files/download/other_assets/7/321057/PSR2000E2.pdf)
pp.7-9 supplies XG voice addresses; pp.10-11 distinguishes MSB 127 normal
kits from MSB 126 SFX kits. Program numbers in that table are zero-based.
[Roland SC-8850 manual](https://cdn.roland.com/assets/media/pdf/SC-8850_OM.pdf)
pp.146-147 explains the distinct GS/GM2 bank conventions. PDFs were read and
tables visually checked; hashes are in the specification notes.

Player/tests/bank-coverage.test.mjs checks every added preset for real audible
finite stereo on JS/WASM/SIMD, every explicit mapping and its diagnostics,
independent GS MIDI PCM references, exact seeks, bank-select order, ports,
native patch priority, missing XG SFX kits, Worker configuration/sample reuse,
and the exact old recording fingerprint. All 128 GM programs also retain
bit-identical PCM against independent original SF2 preset/instrument maps
with the unchanged encoded recordings, including wet effects on all DSPs.
