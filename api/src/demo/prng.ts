// Gerador de números pseudoaleatórios com semente (mulberry32): a mesma semente dá sempre a mesma sequência (#349).

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Um número em [0, 1). (#349) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Um inteiro em [low, high], os dois inclusos. (#349) */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  float(low: number, high: number): number {
    return low + this.next() * (high - low);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new RangeError('Rng.pick: lista vazia');
    return item;
  }

  /** `count` itens distintos da lista, em ordem sorteada. (#349) */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  }
}
