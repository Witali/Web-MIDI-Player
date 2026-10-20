# MIDI file playback plan: completion audit

Verified on 2026-10-20 against implementation commit `08af299` and the current
[improvement plan](IMPROVEMENT-PLAN.md). This audit covers its 25 file-playback
items and the user's requirements to preserve ordered MIDI execution, embedded
tempo maps and selective sample loading. The user explicitly excluded external
synchronization, hardware/live MIDI, outbound dumps, public MIDI 2.0/UMP input
and Z80 expansion. Existing excluded features are outside this completion claim.

## Current verification

- `npm test`: **339 passed, 0 failed, 0 skipped**. Includes the actual Worker,
  AudioWorklet transport, selective bank preparation and JS/scalar-WASM/SIMD PCM
  comparisons; 16 tests specifically cover CA-019 Extended SDS.
- `npm run test:core`: **42,565 native C checks passed**. Regenerated native golden
  output matches the tracked fixture. The JS suite compares scalar/SIMD WASM
  against this native result, not only against each other.
- All source/binary hashes in `dsp/build.json` match current files. C sources,
  WASM binaries and ABI are unchanged by the Extended SDS implementation.
- `verifyBrowserBank()` verified the metadata, MIT notice and every independent
  recording for all **1,466 sample entries**. Preset/mapping tests authenticate
  the old GM recordings, real GS presets and explicit substitutions.
- `node public-catalog.mjs`: 8 files, 0 catalog issues. `node catalog.mjs`: 8,485
  files, 8,390 readable, with 94 reported collection issues. The latter are input
  collection diagnostics, not a claim that malformed downloaded files were fixed.
  Neither build modifies the source MIDI files. Both exported Player directories
  contain byte-identical updated runtime modules, including the new oscillator,
  and their sample-bank adapter modules import successfully.
- Browser smoke check of the freshly generated public catalog: Turkish March
  loaded and played, transport advanced, pause worked, speed 1.25 applied with
  a success message and returned to 1.0. The parts dialog exposed both receiver
  channels, mute/solo, gain/pan and actual preset choices. Playback was left paused.
  This smoke check supplements the automated independent PCM/Worker tests.
- `git diff --check` passed. Runtime, documentation, source references and tests
  are committed as focused changes; generated catalogs and cached PDFs/logs stay
  outside Git.

## Requirement evidence

Every row is satisfied within the stated scope. The evidence is the current
implementation plus executed assertions, not the presence of a checked box.
Paths below are relative to this directory.

