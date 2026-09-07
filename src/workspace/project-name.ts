/**
 * Shared logical-project-name validation invariant. Used both by
 * `workspace/config.ts` (spacebus.json manifest parsing) and
 * `ide/commands.ts` (session-tool target schemas) so the two boundaries
 * can never drift apart on what counts as a safe roster project name.
 *
 * This module defines the policy only — no I/O, no zod schema
 * construction (callers wrap it in their own `.refine(...)` as needed).
 */

const MAX_PROJECT_NAME_LENGTH = 200;

/** Any C0/C1 control character, including NUL, BEL, and newline/CR/tab. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control characters IS the point of this validator.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** A Windows drive letter prefix (`C:`, `d:`), independent of what
 * follows — real roster names never need a bare `X:` prefix, and this is
 * also what a Windows drive-qualified path looks like. */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

/** Credential/header-shaped values a project name must never be
 * mistakable for: an HTTP-header-style `Name: ...`/`Name=...` prefix for
 * a known credential field name (Authorization, Cookie, password, token,
 * secret, api-key — with `-`/`_` variants), OR a standalone `Bearer
 * <token>` value. Matched anywhere in the string, case-insensitively —
 * a real roster project name has no legitimate reason to contain any of
 * these shapes, so this is a narrow, deliberate carve-out rather than a
 * broad denylist that could reject ordinary names. */
const CREDENTIAL_SHAPE_PATTERN =
  /\b(authorization|cookie|password|passwd|token|secret|api[-_]?key)\s*[:=]|\bbearer\s+\S/i;

/**
 * Validates a logical roster project name against the workspace roster's
 * real naming contract: a bounded, non-empty string that MAY contain
 * spaces, punctuation, Unicode characters, and an internal `/`
 * (org/repo-style, e.g. `fro-bot/dashboard`, or a human title like `My
 * Project`) — roster names are not filesystem-path-shaped or
 * ASCII-charset-restricted by convention, so this validator is a
 * DENYLIST of specific unsafe shapes, not a closed positive charset:
 *
 * - Non-empty, at most `MAX_PROJECT_NAME_LENGTH` characters.
 * - No control characters (NUL, BEL, newline/CR/tab, etc).
 * - Never starts with `/` (absolute path) or `~` (home-dir shorthand).
 * - Never contains a backslash (Windows path separator) or starts with a
 *   Windows drive letter (`C:`).
 * - No leading/trailing/doubled `/` (rules out `/foo`, `foo/`, `foo//bar`).
 * - No segment (split on `/`) is exactly `.` or `..` (rules out `.`,
 *   `..`, `./x`, `../x`, `foo/../bar`, `foo/.`).
 * - Never matches `CREDENTIAL_SHAPE_PATTERN` (rules out
 *   `Authorization: ...`, `Bearer abc123`, `Cookie=...`,
 *   `password=hunter2`, `token: value`, `api-key=...`, etc).
 */
export function isValidProjectName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROJECT_NAME_LENGTH) {
    return false;
  }
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  if (value.startsWith("/")) return false;
  if (value.startsWith("~")) return false;
  if (value.includes("\\")) return false;
  if (WINDOWS_DRIVE_PATTERN.test(value)) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("//")) return false;
  if (CREDENTIAL_SHAPE_PATTERN.test(value)) return false;

  const segments = value.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** A safe, non-leaking fallback name for a virtual (no spacebus.json)
 * workspace when the directory-basename-derived name fails
 * `isValidProjectName` (e.g. the directory's basename happens to be
 * `..`, empty after trailing-slash stripping, or otherwise degenerate).
 * Deliberately generic — never derived from any part of the rejected
 * value, since a basename that fails validation could itself be
 * path/credential-shaped and must not leak into the fallback. */
export const FALLBACK_VIRTUAL_PROJECT_NAME = "workspace";
