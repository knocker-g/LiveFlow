const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    replayEndpoint,
    requestBodyShape,
    collectResponseShape,
    createReplayProbeCollector
} = require('../src/replay-schema-probe-core.js');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/replay-schema-probe.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function createTopDiagnosticRuntime(activeResponse, timer = { setTimeout, clearTimeout }) {
    let calls = 0;
    const passiveResponse = { clone() { return { json: async () => ({}) }; } };
    const fetch = (...args) => { calls += 1; return calls === 1 ? Promise.resolve(passiveResponse) : typeof activeResponse === 'function' ? activeResponse(...args) : Promise.resolve(activeResponse); };
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {}; FakeXHR.prototype.send = function () {}; FakeXHR.prototype.setRequestHeader = function () {}; FakeXHR.prototype.addEventListener = function () {};
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch, frames: [], addEventListener() {}, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    vm.runInNewContext(runtimeSource, { window: testWindow, XMLHttpRequest: FakeXHR, Headers: class { keys() { return []; } }, document: { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} }, console: { log() {} }, Promise, URL, AbortController, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
    testWindow.LiveFlowReplayProbe.enable();
    return { window: testWindow, capture: () => testWindow.fetch('/youtubei/v1/live_chat/get_live_chat_replay?key=secret', { method: 'POST', body: '{"context":{},"continuation":"secret"}' }), calls: () => calls };
}

test('replay endpoint matching strips query values and rejects other paths', () => {
    assert.equal(replayEndpoint('https://www.youtube.com/live_chat_replay?v=SECRET'), '/live_chat_replay');
    assert.equal(replayEndpoint('/youtubei/v1/live_chat/get_live_chat_replay?key=SECRET'), '/youtubei/v1/live_chat/get_live_chat_replay');
    assert.equal(replayEndpoint('/youtubei/v1/live_chat/get_live_chat'), null);
});

test('request body summary retains only static keys and primitive types', () => {
    const shape = requestBodyShape(JSON.stringify({ context: { client: { visitorData: 'visitor-secret' } }, continuation: 'continuation-secret', videoId: 'video-secret', enabled: true, count: 42, abc123: 'dynamic-secret' }));
    assert.deepEqual(shape, [
        { key: 'context', type: 'object' },
        { key: 'continuation', type: 'string' },
        { key: 'count', type: 'number' },
        { key: 'enabled', type: 'boolean' },
        { key: 'videoId', type: 'string' }
    ]);
    const output = JSON.stringify(shape);
    for (const secret of ['visitor-secret', 'continuation-secret', 'video-secret', 'dynamic-secret', '42']) assert.equal(output.includes(secret), false);
});

test('response walker emits normalized paths, names, types, and never values', () => {
    const response = {
        continuationContents: { liveChatContinuation: {
            actions: [{ replayChatItemAction: { videoOffsetTimeMsec: '12345', item: { liveChatPaidMessageRenderer: { id: 'channel-secret', timestampUsec: '999', trackingParams: 'tracking-secret' } } } }],
            continuations: [{ liveChatReplayContinuationData: { continuation: 'continuation-secret', timeUntilLastMessageMsec: 500 } }]
        } }, visitorData: 'visitor-secret', apiKey: 'api-key-secret'
    };
    const result = collectResponseShape(response);
    assert.ok(result.replayTimingCandidates.some((entry) => entry.path === 'continuationContents.liveChatContinuation.actions[].replayChatItemAction.videoOffsetTimeMsec' && entry.type === 'string'));
    assert.ok(result.continuationPaths.some((entry) => entry.path.includes('liveChatReplayContinuationData.continuation')));
    assert.ok(result.continuationTimingPaths.some((entry) => entry.path.includes('timeUntilLastMessageMsec')));
    assert.ok(result.rendererNames.includes('liveChatPaidMessageRenderer'));
    assert.ok(result.actionNames.includes('replayChatItemAction'));
    assert.ok(result.continuationDataNames.includes('liveChatReplayContinuationData'));
    const output = JSON.stringify(result);
    for (const secret of ['12345', 'channel-secret', 'tracking-secret', 'continuation-secret', 'visitor-secret', 'api-key-secret', '999', '500']) assert.equal(output.includes(secret), false);
});

test('timing classification ranks video offsets and omits UI paths from session summary', () => {
    const shape = collectResponseShape({
        actions: [{ replayChatItemAction: { timestampUsec: 'secret', videoOffsetTimeMsec: 'secret' } }],
        continuations: [{ liveChatReplayContinuationData: { timeoutMs: 42 } }],
        layout: { animationTimeMs: 99 }
    });
    assert.match(shape.replayTimingCandidates[0].path, /videoOffsetTimeMsec$/);
    assert.ok(shape.continuationTimingPaths.some((entry) => /timeoutMs$/.test(entry.path)));
    const collector = createReplayProbeCollector(); collector.enable(); collector.observeResponse({ layout: { animationTimeMs: 99 } });
    const summary = collector.summary();
    assert.equal(Object.hasOwn(summary, 'visualUiTimingPaths'), false);
    assert.equal(summary.ignoredTimingCounts.visualUi, 1);
});

test('walker deduplicates paths and enforces category, depth, array, and node bounds', () => {
    const result = collectResponseShape({ actions: [
        { replayAction: { offsetTimeMsec: 'one', nested: { deep: { deeper: { deepest: { value: 'secret' } } } } } },
        { replayAction: { offsetTimeMsec: 'two' } }
    ] }, { maxArrayItems: 1, maxDepth: 3, maxNodes: 4, maxTimingPaths: 1 });
    assert.ok(result.nodesVisited <= 4);
    assert.ok(result.replayTimingCandidates.length <= 1);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('malformed objects and strict summary size fail safe', () => {
    const malformed = new Proxy({}, { ownKeys() { throw new Error('blocked'); } });
    assert.deepEqual(collectResponseShape(malformed).responseTopLevelKeys, []);
    const collector = createReplayProbeCollector({ limits: { maxSummaryChars: 700, maxNames: 50 } }); collector.enable();
    collector.observeRequest({ url: '/live_chat_replay' });
    collector.observeResponse({ actions: [{ oneRenderer: { replayOffsetTime: 'secret' }, twoRenderer: {}, threeRenderer: {} }] });
    const summary = collector.summary();
    assert.ok(JSON.stringify(summary).length <= 700);
    assert.equal(summary.truncated.summary, true);
});

test('collector is disabled by default and deduplicates bounded summaries', () => {
    const collector = createReplayProbeCollector({ limits: { maxTimingPaths: 1, maxNames: 1, maxHistory: 2, maxSummaryChars: 5000 } });
    assert.equal(collector.observeRequest({ url: '/live_chat_replay?x=secret' }), false);
    assert.equal(collector.summary().endpoints.length, 0);
    collector.enable();
    collector.observeRequest({ url: '/live_chat_replay?x=secret', method: 'GET', headerNames: [] });
    collector.observeResponse({ actions: [{ replayAction: { offsetTimeMsec: 'secret' } }] });
    collector.observeResponse({ actions: [{ replayAction: { offsetTimeMsec: 'other' } }] });
    const summary = collector.summary();
    assert.deepEqual(summary.endpoints, [{ path: '/live_chat_replay', method: 'GET', count: 1 }]);
    assert.equal(summary.replayTimingCandidates.length, 1);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
    assert.deepEqual(summary.authPresence, { cookieSeen: 'unknown', authorizationSeen: 'unknown' });
});

test('collector reports only explicit auth header-name presence without values', () => {
    const collector = createReplayProbeCollector(); collector.enable();
    collector.observeRequest({ url: '/live_chat_replay', headerNames: ['Cookie', 'Authorization'], body: '{"token":"secret"}' });
    const summary = collector.summary();
    assert.deepEqual(summary.authPresence, { cookieSeen: true, authorizationSeen: true });
    assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('operation deltas count endpoint requests and history stays bounded', () => {
    const collector = createReplayProbeCollector({ limits: { maxHistory: 2 } }); collector.enable();
    collector.startOperation('forwardSeek');
    collector.observeRequest({ url: '/live_chat_replay' });
    collector.finishOperation('forwardSeek');
    collector.startOperation('rate20');
    collector.observeRequest({ url: '/youtubei/v1/live_chat/get_live_chat_replay', method: 'POST' });
    collector.recordVideoEvent('play'); collector.recordVideoEvent('pause'); collector.recordVideoEvent('ratechange');
    const summary = collector.summary();
    assert.equal(summary.operationDeltas.forwardSeek, 1);
    assert.equal(summary.operationDeltas.rate20, 1);
    assert.deepEqual(summary.eventHistory.map((entry) => entry.event), ['pause', 'ratechange']);
});

test('runtime is explicit opt-in, passive, bounded, and has no external output', () => {
    assert.match(runtimeSource, /function enable[\s\S]*collector\.enable\(\); installHooks\(\)/);
    assert.doesNotMatch(runtimeSource, /setInterval|requestAnimationFrame|sendBeacon|WebSocket|chrome\.storage|localStorage|sessionStorage|clipboard|innerHTML/);
    assert.equal((runtimeSource.match(/body:\s*template\.body,\s*credentials:\s*'omit'/g) || []).length, 1);
    assert.doesNotMatch(runtimeSource, /credentials:\s*['"](?:include|same-origin)['"]|Authorization\s*:|Cookie\s*:/);
    assert.match(runtimeSource, /originalFetch\.apply\(this, args\)/);
    assert.equal((runtimeSource.match(/originalFetch\.apply\(this, args\)/g) || []).length, 1);
    assert.equal((runtimeSource.match(/originalFetch\.call\(window, template\.url/g) || []).length, 1);
    assert.doesNotMatch(runtimeSource, /retry|backoff|setInterval|requestAnimationFrame/);
});

test('runtime enable is idempotent, fetch stays nonblocking, and disable restores hooks', async () => {
    let fetchCalls = 0;
    let cloneCalls = 0;
    const response = { clone() { cloneCalls += 1; return { json: async () => ({ replayAction: { videoOffsetTimeMsec: 'secret' } }) }; } };
    const originalFetch = () => { fetchCalls += 1; return Promise.resolve(response); };
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {};
    FakeXHR.prototype.send = function () {};
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.addEventListener = function () {};
    const listeners = new Map();
    const windowListeners = new Map();
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: originalFetch, frames: [], addEventListener(name, fn) { windowListeners.set(name, fn); }, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    const context = {
        window: testWindow,
        XMLHttpRequest: FakeXHR,
        Headers: class { constructor() {} keys() { return []; } },
        document: { querySelector() { return null; }, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
        console: { log() {} }, Promise, URL
    };
    vm.runInNewContext(runtimeSource, context);
    assert.equal(context.window.fetch, originalFetch);
    context.window.LiveFlowReplayProbe.enable();
    const firstHook = context.window.fetch;
    context.window.LiveFlowReplayProbe.enable();
    assert.equal(context.window.fetch, firstHook);
    const returned = context.window.fetch('/youtubei/v1/live_chat/get_live_chat_replay?key=secret', { method: 'POST', body: '{"continuation":"secret"}' });
    assert.equal(fetchCalls, 1);
    assert.equal(await returned, response);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cloneCalls, 1);
    context.window.LiveFlowReplayProbe.disable();
    assert.equal(context.window.fetch, originalFetch);
    assert.equal(FakeXHR.prototype.open.name, '');
    assert.equal(listeners.size, 0);
});

test('top probe aggregates a child-frame Replay request as shape-only data', async () => {
    function makeXHR() {
        function FrameXHR() {}
        FrameXHR.prototype.open = function () {};
        FrameXHR.prototype.send = function () {};
        FrameXHR.prototype.setRequestHeader = function () {};
        FrameXHR.prototype.addEventListener = function () {};
        return FrameXHR;
    }
    function makeDocument() { return { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} }; }
    let topMessage = null;
    let childMessage = null;
    let activeGeneration = 0;
    let childFetchCalls = 0;
    const topFetch = () => Promise.resolve({ clone() { return { json: async () => ({}) }; } });
    const childResponse = { clone() { return { json: async () => ({ continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'private-offset', item: { privateRenderer: { continuation: 'private-token' } } } }] } } }) }; } };
    const childFetch = () => { childFetchCalls += 1; return Promise.resolve(childResponse); };
    const topWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: topFetch, frames: [], addEventListener(name, fn) { if (name === 'message') topMessage = fn; } };
    const childWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: childFetch, frames: [], addEventListener(name, fn) { if (name === 'message') childMessage = fn; } };
    topWindow.top = topWindow; topWindow.parent = topWindow;
    childWindow.top = topWindow; childWindow.parent = topWindow;
    topWindow.frames.push(childWindow);
    topWindow.postMessage = (data) => topMessage?.({ data, source: childWindow });
    childWindow.postMessage = (data) => { if (data.command === 'enable') activeGeneration = data.generation; childMessage?.({ data, source: topWindow }); };
    const common = { Headers: class { keys() { return []; } }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(runtimeSource, { ...common, window: topWindow, XMLHttpRequest: makeXHR(), document: makeDocument() });
    vm.runInNewContext(runtimeSource, { ...common, window: childWindow, XMLHttpRequest: makeXHR(), document: makeDocument() });
    assert.equal(childWindow.fetch, childFetch);
    topWindow.LiveFlowReplayProbe.enable();
    assert.notEqual(childWindow.fetch, childFetch);
    const returned = childWindow.fetch('/youtubei/v1/live_chat/get_live_chat_replay?key=private-key', { method: 'POST', body: '{"continuation":"private-token","visitorData":"private-visitor","trackingParams":"private-tracking"}' });
    assert.equal(childFetchCalls, 1);
    assert.equal(await returned, childResponse);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const duplicate = { channel: 'LIVEFLOW_REPLAY_SHAPE_PROBE_V1', command: 'report', generation: activeGeneration, sequence: 1, kind: 'request', payload: { path: '/live_chat_replay', method: 'GET', requestTopLevelKeys: [] } };
    topMessage({ data: duplicate, source: childWindow });
    topMessage({ data: { ...duplicate, generation: activeGeneration - 1, sequence: 99 }, source: childWindow });
    const summary = topWindow.LiveFlowReplayProbe.summary();
    assert.deepEqual(summary.endpoints, [{ path: '/youtubei/v1/live_chat/get_live_chat_replay', method: 'POST', count: 1 }]);
    assert.equal(summary.observedFrameCount, 1);
    assert.equal(summary.replayFrameObserved, true);
    assert.ok(summary.replayTimingCandidates.some((entry) => /videoOffsetTimeMsec$/.test(entry.path)));
    const serialized = JSON.stringify(summary);
    for (const secret of ['private-key', 'private-offset', 'private-token', 'private-visitor', 'private-tracking']) assert.equal(serialized.includes(secret), false);
    topWindow.LiveFlowReplayProbe.disable();
    assert.equal(childWindow.fetch, childFetch);
});

test('credentialless diagnostic is explicit, frame-local, single-shot, and shape-only', async () => {
    function makeXHR() {
        function FrameXHR() {}
        FrameXHR.prototype.open = function () {}; FrameXHR.prototype.send = function () {}; FrameXHR.prototype.setRequestHeader = function () {}; FrameXHR.prototype.addEventListener = function () {};
        return FrameXHR;
    }
    const document = { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} };
    let topMessage;
    let childMessage;
    const activeCalls = [];
    const passiveResponse = { clone() { return { json: async () => ({}) }; }, ok: true, json: async () => ({}) };
    const diagnosticResponse = { ok: true, json: async () => ({ continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'offset-secret', item: { liveChatTextMessageRenderer: { message: { runs: [{ text: 'message-secret' }] } } } } }], continuations: [{ liveChatReplayContinuationData: { continuation: 'next-secret' } }] } } }) };
    const topFetch = () => Promise.resolve(passiveResponse);
    const childFetch = (...args) => { activeCalls.push(args); return Promise.resolve(activeCalls.length === 1 ? passiveResponse : diagnosticResponse); };
    const topWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: topFetch, frames: [], addEventListener(name, fn) { if (name === 'message') topMessage = fn; } };
    const childWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: childFetch, frames: [], addEventListener(name, fn) { if (name === 'message') childMessage = fn; } };
    topWindow.top = topWindow; topWindow.parent = topWindow; childWindow.top = topWindow; childWindow.parent = topWindow; topWindow.frames.push(childWindow);
    topWindow.postMessage = (data) => topMessage?.({ data, source: childWindow });
    childWindow.postMessage = (data) => childMessage?.({ data, source: topWindow });
    const common = { Headers: class { keys() { return []; } }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(runtimeSource, { ...common, window: topWindow, XMLHttpRequest: makeXHR(), document });
    vm.runInNewContext(runtimeSource, { ...common, window: childWindow, XMLHttpRequest: makeXHR(), document });
    assert.equal(activeCalls.length, 0);
    assert.equal(typeof topWindow.LiveFlowReplayCredentiallessDiagnostic.status, 'function');
    assert.equal(typeof topWindow.LiveFlowReplayCredentiallessDiagnostic.run, 'function');
    assert.equal(childWindow.LiveFlowReplayCredentiallessDiagnostic, undefined);
    assert.deepEqual({ ...topWindow.LiveFlowReplayCredentiallessDiagnostic.status() }, { enabled: false, ready: false, inFlight: false, lastResult: null, readyReason: 'disabled' });
    topWindow.LiveFlowReplayCredentiallessDiagnostic.status();
    assert.equal(activeCalls.length, 0);
    assert.equal((await topWindow.LiveFlowReplayCredentiallessDiagnostic.run()).requestCount, 0);
    topWindow.LiveFlowReplayProbe.enable();
    assert.equal(activeCalls.length, 0);
    assert.equal(topWindow.LiveFlowReplayCredentiallessDiagnostic.status().readyReason, 'no-replay-request');
    const requestBody = '{"context":{"client":{"visitorData":"visitor-secret"}},"continuation":"continuation-secret","trackingParams":"tracking-secret"}';
    const request = { url: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key=api-secret', method: 'POST', headers: null, clone() { return { url: this.url, method: this.method, text: async () => requestBody }; } };
    await childWindow.fetch(request);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(activeCalls.length, 1);
    assert.equal(topWindow.LiveFlowReplayCredentiallessDiagnostic.status().ready, true);
    assert.equal(topWindow.LiveFlowReplayCredentiallessDiagnostic.status().readyReason, 'template-ready');
    const result = await topWindow.LiveFlowReplayCredentiallessDiagnostic.run();
    assert.equal(activeCalls.length, 2);
    const options = activeCalls[1][1];
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'POST');
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    assert.equal(Object.hasOwn(options.headers, 'Cookie'), false);
    assert.deepEqual({ ...result }, { executed: true, credentials: 'omit', requestCount: 1, httpStatusClass: '2xx', jsonParsed: true, replayShapeObserved: true, replayTimingPathObserved: true, continuationShapeObserved: true, reason: 'COMPLETE' });
    const output = JSON.stringify(result);
    for (const secret of ['api-secret', 'visitor-secret', 'continuation-secret', 'tracking-secret', 'offset-secret', 'message-secret', 'next-secret']) assert.equal(output.includes(secret), false);
    assert.equal((await topWindow.LiveFlowReplayCredentiallessDiagnostic.run()).requestCount, 0);
    assert.equal(activeCalls.length, 2);
    topWindow.LiveFlowReplayProbe.disable();
});

