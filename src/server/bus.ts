/**
 * Thin facade over `@fro.bot/space-bus/core`. Panels and app code import the
 * /core surface from here, never from the package directly — a single
 * audit point for the space-bus dependency and a future swap seam.
 *
 * Note: /core reads `globalThis.fetch` directly; `CoreOpts` carries only
 * `{context}` (a `BusContext`), no fetch injection. Tests stub
 * `globalThis.fetch` rather than passing a fetch implementation.
 */
export {
  roster,
  status,
  snapshot,
  dispatch,
  result,
} from "@fro.bot/space-bus/core";
export type {
  CoreOpts,
  Result,
  RosterProject,
  DispatchArgs,
  DispatchResult,
  SessionStatusResult,
  SessionResultResult,
  SnapshotProject,
  DiffSource,
} from "@fro.bot/space-bus/core";
