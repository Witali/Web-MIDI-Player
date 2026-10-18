import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { readMidi } from '../src/midi-metadata.mjs';
import { modernIndex, legacyIndex, packLabel, chooseLabel, csvText, groupRelated } from '../src/library.mjs';


import { createCatalogServer } from '../catalog-server.mjs';

function temp(t) {
  const root = fileURLToPath(new URL('../.cache/catalog-tests/', import.meta.url)).replace(/[\\/]+$/, '');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => { const target = path.resolve(directory); assert.equal(path.dirname(target), root);
    assert.ok(path.basename(target).startsWith('run-')); fs.rmSync(target, { recursive: true, force: true }); });
  return directory;
}
function vlq(value) { const result = [value & 127]; while ((value = Math.floor(value / 128))) result.unshift((value & 127) | 128); return result; }
function midi(events, division = 480) {
  const body = Buffer.from(events.flat());
  const header = Buffer.from('4d546864000000060000000100004d54726b00000000', 'hex');
  header.writeUInt16BE(division, 12); header.writeUInt32BE(body.length, 18);
  return Buffer.concat([header, body]);
}
const sample = midi([[0, 0x90, 60, 100], [...vlq(480), 0x80, 60, 0], [0, 255, 47, 0]]);

test('MIDI duration follows sounding notes and excludes silent end-of-track tails', () => {
  const bytes = midi([[0, 0x90, 60, 100], [...vlq(480), 0x80, 60, 0], [...vlq(480000), 255, 47, 0]]);
  for (const includeNotes of [true, false]) {
    const result = readMidi(bytes, { includeNotes });
    assert.equal(result.duration, .5); assert.equal(result.fileDuration, 500.5);
    assert.equal(result.noteCount, 1); assert.deepEqual(result.instruments, ['Фортепиано']);
  }
});
test('MIDI reader applies tempo changes, running status, sustain, programs and SMPTE', () => {
  const bytes = midi([[0, 0xc0, 24], [0, 0x90, 60, 100], [...vlq(480), 60, 0],
    [0, 255, 81, 3, 15, 66, 64], [0, 0xb0, 64, 127], [0, 0x90, 64, 100],
    [...vlq(240), 0x80, 64, 0], [...vlq(240), 0xb0, 64, 0], [0, 255, 47, 0]]);
  const result = readMidi(bytes);
  assert.equal(result.duration, 1.5); assert.equal(result.notes.length, 2);
  assert.equal(result.notes[1].end, 1.5); assert.equal(result.tempoMin, 60); assert.equal(result.tempoMax, 120);
  assert.deepEqual(result.instruments, ['Гитара']);
  const smpte = midi([[0, 0x90, 60, 100], [...vlq(1000), 0x80, 60, 0], [0, 255, 47, 0]], 0xe728);
  assert.equal(readMidi(smpte).duration, 1); assert.equal(readMidi(smpte).tempo, null);
});
test('metadata repair keeps nested parentheses in titles and corrects archive uploaders', () => {
  const html = '<div id="navigation"><li>MAIN</li></div><div id="page"><li>Song (Part 1) (Band (Live)) - <a href="/download/1">download</a></li><li><span>Other (Part 2)</span> (Queen) - <a href="/download/2">download</a></li></div><div id="sidebar"></div>';
  const entries = modernIndex(html);
  assert.deepEqual(entries.get('https://www.midiworld.com/download/1'), { title: 'Song (Part 1)', artist: 'Band (Live)' });
  assert.deepEqual(entries.get('https://www.midiworld.com/download/2'), { title: 'Other (Part 2)', artist: 'Queen' });
  assert.deepEqual(packLabel({ archiveMember: 'Musics/Queen - Bohemian Rhapsody.mid', artist: 'uploader' }),
    { title: 'Bohemian Rhapsody', artist: 'Queen', inferred: true });
  const parentUrl = 'https://www.midiworld.com/download/99';
  const archiveLabel = chooseLabel([{ key: 'id:99!song', url: parentUrl, archiveParent: 'id:99',
    archiveMember: 'Musics/Queen - Bohemian Rhapsody.mid', artist: 'uploader', filename: 'midi/a.mid' }],
    new Map([[parentUrl, { title: 'Rename this MIDI to ZIP', artist: 'uploader' }]]));
  assert.equal(archiveLabel.title, 'Bohemian Rhapsody'); assert.equal(archiveLabel.artist, 'Queen');
  const classical = legacyIndex('<font size="3">Albéniz, </font> Isaac (1860-1909)<ul><li>España (Op.65) - <i>Sequencer</i><ul><li><a href="/a.mid">Prelude</a></ul></ul>', 'https://www.midiworld.com/classic.htm');
  assert.equal(classical.get('https://www.midiworld.com/a.mid').artist, 'Isaac Albéniz');
  assert.equal(classical.get('https://www.midiworld.com/a.mid').title, 'España (Op.65) — Prelude');
  assert.equal(chooseLabel([{ key: 'id:1', title: 'Name', artist: 'Albeniz Isaac', filename: 'midi/a.mid' }], new Map(), ['Isaac Albéniz']).artist, 'Isaac Albéniz');
  assert.ok(csvText([['=1+1']]).includes("'=1+1"));
});
test('related-version metadata grows linearly even when many source labels match', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i).padStart(64, '0'), title: 'Theme', artist: 'Composer' }));
  const families = groupRelated(items);
  assert.equal(Object.keys(families).length, 1);
  assert.equal(families[items[0].family].length, 200);
  assert.ok(JSON.stringify({ items, families }).length < 60000);
});
test('local catalog server serves MIDI and rejects filesystem traversal and writes', async t => {
  const directory = temp(t); fs.mkdirSync(path.join(directory, 'midi'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<h1>Catalog</h1>');
  fs.writeFileSync(path.join(directory, 'midi/song.mid'), sample);
  fs.writeFileSync(path.join(directory, 'manifest.json'), 'private metadata');
  const { server } = createCatalogServer(directory);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/midi/song.mid`)).arrayBuffer()), sample);
  assert.equal((await fetch(`${base}/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/midi/%2e%2e%2fmanifest.json`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
