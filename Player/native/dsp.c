#include "dsp.h"
#include <stddef.h>
#include <math.h>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

static DspScratch scratch;
_Static_assert(sizeof(float) == 4 && sizeof(double) == 8, "IEEE-754 storage required");
_Static_assert(offsetof(DspScratch, filter) == 4096, "DSP filter ABI");
_Static_assert(offsetof(DspScratch, cursor) == 4200, "DSP cursor ABI");
uint32_t dsp_abi_version(void) { return 1; }
DspScratch *dsp_get_layout(void) { return &scratch; }

static int hermite(uint32_t n, const float *data, int looping, int loop_end,
    int loop_length, int end, double cursor, double step) {
    uint32_t i;
    for (i = 0; i < n; i++) {
        int y0, y1, y2, y3;
        double t, xm1, x0, x1, x2, c, v, w, a, b;
        if (looping) while (cursor >= loop_end) cursor -= loop_length;
        y0 = (int)cursor; y1 = y0 + 1; y2 = y0 + 2; y3 = y0 + 3;
        t = cursor - y0;
        if (looping) {
            while (y1 >= loop_end) y1 -= loop_length;
            while (y2 >= loop_end) y2 -= loop_length;
            while (y3 >= loop_end) y3 -= loop_length;
        } else if (y3 >= end) {
            for (; i < n; i++) scratch.audio[0][i] = 0;
            return 0; /* The reference oscillator retains its old cursor at EOF. */
        }
        xm1 = data[y0]; x0 = data[y1]; x1 = data[y2]; x2 = data[y3];
        c = (x1 - xm1) * .5; v = x0 - x1; w = c + v;
        a = w + v + (x2 - x0) * .5; b = w + a;
        scratch.audio[0][i] = (float)(((a * t - b) * t + c) * t + x0);
        cursor += step;
    }
    scratch.cursor = cursor;
    return 1;
}

#if defined(__wasm_simd128__)
static inline void mix_pair(float *out, v128_t samples, v128_t gain) {
    v128_t previous = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(out));
    v128_t sum = wasm_f64x2_add(previous, wasm_f64x2_mul(samples, gain));
    wasm_v128_store64_lane(out, wasm_f32x4_demote_f64x2_zero(sum), 0);
}
static void mix_simd(uint32_t n, double left, double right, double reverb,
    double chorus, double delay, int insertion) {
    uint32_t i;
    const int l = insertion ? 6 : 1, r = insertion ? 7 : 2;
    const v128_t gl = wasm_f64x2_splat(left), gr = wasm_f64x2_splat(right);
    const v128_t gv = wasm_f64x2_splat(reverb), gc = wasm_f64x2_splat(chorus), gd = wasm_f64x2_splat(delay);
    /* An odd block pads one scratch sample; it never reaches the output. */
    for (i = 0; i < n; i += 2) {
        const v128_t samples = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(scratch.audio[0] + i));
        mix_pair(scratch.audio[l] + i, samples, gl); mix_pair(scratch.audio[r] + i, samples, gr);
        if (!insertion) {
            if (reverb > 0) mix_pair(scratch.audio[3] + i, samples, gv);
            if (chorus > 0) mix_pair(scratch.audio[4] + i, samples, gc);
            if (delay > 0) mix_pair(scratch.audio[5] + i, samples, gd);
        }
    }
}
#endif

int dsp_process_voice(uint32_t count, int filtered, double gain, double increment,
    double left, double right, double reverb, double chorus, double delay, int insertion,
    const float *samples, int looping, int loop_end, int loop_length, int end,
    double cursor, double step) {
    uint32_t i;
    int active = 1;
    double *f = scratch.filter;
    const double a0 = f[0], a1 = f[1], a2 = f[2], a3 = f[3], a4 = f[4];
    double x1 = f[5], x2 = f[6], y1 = f[7], y2 = f[8];
    if (!count || count > DSP_QUANTUM || (samples && (end < 4 || !isfinite(cursor) || !isfinite(step) || cursor < 0 || step < 0 ||
        (looping && (loop_length <= 0 || loop_end > end || loop_end < loop_length))))) return -1;
    if (samples) active = hermite(count, samples, looping, loop_end, loop_length, end, cursor, step);
    for (i = 0; i < count; i++) {
        const double input = scratch.audio[0][i];
        double sample = input;
        if (filtered) {
            sample = a0 * input + a1 * x1 + a2 * x2 - a3 * y1 - y2 * a4;
            x2 = x1; x1 = input; y2 = y1; y1 = sample;
        }
        scratch.audio[0][i] = (float)(sample * gain);
        sample = scratch.audio[0][i]; gain += increment;
#if !defined(__wasm_simd128__)
        {
            const int l = insertion ? 6 : 1, r = insertion ? 7 : 2;
            scratch.audio[l][i] = (float)(scratch.audio[l][i] + left * sample);
            scratch.audio[r][i] = (float)(scratch.audio[r][i] + right * sample);
            if (!insertion) {
                if (reverb > 0) scratch.audio[3][i] = (float)(scratch.audio[3][i] + reverb * sample);
                if (chorus > 0) scratch.audio[4][i] = (float)(scratch.audio[4][i] + chorus * sample);
                if (delay > 0) scratch.audio[5][i] = (float)(scratch.audio[5][i] + delay * sample);
            }
        }
#endif
    }
    if (filtered) { f[5] = x1; f[6] = x2; f[7] = y1; f[8] = y2; }
#if defined(__wasm_simd128__)
    mix_simd(count, left, right, reverb, chorus, delay, insertion);
#endif
    return active;
}

int dsp_process_voice_envelope(uint32_t count, int filtered, double *env, double target, const float *table,
    double left, double right, double reverb, double chorus, double delay, int insertion,
    const float *samples, int looping, int loop_end, int loop_length, int end, double cursor, double step) {
    double gain, increment; int envelope_active, active;
    if (!env || !table || !count || count > DSP_QUANTUM) return -1;
    gain = env[0]; envelope_active = dsp_volume_envelope(env, count, target, table);
    increment = (env[0] - gain) / count;
    active = dsp_process_voice(count, filtered, gain, increment, left, right, reverb, chorus, delay,
        insertion, samples, looping, loop_end, loop_length, end, cursor, step);
    return active < 0 ? active : active && envelope_active;
}
