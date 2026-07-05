/**
 * Periodic ALL-projects reconciliation, replacing the per-project permanent
 * SSE connections removed from `connectWorkspaceSse` (see
 * DockviewShell.tsx). One `/event` stream per roster project saturated
 * WKWebView's ~6-connections-per-host HTTP/1.1 limit with ~6 roster
 * projects, starving every REST call (client.ts's `AbortSignal.timeout(30s)`
 * synthesizes `status:599` on the resulting hang) — roster stuck "Loading",
 * every project's status 599, transcript backfill failing.
 *
 * The fix: reconcile every roster project on a short interval via
 * SHORT-LIVED REST calls (`reconcileProject`'s `listSessions` +
 * `getSessionStatus` + `listQuestions`), which return their socket to the
 * pool immediately — no long-lived streams held open per project. Combined
 * with exactly ONE active-directory SSE connection (see DockviewShell's
 * `ActiveDirectorySse`), total concurrent connections stay at ~2-3.
 *
 * Projects are reconciled SEQUENTIALLY within a tick (not
 * `Promise.all`'d) — this is the simplest way to stay under the connection
 * cap; even at 3 REST calls per project, sequential 6-project ticks
 * complete comfortably inside a 2500ms interval on a loopback server.
 * Overlapping ticks are guarded against (a slow tick — e.g. one project
 * hanging — will never cause two ticks' worth of fetches to run
 * concurrently): if the previous tick hasn't finished when the next is due,
 * the timer fires but the poller just waits for the in-flight tick's
 * `finally` to schedule the next one, rather than starting a second
 * overlapping tick.
 */

export interface ReconcilePollerDeps {
  projects: { expandedPath: string }[];
  reconcileProject: (directory: string) => Promise<void>;
  intervalMs?: number;
  /** Injectable scheduler seam for tests (fake timers without needing
   * bun:test's global timer mocking to intercept a bare `setTimeout`). */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface ReconcilePoller {
  stop(): void;
}

/** Starts the poller. The first tick runs immediately (synchronously
 * kicked off, not after waiting `intervalMs`) so the roster/sessions/
 * needs-attention state is fresh as soon as the workspace mounts — the
 * same "no wait for first data" property the old per-project SSE
 * `onReconcile`-on-connect gave for free. Every subsequent tick is
 * scheduled `intervalMs` after the PREVIOUS tick fully finishes (not on a
 * fixed-rate clock), which is what makes overlap structurally
 * impossible — there is never a moment where two ticks' fetches are
 * in-flight at once. */
export function startReconcilePoller(
  deps: ReconcilePollerDeps,
): ReconcilePoller {
  const {
    projects,
    reconcileProject,
    intervalMs = 2500,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = deps;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    for (const project of projects) {
      if (stopped) return;
      try {
        await reconcileProject(project.expandedPath);
      } catch (e) {
        console.warn(
          "[reconcile-poller] reconcile failed",
          project.expandedPath,
          e,
        );
      }
    }
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    await tick();
    if (stopped) return;
    timer = setTimeoutImpl(() => {
      void loop();
    }, intervalMs);
  }

  void loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeoutImpl(timer);
    },
  };
}
