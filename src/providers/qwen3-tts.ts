import { spawn } from "child_process";
import type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";

/**
 * Qwen3-TTS provider.
 *
 * Talks to a vllm-omni server hosting Qwen/Qwen3-TTS-12Hz-1.7B-Base via
 * the OpenAI-compatible /v1/audio/speech endpoint. The server keeps the
 * model resident and holds a per-agent voice registry (ref_audio + ref_text)
 * keyed by voice name, so each request only pays the generation cost
 * (~4× real-time factor on warm path).
 *
 * Audio comes back as a WAV body, which we pipe straight into `sox play`
 * via stdin — same playback path the OmniVoice provider uses.
 *
 * The reference deployment is Zion's qwen3-tts.service on port 5009.
 * Voice cloning quality, RTF, and French/code-switching fidelity exceed
 * both the prior OmniVoice-Mac path and the ElevenLabs cloud path.
 */
export interface Qwen3TtsConfig {
  /** Endpoint root, e.g. "http://zion.irelate.ai:5009". */
  endpoint: string;
  /** Optional per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Which voice the server should use. Must be a name already registered
   * in vllm-omni's voice registry (e.g. "solene", "aurora", "telos").
   * Omit to fall back to the server's default voice if it has one
   * configured.
   */
  voice?: string;
  /**
   * Model identifier as seen by the OpenAI-compatible endpoint. For
   * vllm-omni this is the model path the server was started with —
   * default "/model" matches the qwen3-tts.service ExecStart.
   */
  model?: string;
  /**
   * Diagnostic caller id. Not used for routing or auth; sent as an
   * extra field for log correlation. May be surfaced by future
   * server-side observability.
   */
  agent?: string;
  /**
   * Default natural-language prosody / style directive for this agent.
   * Maps to Qwen3-TTS's `instruct` field. Examples:
   *   "Speak in a warm, intimate tone with French sensibility."
   *   "Excited, animated delivery."
   *   "Whispered, slow, contemplative."
   *
   * Applied to every utterance unless overridden per-call via
   * TTSRequest.opts.instruct.
   */
  instruct?: string;
}

/**
 * Qwen3-TTS-specific options that may be passed per-request via
 * TTSRequest.opts. Set by the plugin from tool arguments when an
 * agent wants to dial in prosody for a specific utterance.
 */
export interface Qwen3TtsRequestOpts {
  /**
   * Natural-language prosody directive for this single utterance.
   * Overrides the config-level default when present.
   */
  instruct?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = "/model";

let handleCounter = 0;
function nextHandleId(): string {
  handleCounter += 1;
  return `q3-${Date.now()}-${handleCounter}`;
}

/**
 * Pipe a streaming WAV response body into `sox play` via stdin.
 *
 * The pattern mirrors the OmniVoice provider's stream handler. Kept
 * inline here (rather than shared) so the provider remains self-contained;
 * a future refactor can extract the helper to a shared util.
 */
function streamAudioToPlayer(
  stream: ReadableStream,
  volume: number,
): { stop: () => void; done: Promise<void> } {
  const child = spawn("play", ["-v", String(volume), "-t", "wav", "-"], {
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

export function createQwen3TtsProvider(config: Qwen3TtsConfig): TTSProvider {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = config.model ?? DEFAULT_MODEL;

  return {
    name: "qwen3-tts",

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const opts = (req.opts ?? {}) as Qwen3TtsRequestOpts;

      // Resolve instruct: per-call override wins, then config-level default,
      // then omit. Empty strings count as "no instruct".
      const instruct =
        (typeof opts.instruct === "string" && opts.instruct.trim()) ||
        (typeof config.instruct === "string" && config.instruct.trim()) ||
        undefined;

      // Build OpenAI-compatible speech request body.
      // Fields supported by vllm-omni's /v1/audio/speech:
      //   model:    required — the served model identifier
      //   input:    required — the text to synthesize
      //   voice:    optional — registered voice name on the server
      //   speed:    optional — speech rate multiplier
      //   instruct: optional — natural-language prosody directive
      //                        (Qwen3-TTS specific feature)
      const body: Record<string, unknown> = {
        model,
        input: req.text,
      };
      if (config.voice !== undefined) body.voice = config.voice;
      if (req.speed !== undefined) body.speed = req.speed;
      if (instruct !== undefined) body.instruct = instruct;
      if (config.agent !== undefined) body.user = config.agent;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${endpoint}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const message =
          err instanceof Error && err.name === "AbortError"
            ? `Qwen3-TTS endpoint request timed out after ${timeoutMs}ms`
            : `Qwen3-TTS endpoint unreachable at ${endpoint}: ${(err as Error).message}`;
        throw new Error(message);
      }
      clearTimeout(timeoutHandle);

      if (!response.ok) {
        let detail = "";
        try {
          detail = await response.text();
        } catch {
          /* ignore */
        }
        throw new Error(
          `Qwen3-TTS endpoint error (${response.status}): ${detail || response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("Qwen3-TTS endpoint returned no body");
      }

      const { stop, done } = streamAudioToPlayer(response.body, req.volume);

      return {
        id: nextHandleId(),
        startedAt: Date.now(),
        stop,
        done,
      };
    },
  };
}
