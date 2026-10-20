const labels = { text: 'Текст', copyright: 'Авторские сведения', trackName: 'Дорожка', instrumentName: 'Инструмент', lyric: 'Слова', marker: 'Маркер', cue: 'Cue', display: 'Дисплей', programName: 'Программа', deviceName: 'Устройство', reservedText: 'Текстовое событие' };
const time = value => Math.floor(value / 60) + ':' + (value % 60).toFixed(2).padStart(5, '0');
export function renderMidiText(container, player) {
  const document = container.ownerDocument, info = player.metadata?.text;
  const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  container.replaceChildren();
  if (!info?.events.length) { container.append(el('p', 'В этом файле нет текстовых событий.')); return () => {}; }
  const tracks = el('details'), heading = el('summary', 'Названия дорожек'); tracks.append(heading);
  for (const track of info.tracks) tracks.append(el('p', track.track + ' · ' + (track.name || 'Без названия') + (track.instruments.length ? ' · ' + track.instruments.join(', ') : '')));
  const navigation = el('label', 'Маркеры и cue points '), select = el('select'), empty = el('option', 'Выберите позицию'); empty.value = ''; select.append(empty);
  select.setAttribute('aria-label', 'Перейти к маркеру или cue point');
  for (const e of info.events.filter(e => e.kind === 'marker' || e.kind === 'cue')) { const option = el('option', time(e.seconds) + ' · ' + labels[e.kind] + ': ' + e.text); option.value = e.id; select.append(option); }
  select.disabled = select.options.length === 1; navigation.append(select);
  const status = el('p'); status.setAttribute('role', 'status');
  select.onchange = async () => { const e = info.events.find(e => String(e.id) === select.value); if (!e) return; try { await player.seek(e.seconds); status.textContent = ''; } catch (error) { status.textContent = error.message; } };
  const live = el('div'); live.className = 'midi-text-live'; live.setAttribute('aria-live', 'polite');
  const all = el('details'), title = el('summary', 'Все события · ' + info.events.length), list = el('ol');
  const previous = el('button', '← Предыдущие'), next = el('button', 'Следующие →'), count = el('span'); previous.type = next.type = 'button';
  let page = 0;
  const showPage = () => {
    list.replaceChildren(); list.start = page * 50 + 1;
    for (const e of info.events.slice(page * 50, page * 50 + 50)) {
      const item = el('li'), text = e.kind === 'display' ? e.display.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ') : e.text;
      item.append(el('small', time(e.seconds) + ' · дорожка ' + e.track + ' · порт ' + e.port + (e.channel ? ', канал ' + e.channel : '') + ' · ' + labels[e.kind]), el('pre', text)); list.append(item);
    }
    previous.disabled = page === 0; next.disabled = (page + 1) * 50 >= info.events.length; count.textContent = ' ' + (page + 1) + ' / ' + Math.ceil(info.events.length / 50) + ' ';
  };
  previous.onclick = () => { page--; showPage(); }; next.onclick = () => { page++; showPage(); }; showPage();
  all.append(title, list, previous, count, next);
  container.append(tracks, navigation, status, live, all);
  const update = () => {
    live.replaceChildren(); const state = player.textState;
    for (const lyric of state.lyrics) {
      const line = el('p'); line.append(el('small', 'Дорожка ' + lyric.track + ' · '));
      if (lyric.syllable && lyric.line.endsWith(lyric.syllable)) line.append(document.createTextNode(lyric.line.slice(0, -lyric.syllable.length)), el('mark', lyric.syllable));
      else line.append(document.createTextNode(lyric.line)); live.append(line);
    }
    for (const display of state.displays) {
      live.append(el('small', display.family.toUpperCase() + ' · порт ' + display.event.port + ' · последнее сообщение дисплея'));
      const body = display.format === 'letters' ? display.text : display.format === 'bitmap' ? display.pixels.map(r => r.replaceAll('1', '●').replaceAll('0', '·')).join('\n') : display.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
      const pre = el('pre', body); pre.className = display.format === 'bitmap' ? 'midi-display-bitmap' : 'midi-display-text'; live.append(pre);
    }
    const marker = [state.marker, state.cue].filter(Boolean).sort((a, b) => b.id - a.id)[0]; select.value = marker ? String(marker.id) : '';
  };
  update(); player.addEventListener('textchange', update);
  return () => player.removeEventListener('textchange', update);
}
