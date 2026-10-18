import test from 'node:test';
import assert from 'node:assert/strict';
import { installVoiceDSP } from '../voice-dsp.js';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('WASM and SIMD preserve filter state, Float32 mix rounding, sends and partial blocks', async () => {
  for (const backend of ['wasm', 'wasm-simd']) for (const count of [1, 3, 127, 128])
    for (const enabled of [false, true]) for (const insertion of [false, true]) {
      const synth = { synthCore: {}, process() {} };
      await installVoiceDSP(synth, backend);
      const core = synth.synthCore, dsp = core.voiceDSP;
      const filter = { a0: .42, a1: .2, a2: .1, a3: -.3, a4: .05, x1: .1, x2: -.2, y1: .03, y2: .04 };
      const expectedFilter = { ...filter };
      const arrays = [dsp.left, dsp.right, core.reverbInput, core.chorusInput, core.delayInput, core.insertionInputL, core.insertionInputR];
      arrays.forEach(samples => samples.fill(.01));
      core.voiceBuffer.set(Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * .17) * .7));
      const expected = arrays.map(samples => samples.slice());
      let gain = .13;
      for (let i = 0; i < count; i++) {
        const input = core.voiceBuffer[i], f = expectedFilter;
        let sample = input;
        if (enabled) {
          sample = f.a0 * input + f.a1 * f.x1 + f.a2 * f.x2 - f.a3 * f.y1 - f.y2 * f.a4;
          f.x2 = f.x1; f.x1 = input; f.y2 = f.y1; f.y1 = sample;
        }
        sample = Math.fround(sample * gain); gain += .003;
        const gains = insertion ? [0, 0, 0, 0, 0, .71, .27] : [.71, .27, .12, .08, .03, 0, 0];
        for (let j = 0; j < gains.length; j++) expected[j][i] += gains[j] * sample;
      }
      dsp.render(filter, enabled, .13, .003, count, .71, .27, .12, .08, .03, insertion, null, 1);
      for (let j = 0; j < arrays.length; j++) assert.deepEqual(arrays[j].slice(0, count), expected[j].slice(0, count),
        `${backend}, count=${count}, filter=${enabled}, insertion=${insertion}, output=${j}`);
      assert.deepEqual(filter, expectedFilter);
    }
});

test('native C golden output matches scalar and SIMD WASM through the JavaScript ABI', async () => {
  const expected = JSON.parse(await fs.readFile(new URL('./native-dsp-golden.json', import.meta.url), 'utf8'));
  for (const file of ['voice-mixer.wasm', 'voice-mixer-simd.wasm']) {
    const { instance } = await WebAssembly.instantiate(await fs.readFile(new URL('../dsp/' + file, import.meta.url)));
    const e = instance.exports, base = e.dsp_get_layout(), pointer = Number(e.__heap_base.value);
    assert.equal(e.dsp_abi_version(), 1);
    new Float32Array(e.memory.buffer, pointer, 12).set([0, .2, -.6, .9, .7, -.2, -.4, .3, .8, -.5, .1, 0]);
    const state = new Float64Array(e.memory.buffer, base + 4096, 9);
    state.set([.42, .2, .1, -.3, .05, .1, -.2, .03, .04]);
    assert.equal(e.dsp_process_voice(8, 1, .13, .003, .71, .27, .12, .08, .03, 0, pointer, 1, 12, 8, 12, 10.25, .7), 1);
    assert.deepEqual([...new Float32Array(e.memory.buffer, base + 512, 8)], expected.audio);
    assert.deepEqual([...state], expected.filter);
    assert.equal(new Float64Array(e.memory.buffer, base + 4200, 1)[0], expected.cursor);
  }
});

