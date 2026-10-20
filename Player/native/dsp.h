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
/* Begin one host audio block. Immutable oscillator waveforms may be reused
 * within this block; filters/envelopes/mixing still execute for every voice. */
void dsp_begin_block(void);
const uint32_t *dsp_get_cache_stats(void); /* hits, misses, enabled in current block */
/* Batch extension 1. The host grows these descriptors without a voice cap.
 * Six native pointers, six 32-bit words, then eleven doubles (136 bytes on
 * wasm32). Input/capture may alias. Persistent filter/envelope state belongs
 * to one voice; commands execute in array order, including their last block. */
typedef struct {
    const float *samples;
    double *filter, *envelope;
    const float *centibels, *input;
    float *capture;
    uint32_t flags; /* bit 0: filter, bit 1: insertion */
    int32_t looping, loop_end, loop_length, end, active;
    double cursor, step, gain, increment, target;
    double left, right, reverb, chorus, delay, result_cursor;
} DspVoiceCommand;
uint32_t dsp_batch_abi_version(void);
uint32_t dsp_voice_command_size(void);
/* Invalid descriptors reject the entire batch before changing DSP state. */
int dsp_process_batch(DspVoiceCommand *commands, uint32_t voices, uint32_t count);
int dsp_process_batch_scalar(DspVoiceCommand *commands, uint32_t voices, uint32_t count);
const uint32_t *dsp_get_voice_simd_stats(void); /* independent pairs, scalar voices in last valid batch */
int dsp_process_voice(uint32_t count, int filtered, double gain, double increment,
    double left, double right, double reverb, double chorus, double delay, int insertion,
    const float *samples, int looping, int loop_end, int loop_length, int end,
    double cursor, double step);
int dsp_volume_envelope(double *state, uint32_t count, double target, const float *centibels);
int dsp_process_voice_envelope(uint32_t count, int filtered, double *envelope, double target, const float *centibels,
    double left, double right, double reverb, double chorus, double delay, int insertion,
    const float *samples, int looping, int loop_end, int loop_length, int end, double cursor, double step);
double dsp_modulation_envelope(double *state, double time, double release_start, const float *convex_attack);
void dsp_chorus(double *state, float *buffer_left, float *buffer_right, uint32_t count);
void dsp_delay_line(double *state, float *buffer, const float *input, float *output, uint32_t count);
void dsp_dattorro(double *state, uintptr_t *lines, const int16_t *taps, float *predelay, uint32_t count);
#endif
