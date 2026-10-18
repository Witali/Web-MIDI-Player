/* Stateful effects loops adapted from SpessaSynth 4.3.22 (Apache-2.0).
 * Dattorro algorithm by khoin, public domain, as adapted by spessasus. */
#include "dsp.h"
#include <math.h>
static double clamp(double x, double low, double high) { return x < low ? low : x > high ? high : x; }
/* sampleRate, phase, write, gain, reverbGain, delayGain, depthSamples,
 * delaySamples, rateInc, feedbackGain, preLowpass, preLPFz, preLPFa. */
void dsp_chorus(double *s, float *l, float *r, uint32_t n) {
    if (!s || !l || !r || !n || n > DSP_QUANTUM || s[0] < 1) return;
    DspScratch *core = dsp_get_layout();
    const int length = (int)s[0]; int write = (int)s[2];
    double phase = s[1], z = s[11]; uint32_t i;
    for (i = 0; i < n; i++) {
        double input = core->audio[4][i], read, frac, out_l, out_r, mono;
        const double lfo = 2 * fabs(phase - .5); int x0, x1;
        if (s[10] > 0) { z += s[12] * (input - z); input = z; }
        read = write - clamp(s[7] + lfo * s[6], 1, length); if (read < 0) read += length;
        x0 = (int)read; x1 = x0 + 1; if (x1 >= length) x1 -= length; frac = read - x0;
        out_l = l[x0] * (1 - frac) + l[x1] * frac;
        l[write] = (float)(input + out_l * s[9]);
        read = write - clamp(s[7] + (1 - lfo) * s[6], 1, length); if (read < 0) read += length;
        x0 = (int)read; x1 = x0 + 1; if (x1 >= length) x1 -= length; frac = read - x0;
        out_r = r[x0] * (1 - frac) + r[x1] * frac;
        core->audio[1][i] = (float)(core->audio[1][i] + out_l * s[3]);
        core->audio[2][i] = (float)(core->audio[2][i] + out_r * s[3]);
        mono = (out_l + out_r) / 2;
        core->audio[3][i] = (float)(core->audio[3][i] + mono * s[4]);
        core->audio[5][i] = (float)(core->audio[5][i] + mono * s[5]);
        r[write] = (float)(input + out_r * s[9]);
        if (++write >= length) write = 0;
        if ((phase += s[8]) >= 1) phase -= 1;
    }
    s[1] = phase; s[2] = write; s[11] = z;
}
/* feedback, gain, bufferLength, writeIndex, time */
void dsp_delay_line(double *s, float *buffer, const float *input, float *out, uint32_t n) {
    if (!s || !buffer || !input || !out || !n || n > DSP_QUANTUM || s[2] < 1 || s[4] < 0 || s[4] > s[2]) return;
    int write = (int)s[3], length = (int)s[2], delay = (int)s[4]; uint32_t i;
    for (i = 0; i < n; i++) {
        int read = write - delay; double value;
        if (read < 0) read += length;
        value = buffer[read]; out[i] = (float)(value * s[1]);
        buffer[write] = (float)(input[i] + value * s[0]);
        if (++write >= length) write = 0;
    }
    s[3] = write;
}
/* Each descriptor consists of pointer, write index, read index, mask. */
static double rd(uintptr_t *d, int line, int offset) {
    uintptr_t *p = d + line * 4; const float *buffer = (const float *)p[0];
    return buffer[(p[2] + (uintptr_t)offset) & p[3]];
}
static double wr(uintptr_t *d, int line, double value) {
    uintptr_t *p = d + line * 4; float *buffer = (float *)p[0];
    buffer[p[1]] = (float)value; return value; /* JS assignment returns unrounded RHS. */
}
static double cubic(uintptr_t *d, int line, double position) {
    const int integer = (int)position; const double f = position - integer;
    const double x0 = rd(d, line, integer - 1), x1 = rd(d, line, integer);
    const double x2 = rd(d, line, integer + 1), x3 = rd(d, line, integer + 2);
    const double a = (3 * (x1 - x2) - x0 + x3) / 2;
    const double b = 2 * x2 + x0 - (5 * x1 + x3) / 2, c = (x2 - x0) / 2;
    return ((a * f + b) * f + c) * f + x1;
}
/* preDelay, preLPF, inputDiffusion1/2, decay, decayDiffusion1/2, damping,
 * excursionRate/Depth, gain, sampleRate, lp1/2/3, excPhase, pDWrite, pDLength */