| # | Plan requirement | Concrete verification and artifacts |
|---:|---|---|
| 1 | No fixed voice stealing limit | `tests/soundfont.test.mjs` measures 1,024 notes against a single-note amplitude oracle and restores them after seek; `tests/stereo.test.mjs` and `tests/active-voices.test.mjs` cover parser/pool growth, retained tails and allocation boundaries. |
| 2 | MIDI owns note lifetime | `tests/gate-release.test.mjs` asserts dispatch-time release and exclusive choke without gate extensions, plus owed Note Off identities after CC120; `tests/soundfont.test.mjs` measures sustain, CC123 and immediate silence. |
| 3 | Instrument envelopes and overlapping notes | `tests/soundfont.test.mjs` measures independent pad/lead attack/release windows and compares repeated-note PCM against the sum of separate notes with a still-audible old tail. |
| 4 | WASM, measured benefit and JS fallback | `tests/soundfont.test.mjs` compares all 128 GM programs and 47 drums with effects on/off, and simulates unavailable WASM; `DSP-PERFORMANCE.md` retains before/after measurements. The current dense validation below confirms benefit without changing the conservative auto order. |
| 5 | One C source and three test levels | `native/{dsp.c,envelopes.c,effects.c,dsp.h}`, `native/test_dsp.c`, `tests/dsp.test.mjs`, `tests/native-dsp-golden.json` and `dsp/build.json` prove native/WASM/JS ABI, rounding, effects, checksums and no JavaScript math imports; actual Worker tests exercise the public path. |
| 6 | SMPTE timing | `tests/midi-timing.test.mjs` checks all four frame codes, 30000/1001, ticks/frame boundaries, one-hour timing, RMID, unchanged PPQN and malformed divisions; `tests/soundfont.test.mjs` and `tests/transport.test.mjs` check actual note/pan timing and Worker seek. |
| 7 | Exact seeking | `tests/seeking.test.mjs` compares raw PCM bytes against continuous rendering, covering old timbres, pedals, repeated notes, separate ports, percussion, effects and arbitrary reads; `tests/checkpoint.test.mjs` includes later pool/memory growth and partial SysEx. |
| 8 | Natural tails | `tests/soundfont.test.mjs` proves audible release/reverb beyond source+2 seconds and a quiet final block; `tests/transport.test.mjs` and `tests/worklet-loop.test.mjs` cover EOF, duration/read transport and resampling. Explicit Stop remains available for indefinitely held notes. |
| 9 | Ordered SMF F0/F7 stream | `tests/smf-events.test.mjs` checks exact event/wire order, running-status cancellation, real-time interleaving, fragments, ports, large payloads, roundtrip and final EOT. `tests/event-order.test.mjs` protects trailing/controller-only events. |
| 10 | CC66/68/69 behavior | `tests/pedals.test.mjs` verifies rising-edge sostenuto capture, legato phase/envelope continuity, fallback and pedal combinations; `tests/hold2.test.mjs` checks both frozen envelopes, deferred/releasing notes, reset/ports and independent PCM/seek on all DSPs. |
| 11 | CC96/97 relative entry | `tests/parameters.test.mjs` verifies independent RPN/NRPN values, null/selectors, RP-018 step units/carry/saturation, RP-015 reset, snapshots, live retuning and PCM equivalent to absolute commands. |
| 12 | Note Off velocity | `tests/release-velocity.test.mjs` covers all 128 values, Note On zero=64, independent note identities, SMF/F7/ports/Worker, both envelope profiles and ordinary SF2 unchanged PCM; response profiles are explicit host extensions. |
| 13 | Compatibility diagnostics | `tests/diagnostics.test.mjs` asserts real selected/fallback patches, implemented vs unsupported/unverified, timeline/track/port/channel scope, bounded aggregation and export data; `tests/transport.test.mjs` checks public Worker reports and clearing on load. |
| 14 | Additional GS/XG/GM2 timbres | `tests/bank-coverage.test.mjs` authenticates source identities and tables, plays all 33 added presets, verifies all 258 mappings and unchanged GM PCM; `BANK-COVERAGE.md`, `PROVENANCE.json`, `licenses/FluidR3-MIT.txt` and `soundfonts/fluidr3-gm/{presets.csv,mappings.json}` record sources and honest replacements. |
| 15 | GS/XG effects | `tests/gs-effects.test.mjs`, `tests/xg-{variation,variation-models,system-effects,drive,insertion,insertion-slots}.test.mjs` validate manufacturer addresses/units/ranges, unknown Thru, impulse diagrams, independent delayed/nonlinear PCM, slot order/control sources, ports, Worker and exact restored histories. Proprietary hardware DSP curves remain documented host models. |
| 16 | Incoming playback-relevant MTS/SDS | `tests/midi-tuning.test.mjs` covers banks/programs, RPN3/4, exact fractions, no-change, masks, RT/NRT held voices and seeks. `tests/sample-dump.test.mjs` checks exact 8..28-bit words, XOR/sequence/retry/wrap/CANCEL, mapping and audible banks. `tests/extended-sds.test.mjs` independently verifies CA-019 counts/rates/channels/names, all ten loop types and both release legs, actual PCM, full budgets, fragments/ports, Worker and exact seeks after memory growth. |
| 17 | Part controls and UI | `tests/part-controls.test.mjs` compares mute/solo/gain/pan/overrides with independent MIDI and preserves command execution, ports, held phase, selective downloads, failures/retry and public/Worker reconstruction. `parts-view.js` is used by catalogs/example; current browser smoke confirms controls and real presets. |
| 18 | Rate, transpose, whole/A-B loops | `tests/playback-settings.test.mjs`, `tests/worklet-loop.test.mjs`, `tests/checkpoint.test.mjs` and `tests/tempo-playback.test.mjs` check PPQN tempo changes, SMPTE independence, pitch/percussion, original source time, arbitrary A/B PCM, ordered B commands, text, underruns, cancellation and all DSPs; `playback-view.js` provides the shared UI. |
| 19 | Text and displays | `tests/midi-text.test.mjs` validates original bytes/types/encodings, lyrics, karaoke, markers/cues, Channel Prefix, ports, GS/XG partial letters/bitmap and final F7; original clocks, stop/seek reconstruction and unchanged PCM are asserted. `text-view.js` is shared by catalogs/example. |
| 20 | Load sample files as needed | `tests/lazy-bank.test.mjs` observes requests, linked/stereo regions, all 128 GM/47 drums, changing patches, F7/ports and resets; hashes, cancellation, concurrency, bounded LRU, damaged data/retry and exact full/selective PCM are asserted. Public export tests omit full SF2 and verify standalone sample files. |
| 21 | Reuse identical source waves | `tests/dsp.test.mjs` and `native/test_dsp.c` verify cache identity, exact cursor/step/loop fields, collisions, EOF, unique waves beyond capacity and adaptive bypass; `dsp/benchmark-algorithm-{mixed,unison,staggered}.json` and `DSP-PERFORMANCE.md` document benefit and overhead without dropping voices. |
| 22 | Batch voices to C | `tests/voice-batch.test.mjs` compares immediate/batched render order, interpolation, captures, odd/final blocks and pool/payload/native growth, with exact restored histories; `dsp/benchmark-voice-batch-{wasm,simd,cold}.json` records call reduction and measured overhead, without claiming an unproven universal speedup. |
| 23 | Walk only active voices | `tests/active-voices.test.mjs` compares allocation/PCM with a linear oracle, instruments inactive-slot reads and checks note/EOF/cap/checkpoint growth; `dsp/benchmark-active-voices-{wasm,other}.json` retains paired dense, sparse, controller and silence measurements. |
| 24 | SIMD across independent voices | `tests/independent-voices.test.mjs` compares every PCM/state byte to sequential native/in-module oracles with 2,053 voices and dependency fallbacks; `tests/voice-batch.test.mjs` covers effects/controls/checkpoints. `dsp/benchmark-independent-simd*.json` records pair counters, dense/unique-step benefits and small-part overhead. |
| 25 | Event queues without front shifts | `tests/event-queue.test.mjs` instruments head-only reads, stable sorts/equal-time FIFO, reentrant dispatch, falsey notes, released references, compaction and checkpoints; `dsp/benchmark-event-queues.json` compares actual previous/current scheduled MIDI, ordinary SMF and both note readers with exact PCM or JSON as appropriate. |

