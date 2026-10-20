// Map consumed PCM frames back to source-file time, across loop boundaries.
export class TransportTimeline {
  constructor(offset = 0, rate = 1) { this.rate = rate; this.received = this.consumed = this.head = 0; this.entries = [{ frame: 0, seconds: offset, iteration: 0 }]; }
  push(length, spans = []) {
    for (const span of spans) {
      const frame = this.received + span.offset, previous = this.entries.at(-1);
      if (span.iteration === previous.iteration && Math.abs(previous.seconds + (frame - previous.frame) * this.rate / 48000 - span.seconds) < 1e-9) continue;
      this.entries.push({ ...span, frame });
    }
    this.received += length;
  }
  advance(consumed) {
    const loops = [];
    while (this.head + 1 < this.entries.length && this.entries[this.head + 1].frame <= consumed) {
      const next = this.entries[++this.head];
      if (next.loopEnd !== undefined) loops.push({ start: next.seconds, end: next.loopEnd, iteration: next.iteration });
    }
    this.consumed = consumed;
    const entry = this.entries[this.head], result = { seconds: entry.seconds + (consumed - entry.frame) * this.rate / 48000, iteration: entry.iteration, loops };
    if (this.head > 64) { this.entries = this.entries.slice(this.head); this.head = 0; }
    return result;
  }
}
