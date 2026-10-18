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
