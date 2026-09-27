import { Embedder } from '../../core/ports/embedder.js';
import { getVertexGenAIClient, getEmbeddingModelName } from './gemini-client.js';

export class GeminiEmbedder implements Embedder {
  private client = getVertexGenAIClient();
  private model: string;

  constructor(model = 'gemini-embedding-001') {
    this.model = getEmbeddingModelName(model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];

    const results: number[][] = [];
    for (const text of texts) {
      const response = await this.client.models.embedContent({
        model: this.model,
        contents: text,
        config: {
          outputDimensionality: 768,
        },
      });

      const vector = response.embedding?.values || [];
      results.push(vector);
    }
    return results;
  }
}
