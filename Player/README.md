# Player — portable MIDI playback

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
`error` using `addEventListener`; payloads are in `event.detail`.

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

The original Z80 preview renderer is retained as `{ engine: 'z80' }`. Its
20 melodic sample types and PCM drums render in C/WASM at 48 kHz, now using
two synchronized channels with a shared normalization gain. Its copied MIDI
parser supports CC10 changes across held notes and release tails, RMID and
SMPTE. Unsupported GS/XG timbres use the available bank's fallback; no bank can
reproduce every manufacturer's proprietary patches.

All synthesis runs in a Worker. An AudioWorklet drains bounded stereo blocks;
the UI never mixes a full song. Pausing suspends the output without restarting
notes. SoundFont seeking restores the channel/controller state immediately and
retriggers held notes; their attack/phase restarts at the seek position. The Z80
backend reconstructs PCM from the beginning to retain phase and envelopes.
New seek requests cancel obsolete requests.

## Assets and deployment

The unmodified FluidR3 bank is about **142 MiB**, loaded on first use and kept
in the Worker for subsequent tracks. It is deliberately outside Git. Restore
it after cloning with `node Player/tools/fetch-assets.mjs` (Node.js 22+, `tar`).
The script verifies the Debian package and extracted bank SHA-256. Other SF2
banks can be selected with `{ soundfontUrl: './banks/other.sf2' }`.

Serve `.js` as JavaScript, `.json` as JSON, `.wasm` as `application/wasm`, and
`.sf2` as `application/octet-stream`. Keep relative file paths intact. All
assets are local; no CDN or account is required at playback time. A strict CSP
needs `worker-src 'self'`, `connect-src 'self'`, and
`script-src 'self' 'wasm-unsafe-eval'`. Cross-origin hosting also needs CORS.

Keep the complete `licenses/` folder when redistributing the player and banks.
`PROVENANCE.json` records versions, source URLs, source-project commit and hashes.
Only the copied parser and portable adapter are modified; the Z80 repository is
unchanged. SoundFont samples are used under their own MIT license, while the
legacy bank retains its original CC0 source notices.

Run `npm test` from this folder after restoring the SoundFont.

## MIDI support and reference documents

[MIDI-SUPPORT.md](MIDI-SUPPORT.md) records verified support gaps and playback
limitations. [IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md) tracks the prioritized
improvements and their acceptance criteria. Unmodified official PDFs for Standard MIDI Files and MIDI 1.0
messages are in [specs/](specs/README.md), with source links and SHA-256 hashes.
