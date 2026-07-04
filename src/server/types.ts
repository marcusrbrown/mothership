/**
 * zod `.passthrough()` boundary schemas for the subset of the opencode
 * server API the tracer consumes. Follows space-bus's loose-parse posture:
 * only fields actually used by this app are typed; everything else passes
 * through untouched so future server fields never break parsing.
 *
 * See docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md
 * for the live-verified shapes this is based on.
 */
import { z } from "zod";

export const sessionStatusEntrySchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const sessionStatusMapSchema = z.record(
  z.string(),
  sessionStatusEntrySchema,
);

export type SessionStatusEntry = z.infer<typeof sessionStatusEntrySchema>;
export type SessionStatusMap = z.infer<typeof sessionStatusMapSchema>;

export const questionOptionSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const questionQuestionSchema = z
  .object({
    question: z.string(),
    header: z.string().optional(),
    options: z.array(questionOptionSchema).optional(),
  })
  .passthrough();

export const questionRequestSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    questions: z.array(questionQuestionSchema),
    tool: z.unknown().optional(),
  })
  .passthrough();

export const questionListSchema = z.array(questionRequestSchema);

export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type QuestionQuestion = z.infer<typeof questionQuestionSchema>;
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

export const sessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    directory: z.string().optional(),
  })
  .passthrough();

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionListItemSchema = sessionInfoSchema;
export const sessionListSchema = z.array(sessionListItemSchema);

export const messagePartSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const messageInfoSchema = z
  .object({
    id: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

export const messageListItemSchema = z
  .object({
    info: messageInfoSchema,
    parts: z.array(messagePartSchema),
  })
  .passthrough();

export const messageListSchema = z.array(messageListItemSchema);

export type MessagePart = z.infer<typeof messagePartSchema>;
export type MessageInfo = z.infer<typeof messageInfoSchema>;
export type MessageListItem = z.infer<typeof messageListItemSchema>;

export const todoItemSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string().optional(),
  })
  .passthrough();

export const todoListSchema = z.array(todoItemSchema);

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoList = z.infer<typeof todoListSchema>;
