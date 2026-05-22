import { tool, type Plugin } from "@opencode-ai/plugin";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createProvider, type ProviderName, type TTSProvider } from "./providers/index.js";

/**
 * Default constants
 */
const DEFAULT_VOICE_ID = "YOq2y2Up4RgXP2HyXjE5";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_PROVIDER: ProviderName = "elevenlabs";
const DEFAULT_ENABLED = true;
const DEFAULT_API_KEY_PATH = join(
  homedir(),
  ".config/opencode/secrets/elevenlabs-key"
);
const DEFAULT_OMNIVOICE_ENDPOINT = "http://127.0.0.1:7345";
const CONFIG_FILE = "voice.json";
const STATE_FILE = "voice-state.json";

/**
 * Voice config shape.
 * Can be provided in:
 *   - <agent-dir>/voice.json         (per-agent, highest priority)
 *   - opencode.json plugin options   (inline, same priority as above)
 *   - built-in defaults              (fallback)
 *
 * Example voice.json:
 *   {
 *     "provider": "elevenlabs",
 *     "voiceId": "abc123",
 *     "modelId": "eleven_multilingual_v2",
 *     "stability": 0.4
 *   }
 */
export interface VoiceConfig {
  /** Which TTS backend to use. Defaults to "elevenlabs". */
  provider?: ProviderName;

  // --- ElevenLabs fields ---
  voiceId?: string;
  modelId?: string;
  /** Path to file containing the ElevenLabs API key */
  apiKeyPath?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  preserveVoiceDefaults?: boolean;

  // --- OmniVoice fields ---
  /**
   * OmniVoice daemon endpoint, e.g. "http://127.0.0.1:7345".
   * Defaults to http://127.0.0.1:7345 when provider is "omnivoice".
   */
  omnivoiceEndpoint?: string;
  /** Per-request timeout when calling the OmniVoice daemon (ms). */
  omnivoiceTimeoutMs?: number;

  // --- Shared ---
  enabled?: boolean | "on" | "off" | "default";
  /**
   * Speech mode:
   *   "tagged" (default) — only speak content wrapped in <speak>...</speak> tags
   *   "all"              — speak everything except content wrapped in <no-speak>...</no-speak> tags
   */
  speakMode?: "tagged" | "all";
  speed?: number;
  volume?: number;
}

interface VoiceState {
  enabled?: boolean;
  speakMode?: "tagged" | "all";
}

