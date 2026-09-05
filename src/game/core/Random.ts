// Deterministic seeded PRNG (mulberry32) used by city generation and AI. Track P0.
export class Random {
  readonly seed: number;
  private s: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = this.seed | 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Independent child generator seeded from this stream. */
  fork(): Random {
    return new Random(Math.floor(this.next() * 4294967295));
  }
}
