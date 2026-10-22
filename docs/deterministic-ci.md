# Deterministic CI baseline

Prepared for Node 24.12.0 using only built-in modules. No npm install, browser,
YouTube, advertisement, Recorder session or Human visual gate is required.

## Commands

Ordinary changes: `node tools/ci.mjs --base <full-base-commit-SHA>`.
Preview without executing checks: append `--plan`.
The comparison is `base...HEAD`; local uncommitted/untracked work is not a
substitute for a committed CI checkpoint. Tests selected from tracked files only.

The always-on set covers READ-only/security, Replay Control Plane,
Authority/currentness, scope handoff, temporal occurrence accounting and actual
owner-selective pending cleanup. Changed tests and reverse transitive literal
relative dependencies add affected fixtures. A source/tool change without a
known test dependency is an error, not a silent skip. Browser-global/dynamic
dependencies are not completely modeled by the literal graph; inspect the plan
and explicitly use an integration checkpoint when coverage is uncertain.

Coherent integration/merge-ready/Phase-exit/RC checkpoint only:
`node tools/ci.mjs --integration`. This selects all tracked deterministic Node
tests and may generate disposable fixture builds. It does not authorize real
browser or Recorder operations. Full-suite failures must be resolved before
claiming that checkpoint; the command itself is not release evidence.

Both modes syntax-check tracked JavaScript under src/popup/tools/test, parse
manifest/locales, verify manifest assets, privileges and required module wiring,
and run the selected tests sequentially with a finite child-process timeout.

## Workflow and trust

`.github/workflows/deterministic.yml` uses the JSON subset of YAML so Node can
parse its actual configuration without adding a YAML dependency. PR and push
events use their base/before SHA. A branch-creation push without a usable base
fails explicitly; manually dispatch the integration checkpoint. Manual dispatch
requires selecting the integration input. No automatic full-suite fallback.

Actions are pinned to immutable revisions; checkout does not persist credentials.
The token has contents:read only. Event data passes through quoted environment
variables and the Node entrypoint accepts only a full hexadecimal commit SHA.
No secrets, install scripts, caches, deployment, artifact upload or publishing.
These guards are not a substitute for the exact-RC security surface audit.

## Baseline assertion reconciliation

At 4db9b5a, six existing source assertions in read-only-safety and
replay-control-plane-core drifted from the current contract: an explanatory
authorization comment; an earlier initial-intent hidden guard; scope-bound
display publication; nested frozen removal diagnostics; delegated bootstrap
invalidation; and readiness-gated bootstrap admission. Reconciliation executes
the actual listener/helpers in deterministic VM fixtures and tests prohibited
mutations, stale/missing/consumed Authority, foreign ownership, scope loss and
privacy failures. No gate is skipped and no Product behavior is changed.
