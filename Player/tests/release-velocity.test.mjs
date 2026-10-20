import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { BasicMIDI, GeneratorTypes, SoundBankLoader, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from '../vendor/spessasynth.js';
import { installVoiceDSP } from '../voice-dsp.js';
import { installReleaseVelocityProfiles, normalizeReleaseVelocityProfiles } from '../release-velocity.js';
import { createSoundFontPreview } from '../soundfont-preview.js';
import { BrowserSoundBank } from '../lazy-bank.js';
import { MidiPlayer } from '../index.js';
import { midi, midiTracks, vlq } from './fixtures.mjs';
SpessaLog.setLogLevel(false, false, false);
const bytes = fs.readFileSync(new URL('../soundfonts/FluidR3_GM.sf2', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const curve = n => Array(128).fill(n);
const varying = Array.from({ length: 128 }, (_, velocity) => velocity < 64 ? 1200 : velocity === 64 ? 0 : -1200);
const profile = { program: 81, volumeRelease: varying, modulationRelease: varying };
const active = (s, key = 60, channel = 0) => s.synthCore.voices.filter(v => v.isActive && v.channel === channel && v.midiNote === key);
async function synth(dsp = 'js', profiles = [profile]) {
  const s = new SpessaSynthProcessor(48000, { effectsEnabled: false, eventsEnabled: true, maxBufferSize: 128 });
  s.onMissingPreset = (patch, system) => bank.getPreset(patch, system);
  s.soundBankManager.addSoundBank(bank, 'main'); await s.processorInitialized;
  s.setSystemParameter('blackMIDIMode', false); s.setSystemParameter('monophonicRetrigger', false);
  s.programChange(0, 81); installReleaseVelocityProfiles(s, profiles);
  for (const ch of s.midiChannels) for (const [type, value] of [
    [GeneratorTypes.delayVolEnv, -12000], [GeneratorTypes.attackVolEnv, -12000], [GeneratorTypes.holdVolEnv, -12000],
    [GeneratorTypes.decayVolEnv, -12000], [GeneratorTypes.sustainVolEnv, 0], [GeneratorTypes.releaseVolEnv, 0],
    [GeneratorTypes.delayModEnv, -12000], [GeneratorTypes.attackModEnv, -12000], [GeneratorTypes.holdModEnv, -12000],
    [GeneratorTypes.decayModEnv, -12000], [GeneratorTypes.sustainModEnv, 0], [GeneratorTypes.releaseModEnv, 0],
    [GeneratorTypes.modEnvToPitch, 1200]
  ]) ch.setGeneratorOverride(type, value);
  if (dsp !== 'js') await installVoiceDSP(s, dsp); return s;
}
function render(s, count = 1) {
  const pcm = [new Float32Array(count * 128), new Float32Array(count * 128)];
  for (let n = 0; n < count; n++) s.process(pcm[0], pcm[1], n * 128, 128);
  return pcm;
}
const loader = () => new BrowserSoundBank(undefined, { fetcher: async url => new Response(fs.readFileSync(fileURLToPath(url))) });
const end = [0, 255, 47, 0];
const score = velocity => midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(480), 0x80, 60, velocity], [...vlq(960), 255, 47, 0]]);

test('all 128 explicit release velocities reach their own voice, while omitted and zero-Note-On releases use 64', async () => {
  const s = await synth();
  try {
    const events = []; s.onEventCall = e => { if (e.type === 'noteOff') events.push(e.data.velocity); };
    for (let velocity = 0; velocity < 128; velocity++) {
      s.noteOn(0, 60, 100); const group = active(s).filter(v => v.keyDown); render(s, 2);
      s.noteOff(0, 60, velocity); assert.ok(group.length);
      assert.ok(group.every(v => v.releaseVelocity === velocity && v.velocity === 100));
      s.controllerChange(0, 120, 0);
    }
    assert.deepEqual(events, Array.from({ length: 128 }, (_, i) => i));
    s.noteOn(0, 60, 100); render(s, 2); s.noteOn(0, 60, 0); assert.equal(events.at(-1), 64);
    assert.ok(active(s).every(v => v.releaseVelocity === 64));
    s.noteOn(0, 67, 100); s.noteOff(0, 67); assert.equal(events.at(-1), 64);
    s.noteOn(0, 72, 100); const ch = s.midiChannels[0], owed = ch.noteOffID[72];
    for (const bad of [-1, 128, 1.2, NaN]) assert.throws(() => s.noteOff(0, 72, bad), RangeError);
    assert.equal(ch.noteOffID[72], owed); assert.ok(active(s, 72).every(v => v.keyDown));
    s.controllerChange(0, 123, 0); assert.equal(events.at(-1), 64);
  } finally { s.stopAllChannels(true); }
});

