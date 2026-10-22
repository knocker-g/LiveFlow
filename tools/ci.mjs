import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const baseline = [
    'test/ci.test.mjs', 'test/read-only-safety.test.js',
    'test/replay-control-plane-core.test.js', 'test/diagnostic-scope-handoff.test.js',
    'test/temporal-occurrence-accounting.test.js', 'test/pending-clear-production-integration.test.js'
];
const isTest = name => /^test\/[^/]+\.test\.(?:js|mjs)$/.test(name);
const code = name => /^(?:src|popup|tools|test)\/.*\.(?:js|mjs)$/.test(name);

// Literal relative references include require.resolve/readFile fixture paths, not only imports.
export function dependencies(name, source, files) {
    const result = new Set();
    for (const match of source.matchAll(/['"](\.{1,2}\/[^'"\n]+)['"]/g)) {
        const stem = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
        for (const candidate of [stem, stem + '.js', stem + '.mjs', stem + '.json']) {
            if (files.includes(candidate)) result.add(candidate);
        }
    }
    // Existing embedded-source tests read from repository cwd or path.join(root,...).
    // Do not treat arbitrary labels/metadata containing a filename as coverage.
    for (const match of source.matchAll(/readFileSync\s*\(\s*(?:path\.join\s*\(\s*root\s*,\s*)?['"]((?:src|popup|tools|test)\/[^'"\n]+)['"]/g)) {
        const candidate = path.posix.normalize(match[1]);
        if (files.includes(candidate)) result.add(candidate);
    }
    return [...result];
}

export function selectTests(files, read, changed, integration = false) {
    const tests = files.filter(isTest).sort();
    if (integration) return tests;
    const graph = new Map(files.filter(code).map(name => [name, dependencies(name, read(name), files)]));
    const affected = new Set(changed);
    let previous;
    do {
        previous = affected.size;
        for (const [name, deps] of graph) if (deps.some(dep => affected.has(dep))) affected.add(name);
    } while (affected.size !== previous);
    // Global/browser wiring cannot always be inferred from CommonJS dependency edges.
    // Require explicit checkpoint coverage for an unrepresented executable change.
    for (const name of changed.filter(code)) {
        if (!tests.some(test => affected.has(test) && reaches(test, name, graph))) {
            throw new Error(`Unmapped executable change: ${name}; specify --integration at a coherent checkpoint`);
        }
    }
    return [...new Set([...baseline, ...tests.filter(test => affected.has(test))])].sort();
}
function reaches(from, target, graph, visited = new Set()) {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (graph.get(from) || []).some(next => reaches(next, target, graph, visited));
}

export function checkManifest(manifest, files) {
    if (manifest.manifest_version !== 3 || JSON.stringify(manifest.permissions) !== '["storage"]' ||
        manifest.host_permissions?.length || manifest.background || manifest.oauth2) throw new Error('Manifest privilege drift');
    const entries = manifest.content_scripts;
    if (!Array.isArray(entries) || !entries.length) throw new Error('Missing content scripts');
    const refs = [manifest.action?.default_popup, ...Object.values(manifest.icons || {}),
        ...Object.values(manifest.action?.default_icon || {})];
    for (const entry of entries) {
        if (!['MAIN', 'ISOLATED'].includes(entry.world) || !['document_start', 'document_idle'].includes(entry.run_at) ||
            JSON.stringify(entry.matches) !== '["https://www.youtube.com/*","https://youtube.com/*"]') throw new Error('Execution scope drift');
        refs.push(...(entry.js || []), ...(entry.css || []));
    }
    for (const ref of refs) {
        if (typeof ref !== 'string' || !files.includes(ref) || ref.includes('..') || ref.startsWith('/')) throw new Error(`Missing/unsafe manifest asset: ${ref}`);
    }
    if (!files.includes(`_locales/${manifest.default_locale}/messages.json`)) throw new Error('Missing default locale');
    const main = entries.find(entry => entry.js?.includes('src/page-state-main.js'));
    const isolated = entries.find(entry => entry.js?.includes('src/youtube-chat.js'));
    if (main?.world !== 'MAIN' || isolated?.world !== 'ISOLATED' ||
        main.js.indexOf('src/chat-read-core.js') < 0 || main.js.indexOf('src/chat-read-core.js') > main.js.indexOf('src/page-state-main.js') ||
        isolated.js.indexOf('src/opportunity-aware-density.js') < 0 ||
        isolated.js.indexOf('src/opportunity-aware-density.js') > isolated.js.indexOf('src/youtube-chat.js')) throw new Error('Required module world/order drift');
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 180000 });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
}
export function main(args = process.argv.slice(2)) {
    const integration = args.includes('--integration');
    const baseAt = args.indexOf('--base');
    if (args.some((arg, i) => !['--integration', '--plan', '--base'].includes(arg) && !(baseAt >= 0 && i === baseAt + 1))) throw new Error('Unknown argument');
    if (baseAt >= 0 && !/^[0-9a-f]{40}$/.test(args[baseAt + 1] || '')) throw new Error('--base requires a full commit SHA');
    if (!integration && baseAt < 0) throw new Error('Use --base SHA for affected tests or explicit --integration');
    const git = argv => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const files = git(['ls-files']).sort();
    const read = name => fs.readFileSync(path.join(root, name), 'utf8');
    const changed = integration ? [] : git(['diff', '--name-only', '--diff-filter=ACDMRT', `${args[baseAt + 1]}...HEAD`]);
    const selected = selectTests(files, read, changed, integration);
    console.log(JSON.stringify({ mode: integration ? 'integration' : 'affected', changed, tests: selected }, null, 2));
    if (args.includes('--plan')) return;
    for (const name of files.filter(code)) run(process.execPath, ['--check', name]);
    for (const name of files.filter(name => /^(?:_locales\/.*|manifest)\.json$/.test(name))) JSON.parse(read(name));
    checkManifest(JSON.parse(read('manifest.json')), files);
    // No browser dependency is needed by this repository's deterministic test entrypoints.
    for (const name of selected) {
        if (/\b(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:@playwright|playwright|puppeteer)/.test(read(name))) throw new Error(`Browser test forbidden: ${name}`);
    }
    run(process.execPath, ['--test', '--test-concurrency=1', ...selected]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
