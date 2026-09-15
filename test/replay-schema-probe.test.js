const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    replayEndpoint,
    requestBodyShape,
    inspectArchiveBootstrapShape,
    collectResponseShape,
    createReplayProbeCollector
} = require('../src/replay-schema-probe-core.js');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/replay-schema-probe.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

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

test('Archive bootstrap evidence reports only fixed same-snapshot shape and type data', () => {
    const snapshot = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'private-video' } },
        contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { continuations: [
            { reloadContinuationData: { continuation: 'private-continuation' } }
        ] } } } }
    };
    assert.deepEqual(inspectArchiveBootstrapShape(snapshot), {
        watchSnapshotPresent: true,
        liveChatRendererPresent: true,
        continuationContainerPresent: true,
        continuationType: 'reloadContinuationData',
        continuationValueType: 'string',
        continuationPresent: true,
        currentTargetPresent: true,
        sameSnapshotTargetAndContinuation: true
    });
    const serialized = JSON.stringify(inspectArchiveBootstrapShape(snapshot));
    assert.equal(serialized.includes('private-video'), false);
    assert.equal(serialized.includes('private-continuation'), false);
});

test('Archive bootstrap continuation classification is allowlisted and fail-closed', () => {
    const base = (entry) => ({ contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { continuations: [entry] } } } } });
    assert.equal(inspectArchiveBootstrapShape(base({ reloadContinuationData: { continuation: 'secret' } })).continuationType, 'reloadContinuationData');
    assert.equal(inspectArchiveBootstrapShape(base({ privateDynamicData: { continuation: 'secret' } })).continuationType, 'unknown');
    assert.equal(inspectArchiveBootstrapShape(null).continuationType, 'none');
});

test('proven structured Replay bootstrap uses the existing minimal Live request shape', () => {
    const request = require('../src/chat-read-core.js').buildLiveChatReadRequest({ client: { clientName: 'WEB' } }, 'private-continuation');
    assert.deepEqual(Object.keys(request).sort(), ['context', 'continuation']);
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
    assert.equal(result.replayContinuationAndOffsetSameObservation, true);
    const output = JSON.stringify(result);
    for (const secret of ['12345', 'channel-secret', 'tracking-secret', 'continuation-secret', 'visitor-secret', 'api-key-secret', '999', '500']) assert.equal(output.includes(secret), false);
});

