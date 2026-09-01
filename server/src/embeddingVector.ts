export class EmbeddingVectorValidationError extends Error {
  constructor() {
    super("embedding vector is not a usable float32 vector");
    this.name = "EmbeddingVectorValidationError";
  }
}

/** Normalize provider numbers exactly as LanceDB's float32 storage boundary does. */
export function normalizeEmbeddingVectorValues(value: unknown): number[] {
  if (!(Array.isArray(value) || value instanceof Float32Array) || value.length < 1) {
    throw new EmbeddingVectorValidationError();
  }
  let normSquared = 0;
  const normalized = Array.from(value, (coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new EmbeddingVectorValidationError();
    }
    const stored = Math.fround(coordinate);
    if (!Number.isFinite(stored)) throw new EmbeddingVectorValidationError();
    const squared = Math.fround(stored * stored);
    normSquared = Math.fround(normSquared + squared);
    if (!Number.isFinite(normSquared)) throw new EmbeddingVectorValidationError();
    return stored;
  });
  // LanceDB's cosine implementation consumes float32 values and norms. A
  // coordinate can survive storage while its square underflows (or overflows),
  // producing a non-finite distance or a silently wrong result at search time.
  if (!(normSquared > 0)) throw new EmbeddingVectorValidationError();
  return normalized;
}

export function normalizeEmbeddingVector(value: unknown, expectedDimension: number): number[] {
  if (!Number.isSafeInteger(expectedDimension) || expectedDimension < 1) {
    throw new EmbeddingVectorValidationError();
  }
  if (!(Array.isArray(value) || value instanceof Float32Array) || value.length !== expectedDimension) {
    throw new EmbeddingVectorValidationError();
  }
  return normalizeEmbeddingVectorValues(value);
}
