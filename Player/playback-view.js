export function renderPlaybackControls(container, player, { onError = () => {} } = {}) {
  const document = container.ownerDocument;
  const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  container.replaceChildren();
  const form = el('form'), field = el('fieldset'), status = el('p'); field.className = 'playback-controls'; status.setAttribute('role', 'status');
  field.append(el('legend', 'Скорость, высота и повтор'));
  const number = (label, value, min, max, step) => {
    const row = el('label', label + ' '), input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = value; input.required = true; input.setAttribute('aria-label', label); row.append(input); field.append(row); return input;
  };
  const rate = number('Скорость ×', player.playbackRate, .25, 4, 'any'), transpose = number('Транспонирование, полутоны', player.transpose, -48, 48, 1);
  const row = el('label', 'Повтор '), mode = el('select'); mode.setAttribute('aria-label', 'Режим повтора');
  for (const [value, title] of [['off', 'Выключен'], ['full', 'Вся композиция'], ['ab', 'Фрагмент A/B']]) { const option = el('option', title); option.value = value; mode.append(option); }
  const loop = player.loop, duration = player.metadata.sourceDuration;
  mode.value = !loop ? 'off' : loop.start === 0 && loop.end === duration ? 'full' : 'ab'; row.append(mode); field.append(row);
  const start = number('A, секунды MIDI', loop?.start ?? 0, 0, duration, 'any'), end = number('B, секунды MIDI', loop?.end ?? duration, 0, duration, 'any');
  for (const [label, input] of [['A ← позиция', start], ['B ← позиция', end]]) { const button = el('button', label); button.type = 'button'; button.onclick = () => { input.value = String(Math.min(duration, player.currentTime)); mode.value = 'ab'; bounds(); }; field.append(button); }
  const bounds = () => { start.disabled = end.disabled = mode.value !== 'ab'; }; mode.onchange = bounds; bounds();
  const apply = el('button', 'Применить'); apply.type = 'submit'; field.append(apply);
  const note = el('p', 'Позиция и A/B указаны во времени исходного MIDI. Скорость не меняет высоту звука; транспонирование не меняет ударные. Повтор возвращается из B в A без плавного перехода. Применение настроек временно приостанавливает звук.'); note.className = 'playback-note';
  const iteration = el('p'); iteration.className = 'playback-iteration';
  const showIteration = () => { iteration.textContent = 'Повторов: ' + player.iteration; }; showIteration();
  form.append(field, note, status, iteration); container.append(form);
  form.onsubmit = async event => {
    event.preventDefault(); field.disabled = true; status.textContent = 'Подготовка воспроизведения…';
    try {
      await player.setPlayback({ rate: Number(rate.value), transpose: Number(transpose.value), loop: mode.value === 'off' ? null : mode.value === 'full' ? true : { start: Number(start.value), end: Number(end.value) } });
      status.textContent = 'Настройки применены.';
    } catch (error) { status.textContent = error.message; onError(error); }
    finally { field.disabled = false; bounds(); }
  };
  const sync = () => { const settings = player.playback; rate.value = settings.rate; transpose.value = settings.transpose; const loop = settings.loop; mode.value = !loop ? 'off' : loop.start === 0 && loop.end === duration ? 'full' : 'ab'; start.value = loop?.start ?? 0; end.value = loop?.end ?? duration; bounds(); showIteration(); };
  player.addEventListener('playbackchange', sync); player.addEventListener('loop', showIteration); player.addEventListener('timeupdate', showIteration);
  return () => { player.removeEventListener('playbackchange', sync); player.removeEventListener('loop', showIteration); player.removeEventListener('timeupdate', showIteration); };
}
