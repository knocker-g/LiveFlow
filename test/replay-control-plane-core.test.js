const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/replay-control-plane-core.js');

const bindingValue = { lifecycleId: 1, revision: 2, targetId: 'target', generation: 3 };
const binding = core.createAuthorityBinding(bindingValue).binding;

test('shared enums expose only locked Phase 4 vocabulary', () => {
    assert.deepEqual(Object.values(core.AuthorityKind), ['BOOTSTRAP', 'SEQUENTIAL', 'REANCHOR']);
    assert.deepEqual(Object.values(core.AuthorityState), ['OBSERVED_UNUSED', 'CONSUMED', 'INVALID']);
    assert.deepEqual(Object.values(core.ReplayPhase), ['STOPPED', 'BOOTSTRAPPING', 'READING', 'BUFFER_PAUSED', 'REANCHORING', 'SUSPENDED']);
    assert.deepEqual(Object.values(core.SuspendedReason), ['HIDDEN', 'AD', 'MEDIA_PAUSED']);
    assert.deepEqual(Object.values(core.CapabilityState), ['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
    assert.deepEqual(Object.values(core.CapabilityName), [
        'replayMessages', 'bootstrapRead', 'sequentialRead', 'reanchorRead',
        'playerTiming', 'targetIdentity', 'mainContentOwnership'
    ]);
});

test('AuthorityBinding requires four fields, freezes them, and matches exactly', () => {
    const created = core.createAuthorityBinding(bindingValue);
    assert.equal(created.ok, true);
    assert.equal(Object.isFrozen(created.binding), true);
    assert.equal(core.authorityBindingsEqual(created.binding, { ...bindingValue }), true);
    for (const field of Object.keys(bindingValue)) {
        const partial = { ...bindingValue };
        delete partial[field];
        assert.equal(core.createAuthorityBinding(partial).ok, false, field);
    }
    assert.equal(core.authorityBindingsEqual(created.binding, { ...bindingValue, generation: 4 }), false);
    assert.equal(core.createAuthorityBinding({ ...bindingValue, targetId: 'UNKNOWN' }).ok, false);
    assert.equal(core.createAuthorityBinding({ ...bindingValue, targetId: '' }).ok, false);
});

test('authority facade is single-use and raw token is not serialized or diagnosed', () => {
    const created = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'private-token', binding, provenance: 'ADAPTER_SEQUENTIAL'
    });
    assert.equal(created.ok, true);
    assert.doesNotMatch(JSON.stringify(created.authority), /private-token|target/);
    assert.deepEqual(created.authority.diagnostic(binding), {
        authorityKind: 'SEQUENTIAL', authorityState: 'OBSERVED_UNUSED', authorityProvenance: 'ADAPTER_SEQUENTIAL',
        authorityCurrent: true, authorityBindingValid: true, lifecycleCurrent: true,
        revisionCurrent: true, subjectCurrent: true, generationCurrent: true
    });
    assert.equal(core.transitionAuthority(created.authority, 'CONSUME', binding).ok, true);
    assert.equal(core.transitionAuthority(created.authority, 'CONSUME', binding).reason, 'AUTHORITY_CONSUMED');
    assert.equal(core.transitionAuthority(created.authority, 'INVALIDATE', binding).reason, 'AUTHORITY_CONSUMED');
});

test('authority facade rejects stale binding and supports terminal invalidation', () => {
    const created = core.createReplayAuthority({
        kind: 'BOOTSTRAP', opaqueToken: 'opaque', binding, provenance: 'ADAPTER_BOOTSTRAP'
    });
    assert.equal(core.transitionAuthority(created.authority, 'CONSUME', { ...binding, revision: 9 }).reason, 'AUTHORITY_STALE');
    assert.equal(core.transitionAuthority(created.authority, 'INVALIDATE', binding).ok, true);
    assert.equal(core.transitionAuthority(created.authority, 'CONSUME', binding).reason, 'AUTHORITY_INVALID');
});

test('Control Plane can terminally invalidate an unused authority at a suspension boundary', () => {
    const authority = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'suspend-private', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.equal(core.invalidateAuthority(authority).ok, true);
    assert.equal(authority.diagnostic(binding).authorityState, 'INVALID');
    assert.equal(core.invalidateAuthority(authority).reason, 'AUTHORITY_INVALID');
    assert.equal(core.authorizeAuthorityRequest({
        authority, expectedKind: 'SEQUENTIAL', currentBinding: binding,
        consumedRegistry: core.createConsumedAuthorityRegistry()
    }).reason, 'AUTHORITY_INVALID');
});

