# Selectively loaded FluidR3 browser samples

These files adapt Frank Wen and contributors' FluidR3 GM 3.1 for browser MIDI
audition. The complete upstream copyright, acknowledgements and MIT terms are
in [LICENSE.txt](LICENSE.txt). The original SF2 SHA-256, each original PCM hash,
native rate, encoded file hash and digital signal-to-error ratio are recorded
in `manifest.json`. No physical-board quality measurements apply to these
browser assets.

`bank.sf3` is a 200-KB SoundFont metadata map with empty audio payloads. It
retains all 189 preset definitions, key/velocity regions, stereo links,
modulators, envelopes and loop indices. It is **not a standalone playable SF3**.
`../../lazy-bank.js` supplies verified samples before the synthesizer starts.

Recordings are independent Ogg Vorbis streams, encoded from original native-rate
PCM with FFmpeg/libvorbis at a nominal 128 kbit/s per mono recording. Rates below
32 kHz use quality 8 instead, because bitrate support depends on sample rate.
Samples shorter than 4096 PCM bytes remain PCM16 to avoid codec overhead. No
resampling occurs. Vorbis is lossy; this preserves the original instrument
mapping, not bit-identical source audio. Decoder padding is cut back to the
original frame count; loop points and sample rates remain unchanged.

The loader runs the complete ordered MIDI handlers without allocating audio
voices. It selects the actual key/velocity regions and linked stereo samples,
including timed ports, bank/program changes, drum kits, key shifts and F7
escape messages. All required recordings are verified and loaded before playback;
no command is removed or delayed to wait for a download during synthesis.
Requests are deduplicated, limited to four at once and cancelled when a song
is replaced. Each Worker keeps a bounded 32-MiB encoded LRU cache; decoded PCM
belongs only to its current track. Static servers can cache content-addressed
recordings as immutable files. Missing dependencies throw an explicit error.

Binary `.ogg`, `.pcm` and `bank.sf3` files are stored with Git LFS. After cloning,
run `git lfs pull`; setup and export reject unresolved pointers. Static export
publishes the materialized files as ordinary small files with this license,
without publishing the 142-MiB original SF2. The original SF2 remains available
for development and explicit full-bank playback.
The compact Z80 mode retains its separate copied sample bank.

Reproduce from the initialized exact SF2 and FFmpeg with libvorbis:

```powershell
npm run player:samples
```

The manifest records the encoder version and settings. Already verified outputs
with identical original PCM hashes/settings are reused. Signal-to-error values
compare decoded native-rate samples with the original PCM at the same frame
indices, before synthesis/effects. A null value denotes an exact PCM sample.
