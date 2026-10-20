import { TransportTimeline } from './transport-timeline.js';
import { AudioQueue } from './audio-queue.js';

class MidiOutput extends AudioWorkletProcessor {
  constructor() {
    super(); this.queues = [new AudioQueue(), new AudioQueue()]; this.epoch = -1; this.running = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'connect') {
        this.stream = data.port;
        this.stream.onmessage = ({ data }) => {
          if (data.epoch !== this.epoch) return;
          if (Number.isFinite(data.duration) && data.duration !== this.duration) {
            this.duration = data.duration;
            this.port.postMessage({ type: 'duration', epoch: this.epoch, duration: data.duration });
          }
          this.timeline.push(data.channels[0].length, data.spans);
          this.pending = false; this.queues.forEach((queue, i) => queue.push(data.channels[i]));
          if (data.done) { this.done = true; this.queues.forEach(queue => queue.finish()); }
          this.request();
        };
        this.stream.start();
      } else if (data.type === 'reset') {
        this.queues.forEach(queue => queue.reset()); this.epoch = data.epoch; this.offset = data.offset || 0;
        this.frames = this.reportedFrames = 0; this.pending = this.done = this.ended = false; this.duration = undefined;
        this.timeline = new TransportTimeline(this.offset, data.rate || 1);
        this.running = data.running; this.request();
      }
    };
  }
  request() {
    if (this.running && this.stream && !this.pending && !this.done && this.queues[0].length < 4096) {
      this.pending = true; this.stream.postMessage({ type: 'read', epoch: this.epoch });
    }
  }
  process(_inputs, outputs) {
    const channels = outputs[0]; if (!channels?.length) return true;
    if (!this.running) { channels.forEach(channel => channel.fill(0)); return true; }
    const before = this.queues[0].length;
    channels.forEach((channel, i) => this.queues[i]?.pull(channel, sampleRate));
    this.frames += before - this.queues[0].length; this.request();
    const position = this.timeline.advance(this.frames);
    for (const loop of position.loops) this.port.postMessage({ type: 'loop', epoch: this.epoch, ...loop });
    const done = this.done && !this.queues[0].length;
    if (position.loops.length || (done && !this.ended) || this.frames - this.reportedFrames >= 4800) {
      this.reportedFrames = this.frames;
      this.port.postMessage({ type: done ? 'ended' : 'position', epoch: this.epoch,
        seconds: position.seconds, iteration: position.iteration, underruns: Math.max(...this.queues.map(queue => queue.underruns)) });
      if (done) { this.ended = true; this.running = false; }
    }
    return true;
  }
}
registerProcessor('z80-midi-output', MidiOutput);
