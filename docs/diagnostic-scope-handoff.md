# Replay diagnostic scope handoff

MAIN owns the diagnostic epoch, independently of page lifecycle generation and Replay Authority. This protocol does not pause reads, launches, or lifecycle transitions.

On seek, MAIN archives its existing diagnostic baseline, opens an independent baseline, and posts `LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_OPEN` with the previous and next epoch. Content performs its existing synchronous overlay cleanup first. The real runtime `PENDING_CLEARED` notification updates the old scope's lifecycle removal count. Content then publishes that scope's terminal snapshot, resets only diagnostic counters, and awaits the MAIN epoch. New diagnostic observations accumulate while awaiting the open message; runtime operation continues. Once bound, Content publishes the new baseline. Initial binding uses a diagnostic HELLO/OPEN exchange; navigation carries the MAIN epoch on the existing lifecycle notification.

Every Content diagnostic message carries lifecycle generation, epoch, a per-scope sequence, cumulative batch counters, cumulative displayed count, and the cumulative scheduler snapshot. Displayed events share this stream instead of using the old unscoped incremental message. Thus delayed input/displayed/scheduler messages cannot be attributed to a new baseline. MAIN applies contiguous sequences exactly once, including delayed messages to their archived baseline only. Duplicate OPEN/terminal messages are idempotent; stale OPEN cannot resurrect a closed epoch.

The receiver buffers at most 64 snapshots per scope and retains the current scope plus eight archives. A gap, missing terminal, missed handoff, overlapping unbound transition, invalid terminal accounting, or exhausted reorder buffer is `INCOMPLETE`. An unresolved evicted archive leaves a persistent incomplete count. Terminal validation uses the existing canonical ledger, requires zero scheduler pending, and never suppresses removal or changes loss/overflow values. Archives retain MAIN's boundary counters (including its existing temporal-retained baseline); this does not establish new evidence about temporal queue cancellation. Existing Temporal accounting definitions and runtime behavior are unchanged.

`LiveFlowReplayAccountingDiagnostic.status()` adds `accountingComplete` and `diagnosticScope`: epoch, closure state, sequence/gap information, and archived canonical ledger summaries. Incomplete handoffs set `warning` even when the current ledger alone balances. Consumers must check `accountingComplete`, warnings, stage validity, loss, and overflow independently. A scope closure is not itself runtime Accounting PASS.

Targeted evidence:

- `test/diagnostic-scope-handoff.test.js`: real Content seek/cleanup, runtime clear, MAIN receiver/accounting functions; separated baselines, old clear attribution, late/duplicate/reversed/missing snapshots, failed closure, bounded archives, normal playback, navigation, and stale OPEN.
- Selected existing structural-removal and actual-cleanup regressions: canonical accounting guards preserved.
- Selected read-only safety regressions: media cleanup, request-neutral diagnostics, aggregate ledger boundaries.

No B/D package is generated here. Existing package outputs still contain the previous implementation and cannot qualify this change. After separately authorized fresh package preparation, the minimum runtime check is one bounded D seek with canonical pre/post snapshots: old epoch's terminal removal count and closed ledger, clean current epoch, `accountingComplete`, independent loss/overflow, then a short Recorder window. B's prior bounded PASS remains inherited; D runtime Accounting and B/D visual comparison remain unqualified. No Density LOCK, adoption, Done, or Phase 5 Exit.
