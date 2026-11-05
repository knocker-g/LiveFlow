'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRecorder, CODES } = require('../src/dev-startup-diagnostic');
const current = require('../src/acquisition-owner').createLiveAcquisitionOwner;
const { load } = require('./fixtures/acquisition-harness');
const { integration } = load('dev-startup-diagnostic.test.js', ['integration']);

const oldFile = path.resolve('src/acquisition-owner.js');
const old = new Module(oldFile, module); old.filename = oldFile; old.paths = Module._nodeModulePaths(path.dirname(oldFile));
old._compile(fs.readFileSync('.playwright-mcp/g14-e-20261105-acquisition-owner.js.before', 'utf8'), oldFile);

function setup(factory, diagnosticMode = 'on') {
    const file = path.resolve('test/acquisition-owner.test.js'), m = new Module(file, module);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const requireOriginal = m.require.bind(m);
    m.require = id => id === '../src/acquisition-owner.js' ? { createLiveAcquisitionOwner: factory } : requireOriginal(id);
    const source = fs.readFileSync(file, 'utf8').split('\ntest(')[0].replace('const owner = createLiveAcquisitionOwner(config);',
        'options.configure(config); const owner = createLiveAcquisitionOwner(config);');
    m._compile(source + '\nmodule.exports={harness};', file);
    const trace = [], output = [], primary = {};
    let failFacts = false;
    const d = createRecorder({ log(value) { if (diagnosticMode === 'sink-fault') throw primary; output.push(value); } });
    if (diagnosticMode === 'overflow') for (const code of CODES.slice(0, 16)) d.record(code);
    const diagnostic = diagnosticMode === 'detail-fault' ? Object.freeze({ ...d, record(code) {
        if (code.startsWith('O_PREPERMIT_V1_')) throw primary;
        d.record(code);
    } }) : d;
    const h = m.exports.harness({ configure(c) {
        if (diagnosticMode !== 'off') c.diagnostic = diagnostic;
        const facts = c.readFacts;
        c.readFacts = () => { trace.push('facts'); if (failFacts) throw primary;
            return new Proxy(facts(), { get(t, k) { trace.push('get:' + String(k)); return t[k]; } }); };
        const now = c.clock.now; c.clock.now = () => { trace.push('clock'); return now(); };
        const set = c.timers.setTimeout, clear = c.timers.clearTimeout;
        c.timers.setTimeout = (...a) => { trace.push('timer:set'); return set(...a); };
        c.timers.clearTimeout = (...a) => { trace.push('timer:clear'); return clear(...a); };
    } });
    trace.length = 0;
    return { h, d, trace, output, primary, failFacts() { failFacts = true; } };
}
const detail = category => 'LF_DEV_STARTUP_V1:O_PREPERMIT_V1_' + category;

for (const defect of ['read-throw', 'target', 'owned', 'capability', 'clockCurrent']) test('facts terminal classification and equivalence ' + defect, () => {
    function run(factory, mode) {
        const r = setup(factory, mode);
        if (defect === 'read-throw') r.failFacts();
        else r.h.facts[defect === 'target' ? 'targetId' : defect] = defect === 'target' ? 'changed' : false;
        assert.equal(r.h.owner.openBootstrap(r.h.channel), null);
        const product = { status: r.h.owner.status(), trace: [...r.trace], requests: r.h.requests.length, jobs: r.h.clock.jobs.size };
        assert.equal(product.status.phase, 'TERMINAL'); assert.equal(product.status.permit, 'INVALID');
        assert.deepEqual(r.output, []); r.d.flush();
        if (factory === current && mode === 'on') assert.deepEqual(r.output.slice(-2), ['LF_DEV_STARTUP_V1:O_PREPERMIT_WAIT', detail('FACTS_TERMINAL')]);
        return product;
    }
    const baseline = run(old.exports.createLiveAcquisitionOwner, 'off');
    assert.deepEqual(run(current, 'off'), baseline); assert.deepEqual(run(current, 'on'), baseline);
});

for (const [flag, value] of [['visible', false], ['ready', false], ['adActive', true], ['seeking', true]]) test('media eligibility classification and original short circuit ' + flag, () => {
    function run(factory, mode) {
        const r = setup(factory, mode); r.h.facts[flag] = value;
        assert.equal(r.h.owner.openBootstrap(r.h.channel), null);
        const product = { status: r.h.owner.status(), trace: [...r.trace], requests: r.h.requests.length, jobs: r.h.clock.jobs.size };
        assert.equal(product.status.phase, 'CREATED'); assert.equal(product.status.permit, 'UNUSED');
        assert.equal(product.trace.filter(s => s === 'facts').length, 1);
        assert.equal(product.trace.includes('clock'), false);
        r.d.flush();
        if (factory === current && mode === 'on') assert.deepEqual(r.output, ['LF_DEV_STARTUP_V1:O_PREPERMIT_WAIT', detail('MEDIA_INELIGIBLE')]);
        return product;
    }
    const baseline = run(old.exports.createLiveAcquisitionOwner, 'off');
    assert.deepEqual(run(current, 'off'), baseline); assert.deepEqual(run(current, 'on'), baseline);
});

