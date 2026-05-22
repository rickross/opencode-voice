import { createElevenLabsProvider } from "./elevenlabs.js";
import type { TTSProvider } from "./types.js";

/**
 * Provider configuration shape, keyed by provider name.
 *
 * Each provider declares its own configuration object. The plugin core
 * passes the appropriate sub-config when constructing a provider.
 */
export interface ProviderConfigs {
  elevenlabs: {
    voiceId: string;
    modelId: string;
    apiKeyPath: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    preserveVoiceDefaults?: boolean;
  };
  // Future providers register their config shape here.
  // omnivoice: { voiceClonePrompt: string; daemonSocket?: string; ... };
}

export type ProviderName = keyof ProviderConfigs;

/**
 * Create a TTSProvider instance from a provider name and its config.
 *
 * The core plugin reads `provider` from VoiceConfig and calls this
 * factory to obtain the runtime provider. Adding a new backend means
 * adding a case here plus implementing the TTSProvider interface.
 */
export function createProvider<P extends ProviderName>(
  name: P,
  config: ProviderConfigs[P],
): TTSProvider {
  if (name === "elevenlabs") {
    return createElevenLabsProvider(config as ProviderConfigs["elevenlabs"]);
  }
  throw new Error(`Unknown TTS provider: ${String(name)}`);
}

export type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";
