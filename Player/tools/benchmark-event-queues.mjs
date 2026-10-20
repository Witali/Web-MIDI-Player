import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as current from '../vendor/spessasynth.js';
import {installVoiceDSP} from '../voice-dsp.js';
import {installGSEffects} from '../gs-effects.js';
import {installXGVariation} from '../xg-variation.js';
import {createSoundFontPreview} from '../soundfont-preview.js';
import {readMidi} from '../../src/midi-metadata.mjs';
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const baseline = option('--baseline', null); if (!baseline) throw new Error('Pass --baseline PATH to the previous Player directory.');
const root = pathToFileURL(path.resolve(baseline) + path.sep);
const old = await import(new URL('vendor/spessasynth.js', root));
const oldDSP = await import(new URL('voice-dsp.js', root)), oldGS = await import(new URL('gs-effects.js', root)), oldXG = await import(new URL('xg-variation.js', root));
const oldPreview = await import(new URL('soundfont-preview.js', root)), oldMetadata = await import(new URL('../src/midi-metadata.mjs', root));
current.SpessaLog.setLogLevel(false, false, false); old.SpessaLog.setLogLevel(false, false, false);
const versions = {before: {vendor: old, dsp: oldDSP.installVoiceDSP, gs: oldGS.installGSEffects, xg: oldXG.installXGVariation, preview: oldPreview.createSoundFontPreview, metadata: oldMetadata.readMidi},
  after: {vendor: current, dsp: installVoiceDSP, gs: installGSEffects, xg: installXGVariation, preview: createSoundFontPreview, metadata: readMidi}};
const counts = option('--counts', '1000,4000,16000').split(',').map(Number), rounds = Number(option('--rounds', 5)), dsp = option('--dsp', 'wasm');
if (!counts.every(n => Number.isInteger(n) && n > 0) || !Number.isInteger(rounds) || rounds < 1) throw new RangeError('Invalid dimensions.');
if (!['js', 'wasm', 'wasm-simd'].includes(dsp)) throw new Error('Invalid DSP.');
const sha = data => createHash('sha256').update(data).digest('hex'), median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const bankBytes = await fs.readFile(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = current.SoundBankLoader.fromArrayBuffer(bankBytes.buffer.slice(bankBytes.byteOffset, bankBytes.byteOffset + bankBytes.byteLength));
const vlq = value => { const out = [value & 127]; while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 128); return out; };
function file(events) {
  const body = Buffer.from(events.flat()), header = Buffer.from('4d546864000000060000000103e84d54726b00000000', 'hex');
  header.writeUInt32BE(body.length, 18); return new Uint8Array(Buffer.concat([header, body]));
}
function controllers(n) {
  return file([[0, 255, 81, 3, 7, 161, 32], [0, 0xc0, 81], [0, 0x90, 60, 100], [0, 0x90, 67, 90],
    ...Array.from({length: n}, (_, i) => [...vlq(i ? 0 : 1000), 0xb0, [1, 10, 11, 74][i % 4], 1 + i * 17 % 127]),
    [...vlq(500), 0x80, 60, 64], [0, 0x80, 67, 64], [...vlq(500), 255, 47, 0]]);
}
function repeated(n) {
  return file([[0, 255, 81, 3, 7, 161, 32], ...Array.from({length: n}, (_, i) => [0, 0x90, 60, 1 + i % 127]),
    ...Array.from({length: Math.floor(n * .75)}, () => [1, 0x80, 60, 64]), [1, 255, 47, 0]]);
}
const parse = (vendor, bytes) => vendor.BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
async function synth(version) {
  const s = new version.vendor.SpessaSynthProcessor(48000, {effectsEnabled: false, eventsEnabled: false, maxBufferSize: 128});
  s.onMissingPreset = (p, system) => bank.getPreset(p, system); s.soundBankManager.addSoundBank(bank, 'main'); await s.processorInitialized;
  version.gs(s); version.xg(s); s.setSystemParameter('autoAllocateVoices', true); s.setSystemParameter('blackMIDIMode', false); s.setSystemParameter('monophonicRetrigger', false);
  if (dsp !== 'js') await version.dsp(s, dsp); return s;
}
const hashPCM = rows => { const h = createHash('sha256'); for (const row of rows) h.update(new Uint8Array(row.buffer, row.byteOffset, row.byteLength)); return h.digest('hex'); };
async function scheduled(version, plan, count) {
  const s = await synth(version), core = s.synthCore, out = [new Float32Array(60000), new Float32Array(60000)]; let seen = 0, dispatched = false;
  const original = core.processMessageInternal.bind(core);
  core.processMessageInternal = (raw, offset) => { if (raw !== plan[seen]?.raw || offset !== 0) throw new Error('Lost/reordered scheduled MIDI command at ' + seen); seen++; original(raw, offset); };
  try {
    global.gc?.(); const started = performance.now(); for (const e of plan) s.processMessage(e.raw, 0, {time: e.time});
    const enqueue = performance.now() - started;
    if (core.eventQueue.length !== count + 2) throw new Error('Wrong queued message count');
    let at = 0, firstBlock = 0, dispatch = 0;
    while (at < out[0].length) {
      const n = Math.min(128, out[0].length - at), burst = !dispatched && core.currentTime >= .5;
      if (at === 0 || burst) { const t = performance.now(); s.process(...out, at, n); const elapsed = performance.now() - t;
        if (at === 0) firstBlock = elapsed; else { dispatch = elapsed; dispatched = true; }
      } else s.process(...out, at, n);
      at += n;
    }
    if (!dispatched || seen !== plan.length || core.eventQueue.length) throw new Error('Incomplete scheduled stream');
    return {phases: {enqueue, firstBlock, dispatch, totalQueuePhases: enqueue + firstBlock + dispatch}, pcm: hashPCM(out), commands: seen};
  } finally { s.stopAllChannels(true); }
}
async function direct(version, bytes) {
  const p = await version.preview(bytes, bank, {dsp, effects: false});
  try { global.gc?.(); const t = performance.now(), out = p.read(60000), elapsed = performance.now() - t;
    return {phases: {render: elapsed}, pcm: hashPCM(out)};
  } finally { p.close(); }
}
async function noteReader(version, bytes, kind) {
  const parsed = kind === 'basic-note-times' ? parse(version.vendor, bytes) : null;
  global.gc?.(); const t = performance.now(), value = parsed ? parsed.getNoteTimes() : version.metadata(bytes);
  const elapsed = performance.now() - t; return {phases: {read: elapsed}, json: sha(JSON.stringify(value))};
}
const fixtureRoot = path.resolve('.cache/event-queue-fixtures'); await fs.mkdir(fixtureRoot, {recursive: true});
const output = {date: new Date().toISOString(), cpu: os.cpus()[0].model, node: process.version, rounds, counts, dsp, explicitGc: !!global.gc,
  baselineRoot: path.resolve(baseline), baselineCommit: option('--baseline-commit', null),
  scope: 'Actual previous/current code; source SMF files saved under .cache/event-queue-fixtures. Scheduled API measures enqueue, first observation block and due burst block separately; full 60000-frame PCM and every raw message identity/order checked. Direct SMF measures complete render without using the future queue. Note readers compare full JSON. Parsing/initialization/GC excluded except catalog reader includes its own parse. Modes rotate between rounds.',
  sourceHashes: {beforeVendor: sha(await fs.readFile(new URL('vendor/spessasynth.js', root))), afterVendor: sha(await fs.readFile(new URL('../vendor/spessasynth.js', import.meta.url))),
    beforeMetadata: sha(await fs.readFile(new URL('../src/midi-metadata.mjs', root))), afterMetadata: sha(await fs.readFile(new URL('../../src/midi-metadata.mjs', import.meta.url))), queue: sha(await fs.readFile(new URL('../event-queue.js', import.meta.url))), bank: sha(bankBytes)}, cases: []};
