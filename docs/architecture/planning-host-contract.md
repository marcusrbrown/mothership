# Planning host contract

## Status and scope

This is the U1 integration contract for the agent-native planning lifecycle. Source ownership and the MCP context handoff are identified; an authenticated planning host adapter is **not implemented or proven** by this document or its wire-schema fixtures.

`src/planning/contracts.ts` defines proposed version-1 **untrusted reports**. Successful parsing establishes syntax only. It does not establish a host identity, principal, grant, verified outcome, or permission to activate planning features. The current runtime does not emit these proposed reports.

The originating plan is `docs/plans/2026-09-07-001-feat-agent-native-planning-plan.md`. U4 owns the real principal/authorization proof; U6 owns execution correlation, boundary acknowledgment, and evidence integration.

## Source authority

The following mapping was checked on September 7, 2026. It identifies the configured package's source, not the identity of a currently running process.

| Item | Exact authority | Meaning |
|---|---|---|
| Configured package | `@fro.bot/harness@1.18.29-harness.88b6b5fb` | Package being investigated, not a floating latest version |
| Package repository | `fro-bot/agent` | Repository declared by npm metadata |
| npm `gitHead` | `cb4a1425bda9b6f422798381db467ec5ffa2777b` | Harness wrapper/package source tree |
| Runtime integration commit | `88b6b5fb768ab106a5dc4f11e8ec8dd8ec30cadb` | Patched OpenCode runtime source tree in the same repository |
| Runtime base | OpenCode `1.18.29` | Base named by the integration commit |

The wrapper commit and runtime integration commit are different trees. Inspecting only `packages/harness` at npm `gitHead` does not establish the runtime MCP behavior. The integration tree itself contains `packages/opencode` and is available by its exact commit.

### Integration ownership and file targets

Paths in the next table are relative to `fro-bot/agent` at the runtime integration commit unless a different owner is named.

| Owner | Source or test target | Responsibility |
|---|---|---|
| Runtime MCP integration | `packages/opencode/src/mcp/index.ts` | Client creation/storage and tool catalog retrieval |
| Runtime tool execution | `packages/opencode/src/session/tools.ts` | `SessionTools.resolve`, per-invocation runtime context, MCP execution wrapper |
| Runtime MCP conversion | `packages/opencode/src/mcp/catalog.ts` | `McpCatalog.convertTool` and outbound `client.callTool` construction |
| Runtime tool API | `packages/opencode/src/tool/tool.ts` | Runtime `Tool.Context`, separate from tool arguments |
| Runtime plugin adapter | `packages/opencode/src/tool/registry.ts` | `fromPlugin` wrapper and plugin context construction |
| Runtime MCP tests | `packages/opencode/test/mcp/catalog.test.ts`, `lifecycle.test.ts`, `headers.test.ts` | Existing test locations for conversion, shared-client lifecycle, and transport-header behavior |
| Harness packaging | `packages/harness/src/integrate.ts`, `resolve-binary.ts`, `provenance.ts` at npm `gitHead` | Integration orchestration, packaged binary resolution, and provenance |
| Mothership connector | `scripts/ide-mcp-bridge.ts` in Mothership | Stdio-to-HTTP relay; currently forwards tool name and arguments |
| Mothership transport | `sidecar/ide-server/index.ts`, `http-auth.ts`, `mcp-server.ts`, `ws-bridge.ts` | Authenticated ingress and relay, not execution or filesystem ownership |
| Mothership native authority | Planned U4 native services | Current grant checks and protected planning authority |

These runtime test files exist at the pinned integration commit. Their existence is not evidence that the new host contract already has coverage.

## Current call path

1. The MCP service stores clients by MCP server name within the service instance. A client is not allocated per agent session.
2. `SessionTools.resolve` has the active session and constructs per-call context including runtime `sessionID`, `messageID`, `callID`, and `agent`.
3. The MCP execution wrapper uses that context for permission handling, then invokes the converted tool with arguments and execution options.
4. `McpCatalog.convertTool` constructs a `client.callTool` request containing the remote tool name and arguments. It supplies abort/timeout/progress options, but does not construct an agent-principal assertion.
5. Mothership's stdio bridge forwards the tool name and arguments with its shared bearer. Its current request envelope contains no verified agent principal.

SDK-generated transport metadata, such as progress bookkeeping, is not agent identity. The finding is the absence of a principal handoff in the inspected construction, not a claim that the SDK can never add any metadata.

### Required adapter insertion

The runtime adapter must carry host-owned per-call context from `SessionTools.resolve` to the MCP invocation boundary in `McpCatalog.convertTool`. Identity must come from runtime context, not from model arguments, agent display names, mutable client-global variables, or an earlier request on the same connection.

The actual outbound tool name and request must be bound to that invocation. Changes introduced by tool hooks cannot cause an assertion for one request to authorize a different request. A shared connection must support simultaneous calls from differently authorized sessions without context crossing between them.

The transport authentication and host-registration mechanism still require U4 design and implementation approval. A new metadata object alone is not the adapter proof. This contract does not select a new identity provider, expose a credential in arguments, or authorize a runtime patch.

