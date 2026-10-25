// Deterministic pseudo random helpers. Only integer/IEEE-exact operations are used so
// results are identical in every JS engine.

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 step: returns [nextState, value in [0,1)] */
export function rngNext(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [s, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

/** Stateful generator used by map generation (not stored in game state). */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    const [s, v] = rngNext(this.state);
    this.state = s;
    return v;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  pick<T>(arr: T[]): T { return arr[this.int(arr.length)]; }
}

/** Hash of integer coordinates -> [0,1) (used for value noise). */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number { return t * t * (3 - 2 * t); }

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** FNV-style incremental hasher for state checksums. */
export class Hasher {
  h = 0x811c9dc5;
  int(v: number): void {
    v = v | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= (v >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  num(v: number): void {
    // quantize floats; positions are deterministic so exact quantization is stable
    this.int(Math.round(v * 1024));
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  hex(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}
