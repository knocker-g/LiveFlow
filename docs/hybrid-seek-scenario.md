# Hybrid Browser P1 fixture contract

`tools/hybrid-seek-scenario.mjs` exports `runSeekScenario(page, options)`.
There is no executable startup, browser dependency, CDP connection, Product import,
or implicit browser selection. Pass only the existing MCP `page`. The current
`browser_run_code_unsafe` tool accepts an async function of that page (or a file
containing it); it is RCE-equivalent, so future packets must supply reviewed fixed
code, not arbitrary user/source text. No tool invocation was performed in P1.

Only `REPLAY_UI_SEEK_FORWARD_30_V1` is allowed. Separate document-bound inputs:

- `approval`: packet, scenario, deltaSeconds=30, maxActions=1, documentKey.
- `ready`: same packet/documentKey, foregroundExclusive=true.

READY is Human's exclusive foreground attestation; document visibility cannot
prove OS foreground. Neither loaded extension nor previous READY is consent.
Approval applies to one packet invocation; attempted packet IDs are remembered
in the loaded runner module (128 maximum, fail closed without eviction). This is
not durable cross-process authorization: the caller must never replay the packet
or reload the module to retry an attempted action.

## Diagnostic adapter boundary (mocked, not runtime-qualified)

Caller supplies `capture(page, {phase, timeoutMs})`, with PRE, ACTION_GATE and POST
phases. It must use existing MAIN/Content read-only getters in the same document,
return a normalized snapshot, and complete/cancel within the deadline. Never add
listeners, modify globals, execute Core predicates, request READ, poll or retry.
Promise deadlines bound runner waiting; they cannot cancel a misbehaving adapter.
P1.5 adds `createDiagnosticCapture({ expected })` in `hybrid-diagnostic-adapter.mjs` as the
scenario-specific surface mapper; pass it as `capture`. It does not introduce
a generic KNO-215 harness. Existing CDP harness was inspected
as source only, never executed/imported. It creates its own connection and has
navigation/retry semantics incompatible with this packet.

Required normalized fields are explicit in `gate()`: MAIN/Content identity,
documentKey, visibility, phase, authority/currentness/AD facts, lifecycle/epoch,
scope completeness, mismatch/fault/trace completeness, canonical completeness,
conservation/loss/overflow and actual pending counters. Missing fields fail closed.
`mediaTime`/`duration` are ephemeral geometry inputs, not receipt fields.

POST additionally requires actual seek observation, increased epoch, complete
closed old attribution with retained/unclassified/loss/overflow zero. The adapter
must derive those facts from actual archived reason counts, closure and sequence
evidence, accounting for natural launch/drop; a boolean without that evidence is
not sufficient for Product acceptance. Cross-world ordering stays UNORDERED.

### P1.5 actual field mapping

MAIN Shadow status supplies initialAuthorityTrace identity/ring/criticalArchive
and initialRequestDispatch's CURRENT_DOCUMENT_DOM_EXPORT Content trace identity.
The Content panel's exact `DEV B / <12 lowercase hex>` or `DEV D / <12 lowercase hex>`
text supplies the observed candidate and prefix independently of expected. A missing,
malformed, repeated or conflicting panel is rejected; the live read requires exactly
one panel belonging to the current document. MAIN has no separate candidate prefix
getter. MAIN and validated Content export sourceSHA/commonBuildID must both match
the explicitly supplied expected identity. Receipts retain only the candidate enum,
panel count and identity predicate results, not raw panel text or identity values.
`performance.timeOrigin` is a local document join key, not exported in receipts.

Accounting status supplies diagnosticScope.{epoch,scopes,incomplete,
discardedIncomplete}, per-scope lifecycle/sequence/buffered/state, pendingClear
ACK state, all ten canonical stages, and occurrence pending counters. Conservation
is verified against actual input/forwarded/explicitRemoval/retained; no counter
is corrected. Temporal pending includes temporalPending + temporalUnclassified +
temporalDueAwaitingBridge (pendingUnclassified is already inside temporalPending).
Scheduler pending is schedulerRetained checked against stage.retained and
Pipeline.pendingCurrent: a published diagnostic value, not direct Runtime queue
access. A stale publication cannot be independently ruled out by this adapter.

