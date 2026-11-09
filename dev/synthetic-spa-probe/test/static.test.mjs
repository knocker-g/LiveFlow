import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
test('static: minimal exact Manifest; no API permissions or host_permissions', () => {
  const m = JSON.parse(read('extension/manifest.json'));
  assert.deepEqual(Object.keys(m), ['manifest_version', 'name', 'version', 'background', 'content_scripts']);
  assert.equal(m.manifest_version, 3); assert.deepEqual(m.background, { service_worker: 'worker.js' });
  assert.deepEqual(m.content_scripts, [{ matches: ['http://127.0.0.1/*'], js: ['core.js', 'content.js'], world: 'ISOLATED', run_at: 'document_start', all_frames: false }]);
});
test('static: every extension entry exists and parses', () => {
  for (const path of ['extension/core.js', 'extension/content.js', 'extension/worker.js', 'site/page.js']) assert.doesNotThrow(() => new vm.Script(read(path)));
});
test('static: no Product imports, external network or privileged APIs', () => {
  const code = ['extension/core.js', 'extension/content.js', 'extension/worker.js', 'site/page.js'].map(read).join('\n');
  assert.doesNotMatch(code, /youtube\.com|\bfetch\s*\(|XMLHttpRequest|chrome\.(?:tabs|storage|scripting|cookies|identity|debugger|webNavigation)|postMessage\s*\([^)]*['"]\*['"]|src\/production/);
});
test('static: no timers, auto retry, persistence, telemetry or console output in extension', () => {
  const code = ['extension/core.js', 'extension/content.js', 'extension/worker.js'].map(read).join('\n');
  assert.doesNotMatch(code, /setTimeout|setInterval|queueMicrotask|requestAnimationFrame|localStorage|sessionStorage|console\./);
  assert.equal((code.match(/chrome\.runtime\.connect\(/g) || []).length, 1);
});
test('static: single worker listener, only fixed phases and bounded counters', () => {
  const code = read('extension/worker.js');
  assert.equal((code.match(/onConnect\.addListener/g) || []).length, 1);
  assert.match(code, /Math\.min\(count \+ 1, 3\)/); assert.match(read('extension/content.js'), /ports\.length >= 2/);
});
test('static: explicit pushState notification and fixed single action', () => {
  const page = read('site/page.js'); assert.match(page, /history\.pushState\(null, '', '\/watch\?v=fixture'\)/);
  assert.match(page, /new Event\('lf-probe-watch'\)/); assert.doesNotMatch(page, /addEventListener\(['"]pushstate/);
  assert.match(page, /button\.disabled = true/); assert.match(page, /safeReport\(event.detail\)/);
});
test('static: server only binds fixed loopback with restrictive CSP and no request logs', () => {
  const code = read('server.mjs'); assert.match(code, /listen\(18765, '127\.0\.0\.1'/);
  assert.match(code, /connect-src 'none'/); assert.doesNotMatch(code, /console\.(?:log|error)\([^'"\n]/);
});
test('static: no generated bundle, dependencies, fixture inputs or secrets in extension', () => {
  assert.deepEqual(fs.readdirSync(new URL('extension/', root)).sort(), ['content.js', 'core.js', 'manifest.json', 'worker.js']);
  for (const file of fs.readdirSync(new URL('extension/', root))) assert.doesNotMatch(read('extension/' + file), /PRIVATE_SENTINEL|synthetic-private|-----BEGIN|gh[pousr]_[A-Za-z0-9]+/);
});
