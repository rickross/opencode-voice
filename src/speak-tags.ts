/**
 * <speak> tag parsing for tagged-mode voice output.
 *
 * Supports an optional `mode` attribute on the opening tag:
 *
 *   <speak>...</speak>                 (default mode, currently "replace")
 *   <speak mode="replace">...</speak>  (explicit form of default)
 *   <speak mode="queue">...</speak>    (wait for prior speech to finish)
 *   <speak mode="interrupt">...</speak> (alias of replace, distinct name)
 *
 * Any unrecognized mode value falls back to "replace" with no error
 * (we don't want a typo to silence speech — better to play it in the
 * sensible default than to skip it).
 *
 * Multiple <speak> blocks in one message are returned in order with
 * each block's mode preserved. The cleanText return value is the
 * input with the <speak> wrappers removed but the inner text retained,
 * so the displayed transcript still contains everything the model said.
 */

import type { SpeakMode } from "./playback-queue.js";

export interface SpeakBlock {
  text: string;
  /**
   * The mode declared on the <speak> tag, if any.
   *
   * Returns `undefined` when no `mode` attribute was present (or when
   * the attribute value was unrecognized). The caller resolves this to
   * a concrete SpeakMode based on context — typically, the first block
   * of a turn defaults to "replace" and subsequent blocks default to
   * "queue" so multiple tags in one model response narrate in sequence.
   */
  mode: SpeakMode | undefined;
}

export interface ExtractedSpeech {
  /** Original text with <speak> wrappers stripped but inner content kept. */
  cleanText: string;
  /** Ordered list of speak blocks with their resolved modes. */
  blocks: SpeakBlock[];
}

/**
 * Match <speak> with optional whitespace and optional attributes.
 * Captures the entire attributes portion for separate parsing.
 *
 * The regex requires an explicit closing tag; unclosed openers do not
 * match (and produce no speech), matching the discipline established
 * in the prior extractSpeakBlocks function. This is intentional: it
 * prevents a tag-shaped string inside discussion-of-the-tag context
 * from consuming arbitrary downstream content.
 */
const SPEAK_TAG = /<speak\b([^>]*)>([\s\S]*?)<\/speak>/gi;

/**
 * Extract a mode value from the attributes string of a <speak> tag.
 * Returns the recognized SpeakMode, or undefined when no mode attribute
 * was present or its value was unrecognized. The caller decides what
 * the default should be for the position of this block in the turn.
 */
function parseMode(attrs: string): SpeakMode | undefined {
  // Look for mode="value" or mode='value'. Anything else falls through.
  const m = /\bmode\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (!m) return undefined;
  const raw = (m[2] ?? m[3] ?? "").toLowerCase().trim();
  if (raw === "replace" || raw === "queue" || raw === "interrupt") {
    return raw;
  }
  return undefined;
}

/**
 * Walk the input, accumulating speak blocks and a cleaned display
 * version. Empty inner text (after trim) is skipped silently.
 */
export function extractSpeakBlocks(text: string): ExtractedSpeech {
  const blocks: SpeakBlock[] = [];
  const cleanText = text.replace(SPEAK_TAG, (_match, attrs, inner) => {
    const trimmed = String(inner).trim();
    if (!trimmed) return "";
    blocks.push({ text: trimmed, mode: parseMode(String(attrs)) });
    return trimmed;
  });
  return { cleanText, blocks };
}
