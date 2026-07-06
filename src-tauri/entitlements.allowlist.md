# macOS entitlements allowlist

This is the source of truth for every entitlement granted to a Mothership
release binary. Two separate entitlements files exist on purpose — **the
main app and the compiled `ide_*` sidecar never share an entitlements
file.** Sidecar-only exceptions (JIT, library-validation) must not leak into
the main webview process's code-signing identity.

Any change to either `.plist` file must update this table in the same PR.
CODEOWNERS requires owner review for both files plus this document.

## `src-tauri/Entitlements.plist` (main app / main webview process)

| Entitlement | Why it's needed | Scope |
|---|---|---|
| `com.apple.security.cs.allow-jit` | WKWebView's JavaScriptCore needs a JIT-capable memory region under Hardened Runtime; without it the webview fails to load any script. | Main app only. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JavaScriptCore allocates unsigned executable pages for JIT-compiled JS; Hardened Runtime blocks this by default. | Main app only. |
| `com.apple.security.network.client` | The renderer dials the `opencode serve` bus and the packaged `ide_*` sidecar over loopback (`127.0.0.1`/`::1`), and PTY sessions may spawn network-capable child processes. | Main app only. |

Explicitly **not** granted to the main app: `com.apple.security.cs.disable-library-validation`,
`com.apple.security.cs.allow-dyld-environment-variables`, App Sandbox (see
KTD/decision log in the release plan — App Sandbox conflicts with PTY/dev
workspace use in v0.1), and any file-system entitlement beyond what Hardened
Runtime + the OS file picker already provide.

## `src-tauri/sidecar-Entitlements.plist` (compiled `ide-server` sidecar only)

| Entitlement | Why it's needed | Scope |
|---|---|---|
| `com.apple.security.cs.allow-jit` | The sidecar is a compiled Bun binary; Bun's own JS engine needs JIT-capable memory, independent of the main app's WebView JIT need. | Sidecar binary only. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Same JIT requirement as above, for Bun's JIT-compiled code. | Sidecar binary only. |
| `com.apple.security.cs.disable-library-validation` | `bun build --compile` output dynamically loads Bun's bundled runtime libraries that are not signed by the same Team ID chain macOS expects by default; without this the sidecar fails to launch under Hardened Runtime. | Sidecar binary only — **must not** apply to the main app. |
| `com.apple.security.network.client` | The sidecar dials outward for MCP tool operations (e.g. reading workspace files, invoking local commands). | Sidecar binary only. |
| `com.apple.security.network.server` | The sidecar binds a loopback HTTP/WS listener (`IDE_PORT=<n>`) that the main app's webview bridge connects to. | Sidecar binary only. |

## Verification checklist (before freezing entitlements for a release)

- [ ] Signed app launches on both `aarch64-apple-darwin` and
      `x86_64-apple-darwin` (Rosetta) release lanes.
- [ ] Compiled sidecar launches under Hardened Runtime on both lanes and
      passes its `/health` probe.
- [ ] `codesign --display --entitlements :- <binary>` for the main app does
      **not** show `disable-library-validation`.
- [ ] `codesign --display --entitlements :- <sidecar binary>` shows the
      sidecar-only entitlements above and no more.
- [ ] Any new entitlement request is added to this table with a rationale
      before it is added to either `.plist` file.
