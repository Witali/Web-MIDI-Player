# General MIDI drum recordings

25 mono PCM16 excerpts from **VSCO 2 Community Edition** and **VCSL**, by
Versilian Studios / Sam Gossner and contributors, licensed **CC0 1.0**.
The original license texts are [LICENSE-vsco.txt](LICENSE-vsco.txt) and
[LICENSE-vcsl.txt](LICENSE-vcsl.txt). These recordings may be redistributed and
modified under those terms.

[sources.json](sources.json) records exact upstream repositories, pinned
revisions, source URLs, original SHA-256, excerpt positions and canonical file
hashes. Canonical excerpts align to the onset, average stereo to mono, retain
the original rate, quantize to PCM16 and last at most 1.2 seconds. Original
downloads are cached only in ignored `build/audio/midi-drums/sources/`.

From the repository root:

```powershell
python audio/lib/midi-firmware/src/fetch_drums.py
python audio/lib/midi-firmware/src/build_drums.py
```

The first script restores the canonical inputs with their pinned provenance.
The second runs offline from the checked-in WAVs. It maps the 25 recordings
to GM percussion keys 35–81, adjusts pitch where needed, band limits before
resampling, removes DC, normalizes peaks to 95%, and adds short onset/tail fades.
Output is 12-kHz PCM16 in `audio/lib/midi-firmware/data/drums-{pdm,r2r}.json`,
with bandwidth 3.5/5.5 kHz and compact durations 80–640 ms. Each row retains its
canonical source and source/output SHA-256. The mapping and explicit related
timbre approximations are in `build_drums.py` and the generated bank metadata.
In particular the cuica substitute does not reproduce the characteristic squeak.

The same script generates key labels and the original
[drum-only MIDI example](../../scores/midi-drums-demo/README.md).
See the [compiler documentation](../../../lib/midi-firmware/README.md#midi-percussion)
for note lifetime, allocation, PCM playback and ROM fitting. These are compact
one-shot approximations; no physical-board or SNR/SER measurements are claimed.
