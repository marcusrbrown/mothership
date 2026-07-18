/**
 * In-memory ring buffer feeding the audit-log panel. Subscribes to the
 * executor's `onCommandExecuted` hook (already source-tagged 'ui'|'mcp_tool')
 * so UI-initiated and tool-initiated mutations interleave in one visible feed
 * No durable storage — state lives only in memory, per the localhost-only,
 * no-persistence invariant.
 *
 * `recordSessionToolEvent` is the session-tool domain's dedicated,
 * pre-minimized audit entry point — the executor calls this instead of
 * feeding raw session-tool commands through the layout command
 * summarizer, which would stringify prompt/transcript/question/answer
 * content. `sessionToolAuditEventSchema` is a strict zod schema
 * that is the PRIMARY gate (not a denylist key-scan): unknown keys,
 * non-own/inherited/accessor properties, non-plain-object values, and
 * cyclic structures are all refused before validating the closed field
 * set itself (source/tool/outcome/errorCode relationships, bounded safe
 * logical identifiers, finite nonnegative integer byte counts, and real
 * booleans). A caller bypassing TypeScript (a JS caller, `as any`, a
 * forged prototype) gets the exact same refusal a well-typed caller
 * would have been prevented from constructing at compile time.
 */
import { z } from "zod";
import { isValidProjectName, isValidSessionId } from "../../ide/commands";
import type { CommandExecutedEvent } from "../../layout/executor";
import { onCommandExecuted } from "../../layout/executor";

export const AUDIT_LOG_CAP = 500;

export interface AuditLogEntry {
  timestamp: number;
  source: CommandExecutedEvent["source"];
  command: string;
  paramSummary: string;
  result: "ok" | string;
}

// --- session-tool audit events ---------------------------------------------

/** The exact stable error codes this domain's executor can produce (see
 * `src/ide/commands.ts`'s `SessionToolErrorCode`). Kept as a literal list
 * here (not a shared import of the union type at the value level,
 * because TS unions aren't runtime-introspectable) so `errorCode` is
 * validated against real codes, never an arbitrary string. */
const KNOWN_ERROR_CODES = [
  "invalid_arguments",
  "invalid_target",
  "unknown_tool",
  "unknown_project",
  "ambiguous_project",
  "unknown_session",
  "session_project_mismatch",
  "upstream_error",
  "internal_error",
] as const;

/** Bounded, safe logical identifier: reuses the same structural validator
 * `src/ide/commands.ts` uses for the project-name schema (permits real
 * roster names like `fro-bot/dashboard` and dotted segments, rejects
 * absolute/home/relative-path and Windows-drive-shaped values). Session
 * and request ids reuse the tighter opaque-identifier validator. */
const safeProjectIdentifier = z.string().refine(isValidProjectName);
const safeOpaqueIdentifier = z.string().refine(isValidSessionId);

/** Non-negative finite integer — used for both `bytes.returned` and
 * `bytes.original`; rejects negative, fractional, `NaN`, and `Infinity`
 * values so a caller can't smuggle a sentinel/poisoned number through. */
const nonNegativeInt = z.number().finite().int().nonnegative();

/** Every real `ide_*` session-tool name matches this pattern: lowercase-
 * only, `ide_` prefix, bounded length. Closed allowlist shape — rejects
 * anything not shaped like a real tool name (path/space/control/
 * `=`-bearing values, non-`ide_`-prefixed names, uppercase) rather than
 * denylisting specific bad characters one at a time. */
const TOOL_NAME_PATTERN = /^ide_[a-z0-9_]+$/;

/**
 * Strict runtime schema for `SessionToolAuditEvent` — the PRIMARY
 * construction gate, not a denylist backstop. `.strict()` refuses any
 * key not named here; zod's object parsing itself only ever reads own
 * enumerable properties via `Object.keys`/property access on the parsed
 * value, so inherited/prototype-chain properties are invisible to it
 * (see the own-property-only re-copy in `toCleanEvent` below for the
 * belt-and-suspenders guarantee against getter/accessor properties that
 * might still be *own* properties).
 */
const sessionToolAuditEventSchema = z
  .object({
    tool: z.string().max(64).regex(TOOL_NAME_PATTERN),
    source: z.enum(["ui", "mcp_tool"]),
    project: safeProjectIdentifier.optional(),
    sessionId: safeOpaqueIdentifier.optional(),
    requestId: safeOpaqueIdentifier.optional(),
    outcome: z.enum(["ok", "error"]),
    errorCode: z.enum(KNOWN_ERROR_CODES).optional(),
    bytes: z
      .object({ returned: nonNegativeInt, original: nonNegativeInt })
      .strict()
      .refine((b) => b.returned <= b.original, {
        message:
          "bytes.returned must not exceed bytes.original — cannot have returned more bytes than existed",
      })
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.outcome === "error") === (v.errorCode !== undefined), {
    message:
      "outcome:'error' requires errorCode, and errorCode may only be present when outcome:'error'",
  });

/** Property descriptors that are own, enumerable, data (non-accessor)
 * properties are the only ones treated as legitimate input. A getter
 * defined with `Object.defineProperty` is still an "own enumerable
 * property" by `Object.keys`'s definition, so zod's plain object parsing
 * alone would still read (and thus could still trust) its return value.
 * This check runs BEFORE zod parsing and rejects any accessor property,
 * non-plain-object input (class instance, Map, function), or a value
 * whose own-property walk throws (cyclic structures under a naive
 * recursive walk, or any other pathological shape) — closing the gap
 * `.strict()` alone leaves open. */
