import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { TTSProvider, TTSRequest, PlaybackHandle } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPABILITIES_DOC = readFileSync(join(__dirname, "CAPABILITIES.md"), "utf-8");

/**
 * Higgs Audio v3 TTS provider.
 *
 * Talks to a SGLang-Omni server hosting bosonai/higgs-audio-v3-tts-4b
 * via the OpenAI-compatible /v1/audio/speech endpoint.
 *
 * Reference deployment: Zion at http://172.22.1.1:5012 (publicly
 * http://zion.irelate.ai:5012 inside the iRelate VPN), 24kHz output,
 * BF16 weights, GPU 4.
 *
 * Voice selection has three paths:
 *
 *   1. Voice key (`voice: "solene"`) — server-side mapping to a
 *      precomputed codes file (e.g. /mnt/warehouse/voices/codes/solene.json).
 *      Fast and deterministic. Default for cadre voices.
 *
 *   2. Live reference audio + transcript (`references: [{audio_path, text}]`
 *      or the `ref_audio`/`ref_text` shorthand). The server encodes the
 *      reference on each call. Slower but useful for one-off voices that
 *      haven't been pre-encoded yet.
 *
 *   3. Pre-loaded reference codes (`referenceCodes`) — caller has already
 *      loaded the codes JSON. Bypasses the server's voice-key lookup.
 *
 * Inline control tags (<|emotion:...|>, <|style:...|>, <|prosody:...|>,
 * <|sfx:...|>) are part of the text and pass through unchanged. The
 * model interprets them at synthesis time.
 *
 * Response format defaults to WAV. The SGLang-Omni server also accepts
 * "mp3", "flac", "opus", "aac", and "pcm" — pcm is the lowest-TTFA
 * path when paired with stream:true and stream_format:"audio".
 *
 * This first cut supports WAV and MP3 non-streaming only. Streaming
 * (SSE WAV chunks or raw PCM) will land in a follow-up commit using
 * the same http.request workaround qwen3-tts already uses.
 *
 * See ./CAPABILITIES.md for the full control surface and the canonical
 * SGLang-Omni request shape:
 * https://sgl-project.github.io/sglang-omni/cookbook/higgs_tts.html
 */
export interface HiggsAudioV3Config {
  /** Endpoint root, e.g. "http://zion.irelate.ai:5012". */
  endpoint: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Default voice key. Resolves server-side to a precomputed codes
   * file at /mnt/warehouse/voices/codes/<voice>.json. Common cadre
   * voices: solene, aurora, telos, kai, starshine, digby.
   *
   * Ignored when `references` or `referenceCodes` are set per-request.
   */
  voice?: string;
  /**
   * Diagnostic caller id. Not used for routing or auth; emitted as a
   * field on each request body for server-side log correlation.
   */
  agent?: string;
  /**
   * Sampling temperature. Default 0.8 (overrides the SGLang-Omni
   * server default of 1.0). Lower = more deterministic.
   */
  temperature?: number;
  /**
   * Top-k sampling. Default 50 (the SGLang-Omni server default is
   * null = no top-k limit, but 50 is the conventional Higgs setting).
   */
  topK?: number;
  /**
   * Max new tokens to generate. Default 1024 (overrides the SGLang-Omni
   * server default of 2048). One token ≈ 40ms of audio at 25fps.
   */
  maxNewTokens?: number;
  /**
   * Response audio format. Accepted by SGLang-Omni:
   *   "wav" (default), "mp3", "flac", "opus", "aac", "pcm"
   *
   * This first cut supports wav and mp3 non-streaming. pcm requires
   * the streaming path which is not yet wired up here.
   */
  responseFormat?: "wav" | "mp3";
  /** Streaming will be added in a follow-up commit. */
  stream?: boolean;
}

/**
 * Higgs-specific per-request options. Passed through TTSRequest.opts
 * by the speak tool when an agent wants to override config defaults
 * for one utterance.
 */
