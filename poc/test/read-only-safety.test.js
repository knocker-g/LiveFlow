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
    assert.match(pageStateSource, /if \(activeLoopGeneration !== 0\) return;/);
    assert.match(pageStateSource, /while \(generation === currentLoopGeneration && revision === pageRevision && continuation\)/);
});

test('navigation and pagehide invalidate or abort stale READ work', () => {
    assert.match(pageStateSource, /if \(revisionState\?\.changed[^]*?stopReadLoop\(\)/);
    assert.match(pageStateSource, /activeAbortController\.abort\(\)/);
    assert.match(pageStateSource, /addEventListener\('pagehide', stopReadLoop\)/);
    assert.match(contentSource, /addEventListener\('yt-navigate-finish', detectPage\)/);
});

test('unexpected READ response structure stops instead of polling again', () => {
    assert.match(pageStateSource, /if \(!result\.ok\) break;/);
    assert.match(pageStateSource, /if \(!continuationInfo\?\.continuation\) break;/);
});

test('PC Web eligibility is independent of viewport width', () => {
    assert.doesNotMatch(runtimeSource, /innerWidth|outerWidth|screen\.width|matchMedia\s*\(/);
    assert.match(contentSource, /youtube\\\.com\\\/\(\?:watch\|live\)/);
});

test('formal runtime has no proxy, restriction-bypass, or external telemetry path', () => {
    assert.doesNotMatch(runtimeSource, /proxy|rotate(?:Ip|IP)|bypass|telemetry|analytics|sendBeacon/i);
    assert.doesNotMatch(runtimeSource, /https?:\/\/(?!www\.youtube\.com)/i);
});
