# Recorder and structural accounting recovery

2026-10-13. Starting HEAD `20c0f75182fd12587d8b3e36008e48173411c347`. Existing probe source/test dirty and unrelated untracked documents/tools/captures preserved.

## Recorder: confirmed receiver defect

Saved smoke stack points to generated `start()` at `timer = host.setInterval(sample, 100)`. The generator passed native Window methods as properties of a plain host object. Calling them as host methods supplies the wrong receiver; failure precedes sampling and any scheduling/accounting instrumentation. MAIN/ISOLATED access is not the first bad boundary. The saved accounting warning already precedes recorder start, independently supporting separation of the two faults.

Generated host now uses arrows calling `window.setInterval` and `window.clearInterval`. No new API, permission, bridge or Production timer is introduced. A brand-checking Window fixture reproduces Illegal invocation with the old host and verifies both generated B/D start/stop, three timestamped frames, bounded stop and JSON serialization after the fix. Existing passive recorder/package tests remain valid and pass.

Machine JSON serialization is PASS; real-browser Blob/download delivery is NOT_RUN after this fix. The old download timeout is not independently diagnosed as a browser download defect. Previously loaded packages are immutable snapshots and remain unmodified; they do not acquire this fix automatically.

## Accounting: confirmed omitted terminal-removal path

The ledger defines input = forwarded + explicitRemoval + retained + lost. `lostUnaccounted` is derived, not incremented by a loss counter. Scheduler input is cumulative enqueued; forwarded is successful launch; retained is current queue depth; explicit removal previously summed stale, capacity/emergency and lifecycle removals only.

`pending-selection.evaluate()` already removes structurally unrepresentable items after proof. Runtime emits `UNREPRESENTABLE_SPECIAL` while proving, before queue mutation; that event is neither a terminal-removal quantity nor included in the canonical scheduler ledger. Once pending shrinks, the omitted removal becomes apparent loss. Rejecting Renderer commits leaves items retained and is not this removal. Normal lifecycle/window removal has a separate existing quantity. Development instrumentation does not own this queue or ledger.

An isolated execution of the original baseline queue, state machine, runtime and actual MAIN ledger expression, with no dev recorder, produced scheduler losses `[0,1,2,3,4,5,6]` for six structural SPECIAL removals. The fixed integration uses actual content diagnostic publisher, MAIN receiver and ledger expression, verifying zero loss/overflow, explicit removals1..6 and valid scheduler stage. No-selection and later clear do not duplicate removals.

The queue now reports bounded reason/count after actual removal via optional observer callback. Scheduler forwards `STRUCTURAL_DROPPED`; content and MAIN diagnostics retain its cumulative quantity; the canonical existing explicit-removal sum includes it. Reasons remain bounded `UNREPRESENTABLE_SPECIAL`/`UNKNOWN`, with no raw items/IDs. Callback exceptions cannot alter selection. Existing selection, footprint, proof, expiry, lifecycle, launch authority and active trajectories are unchanged. No force-zero, inferred terminal removal from totals, or relaxing Safety occurred.

Historical smoke0→1→6 is consistent with this confirmed source defect, but saved logs contain no structural-terminal quantity. Exact attribution of every historical service item remains INCONCLUSIVE. Those old observations are not rewritten to zero, and post-fix real-service accounting is NOT_RUN. This distinction does not invalidate deterministic qualification of the omitted source path.

## Checks and remaining work

Targeted197/197 PASS: recorder-accounting regression, pending-selection, scheduler-state-machine, scheduler-runtime, chat-read-core, isolated-density-comparison. This includes package wiring and sampler receiver tests, queue removal/one-opportunity bounds, lifecycle accounting and deliberate loss detection. The original164 batch was not blindly repeated; suites were selected for changed observer/queue/ledger/package boundaries. Unchanged READ-only/Authority, Typography A, retention and collision/aggregate geometry evidence reused.

No Browser operation, extension management, runtime rebuild/reload or real-video rerun. Test-only generated package fixtures live in ignored build output; they are not adopted packages. Existing B visual/Typpography PASS remains evidence for that old package, not new runtime acceptance. Full entry/exit INCONCLUSIVE; SPECIAL/subtitle NOT_RUN; B/D comparison NOT_RUN; Human final acceptance pending.

Next: prepare verified refreshed dev-only packages and arrange one qualified recorder/ledger runtime discriminator under an explicit follow-up instruction. User reload of the selected comparison package will be required then; no action is requested before a concrete refreshed package is available. No Production Density adoption/LOCK, issue Done, push or Phase5 exit.
