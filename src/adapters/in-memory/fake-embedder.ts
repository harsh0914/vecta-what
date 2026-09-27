import { Embedder } from '../../core/ports/embedder.js';

export class FakeEmbedder implements Embedder {
  public callCount = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount++;
    return texts.map((text) => this.generateDeterministicVector(text));
  }

  private generateDeterministicVector(text: string): number[] {
    const dim = 768;
    const vec = new Array(dim).fill(0);

    // Simple deterministic hash function to seed vector
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    // Populate dims using pseudo-random generator seeded by hashes
    let seed = (h1 ^ h2) >>> 0;
    let normSq = 0;

    for (let i = 0; i < dim; i++) {
      seed = (Math.imul(1103515245, seed) + 12345) & 0x7fffffff;
      const val = (seed / 0x7fffffff) * 2 - 1;
      vec[i] = val;
      normSq += val * val;
    }

    // Normalize to unit length (L2 norm = 1)
    const norm = Math.sqrt(normSq);
    for (let i = 0; i < dim; i++) {
      vec[i] = vec[i] / norm;
    }

    return vec;
  }
}