## Proposed raw reports

### Host invocation

`rawHostInvocationSchema` describes a version-1 report with `hostId`, `sessionId`, `messageId`, `callId`, `agent`, and `tool`.

- `hostId` names a future host registration; text supplied in this field does not establish that registration.
- Session, message, and call identifiers must be sourced from the host's actual invocation context.
- `agent` is descriptive context, not an authorization role or substitute for a session principal.
- `tool` is the actual outbound MCP tool name, not a display label inferred from prose.
- Context strings are nonblank, bounded to 256 UTF-16 code units, and contain no Unicode control characters. This is the JavaScript producer's wire budget, not a grapheme count: an astral symbol consumes two code units. Parsing does not trim or otherwise rewrite identity strings.
- Unknown fields, including claimed grants, credentials, or `trusted` flags, are rejected.

Even a syntactically valid forged report remains untrusted. The future ingress must authenticate the host and validate its binding before producing internal principal context. Raw-report types must never be treated as native authority types.

### Capability advertisement

`adapterCapabilitiesSchema` describes a version-1 advertisement containing unique names from:

- `principal-context`
- `dispatch-correlation`
- `unit-boundary`
- `verification-provenance`

An empty advertisement is valid and promises no planning capability. Unknown or duplicate names are invalid. An advertisement is not a producer-owned proof and cannot enable a feature. Filesystem publication is a native capability, not something a host advertisement can establish.

## Required authenticated behavior

| Boundary | Required behavior | Failure behavior |
|---|---|---|
| Host registration | Establish the actual registered host through an approved authenticated channel | Unknown host cannot assert a principal |
| Invocation binding | Validate the actual actor, request, and target independently of model fields | Missing, inconsistent, stale, or replayed binding cannot authorize the action |
| Native approval | Check the current approval grant for this principal and revision | No inherited Start grant and no cached-panel bypass |
| Native Start | Check its separate current grant and approved immutable revision | Approval alone cannot dispatch |
| Evidence submission | Identify the authorized verifier and exact unit/revision/result provenance | A self-report or unchecked log cannot become passing verification |
| Shared connection | Preserve distinct caller context for each concurrent invocation | One session cannot borrow another session's authority |

Existing shared-bearer access is not silently upgraded. The privileged operator/webview path must not be reachable by supplying a UI source flag or by reusing a delegated MCP credential.

## Execution and evidence contract still required

The inspected call path identifies where caller context exists and where it is not forwarded. It does not prove a current unit-boundary, revision-handoff, preallocated dispatch-identity, or verification-evidence API.

U6 must establish these with the execution owner and shared facade:

- A precise operation/message identity recorded before possible dispatch, allowing exact reconciliation without matching prompt prose or titles.
- A real unit-boundary acknowledgment before a requested revision handoff takes effect.
- Unit observations qualified by execution, logical unit, and bound revision; generic id-less todos and session idleness are insufficient.
- Evidence with the assessed criteria, result, revision, and identified authorized verifier. Missing or failed evidence remains unverified.
- Explicit handling of delayed observations, indeterminate delivery, and source loss without automatic replay or fabricated progression.

The runtime/host owns production of these observations; space-bus owns any required shared facade extension; Mothership records associations and renders validated observations. No new app scheduler is implied.

## Proof ownership

| Proof | Producer | Evidence required before activation |
|---|---|---|
| Host/context integration | Controlled runtime integration, consumed by U4 | Real host calls from differently authorized sessions on a shared connection; forged argument/metadata attempts fail |
| Principal and grants | U4 native authority and ingress | Checked invocation binding, current-grant revocation, restart, and operator/agent separation |
| Dispatch/boundary/evidence | Execution owner and U6 integration | Actual backend traces with precise correlation and revision-qualified outcomes |
| Confined publication | U3 | The independent native publication contract's real filesystem and recovery proofs |

U1 fixtures establish wire syntax and source-derived contract expectations only. They do not complete these producer proofs. No production module should consume the raw schemas to enable authority in U1.

## Source references

- npm metadata: `https://registry.npmjs.org/@fro.bot%2Fharness/1.18.29-harness.88b6b5fb`
- Runtime tree: `https://github.com/fro-bot/agent/tree/88b6b5fb768ab106a5dc4f11e8ec8dd8ec30cadb`
- Wrapper tree: `https://github.com/fro-bot/agent/tree/cb4a1425bda9b6f422798381db467ec5ffa2777b`
- Runtime invocation context: `https://github.com/fro-bot/agent/blob/88b6b5fb768ab106a5dc4f11e8ec8dd8ec30cadb/packages/opencode/src/session/tools.ts`
- Outbound MCP construction: `https://github.com/fro-bot/agent/blob/88b6b5fb768ab106a5dc4f11e8ec8dd8ec30cadb/packages/opencode/src/mcp/catalog.ts`
- Test ownership: `https://github.com/fro-bot/agent/tree/88b6b5fb768ab106a5dc4f11e8ec8dd8ec30cadb/packages/opencode/test/mcp`
