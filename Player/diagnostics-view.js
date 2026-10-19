const statusNames = { substituted: 'Замена инструмента', unsupported: 'Команда не выполняется',
  partial: 'Частичная поддержка', bankDependent: 'Зависит от банка', unverified: 'Выполнение не подтверждено' };

// All MIDI and SoundFont strings are untrusted text, never markup.
export function renderMidiDiagnostics(container, report) {
  container.replaceChildren();
  const document = container.ownerDocument;
  const add = (parent, tag, text) => {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  if (!report) { add(container, 'p', 'Отчёт появится после загрузки MIDI в SoundFont-плеер.'); return; }
  const counts = report.summary;
  add(container, 'p', `Замены: ${counts.substituted}. Пропуски: ${counts.unsupported}. Частичная поддержка: ${counts.partial}. Зависят от банка: ${counts.bankDependent}. Не подтверждены: ${counts.unverified}.`);
  add(container, 'p', `Проверено событий: ${report.eventsScanned}.${report.complete ? '' : ' Проверка некоторых команд завершилась ошибкой; отчёт неполный.'}`);
  if (!report.entries.length && !report.omitted) add(container, 'p', 'Подмены тембров и известные ограничения обработки команд в этом файле не обнаружены.');
  const list = add(container, 'ol', '');
  for (const entry of report.entries) {
    const item = add(list, 'li', '');
    add(item, 'strong', `${statusNames[entry.status]} · ${entry.feature}${entry.count > 1 ? ' · ×' + entry.count : ''}`);
    add(item, 'p', entry.message);
    const at = entry.first;
    add(item, 'small', `${at.seconds.toFixed(3)} с · дорожка ${at.track} · порт ${at.port}${at.channel == null ? '' : ' · канал ' + at.channel}`);
    if (entry.data?.length) add(item, 'pre', entry.data.map(n => n.toString(16).toUpperCase().padStart(2, '0')).join(' '));
  }
  if (report.omitted) add(container, 'p', `Ещё ${report.omitted} замечаний не показано из-за ограничения размера отчёта. Счётчики включают их.`);
  add(container, 'p', report.note);
  const download = add(container, 'button', 'Скачать отчёт JSON'); download.type = 'button';
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'midi-diagnostics.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
