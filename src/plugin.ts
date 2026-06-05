import { tool, type Plugin } from "@opencode-ai/plugin";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type ProviderName, type TTSProvider } from "./providers/index.js";
import { ProviderRegistry, type RegistryProviderConfigs } from "./provider-registry.js";
import { chunkForTTS } from "./chunker.js";
import {
  PlaybackQueue,
  DEFAULT_SPEAK_MODE,
  type SpeakMode,
} from "./playback-queue.js";
import { extractSpeakBlocks as extractTaggedSpeech } from "./speak-tags.js";

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
const DEFAULT_QWEN3_TTS_ENDPOINT = "http://zion.irelate.ai:5009";
const DEFAULT_QWEN3_TTS_MODEL = "/model";
const DEFAULT_HIGGS_ENDPOINT = "http://zion.irelate.ai:5012";
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
  /**
   * Which voice cell on the OmniVoice daemon to use for this agent.
   * Omit to fall back to the daemon's configured default_voice.
   */
  omnivoiceVoice?: string;
  /**
   * Diagnostic caller id sent with every OmniVoice request. Surfaces in
   * the daemon's /health endpoint and logs. Defaults to the agent name
   * from environment if not specified.
   */
  omnivoiceAgent?: string;

  // --- Qwen3-TTS fields ---
  /**
   * Qwen3-TTS endpoint, e.g. "http://zion.irelate.ai:5009".
   * Defaults to http://zion.irelate.ai:5009 when provider is "qwen3-tts".
   */
  qwen3TtsEndpoint?: string;
  /** Per-request timeout when calling the Qwen3-TTS endpoint (ms). */
  qwen3TtsTimeoutMs?: number;
  /**
   * Which voice (registered in vllm-omni's voice registry) to use for
   * this agent. E.g. "solene", "aurora", "telos". Defaults to the
   * lowercased AGENT_NAME from environment if not specified.
   */
  qwen3TtsVoice?: string;
  /**
   * Model identifier as seen by vllm-omni's OpenAI-compatible endpoint.
   * Defaults to "/model" — matches the qwen3-tts.service ExecStart.
   */
  qwen3TtsModel?: string;
  /**
   * Diagnostic caller id sent with every Qwen3-TTS request. Defaults to
   * the agent name from environment if not specified.
   */
  qwen3TtsAgent?: string;
  /**
   * Default natural-language prosody / style directive for this agent
   * when using qwen3-tts. Applied to every utterance unless overridden
   * per-call via the `speak` tool's `opts.instruct` argument.
   *
   * Examples:
   *   "Warm, intimate tone with French sensibility."
   *   "Calm and professional."
   *   "Slow, contemplative, whispered."
   */
   qwen3TtsInstruct?: string;
  /**
   * Language hint for the qwen3-tts vllm-omni server. Pinned per
   * request to stabilize accent across French/English code-switching.
   *
   * Accepted values: "Auto", "English", "French", "Chinese",
   * "Japanese", "Korean", "German", "Russian", "Portuguese",
   * "Spanish", "Italian". Defaults to omitted (server default).
   */
  qwen3TtsLanguage?: string;
  /**
   * When true, request streaming PCM output from the vllm-omni server
   * (response_format=pcm + stream=true) and pipe directly into the
   * player as raw 24kHz 16-bit signed mono. Defaults to true on the
   * v0.22+ streaming server; set false to fall back to the older WAV
   * response shape (e.g. for an older non-streaming backend).
   */
   qwen3TtsStream?: boolean;

  // --- Higgs Audio v3 fields ---
  /**
   * Higgs Audio v3 endpoint, e.g. "http://zion.irelate.ai:5012".
   * Defaults to http://zion.irelate.ai:5012 when provider is
   * "higgs-audio-v3".
   */
  higgsEndpoint?: string;
  /** Per-request timeout when calling the Higgs endpoint (ms). */
  higgsTimeoutMs?: number;
  /**
   * Server-side voice key for built-in Higgs presets (e.g. "default",
   * "jake"). Cadre voices like "solene" do NOT resolve through this
   * field on our SGLang-Omni deployment — they fall through to default.
   * Use higgsRefAudio + higgsRefText for cadre voices.
   */
  higgsVoice?: string;
  /**
   * Server-side path to the reference audio clip for voice cloning.
   * The SGLang-Omni container reads this from its own filesystem
   * (typically /voices/samples/<agent>.mp3). Set this in voice.json
   * for cadre voices; pair with higgsRefText for clean cloning.
   */
  higgsRefAudio?: string;
  /**
   * Transcript of the reference audio clip. Strongly recommended when
   * higgsRefAudio is set — supplying the transcript materially improves
   * cloning fidelity (per SGLang-Omni cookbook).
   */
  higgsRefText?: string;
  /**
   * Diagnostic caller id sent with every Higgs request for server-side
   * log correlation. Defaults to the lowercased AGENT_NAME.
   */
  higgsAgent?: string;
  /** Sampling temperature for Higgs (default 0.8). */
  higgsTemperature?: number;
  /** Top-k sampling for Higgs (default 50). */
  higgsTopK?: number;
  /** Max generation tokens for Higgs (default 1024). */
  higgsMaxNewTokens?: number;
  /** Response audio format: "wav" (default) or "mp3". Ignored when stream=true. */
  higgsResponseFormat?: "wav" | "mp3";
  /**
   * When true, use the streaming PCM path (raw 16-bit signed mono
   * 24kHz piped directly into `play -t raw`). Lowest TTFA, recommended
   * for conversational use. When false (default), the provider sends
   * a non-streaming request and pipes the whole WAV/MP3 body to the
   * player when it arrives.
   */
  higgsStream?: boolean;

  // --- Shared ---
  enabled?: boolean | "on" | "off" | "default";
  /**
   * Speech mode:
   *   "tagged" (default) — only speak content wrapped in <speak>...</speak>;
   *                        the tags themselves are stripped from display.
   *   "tagged-raw"       — same speech selection as "tagged", but the raw
   *                        <speak>...</speak> tags are preserved in the
   *                        displayed transcript. Useful when you need to
   *                        see exactly what the model emitted (e.g. to
   *                        diagnose models that mis-emit tag syntax).
   *   "all"              — speak everything except content wrapped in
   *                        <no-speak>...</no-speak> tags
   */
  speakMode?: "tagged" | "tagged-raw" | "all";
  speed?: number;
  volume?: number;
}

