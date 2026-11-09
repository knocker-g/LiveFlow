import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { responseFor } from '../server.mjs';
const root = new URL('../', import.meta.url), origin = 'http://127.0.0.1:18765';
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const docId = 'private-document-not-output';
function hook() { const set = new Set(); return { addListener: f => set.add(f), fire: v => { for (const f of [...set]) f(v); } }; }
const sender = (extra = {}) => ({ id: 'test-extension', url: origin + '/top', tab: { id: 5 }, frameId: 0, documentId: docId, documentLifecycle: 'active', ...extra });
const frame = (phase, extra = {}) => ({ url: origin + (phase % 2 ? '/watch?v=fixture' : '/top'), documentId: docId, documentLifecycle: 'active', errorOccurred: false, ...extra });
function worker(getFrame = q => Promise.resolve(frame(0))) {
  let connect, history, filter; const queries = [];
  const c = vm.createContext({ URL, chrome: { runtime: { id: 'test-extension', onConnect: { addListener(f) { connect = f; } } },
    webNavigation: { onHistoryStateUpdated: { addListener(f, v) { history = f; filter = v; } }, getFrame(q) { queries.push(q); return getFrame(q); } } } });
  c.importScripts = () => vm.runInContext(read('extension/core.js'), c);
  vm.runInContext(read('extension/worker.js'), c);
  return { connect, history, filter, queries, sample(phase, input = sender()) {
    const messages = [], onDisconnect = hook(); let disconnected = false;
    connect({ name: 'SPA_M2_' + phase, sender: input, onDisconnect, postMessage: m => messages.push(JSON.parse(JSON.stringify(m))), disconnect() { disconnected = true; onDisconnect.fire(); } });
    return { messages, onDisconnect, get disconnected() { return disconnected; } };
  } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function event(phase, extra = {}) { return { ...frame(phase), tabId: 5, frameId: 0, ...extra }; }
test('M1 URL classifier compatibility including missing and malformed metadata', () => {
  const a = vm.createContext({ URL }), b = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(new URL('../synthetic-spa-probe/extension/core.js', root), 'utf8'), a);
  vm.runInContext(read('extension/core.js'), b);
  for (const input of [origin + '/top', origin + '/watch?v=fixture', origin + '/watch?v=other', origin + '/watch?v=fixture&v=fixture', undefined, null, {}, 'invalid', 'https://example.invalid/top'])
    assert.equal(a.SyntheticProbe.urlClass(input), b.SPAProbeM2.urlClass(input));
});
for (const order of ['BEFORE_PORT', 'AFTER_PORT', 'AFTER_QUERY']) test('browser event ordering: ' + order, async () => {
  let phase = 0, resolveQuery; const w = worker(() => phase === 0 ? Promise.resolve(frame(0)) : new Promise(r => { resolveQuery = r; }));
  w.sample(0); await tick(); phase = 1;
  if (order === 'BEFORE_PORT') w.history(event(1));
  const b = w.sample(1);
  if (order === 'AFTER_PORT') w.history(event(1));
  resolveQuery(frame(1)); await tick();
  if (order === 'AFTER_QUERY') w.history(event(1));
  await tick();
  assert.equal(b.messages[0].row.status, 'COMPLETE');
  assert.equal(b.messages[0].row.event.order, order); assert.equal(b.messages[0].row.senderClass, 'TOP');
  assert.equal(b.messages[0].row.frame.urlClass, 'WATCH');
  assert.deepEqual(JSON.parse(JSON.stringify(w.queries[1])), { tabId: 5, frameId: 0, documentId: docId });
});
for (const [label, value] of [['absent', undefined], ['different URL', frame(0)], ['different Document', frame(1, { documentId: 'replacement-document' })], ['nonactive', frame(1, { documentLifecycle: 'cached' })], ['foreign URL', frame(1, { url: 'https://outside.invalid/private' })], ['browser error', frame(1, { errorOccurred: true })]]) {
  test('getFrame negative: ' + label, async () => {
    let phase = 0; const w = worker(() => Promise.resolve(phase === 0 ? frame(0) : value));
    w.sample(0); await tick(); phase = 1; const b = w.sample(1); w.history(event(1)); await tick();
    assert.equal(b.messages[0].reason, 'FRAME'); assert.equal(b.messages[0].row.status, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(b.messages), /outside\.invalid|private-document|replacement-document/);
  });
}
test('getFrame rejected promise produces fixed failure without exception string', async () => {
  const w = worker(() => Promise.reject(new Error('PRIVATE_SENTINEL'))); const a = w.sample(0); await tick();
  assert.equal(a.messages[0].reason, 'FRAME'); assert.doesNotMatch(JSON.stringify(a.messages), /PRIVATE_SENTINEL/);
});
for (const [label, extra] of [['missing ID', { documentId: undefined }], ['malformed ID', { documentId: {} }], ['wrong frame', { frameId: 1 }], ['wrong extension', { id: 'other' }], ['nonactive', { documentLifecycle: 'cached' }]]) {
  test('sender negative: ' + label, () => { const w = worker(); const a = w.sample(0, sender(extra)); assert.equal(a.messages[0].reason, 'METADATA'); assert.equal(w.queries.length, 0); });
}
test('Worker restart cannot bootstrap a later phase', () => { const w = worker(); const b = w.sample(1); assert.equal(b.messages[0].reason, 'STATE_LOST'); assert.equal(w.queries.length, 0); });
test('Document replacement event retires original binding', async () => {
  const w = worker(() => Promise.resolve(frame(0))); w.sample(0); await tick();
  const b = w.sample(1); w.history(event(1, { documentId: 'replacement-document' })); await tick();
  assert.equal(b.messages[0].reason, 'EVENT'); assert.equal(b.messages[0].row.event.document, 'DIFFERENT');
});
test('foreign-site/tab/frame history events are ignored and never retained', async () => {
  let phase = 0; const w = worker(() => Promise.resolve(frame(phase))); w.sample(0); await tick(); phase = 1; const b = w.sample(1);
  w.history(event(1, { url: 'https://foreign.invalid/private' })); w.history(event(1, { tabId: 99 })); w.history(event(1, { frameId: 2 }));
  await tick(); assert.equal(b.messages.length, 0); w.history(event(1)); await tick(); assert.equal(b.messages[0].reason, 'NONE');
});
test('missing event never becomes invented success or auto query retry', async () => {
  let phase = 0; const w = worker(() => Promise.resolve(frame(phase))); w.sample(0); await tick(); phase = 1; const b = w.sample(1); await tick();
  assert.equal(b.messages.length, 0); assert.equal(w.queries.length, 2); b.onDisconnect.fire();
  assert.equal(b.messages[0].reason, 'DISCONNECT'); assert.equal(w.queries.length, 2);
});
test('disconnect excludes late query completion', async () => {
  let resolve; const w = worker(() => new Promise(r => { resolve = r; })); const a = w.sample(0); a.onDisconnect.fire(); resolve(frame(0)); await tick();
  assert.equal(a.messages.length, 1); assert.equal(a.messages[0].reason, 'DISCONNECT');
});
test('reentrant or duplicate Port cannot issue second concurrent query', async () => {
  const w = worker(() => new Promise(() => {})); const a = w.sample(0); const duplicate = w.sample(0); await tick();
  assert.equal(w.queries.length, 1); assert.equal(a.messages[0].reason, 'EXTRA'); assert.equal(duplicate.messages[0].reason, 'EXTRA');
});
class CE extends Event { constructor(name, options = {}) { super(name); this.detail = options.detail; } }
async function integrated({ missingEvent = false, stop = false } = {}) {
  const d = new EventTarget(); d.URL = origin + '/top';
  const nodes = Object.fromEntries(['run', 'stop', 'status', 'result'].map(id => [id, Object.assign(new EventTarget(), { textContent: '', disabled: false })]));
  d.getElementById = id => nodes[id]; const windowEvents = new EventTarget();
  let currentPhase = 0, connects = 0; const tasks = [];
  const w = worker(() => Promise.resolve(frame(currentPhase)));
  const c = vm.createContext({ URL, document: d, Event, CustomEvent: CE, addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents) });
  c.chrome = { runtime: { connect({ name }) {
    connects++; const incoming = hook(), disconnected = hook(), wd = hook();
    w.connect({ name, sender: sender(), onDisconnect: wd, disconnect: () => disconnected.fire(), postMessage(m) { const text = JSON.stringify(m); tasks.push(() => { c.wire = text; incoming.fire(vm.runInContext('JSON.parse(wire)', c)); }); } });
    return { onMessage: incoming, onDisconnect: disconnected, disconnect() { wd.fire(); disconnected.fire(); } };
  } } };
  vm.runInContext(read('extension/core.js'), c); vm.runInContext(read('extension/content.js'), c);
  const page = vm.createContext({ URL, document: d, Event, CustomEvent: CE, history: { pushState(_s, _t, path) { currentPhase++; d.URL = origin + path; if (!missingEvent) w.history(event(currentPhase)); } } });
  vm.runInContext(read('extension/core.js'), page); vm.runInContext(read('site/page.js'), page);
  nodes.run.dispatchEvent(new Event('click'));
  for (let i = 0; i < 12; i++) { await tick(); while (tasks.length) tasks.shift()(); }
  if (stop) nodes.stop.dispatchEvent(new Event('click'));
  return { text: nodes.result.textContent, nodes, connects, queries: w.queries, document: d };
}
test('actual Page/Content/Worker fixed ABA integrates four Ports and one bounded private projection', async () => {
  const r = await integrated(); const v = JSON.parse(r.text);
  assert.equal(v.status, 'COMPLETE'); assert.equal(r.connects, 4); assert.equal(r.queries.length, 4);
  assert.deepEqual(v.rows.map(x => x.contentClass), ['TOP', 'WATCH', 'TOP', 'WATCH']);
  assert.deepEqual(v.rows.map(x => x.senderClass), ['TOP', 'TOP', 'TOP', 'TOP']);
  assert.deepEqual(v.rows.slice(1).map(x => x.event.urlClass), ['WATCH', 'TOP', 'WATCH']);
  assert.ok(Buffer.byteLength(r.text) <= 4096); assert.doesNotMatch(r.text, /127\.0\.0\.1|documentId|tabId|frameId|private-document|fixture/);
  r.nodes.run.dispatchEvent(new Event('click')); assert.equal(r.connects, 4);
});
test('missing event can be stopped by one human action without reconnect', async () => {
  const r = await integrated({ missingEvent: true, stop: true }); const v = JSON.parse(r.text);
  assert.equal(v.status, 'UNKNOWN'); assert.equal(v.reason, 'USER_STOP'); assert.equal(r.connects, 2);
});
test('UI schema rejects sensitive fields and arbitrary data', async () => {
  const r = await integrated(); r.document.dispatchEvent(new CE('m2-report', { detail: '{"url":"PRIVATE_SENTINEL"}' }));
  assert.equal(r.nodes.result.textContent, '{"status":"UNKNOWN","reason":"SCHEMA"}');
});
test('server pure response routing has no external requests or traversal', () => {
  assert.equal(responseFor('GET', '127.0.0.1:18765', '/schema.js').status, 200);
  assert.equal(responseFor('GET', 'foreign.invalid', '/top').status, 403);
  for (const path of ['/../extension/worker.js', '/worker.js', '/toString', '/favicon.ico']) assert.equal(responseFor('GET', '127.0.0.1:18765', path).status, 404);
});