test('SMF, timed ports, F7 running status, raw queued messages and custom receive channels preserve the velocity byte', async () => {
  const s = await synth();
  try {
    const events = []; s.onEventCall = e => { if (e.type === 'noteOff') events.push([e.data.channel, e.data.midiNote, e.data.velocity]); };
    const data = midiTracks([
      [[0, 0xc0, 81], [0, 0x90, 60, 100], [0, 0x90, 65, 100], [12, 0x80, 60, 0], [0, 0xf7, 2, 65, 77],
       [0, 0x90, 64, 100], [12, 0xf7, 3, 0x80, 64, 127],
       [0, 0x90, 67, 100], [12, 0x90, 67, 0], end],
      [[0, 255, 33, 1, 1], [0, 0xc0, 81], [0, 0x90, 72, 100], [12, 0xf7, 3, 0x80, 72, 33], end]
    ]);
    const sequence = new SpessaSynthSequencer(s); sequence.preload = sequence.skipToFirstNoteOn = false;
    sequence.loopCount = 0; sequence.loadNewSongList([BasicMIDI.fromArrayBuffer(data.buffer)]); sequence.play();
    for (let i = 0; !sequence.isFinished; i++) { assert.ok(i < 100); sequence.processTick(); render(s); }
    assert.deepEqual(events, [[0, 60, 0], [0, 65, 77], [16, 72, 33], [0, 64, 127], [0, 67, 64]]);
    s.noteOn(0, 60, 100); const beforeQueued = events.length;
    s.processMessage(new Uint8Array([0x80, 60, 19]), 0, { time: s.currentTime + .01 });
    render(s); assert.equal(events.length, beforeQueued); assert.ok(active(s).some(v => v.keyDown));
    render(s, 4); assert.equal(events.at(-1)[2], 19);
    s.midiChannels[1].setMIDIParameter('rxChannel', 0); s.synthCore.customChannelNumbers = true;
    s.noteOn(0, 60, 100); s.noteOff(0, 60, 90);
    assert.deepEqual(events.slice(-2), [[0, 60, 90], [1, 60, 90]]);
    const outgoing = []; sequence.externalMIDIPlayback = true; sequence.sendMIDIMessage = message => outgoing.push(message);
    sequence.sendMIDINoteOff(0, 60, 127); sequence.sendMIDINoteOff(0, 60);
    assert.deepEqual(outgoing, [[0x80, 60, 127], [0x80, 60, 64]]);
  } finally { s.stopAllChannels(true); }
});

test('repeated notes retain independent release velocities across sustain, sostenuto, CC123 and reset', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const s = await synth(dsp);
    try {
      s.noteOn(0, 60, 100); render(s, 10); s.controllerChange(0, 66, 127); s.controllerChange(0, 64, 127);
      const first = active(s); s.noteOn(0, 60, 100); render(s, 10); const second = active(s).filter(v => !first.includes(v));
      s.noteOff(0, 60, 12); s.noteOff(0, 60, 110); s.controllerChange(0, 123, 0); render(s, 2);
      assert.ok(first.every(v => v.isHeld && v.releaseVelocity === 12)); assert.ok(second.every(v => v.isHeld && v.releaseVelocity === 110));
      s.controllerChange(0, 64, 0); render(s); assert.ok(first.every(v => !v.isInRelease));
      assert.ok(second.every(v => v.isInRelease && Math.abs(v.volEnv.releaseDuration - 24000) < 1));
      s.controllerChange(0, 121, 0); render(s); assert.ok(first.every(v => v.isInRelease && Math.abs(v.volEnv.releaseDuration - 96000) < 1));
      assert.ok(first.every(v => v.releaseVelocity === 12)); assert.ok(second.every(v => v.releaseVelocity === 110));
    } finally { s.stopAllChannels(true); }
  }
});

test('Hold 2 defers release using the stored velocity, and freezing an ongoing release never reapplies the response', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const s = await synth(dsp);
    try {
      s.noteOn(0, 60, 100); render(s, 10); const group = active(s);
      s.controllerChange(0, 69, 127); s.noteOff(0, 60, 127); render(s, 20);
      assert.ok(group.every(v => !v.isInRelease && v.releaseVelocity === 127));
      s.controllerChange(0, 69, 0); render(s, 2);
      assert.ok(group.every(v => v.isInRelease && Math.abs(v.volEnv.releaseDuration - 24000) < 1));
      const durations = group.map(v => v.volEnv.releaseDuration); s.controllerChange(0, 69, 127); render(s, 20); s.controllerChange(0, 69, 0); render(s);
      group.forEach((v, i) => assert.equal(v.volEnv.releaseDuration, durations[i]));
    } finally { s.stopAllChannels(true); }
  }
});

