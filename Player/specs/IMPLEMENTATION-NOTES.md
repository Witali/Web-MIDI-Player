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

## Host part controls (2026-10-20)

MIDI 1.0 p. 13 (PDF 18) separates CC7/11 and CC10 from Bank Select and
Program Change: Bank Select alone does not switch the program, and a sounding
note need not change timbre on Program Change. The existing handlers retain
these rules. Host mute/solo use channel system gain, never the synth's muted
flag (which rejects Note On). Gain and pan remain independent of MIDI CCs;
file commands, gates, pedal state and original programs still execute.

An explicit host instrument override selects an actual bank preset at voice
creation while retaining the file's channel mode and MIDI patch. It does not
lock or remove Bank Select/Program Change. The UI exposes available presets
instead of manufacturing fallback addresses. Part identity is the receiver's
port/channel, with the sequencer's ordered port mapping and GS/XG receive
routing used during independent no-PCM analysis, including F7 commands.

Changes configure the whole score and reconstruct the audible position from
the beginning, rather than trying to overwrite voices inside a mixed PCM
queue. This deliberately revoices held notes under the new configuration and
regenerates wet tails; it is host policy, not a MIDI-specified operation.
Lazy-bank analysis applies the same override before region selection. Failed
preparation retains the old preview; newer seek/load epochs prevent old PCM
from returning. A new file clears configuration, while exact seek preserves it.

Evidence: Player/tests/part-controls.test.mjs covers metadata, shared tracks,
timed ports/F7, receive-channel fanout, exact preset selection across modes,
solo union/mute priority, controllers/reset, preserved silent voices/phase,
selective samples, PCM against an independent MIDI rewrite on JS/WASM/SIMD,
exact seeks, Worker updates/cancellation, HTTP failure/retry, and public API
transport recovery. The catalog and portable example share a DOM-only view.

## Timed text and display inspection (2026-10-20)

SMF RP-001 pp. 8–9 (PDF 10–11) defines text events, track/instrument names,
Lyric syllable timing, Marker, Cue Point and the MIDI Channel Prefix lifetime.
Printable ASCII is recommended; extended codes are permitted but a universal
legacy encoding is not specified. Text is collected alongside the real ordered
sequencer handlers, with their tempo/port state and decoded F7 channel messages.
Raw bytes and meta types remain intact. Removed the upstream rewrite of Lyric
into Text in karaoke files; this was a presentation concern, not a file edit.

The UI's line buffer, UTF-8/Windows-1252 fallback, karaoke slash/backslash line
convention and retention of latest display messages are explicit host policies.
They do not claim a new MIDI text encoding or hardware LCD expiry/scrolling.
The complete raw event list remains available independently of the bounded view.

Display references read from the manufacturers on 2026-10-20:

