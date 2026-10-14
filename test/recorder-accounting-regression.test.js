const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../src/chat-read-core');
const { createSchedulerRuntime } = require('../src/scheduler-runtime');
const { createGeometryAuthority, createSubtitleGeometryAdapter } = require('../src/geometry-adapter');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8');
function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`), body = source.indexOf('{', start);
    let depth = 1, end = body + 1;
    for (; depth && end < source.length; end++) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; }
    assert.ok(start >= 0 && !depth); return source.slice(start, end);
}
test('generated recorder respects native Window receiver through start/stop and JSON serialization', async () => {
    const { build } = await import('../tools/build-density-comparison.mjs');
    const packages = build(path.resolve(__dirname, '../build/receiver-test-' + crypto.randomUUID()));
    for (const p of packages) {
        const source = fs.readFileSync(path.join(p.directory, 'src/youtube-chat.js'), 'utf8');
        const host = source.match(/\}, (\{ setInterval[^]*?now: \(\) => performance\.now\(\) \})\);/)[1];
        let callback, clears = 0, at = 0;
        const nativeWindow = { setInterval(fn) { if (this !== nativeWindow) throw new TypeError('Illegal invocation'); callback = fn; return 1; },
            clearInterval() { if (this !== nativeWindow) throw new TypeError('Illegal invocation'); clears++; } };
        const context = vm.createContext({ window: nativeWindow, setInterval: nativeWindow.setInterval, clearInterval: nativeWindow.clearInterval,
            performance: { now: () => at }, read: () => ({ at, surface: { left: 0, top: 0, right: 960, bottom: 320 }, boxes: [] }) });
        vm.runInContext(functionSource(source, 'createComparisonRecorder') + `\nrecorder = createComparisonRecorder({candidate:'${p.candidate}'}, read, ${host});`, context);
        assert.doesNotThrow(() => context.recorder.start());
        at = 100; callback(); at = 20000; callback();
        const json = JSON.stringify(context.recorder.result());
        assert.equal(JSON.parse(json).frames.length, 3); assert.equal(JSON.parse(json).finished, true);
        assert.equal(JSON.parse(json).identity.candidate, p.candidate); assert.equal(clears, 1);
    }
});
test('actual structural SPECIAL removal reaches scheduler ledger exactly once, including no selection', () => {
    const messages = [], context = vm.createContext({ core, currentChatMode: 'replay', currentPageLifecycleGeneration: 1,
        replayDiagnosticEpoch: 0, replayDiagnosticLifecycle: 1, replayDiagnosticSequence: 0,
        replayDiagnosticBatch: {}, replayDiagnosticDisplayed: 0, replayDiagnosticIncomplete: false, replayDiagnosticBatchInProgress: false,
        REPLAY_PIPELINE_DIAGNOSTIC_TYPE: 'pipeline', window: { location: { origin: 'https://www.youtube.com' }, postMessage: m => messages.push(m) }, updateReplayLaunchGap() {} });
    vm.runInContext(['createReplaySchedulerDiagnostic', 'publishReplayScopeSnapshot', 'publishReplaySchedulerDiagnostic', 'observeReplayScheduler'].map(n => functionSource(content, n)).join('\n') +
        '\nreplaySchedulerDiagnostic = createReplaySchedulerDiagnostic();\n' + functionSource(main, 'createReplayPipelineDiagnostic') + '\nreplayPipelineDiagnostic = createReplayPipelineDiagnostic();', context);
    let timer, now = 0;
    const adapter = createSubtitleGeometryAdapter({ authority: createGeometryAuthority({ epsilon: 1 }), readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) });
    const events = [], runtime = createSchedulerRuntime({ clock: () => now, generation: () => 1, geometryAdapter: adapter,
        scheduleOneShot: fn => { timer = fn; return fn; }, cancelOneShot() {},
        candidateProof: () => ({ unrepresentableSpecial: true }), launch: () => { throw Error('unrepresentable cannot launch'); },
        observe: e => { events.push(e); context.observeReplayScheduler(e); },
        config: { maxPendingAge: 1000, maxPendingCount: 10, pendingPressureCapacity: 5, scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
            pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
            density: { attackThresholds: [.5,.7,.9], releaseThresholds: [.2,.3,.4], minimumAttackResidence: 1, releaseDwell: 3 },
            collisionAllowances: { CONSERVATIVE: {} } } });
    context.phase3Runtime = runtime;
    vm.runInContext(functionSource(main, 'applyReplayDiagnosticSnapshot'), context);
    const ledgerCall = main.match(/core\?\.computeReplayAccountingLedger\?\.\(\{[^]*?\}\)/)[0];
    const ledger = () => {
        context.diagnostic = context.replayPipelineDiagnostic;
        context.applyReplayDiagnosticSnapshot(context.diagnostic, messages.at(-1) || { scheduler: context.replaySchedulerDiagnostic });
        return vm.runInContext(`schedulerRetained = diagnostic.pendingCurrent; ${ledgerCall}`, context);
    };
    assert.equal(ledger().lostUnaccounted, 0);
    for (let n = 1; n <= 6; n++) {
        Object.assign(context.replayPipelineDiagnostic, { receivedActions:n, messagesObserved:n, bridged:n, enqueued:n });
        runtime.enqueue({id:'special-' + n}, { id:'special-' + n, enqueuedAt:now, rendererType:'liveChatPaidMessageRenderer', footprint:{} });
        timer(); now++;
        assert.equal(runtime.status().pendingCount, 0, JSON.stringify(events));
        const result = ledger();
        assert.equal(result.lostUnaccounted, 0, JSON.stringify({ events, diagnostic: context.replaySchedulerDiagnostic, pipeline: context.replayPipelineDiagnostic, scheduler: result.stages.scheduler }));
        assert.equal(result.overflowUnaccounted, 0); assert.equal(result.stages.scheduler.explicitRemoval,n); assert.equal(result.stages.scheduler.valid,true);
    }
    runtime.clear(); assert.equal(ledger().stages.scheduler.explicitRemoval,6);
    assert.equal(events.filter(e=>e.type === 'STRUCTURAL_DROPPED').reduce((s,e)=>s+e.count,0),6);
});