ProductionReanchor status supplies actual controlPhase, navigation/AD/seek,
ownership/timing facts and visibility; Restart status supplies generation,
frame ownership and snapshot currentness. They are existing read-only getters;
no Authority or eligibility methods are called directly. READING plus current
facts establishes present operational eligibility, not reusable Authority or a
claim that consumed authority is unused. Missing facts block.

Ring sequence must be contiguous over its retained window. Ring truncation is
accepted only with COMPLETE, fault-free bounded critical history; Content trace
must be untruncated/contiguous. Critical allowlist sequence is increasing, not
necessarily consecutive. Scope buffered/missing sequence/INCOMPLETE and unresolved
ACK block. PRE captures an OPEN scope, not terminal completion.

POST joins exactly the prior lifecycle/epoch's CLOSED archive with matching
sequence, TERMINAL_VALIDATED, COMPLETE attribution, zero retained/unclassified,
conserved Temporal/Scheduler and loss/overflow zero. SEEK count comes directly
from archivedAttribution.seekRemoval and terminalReasons.SEEK; Scheduler lifecycle
count comes from schedulerReasons.lifecycle. Scheduler reasons must sum to its
explicitRemoval; Temporal reason totals cannot exceed explicitRemoval (which
also includes filtering). A retained SEEK_STARTED trace is required; otherwise
the adapter cannot claim observed seek. These counts do not assert equality with
preflight queue sizes, and do not independently reconstruct every intervening
natural launch/drop. Product runtime acceptance remains separate.

Acquisition is one synchronous MAIN evaluate of existing status getters and DOM
reads, per phase. It performs no cross-world ordering inference or new messaging.
The deadline bounds awaiting; Playwright cannot cancel an already-running read.
All failures return fixed enums, never error text. An existing-document export
still needs real-browser qualification; no browser was connected in P1.5.

### P1.6 POST observation (supersedes immediate POST read above)

PRE and ACTION_GATE keep the original single-read gates. POST serializes only
reviewed local functions and JSON data into one existing-page evaluate; it adds
no global binding or Product API. Temporary capture listeners cover guarded
existing scope-open, pipeline-snapshot and typed-ACK messages, plus owned-video
seeking/seeked/playing and pagehide. Listeners are registered before the initial
read. Related events schedule one coalesced microtask, after the existing handlers;
unrelated source/origin/type/media never triggers a read. Arrival itself is not
proof of closure. The same strict mapper still decides readiness.

Limits: 32 relevant events, 16 snapshots (including initial), at most 10 seconds.
Runner supplies 9 seconds to reserve delivery time within its 10-second outer
deadline. First cap reached stops; there is no periodic polling. Complete, hard
failure, pagehide, exception, event/capture cap and internal deadline all remove
listeners/timer; already queued microtasks become no-ops. Destroying the document
destroys its local observer. A frozen browser/evaluate transport can still prevent
timely timer execution/delivery; the outer runner stops, but cannot remotely cancel
a frozen execution context. That environmental limitation is not a cleanup PASS.

Scope aggregate failures now have individual fixed boundary enums. All outcomes
retain projected numbers/enums only: at most nine scopes, ten stage rows, fixed
Temporal/Scheduler reasons and ACK pending/fault; absent facts are UNKNOWN. POST
history has at most 16 such summaries, plus first observed failure and end reason.
No raw events, document keys, media times, tokens, URLs, arbitrary strings or
comments are exported. Product counters are never synthesized or corrected.

Runner reports UI completion, observed seek, epoch change, old attribution,
old CLOSED/TERMINAL_VALIDATED, current OPEN/conservation and ACK facts separately.
Current ACK pending0 proves no unresolved current operation, not that an operation
existed. Historical operation applicability is UNKNOWN unless exposed; validated
old closure remains the existing guard proof. No absent ACK is invented for a
normal seek. Partial old scope cannot be hidden by a valid current scope.

P1.6 fixtures exercise the real scope Core with deterministic message ordering;
new event-loop/transport scheduling is mocked, not real Edge qualification.
Previous real SEEK_INCONCLUSIVE is unchanged. Next runtime still needs fresh
Human foreground READY and explicit one-seek authorization, with no extra action.

### P1.7 terminal-aware loss classification

