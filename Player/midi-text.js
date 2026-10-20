const kinds = { 1: 'text', 2: 'copyright', 3: 'trackName', 4: 'instrumentName', 5: 'lyric', 6: 'marker', 7: 'cue', 8: 'programName', 9: 'deviceName' };
export function normalizeTextEncoding(value = 'auto') {
  if (value === 'auto') return value;
  if (typeof value !== 'string') throw new TypeError('Invalid MIDI text encoding.');
  return new TextDecoder(value).encoding;
}
function decode(bytes, encoding) {
  if (encoding !== 'auto') return { text: new TextDecoder(encoding).decode(bytes), encoding };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }; }
}
// Only engine-emitted display messages reach this decoder. Preserve the full
// packet even for unknown addresses or invalid bounds/checksums.
export function decodeDisplay(bytes) {
  const raw = { family: 'unknown', format: 'raw', bytes: [...bytes] };
  if (bytes.at(-1) !== 0xf7) return raw;
  if (bytes[0] === 0x43 && (bytes[1] & 0xf0) === 0x10 && bytes[2] === 0x4c) {
    raw.family = 'xg'; raw.device = bytes[1] & 15;
    const type = bytes[3], offset = bytes[5], data = bytes.slice(6, -1);
    if (bytes[4] === 0 && [6, 7].includes(type) && data.length && offset + data.length <= (type === 6 ? 32 : 48) && data.every(b => b >= (type === 6 ? 32 : 0) && b <= 127))
      return { ...raw, format: type === 6 ? 'letters' : 'bitmap', offset, data };
  } else if (bytes[0] === 0x41) {
    raw.family = 'gs'; raw.device = bytes[1];
    const data = bytes.slice(7, -2), bitmap = bytes[5] === 1;
    const checksum = bytes.slice(4, -1).reduce((n, b) => n + b, 0) % 128 === 0;
    if (bytes[2] === 0x45 && bytes[3] === 0x12 && bytes[4] === 0x10 && [0, 1].includes(bytes[5]) && checksum && data.length && bytes[6] + data.length <= (bitmap ? 64 : 32) && data.every(b => b >= (bitmap ? 0 : 32) && b <= (bitmap ? 31 : 127)))
      return { ...raw, format: bitmap ? 'bitmap' : 'letters', offset: bytes[6], data };
  }
  return raw;
}
export class MidiTextCollector {
  constructor(midi, encoding = 'auto') { this.midi = midi; this.encoding = normalizeTextEncoding(encoding); this.events = []; this.prefixes = new Map(); }
  meta(event, context) {
    if (event.statusByte === 0x20 && event.data.length === 1 && event.data[0] < 16) this.prefixes.set(context.track, event.data[0] + 1);
    if (event.statusByte < 1 || event.statusByte > 15) return;
    const decoded = decode(event.data, this.encoding), karaoke = !!this.midi.isKaraokeFile;
    this.events.push({ ...context, id: this.events.length, channel: this.prefixes.get(context.track) ?? null,
      kind: kinds[event.statusByte] ?? 'reservedText', metaType: event.statusByte, bytes: Array.from(event.data), ...decoded,
      lyric: event.statusByte === 5 || (karaoke && event.statusByte === 1 && !decoded.text.trimStart().startsWith('@')), karaoke });
  }
  channel(track) { this.prefixes.delete(track); }
  display(bytes, context) {
    if (!context) return false;
    const display = decodeDisplay(bytes);
    this.events.push({ ...context, id: this.events.length, channel: this.prefixes.get(context.track) ?? null,
      kind: 'display', display });
    return display.format !== 'raw';
  }
  finish() {
    const tracks = this.midi.tracks.map((_, i) => ({ track: i + 1, name: '', instruments: [] })), named = new Set();
    for (const event of this.events) {
      const track = tracks[event.track - 1];
      if (event.kind === 'trackName' && !named.has(event.track)) { track.name = event.text; named.add(event.track); }
      if (event.kind === 'instrumentName') track.instruments.push(event.text);
    }
    return { encoding: this.encoding, karaoke: !!this.midi.isKaraokeFile, events: this.events, tracks };
  }
}
export class MidiTextTimeline {
  constructor(info = { events: [] }) { this.events = info.events; this.frames = this.events.map(e => Math.round(e.seconds * 48000)); this.reset(); }
  reset() { this.cursor = 0; this.lyrics = new Map(); this.displays = new Map(); this.marker = this.cue = null; }
  at(seconds, { discontinuous = false } = {}) {
    if (!Number.isFinite(seconds)) throw new TypeError('Text time must be finite.');
    // Seeking rounds to the same 48 kHz frame. A fractional-frame marker
    // must remain selected when the user seeks to its exact metadata time.
    const frame = Math.round(seconds * 48000);
    if (discontinuous || (this.cursor && this.frames[this.cursor - 1] > frame)) this.reset();
    const crossed = [];
    while (this.cursor < this.events.length && this.frames[this.cursor] <= frame) {
      const event = this.events[this.cursor++]; crossed.push(event);
      if (event.lyric) {
        let text = event.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
        const previous = this.lyrics.get(event.track);
        if (event.karaoke && /^[\\/]/.test(text)) text = '\n' + text.slice(1);
        const line = ((previous?.line ?? '') + text).split('\n').at(-1).slice(-2048);
        this.lyrics.set(event.track, { track: event.track, line, syllable: text.split('\n').at(-1), event });
      } else if (event.kind === 'marker' || event.kind === 'cue') this[event.kind] = event;
      else if (event.kind === 'display') {
        const d = event.display, key = event.port + ':' + d.family + ':' + d.device + ':' + d.format;
        if (d.format === 'raw') { this.displays.set(key, { event, family: d.family, format: d.format, bytes: d.bytes }); continue; }
        const size = d.format === 'letters' ? 32 : d.family === 'gs' ? 64 : 48;
        const state = this.displays.get(key) ?? { family: d.family, format: d.format, data: Array(size).fill(d.format === 'letters' ? 32 : 0) };
        state.event = event; state.data.splice(d.offset, d.data.length, ...d.data);
        if (d.format === 'letters') state.text = String.fromCharCode(...state.data);
        else {
          const width = d.family === 'gs' ? 5 : 7, pixels = Array.from({ length: 16 }, () => Array(16).fill('0'));
          state.data.forEach((byte, i) => { for (let bit = 0; bit < width; bit++) { const x = Math.floor(i / 16) * width + bit; if (x < 16 && byte & (1 << (width - 1 - bit))) pixels[i % 16][x] = '1'; } });
          state.pixels = pixels.map(row => row.join(''));
        }
        this.displays.set(key, state);
      }
    }
    return { events: crossed, state: this.snapshot() };
  }
  snapshot() { return { lyrics: [...this.lyrics.values()], displays: [...this.displays.values()], marker: this.marker, cue: this.cue }; }
}