void dsp_dattorro(double *s, uintptr_t *d, const int16_t *t, float *predelay, uint32_t n) {
    if (!s || !d || !t || !predelay || !n || n > DSP_QUANTUM || s[17] < 1 || s[11] <= 0 || s[0] < 0 || s[0] > s[17]) return;
    DspScratch *core = dsp_get_layout();
    const int pd = (int)s[0], length = (int)s[17], start = (int)s[16];
    const double fi = s[2], si = s[3], dc = s[4], ft = s[5], st = s[6], dp = 1 - s[7];
    const double ex = s[8] / s[11], ed = s[9] * s[11] / 1000;
    uint32_t i, j;
    for (i = 0; i < n; i++) predelay[(start + (int)i) % length] = core->audio[3][i];
    for (i = 0; i < n; i++) {
        double pre, split, exc, exc2, temp, left, right;
        s[12] += s[1] * (predelay[(length + start - pd + (int)i) % length] - s[12]);
        pre = wr(d, 0, s[12] - fi * rd(d, 0, 0));
        pre = wr(d, 1, fi * (pre - rd(d, 1, 0)) + rd(d, 0, 0));
        pre = wr(d, 2, fi * pre + rd(d, 1, 0) - si * rd(d, 2, 0));
        pre = wr(d, 3, si * (pre - rd(d, 3, 0)) + rd(d, 2, 0));
        split = si * pre + rd(d, 3, 0);
        exc = ed * (1 + cos(s[15] * 6.28)); exc2 = ed * (1 + sin(s[15] * 6.2847));
        temp = wr(d, 4, split + dc * rd(d, 11, 0) + ft * cubic(d, 4, exc));
        wr(d, 5, cubic(d, 4, exc) - ft * temp);
        s[13] += dp * (rd(d, 5, 0) - s[13]);
        temp = wr(d, 6, dc * s[13] - st * rd(d, 6, 0));
        wr(d, 7, rd(d, 6, 0) + st * temp);
        temp = wr(d, 8, split + dc * rd(d, 7, 0) + ft * cubic(d, 8, exc2));
        wr(d, 9, cubic(d, 8, exc2) - ft * temp);
        s[14] += dp * (rd(d, 9, 0) - s[14]);
        temp = wr(d, 10, dc * s[14] - st * rd(d, 10, 0));
        wr(d, 11, rd(d, 10, 0) + st * temp);
        left = rd(d, 9, t[0]) + rd(d, 9, t[1]) - rd(d, 10, t[2]) + rd(d, 11, t[3]) - rd(d, 5, t[4]) - rd(d, 6, t[5]) - rd(d, 7, t[6]);
        right = rd(d, 5, t[7]) + rd(d, 5, t[8]) - rd(d, 6, t[9]) + rd(d, 7, t[10]) - rd(d, 9, t[11]) - rd(d, 10, t[12]) - rd(d, 11, t[13]);
        core->audio[1][i] = (float)(core->audio[1][i] + left * s[10]);
        core->audio[2][i] = (float)(core->audio[2][i] + right * s[10]);
        s[15] += ex;
        for (j = 0; j < 12; j++) { d[j * 4 + 1] = (d[j * 4 + 1] + 1) & d[j * 4 + 3]; d[j * 4 + 2] = (d[j * 4 + 2] + 1) & d[j * 4 + 3]; }
    }
    s[16] = (start + n) % length;
}