test('each voice retains its started instrument response through program changes, cached attacks and monophonic legato', async () => {
  const s = await synth('js', [{ program: 81, volumeRelease: curve(1200) }, { program: 73, volumeRelease: curve(-1200) }]);
  try {
    s.noteOn(0, 60, 100); render(s, 10); const old = active(s);
    s.programChange(0, 73); s.noteOn(0, 60, 100); render(s, 10); const fresh = active(s).filter(v => !old.includes(v));
    s.noteOff(0, 60, 0); render(s); assert.ok(old.every(v => v.volEnv.releaseDuration === 96000)); assert.ok(fresh.every(v => v.keyDown));
    s.noteOff(0, 60, 127); render(s); assert.ok(fresh.every(v => v.volEnv.releaseDuration === 24000));
    s.stopAllChannels(true); s.programChange(0, 81); s.controllerChange(0, 68, 127); s.noteOn(0, 60, 100); render(s, 10);
    const legato = active(s); s.programChange(0, 73); s.noteOn(0, 72, 100); s.noteOff(0, 72, 127); render(s);
    assert.ok(legato.every(v => v.midiNote === 60 && v.keyDown && !v.isInRelease));
    s.noteOff(0, 60, 5); render(s); assert.ok(legato.every(v => v.releaseVelocity === 5 && v.volEnv.releaseDuration === 96000));
    s.controllerChange(0, 68, 0); s.stopAllChannels(true); s.programChange(0, 81); s.noteOn(0, 60, 100); render(s, 10);
    const retained = active(s); installReleaseVelocityProfiles(s, [{ program: 81, volumeRelease: curve(-1200) }]);
    s.noteOn(0, 60, 100); render(s, 10); const changed = active(s).filter(v => !retained.includes(v));
    s.noteOff(0, 60, 64); s.noteOff(0, 60, 64); render(s);
    assert.ok(retained.every(v => v.volEnv.releaseDuration === 96000)); assert.ok(changed.every(v => v.volEnv.releaseDuration === 24000));
    s.stopAllChannels(true); s.controllerChange(0, 0, 119); s.programChange(0, 81);
    assert.equal(s.midiChannels[0].preset.bankMSB, 0, 'Fallback selects an actual bank-zero preset');
    s.noteOn(0, 60, 100); render(s, 10); const fallback = active(s); s.noteOff(0, 60, 64); render(s);
    assert.ok(fallback.every(v => v.volEnv.releaseDuration === 24000), 'Profiles match the actual fallback preset, not requested bank 119');
  } finally { s.stopAllChannels(true); }
});

test('CC120 and forced drum release retain owed key identities; exclusive choke and fast release override velocity profiles', async () => {
  const s = await synth('js', [{ program: 0, percussion: true, volumeRelease: curve(12000) }]);
  try {
    s.midiChannels[9].drumParams[36].rxNoteOff = true;
    s.noteOn(9, 36, 100); render(s, 2); s.controllerChange(9, 120, 0); s.noteOn(9, 36, 100); render(s, 2);
    const current = active(s, 36, 9); assert.ok(current.every(v => v.releaseVelocityProfile?.volumeRelease[0] === 12000)); s.noteOff(9, 36, 7); render(s);
    assert.ok(current.every(v => v.keyDown && !v.isInRelease && v.releaseVelocity === 64));
    s.noteOff(9, 36, 31); render(s); assert.ok(current.every(v => v.releaseVelocity === 31 && v.isInRelease && v.volEnv.releaseDuration <= 750));
    s.noteOn(9, 46, 100); render(s, 2); const hat = active(s, 46, 9); s.noteOn(9, 42, 100); render(s);
    const plain = await synth('js', []);
    try {
      plain.noteOn(9, 46, 100); render(plain, 2); const baseline = active(plain, 46, 9); plain.noteOn(9, 42, 100); render(plain);
      assert.ok(hat.every(v => !v.isActive || v.isInRelease));
      assert.deepEqual(hat.map(v => v.volEnv.releaseDuration), baseline.map(v => v.volEnv.releaseDuration));
    } finally { plain.stopAllChannels(true); }
  } finally { s.stopAllChannels(true); }
});

