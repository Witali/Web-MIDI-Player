import { CENTIBEL_LOOKUP_TABLE, CONVEX_ATTACK } from './vendor/spessasynth.js';

// MIDI/SoundFont setters supply the original parameters; stateful audio DSP
// executes in C. Every cached view is refreshed when the host arena grows.
export function installCStateDSP(core, api, arena) {
  const volumeFields = ['outputGain', 'attenuationCb', 'state', 'sampleTime', 'releaseStartCb',
    'releaseStartTimeSamples', 'attackDuration', 'decayDuration', 'releaseDuration', 'sustainCb',
    'delayEnd', 'attackEnd', 'holdEnd', 'decayEnd', 'enteredRelease', 'canEndOnSilentSustain'];
  const modFields = ['attackDuration', 'decayDuration', 'releaseDuration', 'sustainLevel', 'delayEnd',
    'attackEnd', 'holdEnd', 'releaseStartLevel', 'currentValue', 'enteredRelease', 'decayEnd'];
  function state(fields, object) {
    const holder = { data: new Float64Array(fields.map(key => Number(object[key]) || 0)) };
    const pointer = arena.bind(holder, 'data');
    return { pointer, holder, copy: () => fields.forEach((key, i) => { holder.data[i] = Number(object[key]) || 0; }) };
  }
  const tables = { centibels: CENTIBEL_LOOKUP_TABLE.slice(), convex: CONVEX_ATTACK.slice() };
  const cb = arena.bind(tables, 'centibels'), convex = arena.bind(tables, 'convex');
  function envelope(env, fields, volume) {
    const data = state(fields, env), init = env.init, release = env.startRelease;
    if (volume) {
      env._cState = data.pointer; env._cTable = cb;
      env._cSync = () => { const view = data.holder.data;
        env.outputGain = view[0]; env.attenuationCb = view[1]; env.state = view[2]; env.sampleTime = view[3]; };
    }
    env._cCommit = data.copy; // Resume a host-frozen envelope with its retained clocks/gain.
    env.init = function(voice) { init.call(this, voice); data.copy(); };
    env.startRelease = function(voice) { release.call(this, voice); data.copy(); };
    if (volume) env.process = function(count, target) {
      const active = api.dsp_volume_envelope(data.pointer, count, target, cb), view = data.holder.data;
      this.outputGain = view[0]; this.attenuationCb = view[1]; this.state = view[2]; this.sampleTime = view[3];
      return !!active;
    };
    else env.process = function(voice, time) {
      const value = api.dsp_modulation_envelope(data.pointer, time, voice.releaseStartTime, convex);
      this.currentValue = data.holder.data[8]; return value;
    };
  }
  function voice(v) { envelope(v.volEnv, volumeFields, true); envelope(v.modEnv, modFields, false); }
  core.voices.forEach(voice);
  const allocate = core.allocateNewVoices.bind(core);
  core.allocateNewVoices = count => { const start = core.voices.length; allocate(count); core.voices.slice(start).forEach(voice); };

  const chorus = core.chorusProcessor;
  const chorusFields = ['sampleRate', 'phase', 'write', 'gain', 'reverbGain', 'delayGain', 'depthSamples',
    'delaySamples', 'rateInc', 'feedbackGain', '_preLowpass', 'preLPFz', 'preLPFa'];
  const chorusState = state(chorusFields, chorus);
  const chorusL = arena.bind(chorus, 'leftDelayBuffer'), chorusR = arena.bind(chorus, 'rightDelayBuffer');
  chorus.process = (_input, _left, _right, _reverb, _delay, _start, count) => {
    chorusState.copy(); api.dsp_chorus(chorusState.pointer, chorusL, chorusR, count);
    const view = chorusState.holder.data; chorus.phase = view[1]; chorus.write = view[2]; chorus.preLPFz = view[11];
  };

  const reverb = core.reverbProcessor, d = reverb.dattorro;
  const reverbFields = ['preDelay', 'preLPF', 'inputDiffusion1', 'inputDiffusion2', 'decay', 'decayDiffusion1',
    'decayDiffusion2', 'damping', 'excursionRate', 'excursionDepth', 'gain', 'sampleRate',
    'lp1', 'lp2', 'lp3', 'excPhase', 'pDWrite', 'pDLength'];
  const reverbState = state(reverbFields, d), descriptors = { data: new Uint32Array(48) };
  const desc = arena.bind(descriptors, 'data');
  const pointers = d.delays.map(line => arena.bind(line, 0));
  const taps = arena.bind(d, 'taps'), predelay = arena.bind(d, 'pDelay');
  d.process = (_input, _left, _right, _start, count) => {
    reverbState.copy();
    d.delays.forEach((line, i) => { const at = i * 4; descriptors.data[at] = pointers[i];
      descriptors.data[at + 1] = line[1]; descriptors.data[at + 2] = line[2]; descriptors.data[at + 3] = line[3]; });
    api.dsp_dattorro(reverbState.pointer, desc, taps, predelay, count);
    const view = reverbState.holder.data; d.lp1 = view[12]; d.lp2 = view[13]; d.lp3 = view[14]; d.excPhase = view[15]; d.pDWrite = view[16];
    d.delays.forEach((line, i) => { line[1] = descriptors.data[i * 4 + 1]; line[2] = descriptors.data[i * 4 + 2]; });
  };

  const delayFields = ['feedback', 'gain', 'bufferLength', 'writeIndex', '_time'];
  for (const effect of [reverb, core.delayProcessor]) {
    for (const key of ['delayLeftOutput', 'delayRightOutput', 'delayLeftInput', 'delayPreLPF', 'delayCenterOutput']) {
      if (ArrayBuffer.isView(effect[key])) arena.bind(effect, key);
    }
    for (const key of ['delayLeft', 'delayRight', 'delayCenter']) {
      const line = effect[key]; if (!line) continue;
      const parameters = state(delayFields, line), buffer = arena.bind(line, 'buffer');
      line.process = (input, output, count) => {
        parameters.copy(); const src = arena.pointer(input), dst = arena.pointer(output);
        api.dsp_delay_line(parameters.pointer, buffer, src.offset, dst.offset, count);
        dst.copyBack?.(); line.writeIndex = parameters.holder.data[3];
      };
    }
  }
}
