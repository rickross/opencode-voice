import type { PlaybackHandle, TTSProvider, TTSRequest } from "./providers/types.js";

/**
 * Speak modality:
 *   - "replace"   — stop any current playback, then begin this one immediately
 *   - "queue"     — wait for current playback to finish, then begin this one
 *   - "interrupt" — alias of "replace" with explicit barge-in semantics
 *                   (kept as a distinct name so future divergence is possible)
 */
export type SpeakMode = "replace" | "queue" | "interrupt";

export const DEFAULT_SPEAK_MODE: SpeakMode = "replace";

/**
 * Centralized playback coordinator.
 *
 * The plugin holds exactly one PlaybackQueue. Every call to provider.speak()
 * goes through it. This is what prevents double-play: when a new "replace"
 * call arrives, the queue stops the previous handle before starting the new
 * one. When a "queue" call arrives, it waits in line.
 *
 * The queue is intentionally small. It does not try to be a general-purpose
 * audio scheduler — only the discipline needed for clean turn-by-turn voice:
 *
 *   - At most one playback is live at any moment.
 *   - "replace" cancels the live one, drops anything still queued, starts fresh.
 *   - "queue" appends behind whatever is pending.
 *   - "interrupt" behaves like "replace" with intent flagged in logs.
 *
 * It is not safe to call from multiple processes (it lives in plugin memory
 * only) but that matches the plugin's single-process lifetime.
 */
export class PlaybackQueue {
  /** The currently-playing handle, if any. */
  private current: PlaybackHandle | undefined;

  /**
   * Sequential queue of pending requests. Each entry's `start()` runs
   * after the previous one's playback completes (or is stopped).
   */
  private pending: Array<{
    req: TTSRequest;
    resolve: (h: PlaybackHandle) => void;
    reject: (e: unknown) => void;
  }> = [];

  /**
   * True while we are actively draining the queue. Used to prevent
   * re-entrant drains when a "queue" call arrives mid-drain.
   */
  private draining = false;

  constructor(private readonly provider: TTSProvider) {}

  /**
   * True while a `startNow` is in flight (between calling provider.speak
   * and that promise resolving). Used to prevent race conditions where
   * back-to-back submissions both see `current === undefined` because
   * neither provider call has resolved yet.
   */
  private starting = false;

  /**
   * Submit a speak request with explicit modality.
   *
   * Returns a promise that resolves to the PlaybackHandle once the
   * underlying provider has started streaming. For "queue" calls
   * this may take some time (waiting for previous playbacks).
   */
  async speak(req: TTSRequest, mode: SpeakMode = DEFAULT_SPEAK_MODE): Promise<PlaybackHandle> {
    if (mode === "replace" || mode === "interrupt") {
      // Drop anything queued. Caller wins; everyone else loses cleanly.
      const dropped = this.pending.splice(0);
      for (const d of dropped) {
        // Resolve with a no-op handle so awaiting callers don't hang.
        d.resolve(makeDroppedHandle());
      }
      // Stop the currently-playing handle if any.
      if (this.current) {
        try { this.current.stop(); } catch { /* ignore */ }
        // Wait for the previous one to finish exiting before starting
        // the new one — this avoids racing two `play` processes for the
        // audio output device, which is what produced "double play"
        // when the previous architecture spawned the new player while
        // the old one was still draining stdin.
        try { await this.current.done; } catch { /* ignore */ }
        this.current = undefined;
      }
      const handle = await this.startNow(req);
      return handle;
    }

    // mode === "queue": wait behind anything in flight. We always
    // enqueue and run through drain() — never take a fast path here.
    // Synchronous fast paths race when the same tick submits multiple
    // queue calls before any provider.speak() promise has resolved
    // (both submissions see current === undefined and start in
    // parallel).
    return new Promise<PlaybackHandle>((resolve, reject) => {
      this.pending.push({ req, resolve, reject });
      void this.drain();
    });
  }

  /**
   * Stop the current playback and drop everything pending.
   * Idempotent.
   */
  stopAll(): void {
    const dropped = this.pending.splice(0);
    for (const d of dropped) d.resolve(makeDroppedHandle());
    if (this.current) {
      try { this.current.stop(); } catch { /* ignore */ }
      this.current = undefined;
    }
  }

  /**
   * Start a request right now, with no waiting. Updates `current` and
   * arranges for it to be cleared when playback finishes.
   *
   * The `starting` flag is held from entry until the provider returns
   * a handle, so concurrent drain attempts and queue submissions can
   * see "something is launching" even before `current` is set.
   */
  private async startNow(req: TTSRequest): Promise<PlaybackHandle> {
    this.starting = true;
    try {
      const handle = await this.provider.speak(req);
      this.current = handle;
      void handle.done.finally(() => {
        // Only clear if we're still the current handle. A subsequent
        // "replace" may have already moved past us.
        if (this.current?.id === handle.id) {
          this.current = undefined;
        }
        // After natural completion, drain anything queued.
        void this.drain();
      });
      return handle;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Drive sequential playback through the pending queue.
   * Re-entrancy guard prevents double-drains. Will not pull from
   * the queue while a playback is in flight (`current` set) or while
   * a launch is in progress (`starting` flag set).
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (
        this.pending.length &&
        !this.current &&
        !this.starting
      ) {
        const next = this.pending.shift()!;
        try {
          const handle = await this.startNow(next.req);
          next.resolve(handle);
          // Wait for this playback to actually finish before pulling
          // the next from the queue. We want sequential, not overlap.
          try { await handle.done; } catch { /* ignore */ }
        } catch (err) {
          next.reject(err);
          // Don't break — continue trying subsequent queue entries.
          // A failed call doesn't poison the rest of the queue.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/**
 * Return a no-op PlaybackHandle for callers whose request was dropped
 * by a subsequent "replace". They get a valid handle they can await
 * without it hanging; `done` resolves immediately.
 */
function makeDroppedHandle(): PlaybackHandle {
  return {
    id: `dropped-${Date.now()}`,
    startedAt: Date.now(),
    stop: () => { /* already dropped */ },
    done: Promise.resolve(),
  };
}
