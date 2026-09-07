export const SAFE_METADATA_KEYS = new Set([
  "project",
  "sessionId",
  "requestId",
  "bytes",
  "truncated",
  "panelId",
  "panelType",
  "direction",
  "referencePanelId",
  "panels",
]);

export interface ParsedMetadata {
  key: string;
  value: string;
}

export function parseParamSummary(summary: string): ParsedMetadata[] {
  const pairs: ParsedMetadata[] = [];
  const regex = /([a-zA-Z0-9_-]+)=("[^"]*"|[^\s]+)/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex match loop
  while ((match = regex.exec(summary)) !== null) {
    const key = match[1];
    if (SAFE_METADATA_KEYS.has(key)) {
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      pairs.push({ key, value });
    }
  }
  return pairs;
}

export function getCategory(command: string): "LAYOUT" | "SESSION" | "READ" {
  if (command.startsWith("ide_")) {
    const readTools = [
      "ide_list_sessions",
      "ide_list_projects",
      "ide_get_active_context",
      "ide_list_pending_questions",
      "ide_read_transcript",
    ];
    return readTools.includes(command) ? "READ" : "SESSION";
  }
  return "LAYOUT";
}

export function getActionName(command: string): string {
  if (command.startsWith("ide_")) {
    return command.slice(4);
  }
  return command;
}

export function formatResult(result: string): {
  display: string;
  isError: boolean;
} {
  if (result === "ok") {
    return { display: "OK", isError: false };
  }
  if (result.startsWith("error:")) {
    const code = result.slice(6);
    // Validate that code is a stable error code (lowercase, alphanumeric, underscores)
    if (/^[a-z0-9_]+$/.test(code)) {
      return { display: code.toUpperCase(), isError: true };
    }
  }
  return { display: "ERROR", isError: true };
}
