(() => {
  'use strict';
  const library = JSON.parse(document.getElementById('library-data').textContent);
  const items = library.items, byId = new Map(items.map(item => [item.id, item]));
  const $ = id => document.getElementById(id);
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normalize = text => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/ё/g, 'е');
  const compare = new Intl.Collator('ru', { sensitivity: 'base', numeric: true }).compare;
  const number = n => new Intl.NumberFormat('ru-RU').format(n);
  const time = seconds => {
    if (seconds === null || !Number.isFinite(seconds)) return '—';
    if (seconds >= 86400) return `${number(Math.floor(seconds / 86400))} д.`;
    const total = Math.max(0, Math.floor(seconds)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${(bytes / 1024).toFixed(1)} КБ`;
  const href = file => file.split('/').map(encodeURIComponent).join('/');
  const filename = item => `${item.artist} - ${item.title}.${item.versions[0].file.endsWith('.rmi') ? 'rmi' : 'mid'}`.replace(/[<>:"/\\|?*]/g, '_');
  const state = { view: 'all', category: '', query: '', artist: '', instrument: '', duration: '', sort: 'artist', page: 1, pageSize: 50, family: null };
  let favorites = new Set(), storageAvailable = true, filtered = [], toastTimer;
  try { favorites = new Set(JSON.parse(localStorage.getItem('midi-library-favorites-v1') || '[]').filter(id => byId.has(id))); }
  catch { storageAvailable = false; }
  for (const item of items) item.searchIndex = normalize([item.title, item.artist, item.searchExtra, ...item.aliases].join(' '));
  const artistCounts = new Map(), categoryCounts = new Map(), instrumentCounts = new Map();
  for (const item of items) {
    artistCounts.set(item.artist, (artistCounts.get(item.artist) || 0) + 1);
    categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
    for (const instrument of item.instruments) instrumentCounts.set(instrument, (instrumentCounts.get(instrument) || 0) + 1);
  }
  $('count-all').textContent = number(items.length);
  $('count-issues').textContent = number(library.stats.issues);
  $('library-summary').textContent = `${number(library.stats.unique)} уникальных MIDI · ${number(library.stats.artists)} исполнителей и композиторов · ${number(library.stats.files)} файлов`;
  $('count-favorites').textContent = number(favorites.size);
  $('categories').innerHTML = ['Классика', 'Песни и исполнители', 'Кино и ТВ', 'Игры', 'Гимны', 'Праздники', 'Разное'].map(category =>
    `<button class="nav-item category-item" data-category="${escape(category)}"><span>${escape(category)}</span><span>${number(categoryCounts.get(category) || 0)}</span></button>`).join('');
  $('artist-list').innerHTML = [...artistCounts.keys()].sort(compare).map(artist => `<option value="${escape(artist)}">${number(artistCounts.get(artist))} MIDI</option>`).join('');
  $('instrument').insertAdjacentHTML('beforeend', [...instrumentCounts.keys()].sort(compare).map(name => `<option value="${escape(name)}">${escape(name)} (${number(instrumentCounts.get(name))})</option>`).join(''));
  if (location.protocol === 'file:') $('file-notice').hidden = false;
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
  function saveFavorites() {
    try { localStorage.setItem('midi-library-favorites-v1', JSON.stringify([...favorites])); }
    catch { storageAvailable = false; toast('Избранное доступно до закрытия каталога: браузер запретил локальное сохранение.'); }
    $('count-favorites').textContent = number(favorites.size);
  }
  function toggleFavorite(id) { favorites.has(id) ? favorites.delete(id) : favorites.add(id); saveFavorites(); update(); }
  function update() {
    const tokens = normalize(state.query).trim().split(/\s+/).filter(Boolean), artist = normalize(state.artist).trim();
    const exactArtist = [...artistCounts.keys()].find(name => normalize(name) === artist);
    const family = state.family && new Set(state.family);
    filtered = items.filter(item => {
      if (state.view === 'favorites' && !favorites.has(item.id)) return false;
      if (state.view === 'issues' && !item.issues.length) return false;
      if (state.category && item.category !== state.category) return false;
      if (artist && (exactArtist ? item.artist !== exactArtist : !normalize(item.artist).includes(artist))) return false;
      if (state.instrument && !item.instruments.includes(state.instrument)) return false;
      if (state.duration === 'short' && !(item.duration !== null && item.duration < 120)) return false;
      if (state.duration === 'medium' && !(item.duration >= 120 && item.duration <= 300)) return false;
      if (state.duration === 'long' && !(item.duration > 300)) return false;
      if (state.duration === 'unknown' && item.duration !== null) return false;
      if (family && !family.has(item.id)) return false;
      return tokens.every(token => item.searchIndex.includes(token));
    });
    const tie = (a, b) => Number(a.artist === 'Не указан') - Number(b.artist === 'Не указан') || compare(a.artist, b.artist) || compare(a.title, b.title);
    const numeric = (a, b, key, descending = false) => {
      if (a[key] == null && b[key] == null) return tie(a, b);
      if (a[key] == null) return 1; if (b[key] == null) return -1;
      return (a[key] - b[key]) * (descending ? -1 : 1) || tie(a, b);
    };
    filtered.sort((a, b) => state.sort === 'title' ? compare(a.title, b.title) || tie(a, b)
      : state.sort === 'duration' ? numeric(a, b, 'duration') : state.sort === 'duration-desc' ? numeric(a, b, 'duration', true)
      : state.sort === 'tempo' ? numeric(a, b, 'tempo') : state.sort === 'copies' ? b.versions.length - a.versions.length || tie(a, b) : tie(a, b));
    render();
  }
  function render() {
    // Favorite toggles can change the membership of the active view.
    if (state.view === 'favorites') filtered = filtered.filter(item => favorites.has(item.id));
    const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.max(1, Math.min(state.page, pages));
    const start = (state.page - 1) * state.pageSize, visible = filtered.slice(start, start + state.pageSize);
    $('rows').innerHTML = visible.map(item => {
      const playing = player.item?.id === item.id && player.playing;
      return `<tr data-id="${item.id}"><td><button class="favorite-button ${favorites.has(item.id) ? 'chosen' : ''}" data-action="favorite" aria-label="${favorites.has(item.id) ? 'Убрать из избранного' : 'В избранное'}: ${escape(item.title)}" aria-pressed="${favorites.has(item.id)}">${favorites.has(item.id) ? '★' : '☆'}</button></td>
        <td><button class="row-play ${playing ? 'playing' : ''}" data-action="play" aria-label="${playing ? 'Пауза' : 'Прослушать'}: ${escape(item.title)}" ${!item.playable ? 'disabled title="Этот MIDI не удалось прочитать для прослушивания"' : ''}>${playing ? 'Ⅱ' : '▶'}</button></td>
        <td><button class="song-button" data-action="details" title="${escape(item.title)}">${escape(item.title)}</button><div class="artist-line">${item.issues.length ? '<span class="warning-dot" title="У исходника есть пометки"></span>' : ''}<button class="artist-link" data-action="artist" title="Показать исполнителя">${escape(item.artist)}</button></div></td>
        <td class="cell-time">${time(item.duration)}</td><td class="cell-tempo" title="${item.tempoMin !== item.tempoMax ? `Темп меняется: ${item.tempoMin}–${item.tempoMax} BPM` : 'Темп в MIDI'}">${item.tempo ?? '—'}</td>
        <td class="cell-instruments"><div class="instrument-tags" title="${escape(item.instruments.join(', '))}">${item.instruments.slice(0, 2).map(name => `<span class="instrument-tag">${escape(name)}</span>`).join('')}${item.instruments.length > 2 ? `<span class="instrument-tag">+${item.instruments.length - 2}</span>` : ''}</div></td>
        <td class="cell-copies"><button class="copy-button" data-action="details" title="${item.versions.length} источников, ${new Set(item.versions.map(v => v.file)).size} файлов">${item.versions.length > 1 ? item.versions.length : '·'}</button></td>
        <td><a class="download-link" href="${href(item.versions[0].file)}" download="${escape(filename(item))}" aria-label="Скачать MIDI: ${escape(item.title)}" title="Скачать MIDI">↓</a></td></tr>`;
    }).join('');
    $('result-count').textContent = `${number(filtered.length)} MIDI`;
    $('range').textContent = filtered.length ? `${number(start + 1)}–${number(Math.min(start + state.pageSize, filtered.length))} из ${number(filtered.length)}` : 'Нет мелодий';
    $('page-number').textContent = `${state.page} / ${pages}`;
    $('previous').disabled = state.page === 1; $('next').disabled = state.page >= pages;
    $('empty').hidden = filtered.length > 0;
    $('empty-title').textContent = state.view === 'favorites' && !favorites.size ? 'Здесь будет ваша подборка' : 'Ничего не найдено';
    $('empty-description').textContent = state.view === 'favorites' && !favorites.size ? 'Нажмите ☆ рядом с мелодией, чтобы сохранить её в избранное.' : 'Попробуйте другой запрос или сбросьте фильтры.';
    $('page-title').textContent = state.category || (state.view === 'favorites' ? 'Избранное' : state.view === 'issues' ? 'С пометками' : 'Вся коллекция');
    for (const button of $('views').querySelectorAll('button')) { const active = !state.category && button.dataset.view === state.view; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }
    for (const button of $('categories').querySelectorAll('button')) { const active = button.dataset.category === state.category; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }
    $('active-filter').hidden = !state.family;
    if (state.family) $('active-filter').innerHTML = `Версии одной мелодии <button id="clear-family" aria-label="Показать все мелодии">×</button>`;
    $('count-favorites').textContent = number(favorites.size);
  }
  function reset() {
    Object.assign(state, { view: 'all', category: '', query: '', artist: '', instrument: '', duration: '', sort: 'artist', page: 1, family: null });
    for (const key of ['search', 'artist', 'instrument', 'duration']) $(key).value = '';
    $('sort').value = 'artist'; update();
  }
  function showDetails(item) {
    const related = library.families[item.family] || [];
    const tempo = item.tempo == null ? '—' : item.tempoMin === item.tempoMax ? `${item.tempo} BPM` : `${item.tempoMin}–${item.tempoMax} BPM`;
    const translated = message => ({ 'Truncated MIDI track': 'Неполная дорожка в исходном файле', 'Invalid MIDI header': 'Неверный заголовок исходного файла' }[message] || message);
    $('detail-body').innerHTML = `<h2 id="details-title" class="detail-title">${escape(item.title)}</h2><p class="detail-artist">${escape(item.artist)}</p>
      <div class="detail-actions"><button class="primary-button" id="detail-play" ${!item.playable ? 'disabled' : ''}>▶ Прослушать</button><a class="secondary-button" href="${href(item.versions[0].file)}" download="${escape(filename(item))}">Скачать MIDI ↓</a><button class="secondary-button" id="detail-favorite">${favorites.has(item.id) ? '★ В избранном' : '☆ В избранное'}</button></div>
      <dl class="metadata-grid"><div><dt>Длительность звучания</dt><dd>${time(item.duration)}</dd></div><div><dt>Темп</dt><dd>${tempo}</dd></div><div><dt>Размер файла</dt><dd>${size(item.bytes)}</dd></div><div><dt>Дорожки</dt><dd>${item.tracks ?? '—'}</dd></div><div><dt>Ноты</dt><dd>${item.noteCount == null ? '—' : number(item.noteCount)}</dd></div><div><dt>Раздел</dt><dd>${escape(item.category)}</dd></div></dl>
      <h3 class="detail-section">Инструменты</h3><div class="instrument-tags">${item.instruments.map(name => `<span class="instrument-tag">${escape(name)}</span>`).join('') || '<span class="detail-note">Не определены</span>'}</div>
      ${item.metadataInferred ? '<p class="detail-note">Название и исполнитель восстановлены из имени файла в сборнике.</p>' : ''}
      ${item.issues.length ? `<div class="issue-box"><strong>Пометки об исходнике</strong><br>${item.issues.map(message => escape(translated(message))).join('<br>')}<br>Оригинальный файл сохранён без изменений.</div>` : ''}
      ${related.length > 1 ? `<h3 class="detail-section">Другие версии</h3><p class="detail-note">Есть ${related.length} разных MIDI с этим названием и исполнителем.</p><button class="secondary-button" id="related">Показать все версии</button>` : ''}
      <h3 class="detail-section">Файл и источники · ${item.versions.length}</h3><p class="detail-note">Одинаковые копии объединены. Каждая ссылка «скачать» ведёт к сохранённому экземпляру.</p>
      ${item.versions.map((version, i) => `<div class="file-copy"><div><strong>${escape((version.originalFile || version.file).split('/').pop())}</strong><p>${i ? 'Дополнительный источник' : 'Основной файл'}${version.archive ? ' · из MIDI-сборника' : ''} · <a href="${escape(version.source || version.url)}" target="_blank" rel="noopener noreferrer">Страница источника ↗</a></p></div><a class="download-link" href="${href(version.file)}" download="${escape(filename(item))}" aria-label="Скачать сохранённый MIDI">↓</a></div>`).join('')}`;
    $('detail-play').onclick = () => { $('details').close(); player.toggle(item); };
    $('detail-favorite').onclick = () => { toggleFavorite(item.id); $('detail-favorite').textContent = favorites.has(item.id) ? '★ В избранном' : '☆ В избранное'; };
    if ($('related')) $('related').onclick = () => { reset(); state.family = related; update(); $('details').close(); };
    if (!$('details').open) $('details').showModal();
  }
  const sampleModule = location.protocol === 'file:' ? null : import('./player/index.js');
  // Resolve module failures on first use, keeping catalog search available.
  sampleModule?.catch(() => {});
  class MidiPlayer {
    constructor() { this.item = null; this.song = null; this.playing = false; this.position = 0; this.token = 0; }
    async initialize() {
      if (this.engine) return this.engine;
      const { MidiPlayer: SamplePlayer } = await sampleModule;
      const engine = this.engine = new SamplePlayer({ volume: Number($('volume').value) });
      engine.addEventListener('statechange', () => {
        if (this.engine !== engine) return;
        this.playing = engine.state === 'playing'; this.display();
      });
      engine.addEventListener('timeupdate', event => {
        if (this.engine !== engine) return;
        this.position = event.detail.currentTime; $('seek').value = this.position;
        $('current-time').textContent = time(this.position);
      });
      engine.addEventListener('error', event => { if (this.engine === engine) toast(event.detail.message); });
      return engine;
    }
    async toggle(item = this.item) {
      if (!item) return;
      if (location.protocol === 'file:') { toast('Для прослушивания запустите «Открыть каталог.cmd» в папке проекта.'); return; }
      const token = ++this.token;
      try {
        const engine = await this.initialize(); await engine.unlock();
        if (token !== this.token) return;
        if (this.item?.id === item.id && this.song) {
          engine.state === 'playing' ? await engine.pause() : await engine.play(); return;
        }
        this.item = item; this.song = null; this.position = 0; this.display();
        $('player-title').textContent = `Загрузка: ${item.title}`;
        const song = await engine.load(href(item.versions[0].file));
        if (token !== this.token) return;
        this.song = song; this.display();
        if (song.warnings?.length) toast(song.warnings.join(' '));
        await engine.play();
      } catch (error) { if (token === this.token && error.name !== 'AbortError') { toast(error.message); this.display(); } }
    }
    async seek(position) {
      if (!this.song) return;
      try { await this.engine.seek(position); this.position = this.engine.currentTime; this.display(); }
      catch (error) { toast(error.message); }
    }
    display() {
      $('player').hidden = !this.item;
      if (this.item) {
        $('player-title').textContent = this.item.title; $('player-artist').textContent = this.item.artist;
        $('total-time').textContent = time(this.song?.duration ?? this.item.duration);
        $('current-time').textContent = time(this.position); $('seek').max = this.song?.duration || 1;
        $('seek').value = this.position; $('seek').disabled = !this.song;
        $('player-toggle').textContent = this.playing ? 'Ⅱ' : '▶'; $('player-toggle').setAttribute('aria-label', this.playing ? 'Пауза' : 'Продолжить');
      }
      render();
    }
    close() {
      this.token++; const engine = this.engine; this.engine = null; engine?.dispose().catch(error => toast(error.message));
      this.item = this.song = null; this.playing = false; this.position = 0; this.display();
    }
  }

  const player = new MidiPlayer();
  let searchTimer;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = $('search').value; state.page = 1; update(); }, 100); });
  for (const key of ['artist', 'instrument', 'duration', 'sort']) $(key).addEventListener(key === 'artist' ? 'input' : 'change', () => { state[key] = $(key).value; state.page = 1; update(); });
  $('page-size').onchange = () => { state.pageSize = Number($('page-size').value); state.page = 1; render(); };
  $('previous').onclick = () => { state.page--; render(); };
  $('next').onclick = () => { state.page++; render(); };
  $('views').onclick = event => { const button = event.target.closest('[data-view]'); if (button) { reset(); state.view = button.dataset.view; update(); } };
  $('categories').onclick = event => { const button = event.target.closest('[data-category]'); if (button) { reset(); state.category = button.dataset.category; update(); } };
  $('rows').onclick = event => {
    const action = event.target.closest('[data-action]'), row = event.target.closest('tr[data-id]');
    if (!action || !row) return;
    const item = byId.get(row.dataset.id);
    if (action.dataset.action === 'favorite') toggleFavorite(item.id);
    if (action.dataset.action === 'play') player.toggle(item);
    if (action.dataset.action === 'details') showDetails(item);
    if (action.dataset.action === 'artist') { reset(); state.artist = item.artist; $('artist').value = item.artist; update(); }
  };
  $('active-filter').onclick = () => { state.family = null; state.page = 1; update(); };
  $('reset').onclick = reset; $('empty-reset').onclick = reset;
  document.querySelector('.brand').onclick = event => { event.preventDefault(); reset(); };
  $('close-details').onclick = () => $('details').close();
  $('details').onclick = event => { if (event.target === $('details') && (event.offsetX < 0 || event.offsetX > $('details').clientWidth || event.offsetY < 0 || event.offsetY > $('details').clientHeight)) $('details').close(); };
  $('player-toggle').onclick = () => player.toggle(); $('player-close').onclick = () => player.close();
  $('seek').onchange = () => { const position = Number($('seek').value); if (player.song) { player.seek(position); } };
  $('volume').oninput = () => { if (player.engine) player.engine.volume = Number($('volume').value); };
  $('export').onclick = () => {
    const cell = value => { let text = String(value ?? ''); if (/^[=+@-]/.test(text)) text = "'" + text; return `"${text.replaceAll('"', '""')}"`; };
    const rows = [['Название', 'Исполнитель', 'Раздел', 'Время', 'BPM', 'Инструменты', 'Источники', 'Файл'], ...filtered.map(item => [item.title, item.artist, item.category, time(item.duration), item.tempo, item.instruments.join('; '), item.versions.length, item.versions[0].file])];
    const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'MIDI — выбранные мелодии.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Экспортировано: ${number(filtered.length)} MIDI`);
  };
  document.addEventListener('keydown', event => {
    const editing = /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === '/' && !editing && !$('details').open) { event.preventDefault(); $('search').focus(); }
    if (event.code === 'Space' && !editing && !$('details').open && player.item) { event.preventDefault(); player.toggle(); }
  });
  window.addEventListener('beforeunload', () => { player.clearVoices(); clearInterval(player.timer); });
  update();
})();
