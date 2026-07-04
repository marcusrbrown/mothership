/**
 * OpencodeClient: thin fetch wrapper for the opencode server API the tracer
 * consumes. Mirrors space-bus's `src/core.ts` request semantics (per-request
 * `x-opencode-directory`, 30s timeout, `redirect: 'error'`, single zod
 * boundary crossing per response) without importing the package.
 *
 * Auth: `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` env vars are
 * not reachable from the webview, so credentials are accepted directly as
 * `{username, password}` in the factory config instead of read from env.
 * The tracer's documented posture is an unauthenticated loopback server —
 * see Key Technical Decisions in the tracer plan.
 *
 * GET/HEAD requests move `x-opencode-directory` into a `?directory=` query
 * param (matching the opencode server SDK's own rewrite for those methods);
 * all other methods send it as a header.
 *
 * Every response crosses its zod boundary schema exactly once. No throws
 * across this module's public boundary — every method returns a
 * discriminated `{ok: true, value} | {ok: false, error: {status, message}}`.
 */
import {
  type MessageListItem,
  type QuestionRequest,
  type SessionInfo,
  type SessionStatusMap,
  type TodoList,
  messageListSchema,
  questionListSchema,
  sessionInfoSchema,
  sessionListSchema,
  sessionStatusMapSchema,
  todoListSchema,
} from "./types";

export type ClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: number; message: string } };

export type ClientCredentials = { username?: string; password?: string };

export type OpencodeClientConfig = {
  baseUrl: string;
  credentials?: ClientCredentials;
  /** Injectable fetch, defaults to `globalThis.fetch`. Used for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Defaults to 30_000 per space-bus precedent. */
  timeoutMs?: number;
};

export type OpencodeClient = {
  getSessionStatus: (
    directory: string,
  ) => Promise<ClientResult<SessionStatusMap>>;
  listQuestions: (
    directory: string,
  ) => Promise<ClientResult<QuestionRequest[]>>;
  replyQuestion: (
    directory: string,
    requestID: string,
    answers: string[][],
  ) => Promise<ClientResult<void>>;
  rejectQuestion: (
    directory: string,
    requestID: string,
  ) => Promise<ClientResult<void>>;
  createSession: (
    directory: string,
    params: { title?: string },
  ) => Promise<ClientResult<SessionInfo>>;
  promptAsync: (
    directory: string,
    sessionID: string,
    parts: unknown[],
  ) => Promise<ClientResult<void>>;
  listMessages: (
    directory: string,
    sessionID: string,
    params?: { limit?: number },
  ) => Promise<ClientResult<MessageListItem[]>>;
  listSessions: (
    directory: string,
    params?: { limit?: number },
  ) => Promise<ClientResult<SessionInfo[]>>;
  getTodos: (
    directory: string,
    sessionID: string,
  ) => Promise<ClientResult<TodoList>>;
};

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader(
  credentials: ClientCredentials | undefined,
): Record<string, string> {
  if (!credentials?.password) return {};
  const username = credentials.username ?? "opencode";
  const token = toBase64(`${username}:${credentials.password}`);
  return { Authorization: `Basic ${token}` };
}

const GET_LIKE_METHODS = new Set(["GET", "HEAD"]);

type RawResponse = { status: number; bodyText: string; ok: boolean };

async function rawRequest(
  cfg: OpencodeClientConfig,
  directory: string,
  path: string,
  init: RequestInit = {},
): Promise<RawResponse> {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const method = (init.method ?? "GET").toUpperCase();

  let url = `${cfg.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeader(cfg.credentials),
    ...((init.headers as Record<string, string>) ?? {}),
  };

  if (GET_LIKE_METHODS.has(method)) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}directory=${encodeURIComponent(directory)}`;
  } else {
    headers["x-opencode-directory"] = directory;
  }

  try {
    const res = await fetchImpl(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = await res.text().catch(() => "");
    return { status: res.status, bodyText, ok: res.ok };
  } catch (e) {
    return {
      status: 599,
      bodyText: `request failed: ${(e as Error).message}`,
      ok: false,
    };
  }
}

function parseBoundary<T>(
  schema: { parse: (data: unknown) => T },
  res: RawResponse,
): ClientResult<T> {
  if (!res.ok) {
    return {
      ok: false,
      error: {
        status: res.status,
        message: res.bodyText || `request failed with status ${res.status}`,
      },
    };
  }
  try {
    const json = res.bodyText.length > 0 ? JSON.parse(res.bodyText) : undefined;
    const value = schema.parse(json);
    return { ok: true, value };
  } catch (e) {
    return {
      ok: false,
      error: {
        status: res.status,
        message: `unexpected response shape: ${(e as Error).message}`,
      },
    };
  }
}

export function createOpencodeClient(
  config: OpencodeClientConfig,
): OpencodeClient {
  return {
    async getSessionStatus(directory) {
      const res = await rawRequest(config, directory, "/session/status");
      return parseBoundary(sessionStatusMapSchema, res);
    },

    async listQuestions(directory) {
      const res = await rawRequest(config, directory, "/question");
      return parseBoundary(questionListSchema, res);
    },

    async replyQuestion(directory, requestID, answers) {
      const res = await rawRequest(
        config,
        directory,
        `/question/${encodeURIComponent(requestID)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ answers }),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: {
            status: res.status,
            message: res.bodyText || `reply failed with status ${res.status}`,
          },
        };
      }
      return { ok: true, value: undefined };
    },

    async rejectQuestion(directory, requestID) {
      const res = await rawRequest(
        config,
        directory,
        `/question/${encodeURIComponent(requestID)}/reject`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: {
            status: res.status,
            message: res.bodyText || `reject failed with status ${res.status}`,
          },
        };
      }
      return { ok: true, value: undefined };
    },

    async createSession(directory, params) {
      const res = await rawRequest(config, directory, "/session", {
        method: "POST",
        body: JSON.stringify(params),
      });
      return parseBoundary(sessionInfoSchema, res);
    },

    async promptAsync(directory, sessionID, parts) {
      const res = await rawRequest(
        config,
        directory,
        `/session/${encodeURIComponent(sessionID)}/prompt_async`,
        {
          method: "POST",
          body: JSON.stringify({ parts }),
        },
      );
      if (res.status !== 204) {
        return {
          ok: false,
          error: {
            status: res.status,
            message: res.bodyText || `expected 204, got ${res.status}`,
          },
        };
      }
      return { ok: true, value: undefined };
    },

    async listMessages(directory, sessionID, params) {
      const query = params?.limit !== undefined ? `?limit=${params.limit}` : "";
      const res = await rawRequest(
        config,
        directory,
        `/session/${encodeURIComponent(sessionID)}/message${query}`,
      );
      return parseBoundary(messageListSchema, res);
    },

    async listSessions(directory, params) {
      const query = params?.limit !== undefined ? `?limit=${params.limit}` : "";
      const res = await rawRequest(config, directory, `/session${query}`);
      return parseBoundary(sessionListSchema, res);
    },

    async getTodos(directory, sessionID) {
      const res = await rawRequest(
        config,
        directory,
        `/session/${encodeURIComponent(sessionID)}/todo`,
      );
      return parseBoundary(todoListSchema, res);
    },
  };
}
