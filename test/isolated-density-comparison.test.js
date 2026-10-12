const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const fixture = require('./fixtures/final-visual-candidates');
const tuning = require('../src/phase5-tuning');
const foundations = require('../src/scheduler-foundations');
const overlap = require('../src/normal-overlap-policy');
const geometry = require('../src/geometry-adapter');
const core = require('../src/overlay-core');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
let packages, generator;
test.before(async () => {
    generator = await import('../tools/build-density-comparison.mjs');
    packages = generator.build(path.join(root, 'build', 'density-test-' + crypto.randomUUID()));
});
const source = p => fs.readFileSync(path.join(p.directory, 'src/youtube-chat.js'), 'utf8');
const configOf = s => JSON.parse(JSON.parse(s.match(/const phase5Tuning = JSON.parse\((.*)\);/)[1]));
const extract = (s, name, next) => s.slice(s.indexOf('    function ' + name), s.indexOf('    function ' + next));
test('packages isolate identities/storage, include dirty runtime inputs and only change generated presentation', () => {
    assert.notEqual(packages[0].extensionID, packages[1].extensionID);
    assert.equal(packages[0].commonBuildID, packages[1].commonBuildID);
    const original = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    assert.ok(!JSON.stringify(original).includes('comparison'));
    for (const p of packages) {
        const manifest = JSON.parse(fs.readFileSync(path.join(p.directory, 'manifest.json')));
        assert.deepEqual(manifest.permissions, original.permissions);
        assert.deepEqual(manifest.content_scripts, original.content_scripts);
        const payload = {};
        for (const [name, digest] of Object.entries(p.files)) {
            const bytes = fs.readFileSync(path.join(p.directory, name)); payload[name] = bytes;
            assert.equal(sha(bytes), digest);
            if (!['manifest.json', 'src/youtube-chat.js'].includes(name)) assert.equal(sha(bytes), sha(fs.readFileSync(path.join(root, name))));
        }
        assert.equal(generator.packageDigest(payload), p.packageDigest);
        assert.equal(generator.verify(p.directory).extensionID, p.extensionID);
        assert.ok(source(p).includes(p.packageDigest));
        assert.equal(p.inputs['src/replay-schema-probe.js'], sha(fs.readFileSync(path.join(root, 'src/replay-schema-probe.js'))));
        assert.ok(!Object.keys(payload).some(x => x.startsWith('tools/') || x.startsWith('test/')));
    }
    assert.throws(() => generator.build(root), /ignored workspace/);
    assert.throws(() => generator.replaceOnce('x x', 'x', 'y'), /Unrecognized/);
});
test('effective B/D settings and browser selector exactly match approved fixture, no C execution', () => {
    assert.deepEqual(configOf(source(packages[0])), fixture.candidates[2].config);
    assert.deepEqual(configOf(source(packages[1])), fixture.candidateC.config);
    const p = packages[1], s = source(p);
    const selectorText = s.slice(s.indexOf('const comparisonSelect ='), s.indexOf('})();', s.indexOf('const comparisonSelect =')) + 5);
    const browser = { LiveFlowSchedulerFoundations: foundations, LiveFlowNormalOverlapPolicy: overlap, LiveFlowOverlayCore: core };
    const selector = vm.runInNewContext(selectorText + '; comparisonSelect', { window: browser });
    const lanes = [1, 1.5, 2].map(n => ({ lane: n, interleaved: n % 1 !== 0, rectangle: { x: 1000, y: n * 32, width: 300, height: 32, velocity: 175, exitX: 0, surfaceRight: 1000, semanticClass: 'NORMAL', snapshotAt: 10, occlusionHistoryKnown: true } }));
    const state = { candidates: lanes, active: [{ ...lanes[2].rectangle, x: 580, velocity: 150 }], density: 'MAX_READABLE', config: fixture.candidateC.config };
    const expected = require('./fixtures/opportunity-aware-density').select(state);
    assert.deepEqual(JSON.parse(JSON.stringify(selector(state))), expected);
    assert.equal(selector(state).candidates[0], lanes[1]);
    const before = JSON.stringify(state); selector(state); assert.equal(JSON.stringify(state), before);
});
test('generated actual candidateProof reaches actual Renderer with mandatory commit proof; changed geometry rejects', () => {
    for (const p of packages) {
        const s = source(p), config = configOf(s), bounds = { x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 320, width: 960, height: 320 };
        const media = { player: { getBoundingClientRect: () => bounds }, video: { getBoundingClientRect: () => bounds, playbackRate: 1 } };
        const active = new Map(), nodes = [], records = [], selections = [];
        let revision = 1;
        const node = () => { const n = { isConnected: true, style: {}, remove() { this.isConnected = false; }, getBoundingClientRect: () => ({ left: 960, top: 0, width: 300, height: 32 }), animate() { return { finished: new Promise(() => {}), cancel() {} }; } }; nodes.push(n); return n; };
        const browser = { LiveFlowPhase5Tuning: tuning, LiveFlowSchedulerFoundations: foundations, LiveFlowNormalOverlapPolicy: overlap, LiveFlowOverlayCore: core, postMessage() {} };
        const selectorText = s.slice(s.indexOf('const comparisonSelect ='), s.indexOf('})();', s.indexOf('const comparisonSelect =')) + 5);
        const context = { window: browser, comparisonIdentity: { candidate: p.candidate, selectionPolicy: p.selectionPolicy },
            comparisonRecorder: { selection: x => selections.push(x), launch: x => records.push(x), exit() {} }, comparisonNodes: new WeakMap(), comparisonNextID: 0, phase5Tuning: config,
            overlayCore: { ...core, isMainContentPlaybackEligible: () => true }, geometryCore: geometry,
            getCurrentMainMedia: () => media, isEffectiveDisplayActive: () => true, attachOverlay: () => true,
            applyOverlaySurfaceRect: () => true, isCaptionTrackEnabled: () => false, createDanmakuNode: node,
            applySpecialFit: () => ({ result: 'FIT' }), runtimeSettings: {}, rendererGeneration: 1,
            currentChatMode: 'live', overlayRoot: {}, overlaySurface: { getBoundingClientRect: () => bounds, appendChild() {} },
            activeDanmaku: active, laneStates: [], performance: { now: () => 10000 },
            subtitleGeometryAdapter: { refresh: () => ({ revision, geometry: { state: 'KNOWN_PRESENT' } }) } };
        vm.createContext(context);
        vm.runInContext(selectorText + '\n' + extract(s, 'snapshotActiveGeometry', 'readSubtitleGeometry') + '\n' + extract(s, 'getCandidateProof', 'ensurePhase3Runtime') + '\n' + extract(s, 'renderDanmaku', 'scheduleDanmakuBatch'), context);
        if (p.candidate === 'D') {
            active.set('leader', { node: { isConnected: true, getBoundingClientRect: () => ({ left: 760, top: 64, width: 300, height: 32 }) },
                trajectory: Object.freeze({ velocity: 400, anchorIndex: 4, semanticClass: 'NORMAL' }), occlusionHistoryKnown: true, occlusionEpisodes: [] });
        }
        const entry = { id: 'test', payload: { message: { message: 'hello', authorRole: 'guest', messageType: 'text' } }, footprint: {} };
        const proof = context.getCandidateProof(entry, { exclusionRegions: [] }, foundations.getDensityVisualPolicy('MAX_READABLE'));
        assert.ok(proof.candidates.length); assert.equal(selections[0].policy, p.selectionPolicy);
        if (p.candidate === 'D') assert.equal(selections[0].diagnostic.promoted, true);
        const launch = { ...proof.candidates[0], density: 'MAX_READABLE', geometryRevision: 1 };
        assert.equal(context.renderDanmaku(entry.payload.message, 1, media.video, launch, {}).status, 'rendered');
        assert.equal(records.length, 1); assert.equal(active.size, p.candidate === 'D' ? 2 : 1);
        if (p.candidate === 'D') assert.equal(records[0].interleaved, true);
        assert.ok(Object.isFrozen([...active.values()][0].trajectory));
        revision = 2;
        assert.equal(context.renderDanmaku(entry.payload.message, 1, media.video, launch, {}).status, 'drop');
        assert.equal(records.length, 1);
        // Check Scheduler and Renderer final guards were not removed by generator.
        assert.ok(s.includes('refreshedGeometry?.revision !== launchProof.geometryRevision'));
        assert.ok(s.includes('recordEpisodes(commitRectangle, activeGeometry'));
    }
});
test('passive recorder bounded, redacted event data and honest missing ledger; no state mutation', () => {
    const text = fs.readFileSync(path.join(root, 'tools/density-comparison/recorder.js'), 'utf8');
    let at = 0, callback, cleared = 0;
    const frame = { at, surface: { left: 0, top: 0, right: 960, bottom: 320 }, boxes: [
        { x: 10, y: 0, width: 300, height: 32, semanticClass: 'NORMAL', observationID: 1 },
        { x: 100, y: 16, width: 300, height: 32, semanticClass: 'NORMAL', observationID: 2 }] };
    const factory = vm.runInNewContext(text + '; createComparisonRecorder');
    const recorder = factory({ candidate: 'D' }, () => ({ ...frame, at }), { now: () => at, setInterval: f => { callback = f; return 0; }, clearInterval: () => { cleared++; } });
    const before = JSON.stringify(frame);
    recorder.start(); recorder.event({ type: 'CAPACITY_DROPPED', count: 2, secret: 'excluded' });
    recorder.launch({ at: 0 });
    at = 100; callback(); at = 20000; callback();
    const result = recorder.result();
    assert.equal(result.summary.capacityDrop, 2); assert.equal(result.summary.launch, 1);
    assert.equal(result.summary.maxVerticalPx, 16); assert.equal(result.summary.sampledPairDurations['1/2'].sampledSpanMs, 100);
    assert.equal(result.summary.lostUnaccounted, null); assert.match(result.limitations.lostUnaccounted, /NOT_RUN/);
    assert.equal(JSON.stringify(frame), before); assert.ok(!JSON.stringify(result).includes('excluded'));
    assert.ok(cleared); assert.equal(result.finished, true);
    assert.ok(!/postMessage|fetch\(|chrome\.|storage|enqueue/.test(text));
});
