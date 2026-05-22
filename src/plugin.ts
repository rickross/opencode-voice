import { tool, type Plugin } from "@opencode-ai/plugin";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";

/**
 * Default constants
 */
const DEFAULT_VOICE_ID = "YOq2y2Up4RgXP2HyXjE5";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_ENABLED = true;
const DEFAULT_API_KEY_PATH = join(
  homedir(),
  ".config/opencode/secrets/elevenlabs-key"
);
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
 *     "voiceId": "abc123",
 *     "modelId": "eleven_v3",
 *     "stability": 0.4
 *   }
 */
export interface VoiceConfig {
  voiceId?: string;
  modelId?: string;
  /** Path to file containing the ElevenLabs API key */
  apiKeyPath?: string;
  enabled?: boolean | "on" | "off" | "default";
  /**
   * Speech mode:
   *   "tagged" (default) — only speak content wrapped in <speak>...</speak> tags
   *   "all"              — speak everything except content wrapped in <no-speak>...</no-speak> tags
   */
  speakMode?: "tagged" | "all";
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  preserveVoiceDefaults?: boolean;
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

type SpeakRequest = {
  text: string;
  voiceId: string;
  modelId: string;
  apiKeyPath: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
  volume: number;
  preserveVoiceDefaults?: boolean;
};

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function loadApiKey(apiKeyPath: string): string {
  try {
    return readFileSync(apiKeyPath, "utf-8").trim();
  } catch {
    throw new Error(
      `Failed to read ElevenLabs API key from ${apiKeyPath}. ` +
        `Please create this file with your API key.`
    );
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
  // Remove <no-speak> blocks entirely from the spoken version
  const spokenText = text
    .replace(/<no-speak>[\s\S]*?<\/no-speak>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Strip just the tags from the displayed text, keeping the content visible
  const cleanText = text.replace(/<\/?no-speak>/gi, "");

  return { cleanText, spokenText };
}

function streamAudio(stream: ReadableStream, volume: number): void {
  // sox `play` reads mp3 from stdin — lightweight, no GUI
  const child = spawn(
    "play",
    ["-v", String(volume), "-t", "mp3", "-"],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] }
  );
  child.unref();

  const reader = stream.getReader();
  const stdin = child.stdin!;

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { stdin.end(); break; }
        stdin.write(value);
      }
    } catch {
      stdin.end();
    }
  })();
}

async function startSpeech(request: SpeakRequest): Promise<string> {
  const {
    text,
    voiceId,
    modelId,
    apiKeyPath,
    stability,
    similarityBoost,
    style,
    useSpeakerBoost,
    speed,
    volume,
    preserveVoiceDefaults,
  } = request;

  const apiKey = loadApiKey(apiKeyPath);

  const voiceSettings = preserveVoiceDefaults
    ? undefined
    : {
        ...(stability !== undefined ? { stability } : {}),
        ...(similarityBoost !== undefined ? { similarity_boost: similarityBoost } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(useSpeakerBoost !== undefined ? { use_speaker_boost: useSpeakerBoost } : {}),
        ...(speed !== undefined ? { speed } : {}),
      };

  const body = {
    text,
    model_id: modelId,
    ...(voiceSettings && Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}),
  };

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
  }

  streamAudio(response.body!, volume);

  const preview = text.length > 80 ? text.substring(0, 80) + "..." : text;
  return `<speak_started>
Playing speech (non-blocking): "${preview}"
Voice: ${voiceId}
Model: ${modelId}
</speak_started>`;
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
    voiceId: voiceOptions?.voiceId ?? agentConfig?.voiceId ?? DEFAULT_VOICE_ID,
    modelId: voiceOptions?.modelId ?? agentConfig?.modelId ?? DEFAULT_MODEL_ID,
    apiKeyPath: voiceOptions?.apiKeyPath ?? agentConfig?.apiKeyPath ?? DEFAULT_API_KEY_PATH,
    enabled: runtimeState?.enabled ?? resolveEnabled(configuredEnabled),
    configuredEnabled,
    speakMode: (runtimeState?.speakMode ?? voiceOptions?.speakMode ?? agentConfig?.speakMode ?? "tagged") as "tagged" | "all",
    stability: voiceOptions?.stability ?? agentConfig?.stability ?? 0.5,
    similarityBoost: voiceOptions?.similarityBoost ?? agentConfig?.similarityBoost ?? 0.75,
    style: voiceOptions?.style ?? agentConfig?.style,
    useSpeakerBoost: voiceOptions?.useSpeakerBoost ?? agentConfig?.useSpeakerBoost,
    preserveVoiceDefaults: voiceOptions?.preserveVoiceDefaults ?? agentConfig?.preserveVoiceDefaults ?? false,
    speed: voiceOptions?.speed ?? agentConfig?.speed ?? 1.0,
    volume: voiceOptions?.volume ?? agentConfig?.volume ?? 1.0,
  };

  const speakTool = tool({
    description: `Convert text to speech using ElevenLabs v3 and play it on the device speakers (non-blocking).

Uses the expressive v3 model which supports inline audio tags for emotional control, 
delivery direction, non-verbal reactions, accents, and sound effects.

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
        voiceId = config.voiceId,
        modelId = config.modelId,
        stability = config.stability,
        similarity_boost = config.similarityBoost,
        style = config.style,
        use_speaker_boost = config.useSpeakerBoost,
        preserveVoiceDefaults = config.preserveVoiceDefaults,
        speed = config.speed,
        volume = config.volume,
      } = args;

      return startSpeech({
        text,
        voiceId,
        modelId,
        apiKeyPath: config.apiKeyPath,
        stability,
        similarityBoost: similarity_boost,
        style,
        useSpeakerBoost: use_speaker_boost,
        speed,
        volume,
        preserveVoiceDefaults,
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
      void startSpeech({
        text: spokenText,
        voiceId: config.voiceId,
        modelId: config.modelId,
        apiKeyPath: config.apiKeyPath,
        stability: config.stability,
        similarityBoost: config.similarityBoost,
        style: config.style,
        useSpeakerBoost: config.useSpeakerBoost,
        speed: config.speed,
        volume: config.volume,
        preserveVoiceDefaults: config.preserveVoiceDefaults,
      }).catch((error) => {
        console.error("[opencode-voice] tagged speak failed:", error);
      });
    },
  };
};
