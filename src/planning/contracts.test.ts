/**
 * Behavioral tests for the PROPOSED planning-host wire contracts. These
 * schemas validate untrusted wire syntax only — a passing parse never
 * establishes host identity, grants, evidence, or publication readiness
 * (see contracts.ts). No mocks, no sidecar process, no authenticity
 * helpers: this file only exercises the Zod schemas themselves.
 */
import { describe, expect, test } from "bun:test";
import {
  adapterCapabilitiesSchema,
  publicationIntentSchema,
  rawHostInvocationSchema,
} from "./contracts";

const VALID_RAW_INVOCATION = {
  protocolVersion: 1 as const,
  hostId: "host-abc",
  sessionId: "ses_123",
  messageId: "msg_1",
  callId: "call_1",
  agent: "agent-a",
  tool: "ide_open_panel",
};

describe("rawHostInvocationSchema", () => {
  test("happy path: valid raw invocation round-trips unchanged", () => {
    const result = rawHostInvocationSchema.safeParse(VALID_RAW_INVOCATION);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_RAW_INVOCATION);
    }
  });

  test("error: wrong protocolVersion (number) is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      protocolVersion: 2,
    });
    expect(result.success).toBe(false);
  });

  test("error: protocolVersion as string is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      protocolVersion: "1",
    });
    expect(result.success).toBe(false);
  });

  test("error: missing hostId is rejected", () => {
    const { hostId: _hostId, ...rest } = VALID_RAW_INVOCATION;
    const result = rawHostInvocationSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("error: blank (whitespace-only) sessionId is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      sessionId: "   ",
    });
    expect(result.success).toBe(false);
  });

  test("error: empty string messageId is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      messageId: "",
    });
    expect(result.success).toBe(false);
  });

  test("error: callId containing a control character is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      callId: "call_1\u0000tail",
    });
    expect(result.success).toBe(false);
  });

  test("error: agent containing a newline control character is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      agent: "agent-a\ninjected",
    });
    expect(result.success).toBe(false);
  });

  test("error: tool exceeding 256 chars is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      tool: "t".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  test("happy path: field exactly at the 256-char boundary is accepted", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      tool: "t".repeat(256),
    });
    expect(result.success).toBe(true);
  });

  test("characterization: the 256 budget counts UTF-16 code units — 128 astral emoji (256 code units) accepted, emoji bytes preserved", () => {
    const emoji256 = "\u{1F680}".repeat(128);
    expect(emoji256.length).toBe(256);
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      tool: emoji256,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe(emoji256);
    }
  });

  test("characterization: 129 astral emoji (258 code units) exceeds the budget and is rejected", () => {
    const emoji258 = "\u{1F680}".repeat(129);
    expect(emoji258.length).toBe(258);
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      tool: emoji258,
    });
    expect(result.success).toBe(false);
  });

  test("byte preservation: leading/trailing spaces are non-blank and pass through unchanged (no trim)", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      hostId: "  host-abc  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hostId).toBe("  host-abc  ");
    }
  });

  test("regression: a C1 control character (U+0085 NEL) is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      hostId: "host\u0085abc",
    });
    expect(result.success).toBe(false);
  });

  test("legitimate Unicode formatting/emoji is not banned as a control character", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      agent: "agent-\u{1F680}-a\u200d",
    });
    expect(result.success).toBe(true);
  });

  test("error: unexpected 'trusted' field is rejected (strict, no authenticity flags)", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      trusted: true,
    });
    expect(result.success).toBe(false);
  });

  test("error: unexpected 'grants' field is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      grants: ["planning:write"],
    });
    expect(result.success).toBe(false);
  });

  test("error: unexpected 'token' field is rejected", () => {
    const result = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      token: "bearer-secret",
    });
    expect(result.success).toBe(false);
  });

  test("does not claim authenticity: two fabricated but well-shaped claims both parse without auth", () => {
    const a = rawHostInvocationSchema.safeParse(VALID_RAW_INVOCATION);
    const b = rawHostInvocationSchema.safeParse({
      ...VALID_RAW_INVOCATION,
      hostId: "host-completely-different",
      agent: "agent-impersonator",
    });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});

describe("adapterCapabilitiesSchema", () => {
  test("happy path: empty capabilities array is valid", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 1,
      capabilities: [],
    });
    expect(result.success).toBe(true);
  });

  test("happy path: all four known capabilities accepted", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 1,
      capabilities: [
        "principal-context",
        "dispatch-correlation",
        "unit-boundary",
        "verification-provenance",
      ],
    });
    expect(result.success).toBe(true);
  });

  test("error: unknown capability literal is rejected", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 1,
      capabilities: ["principal-context", "root-access"],
    });
    expect(result.success).toBe(false);
  });

  test("error: duplicate capability entries are rejected", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 1,
      capabilities: ["principal-context", "principal-context"],
    });
    expect(result.success).toBe(false);
  });

  test("error: extra unexpected field is rejected", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 1,
      capabilities: ["principal-context"],
      verified: true,
    });
    expect(result.success).toBe(false);
  });

  test("error: wrong protocolVersion is rejected", () => {
    const result = adapterCapabilitiesSchema.safeParse({
      protocolVersion: 2,
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("publicationIntentSchema", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);

  test("happy path: expectedExternalVersion 'absent' with valid ids/hash accepted", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(true);
  });

  test("happy path: expectedExternalVersion 'sha256' variant with valid hash accepted", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "sha256", value: SHA_A },
      candidateSha256: SHA_B,
    });
    expect(result.success).toBe(true);
  });

  test("error: 'sha256' variant with wrong-length hash is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "sha256", value: "abc123" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: 'sha256' variant with uppercase hex is rejected (lowercase only)", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "sha256", value: SHA_A.toUpperCase() },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: candidateSha256 with invalid characters is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: "z".repeat(64),
    });
    expect(result.success).toBe(false);
  });

  test("error: operationId starting with a hyphen (not alphanumeric-first) is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "-op1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: documentId containing a path separator is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "../etc/passwd",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: operationId exceeding 128 chars is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "a".repeat(129),
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: unexpected 'callerPrincipal' field is rejected (strict, no authz flags)", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
      callerPrincipal: "agent-a",
    });
    expect(result.success).toBe(false);
  });

  test("error: unexpected 'authorized' field is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
      authorized: true,
    });
    expect(result.success).toBe(false);
  });

  test("error: expectedExternalVersion union with unknown 'kind' is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "ready" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("error: expectedExternalVersion 'absent' variant with extra field is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent", value: SHA_A },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("regression: operationId with a trailing LF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1\n",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("regression: documentId with a trailing CRLF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1\r\n",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: SHA_A,
    });
    expect(result.success).toBe(false);
  });

  test("regression: candidateSha256 with a trailing LF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: `${SHA_A}\n`,
    });
    expect(result.success).toBe(false);
  });

  test("regression: candidateSha256 with a trailing CRLF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "absent" },
      candidateSha256: `${SHA_A}\r\n`,
    });
    expect(result.success).toBe(false);
  });

  test("regression: expectedExternalVersion sha256 value with a trailing LF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "sha256", value: `${SHA_A}\n` },
      candidateSha256: SHA_B,
    });
    expect(result.success).toBe(false);
  });

  test("regression: expectedExternalVersion sha256 value with a trailing CRLF is rejected", () => {
    const result = publicationIntentSchema.safeParse({
      protocolVersion: 1,
      operationId: "op_1",
      documentId: "doc_1",
      expectedExternalVersion: { kind: "sha256", value: `${SHA_A}\r\n` },
      candidateSha256: SHA_B,
    });
    expect(result.success).toBe(false);
  });
});
