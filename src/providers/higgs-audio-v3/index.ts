import { spawn } from "child_process";
import { readFileSync } from "fs";
import { request as httpRequest, type IncomingMessage } from "http";
import { dirname, join } from "path";
import { URL, fileURLToPath } from "url";
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
   * Default voice key for the server's built-in presets (e.g. "default",
   * "jake"). The SGLang-Omni server does NOT currently resolve cadre
   * voice keys like "solene" — that name falls through to default. For
   * cadre voices use `refAudio` + `refText` below.
   *
   * Ignored when `refAudio` is set, or when per-request `references` /
   * `referenceCodes` are set.
   */
  voice?: string;
  /**
   * Server-side path or URL to a reference audio clip used for voice
   * cloning. The SGLang-Omni container reads this path from its own
   * filesystem (typically `/voices/samples/<voice>.mp3`), not from
   * the client's filesystem. Pair with `refText` for cleanest clones.
   *
   * When set, this overrides `voice` and triggers the live-reference
   * path for every call this provider serves. This is the recommended
   * path for cadre voices until the server-side `voice: <name>` →
   * codes-file lookup is fixed.
   */
  refAudio?: string;
  /**
   * Transcript of the reference audio clip. Strongly recommended when
   * `refAudio` is set — supplying the transcript materially improves
   * cloning fidelity (per SGLang-Omni cookbook).
   */
  refText?: string;
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
   * For non-streaming, pick "wav" or "mp3". For streaming, "pcm" is
   * the recommended choice (raw 16-bit signed mono 24kHz, no SSE
   * wrapping, lowest TTFA). When `stream: true` the provider
   * automatically uses `stream_format: "audio"` + `response_format: "pcm"`
   * regardless of this setting so the streaming-path defaults are
   * consistent with the SGLang-Omni recommendation.
   */
  responseFormat?: "wav" | "mp3";
  /**
   * When true, stream raw PCM bytes from the server and pipe directly
   * into `play -t raw -r 24000 -e signed -b 16 -c 1 -` for lowest
   * time-to-first-audio. The server returns audio/pcm bytes (no SSE
   * wrapping) when `stream_format: "audio"` + `response_format: "pcm"`
   * are set, which this provider does automatically when stream=true.
   *
   * When false (default), the provider sends a non-streaming request
   * and pipes the whole WAV/MP3 body to the player when it arrives.
   */
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
const DEFAULT_MAX_NEW_TOKENS = 4096;
const DEFAULT_RESPONSE_FORMAT = "wav" as const;
const DEFAULT_STREAM = false;
const PCM_SAMPLE_RATE_HZ = 24_000;

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

/**
 * Streaming PCM path via Node's http.request, bypassing fetch.
 *
 * Mirrors the same shape qwen3-tts uses for its streaming path. The
 * OpenCode plugin runtime has been observed to hang on streaming
 * chunked responses through fetch(); http.request avoids it by giving
 * us explicit chunk-level control via the IncomingMessage 'data'
 * event.
 *
 * The server returns raw 16-bit signed mono PCM at 24kHz with no
 * header when `stream: true` + `stream_format: "audio"` +
 * `response_format: "pcm"` are set. `play -t raw -r 24000 -e signed -b 16 -c 1`
 * is told the format explicitly so it can emit audio on the first chunk
 * (sub-second TTFA).
 */
