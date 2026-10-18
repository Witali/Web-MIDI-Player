// Use two synchronized C preview handles. A shared reference headroom prevents
// independent normalization from undoing MIDI pan or changing channel balance.
export function panGains(value) {
  const pan = Math.max(0, Math.min(127, value));
  const angle = pan <= 64 ? pan / 64 * Math.PI / 4 : Math.PI / 4 + (pan - 64) / 63 * Math.PI / 4;
  return [Math.cos(angle), Math.sin(angle)];
}
export function panScore(score, channel) {
  return { ...score, notes: score.notes.map(note => {
    const events = [
      ...note.levels.map((event, order) => ({ ...event, type: 'gain', order })),
      ...(note.pan || [{ time: note.start, value: 64 }]).map((event, order) => ({ ...event, type: 'pan', order }))
    ].sort((a, b) => a.time - b.time || (a.type === b.type ? a.order - b.order : a.type === 'gain' ? -1 : 1));
    const levels = []; let gain = note.levels[0]?.gain || 0, pan = 64;
    for (let at = 0; at < events.length;) {
      const time = events[at].time;
      while (at < events.length && events[at].time === time) {
        const event = events[at++]; if (event.type === 'gain') gain = event.gain; else pan = event.value;
      }
      // An inaudible epsilon keeps the engine's octave grain choice identical
      // for both ears even when a note is fully panned to the other channel.
      levels.push({ time, gain: gain * Math.max(1e-20, panGains(pan)[channel]) });
    }
    return { ...note, levels };
  }) };
}
export function createStereoPreview(engine, score, bank, players, options) {
  const request = engine.encodeRequest(score, bank, players, options);
  const reference = engine.createPreview(request), stats = reference.stats;
  reference.close();
  const requests = [0, 1].map(channel => engine.encodeRequest(panScore(score, channel), bank, players, options));
  let previews = [];
  const reset = () => {
    previews.forEach(preview => preview.close()); previews = [];
    try { for (const bytes of requests) previews.push(engine.createPreview(bytes)); }
    catch (error) { previews.forEach(preview => preview.close()); previews = []; throw error; }
  };
  reset();
  return {
    get stats() { return { ...stats, position: previews[0].stats.position, channels: 2 }; },
    read(capacity = 2048) {
      return previews.map(preview => {
        const samples = preview.read(capacity), scale = stats.gain / preview.stats.gain;
        for (let i = 0; i < samples.length; i++) samples[i] *= scale;
        return samples;
      });
    },
    reset,
    close() { previews.forEach(preview => preview.close()); previews = []; }
  };
}
