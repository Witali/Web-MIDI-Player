#include "dsp.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
static unsigned checks;
#define CHECK(condition) do { checks++; if (!(condition)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); exit(1); } } while (0)
static DspScratch *s;
static int render(unsigned count, int filter, double gain, double increment, double l, double r, int insertion) {
    return dsp_process_voice(count, filter, gain, increment, l, r, .5, .25, .125, insertion, NULL, 0, 0, 0, 0, 0, 0);
}
static void clear(void) { memset(s, 0, sizeof(*s)); }
static void impulse(void) {
    clear(); s->audio[0][0] = 1; s->filter[0] = .5; s->filter[3] = -.5;
    CHECK(render(3, 1, 1, 0, 1, 0, 0) == 1);
    CHECK(s->audio[1][0] == .5f && s->audio[1][1] == .25f && s->audio[1][2] == .125f);
    CHECK(s->audio[2][0] == 0 && s->audio[3][0] == .25f);
    CHECK(s->filter[7] == .125 && s->filter[8] == .25);
}
static void gain_pan_and_sends(void) {
    unsigned i; clear(); for (i = 0; i < 128; i++) s->audio[0][i] = 1;
    CHECK(render(3, 0, .25, .25, 0, 1, 1) == 1);
    CHECK(s->audio[7][0] == .25f && s->audio[7][1] == .5f && s->audio[7][2] == .75f);
    CHECK(s->audio[6][0] == 0 && s->audio[1][0] == 0 && s->audio[3][0] == 0);
    CHECK(s->audio[7][3] == 0);
    CHECK(render(0, 0, 1, 0, 1, 1, 0) == -1);
    CHECK(render(129, 0, 1, 0, 1, 1, 0) == -1);
}
static void interpolation_and_end(void) {
    const float sample[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    clear(); CHECK(dsp_process_voice(127, 0, 1, 0, 1, 0, 0, 0, 0, 0, sample, 1, 8, 4, 8, 7.5, .75) == 1);
    CHECK(s->audio[1][0] == 1 && s->audio[1][126] == 1);
    clear(); CHECK(dsp_process_voice(8, 0, 1, 0, 1, 0, 0, 0, 0, 0, sample, 0, 0, 0, 8, 4, 1) == 0);
    CHECK(s->audio[1][0] == 1 && s->audio[1][1] == 0 && s->audio[1][7] == 0);
    CHECK(dsp_process_voice(8, 0, 1, 0, 1, 0, 0, 0, 0, 0, sample, 1, 8, 0, 8, 0, 1) == -1);
}
/* Deliberately unoptimized oracle: keep the original per-sample boundary
 * checks and coefficient evaluation independent from the fast block path. */
static int reference_hermite(float *output, unsigned count, const float *data, int looping,
    int loop_end, int loop_length, int end, double *position, double step) {
    unsigned i; double cursor = *position;
    for (i = 0; i < count; i++) {
        int y0, y1, y2, y3; double t, xm1, x0, x1, x2, c, v, w, a, b;
        if (looping) while (cursor >= loop_end) cursor -= loop_length;
        y0 = (int)cursor; y1 = y0 + 1; y2 = y0 + 2; y3 = y0 + 3; t = cursor - y0;
        if (looping) {
            while (y1 >= loop_end) y1 -= loop_length;
            while (y2 >= loop_end) y2 -= loop_length;
            while (y3 >= loop_end) y3 -= loop_length;
        } else if (y3 >= end) { for (; i < count; i++) output[i] = 0; return 0; }
        xm1 = data[y0]; x0 = data[y1]; x1 = data[y2]; x2 = data[y3];
        c = (x1 - xm1) * .5; v = x0 - x1; w = c + v;
        a = w + v + (x2 - x0) * .5; b = w + a;
        output[i] = (float)(((a * t - b) * t + c) * t + x0); cursor += step;
    }
    *position = cursor; return 1;
}
static void interpolation_boundaries(void) {
    float data[1024], expected[128]; unsigned i, trial; uint32_t random = 0x358ef123;
    const double steps[] = {0, .03125, .1, .5, .9999999999999999, 1, 1.0000000000000002, 2.7, 11.125, 129};
    for (i = 0; i < 1024; i++) data[i] = (float)(sin(i * .17) * .6);
    for (trial = 0; trial < 2000; trial++) {
        const int looping = (trial / 10) % 2, end = trial % 3 ? 1024 : 17;
        const int loop_length = trial % 5 ? end / 2 : 1 + (int)(trial % 3);
        const unsigned count = 1 + trial % 128;
        double cursor, expected_cursor; int active;
        random = random * 1664525u + 1013904223u;
        cursor = (random % (unsigned)(end * 16)) / 16.;
        if (trial % 7 == 0) cursor = end - 3.0000000000000004;
        expected_cursor = cursor;
        active = reference_hermite(expected, count, data, looping, end, loop_length, end,
            &expected_cursor, steps[trial % 10]);
        clear(); s->cursor = cursor;
        CHECK(dsp_process_voice(count, 0, 1, 0, 1, 0, 0, 0, 0, 0, data,
            looping, end, loop_length, end, cursor, steps[trial % 10]) == active);
        CHECK(memcmp(expected, s->audio[0], count * sizeof(float)) == 0);
        CHECK(s->cursor == expected_cursor);
    }
}
static void dense_polyphony(void) {
    unsigned voice, i; clear();
    for (voice = 0; voice < 4096; voice++) {
        for (i = 0; i < 128; i++) s->audio[0][i] = .125f;
        CHECK(render(128, 0, 1, 0, 1, 1, 0) == 1);
    }
    CHECK(s->audio[1][64] == 512 && s->audio[2][64] == 512);
}
static void waveform_cache(void) {
    static float sample[8192]; unsigned i; const uint32_t *stats = dsp_get_cache_stats();
    for (i = 0; i < 8192; i++) sample[i] = .125f;
    clear(); for (i = 0; i < 17; i++) dsp_begin_block();
    CHECK(stats[2] == 1);
    CHECK(dsp_process_voice(128, 0, 1, 0, 1, 0, 0, 0, 0, 0, sample, 1, 8192, 4096, 8192, 0, .5) == 1);
    CHECK(stats[0] == 0 && stats[1] == 1);
    s->filter[0] = .5;
    CHECK(dsp_process_voice(128, 1, 2, 0, 0, 1, 0, 0, 0, 0, sample, 1, 8192, 4096, 8192, 0, .5) == 1);
    CHECK(stats[0] == 1 && stats[1] == 1);
    for (i = 0; i < 128; i++) CHECK(s->audio[1][i] == .125f && s->audio[2][i] == .125f);
    CHECK(s->filter[5] == .125 && s->filter[7] == .0625);
    /* More unique entries than cache slots must still render every voice. */
    clear(); for (i = 0; i < 17; i++) dsp_begin_block();
    for (i = 0; i < 4096; i++) CHECK(dsp_process_voice(1, 0, 1, 0, 1, 0, 0, 0, 0, 0,
        sample, 0, 0, 0, 8192, i, 0) == 1);
    CHECK(s->audio[1][0] == 512 && stats[0] == 0 && stats[1] == 4096);
    dsp_begin_block(); CHECK(stats[2] == 0); /* no reuse: bypass caching */
    for (i = 0; i < 17; i++) dsp_begin_block();
    CHECK(stats[2] == 1 && stats[0] == 0 && stats[1] == 0);
    /* A new block never reuses data from a previous block's source. */
    sample[1] = .75f; clear();
    CHECK(dsp_process_voice(1, 0, 1, 0, 1, 0, 0, 0, 0, 0, sample, 0, 0, 0, 8192, 0, 0) == 1);
    CHECK(s->audio[1][0] == .75f && stats[0] == 0 && stats[1] == 1);
}
static void envelopes(void) {
    static float table[32601], convex[1000];
    double v[16] = {0}, m[11] = {.1, .1, .1, .25, .02, .12, .2, 0, 0, 0, .3}; unsigned i;
    for (i = 0; i < 32601; i++) table[i] = (float)pow(10, -((double)i - 16600) / 200);
    for (i = 0; i < 1000; i++) convex[i] = (float)(i / 1000.);
    v[6] = v[7] = 100; v[9] = 200; v[10] = 100; v[11] = 200; v[12] = 300; v[13] = 400;
    CHECK(dsp_volume_envelope(v, 50, .8, table) && v[0] == 0 && v[2] == 0);
    CHECK(dsp_volume_envelope(v, 50, .8, table) && v[0] == 0 && v[2] == 1);
    CHECK(dsp_volume_envelope(v, 50, .8, table) && fabs(v[0] - .4) < 1e-12);
    CHECK(dsp_volume_envelope(v, 50, .8, table) && v[0] == .8 && v[2] == 2);
    CHECK(dsp_volume_envelope(v, 100, .8, table) && v[2] == 3);
    CHECK(dsp_volume_envelope(v, 50, .8, table) && fabs(v[1] - 100) < 1e-12);
    CHECK(dsp_volume_envelope(v, 50, .8, table) && v[2] == 4 && fabs(v[0] - .08) < 1e-8);
    v[14] = 1; v[4] = 200; v[5] = 400; v[8] = 100;
    CHECK(dsp_volume_envelope(v, 50, .8, table) && v[1] == 580);
    CHECK(!dsp_volume_envelope(v, 50, .8, table) && v[1] == 960);
    CHECK(!dsp_volume_envelope(v, 129, 1, table));
    CHECK(dsp_modulation_envelope(m, .01, 0, convex) == 0);
    CHECK(fabs(dsp_modulation_envelope(m, .07, 0, convex) - .5) < .002);
    CHECK(dsp_modulation_envelope(m, .15, 0, convex) == 1);
    CHECK(fabs(dsp_modulation_envelope(m, .25, 0, convex) - .625) < 1e-12);
    CHECK(dsp_modulation_envelope(m, .4, 0, convex) == .25);
    m[9] = 1; m[7] = .25;
    CHECK(fabs(dsp_modulation_envelope(m, .45, .4, convex) - .125) < 1e-12);
    CHECK(dsp_modulation_envelope(m, .6, .4, convex) == 0);
    {
        double fused[16] = {0}; fused[2] = 4;
        clear(); s->audio[0][0] = s->audio[0][1] = s->audio[0][2] = 1;
        CHECK(dsp_process_voice_envelope(3, 0, fused, 1, table, 1, 0, 0, 0, 0, 0, NULL, 0, 0, 0, 0, 0, 0) == 1);
        CHECK(fused[0] == 1 && fused[3] == 3);
        CHECK(s->audio[1][0] == 0 && s->audio[1][1] == (float)(1. / 3) && s->audio[1][2] == (float)(2. / 3));
    }
}
static void chorus_and_delay(void) {
    float left[8] = {0}, right[8] = {0}, buffer[4] = {0}, input[8] = {1}, output[8] = {0};
    double c[13] = {8, 0, 0, 1, 1, .5, 0, 2, 0, 0, 0, 0, 0};
    double d[5] = {.5, 1, 4, 0, 2};
    clear(); s->audio[4][0] = 1; dsp_chorus(c, left, right, 8);
    CHECK(s->audio[1][2] == 1 && s->audio[2][2] == 1);
    CHECK(s->audio[3][2] == 1 && s->audio[5][2] == .5f && c[2] == 0);
    dsp_delay_line(d, buffer, input, output, 8);
    CHECK(output[0] == 0 && output[2] == 1 && output[4] == .5f && output[6] == .25f);
    CHECK(d[3] == 0);
    dsp_delay_line(d, buffer, input, output, 129); CHECK(d[3] == 0);
}
static void reverb(void) {
    const double lengths[12] = {.004771345, .003595309, .012734787, .009307483, .022579886, .149625349,
        .060481839, .1249958, .030509727, .141695508, .089244313, .106280031};
    const double tap_times[14] = {.008937872, .099929438, .064278754, .067067639, .066866033, .006283391,
        .035818689, .011861161, .121870905, .041262054, .08981553, .070931756, .011256342, .004065724};
    double r[18] = {0, .5, .75, .625, .5, .7, .5, .005, .1, .2, 1, 48000, 0, 0, 0, 0, 0, 48000};
    uintptr_t lines[48]; int16_t taps[14]; float *predelay = calloc(48000, sizeof(float));
    unsigned line, block, i; double energy = 0; CHECK(predelay != NULL);
    for (line = 0; line < 12; line++) {
        unsigned length = (unsigned)floor(lengths[line] * 48000 + .5), capacity = 1;
        while (capacity < length) capacity *= 2;
        lines[line * 4] = (uintptr_t)calloc(capacity, sizeof(float)); CHECK(lines[line * 4] != 0);
        lines[line * 4 + 1] = length - 1; lines[line * 4 + 2] = 0; lines[line * 4 + 3] = capacity - 1;
    }
    for (i = 0; i < 14; i++) taps[i] = (int16_t)floor(tap_times[i] * 48000 + .5);
    for (block = 0; block < 200; block++) {
        clear(); if (block == 0) s->audio[3][0] = 1;
        dsp_dattorro(r, lines, taps, predelay, 128);
        for (i = 0; i < 128; i++) { CHECK(isfinite(s->audio[1][i]) && isfinite(s->audio[2][i]));
            energy += s->audio[1][i] * s->audio[1][i] + s->audio[2][i] * s->audio[2][i]; }
    }
    CHECK(energy > .001 && r[15] > 0);
    for (line = 0; line < 12; line++) free((void *)lines[line * 4]); free(predelay);
}
static void batch_voices(void) {
    enum { N = 41 };
    DspVoiceCommand commands[N];
    double filters[2][N][9], envelopes_state[2][N][16], cursors[N];
    float input[N][128], captures[2][N][128], expected[8][128], table[32601], samples[257];
    int statuses[N]; unsigned ci, i, j, pass;
    const unsigned counts[4] = {1, 3, 127, 128};
    CHECK(dsp_batch_abi_version() == 1 && dsp_voice_command_size() == sizeof(DspVoiceCommand));
    for (i = 0; i < 257; i++) samples[i] = (float)sin(i * .17);
    for (i = 0; i < 32601; i++) table[i] = (float)pow(10, -((double)i - 16600) / 200);
    for (ci = 0; ci < 4; ci++) {
        const unsigned count = counts[ci];
        memset(commands, 0, sizeof(commands)); memset(envelopes_state, 0, sizeof(envelopes_state));
        for (i = 0; i < N; i++) {
            DspVoiceCommand *v = commands + i;
            const double f[9] = {.42 + i * .001, .2, .1, -.3, .05, .1, -.2, .03, .04};
            memcpy(filters[0][i], f, sizeof(f)); memcpy(filters[1][i], f, sizeof(f));
            for (j = 0; j < 128; j++) input[i][j] = (float)sin((i + j) * .3);
            envelopes_state[0][i][2] = envelopes_state[1][i][2] = 4;
            v->samples = i % 4 ? samples : NULL; v->input = input[i]; v->capture = captures[1][i];
            v->filter = filters[1][i]; v->envelope = i % 3 ? NULL : envelopes_state[1][i]; v->centibels = table;
            v->flags = (i % 2 ? 1u : 0u) | (i % 5 == 0 ? 2u : 0u);
            v->looping = i % 7 != 0; v->loop_end = 17; v->loop_length = 7; v->end = 257;
            v->cursor = i % 7 ? .25 : 254; v->step = .5; v->gain = .13 + i * .003; v->increment = .003;
            v->target = .75; v->left = .71; v->right = .27; v->reverb = .12; v->chorus = .08; v->delay = .03;
        }
        for (pass = 0; pass < 3; pass++) {
            clear(); dsp_begin_block();
            for (i = 0; i < N; i++) {
                DspVoiceCommand *v = commands + i;
                if (v->flags & 1) memcpy(s->filter, filters[0][i], sizeof(s->filter));
                if (!v->samples) memcpy(s->audio[0], v->input, count * sizeof(float));
                if (v->envelope) statuses[i] = dsp_process_voice_envelope(count, v->flags & 1,
                    envelopes_state[0][i], v->target, table, v->left, v->right, v->reverb, v->chorus, v->delay,
                    v->flags & 2, v->samples, v->looping, v->loop_end, v->loop_length, v->end, v->cursor, v->step);
                else statuses[i] = dsp_process_voice(count, v->flags & 1, v->gain, v->increment,
                    v->left, v->right, v->reverb, v->chorus, v->delay, v->flags & 2,
                    v->samples, v->looping, v->loop_end, v->loop_length, v->end, v->cursor, v->step);
                cursors[i] = statuses[i] ? s->cursor : v->cursor;
                if (v->flags & 1) memcpy(filters[0][i], s->filter, sizeof(s->filter));
                memcpy(captures[0][i], s->audio[0], count * sizeof(float));
            }
            memcpy(expected, s->audio, sizeof(expected)); clear(); dsp_begin_block();
            CHECK(dsp_process_batch(commands, N, count) == 0);
            CHECK(dsp_get_voice_simd_stats()[0] == 0 && dsp_get_voice_simd_stats()[1] == N);
            for (j = 1; j < 8; j++) CHECK(memcmp(expected[j], s->audio[j], count * sizeof(float)) == 0);
            for (i = 0; i < N; i++) {
                CHECK(commands[i].active == statuses[i]);
                CHECK(commands[i].result_cursor == cursors[i]);
                CHECK(memcmp(filters[0][i], filters[1][i], sizeof(filters[0][i])) == 0);
                CHECK(memcmp(envelopes_state[0][i], envelopes_state[1][i], sizeof(envelopes_state[0][i])) == 0);
                CHECK(memcmp(captures[0][i], captures[1][i], count * sizeof(float)) == 0);
                if (commands[i].samples && commands[i].active) commands[i].cursor = cursors[i];
            }
        }
    }
    CHECK(dsp_process_batch_scalar(NULL, 0, 128) == 0);
    CHECK(dsp_get_voice_simd_stats()[0] == 0 && dsp_get_voice_simd_stats()[1] == 0);
    CHECK(dsp_process_batch(NULL, 0, 128) == 0);
    CHECK(dsp_process_batch(NULL, 1, 128) == -1);
    CHECK(dsp_process_batch(commands, N, 0) == -1);
    CHECK(dsp_process_batch(commands, N, 129) == -1);
    memcpy(expected, s->audio, sizeof(expected));
    commands[N - 1].flags = 4; CHECK(dsp_process_batch(commands, N, 128) == -1);
    CHECK(memcmp(expected, s->audio, sizeof(expected)) == 0);
    commands[N - 1].flags = 0; commands[N - 1].samples = NULL; commands[N - 1].input = NULL;
    CHECK(dsp_process_batch(commands, N, 128) == -1);
}
static uint32_t hash_bytes(uint32_t hash, const void *data, size_t count) {
    const unsigned char *bytes = data; size_t i;
    for (i = 0; i < count; i++) hash = (hash ^ bytes[i]) * UINT32_C(16777619);
    return hash;
}
/* Rational source/table values avoid cross-libm assumptions. Expected output
 * comes from five ordinary per-voice calls, not the new SIMD implementation. */
static uint32_t independent_golden(unsigned count) {
    float source[257], input[5][128], captured[5][128], table[32601];
    double filters[5][9], env[5][16] = {{0}}, cursors[5];
    int32_t active[5]; unsigned i, j; uint32_t hash = UINT32_C(2166136261);
    for (i = 0; i < 257; i++) source[i] = (float)((int)((i * 13 + 31) % 127) - 64) / 64;
    for (i = 0; i < 32601; i++) table[i] = (float)(i % 31 + 1) / 32;
    clear(); dsp_begin_block();
    for (i = 0; i < 5; i++) {
        const double f[9] = {.5 + i / 256., .125, .0625, -.25, .03125, .0625, -.125, .03125, -.0625};
        const int oscillator = (i % 2) == 0, insertion = i == 3;
        const double cursor = i == 2 ? 254 : i == 0 ? 10.25 : .25;
        memcpy(filters[i], f, sizeof(f)); memcpy(s->filter, f, sizeof(f));
        for (j = 0; j < 128; j++) input[i][j] = (float)((int)((i * 17 + j * 11) % 61) - 30) / 32;
        env[i][0] = (i + 1) / 16.; env[i][2] = 4; env[i][4] = 50; env[i][8] = 100;
        env[i][9] = i * 20; env[i][14] = i == 2;
        if (!oscillator) memcpy(s->audio[0], input[i], count * sizeof(float));
        if (oscillator) active[i] = dsp_process_voice_envelope(count, 1, env[i], .75, table,
            .71, .27, .12, .08, .03, insertion, source, i == 0, 17, 7, 257, cursor, .7);
        else active[i] = dsp_process_voice(count, 1, (i + 1) / 16., .003 * ((double)i - 1),
            .71, .27, .12, .08, .03, insertion, NULL, 0, 17, 7, 257, cursor, .7);
        cursors[i] = active[i] ? s->cursor : cursor;
        memcpy(filters[i], s->filter, sizeof(s->filter));
        memcpy(captured[i], s->audio[0], count * sizeof(float));
    }
    for (i = 1; i < 8; i++) hash = hash_bytes(hash, s->audio[i], count * sizeof(float));
    hash = hash_bytes(hash, filters, sizeof(filters)); hash = hash_bytes(hash, env, sizeof(env));
    for (i = 0; i < 5; i++) hash = hash_bytes(hash, captured[i], count * sizeof(float));
    hash = hash_bytes(hash, cursors, sizeof(cursors)); hash = hash_bytes(hash, active, sizeof(active));
    return hash;
}
static void golden(void) {
    unsigned i; const float sample[12] = {0, .2f, -.6f, .9f, .7f, -.2f, -.4f, .3f, .8f, -.5f, .1f, 0};
    clear(); s->filter[0] = .42; s->filter[1] = .2; s->filter[2] = .1; s->filter[3] = -.3; s->filter[4] = .05;
    s->filter[5] = .1; s->filter[6] = -.2; s->filter[7] = .03; s->filter[8] = .04;
    dsp_process_voice(8, 1, .13, .003, .71, .27, .12, .08, .03, 0, sample, 1, 12, 8, 12, 10.25, .7);
    printf("{\"audio\":[");
    for (i = 0; i < 8; i++) printf("%s%.17g", i ? "," : "", (double)s->audio[1][i]);
    printf("],\"filter\":["); for (i = 0; i < 9; i++) printf("%s%.17g", i ? "," : "", s->filter[i]);
    printf("],\"cursor\":%.17g,\"independentVoices\":[", s->cursor);
    { const unsigned counts[4] = {1, 3, 127, 128};
      for (i = 0; i < 4; i++) printf("%s%u", i ? "," : "", independent_golden(counts[i])); }
    printf("]}\n");
}
int main(int argc, char **argv) {
    s = dsp_get_layout(); CHECK(dsp_abi_version() == 1);
    if (argc > 1 && strcmp(argv[1], "--golden") == 0) { golden(); return 0; }
    impulse(); gain_pan_and_sends(); interpolation_and_end(); interpolation_boundaries(); dense_polyphony(); envelopes(); chorus_and_delay(); reverb(); waveform_cache(); batch_voices();
    printf("PASS native C DSP: %u checks\n", checks); return 0;
}
