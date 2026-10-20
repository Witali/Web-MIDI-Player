// Ordinary fields keep pending values/head state visible to checkpoints.
// Consumed references are released immediately; compaction is amortized.
export class FIFOQueue {
  items = [];
  head = 0;
  length = 0;
  push(value) { this.items.push(value); return ++this.length; }
  peek() { return this.items[this.head]; }
  take() {
    if (!this.length) return undefined;
    const value = this.items[this.head];
    this.items[this.head++] = undefined; this.length--;
    if (!this.length) this.clear();
    else if (this.head >= 1024 && this.head * 2 >= this.items.length) this.compact();
    return value;
  }
  clear() { this.items.length = 0; this.head = 0; this.length = 0; }
  compact() {
    if (!this.head) return;
    const remaining = this.length;
    this.items.copyWithin(0, this.head); this.items.length = remaining; this.head = 0;
  }
  *[Symbol.iterator]() { for (let i = this.head; i < this.items.length; i++) yield this.items[i]; }
}

// The common monotonic stream only appends and advances the head. A disordered
// burst is stably sorted once when observed, preserving arrival order on ties.
export class TimedEventQueue extends FIFOQueue {
  sorted = true;
  push(value) {
    if (this.length && this.items.at(-1).time - value.time > 0) this.sorted = false;
    return super.push(value);
  }
  order() {
    if (this.sorted) return;
    this.compact(); this.items.sort((a, b) => a.time - b.time); this.sorted = true;
  }
  peek() { this.order(); return super.peek(); }
  take() { this.order(); return super.take(); }
  clear() { super.clear(); this.sorted = true; }
  *[Symbol.iterator]() { this.order(); yield* super[Symbol.iterator](); }
}
