import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaLog } from '../vendor/spessasynth.js';
import { normalizeSmpteTiming } from '../midi-timing.js';
import { diagnoseMidi } from '../midi-diagnostics.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { midi, midiTracks, panned, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const bankBytes = fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bankBytes.buffer.slice(bankBytes.byteOffset, bankBytes.byteOffset + bankBytes.byteLength));
const parse = bytes => normalizeSmpteTiming(BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
const ending = [[0, 0x90, 60, 100], [...vlq(480), 0x80, 60, 0], [0, 255, 47, 0]];
const sysex = data => [0, 0xf0, ...vlq(data.length), ...data];
const audit = (events, options) => diagnoseMidi(parse(midi([...events, ...ending])), bank, options);

test('ordinary GM commands have no notices; analysis preserves the original events and global logging hook', async () => {
  const source = parse(panned(0, true)), before = source.writeMIDI();
  const previous = () => { throw new Error('The host hook must not run inside an audit'); };
  SpessaLog.onDiagnostic = previous;
  try {
    const report = await diagnoseMidi(source, bank);
    assert.equal(report.complete, true);
    assert.equal(report.eventsScanned, source.timeline.length);
    assert.deepEqual(report.entries, []);
    assert.deepEqual(source.writeMIDI(), before);
    assert.equal(SpessaLog.onDiagnostic, previous);
  } finally { SpessaLog.onDiagnostic = null; }
});

test('metadata reports late preset substitutions before playback, with the actual selected sound', async () => {
  const source = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(960), 0x80, 60, 0],
    [0, 0xb0, 0, 119], [0, 0xb0, 32, 119], [0, 0xc0, 81], ...ending]);
  const preview = await createSoundFontPreview(source, bank, { effects: false });
  try {
    assert.equal(preview.stats.position, 0);
    const entry = preview.stats.diagnostics.entries.find(e => e.code === 'preset-substitution');
    assert.equal(entry.first.seconds, 1);
    assert.equal(entry.requested.bankMSB, 119);
    assert.equal(entry.requested.bankLSB, 119);
    assert.equal(entry.actual.program, 81);
    assert.equal(entry.actual.bankMSB, 0);
    assert.ok(entry.actual.name);
    const report = structuredClone(preview.stats.diagnostics);
    preview.read(4096); await preview.seek(.5); preview.read(128);
    assert.deepEqual(preview.stats.diagnostics, report, 'Playback and seeking must not duplicate the file report');
    assert.ok(preview.read(4096).some(channel => channel.some(n => Math.abs(n) > .001)));
  } finally { preview.close(); }
  const selectWithoutProgram = await audit([[0, 0xb0, 0, 119], [0, 0xb0, 32, 119]]);
  assert.equal(selectWithoutProgram.summary.substituted, 0, 'Bank Select alone does not choose a new preset');
});

test('pedals and relative entry are distinguished from bank-dependent CCs and Note Off velocity', async () => {
  const report = await audit([[0, 0xb0, 66, 127], [0, 0xb0, 66, 0], [0, 0xb0, 68, 127], [0, 0xb0, 69, 127],
    [0, 0xb0, 96, 0], [0, 0xb0, 97, 0], [0, 0xb0, 22, 127], [0, 0xa0, 60, 100],
    [0, 0x80, 60, 64], [0, 0xb0, 7, 80], [0, 0xb0, 10, 0], [0, 0xb0, 64, 127], [0, 0xb0, 64, 0]]);
  assert.equal(report.entries.find(e => e.controller === 66).count, 2);
  assert.equal(report.summary.partial, 5);
  assert.equal(report.summary.unsupported, 2);
  assert.equal(report.summary.bankDependent, 2);
  assert.equal(report.entries.find(e => e.controller === 22).status, 'bankDependent');
  assert.ok(report.entries.every(e => ![7, 10, 64].includes(e.controller)));
});

