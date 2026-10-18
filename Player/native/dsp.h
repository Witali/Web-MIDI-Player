#ifndef MIDI_PLAYER_DSP_H
#define MIDI_PLAYER_DSP_H
#include <stdint.h>
#define DSP_QUANTUM 128

/* ABI 1: the host owns the expandable arena; no musical voice limit lives
 * here. Float64 calculations and explicit Float32 stores match the JS DSP.
 * Algorithms adapted from SpessaSynth core 4.3.22 (Apache-2.0); see licenses/. */
typedef struct {
    float audio[8][DSP_QUANTUM];
    double filter[9]; /* a0..a4, x1, x2, y1, y2 */
    double reserved[4];
    double cursor;
} DspScratch;

uint32_t dsp_abi_version(void);
DspScratch *dsp_get_layout(void);
int dsp_process_voice(uint32_t count, int filtered, double gain, double increment,
    double left, double right, double reverb, double chorus, double delay, int insertion,
    const float *samples, int looping, int loop_end, int loop_length, int end,
    double cursor, double step);
#endif
