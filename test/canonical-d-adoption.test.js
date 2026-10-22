const test = require('node:test');
const assert = require('node:assert/strict');
const accepted = require('./fixtures/accepted-d-config.json');
const tuning = require('../src/phase5-tuning');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const settings = require('../src/settings-core');
const reference = require('./fixtures/opportunity-aware-density');
const production = require('../src/opportunity-aware-density');
const core = require('../src/overlay-core');
const overlap = require('../src/normal-overlap-policy');
const foundations = require('../src/scheduler-foundations');

test('canonical defaults equal the independently captured Human-approved D configuration', () => {
    assert.equal(accepted.buildID, 'f0ec22e55f82b1222bbf4f79c40885f97158d91241d4a2463afaabced1f999e8');
    assert.deepEqual(tuning.CURRENT, accepted.config);
});

const lane = n => ({ lane: n, interleaved: n % 1 !== 0, rectangle: { x: 1000, y: n * 32,
    width: 300, height: 32, velocity: 175, exitX: 0, surfaceRight: 1000, semanticClass: 'NORMAL',
    snapshotAt: 10, occlusionHistoryKnown: true } });

test('canonical ordering matches frozen D reference across density, occupancy and bounded fallbacks', () => {
    for (const density of ['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE']) {
        for (const count of [0, 1, 3, 8, 41]) {
            for (const position of [null, 580, 780, 1000]) {
                const candidates = Array.from({ length: count }, (_, i) => lane(i / 2));
                const active = position === null ? [] : [{ ...lane(2).rectangle, x: position, velocity: 150 }];
                for (const special of [false, true]) {
                    if (special && candidates.length) candidates[0].rectangle.semanticClass = 'SPECIAL';
                    const state = { candidates, active, density, config: accepted.config };
                    const before = JSON.stringify(state);
                    assert.deepEqual(production.select(state).candidates, reference.select(state).candidates);
                    assert.equal(JSON.stringify(state), before);
                }
            }
        }
    }
    const candidates = [lane(1), lane(1.5), lane(2)];
    for (const active of [Array.from({ length: core.DANMAKU_MAX_ACTIVE_COMMENTS + 1 }, () => lane(0).rectangle),
        [{ ...lane(2).rectangle, x: 580, occlusionEpisodes: [[8.9, 15]] }]]) {
        const state = { candidates, active, density: 'MAX_READABLE', config: accepted.config };
        assert.deepEqual(production.select(state).candidates, reference.select(state).candidates);
    }
});

test('canonical modules load in ordinary ISOLATED manifest order without comparison controls', () => {
    const manifest = require('../manifest.json');
    const scripts = manifest.content_scripts.find(s => s.world === 'ISOLATED').js;
    const browser = {};
    const context = vm.createContext({ window: browser });
    for (const name of scripts) {
        if (name === 'src/youtube-chat.js') break;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(browser.LiveFlowPhase5Tuning.CURRENT)), accepted.config);
    assert.equal(typeof browser.LiveFlowOpportunityAwareDensity.select, 'function');
    const source = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');
    assert.match(source, /const phase5Tuning = window.LiveFlowPhase5Tuning\?\.CURRENT;/);
    assert.match(source, /window.LiveFlowOpportunityAwareDensity.select\(/);
    assert.doesNotMatch(source, /comparisonIdentity|comparisonRecorder|comparisonSelect|LIVEFLOW_DEV_OWNED_RECORDER|liveflow-dev-comparison/);
    const policy = fs.readFileSync(path.join(__dirname, '../src/opportunity-aware-density.js'), 'utf8');
    assert.doesNotMatch(policy, /setTimeout|setInterval|fetch\(|postMessage|document|diagnostic|comparison/);
});

test('approved B/D comparison configuration remains stable after canonical adoption', () => {
    const { candidateC, candidates } = require('./fixtures/final-visual-candidates');
    assert.deepEqual(candidateC.config, accepted.config);
    const { normalOverlapPolicy, ...b } = accepted.config;
    assert.deepEqual(candidates[2].config, b);
});

test('settings rendering contract, presentation, Acquisition, Authority and SPECIAL cohort stay unchanged', () => {
    const hash = source => crypto.createHash('sha256').update(source).digest('hex');
    for (const [name, digest] of Object.entries(accepted.unchangedInputs)) {
        if (name === 'src/settings-core.js') {
            // Persistence may evolve independently of the accepted rendering contract.
            // Authenticate the historical reference rather than rewriting its receipt.
            const referenceSource = execFileSync('git', ['show', `${accepted.sourceSHA}:${name}`],
                { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).replaceAll('\r\n', '\n');
            assert.equal(hash(referenceSource), digest, name);
            const context = vm.createContext({});
            vm.runInContext(referenceSource, context);
            const original = context.LiveFlowSettingsCore;
            for (const key of ['STORAGE_KEY', 'SETTINGS_VERSION', 'DEFAULT_SETTINGS', 'CAPABILITIES']) {
                assert.equal(JSON.stringify(settings[key]), JSON.stringify(original[key]), key);
            }
            for (const key of ['normalizeSettings', 'createSettingsSnapshot']) {
                assert.equal(settings[key].toString().replaceAll('\r\n', '\n'), original[key].toString(), key);
                for (const field of Object.keys(settings.DEFAULT_SETTINGS)) {
                    for (const value of [undefined, null, false, true, '', 'manual', 0, 100, NaN, {}]) {
                        const input = { [field]: value };
                        assert.equal(JSON.stringify(settings[key](input)), JSON.stringify(original[key](input)), `${key}:${field}`);
                    }
                }
            }
            continue;
        }
        assert.equal(hash(fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replaceAll('\r\n', '\n')), digest, name);
    }
    const source = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8').replaceAll('\r\n', '\n');
    for (const [name, digest] of Object.entries(accepted.unchangedFunctions)) {
        const at = source.indexOf('    function ' + name + '('), end = source.indexOf('\n    }', at) + 6;
        assert.ok(at >= 0);
        assert.equal(hash(source.slice(at, end)), digest, name);
    }
});
