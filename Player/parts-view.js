import { instrumentKey } from './part-controls.js';

// Shared DOM view for the portable example and both catalog modes.
export function renderPartControls(container, player, { onError = () => {} } = {}) {
  const document = container.ownerDocument;
  const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  container.replaceChildren();
  const note = element('p', 'Громкость умножает MIDI-громкость; панорама задаёт сдвиг относительно файла. Выбор инструмента применяется ко всей партии. Изменение восстанавливает текущую позицию и может занять время.');
  note.className = 'parts-note'; container.append(note);
  const status = element('p'); status.setAttribute('role', 'status'); container.append(status);
  const instruments = player.instruments;
  for (const part of player.parts) {
    const field = element('fieldset'); field.className = 'part-controls';
    field.append(element('legend', 'Порт ' + part.port + ' · канал ' + part.channel));
    field.append(element('p', part.sourceInstruments.map(p => p.name).join(' → ') + ' · дорожки ' + part.tracks.join(', ')));
    const update = async changes => {
      const fields = [...container.querySelectorAll('fieldset')]; fields.forEach(f => { f.disabled = true; });
      status.textContent = 'Подготовка партии…';
      try { await player.setPart(part.id, changes); renderPartControls(container, player, { onError }); }
      catch (error) { status.textContent = error.message; fields.forEach(f => { f.disabled = false; }); onError(error); }
    };
    for (const [key, title] of [['muted', 'Mute'], ['solo', 'Solo']]) {
      const label = element('label', title + ' '), input = element('input');
      input.type = 'checkbox'; input.checked = part[key];
      input.onchange = () => update({ [key]: input.checked }); label.append(input); field.append(label);
    }
    for (const [key, title, min] of [['volume', 'Громкость', 0], ['pan', 'Сдвиг панорамы', -1]]) {
      const label = element('label', title + ' '), output = element('output', Math.round(part[key] * 100) + '%'), input = element('input');
      input.type = 'range'; input.min = min; input.max = 1; input.step = .01; input.value = part[key];
      input.setAttribute('aria-label', title + ' · порт ' + part.port + ', канал ' + part.channel);
      input.oninput = () => { output.textContent = Math.round(Number(input.value) * 100) + '%'; };
      input.onchange = () => update({ [key]: Number(input.value) }); label.append(output, input); field.append(label);
    }
    const label = element('label', 'Инструмент '), select = element('select'), original = element('option', 'Как в MIDI-файле');
    select.setAttribute('aria-label', 'Инструмент · порт ' + part.port + ', канал ' + part.channel);
    original.value = ''; select.append(original);
    for (const instrument of instruments) {
      const option = element('option', instrument.name + ' · ' + instrument.bankMSB + ':' + instrument.bankLSB + ':' + (instrument.program + 1) + (instrument.percussion ? ' · ударные' : ''));
      option.value = instrumentKey(instrument); select.append(option);
    }
    select.value = part.instrument ? instrumentKey(part.instrument) : '';
    select.onchange = () => { const p = instruments.find(p => instrumentKey(p) === select.value); update({ instrument: p ? { bankMSB: p.bankMSB, bankLSB: p.bankLSB, program: p.program, percussion: p.percussion } : null }); };
    label.append(select); field.append(label);
    const reset = element('button', 'Сбросить партию'); reset.type = 'button';
    reset.onclick = () => update({ muted: false, solo: false, volume: 1, pan: 0, instrument: null }); field.append(reset);
    container.append(field);
  }
}
