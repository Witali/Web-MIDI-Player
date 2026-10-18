# Official MIDI specifications

Downloaded on 2026-10-18 from the public download links published by the
MIDI Association. The PDF files are preserved unchanged, including their
copyright notices. These reference documents are separate from the player
source code and its dependency licenses.

## Standard MIDI Files (SMF)

- Local file: [RP-001 v1.0 — Standard MIDI Files Specification](RP-001_v1-0_Standard_MIDI_Files_Specification_96-1-4.pdf)
- Official source page: https://midi.org/standard-midi-files-specification
- Official download: https://drive.google.com/file/d/1t4jcCCKoi5HMi7YJ6skvZfKcefLhhOgU/view
- Size: 84,070 bytes.
- SHA-256: `fdb65bd58cd92981273468954b46fe7e915b1f8b5697f55eaec0d475895762b8`

Defines the `.mid` file structure, headers and tracks, delta times, running
status, meta events, tempo maps, and PPQN/SMPTE time division.

## MIDI 1.0 messages

- Local file: [MIDI 1.0 Detailed Specification v4.2.1](M1_v4-2-1_MIDI_1-0_Detailed_Specification_96-1-4.pdf)
- Official source page: https://midi.org/midi-1-0-core-specifications
- Official download: https://drive.google.com/file/d/1ewRrvMEFRPlKon6nfSCxqnTMEu70sz0c/view
- Size: 550,787 bytes.
- SHA-256: `93cbd078d9f57cd5b20349bbd08fd877f057a74e61cf923a7cec5f1b65bc80c4`

Defines channel and system messages, controllers, pedals, pitch bend, pressure,
RPN/NRPN, and system synchronization. Use it alongside the SMF document when
checking the playback behavior of events stored in a MIDI file. Manufacturer
extensions and later standards may require their own specifications.

The implementation audit is in [MIDI-SUPPORT.md](../MIDI-SUPPORT.md).