test('Hermite oscillator preserves exact samples and cursor across pitch ratios, loop boundaries and EOF', async () => {
  function reference(data, count, wave, step) {
    const audio = new Float32Array(count); let cursor = wave.cursor;
    for (let i = 0; i < count; i++) {
      if (wave.isLooping) while (cursor >= wave.loopEnd) cursor -= wave.loopLength;
      const y0 = Math.trunc(cursor), t = cursor - y0;
      const indexes = [y0, y0 + 1, y0 + 2, y0 + 3];
      if (wave.isLooping) for (let j = 1; j < 4; j++) while (indexes[j] >= wave.loopEnd) indexes[j] -= wave.loopLength;
      else if (y0 + 3 >= wave.end) return { audio, cursor: wave.cursor, active: false };
      const [xm1, x0, x1, x2] = indexes.map(index => data[index]);
      const c = (x1 - xm1) * .5, v = x0 - x1, w = c + v;
      const a = w + v + (x2 - x0) * .5, b = w + a;
      audio[i] = ((a * t - b) * t + c) * t + x0; cursor += step;
    }
    return { audio, cursor, active: true };
  }
  const sampleData = Float32Array.from({ length: 257 }, (_, i) => Math.sin(i * .17) * .6);
  for (const backend of ['wasm', 'wasm-simd']) for (const count of [1, 3, 127, 128])
    for (const step of [0, .03125, .1, .5, .9999999999999999, 1, 1.0000000000000002, 2.7, 11.125])
      for (const isLooping of [false, true]) for (const cursor of [0, .25, 8, 16.75, 254]) {
        const synth = { synthCore: {}, process() {} }; await installVoiceDSP(synth, backend);
        const wave = { sampleData, isLooping, loopEnd: 17, loopLength: 3, end: 257, cursor, playbackStep: step };
        const expected = reference(sampleData, count, wave, step);
        const active = synth.synthCore.voiceDSP.render({}, false, 1, 0, count, 1, 0, 0, 0, 0, false, wave, 1);
        assert.equal(active, expected.active);
        assert.deepEqual(synth.synthCore.voiceBuffer.slice(0, count), expected.audio);
        assert.equal(wave.cursor, expected.cursor);
      }
});

test('prebuilt WASM is tied to the C sources and does not import a JavaScript DSP implementation', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../dsp/build.json', import.meta.url), 'utf8'));
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    let data = await fs.readFile(new URL('../' + file, import.meta.url));
    if (/\.[ch]$/.test(file)) data = data.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(data).digest('hex'), expected, `Stale source or WASM artifact: ${file}`);
    if (file.endsWith('.wasm')) {
      const module = await WebAssembly.compile(data);
      assert.deepEqual(WebAssembly.Module.imports(module), []);
      const names = WebAssembly.Module.exports(module).map(item => item.name);
      for (const name of ['dsp_process_voice', 'dsp_volume_envelope', 'dsp_modulation_envelope', 'dsp_chorus', 'dsp_delay_line', 'dsp_dattorro']) {
        assert.ok(names.includes(name), `Missing C DSP export: ${name}`);
      }
    }
  }
});

test('waveform cache matches uncached C for independent voice states, key changes, EOF and memory growth', async () => {
  for (const file of ['voice-mixer.wasm', 'voice-mixer-simd.wasm']) {
    const module = await WebAssembly.compile(await fs.readFile(new URL('../dsp/' + file, import.meta.url)));
    const baseline = (await WebAssembly.instantiate(module)).exports;
    const cached = (await WebAssembly.instantiate(module)).exports;
    const source = Float32Array.from({ length: 257 }, (_, i) => Math.sin(i * .17) * .6);
    for (const e of [baseline, cached]) new Float32Array(e.memory.buffer, Number(e.__heap_base.value), source.length).set(source);
    cached.dsp_begin_block();
    const voice = [128, 1, 17, 7, 257, 0, .5];
    const cases = [voice, voice, voice, [127, 1, 17, 7, 257, 0, .5], [128, 1, 17, 7, 257, .25, .5],
      [128, 1, 17, 7, 257, 0, .51], [128, 1, 17, 8, 257, 0, .5], [128, 1, 18, 7, 257, 0, .5],
      [3, 0, 0, 0, 257, 254, 1], [3, 0, 0, 0, 257, 254, 1], [128, 1, 17, 7, 250, 0, .5], voice];
    for (let i = 0; i < cases.length; i++) {
      const [count, loop, loopEnd, loopLength, end, cursor, step] = cases[i];
      if (i === 2) cached.memory.grow(1);
      const results = [baseline, cached].map(e => {
        const base = e.dsp_get_layout(), filter = new Float64Array(e.memory.buffer, base + 4096, 9);
        filter.set([.42 + i * .001, .2, .1, -.3, .05, .1, -.2, .03, .04]);
        const active = e.dsp_process_voice(count, i % 2, .13 + i * .01, .003, .71, .27, .12, .08, .03, i % 3 === 0 ? 1 : 0,
          Number(e.__heap_base.value), loop, loopEnd, loopLength, end, cursor, step);
        return { active, audio: new Uint32Array(e.memory.buffer, base, 1024).slice(), filter: filter.slice(),
          cursor: new Float64Array(e.memory.buffer, base + 4200, 1)[0] };
      });
      assert.deepEqual(results[1], results[0], `${file}, voice ${i}`);
    }
    const stats = new Uint32Array(cached.memory.buffer, cached.dsp_get_cache_stats(), 3);
    assert.ok(stats[0] >= 3); assert.ok(stats[1] >= 6); assert.equal(stats[2], 1);
    cached.dsp_begin_block(); assert.deepEqual([...stats], [0, 0, 0]);
  }
});
