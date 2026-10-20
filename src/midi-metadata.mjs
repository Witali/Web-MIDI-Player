import { FIFOQueue } from '../Player/event-queue.js';
// SMF/RMID reader shared by the catalog builder and player, with no external dependencies.
export const INSTRUMENT_FAMILIES = ['Фортепиано', 'Клавишная перкуссия', 'Орган',
  'Гитара', 'Бас', 'Струнные', 'Хор', 'Духовые', 'Синтезатор', 'Народные', 'Ударные', 'Эффекты'];

export function instrumentFamily(program, channel) {
  if (channel === 9) return 'Ударные';
  if (program < 40) return INSTRUMENT_FAMILIES[Math.floor(program / 8)];
  if (program < 52) return 'Струнные';
  if (program < 56) return 'Хор';
  if (program < 80) return 'Духовые';
  if (program < 104) return 'Синтезатор';
  if (program < 112) return 'Народные';
  if (program < 120) return 'Ударные';
  return 'Эффекты';
}

export function readMidi(input, { includeNotes = true } = {}) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'RMID') {
    let data = null;
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const length = view.getUint32(pos + 4, true);
      if (pos + 8 + length > bytes.length) throw new Error('Оборванный контейнер RMID');
      if (text(pos, 4) === 'data') { data = bytes.subarray(pos + 8, pos + 8 + length); break; }
      pos += 8 + length + length % 2;
    }
    if (!data) throw new Error('В RMID нет MIDI-данных');
    return readMidi(data, { includeNotes });
  }
  if (bytes.length < 14 || text(0, 4) !== 'MThd') throw new Error('Отсутствует заголовок MIDI');
  const header = view.getUint32(4), format = view.getUint16(8), expected = view.getUint16(10);
  const division = view.getUint16(12);
  if (header < 6 || header + 8 > bytes.length || format > 2 || !division) throw new Error('Неверный заголовок MIDI');
  const events = [], tempos = [{ tick: 0, micros: 500000, order: -1 }];
  let position = header + 8, trackCount = 0, maxTick = 0, sequence = 0;
  const titles = [];
  while (trackCount < expected && position + 8 <= bytes.length) {
    const chunk = text(position, 4), length = view.getUint32(position + 4);
    let cursor = position + 8;
    const end = cursor + length;
    if (end > bytes.length) throw new Error('Оборванная дорожка MIDI');
    position = end;
    if (chunk !== 'MTrk') continue;
    trackCount++;
    let tick = 0, running = 0;
    const take = () => { if (cursor >= end) throw new Error('Оборванное MIDI-событие'); return bytes[cursor++]; };
    const variable = () => {
      let value = 0;
      for (let n = 0; n < 4; n++) { const byte = take(); value = value * 128 + (byte & 127); if (!(byte & 128)) return value; }
      throw new Error('Слишком длинное значение MIDI');
    };
    while (cursor < end) {
      tick += variable(); maxTick = Math.max(maxTick, tick);
      let status = take();
      if (status < 128) { if (!running) throw new Error('Неверный running status'); cursor--; status = running; }
      else if (status < 240) running = status;
      if (status === 255) {
        const type = take(), size = variable();
        if (cursor + size > end) throw new Error('Оборванные метаданные MIDI');
        if (type === 81 && size === 3) {
          const micros = bytes[cursor] * 65536 + bytes[cursor + 1] * 256 + bytes[cursor + 2];
          if (micros) tempos.push({ tick, micros, order: sequence++ });
        }
        if (type === 3 && size && size < 300) {
          const raw = bytes.subarray(cursor, cursor + size);
          let title = new TextDecoder('utf-8').decode(raw);
          if (title.includes('�')) title = new TextDecoder('windows-1252').decode(raw);
          titles.push(title.replace(/[\u0000-\u001f]/g, ' ').trim());
        }
        cursor += size;
        if (type === 47) break;
      } else if (status === 240 || status === 247) {
        const size = variable(); cursor += size; running = 0;
        if (cursor > end) throw new Error('Оборванное SysEx-событие');
      } else if (status >= 240) throw new Error('Неподдерживаемое системное MIDI-событие');
      else {
        const kind = status >> 4, channel = status & 15;
        const a = take(), b = kind === 12 || kind === 13 ? 0 : take();
        if (a > 127 || b > 127) throw new Error('Неверные данные MIDI-события');
        if ([8, 9, 11, 12].includes(kind)) events.push({ tick, kind, channel, a, b, order: sequence++ });
      }
    }
  }
  if (trackCount !== expected) throw new Error('Не все дорожки MIDI доступны');
  if (format === 2) throw new Error('Формат MIDI 2 с независимыми последовательностями');
  tempos.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const map = [];
  for (const tempo of tempos) {
    if (map.at(-1)?.tick === tempo.tick) map[map.length - 1] = { ...tempo };
    else map.push({ ...tempo });
  }
  let seconds = 0;
  for (let i = 0; i < map.length; i++) {
    if (i) seconds += (map[i].tick - map[i - 1].tick) * map[i - 1].micros / division / 1000000;
    map[i].seconds = seconds;
  }
  const smpte = division & 0x8000;
  let frames = 256 - (division >> 8);
  if (frames === 29) frames = 29.97;
  const ticksPerFrame = division & 255;
  if (smpte && (!ticksPerFrame || ![24, 25, 29.97, 30].includes(frames))) throw new Error('Неверное SMPTE-время');
  const atSeconds = tick => {
    if (smpte) return tick / frames / ticksPerFrame;
    let low = 0, high = map.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (map[mid].tick <= tick) low = mid; else high = mid - 1; }
    const tempo = map[low];
    return tempo.seconds + (tick - tempo.tick) * tempo.micros / division / 1000000;
  };
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const channels = Array.from({ length: 16 }, () => ({ program: 0, volume: 100, expression: 127, pedal: false, held: new Map(), sustained: [] }));
  const instruments = new Set(), notes = [];
  let noteCount = 0, lastSoundTick = 0;
  const finish = (note, tick) => {
    lastSoundTick = Math.max(lastSoundTick, tick);
    if (!includeNotes) return;
    const start = atSeconds(note.tick), end = atSeconds(Math.max(tick, note.tick + 1));
    notes.push({ start, end, pitch: note.pitch, velocity: note.velocity, program: note.program, channel: note.channel });
  };
  for (const event of events) {
    const { kind, channel, a, b, tick } = event, state = channels[channel];
    if (kind === 12) state.program = a;
    else if (kind === 11) {
      if (a === 7) state.volume = b;
      if (a === 11) state.expression = b;
      if (a === 64) {
        state.pedal = b >= 64;
        if (!state.pedal) { for (const note of state.sustained) finish(note, tick); state.sustained = []; }
      }
      if ([120, 123].includes(a)) {
        for (const queue of state.held.values()) for (const note of queue) finish(note, tick);
        for (const note of state.sustained) finish(note, tick);
        state.held.clear(); state.sustained = [];
      }
    } else if (kind === 9 && b) {
      instruments.add(instrumentFamily(state.program, channel)); noteCount++;
      const queue = state.held.get(a) || new FIFOQueue();
      queue.push({ tick, pitch: a, velocity: b / 127 * state.volume / 127 * state.expression / 127, program: state.program, channel });
      state.held.set(a, queue);
    } else {
      const queue = state.held.get(a);
      const note = queue?.take();
      if (note) { if (state.pedal) state.sustained.push(note); else finish(note, tick); }
    }
  }
  for (const state of channels) {
    for (const queue of state.held.values()) for (const note of queue) finish(note, maxTick);
    for (const note of state.sustained) finish(note, maxTick);
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const bpms = map.filter(t => t.tick <= maxTick).map(t => Math.round(60000000 / t.micros));
  return { format, tracks: trackCount, duration: Math.round(atSeconds(lastSoundTick) * 1000) / 1000,
    fileDuration: Math.round(atSeconds(maxTick) * 1000) / 1000,
    tempo: smpte ? null : bpms[0], tempoMin: smpte ? null : Math.min(...bpms),
    tempoMax: smpte ? null : Math.max(...bpms), noteCount, instruments: [...instruments], titles, notes };
}
