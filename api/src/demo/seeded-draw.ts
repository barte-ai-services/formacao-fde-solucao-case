// #363 Sorteio determinístico da demonstração: a mesma semente e a mesma chave dão sempre o mesmo valor.
// Sem fonte de aleatoriedade do ambiente: o hash FNV-1a de `semente:id:propósito` alimenta um mulberry32.

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Devolve um gerador em [0, 1) fixo por semente, id e propósito. */
export function seededRandom(seed: string, id: string, purpose: string): () => number {
  let state = fnv1a(`${seed}:${id}:${purpose}`);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inteiro em [min, max], os dois inclusos, fixo por semente, id e propósito. */
export function seededInt(seed: string, id: string, purpose: string, min: number, max: number): number {
  return min + Math.floor(seededRandom(seed, id, purpose)() * (max - min + 1));
}