test('supported resets, unknown manufacturers, unverified SysEx and GS effect fallback remain distinct', async () => {
  const report = await audit([
    sysex([0x7e, 0x7f, 9, 1, 0xf7]),
    sysex([0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7]),
    sysex([0x7e, 0x7f, 9, 1, 0xf7]),
    sysex([1, 0x7f, 0, 0, 0xf7]),
    sysex([0x43, 0x10, 0x4c, 0, 0, 0x55, 0, 0xf7]),
    sysex([0x41, 0x10, 0x42, 0x12, 0x40, 3, 0, 0x7f, 0x7f, 0x3f, 0xf7])
  ]);
  assert.ok(report.entries.some(e => e.code === 'unsupported-message' && e.reason.includes('manufacturer')));
  assert.ok(report.entries.some(e => e.code === 'unverified-sysex' && e.data[5] === 0x55));
  assert.ok(report.entries.some(e => e.code === 'unsupported-effect' && e.reason.includes('Thru')));
  assert.ok(!report.entries.some(e => e.code === 'unverified-sysex' && e.data[0] === 0x7e));
});

test('unsupported RPN and NRPN values are reported; implemented and null RPN are accepted', async () => {
  const report = await audit([[0, 0xb0, 101, 0], [0, 0xb0, 100, 0], [0, 0xb0, 6, 2],
    [0, 0xb0, 100, 99], [0, 0xb0, 6, 12], [0, 0xb0, 101, 127], [0, 0xb0, 100, 127], [0, 0xb0, 6, 0],
    [0, 0xb0, 99, 125], [0, 0xb0, 98, 126], [0, 0xb0, 6, 10]]);
  assert.deepEqual(report.entries.filter(e => e.status === 'unsupported').map(e => [e.feature, e.data]),
    [['RPN', [0, 99]], ['NRPN', [125, 126]]]);
});

test('same channels on different MIDI ports retain independent program, controller and timing context', async () => {
  const source = parse(midiTracks([
    [[0, 255, 81, 3, 7, 161, 32], [...vlq(480), 255, 81, 3, 15, 66, 64], [0, 255, 47, 0]],
    [[0, 255, 33, 1, 10], [0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(960), 0xb0, 66, 127], ...ending],
    [[0, 255, 33, 1, 20], [0, 0xb0, 0, 119], [0, 0xc0, 81], [0, 0x90, 67, 100], [...vlq(960), 0xb0, 69, 127], ...ending]
  ]));
  const report = await diagnoseMidi(source, bank);
  assert.equal(report.entries.find(e => e.controller === 66).first.port, 10);
  assert.equal(report.entries.find(e => e.controller === 69).first.port, 20);
  assert.equal(report.entries.find(e => e.controller === 69).first.channel, 1);
  assert.equal(report.entries.find(e => e.controller === 69).first.seconds, 1.5);
  assert.equal(report.entries.filter(e => e.code === 'preset-substitution').length, 1);
  assert.equal(report.entries.find(e => e.code === 'preset-substitution').first.port, 20);
  const smpte = parse(midi([[...vlq(1000), 0xb0, 66, 127], ...ending], (231 << 8) | 40));
  assert.equal((await diagnoseMidi(smpte, bank)).entries[0].first.seconds, 1);
});

test('large files aggregate repetitions, bound report size and restore hooks across asynchronous yields', async () => {
  const events = Array.from({ length: 4200 }, () => [0, 0xb0, 66, 127]);
  const source = parse(midi([...events, ...Array.from({ length: 10 }, (_, i) => sysex([1, 0x7f, i, 0, 0xf7])), ...ending]));
  const [large, clean] = await Promise.all([diagnoseMidi(source, bank, { maxEntries: 3 }), audit([])]);
  assert.equal(large.entries.length, 3);
  assert.equal(large.entries[0].count, 4200);
  assert.equal(large.omitted, 8);
  assert.equal(large.summary.partial, 4200);
  assert.equal(large.summary.unsupported, 10);
  assert.equal(large.eventsScanned, source.timeline.length);
  assert.deepEqual(clean.entries, []);
  assert.equal(SpessaLog.onDiagnostic, null);
});