test('nested Replay frame relays diagnostic readiness and the single run command without raw template data', async () => {
    function makeXHR() { function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {}; XHR.prototype.setRequestHeader = function () {}; XHR.prototype.addEventListener = function () {}; return XHR; }
    const document = { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} };
    let topMessage; let middleMessage; let leafMessage; let leafCalls = 0;
    const passiveResponse = { clone() { return { json: async () => ({ continuationContents: { liveChatContinuation: {} } }) }; } };
    const activeResponse = { ok: true, json: async () => ({ continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'private-offset' } }], continuations: [{ liveChatReplayContinuationData: { continuation: 'private-next' } }] } } }) };
    const core = require('../src/replay-schema-probe-core.js');
    const topWindow = { LiveFlowReplayProbeCore: core, fetch: () => Promise.resolve(passiveResponse), frames: [], addEventListener(name, fn) { if (name === 'message') topMessage = fn; } };
    const middleWindow = { LiveFlowReplayProbeCore: core, fetch: () => Promise.resolve(passiveResponse), frames: [], addEventListener(name, fn) { if (name === 'message') middleMessage = fn; } };
    const leafWindow = { LiveFlowReplayProbeCore: core, fetch: (...args) => { leafCalls += 1; return Promise.resolve(leafCalls === 1 ? passiveResponse : activeResponse); }, frames: [], addEventListener(name, fn) { if (name === 'message') leafMessage = fn; } };
    topWindow.top = topWindow; topWindow.parent = topWindow; middleWindow.top = topWindow; middleWindow.parent = topWindow; leafWindow.top = topWindow; leafWindow.parent = middleWindow;
    topWindow.frames.push(middleWindow); middleWindow.frames.push(leafWindow);
    topWindow.postMessage = (data) => topMessage?.({ data, source: middleWindow });
    middleWindow.postMessage = (data) => middleMessage?.({ data, source: ['enable', 'disable', 'run'].includes(data.command) ? topWindow : leafWindow });
    leafWindow.postMessage = (data) => leafMessage?.({ data, source: middleWindow });
    const common = { Headers: class { keys() { return []; } }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout, document };
    vm.runInNewContext(runtimeSource, { ...common, window: topWindow, XMLHttpRequest: makeXHR() });
    vm.runInNewContext(runtimeSource, { ...common, window: middleWindow, XMLHttpRequest: makeXHR() });
    vm.runInNewContext(runtimeSource, { ...common, window: leafWindow, XMLHttpRequest: makeXHR() });
    topWindow.LiveFlowReplayProbe.enable();
    const body = '{"context":{"client":{"visitorData":"private-visitor"}},"continuation":"private-continuation"}';
    const request = { url: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key=private-key', method: 'POST', clone() { return { url: this.url, method: this.method, text: async () => body }; } };
    await leafWindow.fetch(request); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const status = topWindow.LiveFlowReplayCredentiallessDiagnostic.status();
    assert.equal(status.ready, true); assert.equal(status.readyReason, 'template-ready'); assert.equal(leafCalls, 1);
    const result = await topWindow.LiveFlowReplayCredentiallessDiagnostic.run();
    assert.equal(result.requestCount, 1); assert.equal(result.credentials, 'omit'); assert.equal(leafCalls, 2);
    const exposed = JSON.stringify({ status, result });
    for (const secret of ['private-visitor', 'private-continuation', 'private-key', 'private-offset', 'private-next']) assert.equal(exposed.includes(secret), false);
});

