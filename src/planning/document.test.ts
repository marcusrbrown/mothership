/**
 * Behavioral tests for the immutable canonical-source document model
 * (see document.ts, U2). No mocks: pure string/byte round trips only.
 */
import { describe, expect, test } from "bun:test";
import { documentBytes, documentSlice, parseDocument } from "./document";

describe("parseDocument: happy path", () => {
  test("plain ASCII source round-trips through source and bytes", () => {
    const src = "# Title\n\nSome text.\n";
    const result = parseDocument(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(src);
    expect(result.value.length).toBe(src.length);
    expect(new TextDecoder().decode(documentBytes(result.value))).toBe(src);
  });

  test("parsing valid UTF-8 bytes decodes to the equivalent string", () => {
    const src = "héllo wörld — 日本語 🎉\n";
    const bytes = new TextEncoder().encode(src);
    const result = parseDocument(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(src);
  });

  test("leading BOM is preserved as content on round trip (bytes input)", () => {
    const withoutBom = "# Title\ntext\n";
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(withoutBom),
    ]);
    const result = parseDocument(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.startsWith("\uFEFF")).toBe(true);
    expect(result.value.source).toBe(`\uFEFF${withoutBom}`);
    const roundTripped = documentBytes(result.value);
    expect(roundTripped[0]).toBe(0xef);
    expect(roundTripped[1]).toBe(0xbb);
    expect(roundTripped[2]).toBe(0xbf);
  });

  test("leading BOM already present in a string is preserved as-is", () => {
    const src = "\uFEFF# Title\ntext\n";
    const result = parseDocument(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(src);
  });

  test("CRLF line endings are preserved exactly", () => {
    const src = "line one\r\nline two\r\n";
    const result = parseDocument(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(src);
    expect(result.value.source.includes("\r\n")).toBe(true);
  });

  test("trailing newline presence/absence is preserved exactly", () => {
    const withNl = parseDocument("a\nb\n");
    const withoutNl = parseDocument("a\nb");
    expect(withNl.ok && withNl.value.source.endsWith("\n")).toBe(true);
    expect(withoutNl.ok && withoutNl.value.source.endsWith("\n")).toBe(false);
  });
});

describe("parseDocument: error path", () => {
  test("invalid UTF-8 byte sequence is rejected, not replaced", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0xff, 0xfe, 0x6c, 0x6c, 0x6f]);
    const result = parseDocument(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-utf8");
  });

  test("truncated multi-byte UTF-8 sequence is rejected", () => {
    // 0xE2 0x82 is the start of a 3-byte sequence (e.g. U+20AC) with the
    // final byte missing.
    const bytes = new Uint8Array([0x61, 0xe2, 0x82]);
    const result = parseDocument(bytes);
    expect(result.ok).toBe(false);
  });

  test("unpaired high surrogate in a string is rejected", () => {
    const src = `before${String.fromCharCode(0xd800)}after`;
    const result = parseDocument(src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unpaired-surrogate");
  });

  test("unpaired low surrogate in a string is rejected", () => {
    const src = `before${String.fromCharCode(0xdc00)}after`;
    const result = parseDocument(src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unpaired-surrogate");
  });

  test("a valid surrogate pair (emoji) is accepted, not flagged as unpaired", () => {
    const src = "before🎉after";
    const result = parseDocument(src);
    expect(result.ok).toBe(true);
  });
});

describe("document identity and immutability", () => {
  test("documentBytes returns a fresh copy each call, not a shared alias", () => {
    const result = parseDocument("abc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = documentBytes(result.value);
    const second = documentBytes(result.value);
    expect(first).not.toBe(second);
    first[0] = 0;
    expect(documentBytes(result.value)[0]).not.toBe(0);
  });

  test("mutating the input byte buffer after parsing does not affect the document", () => {
    const bytes = new TextEncoder().encode("original");
    const result = parseDocument(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    bytes[0] = 0;
    expect(result.value.source).toBe("original");
  });

  test("the document object is frozen", () => {
    const result = parseDocument("abc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe("documentSlice", () => {
  test("slices UTF-16 offsets, not byte offsets", () => {
    const result = parseDocument("日本語 test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "日本語" is 3 UTF-16 code units even though it is 9 UTF-8 bytes.
    expect(documentSlice(result.value, { start: 0, end: 3 })).toBe("日本語");
  });

  test("an out-of-bounds range throws rather than silently clamping", () => {
    const result = parseDocument("abc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => documentSlice(result.value, { start: 0, end: 100 })).toThrow();
  });
});
