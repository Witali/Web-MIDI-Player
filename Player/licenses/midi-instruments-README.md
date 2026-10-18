# Additional CC0 instrument recordings

Sixteen compact excerpts from **VSCO 2 Community Edition**, recorded by Sam
Gossner and Simon Dalzell / Versilian Studios, with sample cutting by Elan
Hickler / Soundemote. The upstream [repository](https://github.com/sgossner/VSCO-2-CE)
and [publisher](https://versilian-studios.com/vsco-community/) identify this
library as CC0. The exact upstream license is retained in `LICENSE.txt`.

Pinned revision: `440300901dfe9275fd84e0b7763af1f8443ae62e`.
`sources.json` records each upstream URL/path/hash, excerpt hash, sample format,
transformation and estimated pitch used to extract its browser waveform.

Included: horn, trumpet, trombone, tuba, organ, glockenspiel, marimba, xylophone,
harp, pizzicato contrabass, pizzicato viola, bassoon, clarinet, flute, oboe and
piccolo. The builder also reuses the existing piano, violin, cello and FreePats
guitar recordings in the adjacent canonical sample directories: **20 instruments**
in total, without copying those four existing inputs.

Reproduce with `audio/lib/midi-firmware/src/fetch_samples.py` (Python/numpy,
network access). Original downloads are cached only under ignored
`build/audio/midi-builder/sources/`. Imports verify the pinned original hashes
on subsequent runs. The converter keeps the first up to 1.2 seconds, averages
channels, and rounds to mono 16-bit PCM. Stable grains are derived separately;
no raw WAV is needed by the exported website.

Pitch is estimated by a 120 ms Hann-windowed FFT near the note in the filename.
The organ filename has no pitch, so its strongest 60–1500 Hz peak is used. These
are compact timbral approximations, not full multisample reproductions. Mallet
transients, breath noise, vibrato and long recorded envelopes are simplified.
