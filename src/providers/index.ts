import { createElevenLabsProvider } from "./elevenlabs/index.js";
import { createHiggsAudioV3Provider } from "./higgs-audio-v3/index.js";
import { createOmniVoiceProvider } from "./omnivoice/index.js";
import { createQwen3TtsProvider } from "./qwen3-tts/index.js";
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
  omnivoice: {
    endpoint: string;
    timeoutMs?: number;
    voice?: string;
    agent?: string;
  };
  "qwen3-tts": {
    endpoint: string;
    timeoutMs?: number;
    voice?: string;
    model?: string;
    agent?: string;
    instruct?: string;
    language?: string;
    stream?: boolean;
  };
  "higgs-audio-v3": {
    endpoint: string;
    timeoutMs?: number;
    voice?: string;
    agent?: string;
    temperature?: number;
    topK?: number;
    maxNewTokens?: number;
    responseFormat?: "wav" | "mp3";
    stream?: boolean;
  };
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
  if (name === "omnivoice") {
    return createOmniVoiceProvider(config as ProviderConfigs["omnivoice"]);
  }
  if (name === "qwen3-tts") {
    return createQwen3TtsProvider(config as ProviderConfigs["qwen3-tts"]);
  }
  if (name === "higgs-audio-v3") {
    return createHiggsAudioV3Provider(config as ProviderConfigs["higgs-audio-v3"]);
  }
  throw new Error(`Unknown TTS provider: ${String(name)}`);
}

export type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";
