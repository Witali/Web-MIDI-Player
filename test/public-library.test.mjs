import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildPublicLibrary, publicLibraryCsv } from '../src/public-library.mjs';
import { verifyBrowserBank } from '../Player/tools/verify-browser-bank.mjs';
import { renderCatalog, writeCatalog } from '../src/catalog-output.mjs';

const source = fileURLToPath(new URL('../public-library/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
function fixture(t) {
  const root = fileURLToPath(new URL('../.cache/public-library-tests/', import.meta.url)).replace(/[\\/]+$/, '');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  const copy = { ...structuredClone(manifest), tracks: [structuredClone(manifest.tracks[0])] };
  const track = copy.tracks[0];
  for (const file of [track.file, track.rights.sourceFile]) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target);
  }
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(copy));
  save();
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), root); assert.ok(path.basename(directory).startsWith('run-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, manifest: copy, track, save };
}

test('public catalog contains exactly the reviewed MIDI files and preserves their rights evidence', () => {
  const library = buildPublicLibrary(source);
  assert.equal(library.mode, 'public');
  assert.equal(library.items.length, manifest.tracks.length);
  assert.deepEqual(new Set(library.items.map(item => item.id)), new Set(manifest.tracks.map(track => track.sha256)));
  assert.ok(library.items.every(item => item.playable && item.noteCount > 0 && item.duration > 0 && item.rights.contributor));
  assert.match(publicLibraryCsv(library), /Статус прав/);
  assert.match(publicLibraryCsv(library), /Public Domain/);
});

test('unlisted MIDI files never become public catalog entries', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(f.directory, f.track.file), path.join(f.directory, 'midi/unreviewed.mid'));
  const library = buildPublicLibrary(f.directory);
  assert.equal(library.items.length, 1);
  assert.equal(library.items[0].versions[0].file, f.track.file);
});

test('public build rejects missing declarations, evidence and non-reviewed source hosts', t => {
  const f = fixture(t);
  f.track.rights.status = 'unknown'; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /reviewed public-domain/);
  f.track.rights.status = 'public-domain'; f.track.rights.edition = ''; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /Missing public-library evidence/);
  f.track.rights.edition = 'Original edition'; f.track.rights.sourcePage = 'https://www.midiworld.com/'; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /Unreviewed public-library source URL/);
});

test('public build rejects changed MIDI or notation sources', t => {
  const f = fixture(t), midi = path.join(f.directory, f.track.file);
  fs.appendFileSync(midi, Buffer.from([0]));
  assert.throws(() => buildPublicLibrary(f.directory), /checksum mismatch/);
  fs.copyFileSync(path.join(source, f.track.file), midi);
  fs.appendFileSync(path.join(f.directory, f.track.rights.sourceFile), '\n');
  assert.throws(() => buildPublicLibrary(f.directory), /checksum mismatch/);
});

test('public build rejects paths outside the reviewed collection and duplicate entries', t => {
  const f = fixture(t);
  f.track.file = '../downloads/private.mid'; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /Invalid public MIDI path/);
  f.track.file = manifest.tracks[0].file;
  f.track.rights.sourceFile = '../README.md'; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /Invalid notation source path/);
  f.track.rights.sourceFile = manifest.tracks[0].rights.sourceFile;
  f.manifest.tracks.push(structuredClone(f.track)); f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /duplicate public-library key/);
});

test('public and local catalog HTML has valid inline JavaScript and safe embedded data', () => {
  const library = buildPublicLibrary(source);
  library.items[0].title = '</script><script>throw new Error("injected")</script>\u2028\u2029';
  for (const mode of ['public', undefined]) {
    library.mode = mode;
    const html = renderCatalog(library);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 3);
    const data = scripts.find(script => script[1].includes('application/json'));
    assert.equal(JSON.parse(data[2]).items[0].title, library.items[0].title);
    for (const script of scripts.filter(script => !script[1].includes('application/json'))) new vm.Script(script[2]);
    assert.ok(html.includes(mode === 'public' ? 'PUBLIC DOMAIN' : 'OFFLINE LIBRARY'));
    assert.ok(!html.includes('/* CATALOG_'));
  }
});

test('public export includes verified standalone sample files and omits the full SF2', t => {
  const f = fixture(t), output = path.join(f.directory, 'export');
  writeCatalog(output, buildPublicLibrary(f.directory));
  assert.ok(fs.existsSync(path.join(output, 'player/lazy-bank.js')));
  assert.ok(!fs.existsSync(path.join(output, 'player/soundfonts/FluidR3_GM.sf2')));
  const bank = verifyBrowserBank(path.join(output, 'player/soundfonts/fluidr3-gm'));
  assert.equal(bank.total.unique_files, 1418);
  assert.ok(fs.existsSync(path.join(output, 'player/licenses/FluidR3-MIT.txt')));
});