- [Yamaha MU128 Sound List, table 1-7 (p. 43)](https://data.yamaha.com/files/download/other_assets/1/318081/MU128E2.pdf):
  XG display letter and bitmap addresses. Bitmap bytes run down 16 rows in
  column groups of seven bits; the last group contributes two visible columns.
- [Roland SC-8850 Owner's Manual, LCD parameter map (p. 234)](https://cdn.roland.com/assets/media/pdf/SC-8850_OM.pdf):
  model 45H letter/dot data, partial addresses, checksum and 16×16 mapping.
  Bitmap groups have five visible bits except the final single column.

Only packets actually emitted by the engine's display handler are collected.
Known bounds/checksum-valid LCD messages are rendered; others retain full raw
bytes and their unverified diagnostic. Completion time comes from the final
F7 packet, not the start of a multipart message. Port and device memory are
independent and reconstructed after seeking.

Evidence: Player/tests/midi-text.test.mjs covers all text byte preservation,
Channel Prefix expiry (including escaped channel commands), tracks/ports,
tempo changes, SMPTE, trailing events, explicit/automatic decoding, karaoke
read/write round trips, GS/XG partial letters/bitmaps, invalid bounds/checksum,
F0/F7 completion, independent devices, unchanged PCM on JS/WASM/SIMD and exact
seek, public Worker text events, stop, configuration edits and new-file reset.


## Host speed, pitch and A/B transport (2026-10-20)

SMF RP-001 p. 6 (PDF 8) defines delta times and timed F0/F7 packets; p. 9
(PDF 11) specifies Set Tempo in microseconds per quarter note and End Of Track
as the exact track ending, including looped/concatenated sequences. Existing
PPQN tempo maps and SMPTE normalization remain unchanged. Host rate scales
sequencer time, rather than sample playback speed or individual MIDI commands.
All commands retain their order. Source seconds remain the public coordinate.
The ending release/effect tail stays in real synthesis time.

MIDI 1.0 pp. 10–11 (PDF 15–16) defines key/velocity and matched release
messages; pp. 47–49 (PDF 52–54) defines MIDI Tuning Standard and the real-time
single-note tuning payload. Host transpose adds a system pitch offset to the
receiver, preserving original MIDI key identities, sample selection, MTS,
bend and portamento. Drum channels ignore this host offset. Transpose does
not rewrite Note On/Off keys or clamp them at 0/127. Tests compare it with
independent SoundFont pitch-generator changes, including MTS and portamento.

Speed/pitch bounds, whole-score configuration, exact reconstruction, A/B and
their UI are host policies, not new MIDI requirements. The audio interval is
[A, B); the sequencer explicitly dispatches every command at B inclusively
before restoring A. This inclusive check uses the absolute tempo map rather
than the accumulated playback clock, avoiding floating-point drift without
adding an epsilon that might include later commands. It does not dispatch
later commands while this loop is
active. The no-PCM compatibility inspection still covers the whole file.
Lyrics/display presentation excludes B and restores A on the audible wrap.
No message is silently removed to implement transport controls.

Checkpoints restore mutable synth/sequence state in place, including the
pending 128-frame remainder, byte decoder, voice gates, pedal capture, random
pan and native DSP/effect buffers. Immutable bank/MIDI data and monotonic sample
caches/allocators are retained. Channel topology is preallocated from complete
inspection. Later voice-pool or WASM memory growth does not invalidate a saved
state; bound native views are refreshed. This is exact repeated-prefix state,
without accumulating the previous cycle's tail or smoothing its PCM seam.

Worker spans map actually consumed PCM frames to source time across wraps.
The AudioWorklet reports loops only after consumption, accounts for device
resampling, and freezes source position during underruns. Epochs reject old
PCM and metadata. New files restore constructor rate/transpose and clear loops.

Evidence: Player/tests/playback-settings.test.mjs, checkpoint.test.mjs and
worklet-loop.test.mjs cover tempo rewrites, every SMPTE mode, independent pitch
references/MTS, unchanged percussion, arbitrary A/B frames, exact PCM on
JS/WASM/SIMD, ordered B commands versus later commands (including a 300-tempo-change drift
regression), whole-song End Of Track, partial SysEx, wet
state, RNG, memory/pool growth, exact seeks, Worker cancellation/sample reuse,
public API/defaults, audible lyrics and 44.1 kHz output timing/underruns/EOF.


## Additional timbres and explicit bank mappings (2026-10-20)

MIDI 1.0 p.13 (PDF 18) and GM2 v1.2a pp.5-6 (PDF 9-10) require Bank Select
to wait for Program Change. Existing held notes retain their original preset.
GM2 melody bank MSB 121 uses LSB variations; rhythm bank MSB 120 changes the
channel type when Program Change selects its preset. Appendix A pp.25-31
and Appendix B pp.32-34 define the categories, variations and percussion.
GS MSB variation numbers cannot simply be copied to a GM2/XG LSB.

The verified MIT FluidR3 GS supplement adds actual GS-addressed presets.
The host profile implements only published category correspondences, reports
each substitution and keeps the requested MIDI patch/controllers intact.
Native exact patches take precedence. It does not claim to reproduce hardware
recordings or to supply every defined GM2/GS/XG voice. XG SFX MSB 126 is now
recognized as percussion; an unavailable key map is reported as a drum fallback,
not represented as the GS SFX map or an unrelated melodic preset.

Primary references read and visually checked:

- [GM2 v1.2a, RP-024](https://midi.org/general-midi-2), official download
  [General_MIDI_Level_2_07-2-6_1.2a.pdf](https://drive.google.com/file/d/1OzXk-AshTcb1xyIEHBTA3HcUb-KnLNIR/view),
  185,203 bytes; SHA-256: 56af9df9d9da3cbca39e743af0595a8441246124cdaa3f70736071ced164996e.
- [Yamaha PSR-2000/1000 Data List](https://usa.yamaha.com/files/download/other_assets/7/321057/PSR2000E2.pdf),
  pp.7-11, 361,790 bytes; SHA-256: 6e9aa74aef77f4e2df56838206d22ef936d35a55061072bfa676fb96fe299262.
- [Roland SC-8850 manual](https://cdn.roland.com/assets/media/pdf/SC-8850_OM.pdf),
  pp.146-147, 5,031,818 bytes; SHA-256: ec1b2c9a76bee49969fdebf2ebd7fe6f217eaad250468105c5bd5cd41dbe667d.

The source license/preset inventory, exact mapping limits, deployment and tests
are documented in [BANK-COVERAGE.md](../BANK-COVERAGE.md). SoundFont source
and package hashes are pinned in PROVENANCE.json; the MIT notice is retained.
Every original GM recording's PCM identity, native rate, frame count and
encoded-file digest remains unchanged. Sample indexes are rebuilt consistently
with preset/instrument links. PCM regression compares all GM programs against
independent original SF2 maps, with the unchanged encoded recordings.
