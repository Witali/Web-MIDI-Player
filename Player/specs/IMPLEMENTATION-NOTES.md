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
highest MSB the remaining representable cents are retained. RPN 3/4 tuning
selection was added later; see the MIDI Tuning Standard section below.

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


## GS effect records and distortion models (2026-10-20)

[Roland SC-8850 manual](https://cdn.roland.com/assets/media/pdf/SC-8850_OM.pdf),
pp.93-94,128,216,224-225,235-237,245, defines Overdrive 01 10 and Distortion
01 11, the mono L+R → drive → optional amplifier → EQ → pan → level path,
parameter addresses/defaults, DT1 type macros and address/data checksum.
The exact PDF digest is recorded above. Printed pp.93 and216 were also
visually checked so bold factory values and the block diagram were preserved.

The receiver validates framing/checksum for the entire effect record before any mutation, then
applies each payload byte in address order. Type bytes form a two-byte
parameter: an adjacent complete pair selects once; a partial write retains
the other byte, including a previous unknown type. Resets clear that state.
Macro defaults apply before later parameter overrides in the same record.
Unknown algorithms use Thru with an explicit notice. Reserved/unused addresses
and values outside documented ranges also report a notice; they do not gain
an implementation claim from an empty setter. This validator is scoped to
effect blocks, not an audit of every Roland SysEx family.

GSOverdrive/GSDistortion implement the published controls and routing. The
soft tanh/hard clipping drive curves, four cabinet filter models, equal-power
pan and linear level law are deterministic host DSP choices: Roland does not
publish its DSP coefficients, cabinet impulse responses or gain curves. They
are not bit-exact SC hardware emulations. The low/high shelves use 200/4000Hz
and the RBJ Audio EQ Cookbook formulas; dB gains are verified by sine energy.
All dynamic state is owned by the synth graph, so exact seek/loop snapshots
restore cabinet/EQ and system-effect history. Existing voices/native kernels
are unchanged; these insertion processors run in JavaScript on all backends.

Evidence: tests/gs-effects.test.mjs uses the actual published Distortion SysEx
example, independent parameter/default values and nonlinear PCM references,
checksum/range failures, complete and partial DT1 writes, macro ordering,
unknown-type fallback, effects:false identity, fragmented F0/F7, independent
MIDI ports and exact seek/checkpoint PCM on JS, scalar WASM and SIMD.


## XG System Variation stereo delays (2026-10-20)

Primary references read, with the effect/connection diagrams visually checked:

- [Yamaha MU100 Sound List & MIDI Data](https://usa.yamaha.com/files/download/other_assets/9/318079/MU100E2.pdf),
  pp.5-10,12,26,30,41-42: types, four delay algorithms, parameter units/ranges,
  EQ table, CC94, two-byte Variation parameters and System control addresses.
  1,533,518 bytes; SHA-256: 24d70f9d79cbb18fb2a5d911d0c13780c17be8de94918878bf7d0298c8c90bb0.
- [Yamaha MU100 Owner's Manual](https://usa.yamaha.com/files/download/other_assets/5/333985/MU100E1.pdf),
  printed pp.136-141 (PDF pp.133-138): No Effect versus Thru, System-only
  return/pan/sends, insertion-only Dry/Wet, and stereo connection diagrams.
  4,420,081 bytes; SHA-256: a53fd5997df276c7ce048cf28e8055189e8f825220d90db2f1adc5772fd962b5.

Supported Variation types are 05/00 Delay LCR, 06/00 Delay LR, 07/00 Echo,
08/00 Cross Delay, 00/00 No Effect and 40/00 Thru in System mode. Each algorithm
follows its own feedback/tap diagram. Parameters use exact 14-bit values and
0.1ms delay units. Partial writes retain the other seven bits; a complete pair
applies once. Type changes restore defaults before following overrides. The
published LCR factory defaults are retained; other program defaults are explicit
host choices. Fractional delay lengths use linear interpolation. Parameter
ranges/EQ frequencies are transcribed from Yamaha's tables.

CC94 retains channel/port/drum-note sends and stereo position. Variation runs
before Chorus/Reverb; its sends tap the wet signal before Variation pan/return,
as shown on p.140. Dry/Wet does not affect this System bus. No Effect mutes the
bus; unknown types use a diagnosed Thru. Effect1 multi-byte records dispatch
every byte, including explicit diagnostics for the not-yet-implemented Reverb,
Chorus, reserved addresses and modulation controls. Framing/7-bit validation
precedes mutation; semantic range failures leave the processor parameter intact.
Yamaha's device number is the low four bits of its function/device header;
Roland/universal device addressing keeps its separate representation.

The signed feedback coefficient law, high-damping LPF, interpolation of
return/send gains between specified anchors (0=-infinity,96=0dB,127=+6dB), and
constant-power return pan are host DSP choices. No proprietary Yamaha DSP
identity is claimed. All delay memory and parameter bytes belong to the synth
object graph and are restored by exact seek/loop checkpoints. Native voice
DSP remains unchanged; fresh native voice views feed the stereo send bus even
after WASM memory growth. New effect DSP runs in JavaScript on every backend.

Insertion is deliberately still reported as unsupported, with a Thru fallback:
the manufacturer's graph puts it before part volume/pan. The current SF2 voice
pipeline must be refactored before claiming that routing. Configuring an
insertion part reports this limitation; merely selecting a type while the part
is OFF is valid setup. Delay time continues advancing silently during this
fallback, so a later System switch cannot resume a frozen old tail. XG Reverb,
Chorus, separate insertion slots, analogue inputs and effect controller
modulation also remain outside this change. The overall effects plan item
therefore remains open. Configuring Variation outside XG mode is also
reported explicitly: send XG System On before its effect setup.

Evidence: tests/xg-variation.test.mjs includes independent impulse diagrams,
signed feedback/cross-input tests, fractional delays, parameter/default tables,
all-byte dispatch, partial writes, malformed/range diagnostics, device filtering,
send/return ordering, all four algorithms through actual MIDI on JS/WASM/SIMD,
No Effect/fallback/effects:false PCM, F0/F7 and ports, exact seeks/checkpoints,
an independent delayed dry-stereo PCM reference with live pan changes,
inactive-mode diagnostics and real Worker selective loading/seek/PCM.


## XG System Reverb and Chorus (2026-10-20)

The exact Yamaha references and hashes are recorded in the preceding section.
MU100 Sound List & MIDI Data printed pp.11,13-14,25-26,41-42 defines the System
block diagrams, parameter ranges, conversion tables and factory Effect1 data.
The Owner's Manual printed pp.136-141 defines connection/return/send semantics.
The original p.11 and p.13 diagrams were visually checked for independent
stereo filters, ER paths and mono/stereo chorus input before implementation.

Implemented System types are Hall1/2 (01/00,01), Room1/2/3 (02/00,01,02),
Stage1/2 (03/00,01), Plate (04/00), Chorus1/2/3/4 (41/00,01,02,08), Celeste1/2/3/4
(42/00,01,02,08), and Flanger1/2/3 (43/00,01,08). No Effect mutes the selected
System bus. An unknown MSB/LSB pair uses a diagnosed Thru; subsequent partial
writes retain the unknown address rather than the fallback processor's type.
Type changes reset program parameters before following overrides and retain
independent return/pan/send controls. Only Hall1 and Chorus1 factory programs
are published in Effect1; other program defaults are explicit host choices.

Numeric tables are transcribed unchanged: LFO 0..39.7Hz, delay offset 0..50ms,
initial/reverb delay 0.1..99.3ms, Reverb Time 0.3..30s and logarithmic EQ cutoff
frequencies. Flanger Delay Offset permits only data 0..63 (unlike Chorus/Celeste
0..127). Its LFO phase difference is (data-64)*3 degrees, data 4..124. Input
Mode selects mono/stereo for Chorus/Celeste. System mixing ignores insertion-only
Dry/Wet, and System Chorus ignores the mid-EQ fields documented for Variation
only; their valid values are retained. Reserved parameters and invalid ranges
still generate explicit diagnostics rather than a generic successful setter.

Direct CC91/93 sources preserve SoundFont/drum sends and stereo pan after voice
filter/envelope gain. Variation's stereo outputs feed the System buses before
its own pan/return; Chorus feeds Reverb before Chorus pan/return. Muting a return
does not mute its outgoing serial send. XG System On initializes Yamaha's default
programs; ordinary GS/GM mode retains its previous effects and PCM path. Processor
selection, filters, LFO phase and all feedback/ring-buffer state belong to the
synth graph, so checkpoints also restore across later type reallocations.

The DSP implementations are documented host models. Chorus uses interpolated
modulated delays; Celeste sums three LFO phases; Flanger uses separate channel
phase offsets. Depth scaling and feedback gain curves are host choices. Reverb
uses independent HPF/LPF and stereo early reflections before a common mono-fed
stereo eight-line orthogonal FDN. Per-line gain is 10^(-3*delaySeconds/RT60).
Diffusion uses feedforward allpasses; density controls reflection count; high
damping filters feedback. Room geometry, reflection taps, diffusion/damping
coefficients and balance curves are host choices, since Yamaha does not publish
its DSP. These models implement the published controls and topology without
claiming hardware PCM identity. All new DSP remains JavaScript on every backend.

Evidence: tests/xg-system-effects.test.mjs transcribes independent MU100 values,
checks HPF/LPF cutoff energy, three-phase fractional impulses, mono/stereo,
Flanger phase, early-reflection timing/side, RT60 gains/decay, all 19 programs,
serial send taps, an independent dry PCM reference on JS/WASM/SIMD, malformed
parameter handling, live F0/F7/ports, exact seeks/checkpoints with type changes,
No Effect/effects:false identity and a real selectively loaded Worker. The prior
XG Variation stereo-delay suite remains active. Variation algorithms, Insertion
routing, separate insertion slots and controller modulation remain unfinished;
the overall effects plan item is still open.


## Expanded XG Variation models (2026-10-20)

MU100 Sound List & MIDI Data printed pp.5-14,41-42 provides the membership,
block-specific diagrams, mid-EQ applicability and paired parameter addresses.
Variation now accepts exactly the eight Reverb, eleven modulation and four
delay programs implemented above. Unknown subtypes still use a diagnosed Thru;
a known MSB alone is not sufficient. The first ten parameters always retain the
MSB/LSB memory representation from Effect1, including seven-bit-valued controls.
Out-of-range combined writes do not clamp the processor parameter; subsequent
partial writes use the retained pair. Algorithm-specific ranges still apply.

Reverb's Variation diagram sums the stereo input before HPF/LPF and ER, unlike
the independent System Reverb inputs. The host uses an arithmetic mean to
normalize that sum. The common late/early model then runs in that configuration.
Variation Chorus/Celeste/Flanger enable the documented mid EQ (frequency data
14..54, gain 52..76, width 10..120); System Chorus retains these fields but ignores
them as specified. The host peak filter uses the RBJ formula with width/10 as Q;
the detailed Yamaha coefficient/bandwidth law is not published. The physical
gain, frequency lookup and width values are retained, without claiming Yamaha
hardware filter identity. Insertion-only Dry/Wet remains inaudible in System
connection. Variation Reverb's insertion parameter default is a documented host
choice of 64 instead of System Reverb's unused 0. Insertion routing is still an
explicit diagnosed Thru until the pre-volume/pan pipeline is implemented.

Evidence: tests/xg-variation-models.test.mjs checks all 23 exact addresses and
invalid subtypes, 14-bit partial writes for seven-bit algorithms, anti-phase
cancellation before Variation Reverb input filters, mid-EQ dB/width behavior
and System inapplicability, every added family through real MIDI, an independent
doubled-dry PCM reference on JS/WASM/SIMD, live F0/F7/ports, allocation-crossing
exact checkpoints/seeks and real selectively loaded Worker PCM. The existing
System and delay suites remain unchanged in scope and also pass.


## Reverb density spacing correction (2026-10-20)

MU100 Sound List & MIDI Data, printed p.23, explains Density as reflection
spacing: higher values place reflections closer together. The host ER model
now contracts its tap offsets as density increases, in addition to increasing
the reflection count. Previously it only added farther taps. Initial Delay
remains unchanged. An independent impulse test checks the first and next
reflection times and the higher concentration inside a fixed time window.


## XG Variation Insertion and part mixer (2026-10-20)

MU100 Owner's Manual printed pp.136-141 places Variation Insertion before part
volume/expression/pan. Sound List & MIDI Data pp.11-16,30,42,46,50 defines
insertion Dry/Wet, the inactive System-only controls, Variation Part, Multi Part
Dry Level/Variation Send, and per-drum-note Variation Send. Their original PDFs
and hashes are recorded above. XG drum Variation Send defaults to 127, whereas
the shared GS reset previously gave 0; this default is now separated by mode.

The selected part is summed into an owned stereo insertion bus. Attenuation
sources CC7/11 and pan source CC10 are evaluated at neutral values for the audio
stage only; original controllers, SF2 generators and modulator results remain
intact. Pitch/filter/envelope and other source modulation still use live MIDI.
The normal path remains bit-identical for unprocessed parts and Thru/fallback.
When an existing voice enters or leaves the insertion bus, its previous envelope
gain is rescaled without restarting clocks, samples, gates or release; the bound
native envelope state is committed consistently. Hold2 and exact checkpoints
retain these additional fields and the part buses, including after type changes.

Processing follows the block's dry-tap diagram: delay/modulation dry paths use
their pre-effect EQ, while Reverb dry paths branch before mono input filtering.
Insertion applies the Dry/Wet balance, then part volume/expression/pan and the
host gain/pan. Chorus/Reverb sends precede Dry Level. System-only Variation
return/pan/send controls are retained but inactive here. No Effect produces a
silent selected part without deleting notes; Thru bypasses the extra pipeline.
CC94 is retained without changing insertion selection. Multi Part Variation Send
selects/clears the part in Insertion connection, and controls CC94 depth in System.
Per-note drum Variation OFF keeps that note on its original independent path.

The post-part mixer uses a continuous squared gain curve with 14-bit controller
values and a stereo mid/side pan model; the Dry/Wet law is a linear balance.
Those curves are host choices, not published Yamaha coefficients. In this stage,
SF2 volume/pan sources define neutral instrument input rather than applying those
controls twice. Post-insertion Chorus/Reverb sends use the part's MIDI controls,
as in the device graph, rather than per-voice SF2 effect-send levels. Existing
ordinary SoundFont paths, including their bank-specific curves, remain unchanged.

Multi Part messages are framing/range checked before dispatch, and every payload
byte is consumed. Existing unsupported fields remain explicit; two-byte Detune is
kept together rather than mistaking its second byte for another command. Dry Level,
Variation Send and Rx Channel OFF now have defined behavior. Invalid receive/mono/
mode/key-shift values do not mutate the part. A mixer command outside XG mode is
diagnosed instead of silently claiming active audio routing. Separate insertion
slots and effect controller modulation were the next unfinished effect work;
see the completed Effect2 section below.

Evidence: tests/xg-insertion.test.mjs checks independent delayed dry PCM on all
three DSPs; changing volume/expression/pan after a note has entered the delay;
unchanged feedback memory during those changes; 14-bit LSB gain; host mute/gain;
Dry/Wet versus inactive System controls; isolated No Effect/Thru; serial sends
with Dry Level 0; Multi Part payload ordering/malformed records; independent ports
and actual receive-part routing; NRPN 31 per-note drum gating/defaults; Hold2,
F0/F7, live types, exact seek/checkpoint PCM, real Worker and effects:false.


## XG drive models and Insertion-specific limits (2026-10-20)

MU100 Sound List & MIDI Data printed p.16 defines Distortion49/00 and
Overdrive4A/00: Drive, low shelf, mid peak EQ, LPF, output level, Dry/Wet and
Edge. Printed pp.43-45 publishes the default Distortion program for both
Effect2 slots. The original p.16 diagrams were visually checked: Variation
adds an envelope-follower gate, whereas separate Insertion does not. The
model reflects this difference; coefficients, transfer curves and gate
threshold/times remain explicit host choices. Dry taps precede mono summing
and all wet processing. Unlisted parameters are not invented as controls.

The shared factory also enforces the smaller separate-Insertion bounds from
p.12: Delay LCR/LR lengths1..7429, Echo/Cross1..3714 (all in0.1ms units).
Reverb Density there is0..2 instead of Variation's0..4. Factory host defaults
are clipped into these valid ranges. Mid EQ in Chorus/Celeste/Flanger is only
specified for the Variation block and stays inactive in the separate slots.
All variants retain exact type membership rather than accepting an entire MSB.

Evidence: tests/xg-drive.test.mjs transcribes the published default, checks
all factory parameter limits, independent nonlinear PCM, stereo dry taps,
real EQ gain, output mute, reset and the gate distinction. The Variation
model suite now exercises all25 supported addresses through real MIDI.

## XG Effect2 slots and effect controllers (2026-10-20)

Primary references: MU100 Sound List & MIDI Data printed pp.11-16,42-45,47
(the official PDF and SHA-256 are recorded above), and MU100 Owner's Manual
printed pp.138,140-141. The original insertion signal-flow diagram on p.141
was visually checked. Effect2 uses addresses03 00 and03 01, with separate
part selection and five control depths for each slot. Both published factory
programs are Distortion49/00, Part OFF127, all control depths64.

The two slots support the same25 exact type addresses as Variation, within
the separate-Insertion parameter ranges described in the preceding section.
They run INS1 → INS2 → Variation before the selected part's mixer. Different
part assignments keep independent audio paths. Main and alternate histories,
raw bytes, base parameters, effective parameters and buffers are synth-owned
state included in exact seek/checkpoints. All supplied bytes are dispatched
in order; malformed framing is rejected before any writes. Unsupported slots,
analogue inputs and unknown algorithms remain explicit diagnostics. Unused
fields of a known algorithm are accepted as inactive fields rather than
incorrectly diagnosed as an unknown command.

MU100 pp.44-45 explicitly separates the two parameter representations:
Delay LCR/LR/Echo/Cross use14-bit fields30..43 and do not receive02..0B;
other supported types receive02..0B and ignore30..43. Partial writes retain
the complementary byte, and only valid combined values reach DSP state.
Ignored alternative representations do not alter the active parameter.

The original Control dots on pp.11-16 were visually checked at high resolution:
Drive is the controlled parameter for Distortion/Overdrive; Dry/Wet is the
controlled parameter for the supported reverb/delay/modulation types. Effect1
addresses5C..60 and Effect2 addresses0D..11 are signed depths centred at64.
Sources are MW, channel pitch bend, channel pressure, AC1 and AC2. Multi Part
addresses59 and60 assign AC1/2 CC numbers0..95, default16/17. Effect control
listens to the assigned receiver part and is inactive for System Variation.
Base program/raw parameter data is retained independently of the live overlay.
The unpublished interpolation law is represented by additive normalized signed
source/depth in parameter-data space, clamped to that parameter's legal range.
This law is a host policy, not a claim about Yamaha's DSP coefficients.

A preceding nonlinear insertion can mix drum notes whose Variation sends
have different settings. The host keeps a second copy of each slot processing
the component without Variation send. Variation receives full-output minus
that alternate output; the alternate output bypasses Variation and is added
back. This preserves full nonlinear insertion output through Variation Thru,
and a lone Variation-OFF note bypasses Variation even after prior slots.
For mixed nonlinear input, cross terms are attributed to participating notes.
Yamaha does not publish that internal separation algorithm; it is an explicit
host policy. In System connection the same decomposition weights per-note
Variation sends before applying the part's CC94 send after its mixer.

System On clears audio history but preserves Effect2 settings; All Parameter
Reset restores them. The persistence rule is explicitly documented by Yamaha
PSR2000E2 printed p.39, official source
https://usa.yamaha.com/files/download/other_assets/7/321057/PSR2000E2.pdf,
361790 bytes, SHA-256
6e9aa74aef77f4e2df56838206d22ef936d35a55061072bfa676fb96fe299262.
MU100 p.36 describes System On/mode entry without that explicit Effect2 rule;
the player adopts PSR's persistence policy, rather than claiming that the MU100
text states the same reset behavior. Malformed/nonzero reset data is rejected.

Evidence: tests/xg-insertion-slots.test.mjs checks defaults/ranges, both parameter
representations, partial/batched writes, malformed messages, analogue/reserved
addresses, exact type fallback, independent delayed PCM through three stages,
noncommutative drive/delay ordering, separate parts/ports and receive routing,
all five sources on both slots and Variation, signed depth, base-state retention,
inactive System controls, audible stored-tail modulation without voices, nonlinear
drum bypass, resets, F0/F7, Hold2, changing types, exact seeks/checkpoints on all
three DSPs, selective loading through the actual Worker and effects:false.

## MIDI Tuning Standard banks, resolution and real-time semantics (2026-10-20)

Primary reference: MIDI Association's MIDI Tuning Updated Specification,
CA-020/CA-021/RP-020, pp.1-8. Its official source, download, size and hash are
recorded in specs/README.md. MIDI1.0 pp.48-50 also defines the original format.
The updated document resolves the original dump checksum ambiguity and adds
banked/key-based/scale formats and Non-Real-Time forms.

The decoder now accepts the complete original Bulk Dump01, banked Key-Based
Dump04, Scale/Octave Dumps05/06, Single Note02/07 and channel Scale/Octave08/09.
Frequency words retain exact1/16384-semitone units. All-7F is a no-change word;
it does not erase an existing key or reset it to equal temperament. Repeated key
entries execute in payload order. Lengths/counts, framing, seven-bit values,
reserved channel-mask bits and allowed RT/NRT headers are validated before any
state mutation. Later dumps require the specified XOR checksum over the message
excluding F0, checksum and F7. For legacy01, the decoder follows p.6's permitted
policy of ignoring its historically ambiguous checksum while checking its size.
Names and all128 key frequencies are retained, including inactive programs.

Tuning memory is independent of the selected instrument and its Bank Select.
RPN3/4 select per-receiver-part tuning program/bank, use seven-bit MSB data and
RP-018 increment/decrement steps, and ignore unavailable selections. Data Entry
LSB does not reload an unchanged tuning program. Bank0/program0 starts as equal
temperament; other programs become available when received. Additional banks
allocate individual128-key Float64 tables on demand. Unset frequencies use an
internal NaN sentinel, since Scale/Octave dumps can legitimately tune key0 below
MIDI pitch0, including exactly-1. Full system reset clears the tuning store and
restores the default selection/offsets; CC121 preserves them. This reset/storage
policy is documented player behavior, not a hardware memory-persistence claim.

Each voice retains its effective tuning and direct scale offset at Note On.
RT changes update matching held/released voices without recreating notes,
samples, envelopes or phase. NRT messages update stored data/future notes and
leave existing voice values intact. A tuning-program/bank selection applies its
new current preset immediately, including to sounding notes. Channel scale
messages replace their earlier offsets rather than accumulate them, and apply
relative to the selected tuning preset. All16 channel-mask bits, independent
source ports and custom receive-channel routing are handled. Tuning memory is
device-wide; direct channel masks address only their source port's channels.

Two-byte Scale/Octave retains fractional cents (100/8192 per data step). The
voice pitch cache now uses full precision for MTS-active voices, so consecutive
sub-cent changes reach audio even within the same integer cent. Ordinary voices
keep their earlier cache behavior. A tuned Note On may choose a different SF2
sample region; its original MIDI fallback target remains separate, so subsequent
legato/return/program changes cannot inherit that region-selection pitch offset.
Sample selection clamps to SF2's0..127 key range while tuning itself keeps its
full frequency range. Original Note On/Off identity is unchanged.

Stored tables, selected bank/program and channel scale offsets survive ordinary
snapshots; effective voice state, sparse allocations and tables also survive exact
seek/checkpoints. Both catalog builds include the standalone decoder. Requests00
and03 remain explicitly unsupported until a MIDI output is supplied; they are not
misreported as successful data imports. Other proprietary patch/sample dump
families still require their own decoders and are not implied by MTS support.

Evidence: tests/midi-tuning.test.mjs checks exact words/no-change/duplicate keys,
all dump forms and checksums, names, negative and fractional offsets, independent
program/bank selection, RPN increments/LSBs, RT/NRT voice differences, exact PCM
against independent channel fine tuning on all three DSPs, successive sub-cent
pitch updates, additive preset/scale behavior, masks/ports/receive routing,
malformed messages/device IDs, snapshots/reset, legato phase/targets, F0/F7,
pedals, exact seeks/checkpoints, and actual Worker selective sample preparation.
The existing transpose fixture now explicitly selects its MTS tuning program.

## Sample Dump Standard receiver and instrument bank (2026-10-20)

Primary reference: the unchanged MIDI1.0 Detailed Specification4.2.1 in this
folder, printed pp.35-39 (PDF40-44). These pages define the SDS header, exact
significant-bit packing/offset-binary representation,120-byte packets, XOR,
packet counter/retries, ACK/NAK/CANCEL/WAIT roles, and multiple-loop messages.
No waveform/pitch/program relation is specified by SDS. The player therefore
keeps the actual protocol receiver separate from explicit instrument assignment.

The receiver owns a transfer per source port/device. It decodes the little-endian
header fields and two/three/four-byte left-justified sample words for every bit
depth8..28. All original word values are retained as Uint32; Float32 playback is
normalized around the offset-binary midpoint. High-resolution source words survive
even where Float32 audio rounds their least significant bits. No partial sample
is published. A complete sample replaces only the stored address for future
notes, and existing voices retain their old sample and clocks.

Every data record is framing/size/seven-bit checked, then XOR/packet order/padding
checked before committing words. Bad packets request retransmission; a byte-identical
repeat of the preceding packet is acknowledged without adding words. Packet127
wraps to0. This receiver tracks the required next packet and can request it when
an out-of-order packet arrives. Final unused words/bits must be zero. CANCEL and
replacement headers clear only incomplete transfer state; prior committed samples
survive. Full MIDI reset also cancels partial transfers while retaining committed
sample memory (the player's documented sampler-memory policy). Incomplete transfers
are diagnosed at stream end. The unrelated File Dump EOF does not complete SDS.

The standalone receiver can issue framed ACK/NAK/CANCEL through an injected
onReply callback. No external messages are sent by ordinary file playback.
Incoming sender-side handshakes, Dump/Loop Requests and later Extended SDS forms
remain explicit diagnostics until their respective sender/extension is implemented.
The current work does not claim arbitrary manufacturer patch-dump compatibility.

Loop Point Transmission replaces/deletes individual loop entries, including the
special delete-all number. Raw positions and every defined loop entry are retained;
a mapping selects one loop for its instrument, matching the single-loop SoundFont
rendering model. No endpoint offset is applied in the protocol store. The adapter's
explicit loopEnd setting chooses inclusive(default) or exclusive endpoint conversion.
This is a host interpretation policy rather than an extra encoded SDS field.
Bidirectional loops use an expanded forward-readable cycle without repeated turn
points. Release continues with the host envelope; its default0.1s duration is
configurable and is not attributed to the protocol.

sampleDumpMappings requires sample number, rootKey and destination program; it can
also select source SMF port/device, bank address, percussion status, loop number,
endpoint convention, display name and release. Destinations are unique. Both
selective/full-bank paths install the adapter, and metadata/part controls include
the assigned presets. Preparation observes the actual timeline: a note before
completion selects the prior instrument, while later notes select the received
bank. The source SoundFont is unchanged. A prepared result carries its mappings
into playback and rejects a conflicting mapping configuration.

Completed words/PCM have a content-verified resource cache: hashing locates a
bucket, but every word is compared before reuse. Constructed banks are cached by
wave, mapping and selected loop. These caches and native PCM allocations remain
monotonic across checkpoint restoration. Partial transfer arrays, counters, loops,
completed addresses and active instrument maps remain mutable checkpoint state.
Completion never aliases a cache resource to a writable partial transfer buffer.
This is needed when an older checkpoint resumes receipt after a newer checkpoint
has already completed it. The64MiB receiver budget counts retained decoded wave
resources, loop expansions and reservations for pending words/PCM; it is separate
from the engine's existing voice/metadata/native storage. Completed waves are not
copied into checkpoints, and repeated identical transfers do not grow the caches.

Evidence: tests/sample-dump.test.mjs independently packs every supported bit depth,
checks endpoints/zero/padding/XOR/count/order/duplicates/wrap/CANCEL/budgets, ports
and devices, loop edits and actual constructed waveforms. It compares real PCM
with an independently constructed bank on JS/WASM/SIMD, preserves held samples
across replacement, restores partial and completed transfers repeatedly, verifies
F7 commit timing/real-time exclusion, source-port mapping and public API forwarding,
selective preparation with zero downloaded bank samples, metadata, Worker, exact
seek/checkpoints and actual WASM-memory growth. A large wave is retransmitted over
multiple restores without growing its bank/PCM/native allocations.

A replay with a known header can validate each packet against cached wave
candidates without reserving another full sample. If the data first differs,
the already verified prefix is copied into a new pending transfer, subject
to the memory budget. A genuinely new wave is cancelled when it cannot fit;
an identical replay remains possible even when the cache is full. Candidate
state is checkpointed, while immutable resources stay shared. Boundary tests
cover replay, cancellation/reset and a late data difference at a full budget.

## Ordered active voice traversal (2026-10-20)

MIDI1.0 Detailed Specification printed A-4 (PDF67) leaves polyphonic voice
assignment to the receiver, while repeated Note Ons require their corresponding
Note Off identities. Printed A-5 (PDF68) requires sustain/All Notes Off to enter
release appropriately rather than abruptly discard held/releasing notes. This
optimization preserves the player's established allocation, gates and envelope
behavior; it does not reinterpret these messages or remove low-level voices.

The render/control collection is ordered by original pool index. A min-heap
returns the lowest inactive index, matching the prior linear first-free search.
A slot killed and reused before compaction keeps its existing ordered entry;
otherwise binary insertion adds its new active entry. Finished voices are removed
with stable in-place compaction during the render walk. Controller-triggered
kills mark the collection dirty; the next control traversal compacts it once.
No swap-removal or note-age reordering is used, so Float32 mixing order remains
unchanged. The last-block voice-count convention also remains unchanged.

Pedals, Note Off/fast release, channel/poly pressure, live generators/modulators
and MTS updates now walk the active collection. Release, sustain, sostenuto,
Hold2 and silent-but-still-active notes remain present until the original DSP
ends their voices. Tests instrument every inactive slot with a read counter:
subsequent render and controller operations perform zero inactive-slot reads.
Initial allocation/native binding and explicit cap/checkpoint rebuilds still
visit retained storage; those operations are outside the audio-block hot path.

Checkpoint restoration rebuilds active/free membership after deactivating new
slots retained from later pool growth. Native memory/sample caches stay
monotonic as before. Automatic allocation also reuses retained slots above a
previously lowered cap, instead of allocating a far-away slot outside the newly
extended render cap. Explicit fixed-cap priority replacement keeps its prior
policy. The C sources, ABI and generated WASM modules are unchanged.

Evidence: tests/active-voices.test.mjs uses a linear first-free oracle through
4000 irregular allocation/release operations, then compares actual full-pool
scan rendering against active rendering on JS/WASM/SIMD. It checks a1024-note
burst, holes/reuse, sparse continuation, pedals/pressure, EOF, temporary caps,
explicit priority replacement, repeated checkpoint restoration and later pool/
WASM growth. Separate performance runs load the previous committed modules and
compare complete measured PCM while alternating128-frame blocks. Full logs,
hashes, medians and reproduction commands are in DSP-PERFORMANCE.md.


## Batched C voices (20 October 2026)

MIDI 1.0 Detailed Specification v4.2.1, Appendix A-4/A-5 (PDF pages 67–68),
allows receiver voice assignment policies but requires corresponding Note Off
handling, sustain-aware All Notes Off and release rather than abrupt truncation.
It also requires input messages not to be lost during ongoing processing.
This optimization changes neither MIDI dispatch nor those policies: the host
prepares a batch inside the existing 1–128-frame audio block, after ordered MIDI
handling, and executes its voice commands in the existing pool-slot order.
It never merges, skips, quantizes anew or reorders MIDI commands or voice tails.

The optional batch extension 1 preserves the base DSP ABI 1. The host expands
136-byte wasm32 descriptors geometrically, with no musical voice count limit.
Per-voice filter history remains in the bound native arena; coefficients are
written by the host and observable JS history is synchronized after rendering.
A transition from the immediate renderer copies its latest history once.
Volume envelopes remain in their existing bound state. Modulation envelopes
still use individual C calls where their results are needed to prepare pitch
or cutoff; one batch does not mean all JS/C crossings have disappeared.

For 16 or more listed voices, the main stereo process wrapper submits one
render batch before effects. Fewer voices keep immediate rendering, avoiding
measured setup overhead; all voices are still rendered. A plain multi-output
call outside that wrapper retains the existing immediate behavior. Unsupported
older DSP modules also retain their immediate path. This is an internal dispatch
threshold, not a polyphony limit or a perceptual/silence cutoff.

For non-Hermite interpolation the host retains each precomputed waveform until
C consumes it. XG insertion/variation/system sends receive each voice's own
filtered/enveloped PCM in the same order, including its final partial/EOF block.
Command/payload relocation and native memory growth refresh every affected view
and queued pointer. Transient command storage is excluded from checkpoints;
per-voice native filter/envelope state remains included. Capacity and immutable
sample caches stay monotonic across restoration.

Evidence: native/test_dsp.c compares sequential and batched filters, envelopes,
oscillators, captures and all seven output/send buffers with no tolerance at
block lengths 1/3/127/128. tests/dsp.test.mjs checks wasm32 layout against the
native golden output and atomic rejection of malformed batches.
tests/voice-batch.test.mjs compares exact actual PCM/state through mixed
interpolation, XG routing changes, pedals, sample EOF, sparse/dense transitions,
late sample allocation, descriptor/payload/pool growth and repeated checkpoints
on scalar/SIMD. Full MIDI/Worker/seek regression tests remain applicable.


## SIMD across independent voice filters (20 October 2026)

MIDI 1.0 v4.2.1 Appendix A-4/A-5 remains the voice/hold/order reference. This
change is inside the ordered C audio batch; it does not alter MIDI parsing,
event times, assignment policies, pedal/release processing or transport.
Pairs are adjacent existing commands, with a scalar remainder. No regrouping
by timbre, pitch or channel occurs, and every original command still executes.

The existing AoS per-voice filter histories stay bound and checkpointable.
At pair entry, corresponding coefficients/history/gain fields are transposed
into f64x2 SoA registers, one independent voice per lane. Recurrence advances
in original sample order within each lane. Filter history remains Float64;
processed PCM is explicitly demoted to Float32 after gain at the original
rounding point. Dry/insertion/send buffers are accumulated in voice A/B order.
C/WASM flags still prohibit fast math, contraction and relaxed SIMD.

The paired path requires disjoint mutable states and no cross-voice read/write
dependencies. Range checks include partly overlapping filter/envelope states,
capture/input aliases, source/table/descriptor reads and scratch aliases. Input is copied before
its own volume envelope is updated, retaining the original intra-voice order. A dependent or
unfiltered command retains ordinary sequential processing, including its last
EOF/release block. The descriptor retains batch extension 1 and its 136-byte wasm32 layout. Optional
exports provide a sequential-filter reference and last-valid-batch pair counts.
The non-SIMD module and direct single-voice renderer retain their existing DSP.

Evidence: native golden hashes come from five independent ordinary C voice calls
with rational source/lookup inputs, at block sizes 1/3/127/128. The SIMD result
matches them exactly. Separate same-module tests compare complete PCM/filter/
envelope/capture/cursor/activity bytes, mixed flags, 2053 voices, memory growth
and dependent ranges. Actual synth tests confirm pair use and compare both
exports through XG/control changes, Hold2/sustain/release and repeated checkpoints.
The full MIDI/Worker/seek suite and paired actual-player benchmarks also apply.
