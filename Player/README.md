# Web-MIDI-Player — portable MIDI playback

Copy the complete `Player/` folder to a static website and import `index.js`.
The library needs no application framework, package install, external service
or connection to the original Z80 project. Serve it over HTTPS or localhost.

```html
<button id="play">Play</button>
<script type="module">
  import { MidiPlayer } from './Player/index.js';
  const player = new MidiPlayer({ volume: 0.55 });
  document.querySelector('#play').onclick = async () => {
    await player.unlock(); // preserve the click's audio permission
    await player.load('./music/song.mid');
    await player.play();
  };
</script>
```

`load()` accepts a URL, File, Blob, ArrayBuffer or typed array. It returns
metadata. The transport provides `play()`, `pause()`, `seek(seconds)`, `stop()`
and `dispose()`. Set `player.volume` from 0 to 1. Read `state`, `duration` and
`currentTime`. Subscribe to `loaded`, `statechange`, `timeupdate`, `ended` and
`error` using `addEventListener`; payloads are in `event.detail`. Long release
and effect tails extend the initial duration estimate instead of being cut;
`durationchange` reports the updated duration. The same metadata object is
updated, so site seek controls can follow it. Playback waits for inactive
voices and 250 ms below −120 dBFS, with at least two seconds of ending headroom.

The sample page is `example/index.html`. It generates its own short test score;
no copyrighted or downloaded MIDI is included.

## Sound and instrument coverage

The default SoundFont engine uses **FluidR3 GM**, a complete MIT-licensed bank.
All 128 bank-zero GM programs and standard percussion keys 35–81 are tested for
audible output. `soundfonts/inventory.json` lists every available preset.
Bank selects, program changes, sustain, expression, pitch bend and stereo CC10
are processed by **SpessaSynth core 4.3.22** (Apache-2.0). Each SoundFont may add
its own stereo image; reverb and chorus can place a wet tail in both channels.
Pass `{ effects: false }` to audition dry panning.

The adapter handles SMPTE time division at 24, 25, 30000/1001 and 30 fps by
translating the parsed song to an equivalent fixed-tempo clock in memory.
Tempo events do not change SMPTE timing; ordinary PPQN tempo maps are retained.
The source file is unchanged, and seeking uses the same corrected timeline.

Playback has no fixed voice-count limit: the SoundFont voice pool grows as
needed, and the compact WASM preview mixes all sounding notes without the ROM
compiler's four-voice allocator. Notes and release tails can overlap, including
repeated pitches. CPU and memory determine practical capacity; input validation
limits are documented separately from musical polyphony.

The SoundFont engine uses each instrument's volume and modulation envelopes.
Note Off starts its release unless CC64 sustain is holding it. CC123 All Notes
Off respects sustain; CC120 All Sound Off silences active voices immediately.
Explicit MIDI mono mode and percussion choke groups still follow the file and
instrument definitions. No artificial sustain or forced single-note retrigger
is added by the adapter.

The original Z80 preview renderer is retained as `{ engine: 'z80' }`. Its
20 melodic sample types and PCM drums render in C/WASM at 48 kHz, now using
two synchronized channels with a shared normalization gain. Its copied MIDI
parser supports CC10 changes across held notes and release tails, RMID and
SMPTE. Unsupported GS/XG timbres use the available bank's fallback; no bank can
reproduce every manufacturer's proprietary patches.

All synthesis runs in a Worker. An AudioWorklet drains bounded stereo blocks;
the UI never mixes a full song. Pausing suspends the output without restarting
notes. SoundFont seeking reconstructs the actual synth state by rendering the prefix
without output. Old presets, pedals, repeated notes, sample phases, percussion
and wet effects match uninterrupted playback, including a seek inside an audio
quantum or beyond the MIDI events into a release tail. Forward seeks reuse the
current state; backward seeks replay from the beginning. Random pan is seeded
per synth so it also survives replay. The Z80 backend reconstructs its PCM from
the beginning. Requests yield during long reconstruction; a newer seek or load
cancels obsolete work. Reverse seeking costs CPU proportional to the prefix.
The MIDI specification does not prescribe a seek algorithm; exact reconstruction
is this player's policy. See [specification notes](specs/IMPLEMENTATION-NOTES.md).

## Playback compatibility report

SoundFont `load()` returns `metadata.diagnostics` before playback begins. The
Worker inspects the entire sorted MIDI timeline with the pinned engine's bank,
controller, RPN/NRPN, SysEx and port handlers, without rendering the audio prefix
or allocating notes. The inspection synth is separate from the playback synth.
The catalog's **Совместимость** button and the sample page display the report;
its JSON export is available in the same view.

