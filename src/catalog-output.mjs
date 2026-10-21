import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Optional external-device modules stay in the repository for explicit integrations.
// Standard catalogs ship only the file player, including when updating an old export.
const externalMidiModules = new Set(['web-midi.js', 'live-midi.js', 'live-synth.js', 'live-worker.js', 'live-worklet.js', 'devices-view.js']);
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');

export function renderCatalog(library) {
  const json = JSON.stringify(library).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const queue = read('Player/event-queue.js').replace(/^export\s+/gm, '');
  const core = queue + '\n' + read('src/midi-metadata.mjs')
    .replace("import { FIFOQueue } from '../Player/event-queue.js';", '').replace(/^export\s+/gm, '');
  let html = read('catalog/index.template.html')
    .replace('/* CATALOG_STYLES */', () => read('catalog/styles.css'))
    .replace('/* CATALOG_DATA */', () => json)
    .replace('/* MIDI_CORE */', () => '(() => {\n' + core + '\nwindow.MidiCore = {readMidi, instrumentFamily};\n})();')
    .replace('/* CATALOG_APP */', () => read('catalog/app.js'));
  if (library.mode === 'public') html = html
    .replace('Web-MIDI-Player — каталог мелодий', 'Web-MIDI-Player — библиотека')
    .replace('Локальная коллекция', 'Библиотека')
    .replace('Файлы хранятся на вашем компьютере', 'Классика и регтайм · Public Domain')
    .replace('OFFLINE LIBRARY', 'PUBLIC DOMAIN')
    .replace('Для прослушивания откройте <strong>«Открыть каталог.cmd»</strong> в папке проекта. Поиск и ссылки на файлы работают и здесь.', 'Для прослушивания откройте каталог через HTTP или HTTPS. Поиск и скачивание MIDI работают и здесь.')
    .replace('Точные копии удалены после побайтного сравнения. Сохранённый файл и все источники доступны в карточке мелодии. Разделы составлены по метаданным каталога.', 'Произведения и редакции с заявленным статусом Public Domain. Источники, авторы набора и исходные ноты доступны в карточках мелодий.');
  return html;
}

export function writeCatalog(directory, library) {
  fs.mkdirSync(directory, { recursive: true });
  const playerDirectory = path.join(path.resolve(directory), 'player');
  if (fs.existsSync(playerDirectory)) {
    if (fs.lstatSync(playerDirectory).isSymbolicLink()) throw new Error('Player export must be a real directory.');
    for (const name of externalMidiModules) {
      const target = path.join(playerDirectory, name);
      if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isFile()) throw new Error('Unexpected external MIDI export entry: ' + name);
        fs.unlinkSync(target);
      }
    }
  }
  fs.writeFileSync(path.join(directory, 'index.html'), renderCatalog(library));
  if (library.mode !== 'public') {
    fs.cpSync(path.join(root, 'Player'), path.join(directory, 'player'), {
      recursive: true, filter: source => !['tests', 'node_modules', '.cache', '.git'].includes(path.basename(source)) && !externalMidiModules.has(path.basename(source))
    });
    return;
  }
  const runtime = ['index.js', 'worker.js', 'worklet.js', 'audio-queue.js', 'midi-timing.js',
    'soundfont-preview.js', 'active-voices.js', 'event-queue.js', 'sample-dump.js', 'sample-dump-oscillator.js', 'sample-dump-bank.js', 'sample-dump-settings.js', 'midi-tuning.js', 'gs-effects.js', 'effect-dsp.js', 'xg-variation.js', 'xg-delay.js', 'xg-effect-values.js', 'xg-drive.js', 'xg-insertion-slots.js', 'xg-effect-control.js', 'xg-insertion.js', 'xg-effect-types.js', 'xg-system-effects.js', 'xg-reverb.js', 'xg-chorus.js', 'fluid-bank-mappings.js', 'synth-checkpoint.js', 'playback-settings.js', 'playback-view.js', 'loop-preview.js', 'transport-timeline.js', 'lazy-bank.js', 'release-velocity.js', 'part-controls.js', 'parts-view.js', 'midi-text.js', 'text-view.js', 'midi-diagnostics.js', 'diagnostics-view.js', 'stereo-preview.js', 'voice-dsp-state.js', 'voice-dsp-batch.js', 'voice-dsp.js',
    'engine', 'vendor', 'dsp/voice-mixer.wasm', 'dsp/voice-mixer-simd.wasm',
    'soundfonts/fluidr3-gm', 'licenses', 'PROVENANCE.json'];
  for (const asset of runtime) {
    const target = path.join(directory, 'player', asset);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, 'Player', asset), target, { recursive: true });
  }
}
