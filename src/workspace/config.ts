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
 * is injected by the orchestrator/U1.2b wiring layer, not this module.
 * Tests stub `readTextFile` directly.
 */
import { z } from "zod";

export const manifestSchema = z
  .object({
    server: z.object({ baseUrl: z.string().url() }),
    projects: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        description: z.string(),
      }),
    ),
  })
  .strict();

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
};

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

  let raw: string;
  try {
    raw = await readTextFile(manifestPath);
  } catch {
    // Missing file (or unreadable for any reason) → virtual single-project workspace.
    const name =
      directory.replace(/\/+$/, "").split("/").filter(Boolean).pop() ??
      directory;
    return {
      kind: "virtual",
      project: {
        name,
        path: directory,
        description: "",
        expandedPath: expandHome(directory, options.homeDir),
      },
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

  const localhostError = validateLocalhost(parsed.data.server.baseUrl);
  if (localhostError) {
    return { kind: "error", message: localhostError };
  }

  return {
    kind: "workspace",
    config: parsed.data,
    projects: toProjects(parsed.data, options.homeDir),
  };
}
