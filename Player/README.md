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
bank/program/name), unsupported commands, partial pedal/Note Off velocity
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

The unmodified FluidR3 bank is about **142 MiB**, loaded on first use and kept
in the Worker for subsequent tracks. It is tracked with **Git LFS** under the
MIT license; retain `licenses/FluidR3-MIT.txt` when redistributing it. Install
Git LFS and run `git lfs install` before cloning, or `git lfs pull` from an
existing clone, to retrieve the actual SoundFont instead of its pointer file.

Run `npm run setup` from the repository root to check the bank and download it
when missing or different from the pinned checksum. The setup script is
`Player/tools/fetch-assets.mjs`; it also runs as `npm run player:assets` or
`node Player/tools/fetch-assets.mjs` (Node.js 22+, `tar`).

The download source is the
[FluidR3 GM 3.1 Debian package](https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-5.3_all.deb)
(about 114 MiB compressed, 142 MiB extracted). The script verifies both the
package and extracted bank SHA-256 and skips downloading a verified bank.
This setup path works without Git LFS. Other SF2 banks can be selected with
`{ soundfontUrl: './banks/other.sf2' }`.

Serve `.js` as JavaScript, `.json` as JSON, `.wasm` as `application/wasm`, and
`.sf2` as `application/octet-stream`. Keep relative file paths intact. All
assets are local; no CDN or account is required at playback time. A strict CSP
needs `worker-src 'self'`, `connect-src 'self'`, and
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
