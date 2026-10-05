const EMBEDDING_NAME_PATTERNS = [
  /embed(?:ding)?/iu,
  /(?:^|[-_/.])(?:bge|e5|gte|m3e)(?:$|[-_/.]|\d)/iu,
  /(?:^|[-_/.])(?:jina[-_]?embeddings|nomic[-_]?embed|sentence[-_]?transformers?)(?:$|[-_/.])/iu,
];

const NON_EMBEDDING_NAME_PATTERNS = [
  /(?:^|[-_/.])(?:rerank|ranker|cross[-_]?encoder)(?:$|[-_/.])/iu,
  /(?:image|vision|\bvl\b|chat|instruct|coder|completion|reason)/iu,
];

/**
 * OpenAI-compatible /models only guarantees model names, so the client cannot
 * ask every provider for a reliable task type. Keep only names that clearly
 * indicate embedding/vector usage and leave unknown names to the custom input.
 */
export function selectEmbeddingModelNames(models: string[], presets: string[] = []): string[] {
  const presetNames = new Set(presets.map((model) => model.trim().toLocaleLowerCase()).filter(Boolean));
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)))
    .filter((model) => {
      const normalized = model.toLocaleLowerCase();
      if (NON_EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(model))) return false;
      return presetNames.has(normalized) || EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(model));
    });
}
