import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { responseFor } from '../server.mjs';
const root = new URL('../', import.meta.url);
const source = p => fs.readFileSync(new URL(p, root), 'utf8');
function core() { const c = vm.createContext({ URL }); vm.runInContext(source('extension/core.js'), c); return c.SyntheticProbe; }
const P = core();
const O = 'http://127.0.0.1:18765';
const privateDoc = 'synthetic-private-document-never-export';
function hooks() { const listeners = new Set(); return { addListener: f => listeners.add(f), fire: x => { for (const f of [...listeners]) f(x); } }; }
function worker() {
  let connect;
  const c = vm.createContext({ URL, chrome: { runtime: { id: 'synthetic-extension', onConnect: { addListener(f) { connect = f; } } } } });
  c.importScripts = () => vm.runInContext(source('extension/core.js'), c);
  vm.runInContext(source('extension/worker.js'), c);
  return { connect, sample(phase, sender) {
    const messages = [], disconnect = hooks(); let closed = 0;
    connect({ name: 'SPA_PROBE_V1_' + phase, sender, onDisconnect: disconnect,
      postMessage: m => messages.push(JSON.parse(JSON.stringify(m))), disconnect() { closed++; } });
    return { messages, disconnect, closed };
  } };
}
const sender = (url = O + '/top', extra = {}) => ({ id: 'synthetic-extension', url, documentId: privateDoc, frameId: 0, tab: { id: 7 }, documentLifecycle: 'active', ...extra });

for (const [label, input, expected] of [
  ['top', O + '/top', 'TOP'], ['watch', O + '/watch?v=fixture', 'WATCH'],
  ['root', O + '/', 'OTHER'], ['duplicate query', O + '/watch?v=fixture&v=fixture', 'OTHER'],
  ['missing query', O + '/watch', 'OTHER'], ['other query', O + '/watch?v=other', 'OTHER'],
  ['other port', 'http://127.0.0.1:18766/top', 'OTHER'], ['other host', 'http://localhost:18765/top', 'OTHER'],
  ['scheme', 'https://127.0.0.1:18765/top', 'OTHER'], ['credentials', 'http://u:p@127.0.0.1:18765/top', 'OTHER'],
  ['fragment', O + '/top#x', 'OTHER'], ['undefined', undefined, 'ABSENT'], ['null', null, 'ABSENT'],
  ['nonstring', {}, 'ERROR'], ['malformed', 'not-absolute', 'ERROR']
]) test('classification: ' + label, () => assert.equal(P.urlClass(input), expected));

test('worker two phases correlate privately and project no identity', () => {
  const w = worker(); const a = w.sample('TOP', sender()).messages[0];
  const b = w.sample('WATCH', sender(O + '/watch?v=fixture')).messages[0];
  assert.equal(a.senderClass, 'TOP'); assert.equal(b.senderClass, 'WATCH');
  assert.equal(b.documentSame, 'SAME'); assert.equal(b.ordinal, 2);
  assert.equal(JSON.stringify([a, b]).includes(privateDoc), false);
  assert.equal(Object.keys(b).some(k => /url|tabId|frameId|documentId/.test(k)), false);
});
test('stale sender category is observed without inventing updated metadata', () => {
  const w = worker(); w.sample('TOP', sender());
  assert.equal(w.sample('WATCH', sender()).messages[0].senderClass, 'TOP');
});
test('missing document metadata stays unknown without tab/frame substitution', () => {
  const w = worker(); w.sample('TOP', sender(undefined, { documentId: undefined }));
  const b = w.sample('WATCH', sender(O + '/watch?v=fixture', { documentId: undefined, documentLifecycle: 'arbitrary-private-value' })).messages[0];
  assert.equal(b.documentPresence, 'ABSENT'); assert.equal(b.documentSame, 'UNKNOWN'); assert.equal(b.lifecycle, 'UNKNOWN');
});
test('changed document is DIFFERENT', () => {
  const w = worker(); w.sample('TOP', sender());
  assert.equal(w.sample('WATCH', sender(O + '/watch?v=fixture', { documentId: 'different-private-document' })).messages[0].documentSame, 'DIFFERENT');
});
test('restart has no baseline and cannot join a WATCH result', () => {
  assert.equal(worker().sample('WATCH', sender(O + '/watch?v=fixture')).messages[0].status, 'RUN_LOST');
});
test('disconnect never reconnects; later attempt is rejected', () => {
  const w = worker(); const a = w.sample('TOP', sender()); a.disconnect.fire();
  assert.equal(w.sample('WATCH', sender(O + '/watch?v=fixture')).messages[0].status, 'UNEXPECTED_ATTEMPT');
});
test('extra attempt after fixed two phases is rejected', () => {
  const w = worker(); w.sample('TOP', sender()); w.sample('WATCH', sender(O + '/watch?v=fixture'));
  assert.equal(w.sample('WATCH', sender(O + '/watch?v=fixture')).messages[0].status, 'UNEXPECTED_ATTEMPT');
});
test('unknown Port name irreversibly retires the run', () => {
  const w = worker(); w.sample('TOP', sender());
  assert.equal(w.sample('FOREIGN', sender()).closed, 1);
  assert.equal(w.sample('WATCH', sender(O + '/watch?v=fixture')).messages[0].status, 'UNEXPECTED_ATTEMPT');
});
test('malformed document metadata is UNKNOWN and never exported', () => {
  const w = worker(); w.sample('TOP', sender(O + '/top', { documentId: { private: 'PRIVATE_SENTINEL' } }));
  const b = w.sample('WATCH', sender(O + '/watch?v=fixture', { documentId: '' })).messages[0];
  assert.equal(b.documentPresence, 'UNKNOWN'); assert.equal(b.documentSame, 'UNKNOWN');
  assert.equal(JSON.stringify(b).includes('PRIVATE_SENTINEL'), false);
});
for (const [name, patch] of [['extension', { id: 'foreign' }], ['frame', { frameId: 1 }], ['tab', { tab: {} }], ['missing URL', { url: undefined }]]) {
  test('invalid metadata: ' + name, () => assert.notEqual(worker().sample('TOP', sender(O + '/top', patch)).messages[0].status, 'COMPLETE'));
}
test('hostile metadata exception yields fixed ERROR only', () => {
  const input = sender(); Object.defineProperty(input, 'url', { get() { throw new Error('PRIVATE_SENTINEL'); } });
  const output = worker().sample('TOP', input).messages[0];
  assert.equal(output.status, 'ERROR'); assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'), false);
});
test('reply schema rejects unexpected and sensitive fields', () => {
  // Test inside the same realm as structured-cloned incoming extension messages.
  const c = vm.createContext({ URL }); vm.runInContext(source('extension/core.js'), c);
  assert.equal(vm.runInContext("SyntheticProbe.validReply({...SyntheticProbe.unknown('TOP','ERROR'), url:'SECRET'})", c), false);
  assert.equal(vm.runInContext("SyntheticProbe.validReply(SyntheticProbe.unknown('TOP','ERROR'))", c), true);
});