Primary MIDI/SMF/addendum sources, exact hashes and manufacturer-page references
are in [specs/README.md](specs/README.md) and
[specs/IMPLEMENTATION-NOTES.md](specs/IMPLEMENTATION-NOTES.md). Unknown extensions
and unavailable sounds remain explicit diagnostic findings. Completing this plan
does not claim support for every future/vendor-specific MIDI message or exact
hardware synthesis.

## Current dense-render measurement

Implementation `08af299`; AMD Ryzen 5 5600X; Node v22.22.3; 1,024 notes on
15 channels, Piano/Strings/Flute/Pad, stereo pan, effects explicitly on/off.
Three order-rotated rounds; 0.25 s warmup and 0.5 s measured audio per run;
initialization and bank loading excluded. Medians in milliseconds:

| Effects | JS | Scalar WASM | SIMD WASM | JS/scalar | JS/SIMD |
|---|---:|---:|---:|---:|---:|
| off | 621.06 | 453.51 | 436.45 | 1.37x | 1.42x |
| on | 803.40 | 555.71 | 517.61 | 1.45x | 1.55x |

Raw rounds, build manifest and source hashes are in
[dsp/benchmark-plan-completion.json](dsp/benchmark-plan-completion.json).
This is a current dense validation, not a repeat of every historical optimization
comparison or a guarantee of real-time performance on all files/hardware. PCM
correctness comes from the independent assertions above; the timing-only tool
is not counted as another PCM comparison. Full comparative methodology and
rejected experiments remain in [DSP-PERFORMANCE.md](DSP-PERFORMANCE.md).

Reproduce this timing series from the repository root:

```sh
node Player/tools/benchmark-polyphony.mjs --notes 1024 --rounds 3 --seconds 0.5 --output results.json
```

All 25 requirements have current implementation and verification evidence.
There is no remaining implementation item in the agreed file-playback plan.
