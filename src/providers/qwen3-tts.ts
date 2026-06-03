import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { request as httpRequest, type IncomingMessage } from "http";
import { URL } from "url";
import type { TTSProvider, TTSRequest, PlaybackHandle } from "./types.js";

/**
 * Side-channel observability log. Written directly from the provider
 * regardless of how OpenCode routes (or fails to route) plugin stderr.
 * One JSON-line per event for trivial parsing and tail -f.
 *
 * tail -f /tmp/qwen3-tts-trace.log    # watch live
 * jq -c '.' < /tmp/qwen3-tts-trace.log  # validate / reformat
 */
const TRACE_PATH = "/tmp/qwen3-tts-trace.log";

function trace(event: string, data: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    });
    appendFileSync(TRACE_PATH, line + "\n");
  } catch {
    /* observability is best-effort; never block on a log failure */
  }
}

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
  /**
   * Language hint sent per-request to stabilize accent. Accepted by
   * vllm-omni v0.22+: "Auto", "English", "French", "Chinese",
   * "Japanese", "Korean", "German", "Russian", "Portuguese",
   * "Spanish", "Italian". Omit to use server default.
   */
  language?: string;
  /**
   * Request streaming PCM output (response_format=pcm + stream=true).
   * When true, the response body is raw 16-bit signed mono PCM at
   * 24kHz, piped directly into `play -t raw` for low TTFB (~10ms vs
   * ~1.9s for non-streaming WAV). Defaults to true.
   */
  stream?: boolean;
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
const DEFAULT_STREAM = true;
const PCM_SAMPLE_RATE_HZ = 24_000;
const PROVIDER_BUILD = "2026-06-03-v11-streaming-http-request";

// Side-channel observability: write a sentinel file at module load so we can
// verify *outside the log* which build OpenCode actually picked up. This file
// is overwritten on every load, including double-loads (we'll see the most
// recent loadedAt timestamp).
try {
  const { writeFileSync } = require("fs");
  writeFileSync(
    "/tmp/qwen3-tts-build.txt",
    `build=${PROVIDER_BUILD}\nloadedAt=${new Date().toISOString()}\npid=${process.pid}\n`,
  );
} catch {
  /* sentinel write best-effort; never block plugin load */
}

trace("module_loaded", { build: PROVIDER_BUILD, pid: process.pid });
console.error(`[qwen3-tts] provider module loaded build=${PROVIDER_BUILD} pid=${process.pid}`);

let handleCounter = 0;
function nextHandleId(): string {
  handleCounter += 1;
  return `q3-${Date.now()}-${handleCounter}`;
}

/**
 * Streaming path via Node's http.request, bypassing Bun's fetch.
 *
 * The fetch-based path hangs on streaming chunked responses from
 * vllm-omni in the OpenCode plugin runtime (confirmed across v8/v9/v10
 * diagnostics — fetch_start fires, no fetch_ok ever follows). The same
 * fetch works in a bare Bun process and via curl, so the issue is
 * specific to the runtime context, not the network or server.
 *
 * http.request gives us explicit chunk-level control: we attach a
 * 'data' handler to the response IncomingMessage and write each chunk
 * straight to the player's stdin as it arrives. No fetch lifecycle,
 * no Response abstraction, no getReader().
 *
 * This is the low-TTFB path. The buffered path (stream=false) stays on
 * fetch() because it works and there's no reason to change it.
 */
