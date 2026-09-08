const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    assert.match(pageStateSource, /addEventListener\('pagehide', \(\) => \{[^]*?disconnectWatchRootObserver\(\);[^]*?stopReadLoop\(\);/);
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
    assert.match(pageStateSource, /'PAGE_STATE_REJECTED'/);
    assert.match(pageStateSource, /'READ_START_REJECTED'/);
    assert.match(contentSource, /pageTargetChanged=\$\{event\.data\.pageTargetChanged === true\}/);
    assert.match(contentSource, /bootstrapTargetMatched=\$\{event\.data\.bootstrapTargetMatched === true\}/);
    assert.match(contentSource, /responseAfterInvalidation=\$\{event\.data\.responseAfterInvalidation === true\}/);
    assert.doesNotMatch(contentSource, /READ lifecycle:[^\r\n]*(?:visitorData|message|videoId|targetIdentity)=/i);
    assert.doesNotMatch(contentSource, /READ lifecycle:[^\r\n]*continuation=\$\{/i);
});

test('new page bootstrap is not established before YouTube page data is updated', () => {
    assert.match(pageStateSource, /const hadEstablishedPage = pageKey !== '';/);
    assert.match(pageStateSource, /if \(hadEstablishedPage && !navigationPending\)/);
    assert.match(pageStateSource, /canReevaluatePageLifecycle/);
    assert.match(pageStateSource, /if \(!canReevaluate\) return;/);
    assert.match(pageStateSource, /canEstablishPageLifecycle/);
    assert.match(pageStateSource, /pageTargetChanged/);
    assert.match(pageStateSource, /bootstrapTargetMatched: bootstrapTarget\.matched/);
    assert.match(pageStateSource, /navigationTargetMatched/);
    assert.match(pageStateSource, /if \(!establishment\.ok\)[^]*?return;/);
    assert.match(pageStateSource, /navigationPending = false;/);
    assert.match(pageStateSource, /addEventListener\('yt-page-data-updated', \(\) => respond\(\{ pageDataUpdated: true, eventSource: 'yt-page-data-updated' \}\)\)/);
});

test('completed SPA state reevaluates once through existing lifecycle events without polling', () => {
    assert.match(pageStateSource, /let navigationPageDataUpdated = false;/);
    assert.match(pageStateSource, /if \(pageDataUpdated\) navigationPageDataUpdated = true;/);
    assert.match(pageStateSource, /navigationCompletionTargetIdentity === targetIdentity/);
    assert.match(runtimeSource, /ownershipMutation === true && pageDataUpdatedSeen === true/);
    assert.match(pageStateSource, /addEventListener\('yt-navigate-finish', \(event\) => respond\(\{ navigationFinished: true, eventSource: 'yt-navigate-finish', event \}\)\)/);
    assert.match(contentSource, /pageDataSeen=\$\{event\.data\.navigationPageDataUpdated === true\}/);
    assert.match(contentSource, /canReevaluate=\$\{event\.data\.canReevaluate === true\}/);
    assert.doesNotMatch(pageStateSource, /setInterval\s*\(|requestAnimationFrame\s*\(/);
});

test('duplicate lifecycle signals cannot bypass single-loop start protection', () => {
    assert.match(pageStateSource, /if \(readRequestInFlight \|\| activeLoopGeneration !== 0\)/);
    assert.match(contentSource, /readRequestedRevision === currentPageRevision/);
    assert.equal((pageStateSource.match(/addEventListener\('yt-navigate-finish'/g) || []).length, 1);
    assert.equal((pageStateSource.match(/addEventListener\('yt-page-data-updated'/g) || []).length, 1);
});

test('reused watch DOM cannot establish or start READ with a stale bootstrap target', () => {
    assert.match(pageStateSource, /const watchSnapshot = watchRoot\?\.data;/);
    assert.match(pageStateSource, /readContinuation\(watchSnapshot\)/);
    assert.match(pageStateSource, /readBootstrapTargetEvidence\(watchSnapshot, watchRoot\)/);
    assert.match(pageStateSource, /watchSnapshot\?\.currentVideoEndpoint\?\.watchEndpoint\?\.videoId/);
    assert.match(pageStateSource, /window\.ytInitialPlayerResponse\?\.videoDetails\?\.videoId/);
    assert.match(pageStateSource, /watchRoot\?\.getAttribute\?\.\('video-id'\)/);
    assert.match(pageStateSource, /bootstrapTargetEvidence\.authoritative/);
    assert.match(pageStateSource, /bootstrapTargetEvidence\.supporting/);
    assert.match(pageStateSource, /targetIdentity !== invalidatedTargetIdentity/);
    assert.match(pageStateSource, /pageState\.targetIdentity === targetIdentity/);
    assert.match(pageStateSource, /if \(!isCurrentPageStateTarget\(\)\)[^]*?break;/);
});

test('fresh authoritative bootstrap can establish B while supporting SPA candidates remain stale', () => {
    assert.match(pageStateSource, /authoritative:\s*watchSnapshot/);
    assert.match(pageStateSource, /supporting:\s*\[/);
    assert.match(contentSource, /supportingCandidates=\$\{Number\.isInteger/);
    assert.match(contentSource, /supportingMatches=\$\{Number\.isInteger/);
    assert.doesNotMatch(pageStateSource, /candidates\.every/);
});

test('watch-root mutation is a scoped reevaluation signal, never bootstrap authority', () => {
    assert.match(pageStateSource, /new MutationObserver/);
    assert.match(pageStateSource, /watchRootObserver\.observe\(watchRoot, \{/);
    assert.match(pageStateSource, /subtree:\s*true/);
    assert.match(pageStateSource, /childList:\s*true/);
    assert.match(pageStateSource, /attributeFilter:\s*\['video-id', 'hidden'\]/);
    assert.match(pageStateSource, /eventSource:\s*'watch-root-mutation'/);
    assert.match(pageStateSource, /ownershipSource:\s*'WATCH_ROOT_SNAPSHOT'/);
    assert.doesNotMatch(pageStateSource, /document\.documentElement[^]*?MutationObserver/);
});

test('observer lifecycle is generation-bound, deduplicated, rebound, and cleaned up', () => {
    assert.match(pageStateSource, /observedGeneration !== pageLifecycleGeneration/);
    assert.match(pageStateSource, /ownershipReevaluationQueued/);
    assert.match(pageStateSource, /bindWatchRootObserver\(watchRoot\)/);
    assert.match(pageStateSource, /disconnectWatchRootObserver\(\)/);
    assert.match(pageStateSource, /addEventListener\('pagehide', \(\) => \{[^]*?disconnectWatchRootObserver\(\)/);
});

test('SPA ownership requires completion target, page data, and one watch-root snapshot', () => {
    assert.match(pageStateSource, /event\?\.detail\?\.response\?\.playerResponse\?\.videoDetails\?\.videoId/);
    assert.match(pageStateSource, /navigationCompletionTargetIdentity === targetIdentity/);
    assert.match(pageStateSource, /pageDataUpdated:\s*!navigationPending \|\| navigationPageDataUpdated/);
    assert.match(pageStateSource, /ownershipSameSnapshot:\s*bootstrapTarget\.matched && Boolean\(continuation\)/);
});

test('page target values remain internal and are not sent through the bridge', () => {
    const responsePayloadStart = pageStateSource.indexOf('type: RESPONSE_TYPE');
    const responsePayloadEnd = pageStateSource.indexOf('}, window.location.origin);', responsePayloadStart);
    const responsePayload = pageStateSource.slice(responsePayloadStart, responsePayloadEnd);
    const diagnosticPayloadStart = pageStateSource.indexOf('type: LIFECYCLE_DIAGNOSTIC_TYPE');
    const diagnosticPayloadEnd = pageStateSource.indexOf('}, window.location.origin);', diagnosticPayloadStart);
    const diagnosticPayload = pageStateSource.slice(diagnosticPayloadStart, diagnosticPayloadEnd);
    assert.doesNotMatch(responsePayload, /targetIdentity/);
    assert.doesNotMatch(diagnosticPayload, /targetIdentity/);
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