test('ordinary SF2 audio is bit-identical for varied release velocities and Note On zero equals Note Off 64 on all DSPs', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    let reference;
    for (const velocity of [0, 1, 32, 64, 100, 127]) {
      const preview = await createSoundFontPreview(score(velocity), bank, { effects: true, dsp });
      try { const pcm = preview.read(96000); if (!reference) reference = pcm; else assert.deepEqual(pcm, reference); }
      finally { preview.close(); }
    }
    const zero = midi([[0, 0xc0, 81], [0, 0x90, 60, 100], [...vlq(480), 0x90, 60, 0], [...vlq(960), 255, 47, 0]]);
    for (const bytes of [score(64), zero]) {
      const p = await createSoundFontPreview(bytes, bank, { effects: false, dsp, releaseVelocityProfiles: [profile] });
      try { const pcm = p.read(96000); if (bytes === zero) assert.deepEqual(pcm, reference); else reference = pcm; }
      finally { p.close(); }
    }
  }
});

test('opt-in volume and modulation release audio matches an independent generator change, without replacing attack velocity', async () => {
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const a = await synth(dsp, [{ program: 81, volumeRelease: curve(1200), modulationRelease: curve(600) }]);
    const b = await synth(dsp, []);
    b.midiChannels[0].setGeneratorOverride(GeneratorTypes.releaseVolEnv, 1200);
    b.midiChannels[0].setGeneratorOverride(GeneratorTypes.releaseModEnv, 600);
    try {
      a.noteOn(0, 60, 100); b.noteOn(0, 60, 100); assert.deepEqual(render(a, 100), render(b, 100));
      a.noteOff(0, 60, 127); b.noteOff(0, 60, 64);
      assert.deepEqual(render(a, 300), render(b, 300));
      assert.ok(active(a).every(v => v.velocity === 100 && v.releaseVelocity === 127));
    } finally { a.stopAllChannels(true); b.stopAllChannels(true); }
  }
});

test('profiled PCM and exact seeking agree across selective JS/WASM/SIMD playback', async () => {
  const bytes = score(127), prepared = await loader().load(bytes);
  let reference;
  for (const dsp of ['js', 'wasm', 'wasm-simd']) {
    const p = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: true, dsp, releaseVelocityProfiles: [profile] });
    try {
      const pcm = p.read(144000); if (!reference) reference = pcm; else assert.deepEqual(pcm, reference);
      for (const time of [.23, .503, .71, 1.19, .01]) { await p.seek(time); const at = Math.round(time * 48000); assert.deepEqual(p.read(1024), reference.map(c => c.slice(at, at + 1024))); }
    } finally { p.close(); }
  }
  const plain = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: true, dsp: 'js' });
  try { const pcm = plain.read(144000); assert.deepEqual(reference.map(c => c.slice(0, 24000)), pcm.map(c => c.slice(0, 24000))); assert.notDeepEqual(reference, pcm); }
  finally { plain.close(); }
});

test('public Worker passes serializable instrument profiles through selective loading, audio reads and seeking', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url)), channel = new MessageChannel(); let id = 0;
  const call = async (type, data) => { const pending = once(worker, 'message'); worker.postMessage({ type, id: ++id, ...data }); const reply = (await pending)[0]; assert.equal(reply.error, undefined); return reply.result; };
  const bytes = score(127), prepared = await loader().load(bytes);
  const reference = await createSoundFontPreview(bytes, prepared.bank, { prepared, effects: false, dsp: 'wasm', releaseVelocityProfiles: [profile] });
  try {
    const loaded = await call('load', { bytes, epoch: 1, effects: false, dsp: 'wasm', releaseVelocityProfiles: [profile] }); assert.equal(loaded.sampleBank.mode, 'samples');
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    await call('seek', { seconds: .71, epoch: 2 }); await reference.seek(.71);
    const pending = once(channel.port1, 'message'); channel.port1.postMessage({ type: 'read', epoch: 2 });
    assert.deepEqual((await pending)[0].channels, reference.read(2048));
  } finally { reference.close(); channel.port1.close(); await worker.terminate(); }
});

test('profile validation rejects malformed curves and ambiguous patches and snapshots caller-owned settings', () => {
  for (const profiles of [null, {}, Array(1), [null], [{ program: 128, volumeRelease: curve(0) }], [{ program: 0 }],
    [{ program: 0, volumeRelease: [] }], [{ program: 0, volumeRelease: Array(128) }],
    [{ program: 0, volumeRelease: curve(Infinity) }], [{ program: 0, volumeRelease: curve(12001) }],
    [{ program: 0, percussion: 1, volumeRelease: curve(0) }], [profile, profile]])
    assert.throws(() => normalizeReleaseVelocityProfiles(profiles));
  const input = { program: 81, volumeRelease: curve(1200) }, player = new MidiPlayer({ releaseVelocityProfiles: [input] });
  input.volumeRelease[0] = -1200; assert.equal(player._releaseVelocityProfiles[0].volumeRelease[0], 1200);
  assert.throws(() => new MidiPlayer({ engine: 'z80', releaseVelocityProfiles: [profile] }), /SoundFont/);
});
