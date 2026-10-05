const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/chat-read-core.js');

function future(offsetMsec) {
    return { replayOffsetMsec: offsetMsec };
}

test('Replay read-ahead defers contiguous future pages while player time is static', () => {
    const first = core.classifyReplayReadAheadHorizon([future(1000), future(27000)], 0);
    const second = core.classifyReplayReadAheadHorizon([future(28500), future(48800)], 0);
    assert.equal(first, 'HIGH_WATER');
    assert.equal(second, 'HIGH_WATER');
    assert.deepEqual(core.evaluateReplayReadAheadCadence({
        deferred: false, horizon: first,
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        capabilityAllowed: true, requestInFlight: false, activeLoop: false,
        lifecycleCurrent: true, targetCurrent: true, videoCurrent: true, visible: true,
        adActive: false, seekActive: false, navigationPending: false
    }), { action: 'DEFER', reason: 'HIGH_WATER' });
});

test('Replay read-ahead retains authority at high water and resumes one normal read after player progress', () => {
    const valid = {
        deferred: true, horizon: 'HIGH_WATER',
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        capabilityAllowed: true, requestInFlight: false, activeLoop: false,
        lifecycleCurrent: true, targetCurrent: true, videoCurrent: true, visible: true,
        adActive: false, seekActive: false, navigationPending: false
    };
    assert.deepEqual(core.evaluateReplayReadAheadCadence(valid), { action: 'WAIT', reason: 'HIGH_WATER' });
    assert.equal(core.classifyReplayReadAheadHorizon([future(1000), future(27000)], 18), 'RESUME_WATER');
    assert.deepEqual(core.evaluateReplayReadAheadCadence({ ...valid, horizon: 'RESUME_WATER' }), {
        action: 'RESUME', reason: 'HORIZON_RECOVERED'
    });
});

test('Replay read-ahead resume is fail-closed for authority, currentness, capability, and serialization', () => {
    const valid = {
        deferred: true, horizon: 'RESUME_WATER',
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        capabilityAllowed: true, requestInFlight: false, activeLoop: false,
        lifecycleCurrent: true, targetCurrent: true, videoCurrent: true, visible: true,
        adActive: false, seekActive: false, navigationPending: false
    };
    for (const change of [
        { authorityAvailable: false }, { authorityCurrent: false }, { authorityUnused: false },
        { capabilityAllowed: false }, { requestInFlight: true }, { activeLoop: true },
        { lifecycleCurrent: false }, { targetCurrent: false }, { videoCurrent: false },
        { visible: false }, { adActive: true }, { seekActive: true }, { navigationPending: true }
    ]) assert.equal(core.evaluateReplayReadAheadCadence({ ...valid, ...change }).action, 'HOLD');
});

test('Replay read-ahead relation reuses existing current/near semantics without early display', () => {
    assert.equal(core.classifyReplayReadAheadHorizon([], 0), 'RESUME_WATER');
    assert.equal(core.classifyReplayReadAheadHorizon([future(9000)], 0), 'RESUME_WATER');
    assert.equal(core.classifyReplayReadAheadHorizon([future(10001)], 0), 'HIGH_WATER');
    assert.equal(core.classifyReplayMessageRelation(9000, 0), 'NEAR_FUTURE');
    assert.equal(core.classifyReplayMessageRelation(10001, 0), 'FAR_FUTURE');
});

test('Production read-ahead defer preserves the single unused authority and resumes through authorization', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
    const loop = source.match(/async function startReadLoop\([^]*?\n    \}/)?.[0] || '';
    const flush = source.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    const capacity = loop.indexOf('replayPending.length >= REPLAY_MAX_PENDING');
    const defer = loop.indexOf("readAheadDecision?.action === 'DEFER'");
    assert.ok(capacity >= 0 && defer > capacity, 'count-pressure behavior keeps precedence');
    assert.match(loop, /replayReadAheadDeferred = true[^]*nextSequentialAuthority = null/);
    const deferBlock = loop.slice(defer, loop.indexOf('break;', defer) + 6);
    assert.doesNotMatch(deferBlock, /authorizeSequentialAuthority|invalidateAuthorityHandle|transitionAuthority/);
    assert.match(flush, /if \(replayReadAheadDeferred\)[^]*authorizeSequentialAuthority\([^]*deferredAuthority[^]*, 0[^]*\)/);
    assert.match(flush, /replayObservedSequentialAuthority = null;[^]*replayReadAheadDeferred = false;[^]*replaySequentialResumeHandoff = true;[^]*startReadLoop\(pageLifecycleGeneration, 'READ_AHEAD_RESUME', requestGrant\)/);
    assert.match(loop, /const preserveSequentialPending = requestAuthorityKind === 'SEQUENTIAL' &&[^]*replaySequentialResumeHandoff[^]*if \(!preserveSequentialPending\) \{[^]*replayPending = \[\]/);
    assert.doesNotMatch(`${loop}\n${flush}`, /setInterval|requestAnimationFrame/);
});
