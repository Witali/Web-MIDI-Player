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
no copyrighted or downloaded MIDI is included. Its GS/XG demo requests rain,
thunder, engine and laughter through XG addresses so the compatibility view
can show the actual FluidR3 GS presets selected.

## Live MIDI devices

Both catalogs have a **MIDI-устройства** button; the portable example has the
same controls. Choose input/output ports explicitly. Permission, local input
sound and MIDI Thru have separate controls. Importing the library or granting
access never chooses a device. Disconnected devices must be selected again.

```js
import { LiveMidiPlayer, renderMidiDevices } from './Player/index.js';
const live = new LiveMidiPlayer({ volume: 0.55, effects: true, dsp: 'auto' });
const removeView = renderMidiDevices(document.querySelector('#devices'), live);
// At teardown: removeView(); await live.dispose();
```

A separate LiveMidiPlayer owns an audio context/Worker/AudioWorklet and its
`ports` (WebMidiPorts). Keyboard input does not change the file player's song,
seek state, loop or controllers. The sound button calls `start()` from the
user's click; `stop()` releases the live graph. `panic()` cancels pending input
and stops voices. `dispose()` also closes selected ports. Set `volume` from 0
to 1; `statechange` and `error` carry their payload in event.detail. `start()`
returns runtime metadata; `metadata` updates after applied input.

`live.send(bytes)` accepts complete wire messages for the local synth and
returns a promise for their application. Selected keyboard input calls it
while local sound runs. Optional `{ timestamp }` is an input receipt time in
milliseconds: buffered messages keep their relative timing. Cold sample
preparation moves the waiting burst together, retaining Note On/Off gates.
An empty stream reanchors to the next receipt. Equal times retain arrival
order; dispatch uses fixed 128-frame synthesis boundaries. There is no
controller coalescing or event cap. A preparation failure reports an error,
stops voices and blocks later commands until an explicit panic/retry.

Live startup loads only verified bank metadata. Before admitting a command,
it prepares independent recordings of currently selected instruments,
including their key/velocity regions and stereo links. Instrument readiness
covers nested mono/legato/pedal note starts. File playback keeps its existing
score-based region selection. Played instruments stay decoded for the live
session; encoded data uses the bounded cache. No whole SF2 is fetched. The
first instrument can take time to prepare. soundfontUrl and sampleManifestUrl
select a custom complete bank or browser bank, respectively.

WebMidiPorts is also exported independently:

```js
import { WebMidiPorts } from './Player/index.js';
const ports = new WebMidiPorts();
// From explicit controls; inputId/outputId come from the user's selection.
await ports.request({ sysex: false, software: false });
await ports.selectInput(inputId);   // null disconnects
await ports.selectOutput(outputId);
ports.addEventListener('midimessage', event => {
  const { data, timestamp, port } = event.detail;
});
ports.thru = true;                  // selected input -> selected output
ports.send([0x90, 60, 100]);
ports.send([0x80, 60, 0], performance.now() + 300);
// ports.panic(); await ports.dispose();
```

`ports.ports` lists descriptions; `ports.selection` describes the selected
pair. Events: portschange, inputchange, outputchange, midimessage, midisend,
statechange and error. A successful permission refresh clears selections;
a failed request/open preserves the previous session. Native opens/closes
are serialized per port, including superseded operations and hotplug.

Output timestamps follow Web MIDI: absolute performance-clock milliseconds,
past times send immediately, equal times preserve call order. `send()` checks
one or more complete MIDI 1.0 wire messages atomically; running status and
SMF meta/length encodings are not accepted. Realtime bytes may interrupt a
message without consuming data positions. SysEx output requires permission
requested with sysex:true. Input bytes and receipt times are copied for
listeners. Thru forwards every permitted message, including Common/Realtime
and SysEx. Output replacement clears future sends and releases used channels;
panic clears future sends and releases all channels. `clearOutput()` exposes
queue cancellation alone.

The local synth uses the supported MIDI 1.0/GM/GS/XG/MTS/SDS handlers.
Common/Realtime bytes remain available to listeners and Thru; external
synchronization is still pending. This API does not route a loaded SMF to
hardware or implement UMP. Output controls send test notes or explicit hex
commands. Tests use modeled device ports, actual Worker/WASM PCM and browser
audio startup/stop; physical driver conformance is not claimed.

