const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/chat-frame-role-main.js'), 'utf8');
const core = require('../src/chat-frame-role-core.js');

test('frame role classification uses exact document identity only', () => {
    assert.equal(core.classifyChatFramePath('/live_chat'), 'LIVE_CHAT');
    assert.equal(core.classifyChatFramePath('/live_chat_replay'), 'REPLAY_CHAT');
    for (const value of ['/watch', '/live_chat_replay/other', '', null]) assert.equal(core.classifyChatFramePath(value), 'UNSUPPORTED');
});

function setup(rolePath = '/live_chat_replay') {
    let topMessage;
    let childMessage;
    let dispatched = 0;
    let fetchCalls = 0;
    const topWindow = {
        LiveFlowChatFrameRoleCore: core, frames: [], location: { origin: 'https://www.youtube.com' },
        addEventListener(name, fn) { if (name === 'message') topMessage = fn; },
        dispatchEvent() { dispatched += 1; }, fetch() { fetchCalls += 1; }
    };
    const childWindow = {
        LiveFlowChatFrameRoleCore: core, frames: [], location: { origin: 'https://www.youtube.com', pathname: rolePath },
        addEventListener(name, fn) { if (name === 'message') childMessage = fn; }, fetch() { fetchCalls += 1; }
    };
    topWindow.top = topWindow; topWindow.parent = topWindow;
    childWindow.top = topWindow; childWindow.parent = topWindow;
    topWindow.frames.push(childWindow);
    topWindow.postMessage = (data) => topMessage?.({ data, source: childWindow, origin: 'https://www.youtube.com' });
    childWindow.postMessage = (data) => childMessage?.({ data, source: topWindow, origin: 'https://www.youtube.com' });
    const iframe = { isConnected: true, contentWindow: childWindow };
    const watchRoot = {
        isConnected: true,
        contains(node) { return node === iframe; },
        querySelectorAll(selector) { return selector === 'ytd-live-chat-frame iframe' ? [iframe] : []; }
    };
    const document = { querySelector(selector) { return selector === 'ytd-watch-flexy' ? watchRoot : null; } };
    const common = { document, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } };
    vm.runInNewContext(runtimeSource, { ...common, window: topWindow });
    vm.runInNewContext(runtimeSource, { ...common, window: childWindow });
    return {
        topWindow, childWindow, iframe, watchRoot,
        announceReady() { topMessage?.({ data: { channel: 'LIVEFLOW_CHAT_FRAME_ROLE_V1', command: 'ready' }, source: childWindow, origin: 'https://www.youtube.com' }); },
        get dispatched() { return dispatched; }, get fetchCalls() { return fetchCalls; }
    };
}

test('owned Replay frame reports current generation without generating requests', () => {
    const fixture = setup('/live_chat_replay');
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.beginGeneration(4), true);
    assert.deepEqual({ ...fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 4) }, {
        role: 'REPLAY_CHAT', ownedFramePresent: true, sourceMatchesOwnedFrame: true,
        frameConnected: true, generationCurrent: true
    });
    assert.equal(fixture.fetchCalls, 0);
    assert.equal(fixture.dispatched, 1);
});

test('Live role is accepted, while stale generation and detached ownership fail closed', () => {
    const fixture = setup('/live_chat');
    fixture.topWindow.LiveFlowChatFrameRole.beginGeneration(2);
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 2).role, 'LIVE_CHAT');
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 1).role, 'UNSUPPORTED');
    fixture.topWindow.LiveFlowChatFrameRole.beginGeneration(3);
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 3).role, 'UNSUPPORTED');
    fixture.announceReady();
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 3).role, 'LIVE_CHAT');
    fixture.iframe.isConnected = false;
    const detached = fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 3);
    assert.equal(detached.role, 'UNSUPPORTED');
    assert.equal(detached.ownedFramePresent, false);
    assert.equal(detached.sourceMatchesOwnedFrame, false);
});

test('unowned source reports and unsupported paths cannot establish a mode', () => {
    const fixture = setup('/watch');
    fixture.topWindow.LiveFlowChatFrameRole.beginGeneration(7);
    assert.equal(fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 7).role, 'UNSUPPORTED');
    fixture.iframe.contentWindow = {};
    const unowned = fixture.topWindow.LiveFlowChatFrameRole.snapshot(fixture.watchRoot, 7);
    assert.equal(unowned.role, 'UNSUPPORTED');
    assert.equal(unowned.sourceMatchesOwnedFrame, false);
});
