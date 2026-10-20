// Repeat an exact continuous-render prefix state. No full-song PCM cache,
// approximate controller seek or asynchronous work is needed at the boundary.
export function createLoopPreview(base, playback) {
  if (!playback.loop) return base;
  const { start, end } = playback.loop, rate = playback.rate;
  const first = Math.round(start / rate * 48000), last = Math.round(end / rate * 48000);
  const zero = base.capture(); let atStart = first === 0 ? zero : null, iteration = 0, spans = [];
  function captureStart() { if (!atStart && base.frame === first) atStart = base.capture(); }
  return {
    get stats() { return { ...base.stats, playback, iteration }; },
    get lastSpans() { return spans; },
    read(capacity = 2048) {
      if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('Read capacity must be a nonnegative integer.');
      const channels = [new Float32Array(capacity), new Float32Array(capacity)];
      spans = [{ offset: 0, seconds: base.stats.position, iteration }];
      for (let at = 0; at < capacity;) {
        captureStart();
        const boundary = base.frame < first ? first : last;
        const count = Math.min(capacity - at, boundary - base.frame);
        if (count <= 0) throw new Error('Invalid loop cursor.');
        const pcm = base.read(count);
        if (pcm[0].length !== count) throw new Error('Sequence ended before the loop boundary.');
        channels.forEach((c, i) => c.set(pcm[i], at)); at += count;
        captureStart();
        if (base.frame === last) {
          base.flushThrough(end);
          atStart.restore(); iteration++;
          spans.push({ offset: at, seconds: base.stats.position, iteration, loopEnd: end });
        }
      }
      return channels;
    },
    async seek(seconds, options = {}) {
      if (!Number.isFinite(seconds)) throw new TypeError('Seek position must be finite.');
      let target = Math.max(0, seconds);
      if (target >= end || Math.round(target / rate * 48000) >= last) target = start;
      const frame = Math.round(target / rate * 48000);
      if (frame >= first) {
        if (!atStart) {
          zero.restore(); const result = await base.seek(start, options);
          if (result.cancelled) return result;
          captureStart();
        }
        atStart.restore();
      } else zero.restore();
      iteration = 0; spans = [];
      return base.seek(target, options);
    },
    async reset() { zero.restore(); iteration = 0; spans = []; },
    close() { atStart = null; base.close(); }
  };
}