export interface HiggsAudioV3RequestOpts {
  /** Override the default voice for this utterance. */
  voice?: string;
  /**
   * Live reference audio + transcript pairs. When provided, the
   * server encodes the references and uses them instead of any
   * `voice`-keyed precomputed codes. Each item has `audio_path`
   * (local path or HTTP URL) and `text` (transcript).
   */
  references?: Array<{
    audio_path: string;
    text: string;
  }>;
  /**
   * SGLang-Omni shorthand for `references[0].audio_path`. Convenient
   * for single-reference clones — equivalent to setting
   * `references: [{audio_path, text}]`.
   */
  refAudio?: string;
  /** Shorthand for `references[0].text`. Used with `refAudio`. */
  refText?: string;
  /**
   * Pre-loaded reference codes (8-codebook arrays from a precomputed
   * JSON file). Skips both encoding and the server's voice-key lookup.
   *
   * Wired as `reference_codes` in the request body for the SGLang-Omni
   * server's precomputed-codes path.
   */
  referenceCodes?: number[][];
  /** Per-utterance sampling temperature override. */
  temperature?: number;
  /** Per-utterance top_k override. */
  topK?: number;
  /** Per-utterance max_new_tokens override. */
  maxNewTokens?: number;
  /** Per-utterance response_format override. */
  responseFormat?: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_K = 50;
const DEFAULT_MAX_NEW_TOKENS = 1024;
const DEFAULT_RESPONSE_FORMAT = "wav" as const;

let handleCounter = 0;
function nextHandleId(): string {
  handleCounter += 1;
  return `higgs-${Date.now()}-${handleCounter}`;
}

function streamAudioToPlayer(
  stream: ReadableStream,
  volume: number,
  format: "wav" | "mp3",
): { stop: () => void; done: Promise<void> } {
  // `play -t <format> -` reads the indicated container from stdin.
  // wav and mp3 both have framed headers that sox can pick up
  // mid-stream; raw pcm (when we add it for streaming) needs explicit
  // -r/-e/-b/-c flags.
  const child = spawn("play", ["-v", String(volume), "-t", format, "-"], {
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

export function createHiggsAudioV3Provider(config: HiggsAudioV3Config): TTSProvider {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "higgs-audio-v3",
    capabilitiesDoc: CAPABILITIES_DOC,

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const opts = (req.opts ?? {}) as HiggsAudioV3RequestOpts;
      const responseFormat =
        opts.responseFormat ?? config.responseFormat ?? DEFAULT_RESPONSE_FORMAT;

      // Build the request body. Voice selection precedence:
      //   1. Per-call referenceCodes (caller already loaded the JSON)
      //   2. Per-call references (server will encode)
      //   3. Per-call refAudio+refText shorthand (server will encode)
      //   4. Per-call voice (server uses precomputed codes)
      //   5. Config-default voice
      const body: Record<string, unknown> = {
        input: req.text,
        response_format: responseFormat,
        temperature: opts.temperature ?? config.temperature ?? DEFAULT_TEMPERATURE,
        top_k: opts.topK ?? config.topK ?? DEFAULT_TOP_K,
        max_new_tokens:
          opts.maxNewTokens ?? config.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
      };

      if (opts.referenceCodes) {
        body.reference_codes = opts.referenceCodes;
      } else if (opts.references) {
        body.references = opts.references;
      } else if (opts.refAudio !== undefined) {
        // SGLang-Omni accepts both shapes; normalize the shorthand into
        // the canonical `references` array so the server path is
        // uniform regardless of which the caller used.
        body.references = [
          {
            audio_path: opts.refAudio,
            ...(opts.refText !== undefined ? { text: opts.refText } : {}),
          },
        ];
      } else {
        const voice = opts.voice ?? config.voice;
        if (voice !== undefined) body.voice = voice;
      }

      if (req.speed !== undefined) body.speed = req.speed;
      if (config.agent !== undefined) body.agent = config.agent;

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
            ? `Higgs Audio v3 request timed out after ${timeoutMs}ms`
            : `Higgs Audio v3 endpoint unreachable at ${endpoint}: ${(err as Error).message}`;
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
          `Higgs Audio v3 error (${response.status}): ${detail || response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("Higgs Audio v3 returned no body");
      }

      const { stop, done } = streamAudioToPlayer(response.body, req.volume, responseFormat);

      return {
        id: nextHandleId(),
        startedAt: Date.now(),
        stop,
        done,
      };
    },
  };
}