Old-scope positive loss/overflow before terminal validation is retained as
PENDING_TERMINAL, not corrected/zeroed/ignored and never a PASS. Event observation
continues within the same limits. The first provisional anomaly (capture, epoch,
actual loss/overflow) is separate from final observer outcome and history.
`terminalObserved=true` plus TERMINAL_VALIDATED/TERMINAL_INVALID is required to
treat an archive measurement as terminal. A positive terminal loss/overflow or
observed TERMINAL_INVALID stops immediately as TERMINAL_FAILURE; runner emits
FAIL independently of the initial incomplete guard. Current-scope loss and
identity/currentness, collector fault, discarded history and other hard-stop
conditions retain their original handling. Missing terminal/closure readiness
stays UNKNOWN/pending; deadline/cap is INCONCLUSIVE, never inferred closure.

Each old scope has ten fixed stage slots. Existing ARCHIVED_ATTRIBUTION_V1 exposes
only Temporal/Scheduler stage counters, copied verbatim; the other eight remain
UNKNOWN. Current stages cannot fill them. `closureReady` and historical ACK
applicability are not exposed directly and remain UNKNOWN. `terminalObserved`
means validation hook observed, not necessarily first terminal message arrival.
No Product diagnostics/API expansion or package update is included.

### P1.8 acceptance scope and pre-action opportunity

Every call now requires `options.acceptanceScope` AND the identical explicit
`approval.acceptanceScope`, selected from SEEK_HANDOFF_TERMINAL (A) or
SEEK_DUAL_NONZERO_ATTRIBUTION (B). Old invocations without scope fail closed.
A keeps every identity/document/Authority/ownership/currentness/Accounting guard
but allows pending zero. Its PASS proves only terminal handoff, not a nonzero
removal or B acceptance. Receipt keeps requested/authorized scope and A/B verdicts.
B never silently downgrades to A: missing actual removal proof keeps overall
INCONCLUSIVE even when the independent A sub-verdict is PASS.

B with only a dual-positive deficiency calls capture phase OPPORTUNITY once.
The adapter registers guarded existing pipeline publication, visibility and
pagehide listeners before its first snapshot. Wait ceiling5s/12 relevant pipeline
events/4 captures including initial. Runner supplies4.5s internal budget inside
5s outer timeout. No timer loop or polling. Nonterminal current lifecycle/epoch,
incomplete=false and increasing sequence are required for a trigger. A coalesced
microtask re-reads the full strict mapper; current applied sequence and Scheduler
pending must exactly match the trigger (superseded/not-applied cannot qualify).
An already-applied newer sequence captured immediately after registration may
qualify as INITIAL_NEW_SEQUENCE, with trigger time/receipt age UNKNOWN. A
Temporal-only change without a new publication can be missed; no guarantee of
opportunity exists. Hidden/state/currentness faults on read abort, never recover.

Opportunity cleanup must complete before ACTION_GATE. That full recheck uses the
same document/lifecycle/epoch, a nonregressing publication sequence, and both
positive counters for B. Queue drain aborts action0, no second wait. Deadline/cap
also action0/NOT_QUALIFIED. Ordinary media events cannot certify a publication.
Document visibility is Human-coordinated; no continuous OS foreground guarantee
or atomic Runtime queue snapshot is claimed. Publication receipt age is local
delivery recency only; all receipts state
NO_PRODUCER_TIMESTAMP_OR_QUEUE_REVISION.

POST stays P1.7. A requires one epoch advance, old validated closure and independent
new scope conservation. B additionally needs positive Temporal SEEK and Scheduler
lifecycle deltas between actual ACTION_GATE reason counters and the matching
old-scope terminal archive, with its stage/closure validation. These are actual
counter deltas, never pre-pending subtraction. Missing/zero/negative reason proof
keeps B NOT_PROVEN and overall INCONCLUSIVE. Cumulative old reasons alone cannot
prove this seek's removal. Empty new ledger never proves fresh Acquisition.

Receipt adds initial/trigger/ACTION_GATE/POST sequence/pending, publication match,
receipt age, wait reason/events/captures/duration/cleanup, A/B verdicts and Human
mid-run interaction counters. The fixtures explicitly bind scopes; real Edge
waiter/event timing and UI still need separate packet-specific READY/authorization.

## UI and evidence

