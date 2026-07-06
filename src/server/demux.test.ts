import { describe, expect, test } from "bun:test";
import { createDemux } from "./demux";
import type { SseEvent } from "./types";

function evt(type: string, properties?: unknown): SseEvent {
  return { type, properties } as SseEvent;
}

describe("createDemux", () => {
  test("event with sessionID routes to that subscriber only", () => {
    const demux = createDemux();
    const received: SseEvent[] = [];
    const receivedOther: SseEvent[] = [];
    demux.subscribe("ses_1", (e) => received.push(e));
    demux.subscribe("ses_2", (e) => receivedOther.push(e));

    demux.dispatch(evt("message.part.updated", { sessionID: "ses_1" }));

    expect(received).toHaveLength(1);
    expect(receivedOther).toHaveLength(0);
  });

  test("every event reaches the firehose regardless of sessionID", () => {
    const demux = createDemux();
    const firehose: SseEvent[] = [];
    demux.subscribeFirehose((e) => firehose.push(e));

    demux.dispatch(evt("session.created", { id: "ses_1" }));
    demux.dispatch(evt("server.heartbeat"));

    expect(firehose).toHaveLength(2);
  });

  test("lifecycle events also reach a matching per-session subscriber", () => {
    const demux = createDemux();
    const received: SseEvent[] = [];
    demux.subscribe("ses_1", (e) => received.push(e));

    demux.dispatch(evt("session.status", { sessionID: "ses_1", type: "busy" }));

    expect(received).toHaveLength(1);
  });

  test("unknown event type is logged, not thrown, and still dispatched", () => {
    const demux = createDemux();
    const firehose: SseEvent[] = [];
    demux.subscribeFirehose((e) => firehose.push(e));

    expect(() =>
      demux.dispatch(evt("some.future.type", { sessionID: "ses_1" })),
    ).not.toThrow();
    expect(firehose).toHaveLength(1);
  });

  test("malformed frame (no type) is skipped without throwing", () => {
    const demux = createDemux();
    const firehose: SseEvent[] = [];
    demux.subscribeFirehose((e) => firehose.push(e));

    expect(() =>
      demux.dispatch({ properties: {} } as unknown as SseEvent),
    ).not.toThrow();
    expect(firehose).toHaveLength(0);
  });

  test("message.part.updated carries sessionID nested under properties.part.sessionID, not properties.sessionID — must still route to that session's subscriber", () => {
    const demux = createDemux();
    const received: SseEvent[] = [];
    demux.subscribe("ses_1", (e) => received.push(e));

    demux.dispatch(
      evt("message.part.updated", {
        part: {
          id: "prt_1",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "hi",
        },
      }),
    );

    expect(received).toHaveLength(1);
  });

  test("unsubscribe stops further delivery", () => {
    const demux = createDemux();
    const received: SseEvent[] = [];
    const unsubscribe = demux.subscribe("ses_1", (e) => received.push(e));
    unsubscribe();

    demux.dispatch(evt("message.part.updated", { sessionID: "ses_1" }));

    expect(received).toHaveLength(0);
  });
});
