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
Volume envelope evaluation and voice rendering share one C call per block.

JavaScript still parses MIDI/SF2, schedules events, calculates SoundFont generator
parameters and handles the public transport. Envelope initialization/release
parameter setup, LFO control calculations, advanced GS/XG insertion effects and
some effect routing remain in SpessaSynth. The per-sample main voice, chorus,
delay-line and Dattorro loops run in C/WASM. This is not a claim that every
controller or vendor extension has been rewritten in C.

The WAT prototype remains in branch `experiment/wasm-voice-dsp`. The source
Z80 tester project is not modified. The adapted SpessaSynth algorithms retain
their Apache-2.0 license; see [NOTICE](NOTICE).
