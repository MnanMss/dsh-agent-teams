# Harness 0.2.1-rc.3 compatibility

The published `0.1.26` artifact declares its exact peer set up to `0.2.1-rc.2`. The host compatibility gate evaluates those ranges against the running version with no fallback for an unknown version, so `0.2.1-rc.3` refuses to load the plugin before activation. `0.1.27` adds rc.3, retains rc.2 and every earlier supported host, and moves the development cohort to rc.3.

## Source audit

- rc.2: `687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`).
- rc.3: `1f81c047fc48fa190a683e469daa699857e9afe8` (`dsh-v0.2.1-rc.3`).
- Published to npm `2026-10-23T07:54:30Z` on the `next` dist-tag; `latest` still points at rc.2. The official registry resolves a complete 296-package DSH cohort, so the full closure is pinned rather than a CLI version alone.
- Comparing the packaged `lib/` payloads of rc.2 and rc.3, only four packages changed:
  - `@deepseek-ai/dsh-client-ui-conversation` — additive `viewPins` client service, `sidebar.right.tab.guide.actions` and `views.actions` slots, optional composer-submission fields.
  - `@deepseek-ai/dsh-client-ui-sidebar-right` — additive `guide-pins` service, guide actions and a `More` row type.
  - `@deepseek-ai/dsh-client-ui-primitives` — additive `Menu` props (`current`, `minWidthFromAnchor`) and a rewritten tooltip placement helper with matching CSS.
  - `@deepseek-ai/dsh-api-session-controller` — one doc comment.
- Every other sampled package, including `@deepseek-ai/dsh`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-client-ui-chat`, the slot contract and the session/subagent/tools packages, has a byte-identical `lib/` payload. `dsh-app-boot`, which owns `evaluatePluginCompatibility()`, is byte-identical between rc.2 and rc.3: the rejection is a version-range miss, not an API break.
- AgentTeams imports none of the changed APIs except `Menu`, which only gained optional props. No activation adapter change was required.

## Verification

The unmodified 0.1.26 official npm tarball is rejected by the rc.3 CLI plugin manager in a fresh isolated profile, with no exemption active, reproducing the desktop error verbatim. The runtime runner performs a real CLI plugin-manager add of the candidate in a separate rc.3 profile, without `allow-version`, in addition to its lifecycle, recovery, failure, entry, web approval, protocol and stability scenarios.

Local macOS validation passed: build, typecheck, full `pnpm verify`, and all eleven runtime scenarios including the plugin-manager install. Candidate SHA-256: `baa90b34f70730e2d793b67ae668d8d39f1bf0c07e08e05639c1f4a3ec245b70`. The installation gate accepted the exact 0.1.27 package without an exemption. CI runs the exact supported-host matrix and Ubuntu/Windows checks before npm publication; those results must be checked separately.

Real provider credentials, native desktop interaction and migration of existing user data are outside the isolated fixture coverage. Do not equate these checks with a manual desktop acceptance test.

## Recovery

Existing published artifacts and tags are immutable. Upgrade to 0.1.27 on rc.3; do not bypass host compatibility checks. A rollback to 0.1.26 requires a supported host such as rc.2 and separate care for user data — on rc.3 the older artifact stays rejected by the gate.