Exactly one visible, unambiguous native YouTube progress slider is required.
One locator click targets the position corresponding to current media time +30s.
No JS media setter or synthetic Play/seek event is used. Geometry/duration mapping,
slider behavior (including live/DVR variants) and cross-world adapter access need
separate real-Edge qualification. The exact 30s result is not guaranteed by a mock.
Immediately before click, capture requalifies document/scope/queues. Visibility
and geometry can still change after that snapshot; no atomic UI-action guarantee
is claimed. Locator action has a 2s timeout; POST capture has a 10s maximum.

Receipt is fixed-size: scenario, independent attempted/completed counts, fixed
firstBadBoundary enum, sanitized pre/post counters, expected identity plus actual
identity-match boolean, and browserReleased. No URLs, IDs, document keys, comments,
tokens, errors/stacks or raw status objects are exported. Release means runner
finished and Human may resume; no focus/close action is performed. Caller saves
the returned receipt and tells Human the browser is released on every outcome.

`SCENARIO_EVIDENCE_COMPLETE` is orchestration output, not Runtime SEEK PASS.
Next runtime packet requires separate explicit seek approval and Human READY,
qualified actual capture adapter, and evidence-based Product verdict. Human needs
initial setup/approval/READY only; no intermediate SEEK_NOW/SEEK_DONE is needed
if this route qualifies. No measured Human/time/token savings are claimed yet.

## P1.9 retained observability

Each mapper outcome now retains a fixed anonymous `evidence` projection before gate evaluation. Identity arms include panel/document facts, prefix classification, MAIN status descriptor/type and identity match, and independent bounded Content dataset parse/identity match. Missing reads remain UNKNOWN. A parsed dataset identity is evidence only: it does not replace the existing validated MAIN Content export admission guard.

Control evidence retains the first mismatch/context, fixed enum event/path/phase/failure, recorded lifecycle/epoch, cumulative counts, up to eight available anomaly rows, ring coverage/truncation and archive completeness. HISTORY_INCOMPLETE does not explain unrecorded increments. Getter calls require own data descriptors and preserve the receiver; unknown accessors are not executed. Exceptions are classified without exporting error text.

No acceptance/Authority/currentness/Accounting guard or listener deadline/cap changed. Runtime invocation must explicitly supply the intended package identity; for the c880919 diagnostic D use prefix b919fdf34325 and its matching source/common provenance. Do not use the older default expected fingerprint as a new-package authorization. Fixture success is not a runtime verdict.

The scenario runner's receipt-only re-projection also retains this schema; arbitrary adapter keys remain excluded. This is an export change only, not an action/approval/qualification change. No package rebuild is needed for P1.9 external tooling.

## P1.9 review correction: independent Content identity arms

`evidence.identity.datasetIdentity` describes only the bounded DOM dataset read/parse/identity and its relationship to MAIN provenance. `validatedContentExport` describes only `initialRequestDispatch.content.identity`, its relationship to MAIN, document correspondence and the existing identity-admission predicate. Neither fills the other's missing values. The legacy `content` arm is now an alias of validated-export identity only. Dataset PASS with validated-export MISSING remains IDENTITY_MISSING and is visible as such in the runner receipt. Admission here means the identity arm, not full document/Authority/Accounting qualification.

Commit dependency closure for this review candidate is exactly the adapter, runner, this documentation, `test/hybrid-observability-retention.test.mjs`, and `test/fixtures/hybrid-diagnostic-reading.json`. The JSON is a historical sanitized diagnostic projection from `.playwright-mcp/kno208-core-init-authorized-reload-after.json` (media omitted, pipeline reduced); it contains no source comments/tokens/URLs and is not current runtime qualification. Test controls explicitly replace expected identity/current-version facts. The fixture needs only Node builtins, the two local tooling modules and that JSON. Existing P1.x regression test files are separate uncommitted evidence assets, not hidden dependencies; their checkpoint should be reviewed separately.

## Explicit runtime expected identity binding

`runSeekScenario(page, { expected, packet, acceptanceScope, approval, ready, capture })` and `createDiagnosticCapture({ expected })` require an explicit complete fingerprint: lowercase hex `prefix` (12), `sourceSHA` (40), and `commonBuildID` (64). Both clone/freeze these three fields before async work. Missing/partial/malformed fields stop before capture/action; there is no runtime legacy default. `EXPECTED` remains historical fixture data, usable only by explicitly passing it for a legacy packet.

