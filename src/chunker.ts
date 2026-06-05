/**
 * Sentence-aware text chunker for TTS input.
 *
 * Background: The qwen3-tts model has a hard input ceiling of
 * `max_model_len: 4096` tokens (~6000 mixed English characters).
 * Beyond ~6000 chars the server silently truncates; beyond ~10000
 * chars it enters degenerate generation (24-hour declared duration,
 * no audible content). Both failure modes look like success at the
 * HTTP layer (200 OK, valid WAV header) which makes them especially
 * pernicious.
 *
 * Strategy: pre-split text at natural sentence boundaries when input
 * exceeds a conservative safety threshold (4000 chars), and submit
 * chunks sequentially. Audio plays back-to-back; the natural pause
 * at sentence boundaries reads as good prosody, not as gaps.
 *
 * The chunker preserves:
 *   - Sentence boundaries (., ?, !, …, French punctuation)
 *   - Paragraph boundaries (\n\n) as hard splits
 *   - Quotation marks across boundaries
 *   - Inline tags like [whispers], [excited] (treated as ordinary words)
 *
 * The chunker does NOT try to be smart about clauses or commas —
 * sentence boundaries are the smallest unit it will split on. If a
 * single sentence exceeds the chunk limit, it is emitted as-is and
 * the model truncation behavior takes over (rare in practice; user-
 * written sentences over 4000 chars are vanishingly uncommon).
 */
export interface ChunkOptions {
  /**
   * Max characters per chunk. Default 4000, chosen with margin under
   * the empirically observed 6000-char qwen3-tts ceiling. Increase
   * only if the underlying provider's input ceiling rises.
   */
  maxChars?: number;
  /**
   * Minimum characters per chunk. Below this we prefer to merge a
   * short final chunk into the previous one if that doesn't push us
   * over maxChars. Default 200; tunes the "no awkwardly short final
   * chunk" behavior.
   */
  minChars?: number;
}

// Lowered from 4000 to 2500 after observing sox playback aborts on
// long single-chunk turns (~15 seconds of audio into a 90-second clip,
// the sox player aborted mid-stream and the rest of the audio was
// discarded). 2500 chars typically produces ~60-80 seconds of audio,
// which plays cleanly without sox buffer-saturation issues. The cost
// is more frequent chunk boundaries (audible as natural sentence-end
// pauses) on longer turns.
const DEFAULT_MAX_CHARS = 2500;
const DEFAULT_MIN_CHARS = 200;

/**
 * Sentence terminator regex. Matches end-of-sentence punctuation
 * followed by whitespace or end-of-string. Includes English (.?!),
 * ellipsis (…), and the same punctuation in French context (the
 * Unicode forms are identical).
 *
 * Uses a lookahead so the terminator stays attached to the sentence
 * it ended.
 */
const SENTENCE_BOUNDARY = /([.!?…])(\s+|$)/g;

/**
 * Split text into sentences. Preserves the terminator punctuation
 * with the sentence it ends. Returns an array of trimmed sentences.
 */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  SENTENCE_BOUNDARY.lastIndex = 0;
  while ((match = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const end = match.index + match[1].length;
    const piece = text.slice(lastIndex, end).trim();
    if (piece) sentences.push(piece);
    lastIndex = end + match[2].length;
  }
  const tail = text.slice(lastIndex).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * Greedily pack sentences into chunks of up to maxChars.
 *
 * If a single sentence exceeds maxChars on its own, emit it as its
 * own chunk anyway — better to send oversized than to split mid-
 * sentence and produce audibly clipped prosody. This is rare in
 * practice (sentences over 4000 chars are extraordinarily uncommon
 * in real prose) and the cost of that rare case is silent server-
 * side truncation rather than catastrophic failure.
 */
function packSentencesIntoChunks(
  sentences: string[],
  maxChars: number,
  minChars: number,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    const candidate = current + " " + sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);

  // Tail-merge: if the last chunk is awkwardly short and the merged
  // result still fits, fold it into the previous chunk for prosody.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.length < minChars && prev.length + 1 + last.length <= maxChars) {
      chunks[chunks.length - 2] = prev + " " + last;
      chunks.pop();
    }
  }
  return chunks;
}

/**
 * Split text into TTS-ready chunks.
 *
 * The shape: split first on paragraph boundaries (\n\n) — always,
 * regardless of total input length. Then within each paragraph,
 * split on sentence boundaries and pack sentences greedily into
 * chunks of up to maxChars.
 *
 * Why paragraph-split is unconditional: empirically, the Higgs
 * Audio v3 model interprets internal blank lines (\n\n) as "text
 * is done" and emits silence-tokens for the remainder of its token
 * budget — producing a long file containing only the first
 * paragraph of speech followed by ~60 seconds of near-silence.
 * Qwen3-TTS handles paragraph breaks more gracefully but still
 * benefits from explicit splitting (cleaner prosody, no risk of
 * the chunker swallowing structural breaks the writer intended).
 *
 * So: never send a chunk containing an internal `\n\n` to any
 * provider. Each paragraph becomes its own chunk; chunks play
 * back-to-back; paragraph breaks become natural pauses between
 * audio segments rather than confused-model failure modes.
 *
 * Single-paragraph inputs short enough to fit in one chunk are
 * still returned as a single-element array (no per-sentence
 * packing needed).
 */
export function chunkForTTS(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

  const trimmed = text.trim();
  if (!trimmed) return [];

  // Always split on paragraph boundaries first, regardless of total
  // length. This is the fix for the Higgs-paragraph-silence bug:
  // never let a chunk contain an internal `\n\n`.
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Fast path: single paragraph that fits in one chunk. No further
  // splitting work needed.
  if (paragraphs.length === 1 && paragraphs[0].length <= maxChars) {
    return [paragraphs[0]];
  }

  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      chunks.push(paragraph);
      continue;
    }
    const sentences = splitIntoSentences(paragraph);
    const packed = packSentencesIntoChunks(sentences, maxChars, minChars);
    for (const c of packed) chunks.push(c);
  }

  return chunks;
}
