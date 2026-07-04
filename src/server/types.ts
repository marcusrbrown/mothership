import {
  type BusContext,
  type CredentialsSchema,
  type MessageEnvelopeSchema,
  type MessageListSchema,
  type MessagePartSchema,
  type PendingQuestionEntrySchema,
  type PendingQuestionListSchema,
  type ProjectSchema,
  type RosterSchema,
  type SessionListSchema,
  type SessionSchema,
  type SessionStatusMapSchema,
  type TodoSchema,
  busContextSchema,
  credentialsSchema,
  messageEnvelopeSchema,
  messageListSchema,
  messagePartSchema,
  pendingQuestionEntrySchema,
  pendingQuestionListSchema,
  projectSchema,
  rosterSchema,
  sessionListSchema,
  sessionSchema,
  sessionStatusMapSchema,
  todoSchema,
} from "@fro.bot/space-bus/contract";
/**
 * Boundary schemas for the opencode server API the tracer consumes.
 *
 * Primary surface: re-exported from `@fro.bot/space-bus/contract` — the
 * library's zod schemas track the same upstream server this app talks to.
 * Only genuinely missing pieces are hand-rolled here (currently: the SSE
 * event envelope, which /contract has no equivalent for since space-bus
 * doesn't consume the event stream).
 *
 * See docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md
 * for the live-verified shapes this is based on.
 */
import { z } from "zod";

export {
  busContextSchema,
  credentialsSchema,
  messageEnvelopeSchema,
  messageListSchema,
  messagePartSchema,
  pendingQuestionEntrySchema,
  pendingQuestionListSchema,
  projectSchema,
  rosterSchema,
  sessionListSchema,
  sessionSchema,
  sessionStatusMapSchema,
  todoSchema,
};

export type {
  BusContext,
  CredentialsSchema as Credentials,
  MessageEnvelopeSchema as MessageListItem,
  MessageListSchema as MessageList,
  MessagePartSchema as MessagePart,
  PendingQuestionEntrySchema as QuestionRequest,
  PendingQuestionListSchema as QuestionList,
  ProjectSchema as RosterProjectEntry,
  RosterSchema as Roster,
  SessionListSchema as SessionList,
  SessionSchema as SessionInfo,
  SessionStatusMapSchema as SessionStatusMap,
  TodoSchema as TodoList,
};

/**
 * SSE `/event` envelope — /contract has no equivalent since space-bus's
 * /core reads via one-shot HTTP calls, never the event stream. Hand-rolled
 * per the live-verified contract: `{id?, type, properties}` on every
 * `event: message` frame; `properties` shape is per-event-type and left
 * loose (open union posture — demux switches on known `type` strings).
 */
export const sseEventSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    properties: z.unknown().optional(),
  })
  .passthrough();

export type SseEvent = z.infer<typeof sseEventSchema>;
