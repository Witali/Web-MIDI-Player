/* SoundFont envelope state transitions, matching SpessaSynth 4.3.22. */
#include "dsp.h"
#include <math.h>
static double lookup(const float *table, double attenuation) {
    double index = attenuation + 16600;
    if (!isfinite(index)) index = 0; /* JS ToInt32(NaN/Infinity). */
    if (index < 0 || index >= 32601) return NAN;
    return table[(int)index];
}
/* outputGain, attenuationCb, state, sampleTime, releaseStartCb,
 * releaseStartTimeSamples, attackDuration, decayDuration, releaseDuration,
 * sustainCb, delayEnd, attackEnd, holdEnd, decayEnd, enteredRelease,
 * canEndOnSilentSustain. Initialization/release parameters come from the bank. */
int dsp_volume_envelope(double *s, uint32_t count, double target, const float *table) {
    if (!s || !table || !count || count > DSP_QUANTUM) return 0;
    const double time = s[3] += count;
    if (s[14]) {
        s[1] = (time - s[5]) / s[8] * (960 - s[4]) + s[4];
        s[0] = lookup(table, s[1]) * target; return s[1] < 900;
    }
    switch ((int)s[2]) {
    case 0:
        if (time < s[10]) { s[1] = 960; s[0] = 0; return 1; }
        s[2]++;
        /* fall through */
    case 1:
        if (time < s[11]) { s[1] = 0; s[0] = (1 - (s[11] - time) / s[6]) * target; return 1; }
        s[2]++;
        /* fall through */
    case 2:
        if (time < s[12]) { s[1] = 0; s[0] = target; return 1; }
        s[2]++;
        /* fall through */
    case 3:
        if (time < s[13]) { s[1] = (1 - (s[13] - time) / s[7]) * s[9]; s[0] = target * lookup(table, s[1]); return 1; }
        s[2]++;
        /* fall through */
    case 4:
        if (s[15] && s[9] >= 900) { s[1] = 960; s[0] = 0; return 0; }
        s[1] = s[9]; s[0] = target * lookup(table, s[9]); return 1;
    default: return 0;
    }
}
/* attackDuration, decayDuration, releaseDuration, sustainLevel, delayEnd,
 * attackEnd, holdEnd, releaseStartLevel, currentValue, enteredRelease, decayEnd. */
double dsp_modulation_envelope(double *s, double time, double release_start, const float *convex) {
    if (!s || !convex) return 0;
    if (s[9]) {
        if (s[7] == 0) return 0;
        { const double value = (1 - (time - release_start) / s[2]) * s[7]; return value > 0 ? value : 0; }
    }
    if (time < s[4]) s[8] = 0;
    else if (time < s[5]) {
        const int index = (int)((1 - (s[5] - time) / s[0]) * 1000);
        s[8] = index >= 0 && index < 1000 ? convex[index] : NAN;
    } else if (time < s[6]) s[8] = 1;
    else if (time < s[10]) s[8] = (1 - (s[10] - time) / s[1]) * (s[3] - 1) + 1;
    else s[8] = s[3];
    return s[8];
}
