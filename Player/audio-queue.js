// Bounded, allocation-free playback queue shared by the AudioWorklet and tests.
export class AudioQueue {
  constructor(capacity = 48000) {
    this.samples = new Float32Array(capacity);
    this.reset();
  }
  reset() { this.head = this.length = this.phase = this.underruns = this.dropped = 0; this.started = this.ended = false; }
  // Finite score audition must drain even a final block shorter than prebuffer.
  finish() { this.ended = true; }
  push(samples) {
    for (const sample of samples) {
      if (this.length === this.samples.length) {
        this.head = (this.head + 1) % this.samples.length;
        this.length--;
        this.dropped++;
      }
      this.samples[(this.head + this.length) % this.samples.length] = sample;
      this.length++;
    }
    // Cap latency at 150 ms after a suspended/slow consumer.
    if (this.length > 7200) {
      const discard = this.length - 4800;
      this.head = (this.head + discard) % this.samples.length;
      this.length -= discard;
      this.dropped += discard;
      this.phase = 0;
    }
  }
  pull(output, deviceRate = 48000) {
    if (!this.started && this.length < 1920 && !this.ended) { output.fill(0); return; }
    this.started = true;
    const step = 48000 / deviceRate;
    for (let i = 0; i < output.length; i++) {
      if (this.length < (this.ended ? 1 : 2)) {
        output.fill(0, i);
        if (!this.ended) this.underruns++;
        this.started = false;
        this.phase = 0;
        return;
      }
      const first = this.samples[this.head], second = this.length > 1 ? this.samples[(this.head + 1) % this.samples.length] : first;
      output[i] = first + (second - first) * this.phase;
      this.phase += step;
      const advance = Math.min(Math.floor(this.phase), this.length);
      this.head = (this.head + advance) % this.samples.length;
      this.length -= advance;
      this.phase -= advance;
    }
  }
}
