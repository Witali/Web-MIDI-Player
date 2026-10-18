import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { panned } from './fixtures.mjs';

test('portable Worker loads, streams stereo, seeks, rejects stale reads and reports invalid input', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel();
  let sequence = 0;
  const call = async (type, values) => {
    const id = ++sequence, reply = once(worker, 'message'); worker.postMessage({ type, id, ...values });
    const data = (await reply)[0]; assert.equal(data.id, id); return data;
  };
  const read = async epoch => {
    const reply = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch }); return (await reply)[0];
  };
  try {
    const loaded = await call('load', { bytes: panned(0, true), epoch: 1, engine: 'z80' });
    assert.equal(loaded.result.channels, 2); assert.equal(loaded.result.sampleRate, 48000);
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    const first = await read(1); assert.equal(first.channels.length, 2); assert.equal(first.channels[0].length, 2048);
    const seek = await call('seek', { seconds: .75, epoch: 2 }); assert.equal(seek.result.seconds, .75);
    channel.port1.postMessage({ type: 'read', epoch: 1 });
    const after = await read(2); assert.equal(after.epoch, 2); assert.ok(after.channels[1].some(n => Math.abs(n) > .001));
    const invalid = await call('load', { bytes: new Uint8Array([0, 1, 2]), epoch: 3, engine: 'z80' }); assert.equal(typeof invalid.error, 'string');
  } finally { channel.port1.close(); await worker.terminate(); }
});

test('stereo AudioWorklet preserves channels, resamples, ignores stale blocks and replays after EOF', async () => {
  let Processor;
  globalThis.sampleRate = 44100;
  globalThis.AudioWorkletProcessor = class { constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; } };
  globalThis.registerProcessor = (_name, constructor) => { Processor = constructor; };
  try {
    await import('../worklet.js');
    const processor = new Processor(), requests = [], stream = { postMessage: data => requests.push(data), start() {} };
    processor.port.onmessage({ data: { type: 'connect', port: stream } });
    processor.port.onmessage({ data: { type: 'reset', epoch: 1, running: true } });
    const left = new Float32Array(128), right = new Float32Array(128);
    processor.process([], [[left, right]]); assert.equal(requests.length, 1);
    stream.onmessage({ data: { epoch: 0, channels: [new Float32Array(193), new Float32Array(193)], done: true } });
    assert.equal(processor.queues[0].length, 0);
    stream.onmessage({ data: { epoch: 1, channels: [new Float32Array(193).fill(.25), new Float32Array(193).fill(-.5)], done: true } });
    processor.process([], [[left, right]]); assert.ok(left.every(n => n === .25)); assert.ok(right.every(n => n === -.5));
    processor.process([], [[left, right]]); assert.equal(processor.messages.filter(m => m.type === 'ended').length, 1);
    processor.port.onmessage({ data: { type: 'reset', epoch: 2, offset: 5, running: true } });
    stream.onmessage({ data: { epoch: 2, channels: [new Float32Array(30).fill(.1), new Float32Array(30).fill(.2)], done: true } });
    processor.process([], [[left, right]]);
    assert.equal(processor.messages.at(-1).epoch, 2); assert.ok(processor.messages.at(-1).seconds > 5);
  } finally { delete globalThis.sampleRate; delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor; }
});
