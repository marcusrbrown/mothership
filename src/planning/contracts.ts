/**
 * PROPOSED raw wire syntax for a future planning host adapter (see
 * docs/plans/2026-09-07-001-feat-agent-native-planning-plan.md, U1).
 * A passing parse validates SYNTAX only — never host identity, grants,
 * authorization, evidence, or publication readiness. No runtime
 * integration with a real host, sidecar, or filesystem happens here.
 */
import { z } from "zod";

/** Wire-protocol version for every schema in this module. Bumped only
 * when a schema's wire shape changes incompatibly. */
export const PLANNING_WIRE_PROTOCOL_VERSION = 1;

// Unicode Cc category = C0 controls (U+0000-001F), DEL (U+007F), and C1
// controls (U+0080-009F, e.g. NEL U+0085) — exactly "control characters",
// never legitimate formatting/emoji (those are category Cf/So, not Cc).
const CONTROL_CHAR_RE = /\p{Cc}/u;

// 1..256 UTF-16 code units, not blank, no control chars; validated as-is, never trimmed.
const wireStringSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  })
  .refine((value) => !CONTROL_CHAR_RE.test(value), {
    message: "must not contain control characters",
  });

/** Raw, UNTRUSTED host-invocation claim; a successful parse carries no
 * identity guarantee. `.strict()` closes the shape so no credential,
 * grant, "trusted", or "verified" field can be smuggled through. */
export const rawHostInvocationSchema = z
  .object({
    protocolVersion: z.literal(PLANNING_WIRE_PROTOCOL_VERSION),
    hostId: wireStringSchema,
    sessionId: wireStringSchema,
    messageId: wireStringSchema,
    callId: wireStringSchema,
    agent: wireStringSchema,
    tool: wireStringSchema,
  })
  .strict();
export type RawHostInvocation = z.infer<typeof rawHostInvocationSchema>;

// Full capability vocabulary; anything outside this set is rejected.
export const ADAPTER_CAPABILITIES = [
  "principal-context",
  "dispatch-correlation",
  "unit-boundary",
  "verification-provenance",
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

/** An adapter's self-reported capability set — a CLAIM, not proof; it
 * does not itself enable any capability. */
export const adapterCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(PLANNING_WIRE_PROTOCOL_VERSION),
    capabilities: z.array(z.enum(ADAPTER_CAPABILITIES)),
  })
  .strict()
  .refine(
    (value) => new Set(value.capabilities).size === value.capabilities.length,
    {
      message: "capabilities must not contain duplicate entries",
      path: ["capabilities"],
    },
  );
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;

// Opaque ID: alnum first char, then alnum/_/-, 1..128 chars; no path separators.
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const opaqueIdSchema = z.string().regex(OPAQUE_ID_RE);

// Lowercase-only 64-char hex digest; uppercase is rejected, never normalized.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const sha256HexSchema = z.string().regex(SHA256_HEX_RE);

// Optimistic-concurrency baseline: no prior version expected, or an exact one.
const expectedExternalVersionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("sha256"), value: sha256HexSchema }).strict(),
]);
export type ExpectedExternalVersion = z.infer<
  typeof expectedExternalVersionSchema
>;

/** A caller's UNTRUSTED intent to publish. Describes WHAT to publish
 * and WHAT it expects to overwrite — not WHO may do it or WHETHER the
 * publish may proceed. `.strict()` rejects any raw path, principal, or
 * authorization flag. */
export const publicationIntentSchema = z
  .object({
    protocolVersion: z.literal(PLANNING_WIRE_PROTOCOL_VERSION),
    operationId: opaqueIdSchema,
    documentId: opaqueIdSchema,
    expectedExternalVersion: expectedExternalVersionSchema,
    candidateSha256: sha256HexSchema,
  })
  .strict();
export type PublicationIntent = z.infer<typeof publicationIntentSchema>;
