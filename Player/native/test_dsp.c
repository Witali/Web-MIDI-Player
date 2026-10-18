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
static void dense_polyphony(void) {
    unsigned voice, i; clear();
    for (voice = 0; voice < 4096; voice++) {
        for (i = 0; i < 128; i++) s->audio[0][i] = .125f;
        CHECK(render(128, 0, 1, 0, 1, 1, 0) == 1);
    }
    CHECK(s->audio[1][64] == 512 && s->audio[2][64] == 512);
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
static void golden(void) {
    unsigned i; const float sample[12] = {0, .2f, -.6f, .9f, .7f, -.2f, -.4f, .3f, .8f, -.5f, .1f, 0};
    clear(); s->filter[0] = .42; s->filter[1] = .2; s->filter[2] = .1; s->filter[3] = -.3; s->filter[4] = .05;
    s->filter[5] = .1; s->filter[6] = -.2; s->filter[7] = .03; s->filter[8] = .04;
    dsp_process_voice(8, 1, .13, .003, .71, .27, .12, .08, .03, 0, sample, 1, 12, 8, 12, 10.25, .7);
    printf("{\"audio\":[");
    for (i = 0; i < 8; i++) printf("%s%.17g", i ? "," : "", (double)s->audio[1][i]);
    printf("],\"filter\":["); for (i = 0; i < 9; i++) printf("%s%.17g", i ? "," : "", s->filter[i]);
    printf("],\"cursor\":%.17g}\n", s->cursor);
}
int main(int argc, char **argv) {
    s = dsp_get_layout(); CHECK(dsp_abi_version() == 1);
    if (argc > 1 && strcmp(argv[1], "--golden") == 0) { golden(); return 0; }
    impulse(); gain_pan_and_sends(); interpolation_and_end(); dense_polyphony(); envelopes(); chorus_and_delay(); reverb();
    printf("PASS native C DSP: %u checks\n", checks); return 0;
}
