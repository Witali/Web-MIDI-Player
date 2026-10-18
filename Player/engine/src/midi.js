// Strict Standard MIDI File reader. Times are converted once using the shared
// tempo map; channel controllers are interpreted across tracks in tick order.
import {drumNames,drumSample} from './drums.js';
export function parseMidi(input,{percussion=true}={}) {
  const bytes = new Uint8Array(input);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('MIDI больше 4 МБ. Разделите его на части.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0, limit = bytes.length, eventCount = 0;
  const need = n => { if (p + n > limit) throw new Error('Оборванный MIDI-файл.'); };
  const byte = () => { need(1); return bytes[p++]; };
  const u16 = () => { need(2); const n = view.getUint16(p); p += 2; return n; };
  const u32 = () => { need(4); const n = view.getUint32(p); p += 4; return n; };
  const tag = () => String.fromCharCode(byte(), byte(), byte(), byte());
  const vlq = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) { const b = byte(); n = n * 128 + (b & 127); if (!(b & 128)) return n; }
    throw new Error('Некорректная MIDI VLQ-длина.');
  };
  if (tag() !== 'MThd') throw new Error('Ожидается Standard MIDI File (.mid).');
  const header = u32(); if (header < 6) throw new Error('Некорректный MIDI-заголовок.');
  const format = u16(), tracks = u16(), division = u16(); need(header - 6); p += header - 6;
  if (format > 1) throw new Error('MIDI format 2 содержит независимые песни. Сохраните как format 0 или 1.');
  if (!tracks || (format === 0 && tracks !== 1) || !division) throw new Error('Некорректные параметры MIDI.');
  const smpte = !!(division & 0x8000);
  const frameCode = 256 - (division >> 8), frames = frameCode === 29 ? 30000 / 1001 : frameCode;
  const ticksPerSecond = frames * (division & 255);
  if (smpte && (![24, 25, 29, 30].includes(frameCode) || !(division & 255))) throw new Error('Некорректное SMPTE-время MIDI.');
  const events = [], names = [], warnings = new Set(); let endTick = 0;
  for (let track = 0; track < tracks; track++) {
    limit = bytes.length;
    if (tag() !== 'MTrk') throw new Error('Не найден MIDI-трек.');
    const length = u32(); need(length); const end = p + length; limit = end;
    let tick = 0, running = 0, ended = false;
    while (p < end) {
      tick += vlq(); endTick = Math.max(endTick, tick);
      if (++eventCount > 200000) throw new Error('В MIDI более 200 000 событий. Разделите файл.');
      let status = byte(), a;
      if (status < 128) { a = status; status = running; if (!status) throw new Error('MIDI running status без предыдущего статуса.'); }
      if (status === 0xff) {
        running = 0; const type = byte(), size = vlq(); need(size);
        const data = bytes.slice(p, p + size); p += size;
        if (type === 0x51) {
          if (size !== 3) throw new Error('Некорректное событие MIDI tempo.');
          const tempo = data[0] * 65536 + data[1] * 256 + data[2];
          if (!tempo) throw new Error('Темп MIDI равен нулю.');
          events.push({ tick, track, type: 'tempo', tempo });
        } else if (type === 3) names[track] = new TextDecoder().decode(data).replace(/\0/g, '').slice(0, 160);
        else if (type === 0x2f) { if (size) throw new Error('Некорректный End of Track.'); ended = true; p = end; break; }
      } else if (status === 0xf0 || status === 0xf7) {
        running = 0; const size = vlq(); need(size); p += size;
        warnings.add('SysEx пропущен: используются General MIDI и банк сайта.');
      } else {
        if (status < 0x80 || status >= 0xf0) throw new Error('Недопустимый статус в MIDI-треке.');
        running = status; const kind = status >> 4, channel = status & 15;
        a ??= byte(); const b = kind === 0xc || kind === 0xd ? 0 : byte();
        if (a > 127 || b > 127) throw new Error('Некорректные MIDI-данные.');
        events.push({ tick, track, kind, channel, a, b });
      }
    }
    if (!ended) warnings.add('Нет End of Track: конец определён по длине трека.');
  }
  events.sort((a, b) => a.tick - b.tick || a.track - b.track);
  let tick = 0, seconds = 0, tempo = 500000;
  for (const event of events) {
    seconds += smpte ? (event.tick - tick) / ticksPerSecond : (event.tick - tick) * tempo / division / 1e6; tick = event.tick; event.time = seconds;
    if (event.type === 'tempo') tempo = event.tempo;
  }
  const duration = seconds + (smpte ? (endTick - tick) / ticksPerSecond : (endTick - tick) * tempo / division / 1e6);
  if (duration > 1800) throw new Error('MIDI длиннее 30 минут. Разделите файл перед загрузкой.');
  const channels = Array.from({ length: 16 }, () => ({ program: 0, volume: 100, expression: 127, pan: 64, sustain: false, active: [], tails: [] }));
  const notes = []; let drums = 0, dangling = 0, levelCount = 0;
  const level = (note,time,value) => { if(++levelCount>1000000)throw new Error('Слишком много изменений громкости MIDI. Разделите файл.');note.levels.push({time,gain:value}); };
  const gain = (c, velocity) => (velocity / 127) ** 2 * c.volume / 127 * c.expression / 127;
  // end/releaseStart is the effective gate, not the audible end. The C engine
  // derives soundEnd from the user-selected timbre. Keep the physical key-up
  // independently: a pedal can hold that gate long after key release.
  const finish = (note, time) => {
    if(note.end !== null)return;
    note.end = note.releaseStart = Math.max(note.start, time);
    note.keyOff ??= note.end;
    channels[note.channel].tails.push(note);
  };
  for (const e of events) {
    if (e.type) continue;
    const c = channels[e.channel];
    // A percussion hit may omit Note Off entirely. Retire its key state after
    // the largest permitted PCM tail instead of exhausting the held-key cap.
    for(const n of c.active)if(n.percussion && n.start+1.25<=e.time)finish(n,n.start+1.25);
    c.active=c.active.filter(n=>n.end===null);
    // Melodic releases need 200 ms; one-shots need up to 1.25 s from onset.
    // Controllers and All Sound Off also affect those already released tails.
    c.tails = c.tails.filter(n => (n.percussion?n.start+1.25:n.end+.2) >= e.time && n.hardEnd === undefined);
    if (e.kind === 0xc) c.program = e.a;
    else if (e.kind === 9 && e.b) {
      if (e.channel === 9 && (!percussion || !drumSample(e.a))) { drums++; continue; }
      const isDrum=e.channel===9;
      if(isDrum){
        // A new hi-hat articulation replaces the open/closed/pedal tail. The
        // same rule handles repeated open hats; track order resolves ties.
        const group=key=>[42,44,46].includes(key)?1:[80,81].includes(key)?2:0,g=group(e.a);
        if(g)for(const n of [...c.active,...c.tails])if(n.percussion&&group(n.drumKey)===g&&n.hardEnd===undefined)n.hardEnd=e.time;
        if(c.program)warnings.add('Нестандартный набор ударных заменён стандартным GM-набором сайта.');
      }
      const note = { id: notes.length, part: isDrum?`drum:${e.a}`:`${e.channel}:${c.program}`, channel: e.channel, program: c.program,
        track: e.track, pitch: e.a, velocity: e.b, start: e.time, end: null, released: false,
        ...(isDrum?{percussion:true,drumKey:e.a,drumName:drumNames[e.a-35]}:{}),
        pan: [{ time: e.time, value: c.pan }], levels: [{ time: e.time, gain: gain(c, e.b) }] };
      notes.push(note); c.active.push(note);
      // File-size and event-count checks bound parsing; musical polyphony is
      // not capped. Dense held chords must also survive transport seeks.
    } else if (e.kind === 8 || (e.kind === 9 && !e.b)) {
      const note = c.active.find(n => n.pitch === e.a && !n.released && n.end === null);
      if (note) { note.released = true; note.keyOff = e.time; if (note.percussion || !c.sustain) finish(note, e.time); }
    } else if (e.kind === 0xb) {
      if (e.a === 7 || e.a === 11) {
        c[e.a === 7 ? 'volume' : 'expression'] = e.b;
        for (const n of [...c.active,...c.tails]) level(n,e.time,gain(c,n.velocity));
      } else if (e.a === 10) {
        c.pan = e.b;
        for (const n of [...c.active, ...c.tails]) n.pan.push({ time: e.time, value: e.b });
      } else if (e.a === 64) {
        c.sustain = e.b >= 64;
        if (!c.sustain) for (const n of c.active) if (n.released && n.end === null) finish(n, e.time);
      } else if (e.a === 120 || e.a === 123) {
        for (const n of c.active) if (n.end === null) { n.released = true; n.keyOff ??= e.time; if (n.percussion || e.a === 120 || !c.sustain) finish(n, e.time); }
        if(e.a === 120)for(const n of c.tails)n.hardEnd=e.time;
      } else if (e.a === 121) {
        c.expression = 127; c.sustain = false;
        for (const n of c.active) if (n.end === null) {
          if (n.released) finish(n, e.time); else level(n,e.time,gain(c,n.velocity));
        }
        for(const n of c.tails)level(n,e.time,gain(c,n.velocity));
      } else if (![0, 32, 91, 93].includes(e.a)) warnings.add('Часть контроллеров MIDI (например, модуляция) пропущена.');
      if ([0, 32].includes(e.a) && e.b) warnings.add('Банки MIDI заменены ближайшими General MIDI инструментами.');
    } else if ([0xa, 0xd, 0xe].includes(e.kind)) warnings.add('Pitch bend и aftertouch пока не переносятся в прошивку.');
    // Remove completed notes from channel state; retained notes remain in notes.
    c.active = c.active.filter(n => n.end === null);
  }
  for (const c of channels) for (const n of c.active) { finish(n, duration); if(!n.percussion)dangling++; }
  if (drums) warnings.add(`Ударные канала 10 пропущены: ${drums} нот. ${percussion?'Поддерживаются стандартные GM-клавиши 35–81.':'Ударные отключены для совместимого импорта.'}`);
  if (dangling) warnings.add(`Ноты без Note Off закрыты в конце MIDI: ${dangling}.`);
  const valid = notes.filter(n => n.percussion || n.end > n.start);
  const parts = new Map();
  for (const n of valid) {
    let part = parts.get(n.part);
    if (!part) { part = { id: n.part, channel: n.channel, program: n.program, tracks: new Set(), notes: 0, energy: 0, min: n.pitch, max: n.pitch,
      ...(n.percussion?{percussion:true,drumKey:n.drumKey,drumName:n.drumName}:{}) }; parts.set(n.part, part); }
    part.notes++; part.tracks.add(names[n.track] || `Трек ${n.track + 1}`);
    part.min = Math.min(part.min, n.pitch); part.max = Math.max(part.max, n.pitch);
    const energyEnd=n.percussion?Math.min(n.hardEnd??Infinity,n.start+.2):n.end;
    for (let i = 0; i < n.levels.length; i++) part.energy += n.levels[i].gain ** 2 * Math.max(0,Math.min(energyEnd, n.levels[i + 1]?.time ?? energyEnd) - n.levels[i].time);
  }
  return { format, ppqn: division, duration:Math.max(duration,...valid.filter(n=>n.percussion).map(n=>n.start+.00025)), notes: valid,
    parts: [...parts.values()].map(p => ({ ...p, tracks: [...p.tracks] })).sort((a, b) => b.energy - a.energy || a.channel - b.channel || a.program - b.program),
    warnings: [...warnings] };
}

