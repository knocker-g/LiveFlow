import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url), read = p => fs.readFileSync(new URL(p, root), 'utf8');
test('manifest adds only DEV webNavigation, no tabs or host access', () => {
  const m = JSON.parse(read('extension/manifest.json'));
  assert.deepEqual(Object.keys(m), ['manifest_version', 'name', 'version', 'permissions', 'background', 'content_scripts']);
  assert.deepEqual(m.permissions, ['webNavigation']); assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.content_scripts, [{ matches: ['http://127.0.0.1/*'], js: ['core.js', 'content.js'], world: 'ISOLATED', run_at: 'document_start', all_frames: false }]);
});
test('all Manifest references exist and scripts parse', () => { for (const p of ['extension/core.js', 'extension/worker.js', 'extension/content.js', 'site/page.js']) assert.doesNotThrow(() => new vm.Script(read(p))); });
test('single filtered history listener and one runtime listener', () => {
  const s = read('extension/worker.js'); assert.equal((s.match(/onHistoryStateUpdated.addListener/g) || []).length, 1);
  assert.equal((s.match(/onConnect.addListener/g) || []).length, 1); assert.match(s, /hostEquals: '127.0.0.1', ports: \[18765\]/);
  assert.match(s, /!P.local\(details.url\)/);
});
test('no additional browser operations, network, Product code, persistence, timers or logging', () => {
  const s = ['extension/core.js', 'extension/worker.js', 'extension/content.js', 'site/page.js'].map(read).join('\n');
  assert.doesNotMatch(s, /chrome\.(tabs|scripting|cookies|storage|identity|debugger)|\bfetch\(|XMLHttpRequest|setTimeout|setInterval|queueMicrotask|console\.|youtube\.com|require\(|import\s/);
});
test('finite phases, query binding and no automatic reconnection', () => {
  const w = read('extension/worker.js'), c = read('extension/content.js');
  assert.match(w, /attempts >= 4/); assert.match(w, /index >= 3/);
  assert.match(w, /getFrame\(\{ tabId: baseline.tab, frameId: 0, documentId: baseline.doc \}\)/);
  assert.equal((c.match(/chrome.runtime.connect/g) || []).length, 1); assert.match(c, /onDisconnect.addListener\(\(\) => finish\('DISCONNECT'\)\)/);
});
test('server fixed loopback, strict CSP, no raw log or browser launch', () => {
  const s = read('server.mjs'); assert.match(s, /listen\(18765, '127.0.0.1'/); assert.match(s, /connect-src 'none'/);
  assert.doesNotMatch(s, /child_process|console\.(log|error)\([^'"\n]/);
});
test('page uses shared fixed schema and explicit phase hint after pushState', () => {
  const s = read('site/page.js'); assert.match(s, /P.validReport/); assert.match(s, /history.pushState/); assert.match(s, /new CustomEvent\('m2-phase'/);
  assert.match(s, /4096/); assert.doesNotMatch(s, /addEventListener\(['"]pushstate/);
});
test('extension has no private fixture values or credentials', () => {
  assert.deepEqual(fs.readdirSync(new URL('extension/', root)).sort(), ['content.js', 'core.js', 'manifest.json', 'worker.js']);
  for (const p of fs.readdirSync(new URL('extension/', root))) assert.doesNotMatch(read('extension/' + p), /PRIVATE_SENTINEL|private-document|-----BEGIN|github_pat_/);
});
