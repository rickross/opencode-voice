import { spawn } from "child_process";
import type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";

/**
 * OmniVoice TTS provider.
 *
 * Talks to a local omnivoice-daemon process via HTTP. The daemon holds
 * the OmniVoice model and a cached VoiceClonePrompt in memory, so each
 * request only pays the generation cost (typically <1× real-time on M4).
 *
 * Audio comes back as a WAV body, which we pipe straight into `sox play`
 * via stdin — same playback path the ElevenLabs provider uses.
 *
 * See daemon/README.md in this repo for daemon setup.
 */
export interface OmniVoiceConfig {
  /** Daemon endpoint, e.g. "http://127.0.0.1:7345". */
  endpoint: string;
  /** Optional per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * OmniVoice-specific options that may be passed per-request via TTSRequest.opts.
 */
export interface OmniVoiceRequestOpts {
  /** Diffusion steps. 16 = faster, 32 = default quality. */
  numStep?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

let handleCounter = 0;
function nextHandleId(): string {
  handleCounter += 1;
  return `ov-${Date.now()}-${handleCounter}`;
}

function streamAudioToPlayer(
  stream: ReadableStream,
  volume: number,
): { stop: () => void; done: Promise<void> } {
  // sox `play` reads wav from stdin via `-t wav`.
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

export function createOmniVoiceProvider(config: OmniVoiceConfig): TTSProvider {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "omnivoice",

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const opts = (req.opts ?? {}) as OmniVoiceRequestOpts;

      const body: Record<string, unknown> = { text: req.text };
      if (req.speed !== undefined) body.speed = req.speed;
      if (opts.numStep !== undefined) body.num_step = opts.numStep;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${endpoint}/speak`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const message =
          err instanceof Error && err.name === "AbortError"
            ? `OmniVoice daemon request timed out after ${timeoutMs}ms`
            : `OmniVoice daemon unreachable at ${endpoint}: ${(err as Error).message}`;
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
          `OmniVoice daemon error (${response.status}): ${detail || response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("OmniVoice daemon returned no body");
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
