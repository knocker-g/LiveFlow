import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dependencies, selectTests, checkManifest, baseline } from '../tools/ci.mjs';

test('affected closure includes transitive fixtures and changed tests, not unrelated tests', () => {
    const sources = { 'src/core.js': '', 'test/fixtures/a.js': "require('../../src/core')",
        'test/a.test.js': "require('./fixtures/a')", 'test/b.test.js': '' };
    const files = Object.keys(sources);
    assert.deepEqual(dependencies('test/fixtures/a.js', sources['test/fixtures/a.js'], files), ['src/core.js']);
    const selected = selectTests(files, name => sources[name], ['src/core.js']);
    assert.ok(selected.includes('test/a.test.js'));
    assert.ok(!selected.includes('test/b.test.js'));
    for (const name of baseline) assert.ok(selected.includes(name));
    assert.ok(selectTests(files, name => sources[name], ['test/b.test.js']).includes('test/b.test.js'));
});
test('unmapped executable and removed dependencies fail closed; broad suite is explicit', () => {
    const files = ['src/new.js', 'test/a.test.js'];
    assert.throws(() => selectTests(files, () => '', ['src/new.js']), /Unmapped executable/);
    assert.throws(() => selectTests(files, () => '', ['src/deleted.js']), /Unmapped executable/);
    assert.deepEqual(selectTests(files, () => '', [], true), ['test/a.test.js']);
    assert.deepEqual(selectTests(files, () => '', ['docs/a.md']), [...baseline].sort());
});
test('root-relative file reads map actual fixture consumers without filename-only coverage', () => {
    const sources = { 'tools/embedded.js': '', 'tools/unread.js': '',
        'tools/builder.mjs': "fs.readFileSync(path.join(root, 'tools/embedded.js'), 'utf8')",
        'test/a.test.mjs': "import '../tools/builder.mjs'",
        'test/b.test.mjs': "fs.readFileSync('tools/embedded.js', 'utf8')",
        'test/unrelated.test.mjs': "const label = 'tools/unread.js'; const unused = path.join(root, 'tools/unread.js');" };
    const files = Object.keys(sources), read = name => sources[name];
    assert.deepEqual(dependencies('tools/builder.mjs', sources['tools/builder.mjs'], files), ['tools/embedded.js']);
    const selected = selectTests(files, read, ['tools/embedded.js']);
    assert.ok(selected.includes('test/a.test.mjs')); assert.ok(selected.includes('test/b.test.mjs'));
    assert.ok(!selected.includes('test/unrelated.test.mjs'));
    assert.throws(() => selectTests(files, read, ['tools/unread.js']), /Unmapped executable/);
    assert.throws(() => selectTests(files, read, ['tools/missing.js']), /Unmapped executable/);
});
test('manifest sanity validates actual assets and rejects privileges, scope and missing assets', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
    const refs = manifest.content_scripts.flatMap(s => [...s.js, ...(s.css || [])]);
    const files = [...refs, manifest.action.default_popup, ...Object.values(manifest.icons),
        ...Object.values(manifest.action.default_icon), `_locales/${manifest.default_locale}/messages.json`];
    assert.doesNotThrow(() => checkManifest(manifest, files));
    assert.throws(() => checkManifest({ ...manifest, permissions: ['storage', 'cookies'] }, files), /privilege/);
    assert.throws(() => checkManifest(manifest, []), /asset/);
    const changed = structuredClone(manifest); changed.content_scripts[0].world = 'UNKNOWN';
    assert.throws(() => checkManifest(changed, files), /scope/);
});
test('workflow is valid JSON/YAML subset with bounded read-only pinned jobs and safe event data', () => {
    const workflow = JSON.parse(fs.readFileSync(new URL('../.github/workflows/deterministic.yml', import.meta.url)));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
    const job = workflow.jobs.deterministic;
    assert.equal(job['timeout-minutes'], 10);
    assert.equal(job.steps[0].with['persist-credentials'], false);
    for (const step of job.steps.filter(s => s.uses)) assert.match(step.uses, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
    const command = job.steps.at(-1);
    assert.ok(command.env.BASE_SHA);
    assert.doesNotMatch(command.run, /\$\{\{|npm|npx|playwright|curl|eval/);
    assert.match(command.run, /node tools\/ci.mjs --base "\$BASE_SHA"/);
    assert.match(command.run, /node tools\/ci.mjs --integration/);
});
