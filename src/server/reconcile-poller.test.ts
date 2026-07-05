import { describe, expect, test } from "bun:test";
import { startReconcilePoller } from "./reconcile-poller";

/**
 * Injectable-scheduler test harness: a fake `setTimeout`/`clearTimeout`
 * pair that records scheduled callbacks and lets the test fire them
 * manually, without bun:test's global fake timers (which don't reliably
 * intercept every await-chained microtask). `flush()` synchronously
 * invokes the most recently scheduled callback, if any.
 */
function fakeScheduler() {
  let pending: (() => void) | undefined;
  let nextId = 1;
  const cleared = new Set<number>();

  const setTimeoutImpl = ((cb: () => void) => {
    const id = nextId++;
    pending = () => {
      if (!cleared.has(id)) cb();
    };
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const clearTimeoutImpl = ((id: unknown) => {
    cleared.add(id as number);
  }) as typeof clearTimeout;

  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    fire() {
      const cb = pending;
      pending = undefined;
      cb?.();
    },
  };
}

describe("startReconcilePoller", () => {
  test("reconciles every project on the first tick, immediately (no wait)", async () => {
    const calls: string[] = [];
    const scheduler = fakeScheduler();
    const poller = startReconcilePoller({
      projects: [{ expandedPath: "/repo/a" }, { expandedPath: "/repo/b" }],
      reconcileProject: async (dir) => {
        calls.push(dir);
      },
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });

    // Flush the microtask queue so the immediately-kicked-off first tick's
    // sequential awaits resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["/repo/a", "/repo/b"]);
    poller.stop();
  });

  test("reconciles projects sequentially, not concurrently", async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const scheduler = fakeScheduler();

    startReconcilePoller({
      projects: [{ expandedPath: "/repo/a" }, { expandedPath: "/repo/b" }],
      reconcileProject: (dir) => {
        order.push(`start:${dir}`);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            order.push(`end:${dir}`);
            resolve();
          });
        });
      },
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });

    await Promise.resolve();
    // Only project "a" should have started — "b" must wait for "a" to
    // resolve, proving no `Promise.all` fan-out.
    expect(order).toEqual(["start:/repo/a"]);

    releases[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:/repo/a", "end:/repo/a", "start:/repo/b"]);

    releases[1]?.();
    await Promise.resolve();
  });

  test("schedules the next tick only after the previous tick fully finishes (no overlap)", async () => {
    const calls: string[] = [];
    const scheduler = fakeScheduler();

    const poller = startReconcilePoller({
      projects: [{ expandedPath: "/repo/a" }],
      reconcileProject: async (dir) => {
        calls.push(dir);
      },
      intervalMs: 2500,
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/repo/a"]);

    // Firing the scheduled timer runs a second tick.
    scheduler.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/repo/a", "/repo/a"]);

    poller.stop();
  });

  test("stop() halts further ticks", async () => {
    const calls: string[] = [];
    const scheduler = fakeScheduler();

    const poller = startReconcilePoller({
      projects: [{ expandedPath: "/repo/a" }],
      reconcileProject: async (dir) => {
        calls.push(dir);
      },
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/repo/a"]);

    poller.stop();
    scheduler.fire();
    await Promise.resolve();
    await Promise.resolve();

    // stop() cleared the pending timer, so firing it again is a no-op —
    // and even if the callback did fire, `stopped` guards the tick body.
    expect(calls).toEqual(["/repo/a"]);
  });

  test("stop() during an in-flight tick prevents any further reconciles", async () => {
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    const scheduler = fakeScheduler();

    const poller = startReconcilePoller({
      projects: [{ expandedPath: "/repo/a" }, { expandedPath: "/repo/b" }],
      reconcileProject: (dir) => {
        calls.push(dir);
        return new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });

    await Promise.resolve();
    // Only "a" has started (in-flight); "b" has not been called yet.
    expect(calls).toEqual(["/repo/a"]);

    // stop() fires while project "a"'s reconcile is still in-flight.
    poller.stop();

    // Now let "a" resolve — the tick loop must NOT proceed to "b".
    releases[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["/repo/a"]);

    // And no next tick is scheduled/fires either.
    scheduler.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/repo/a"]);
  });
});
