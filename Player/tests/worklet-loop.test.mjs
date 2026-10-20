import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiTextTimeline } from '../midi-text.js';

test('worklet maps consumed resampled PCM to loop source time, rejects stale spans and freezes during underruns', async () => {
  let Processor;
  const original = [globalThis.sampleRate, globalThis.AudioWorkletProcessor, globalThis.registerProcessor];
  globalThis.sampleRate = 44100;
  globalThis.AudioWorkletProcessor = class { constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; } };
  globalThis.registerProcessor = (_name, constructor) => { Processor = constructor; };
  try {
    await import('../worklet.js');
    const processor = new Processor(), requests = [], period = 4096, start = .1, rate = 1.5, end = start + period * rate / 48000;
    let sent = 0, responding = true;
    const stream = { start() {}, postMessage(data) {
      requests.push(data); if (!responding) return;
      const offset = sent, count = 2048, iteration = Math.floor(offset / period);
      const spans = [{ offset: 0, seconds: start + (offset % period) * rate / 48000, iteration }];
      for (let boundary = (iteration + 1) * period; boundary <= offset + count; boundary += period)
        spans.push({ offset: boundary - offset, seconds: start, iteration: boundary / period, loopEnd: end });
      const left = Float32Array.from({ length: count }, (_, i) => ((offset + i) % period) / period), right = left.map(n => -n);
      sent += count; stream.onmessage({ data: { epoch: data.epoch, channels: [left, right], spans, done: false } });
    } };
    processor.port.onmessage({ data: { type: 'connect', port: stream } });
    processor.port.onmessage({ data: { type: 'reset', epoch: 1, offset: start, rate, running: true } });
    const output = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 300; i++) {
      processor.process([], [output]);
      assert.ok(output[0].every((v, n) => Math.abs(v + output[1][n]) < 1e-7));
    }
    const consumed = Math.floor(300 * 128 * 48000 / 44100);
    assert.equal(processor.frames, consumed);
    const mapped = processor.timeline.advance(consumed), iterations = Math.floor(consumed / period);
    assert.ok(Math.abs(mapped.seconds - (start + consumed % period * rate / 48000)) < 1e-12);
    assert.equal(mapped.iteration, iterations);
    const loops = processor.messages.filter(m => m.type === 'loop');
    assert.equal(loops.length, iterations); assert.deepEqual(loops.map(m => m.iteration), Array.from({ length: iterations }, (_, i) => i + 1));
    assert.ok(loops.every(m => m.start === start && m.end === end));
    assert.equal(processor.messages.some(m => m.type === 'ended'), false);
    assert.ok(processor.queues.every(q => !q.underruns && !q.dropped));
    const queued = processor.queues[0].length, entries = processor.timeline.received;
    stream.onmessage({ data: { epoch: 0, channels: [new Float32Array(128), new Float32Array(128)], spans: [{ offset: 0, seconds: 999, iteration: 999, loopEnd: 999 }], done: true } });
    assert.equal(processor.queues[0].length, queued); assert.equal(processor.timeline.received, entries);
    processor.running = false; processor.process([], [output]); assert.equal(processor.frames, consumed); assert.ok(output.every(c => c.every(n => n === 0)));
    processor.running = true; responding = false;
    for (let i = 0; i < 100; i++) processor.process([], [output]);
    const stalled = processor.frames, source = processor.timeline.advance(stalled).seconds;
    for (let i = 0; i < 10; i++) processor.process([], [output]);
    assert.equal(processor.frames, stalled); assert.equal(processor.timeline.advance(stalled).seconds, source);
    assert.ok(processor.queues.every(q => q.underruns > 0)); assert.ok(output.every(c => c.every(n => n === 0)));
    processor.port.onmessage({ data: { type: 'reset', epoch: 2, offset: .7, rate: .5, running: true } });
    stream.onmessage({ data: { epoch: 2, channels: [new Float32Array(193).fill(.25), new Float32Array(193).fill(-.5)], done: true } });
    for (let i = 0; i < 5; i++) processor.process([], [output]);
    const ended = processor.messages.filter(m => m.type === 'ended'); assert.equal(ended.length, 1);
    assert.equal(ended[0].epoch, 2); assert.equal(ended[0].iteration, 0); assert.equal(ended[0].seconds, .7 + 193 * .5 / 48000);
    assert.ok(requests.length > 10);
  } finally {
    [globalThis.sampleRate, globalThis.AudioWorkletProcessor, globalThis.registerProcessor] = original;
  }
});


test('fractional text positions round to the output frame under every host rate', () => {
  const marker = { id: 0, kind: 'marker', text: 'Fractional', seconds: 50.6 / 48000 }, timeline = new MidiTextTimeline({ events: [marker] });
  for (const rate of [.25, .5, 1, 2, 4]) {
    const frame = Math.round(marker.seconds / rate * 48000);
    assert.equal(timeline.at((frame - 1) * rate / 48000, { rate }).state.marker, null);
    assert.equal(timeline.at(frame * rate / 48000, { rate }).state.marker.text, 'Fractional');
    assert.equal(timeline.at((frame - 1) * rate / 48000, { rate }).state.marker, null);
  }
});
