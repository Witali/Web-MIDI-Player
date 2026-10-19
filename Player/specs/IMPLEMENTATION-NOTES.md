# MIDI behavior and verification

The primary references are the unmodified PDFs in this folder, identified by
[their recorded hashes](README.md). Page references below use the printed page
number; the PDF page index is supplied when different. These are paraphrases,
not replacements for the normative documents.

## Exact seeking (2026-10-19)

- MIDI 1.0 Detailed Specification 4.2.1, pp. 10-11 (PDF 15-16): a receiver must
  accept both Note Off and Note On with zero velocity. The latter represents a
  release velocity of 64. Gate release and the instrument's release envelope
  are different operations.
- p. 13 (PDF 18), Bank Select: remember both bank bytes; Bank Select alone must
  not change the preset. Program Change chooses the new preset. Notes already
  sounding need not change their original timbre.
- Appendix A-4 (PDF 67): repeated Note Ons on the same channel/key require
  corresponding Note Offs. The receiver chooses its voice assignment policy.
  This player retains all polyphonic voices and pairs releases in order.
- Appendix A-5 (PDF 68): CC64 delays both Note Off and All Notes Off until pedal
  release. Release must enter the envelope's release stage rather than cut PCM.
- Standard MIDI Files 1.0, pp. 4-5 (PDF 6-7): format 1 combines simultaneous
  tracks/outputs; format 2 contains independent patterns. PPQN uses the tempo
  map, while SMPTE division defines an absolute clock. Missing initial tempo
  means 120 BPM.

MIDI does not prescribe an offline seek algorithm or demand identical DSP
rounding across synths. This player's stronger seek contract is that its own
continuous PCM and its own PCM following seek are identical at the selected
48 kHz sample. Replaying all earlier events through the same synth path restores
per-note presets, pedals, oscillator/filter/envelope state, MIDI ports and wet
FX. Fixed 128-frame synthesis quanta with retained unread samples make this
contract independent of consumer read sizes. Random pan has a per-synth seed.
Backward seeking is proportional to the prefix duration; forward seeking can
reuse current state. Worker reads are suspended during reconstruction, and old
seek requests yield and cancel when superseded.

Evidence: `Player/tests/seeking.test.mjs` compares continuous/seek PCM on JS,
scalar WASM and SIMD, with/without effects, at forward/backward and non-aligned
positions. `soundfont.test.mjs` checks SMPTE clocks and >512 held notes;
`transport.test.mjs` compares the real Worker stream before/after seeking.

## Embedded tempo changes (2026-10-19)

SMF 1.0 pp. 4-5 defines PPQN ticks relative to the quarter-note tempo map;
format 1 tracks share the same timeline and missing initial tempo means 120 BPM.
Set Tempo events are applied by the sequencer during playback, not only when
calculating file duration. SMPTE division instead keeps its absolute clock.

Evidence: Player/tests/tempo-playback.test.mjs measures PCM note and silence
windows at 120, 240 and 60 BPM on JS, scalar WASM and SIMD and compares seeks
on both sides of the tempo changes with continuous PCM. The public Mutopia
Rondo Alla Turca file currently has only one Set Tempo event at tick zero:
1,000,000 microseconds per quarter note (60 BPM); it contains no accelerando.

The tempo audio fixture also ends with Note Off followed by All Sound Off on
the same tick. These are separate ordered events: finishing on the first final
Note Off would drop All Sound Off. The sequencer now processes the timeline
through its end rather than using the last voice-message tick as an early exit.

## Complete event execution and output routing (2026-10-19)

SMF 1.0 pp. 4-5 (PDF 6-7) permits simultaneous tracks carrying different
classes of events, including setup and controller messages without notes.
A track's note-channel list is metadata, not permission to discard its other
messages. Commands continue through the complete timeline, including files
containing only tick-zero setup. Within each track their stored order is
preserved; simultaneous events in different tracks use stable track order.

The legacy FF21 numeric port convention is also handled as event state, not
as a retroactive property of the whole track. Each newly encountered output
gets normal channel defaults (including melodic and percussion assignments);
controllers and Program Changes from note-free tracks reach that output.
FF21 is a compatibility convention, not a normative SMF 1.0 meta-event.

Evidence: Player/tests/event-order.test.mjs records every dispatched event,
checks delayed final commands and zero-duration setup, compares multi-port PCM
bit for bit with equivalent port-zero playback, and checks timed port switches
while earlier notes continue on the previous output.

## SMF event syntax and byte streams (2026-10-19)

- SMF 1.0 pp. 2-3 (PDF 4-5): VLQs have at most four bytes; unknown chunks are
  skipped using their declared length. Chunk/event bounds are checked before
  reading or allocating their payload.
- p. 5 (PDF 7): honor header length even when it exceeds six bytes.
- pp. 6-7 (PDF 8-9): F0 and F7 both carry a VLQ payload length. F7 continues
  an unfinished SysEx or escapes arbitrary MIDI bytes when no SysEx is pending.
  Preserve packet boundaries and ticks; a complete SysEx is interpreted when
  EOX arrives, without applying an unfinished packet early. Meta and SysEx cancel
  SMF running status; explicit channel status is required for the next event.
- pp. 7-9 (PDF 9-11): retain unknown meta payloads while ignoring their semantics.
  End Of Track must be last and determines exact track length, including a
  silent suffix. Writing preserves its delta rather than moving it to the last
  preceding event. Invalid/truncated track syntax fails explicitly.
- MIDI 1.0 pp. 29 (PDF 34), A-1/A-2 (PDF 64-65): wire running status is separate
  from SMF running status. System Common/Exclusive clear it; System Real-Time
  can interrupt a partially received channel, common or SysEx message without
  corrupting that message. Each output has its own byte-stream state.

Evidence: Player/tests/smf-events.test.mjs checks event/payload round trips,
header/chunk forward compatibility, invalid bounds/status/VLQs, real-time
interrupts, independent ports, 180 kB SysEx, actual escaped controller/note
playback, complete-stream diagnostics, trailing events, and continuous/seek PCM
for timed multipart Master Volume on JS, scalar WASM and SIMD. This establishes
correct delivery of the parsed messages; manufacturer-specific command coverage
and external synchronization are separate plan items.