test('response consistency requires Replay continuation and offset in one observation', () => {
    const collector = createReplayProbeCollector(); collector.enable();
    collector.observeResponse({ continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'private' } }] } } });
    assert.equal(collector.summary().responseGenerationConsistency.replayContinuationAndOffsetObservedTogether, false);
    collector.observeResponse({ continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'private' } }], continuations: [{ liveChatReplayContinuationData: { continuation: 'private' } }] } } });
    assert.deepEqual(collector.summary().responseGenerationConsistency, { replayContinuationAndOffsetObservedTogether: true, observationCount: 1 });
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
    assert.equal((runtimeSource.match(/credentials:\s*'omit'/g) || []).length, 0);
    assert.doesNotMatch(runtimeSource, /credentials:\s*['"](?:include|same-origin)['"]|Authorization\s*:|Cookie\s*:/);
    assert.match(runtimeSource, /originalFetch\.apply\(this, args\)/);
    assert.equal((runtimeSource.match(/originalFetch\.apply\(this, args\)/g) || []).length, 1);
    assert.equal((runtimeSource.match(/originalFetch\.call\(/g) || []).length, 0);
    assert.doesNotMatch(runtimeSource, /\.clone\(\)\.text\(|diagnosticTemplate|executeCredentiallessDiagnostic/);
    assert.doesNotMatch(runtimeSource, /retry|backoff|setInterval|requestAnimationFrame/);
    assert.doesNotMatch(runtimeSource, /runStructuredDiagnostic|safeStructuredResult|LiveFlowReplayStructuredDiagnostic\s*=/);
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

test('a delayed response from an invalidated Passive generation is discarded', async () => {
    let resolveFetch;
    const responseValue = { continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: 'private' } }], continuations: [{ liveChatReplayContinuationData: { continuation: 'private' } }] } } };
    const response = { clone() { return { json: async () => responseValue }; } };
    const originalFetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {}; FakeXHR.prototype.send = function () {}; FakeXHR.prototype.setRequestHeader = function () {}; FakeXHR.prototype.addEventListener = function () {};
    const documentListeners = new Map();
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: originalFetch, frames: [], location: { pathname: '/watch' }, addEventListener() {}, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    const document = { querySelector() { return null; }, addEventListener(name, fn) { if (!documentListeners.has(name)) documentListeners.set(name, []); documentListeners.get(name).push(fn); }, removeEventListener() {} };
    vm.runInNewContext(runtimeSource, { window: testWindow, XMLHttpRequest: FakeXHR, Headers: class { keys() { return []; } }, document, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout });
    testWindow.LiveFlowReplayProbe.enable();
    const pending = testWindow.fetch('/youtubei/v1/live_chat/get_live_chat_replay', { method: 'POST' });
    documentListeners.get('yt-navigate-start').forEach((listener) => listener());
    resolveFetch(response);
    await pending; await Promise.resolve(); await Promise.resolve();
    assert.equal(testWindow.LiveFlowReplayProbe.summary().responseGenerationConsistency.replayContinuationAndOffsetObservedTogether, false);
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

test('native-template Replay diagnostic is absent and Passive observation never clones a request body', async () => {
    function makeXHR() {
        function FrameXHR() {}
        FrameXHR.prototype.open = function () {}; FrameXHR.prototype.send = function () {}; FrameXHR.prototype.setRequestHeader = function () {}; FrameXHR.prototype.addEventListener = function () {};
        return FrameXHR;
    }
    const document = { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} };
    let topMessage;
    let childMessage;
    let calls = 0;
    let bodyClones = 0;
    const passiveResponse = { clone() { return { json: async () => ({}) }; } };
    const topFetch = () => Promise.resolve(passiveResponse);
    const childFetch = () => { calls += 1; return Promise.resolve(passiveResponse); };
    const topWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: topFetch, frames: [], addEventListener(name, fn) { if (name === 'message') topMessage = fn; } };
    const childWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: childFetch, frames: [], addEventListener(name, fn) { if (name === 'message') childMessage = fn; } };
    topWindow.top = topWindow; topWindow.parent = topWindow; childWindow.top = topWindow; childWindow.parent = topWindow; topWindow.frames.push(childWindow);
    topWindow.postMessage = (data) => topMessage?.({ data, source: childWindow });
    childWindow.postMessage = (data) => childMessage?.({ data, source: topWindow });
    const common = { Headers: class { keys() { return []; } }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(runtimeSource, { ...common, window: topWindow, XMLHttpRequest: makeXHR(), document });
    vm.runInNewContext(runtimeSource, { ...common, window: childWindow, XMLHttpRequest: makeXHR(), document });
    assert.equal(calls, 0);
    assert.equal(topWindow.LiveFlowReplayCredentiallessDiagnostic, undefined);
    assert.equal(childWindow.LiveFlowReplayCredentiallessDiagnostic, undefined);
    topWindow.LiveFlowReplayProbe.enable();
    assert.equal(calls, 0);
    const request = { url: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key=api-secret', method: 'POST', headers: null, clone() { bodyClones += 1; throw new Error('request body must not be cloned'); } };
    await childWindow.fetch(request);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(bodyClones, 0);
    assert.equal(topWindow.LiveFlowReplayProbe.summary().endpoints[0].count, 1);
    topWindow.LiveFlowReplayProbe.disable();
});

test('top initialization replaces a stale Passive API and removes a legacy active Replay diagnostic', () => {
    let disabled = 0;
    let fetchCalls = 0;
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {}; FakeXHR.prototype.send = function () {}; FakeXHR.prototype.setRequestHeader = function () {}; FakeXHR.prototype.addEventListener = function () {};
    const staleApi = { disable() { disabled += 1; } };
    const testWindow = { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), LiveFlowReplayProbe: staleApi, LiveFlowReplayCredentiallessDiagnostic: { run() { throw new Error('must not run'); } }, LiveFlowReplayStructuredDiagnostic: { run() { throw new Error('must not run'); } }, fetch() { fetchCalls += 1; return Promise.resolve({}); }, frames: [], addEventListener() {}, postMessage() {} };
    testWindow.top = testWindow; testWindow.parent = testWindow;
    const context = { window: testWindow, XMLHttpRequest: FakeXHR, Headers: class { keys() { return []; } }, document: { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} }, console: { log() {} }, Promise, URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(runtimeSource, context);
    assert.equal(disabled, 1);
    assert.notEqual(testWindow.LiveFlowReplayProbe, staleApi);
    assert.equal(typeof testWindow.LiveFlowReplayProbe.enable, 'function');
    assert.equal(testWindow.LiveFlowReplayCredentiallessDiagnostic, undefined);
    assert.equal(testWindow.LiveFlowReplayStructuredDiagnostic, undefined);
    assert.equal(context.LiveFlowReplayCredentiallessDiagnostic, undefined);
    assert.equal(fetchCalls, 0);
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