Use the same expected object to construct the adapter and invoke the runner. The adapter exposes its immutable expected binding; runner checks it before PRE, passes the fixed binding to each capture, and compares exact snapshot identity at PRE/OPPORTUNITY/ACTION_GATE/POST. Receipt expectedIdentity uses that same binding. This is existing prefix/source/common validation; full buildID/package digest are package-verifier provenance, not newly claimed runtime fields. Captured facts and supplied expected must agree; syntactic validity alone does not prove package provenance. New D uses prefix `b919fdf34325`, Product source `c880919dea33d406aaa98d1377e6888ce131d08b`, common `5b414f33d781d654178e5e9c4131b243fee34f8eee52830422fe97d102c634c6`; repository tooling HEAD is separate.

Legacy invocation helpers in the runner, adapter, A/B and POST fixtures now explicitly supply historical EXPECTED; deliberate missing/malformed contract tests remain negative cases. New runtime packets must not source-rewrite EXPECTED or relabel new captures as old identity. Action approval/READY, A/B scope and all opportunity/POST bounds remain required and unchanged.

## 2026-10-19 interrupted contract closure

The identity migration snapshot includes eight paths: this document, both tooling modules, the expected-identity fixture and the four migrated runner/adapter/A-B/POST test files. Those previously untracked legacy fixtures are included because their invocation setups are mechanically coupled to the now-required expected contract. Test assertions and action/acceptance semantics are unchanged; only explicit historical expected setup is added. They are no longer deferred as an optional baseline checkpoint for this commit.

The import/read closure additionally uses already committed `test/fixtures/hybrid-diagnostic-reading.json` and `src/diagnostic-scope-core.js`, plus Node builtins. It does not require schema-probe dirty work, external browsers, packages or local receipt files. Runtime runner/factory invocations always bind expected explicitly. Pure mapper helpers retain historical unit-test defaults, but the runtime capture factory always supplies its validated binding; the defaults are not a runtime admission fallback. Deliberate missing/partial/malformed expected tests remain invalid-input controls.
## Dev-only owned Passive Recorder lifecycle

`tools/passive-recorder-scenario.mjs` exposes `createPassiveCapture({expected})`
and `runPassiveRecorderScenario(page, options)`. This is a separate
`PASSIVE_RECORDER_V1` operation; it never invokes the Seek runner or changes its
READING/A/B gates. Explicit frozen expected is required end-to-end. The passive
mapper allows matching MAIN/Shadow READING or BUFFER_PAUSED, retaining all prior
identity/currentness, scope/archive/ACK, mismatch/fault and Accounting gates. It
also requires owned playing ready media, complete positive geometry and explicit
Authority binding-currentness facts; unknown values block. Queues may be empty.

Approval and fresh foreground-exclusive READY must bind the packet and local
document key. Approval must name `operation: PASSIVE_RECORDER_V1` and
`recorder: true`. No browser use is implied by fixture results. Native UI Seek,
playback, reload, navigation, extension/settings changes and Product actions are
never part of this operation. No implicit downgrade from Seek or bypass of its
authorization is provided.

The approved dev-only generator now embeds the closure-owned lifecycle controller
and `LIVEFLOW_DEV_OWNED_RECORDER_V1` diagnostic bridge. Existing packages remain
unchanged and lack this bridge: a read-only INFO handshake must verify its
observed build/instance and availability before any START. A fresh separately
qualified package is required; old prefix/source fingerprints must not be reused
as new-package defaults. Generator inputs fingerprint both new lifecycle modules.
No Production manifest, source, Control Plane, Scheduler or acquisition API changes.

One document/Recorder-instance operation owns sampling and deadline resources.
Start is bound to explicit build identity, local document/video and presentation
generation/lifecycle/epoch. Cleanup uses the previously issued diagnostic owner,
not requalification of an invalid identity. Wrong instance/capability/operation
cannot stop another Recorder. Stop closes admission, clears interval/deadline and
fences queued callbacks; STOP_CONFIRMED requires owned resource count0 and active
callback count0. Ownership remains held until caller receives ACK and explicitly
releases it. Unknown cleanup is sticky and prevents further capture, with no
automatic retry, recovery or registry eviction. Later ACK cannot promote invalid
capture into PASS. The registry is bounded to32 operations per document.

