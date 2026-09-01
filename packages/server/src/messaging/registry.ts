import type {
  MessageChannelId,
  MessageProvider,
  MessageProviderId,
} from "@multiremi/contracts/messaging.js";

/**
 * The Core's only way to reach a Provider.
 *
 * Registration is the single extension point: adding a channel means
 * registering another Provider here, never editing scheduling, deduplication,
 * storage, or any other Core behaviour.
 */
export class MessageProviderRegistry {
  private readonly providers = new Map<MessageProviderId, MessageProvider>();

  constructor(providers: readonly MessageProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: MessageProvider): void {
    const id = provider.manifest.provider.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(id)) {
      throw new Error(`Invalid message provider id: ${JSON.stringify(provider.manifest.provider)}`);
    }
    if (this.providers.has(id)) throw new Error(`Duplicate message provider: ${id}`);
    if (provider.manifest.channels.length === 0) {
      throw new Error(`Message provider ${id} declares no channel`);
    }
    for (const channel of provider.manifest.channels) {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(channel)) {
        throw new Error(`Invalid channel id ${JSON.stringify(channel)} on provider ${id}`);
      }
    }
    this.providers.set(id, provider);
  }

  get(provider: MessageProviderId): MessageProvider | null {
    return this.providers.get(provider.trim()) ?? null;
  }

  has(provider: MessageProviderId): boolean {
    return this.providers.has(provider.trim());
  }

  /**
   * Providers that serve a channel.
   *
   * A channel may have more than one Provider — the same platform reached
   * through a different tool — so this returns every match rather than
   * pretending the mapping is one-to-one.
   */
  forChannel(channel: MessageChannelId): MessageProvider[] {
    const target = channel.trim();
    return this.list().filter((provider) => provider.manifest.channels.includes(target));
  }

  list(): MessageProvider[] {
    return [...this.providers.values()].sort((left, right) =>
      left.manifest.provider.localeCompare(right.manifest.provider));
  }

  ids(): MessageProviderId[] {
    return this.list().map((provider) => provider.manifest.provider);
  }

  channels(): MessageChannelId[] {
    const channels = new Set<MessageChannelId>();
    for (const provider of this.providers.values()) {
      for (const channel of provider.manifest.channels) channels.add(channel);
    }
    return [...channels].sort();
  }
}