Web MIDI needs HTTPS or localhost, a supporting browser and MIDI permission;
SysEx is a separate opt-in. See [W3C Web MIDI, sections 4–5](https://www.w3.org/TR/2025/WD-webmidi-20250121/).


## Sound and instrument coverage

The default SoundFont engine uses **FluidR3 GM + GS**, two MIT-licensed banks.
All 128 bank-zero GM programs and standard percussion keys 35–81 are tested for
audible output. `soundfonts/inventory.json` lists every available preset.
The GS supplement adds 33 presets. Explicit GM2/XG substitutions and the
complete address tables are documented in [BANK-COVERAGE.md](BANK-COVERAGE.md).
Bank selects, program changes, sustain, expression, pitch bend and stereo CC10
are processed by **SpessaSynth core 4.3.22** (Apache-2.0). Each SoundFont may add
its own stereo image; reverb and chorus can place a wet tail in both channels.
Pass `{ effects: false }` to audition dry panning.

The adapter handles SMPTE time division at 24, 25, 30000/1001 and 30 fps by
translating the parsed song to an equivalent fixed-tempo clock in memory.
Tempo events do not change SMPTE timing; ordinary PPQN tempo maps are retained.
The source file is unchanged, and seeking uses the same corrected timeline.

Rendering and MIDI control updates traverse the active voices in original pool
order, including held/releasing notes. Free-slot allocation preserves the prior
first-free policy and exact PCM. Sparse passages after a dense burst avoid
rescanning retained inactive storage; measurements and limits are in
[DSP-PERFORMANCE.md](DSP-PERFORMANCE.md).

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

## Speed, transpose and looping

These host controls require the SoundFont engine. Constructor options
`playbackRate` (default 1) and `transpose` (default 0) provide new-load defaults.
After loading, call `await player.setPlayback(changes)` with any subset of:

- `rate`: finite 0.25–4. This scales the sequencer clock and every PPQN tempo
  segment, preserving pitch and real-time instrument envelopes. Explicit host
  rate also scales SMPTE playback; tempo events still do not alter SMPTE timing.
- `transpose`: integer −48…+48 semitones. A global synth pitch offset adds to
  MIDI tuning, bend, MTS and portamento. Original MIDI keys, key-dependent
  modulators, sample regions and Note On/Off identities stay intact; drum
  channels are unchanged. Pitch shifting does not select a new sample region.
- `loop`: `null`/`false` disables repeat; `true` repeats the entire original
  sequence through End Of Track; `{ start, end }` repeats A/B. Bounds must fit
  `metadata.sourceDuration`, excluding the ending effect tail, and span at least
  128 output PCM frames (about 2.67 ms). Boundary precision is one output frame.

`currentTime`, `duration`, seek targets, text timestamps and A/B use **original
file seconds**. At rate 2 the source position advances two seconds per real
second. `duration` includes a dynamic tail estimate in the same coordinate;
initial two-second real tail headroom therefore adds `2 * rate` source seconds.

Settings apply to the whole score, then reconstruct the current position with
those settings, including notes and wet effects. Audio is suspended during
preparation. A newer seek/load cancels obsolete reconstruction. Failed preparation
retains the previous preview. Read defensive `player.playback`, `playbackRate`,
`transpose` and `loop` values; `playbackchange` reports accepted settings.

A/B repeats the exact continuous-render PCM slice [A, B). Every MIDI command
at B is dispatched in file order before restoring A; commands after B wait
until the user changes/disables that loop. Complete-file diagnostics remain
available. The synth restores voices, controllers, pending partial audio,
random pan, byte-stream decoder and effect memory at A. It does not carry the
previous cycle's wet tail across the boundary or crossfade the seam. A hard
boundary may click where the selected PCM endpoints differ. State checkpoints
exclude immutable samples and MIDI data; no full-song PCM is retained. Very
short loops restore the full mutable state frequently and can exceed real-time
CPU capacity; longer regions reduce this cost.

Playback/seek before A includes the intro. Seeking to or beyond B returns A;
Stop returns zero while retaining settings. New loads clear loops and restore
the constructor's rate/transpose defaults. `player.iteration` counts audible
wraps; seek/configuration resets it. `loop` events report `{ start, end, iteration }`
when consumed audio crosses B, independently of buffered-ahead rendering.
Text is flushed through [A, B), then reconstructed at A with reason `loop`.

```js
import { renderPlaybackControls } from './Player/index.js';
await player.setPlayback({ rate: .75, transpose: 2, loop: { start: 4, end: 12 } });
const disconnect = renderPlaybackControls(document.querySelector('#playback'), player);
// Call disconnect() before replacing/removing the view.
```

The catalogs expose **Темп и повтор** and the portable example shares these
controls. Their loop and reconstruction policy is a player feature; MIDI/SMF
specifies the original messages and timing, not this host-control API.

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

## Timed text, lyrics, markers and displays

SoundFont metadata includes `text.tracks` (1-based track names/instrument
names) and `text.events` in original timeline order. Each event includes
`id`, `seconds`, `tick`, `track`, `port`, `channel` (a 1-based MIDI
Channel Prefix, or null), `kind`, original `metaType`/`bytes`, decoded
`text` and its `encoding`. Lyrics identify syllable times; markers and cue
points retain their own timestamps, including events after the last note.
PPQN tempo maps and all four SMPTE clock modes use the playback timeline.
Reserved text types are retained. Karaoke detection does not rewrite the SMF
Lyric event type when reading or writing the file.

`textEncoding: 'auto'` (constructor default) tries valid UTF-8 per event, then
Windows-1252 for legacy bytes. SMF recommends printable ASCII and does not name
a universal encoding for extended characters. Automatic legacy detection is
therefore a heuristic; use an explicit TextDecoder label such as
`'windows-1251'` or `'shift_jis'` when known. Original bytes remain available.

Read defensive snapshots from `player.textEvents` and `player.textState`.
`textchange` supplies `{ currentTime, reason, events, state }`: playback emits
all crossed text/display events between audible position reports (normally
100 ms), rather than just the most recent syllable. Load, seek and configuration
changes reconstruct state and emit their reason; their event list is the
prefix replay, not newly played messages. Stop and backward seeks restore
lyrics, markers and displays; a new load clears them. State comparisons use
the same nearest 48 kHz output frame as audio seeking at the selected host rate, including fractional-frame
marker positions. Metadata retains the unrounded event time.

`state.lyrics` contains each track's current line/syllable; only the displayed
line is bounded to 2048 characters, with full event text kept in metadata.
CR/LF start a new line. In detected karaoke files, leading slash/backslash
start a line/page as a presentation convention; raw text is preserved.
`state.marker` and `state.cue` retain the last respective event.

Engine-confirmed GS/XG display packets are timestamped when the final F7
arrives. Yamaha XG and Roland LCD letter/16×16 bitmap updates have independent
port/device memory, including partial writes. GS checksum and address/data
bounds are checked. Unknown/invalid display packets remain visible as raw
bytes and retain an unverified diagnostic. The view is a timeline inspector:
it retains the latest message, without emulating hardware scroll/expiry timers.

```js
import { MidiPlayer, renderMidiText } from './Player/index.js';
const player = new MidiPlayer({ textEncoding: 'auto' });
await player.load('./song.mid');
const disconnectView = renderMidiText(document.querySelector('#text'), player);
player.addEventListener('textchange', event => console.log(event.detail.state));
const marker = player.textEvents.find(e => e.kind === 'marker');
if (marker) await player.seek(marker.seconds);
// Call disconnectView() before replacing/removing this view.
```

Both catalogs expose **Текст и метки**, with syllable highlighting, marker/cue
navigation, track names, displays and a paginated complete event list.
The portable example generates its own text and markers. Compact Z80 text
export is unavailable; expansion of that backend is outside this project's scope.

## Part controls

SoundFont metadata exposes one receiver part per MIDI port/channel that starts
notes. Tracks sharing a channel share its controls; a timed port change creates
a separate part. GS/XG receive-channel routing can drive several receiver parts.
Part IDs are `"port:channel"`: port is the SMF port number (default 0), channel
is 1–16. Each row includes contributing 1-based tracks and actual source presets.
Read defensive snapshots from `player.parts` and `player.instruments`.

`await player.setPart(id, changes)` accepts any subset of:

- `muted` and `solo`: booleans, default false. Multiple solos form a union;
  mute takes priority. Voices and MIDI messages continue to run while silent.
- `volume`: linear gain 0–1, default 1, multiplied with the file's volume and
  expression. It does not replace or lock CC7/11.
- `pan`: relative stereo offset −1 to +1, default 0, added to the file's pan
  and clamped at the stereo edges. It does not replace or lock CC10.
- `instrument`: null to follow the file (default), or an exact available
  `{ program, bankMSB = 0, bankLSB = 0, percussion = false }` address. Program
  and bank bytes are zero-based 0–127. Choose from `player.instruments`;
  unavailable addresses are rejected. This selects sample presets independently
  of GS/XG mode, while MIDI program, bank, drum mode and controllers still run.

```js
const [part] = player.parts;
await player.setPart(part.id, { solo: true, volume: 0.7, pan: -0.2 });
await player.setPart(part.id, { instrument: { program: 73 } }); // flute
await player.setPart(part.id, { solo: false, instrument: null });
player.addEventListener('partschanged', event => console.log(event.detail.parts));
// Optional shared view, also used by the catalog and portable example:
renderPartControls(document.querySelector('#parts'), player);
```

Import `renderPartControls` from `index.js` for the last line. Changes are
configuration for the whole score: the Worker prepares any newly needed sample
recordings and reconstructs the audible position with those settings, including
held notes and wet tails. Playback briefly waits; replay cost grows with the
prefix length. Old queued PCM is discarded using a new transport epoch.
Settings survive stop/seek and reset on a new load. A failed sample download
leaves the previous configuration playable and can be retried. Concurrent
changes are combined; a later seek cancels obsolete reconstruction, retaining
requested settings. This is host playback policy, not new MIDI commands.
Compact Z80 part controls are unavailable. That backend is retained as-is;
its expansion is outside this project's scope.

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

The default `dsp: 'auto'` tries scalar C/WASM first, then SIMD128 or JavaScript
as fallback. Measurements on small scores with effects still favor scalar;
SIMD can be selected explicitly for dense parts. Hermite interpolation, filtering,
volume/modulation envelope evaluation, stereo mixing, chorus, delay lines and
Dattorro reverb run in C/WASM. MIDI interpretation and SoundFont parameter
setup remain unchanged. Use `dsp: 'js'`, `'wasm'` or `'wasm-simd'`
to select a backend explicitly; `metadata.dsp` reports the one in use.

An adaptive C cache reuses identical oscillator waveforms within each audio
block. Every voice retains its own envelope, filter and stereo/effect gains;
the order of mixing and the PCM rounding remain unchanged. The cache probes
for reuse and bypasses itself for parts with distinct oscillator phases.
It bounds cache memory, with no limit on musical voices.

The stereo wrapper sends batches of 16 or more listed voices to C, with
persistent per-voice filter history. The SIMD module evaluates two adjacent
independent filters in f64x2 lanes while preserving each filter's sample order
and the original voice mixing/Float32 rounding. Dependent buffers and unmatched
voices keep the single-voice path. Current dense tests show an advantage for
SIMD; the full scalar/SIMD comparison and small-score tradeoffs are documented
in DSP-PERFORMANCE.md.

Future-event and repeated-note queues advance a head cursor and compact pending
storage, retaining every message and equal-time arrival order. Ordinary SMF
playback already advances its timeline index. Queue checkpoints and both
standalone catalogs retain the same PCM/note-analysis output.

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
`soundfonts/fluidr3-gm/`: a compact metadata map, a JSON manifest and
1,454 independent sample files (31.0 MiB for the entire set; 1,466 sample entries). Each MIDI loads
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

The original 142-MiB GM SF2, 3.1-MiB GS supplement and browser recordings are tracked with **Git LFS**
under MIT. Install Git LFS before cloning, or run `git lfs pull` in an existing
clone. Keep `licenses/FluidR3-MIT.txt` and the sample bank's `LICENSE.txt`.
`npm run setup` verifies both original banks and every browser asset. It restores
missing original SF2 from the pinned
[FluidR3 GM 3.1 Debian package](https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-5.3_all.deb)
(114 MiB package) and [GS supplement](https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gs_3.1-5.3_all.deb)
(2.4 MiB package), checking archive and extracted-bank SHA-256. If the
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


## Manufacturer effects

GS insertion supports Thru, Stereo EQ, Phaser, Auto Wah, Tremolo, Auto Pan,
Phaser/Auto Wah, Overdrive and Distortion. The new drive models expose their
published drive, amplifier category/switch, low/high gain, pan, output level
and effect sends. GS effect DT1 records validate framing/checksum, consume
all ordered bytes and handle partial type writes. Unsupported types/parameters
and invalid values appear in `metadata.diagnostics`.

XG **System Variation** supports Delay LCR, Delay LR, Echo and Cross Delay,
plus No Effect/Thru. Send XG System On before the XG effect setup. It preserves stereo CC94 sends, exact 14-bit delay values
in 0.1ms units, EQ parameters, feedback, damping, return/pan and sends to Chorus
and Reverb. System mode ignores insertion-only Dry/Wet. These are host DSP
models with published parameter maps, rather than hardware DSP reproductions.

XG System Reverb also supports Hall/Room/Stage/Plate (eight programs), and
System Chorus supports Chorus/Celeste/Flanger (eleven programs). Yamaha lookup
tables set Hz, milliseconds, seconds and filter cutoffs. Chorus input can be
mono or stereo; Celeste uses three LFO phases; Flanger controls their relative
phase. Stereo Variation/Chorus sends precede the corresponding pan and return.
System-only and insertion-only parameters retain their specified applicability.

XG Variation in System mode supports all those families (25 programs including Distortion/Overdrive). Its
Reverb input is summed before HPF/LPF/early reflections; Chorus/Celeste/Flanger
enable the documented mid EQ. Parameter pairs remain 14-bit even for controls
whose valid value fits in seven bits. Variation Insertion also processes the
selected part before volume/expression/pan, with Dry/Wet, post-part sends,
Dry Level and per-note drum on/off. No Effect mutes the part while retaining
its voices; Thru uses the original rendering path. Two Effect2 insertion slots
process the same supported families in INS1 → INS2 → Variation order. Each has
independent part assignment, Dry/Wet, valid parameter representations and limits.
MW, pitch bend, channel pressure and assignable controllers AC1/AC2 control the
parameter marked in Yamaha's table: Drive for drive effects, Dry/Wet for the
other supported families. The modulation interpolation law is a host choice.
Unsupported effect types produce an explicit Thru notice.
See [implementation notes](specs/IMPLEMENTATION-NOTES.md) for primary sources,
algorithm choices, coverage and PCM evidence.

MIDI Tuning Standard supports stored key/scale dumps, independent tuning banks
and programs (RPN3/4), Single Note Tuning and channel Scale/Octave messages.
Real-Time changes retune sounding notes without restarting them; Non-Real-Time
changes apply to future notes. Exact frequency fractions and fractional scale
values survive playback, snapshots and seeking. Direct scale offsets replace
prior offsets and apply relative to the selected tuning preset. Dump requests
remain explicitly unsupported until MIDI output is available. See the MTS section
in [implementation notes](specs/IMPLEMENTATION-NOTES.md) for formats, validation,
reset/storage policy and the primary MIDI Association specification.

Sample Dump Standard is decoded in the SoundFont path, including exact8–28-bit
words, ordered/checksummed packets and loop-point edits. It does not specify an
instrument patch or root pitch. Assign those explicitly when constructing the
player (programs and MIDI keys are zero-based):

```js
const player = new MidiPlayer({
  sampleDumpMappings: [{
    sample: 1, sourcePort: 0, rootKey: 60,
    bankMSB: 0, bankLSB: 0, program: 81,
    loop: 0, loopEnd: 'exclusive'
  }]
});
await player.load(midiFile);
```

A complete received wave becomes available at its final packet, without replacing
already sounding voices. Until then, the existing instrument/fallback applies.
`metadata.sampleDumps` describes received samples; mapped instruments appear in
the normal part selector. `sourcePort` is the SMF port number; optional `deviceID`
restricts the source device. Root key and destination program are required.
`loop` selects a preserved loop number (default0; `null` disables looping).
The decoder retains raw loop addresses; playback's `loopEnd` policy is explicit:
`inclusive` by default, or `exclusive` for a one-past-end endpoint. A bidirectional
loop is expanded into a forward-readable cycle without duplicating endpoints.
The host envelope releases in0.1s by default (`release`, in seconds, is configurable).

Incomplete transfers, invalid packets and unsupported extensions remain explicit
compatibility notices. The receiver reserves64MiB for decoded/expanded resources
and pending data; exhaustion rejects a new transfer instead of publishing partial
PCM. Identical data and constructed banks are reused during loops/seeks, with
full-word verification after hashing. The standalone `SampleDumpReceiver` also
accepts an `onReply` callback for framed ACK/NAK/CANCEL responses and a configurable
memory budget. File playback has no external MIDI output; outbound dumps and
Extended SDS are not implied by receiver support. Primary references and detailed
verification are in [implementation notes](specs/IMPLEMENTATION-NOTES.md).
