// Slot order fixes both first-free allocation and floating-point mix order.
export class OrderedVoicePool {
  constructor(voices) {
    this.voices = voices;
    this.active = [];
    this.free = [];
    this.dirty = false;
  }
  add(voice) {
    voice.poolIndex = this.voices.length - 1;
    voice.poolFree = true;
    voice.poolListed = false;
    // New slots exceed every existing index, so append preserves the heap.
    this.free.push(voice.poolIndex);
  }
  push(index) {
    const heap = this.free;
    let at = heap.length;
    heap.push(index);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (heap[parent] <= index) break;
      heap[at] = heap[parent]; at = parent;
    }
    heap[at] = index;
  }
  pop() {
    const heap = this.free, first = heap[0], last = heap.pop();
    if (heap.length) {
      let at = 0;
      while (at * 2 + 1 < heap.length) {
        let child = at * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
        if (heap[child] >= last) break;
        heap[at] = heap[child]; at = child;
      }
      heap[at] = last;
    }
    return first;
  }
  take(cap) {
    if (!this.free.length || this.free[0] >= cap) return;
    const voice = this.voices[this.pop()];
    voice.poolFree = false;
    // A killed slot may be reused before the next list compaction.
    if (!voice.poolListed) {
      let lo = 0, hi = this.active.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.active[mid].poolIndex < voice.poolIndex) lo = mid + 1;
        else hi = mid;
      }
      this.active.splice(lo, 0, voice); voice.poolListed = true;
    }
    return voice;
  }
  retire(voice) {
    voice.isActive = false;
    if (!voice.poolFree) { voice.poolFree = true; this.push(voice.poolIndex); }
    if (voice.poolListed) this.dirty = true;
  }
  prune() {
    if (!this.dirty) return;
    let kept = 0;
    for (let at = 0; at < this.active.length; at++) {
      const voice = this.active[at];
      if (voice.isActive) { if (kept !== at) this.active[kept] = voice; kept++; }
      else { voice.poolListed = false; this.retire(voice); }
    }
    this.active.length = kept; this.dirty = false;
  }
  rebuild() {
    // Cold path for explicit caps and checkpoint restoration after pool growth.
    this.active.length = this.free.length = 0; this.dirty = false;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      voice.poolIndex = i; voice.poolFree = !voice.isActive; voice.poolListed = voice.isActive;
      if (voice.isActive) this.active.push(voice); else this.free.push(i);
    }
  }
  clear() { this.active.length = this.free.length = 0; this.dirty = false; }
}