test('saved SEQUENTIAL authorization creates exactly one opaque consume-before-fetch grant', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const authority = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'saved-private-token', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    const authorized = core.authorizeAuthorityRequest({
        authority, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    });
    assert.equal(authorized.ok, true);
    assert.equal(authority.diagnostic(binding).authorityState, 'CONSUMED');
    assert.equal(registry.diagnostic().consumedCount, 1);
    assert.doesNotMatch(JSON.stringify(authorized.grant), /saved-private-token|target/);
    const claim = core.claimAuthorityRequestGrant(authorized.grant, 'SEQUENTIAL');
    assert.deepEqual(claim, { ok: true, opaqueToken: 'saved-private-token', reason: 'NONE' });
    assert.equal(core.claimAuthorityRequestGrant(authorized.grant, 'SEQUENTIAL').reason, 'GRANT_CONSUMED');
    assert.equal(core.authorizeAuthorityRequest({
        authority, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_CONSUMED');
});

test('consumed authority registry supports private lifecycle-scoped identity checks', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const authority = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'registry-token', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.equal(registry.has('registry-token'), false);
    assert.equal(core.authorizeAuthorityRequest({ authority, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry }).ok, true);
    assert.equal(registry.has('registry-token'), true);
    assert.deepEqual(Object.keys(registry.toJSON ? registry.toJSON() : registry.diagnostic()), ['consumedCount']);
});

test('BOOTSTRAP authorization is consume-before-fetch, single-claim, and registry-backed', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const authority = core.createReplayAuthority({
        kind: 'BOOTSTRAP', opaqueToken: 'private-bootstrap', binding, provenance: 'ADAPTER_BOOTSTRAP'
    }).authority;
    const authorized = core.authorizeAuthorityRequest({
        authority, expectedKind: 'BOOTSTRAP', currentBinding: binding, consumedRegistry: registry
    });
    assert.equal(authorized.ok, true);
    assert.equal(authority.diagnostic(binding).authorityState, 'CONSUMED');
    assert.equal(registry.diagnostic().consumedCount, 1);
    assert.doesNotMatch(JSON.stringify(authorized.grant), /private-bootstrap|target/);
    assert.deepEqual(core.claimAuthorityRequestGrant(authorized.grant, 'BOOTSTRAP'), {
        ok: true, opaqueToken: 'private-bootstrap', reason: 'NONE'
    });
    assert.equal(core.claimAuthorityRequestGrant(authorized.grant, 'BOOTSTRAP').reason, 'GRANT_CONSUMED');
    assert.equal(core.authorizeAuthorityRequest({
        authority, expectedKind: 'BOOTSTRAP', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_CONSUMED');
});

test('consumed BOOTSTRAP A hands off to distinct SEQUENTIAL B without mutation or token reuse', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const bootstrap = core.createReplayAuthority({
        kind: 'BOOTSTRAP', opaqueToken: 'A', binding, provenance: 'ADAPTER_BOOTSTRAP'
    }).authority;
    const bootstrapGrant = core.authorizeAuthorityRequest({
        authority: bootstrap, expectedKind: 'BOOTSTRAP', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(core.claimAuthorityRequestGrant(bootstrapGrant, 'BOOTSTRAP').opaqueToken, 'A');
    assert.equal(bootstrap.diagnostic(binding).authorityKind, 'BOOTSTRAP');
    assert.equal(bootstrap.diagnostic(binding).authorityState, 'CONSUMED');

    const sequential = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'B', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    const sequentialGrant = core.authorizeAuthorityRequest({
        authority: sequential, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(core.claimAuthorityRequestGrant(sequentialGrant, 'SEQUENTIAL').opaqueToken, 'B');
    assert.equal(sequential.diagnostic(binding).authorityKind, 'SEQUENTIAL');
    assert.equal(registry.diagnostic().consumedCount, 2);

    const repeatedBootstrap = core.createReplayAuthority({
        kind: 'BOOTSTRAP', opaqueToken: 'A', binding, provenance: 'ADAPTER_BOOTSTRAP'
    }).authority;
    assert.equal(core.authorizeAuthorityRequest({
        authority: repeatedBootstrap, expectedKind: 'BOOTSTRAP', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_REPEATED');
});

test('saved authority authorization rejects missing, stale, invalid, kind mismatch, and repeated tokens', () => {
    const registry = core.createConsumedAuthorityRegistry();
    assert.equal(core.authorizeAuthorityRequest({
        authority: null, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_INVALID');
    const stale = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'stale', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.equal(core.authorizeAuthorityRequest({
        authority: stale, expectedKind: 'SEQUENTIAL', currentBinding: { ...binding, generation: 4 }, consumedRegistry: registry
    }).reason, 'AUTHORITY_STALE');
    const wrongKind = core.createReplayAuthority({
        kind: 'REANCHOR', opaqueToken: 'wrong-kind', binding, provenance: 'ADAPTER_REANCHOR'
    }).authority;
    assert.equal(core.authorizeAuthorityRequest({
        authority: wrongKind, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_KIND_MISMATCH');
    const invalid = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'invalid', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    core.transitionAuthority(invalid, 'INVALIDATE', binding);
    assert.equal(core.authorizeAuthorityRequest({
        authority: invalid, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_INVALID');
    const first = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'repeated', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.equal(core.authorizeAuthorityRequest({
        authority: first, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).ok, true);
    const repeated = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'repeated', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.equal(core.authorizeAuthorityRequest({
        authority: repeated, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_REPEATED');
});

test('sequential progression consumes distinct A and B authorities without state reset or token reuse', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const authorityA = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'A', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    const grantA = core.authorizeAuthorityRequest({
        authority: authorityA, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(core.claimAuthorityRequestGrant(grantA, 'SEQUENTIAL').opaqueToken, 'A');
    const authorityB = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'B', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.notEqual(authorityA, authorityB);
    assert.equal(authorityA.diagnostic(binding).authorityState, 'CONSUMED');
    assert.equal(authorityB.diagnostic(binding).authorityState, 'OBSERVED_UNUSED');
    const grantB = core.authorizeAuthorityRequest({
        authority: authorityB, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(core.claimAuthorityRequestGrant(grantB, 'SEQUENTIAL').opaqueToken, 'B');
    assert.equal(registry.diagnostic().consumedCount, 2);
    assert.equal(core.transitionAuthority(authorityA, 'CONSUME', binding).reason, 'AUTHORITY_CONSUMED');
});

test('REANCHOR grant is single-use and hands off to a distinct fresh SEQUENTIAL authority', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const reanchor = core.createReplayAuthority({
        kind: 'REANCHOR', opaqueToken: 'seek-A', binding, provenance: 'ADAPTER_REANCHOR'
    }).authority;
    const reanchorGrant = core.authorizeAuthorityRequest({
        authority: reanchor, expectedKind: 'REANCHOR', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(reanchor.diagnostic(binding).authorityState, 'CONSUMED');
    assert.equal(core.claimAuthorityRequestGrant(reanchorGrant, 'REANCHOR').opaqueToken, 'seek-A');
    assert.equal(core.claimAuthorityRequestGrant(reanchorGrant, 'REANCHOR').reason, 'GRANT_CONSUMED');
    const sequential = core.createReplayAuthority({
        kind: 'SEQUENTIAL', opaqueToken: 'fresh-B', binding, provenance: 'ADAPTER_SEQUENTIAL'
    }).authority;
    assert.notEqual(reanchor, sequential);
    assert.equal(reanchor.diagnostic(binding).authorityKind, 'REANCHOR');
    assert.equal(sequential.diagnostic(binding).authorityState, 'OBSERVED_UNUSED');
    const sequentialGrant = core.authorizeAuthorityRequest({
        authority: sequential, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.equal(core.claimAuthorityRequestGrant(sequentialGrant, 'SEQUENTIAL').opaqueToken, 'fresh-B');
    assert.equal(registry.diagnostic().consumedCount, 2);
});

test('normal-playback coverage repair enters REANCHORING without clearing retained pending', () => {
    const transition = core.reduceReplayControlState(core.createReplayState('READING'), 'REANCHOR_AUTHORIZED', {
        preservePending: true
    });
    assert.equal(transition.nextState.phase, 'REANCHORING');
    assert.equal(transition.pendingAction, 'KEEP');
    assert.equal(transition.requestIntent, 'REQUEST_REANCHOR');
});

test('Production coverage-hole repair is bounded, pending-preserving, and uses the existing REANCHOR path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const gate = source.match(/function maybeQueueReplayCoverageHoleRepair\([^]*?\n    \}/)?.[0] || '';
    const executor = source.match(/async function runQueuedReplayReanchor\([^]*?\n    \}/)?.[0] || '';
    const flush = source.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.match(gate, /evaluateReplayCoverageHoleRepair/);
    assert.match(gate, /hasReplayCurrentWindowCoverageHole/);
    assert.match(gate, /transitionReplayCoverageHoleEpisode[^]*'AUTHORIZED'/);
    assert.match(gate, /queueReplayReanchor\('COVERAGE_HOLE'/);
    assert.match(flush, /maybeQueueReplayCoverageHoleRepair/);
    assert.match(executor, /preservePending: intent\.reason === 'COVERAGE_HOLE'/);
    assert.match(executor, /invalidateAuthorityHandle\(replayObservedSequentialAuthority\)/);
    assert.match(executor, /replayPending\.concat\(result\.messages\)/);
    assert.match(executor, /classifyReplayCoverageHoleRepairResult/);
    assert.doesNotMatch(gate, /setTimeout|setInterval|requestAnimationFrame|fetch/);
});

test('CapabilitySnapshot is immutable, fills missing entries with UNKNOWN, and never infers capabilities', () => {
    const created = core.createCapabilitySnapshot({
        binding, evidenceEpoch: 1,
        capabilities: { sequentialRead: 'SUPPORTED', playerTiming: 'SUPPORTED' }
    });
    assert.equal(created.ok, true);
    assert.equal(Object.isFrozen(created.snapshot), true);
    assert.equal(Object.isFrozen(created.snapshot.capabilities), true);
    assert.equal(created.snapshot.capabilities.sequentialRead, 'SUPPORTED');
    assert.equal(created.snapshot.capabilities.replayMessages, 'UNKNOWN');
    assert.equal(created.snapshot.capabilities.reanchorRead, 'UNKNOWN');
});

test('capability path dependency checks distinguish required and unrelated capabilities', () => {
    const all = Object.fromEntries(Object.values(core.CapabilityName).map((name) => [name, 'SUPPORTED']));
    const snapshot = core.createCapabilitySnapshot({ binding, evidenceEpoch: 1, capabilities: all }).snapshot;
    assert.equal(core.canUseCapabilityPath('SEQUENTIAL', snapshot, binding).allowed, true);
    const withoutReanchor = core.createCapabilitySnapshot({
        binding, evidenceEpoch: 2, capabilities: { ...all, reanchorRead: 'UNKNOWN' }
    }).snapshot;
    assert.equal(core.canUseCapabilityPath('SEQUENTIAL', withoutReanchor, binding).allowed, true);
    assert.equal(core.canUseCapabilityPath('REANCHOR', withoutReanchor, binding).allowed, false);
    assert.deepEqual(core.canUseCapabilityPath('REANCHOR', withoutReanchor, binding).unavailable,
        [{ name: 'reanchorRead', state: 'UNKNOWN' }]);
    assert.equal(core.canUseCapabilityPath('SEQUENTIAL', snapshot, { ...binding, generation: 4 }).allowed, false);
});

test('foreground retained diagnostic duration uses fixed shape-only buckets', () => {
    assert.equal(core.classifyForegroundHiddenDurationMs(-1), 'UNKNOWN');
    assert.equal(core.classifyForegroundHiddenDurationMs(Number.NaN), 'UNKNOWN');
    assert.equal(core.classifyForegroundHiddenDurationMs(1000), 'VERY_SHORT');
    assert.equal(core.classifyForegroundHiddenDurationMs(10000), 'SHORT');
    assert.equal(core.classifyForegroundHiddenDurationMs(60000), 'MEDIUM');
    assert.equal(core.classifyForegroundHiddenDurationMs(180000), 'LONG');
});

test('foreground retained diagnostic eligibility fails closed for every missing precondition', () => {
    const valid = {
        armed: true, captured: true, hiddenObserved: true, visibleObserved: true,
        terminal: false, requestCount: 0, bindingCurrent: true, ownershipCurrent: true,
        capabilityAllowed: true, documentVisible: true, noAd: true, noSeek: true,
        noNavigation: true, noReadRequest: true, noReanchorRequest: true,
        noDiagnosticConflict: true, noDiagnosticRequest: true, controlStopped: true,
        tokenAvailable: true, contextAvailable: true
    };
    assert.deepEqual(core.evaluateForegroundRetainedDiagnosticEligibility(valid), { allowed: true, reason: 'NONE' });
    for (const name of Object.keys(valid).filter((name) => typeof valid[name] === 'boolean' && name !== 'terminal')) {
        assert.equal(core.evaluateForegroundRetainedDiagnosticEligibility({ ...valid, [name]: false }).allowed, false, name);
    }
    assert.equal(core.evaluateForegroundRetainedDiagnosticEligibility({ ...valid, terminal: true }).reason, 'ALREADY_CONSUMED');
    assert.equal(core.evaluateForegroundRetainedDiagnosticEligibility({ ...valid, requestCount: 1 }).reason, 'ALREADY_CONSUMED');
    assert.equal(core.evaluateForegroundRetainedDiagnosticEligibility({ ...valid, bindingCurrent: false }).reason, 'STALE_BINDING');
});

test('foreground Production recovery eligibility separates authority, capability, binding, and environment facts', () => {
    const valid = {
        visible: true, replayTarget: true, lifecycleCurrent: true, revisionCurrent: true, targetCurrent: true,
        authorityAvailable: true, authorityUnused: true, authorityBindingCurrent: true, authorityUnconsumed: true,
        noAd: true, noSeek: true, ownershipCurrent: true, playerTimingValid: true,
        noRequestConflict: true, capabilityAllowed: true, controlSuspendedHidden: true
    };
    assert.deepEqual(core.evaluateForegroundRecoveryEligibility(valid), { allowed: true, reason: 'ELIGIBLE' });
    for (const key of Object.keys(valid)) {
        const rejected = core.evaluateForegroundRecoveryEligibility({ ...valid, [key]: false });
        assert.equal(rejected.allowed, false, key);
        assert.equal(rejected.reason, key, key);
    }
});

test('authority eligibility inspection is non-consuming and registry-aware', () => {
    const registry = core.createConsumedAuthorityRegistry();
    const authority = core.createReplayAuthority({
        kind: 'REANCHOR', opaqueToken: 'foreground-A', binding, provenance: 'ADAPTER_REANCHOR'
    }).authority;
    assert.deepEqual(core.inspectAuthorityRequestEligibility({
        authority, expectedKind: 'REANCHOR', currentBinding: binding, consumedRegistry: registry
    }), { ok: true, reason: 'NONE' });
    assert.equal(authority.diagnostic(binding).authorityState, 'OBSERVED_UNUSED');
    const grant = core.authorizeAuthorityRequest({
        authority, expectedKind: 'REANCHOR', currentBinding: binding, consumedRegistry: registry
    }).grant;
    assert.ok(grant);
    assert.equal(core.inspectAuthorityRequestEligibility({
        authority, expectedKind: 'REANCHOR', currentBinding: binding, consumedRegistry: registry
    }).reason, 'AUTHORITY_CONSUMED');
});

test('reducer follows bootstrap, sequential, and buffer resume paths without implicit bootstrap', () => {
    let state = core.createReplayState('STOPPED');
    let transition = core.reduceReplayControlState(state, 'LIFECYCLE_START');
    assert.equal(transition.nextState.phase, 'BOOTSTRAPPING');
    transition = core.reduceReplayControlState(transition.nextState, 'BOOTSTRAP_AUTHORIZED');
    assert.equal(transition.requestIntent, 'REQUEST_BOOTSTRAP');
    transition = core.reduceReplayControlState(transition.nextState, 'BOOTSTRAP_SUCCEEDED');
    assert.equal(transition.nextState.phase, 'READING');
    assert.equal(transition.authorityAction, 'ACCEPT_FRESH_SEQUENTIAL');
    transition = core.reduceReplayControlState(transition.nextState, 'BUFFER_HIGH_WATERMARK');
    assert.equal(transition.nextState.phase, 'BUFFER_PAUSED');
    assert.equal(transition.authorityAction, 'SAVE_SEQUENTIAL');
    for (const event of ['BUFFER_LOW_WATERMARK', 'EARLY_RESUME_ELIGIBLE']) {
        const resume = core.reduceReplayControlState(transition.nextState, event);
        assert.equal(resume.nextState.phase, 'READING');
        assert.equal(resume.authorityAction, 'RESTORE_SAVED');
        assert.equal(resume.requestIntent, 'REQUEST_SEQUENTIAL');
    }
    const forbidden = core.reduceReplayControlState(transition.nextState, 'BOOTSTRAP_AUTHORIZED');
    assert.equal(forbidden.failure, 'FORBIDDEN_EVENT');
    assert.equal(forbidden.nextState.phase, 'BUFFER_PAUSED');
});

test('initial alignment is an explicit bootstrap-to-reanchor transition without synthetic seek', () => {
    const bootstrapping = core.createReplayState('BOOTSTRAPPING');
    const transition = core.reduceReplayControlState(bootstrapping, 'INITIAL_ALIGNMENT_REQUIRED');
    assert.equal(transition.nextState.phase, 'REANCHORING');
    assert.equal(transition.authorityAction, 'INVALIDATE_ACTIVE');
    assert.equal(transition.pendingAction, 'CLEAR');
    assert.equal(transition.requestIntent, 'NONE');
    assert.notEqual('INITIAL_ALIGNMENT_REQUIRED', 'SEEK_STARTED');
    assert.notEqual('INITIAL_ALIGNMENT_REQUIRED', 'SEEK_COMPLETED');
});

test('initial alignment policy commits only proven coverage and permits one authorized attempt', () => {
    assert.deepEqual(core.evaluateInitialReplayAlignment({
        targetOffsetMsec: 0, coverage: 'UNKNOWN', reanchorEligible: false, attempted: false
    }), { action: 'COMMIT_BOOTSTRAP', reason: 'ALIGNED' });
    assert.deepEqual(core.evaluateInitialReplayAlignment({
        targetOffsetMsec: 30000, coverage: 'ALIGNED', reanchorEligible: false, attempted: false
    }), { action: 'COMMIT_BOOTSTRAP', reason: 'ALIGNED' });
    for (const coverage of ['OUTSIDE', 'UNKNOWN']) {
        assert.deepEqual(core.evaluateInitialReplayAlignment({
            targetOffsetMsec: 30000, coverage, reanchorEligible: true, attempted: false
        }), { action: 'ALIGN_ONCE', reason: coverage });
    }
    assert.deepEqual(core.evaluateInitialReplayAlignment({
        targetOffsetMsec: 30000, coverage: 'UNKNOWN', reanchorEligible: true, attempted: true
    }), { action: 'HOLD', reason: 'ATTEMPT_USED' });
    assert.deepEqual(core.evaluateInitialReplayAlignment({
        targetOffsetMsec: 30000, coverage: 'OUTSIDE', reanchorEligible: false, attempted: false
    }), { action: 'HOLD', reason: 'AUTHORITY_UNAVAILABLE' });
    assert.deepEqual(core.evaluateInitialReplayAlignment({
        targetOffsetMsec: null, coverage: 'UNKNOWN', reanchorEligible: true, attempted: false
    }), { action: 'HOLD', reason: 'PLAYER_TIMING_UNKNOWN' });
    for (const targetOffsetMsec of [1000, 60000, 3600000]) {
        assert.equal(core.evaluateInitialReplayAlignment({
            targetOffsetMsec, coverage: 'OUTSIDE', reanchorEligible: true, attempted: false
        }).action, 'ALIGN_ONCE');
    }
});

test('Production initial alignment suppresses old bootstrap commit and has no retry or fallback path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const decision = source.indexOf("if (requestAuthorityKind === 'BOOTSTRAP')", source.indexOf('if (mode === \'replay\') {', source.indexOf('const canContinue')));
    const responseCommit = source.indexOf('observeReplayPipelineResponse(result)', decision);
    const pendingCommit = source.indexOf('replayPending = replayPending.concat(result.messages)', decision);
    const block = source.slice(decision, responseCommit);
    assert.ok(decision >= 0 && responseCommit > decision && pendingCommit > responseCommit);
    assert.match(block, /classifyReplayInitialStartupCoverage/);
    assert.match(block, /evaluateInitialReplayAlignment/);
    assert.match(block, /INITIAL_ALIGNMENT_REQUIRED/);
    assert.match(block, /queueReplayReanchor\('INITIAL_ALIGNMENT'/);
    assert.match(block, /break;/);
    assert.doesNotMatch(block, /SEEK_STARTED|SEEK_COMPLETED/);
    assert.doesNotMatch(block, /setTimeout|setInterval|retry|fallback|INITIAL_WATCH/);
    assert.equal((source.match(/queueReplayReanchor\('INITIAL_ALIGNMENT'/g) || []).length, 1);
});

test('stale bootstrap and reanchor completions cannot mutate current control state or pending', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /responseBindingCurrent = generation === currentLoopGeneration[^]*lifecycleGeneration === pageLifecycleGeneration[^]*if \(mode === 'replay' && responseBindingCurrent\)/);
    assert.match(source, /completionCurrent = generation === currentLoopGeneration[^]*intent\.lifecycleGeneration === pageLifecycleGeneration[^]*if \(result\?\.ok && completionCurrent/);
    assert.match(source, /if \(completionCurrent && !result\?\.ok\) replayPipelineDiagnostic\.reanchorProductionState/);
    assert.match(source, /if \(completionStillCurrent\) observeReplayControlShadow\('REANCHOR_FAILED'\)/);
    const initialDecision = source.indexOf("observeReplayControlShadow('INITIAL_ALIGNMENT_REQUIRED')");
    const pipelineCommit = source.indexOf('observeReplayPipelineResponse(result)', initialDecision);
    const pendingCommit = source.indexOf('replayPending = replayPending.concat(result.messages)', initialDecision);
    assert.ok(initialDecision >= 0 && pipelineCommit > initialDecision && pendingCommit > pipelineCommit);
});

test('reducer models suspend precedence and media pause resume targets', () => {
    const stopped = core.createReplayState('STOPPED');
    assert.equal(core.reduceReplayControlState(stopped, 'HIDDEN_ENTER').nextState.phase, 'STOPPED');
    assert.equal(core.reduceReplayControlState(stopped, 'AD_ENTER').nextState.phase, 'STOPPED');

    const reading = core.createReplayState('READING');
    const pausedReading = core.reduceReplayControlState(reading, 'MEDIA_PAUSE').nextState;
    assert.deepEqual(pausedReading, { phase: 'SUSPENDED', suspendedReason: 'MEDIA_PAUSED', resumeTarget: 'READING' });
    assert.equal(core.reduceReplayControlState(pausedReading, 'MEDIA_PLAY').nextState.phase, 'READING');

    const buffer = core.createReplayState('BUFFER_PAUSED');
    const pausedBuffer = core.reduceReplayControlState(buffer, 'MEDIA_PAUSE').nextState;
    assert.equal(pausedBuffer.resumeTarget, 'BUFFER_PAUSED');
    assert.equal(core.reduceReplayControlState(pausedBuffer, 'MEDIA_PLAY').nextState.phase, 'BUFFER_PAUSED');
    const ad = core.reduceReplayControlState(pausedBuffer, 'AD_ENTER').nextState;
    assert.equal(ad.suspendedReason, 'AD');
    const hidden = core.reduceReplayControlState(ad, 'HIDDEN_ENTER').nextState;
    assert.equal(hidden.suspendedReason, 'HIDDEN');
    assert.equal(core.reduceReplayControlState(hidden, 'AD_ENTER').nextState.suspendedReason, 'HIDDEN');
    assert.equal(core.reduceReplayControlState(hidden, 'VISIBLE_ENTER', { adActive: true }).nextState.suspendedReason, 'AD');
    const hiddenFromReading = core.reduceReplayControlState(reading, 'HIDDEN_ENTER');
    assert.equal(hiddenFromReading.authorityAction, 'RETAIN_ELIGIBLE_REANCHOR');
    const recovered = core.reduceReplayControlState(hiddenFromReading.nextState, 'VISIBLE_ENTER', {
        adActive: false, recoveryEligible: true
    });
    assert.equal(recovered.nextState.phase, 'REANCHORING');
    assert.equal(recovered.authorityAction, 'KEEP');
    const failed = core.reduceReplayControlState(hiddenFromReading.nextState, 'VISIBLE_ENTER', {
        adActive: false, recoveryEligible: false
    });
    assert.equal(failed.nextState.phase, 'STOPPED');
    assert.equal(failed.requestIntent, 'NONE');
});

test('media pause preserves an already saved sequential authority while buffer paused', () => {
    const saved = { identity: 'saved-sequential' };
    const observed = { identity: 'observed-sequential' };

    assert.equal(core.retainSequentialAuthorityForMediaPause(saved, null), saved,
        'BUFFER_PAUSED owns the saved unused authority even when no loop-local candidate exists');
    assert.equal(core.retainSequentialAuthorityForMediaPause(null, observed), observed,
        'READING transfers the loop-local observed authority into pause storage');
    assert.equal(core.retainSequentialAuthorityForMediaPause(null, null), null,
        'no authority is invented when neither owner has one');
});

test('seek precedence, failure closure, and rate change are explicit', () => {
    for (const state of [
        core.createReplayState('READING'),
        core.createReplayState('BUFFER_PAUSED'),
        core.createReplayState('SUSPENDED', 'MEDIA_PAUSED', 'READING')
    ]) {
        const transition = core.reduceReplayControlState(state, 'SEEK_STARTED');
        assert.equal(transition.nextState.phase, 'REANCHORING');
        assert.equal(transition.pendingAction, 'CLEAR');
    }
    const reanchoring = core.createReplayState('REANCHORING');
    assert.equal(core.reduceReplayControlState(reanchoring, 'SEEK_STARTED').nextState.phase, 'REANCHORING');
    assert.equal(core.reduceReplayControlState(reanchoring, 'REANCHOR_FAILED').nextState.phase, 'STOPPED');
    const rate = core.reduceReplayControlState(core.createReplayState('READING'), 'PLAYBACK_RATE_CHANGED');
    assert.equal(rate.nextState.phase, 'READING');
    assert.equal(rate.failure, 'NO_OP');
});

test('all state and event pairs receive a total classification', () => {
    const states = [
        core.createReplayState('STOPPED'), core.createReplayState('BOOTSTRAPPING'),
        core.createReplayState('READING'), core.createReplayState('BUFFER_PAUSED'),
        core.createReplayState('REANCHORING'), core.createReplayState('SUSPENDED', 'HIDDEN'),
        core.createReplayState('SUSPENDED', 'AD'), core.createReplayState('SUSPENDED', 'MEDIA_PAUSED', 'READING')
    ];
    for (const state of states) {
        for (const event of Object.values(core.ReplayEvent)) {
            const transition = core.reduceReplayControlState(state, event, { optional: false });
            assert.ok(transition && transition.nextState && typeof transition.failure === 'string', `${state.phase}/${event}`);
        }
    }
});

test('shadow controller is deterministic and exposes redacted fixed diagnostics only', () => {
    const shadow = core.createShadowController();
    shadow.dispatch('LIFECYCLE_START');
    let status = shadow.dispatch('BOOTSTRAP_AUTHORIZED', {}, 'BOOTSTRAPPING');
    assert.equal(status.shadowPhase, 'BOOTSTRAPPING');
    assert.equal(status.latestMismatch, 'NONE');
    status = shadow.dispatch('BOOTSTRAP_SUCCEEDED', {}, 'STOPPED');
    assert.equal(status.latestMismatch, 'PHASE_MISMATCH');
    assert.deepEqual(Object.keys(status).sort(), [
        'latestMismatch', 'mismatchCount', 'shadowPhase', 'shadowResumeTarget',
        'shadowSuspendedReason', 'transitionCount'
    ]);
    assert.doesNotMatch(JSON.stringify(status), /continuation|token|targetId|schema|https?:/i);
});

test('pure control-plane module imports no DOM, network, timer, scheduler, or renderer surface', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/replay-control-plane-core.js'), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|document\.|querySelector|MutationObserver|setInterval|requestAnimationFrame/);
    assert.doesNotMatch(source, /scheduler-runtime|youtube-chat|liveChatReplayContinuationData|playerSeekContinuationData/);
});

test('runtime shadow integration is loaded before page state and cannot control Production branches', () => {
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const mainScripts = manifest.content_scripts.find((entry) => entry.world === 'MAIN' && entry.run_at === 'document_idle').js;
    assert.ok(mainScripts.indexOf('src/replay-control-plane-core.js') < mainScripts.indexOf('src/page-state-main.js'));
    const source = fs.readFileSync(path.join(root, 'src/page-state-main.js'), 'utf8');
    assert.match(source, /createShadowController/);
    assert.match(source, /LiveFlowReplayControlPlaneShadowDiagnostic/);
    assert.doesNotMatch(source, /if\s*\(\s*observeReplayControlShadow|while\s*\(\s*observeReplayControlShadow/);
    const observationCalls = source.split(/\r?\n/)
        .filter((line) => line.includes('observeReplayControlShadow(') && !line.includes('function observeReplayControlShadow'))
        .join('\n');
    assert.doesNotMatch(observationCalls, /continuation|opaqueToken|schema|targetIdentity|currentTime/i);
});

test('buffer normal resume uses a single-use grant and has no raw or bootstrap fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const normalStart = source.indexOf("if (normalResume?.eligible === true)");
    const earlyStart = source.indexOf('const earlyResume =', normalStart);
    const normalPath = source.slice(normalStart, earlyStart);
    assert.match(normalPath, /authorizeSavedSequentialResume\(\)/);
    assert.match(normalPath, /startReadLoop\(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant\)/);
    assert.doesNotMatch(normalPath, /authority\.continuation|pageState\.continuation|INITIAL_WATCH|BOOTSTRAP|REANCHOR/);
    assert.match(source, /claimAuthorityRequestGrant\?\.\(currentRequestGrant, requestAuthorityKind\)/);
    assert.match(source, /createReplayAuthority\?\.\(\{[^]*kind: 'SEQUENTIAL'[^]*provenance: 'ADAPTER_SEQUENTIAL'/);
});

test('normal sequential progression uses candidate handles and grants instead of raw handoff', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /nextSequentialAuthority = continuationProgress === 'ADVANCED'[^]*createSequentialAuthorityCandidate\(nextSequentialContinuation, candidateBinding\)/);
    assert.match(source, /authorizeSequentialAuthority\([^]*nextSequentialAuthority[^]*currentRequestGrant/);
    assert.match(source, /claimAuthorityRequestGrant\?\.\(currentRequestGrant, requestAuthorityKind\)[^]*performRead\(requestContinuation/);
    assert.match(source, /replayPausedSequentialAuthority = nextSequentialAuthority;\s*replayObservedSequentialAuthority = null;\s*nextSequentialAuthority = null/);
    assert.match(source, /if \(mode !== 'replay'\) continuation = continuationInfo\.continuation/);
    const sourcePolicy = source.match(/const shadowResponseEvent[^]*?observeReplayControlShadow\(shadowResponseEvent\)/)?.[0] || '';
    assert.doesNotMatch(sourcePolicy, /continuationSource/);
});

test('Production re-anchor uses REANCHOR grant and fresh SEQUENTIAL grant without raw fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const capture = source.match(/function captureReplaySeekAuthority\([^]*?\n    \}/)?.[0] || '';
    assert.match(capture, /kind: 'REANCHOR'[^]*provenance: 'ADAPTER_REANCHOR'/);
    assert.doesNotMatch(capture, /consumed:\s*false|continuation\s*:/);
    const executor = source.match(/async function runQueuedReplayReanchor\([^]*?\n    \}/)?.[0] || '';
    assert.match(executor, /authorizeReplayAuthority\([^]*'REANCHOR'/);
    assert.match(executor, /claimAuthorityRequestGrant\?\.\(reanchorGrant, 'REANCHOR'\)/);
    assert.match(executor, /createSequentialAuthorityCandidate\([^]*authorizeSequentialAuthority\(/);
    assert.match(executor, /startReadLoop\(pageLifecycleGeneration, 'PLAYER_SEEK_HANDOFF', sequentialGrant\)/);
    assert.doesNotMatch(executor, /pageState\.continuation|INITIAL_WATCH|authority\.continuation|authority\.consumed|\bfallback\b|\bretry\b/i);
});

test('Production bootstrap uses one opaque BOOTSTRAP grant and hands off to fresh SEQUENTIAL authority', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const candidate = source.match(/function acceptReplayBootstrapCandidate\([^]*?\n    \}/)?.[0] || '';
    assert.match(candidate, /replayBootstrapEligibilityLifecycleId === pageLifecycleGeneration/);
    assert.match(candidate, /replayBootstrapEligibilityLifecycleId = pageLifecycleGeneration/);
    assert.match(candidate, /kind: 'BOOTSTRAP'[^]*provenance: 'ADAPTER_BOOTSTRAP'/);
    const start = source.match(/function startReplayBootstrap\([^]*?\n    \}/)?.[0] || '';
    assert.match(start, /authorizeReplayAuthority\(replayBootstrapAuthority, 'BOOTSTRAP'/);
    assert.match(start, /startReadLoop\(requestedLifecycleGeneration, 'INITIAL_WATCH', grant\)/);
    assert.match(source, /claimAuthorityRequestGrant\?\.\(currentRequestGrant, requestAuthorityKind\)/);
    assert.match(source, /requestAuthorityKind === 'BOOTSTRAP'[^]*'BOOTSTRAP_SUCCEEDED'/);
    assert.match(source, /nextSequentialAuthority = continuationProgress === 'ADVANCED'[^]*createSequentialAuthorityCandidate/);
});

test('bootstrap lifecycle eligibility is terminal within a lifecycle and resets only on lifecycle change', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /if \(replayBootstrapEligibilityLifecycleId === pageLifecycleGeneration\) return false/);
    assert.equal((source.match(/replayBootstrapEligibilityLifecycleId = pageLifecycleGeneration/g) || []).length, 1);
    assert.equal((source.match(/replayBootstrapEligibilityLifecycleId\s*=\s*-1/g) || []).length, 1);
    assert.match(source, /pageLifecycleGeneration \+= 1;\s*replayBootstrapAuthority = null/);
    assert.doesNotMatch(source, /replayBootstrapConsumedLifecycleGeneration/);
});

test('Replay bootstrap has no raw page-state authority or generic deferred fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /continuation: chatMode === 'live'[^]*\? continuation : ''/);
    assert.match(source, /continuation: pageState\.mode === 'live' \? pageState\.continuation : ''/);
    assert.doesNotMatch(source, /deferredReplayReadStart/);
    assert.doesNotMatch(source, /authorizeReplayReadStart/);
    assert.match(source, /const replayStartAuthority = pageState\.mode === 'replay' && replayRequestGrant/);
    assert.match(source, /if \(pageState\.mode === 'replay'\) startReplayBootstrap/);
    assert.match(source, /&& pageState\.mode === 'live'\) startReadLoop\(generation\)/);
});

test('Production HIDDEN retains only an eligible REANCHOR and foreground recovery never resumes directly', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const enter = source.match(/function enterReplaySuspended\([^]*?\n    \}/)?.[0] || '';
    assert.match(enter, /effectiveReason = document\.hidden[^]*\? 'HIDDEN' : reason/);
    assert.match(enter, /invalidateAuthorityHandle\(replayBootstrapAuthority\)/);
    assert.match(enter, /invalidateAuthorityHandle\(replayPausedSequentialAuthority\)/);
    assert.match(enter, /retainReanchor = effectiveReason === 'HIDDEN'[^]*replaySeekAuthorityEligibleForHidden\(hiddenOwnedVideo\)/);
    assert.match(enter, /if \(!retainReanchor\) \{[^]*invalidateAuthorityHandle\(replaySeekAuthority\)[^]*replaySeekAuthority = null/);
    assert.match(enter, /stopReadLoop\(effectiveReason === 'HIDDEN' \? 'visibility-hidden' : 'ad-enter'\)/);
    assert.match(enter, /observeReplayControlShadow\(effectiveReason === 'HIDDEN' \? 'HIDDEN_ENTER' : 'AD_ENTER'\)/);
    assert.match(source, /if \(replayProductionControlState\?\.phase === 'SUSPENDED'[^]*return null/);
    assert.match(source, /async function startReadLoop[^]*pageState\.mode === 'replay' && replayProductionControlState\?\.phase === 'SUSPENDED'[^]*FAILED_CLOSED[^]*return/);
    assert.match(source, /function flushReplayPending[^]*document\.hidden \|\| replayProductionControlState\?\.phase === 'SUSPENDED'\) return/);

    const visible = source.match(/function resumeReadAfterVisibility\([^]*?\n    \}/)?.[0] || '';
    const replayVisible = visible.slice(0, visible.indexOf('const core = window.LiveFlowChatReadCore'));
    assert.match(replayVisible, /replayProductionControlState\?\.phase !== 'SUSPENDED'[^]*suspendedReason !== 'HIDDEN'/);
    assert.match(replayVisible, /replayAdIsActive\(\)/);
    assert.match(replayVisible, /evaluateForegroundRecoveryEligibility/);
    assert.match(replayVisible, /observeReplayControlShadow\('VISIBLE_ENTER', \{ adActive: false, recoveryEligible: true \}\)/);
    assert.match(replayVisible, /queueReplayReanchor\('FOREGROUND'/);
    assert.doesNotMatch(replayVisible, /respond\(|startReadLoop|startReplayBootstrap|INITIAL_WATCH/);
});

test('foreground recovery is capability-gated, consumes one retained authority, and hands off only fresh sequential', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const visible = source.match(/function resumeReadAfterVisibility\([^]*?\n    \}/)?.[0] || '';
    const executor = source.match(/async function runQueuedReplayReanchor\([^]*?\n    \}/)?.[0] || '';
    assert.match(visible, /reanchorRead: 'SUPPORTED'[^]*targetIdentity:[^]*mainContentOwnership:[^]*playerTiming:/);
    assert.match(visible, /inspectAuthorityRequestEligibility/);
    assert.match(visible, /authorityAvailable:[^]*authorityUnused:[^]*authorityBindingCurrent:[^]*authorityUnconsumed:/);
    assert.match(visible, /ownershipCurrent[^]*capabilityAllowed[^]*controlSuspendedHidden/);
    assert.match(executor, /authorizeReplayAuthority\([^]*replaySeekAuthority[^]*'REANCHOR'/);
    assert.match(executor, /claimAuthorityRequestGrant\?\.\(reanchorGrant, 'REANCHOR'\)/);
    assert.match(executor, /intent\.reason === 'FOREGROUND'[^]*freshSequentialHandoff = true[^]*foregroundRecoveryResult = 'SUCCESS'/);
    assert.doesNotMatch(visible, /INITIAL_WATCH|pageState\.continuation|startReplayBootstrap|startReadLoop/);
});

test('foreground recovery diagnostics are shape-only and diagnostic token never enters Production', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const status = source.match(/function replayForegroundRecoveryStatus\(\)[^]*?\n    \}/)?.[0] || '';
    assert.match(status, /replayForegroundRecoveryDiagnostic/);
    assert.doesNotMatch(status, /token|continuation|offset|target|url|timestamp|video/i);
    assert.match(source, /retainedAtHidden:[^]*retainedCurrentAtVisible:[^]*foregroundRecoveryStarted:[^]*foregroundRecoveryResult:[^]*freshSequentialHandoff:/);
    const gateStart = source.indexOf('window.LiveFlowReplayForegroundRetainedReanchorDiagnostic');
    const gateEnd = source.indexOf('window.LiveFlowReplayPlayerSeekActiveDiagnostic', gateStart);
    const productionVisible = source.match(/function resumeReadAfterVisibility\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(productionVisible, /replayForegroundRetainedDiagnostic|retainedToken|opaqueToken/);
    assert.ok(gateStart >= 0 && gateEnd > gateStart);
});

test('AD exit uses only retained approved REANCHOR and hidden precedence has no nested stack', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const adEnter = source.match(/event\.data\.type === REPLAY_AD_ENTER_TYPE[^]*?return;/)?.[0] || '';
    assert.match(adEnter, /enterReplaySuspended\('AD'\)/);
    assert.doesNotMatch(adEnter, /startReadLoop|startReplayBootstrap|queueReplayReanchor/);
    const adExitStart = source.indexOf('event.data.type === REPLAY_AD_EXIT_TYPE');
    const adExitEnd = source.indexOf("event.data.type === REPLAY_DISPLAYED_TYPE", adExitStart);
    const adExit = source.slice(adExitStart, adExitEnd);
    assert.match(adExit, /document\.hidden \|\| replayProductionControlState\?\.suspendedReason === 'HIDDEN'/);
    assert.match(adExit, /AD_EXIT_READY/);
    assert.match(adExit, /settleReplayAdExit\(\)/);
    assert.doesNotMatch(adExit, /startReadLoop|startReplayBootstrap|INITIAL_WATCH|pageState\.continuation/);
    assert.doesNotMatch(source, /suspendStack|suspendedReasons|replaySuspendedStack/);
});

test('suspension cleanup retains lifecycle consumed registry and bootstrap eligibility terminality', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const enter = source.match(/function enterReplaySuspended\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(enter, /createConsumedAuthorityRegistry|replayBootstrapEligibilityLifecycleId\s*=/);
    assert.equal((source.match(/replayConsumedAuthorityRegistry = replayControlPlaneCore\?\.createConsumedAuthorityRegistry/g) || []).length, 4);
    assert.equal((source.match(/replayBootstrapEligibilityLifecycleId\s*=\s*pageLifecycleGeneration/g) || []).length, 1);
    assert.match(source, /event\.data\.type === STOP_READ_LOOP_TYPE[^]*observeReplayControlShadow\('DISABLE', \{\}, 'STOPPED'\)[^]*stopReadLoop\('user-disabled'\)/);
    assert.match(source, /addEventListener\('pagehide'[^]*observeReplayControlShadow\('NAVIGATION', \{\}, 'STOPPED'\)[^]*stopReadLoop\('pagehide'\)/);
    assert.match(source, /revisionState\?\.changed[^]*observeReplayControlShadow\('NAVIGATION', \{\}, 'STOPPED'\)[^]*pageLifecycleGeneration \+= 1/);
});

test('same-target Live to Replay transition invalidates the old acquisition before Replay bootstrap commit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const transition = source.match(/function applyLiveToReplayModeTransition\([^]*?\n    \}/)?.[0] || '';
    const respond = source.match(/function respond\([^]*?\n    \}/)?.[0] || '';
    const stop = source.match(/function stopReadLoop\([^]*?\n    \}/)?.[0] || '';
    assert.match(transition, /classifySameTargetChatModeTransition/);
    assert.match(transition, /observeReplayControlShadow\('GENERATION_INVALIDATED', \{\}, 'STOPPED'\)/);
    assert.match(transition, /stopReadLoop\('mode-transition'\)/);
    assert.match(transition, /pageRevision \+= 1;[^]*pageLifecycleGeneration \+= 1/);
    assert.match(transition, /createConsumedAuthorityRegistry/);
    assert.match(transition, /beginGeneration\?\.\(pageLifecycleGeneration\)/);
    assert.match(transition, /postLifecycleInvalidated\(\)/);
    assert.doesNotMatch(transition, /navigationPending\s*=|startReadLoop|startReplayBootstrap|performRead|queueReplayReanchor/);
    assert.match(stop, /currentLoopGeneration \+= 1/);
    assert.match(stop, /activeAbortController\.abort\(\)/);
    assert.match(stop, /replayPending = \[\]/);
    assert.match(stop, /replayPausedSequentialAuthority = null/);
    assert.ok(respond.indexOf('applyLiveToReplayModeTransition(targetIdentity, eventSource)') < respond.indexOf('const shadowLifecycleStart'),
        'old Live generation is invalidated before Replay page state and authority commit');
    assert.match(respond, /const shadowLifecycleStart = pageState\.mode !== 'replay'[^]*acceptReplayBootstrapCandidate\(continuation\)/);
    assert.match(source, /responseBindingCurrent = generation === currentLoopGeneration[^]*revision === pageRevision[^]*lifecycleGeneration === pageLifecycleGeneration/);
});

test('mode transition uses lifecycle invalidation to clear presentation without Native Chat authority', () => {
    const pageState = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const presentation = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');
    const transition = pageState.match(/function applyLiveToReplayModeTransition\([^]*?\n    \}/)?.[0] || '';
    const invalidation = presentation.match(/function handlePageLifecycleInvalidated\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(transition, /iframe|LIVE_CHAT|REPLAY_CHAT|Native/);
    assert.match(invalidation, /currentMessages = \[\]/);
    assert.match(invalidation, /currentChatMode = 'unknown'/);
    assert.match(invalidation, /cleanupOverlay\(\)/);
    assert.doesNotMatch(invalidation, /cleanupManagementBar|removeManagementBar/);
});

test('same-target mode transition accounting fixture closes without unexplained loss', () => {
    const overlay = require('../src/overlay-core.js');
    assert.deepEqual(overlay.computeLivePresentationAccounting({
        input: 3, enqueued: 2, lifecycleSuppressed: 1
    }), { input: 3, accounted: 3, lostUnaccounted: 0, valid: true });
});

test('Replay boundary exposes no raw authority or YouTube continuation type to presentation', () => {
    const pageState = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const presentation = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');
    const postReadResult = pageState.match(/function postReadResult\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(postReadResult, /continuationTypes|opaqueToken|requestContinuation/);
    assert.doesNotMatch(presentation, /continuationTypes|liveChatReplayContinuationData|playerSeekContinuationData|reloadContinuationData|timedContinuationData/);
});

test('Production Replay request call sites claim exactly one authority grant', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.equal((source.match(/result = await performRead\(/g) || []).length, 3);
    assert.match(source, /claimAuthorityRequestGrant\?\.\(currentRequestGrant, requestAuthorityKind\)[^]*performRead\(requestContinuation/);
    assert.match(source, /claimAuthorityRequestGrant\?\.\(reanchorGrant, 'REANCHOR'\)[^]*performRead\(claimed\.opaqueToken/);
    assert.match(source, /LiveFlowReplayForegroundRetainedReanchorDiagnostic[^]*performRead\(retainedToken[^]*playerOffsetMs, false, false\)/);
    assert.doesNotMatch(source, /performRead\(pageState\.continuation[^]*'replay'/);
    assert.doesNotMatch(source, /performRead\([^)]*replayPausedSequentialAuthority/);
});

test('Replay source labels remain diagnostic-only and cannot authorize requests', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const authorize = source.match(/function authorizeReplayAuthority\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(authorize, /INITIAL_WATCH|BUFFER_RESUME|BUFFER_EARLY_RESUME|SEQUENTIAL_RESPONSE|PLAYER_SEEK_HANDOFF|continuationSource/);
    assert.match(source, /replayPipelineDiagnostic\.sequentialContinuationSource = continuationSource/);
});

test('Production temporal rescue is rolled back and one-shot early resume remains', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const flush = source.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.match(flush, /if \(normalResume\?\.eligible === true\)[^]*return;[^]*evaluateReplayBufferEarlyResume/);
    assert.match(flush, /authorizeSavedSequentialResume\(\)/);
    assert.doesNotMatch(source, /BUFFER_TEMPORAL_RESCUE|TEMPORAL_RESCUE_ELIGIBLE|TEMPORAL_RESCUE_COMPLETED|evaluateReplayTemporalRescue/);
    assert.equal(core.ReplayEvent.TEMPORAL_RESCUE_ELIGIBLE, undefined);
});

test('early resume remains one response within a runway depletion episode', () => {
    const reading = core.createReplayState('READING');
    const result = core.reduceReplayControlState(reading, 'EARLY_RESUME_COMPLETED');
    assert.equal(result.nextState.phase, 'BUFFER_PAUSED');
    assert.equal(result.authorityAction, 'SAVE_SEQUENTIAL');
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /continuationSource === 'BUFFER_EARLY_RESUME' && replayPressureEpisodeActive[^]*replayPausedSequentialAuthority = nextSequentialAuthority[^]*nextSequentialAuthority = null[^]*break;/);
    assert.match(source, /runwayPositive = selection\.due\.length > 0 \|\| replayPipelineDiagnostic\.pendingCurrent > 0/);
    assert.match(source, /suppressed: replayRunwayDepletionEpisodeState !== 'DEPLETED_AVAILABLE'/);
    assert.match(source, /transitionReplayRunwayDepletionEpisode[^]*'EARLY_RESUME_STARTED'/);
    assert.match(source, /canUseCapabilityPath\?\.\(\s*'EARLY_RESUME', capabilitySnapshot, currentReplayAuthorityBinding\(\)/);
    assert.match(source, /authorityAvailable: Boolean\(authority\) && earlyResumeCapabilityAllowed/);
});

test('capability evidence remains shadow-only outside scheduler and presentation boundaries', () => {
    const schedulerFiles = ['scheduler-foundations.js', 'scheduler-runtime.js', 'scheduler-state-machine.js', 'pending-selection.js'];
    for (const file of schedulerFiles) {
        const source = fs.readFileSync(path.join(__dirname, `../src/${file}`), 'utf8');
        assert.doesNotMatch(source, /LiveFlowReplayControlPlaneCore|createCapabilitySnapshot|compareCapability/);
    }
    const presentation = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');
    assert.doesNotMatch(presentation, /createCapabilitySnapshot|compareCapability/);
});

test('foreground retained REANCHOR gate is explicit, single-shot, isolated, and never hands off', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const gateStart = source.indexOf('window.LiveFlowReplayForegroundRetainedReanchorDiagnostic');
    const gateEnd = source.indexOf('window.LiveFlowReplayPlayerSeekActiveDiagnostic', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    assert.ok(gateStart >= 0 && gateEnd > gateStart);
    assert.match(gate, /arm\(\)/);
    assert.match(gate, /async run\(\)/);
    assert.match(gate, /requestCount: diagnostic\.requestCount/);
    assert.match(gate, /diagnostic\.opaqueToken = ''[^]*diagnostic\.requestStarted = true[^]*diagnostic\.requestCount = 1/);
    assert.match(gate, /performRead\(retainedToken[^]*'replay', playerOffsetMs, false, false\)/);
    assert.doesNotMatch(gate, /startReadLoop|startReplayBootstrap|authorizeReplayAuthority|queueReplayReanchor|replayPending\s*=|postReadResult/);
    assert.doesNotMatch(gate, /setInterval|setTimeout|retry|fallback/i);
});

test('foreground retained REANCHOR status is redacted and capture is Production-response-only', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const status = source.match(/function replayForegroundRetainedStatus\(\)[^]*?\n    \}/)?.[0] || '';
    assert.match(status, /durationClass[^]*requestCount[^]*result[^]*bindingCurrent[^]*ownershipCurrent[^]*responseValidated[^]*relationAccepted[^]*freshSequentialObserved[^]*additionalRequests/);
    assert.doesNotMatch(status, /opaqueToken|continuation|targetIdentity|playerOffsetMs|URL|hiddenAt|timestamp/i);
    const capture = source.match(/function captureReplayForegroundRetainedCandidate\([^]*?\n    \}/)?.[0] || '';
    assert.match(capture, /diagnostic\.armed[^]*playerOffsetMs !== null[^]*mode !== 'replay'/);
    assert.match(capture, /extractPlayerSeekContinuation\?\.\(payload\)/);
    assert.match(capture, /replayConsumedAuthorityRegistry\?\.has\?\.\(token\)/);
    assert.match(source, /if \(mode === 'replay'\) captureReplayForegroundRetainedCandidate\(payload/);
});

test('foreground retained REANCHOR preconditions are current and capability-gated', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const gateStart = source.indexOf('window.LiveFlowReplayForegroundRetainedReanchorDiagnostic');
    const gateEnd = source.indexOf('window.LiveFlowReplayPlayerSeekActiveDiagnostic', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    assert.match(gate, /diagnostic\.lifecycleGeneration === pageLifecycleGeneration/);
    assert.match(gate, /diagnostic\.revision === pageRevision/);
    assert.match(gate, /diagnostic\.targetIdentity === pageState\.targetIdentity/);
    assert.match(gate, /documentVisible: document\.visibilityState === 'visible'/);
    assert.match(gate, /noAd: !replayAdActive[^]*noSeek: !replaySeekInProgress[^]*noNavigation: !navigationPending[^]*noReadRequest: !readRequestInFlight[^]*noReanchorRequest: !replayReanchorLock/);
    assert.match(gate, /canUseCapabilityPath\?\.\([^]*'HIDDEN_RECOVERY'/);
    assert.match(gate, /replayProductionControlState\?\.phase === 'STOPPED'/);
});

test('foreground retained diagnostic cannot restore Production authority or capture its own response', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /allowProductionAuthorityCapture = true/);
    assert.match(source, /mode === 'replay' && allowProductionAuthorityCapture\) captureReplaySeekAuthority/);
    assert.match(source, /performRead\(retainedToken[^]*playerOffsetMs, false, false\)/);
    assert.match(source, /observeReplayForegroundHidden\(\)[^]*if \(!retainReanchor\)[^]*invalidateAuthorityHandle\(replaySeekAuthority\)/);
});

test('foreground retained diagnostic fails closed on unrelated lifecycle changes', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    assert.match(source, /event\.data\.type === STOP_READ_LOOP_TYPE[^]*terminateReplayForegroundRetainedDiagnostic\('STALE_BINDING', true\)/);
    assert.match(source, /event\.data\.type === REPLAY_AD_ENTER_TYPE[^]*terminateReplayForegroundRetainedDiagnostic\('VISIBLE_PRECONDITION_FAILED', true\)/);
    assert.match(source, /addEventListener\('pagehide'[^]*terminateReplayForegroundRetainedDiagnostic\('STALE_BINDING', true\)/);
    assert.match(source, /addEventListener\('seeking'[^]*terminateReplayForegroundRetainedDiagnostic\('STALE_BINDING', true\)/);
});
