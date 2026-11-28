export const MARKER_OPEN = "⟦";
export const MARKER_CLOSE = "⟧";

export const INLINE_MARKER_MAX_CHARS = 40;
export const INLINE_MARKER_WORDLESS_MAX_CHARS = 400;

const MARKER_RE = /⟦[^⟦⟧\s]{1,32}⟧/gu;
const TAG_CLEAN_RE = /[^a-z0-9]+/gu;
const COMBINING_MARKS_RE = /[\p{Mn}\p{Mc}\u200c\u200d]/gu;
const TOKEN_GLUE = "[0-9A-Za-z_./:#?=&%~@+\\-]";
const PROSE_WORD_RE = new RegExp(
  `(?<!${TOKEN_GLUE})[\\p{L}]{4,}(?!${TOKEN_GLUE})`,
  "u",
);

/** Return true when rendered inline text carries no prose words (URL, formula, digits). */
export function isWordlessInline(text: string): boolean {
  const cleaned = text.replace(COMBINING_MARKS_RE, "");
  return !PROSE_WORD_RE.test(cleaned);
}

/** Return true when a protected inline element fits within atomic marker bounds. */
export function canBeInlineMarker(renderedText: string): boolean {
  const trimmed = renderedText.trim();
  if (trimmed.length <= INLINE_MARKER_MAX_CHARS) return true;
  return (
    trimmed.length <= INLINE_MARKER_WORDLESS_MAX_CHARS &&
    isWordlessInline(trimmed)
  );
}

export function markerTagName(rawTag: string): string {
  const clean = rawTag.toLowerCase().replace(TAG_CLEAN_RE, "");
  return clean || "x";
}

export function formatMarkerToken(tag: string, ordinal: number): string {
  return `${MARKER_OPEN}${markerTagName(tag)}${ordinal}${MARKER_CLOSE}`;
}

export class MarkerOrdinalSupply {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  allocate(
    rawTag: string,
    occupiedText: string,
    taken: ReadonlySet<string>,
  ): string {
    const clean = markerTagName(rawTag);
    for (;;) {
      const token = `${MARKER_OPEN}${clean}${this.next}${MARKER_CLOSE}`;
      this.next += 1;
      if (!occupiedText.includes(token) && !taken.has(token)) return token;
    }
  }
}

export function findMarkers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const token = match[0];
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

export interface MarkerReconciliation {
  text: string;
  missing: string[];
  invented: string[];
  duplicates: string[];
}

/**
 * Reconcile marker tokens in translated text against issued tokens.
 * Literal source brackets not in `issued` are preserved; invented or repeated
 * issued tokens are scrubbed, and dropped issued tokens are appended in source order.
 */
export function reconcileMarkers(
  sourceText: string,
  translatedText: string,
  issued: readonly string[],
): MarkerReconciliation {
  const issuedSet = new Set(issued);
  const literalSet = new Set(
    findMarkers(sourceText).filter((token) => !issuedSet.has(token)),
  );
  const seen = new Set<string>();
  const invented: string[] = [];
  const duplicates: string[] = [];

  const cleaned = translatedText.replace(MARKER_RE, (token) => {
    if (issuedSet.has(token)) {
      if (seen.has(token)) {
        if (!duplicates.includes(token)) duplicates.push(token);
        return "";
      }
      seen.add(token);
      return token;
    }
    if (literalSet.has(token)) return token;
    if (!invented.includes(token)) invented.push(token);
    return "";
  });

  const missing = issued.filter((token) => !seen.has(token));
  const text = missing.length
    ? `${cleaned.trimEnd()} ${missing.join(" ")}`.trim()
    : cleaned;

  return { text, missing, invented, duplicates };
}

export interface MarkerTextSegment {
  kind: "text" | "marker";
  value: string;
}

/** Split reconciled text into ordered literal-text and marker-token segments. */
export function splitOnMarkers(
  text: string,
  issued: readonly string[],
): MarkerTextSegment[] {
  if (!issued.length) return text ? [{ kind: "text", value: text }] : [];
  const escaped = issued
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(escaped, "gu");
  const segments: MarkerTextSegment[] = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > position) {
      segments.push({ kind: "text", value: text.slice(position, index) });
    }
    segments.push({ kind: "marker", value: match[0] });
    position = index + match[0].length;
  }
  if (position < text.length) {
    segments.push({ kind: "text", value: text.slice(position) });
  }
  return segments;
}
