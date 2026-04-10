import { tool, type Plugin } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";

/**
 * Default constants
 */
const DEFAULT_VOICE_ID = "YOq2y2Up4RgXP2HyXjE5";
const DEFAULT_MODEL_ID = "eleven_v3";
const DEFAULT_API_KEY_PATH = join(
  homedir(),
  ".config/opencode/secrets/elevenlabs-key"
);
const CONFIG_FILE = "voice.json";

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
  stability?: number;
  similarityBoost?: number;
  speed?: number;
  volume?: number;
}

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

function playAudio(filePath: string, volume: number): void {
  const child = spawn("afplay", ["-v", String(volume), filePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("exit", () => {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  });
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

  // Merge: defaults < agent voice.json < inline plugin options
  const config = {
    voiceId: voiceOptions?.voiceId ?? agentConfig?.voiceId ?? DEFAULT_VOICE_ID,
    modelId: voiceOptions?.modelId ?? agentConfig?.modelId ?? DEFAULT_MODEL_ID,
    apiKeyPath: voiceOptions?.apiKeyPath ?? agentConfig?.apiKeyPath ?? DEFAULT_API_KEY_PATH,
    stability: voiceOptions?.stability ?? agentConfig?.stability ?? 0.5,
    similarityBoost: voiceOptions?.similarityBoost ?? agentConfig?.similarityBoost ?? 0.75,
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
- Use in SHORT BURSTS to notify the user of important state changes
- Good for: task completion, errors requiring attention, questions needing user input
- Keep messages concise (1-2 sentences) - don't read entire responses aloud
- Examples of when to use:
  * "[excited] Done! The build succeeded."
  * "[curious] I have a question - should I proceed with the refactor?"
  * "[sighs] I found 3 errors we need to fix."
  * "[whispers] Heads up - I'm about to make a breaking change."`,

    args: {
      text: tool.schema
        .string()
        .describe(
          "The text to convert to speech. Can include audio tags like [laughs], [whispers], [excited], etc."
        ),
      stability: tool.schema.number().min(0).max(1).optional()
        .describe("Voice stability (0-1). Lower = more expressive. Default from config."),
      similarity_boost: tool.schema.number().min(0).max(1).optional()
        .describe("How closely to match the original voice (0-1). Default from config."),
      speed: tool.schema.number().min(0.5).max(2.0).optional()
        .describe("Speech speed multiplier (0.5-2.0). Default from config."),
      volume: tool.schema.number().min(0).max(2).optional()
        .describe("Playback volume (0-2). Default from config."),
    },

    async execute(args) {
      const {
        text,
        stability = config.stability,
        similarity_boost = config.similarityBoost,
        speed = config.speed,
        volume = config.volume,
      } = args;

      const apiKey = loadApiKey(config.apiKeyPath);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: config.modelId,
            voice_settings: {
              stability,
              similarity_boost,
              style: 0,
              use_speaker_boost: true,
              speed,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      const tempFile = join(tmpdir(), `opencode-voice-${Date.now()}.mp3`);
      writeFileSync(tempFile, Buffer.from(audioBuffer));

      playAudio(tempFile, volume);

      const preview = text.length > 80 ? text.substring(0, 80) + "..." : text;
      return `<speak_started>
Playing speech (non-blocking): "${preview}"
Voice: ${config.voiceId}
Model: ${config.modelId} (v3 expressive)
</speak_started>`;
    },
  });

  return {
    tool: { speak: speakTool },
  };
};
