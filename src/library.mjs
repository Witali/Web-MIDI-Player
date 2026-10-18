import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { plainText, siteUrl } from './catalog-text.mjs';
import { readMidi } from './midi-metadata.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/ё/g, 'е');
const nameKey = value => fold(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).sort().join(' ');
const tidy = value => plainText(String(value || '')).replace(/\.(mid|midi|rmi|kar)$/i, '').replace(/\s+/g, ' ').trim();
const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const RUSSIAN = { bach: 'бах', beethoven: 'бетховен', mozart: 'моцарт', chopin: 'шопен',
  liszt: 'лист', tchaikovsky: 'чайковский', rachmaninov: 'рахманинов', shostakovich: 'шостакович',
  schubert: 'шуберт', schumann: 'шуман', brahms: 'брамс', haydn: 'гайдн', handel: 'гендель',
  vivaldi: 'вивальди', debussy: 'дебюсси', ravel: 'равель', bartok: 'барток', scriabin: 'скрябин',
  scarlatti: 'скарлатти', mendelssohn: 'мендельсон', albeniz: 'альбенис', albinoni: 'альбинони',
  grieg: 'григ', prokofiev: 'прокофьев', stravinsky: 'стравинский' };

function composerName(label) {
  const cleaned = tidy(label).replace(/\s*\([^)]*\)[\s\S]*$/, '').trim();
  if (!cleaned || cleaned.length > 100 || !/\p{L}/u.test(cleaned)) return '';
  const comma = cleaned.indexOf(',');
  return comma >= 0 ? `${cleaned.slice(comma + 1).trim()} ${cleaned.slice(0, comma).trim()}`.trim() : cleaned;
}

