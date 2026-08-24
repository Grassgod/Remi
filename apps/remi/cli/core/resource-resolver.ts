import { CliError } from "./errors.js";

export interface ResourceResolverAdapter<T> {
  kind: string;
  getById(ref: string): Promise<T | null>;
  search(query: string): Promise<readonly T[]>;
  id(resource: T): string;
  name(resource: T): string | null;
  describe?(resource: T): Record<string, unknown>;
}

export class ResourceResolver<T> {
  private readonly cache = new Map<string, Promise<T>>();

  constructor(private readonly adapter: ResourceResolverAdapter<T>) {}

  resolve(rawRef: string): Promise<T> {
    const ref = rawRef.trim();
    if (!ref) return Promise.reject(new CliError("usage", `${this.adapter.kind} reference is required`));
    const cacheKey = ref.toLocaleLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const pending = this.resolveUncached(ref).catch((error) => {
      this.cache.delete(cacheKey);
      throw error;
    });
    this.cache.set(cacheKey, pending);
    return pending;
  }

  private async resolveUncached(ref: string): Promise<T> {
    const exact = await this.adapter.getById(ref);
    if (exact && this.adapter.id(exact) === ref) return exact;
    const candidates = deduplicate(await this.adapter.search(normalizeName(ref)), (resource) => this.adapter.id(resource));
    const exactId = candidates.filter((resource) => this.adapter.id(resource) === ref);
    if (exactId.length === 1) return exactId[0]!;
    if (exactId.length > 1) throw this.ambiguous(ref, exactId);
    const shortId = candidates.filter((resource) => this.adapter.id(resource).startsWith(ref));
    if (shortId.length === 1) return shortId[0]!;
    if (shortId.length > 1) throw this.ambiguous(ref, shortId);
    const normalizedRef = normalizeName(ref);
    const byName = candidates.filter((resource) => normalizeName(this.adapter.name(resource) ?? "") === normalizedRef);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw this.ambiguous(ref, byName);
    throw new CliError("not_found", `${this.adapter.kind} not found: ${ref}`);
  }

  private ambiguous(ref: string, candidates: readonly T[]): CliError {
    return new CliError("ambiguous_ref", `ambiguous ${this.adapter.kind} reference: ${ref}`, {
      details: {
        candidates: candidates.map((resource) => this.adapter.describe?.(resource) ?? {
          id: this.adapter.id(resource),
          name: this.adapter.name(resource),
        }),
      },
      hint: `Use the full ${this.adapter.kind} ID.`,
    });
  }
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function deduplicate<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
