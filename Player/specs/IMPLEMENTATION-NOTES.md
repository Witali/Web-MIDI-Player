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

## Relative Data Entry and controller reset (2026-10-19)

MIDI 1.0 pp. 12, 17-18 (PDF 17, 22-23) specifies 14-bit controller pairs,
waiting for both initial RPN/NRPN selector bytes, retaining a parameter's value
when selecting it, and semitone/cents units for RPN 0. MSB updates clear the
previous LSB; all CC32-63 counterparts are handled, with controller locks honored.
The null number 127:127 disables further Data Entry/Inc/Dec in either family.

[RP-018](README.md#controller-addenda-used-in-implementation) specifies that the
CC96/97 value byte is ignored. RPN 0/1 step the LSB, RPN 2/3/4 step the MSB, and
future RPNs default to LSB steps unless otherwise specified. RPN 0 carries at
100 cents rather than 128. Each supported parameter has its own current value;
returning to it never reuses a different parameter's last Data Entry. Values
saturate at representable endpoints, including RPN 0's 127:127 endpoint; at its
highest MSB the remaining representable cents are retained. RPN 3/4 still report
unsupported tuning-selection semantics; their documented step width alone does
not establish tuning-bank support.

RP-018 leaves NRPN steps to the manufacturer. This receiver's policy for its
existing NRPNs is one MSB unit for part/drum 7-bit parameters and one LSB unit
for SoundFont/AWE32 generator parameters, using their existing generator scales.
Unknown parameters are reported explicitly. Absolute drum fine pitch is an
independent offset, so repeating the same value does not accumulate tuning.
CA-026 leaves RPN 5 units/defaults to the receiver: the existing mapping remains
raw 14-bit value / 1.28 cents, default 50 cents, with an LSB relative step.
This mapping is not a claim of complete GM2 conformance.

RP-015 resets expression, modulation, the four listed pedals, pitch bend and
channel/poly pressure, and nulls both parameter-number families. It preserves
program/bank, volume/pan, effects, sound controllers, channel mode and actual
parameter values. CC68 and CC69 are also reset to OFF; other unlisted controllers retain
their current values in this receiver.
A full synth reset instead restores parameter defaults. Snapshots include
selector completeness, active family, remembered values and SF2 generator index.

Evidence: Player/tests/parameters.test.mjs covers selection in either byte
order, null and incomplete selection, base-100 carry, endpoint saturation,
independent parameters, all controller LSB ranges, locks, NRPN steps, repeated
absolute values, RP-015, snapshots, actual held-note pitch changes and exact
seek/absolute-versus-relative PCM on JS, scalar WASM and SIMD.

## Sostenuto CC66 (2026-10-19)

MIDI 1.0 p. 12 and Appendix A-5 (PDF 17, 68) define switch thresholds and
Chord Hold/Sostenuto: hold the keys already down at pedal-on; later notes play
normally. Each voice retains its own key-down/captured flags, so a later repeat
of the same key does not inherit the earlier voice's capture. Repeated ON
values do not recapture additional notes, and sustain-only tails are excluded.

Note Off and All Notes Off register key release while either pedal may still
hold the voice. Releasing CC64 or CC66 releases only voices no longer protected
by the other pedal, through their ordinary envelope release. CC121 clears both
pedals; CC120 remains immediate silence. Channel/port scope is preserved.

Evidence: Player/tests/pedals.test.mjs covers threshold edges, late/repeated
notes, both pedal-release orders, sustain-tail exclusion, All Notes/Sound Off,
reset, separate output ports and bit-identical PCM versus delayed Note Offs
including exact seeks on JS, scalar WASM and SIMD. Subsequent CC68/69 work is
recorded below.

## Legato Footswitch CC68 (2026-10-19)

MIDI 1.0 p. 14 (PDF 19) requires temporary monophonic legato: an overlapping
Note On changes pitch without reattacking envelopes or, where possible, the
sample attack. OFF restores the previous mono/poly voice-assignment behavior.
This is a performance switch, separate from proper channel-mode messages.

This receiver preserves the channel's underlying CC126/127 mode while CC68
overlays monophonic allocation; explicit mode changes still update that mode.
The most recent held key wins. Releasing it returns to the last still-held key
without an attack while its voice remains available. Enabling during a chord
keeps the most recent held group and releases other groups through envelopes.

A legato transition retains the original sample, phase, root, velocity, timbre,
filter state, envelope clocks and LFO phase while retuning the existing layers.
Portamento has a separate glide start time; it does not rewind the envelopes.
After a gap the next Note On starts a normal attack using the current program.
Logical Note On/Off IDs remain distinct for repeated keys, silent mono keys and
fast retrigger releases. Sostenuto membership follows the logical captured key
when returning to a held key. CC121 turns CC68 off without changing channel mode.

Evidence: Player/tests/pedals.test.mjs checks actual retained oscillator/envelope
state, audible octave retuning, repeated-key pairing, fallback, chord entry,
mode restoration, new attacks after gaps, program changes, portamento timing,
ports, pedals and fast-release progress. Real legato PCM is identical to an
independent semitone change via RPN Fine Tuning, including exact seeks on JS,
scalar WASM and SIMD. The reference uses exact Fine Tuning units; SoundFont
2.04 section 8.4.10 instead specifies a 127/128 normalization for its default
pitch-wheel-sensitivity modulator, so a nominal bend range is not an exact
semitone PCM reference. [SoundFont specification](https://www.synthfont.com/sfspec24.pdf).

## Gate release timestamps and All Sound Off (2026-10-19)

MIDI 1.0 pp. 10-11 (PDF 15-16) recognizes Note Off and Note On zero as gate
release; Appendix A-5 permits pedals to defer release. Instrument release
envelopes determine the tail. The old receiver unconditionally extended gates
to at least 30 ms, and exclusive-class notes to 70 ms. Both extensions are
removed: release begins at command dispatch, preserving the bank's release
shape. The existing 128-frame sequencer scheduling resolution remains.

SoundFont 2.04 section 8.1.2 operator 57 (PDF 36-37) requires a new exclusive
class note to terminate other sounding members rapidly. An open hi-hat can now
enter its exclusive release at the incoming closed-hat event, without waiting
for a minimum gate duration.

MIDI 1.0 p. 25 (PDF 30) explicitly distinguishes CC120 All Sound Off from
Note Off, All Notes Off, Hold Off and volume changes, and still requires one
Note Off for every Note On. CC120 therefore silences voices immediately while
retaining logical pending Note Off identities and controller/pedal state. An
old key release cannot accidentally release a subsequent press of the same key.

Evidence: Player/tests/gate-release.test.mjs checks short explicit/zero-velocity
release timestamps, real release PCM, immediate hi-hat choke scheduling,
independent CC120/pedal/Note Off behavior, and short-gate PCM/seek on JS, scalar
WASM and SIMD.

## Hold 2 CC69 (2026-10-19)

MIDI 1.0 Appendix A-5 (PDF 68) leaves the other-hold function to the receiver;
freezing the envelope at its current point is an explicit example. This
receiver freezes volume and modulation envelopes of voices active on the
OFF-to-ON transition (threshold 64). Later notes are not captured; repeated
ON values do not recapture. Oscillators, LFOs, filters, effects and controllers
continue. One-shot samples may still reach their natural end.

Note Off records key release while frozen. OFF begins any pending release
immediately, or resumes an already running release at its saved point. CC64
and CC66 retain their independent hold logic. CC121 clears CC69; CC120 and
exclusive-class choke override the freeze. JS and native envelope states stay
synchronized without rewinding oscillators. A file leaving the switch ON can
retain a live envelope until explicit stop.

Evidence: Player/tests/hold2.test.mjs covers both envelope clocks, audible
modulation, later notes, repeated ON, live volume, pending and ongoing release,
pedal/reset/choke priorities, ports, actual PCM and exact seeking on JS, scalar
WASM and SIMD with effects.

## Separately loaded recordings (2026-10-19)

Sample transport is a host policy, separate from MIDI command semantics. MIDI
1.0 pp. 10, 13 (PDF 15, 18) identifies Note On key/velocity and bank/program
selection; SMF RP-001 pp. 6-7 (PDF 8-9) permits packetized F0/F7 messages. A
program-number-only scan would miss region dependencies selected by these
commands, timed ports, tuning and part key/velocity parameters.

The preparation pass executes the same ordered command handlers as playback,
intercepting voice construction to collect selected regions and stereo links.
No PCM voices are allocated in that pass. Original MIDI events are retained;
playback uses a separate synth and re-executes every command in sequence. All
required recordings are downloaded and verified before synthesis, so network
waits cannot drop a note or reorder a MIDI message. The approximate upstream
preload scan is disabled; an unprepared sample throws instead of losing a note
silently. Mono/legato analysis without active PCM voices can conservatively
include extra regions; it does not intentionally exclude a potential attack.

Evidence: Player/tests/lazy-bank.test.mjs compares selective playback with an
independently filled complete compressed bank for program/bank changes, F7,
drums, timed ports, legato, reset, tempo and exact seeks on JS, scalar WASM and
SIMD; it also covers all 128 GM programs and 47 standard drum keys, integrity,
cache bounds, deduplication, cancellation, retry and browser fetch invocation.
Browser Worker verification rendered real PCM, sought to 20.13 seconds and
reloaded Mozart without downloading its 26 recordings again. The Vorbis bank
is lossy relative to original SF2; the full SF2 path remains available.

## Note Off velocity (2026-10-20)

MIDI 1.0 pp. 10–11 (PDF 15–16) defines explicit Note Off velocity and the
Note On zero alternative, which uses release velocity 64. Velocity's audible
interpretation belongs to the receiving instrument. SF2 2.04 section 8.2.1
(PDF 39) defines Note On velocity but no Note Off velocity modulator source;
reserved sources must not be repurposed.
[SoundFont specification](https://www.synthfont.com/sfspec24.pdf).

Explicit values 0–127 now reach the actual logical Note On identity through
SMF, F7, raw/scheduled messages, port routing and external helper output. The
voice stores release velocity separately from attack velocity; Note On zero
and omitted values use 64. Sustain/sostenuto/Hold 2 retain that value while
release is pending. Generated CC123 releases use 64 for still-pressed keys.
CC120 preserves owed identities. Forced drum Note Off now targets the matched
identity, so an old release cannot terminate a newer press after CC120.

The host can opt an actual preset into explicit volume/modulation release
curves with 128 timecent offsets. This is a documented receiver extension,
not a new SF2 source or a MIDI-prescribed curve. Unconfigured banks retain
their former PCM; attack velocity and key/velocity region selection stay
unchanged. Profiles are captured at attack, including cached voices, and
remain attached through program changes and legato. Forced choke/fast release
overrides them. JS computes release parameters once; the existing C-state
bridge receives the same values without changing the native audio kernels.

Evidence: Player/tests/release-velocity.test.mjs covers all 128 velocity values,
zero-Note-On/64 equivalence, invalid input without state mutation, F7, routed
ports, raw MIDI, external output, overlapping keys, all three pedals, CC123/121,
CC120 and forced drum identities, program/profile changes, legato and choke.
Opt-in PCM equals an independent generator-change reference; ordinary-bank
PCM is identical across tested velocities. Real audio, exact seeks and the
Worker path are checked on JS, scalar WASM and SIMD, including selective
sample loading. The compact Z80 mode remains a separate pending plan item.
