import { writePwa } from '../src/pwa-output.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildPublicLibrary, publicLibraryCsv } from '../src/public-library.mjs';
import { verifyBrowserBank } from '../Player/tools/verify-browser-bank.mjs';
import { renderCatalog, writeCatalog } from '../src/catalog-output.mjs';

const source = fileURLToPath(new URL('../public-library/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
function fixture(t, key = manifest.tracks[0].key) {
  const root = fileURLToPath(new URL('../.cache/public-library-tests/', import.meta.url)).replace(/[\\/]+$/, '');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  const copy = { ...structuredClone(manifest), tracks: [structuredClone(manifest.tracks.find(track => track.key === key))] };
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

test('the reviewed CC0 Bumblebee keeps its full piano reduction and original MusicXML', t => {
  const f = fixture(t, 'rimsky-korsakov-flight-of-the-bumblebee');
  const [item] = buildPublicLibrary(f.directory).items;
  assert.equal(item.title, 'Полёт шмеля');
  assert.equal(item.artist, 'Николай Римский-Корсаков');
  assert.equal(item.rights.label, 'CC0 1.0 (Public Domain)');
  assert.equal(item.tempo, 144);
  assert.ok(item.duration > 93 && item.duration < 95);
  assert.equal(item.noteCount, 1283);
  assert.deepEqual(item.instruments, ['Фортепиано']);
  const original = fs.readFileSync(path.join(f.directory, f.track.rights.sourceFile));
  assert.equal(original.readUInt32LE(), 0x04034b50);
  assert.match(item.rights.sourceFile, /\.mxl$/);
  assert.ok(item.aliases.includes('Полет шмеля') && item.aliases.includes('Flight of the Bumblebee'));
});

test('the generated CC0 edition rejects unreviewed source paths and missing conversion evidence', t => {
  const f = fixture(t, 'rimsky-korsakov-flight-of-the-bumblebee');
  const approved = { ...f.track.rights };
  for (const name of ['sourcePage', 'sourceUrl', 'midiUrl', 'declarationUrl']) {
    f.track.rights = { ...approved, [name]: approved[name] + 'unreviewed' }; f.save();
    assert.throws(() => buildPublicLibrary(f.directory), /Unreviewed public-library source URL/);
  }
  f.track.rights = { ...approved, modifications: '' }; f.save();
  assert.throws(() => buildPublicLibrary(f.directory), /Missing public-library evidence: modifications/);
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
  for (const name of ['web-midi.js','live-midi.js','live-synth.js','live-worker.js','live-worklet.js','devices-view.js']) {
    assert.ok(!fs.existsSync(path.join(output, 'player', name)), 'External MIDI stays optional: ' + name);
  }
  assert.ok(!fs.existsSync(path.join(output, 'player/soundfonts/FluidR3_GM.sf2')));
  assert.ok(!fs.existsSync(path.join(output, 'player/soundfonts/FluidR3_GS.sf2')));
  assert.ok(fs.existsSync(path.join(output, 'player/fluid-bank-mappings.js')));
  assert.ok(fs.existsSync(path.join(output, 'player/soundfonts/fluidr3-gm/mappings.json')));
  const bank = verifyBrowserBank(path.join(output, 'player/soundfonts/fluidr3-gm'));
  assert.equal(bank.total.unique_files, 1454);
  assert.ok(fs.existsSync(path.join(output, 'player/licenses/FluidR3-MIT.txt')));
});


test('PWA export keeps relative file handlers, versions its cache and never caches private MIDI or full SF2', t => {
  const f = fixture(t), output = path.join(f.directory, 'pwa');
  writeCatalog(output, buildPublicLibrary(f.directory));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.webmanifest'), 'utf8'));
  for (const member of ['id', 'scope', 'start_url']) assert.equal(new URL(manifest[member], 'https://example.test/repository/manifest.webmanifest').pathname, '/repository/');
  assert.equal(new URL(manifest.file_handlers[0].action, 'https://example.test/repository/manifest.webmanifest').pathname, '/repository/');
  assert.deepEqual(manifest.file_handlers[0].accept['audio/midi'], ['.mid', '.midi', '.rmi', '.kar']);
  assert.equal(manifest.name, 'Web-MIDI-Player');
  assert.equal(fs.readFileSync(path.join(output, 'icons/icon.svg'), 'utf8'), fs.readFileSync(new URL('../catalog/pwa/icon.svg', import.meta.url), 'utf8'));
  for (const size of [32, 192, 512]) {
    const png = fs.readFileSync(path.join(output, 'icons/icon-' + size + '.png'));
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, 'https://example.test/repository/');
    const bytes = fs.readFileSync(path.join(output, url.pathname.slice('/repository/'.length)));
    assert.equal(url.searchParams.get('v'), createHash('sha256').update(bytes).digest('hex').slice(0, 12), 'New artwork must update the manifest icon URL');
  }
  const describe = directory => {
    const sandbox = { URL, self: { location: { href: 'https://example.test/repository/sw.js' }, addEventListener() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'sw.js'), 'utf8') + ';globalThis.description = {VERSION, ASSETS, PREFIX};', sandbox);
    return sandbox.description;
  };
  const { ASSETS: assets, VERSION: version, PREFIX: prefix } = describe(output);
  assert.ok(version.length >= 16);
  assert.equal(prefix, 'web-midi-player:/repository/:');
  assert.ok(assets.some(asset => asset.file === 'index.html' && asset.core));
  assert.ok(assets.some(asset => asset.file === 'player/soundfonts/fluidr3-gm/manifest.json' && asset.core));
  assert.ok(assets.some(asset => asset.file.includes('/samples/') && !asset.core));
  assert.ok(!assets.some(asset => /\.sf2$/.test(asset.file) || asset.file.startsWith('downloads/')));
  for (const asset of assets) assert.ok(fs.existsSync(path.join(output, asset.file)));
  const privateOutput = path.join(f.directory, 'personal');
  fs.mkdirSync(path.join(privateOutput, 'midi'), { recursive: true });
  fs.mkdirSync(path.join(privateOutput, 'player/soundfonts'), { recursive: true });
  fs.writeFileSync(path.join(privateOutput, 'index.html'), '<p>Personal catalog</p>');
  fs.copyFileSync(path.join(f.directory, f.track.file), path.join(privateOutput, 'midi/private.mid'));
  fs.writeFileSync(path.join(privateOutput, 'player/soundfonts/original.sf2'), 'full SoundFont');
  writePwa(privateOutput);
  const personal = describe(privateOutput);
  assert.ok(!personal.ASSETS.some(asset => asset.file.startsWith('midi/') || asset.file.endsWith('.sf2')));
  fs.appendFileSync(path.join(privateOutput, 'index.html'), '<p>Updated</p>');
  writePwa(privateOutput);
  assert.notEqual(describe(privateOutput).VERSION, personal.VERSION);

});