for (const count of counts) {
  const midi = controllers(count), notes = repeated(count), parsed = parse(current, midi), plan = [];
  for (const item of parsed.timeline) { const e = parsed.tracks[item.tr].events[item.ev]; if (e.statusByte >= 0x80 && e.statusByte < 0xf0) plan.push({time: parsed.midiTicksToSeconds(e.ticks), raw: new Uint8Array([e.statusByte, ...e.data])}); }
  if (plan.length !== count + 5) throw new Error('Invalid controller fixture');
  const controllerFile = path.join(fixtureRoot, 'controllers-' + count + '.mid'), notesFile = path.join(fixtureRoot, 'repeated-' + count + '.mid');
  await fs.writeFile(controllerFile, midi); await fs.writeFile(notesFile, notes);
  for (const kind of ['scheduled-api', 'direct-smf', 'basic-note-times', 'catalog-note-times']) {
    const times = {before: [], after: []}; let digest, commands;
    for (let round = 0; round < rounds; round++) {
      const pair = {};
      for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        pair[mode] = kind === 'scheduled-api' ? await scheduled(versions[mode], plan, count)
          : kind === 'direct-smf' ? await direct(versions[mode], midi) : await noteReader(versions[mode], notes, kind);
        times[mode].push(pair[mode].phases);
      }
      const key = kind.includes('note-times') ? 'json' : 'pcm';
      if (pair.before[key] !== pair.after[key]) throw new Error('Output mismatch: ' + kind + ' count=' + count + ' round=' + round);
      digest = pair.after[key]; commands = pair.after.commands;
    }
    const phases = Object.keys(times.before[0]), medians = {}, pairedSpeedup = {};
    for (const phase of phases) { medians[phase] = {before: median(times.before.map(v => v[phase])), after: median(times.after.map(v => v[phase]))};
      pairedSpeedup[phase] = median(times.before.map((v, i) => v[phase] / times.after[i][phase])); }
    const source = kind.includes('note-times') ? notes : midi;
    const result = {kind, count, commands, sourceFile: kind.includes('note-times') ? notesFile : controllerFile, fileBytes: source.length, fileSha256: sha(source), times, medians, pairedSpeedup,
      exactPCM: !kind.includes('note-times'), exactJSON: kind.includes('note-times'), outputSha256: digest};
    output.cases.push(result); console.log(JSON.stringify({kind, count, medians, pairedSpeedup, exact: true}));
  }
}
await fs.writeFile(path.resolve(option('--output', 'Player/dsp/benchmark-event-queues.json')), JSON.stringify(output, null, 2) + '\n');
