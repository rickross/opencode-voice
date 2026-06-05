import { createProvider, type ProviderName, type ProviderConfigs } from "./providers/index.js";
import type { TTSProvider } from "./providers/types.js";

/**
 * The set of provider configs that the registry should pre-construct
 * at startup. Any key present in this object causes that provider to
 * be instantiated immediately; absent keys leave that provider
 * unavailable.
 */
export type RegistryProviderConfigs = Partial<ProviderConfigs>;

export interface ProviderRegistryConfig {
  /**
   * Per-provider configuration. Every entry whose value is present
   * gets constructed at registry creation time. Missing entries make
   * that provider unavailable (attempting to switch to it will throw).
   */
  providers: RegistryProviderConfigs;
  /**
   * Which provider is active when the registry is created. Must be a
   * key present in `providers`.
   */
  defaultProvider: ProviderName;
}

/**
 * A small in-process registry of TTS providers with one of them
 * marked active.
 *
 * Pre-construction at startup means switching providers is instant
 * (no model load, no connection handshake). The memory cost is
 * negligible for HTTP-based providers — they hold no model weights
 * in this process, only configuration and a small amount of state.
 *
 * The registry is intentionally simple:
 *   - One active provider at a time.
 *   - `setActive` swaps the active reference; new speak() calls land
 *     on the new provider. In-flight playback on the old provider is
 *     unaffected (the playback queue holds its own handle).
 *   - `getActive` returns the current provider object.
 *   - `list` and `describe` surface metadata for /voice slash commands.
 *
 * The registry is not safe to share across processes; it lives in
 * plugin memory alongside the playback queue.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, TTSProvider>();
  private activeName: ProviderName;

  constructor(config: ProviderRegistryConfig) {
    for (const name of Object.keys(config.providers) as ProviderName[]) {
      const providerConfig = config.providers[name];
      if (providerConfig === undefined) continue;
      // Type-narrowing through the heterogeneous map requires a cast at
      // the boundary; the factory's own signature re-establishes safety.
      const provider = createProvider(name, providerConfig as ProviderConfigs[typeof name]);
      this.providers.set(name, provider);
    }

    if (!this.providers.has(config.defaultProvider)) {
      throw new Error(
        `defaultProvider "${config.defaultProvider}" is not in the configured providers ` +
          `[${[...this.providers.keys()].join(", ")}]`,
      );
    }
    this.activeName = config.defaultProvider;
  }

  /** The currently active provider object. */
  getActive(): TTSProvider {
    const provider = this.providers.get(this.activeName);
    if (!provider) {
      throw new Error(`Active provider "${this.activeName}" is no longer in the registry`);
    }
    return provider;
  }

  /** The name of the currently active provider. */
  getActiveName(): ProviderName {
    return this.activeName;
  }

  /**
   * Swap the active provider to `name`. Throws if `name` was not
   * configured at registry construction.
   *
   * In-flight playback on the prior provider is not interrupted by
   * this call; only subsequent speak() calls land on the new provider.
   */
  setActive(name: ProviderName): void {
    if (!this.providers.has(name)) {
      throw new Error(
        `Unknown provider "${name}". Available: [${[...this.providers.keys()].join(", ")}]`,
      );
    }
    this.activeName = name;
  }

  /** Return all available provider names. */
  listNames(): ProviderName[] {
    return [...this.providers.keys()];
  }

  /**
   * Return a snapshot suitable for /voice list — each provider's
   * name, whether it is active, and a one-line summary derived from
   * the first non-empty line after the title in its CAPABILITIES.md.
   */
  listSummaries(): { name: ProviderName; active: boolean; summary: string }[] {
    return this.listNames().map((name) => {
      const provider = this.providers.get(name)!;
      return {
        name,
        active: name === this.activeName,
        summary: extractFirstSummaryLine(provider.capabilitiesDoc),
      };
    });
  }

  /**
   * Return the full CAPABILITIES.md content for `name`, for use by
   * /voice describe. Throws on unknown name.
   */
  describe(name: ProviderName): string {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `Unknown provider "${name}". Available: [${[...this.providers.keys()].join(", ")}]`,
      );
    }
    return provider.capabilitiesDoc;
  }
}

/**
 * Extract the first non-empty paragraph after the heading from a
 * CAPABILITIES.md. Used for the /voice list summary view.
 */
function extractFirstSummaryLine(doc: string): string {
  const lines = doc.split("\n");
  let inTitle = true;
  const buffer: string[] = [];
  for (const line of lines) {
    if (inTitle) {
      if (line.startsWith("#")) continue;
      if (line.trim() === "") continue;
      inTitle = false;
    }
    if (line.trim() === "") {
      if (buffer.length > 0) break;
      continue;
    }
    if (line.startsWith("#")) break;
    buffer.push(line.trim());
  }
  return buffer.join(" ").slice(0, 200);
}
