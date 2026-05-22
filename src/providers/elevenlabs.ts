import { readFileSync } from "fs";
import { spawn } from "child_process";
import type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";

/**
 * ElevenLabs streaming TTS provider.
 *
 * Calls the ElevenLabs `/stream` endpoint and pipes the audio bytes
 * directly into `sox play` via stdin. No temp file required.
 */
export interface ElevenLabsConfig {
  voiceId: string;
  modelId: string;
  apiKeyPath: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  preserveVoiceDefaults?: boolean;
}

/**
 * ElevenLabs-specific options that may be passed per-request via TTSRequest.opts.
 */
export interface ElevenLabsRequestOpts {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  preserveVoiceDefaults?: boolean;
}

let handleCounter = 0;
function nextHandleId(): string {
  handleCounter += 1;
  return `el-${Date.now()}-${handleCounter}`;
}

function loadApiKey(apiKeyPath: string): string {
  try {
    return readFileSync(apiKeyPath, "utf-8").trim();
  } catch {
    throw new Error(
      `Failed to read ElevenLabs API key from ${apiKeyPath}. ` +
        `Please create this file with your API key.`,
    );
  }
}

function buildVoiceSettings(merged: ElevenLabsConfig & ElevenLabsRequestOpts) {
  if (merged.preserveVoiceDefaults) return undefined;
  const settings: Record<string, unknown> = {};
  if (merged.stability !== undefined) settings.stability = merged.stability;
  if (merged.similarityBoost !== undefined) settings.similarity_boost = merged.similarityBoost;
  if (merged.style !== undefined) settings.style = merged.style;
  if (merged.useSpeakerBoost !== undefined) settings.use_speaker_boost = merged.useSpeakerBoost;
  return Object.keys(settings).length ? settings : undefined;
}

function streamAudioToPlayer(
  stream: ReadableStream,
  volume: number,
): { stop: () => void; done: Promise<void> } {
  // sox `play` reads mp3 from stdin — lightweight, no GUI
  const child = spawn("play", ["-v", String(volume), "-t", "mp3", "-"], {
    stdio: ["pipe", "ignore", "ignore"],
  });

  const done = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  const reader = stream.getReader();
  const stdin = child.stdin!;
  let cancelled = false;

  (async () => {
    try {
      while (!cancelled) {
        const { done: readDone, value } = await reader.read();
        if (readDone) break;
        if (!stdin.write(value)) {
          await new Promise<void>((resolve) => stdin.once("drain", resolve));
        }
      }
    } catch {
      // network or stream errors — fall through and end stdin
    } finally {
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
    }
  })();

  const stop = () => {
    cancelled = true;
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  return { stop, done };
}

export function createElevenLabsProvider(config: ElevenLabsConfig): TTSProvider {
  return {
    name: "elevenlabs",

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const opts = (req.opts ?? {}) as ElevenLabsRequestOpts;
      const merged: ElevenLabsConfig & ElevenLabsRequestOpts = {
        voiceId: opts.voiceId ?? config.voiceId,
        modelId: opts.modelId ?? config.modelId,
        apiKeyPath: config.apiKeyPath,
        stability: opts.stability ?? config.stability,
        similarityBoost: opts.similarityBoost ?? config.similarityBoost,
        style: opts.style ?? config.style,
        useSpeakerBoost: opts.useSpeakerBoost ?? config.useSpeakerBoost,
        preserveVoiceDefaults: opts.preserveVoiceDefaults ?? config.preserveVoiceDefaults,
      };

      const apiKey = loadApiKey(merged.apiKeyPath);
      const voiceSettings = buildVoiceSettings(merged);

      const body = {
        text: req.text,
        model_id: merged.modelId,
        ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
      };

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${merged.voiceId}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
      }

      const { stop, done } = streamAudioToPlayer(response.body!, req.volume);

      return {
        id: nextHandleId(),
        startedAt: Date.now(),
        stop,
        done,
      };
    },
  };
}
