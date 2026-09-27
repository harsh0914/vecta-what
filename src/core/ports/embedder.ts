export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}
