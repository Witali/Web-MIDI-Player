# Portable C audio core

`dsp.c` is the source of both scalar and SIMD128 WebAssembly modules. The same
source compiles to a native executable for independent C tests. No fixed voice
count is encoded in the core: the host grows its sample/state arena and submits
every sounding voice, including release tails.

The core implements Hermite interpolation, the biquad filter, volume and
modulation envelope evaluation, gain ramps, stereo mixing, effect sends, chorus,
delay lines and Dattorro reverb. Float64 arithmetic, explicit
Float32 stores and disabled floating-point contraction retain reference rounding.
`DspScratch` and the exported ABI are defined in `dsp.h`; invalid block sizes
and loop parameters are rejected before writing buffers.

```sh
node tools/test-core.mjs
node tools/build-core.mjs --emsdk /path/to/emsdk
node --test tests/*.test.mjs
```

The tested toolchain is Emscripten 6.0.12. Scalar and SIMD modules are generated
from the same C source, with `-msimd128` added for SIMD. Build flags and source
hashes are recorded in `dsp/build.json`. Native tests use MSVC on Windows or
`cc` on Linux/macOS; pass `--vcvars PATH` or `--cc PATH` when needed. Build
products stay under `.cache/native-tests/`.

Native tests cover impulse response, state continuity, gain ramps, pan, effect
routing, loop wrapping, sample EOF, invalid input and 4096 overlapping voices.
The native executable generates `tests/native-dsp-golden.json`; JavaScript tests
compare both WASM modules against that output. Full player tests compare GM
instruments, drums, envelopes, MIDI controls, transport and JS fallback.

The C module imports no JavaScript DSP or math functions. The host supplies
bank lookup tables and refreshes cached typed arrays after memory growth.
Volume envelope evaluation and voice rendering share one call per voice on
sparse/legacy paths. The main stereo wrapper batches blocks with at least 16
listed voices into one render export. Modulation envelopes may still require
individual C calls while the host prepares pitch/cutoff.

The host calls `dsp_begin_block()` before rendering each audio quantum. A
bounded waveform cache can then reuse Hermite output only when source pointer,
all loop/end parameters, block length and exact cursor/step bits match. Each
voice still runs its own envelope, filter, gains, stereo routing and sends in
the original order. Collisions recompute and replace an entry; they never
remove a voice. EOF results preserve the reference cursor semantics.

The cache occupies about 0.56 MiB and the module starts with 1 MiB of memory;
the sample/state arena continues to grow. It enables after at least 50% reuse,
remains enabled above 25%, and otherwise probes once every 16 quanta. This
avoids copying unique waveforms continually. `dsp_get_cache_stats()` returns
three uint32 values: hits, misses and enabled for the current block. Native
users who do not call `dsp_begin_block()` retain the uncached renderer.

JavaScript still parses MIDI/SF2, schedules events, calculates SoundFont generator
parameters and handles the public transport. Envelope initialization/release
parameter setup, LFO control calculations, advanced GS/XG insertion effects and
some effect routing remain in SpessaSynth. CA-019 Extended SDS uses the host
source-path oscillator for its backward/bidirectional/release-loop interpolation;
C/WASM still processes its envelopes, filter, batch mixing and effects. The per-sample main voice, chorus,
delay-line and Dattorro loops run in C/WASM. This is not a claim that every
controller or vendor extension has been rewritten in C.

The WAT prototype remains in branch `experiment/wasm-voice-dsp`. The source
Z80 tester project is not modified. The adapted SpessaSynth algorithms retain
their Apache-2.0 license; see [NOTICE](NOTICE).

## Batch extension 1

The base ABI 1 and scratch offsets remain compatible. Optional exports
`dsp_batch_abi_version`, `dsp_voice_command_size` and `dsp_process_batch`
describe an expandable ordered array of `DspVoiceCommand` structures. On wasm32
each is 136 bytes: six pointers, six 32-bit words and eleven doubles. Native
builds use ordinary typed pointers with their natural 64-bit layout. The full
batch is checked for invalid block/descriptor parameters before DSP state is
changed. This is a trusted host-memory API, not validation of arbitrary pointers.

Each command owns its filter/envelope state; the batch never shares a filter
history between voices. The native filter kernel directly updates persistent
history instead of copying it through the shared scratch layout. Optional input
supports host interpolation and optional capture retains each voice's processed
PCM for XG routing. Capture/input may alias; both support partial blocks. Ended
voices still contribute their final audio, then are retired after the batch.
`dsp_begin_block()` remains a separate once-per-host-quantum operation.

The JS adapter grows descriptors and optional waveform payloads geometrically,
refreshes views after memory growth and relocates already queued payload pointers.
These temporary buffers are reused and omitted from checkpoints; bound native
filter/envelope states remain checkpointed. Main stereo rendering uses batches
at 16 listed voices and above, with immediate rendering below that threshold.
This threshold does not remove voices or change MIDI scheduling. See
[performance measurements](../DSP-PERFORMANCE.md) for the measured limits.

## Independent voice filters in SIMD128

The SIMD module processes adjacent independent filtered voices two at a time.
Its f64x2 lanes represent two different filters. Each lane retains sequential
sample-by-sample feedback, Float64 history and the existing gain-ramp arithmetic.
The stable per-voice arena/descriptor layout is transposed into SoA registers
at pair entry and written back once. Unfiltered voices, an unmatched final
voice and dependent memory ranges keep the existing single-voice kernel.

Oscillator cache lookups still run in original voice order. Two temporary
waveforms feed the paired filter; each resulting sample is rounded to Float32
at the same point as before. Mixing and capture execute for voice A and then B,
with the original per-voice Float32 accumulation. Pair eligibility checks the
filter/envelope/capture writes against the other voice's reads and writes,
including input/table buffers, command descriptors and the shared scratch region. Shared or partly
overlapping histories and cross-voice capture/input dependencies fall back
without changing their original execution semantics. An input buffer is copied
before its own envelope is updated, preserving intra-voice aliases as well.

The base ABI and batch descriptor version/size stay unchanged. The optional
`dsp_process_batch_scalar` export runs sequential voice filters in the same
module (the existing SIMD sample mixer remains available). This provides an
in-module reference. `dsp_get_voice_simd_stats` returns pair and scalar-voice
counts from the last valid batch; invalid batches leave these unchanged.
The internal host flag `voiceDSP.independentSIMD=false` selects that reference.
Ordinary playback uses independent SIMD when the batch/module supports it.

Tests compare native per-voice golden output, every PCM/state byte between the
two exports, odd/partial blocks, EOF/release captures, mixed routing, 2053 voices,
aliased ranges, later memory growth, actual XG/control handling and checkpoints.
Measurements against both the previous committed module and the sequential
export are recorded in [DSP-PERFORMANCE.md](../DSP-PERFORMANCE.md).