class CE extends Event { constructor(name, options = {}) { super(name); this.detail = options.detail; } }
function integrated({ duplicate = false, lose = false } = {}) {
  const doc = new EventTarget(); doc.URL = O + '/top';
  const elements = Object.fromEntries(['run', 'status', 'result'].map(k => [k, Object.assign(new EventTarget(), { disabled: k === 'run', textContent: '' })]));
  doc.getElementById = id => elements[id];
  const w = worker(), queued = [], win = new EventTarget(); let attempts = 0;
  const c = vm.createContext({ URL, document: doc, CustomEvent: CE, Event,
    addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win) });
  c.chrome = { runtime: { connect({ name }) {
    attempts++; const incoming = hooks(), disconnected = hooks(); const workerDisconnect = hooks();
    const port = { onMessage: incoming, onDisconnect: disconnected, disconnect() { workerDisconnect.fire(); disconnected.fire(); } };
    w.connect({ name, sender: sender(doc.URL), onDisconnect: workerDisconnect,
      postMessage(message) { const json = JSON.stringify(message); queued.push(() => { c.wire = json; incoming.fire(vm.runInContext('JSON.parse(wire)', c)); }); },
      disconnect() { disconnected.fire(); } });
    return port;
  } } };
  vm.runInContext(source('extension/core.js'), c); vm.runInContext(source('extension/content.js'), c);
  const page = vm.createContext({ document: doc, Event, history: { pushState(_state, _unused, value) { doc.URL = O + value; } } });
  vm.runInContext(source('site/page.js'), page);
  elements.run.dispatchEvent(new Event('click'));
  if (duplicate) doc.dispatchEvent(new Event('lf-probe-top'));
  if (lose) win.dispatchEvent(new Event('pagehide'));
  let turns = 0; while (queued.length) { assert.ok(++turns <= 4); queued.shift()(); }
  return { attempts, doc, elements, text: elements.result.textContent };
}
test('actual page + ISOLATED content + worker fixture completes same Document with two Ports', () => {
  const run = integrated(); const r = JSON.parse(run.text);
  assert.equal(r.status, 'COMPLETE'); assert.equal(run.attempts, 2); assert.equal(r.rows[1].contentClass, 'WATCH');
  assert.equal(r.rows[1].documentSame, 'SAME'); assert.ok(run.text.length <= 2048);
  assert.equal(/127\.0\.0\.1|synthetic-private|documentId|tabId|frameId|fixture/.test(run.text), false);
});
test('duplicate hint cannot add a Port', () => { const r = integrated({ duplicate: true }); assert.equal(r.attempts, 1); assert.equal(JSON.parse(r.text).status, 'PHASE_REJECTED'); });
test('pagehide retires and late response cannot restart', () => { const r = integrated({ lose: true }); assert.equal(r.attempts, 1); assert.equal(JSON.parse(r.text).status, 'CONNECTION_LOST'); });
test('page readout rejects injected raw data', () => {
  const r = integrated(); r.doc.dispatchEvent(new CE('lf-probe-report', { detail: '{"url":"PRIVATE_SENTINEL"}' }));
  assert.equal(r.elements.result.textContent, '{"status":"UNEXPECTED_OUTPUT_STOP"}');
});
test('offline ABA endpoint equality does not claim revision continuity', () => {
  const d = { url: O + '/top' }; const original = d;
  d.url = O + '/watch?v=fixture'; d.url = O + '/top'; d.url = O + '/watch?v=fixture';
  assert.equal(d, original); assert.equal(P.urlClass(d.url), 'WATCH');
  assert.equal(Object.hasOwn(P, 'historyContinuity'), false);
});
test('local server pure routing denies traversal, foreign Host and writes without listening', () => {
  for (const path of ['/../manifest.json', '/favicon.ico', '/watch?v=private']) assert.equal(responseFor('GET', '127.0.0.1:18765', path).status, 404);
  assert.equal(responseFor('POST', '127.0.0.1:18765', '/top').status, 403);
  assert.equal(responseFor('GET', 'foreign.example', '/top').status, 403);
  assert.equal(responseFor('GET', '127.0.0.1:18765', '/top').status, 200);
});