The observer's cleanup command carries the same Recorder instance as the
transport. Cancellation arriving before START leaves a bounded tombstone, so a
delayed START cannot allocate new resources afterward. A normal stop ACK does not
hide an unconfirmed observer: receipt fields `recorderCleanup` and
`observerCleanup` are separate, and overall CLEANUP_UNKNOWN holds the owner.
Media/geometry failure facts and UNKNOWN values survive the final receipt.

Observation budget is at most10s from internal start; normal runner duration is8s
(allowed1–9000ms). Every sample/event and read completion checks deadline and
currentness. A delayed callback stops before collecting new data. Internal
deadline request and actual resource release remain different facts. Cleanup
confirmation, including ownership retirement, has a separate2s runner waiting
budget. Diagnostic command listeners use1900ms to reserve100ms delivery margin;
the2s value matches the existing single-read transport budget, not a guarantee of
native release. Frozen/detached context, lost ACK, clear failure or timeout yields
CLEANUP_UNKNOWN/FAILED, never fabricated cleanup PASS. No page/extension reload or
Product cleanupOverlay is used. Manual Record20s UI remains legacy and cannot
replace/interfere with an owned operation.

The operation's deadline is an ephemeral local monotonic-clock value supplied by
the Recorder, carried through capture factory and observer. A resumed observer
checks it before reading diagnostics; timer delivery after expiry cannot create
a late snapshot. The deadline is not persisted as document identity or a native
stop guarantee. Cancellation during start or cleanup never promotes capture PASS.

The passive observer listens only to relevant publication/media/lifecycle events,
coalesces reads after Product handlers, caps32events/16captures and always removes
its per-operation listeners/timer when execution is responsive. Identity/scope/
Authority failure ends observation and sends only old-owner diagnostic cleanup.
Recorder's document-owned bridge listener is not a per-operation resource. A
frozen context cannot acknowledge cleanup; elapsed wall time is not proof.

Receipt separates capture execution, cleanup confirmation/resources, sampled
evidence qualification, Density comparison NOT_PROVEN and Human acceptance
PENDING. Empty activity or missing SPECIAL observations do not imply comparison
success. Canonical Accounting remains an independent diagnostic export. Evidence
projection omits raw video IDs, URLs, comments, owner capabilities and error text;
missing counters remain UNKNOWN. Historical mismatch5/provisional loss22 remain
UNKNOWN. Runtime qualification and visual/Seek/B-D acceptance are separate tasks.

### Import-free passive host invocation

`tools/build-passive-host-invocation.mjs` exports
`buildPassiveHostInvocation({packet, expected, ready, approval, durationMs})`.
Generate the function text offline and pass it to the existing
`browser_run_code_unsafe` filename/code interface. Explicit packet-bound
foreground READY and Recorder approval remain required; generating text is not
browser authorization. Expected identity comes from the selected package manifest.

The host VM has no dynamic-import callback. The builder bundles the three existing
tooling modules into isolated scopes and rejects unbundled imports. It uses only
the supplied existing `page` interface at execution time. After passive PRE passes,
a read-only Web Crypto call obtains one operation capability; it is never written
to the final receipt. The existing runner repeats qualification, checks the bridge,
and owns START/STOP and cleanup. No Product/package change or alternate browser
connection is required. A mock-host fixture proves packaging, not real Edge behavior.

### Read-only invocation dependency gate

`tools/prepare-readonly-invocation.mjs` prepares the D-only read-only runtime
projection separately from the adapter's lexical scope (`initStageNames` is not
the accounting `stageNames`). It does not import the Recorder runner or send
diagnostic bridge commands. `prepareInvocation({filename, expected, packet})`
compiles both the host function and its page expression before writing a fresh
file, then verifies nonempty exact bytes and SHA256. Existing files are never
overwritten. Any failure returns `OFFLINE_PREFLIGHT_FAILED` without a host call.

The immediate caller must pass the successful in-memory receipt to
`invokePrepared(receipt, {invoke, authorization})` in the same process.
Authorization must independently name the packet, `readOnly: true`, and fresh
`foregroundExclusive: true`. The gate rejects forged/serialized/failed receipts,
missing/empty/changed files, and repeated dispatch. It sends verified `code`
bytes through the supplied host callback, never an unchecked filename. A host
error consumes the attempt and is not retried. Do not queue a separate browser
tool unconditionally after a generation shell command. This is a dependency
gate for reviewed source, not a sandbox for arbitrary generator callbacks.
Preparation and mock-host PASS do not authorize or execute browser validation.
