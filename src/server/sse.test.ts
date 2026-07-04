import { describe, expect, test } from "bun:test";
import { connectSse } from "./sse";

/** Minimal stub EventSource — enough surface for connectSse's usage
 * (onopen/onmessage/onerror, close(), constructed with a URL). Exposes
 * `emitOpen`/`emitMessage`/`emitError` plus a shared registry so tests can
 * grab the most recently constructed instance. */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }

  emitError() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

function freshEventSource() {
  StubEventSource.instances = [];
  return StubEventSource as unknown as typeof EventSource;
}

describe("connectSse", () => {
  test("connect fires onReconcile on open", () => {
    const EventSourceImpl = freshEventSource();
    let reconciled = 0;
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => reconciled++,
      EventSourceImpl,
    });

    const instance = StubEventSource.instances[0] as StubEventSource;
    instance.emitOpen();

    expect(reconciled).toBe(1);
  });

  test("directory is passed as a query param on the /event URL", () => {
    const EventSourceImpl = freshEventSource();
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspace/proj a",
      onEvent: () => {},
      onReconcile: () => {},
      EventSourceImpl,
    });
    const instance = StubEventSource.instances[0] as StubEventSource;
    expect(instance.url).toContain("/event?directory=");
    expect(instance.url).toContain(encodeURIComponent("/workspace/proj a"));
  });

  test("parse failure skips the frame, stream survives, other frames still delivered", () => {
    const EventSourceImpl = freshEventSource();
    const events: unknown[] = [];
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: (e) => events.push(e),
      onReconcile: () => {},
      EventSourceImpl,
    });
    const instance = StubEventSource.instances[0] as StubEventSource;
    instance.emitOpen();

    instance.emitMessage("not json{{{");
    instance.emitMessage(JSON.stringify({ type: "server.heartbeat" }));

    expect(events).toHaveLength(1);
  });

  test("reconnect after an error re-fires onReconcile (full reconcile is the safety net, not resume)", async () => {
    const EventSourceImpl = freshEventSource();
    let reconciled = 0;
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => reconciled++,
      EventSourceImpl,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });

    const first = StubEventSource.instances[0] as StubEventSource;
    first.emitOpen();
    expect(reconciled).toBe(1);

    first.emitError();
    expect(first.closed).toBe(true);

    // wait past the scheduled backoff for a new EventSource to be constructed
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(StubEventSource.instances.length).toBeGreaterThan(1);
    const second = StubEventSource.instances[1] as StubEventSource;
    second.emitOpen();

    expect(reconciled).toBe(2);
  });

  test("close() prevents further reconnect attempts", async () => {
    const EventSourceImpl = freshEventSource();
    const client = connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => {},
      EventSourceImpl,
      initialBackoffMs: 1,
    });
    const first = StubEventSource.instances[0] as StubEventSource;
    first.emitOpen();

    client.close();
    first.emitError();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(StubEventSource.instances).toHaveLength(1);
  });
});