The report distinguishes actual preset substitutions (requested and selected
bank/program/name), unsupported commands, partial feature support
handling, bank-dependent CC/poly pressure and SysEx whose execution could not
be confirmed. Recognizing a message is not treated as implementing it. Standard
GM commands do not receive speculative warnings. Missing dedicated CC behavior
does not imply silence: SoundFont modulators may still use that controller.

Each entry contains `code`, `status`, `feature`, `message`, `count`, and
`first`/`last` positions with seconds, ticks, one-based track/channel and the
original MIDI port number. Program numbers in structured patches are zero-based;
the displayed program is one-based. `summary` counts notice occurrences by
status. Repeated notices are grouped; at most 200 distinct entries and 64 bytes
per message are retained. `omitted` reports suppressed occurrences, which remain
in the summary. `complete` is false if a command failed during analysis. The
report covers the file once; playing/seeking does not append duplicate notices,
and a new load replaces it. Compact Z80 metadata does not include this report.

The report verifies command handling and preset selection. It does not certify
audible modulation, sample coverage for each key, or exact reproduction of any
hardware synthesizer. An empty report means no known processing limitations
were detected in this file, not full implementation of every MIDI extension.

```js
const metadata = await player.load('./music/song.mid');
console.log(metadata.diagnostics.summary, metadata.diagnostics.entries);
// Optional shared, text-only UI:
const { renderMidiDiagnostics } = await import('./Player/index.js');
renderMidiDiagnostics(document.querySelector('#report'), metadata.diagnostics);
```

## Note Off velocity and instrument profiles

The engine preserves the explicit Note Off velocity (0–127) for each logical
key press, independently of the Note On velocity. Note On with velocity zero,
engine calls omitting release velocity, and generated All Notes Off releases
use 64. The engine's `noteOff` event includes `velocity`. Sustain, sostenuto
and Hold 2 retain the key's value until release can begin; program changes do
not replace an already started voice's instrument response.

MIDI leaves the audible response to the receiver. SF2 2.04 defines Note On
velocity as a modulator source, with no standard Note Off velocity source.
Consequently ordinary SF2 banks, including FluidR3, keep their original audio.
An instrument can opt into a host-defined response using this example:

```js
// Example receiver policy: slower release at 0, unchanged at 64, faster at 127.
const volumeRelease = Array.from({ length: 128 }, (_, velocity) =>
  1200 * (64 - velocity) / (velocity <= 64 ? 64 : 63));
const player = new MidiPlayer({
  releaseVelocityProfiles: [{ program: 0, volumeRelease }]
});
```

Each profile matches an **actual selected preset**, using zero-based
`program`, `bankMSB`/`bankLSB` (default 0) and `percussion` (default false).
This also applies to fallback instruments and additional MIDI ports. Optional
`volumeRelease` and `modulationRelease` curves each contain exactly 128 finite
timecent offsets, indexed by release velocity, from −12000 to +12000. At least
one curve is required; duplicate preset matches are rejected. An offset of
+1200 doubles the bank's release time, and −1200 halves it, subject to the
engine's existing release-time floor. These curves affect release only;
the attack velocity and its sample/velocity-region selection are retained.
Forced choke/fast termination takes priority over the curves.

Settings are copied on construction. Existing voices retain the profile from
their attack; reset and exact seek reapply the configured profiles. Profiles
work with full and selectively loaded banks on JS, scalar WASM and SIMD.
They are an explicit player extension, rather than a reserved SF2 modulator
encoding. They are unavailable in the compact Z80 engine.

## WASM voice DSP

The default `dsp: 'auto'` selects the measured faster scalar C/WASM kernel,
then SIMD128 or JavaScript as fallback. Hermite interpolation, filtering,
volume/modulation envelope evaluation, stereo mixing, chorus, delay lines and
Dattorro reverb run in C/WASM. MIDI interpretation and SoundFont parameter
setup remain unchanged. Use `dsp: 'js'`, `'wasm'` or `'wasm-simd'`
to select a backend explicitly; `metadata.dsp` reports the one in use.

An adaptive C cache reuses identical oscillator waveforms within each audio
block. Every voice retains its own envelope, filter and stereo/effect gains;
the order of mixing and the PCM rounding remain unchanged. The cache probes
for reuse and bypasses itself for parts with distinct oscillator phases.
It bounds cache memory, with no limit on musical voices.

