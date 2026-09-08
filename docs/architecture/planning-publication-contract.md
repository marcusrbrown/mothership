# Planning publication contract

## Status and boundary

This U1 document defines the preservation and recovery contract that U3 must prove before enabling native plan writes. It does not implement a filesystem algorithm or claim that atomic rename supplies compare-and-swap against an external editor.

Current `src-tauri/src/workspace_fs.rs` is read-only. U1 adds no native command, filesystem permission, writer, authority store, or runtime registration. Wire fixtures in `src/planning/contracts.test.ts` validate proposed intent syntax only.

## Identities and custody

| Item | Meaning and owner |
|---|---|
| Logical document | Native enrollment resolves an opaque document ID to permitted project Markdown under a known roster root |
| Expected external version | The version compared by the editor, or an explicit expectation that no destination exists |
| Candidate | The exact proposed source content, retained independently of publication |
| Publication intent | A unique operation bound to caller, document, expected external version, and candidate identity |
| Authority record version | Native transaction concurrency token; distinct from a Markdown content version |
| Protected snapshots/records | Native app-data custody outside document-write roots; never writable through a document ID |

The native service, not the wire payload, establishes caller authority and resolves the actual destination. Project names, paths, caller flags, and editor state cannot replace that resolution.

## Proposed intent syntax

`publicationIntentSchema` defines version 1 with an opaque `operationId`, opaque `documentId`, `expectedExternalVersion`, and `candidateSha256`.

- Opaque IDs use an alphanumeric first character followed by alphanumeric, underscore, or hyphen characters, up to 128 characters. They are not titles or filesystem paths.
- The expected version is either `absent` or a SHA-256 value. Absence is an explicit creation precondition, not a wildcard overwrite instruction.
- Hashes use 64 lowercase hexadecimal characters. A claimed hash still requires comparison against actual bytes by the future native service.
- Extra path, principal, permission, or trust fields are rejected.

This intent has no credential or authority field. Valid syntax neither authorizes a write nor establishes that the expected version is current.

## Required decision outcomes

| Condition | Required outcome |
|---|---|
| Invalid caller, document enrollment, containment, file type, or safety capability | Reject before publication and retain the draft |
| Destination exists when absence was expected | Conflict; do not replace it |
| Destination changed from the expected external version | Preserve local and external versions; require comparison and explicit resolution |
| Valid binding and proven publication path | Publish once; acknowledge only the durable recorded outcome |
| A second writer changes the destination after the final check | Preservation and explicit-resolution behavior must still hold; a clean hash check alone cannot justify success |
| Interrupted or uncertain publication | Recover from preserved versions and operation records; expose uncertainty rather than automatically retrying or restoring |
| Repeated operation | Do not write twice; return an identical recorded receipt only when the complete binding matches, otherwise reject conflicting reuse |

If a candidate algorithm cannot satisfy the final-check race or recovery contract on a filesystem, that publication capability stays unavailable. A watcher, advisory lock, or best-effort comparison is not a permitted substitute for the missing guarantee.

## Conflict resolution

- **Choose external:** adopt the freshly validated external version and retain the local draft; adopting it does not require overwriting the file.
- **Choose local:** publish against the external version the user just compared. Another external edit causes another conflict, not a force overwrite. Retain the external candidate.
- **Merge:** retain both inputs and create a reviewable candidate, then apply the same publication checks.
- **Leave unresolved:** preserve both sides without publishing a resolution.

Changed plan content requires approval of the new revision. Conflict resolution never transfers historical approval or triggers execution.

## Native confinement and transaction requirements

1. Validate current enrollment and roster-root containment at use, including traversal, symlink replacement, and attempts to alias protected records into document scope.
2. Limit operations to enrolled plan Markdown. Do not expose arbitrary filesystem access through the sidecar or a raw path argument.
3. Serialize app-originated writers, while treating external editors as independent writers that may not honor advisory locks.
4. Keep candidate and external-version preservation explicit throughout publication and recovery. Do not delete the only recoverable copy as cleanup.
5. Use a native transaction owner and expected record versions for protected authority/association updates. Reject stale changes rather than losing newer approvals or revocations.
6. Acknowledge protected record changes only after durable commit. Recovery must not resurrect an uncertain grant or lose acknowledged revocation.
7. Do not imply one transaction spans protected records, project filesystem publication, and backend dispatch. Each boundary has its own recorded outcome and uncertainty.

File modes and confined interfaces protect against callers limited to those interfaces. They are not containment of arbitrary same-OS-user processes, nor does an append-only convention alone create cryptographic tamper evidence.

## Producer-owned proof matrix

U3 owns `src-tauri/tests/planning_publication.rs` and the native custody tests. The tests must exercise real filesystem interleavings, not only mocked file reads.

| Scenario | Evidence required |
|---|---|
| Ordinary create/update | Correct bytes, retained immutable snapshot, and a single durable outcome |
| Expected-absent collision | Existing destination remains intact and both candidates remain recoverable |
| External change before publication | No silent replacement; explicit comparison and resolution |
| External change between final check and publication | Preservation of the actual competing version, not merely the older version originally read |
| Concurrent app writers | Stale expected versions cannot overwrite a newer result |
| Crash before/after each publication and record boundary | Recovery identifies acknowledged, not-published, or uncertain outcomes without destructive replay |
| Path or symlink changes during resolution | No escape from enrolled project scope or access to protected stores |
| Stale/replayed intent | No second write and no reuse against a different caller, document, version, or candidate |
| Unsupported filesystem behavior | Publication remains disabled with an actionable reason |
| Approval/revocation race | A stale protected-record write cannot resurrect authority |

## Stop conditions

U1 is complete when the contract, producer, and proof targets are explicit and its raw intent fixtures pass. U3 is not complete until the actual algorithm satisfies this matrix and the origin's preservation rules. Any necessary change to those rules requires an explicit decision; a failing proof does not authorize weaker behavior.

No native-write or custody capability is enabled by these documents or schemas. Authentication, filesystem permissions, new dependencies, and runtime registration remain separately gated implementation work.

## References

- Origin: `docs/brainstorms/2026-09-07-agent-native-planning-lifecycle-requirements.md`, especially external/concurrent editing and revision approval.
- Implementation plan: `docs/plans/2026-09-07-001-feat-agent-native-planning-plan.md`, U1/U3/U4.
- Existing read seam: `src-tauri/src/workspace_fs.rs`.
- Existing custody precedent: `src-tauri/src/ide_sidecar.rs`; this is a precedent to inspect, not a publication proof.
- Rust file semantics: `https://doc.rust-lang.org/std/fs/fn.rename.html` and `https://doc.rust-lang.org/std/fs/fn.canonicalize.html`.