test('top initialization replaces a stale Passive-only API and exposes both current APIs without a request', () => {
    let disabled = 0;
    let fetchCalls = 0;
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {}; FakeXHR.prototype.send = function () {}; FakeXHR.prototype.setRequestHeader = function () {}; FakeXHR.prototype.addEventListener = function () {};
    const staleApi = { disable() { disabled += 1; } };
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), LiveFlowReplayProbe: staleApi, fetch() { fetchCalls += 1; return Promise.resolve({}); }, frames: [], addEventListener() {}, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    const context = { window: testWindow, XMLHttpRequest: FakeXHR, Headers: class { keys() { return []; } }, document: { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(runtimeSource, context);
    assert.equal(disabled, 1);
    assert.notEqual(testWindow.LiveFlowReplayProbe, staleApi);
    assert.equal(typeof testWindow.LiveFlowReplayProbe.enable, 'function');
    assert.equal(typeof testWindow.LiveFlowReplayCredentiallessDiagnostic.status, 'function');
    assert.equal(typeof testWindow.LiveFlowReplayCredentiallessDiagnostic.run, 'function');
    assert.equal(context.LiveFlowReplayCredentiallessDiagnostic, testWindow.LiveFlowReplayCredentiallessDiagnostic);
    assert.equal(fetchCalls, 0);
    testWindow.LiveFlowReplayCredentiallessDiagnostic.status();
    testWindow.LiveFlowReplayCredentiallessDiagnostic.status();
    assert.equal(fetchCalls, 0);
});

test('credentialless diagnostic stops on non-2xx and invalid JSON without follow-up', async () => {
    for (const [response, reason, parsed] of [
        [{ ok: false, json: async () => { throw new Error('must not parse'); } }, 'HTTP_STOP', false],
        [{ ok: true, json: async () => { throw new Error('invalid'); } }, 'INVALID_JSON', false]
    ]) {
        const runtime = createTopDiagnosticRuntime(response);
        await runtime.capture();
        const result = await runtime.window.LiveFlowReplayCredentiallessDiagnostic.run();
        assert.equal(result.reason, reason); assert.equal(result.jsonParsed, parsed); assert.equal(result.requestCount, 1); assert.equal(runtime.calls(), 2);
    }
});

test('template readiness accepts only bounded HTTPS YouTube Replay POST bodies', async () => {
    const valid = createTopDiagnosticRuntime({ ok: false });
    await valid.capture();
    assert.equal(valid.window.LiveFlowReplayCredentiallessDiagnostic.status().ready, true);
    assert.equal(valid.calls(), 1);

    const cases = [
        ['http://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay', { method: 'POST', body: '{"context":{},"continuation":"secret"}' }],
        ['https://example.com/youtubei/v1/live_chat/get_live_chat_replay', { method: 'POST', body: '{"context":{},"continuation":"secret"}' }],
        ['https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay', { method: 'GET', body: '{"context":{},"continuation":"secret"}' }],
        ['https://www.youtube.com/youtubei/v1/live_chat/get_live_chat', { method: 'POST', body: '{"context":{},"continuation":"secret"}' }],
        ['https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay', { method: 'POST', body: JSON.stringify({ context: {}, continuation: 'x'.repeat(65537) }) }]
    ];
    for (const [url, options] of cases) {
        const runtime = createTopDiagnosticRuntime({ ok: false });
        await runtime.window.fetch(url, options);
        assert.equal(runtime.window.LiveFlowReplayCredentiallessDiagnostic.status().ready, false);
        assert.equal(runtime.calls(), 1);
    }
});

test('disable and detached child invalidate unconsumed readiness without a request', async () => {
    const runtime = createTopDiagnosticRuntime({ ok: false });
    await runtime.capture();
    assert.equal(runtime.window.LiveFlowReplayCredentiallessDiagnostic.status().ready, true);
    runtime.window.LiveFlowReplayProbe.disable();
    assert.equal(runtime.window.LiveFlowReplayCredentiallessDiagnostic.status().ready, false);
    assert.equal(runtime.calls(), 1);
});

test('credentialless diagnostic aborts on its bounded timeout without retry', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const runtime = createTopDiagnosticRuntime((url, options) => options.signal.aborted ? Promise.reject(abortError) : new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(abortError), { once: true })), { setTimeout(callback) { callback(); return 1; }, clearTimeout() {} });
    await runtime.capture();
    const result = await runtime.window.LiveFlowReplayCredentiallessDiagnostic.run();
    assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.httpStatusClass, 'timeout'); assert.equal(result.requestCount, 1); assert.equal(runtime.calls(), 2);
});

