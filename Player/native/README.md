# Portable C audio core

`dsp.c` is the source of both scalar and SIMD128 WebAssembly modules. The same
source compiles to a native executable for independent C tests. No fixed voice
count is encoded in the core: the host grows its sample/state arena and submits
every sounding voice, including release tails.

The current core implements Hermite interpolation, the biquad filter, envelope
gain ramps, stereo mixing and effect sends. Float64 arithmetic, explicit
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

The WAT prototype remains available for comparing the original experiment.
The remaining envelope/modulation and effects port is tracked in the improvement
plan; the source Z80 tester project is not modified.
