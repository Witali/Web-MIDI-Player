import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readMidi } from './midi-metadata.mjs';
import { csvText, groupRelated } from './library.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing public-library evidence: ' + name);
};

export function buildPublicLibrary(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.tracks) || !manifest.tracks.length) throw new Error('Invalid public-library manifest');
  const items = [], keys = new Set(), hashes = new Set();
  for (const track of manifest.tracks) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track.key) || keys.has(track.key)) throw new Error('Invalid or duplicate public-library key');
    keys.add(track.key);
    if (track.file !== 'midi/' + track.key + '.mid') throw new Error('Invalid public MIDI path');
    const rights = track.rights;
    if (rights?.status !== 'public-domain') throw new Error('Public library requires a reviewed public-domain declaration');
    for (const name of ['contributor', 'edition', 'reference', 'checkedOn', 'sourcePage', 'midiUrl', 'sourceUrl', 'declarationUrl']) required(rights[name], name);
    for (const name of ['sourcePage', 'midiUrl', 'sourceUrl', 'declarationUrl']) {
      const url = new URL(rights[name]);
      if (url.protocol !== 'https:' || url.hostname !== 'www.mutopiaproject.org' || url.username || url.password) throw new Error('Unreviewed public-library source URL');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rights.checkedOn)) throw new Error('Invalid public-library review date');
    if (!['sources/' + track.key + '.ly', 'sources/' + track.key + '.zip'].includes(rights.sourceFile)) throw new Error('Invalid notation source path');
    for (const [file, expected] of [[track.file, track.sha256], [rights.sourceFile, rights.sourceSha256]]) {
      if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Missing public-library checksum');
      const absolute = path.join(directory, file), real = fs.realpathSync(absolute);
      if (!real.startsWith(fs.realpathSync(directory) + path.sep)) throw new Error('Public-library asset escapes its directory');
      if (sha256(fs.readFileSync(real)) !== expected) throw new Error('Public-library checksum mismatch: ' + file);
    }
    if (hashes.has(track.sha256)) throw new Error('Duplicate public MIDI content');
    hashes.add(track.sha256);
    const bytes = fs.readFileSync(path.join(directory, track.file));
    if (bytes.length !== track.bytes) throw new Error('Public MIDI size mismatch');
    const metadata = readMidi(bytes, { includeNotes: false });
    if (!metadata.noteCount) throw new Error('Public MIDI contains no notes');
    for (const name of ['title', 'artist', 'category', 'composerDates']) required(track[name], name);
    items.push({ id: track.sha256, key: track.key, title: track.title, artist: track.artist, category: track.category,
      aliases: Array.isArray(track.aliases) ? track.aliases : [], searchExtra: '', metadataInferred: false,
      bytes: bytes.length, duration: metadata.duration, tempo: metadata.tempo, tempoMin: metadata.tempoMin,
      tempoMax: metadata.tempoMax, tracks: metadata.tracks, noteCount: metadata.noteCount,
      instruments: metadata.instruments, playable: true, issues: [],
      composerDates: track.composerDates, compositionYear: track.compositionYear, rights,
      versions: [{ file: track.file, originalFile: track.file, url: rights.midiUrl, source: rights.sourcePage,
        title: track.title, artist: track.artist, archive: false }] });
  }
  items.sort((a, b) => a.artist.localeCompare(b.artist, 'ru') || a.title.localeCompare(b.title, 'ru'));
  const stats = { unique: items.length, files: items.length, sources: items.length, duplicates: 0,
    artists: new Set(items.map(item => item.artist)).size, issues: 0, readable: items.length, missingArtist: 0,
    totalSeconds: items.reduce((sum, item) => sum + item.duration, 0), updated: manifest.verifiedOn };
  return { version: 1, mode: 'public', title: manifest.title, stats, items, families: groupRelated(items) };
}

export function publicLibraryCsv(library) {
  return csvText([['Название', 'Композитор', 'Раздел', 'Длительность, секунд', 'Статус прав', 'Автор набора', 'Источник', 'Проверено', 'Файл', 'SHA-256'],
    ...library.items.map(item => [item.title, item.artist, item.category, item.duration, item.rights.label,
      item.rights.contributor, item.rights.sourcePage, item.rights.checkedOn, item.versions[0].file, item.id])]);
}
