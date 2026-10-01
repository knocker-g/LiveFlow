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

test('manifest requests only storage and no cross-origin host permissions', () => {
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'oauth2'), false);
});

test('READ loop does not use an interval or permit a duplicate active loop', () => {
    assert.doesNotMatch(pageStateSource, /setInterval\s*\(/);
    assert.match(pageStateSource, /canStartReadLoop/);
    assert.match(pageStateSource, /requestInFlight: readRequestInFlight/);
    assert.match(pageStateSource, /while \(generation === currentLoopGeneration && revision === pageRevision &&\s*lifecycleGeneration === pageLifecycleGeneration && !navigationPending &&\s*\(continuation \|\| currentRequestGrant \|\| nextSequentialAuthority\)\)/);
});

test('navigation and pagehide invalidate or abort stale READ work', () => {
    assert.match(pageStateSource, /if \(revisionState\?\.changed[^]*?stopReadLoop\('navigation'\)/);
    assert.match(pageStateSource, /activeAbortController\.abort\(\)/);
    assert.match(pageStateSource, /function invalidatePageLifecycle\(eventSource = 'yt-navigate-start'\)[^]*?stopReadLoop\('navigation'\)/);
    assert.match(pageStateSource, /addEventListener\('yt-navigate-start', \(\) => invalidatePageLifecycle\('yt-navigate-start'\)\)/);
    assert.match(pageStateSource, /addEventListener\('pagehide', \(\) => \{[^]*?disconnectWatchRootObserver\(\);[^]*?stopReadLoop\('pagehide'\);/);
    assert.match(pageStateSource, /addEventListener\('visibilitychange'/);
    assert.match(pageStateSource, /if \(document\.hidden\) \{\s*if \(pageState\.mode === 'replay'\) enterReplaySuspended\('HIDDEN'\)/);
    assert.match(contentSource, /addEventListener\('yt-navigate-finish', detectPage\)/);
});

test('credentialless Replay schema diagnostic is passive, single-observation, and generation-bound', () => {
    assert.match(pageStateSource, /LiveFlowReplayCredentiallessSchemaDiagnostic = Object\.freeze/);
    assert.match(pageStateSource, /inspectOwnReplayResponseForPlayerSeek\(payload, \{ mode, revision, generation, abortController \}\)/);
    assert.match(pageStateSource, /canAcceptReplaySchemaDiagnostic/);
    assert.match(pageStateSource, /armedLifecycleGeneration: diagnostic\.lifecycleGeneration/);
    assert.match(pageStateSource, /currentLifecycleGeneration: pageLifecycleGeneration/);
    assert.match(pageStateSource, /currentReadGeneration: currentLoopGeneration/);
    assert.match(pageStateSource, /aborted: abortController\?\.signal\?\.aborted === true/);
    assert.match(pageStateSource, /if \(!diagnostic\.armed \|\| diagnostic\.observed\) return false/);
    assert.match(pageStateSource, /invalidateReplayCredentiallessSchemaDiagnostic\(\);[^]*stopReadLoop\('user-disabled'\)/);
    assert.match(pageStateSource, /function invalidatePageLifecycle[^]*invalidateReplayCredentiallessSchemaDiagnostic\(\)/);
    assert.match(pageStateSource, /arm\(\) \{\s*invalidateReplayCredentiallessSchemaDiagnostic\(\)/);
    assert.match(pageStateSource, /return Object\.freeze\(\{ armed: state\.armed === true, observed: state\.observed === true, result: state\.result \}\)/);
    const statusFunction = pageStateSource.match(/function replayCredentiallessSchemaDiagnosticStatus\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(statusFunction, /continuation|targetIdentity|response|videoId/i);
    assert.doesNotMatch(statusFunction, /playerOffsetMs|playerSeekContinuationData|fetch\s*\(/);
    const replayFetches = pageStateSource.match(/fetch\(mode === 'replay' \? '\/youtubei\/v1\/live_chat\/get_live_chat_replay\?prettyPrint=false'/g) || [];
    assert.equal(replayFetches.length, 1);
});

test('player-seek Active Gate is explicit, single-use, credentialless, and mutually exclusive', () => {
    assert.match(pageStateSource, /LiveFlowReplayPlayerSeekActiveDiagnostic = Object\.freeze/);
    assert.match(pageStateSource, /function capturePlayerSeekDiagnosticAuthority/);
    assert.match(pageStateSource, /arm\(\) \{\s*abortReplayPlayerSeekDiagnostic\(\)/);
    assert.match(pageStateSource, /diagnostic\.consumed = true;[^]*diagnostic\.continuation = '';/);
    assert.match(pageStateSource, /if \(!canRun\) \{[^]*getPlayerSeekDiagnosticNotSentReason[^]*return replayPlayerSeekDiagnosticNotSentStatus\(reason\)/);
    assert.match(pageStateSource, /if \(replayPlayerSeekDiagnosticLock \|\| replayReanchorLock\) break/);
    assert.match(pageStateSource, /replayPlayerSeekDiagnosticLock = true;[^]*currentLoopGeneration \+= 1;[^]*activeLoopGeneration = 0;[^]*deferredReadStartGeneration = null/);
    assert.match(pageStateSource, /productionRequestInFlight: readRequestInFlight/);
    assert.match(pageStateSource, /credentials: 'omit', signal: controller\.signal/);
    assert.match(pageStateSource, /window\.setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, 12000\)/);
    assert.match(pageStateSource, /finally \{[^]*finalizePlayerSeekDiagnosticState[^]*replayPlayerSeekDiagnosticLock = false/);
    const activeDiagnosticApi = pageStateSource.slice(pageStateSource.indexOf('window.LiveFlowReplayPlayerSeekActiveDiagnostic'));
    const activeDiagnostic = activeDiagnosticApi.slice(activeDiagnosticApi.indexOf('async run()'));
    const finalizerIndex = activeDiagnostic.indexOf('finally {');
    const finalStatusIndex = activeDiagnostic.indexOf('return replayPlayerSeekDiagnosticStatus();', finalizerIndex);
    assert.ok(finalizerIndex >= 0 && finalStatusIndex > finalizerIndex);
    assert.equal(activeDiagnostic.slice(0, finalizerIndex).includes('return replayPlayerSeekDiagnosticStatus();'), false);
    assert.match(pageStateSource, /invalidatePageLifecycle[^]*abortReplayPlayerSeekDiagnostic\(\)/);
    assert.match(pageStateSource, /function stopReadLoop[^]*\['user-disabled', 'visibility-hidden', 'pagehide', 'navigation'\]\.includes\(reason\)[^]*abortReplayPlayerSeekDiagnostic\(\)/);
    assert.doesNotMatch(pageStateSource, /\['seek', 'playback-paused'[^]*abortReplayPlayerSeekDiagnostic/);
    assert.doesNotMatch(pageStateSource, /function restartReplayFromCurrentPosition[^]*replayPlayerSeekDiagnostic\.armed && replayPlayerSeekDiagnostic\.ready[^]*pageState\.mode === 'replay'\) return/);
    assert.doesNotMatch(pageStateSource, /LiveFlowReplayPlayerSeekActiveDiagnostic[^]*retry|LiveFlowReplayPlayerSeekActiveDiagnostic[^]*backoff/i);
    const statusFunction = pageStateSource.match(/function replayPlayerSeekDiagnosticStatus\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(statusFunction, /continuation|playerOffsetMs|targetIdentity|videoId|requestBody|response/i);
    assert.match(pageStateSource, /function emptyPlayerSeekResult\(\)[^]*requestAttempted: false/);
});

test('Production Replay re-anchor is trigger-bounded, single-use, exclusive, and fail-closed', () => {
    assert.match(pageStateSource, /function captureReplaySeekAuthority\([^]*?extractPlayerSeekContinuation[^]*?createReplayAuthority[^]*?kind: 'REANCHOR'[^]*?provenance: 'ADAPTER_REANCHOR'/);
    assert.match(pageStateSource, /if \(mode === 'replay' && allowProductionAuthorityCapture\) captureReplaySeekAuthority\(payload/);
    assert.match(pageStateSource, /authorizeReplayAuthority\([^]*replaySeekAuthority,[^]*'REANCHOR'[^]*currentReplayAuthorityBinding\(pageLifecycleGeneration\)/);
    assert.match(pageStateSource, /claimAuthorityRequestGrant\?\.\(reanchorGrant, 'REANCHOR'\)/);
    assert.doesNotMatch(pageStateSource, /replaySeekAuthority\.(?:continuation|consumed)|authority\.continuation/);
    assert.match(pageStateSource, /if \(readRequestInFlight\) return false/);
    assert.match(pageStateSource, /replayReanchorLock = true;[^]*?readRequestInFlight = true;[^]*?finally \{[^]*?readRequestInFlight = false;[^]*?replayReanchorLock = false/);
    assert.match(pageStateSource, /performRead\(claimed\.opaqueToken, pageState\.context[^]*?'replay', playerOffsetMs\)/);
    assert.match(pageStateSource, /requestBody\.currentPlayerState = \{ playerOffsetMs \}/);
    assert.match(pageStateSource, /credentials: 'omit'/);
    assert.match(pageStateSource, /queueReplayReanchor\('SEEK'/);
    assert.match(pageStateSource, /reason === 'SEEK' && epoch === replayLastAttemptedSeekEpoch/);
    assert.match(pageStateSource, /if \(intent\.reason === 'SEEK'\) replayLastAttemptedSeekEpoch = intent\.epoch/);
    assert.match(pageStateSource, /queueReplayReanchor\('AD_EXIT'/);
    assert.doesNotMatch(pageStateSource, /queueReplayReanchor\('AD_ENTER'/);
    assert.match(pageStateSource, /freshSequentialAuthority[^]*createSequentialAuthorityCandidate[^]*authorizeSequentialAuthority\([^]*freshSequentialAuthority[^]*startReadLoop\(pageLifecycleGeneration, 'PLAYER_SEEK_HANDOFF', sequentialGrant\)/);
    const reanchorFunction = pageStateSource.match(/async function runQueuedReplayReanchor\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(reanchorFunction, /fallback|retry|backoff|pageState\.continuation/);
    assert.doesNotMatch(reanchorFunction, /console\.|localStorage|sessionStorage|postMessage/);
    assert.match(pageStateSource, /relation !== 'CROSSES_TARGET' && relation !== 'ALL_NEAR_OR_AFTER_TARGET'/);
    assert.match(pageStateSource, /relation === 'ALL_BEFORE_TARGET' \? 'reanchor_relation_all_before' : 'reanchor_relation_unknown'/);
    const relationGateIndex = pageStateSource.indexOf("relation !== 'CROSSES_TARGET'");
    const productionCaptureIndex = pageStateSource.indexOf('captureReplaySeekAuthority(payload', relationGateIndex);
    assert.ok(relationGateIndex >= 0 && productionCaptureIndex > relationGateIndex);
    assert.match(pageStateSource, /result\?\.errorType === 'reanchor_relation_all_before'[^]*?replayProductionReanchorReason = 'RELATION_ALL_BEFORE'/);
    assert.match(pageStateSource, /LiveFlowReplayProductionReanchorDiagnostic = Object\.freeze/);
    const productionDiagnostic = pageStateSource.slice(pageStateSource.indexOf('window.LiveFlowReplayProductionReanchorDiagnostic'), pageStateSource.indexOf('window.LiveFlowReplayCredentiallessSchemaDiagnostic'));
    assert.doesNotMatch(productionDiagnostic, /continuation|playerOffsetMs|targetIdentity|videoId|requestBody|responseBody/);
});

test('Replay seek intents coalesce by epoch and ad enter never uses ad currentTime', () => {
    assert.match(pageStateSource, /if \(!replaySeekInProgress\) \{\s*replaySeekInProgress = true;\s*replaySeekNeedsReanchor = true;\s*replaySeekEpoch \+= 1/);
    assert.match(pageStateSource, /intent\.reason !== 'SEEK' \|\| \(!replaySeekInProgress && intent\.epoch === replaySeekEpoch\)/);
    assert.match(pageStateSource, /event\.data\.type === REPLAY_AD_ENTER_TYPE[^]*?enterReplaySuspended\('AD'\)/);
    assert.match(pageStateSource, /pageState\.mode === 'replay' && !replayAdActive/);
    assert.match(pageStateSource, /replayAdActive && pageState\.mode === 'replay'[^]*?replayAdActive = false/);
    assert.doesNotMatch(pageStateSource.match(/event\.data\.type === REPLAY_AD_ENTER_TYPE[^]*?return;/)?.[0] || '', /currentTime|queueReplayReanchor/);
    assert.match(pageStateSource, /replayAdExitNeedsReanchor = true;[^]*observeReplayControlShadow\('AD_EXIT_READY'[^]*settleReplayAdExit\(\)/);
    assert.match(pageStateSource, /if \(!mediaReady \|\| playerOffsetMs === null\) \{[^]*?if \(intent\.reason !== 'AD_EXIT'/);
    assert.match(pageStateSource, /addEventListener\('playing', settleReplayAdExit, true\)/);
    assert.match(pageStateSource, /addEventListener\('canplay', settleReplayAdExit, true\)/);
    assert.match(pageStateSource, /addEventListener\('loadeddata', settleReplayAdExit, true\)/);
    assert.match(pageStateSource, /replayReanchorIntent\?\.reason === 'AD_EXIT' && replayReanchorIntent\.video !== video\) replayReanchorIntent = null/);
});

test('ad exit does not consume re-anchor authority before a main-media readiness event', () => {
    assert.match(pageStateSource, /function queueReplayReanchor\(reason, epoch, video, waitForMediaEvent = false\)/);
    assert.match(pageStateSource, /if \(!waitForMediaEvent\) window\.queueMicrotask\(\(\) => runQueuedReplayReanchor/);
    assert.match(pageStateSource, /queueReplayReanchor\('AD_EXIT', replaySeekEpoch, video, true\)/);
    assert.match(pageStateSource, /addEventListener\('playing', settleReplayAdExit, true\)/);
    assert.match(pageStateSource, /addEventListener\('canplay', settleReplayAdExit, true\)/);
    assert.match(pageStateSource, /addEventListener\('loadeddata', settleReplayAdExit, true\)/);
});

test('foreground resume is one-shot, presentation-independent, generation-bound, and ownership validated', () => {
    assert.match(contentSource, /function handleVisibilityChange\(\)[^]*?if \(document\.hidden\)[^]*?cleanupOverlay\(\)[^]*?if \(!isYouTubeWatchPage\(\)\) return/);
    assert.match(contentSource, /type: RESUME_READ_LOOP_TYPE[^]*?pageLifecycleGeneration: currentPageLifecycleGeneration[^]*?userEnabled: true/);
    assert.match(pageStateSource, /stopReason: readStopReason/);
    assert.match(pageStateSource, /targetMatched: target\?\.matched === true && pageState\.targetIdentity === targetIdentity/);
    assert.match(pageStateSource, /continuationAvailable: Boolean\(continuation\)/);
    assert.match(pageStateSource, /currentWatchRoot = Boolean\(watchRoot\?\.isConnected/);
    assert.match(pageStateSource, /if \(accepted\) readStopReason = 'none'/);
    assert.match(pageStateSource, /readRequestInFlight\) \{\s*deferredVisibilityResumeGeneration = requestedLifecycleGeneration/);
    assert.match(pageStateSource, /window\.queueMicrotask\(\(\) => resumeReadAfterVisibility\(deferredVisibilityGeneration, true\)\)/);
    assert.doesNotMatch(pageStateSource + contentSource, /setInterval\s*\(|requestAnimationFrame\s*\(/);
});

test('foreground resume reopens the existing content READ bridge before requesting recovery', () => {
    const visibilityHandler = contentSource.match(/function handleVisibilityChange\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(visibilityHandler, /if \(!isYouTubeWatchPage\(\)\) return;[^]*?acceptingReadResults = true;[^]*?type: RESUME_READ_LOOP_TYPE/);
    assert.doesNotMatch(visibilityHandler, /requestReadOnce\s*\(/);
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
    assert.match(pageStateSource, /if \(!canReevaluate\) return false;/);
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
    assert.match(pageStateSource, /if \(readRequestInFlight \|\| activeLoopGeneration !== 0 \|\| replayReanchorLock\)/);
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
    assert.match(pageStateSource, /pageEstablished:\s*establishedTargetIdentity\.length > 0/);
    assert.match(runtimeSource, /return pageEstablished !== true/);
    assert.match(pageStateSource, /const stillCanSignalReevaluation = [^]*?if \(!stillCanSignalReevaluation \|\| observedGeneration !== pageLifecycleGeneration/);
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
    assert.match(pageStateSource, /if \(readRequestInFlight \|\| activeLoopGeneration !== 0 \|\| replayReanchorLock\) \{[^]*deferredReadStartGeneration = requestedLifecycleGeneration;/);
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

test('Live and Replay READ use only their explicit endpoints without ambient credentials', () => {
    assert.match(pageStateSource, /'\/youtubei\/v1\/live_chat\/get_live_chat\?prettyPrint=false'/);
    assert.match(pageStateSource, /'\/youtubei\/v1\/live_chat\/get_live_chat_replay\?prettyPrint=false'/);
    assert.match(pageStateSource, /headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\}/);
    assert.match(pageStateSource, /body:\s*JSON\.stringify\(requestBody\)/);
    assert.match(runtimeSource, /return\s*\{\s*context,\s*continuation\s*\}/);
    assert.match(pageStateSource, /credentials:\s*'omit'/);
    assert.doesNotMatch(pageStateSource, /credentials:\s*'include'/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('Production mode prefers the watch snapshot and uses owned frame role only as fallback', () => {
    const roleSource = fs.readFileSync(path.join(sourceRoot, 'chat-frame-role-main.js'), 'utf8');
    assert.match(roleSource, /event\.source !== window\.parent/);
    assert.match(roleSource, /frame\.contentWindow === event\.source|reports\.get\(frame\.contentWindow\)/);
    assert.match(roleSource, /watchRoot\.contains\(frame\)/);
    assert.match(roleSource, /report\?\.generation === expectedGeneration/);
    assert.match(pageStateSource, /classifyInitialChatMode\?\.\(watchSnapshot\)/);
    assert.match(pageStateSource, /frameRole\.role === 'LIVE_CHAT'/);
    assert.match(pageStateSource, /frameRole\.role === 'REPLAY_CHAT'/);
    assert.match(pageStateSource, /sourceMatchesOwnedFrame === true/);
    assert.match(pageStateSource, /frameConnected === true/);
    assert.match(pageStateSource, /generationCurrent === true/);
    assert.doesNotMatch(readRuntimeSource, /isLiveContent|isLiveNow/);
    assert.doesNotMatch(roleSource, /fetch\s*\(|XMLHttpRequest|MutationObserver|setInterval|requestAnimationFrame/);
});

test('Replay production lifecycle is video-time synchronized, bounded, and generation-bound', () => {
    assert.match(pageStateSource, /REPLAY_MAX_PENDING = 100/);
    assert.match(pageStateSource, /REPLAY_REQUEST_TIMEOUT_MS = 15000/);
    assert.match(pageStateSource, /credentials:\s*'omit'/);
    assert.match(pageStateSource, /replayPending = replayPending\.concat\(result\.messages\);/);
    assert.match(pageStateSource, /selectBoundedReplayDueMessages\?\.\([^]*REPLAY_MAX_PENDING/);
    assert.doesNotMatch(pageStateSource, /replayPending\.concat\(result\.messages\)\.slice\(-REPLAY_MAX_PENDING\)/);
    assert.match(pageStateSource, /replayAcquisitionPausedForBuffer[^]*?replayPending\.length <= Math\.floor\(REPLAY_MAX_PENDING \/ 2\)[^]*?replayPausedSequentialAuthority[^]*?authorizeSavedSequentialResume\(\)[^]*?startReadLoop\(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant\)/);
    assert.match(pageStateSource, /replayPending\.length >= REPLAY_MAX_PENDING[^]*bufferPauseReason = 'COUNT_PRESSURE'/);
    assert.match(pageStateSource, /classifyReplayBufferPauseState[^]*pendingCount: replayPending\.length[^]*nearestFutureClass: replayPipelineDiagnostic\.nearestFutureClass/);
    assert.match(pageStateSource, /evaluateReplayBufferEarlyResume/);
    assert.match(pageStateSource, /earlyResumeSuppressionState: 'CLEAR'/);
    assert.match(pageStateSource, /'USED_WAITING_FOR_LOW_WATERMARK'/);
    assert.match(pageStateSource, /pendingCount: replayPending\.length[^]*dueCount: selection\.due\.length[^]*schedulerPendingCount: replayPipelineDiagnostic\.pendingCurrent/);
    assert.match(pageStateSource, /nearestFutureClass: replayPipelineDiagnostic\.nearestFutureClass/);
    assert.match(pageStateSource, /window\.queueMicrotask\(\(\) => startReadLoop\(pageLifecycleGeneration, 'BUFFER_EARLY_RESUME', requestGrant\)\)/);
    assert.match(pageStateSource, /authorizeSavedSequentialResume\(\)[^]*replayPausedSequentialAuthority = null[^]*replayEarlyResumeSuppressionState[^]*startReadLoop\(pageLifecycleGeneration, 'BUFFER_EARLY_RESUME', requestGrant\)/);
    assert.match(pageStateSource, /LOW_WATERMARK_REACHED/);
    assert.match(pageStateSource, /COUNT_PRESSURE_PAUSED/);
    assert.match(pageStateSource, /maxObservedSequentialInFlight/);
    assert.match(pageStateSource, /function createSequentialAuthorityCandidate[^]*createReplayAuthority\?\.\(\{[^]*kind: 'SEQUENTIAL'[^]*provenance: 'ADAPTER_SEQUENTIAL'/);
    assert.match(pageStateSource, /currentReplayAuthorityBinding\([^]*lifecycleId: pageLifecycleGeneration[^]*revision: pageRevision[^]*targetId: pageState\.targetIdentity[^]*generation/);
    assert.match(pageStateSource, /!navigationPending[^]*!replayAdActive[^]*!replaySeekInProgress/);
    assert.match(pageStateSource, /replayReanchorLock \|\| replayPlayerSeekDiagnosticLock/);
    assert.match(pageStateSource, /function stopReadLoop\([^]*replayEarlyResumeSuppressionState = 'CLEAR'/);
    assert.match(pageStateSource, /function startReplayBootstrap[^]*authorizeReplayAuthority\(replayBootstrapAuthority, 'BOOTSTRAP'/);
    assert.doesNotMatch(pageStateSource, /replayBootstrapConsumedLifecycleGeneration/);
    assert.doesNotMatch(pageStateSource, /deferredReplayReadStart|deferredReplay\.continuation/);
    assert.match(pageStateSource, /if \(pageState\.mode === 'replay'\) startReplayBootstrap\(event\.data\.pageLifecycleGeneration\)/);
    assert.match(pageStateSource, /replayStartAuthority\?\.allowed !== true[^]*FAILED_CLOSED/);
    assert.match(pageStateSource, /normalResume\?\.eligible === true[^]*authorizeSavedSequentialResume\(\)[^]*startReadLoop\(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant\)/);
    assert.match(pageStateSource, /selectBoundedReplayDueMessages\?\.\([^]*replayPending, video\.currentTime, replayStartTimeSeconds, REPLAY_MAX_PENDING/);
    assert.match(pageStateSource, /addEventListener\('pause'[^]*?suspendReplayForMediaPause\(\)/);
    assert.match(pageStateSource, /addEventListener\('seeking'[^]*?stopReplayContext\('seek'\)/);
    assert.doesNotMatch(pageStateSource, /credentials:\s*'include'|Retry-After|\bretry\b|\bbackoff\b/i);
    assert.match(contentSource, /launchGapClass: 'NONE'[^]*launchGapCause: 'UNKNOWN'/);
    assert.match(contentSource, /staleAfterCollision[^]*staleAfterPacing[^]*staleAfterSelectionMiss[^]*staleAlreadyOnEnqueue/);
    assert.doesNotMatch(contentSource.match(/function createReplaySchedulerDiagnostic\(\) \{[^]*?\n    \}/)?.[0] || '', /\b(?:comment|offset|timestamp|continuation|geometry)\s*:/i);
});

test('Replay media context changes clear display state and restart only from current video time', () => {
    assert.match(contentSource, /function handleReplayMediaContextChange[^]*?currentMessages = \[\];[^]*?cleanupOverlay\(\)/);
    assert.match(contentSource, /addEventListener\('pause', handleReplayMediaContextChange, true\)/);
    assert.match(contentSource, /addEventListener\('seeking', handleReplayMediaContextChange, true\)/);
    assert.match(contentSource, /addEventListener\('ratechange', handleReplayMediaContextChange, true\)/);
    assert.match(pageStateSource, /function stopReplayContext[^]*?stopReadLoop\(reason\)/);
    assert.match(pageStateSource, /addEventListener\('seeked', restartReplayFromCurrentPosition, true\)/);
    assert.match(pageStateSource, /canRestartReplayAtCurrentPosition/);
    assert.doesNotMatch(pageStateSource, /replayBatchIsEntirelyStale\(result\.messages[^]*?break/);
});

test('Replay visual duration uses playbackRate without changing Live duration selection', () => {
    assert.match(contentSource, /currentChatMode === 'replay' \? video\.playbackRate : 1/);
    assert.match(contentSource, /calculateReplayPlaybackRateFactor\(playbackRate\)/);
    assert.match(contentSource, /minSpeed: phase5Tuning\.minimumSpeed \* playbackRate/);
    assert.match(contentSource, /maxSpeed: phase5Tuning\.maximumSpeed \* playbackRate/);
});

test('Replay restart diagnostics expose only fixed enums, booleans, and buckets without another fetch', () => {
    assert.match(pageStateSource, /window\.LiveFlowReplayRestartDiagnostic = Object\.freeze/);
    assert.match(pageStateSource, /restartReason:[^]*restartStage:[^]*runtimeEnabled:[^]*pendingCountBucket:[^]*restartElapsedBucket:[^]*continuationAdvanceBucket:/);
    assert.match(pageStateSource, /'LT_1S'[^]*'1_TO_3S'[^]*'3_TO_10S'[^]*'GT_10S'/);
    assert.match(pageStateSource, /'ZERO'[^]*'ONE'[^]*'TWO_TO_FIVE'[^]*'GT_FIVE'/);
    assert.match(contentSource, /type: REPLAY_DISPLAYED_TYPE, pageLifecycleGeneration: currentPageLifecycleGeneration/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('Replay post-reanchor pipeline diagnostic is shape-only, seek-scoped, and request-neutral', () => {
    assert.match(pageStateSource, /function createReplayPipelineDiagnostic\(\)[^]*responsesObserved: 0[^]*messagesObserved: 0[^]*timingFiltered: 0[^]*timingPending: 0[^]*timingCapacityDropped: 0[^]*replayPendingPromoted: 0[^]*replayPendingFlushCalls: 0[^]*ownedVideoTimeupdateObserved: 0[^]*pendingGenerationMismatch: 0[^]*bridged: 0[^]*enqueued: 0[^]*launched: 0[^]*firstLaunchObserved: false/);
    assert.match(pageStateSource, /function observeReplayPipelineResponse\(result\)[^]*result\.messages\.length/);
    assert.match(pageStateSource, /timingFiltered \+= selection\.filteredCount/);
    assert.match(pageStateSource, /timingPending = selection\.pending\.length/);
    assert.match(pageStateSource, /timingCapacityDropped \+= selection\.capacityDropped/);
    assert.match(pageStateSource, /uniqueTimingFiltered[^]*uniqueTimingFutureBuffered[^]*uniqueTimingDue[^]*uniqueTimingCapacityDropped/);
    assert.match(pageStateSource, /nearestFutureClass: 'NONE'[^]*reanchorTemporalCoverage: 'UNKNOWN'/);
    assert.match(pageStateSource, /reanchorAccepted: false[^]*reanchorAcceptedRelation: 'NONE'[^]*freshChainStarted: false[^]*freshChainSource: 'NONE'[^]*currentWindowConfirmed: false/);
    assert.match(pageStateSource, /nearestBeforeTargetClass: 'UNKNOWN'[^]*nearestAfterTargetClass: 'UNKNOWN'[^]*targetBracketGapClass: 'UNKNOWN'[^]*currentWindowState: 'UNKNOWN'/);
    assert.match(pageStateSource, /transportTemporalCoverageConfirmed: false[^]*displayableNearestBeforeTargetClass: 'UNKNOWN'[^]*displayableCurrentWindowConfirmed: false/);
    assert.match(pageStateSource, /reanchorTimestampedActionCount: 0[^]*reanchorDisplayableMessageCount: 0[^]*reanchorDisplayableBefore: 0[^]*reanchorDisplayableDue: 0[^]*reanchorDisplayableFuture: 0/);
    assert.match(pageStateSource, /freshSequentialResponseObserved: false[^]*freshSequentialDisplayableMessageCount: 0[^]*freshSequentialDisplayableCurrentWindowState: 'UNKNOWN'/);
    assert.match(pageStateSource, /freshSequentialDisplayableNearestBeforeTargetClass: 'UNKNOWN'[^]*freshSequentialDisplayableNearestAfterTargetClass: 'UNKNOWN'[^]*freshSequentialDisplayableTargetBracketGapClass: 'UNKNOWN'/);
    assert.match(pageStateSource, /replayPendingRetainedFromPriorResponse: 0[^]*replayPendingAddedFromCurrentResponse: 0[^]*replayPendingCapacityDroppedCurrentMerge: 0/);
    assert.match(pageStateSource, /firstFreshSequentialPriorPendingRetained: 0[^]*firstFreshSequentialPendingAdded: 0[^]*firstFreshSequentialCapacityDropped: 0/);
    assert.match(pageStateSource, /classifyNearestReplayFuture\?\.\([^]*replayPending, video\.currentTime/);
    assert.match(pageStateSource, /classifyReplayReanchorCoverage\?\.\(payload, playerOffsetMs\)/);
    assert.match(pageStateSource, /summarizeReplayTargetHole\?\.\(payload, playerOffsetMs\)/);
    assert.match(pageStateSource, /summarizeReplayDisplayableTargetHole\?\.\(normalizedMessages, playerOffsetMs\)/);
    assert.match(pageStateSource, /if \(replayAwaitingFirstFreshSequentialResponse\)[^]*freshSequentialResponseObserved = true[^]*replayAwaitingFirstFreshSequentialResponse = false/);
    assert.match(pageStateSource, /preserveSequentialPending = requestAuthorityKind === 'SEQUENTIAL'[^]*replayAwaitingFirstFreshSequentialResponse \|\| replaySequentialResumeHandoff/);
    assert.match(pageStateSource, /if \(!preserveSequentialPending\) \{[^]*replayPending = \[\]/);
    assert.match(pageStateSource, /function stopReadLoop\([^]*replayPending = \[\]/);
    assert.match(pageStateSource, /const priorPending = replayPending\.slice\(\)[^]*replayPending = replayPending\.concat\(result\.messages\)[^]*observeReplayPendingMerge\(priorPending, result\.messages/);
    assert.match(pageStateSource, /nextSequentialAuthority = continuationProgress === 'ADVANCED'[^]*createSequentialAuthorityCandidate\(nextSequentialContinuation, candidateBinding\)[^]*replayPausedSequentialAuthority = nextSequentialAuthority;[^]*replayObservedSequentialAuthority = null;[^]*nextSequentialAuthority = null/);
    const pendingFlushFunction = pageStateSource.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(pendingFlushFunction, /restartReplayFromCurrentPosition/);
    assert.match(pendingFlushFunction, /startReadLoop\(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant\)/);
    assert.match(pageStateSource, /consumedContinuations: replayConsumedAuthorityRegistry/);
    assert.doesNotMatch(pageStateSource, /replaySequentialSeenContinuations/);
    assert.match(pageStateSource, /bufferSavedContinuationState = 'OBSERVED_UNUSED'/);
    assert.match(pageStateSource, /startReadLoop\(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant\)/);
    assert.equal((pageStateSource.match(/replayPipelineDiagnostic\.displayableCurrentWindowState\s*=/g) || []).length, 1);
    assert.match(pageStateSource, /transportTemporalCoverageConfirmed = \['CONFIRMED_NEAR', 'CROSSES_WITH_SMALL_GAP', 'AFTER_NEAR'\]/);
    assert.doesNotMatch(pageStateSource, /currentWindowConfirmed = \['CROSSES_TARGET'/);
    assert.equal((pageStateSource.match(/replayPipelineDiagnostic\.reanchorTemporalCoverage\s*=/g) || []).length, 1);
    assert.match(pageStateSource, /reanchorAcceptedRelation = relation/);
    assert.match(pageStateSource, /freshChainSource = 'PLAYER_SEEK_RESPONSE_REPLAY_CONTINUATION'/);
    assert.doesNotMatch(pageStateSource, /freshChainSource = '(?:OLD|INITIAL|WATCH|NATIVE)/);
    assert.match(pageStateSource, /event\.target !== getCurrentMainVideo\(\)[^]*ownedVideoTimeupdateObserved \+= 1[^]*flushReplayPending\([^]*'timeupdate'/);
    assert.match(pageStateSource, /bridged \+= selection\.due\.length/);
    assert.match(pageStateSource, /addEventListener\('seeking'[^]*replayPipelineDiagnostic = createReplayPipelineDiagnostic\(\)/);
    assert.match(contentSource, /enqueuedCount \+= 1/);
    assert.match(contentSource, /type: REPLAY_PIPELINE_DIAGNOSTIC_TYPE[^]*enqueuedCount/);
    assert.match(contentSource, /pendingCurrent:[^]*opportunitiesArmed:[^]*opportunitiesEvaluated:[^]*stalePruned:[^]*selectionNone:[^]*collisionBlocked:[^]*geometryUnknown:[^]*generationInvalidated:[^]*geometryInvalidated:[^]*launchCommitted:[^]*schedulerState: 'IDLE'/);
    assert.match(contentSource, /collisionActiveDanmaku:[^]*collisionSubtitle:[^]*collisionCandidateGeometry:[^]*collisionNoUsableLane:[^]*collisionOther:/);
    assert.match(runtimeSource, /proveBoundedCollisionSafe/);
    assert.match(runtimeSource, /isOutsideHardExclusions/);
    assert.match(contentSource, /blockedReason: 'CANDIDATE_GEOMETRY_INVALID'/);
    assert.match(contentSource, /blockedReason: 'NO_USABLE_LANE'/);
    assert.match(contentSource, /event\.type === 'seeking'[^]*replaySchedulerDiagnostic = createReplaySchedulerDiagnostic\(\)/);
    assert.match(contentSource, /observe: observeReplayScheduler/);
    assert.match(contentSource, /function getCandidateProof[^]*applyOverlaySurfaceRect\(surface\)[^]*overlaySurface\.appendChild\(probe\)[^]*probe\.getBoundingClientRect\(\)/);
    assert.match(pageStateSource, /LiveFlowReplayPipelineDiagnostic = Object\.freeze\([^]*return Object\.freeze\(\{ \.\.\.replayPipelineDiagnostic \}\)/);
    assert.doesNotMatch(pageStateSource, /LiveFlowReplayPipelineDiagnostic[^]*?(?:continuation|videoId|playerOffsetMs|requestBody|responseBody)\s*:/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('Temporal starvation telemetry stays shape-only after Production rescue rollback', () => {
    const diagnostic = pageStateSource.match(/function createReplayTemporalStarvationDiagnostic\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(diagnostic, /episodeActive:[^]*totalPendingClass:[^]*dueCountClass:[^]*nearFutureCountClass:[^]*nearestFutureClass:/);
    assert.match(diagnostic, /bufferPausedNow: false/);
    assert.match(diagnostic, /schedulerPending:[^]*schedulerLaunchable:[^]*savedSequentialAvailable:[^]*savedSequentialCurrent:[^]*savedSequentialUnused:/);
    assert.match(diagnostic, /temporalStarvationKnown:[^]*temporalStarvationObserved:[^]*hypotheticalRescueEligible:[^]*hypotheticalRescueBlockedReason:/);
    assert.doesNotMatch(diagnostic, /token|continuation|timestamp|offset|message|author|target|url/i);
    assert.match(pageStateSource, /LiveFlowReplayTemporalStarvationDiagnostic = Object\.freeze/);
    assert.match(pageStateSource, /mergeReplayTemporalEpisodeHistory/);
    assert.match(pageStateSource, /evaluateReplayHypotheticalRescue/);
    assert.doesNotMatch(pageStateSource, /evaluateReplayTemporalRescue|BUFFER_TEMPORAL_RESCUE|TEMPORAL_RESCUE_ELIGIBLE|TEMPORAL_RESCUE_COMPLETED/);
    assert.doesNotMatch(pageStateSource, /!replayPipelineDiagnostic\.earlyResumeStarted \? 'EARLY_RESUME_NOT_USED'/);
    assert.match(pageStateSource, /if \(!replayTemporalStarvationDiagnostic\.episodeActive\) \{[^]*createReplayTemporalStarvationDiagnostic\(\)[^]*episodeActive = true/);
    assert.equal((pageStateSource.match(/REPLAY_MAX_PENDING = 100/g) || []).length, 1);
    assert.match(pageStateSource, /replayPending\.length <= Math\.floor\(REPLAY_MAX_PENDING \/ 2\)/);
    assert.match(pageStateSource, /earlyResumeSuppressionState[^]*USED_WAITING_FOR_LOW_WATERMARK/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
    assert.doesNotMatch(pageStateSource, /setInterval\s*\(|requestAnimationFrame\s*\(/);
});

test('Soft temporal lead shadow is passive, bounded, and redacted', () => {
    const status = pageStateSource.match(/LiveFlowReplayTemporalLeadShadowDiagnostic = Object\.freeze\([^]*?\n    \}\);/)?.[0] || '';
    const update = pageStateSource.match(/function updateReplayTemporalLeadShadowDiagnostic\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(pageStateSource, /LiveFlowReplayTemporalLeadShadowDiagnostic = Object\.freeze/);
    assert.match(update, /evaluateReplayTemporalLeadShadow/);
    assert.match(update, /Math\.min\(255/);
    assert.doesNotMatch(update, /fetch\(|performRead\(|authorizeReplayAuthority|authorizeSavedSequentialResume|setTimeout|setInterval|requestAnimationFrame/);
    assert.doesNotMatch(status, /token|continuation|timestamp|offset|message|author|url|id\s*:/i);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('Replay gap-origin diagnostic is passive, lifecycle-bounded, and redacted', () => {
    const diagnostic = pageStateSource.match(/function createReplayGapOriginDiagnostic\(\) \{[^]*?\n    \}/)?.[0] || '';
    const status = pageStateSource.match(/function replayGapOriginStatus\(\) \{[^]*?\n    \}/)?.[0] || '';
    const evidence = runtimeSource.match(/function createReplayGapEvidenceState\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(diagnostic, /acquisitionLeadClass:[^]*retainedNearestDistanceClass:[^]*responseFirstMessageRelation:[^]*responseLastMessageRelation:[^]*responseCoverageProgress:/);
    assert.match(diagnostic, /gapBandObserved:[^]*gapBandObservedDisposition:[^]*capacitySelectionNearestPreserved:[^]*gapOriginClass:/);
    assert.doesNotMatch(status, /opaqueToken|continuation|timestamp|offset|message|author|target|url|id\s*:/i);
    assert.doesNotMatch(evidence, /opaqueToken|continuation|timestamp|offset|message|author|target|url|id\s*:/i);
    assert.match(pageStateSource, /updateReplayGapEvidence\?\.\([^]*replayGapEvidence, gapObservations, video\.currentTime/);
    assert.match(pageStateSource, /LiveFlowReplayGapOriginDiagnostic = Object\.freeze/);
    assert.match(status, /gapObservedFiltered:[^]*gapObservedBridgedDue:[^]*gapObservedCapacityDropped:[^]*gapObservedExactIdDeduped:[^]*gapObservedRetained:[^]*gapObservedUnknown:/);
    assert.match(status, /gapBandScope: 'LIFECYCLE_WIDE_MOVING'[^]*movingBandAmbiguity:[^]*acquisitionLeadPersistent:[^]*responseFarFuturePersistent:/);
    assert.match(pageStateSource, /function observeReplayGapPersistence\([^]*updateReplayGapPersistenceState/);
    assert.match(runtimeSource, /function updateReplayGapPersistenceState\([^]*Math\.min\(255,[^]*acquisitionLeadConsecutive[^]*farFutureResponseConsecutive/);
    assert.match(pageStateSource, /function stopReadLoop\([^]*resetReplayGapOriginDiagnostic\(\)/);
    assert.match(pageStateSource, /\['user-disabled', 'visibility-hidden', 'pagehide', 'navigation'\]\.includes\(reason\)[^]*resetReplayGapOriginDiagnostic\(\)/);
    assert.equal((pageStateSource.match(/resetReplayGapOriginDiagnostic\(\)/g) || []).length, 3,
        'definition plus lifecycle invalidation and teardown are the only reset sites');
    const flush = pageStateSource.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(flush, /fetch\(|performRead\(|setTimeout|setInterval|requestAnimationFrame/);
    assert.doesNotMatch(flush, /resetReplayGapOriginDiagnostic/);
    assert.equal((pageStateSource.match(/\bfetch\s*\(/g) || []).length, 1);
});

test('timer is generation-bound and cancelled during loop stop', () => {
    assert.match(pageStateSource, /window\.clearTimeout\(activeWaitTimer\)/);
    assert.match(pageStateSource, /resolve\(generation === currentLoopGeneration\)/);
});

test('Replay media pause preserves pending and the observed unused sequential authority', () => {
    const suspend = pageStateSource.match(/function suspendReplayForMediaPause\(\) \{[^]*?\n    \}/)?.[0] || '';
    const pauseHandler = pageStateSource.match(/addEventListener\('pause'[^]*?\}, true\);/)?.[0] || '';
    const resumePath = pageStateSource.match(/restartReason === 'RESUME' && readStopReason === 'playback-paused'[^]*?return;/)?.[0] || '';
    assert.match(suspend, /replayPausedSequentialAuthority = replayObservedSequentialAuthority/);
    assert.match(suspend, /replayAcquisitionPausedForBuffer = Boolean\(replayPausedSequentialAuthority\)/);
    assert.doesNotMatch(suspend, /replayPending\s*=\s*\[\]/);
    assert.doesNotMatch(pauseHandler, /stopReadLoop|stopReplayContext/);
    assert.match(pauseHandler, /suspendReplayForMediaPause\(\)/);
    assert.match(resumePath, /flushReplayPending/);
    assert.doesNotMatch(resumePath, /startReplayBootstrap|INITIAL_WATCH/);
});

test('PC Web eligibility is independent of viewport width', () => {
    assert.doesNotMatch(readRuntimeSource, /innerWidth|outerWidth|screen\.width|matchMedia\s*\(/);
    assert.match(contentSource, /youtube\\\.com\\\/\(\?:watch\|live\)/);
});

test('formal runtime has no proxy, restriction-bypass, or external telemetry path', () => {
    assert.doesNotMatch(runtimeSource, /proxy|rotate(?:Ip|IP)|bypass|telemetry|analytics|sendBeacon/i);
    assert.doesNotMatch(runtimeSource, /https?:\/\/(?!www\.youtube\.com)/i);
});

test('Replay bootstrap mode does not require Native Chat iframe to be open', () => {
    assert.match(pageStateSource, /const snapshotChatMode = core\?\.classifyInitialChatMode\?\.\(watchSnapshot\)/);
    assert.match(pageStateSource, /const chatMode = snapshotChatMode !== 'unknown' \? snapshotChatMode : frameChatMode/);
    assert.doesNotMatch(pageStateSource, /const chatMode = frameRole\?\.role === 'LIVE_CHAT'/);
});

test('Replay accounting ledger is aggregate-only and detects unaccounted boundaries', () => {
    const ledger = pageStateSource.match(/function replayAccountingStatus\(\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(ledger, /computeReplayAccountingLedger/);
    assert.match(ledger, /lostUnaccounted: ledger\.lostUnaccounted/);
    assert.match(pageStateSource, /LiveFlowReplayAccountingDiagnostic = Object\.freeze/);
    assert.match(pageStateSource, /receivedActions[^]*parseFailed[^]*displayable[^]*beforeStartFiltered[^]*capacityDropped/);
    assert.doesNotMatch(ledger, /opaqueToken|continuation|timestamp|offsetMsec|author|targetIdentity|url/i);
    assert.doesNotMatch(ledger, /fetch\(|performRead\(|setTimeout|setInterval|requestAnimationFrame/);
});

test('Replay lifecycle discard reason split is shape-only and preserves the aggregate counter', () => {
    assert.match(contentSource, /lifecycleDiscardedDisplayDisabled: inputCount/);
    for (const field of ['lifecycleDiscardedMediaMissing', 'lifecycleDiscardedMediaPaused',
        'lifecycleDiscardedMediaEnded', 'lifecycleDiscardedMediaNotReady',
        'lifecycleDiscardedAdShowing', 'lifecycleDiscardedAdInterrupting']) {
        assert.match(contentSource, new RegExp(field));
    }
    assert.match(pageStateSource, /lifecycleDiscardedDisplayDisabled: 0[^]*lifecycleDiscardedMediaMissing: 0[^]*lifecycleDiscardedMediaPaused: 0[^]*lifecycleDiscardedMediaEnded: 0[^]*lifecycleDiscardedMediaNotReady: 0[^]*lifecycleDiscardedAdShowing: 0[^]*lifecycleDiscardedAdInterrupting: 0/);
    assert.doesNotMatch(contentSource.match(/function scheduleDanmakuBatch\(messages\) \{[^]*?\n    \}/)?.[0] || '', /setTimeout|setInterval|requestAnimationFrame|fetch\s*\(/);
});

test('Replay runtime observer is event-driven, bounded, redacted, and behavior-neutral', () => {
    assert.match(pageStateSource, /LiveFlowReplayRuntimeObserver = Object\.freeze/);
    assert.match(pageStateSource, /observeReplayRuntimeAccounting\('response-accepted'\)/);
    assert.match(pageStateSource, /observeReplayRuntimeAccounting\(source === 'timeupdate'/);
    assert.match(pageStateSource, /observeReplayRuntimeAccounting\('scheduler'\)/);
    assert.match(pageStateSource, /observeReplayRuntimeAccounting\('displayed'\)/);
    const chatReadCoreSource = fs.readFileSync(path.join(sourceRoot, 'chat-read-core.js'), 'utf8');
    const observer = chatReadCoreSource.match(/function createReplayRuntimeObserver\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(observer, /setTimeout|setInterval|requestAnimationFrame|fetch\s*\(|XMLHttpRequest/);
    assert.doesNotMatch(observer, /opaqueToken|continuation|timestamp|offsetMsec|messageId|author/i);
    assert.doesNotMatch(observer, /\.enqueue\(|\.consume\(|\.invalidate\(|startReadLoop|performRead/);
});
