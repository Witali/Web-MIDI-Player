export function vlq(value) { const bytes = [value & 127]; while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128); return bytes; }
export function midi(events, division = 480) {
  const body = Buffer.from(events.flat());
  const head = Buffer.from('4d546864000000060000000101e04d54726b00000000', 'hex');
  head.writeUInt16BE(division, 12); head.writeUInt32BE(body.length, 18);
  return new Uint8Array(Buffer.concat([head, body]));
}
export function panned(value = 64, moving = false) {
  return midi([[0, 0xb0, 10, value], [0, 0xc0, 73], [0, 0x90, 69, 110],
    ...(moving ? [[...vlq(480), 0xb0, 10, 127], [...vlq(480), 0x80, 69, 0]] : [[...vlq(960), 0x80, 69, 0]]), [0, 255, 47, 0]]);
}

export function midiTracks(tracks, division = 480) {
  const header = Buffer.from(midi([], division).subarray(0, 14));
  header.writeUInt16BE(tracks.length > 1 ? 1 : 0, 8);
  header.writeUInt16BE(tracks.length, 10);
  return new Uint8Array(Buffer.concat([header, ...tracks.map(events => Buffer.from(midi(events, division).subarray(14)))]));
}

export function smptePanned(frameCode = 25, ticksPerFrame = 40) {
  const ticksPerSecond = (frameCode === 29 ? 30 : frameCode) * ticksPerFrame;
  const quarter = ticksPerSecond / 4;
  return midiTracks([
    [[0, 255, 81, 3, 7, 161, 32], [...vlq(quarter), 255, 81, 3, 3, 208, 144],
      [...vlq(quarter * 2), 255, 81, 3, 30, 132, 128], [0, 255, 47, 0]],
    [[0, 0xb0, 10, 0], [0, 0xc0, 81], [...vlq(quarter), 0x90, 69, 110],
      [...vlq(quarter * 2), 0xb0, 10, 127], [...vlq(quarter * 2), 0x80, 69, 0], [0, 255, 47, 0]]
  ], ((256 - frameCode) << 8) | ticksPerFrame);
}