test('XHR Replay observation preserves callbacks and isolates non-JSON responses', () => {
    let loadHandler = null;
    let sends = 0;
    function FakeXHR() { this.responseType = ''; this.responseText = 'not-json'; }
    const originalOpen = function () {};
    const originalSend = function () { sends += 1; return 'sent'; };
    const originalHeader = function () {};
    FakeXHR.prototype.open = originalOpen; FakeXHR.prototype.send = originalSend; FakeXHR.prototype.setRequestHeader = originalHeader;
    FakeXHR.prototype.addEventListener = function (name, handler) { if (name === 'load') loadHandler = handler; };
    const listeners = new Map();
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: () => Promise.resolve({}), frames: [], addEventListener(name, fn) { listeners.set(name, fn); }, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    vm.runInNewContext(runtimeSource, {
        window: testWindow, XMLHttpRequest: FakeXHR, Headers: class { keys() { return []; } }, Promise, URL,
        document: { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} }, console: { log() {} }
    });
    testWindow.LiveFlowReplayProbe.enable();
    const xhr = new FakeXHR();
    xhr.open('POST', '/youtubei/v1/live_chat/get_live_chat_replay?key=secret');
    assert.equal(xhr.send('{"continuation":"secret"}'), 'sent');
    assert.equal(sends, 1);
    assert.doesNotThrow(() => loadHandler());
    assert.equal(testWindow.LiveFlowReplayProbe.summary().endpoints[0].count, 1);
    testWindow.LiveFlowReplayProbe.disable();
    assert.equal(FakeXHR.prototype.open, originalOpen);
    assert.equal(FakeXHR.prototype.send, originalSend);
    assert.equal(FakeXHR.prototype.setRequestHeader, originalHeader);
});

test('manifest loads passive probe in MAIN world without permission expansion', () => {
    const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN' && entry.all_frames === true);
    assert.ok(main.js.includes('src/replay-schema-probe-core.js'));
    assert.ok(main.js.includes('src/replay-schema-probe.js'));
    assert.equal(main.run_at, 'document_start');
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'background'), false);
});
