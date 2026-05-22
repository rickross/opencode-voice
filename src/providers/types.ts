/**
 * Provider-agnostic interfaces for text-to-speech backends.
 *
 * Any backend (ElevenLabs, OmniVoice, future) implements TTSProvider.
 * The plugin core does not import backend-specific code — only this file.
 */

/**
 * Request to speak a piece of text.
 *
 * Provider-agnostic fields are first-class. Backend-specific options
 * (e.g. ElevenLabs stability, OmniVoice num_step) live under `opts`.
 */
export interface TTSRequest {
  /** The text to synthesize and play. */
  text: string;
  /** Playback volume, 0.0 – 2.0. */
  volume: number;
  /** Optional speech rate multiplier. */
  speed?: number;
  /**
   * Backend-specific options. The shape is provider-defined; the core
   * passes this through opaquely.
   */
  opts?: Record<string, unknown>;
}

/**
 * A handle to an in-flight or queued playback.
 *
 * Returned by `provider.speak()`. The core uses this to coordinate
 * queueing, interruption, and completion tracking.
 */
export interface PlaybackHandle {
  /** Unique id for this playback within the session. */
  id: string;
  /** Wall-clock timestamp (ms) when speak() was called. */
  startedAt: number;
  /** Stop playback immediately (SIGTERM the player). Idempotent. */
  stop(): void;
  /** Resolves when playback finishes (either naturally or via stop()). */
  done: Promise<void>;
}

/**
 * A TTS backend implementation.
 *
 * `name` is a stable identifier used in config and logs.
 * `speak()` returns a handle as soon as playback has started (non-blocking).
 */
export interface TTSProvider {
  readonly name: string;
  speak(req: TTSRequest): Promise<PlaybackHandle>;
}