export function legacyIndex(html, url, fallback = '') {
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const start = body.search(/<div\b[^>]*\bid=["']page["']/i), end = body.search(/<div\b[^>]*\bid=["']sidebar["']/i);
  if (start >= 0) body = body.slice(start, end > start ? end : undefined);
  const headers = [];
  for (const font of body.matchAll(/<font\b[^>]*size\s*=\s*["']?3["']?[^>]*>([\s\S]*?)<\/font>/gi)) {
    const tail = body.slice(font.index + font[0].length).split(/<ul\b/i)[0].slice(0, 400);
    const label = plainText(font[1] + tail);
    if (/\((?:[c.?\s-]*\d{2,4}|\?\s*-)/i.test(label)) {
      const artist = composerName(label);
      if (artist) headers.push({ at: font.index, artist });
    }
  }
  const result = new Map();
  for (const anchor of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const target = siteUrl(anchor[1], url);
    if (!target || !/\.(mid|midi|rmi|kar)$/i.test(target.pathname)) continue;
    let artist = fallback;
    for (const header of headers) { if (header.at > anchor.index) break; artist = header.artist; }
    let title = tidy(anchor[2]), work = '';
    const prefix = body.slice(0, anchor.index);
    const ul = prefix.toLowerCase().lastIndexOf('<ul');
    const li = prefix.toLowerCase().lastIndexOf('<li', ul);
    if (li >= 0 && ul > li) {
      const heading = prefix.slice(li, ul);
      if (!/<a\b/i.test(heading)) work = tidy(heading.replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, '')).replace(/\s*-\s*$/, '');
      if (work.length > 160) work = '';
    }
    if (work && !fold(title).startsWith(fold(work))) title = `${work} — ${title}`;
    result.set(target.href, { title, artist, work, legacy: true });
  }
  return result;
}

export function packLabel(track) {
  const basename = (track.archiveMember || track.title || '').split(/[\\/]/).pop();
  const label = tidy(basename);
  const parts = label.match(/^(.{1,100}?)\s+[-–—]\s+(.+)$/);
  return parts ? { artist: parts[1].trim(), title: parts[2].trim(), inferred: true }
    : { artist: '', title: label, inferred: true };
}

export function modernIndex(html) {
  const result = new Map();
  let body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const start = body.search(/<div\b[^>]*\bid=["']page["']/i), end = body.search(/<div\b[^>]*\bid=["']sidebar["']/i);
  if (start >= 0) body = body.slice(start, end > start ? end : undefined);
  for (const row of body.matchAll(/<li\b[^>]*>([\s\S]*?)<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?midiworld\.com)?\/download\/(\d+)\/?["'][^>]*>/gi)) {
    const prefix = row[1], span = prefix.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i);
    let title = '', artist = '';
    if (span) {
      title = tidy(span[1]);
      artist = tidy(prefix.slice(span.index + span[0].length)).replace(/\s*-\s*$/, '').trim().replace(/^\(|\)$/g, '');
    } else {
      const label = tidy(prefix).replace(/\s*-\s*$/, '').trim();
      let depth = 0, split = -1;
      if (label.endsWith(')')) for (let i = label.length - 1; i >= 0; i--) {
        if (label[i] === ')') depth++; else if (label[i] === '(' && --depth === 0) { split = i; break; }
      }
      if (split >= 0) { title = label.slice(0, split).trim(); artist = label.slice(split + 1, -1).trim(); }
      else title = label;
    }
    result.set(`https://www.midiworld.com/download/${row[2]}`, { title, artist });
  }
  return result;
}

function loadLegacy(directory, manifest) {
  const result = new Map(), composers = new Map();
  const cache = url => path.join(directory, 'pages', `${digest(url)}.html`);
  const indexUrl = 'https://www.midiworld.com/composers.htm';
  if (fs.existsSync(cache(indexUrl))) {
    const html = fs.readFileSync(cache(indexUrl), 'utf8');
    for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/ul>)/gi)) {
      const link = item[1].match(/<a\b[^>]*href=["']([^"']+)["']/i);
      const url = link && siteUrl(link[1], indexUrl);
      if (!url || !/\.htm$/i.test(url.pathname) || /\/(classic|earlymus)\.htm/i.test(url.pathname)) continue;
      const name = composerName(plainText(item[1]));
      if (name) {
        composers.set(url.pathname, name);
        composers.set(url.pathname.replace('/mw_', '/'), name);
      }
    }
  }
  for (const url of Object.keys(manifest.pages)) {
    if (!/\.html?$/.test(new URL(url).pathname) || !fs.existsSync(cache(url))) continue;
    const entries = legacyIndex(fs.readFileSync(cache(url), 'utf8'), url, composers.get(new URL(url).pathname) || '');
    for (const [key, value] of entries) if (value.artist || !result.has(key)) result.set(key, value);
  }
  const composerNames = [...new Set([...composers.values(), ...[...result.values()].map(r => r.artist)].filter(Boolean))];
  for (const url of Object.keys(manifest.pages)) {
    if (!/\/(?:files\/\d+|search\/)/.test(url) || !fs.existsSync(cache(url))) continue;
    for (const [key, value] of modernIndex(fs.readFileSync(cache(url), 'utf8'))) {
      const previous = result.get(key);
      if (!previous || (!previous.title && value.title) || (!previous.artist && value.artist)) result.set(key, value);
    }
  }
  return { result, composers: composerNames };
}

export function chooseLabel(tracks, legacy = new Map(), composers = []) {
  const known = new Map(composers.map(name => [nameKey(name), name]));
  const candidates = tracks.map(track => {
    const cached = track.archiveParent ? null : legacy.get(track.url);
    const label = track.archiveParent ? packLabel(track) : cached || { artist: tidy(track.artist), title: tidy(track.title) };
    let artist = tidy(label.artist), title = tidy(label.title);
    artist = known.get(nameKey(artist)) || artist;
    if (!title) title = tidy(path.basename(track.filename || '').replace(/^[^_]+__/, ''));
    if (!title || title === artist || /_-_$/.test(title)) title = `Без названия · ${track.key.replace('id:', '')}`;
    const generic = /^(theme|variation \d+|[1234](?:st|nd|rd|th) movement|untitled|без названия)/i.test(title);
    return { ...label, artist, title, track, score: (artist ? 6 : 0) + (title ? 8 : 0) +
      (label.legacy ? 5 : 0) + (!track.archiveParent ? 3 : 0) + (label.work ? 3 : 0) - (generic ? 4 : 0) };
  }).sort((a, b) => b.score - a.score || collator.compare(a.title, b.title));
  const primary = candidates[0];
  if (!primary.artist) primary.artist = candidates.find(c => c.artist)?.artist || 'Не указан';
  return { ...primary, aliases: [...new Set(candidates.flatMap(c => [c.title, c.artist]).filter(Boolean))],
    classical: candidates.some(c => c.legacy || known.has(nameKey(c.artist))) };
}

function categoryFor(label, tracks) {
  const names = fold([label.artist, ...tracks.map(t => t.artist || '')].join(' '));
  if (/national anthems|national anthem/.test(names)) return 'Гимны';
  if (/christmas carols|christmas songs/.test(names)) return 'Праздники';
  if (/video game themes|nintendo|toby fox|undertale|minecraft|koji kondo|sonic|pokemon|sega/.test(names)) return 'Игры';
  if (/movie themes|tv themes|disney themes|walt disney/.test(names)) return 'Кино и ТВ';
  if (label.classical) return 'Классика';
  return label.artist === 'Не указан' ? 'Разное' : 'Песни и исполнители';
}

export function csvText(rows) {
  const cell = input => { let value = String(input ?? ''); if (/^[=+@-]/.test(value)) value = "'" + value;
    return `"${value.replaceAll('"', '""')}"`; };
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function groupRelated(items) {
  const groups = new Map(), families = {};
  for (const item of items) {
    const key = `${fold(item.artist)}|${fold(item.title).replace(/[^\p{L}\p{N}]/gu, '')}`;
    const family = groups.get(key) || []; family.push(item); groups.set(key, family);
  }
  for (const [key, family] of groups) {
    const id = family.length > 1 ? digest(key).slice(0, 16) : null;
    if (id) families[id] = family.map(item => item.id);
    for (const item of family) item.family = id;
  }
  return families;
}

export async function buildLibrary(directory, { onProgress = () => {} } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const tracks = Object.values(manifest.tracks).filter(t => t.status === 'done' && t.format !== 'zip');
  const groups = new Map();
  for (const track of tracks) { const group = groups.get(track.sha256) || []; group.push(track); groups.set(track.sha256, group); }
  const legacy = loadLegacy(directory, manifest);
  const cacheFile = path.join(directory, 'catalog-metadata.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { version: 2, items: {} };
  if (cache.version !== 2) { cache.version = 2; cache.items = {}; }
  const items = [];
  for (const [sha256, copies] of groups) {
    const label = chooseLabel(copies, legacy.result, legacy.composers);
    let metadata = cache.items[sha256];
    if (!metadata) {
      try {
        const absolute = path.resolve(directory, label.track.filename);
        if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error('Invalid MIDI path');
        const parsed = readMidi(fs.readFileSync(absolute), { includeNotes: false });
        const { notes, ...summary } = parsed;
        metadata = summary;
      } catch (error) { metadata = { duration: null, tempo: null, tracks: null, instruments: [], error: error.message }; }
      cache.items[sha256] = metadata;
    }
    const versions = [label.track, ...copies.filter(t => t !== label.track)].map(track => ({
      file: track.filename, originalFile: track.originalFilename || track.filename, url: track.url, source: track.source, title: track.title,
      artist: track.artist || '', archive: Boolean(track.archiveParent) }));
    const issues = [...new Set([...copies.flatMap(t => t.warnings || []), ...(metadata.error ? [metadata.error] : [])])];
    const russian = Object.entries(RUSSIAN).filter(([name]) => fold(label.artist).includes(name)).map(([, name]) => name).join(' ');
    items.push({ id: sha256, title: label.title, artist: label.artist, category: categoryFor(label, copies),
      aliases: label.aliases, searchExtra: russian, metadataInferred: Boolean(label.inferred),
      bytes: label.track.bytes, duration: metadata.duration, tempo: metadata.tempo,
      tempoMin: metadata.tempoMin, tempoMax: metadata.tempoMax, tracks: metadata.tracks,
      noteCount: metadata.noteCount, instruments: metadata.instruments, playable: !metadata.error && metadata.noteCount > 0,
      issues, versions });
    if (items.length % 500 === 0) onProgress(items.length, groups.size);
  }
  // Unify only case/accent-equivalent performer names; preserve unrelated source labels.
  const spellings = new Map();
  for (const item of items) {
    const key = fold(item.artist), variants = spellings.get(key) || new Map();
    variants.set(item.artist, (variants.get(item.artist) || 0) + 1); spellings.set(key, variants);
  }
  const names = new Map([...spellings].map(([key, variants]) => [key, [...variants].sort((a, b) => b[1] - a[1])[0][0]]));
  for (const item of items) item.artist = names.get(fold(item.artist));
  items.sort((a, b) => Number(a.artist === 'Не указан') - Number(b.artist === 'Не указан') || collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title));
  const families = groupRelated(items);
  const physicalFiles = new Set(tracks.map(t => t.filename)).size;
  const stats = { unique: items.length, files: physicalFiles, sources: tracks.length, duplicates: physicalFiles - items.length,
    artists: new Set(items.map(i => i.artist).filter(a => a !== 'Не указан')).size,
    issues: items.filter(i => i.issues.length).length, readable: items.filter(i => i.playable).length,
    missingArtist: items.filter(i => i.artist === 'Не указан').length,
    totalSeconds: items.reduce((sum, i) => sum + (i.duration || 0), 0), updated: new Date().toISOString() };
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const library = { version: 1, stats, items, families };
  fs.writeFileSync(path.join(directory, 'library.json'), JSON.stringify(library));
  fs.writeFileSync(path.join(directory, 'library.csv'), csvText([
    ['Название', 'Исполнитель / композитор', 'Раздел', 'Длительность, секунд', 'Темп, BPM', 'Инструменты', 'Дорожки', 'Ноты', 'Копии', 'Файл', 'Пометки', 'Подпись из имени файла', 'SHA-256'],
    ...items.map(i => [i.title, i.artist, i.category, i.duration, i.tempo, i.instruments.join('; '), i.tracks, i.noteCount,
      i.versions.length, i.versions[0].file, i.issues.join('; '), i.metadataInferred ? 'Да' : '', i.id]) ]));
  onProgress(items.length, groups.size);
  return library;
}
