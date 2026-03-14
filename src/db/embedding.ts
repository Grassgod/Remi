/**
 * Voyage AI embedding client.
 * Uses native fetch, no external deps.
 */

export interface EmbeddingConfig {
  provider: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
}

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3.5-lite";
const DEFAULT_DIMENSIONS = 1024;
const MAX_RETRIES = 1;

/**
 * Generate embeddings for a list of texts using Voyage AI.
 * Returns empty array if no API key is configured.
 */
export async function embed(
  texts: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  if (!config.apiKey || texts.length === 0) return [];

  const model = config.model ?? DEFAULT_MODEL;
  const body = {
    model,
    input: texts,
    input_type: "document" as const,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (attempt < MAX_RETRIES && res.status >= 500) continue;
        throw new Error(`Voyage API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data.map((d) => d.embedding);
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      throw err;
    }
  }

  return [];
}

/**
 * Generate embedding for a single query text (uses "query" input_type for better retrieval).
 */
export async function embedQuery(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  if (!config.apiKey || !text) return [];

  const model = config.model ?? DEFAULT_MODEL;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: [text],
          input_type: "query",
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (attempt < MAX_RETRIES && res.status >= 500) continue;
        throw new Error(`Voyage API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data[0]?.embedding ?? [];
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      throw err;
    }
  }

  return [];
}