test('eligible positive original reservation, permit, t0 deadline and output block unchanged', () => {
    function run(factory, mode) {
        const r = setup(factory, mode), port = r.h.owner.openBootstrap(r.h.channel);
        assert.ok(port); assert.equal(port.consumePermit({ operationId: port.operationId, route: r.h.config.route }), true);
        assert.equal(port.consumePermit({ operationId: port.operationId, route: r.h.config.route }), null);
        r.d.flush(); assert.deepEqual(r.output, []);
        return { status: r.h.owner.status(), trace: r.trace, jobs: [...r.h.clock.jobs.values()].map(x => x.due) };
    }
    const baseline = run(old.exports.createLiveAcquisitionOwner, 'off');
    assert.deepEqual(run(current, 'off'), baseline); assert.deepEqual(run(current, 'on'), baseline);
});

for (const mode of ['sink-fault', 'overflow', 'detail-fault']) test('diagnostic failure cannot change prepermit product ' + mode, () => {
    const r = setup(current, mode); r.h.facts.ready = false;
    assert.equal(r.h.owner.openBootstrap(r.h.channel), null);
    assert.equal(r.h.owner.status().phase, 'CREATED'); assert.equal(r.h.owner.status().permit, 'UNUSED');
    r.d.flush(); assert.equal(r.h.requests.length, 0); assert.equal(r.h.clock.jobs.size, 0);
    if (mode === 'overflow') assert.equal(r.output.at(-1), 'LF_DEV_STARTUP_V1:DIAG_INCOMPLETE');
    assert.ok(r.output.every(s => /^LF_DEV_STARTUP_V1:[A-Z0-9_]+$/.test(s)));
});

test('original eligible getter exception identity is not caught or reread by discriminator', () => {
    for (const factory of [old.exports.createLiveAcquisitionOwner, current]) {
        const r = setup(factory); let reads = 0;
        Object.defineProperty(r.h.facts, 'ready', { get() { if (++reads === 2) throw r.primary; return true; } });
        assert.throws(() => r.h.owner.openBootstrap(r.h.channel), e => e === r.primary);
        assert.equal(reads, 2); assert.equal(r.h.owner.status().phase, 'CREATED');
    }
});

test('real Content completed-boundary flush emits media detail before any permit/extraction', async () => {
    const output = [], d = createRecorder({ log: s => output.push(s) });
    const h = integration(d)(); h.f.value(h.r.video).readyState = 1;
    await h.start();
    assert.ok(output.includes('LF_DEV_STARTUP_V1:O_PREPERMIT_WAIT'));
    assert.ok(output.includes(detail('MEDIA_INELIGIBLE')));
    assert.equal(h.injections.length, 0); assert.equal(h.requests.length, 0);
    h.f.value(h.r.video).readyState = 4; await h.tick(1);
    // Injection resolves asynchronously after tick's original timer pass.
    h.fire(); await h.flush();
    assert.equal(h.injections.length, 1); assert.equal(h.requests.length, 1);
});

test('real Content terminal facts detail flushes only after original Owner cleanup returns', async () => {
    const output = [], d = createRecorder({ log: s => output.push(s) }); let clocks = 0;
    const h = integration(d, config => {
        const now = config.realm.performance.now;
        config.realm.performance.now = () => ++clocks === 2 ? NaN : now();
    })();
    await h.start();
    assert.equal(h.bridge.inspect().owner, 'TERMINAL');
    assert.ok(output.includes('LF_DEV_STARTUP_V1:O_PREPERMIT_WAIT'));
    assert.ok(output.includes(detail('FACTS_TERMINAL')));
    assert.equal(h.injections.length, 0); assert.equal(h.requests.length, 0);
});

test('eligibility getter terminal reentry is unclassified rather than attributed to facts', () => {
    const r = setup(current); let reads = 0;
    Object.defineProperty(r.h.facts, 'ready', { get() {
        if (++reads === 2) { r.h.owner.cancel(); return false; } return true;
    } });
    assert.equal(r.h.owner.openBootstrap(r.h.channel), null); r.d.flush();
    assert.equal(r.h.owner.status().phase, 'TERMINAL');
    assert.equal(reads, 2); assert.equal(r.output.at(-1), detail('UNCLASSIFIED'));
});