function assertPlainOwnDataObject(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertPlainOwnDataObject(item, seen);
    return;
  }
  if (seen.has(value)) {
    throw new Error(
      "audit-store: refusing to record session-tool event — cyclic structure detected",
    );
  }
  seen.add(value);

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      "audit-store: refusing to record session-tool event — value is not a plain object",
    );
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(
        `audit-store: refusing to record session-tool event — "${key}" is an accessor property, not a plain data property`,
      );
    }
    assertPlainOwnDataObject(descriptor.value, seen);
  }
}

export type SessionToolAuditEvent = z.infer<typeof sessionToolAuditEventSchema>;

/**
 * Validates `event` against the strict schema and structural
 * plain-object/own-property/cyclic guards, then returns a FRESH object
 * built only from the validated, own-enumerable-data-property values —
 * never the caller's original reference. This means a caller mutating
 * their original object after the call cannot retroactively change the
 * recorded entry, and any property that slipped past validation via a
 * later prototype mutation can't reach the stored copy either. Throws on
 * any violation; never returns a partially-sanitized event.
 */
function toCleanEvent(event: unknown): SessionToolAuditEvent {
  assertPlainOwnDataObject(event, new WeakSet());
  const parsed = sessionToolAuditEventSchema.parse(event);
  // Re-copy through JSON to guarantee the returned object is a fresh,
  // plain, own-property-only structure with no residual reference to
  // the caller's original object graph (zod's parse result for a
  // `.strict()` object schema is already a fresh object, but the
  // round-trip is a cheap, explicit belt-and-suspenders guarantee that
  // survives any future schema change).
  return JSON.parse(JSON.stringify(parsed)) as SessionToolAuditEvent;
}

function summarizeSessionToolEvent(event: SessionToolAuditEvent): string {
  const parts: string[] = [];
  if (event.project) parts.push(`project=${event.project}`);
  if (event.sessionId) parts.push(`sessionId=${event.sessionId}`);
  if (event.requestId) parts.push(`requestId=${event.requestId}`);
  if (event.bytes) {
    parts.push(`bytes=${event.bytes.returned}/${event.bytes.original}`);
  }
  if (event.truncated !== undefined) {
    parts.push(`truncated=${event.truncated}`);
  }
  return parts.join(" ");
}

function sessionToolResult(event: SessionToolAuditEvent): string {
  if (event.outcome === "ok") return "ok";
  return `error:${event.errorCode ?? "unknown"}`;
}

function toSessionToolEntry(event: SessionToolAuditEvent): AuditLogEntry {
  return {
    timestamp: Date.now(),
    source: event.source,
    command: event.tool,
    paramSummary: summarizeSessionToolEvent(event),
    result: sessionToolResult(event),
  };
}

type Listener = (entries: readonly AuditLogEntry[]) => void;

function summarizeParams(command: CommandExecutedEvent["command"]): string {
  const { type, ...rest } = command as Record<string, unknown>;
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (k === "params" || k === "layout") return `${k}=…`;
      return `${k}=${JSON.stringify(v)}`;
    });
  return parts.join(" ");
}

function summarizeResult(event: CommandExecutedEvent): string {
  return event.result.ok ? "ok" : `error:${event.result.error.code}`;
}

function toEntry(event: CommandExecutedEvent): AuditLogEntry {
  return {
    timestamp: Date.now(),
    source: event.source,
    command: event.command.type,
    paramSummary: summarizeParams(event.command),
    result: summarizeResult(event),
  };
}

export function createAuditStore() {
  let entries: AuditLogEntry[] = [];
  const listeners = new Set<Listener>();

  function push(entry: AuditLogEntry): void {
    entries = [...entries, entry];
    if (entries.length > AUDIT_LOG_CAP) {
      entries = entries.slice(entries.length - AUDIT_LOG_CAP);
    }
    for (const listener of listeners) listener(entries);
  }

  const unsubscribe = onCommandExecuted((event) => {
    push(toEntry(event));
  });

  return {
    getEntries(): readonly AuditLogEntry[] {
      return entries;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Records a native (non-command) UI layout mutation — e.g. a dockview
     * drag-move/close that bypasses `executeCommand` entirely. Always
     * source:'ui' (native dockview gestures are UI-only) and always
     * result:'ok' (dockview doesn't report a native-gesture failure through
     * this path). Callers are responsible for de-duping/throttling before
     * calling this (see `DockviewShell`'s panel-set-signature comparison) —
     * this method unconditionally appends.
     */
    recordNativeLayoutChange(paramSummary: string): void {
      push({
        timestamp: Date.now(),
        source: "ui",
        command: "layout_changed_native",
        paramSummary,
        result: "ok",
      });
    },
    /**
     * Records a session-tool operation (the executor calls this instead
     * of the layout command flow). Throws — refusing to
     * append anything — if `event` fails the strict schema/structural
     * validation in `toCleanEvent` (unknown keys, non-plain/inherited/
     * accessor/cyclic values, invalid identifier shapes, or an
     * inconsistent outcome/errorCode/bytes/truncated combination); a
     * thrown construction never reaches the ring buffer.
     */
    recordSessionToolEvent(event: SessionToolAuditEvent): void {
      const clean = toCleanEvent(event);
      push(toSessionToolEntry(clean));
    },
    /** Test/dev-only teardown — mirrors registry's __reset convention. */
    __dispose(): void {
      unsubscribe();
      listeners.clear();
      entries = [];
    },
  };
}

export type AuditStore = ReturnType<typeof createAuditStore>;

/** Process-wide singleton the panel subscribes to (one audit feed per app,
 * same convention as the panel registry). */
export const auditStore = createAuditStore();