function streamViaHttpRequest(
  endpointUrl: string,
  bodyJson: string,
  volume: number,
  callId: string,
  format: "wav" | "pcm",
  timeoutMs: number,
): {
  stop: () => void;
  done: Promise<void>;
  fetchPromise: Promise<void>;
} {
  const playArgs =
    format === "pcm"
      ? [
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
        ]
      : ["-v", String(volume), "-t", "wav", "-"];
  const child = spawn("play", playArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  trace("play_spawn", {
    call_id: callId,
    pid: child.pid,
    format,
    spawn_ms: 0,
    mode: "http_request_stream",
  });

  child.stderr?.on("data", (data) => {
    trace("play_stderr", { call_id: callId, line: data.toString().trim() });
  });
  child.on("error", (err) => {
    trace("play_error", { call_id: callId, error: err.message });
  });

  const playbackDone = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      trace("play_exit", { call_id: callId, code, signal });
      resolve();
    });
    child.on("error", () => resolve());
  });

  const stdin = child.stdin!;
  let cancelled = false;
  let firstChunkAt: number | undefined;
  let chunkCount = 0;
  let totalBytes = 0;
  const requestStart = Date.now();
  let req: ReturnType<typeof httpRequest> | undefined;

  const fetchPromise = new Promise<void>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(endpointUrl);
    } catch (err) {
      reject(err);
      return;
    }

    trace("http_request_start", { call_id: callId, host: u.host, path: u.pathname });
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
        const headersAt = Date.now();
        trace("http_response_headers", {
          call_id: callId,
          status: res.statusCode,
          latency_ms: headersAt - requestStart,
          content_type: res.headers["content-type"],
          transfer_encoding: res.headers["transfer-encoding"],
          content_length: res.headers["content-length"],
        });

        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            reject(
              new Error(
                `Qwen3-TTS endpoint error (${res.statusCode}): ${body || "no body"}`,
              ),
            );
          });
          return;
        }

        res.on("data", (chunk: Buffer) => {
          if (cancelled) return;
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            trace("first_chunk", {
              call_id: callId,
              bytes: chunk.length,
              after_headers_ms: firstChunkAt - headersAt,
              after_request_ms: firstChunkAt - requestStart,
            });
          }
          chunkCount += 1;
          totalBytes += chunk.length;
          if (!stdin.write(chunk)) {
            res.pause();
            stdin.once("drain", () => res.resume());
          }
        });
        res.on("end", () => {
          trace("stream_complete", {
            call_id: callId,
            chunks: chunkCount,
            total_bytes: totalBytes,
            duration_ms: Date.now() - requestStart,
          });
          try {
            stdin.end();
          } catch {
            /* ignore */
          }
          resolve();
        });
        res.on("error", (err) => {
          trace("stream_error", { call_id: callId, error: err.message });
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
      trace("http_request_timeout", { call_id: callId, timeout_ms: timeoutMs });
      req?.destroy(new Error(`http.request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      trace("http_request_error", { call_id: callId, error: err.message });
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

/**
 * Pipe a streaming response body into `sox play` via stdin.
 *
 * Supports two input formats:
 *   - "wav": legacy non-streaming path; the server returns a WAV body
 *     with a normal RIFF header, which sox parses from the stream.
 *   - "pcm": v0.22+ streaming path; the server returns raw 16-bit
 *     signed mono PCM at 24kHz with no header. `play -t raw` is told
 *     the rate / sample width / channel count explicitly so it can
 *     start emitting audio on the first chunk (~10ms TTFB).
 *
 * The pattern mirrors the OmniVoice provider's stream handler. Kept
 * inline here (rather than shared) so the provider remains self-contained;
 * a future refactor can extract the helper to a shared util.
 */
function streamAudioToPlayer(
  stream: ReadableStream,
  volume: number,
  callId: string,
  format: "wav" | "pcm",
): { stop: () => void; done: Promise<void> } {
  const spawnStart = Date.now();
  const playArgs =
    format === "pcm"
      ? [
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
        ]
      : ["-v", String(volume), "-t", "wav", "-"];
  const child = spawn("play", playArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  trace("play_spawn", {
    call_id: callId,
    pid: child.pid,
    format,
    spawn_ms: Date.now() - spawnStart,
  });

  child.stderr?.on("data", (data) => {
    trace("play_stderr", { call_id: callId, line: data.toString().trim() });
  });
  child.on("error", (err) => {
    trace("play_error", { call_id: callId, error: err.message });
  });
  child.on("exit", (code, signal) => {
    trace("play_exit", { call_id: callId, code, signal, duration_ms: Date.now() - spawnStart });
  });

  const done = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  const reader = stream.getReader();
  const stdin = child.stdin!;
  let cancelled = false;
  let firstChunkAt: number | undefined;
  let chunkCount = 0;
  let totalBytes = 0;
  const streamStart = Date.now();

  (async () => {
    try {
      while (!cancelled) {
        const { done: readDone, value } = await reader.read();
        if (readDone) break;
        if (firstChunkAt === undefined) {
          firstChunkAt = Date.now();
          trace("first_chunk", { call_id: callId, bytes: value.length, after_fetch_ms: firstChunkAt - streamStart });
        }
        chunkCount += 1;
        totalBytes += value.length;
        if (!stdin.write(value)) {
          await new Promise<void>((resolve) => stdin.once("drain", resolve));
        }
      }
      trace("stream_complete", {
        call_id: callId,
        chunks: chunkCount,
        total_bytes: totalBytes,
        duration_ms: Date.now() - streamStart,
      });
    } catch (err) {
      trace("stream_error", { call_id: callId, error: (err as Error).message });
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
 * Diagnostic helper: spawn `play` with the right input format and write
 * a single complete buffer to stdin, then close it. Used by the v9
 * diagnostic to remove chunked-stdin-write as a confound for audio
 * quality on the streaming path.
 *
 * Independent of the chunked streaming path in streamAudioToPlayer.
 */
function playBufferOnce(
  bytes: Uint8Array,
  volume: number,
  callId: string,
  format: "wav" | "pcm",
): { stop: () => void; done: Promise<void> } {
  const spawnStart = Date.now();
  const playArgs =
    format === "pcm"
      ? [
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
        ]
      : ["-v", String(volume), "-t", "wav", "-"];
  const child = spawn("play", playArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  trace("play_spawn", {
    call_id: callId,
    pid: child.pid,
    format,
    spawn_ms: Date.now() - spawnStart,
    mode: "buffer_once",
    total_bytes: bytes.length,
  });

  child.stderr?.on("data", (data) => {
    trace("play_stderr", { call_id: callId, line: data.toString().trim() });
  });
  child.on("error", (err) => {
    trace("play_error", { call_id: callId, error: err.message });
  });
  child.on("exit", (code, signal) => {
    trace("play_exit", { call_id: callId, code, signal, duration_ms: Date.now() - spawnStart });
  });

  const done = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  try {
    child.stdin!.write(bytes);
    child.stdin!.end();
  } catch (err) {
    trace("play_stdin_error", { call_id: callId, error: (err as Error).message });
  }

  const stop = () => {
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
  const stream = config.stream ?? DEFAULT_STREAM;
  const responseFormat = stream ? "pcm" : "wav";
  const playerFormat: "wav" | "pcm" = stream ? "pcm" : "wav";

  return {
    name: "qwen3-tts",

    async speak(req: TTSRequest): Promise<PlaybackHandle> {
      const callId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      trace("speak_called", {
        call_id: callId,
        build: PROVIDER_BUILD,
        voice: config.voice,
        model,
        endpoint,
        language: config.language,
        stream,
        chars: req.text.length,
        preview: req.text.substring(0, 80),
      });
      const opts = (req.opts ?? {}) as Qwen3TtsRequestOpts;

      // Resolve instruct: per-call override wins, then config-level default,
      // then omit. Empty strings count as "no instruct".
      const instruct =
        (typeof opts.instruct === "string" && opts.instruct.trim()) ||
        (typeof config.instruct === "string" && config.instruct.trim()) ||
        undefined;

      // Build OpenAI-compatible speech request body.
      // Fields supported by vllm-omni's /v1/audio/speech (v0.22+):
      //   model:           required — the served model identifier ("/model")
      //   input:           required — the text to synthesize
      //   voice:           optional — registered voice name on the server
      //   speed:           optional — speech rate multiplier
      //   instruct:        optional — natural-language prosody directive
      //   language:        optional — language hint ("French" / "English" / …)
      //                    pinned per-request to stabilize accent across
      //                    code-switching utterances
      //   stream:          optional — when true, response is streamed
      //   response_format: optional — "pcm" for raw 16-bit / 24kHz / mono
      //                    streaming (low TTFB), "wav" for legacy buffered
      const body: Record<string, unknown> = {
        model,
        input: req.text,
      };
      if (config.voice !== undefined) body.voice = config.voice;
      if (req.speed !== undefined) body.speed = req.speed;
      if (instruct !== undefined) body.instruct = instruct;
      if (config.language !== undefined) body.language = config.language;
      if (stream) {
        body.stream = true;
        body.response_format = responseFormat;
      }
      if (config.agent !== undefined) body.user = config.agent;

      const bodyJson = JSON.stringify(body);

      // v11: streaming path uses Node's http.request directly, bypassing
      // Bun's fetch. Diagnostics v8/v9/v10 showed that fetch() never
      // resolves on streaming chunked responses from vllm-omni in the
      // OpenCode plugin runtime, regardless of keepalive or arrayBuffer
      // vs getReader(). The same fetch works in a bare Bun process, so
      // the incompatibility is between the harness's fetch context and
      // chunked-no-content-length responses. http.request gives us
      // direct chunk handling and sidesteps the fetch lifecycle entirely.
      if (stream) {
        trace("http_request_dispatch", { call_id: callId, url: `${endpoint}/v1/audio/speech`, body_size: bodyJson.length });
        const { stop, done, fetchPromise } = streamViaHttpRequest(
          `${endpoint}/v1/audio/speech`,
          bodyJson,
          req.volume,
          callId,
          playerFormat,
          timeoutMs,
        );
        fetchPromise.catch((err) => {
          trace("http_request_failed", { call_id: callId, error: (err as Error).message });
        });
        done
          .then(() => trace("playback_done", { call_id: callId }))
          .catch((e) => trace("playback_error", { call_id: callId, error: String(e) }));
        return {
          id: nextHandleId(),
          startedAt: Date.now(),
          stop,
          done,
        };
      }

      // Buffered (non-streaming) path retains the fetch implementation —
      // it works in the plugin runtime and there is no reason to change
      // a working transport.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      const fetchStart = Date.now();
      trace("fetch_start", { call_id: callId, url: `${endpoint}/v1/audio/speech`, body_size: bodyJson.length });
      try {
        response = await fetch(`${endpoint}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyJson,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        trace("fetch_error", { call_id: callId, error: (err as Error).message, latency_ms: Date.now() - fetchStart });
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
      trace("fetch_ok", {
        call_id: callId,
        status: response.status,
        latency_ms: Date.now() - fetchStart,
        content_type: response.headers.get("content-type"),
        transfer_encoding: response.headers.get("transfer-encoding"),
        content_length: response.headers.get("content-length"),
      });

      const { stop, done } = streamAudioToPlayer(response.body, req.volume, callId, playerFormat);

      done.then(() => trace("playback_done", { call_id: callId })).catch((e) => trace("playback_error", { call_id: callId, error: String(e) }));

      return {
        id: nextHandleId(),
        startedAt: Date.now(),
        stop,
        done,
      };
    },
  };
}
