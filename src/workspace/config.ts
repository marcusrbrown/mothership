/**
 * spacebus.json workspace config parsing.
 *
 * Mirrors `fro-bot/space-bus`'s `src/config.ts` semantics (zod schema,
 * `~` expansion, localhost-hostname guard) without importing the package —
 * this module runs in the webview, not Node, so file reads go through an
 * injected `readTextFile` reader (Tauri's fs plugin is NOT a dependency of
 * this project; @tauri-apps/plugin-fs is intentionally not installed).
 *
 * The default reader throws 'not wired' — the Tauri-backed implementation
 * is injected by the app's wiring layer, not this module.
 * Tests stub `readTextFile` directly.
 */
import { z } from "zod";
import {
  FALLBACK_VIRTUAL_PROJECT_NAME,
  isValidProjectName,
} from "./project-name";

export const manifestSchema = z.object({
  server: z
    .object({
      baseUrl: z.string().url().optional(),
      managed: z
        .object({
          command: z.array(z.string()).optional(),
          cwd: z.string().optional(),
          port: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .superRefine((server, ctx) => {
      const hasBaseUrl = server.baseUrl !== undefined;
      const hasManaged = server.managed !== undefined;
      if (hasBaseUrl === hasManaged) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "spacebus.json server must set exactly one of baseUrl or managed",
        });
      }
    }),
  projects: z.array(
    z.object({
      name: z.string().refine(isValidProjectName, {
        message:
          "spacebus.json project name is not a valid roster project name (path/credential-shaped or malformed names are rejected)",
      }),
      path: z.string(),
      description: z.string(),
    }),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;

const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Expands a leading `~` to the user's home directory. Webview has no `os.homedir()`, so callers
 * that need real expansion must supply `homeDir`; without it, `~` paths are left as-is except for
 * the literal `~` prefix removal (best-effort — the expandedPath field documents this limitation). */
export function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith("~")) return path;
  if (!homeDir) return path;
  return homeDir + path.slice(1);
}

export type Project = Manifest["projects"][number] & {
  expandedPath: string;
};

/** Injected file reader seam. Default throws — must be wired with a real implementation
 * (e.g. Tauri's `readTextFile`) before `loadWorkspace` is used against real files. */
export async function defaultReadTextFile(_path: string): Promise<string> {
  throw new Error(
    "not wired: no readTextFile implementation was provided to loadWorkspace",
  );
}

export type WorkspaceResult =
  | { kind: "workspace"; config: Manifest; projects: Project[] }
  | { kind: "virtual"; project: Project }
  | { kind: "error"; message: string };

function validateLocalhost(baseUrl: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return "spacebus.json server.baseUrl is not a valid URL";
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    return `spacebus.json baseUrl must point to localhost (got ${hostname}) — refusing to send credentials off-machine`;
  }
  return undefined;
}

/** Returns the first project name that appears more than once (exact string equality,
 * no case-folding or normalization — mirrors the existing name contract's leniency on
 * spaces/punctuation/Unicode/slash), or `undefined` if all names are unique. */
function findDuplicateProjectName(manifest: Manifest): string | undefined {
  const seen = new Set<string>();
  for (const p of manifest.projects) {
    if (seen.has(p.name)) return p.name;
    seen.add(p.name);
  }
  return undefined;
}

function toProjects(manifest: Manifest, homeDir?: string): Project[] {
  return manifest.projects.map((p) => ({
    ...p,
    expandedPath: expandHome(p.path, homeDir),
  }));
}

export type LoadWorkspaceOptions = {
  /** Injected file reader; defaults to a stub that throws 'not wired'. */
  readTextFile?: (path: string) => Promise<string>;
  /** Home directory for `~` expansion; when omitted, `~` paths are left un-expanded. */
  homeDir?: string;
  /** Injected existence check, used to distinguish "confirmed missing" (→
   * virtual workspace) from "present but unreadable" (→ error) BEFORE
   * attempting the read. When omitted, `loadWorkspace` falls back to its
   * pre-existing behavior: any `readTextFile` throw is treated as
   * "missing", since there is no independent signal to tell the two
   * apart. Production callers (`StartupHandshake`) should inject the
   * real Tauri-backed `pathExists`. */
  pathExists?: (path: string) => Promise<boolean>;
};

/** Builds the virtual (no spacebus.json) single-project workspace result
 * for `directory`. The derived project name (directory basename) is
 * validated against the shared `isValidProjectName` invariant — a
 * basename that fails (e.g. degenerate after trailing-slash stripping,
 * or otherwise malformed) falls back to `FALLBACK_VIRTUAL_PROJECT_NAME`
 * rather than being used as-is, and the rejected basename itself is
 * never echoed anywhere (the fallback name is a fixed constant, not
 * derived from the rejected value). */
function virtualWorkspaceResult(
  directory: string,
  homeDir?: string,
): WorkspaceResult {
  const basename =
    directory.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? directory;
  const name = isValidProjectName(basename)
    ? basename
    : FALLBACK_VIRTUAL_PROJECT_NAME;
  return {
    kind: "virtual",
    project: {
      name,
      path: directory,
      description: "",
      expandedPath: expandHome(directory, homeDir),
    },
  };
}

/**
 * Loads the workspace for `directory` by reading `<directory>/spacebus.json`.
 *
 * - Missing file → `{kind: 'virtual'}` single-project workspace derived from `directory`.
 * - Present but malformed (bad JSON or schema failure) → `{kind: 'error'}` with the zod/JSON message.
 *   Never a partial workspace.
 * - Valid manifest (including `projects: []`) → `{kind: 'workspace'}`. An empty projects array is a
 *   valid, non-error state — the roster's empty-state UI is a panel-layer concern, not this module's.
 */
export async function loadWorkspace(
  directory: string,
  options: LoadWorkspaceOptions = {},
): Promise<WorkspaceResult> {
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const manifestPath = `${directory.replace(/\/+$/, "")}/spacebus.json`;

  const pathExists = options.pathExists;
  let readable: boolean;
  if (pathExists) {
    let exists: boolean;
    try {
      exists = await pathExists(manifestPath);
    } catch {
      // A `pathExists` seam that itself fails cannot distinguish
      // "confirmed missing" from "confirmed present but unreadable" —
      // fail closed as a stable, non-secret error rather than guessing
      // virtual (which would silently discard a possibly-real manifest).
      return {
        kind: "error",
        message: "spacebus.json existence check failed",
      };
    }
    readable = exists;
  } else {
    // No injected `pathExists` seam — this is the pre-existing behavior:
    // any `readTextFile` throw (missing OR unreadable-for-any-reason) is
    // treated as "missing", since there is no independent existence
    // signal to distinguish the two. Callers that need the distinction
    // (e.g. `StartupHandshake`) must inject `pathExists`.
    readable = true;
  }

  let raw: string;
  if (!readable) {
    return virtualWorkspaceResult(directory, options.homeDir);
  }
  try {
    raw = await readTextFile(manifestPath);
  } catch {
    if (!pathExists) {
      // No independent existence signal — preserve the pre-existing
      // "any throw means missing" fallback.
      return virtualWorkspaceResult(directory, options.homeDir);
    }
    // `pathExists` confirmed the file IS present, yet the read still
    // failed (permission denied, I/O error, race where it was deleted
    // between the check and the read, etc) — this is a REAL error, not
    // "no manifest". Falling back to virtual here would silently ignore
    // a manifest the user actually has, potentially connecting to the
    // wrong server/roster. The raw exception/path is never echoed.
    return {
      kind: "error",
      message: "spacebus.json exists but could not be read",
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      kind: "error",
      message: `spacebus.json is not valid JSON: ${(e as Error).message}`,
    };
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "error", message: parsed.error.message };
  }

  if (parsed.data.server.baseUrl !== undefined) {
    const localhostError = validateLocalhost(parsed.data.server.baseUrl);
    if (localhostError) {
      return { kind: "error", message: localhostError };
    }
  }

  if (findDuplicateProjectName(parsed.data) !== undefined) {
    // Generic, stable message — the duplicate name itself is never echoed since
    // project names may be path-shaped or credential-shaped (e.g. embedded tokens
    // or secrets pasted into a name field) and must not leak into error output.
    return {
      kind: "error",
      message: "spacebus.json project names must be unique",
    };
  }

  return {
    kind: "workspace",
    config: parsed.data,
    projects: toProjects(parsed.data, options.homeDir),
  };
}