function streamPcmViaHttpRequest(
  endpointUrl: string,
  bodyJson: string,
  volume: number,
  timeoutMs: number,
): { stop: () => void; done: Promise<void>; fetchPromise: Promise<void> } {
  const child = spawn(
    "play",
    [
      "-v",
      String(volume),
      "-t",
      "raw",
      "-r",
      String(PCM_SAMPLE_RATE_HZ),
      "-e",
      "signed",
      "-b",
      "16",
      "-c",
      "1",
      "-",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );

  const playbackDone = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  const stdin = child.stdin!;
  let cancelled = false;
  let req: ReturnType<typeof httpRequest> | undefined;

  const fetchPromise = new Promise<void>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(endpointUrl);
    } catch (err) {
      reject(err);
      return;
    }

    req = httpRequest(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyJson),
          Accept: "*/*",
        },
      },
      (res: IncomingMessage) => {
        if (process.env.OPENCODE_VOICE_DEBUG !== "0") {
          console.error(
            `[higgs-audio-v3] response: status=${res.statusCode} content-type=${res.headers["content-type"] ?? "?"}`,
          );
        }

        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            reject(
              new Error(
                `Higgs Audio v3 streaming error (${res.statusCode}): ${body || "no body"}`,
              ),
            );
          });
          return;
        }

        let bytesReceived = 0;
        res.on("data", (chunk: Buffer) => {
          if (cancelled) return;
          bytesReceived += chunk.length;
          if (!stdin.write(chunk)) {
            res.pause();
            stdin.once("drain", () => res.resume());
          }
        });
        res.on("end", () => {
          if (process.env.OPENCODE_VOICE_DEBUG !== "0") {
            const seconds = (bytesReceived / 48000).toFixed(2);
            console.error(
              `[higgs-audio-v3] stream complete: ${bytesReceived} bytes (~${seconds}s @ 24kHz 16-bit mono)`,
            );
          }
          try {
            stdin.end();
          } catch {
            /* ignore */
          }
          resolve();
        });
        res.on("error", (err) => {
          try {
            stdin.end();
          } catch {
            /* ignore */
          }
          reject(err);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req?.destroy(new Error(`Higgs Audio v3 http.request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
      reject(err);
    });

    req.write(bodyJson);
    req.end();
  });

  const stop = () => {
    cancelled = true;
    try {
      req?.destroy();
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  return { stop, done: playbackDone, fetchPromise };
}

export function createHiggsAudioV3Provider(config: HiggsAudioV3Config): TTSProvider {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "higgs-audio-v3",
    capabilitiesDoc: CAPABILITIES_DOC,

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const opts = (req.opts ?? {}) as HiggsAudioV3RequestOpts;
      const stream = config.stream ?? DEFAULT_STREAM;

      // Format selection.
      //   - Streaming forces response_format="pcm" + stream_format="audio"
      //     per the SGLang-Omni cookbook recommendation for lowest TTFA.
      //   - Non-streaming honors opts.responseFormat ?? config.responseFormat,
      //     defaulting to "wav".
      const responseFormat: "wav" | "mp3" | "pcm" = stream
        ? "pcm"
        : opts.responseFormat ?? config.responseFormat ?? DEFAULT_RESPONSE_FORMAT;

      // Build the request body. Voice selection precedence
      // (per-call wins over config; references win over voice key):
      //   1. Per-call referenceCodes (caller already loaded the JSON)
      //   2. Per-call references array (canonical multi-ref shape)
      //   3. Per-call refAudio+refText shorthand
      //   4. Config-level refAudio+refText — recommended for cadre voices
      //   5. Per-call voice (server preset lookup, e.g. "default", "jake")
      //   6. Config-default voice
      const body: Record<string, unknown> = {
        input: req.text,
        response_format: responseFormat,
        temperature: opts.temperature ?? config.temperature ?? DEFAULT_TEMPERATURE,
        top_k: opts.topK ?? config.topK ?? DEFAULT_TOP_K,
        max_new_tokens:
          opts.maxNewTokens ?? config.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
      };

      if (stream) {
        body.stream = true;
        // stream_format=audio bypasses SSE wrapping for raw PCM bytes.
        body.stream_format = "audio";
      }

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
      } else if (config.refAudio !== undefined) {
        // Config-level reference: use on every speak() call. This is
        // the recommended path for cadre voices since the SGLang-Omni
        // `voice: <name>` → codes lookup currently falls through to
        // default on our deployment.
        body.references = [
          {
            audio_path: config.refAudio,
            ...(config.refText !== undefined ? { text: config.refText } : {}),
          },
        ];
      } else {
        const voice = opts.voice ?? config.voice;
        if (voice !== undefined) body.voice = voice;
      }

      if (req.speed !== undefined) body.speed = req.speed;
      if (config.agent !== undefined) body.agent = config.agent;

      const endpointUrl = `${endpoint}/v1/audio/speech`;
      const bodyJson = JSON.stringify(body);

      if (process.env.OPENCODE_VOICE_DEBUG !== "0") {
        // Log a redacted view of the request: full input text, key params,
        // but trim references array's transcript for noise control.
        const debugBody: Record<string, unknown> = {
          input: body.input,
          response_format: body.response_format,
          stream: body.stream,
          stream_format: body.stream_format,
          temperature: body.temperature,
          top_k: body.top_k,
          max_new_tokens: body.max_new_tokens,
        };
        if (body.references) debugBody.references = "[ref array]";
        if (body.reference_codes) debugBody.reference_codes = "[codes array]";
        if (body.voice) debugBody.voice = body.voice;
        console.error(
          `[higgs-audio-v3] POST ${endpointUrl} body=${JSON.stringify(debugBody)}`,
        );
      }

      // Streaming PCM path (http.request, no fetch). Returns immediately
      // with a handle; the player consumes the chunked PCM as it arrives.
      if (stream) {
        const { stop, done, fetchPromise } = streamPcmViaHttpRequest(
          endpointUrl,
          bodyJson,
          req.volume,
          timeoutMs,
        );
        // Surface server-side errors (4xx/5xx, connection failure) by
        // letting fetchPromise reject. We await its first tick so the
        // caller sees the error here rather than via the playback handle.
        fetchPromise.catch((err) => {
          // The fetch promise rejection doesn't automatically abort the
          // playback child; stop() handles that.
          stop();
          // The rejection will also propagate via `done` because stdin.end()
          // closes the player, which exits and resolves done().
          // We log to stderr so it's visible without needing to await.
          console.error(`[higgs-audio-v3] streaming error:`, err);
        });

        return {
          id: nextHandleId(),
          startedAt: Date.now(),
          stop,
          done,
        };
      }

      // Non-streaming WAV/MP3 path (fetch + buffered body).
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(endpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyJson,
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

      const { stop, done } = streamAudioToPlayer(
        response.body,
        req.volume,
        responseFormat as "wav" | "mp3",
      );

      return {
        id: nextHandleId(),
        startedAt: Date.now(),
        stop,
        done,
      };
    },
  };
}
