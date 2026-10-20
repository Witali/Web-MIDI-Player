import { installSampleDumpBank } from './sample-dump-bank.js';
import { installXGVariation } from './xg-variation.js';
import { installGSEffects } from './gs-effects.js';
import { installBankMappings } from './fluid-bank-mappings.js';
import { installPartControls } from './part-controls.js';
import { SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from './vendor/spessasynth.js';

// These controllers have transport/parameter behavior or standard synth routing.
// Other CCs are retained for SoundFont modulators; absence of a dedicated handler
// alone is not evidence that the selected bank ignores the value.
const handledCCs = new Set([0, 1, 5, 6, 7, 10, 11, 32, 33, 37, 38, 39, 42, 43,
  64, 65, 66, 68, 69, 71, 72, 73, 74, 75, 76, 77, 78, 84, 91, 92, 93, 94, 96, 97, 98, 99, 100, 101,
  120, 121, 123, 124, 125, 126, 127]);
const ignoredSystem = new Set([0xf1, 0xf2, 0xf3, 0xf6, 0xf8, 0xfa, 0xfb, 0xfc, 0xfe]);
const hex = bytes => bytes.map(n => n.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const patch = p => `банк ${p.bankMSB}:${p.bankLSB}, программа ${p.program + 1}${p.isGMGSDrum ? ' (ударные)' : ''}`;

// Analyze every event with the pinned engine's own routing and parameter
// handlers, without generating PCM or allocating audio voices. The playback synth is
// separate: inspection cannot change its controllers, voices or effects.
export async function diagnoseMidi(midi, bank, { effects = true, maxEntries = 200, onSample, signal, parts = [], partSettings = {}, textCollector, sampleDumpMappings } = {}) {
  const entries = new Map(), summary = { substituted: 0, unsupported: 0, partial: 0, bankDependent: 0, unverified: 0 };
  let context, omitted = 0, complete = true, scanned = 0;
  const record = (code, status, feature, message, fields = {}) => {
    const key = JSON.stringify([code, status, feature, context.track, context.port, context.channel, fields]);
    summary[status]++;
    const existing = entries.get(key);
    if (existing) { existing.count++; existing.last = { ...context }; return; }
    if (entries.size >= maxEntries) { omitted++; return; }
    entries.set(key, { code, status, feature, message, ...fields, count: 1, first: { ...context }, last: { ...context } });
  };
  const synth = new SpessaSynthProcessor(48000, { effectsEnabled: effects, eventsEnabled: false, maxBufferSize: 128 });
  synth.onMissingPreset = (requested, system) => bank.getPreset(requested, system);
  synth.soundBankManager.addSoundBank(bank, 'diagnostics');
  await synth.processorInitialized;
  installBankMappings(synth, bank);
  installGSEffects(synth);
  installXGVariation(synth);
  const foundParts = new Map();
  // Run the actual routing/gates even when only collecting metadata. Never
  // allocate audio voices or decode PCM in this independent inspection synth.
  synth.setSystemParameter('blackMIDIMode', false);
  synth.setSystemParameter('monophonicRetrigger', false);
  synth.synthCore.getVoicesForPreset = (preset, key, velocity) => {
    if (onSample) for (const voice of preset.getVoiceParameters(key, velocity)) onSample(voice.sample);
    return [];
  };
  const sequence = new SpessaSynthSequencer(synth);
  sequence.preload = sequence.skipToFirstNoteOn = false;
  sequence.loopCount = 0;
  sequence.loadNewSongList([midi]);
  installSampleDumpBank(synth,sampleDumpMappings,offset=>Number(Object.keys(sequence.midiPortChannelOffsets).find(port=>sequence.midiPortChannelOffsets[port]===offset)));
  installPartControls(synth, bank, parts, partSettings);
  const getVoices = synth.synthCore.getVoices.bind(synth.synthCore);
  synth.synthCore.getVoices = (channel, key, velocity) => {
    if (context) {
      const ch = synth.midiChannels[channel], offset = Math.floor(channel / 16) * 16;
      const port = Number(Object.keys(sequence.midiPortChannelOffsets).find(p => sequence.midiPortChannelOffsets[p] === offset));
      let row = foundParts.get(channel);
      if (!row) foundParts.set(channel, row = { id: port + ':' + (channel % 16 + 1), port, channel: channel % 16 + 1,
        synthChannel: channel, tracks: [], sourceInstruments: [] });
      if (!row.tracks.includes(context.track)) row.tracks.push(context.track);
      const preset = synth.synthCore.sampleDumpBank.presetForChannel(ch) ?? ch.preset;
      if (preset && !row.sourceInstruments.some(p => p.name === preset.name && p.program === preset.program && p.bankMSB === preset.bankMSB && p.bankLSB === preset.bankLSB && p.percussion === !!preset.isGMGSDrum))
        row.sourceInstruments.push({ name: preset.name, program: preset.program, bankMSB: preset.bankMSB, bankLSB: preset.bankLSB, percussion: !!preset.isGMGSDrum });
    }
    return getVoices(channel, key, velocity);
  };
  let seconds = 0, previousTick = 0;
  try {
    for (const { tr, ev } of midi.timeline) {
      signal?.throwIfAborted();
      const event = midi.tracks[tr].events[ev];
      seconds += (event.ticks - previousTick) * sequence.oneTickToSeconds;
      previousTick = event.ticks;
      context = { seconds, tick: event.ticks, track: tr + 1, port: sequence.currentMIDIPorts[tr] ?? 0,
        channel: event.statusByte >= 0x80 && event.statusByte < 0xf0 ? (event.statusByte & 15) + 1 : null };
      textCollector?.meta(event, context);
      const before = SpessaLog.onDiagnostic;
      let implemented = false, unsupported = false;
      synth.onEventCall = ({ type, data }) => {
        if (type === 'displayMessage' && textCollector?.display(data, context)) implemented = true;
      };
      SpessaLog.onDiagnostic = detail => {
        if (detail.kind === 'implemented') { implemented = true; return; }
        if (detail.kind === 'substituted') {
          record('preset-substitution', 'substituted', 'Bank Select / Program Change',
            `Запрошен ${patch(detail.requested)}; выбран «${detail.actual.name}» (${patch(detail.actual)}).`,
            { requested: detail.requested, actual: detail.actual, system: detail.system, ...(detail.mapping ? { mapping: detail.mapping } : {}) });
        } else {
          unsupported = true;
          const isEffect = /effect|EFX|Reverb|Chorus|Variation/i.test(detail.feature);
          record(isEffect ? 'unsupported-effect' : 'unsupported-message', 'unsupported', detail.feature,
            `Движок не выполняет команду: ${detail.feature}.${detail.reason ? ' ' + detail.reason : ''}`,
            { data: detail.data, reason: detail.reason });
        }
      };
      try {
        sequence.onEventCall = ({ type, data }) => {
          if (type !== 'midiEvent') return;
          const event = data.event, status = event.statusByte & 0xf0;
          context.channel = event.statusByte < 0xf0 ? (event.statusByte & 15) + 1 : null;
          if (event.statusByte >= 0x80 && event.statusByte < 0xf0) textCollector?.channel(context.track);
          if (status === 0xb0) {
            const [controller] = event.data;
            if (!handledCCs.has(controller)) record('bank-dependent-controller', 'bankDependent', `CC${controller}`,
              'Контроллер передаётся модуляторам SoundFont; слышимый результат зависит от выбранного инструмента.', { controller });
          }
          if (status === 0xa0) record('bank-dependent-pressure', 'bankDependent', 'Poly Pressure',
            'Полифонический aftertouch распознаётся; изменение звука зависит от модуляторов инструмента.');
          if (ignoredSystem.has(event.statusByte)) record('system-synchronization', 'unsupported', `MIDI ${hex([event.statusByte])}`,
            'Системная синхронизация или команда внешнего устройства не используется файловым плеером.', { statusByte: event.statusByte });
        };
        // Dispatch raw packets through the same byte-stream decoder as playback.
        // Diagnostics therefore include commands inside F7 escapes and completed
        // multipart SysEx, rather than interpreting an unfinished F0 packet.
        const systemExclusive = synth.systemExclusive;
        synth.systemExclusive = (...args) => {
          implemented = unsupported = false;
          systemExclusive(...args);
          const data = args[0];
          if (!implemented && !unsupported) record('unverified-sysex', 'unverified', 'SysEx',
            'SysEx прочитан полностью, но выполнение этой команды движком не подтверждено.',
            { data: Array.from(data.subarray(0, 64)), bytes: data.length });
        };
        try {
          sequence.processEvent(event, tr);
          if (scanned + 1 === midi.timeline.length) sequence.finishMIDIStreams();
        } finally { synth.systemExclusive = systemExclusive; }
      } catch (error) {
        complete = false;
        record('analysis-error', 'unverified', 'MIDI', `Проверка команды завершилась ошибкой: ${error.message}`);
      } finally { SpessaLog.onDiagnostic = before; }
      // Let the Worker receive newer load/seek requests on very large scores.
      if (++scanned % 4096 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { synth.stopAllChannels(true); }
  signal?.throwIfAborted();
  return { version: 1, engine: 'soundfont', scope: 'file', complete, eventsScanned: scanned,
    sampleDumpMappings:synth.synthCore.sampleDumpBank.mappings,
    sampleDumps: synth.synthCore.sampleDumps.describe().map(row=>({...row,channelOffset:row.port,port:Number(Object.keys(sequence.midiPortChannelOffsets).find(port=>sequence.midiPortChannelOffsets[port]===row.port))})),
    summary, entries: [...entries.values()], omitted, channelCount: synth.midiChannels.length, parts: [...foundParts.values()].sort((a, b) => a.port - b.port || a.channel - b.channel),
    note: 'Отчёт проверяет обработку команд и выбор пресетов. Он не гарантирует совпадение с аппаратным синтезатором; модуляторы и качество звука отдельно не оцениваются.' };
}
