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

## Controller addenda used in implementation

Read on 2026-10-19 via the public links on the
[official MIDI 1.0 addenda page](https://midi.org/midi-1-0-addenda). These PDFs
are not redistributed with the code; their source links and hashes identify
the exact references used.

- [RP-018: Response to Data Increment/Decrement Controllers](https://drive.google.com/file/d/12BL3AKojiRcFR170CUy_H61RlZO9toYF/view),
  32,628 bytes; SHA-256: 0b419fefb40d65148a4a5f8385aeaef60e5b16e25b25d226b1b90f140c213810.
- [RP-015: Response to Reset All Controllers](https://drive.google.com/file/d/1VzU1Bfv8iYLGD23ZfaTJVomEKNTtBh6n/view),
  33,669 bytes; SHA-256: 0b1b75e84ea9ed7429e81a9101afe33683f53914e8161eb6c3dd637b1542e5c5.
- [CA-026: Modulation Depth Range RPN](https://drive.google.com/file/d/1V_zUZ7ZNOV_ySDwN6aYOFJipq4Jk0en6/view),
  48,489 bytes; SHA-256: 49be1c7b497827a889374028e789198649ca8d94ae92afc395c66d3929c3ecba.

GM2 v1.2a (RP-024) and the manufacturer bank-address tables used on
2026-10-20 are identified with URLs, hashes and printed page numbers in
[implementation notes](IMPLEMENTATION-NOTES.md#additional-timbres-and-explicit-bank-mappings-2026-10-20).
They are not redistributed with the player.

MIDI Tuning Updated Specification (CA-020/CA-021/RP-020), read on2026-10-20:
[official source page](https://midi.org/midi-tuning-updated-specification),
[official download](https://drive.google.com/file/d/1aSEsFSZMEsnF0LP93ZhD-yUbTmfcHWHA/view).
72,967 bytes; SHA-256:
`a798ef37dea8369fc40c1cdb2fdf002ba24cbc8f7ea7eb40d1508abaf5595fff`.
The PDF is used as a reference and is not redistributed with the player.

Sample Dump Size, Rate and Name Extensions (CA-019, revised 2000-12-01),
read on 2026-10-20 via the
[official addenda page](https://midi.org/midi-1-0-addenda):
[official download](https://drive.google.com/file/d/17t3anBz4ImfwAou2bMkLtvhAF-YJjOSw/view).
57,991 bytes; SHA-256:
`445d286e1bbd16ef62a4ebc8cec132d38167635f0b0d035fdf82a20110eeb8f1`.
Pages 2-4 define the extended rate/count/channel fields, loop types and names.
The PDF is used as a reference and is not redistributed with the player.