interface VoiceState {
  enabled?: boolean;
  speakMode?: "tagged" | "tagged-raw" | "all";
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

/**
 * In "all" mode: strip <no-speak> blocks from both the spoken text and
 * remove the tags from the displayed text. Everything outside <no-speak>
 * tags is spoken as one logical utterance (default mode "replace": a new
 * turn cancels and replaces any in-flight playback from a prior turn).
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
  // Protect Higgs-style inline control tags (`<|category:value|>`) from
  // every markdown / whitespace transform below. These tags carry
  // underscores in values like `long_pause` and `speed_very_slow`; the
  // generic underscore-stripping below would mangle them into
  // unrecognized tags that the server then speaks as text.
  //
  // Strategy: extract the tags, replace with NUL-prefixed placeholders
  // the normalizer is guaranteed not to touch, then restore at the end.
  // Same shape works for any future SSML-style passthrough tags.
  const protectedTags: string[] = [];
  let out = text.replace(/<\|[^|]+\|>/g, (match) => {
    const idx = protectedTags.length;
    protectedTags.push(match);
    return `\u0000HTAG${idx}\u0000`;
  });

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

  // Collapse whitespace — but preserve paragraph breaks (\n\n+) as
  // structural markers. The chunker downstream splits on paragraph
  // boundaries to keep TTS providers from choking on internal blank
  // lines (Higgs Audio v3 in particular interprets \n\n as "text is
  // done" and silences the remainder of its generation budget).
  //
  // Strategy: canonicalize all paragraph-break sequences to exactly
  // "\n\n", then collapse non-paragraph whitespace runs to single
  // spaces. Order matters: paragraph step first, then per-paragraph
  // whitespace collapse, then rejoin.
  out = out
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter((para) => para.length > 0)
    .join("\n\n");

  // Restore protected inline control tags.
  out = out.replace(/\u0000HTAG(\d+)\u0000/g, (_, idx) => {
    return protectedTags[Number(idx)] ?? "";
  });

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
    omnivoiceVoice:
      voiceOptions?.omnivoiceVoice ??
      agentConfig?.omnivoiceVoice ??
      process.env.AGENT_NAME?.toLowerCase(),
    omnivoiceAgent:
      voiceOptions?.omnivoiceAgent ??
      agentConfig?.omnivoiceAgent ??
      process.env.AGENT_NAME?.toLowerCase(),
    // Qwen3-TTS config
    qwen3TtsEndpoint: voiceOptions?.qwen3TtsEndpoint ?? agentConfig?.qwen3TtsEndpoint ?? DEFAULT_QWEN3_TTS_ENDPOINT,
    qwen3TtsTimeoutMs: voiceOptions?.qwen3TtsTimeoutMs ?? agentConfig?.qwen3TtsTimeoutMs,
    qwen3TtsVoice:
      voiceOptions?.qwen3TtsVoice ??
      agentConfig?.qwen3TtsVoice ??
      process.env.AGENT_NAME?.toLowerCase(),
    qwen3TtsModel: voiceOptions?.qwen3TtsModel ?? agentConfig?.qwen3TtsModel ?? DEFAULT_QWEN3_TTS_MODEL,
    qwen3TtsAgent:
      voiceOptions?.qwen3TtsAgent ??
      agentConfig?.qwen3TtsAgent ??
      process.env.AGENT_NAME?.toLowerCase(),
    qwen3TtsInstruct: voiceOptions?.qwen3TtsInstruct ?? agentConfig?.qwen3TtsInstruct,
    qwen3TtsLanguage: voiceOptions?.qwen3TtsLanguage ?? agentConfig?.qwen3TtsLanguage,
    qwen3TtsStream: voiceOptions?.qwen3TtsStream ?? agentConfig?.qwen3TtsStream,
    // Higgs Audio v3 config
    higgsEndpoint: voiceOptions?.higgsEndpoint ?? agentConfig?.higgsEndpoint ?? DEFAULT_HIGGS_ENDPOINT,
    higgsTimeoutMs: voiceOptions?.higgsTimeoutMs ?? agentConfig?.higgsTimeoutMs,
    higgsVoice: voiceOptions?.higgsVoice ?? agentConfig?.higgsVoice,
    higgsRefAudio: voiceOptions?.higgsRefAudio ?? agentConfig?.higgsRefAudio,
    higgsRefText: voiceOptions?.higgsRefText ?? agentConfig?.higgsRefText,
    higgsAgent:
      voiceOptions?.higgsAgent ??
      agentConfig?.higgsAgent ??
      process.env.AGENT_NAME?.toLowerCase(),
    higgsTemperature: voiceOptions?.higgsTemperature ?? agentConfig?.higgsTemperature,
    higgsTopK: voiceOptions?.higgsTopK ?? agentConfig?.higgsTopK,
    higgsMaxNewTokens: voiceOptions?.higgsMaxNewTokens ?? agentConfig?.higgsMaxNewTokens,
    higgsResponseFormat: voiceOptions?.higgsResponseFormat ?? agentConfig?.higgsResponseFormat,
    higgsStream: voiceOptions?.higgsStream ?? agentConfig?.higgsStream,
    // Runtime / shared
    enabled: runtimeState?.enabled ?? resolveEnabled(configuredEnabled),
    configuredEnabled,
    speakMode: (runtimeState?.speakMode ?? voiceOptions?.speakMode ?? agentConfig?.speakMode ?? "tagged") as "tagged" | "tagged-raw" | "all",
    speed: voiceOptions?.speed ?? agentConfig?.speed ?? 1.0,
    volume: voiceOptions?.volume ?? agentConfig?.volume ?? 1.0,
  };

  // Pre-construct every provider whose flat-shape config keys are
  // available, regardless of which one is the default. This lets
  // /voice switch swap to any provider at runtime with no model load,
  // no connection handshake, no delay.
  //
  // The legacy flat-shape config (qwen3TtsEndpoint, omnivoiceEndpoint,
  // etc.) populates each provider with the same defaults we used
  // before the registry existed. A future commit will add a nested
  // `providers: { ... }` shape that allows per-provider config without
  // the flat-key prefixing.
  function buildRegistry(): ProviderRegistry {
    const providers: RegistryProviderConfigs = {
      elevenlabs: {
        voiceId: config.voiceId,
        modelId: config.modelId,
        apiKeyPath: config.apiKeyPath,
        stability: config.stability,
        similarityBoost: config.similarityBoost,
        style: config.style,
        useSpeakerBoost: config.useSpeakerBoost,
        preserveVoiceDefaults: config.preserveVoiceDefaults,
      },
      omnivoice: {
        endpoint: config.omnivoiceEndpoint,
        timeoutMs: config.omnivoiceTimeoutMs,
        voice: config.omnivoiceVoice,
        agent: config.omnivoiceAgent,
      },
      "qwen3-tts": {
        endpoint: config.qwen3TtsEndpoint,
        timeoutMs: config.qwen3TtsTimeoutMs,
        voice: config.qwen3TtsVoice,
        model: config.qwen3TtsModel,
        agent: config.qwen3TtsAgent,
        instruct: config.qwen3TtsInstruct,
        language: config.qwen3TtsLanguage,
        stream: config.qwen3TtsStream,
      },
      "higgs-audio-v3": {
        endpoint: config.higgsEndpoint,
        timeoutMs: config.higgsTimeoutMs,
        voice: config.higgsVoice,
        refAudio: config.higgsRefAudio,
        refText: config.higgsRefText,
        agent: config.higgsAgent,
        temperature: config.higgsTemperature,
        topK: config.higgsTopK,
        maxNewTokens: config.higgsMaxNewTokens,
        responseFormat: config.higgsResponseFormat,
        stream: config.higgsStream,
      },
    };
    return new ProviderRegistry({
      providers,
      defaultProvider: config.provider,
    });
  }

  const registry: ProviderRegistry = buildRegistry();

  // Single playback coordinator for the lifetime of this plugin instance.
  // Every speak call (tool, tagged extraction, all-mode turn) routes through
  // it. This is what enforces the modality contract:
  //   - "replace" (default for whole-turn voice in all-mode, and the most
  //     common modality for conversational use) stops any in-flight playback
  //     before starting the new one, eliminating the double-play we used to
  //     see when turns came back-to-back.
  //   - "queue" appends behind in-flight playback. Useful for multi-segment
  //     narration where pause-then-continue is intentional.
  //   - "interrupt" is currently identical to "replace" but named distinctly
  //     so a future implementation can diverge (e.g., explicit barge-in
  //     semantics with a notification ping).
  const playbackQueue = new PlaybackQueue(() => registry.getActive());

  /**
   * Internal helper that drives a request through the provider and returns
   * a confirmation string in the same shape startSpeech() used to return.
   * Errors are surfaced to the caller; the provider's playback runs
   * non-blocking via its returned handle.
   *
   * If the post-normalization text exceeds the provider's safe input
   * ceiling, it is chunked at sentence boundaries before submission.
   * Chunks are played sequentially regardless of the caller's chosen
   * modality — modality controls how this *call* relates to prior calls,
   * not how chunks within one call relate to each other.
   *
   * The first chunk respects the caller's modality (replace/queue/interrupt).
   * Subsequent chunks are submitted in queue mode so they play back-to-back
   * without interruption.
   */
  async function speakViaProvider(args: {
    text: string;
    volume: number;
    speed?: number;
    mode?: SpeakMode;
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

    const chunks = chunkForTTS(speechText);
    if (chunks.length === 0) {
      return `<speak_skipped>
Chunker produced no output.
</speak_skipped>`;
    }

    const firstMode = args.mode ?? DEFAULT_SPEAK_MODE;
    const firstHandle = await playbackQueue.speak(
      {
        text: chunks[0],
        volume: args.volume,
        speed: args.speed,
        opts: args.opts,
      },
      firstMode,
    );

    // Queue any remaining chunks behind the first one. They inherit
    // the same volume / speed / opts and always play in "queue" mode
    // so the multi-chunk utterance plays as one continuous arc.
    for (let i = 1; i < chunks.length; i += 1) {
      void playbackQueue
        .speak(
          {
            text: chunks[i],
            volume: args.volume,
            speed: args.speed,
            opts: args.opts,
          },
          "queue",
        )
        .catch((err) => {
          console.error(
            `[opencode-voice] chunk ${i + 1}/${chunks.length} failed:`,
            err,
          );
        });
    }

    const preview =
      speechText.length > 80 ? speechText.substring(0, 80) + "..." : speechText;
    return `<speak_started>
Playing speech (non-blocking): "${preview}"
Provider: ${registry.getActiveName()}
Handle: ${firstHandle.id}
Mode: ${firstMode}
Chunks: ${chunks.length}
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
      instruct: tool.schema.string().optional()
        .describe(
          "Natural-language prosody / style directive for this utterance. " +
          "Supported by qwen3-tts only; ignored by other providers. " +
          "Examples: 'Whispered, intimate.' / 'Excited, animated.' / 'Calm and slow.'"
        ),
      mode: tool.schema.enum(["replace", "queue", "interrupt"]).optional()
        .describe(
          "Speak modality (default \"replace\"). " +
          "\"replace\": stop any in-flight playback before starting this one (best for conversational turns). " +
          "\"queue\": wait for current playback to finish before starting (best for multi-segment narration). " +
          "\"interrupt\": alias of \"replace\" with explicit barge-in intent."
        ),
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
        instruct,
        mode,
        speed = config.speed,
        volume = config.volume,
      } = args;

      // Pass any provider-specific overrides through `opts`.
      // Each provider reads what it knows about and ignores the rest.
      const opts: Record<string, unknown> = {};
      if (voiceId !== undefined) opts.voiceId = voiceId;
      if (modelId !== undefined) opts.modelId = modelId;
      if (stability !== undefined) opts.stability = stability;
      if (similarity_boost !== undefined) opts.similarityBoost = similarity_boost;
      if (style !== undefined) opts.style = style;
      if (use_speaker_boost !== undefined) opts.useSpeakerBoost = use_speaker_boost;
      if (preserveVoiceDefaults !== undefined) opts.preserveVoiceDefaults = preserveVoiceDefaults;
      if (instruct !== undefined) opts.instruct = instruct;

      return speakViaProvider({
        text,
        volume,
        speed,
        mode: mode as SpeakMode | undefined,
        opts: Object.keys(opts).length ? opts : undefined,
      });
    },
  });

  const voiceTool = tool({
    description: `Control runtime voice mode for tag-driven speech, and manage TTS providers.

Voice mode actions:
- on: enable speaking of <speak>...</speak> blocks (tagged mode)
- off: disable speaking entirely
- status: show current voice mode, active provider, and available providers
- tagged: switch to tagged mode — only speak content inside <speak>...</speak> tags (tags stripped from display)
- tagged-raw: same speech selection as tagged, but preserve raw <speak> tags in the displayed transcript (useful for diagnosing model tag-fidelity issues)
- all: switch to all mode — speak everything except content inside <no-speak>...</no-speak> tags

Provider actions:
- list: list available TTS providers with active marker and one-line summaries
- describe: dump the full CAPABILITIES.md for one provider — pass providerName
- switch: swap the active TTS provider — pass providerName
- ab: speak the same text through providerA then providerB back-to-back for direct comparison — pass providerName (= A), providerB, and text`,
    args: {
      action: tool.schema
        .enum([
          "on", "off", "status",
          "tagged", "tagged-raw", "all",
          "list", "describe", "switch", "ab",
        ])
        .describe("Voice mode or provider action to perform."),
      providerName: tool.schema
        .string()
        .optional()
        .describe("Provider name for describe/switch (single provider) or A side of ab (e.g. 'qwen3-tts')."),
      providerB: tool.schema
        .string()
        .optional()
        .describe("B side of ab action (e.g. 'higgs-audio-v3')."),
      text: tool.schema
        .string()
        .optional()
        .describe("Text to speak through both providers for the ab action. Use the same text for a fair comparison."),
    },
    async execute(args) {
      const action = args.action;
      if (action === "status") {
        return JSON.stringify(
          {
            enabled: config.enabled,
            speakMode: config.speakMode,
            configuredEnabled: config.configuredEnabled,
            provider: registry.getActiveName(),
            availableProviders: registry.listNames(),
            voiceId: config.voiceId,
            modelId: config.modelId,
            preserveVoiceDefaults: config.preserveVoiceDefaults,
            statePath,
          },
          null,
          2,
        );
      }

      if (action === "list") {
        const summaries = registry.listSummaries();
        const lines = summaries.map((s) => {
          const marker = s.active ? "* " : "  ";
          return `${marker}${s.name} — ${s.summary}`;
        });
        return lines.join("\n");
      }

      if (action === "describe") {
        if (!args.providerName) {
          throw new Error("providerName is required for the 'describe' action.");
        }
        return registry.describe(args.providerName as ProviderName);
      }

      if (action === "switch") {
        if (!args.providerName) {
          throw new Error("providerName is required for the 'switch' action.");
        }
        const previous = registry.getActiveName();
        registry.setActive(args.providerName as ProviderName);
        return `Active TTS provider: ${previous} → ${registry.getActiveName()}.`;
      }

      if (action === "ab") {
        if (!args.providerName || !args.providerB || !args.text) {
          throw new Error(
            "The 'ab' action requires providerName (A), providerB, and text.",
          );
        }
        const providerA = args.providerName as ProviderName;
        const providerB = args.providerB as ProviderName;
        const text = args.text;

        // Capture the active provider so we can restore it after the
        // comparison. The user's mental model is that ab is a one-off
        // operation that doesn't permanently change which voice they
        // get for normal speak calls.
        const originalActive = registry.getActiveName();

        // Side A
        registry.setActive(providerA);
        try {
          const handleA = await playbackQueue.speak(
            { text, volume: config.volume, speed: config.speed },
            "replace",
          );
          await handleA.done;
        } catch (err) {
          registry.setActive(originalActive);
          throw new Error(
            `A/B comparison failed during side A (${providerA}): ${(err as Error).message}`,
          );
        }

        // Brief pause between the two utterances so the comparison
        // doesn't run together. The playback queue plays sequentially
        // already; this is an explicit silence-gap for the listener.
        await new Promise((resolve) => setTimeout(resolve, 800));

        // Side B
        registry.setActive(providerB);
        try {
          const handleB = await playbackQueue.speak(
            { text, volume: config.volume, speed: config.speed },
            "replace",
          );
          await handleB.done;
        } catch (err) {
          registry.setActive(originalActive);
          throw new Error(
            `A/B comparison failed during side B (${providerB}): ${(err as Error).message}`,
          );
        }

        registry.setActive(originalActive);
        return `A/B complete: ${providerA} → ${providerB}. Active provider restored to ${originalActive}.`;
      }

      if (!statePath) {
        throw new Error("Voice runtime state is unavailable because the agent directory is missing.");
      }

      if (action === "tagged" || action === "tagged-raw" || action === "all") {
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

      if (config.speakMode === "all") {
        // In all-mode, the entire turn is one logical utterance.
        // Default modality is "replace" so a fresh turn cancels any
        // lingering playback from a prior turn — eliminates double-play
        // when turns arrive back-to-back during conversation.
        const { cleanText, spokenText } = extractAllModeText(output.text);
        output.text = cleanText;
        if (!spokenText) return;
        void speakViaProvider({
          text: spokenText,
          volume: config.volume,
          speed: config.speed,
          mode: "replace",
        }).catch((error) => {
          console.error("[opencode-voice] all-mode speak failed:", error);
        });
        return;
      }

      // Tagged mode (and tagged-raw): extract each <speak> block in
      // document order, preserving its parsed `mode` attribute (or
      // undefined if none was declared). Default resolution rules:
      //   - First block of a turn: default "replace" — fresh turn
      //     cancels any lingering playback from the prior turn.
      //   - Subsequent blocks within the same turn: default "queue"
      //     — multiple tags in one model response narrate in sequence
      //     rather than cancelling each other.
      // Authors who want a later block to interrupt earlier ones in
      // the same turn write mode="replace" or mode="interrupt"
      // explicitly.
      //
      // Display behavior differs by mode:
      //   - "tagged":     output.text rewritten to cleanText (tags stripped)
      //   - "tagged-raw": output.text untouched (raw tags preserved in
      //                   the transcript so you can see exactly what the
      //                   model emitted — useful for diagnosing models
      //                   that mis-emit tag syntax)
      const { cleanText, blocks } = extractTaggedSpeech(output.text);
      if (config.speakMode === "tagged") {
        output.text = cleanText;
      }
      if (!blocks.length) return;

      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        const isFirst = i === 0;
        const resolvedMode: SpeakMode =
          block.mode ?? (isFirst ? DEFAULT_SPEAK_MODE : "queue");
        void speakViaProvider({
          text: block.text,
          volume: config.volume,
          speed: config.speed,
          mode: resolvedMode,
        }).catch((error) => {
          console.error(
            `[opencode-voice] tagged speak block ${i + 1}/${blocks.length} failed:`,
            error,
          );
        });
      }
    },
  };
};
