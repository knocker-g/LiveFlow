const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pocRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(pocRoot, 'src');
const runtimeFiles = fs.readdirSync(sourceRoot)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(sourceRoot, name));
const runtimeSource = runtimeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const pageStateSource = fs.readFileSync(path.join(sourceRoot, 'page-state-main.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(sourceRoot, 'youtube-chat.js'), 'utf8');
const readRuntimeSource = [
    'chat-read-core.js',
    'page-state-main.js',
    'youtube-chat.js'
].map((name) => fs.readFileSync(path.join(sourceRoot, name), 'utf8')).join('\n');
const manifest = JSON.parse(fs.readFileSync(path.join(pocRoot, 'manifest.json'), 'utf8'));

test('formal runtime contains no chat WRITE endpoint or WRITE message path', () => {
    assert.doesNotMatch(runtimeSource, /liveChat\/messages|POST_YOUTUBE_CHAT|SEND_TEST_MESSAGE|textMessageEvent/i);
});

test('formal runtime contains no OAuth or Authorization generation', () => {
    assert.doesNotMatch(runtimeSource, /chrome\.identity|launchWebAuthFlow|getAuthToken|oauth|youtube\.force-ssl/i);
    assert.doesNotMatch(runtimeSource, /\bAuthorization\b|\bBearer\b/i);
});

test('formal runtime contains no Cookie API or SAPISID hash access', () => {
    assert.doesNotMatch(runtimeSource, /chrome\.cookies|document\.cookie|SAPISIDHASH|\bSAPISID\b/i);
});

test('formal runtime contains no user-agent or request-header spoofing', () => {
    assert.doesNotMatch(runtimeSource, /User-Agent|Sec-CH-UA|navigator\.userAgent|declarativeNetRequest|webRequest/i);
});

test('formal runtime contains no Mobile PC-watch bootstrap workaround', () => {
    assert.doesNotMatch(runtimeSource, /GET_PC_WATCH_BOOTSTRAP|MOBILE_PC_BOOTSTRAP|requestPcWatchBootstrap|canStartMobileBootstrapRead/i);
    assert.equal(manifest.content_scripts.flatMap((script) => script.matches).some((match) => match.includes('m.youtube.com')), false);
    assert.equal(Object.hasOwn(manifest, 'background'), false);
});

test('manifest requests no extension API or cross-origin host permissions', () => {
    assert.equal(Object.hasOwn(manifest, 'permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'oauth2'), false);
});

test('READ loop does not use an interval or permit a duplicate active loop', () => {
    assert.doesNotMatch(pageStateSource, /setInterval\s*\(/);
    assert.match(pageStateSource, /canStartReadLoop/);
    assert.match(pageStateSource, /requestInFlight: readRequestInFlight/);
    assert.match(pageStateSource, /while \(generation === currentLoopGeneration && revision === pageRevision &&\s*lifecycleGeneration === pageLifecycleGeneration && !navigationPending && continuation\)/);
});

test('navigation and pagehide invalidate or abort stale READ work', () => {
    assert.match(pageStateSource, /if \(revisionState\?\.changed[^]*?stopReadLoop\(\)/);
    assert.match(pageStateSource, /activeAbortController\.abort\(\)/);
    assert.match(pageStateSource, /function invalidatePageLifecycle\(eventSource = 'yt-navigate-start'\)[^]*?stopReadLoop\(\)/);
    assert.match(pageStateSource, /addEventListener\('yt-navigate-start', \(\) => invalidatePageLifecycle\('yt-navigate-start'\)\)/);
    assert.match(pageStateSource, /addEventListener\('pagehide', stopReadLoop\)/);
    assert.match(pageStateSource, /addEventListener\('visibilitychange'/);
    assert.match(pageStateSource, /if \(document\.hidden\) stopReadLoop\(\)/);
    assert.match(contentSource, /addEventListener\('yt-navigate-finish', detectPage\)/);
});

test('SPA lifecycle prevents delayed old-page requests and responses from restarting READ', () => {
    assert.match(pageStateSource, /pageLifecycleGeneration \+= 1/);
    assert.match(pageStateSource, /navigationPending = true/);
    assert.match(pageStateSource, /requestedLifecycleGeneration !== pageLifecycleGeneration \|\| navigationPending/);
    assert.match(pageStateSource, /lifecycleGeneration === pageLifecycleGeneration && !navigationPending/);
    assert.match(pageStateSource, /postReadResult\(result, lifecycleGeneration\)/);
    assert.match(contentSource, /event\.data\.pageLifecycleGeneration !== currentPageLifecycleGeneration/);
});

test('safe lifecycle diagnostics distinguish abort, stale response, and new generation without page values', () => {
    assert.match(pageStateSource, /'NAV_INVALIDATE'/);
    assert.match(pageStateSource, /'NEW_PAGE_STATE'/);
    assert.match(pageStateSource, /'READ_START'/);
    assert.match(pageStateSource, /'READ_REQUEST_BEGIN'/);
    assert.match(pageStateSource, /'READ_RESPONSE_RECEIVED'/);
    assert.match(pageStateSource, /'READ_STOP'/);
    assert.match(contentSource, /responseAfterInvalidation=\$\{event\.data\.responseAfterInvalidation === true\}/);
    assert.doesNotMatch(contentSource, /READ lifecycle:[^\r\n]*(?:continuation|visitorData|message|videoId)/i);
});

test('new page bootstrap is not established before YouTube page data is updated', () => {
    assert.match(pageStateSource, /const hadEstablishedPage = pageKey !== '';/);
    assert.match(pageStateSource, /if \(hadEstablishedPage && !navigationPending\)/);
    assert.match(pageStateSource, /if \(navigationPending && !pageDataUpdated\) return;/);
    assert.match(pageStateSource, /if \(pageDataUpdated\) navigationPending = false;/);
    assert.match(pageStateSource, /addEventListener\('yt-page-data-updated', \(\) => respond\(\{ pageDataUpdated: true \}\)\)/);
});

test('a new lifecycle start signal waits for an aborted old request to settle without parallel READ', () => {
    assert.match(pageStateSource, /if \(readRequestInFlight \|\| activeLoopGeneration !== 0\) \{\s*deferredReadStartGeneration = requestedLifecycleGeneration;/);
    assert.match(pageStateSource, /deferredGeneration === pageLifecycleGeneration && !navigationPending/);
    assert.match(pageStateSource, /window\.queueMicrotask\(\(\) => startReadLoop\(deferredGeneration\)\)/);
});

test('unexpected READ response structure stops instead of polling again', () => {
    assert.match(pageStateSource, /errorType: 'invalid_json'/);
    assert.match(pageStateSource, /validateLiveChatReadResponse/);
    assert.match(pageStateSource, /validationOk: Boolean\(result\?\.ok\)/);
    assert.match(pageStateSource, /errorType: 'parser_exception'/);
});

test('runtime has no retry, backoff, Retry-After, or timeout fallback polling', () => {
    assert.doesNotMatch(runtimeSource, /Retry-After|exponential|backoff|\bretry\b/i);
    assert.doesNotMatch(pageStateSource, /fallbackMs|\|\|\s*1000/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('READ uses the unchanged endpoint without ambient credentials', () => {
    assert.match(pageStateSource, /fetch\('\/youtubei\/v1\/live_chat\/get_live_chat\?prettyPrint=false'/);
    assert.match(pageStateSource, /headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\}/);
    assert.match(pageStateSource, /body:\s*JSON\.stringify\(requestBody\)/);
    assert.match(runtimeSource, /return\s*\{\s*context,\s*continuation\s*\}/);
    assert.match(pageStateSource, /credentials:\s*'omit'/);
    assert.doesNotMatch(pageStateSource, /credentials:\s*'include'/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('timer is generation-bound and cancelled during loop stop', () => {
    assert.match(pageStateSource, /window\.clearTimeout\(activeWaitTimer\)/);
    assert.match(pageStateSource, /resolve\(generation === currentLoopGeneration\)/);
});

test('PC Web eligibility is independent of viewport width', () => {
    assert.doesNotMatch(readRuntimeSource, /innerWidth|outerWidth|screen\.width|matchMedia\s*\(/);
    assert.match(contentSource, /youtube\\\.com\\\/\(\?:watch\|live\)/);
});

test('formal runtime has no proxy, restriction-bypass, or external telemetry path', () => {
    assert.doesNotMatch(runtimeSource, /proxy|rotate(?:Ip|IP)|bypass|telemetry|analytics|sendBeacon/i);
    assert.doesNotMatch(runtimeSource, /https?:\/\/(?!www\.youtube\.com)/i);
});

test('Native Chat layout remains DOM-only and does not affect READ or browser privileges', () => {
    const source = ['native-chat-layout-core.js', 'native-chat-layout.js']
        .map((name) => fs.readFileSync(path.join(sourceRoot, name), 'utf8').replace(/\r\n/g, '\n'))
        .join('\n---\n');
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|chrome\.|credentials|Authorization|Cookie/i);
    assert.doesNotMatch(source, /contentDocument|contentWindow|setInterval\s*\(/);
});
