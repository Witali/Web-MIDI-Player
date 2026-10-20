// W3C Web MIDI, sections 4 and 5. No permission request or port selection on import.
const emit = (target, type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
const abort = () => new DOMException('MIDI operation superseded.', 'AbortError');
const description = port => port ? Object.fromEntries(['id', 'name', 'manufacturer', 'version', 'type', 'state', 'connection'].map(k => [k, port[k]])) : null;
const realtime = new Set([0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff]);

// Validate complete wire messages, never SMF records or running status. Realtime
// bytes may interrupt another message without consuming one of its data bytes.
export function midiMessages(input) {
  if (!input || typeof input[Symbol.iterator] !== 'function') throw new TypeError('Expected MIDI bytes.');
  const values = [...input];
  if (!values.length || values.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new TypeError('Expected nonempty MIDI bytes (0–255).');
  const messages = []; let message = [], left = 0, sysex = false;
  for (const byte of values) {
    if (realtime.has(byte)) { messages.push(Uint8Array.of(byte)); continue; }
    if (sysex) {
      if (byte === 0xf7) { message.push(byte); messages.push(Uint8Array.from(message)); message = []; sysex = false; }
      else if (byte < 128) message.push(byte);
      else throw new TypeError('Invalid status inside SysEx.');
    } else if (left) {
      if (byte >= 128) throw new TypeError('Incomplete MIDI message.');
      message.push(byte);
      if (!--left) { messages.push(Uint8Array.from(message)); message = []; }
    } else {
      if (byte < 128) throw new TypeError('Running status is not supported by Web MIDI.');
      if (byte === 0xf0) { sysex = true; message = [byte]; }
      else if (byte === 0xf6) messages.push(Uint8Array.of(byte));
      else {
        left = byte < 0xf0 ? ([0xc, 0xd].includes(byte >> 4) ? 1 : 2) : ({241:1, 242:2, 243:1}[byte] ?? 0);
        if (!left) throw new TypeError('Undefined or unexpected MIDI status.');
        message = [byte];
      }
    }
  }
  if (left || sysex) throw new TypeError('Incomplete MIDI message.');
  return { data: Uint8Array.from(values), messages, sysex: messages.some(m => m[0] === 0xf0) };
}

export class WebMidiPorts extends EventTarget {
  constructor({ navigator = globalThis.navigator } = {}) {
    super(); this.navigator = navigator; this.access = null; this.input = this.output = null;
    this.thru = false; this.state = 'idle'; this._request = this._inputVersion = this._outputVersion = 0;
    this._usedChannels = new Set(); this._opening = new Set(); this._portJobs = new Map();
    this._statechange = () => this._refresh();
    this._message = event => {
      if (this.state === 'disposed' || event.target !== this.input) return;
      const data = new Uint8Array(event.data), timestamp = event.timeStamp;
      if (this.thru && this.output) {
        try { this.send(data, timestamp); } catch (error) { emit(this, 'error', error); }
      }
      emit(this, 'midimessage', { data, timestamp, port: description(this.input) });
    };
  }
  get supported() { return typeof this.navigator?.requestMIDIAccess === 'function'; }
  get sysexEnabled() { return this.access?.sysexEnabled ?? false; }
  get ports() { return { inputs: [...(this.access?.inputs.values() ?? [])].map(description), outputs: [...(this.access?.outputs.values() ?? [])].map(description) }; }
  get selection() { return { input: description(this.input), output: description(this.output) }; }
  _alive() { if (this.state === 'disposed') throw new Error('MIDI ports disposed.'); }
  async request({ sysex = false, software = false } = {}) {
    this._alive();
    if (!this.supported) throw new Error('Web MIDI requires a supporting browser on HTTPS or localhost.');
    const revision = ++this._request;
    this.state = 'requesting'; emit(this, 'statechange', this.state);
    try {
      const access = await this.navigator.requestMIDIAccess({ sysex: !!sysex, software: !!software });
      if (revision !== this._request || this.state === 'disposed') throw abort();
      // Re-requesting permissions does not choose or reopen any device.
      await this.selectInput(null);
      if (revision !== this._request || this.state === 'disposed') throw abort();
      await this.selectOutput(null);
      if (revision !== this._request || this.state === 'disposed') throw abort();
      this.access?.removeEventListener('statechange', this._statechange);
      this.access = access; access.addEventListener('statechange', this._statechange);
      this.state = 'ready'; this._refresh(); emit(this, 'statechange', this.state); return this.ports;
    } catch (error) {
      if (revision === this._request && this.state !== 'disposed') { this.state = this.access ? 'ready' : 'idle'; emit(this, 'statechange', this.state); }
      throw error;
    }
  }
  _refresh() {
    for (const kind of ['input', 'output']) {
      const port = this[kind], map = this.access[kind + 's'];
      if (port && (port.state !== 'connected' || map.get(port.id) !== port)) {
        this['_' + kind + 'Version']++;
        this._detach(kind); // A reconnected device must be selected explicitly again.
      }
    }
    emit(this, 'portschange', this.ports);
  }
  _operation(port, kind) {
    const job = (this._portJobs.get(port) ?? Promise.resolve()).catch(() => {}).then(() => port[kind]());
    this._portJobs.set(port, job);
    job.finally(() => { if(this._portJobs.get(port) === job)this._portJobs.delete(port); }).catch(() => {});
    return job;
  }
  _detach(kind) {
    const port = this[kind]; if (!port) return Promise.resolve();
    if (kind === 'input') port.removeEventListener('midimessage', this._message);
    else { try { this._silence(port, false); } catch (error) { emit(this, 'error', error); } }
    this[kind] = null; emit(this, kind + 'change', { previous: description(port), port: null });
    return this._operation(port, 'close').catch(error => { emit(this, 'error', error); });
  }
  async _select(kind, id) {
    this._alive();
    const versionKey = '_' + kind + 'Version', version = ++this[versionKey];
    if (id == null || id === '') { await this._detach(kind); return null; }
    if (!this.access) throw new Error('Request MIDI access before choosing a port.');
    const port = this.access[kind + 's'].get(id);
    if (!port || port.state !== 'connected') throw new Error('MIDI port is not connected.');
    if (port === this[kind]) return description(port);
    const opening = { kind, port }; this._opening.add(opening);
    try {
      await this._operation(port, 'open');
      if (version !== this[versionKey] || this.state === 'disposed' || port.state !== 'connected' || this.access[kind + 's'].get(id) !== port) throw abort();
      await this._detach(kind);
      if (version !== this[versionKey] || this.state === 'disposed' || port.state !== 'connected') throw abort();
      this[kind] = port;
      if (kind === 'input') port.addEventListener('midimessage', this._message);
      emit(this, kind + 'change', { previous: null, port: description(port) }); return description(port);
    } finally {
      this._opening.delete(opening);
      // A superseded open cannot close the same port selected by a newer call.
      if (port !== this[kind] && ![...this._opening].some(o => o.port === port)) await this._operation(port, 'close').catch(() => {});
    }
  }
  selectInput(id) { return this._select('input', id); }
  selectOutput(id) { return this._select('output', id); }
  send(input, timestamp = 0) {
    this._alive();
    if (!this.output) throw new Error('Select a MIDI output port first.');
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new RangeError('MIDI timestamp must be nonnegative milliseconds.');
    const { data, messages, sysex } = midiMessages(input);
    if (sysex && !this.sysexEnabled) throw new DOMException('Request SysEx permission before sending SysEx.', 'InvalidAccessError');
    this.output.send(data, timestamp);
    for (const message of messages) if (message[0] < 0xf0) this._usedChannels.add(message[0] & 15);
    emit(this, 'midisend', { data, timestamp, port: description(this.output) });
  }
  clearOutput() { this._alive(); this.output?.clear(); }
  _silence(port, all) {
    port.clear();
    const channels = all ? Array.from({ length: 16 }, (_, i) => i) : [...this._usedChannels];
    this._usedChannels.clear();
    if (port.state !== 'connected') return;
    for (const channel of channels) for (const cc of [64, 66, 69, 120]) port.send([0xb0 | channel, cc, 0]);
  }
  panic() { this._alive(); if (this.output) this._silence(this.output, true); }
  async dispose() {
    if (this.state === 'disposed') return;
    this.state = 'disposed'; this._request++; this._inputVersion++; this._outputVersion++;
    this.access?.removeEventListener('statechange', this._statechange);
    await this._detach('input'); await this._detach('output'); this.access = null;
    emit(this, 'statechange', this.state);
  }
}
