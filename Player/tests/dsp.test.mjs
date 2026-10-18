import test from 'node:test';
import assert from 'node:assert/strict';
import { installVoiceDSP } from '../voice-dsp.js';
import fs from 'node:fs/promises';

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
