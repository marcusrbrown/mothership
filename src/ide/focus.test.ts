import { describe, expect, test } from "bun:test";
import {
  type ActiveSession,
  type FocusSeams,
  createFocusController,
} from "./focus";

function makeSeams(): {
  seams: FocusSeams;
  calls: {
    transcript: unknown[];
    sessions: unknown[];
    roster: unknown[];
    sse: string[];
    activeSession: ActiveSession[];
  };
} {
  const calls = {
    transcript: [] as unknown[],
    sessions: [] as unknown[],
    roster: [] as unknown[],
    sse: [] as string[],
    activeSession: [] as ActiveSession[],
  };
  const seams: FocusSeams = {
    updateTranscriptParams: (p) => calls.transcript.push(p),
    updateSessionsParams: (p) => calls.sessions.push(p),
    updateRosterParams: (p) => calls.roster.push(p),
    setActiveDirectory: (d) => calls.sse.push(d),
    updateActiveSession: (s) => calls.activeSession.push(s),
  };
  return { seams, calls };
}

describe("createFocusController", () => {
  describe("selectProject", () => {
    test("happy path: scopes sessions panel, marks roster active, switches SSE, sets context", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectProject({ name: "dashboard", directory: "/a" });

      expect(calls.sessions).toContainEqual({
        directory: "/a",
        activeSessionId: undefined,
      });
      expect(calls.roster).toContainEqual({ activeDirectory: "/a" });
      expect(calls.sse).toEqual(["/a"]);
      expect(controller.getActiveContext()).toEqual({ project: "dashboard" });
    });

    test("happy path: switching to a different project clears the previously active session", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectProject({ name: "b", directory: "/b" });

      expect(controller.getActiveContext()).toEqual({ project: "b" });
      expect(calls.transcript).toContainEqual({
        directory: "/b",
        sessionID: undefined,
      });
    });

    test("happy path: re-selecting the same directory preserves the active session", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectProject({ name: "a", directory: "/a" });

      expect(controller.getActiveContext()).toEqual({
        project: "a",
        sessionId: "ses_1",
      });
    });

    test("happy path: re-selecting the same directory does not clear the transcript", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      calls.transcript.length = 0;
      controller.selectProject({ name: "a", directory: "/a" });

      expect(calls.transcript).toHaveLength(0);
    });

    test("edge case: selecting a project with no prior session focused is a no-op for the transcript session clear semantics but still updates panels", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectProject({ name: "a", directory: "/a" });

      expect(calls.transcript).toContainEqual({
        directory: "/a",
        sessionID: undefined,
      });
    });
  });

  describe("selectSession", () => {
    test("happy path: points transcript, marks sessions/roster active, switches SSE, sets full context", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectSession({
        id: "ses_1",
        project: "dashboard",
        directory: "/a",
      });

      expect(calls.transcript).toContainEqual({
        directory: "/a",
        sessionID: "ses_1",
      });
      expect(calls.sessions).toContainEqual({
        directory: "/a",
        activeSessionId: "ses_1",
      });
      expect(calls.roster).toContainEqual({ activeDirectory: "/a" });
      expect(calls.sse).toEqual(["/a"]);
      expect(controller.getActiveContext()).toEqual({
        project: "dashboard",
        sessionId: "ses_1",
      });
    });

    test("happy path: selecting a second session in a different project switches directory/context fully", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectSession({ id: "ses_2", project: "b", directory: "/b" });

      expect(controller.getActiveContext()).toEqual({
        project: "b",
        sessionId: "ses_2",
      });
      expect(calls.sse).toEqual(["/a", "/b"]);
    });
  });

  describe("getActiveContext", () => {
    test("happy path: nothing focused yet returns an empty object", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);
      expect(controller.getActiveContext()).toEqual({});
    });

    test("security: never exposes a directory field", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      const ctx = controller.getActiveContext() as unknown as Record<
        string,
        unknown
      >;
      expect(ctx.directory).toBeUndefined();
      expect(JSON.stringify(ctx)).not.toContain("/a");
    });
  });

  describe("updateActiveSession seam", () => {
    test("selecting a session emits it as the active session", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      expect(calls.activeSession[calls.activeSession.length - 1]).toEqual({
        sessionId: "ses_1",
        directory: "/a",
      });
    });

    test("selecting a different project clears the active session", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectProject({ name: "b", directory: "/b" });
      expect(
        calls.activeSession[calls.activeSession.length - 1],
      ).toBeUndefined();
    });

    test("re-selecting the same project's directory preserves the active session", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectProject({ name: "a", directory: "/a" });
      expect(calls.activeSession[calls.activeSession.length - 1]).toEqual({
        sessionId: "ses_1",
        directory: "/a",
      });
    });

    test("selecting a project with no prior session emits undefined", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectProject({ name: "a", directory: "/a" });
      expect(
        calls.activeSession[calls.activeSession.length - 1],
      ).toBeUndefined();
    });

    test("rapid sequential calls: the seam receives every intermediate value, with the last call winning the final state", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectProject({ name: "a", directory: "/a" });
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectProject({ name: "b", directory: "/b" });
      controller.selectSession({ id: "ses_2", project: "b", directory: "/b" });

      expect(calls.activeSession[calls.activeSession.length - 1]).toEqual({
        sessionId: "ses_2",
        directory: "/b",
      });
    });

    test("the seam is optional — a controller built without it never throws", () => {
      const seams: FocusSeams = {
        updateTranscriptParams: () => {},
        updateSessionsParams: () => {},
        updateRosterParams: () => {},
        setActiveDirectory: () => {},
      };
      const controller = createFocusController(seams);
      expect(() => {
        controller.selectProject({ name: "a", directory: "/a" });
        controller.selectSession({
          id: "ses_1",
          project: "a",
          directory: "/a",
        });
      }).not.toThrow();
    });
  });

  describe("clearSessionIfCurrent", () => {
    test("happy path: clears transcript/sessions params and reports undefined active session, project preserved", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      calls.transcript.length = 0;
      calls.sessions.length = 0;
      calls.activeSession.length = 0;

      controller.clearSessionIfCurrent("ses_1");

      expect(calls.transcript[calls.transcript.length - 1]).toEqual({
        directory: "/a",
        sessionID: undefined,
      });
      expect(calls.sessions[calls.sessions.length - 1]).toEqual({
        directory: "/a",
        activeSessionId: undefined,
      });
      expect(
        calls.activeSession[calls.activeSession.length - 1],
      ).toBeUndefined();
      expect(controller.getActiveContext()).toEqual({ project: "a" });
    });

    test("happy path: matching directory clears as expected", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.clearSessionIfCurrent("ses_1", "/a");
      expect(controller.getActiveContext()).toEqual({ project: "a" });
    });

    test("no-op: a directory mismatch prevents clearing", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      calls.activeSession.length = 0;

      controller.clearSessionIfCurrent("ses_1", "/wrong");

      expect(calls.activeSession).toHaveLength(0);
      expect(controller.getActiveContext()).toEqual({
        project: "a",
        sessionId: "ses_1",
      });
    });

    test("no-op: a stale/non-current sessionId never clears the current session", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectSession({ id: "ses_2", project: "a", directory: "/a" });
      calls.activeSession.length = 0;

      controller.clearSessionIfCurrent("ses_1");

      expect(calls.activeSession).toHaveLength(0);
      expect(controller.getActiveContext()).toEqual({
        project: "a",
        sessionId: "ses_2",
      });
    });

    test("no-op: nothing focused yet", () => {
      const { seams, calls } = makeSeams();
      const controller = createFocusController(seams);
      controller.clearSessionIfCurrent("ses_1");
      expect(calls.activeSession).toHaveLength(0);
      expect(controller.getActiveContext()).toEqual({});
    });

    test("race: a rapid re-select after a stale prune notification remains coherent (last state wins, not the stale prune)", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      controller.selectSession({ id: "ses_2", project: "a", directory: "/a" });
      // A late prune notification for the superseded session arrives
      // after ses_2 is already active — must not clear ses_2.
      controller.clearSessionIfCurrent("ses_1");
      expect(controller.getActiveContext()).toEqual({
        project: "a",
        sessionId: "ses_2",
      });
    });

    test("the seam is optional — clearing never throws without updateActiveSession", () => {
      const seams: FocusSeams = {
        updateTranscriptParams: () => {},
        updateSessionsParams: () => {},
        updateRosterParams: () => {},
        setActiveDirectory: () => {},
      };
      const controller = createFocusController(seams);
      controller.selectSession({ id: "ses_1", project: "a", directory: "/a" });
      expect(() => controller.clearSessionIfCurrent("ses_1")).not.toThrow();
    });
  });

  describe("race behavior", () => {
    test("rapid sequential focus calls: last call wins with no interleaving", () => {
      const { seams } = makeSeams();
      const controller = createFocusController(seams);

      controller.selectProject({ name: "a", directory: "/a" });
      controller.selectProject({ name: "b", directory: "/b" });
      controller.selectSession({ id: "ses_x", project: "c", directory: "/c" });

      expect(controller.getActiveContext()).toEqual({
        project: "c",
        sessionId: "ses_x",
      });
    });
  });
});
