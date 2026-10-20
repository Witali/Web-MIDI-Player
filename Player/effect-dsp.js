// Deterministic host DSP models. MIDI parameter units come from the device
// manuals; their proprietary analogue/cabinet transfer functions are not public.
export class Biquad {
  constructor() { this.coefficients = [1, 0, 0, 0, 0]; this.clear(); }
  clear() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  shelf(sampleRate, frequency, decibels, high = false) {
    if (!decibels) { this.coefficients = [1, 0, 0, 0, 0]; return; }
    // RBJ Audio EQ Cookbook, shelf slope S=1.
    const A = 10 ** (decibels / 40), w = 2 * Math.PI * Math.min(frequency, sampleRate * .45) / sampleRate;
    const c = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, t = 2 * Math.sqrt(A) * alpha;
    const s = high ? 1 : -1;
    const a0 = A + 1 - s * (A - 1) * c + t;
    this.coefficients = [A * (A + 1 + s * (A - 1) * c + t) / a0,
      -s * 2 * A * (A - 1 + s * (A + 1) * c) / a0,
      A * (A + 1 + s * (A - 1) * c - t) / a0,
      s * 2 * (A - 1 - s * (A + 1) * c) / a0,
      (A + 1 - s * (A - 1) * c - t) / a0];
  }
  process(x) {
    const [b0, b1, b2, a1, a2] = this.coefficients;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
