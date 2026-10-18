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
    impulse(); gain_pan_and_sends(); interpolation_and_end(); dense_polyphony();
    printf("PASS native C DSP: %u checks\n", checks); return 0;
}