function resolveEnabled(value: VoiceConfig["enabled"] | undefined): boolean {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return DEFAULT_ENABLED;
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function extractSpeakBlocks(text: string): { cleanText: string; spokenText: string } {
  const spoken: string[] = [];
  const cleanText = text.replace(/<speak>([\s\S]*?)<\/speak>/gi, (_match, inner) => {
    const trimmed = String(inner).trim();
    if (trimmed) spoken.push(trimmed);
    return trimmed;
  });
  return {
    cleanText,
    spokenText: spoken.join("\n"),
  };
}

/**
 * In "all" mode: strip <no-speak> blocks from both the spoken text and
 * remove the tags from the displayed text. Everything outside <no-speak>
 * tags is spoken.
 */
function extractAllModeText(text: string): { cleanText: string; spokenText: string } {
  const spokenText = text
    .replace(/<no-speak>[\s\S]*?<\/no-speak>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const cleanText = text.replace(/<\/?no-speak>/gi, "");

  return { cleanText, spokenText };
}

/**
 * Normalize text for TTS. Strips common markdown syntax that should not
 * be vocalized (asterisks for bold/italic/emphasis, backticks for code,
 * leading list markers, heading hashes, link syntax). Preserves the
 * underlying words and natural punctuation.
 *
 * This runs after speak/no-speak extraction and before sending to the
 * provider. The displayed text is untouched — only the spoken stream
 * is normalized.
 */
function normalizeForSpeech(text: string): string {
  let out = text;

  // Fenced code blocks: drop entirely. Inline code: keep the word, drop backticks.
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/`([^`]*)`/g, "$1");

  // Markdown links [label](url) -> label
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Bold / italic / emphasis markers (** *), keep inner text.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/_([^_\n]+)_/g, "$1");

  // Stray asterisks or underscores that didn't form a pair.
  out = out.replace(/[*_]/g, "");

  // Leading list/heading markers at start of lines.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, "");

  // Blockquote markers.
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, "");

  // Horizontal rules.
  out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, " ");

  // Collapse whitespace.
  out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}

const AUDIO_TAG_EXAMPLES = `
Audio Tags (v3 expressive features):
  Emotions: [laughs], [sighs], [whispers], [excited], [sad], [angry], [happily], [sarcastic], [curious]
  Delivery: [whispers], [shouts], [dramatically], [calmly], [nervously]
  Reactions: [laughs], [laughs harder], [giggles], [clears throat], [sighs], [gasps], [gulps]
  Accents: [strong French accent], [British accent], [Southern US accent]
  Sound FX: [applause], [gunshot], [explosion]

Example: "[whispers] Something's coming... [sighs] I can feel it."
Example: "[excited] We did it! [laughs] I can't believe it worked!"
`;

/**
 * Config resolution order (later overrides earlier):
 *   1. Built-in defaults
 *   2. <agent-dir>/voice.json  (input.directory at runtime)
 *   3. Plugin options from opencode.json
 */
export const VoicePlugin: Plugin = async (input, options) => {
  const voiceOptions = options as VoiceConfig | undefined;

  // Load per-agent config file from the agent's working directory
  const agentConfig = input?.directory
    ? readJsonFile<VoiceConfig>(join(input.directory, CONFIG_FILE))
    : undefined;
  const statePath = input?.directory ? join(input.directory, STATE_FILE) : undefined;
  const runtimeState = statePath ? readJsonFile<VoiceState>(statePath) : undefined;
  const configuredEnabled = voiceOptions?.enabled ?? agentConfig?.enabled ?? "default";

  // Merge: defaults < agent voice.json < inline plugin options
  const config = {
    provider: (voiceOptions?.provider ?? agentConfig?.provider ?? DEFAULT_PROVIDER) as ProviderName,
    // ElevenLabs config
    voiceId: voiceOptions?.voiceId ?? agentConfig?.voiceId ?? DEFAULT_VOICE_ID,
    modelId: voiceOptions?.modelId ?? agentConfig?.modelId ?? DEFAULT_MODEL_ID,
    apiKeyPath: voiceOptions?.apiKeyPath ?? agentConfig?.apiKeyPath ?? DEFAULT_API_KEY_PATH,
    stability: voiceOptions?.stability ?? agentConfig?.stability ?? 0.5,
    similarityBoost: voiceOptions?.similarityBoost ?? agentConfig?.similarityBoost ?? 0.75,
    style: voiceOptions?.style ?? agentConfig?.style,
    useSpeakerBoost: voiceOptions?.useSpeakerBoost ?? agentConfig?.useSpeakerBoost,
    preserveVoiceDefaults: voiceOptions?.preserveVoiceDefaults ?? agentConfig?.preserveVoiceDefaults ?? false,
    // OmniVoice config
    omnivoiceEndpoint: voiceOptions?.omnivoiceEndpoint ?? agentConfig?.omnivoiceEndpoint ?? DEFAULT_OMNIVOICE_ENDPOINT,
    omnivoiceTimeoutMs: voiceOptions?.omnivoiceTimeoutMs ?? agentConfig?.omnivoiceTimeoutMs,
    // Runtime / shared
    enabled: runtimeState?.enabled ?? resolveEnabled(configuredEnabled),
    configuredEnabled,
    speakMode: (runtimeState?.speakMode ?? voiceOptions?.speakMode ?? agentConfig?.speakMode ?? "tagged") as "tagged" | "all",
    speed: voiceOptions?.speed ?? agentConfig?.speed ?? 1.0,
    volume: voiceOptions?.volume ?? agentConfig?.volume ?? 1.0,
  };

  // Instantiate the provider once at plugin init based on which backend
  // is selected. Each provider only sees the config it cares about.
  function buildProvider(): TTSProvider {
    if (config.provider === "omnivoice") {
      return createProvider("omnivoice", {
        endpoint: config.omnivoiceEndpoint,
        timeoutMs: config.omnivoiceTimeoutMs,
      });
    }
    return createProvider("elevenlabs", {
      voiceId: config.voiceId,
      modelId: config.modelId,
      apiKeyPath: config.apiKeyPath,
      stability: config.stability,
      similarityBoost: config.similarityBoost,
      style: config.style,
      useSpeakerBoost: config.useSpeakerBoost,
      preserveVoiceDefaults: config.preserveVoiceDefaults,
    });
  }

  const provider: TTSProvider = buildProvider();

  /**
   * Internal helper that drives a request through the provider and returns
   * a confirmation string in the same shape startSpeech() used to return.
   * Errors are surfaced to the caller; the provider's playback runs
   * non-blocking via its returned handle.
   */
  async function speakViaProvider(args: {
    text: string;
    volume: number;
    speed?: number;
    opts?: Record<string, unknown>;
  }): Promise<string> {
    // Strip markdown/structural syntax that shouldn't be vocalized.
    const speechText = normalizeForSpeech(args.text);

    // Bail cleanly if normalization left nothing speakable.
    if (!speechText) {
      return `<speak_skipped>
No speakable content after normalization.
</speak_skipped>`;
    }

    const handle = await provider.speak({
      text: speechText,
      volume: args.volume,
      speed: args.speed,
      opts: args.opts,
    });

    const preview =
      speechText.length > 80 ? speechText.substring(0, 80) + "..." : speechText;
    return `<speak_started>
Playing speech (non-blocking): "${preview}"
Provider: ${provider.name}
Handle: ${handle.id}
</speak_started>`;
  }

  const speakTool = tool({
    description: `Convert text to speech and play it on the device speakers (non-blocking).

The active TTS provider is determined by the agent's voice.json (default: elevenlabs).
When using ElevenLabs, inline audio tags are supported for expressive control.

${AUDIO_TAG_EXAMPLES}

The audio plays in the background and control returns immediately.

USAGE GUIDANCE:
- Speak naturally — 1-2 sentences is the routine target, 3-4 is fine when clarity needs it, longer is occasionally worthwhile but not the norm
- Use your judgment. Don't pad. Don't muzzle. Match the moment.
- Avoid reading out code, file paths, JSON, or long technical lists — use written text for those
- Pair with written text when precision matters (commands, paths, structured data)
- Examples:
  * "[excited] Done! The build succeeded."
  * "[curious] I have a question — should I proceed with the refactor?"
  * "[sighs] I found 3 errors we need to fix."
  * "[warmly] That's a good instinct. Here's why it works..."`,

    args: {
      text: tool.schema
        .string()
        .describe(
          "The text to convert to speech. Can include audio tags like [laughs], [whispers], [excited], etc."
        ),
      voiceId: tool.schema.string().optional()
        .describe("Optional ElevenLabs voice ID override. Defaults to voice.json or plugin config."),
      modelId: tool.schema.string().optional()
        .describe("Optional ElevenLabs model ID override. Defaults to voice.json or plugin config."),
      stability: tool.schema.number().min(0).max(1).optional()
        .describe("Voice stability (0-1). Lower = more expressive. Default from config."),
      similarity_boost: tool.schema.number().min(0).max(1).optional()
        .describe("How closely to match the original voice (0-1). Default from config."),
      style: tool.schema.number().min(0).max(1).optional()
        .describe("Optional style exaggeration (0-1). Omit to use stored/default voice behavior."),
      use_speaker_boost: tool.schema.boolean().optional()
        .describe("Optional speaker boost override. Omit to use stored/default voice behavior."),
      preserveVoiceDefaults: tool.schema.boolean().optional()
        .describe("If true, do not send voice_settings unless explicitly overridden."),
      speed: tool.schema.number().min(0.5).max(2.0).optional()
        .describe("Speech speed multiplier (0.5-2.0). Default from config."),
      volume: tool.schema.number().min(0).max(2).optional()
        .describe("Playback volume (0-2). Default from config."),
    },

    async execute(args) {
      const {
        text,
        voiceId,
        modelId,
        stability,
        similarity_boost,
        style,
        use_speaker_boost,
        preserveVoiceDefaults,
        speed = config.speed,
        volume = config.volume,
      } = args;

      // Pass any provider-specific overrides through `opts`.
      // The current providers (only elevenlabs so far) read what they need.
      const opts: Record<string, unknown> = {};
      if (voiceId !== undefined) opts.voiceId = voiceId;
      if (modelId !== undefined) opts.modelId = modelId;
      if (stability !== undefined) opts.stability = stability;
      if (similarity_boost !== undefined) opts.similarityBoost = similarity_boost;
      if (style !== undefined) opts.style = style;
      if (use_speaker_boost !== undefined) opts.useSpeakerBoost = use_speaker_boost;
      if (preserveVoiceDefaults !== undefined) opts.preserveVoiceDefaults = preserveVoiceDefaults;

      return speakViaProvider({
        text,
        volume,
        speed,
        opts: Object.keys(opts).length ? opts : undefined,
      });
    },
  });

  const voiceTool = tool({
    description: `Control runtime voice mode for tag-driven speech.

- on: enable speaking of <speak>...</speak> blocks (tagged mode)
- off: disable speaking entirely
- status: show current voice mode and config
- tagged: switch to tagged mode — only speak content inside <speak>...</speak> tags
- all: switch to all mode — speak everything except content inside <no-speak>...</no-speak> tags`,
    args: {
      action: tool.schema.enum(["on", "off", "status", "tagged", "all"]).describe("Voice mode action to perform."),
    },
    async execute(args) {
      const action = args.action;
      if (action === "status") {
        return JSON.stringify(
          {
            enabled: config.enabled,
            speakMode: config.speakMode,
            configuredEnabled: config.configuredEnabled,
            provider: config.provider,
            voiceId: config.voiceId,
            modelId: config.modelId,
            preserveVoiceDefaults: config.preserveVoiceDefaults,
            statePath,
          },
          null,
          2,
        );
      }

      if (!statePath) {
        throw new Error("Voice runtime state is unavailable because the agent directory is missing.");
      }

      if (action === "tagged" || action === "all") {
        config.speakMode = action;
        config.enabled = true;
        writeJsonFile(statePath, { enabled: true, speakMode: action });
        return `Voice mode set to "${action}".`;
      }

      const nextEnabled = action === "on";
      writeJsonFile(statePath, { enabled: nextEnabled, speakMode: config.speakMode });
      config.enabled = nextEnabled;
      return `Voice ${nextEnabled ? "on" : "off"}.`;
    },
  });

  return {
    tool: { speak: speakTool, voice: voiceTool },
    "experimental.text.complete": async (_input, output) => {
      if (!config.enabled) return;
      const { cleanText, spokenText } = config.speakMode === "all"
        ? extractAllModeText(output.text)
        : extractSpeakBlocks(output.text);
      output.text = cleanText;
      if (!spokenText) return;
      void speakViaProvider({
        text: spokenText,
        volume: config.volume,
        speed: config.speed,
      }).catch((error) => {
        console.error("[opencode-voice] tagged speak failed:", error);
      });
    },
  };
};
