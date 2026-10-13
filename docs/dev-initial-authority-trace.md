# Initial Authority ordering trace (development only)

Enable through the existing comparison generator:

`node tools/build-density-comparison.mjs --initial-authority-trace build/density-comparison-initial-authority-<unique>`

The default generator path stays uninstrumented. Production source/manifest, Authority, Control Plane and READ decisions are unchanged. Only generated MAIN and generated shadow-controller copies receive hooks; B/D receive identical copies. Provenance includes the trace profile, helper/injector input hashes and generated output hashes. Old output cannot be overwritten.

The collector installs before Replay controller construction and initial bootstrap. It keeps a document-local 256-record ring, strict sequence, truncation and collector-fault flags. The existing read-only `LiveFlowReplayControlPlaneShadowDiagnostic.status().initialAuthorityTrace` returns detached snapshots, profile `INITIAL_AUTHORITY_ORDER_V1`, source SHA and common build ID. There are no new globals, action commands, messages, permissions, native API wrappers, requests, timers or awaits. Snapshot reads cannot arm, reset, clear, consume, retry or otherwise affect Product.

Records whitelist lifecycle/revision/generation/diagnostic epoch, order, bounded enums and counts. They exclude tokens/token hashes, target values/URLs, comments/identities, credentials, raw response, stacks and actual media offsets/timestamps. Unknown fields are not read. Media/visibility are enums. State at acceptance/authorization/claim is taken from the actual existing operation outcome and the unchanged Core contract; no additional authorization/claim/currentness checks are performed. Existing diagnostic reads are cached only where already performed, preserving their call count. Source anchors are exact and generation fails on unfamiliar shape.

Key ordering distinctions:

- Candidate accepted -> Authority `OBSERVED_UNUSED`.
- Successful `authorizeAuthorityRequest` -> Authority `CONSUMED`, Grant `AUTHORIZED`.
- Actual media/hidden gate rejection may occur afterward with no HTTP request and no Grant claim.
- Actual `claimAuthorityRequestGrant` -> Grant `CLAIMED`, then original READ begins.
- Invalidation of unused Authority -> `INVALID`; invalidation attempt on consumed Authority is `NO_OP`, never resurrection.
- Foreground eligibility and stop/queued outcome remain the original decisions.

The generated shadow controller adds a private observer for dispatch and capability comparison. Original reducer/capability calls and return values are preserved. First mismatch is attributed to its event/path/count increment; it is not automatically classified as an Authority defect. Collector failures/overflow only invalidate trace qualification, never Product execution.

Targeted tests compare actual original/instrumented MAIN functions against actual Authority Core for paused, hidden and authorized READ paths, including calls/arguments/receiver/results. They cover early installation, once rejection, all early read-loop gates, terminal invalidation, claim, shadow attribution, bounded ring/privacy/fault behavior, status-only export, generator/provenance and Production exclusion. The READ fixture is synthetic and deliberately returns an invalid-response outcome; it is not runtime acquisition evidence. Existing scope/Safety evidence is reused without broad rerun.

Next runtime packet: load verified fresh B/D packages, keep D only enabled, restore settings, and defer the single ordinary page startup until MCP is ready. One normal reload OR navigation in the existing dedicated Edge, foreground throughout; no forced pause/hide, seek, retry or toggle. Collector automatically precedes bootstrap, even if MCP reads the snapshot later. After the first natural startup outcome (short bounded window), export the existing getter once. Require `TRACE_INSTALLED` first, unbroken sequence, no truncation/fault and matching provenance. A healthy new startup does not establish the historical failure cause. No runtime Accounting/Recorder/visual acceptance is conferred by this implementation.