[DSP-PERFORMANCE.md](DSP-PERFORMANCE.md) records the successful experiment branch,
reproducible benchmarks and bit-identical audio checks. The browser comparison
page is `example/benchmark.html`. Portable C sources and native tests are in
`native/`, with prebuilt modules in `dsp/`. Rebuild using
`npm run build:dsp -- --emsdk /path/to/emsdk` (tested Emscripten 6.0.12).
`npm run test:core` runs native C tests; `npm test` checks WASM/JavaScript,
native golden-output parity and the full player. See `native/README.md` for
the exact boundary between the C audio core and JavaScript control logic.

## Assets and deployment

The default engine loads FluidR3 **as separate recordings** from
`soundfonts/fluidr3-gm/`: a 198-KiB metadata map, a JSON manifest and
1,418 independent sample files (30.3 MiB for the entire set). Each MIDI loads
only its required key/velocity regions and linked stereo recordings, including
later bank/program changes, drum kits, timed ports and escaped MIDI messages.
The complete ordered MIDI handlers select the dependencies; playback executes
the original events again. Required files finish loading before playback starts.

Recordings use Ogg Vorbis from the original native-rate PCM; very short samples
remain PCM16. This is the same encoding as the Z80 tester's browser bank.
Vorbis is lossy; sample rates, original frame counts, loops, preset maps,
modulators and envelopes are retained. It is not bit-identical to the original
SF2. Exact original PCM remains available by explicitly choosing
`{ soundfontUrl: './banks/FluidR3_GM.sf2' }`; other full SF2 banks still work.
A relocated copy of the sample bank can use
`{ sampleManifestUrl: './banks/fluidr3-gm/manifest.json' }`.
Choose one of these URL options or omit both for the default sample bank.

Downloads are limited to four at once and verified by SHA-256 before decoding.
A new track cancels obsolete sample downloads. Each Worker's encoded LRU cache
is limited to 32 MiB; decoded PCM belongs only to its current track. The server
may also cache content-addressed sample files. `metadata.sampleBank` reports
selected sample/file counts, encoded bytes, newly downloaded sample bytes and
cache hits. `metadata.sampleBank.mode` is `samples` or `full`.

The original 142-MiB SF2 and browser recordings are tracked with **Git LFS**
under MIT. Install Git LFS before cloning, or run `git lfs pull` in an existing
clone. Keep `licenses/FluidR3-MIT.txt` and the sample bank's `LICENSE.txt`.
`npm run setup` verifies the original bank and every browser asset. It restores
missing original SF2 from the pinned
[FluidR3 GM 3.1 Debian package](https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-5.3_all.deb)
(114 MiB package), checking both archive and extracted-bank SHA-256. If the
browser assets are missing, setup rebuilds them with FFmpeg/libvorbis; use
`git lfs pull` to retrieve the ready files without encoding. Node.js 22+ and
`tar` are required for setup; FFmpeg is needed only for rebuilding samples.
`npm run player:samples` reproduces the split bank from the verified original;
see [the sample-bank README](soundfonts/fluidr3-gm/README.md) for encoding details.

Static sites need the sample-bank directory, its license and player runtime;
the original SF2 is optional. `npm run catalog:public` verifies and exports all
small files, omitting the original SF2. Serve `.js` as JavaScript, `.json` as
JSON, `.wasm` as `application/wasm`, `.ogg` as `audio/ogg`, and `.sf3`,
`.pcm` and optional `.sf2` as `application/octet-stream`. Keep relative paths
intact. All assets are local; no CDN or account is required at playback time.
A strict CSP needs `worker-src 'self'`, `connect-src 'self'`, and
`script-src 'self' 'wasm-unsafe-eval'`. Cross-origin hosting also needs CORS.

Keep the complete `licenses/` folder when redistributing the player and banks.
`PROVENANCE.json` records versions, source URLs, source-project commit and hashes.
Local adapter/parser and vendor patches are recorded in `PROVENANCE.json`;
the Z80 repository is unchanged. SoundFont samples use their own MIT license, while the
legacy bank retains its original CC0 source notices.

Run `npm test` from this folder after restoring the SoundFont.

## MIDI support and reference documents

[MIDI-SUPPORT.md](MIDI-SUPPORT.md) records verified support gaps and playback
limitations. [IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md) tracks the prioritized
improvements and their acceptance criteria. Unmodified official PDFs for
Standard MIDI Files and MIDI 1.0
messages are in [specs/](specs/README.md), with source links and SHA-256 hashes.
