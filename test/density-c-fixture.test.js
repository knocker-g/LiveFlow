const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateC, candidates, run } = require('./fixtures/final-visual-candidates.js');
test('B/C fixed episodes conserve input with actual right-entry trajectories and unchanged SPECIAL/subtitle guards', () => {
    for (const c of [candidates[2], candidateC]) for (const shape of ['HIGH', 'BURST']) {
        const r = run(c.config, shape);
        assert.equal(r.lostUnaccounted, 0);
        assert.equal(r.pending, 0);
        assert.equal(r.drops.EMERGENCY_PENDING_DROPPED, 0);
        assert.ok(r.launchesDetail.every(a => a.initialX === 960 && a.y + a.height <= 256));
        assert.ok(r.launchesDetail.filter(a => a.special).every(a => !a.interleaved));
        assert.ok(r.normalOverlap.sampledPairSeconds <= 1.6);
        if (c.name === 'C') assert.equal(r.normalOverlap.crossRowVerticalPx, 16);
    }
});

test('active surface bounds are held until natural retirement, and snapshots observe actual DOM without mutating trajectories', () => {
    const vm = require('node:vm'), fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    const trajectory = Object.freeze({ velocity: 150, anchorIndex: 1, semanticClass: 'NORMAL' });
    const activeDanmaku = new Map([['a', { trajectory, node: { isConnected: true,
        getBoundingClientRect: () => ({ left: 450, top: 90, width: 300, height: 32 }) } }]]);
    const style = { left: '10px', top: '20px', width: '960px', height: '320px' };
    const context = vm.createContext({ overlayRoot: { isConnected: true }, overlaySurface: { isConnected: true, style }, activeDanmaku });
    vm.runInContext(source.match(/    function applyOverlaySurfaceRect\([^]*?\n    \}/)[0] +
        source.match(/    function snapshotActiveGeometry\([^]*?\n    \}/)[0] + '\nthis.apply = applyOverlaySurfaceRect; this.snapshot = snapshotActiveGeometry;', context);
    assert.equal(context.apply({ left: 15, top: 20, width: 960, height: 320 }), false);
    assert.equal(style.left, '10px');
    const snapshot = context.snapshot({ left: 100, right: 1060 });
    assert.equal(snapshot[0].x, 450); assert.equal(snapshot[0].exitX, 100);
    assert.equal(trajectory.velocity, 150); assert.equal(trajectory.x, undefined);
    activeDanmaku.clear();
    assert.equal(context.apply({ left: 15, top: 20, width: 960, height: 320 }), true);
});
