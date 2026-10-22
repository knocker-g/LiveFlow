const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
async function setup() {
    const { instrumentArchivedAttribution } = await import('../tools/density-comparison/instrument-archived-attribution.mjs');
    const generated = instrumentArchivedAttribution(main);
    // Reuse only the dedicated combined fixture setup; do not load/run its 11 tests.
    const prefix = fs.readFileSync(require.resolve('./seek-epoch-combined-listener.test'), 'utf8')
        .split('for (const order of ')[0]
        .replace("fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8')", JSON.stringify(generated))
        .replace('    c.postReplayDiagnosticScope(); flush();',
            "    c.archivedAttribution = new WeakMap(); vm.runInContext(source(main, 'archivedAttributionSnapshot'), c);\n    c.postReplayDiagnosticScope(); flush();");
    const outer = vm.createContext({ require: createRequire(path.resolve('test/seek-epoch-combined-listener.test.js')) });
    vm.runInContext(prefix + '\nmakeCombined=combined;', outer);
    const h = outer.makeCombined();
    // Actual status entry from existing read-only public surface; printSummary is irrelevant here.
    const match = main.match(/window.LiveFlowReplayAccountingDiagnostic = Object.freeze\(\{\s+status: ([a-zA-Z]+),/);
    assert.equal(match[1], 'replayAccountingStatus');
    vm.runInContext('window.LiveFlowReplayAccountingDiagnostic=Object.freeze({status:replayAccountingStatus});', h.c);
    h.status = () => h.c.window.LiveFlowReplayAccountingDiagnostic.status();
    h.details = () => h.status().diagnosticScope.scopes[0].archivedAttribution;
    return h;
}
for (const order of [['MAIN', 'CONTENT'], ['CONTENT', 'MAIN']]) {
    test('dev-only archived counters through real handoff/getter: ' + order.join('→'), async () => {
        const h = await setup(); h.old.temporalRemovalReasons.PRIVATE_ID = 'PRIVATE_TOKEN'; h.seek(order);
        const messages = h.messages.splice(0);
        messages.filter(m => m.source === 'liveflow-page-state').forEach(h.deliver); h.flush();
        assert.equal(h.status().accountingComplete, false);
        assert.equal(h.details().sequenceCompleteness, 'INCOMPLETE');
        messages.filter(m => m.source !== 'liveflow-page-state').reverse().forEach(h.deliver); h.flush();
        const d = h.details();
        assert.equal(d.state, 'CLOSED'); assert.equal(d.sequenceCompleteness, 'COMPLETE');
        assert.equal(d.closure, 'TERMINAL_VALIDATED'); assert.equal(d.lifecycle, 0); assert.equal(d.epoch, 0);
        assert.equal(d.temporal.input, 5); assert.equal(d.seekRemoval, 3);
        assert.equal(d.temporal.explicitRemoval, 3); assert.equal(d.due, 2); assert.equal(d.future, 0);
        assert.equal(d.pending, 0); assert.equal(d.unclassified, 0); assert.equal(d.pendingUnclassified, 0);
        assert.equal(d.scheduler.input, 2); assert.equal(d.scheduler.explicitRemoval, 2);
        assert.equal(d.scheduler.retained, 0); assert.equal(d.schedulerReasons.lifecycle, 2);
        assert.equal(d.lostUnaccounted, 0); assert.equal(d.overflowUnaccounted, 0);
        assert.equal(d.accountingComplete, true); assert.equal(d.accountingValid, true);
        assert.ok(Object.isFrozen(d)); assert.ok(Object.isFrozen(d.temporal)); assert.ok(Object.isFrozen(d.terminalReasons));
        const saved = JSON.stringify(d); h.enqueue(1); h.accept([{ replayOffsetMsec: 12000 }], true);
        assert.equal(JSON.stringify(h.details()), saved); assert.equal(h.status().temporalDiscarded, 0);
        messages.filter(m => m.source !== 'liveflow-page-state').forEach(h.deliver);
        assert.equal(JSON.stringify(h.details()), saved);
        assert.doesNotMatch(saved, /PRIVATE|future-1|unclassified"\s*:\s*"|replayOffsetMsec|opaqueToken|https?:|message"|targetIdentity/);
    });
}
for (const failure of ['missing terminal', 'missing sequence', 'loss', 'post-terminal']) {
    test('archive remains INCOMPLETE: ' + failure, async () => {
        const h = await setup(); if (failure === 'loss') h.old.messagesObserved++;
        h.seek(['MAIN', 'CONTENT']);
        const terminal = h.messages.find(m => m.diagnosticTerminal);
        if (failure === 'missing terminal') h.messages.splice(h.messages.indexOf(terminal), 1);
        if (failure === 'missing sequence') h.messages.splice(h.messages.findIndex(m => m.diagnosticScopeEpoch === 0 && !m.diagnosticTerminal), 1);
        h.flush();
        const closed = JSON.stringify(h.details());
        const discarded = h.status().diagnosticScope.discardedIncomplete;
        if (failure === 'post-terminal') h.deliver({ ...terminal, diagnosticSequence: terminal.diagnosticSequence + 1 });
        assert.equal(h.status().accountingComplete, false);
        if (failure === 'post-terminal') {
            // A validated CLOSED archive is immutable; a late transport fault is
            // recorded outside it and must still invalidate aggregate completeness.
            assert.equal(h.details().state, 'CLOSED'); assert.equal(h.details().sequenceCompleteness, 'COMPLETE');
            assert.equal(JSON.stringify(h.details()), closed);
            assert.equal(h.status().diagnosticScope.discardedIncomplete, discarded + 1);
        } else {
            assert.equal(h.details().state, 'INCOMPLETE'); assert.equal(h.details().sequenceCompleteness, 'INCOMPLETE');
        }
        if (failure === 'loss') { assert.equal(h.details().lostUnaccounted, 1); assert.equal(h.details().closure, 'TERMINAL_INVALID'); }
    });
}
test('existing archive bound and unresolved eviction remain visible', async () => {
    const h = await setup(); h.seek(['MAIN', 'CONTENT']); h.flush();
    const saved = h.details();
    for (let i = 0; i < 11; i++) h.c.openReplayDiagnosticScope();
    const s = h.status();
    assert.equal(s.diagnosticScope.scopes.length, 9);
    assert.ok(s.diagnosticScope.discardedIncomplete > 0); assert.equal(s.accountingComplete, false);
    assert.equal(saved.state, 'CLOSED'); assert.ok(Object.isFrozen(saved));
    assert.ok(s.diagnosticScope.scopes.every(scope => scope.archivedAttribution.state === 'INCOMPLETE' || scope.state === 'OPEN'));
});
test('collector fault is isolated and makes diagnostic status incomplete', async () => {
    const h = await setup();
    h.c.archivedAttribution = { has() { throw Error('collector unavailable'); } };
    assert.doesNotThrow(() => { h.seek(['MAIN', 'CONTENT']); h.flush(); });
    assert.equal(h.c.replayPending.length, 0); assert.equal(h.c.phase3Runtime, null);
    assert.equal(h.status().accountingComplete, false);
    assert.equal(h.details().collectorFault, true); assert.equal(h.details().state, 'INCOMPLETE');
});
test('generated code only, anchor guards and no new effects', async () => {
    const { instrumentArchivedAttribution } = await import('../tools/density-comparison/instrument-archived-attribution.mjs');
    const { instrumentInitialAuthorityTrace } = await import('../tools/density-comparison/instrument-initial-authority.mjs');
    const { instrumentInitialRequestMain } = await import('../tools/density-comparison/instrument-initial-request.mjs');
    const generated = instrumentArchivedAttribution(main); new vm.Script(generated);
    const copies = instrumentInitialAuthorityTrace(main, fs.readFileSync(require.resolve('../src/replay-control-plane-core'), 'utf8'),
        { sourceSHA: 'a'.repeat(40), commonBuildID: 'b'.repeat(64) });
    new vm.Script(instrumentArchivedAttribution(instrumentInitialRequestMain(copies.main)));
    assert.doesNotMatch(main, /ARCHIVED_ATTRIBUTION_V1/);
    assert.throws(() => instrumentArchivedAttribution(''), /anchor/);
    const setup = generated.slice(generated.indexOf('    const archivedAttribution'), generated.indexOf('    const diagnosticScopes'));
    assert.doesNotMatch(setup, /postMessage|fetch\(|setTimeout|setInterval|addEventListener|await /);
    const build = fs.readFileSync(require.resolve('../tools/build-density-comparison.mjs'), 'utf8');
    assert.match(build, /if \(diagnosticCopies\) \{[\s\S]*?instrumentArchivedAttribution\(diagnosticCopies.main\)/);
    assert.match(build, /instrument-archived-attribution.mjs/);
});
