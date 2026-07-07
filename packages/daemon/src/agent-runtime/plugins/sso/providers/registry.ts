/**
 * SsoProviderRegistry — maps plugin `type` string to factory + metadata.
 *
 * Built-in types (bytedance-oidc, generic-oidc) are registered at startup
 * by the SsoPlugin class. External code can register additional types
 * before the plugin's handlers receive traffic.
 */

import type {
  SsoProvider,
  SsoProviderFactory,
  PluginTypeMeta,
} from "./base.js";

interface RegisteredType {
  factory: SsoProviderFactory;
  meta: PluginTypeMeta;
}

export class SsoProviderRegistry {
  private _types = new Map<string, RegisteredType>();
  /** Cache of instantiated providers: providerId → SsoProvider */
  private _instances = new Map<string, { instance: SsoProvider; configHash: string }>();

  register(meta: PluginTypeMeta, factory: SsoProviderFactory): this {
    if (this._types.has(meta.type)) {
      throw new Error(`SSO provider type already registered: ${meta.type}`);
    }
    this._types.set(meta.type, { factory, meta });
    return this;
  }

  listTypes(): PluginTypeMeta[] {
    return [...this._types.values()].map((r) => r.meta);
  }

  hasType(type: string): boolean {
    return this._types.has(type);
  }

  /**
   * Get (or build) a provider instance for a configured row.
   * Instances are cached by providerId + a hash of the config so config
   * changes invalidate the cache automatically.
   */
  get(
    providerId: string,
    type: string,
    config: Record<string, unknown>,
  ): SsoProvider {
    const reg = this._types.get(type);
    if (!reg) throw new Error(`unknown SSO provider type: ${type}`);

    const hash = hashConfig(config);
    const cached = this._instances.get(providerId);
    if (cached && cached.configHash === hash) return cached.instance;

    const instance = reg.factory(config);
    this._instances.set(providerId, { instance, configHash: hash });
    return instance;
  }

  /** Drop cached instance — call after a provider row is updated. */
  invalidate(providerId: string): void {
    this._instances.delete(providerId);
  }
}

function hashConfig(config: Record<string, unknown>): string {
  // Cheap deterministic hash — stringify with sorted keys
  const sorted = Object.keys(config)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = config[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}
