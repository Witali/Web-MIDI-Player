// Public transport API. PCM synthesis remains in the Worker/WASM engine.
export class MidiPlayer extends EventTarget {
  constructor({ volume = 0.55, engine = 'soundfont', effects = true, soundfontUrl } = {}) {
    super();
    this.state = 'empty'; this.currentTime = 0; this.duration = 0;
    this.metadata = null; this._volume = 0.55; this.volume = volume;
    if (!['soundfont', 'z80'].includes(engine)) throw new TypeError('Unknown playback engine.');
    this._engine = engine; this._effects = effects;
    this._soundfontUrl = soundfontUrl ? new URL(soundfontUrl, globalThis.location?.href || import.meta.url).href : undefined;
    this._revision = 0; this._epoch = 0; this._sequence = 0; this._pending = new Map();
    this._wantsPlayback = false;
  }
  get volume() { return this._volume; }
  set volume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Volume must be between 0 and 1.');
    this._volume = value;
    this._gain?.gain.setTargetAtTime(value, this._context.currentTime, 0.01);
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _state(value) { this.state = value; this._emit('statechange', { state: value }); }
  _alive() { if (this.state === 'disposed') throw new Error('Player has been disposed.'); }
  _workerReady() {
    if (this._worker) return;
    this._worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = ({ data }) => {
      const pending = this._pending.get(data.id);
      if (pending) {
        this._pending.delete(data.id);
        data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
      } else if (data.type === 'error') this._failure(new Error(data.message));
    };
    this._worker.onerror = event => this._failure(new Error(event.message || 'Audio Worker failed.'));
  }
  _failure(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    this._context?.suspend().catch(() => {});
    this._state('error'); this._emit('error', error);
  }
  _call(type, data = {}, transfer = []) {
    this._workerReady(); const id = ++this._sequence;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try { this._worker.postMessage({ type, id, ...data }, transfer); }
      catch (error) { this._pending.delete(id); reject(error); }
    });
  }
  async load(source) {
    this._alive(); const revision = ++this._revision;
    this._wantsPlayback = false;
    this._epoch++; this.metadata = null; this.duration = this.currentTime = 0;
    this._state('loading');
    this._abort?.abort(); this._abort = new AbortController();
    const abort = this._abort;
    try {
      await this._context?.suspend();
      this._node?.port.postMessage({ type: 'reset', epoch: this._epoch, running: false });
      let bytes;
      if (typeof source === 'string' || source instanceof URL) {
        const response = await fetch(source, { signal: abort.signal });
        if (!response.ok) throw new Error(`MIDI download failed: HTTP ${response.status}.`);
        bytes = new Uint8Array(await response.arrayBuffer());
      } else if (source instanceof Blob) bytes = new Uint8Array(await source.arrayBuffer());
      else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source.slice(0));
      else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
      else throw new TypeError('Load a MIDI URL, File, Blob, ArrayBuffer or typed array.');
      if (revision !== this._revision) throw new DOMException('Superseded load.', 'AbortError');
      const metadata = await this._call('load', { bytes, epoch: this._epoch, engine: this._engine,
        effects: this._effects, soundfontUrl: this._soundfontUrl }, [bytes.buffer]);
      if (revision !== this._revision) throw new DOMException('Superseded load.', 'AbortError');
      this.metadata = metadata; this.duration = metadata.duration;
      this._state('ready'); this._emit('loaded', metadata); return metadata;
    } catch (error) {
      if (revision === this._revision) { this._state('error'); this._emit('error', error); }
      throw error;
    }
  }
  async _audio() {
    if (this._opening) return this._opening;
    this._opening = this._openAudio();
    try { return await this._opening; } finally { this._opening = null; }
  }
  async _openAudio() {
    if (this._context) return this._context.resume();
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio || !globalThis.AudioWorkletNode) throw new Error('Web Audio and AudioWorklet require HTTPS or localhost.');
    const context = this._context = new Audio({ sampleRate: 48000, latencyHint: 'interactive' });
    // Resume before awaiting module loading, while still in the user's gesture.
    const resumed = context.resume();
    await context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    await resumed;
    if (this.state === 'disposed') return;
    this._gain = context.createGain(); this._gain.gain.value = this.volume;
    this._node = new AudioWorkletNode(context, 'z80-midi-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const channel = new MessageChannel();
    this._node.port.postMessage({ type: 'connect', port: channel.port1 }, [channel.port1]);
    this._worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
    this._node.port.onmessage = ({ data }) => {
      if (data.epoch !== this._epoch || this.state === 'disposed') return;
      if (data.type === 'position' || data.type === 'ended') {
        this.currentTime = Math.min(this.duration, data.seconds);
        this._emit('timeupdate', { currentTime: this.currentTime, duration: this.duration, underruns: data.underruns });
      }
      if (data.type === 'ended') {
        this._wantsPlayback = false; this._state('ended'); context.suspend().catch(() => {}); this._emit('ended');
      }
    };
    this._node.connect(this._gain); this._gain.connect(context.destination);
  }
  async unlock() { this._alive(); this._workerReady(); await this._audio(); }
  async play() {
    this._alive();
    if (!this.metadata) throw new Error('Load a MIDI file before playing.');
    this._wantsPlayback = true;
    if (this.state === 'seeking') return;
    if (this.state === 'playing') return;
    const revision = this._revision, wasPaused = this.state === 'paused';
    await this._audio();
    if (revision !== this._revision || this.state === 'disposed') return;
    if (!wasPaused) {
      if (this.currentTime >= this.duration) this.currentTime = 0;
      const epoch = ++this._epoch;
      const result = await this._call('seek', { seconds: this.currentTime, epoch });
      if (epoch !== this._epoch || revision !== this._revision) return;
      this._node.port.postMessage({ type: 'reset', epoch, offset: result.seconds, running: true });
    }
    this._state('playing');
  }
  async pause() {
    this._alive();
    this._wantsPlayback = false;
    if (this.state !== 'playing') return;
    await this._context.suspend();
    if (this.state === 'playing') this._state('paused');
  }
  async seek(seconds) {
    this._alive();
    if (!this.metadata) throw new Error('Load a MIDI file before seeking.');
    if (!Number.isFinite(seconds)) throw new TypeError('Seek position must be finite.');
    const revision = this._revision, epoch = ++this._epoch;
    this._state('seeking');
    await this._context?.suspend();
    const result = await this._call('seek', { seconds: Math.max(0, Math.min(seconds, this.duration)), epoch });
    if (revision !== this._revision || epoch !== this._epoch) return;
    this.currentTime = result.seconds;
    this._node?.port.postMessage({ type: 'reset', epoch, offset: result.seconds, running: true });
    this._emit('timeupdate', { currentTime: this.currentTime, duration: this.duration });
    if (this._wantsPlayback) { await this._context?.resume(); this._state('playing'); }
    else this._state('ready');
  }
  async stop() {
    this._alive();
    if (!this.metadata) return;
    await this.pause(); await this.seek(0);
  }
  async dispose() {
    if (this.state === 'disposed') return;
    this._revision++; this._epoch++; this._wantsPlayback = false; this._abort?.abort();
    const error = new DOMException('Player disposed.', 'AbortError');
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear(); this._worker?.terminate(); this._worker = null;
    this._node?.disconnect(); this._node?.port.close(); this._gain?.disconnect();
    await this._context?.close(); this._context = null; this._node = null;
    this.metadata = null; this._state('disposed');
  }
}
