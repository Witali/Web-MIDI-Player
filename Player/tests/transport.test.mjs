import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { panned, smptePanned, midi, vlq } from './fixtures.mjs';

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
    stream.onmessage({ data: { epoch: 0, duration: 999, channels: [new Float32Array(193), new Float32Array(193)], done: true } });
    assert.equal(processor.queues[0].length, 0);
    assert.equal(processor.messages.filter(m => m.type === 'duration').length, 0);
    stream.onmessage({ data: { epoch: 1, duration: 4.5, channels: [new Float32Array(193).fill(.25), new Float32Array(193).fill(-.5)], done: true } });
    assert.deepEqual(processor.messages.find(m => m.type === 'duration'), { type: 'duration', epoch: 1, duration: 4.5 });
    processor.process([], [[left, right]]); assert.ok(left.every(n => n === .25)); assert.ok(right.every(n => n === -.5));
    processor.process([], [[left, right]]); assert.equal(processor.messages.filter(m => m.type === 'ended').length, 1);
    processor.port.onmessage({ data: { type: 'reset', epoch: 2, offset: 5, running: true } });
    stream.onmessage({ data: { epoch: 2, channels: [new Float32Array(30).fill(.1), new Float32Array(30).fill(.2)], done: true } });
    processor.process([], [[left, right]]);
    assert.equal(processor.messages.at(-1).epoch, 2); assert.ok(processor.messages.at(-1).seconds > 5);
  } finally { delete globalThis.sampleRate; delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor; }
});

test('the public Worker SoundFont path loads SMPTE timing and seeks to the held note', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel();
  let id = 0;
  const call = async (type, values) => {
    const reply = once(worker, 'message'); worker.postMessage({ type, id: ++id, ...values });
    const response = (await reply)[0]; assert.equal(response.id, id); assert.equal(response.error, undefined); return response.result;
  };
  try {
    const loaded = await call('load', { bytes: smptePanned(25), epoch: 1, effects: false });
    assert.ok(Math.abs(loaded.sourceDuration - 1.25) < 1e-9);
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    const continuous = [[], []];
    for (let block = 0; block < 24; block++) {
      const pending = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch: 1 });
      const audio = (await pending)[0]; audio.channels.forEach((samples, c) => continuous[c].push(...samples));
    }
    await call('seek', { seconds: .95, epoch: 2 });
    const reply = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch: 2 });
    const audio = (await reply)[0];
    assert.equal(audio.epoch, 2); assert.ok(audio.channels[1].some(n => Math.abs(n) > .001));
    const energy = samples => samples.reduce((sum, n) => sum + n * n, 0);
    audio.channels.forEach((samples, c) => assert.deepEqual(samples, Float32Array.from(continuous[c].slice(45600, 47648)), 'Worker seek must reproduce continuous PCM'));
    assert.ok(energy(audio.channels[1]) > energy(audio.channels[0]));
  } finally { channel.port1.close(); await worker.terminate(); }
});


test('Worker returns the full compatibility report on load and clears it for the next song', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url));
  let id = 0;
  const call = async (type, values) => {
    const reply = once(worker, 'message'); worker.postMessage({ type, id: ++id, ...values });
    const response = (await reply)[0]; assert.equal(response.error, undefined); return response.result;
  };
  try {
    const source = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(960), 0xb0, 22, 127],
      [0, 0x80, 60, 0], [0, 255, 47, 0]]);
    const loaded = await call('load', { bytes: source, epoch: 1, effects: false });
    assert.equal(loaded.position, 0);
    assert.equal(loaded.diagnostics.entries[0].first.seconds, 1);
    assert.equal(loaded.diagnostics.summary.bankDependent, 1);
    await call('seek', { seconds: .5, epoch: 2 });
    const next = await call('load', { bytes: panned(), epoch: 3, effects: false });
    assert.deepEqual(next.diagnostics.entries, []);
  } finally { await worker.terminate(); }
});


test('a superseded long Worker seek cancels and cannot leak old-epoch PCM during reconstruction', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel();
  const pending = new Map(), audio = [];
  let id = 0;
  worker.on('message', data => { const request = pending.get(data.id); if (request) { pending.delete(data.id); request(data); } });
  channel.port1.on('message', data => audio.push(data));
  const call = (type, values) => new Promise((resolve, reject) => {
    const next = ++id;
    const timeout = setTimeout(() => reject(new Error('Worker command timed out')), 8000);
    pending.set(next, data => { clearTimeout(timeout); data.error ? reject(new Error(data.error)) : resolve(data.result); });
    worker.postMessage({ type, id: next, ...values });
  });
  try {
    const source = midi([[0, 0xc0, 81], ...Array.from({length:64}, (_,i) => [0, 0x90, 48+i, 80]),
      [...vlq(700*960), 0x80, 60, 64], [0, 0xb0, 123, 0], [0, 255, 47, 0]]);
    await call('load', { bytes: source, epoch: 1, effects: false });
    worker.postMessage({type:'connect',port:channel.port2},[channel.port2]);
    const first = call('seek', {seconds:600,epoch:2});
    await new Promise(resolve => setTimeout(resolve,20));
    channel.port1.postMessage({type:'read',epoch:1});
    const next = call('seek', {seconds:.25,epoch:3});
    assert.equal((await first).cancelled,true);
    assert.equal((await next).seconds,.25);
    const reply=once(channel.port1,'message'); channel.port1.postMessage({type:'read',epoch:3});
    const pcm=(await reply)[0];
    assert.equal(pcm.epoch,3);
    assert.ok(pcm.channels.some(samples=>samples.some(n=>Math.abs(n)>.001)));
    assert.ok(audio.every(block=>block.epoch===3),'Reconstruction must never answer an old stream read');
  } finally { channel.port1.close(); await worker.terminate(); }
});
