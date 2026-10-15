const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8');
function setup() {
    const prefix = fs.readFileSync(require.resolve('./scheduler-publication-consistency.test'), 'utf8')
        .split("test('actual quiet enqueue")[0];
    const outer = vm.createContext({ require: createRequire(path.resolve('test/scheduler-publication-consistency.test.js')) });
    vm.runInContext(prefix + '\nmakeHarness=harness;', outer);
    const h = outer.makeHarness(); h.enqueue(1);
    return h;
}
test('actual enqueue retains immutable Product owner independently of presentation and request generations', () => {
    const h = setup(), c = h.c, video = {};
    const start = content.indexOf('        let enqueuedCount = 0;');
    const end = content.indexOf('        observeLivePresentationBatch(', start);
    for (const generation of [7, 8]) {
        Object.assign(c, { incomingReadGeneration: generation, runtime: c.phase3Runtime,
            pendingOwner: Object.freeze({ document: 'FIXTURE_DOCUMENT', stream: 1, target: 'FIXTURE', lifecycle: 0, revision: 0 }),
            visibleMessages: [{ id: 'item-' + generation, messageType: 'text' }], scheduledGeneration: 1,
            scheduledVideo: video, launchSettingsSnapshot: {}, performance: { now: () => 0 },
            phase5Tuning: { lineHeight: 20 }, inputCount: 1 });
        vm.runInContext('{' + content.slice(start, end) + '}', c); h.flush();
    }
    const entries = c.phase3Runtime.queue.snapshot().slice(-2);
    for (const entry of entries) {
        assert.equal(entry.payload.generation, 1);
        assert.equal(entry.payload.pageLifecycleGeneration, 0);
        assert.equal(entry.payload.video, video);
        assert.equal(entry.payload.readGeneration, undefined);
        assert.equal(entry.payload.ownerId, undefined);
        assert.equal(entry.payload.targetIdentity, undefined);
        assert.equal(entry.pendingOwner.stream, 1);
        assert.equal(entry.pendingOwner.document, 'FIXTURE_DOCUMENT');
        assert.ok(Object.isFrozen(entry.pendingOwner));
    }
    assert.match(content, /scheduleDanmakuBatch\(newMessages, pendingOwner\)/);
});
test('existing clear counts actual pending once and leaves active trajectory untouched', () => {
    const h = setup(), c = h.c, active = { animation: { cancel() { throw Error('must not cancel'); } }, node: {} };
    c.activeDanmaku.set('active', active);
    assert.equal(c.phase3Runtime.clear(), undefined); h.flush();
    assert.equal(c.replayPipelineDiagnostic.schedulerLifecycleDiscarded, 1);
    assert.equal(c.activeDanmaku.get('active'), active);
    c.phase3Runtime.clear(); h.flush();
    assert.equal(c.replayPipelineDiagnostic.schedulerLifecycleDiscarded, 1);
    assert.equal(c.activeDanmaku.get('active'), active);
});
