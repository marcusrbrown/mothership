/**
 * Immutable canonical-source document model (U2). A `PlanDocument` is the
 * verbatim original Markdown source — BOM, CRLF/LF, trailing newlines,
 * Unicode, comments, frontmatter, fenced blocks, and unknown syntax all
 * survive unchanged. Nothing here parses Markdown structure; see units.ts.
 */

/** A half-open UTF-16 code-unit range `[start, end)` into a document's
 * `source` string — directly usable with `String.prototype.slice`. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Immutable canonical document. `source` is a JS string (already
 * immutable); `length` is its UTF-16 code-unit length. */
export interface PlanDocument {
  readonly source: string;
  readonly length: number;
}

export type DocumentErrorKind = "invalid-utf8" | "unpaired-surrogate";

export interface DocumentError {
  readonly kind: DocumentErrorKind;
  readonly message: string;
}

export type DocumentResult =
  | { readonly ok: true; readonly value: PlanDocument }
  | { readonly ok: false; readonly error: DocumentError };

// A lone (unpaired) UTF-16 surrogate: a high surrogate not followed by a
// low surrogate, or a low surrogate not preceded by a high surrogate.
const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkNoUnpairedSurrogates(source: string): DocumentError | null {
  if (!UNPAIRED_SURROGATE_RE.test(source)) return null;
  return {
    kind: "unpaired-surrogate",
    message: "source contains an unpaired UTF-16 surrogate code unit",
  };
}

function freezeDocument(source: string): PlanDocument {
  return Object.freeze({ source, length: source.length });
}

/**
 * Parse a document from either a string or raw UTF-8 bytes.
 *
 * Bytes are decoded strictly (`fatal: true`); invalid UTF-8 (including
 * truncated multi-byte sequences) is rejected rather than replaced with
 * U+FFFD. A leading byte-order mark is preserved as a literal U+FEFF
 * character in `source` (`ignoreBOM: true`) so it round-trips through
 * `documentBytes`. String input is checked for unpaired surrogates,
 * which cannot occur from a strict UTF-8 decode but can occur in a
 * hand-built JS string.
 */
export function parseDocument(input: string | Uint8Array): DocumentResult {
  if (typeof input === "string") {
    const error = checkNoUnpairedSurrogates(input);
    if (error) return { ok: false, error };
    return { ok: true, value: freezeDocument(input) };
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input,
    );
  } catch {
    return {
      ok: false,
      error: { kind: "invalid-utf8", message: "input is not valid UTF-8" },
    };
  }
  return { ok: true, value: freezeDocument(source) };
}

/** Fresh UTF-8 bytes for the document's full source; never a shared alias. */
export function documentBytes(document: PlanDocument): Uint8Array {
  return new TextEncoder().encode(document.source);
}

/** Slice `document.source` by UTF-16 offsets. Throws on an out-of-bounds
 * or inverted range — ranges are produced internally and an invalid one
 * signals a caller bug, not user input to recover from. */
export function documentSlice(
  document: PlanDocument,
  range: SourceRange,
): string {
  if (
    range.start < 0 ||
    range.end > document.length ||
    range.start > range.end
  ) {
    throw new RangeError(
      `source range [${range.start}, ${range.end}) is out of bounds for document of length ${document.length}`,
    );
  }
  return document.source.slice(range.start, range.end);
}