export const programFamilies = ['Фортепиано', 'Хроматическая перкуссия', 'Орган', 'Гитара', 'Бас', 'Струнные', 'Ансамбль', 'Медные духовые', 'Деревянные духовые', 'Флейта', 'Синтезатор: соло', 'Синтезатор: фон', 'Синтезатор: эффекты', 'Этнические', 'Перкуссия', 'Эффекты'];
export const programName = program => `${programFamilies[program >> 3]} · GM ${program + 1}`;
export function suggestedSample(program,part) {
  if(part?.percussion)return drumSample(part.drumKey);
  const exact = { 9: 'glockenspiel', 11: 'glockenspiel', 12: 'marimba', 13: 'xylophone', 41: 'viola',
    42: 'cello', 43: 'contrabass', 46: 'harp', 56: 'trumpet', 57: 'trombone', 58: 'tuba', 60: 'horn',
    68: 'oboe', 69: 'horn', 70: 'bassoon', 71: 'clarinet', 72: 'piccolo', 73: 'flute', 74: 'flute', 75: 'flute' };
  if (exact[program]) return exact[program];
  if (program >= 16 && program < 24) return 'organ';
  if (program >= 24 && program < 32) return 'guitar';
  if (program >= 32 && program < 40) return 'contrabass';
  if (program >= 40 && program < 56 || program >= 64 && program < 80) return 'violin';
  return 'piano';
}
