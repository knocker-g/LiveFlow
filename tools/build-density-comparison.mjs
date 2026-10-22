// Dev-only: never a Production release entrypoint. Generated output stays under ignored build/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { instrumentInitialAuthorityTrace } from './density-comparison/instrument-initial-authority.mjs';
import { instrumentInitialRequestMain, instrumentInitialRequestContent } from './density-comparison/instrument-initial-request.mjs';
import { instrumentArchivedAttribution } from './density-comparison/instrument-archived-attribution.mjs';
import { instrumentChatReadInitialization, instrumentCoreInitializationStatus } from './density-comparison/instrument-core-initialization.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function replaceOnce(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Unrecognized source anchor: ' + before.slice(0, 70));
    return source.replace(before, after);
}
const digestSlot = '0'.repeat(64);
export function packageDigest(files) {
    return hash(JSON.stringify(Object.keys(files).sort().map(name => [name, hash(name === 'src/youtube-chat.js'
        ? files[name].toString().replace(/"packageDigest":"[a-f0-9]{64}"/, '"packageDigest":"' + digestSlot + '"') : files[name])])));
}
export function verify(directory) {
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json')));
    const files = {};
    for (const [name, digest] of Object.entries(provenance.files)) {
        if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('Invalid package path');
        files[name] = fs.readFileSync(path.join(directory, name));
        if (hash(files[name]) !== digest) throw Error('Package file hash mismatch: ' + name);
    }
    const inventory = fs.readdirSync(directory, { recursive: true }).filter(n => fs.statSync(path.join(directory, n)).isFile()).map(n => n.replaceAll('\\', '/')).sort();
    if (JSON.stringify(inventory) !== JSON.stringify([...Object.keys(files), 'provenance.json'].sort())) throw Error('Unexpected package file');
    if (packageDigest(files) !== provenance.packageDigest) throw Error('Package digest mismatch');
    const manifest = JSON.parse(files['manifest.json']);
    const id = hash(Buffer.from(manifest.key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
    if (id !== provenance.extensionID) throw Error('Extension identity mismatch');
    return { candidate: provenance.candidate, sourceSHA: provenance.sourceSHA, buildID: provenance.buildID, packageDigest: provenance.packageDigest, extensionID: id };
}
export function build(output = path.join(root, 'build/density-comparison'), { initialAuthorityTrace = false } = {}) {
    const resolved = path.resolve(output), allowed = path.join(root, 'build') + path.sep;
    if (!resolved.startsWith(allowed)) throw Error('Output must stay inside ignored workspace build/');
    if (fs.existsSync(resolved)) throw Error('Output exists; choose a fresh build/ directory (never overwrite)');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    const resources = new Set(['manifest.json', ...manifest.content_scripts.flatMap(x => x.js)]);
    for (const file of execFileSync('git', ['ls-files', '_locales', 'icons', 'popup'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/)) resources.add(file);
    const files = Object.fromEntries([...resources].sort().map(name => [name, fs.readFileSync(path.join(root, name))]));
    const inputs = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, hash(v)]));
    const devInputs = ['tools/build-density-comparison.mjs', 'tools/density-comparison/recorder.js',
        'tools/density-comparison/owned-recorder.mjs', 'tools/density-comparison/recorder-bridge.mjs',
        'test/fixtures/final-visual-candidates.js', 'test/fixtures/opportunity-aware-density.js'];
    if (initialAuthorityTrace) devInputs.push('tools/density-comparison/initial-authority-trace.js',
        'tools/density-comparison/instrument-initial-authority.mjs', 'tools/density-comparison/instrument-initial-request.mjs',
        'tools/density-comparison/instrument-archived-attribution.mjs', 'tools/density-comparison/instrument-core-initialization.mjs');
    for (const name of devInputs) inputs[name] = hash(fs.readFileSync(path.join(root, name)));
    const sourceSHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    const traceProfile = initialAuthorityTrace ? 'INITIAL_AUTHORITY_ORDER_V1' : 'NONE';
    const commonBuildID = hash(JSON.stringify({ sourceSHA, inputs, traceProfile }));
    const diagnosticCopies = initialAuthorityTrace ? instrumentInitialAuthorityTrace(
        files['src/page-state-main.js'].toString(), files['src/replay-control-plane-core.js'].toString(),
        { sourceSHA, commonBuildID }) : null;
    if (diagnosticCopies) {
        diagnosticCopies.main = instrumentInitialRequestMain(diagnosticCopies.main);
        diagnosticCopies.main = instrumentArchivedAttribution(diagnosticCopies.main);
        diagnosticCopies.main = instrumentCoreInitializationStatus(diagnosticCopies.main);
        diagnosticCopies.chatRead = instrumentChatReadInitialization(files['src/chat-read-core.js'].toString());
        new vm.Script(diagnosticCopies.chatRead);
        new vm.Script(diagnosticCopies.main); new vm.Script(diagnosticCopies.core);
    }
    const { candidates, candidateC } = require('../test/fixtures/final-visual-candidates.js');
    const selector = fs.readFileSync(path.join(root, 'test/fixtures/opportunity-aware-density.js'), 'utf8')
        .replace("require('../../src/scheduler-foundations.js')", 'window.LiveFlowSchedulerFoundations')
        .replace("require('../../src/normal-overlap-policy.js')", 'window.LiveFlowNormalOverlapPolicy')
        .replace("require('../../src/overlay-core.js')", 'window.LiveFlowOverlayCore')
        .replace('module.exports = { select };', 'return select;');
    if (/require\(|module\.exports/.test(selector)) throw Error('Selector wrapper not browser-safe');
    const recorder = fs.readFileSync(path.join(root, 'tools/density-comparison/recorder.js'), 'utf8') + '\n' +
        ['owned-recorder.mjs','recorder-bridge.mjs'].map(name => fs.readFileSync(path.join(root, 'tools/density-comparison',name),'utf8').replaceAll('export function ','function ')).join('\n');
    const packages = [];
    for (const candidate of ['B', 'D']) {
        const config = candidate === 'B' ? candidates[2].config : candidateC.config;
        const identity = { candidate, sourceSHA, commonBuildID, buildID: hash(commonBuildID + candidate), packageDigest: digestSlot,
            selectionPolicy: candidate === 'B' ? 'B_OCCUPANCY' : 'B_OCCUPANCY_THEN_APPROVED_D', typography: 'A', traceProfile };
        let source = files['src/youtube-chat.js'].toString();
        for (const stroke of ['1.4px #101010', '1.1px #0b2011', '1.1px #0e2338', '1.1px #302709']) if (!source.includes(stroke)) throw Error('Typography A missing');
        source = replaceOnce(source, '    const phase5Tuning = window.LiveFlowPhase5Tuning?.CURRENT;',
            '    const phase5Tuning = JSON.parse(' + JSON.stringify(JSON.stringify(config)) + ');\n' +
            '    const comparisonIdentity = ' + JSON.stringify(identity) + ';\n' +
            '    const comparisonSelect = (() => {\n' + selector + '\n})();\n' + recorder + '\n' +
            '    const comparisonNodes = new WeakMap(); let comparisonNextID = 0;\n' +
            '    const comparisonRecorder = createOwnedRecorder(comparisonIdentity, () => {\n' +
            '        const media = getCurrentMainMedia(); const surface = overlaySurface?.getBoundingClientRect();\n' +
            '        return { at: performance.now(), videoID: new URL(location.href).searchParams.get("v"), mediaTime: media?.video?.currentTime ?? null,\n' +
            '            playbackRate: media?.video?.playbackRate ?? null, paused: media?.video?.paused ?? null, ad: media ? isAdPlaybackActive(media.player) : null,\n' +
            '            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, settings: runtimeSettings, generation: rendererGeneration,\n' +
            '            captions: media ? isCaptionTrackEnabled(media.player) : null, surface: surface ? { left: surface.left, top: surface.top, right: surface.right, bottom: surface.bottom } : null,\n' +
            '            boxes: surface ? snapshotActiveGeometry(surface)?.map((box, index) => { const node = [...activeDanmaku.values()][index].node; if (!comparisonNodes.has(node)) comparisonNodes.set(node, ++comparisonNextID); return { ...box, observationID: comparisonNodes.get(node) }; }) : null, scheduler: phase3Runtime?.status?.() ?? null };\n' +
            '    }, { setInterval: (callback, delay) => window.setInterval(callback, delay), clearInterval: handle => window.clearInterval(handle), setTimeout: (callback,delay) => window.setTimeout(callback,delay), clearTimeout: handle => window.clearTimeout(handle), now: () => performance.now(), binding: () => ({document, video:getCurrentMainMedia()?.video, generation:rendererGeneration, lifecycle:currentPageLifecycleGeneration, epoch:replayDiagnosticEpoch}) }, createComparisonRecorder);\n' +
            '    installRecorderBridge(comparisonRecorder, comparisonIdentity, {window, origin:location.origin, instanceId:Array.from(window.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,"0")).join(""), documentKey:String(performance.timeOrigin), post:value => window.postMessage(value, location.origin)});\n' +
            '    document.addEventListener("DOMContentLoaded", installComparisonPanel, { once: true });\n' +
            '    if (document.readyState !== "loading") installComparisonPanel();\n' +
            '    function installComparisonPanel() {\n' +
            '        if (document.getElementById("liveflow-dev-comparison")) return;\n' +
            '        const panel = document.createElement("div"); panel.id = "liveflow-dev-comparison";\n' +
            '        panel.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;background:#111;color:white;padding:6px;font:12px sans-serif";\n' +
            '        panel.append(document.createTextNode("DEV " + comparisonIdentity.candidate + " / " + comparisonIdentity.buildID.slice(0,12) + " "));\n' +
            '        for (const [label, action] of [["Record 20s", () => comparisonRecorder.start()], ["Export JSON", () => {\n' +
            '            comparisonRecorder.stop(); const result = comparisonRecorder.result(); if (!result) return;\n' +
            '            const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type:"application/json"}));\n' +
            '            const link = document.createElement("a"); link.href = url; link.download = "liveflow-" + comparisonIdentity.candidate + "-" + comparisonIdentity.buildID.slice(0,12) + ".json"; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);\n' +
            '        }]]) { const button = document.createElement("button"); button.textContent = label; button.addEventListener("click", action); panel.append(button); }\n' +
            '        document.documentElement.append(panel);\n' +
            '    }');
        // The canonical path owns D. Keep the historical B/D comparison isolated.
        source = replaceOnce(source,
            '        const selection = window.LiveFlowOpportunityAwareDensity.select({ candidates: ranked, active: activeComments, density: densityPolicy.density, config: phase5Tuning });',
            '        const selection = comparisonIdentity.candidate === "D" ? comparisonSelect({ candidates: ranked, active: activeComments, density: densityPolicy.density, config: phase5Tuning }) : { candidates: ranked };\n' +
            '        comparisonRecorder.selection({ at: now, policy: comparisonIdentity.selectionPolicy, diagnostic: selection.diagnostic ?? null });');
        source = replaceOnce(source, '    function observeReplayScheduler(event) {',
            '    function observeReplayScheduler(event) {\n        if (event) comparisonRecorder.event(event);');
        source = replaceOnce(source, "        return { status: 'rendered' };", "        if (!comparisonNodes.has(node)) comparisonNodes.set(node, ++comparisonNextID);\n        comparisonRecorder.launch({ at: commitAt, observationID: comparisonNodes.get(node), rectangle: commitRectangle, lane: launchProof.lane, interleaved: launchProof.interleaved, density: launchProof.density, geometryRevision: launchProof.geometryRevision, surfaceBounds: launchProof.surfaceBounds, clearanceRectangle: launchProof.clearanceRectangle, hardExclusions: launchProof.hardExclusions });\n        return { status: 'rendered' };");
        source = replaceOnce(source, '        animation.finished.then(() => {', '        animation.finished.then(() => {\n            comparisonRecorder.exit({ at: performance.now(), observationID: comparisonNodes.get(node), reason: "ANIMATION_FINISHED", rectangle: { left: node.getBoundingClientRect().left, width: commentWidth } });');
        source = replaceOnce(source, '    function cleanupOverlay() {', '    function cleanupOverlay() {\n        comparisonRecorder.event({ type: "LIFECYCLE_CLEAR" }); comparisonRecorder.stop();');
        if (initialAuthorityTrace) source = instrumentInitialRequestContent(source, { sourceSHA, commonBuildID });
        new vm.Script(source);
        const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const key = publicKey.export({ type: 'spki', format: 'der' });
        const extensionID = hash(key).slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
        const generatedManifest = { ...manifest, name: 'LiveFlow DEV comparison ' + candidate, key: key.toString('base64'),
            description: 'Development-only B/D comparison. Never distribute as Production.' };
        const generated = { ...files, 'manifest.json': Buffer.from(JSON.stringify(generatedManifest, null, 2) + '\n'), 'src/youtube-chat.js': Buffer.from(source) };
        if (diagnosticCopies) {
            generated['src/chat-read-core.js'] = Buffer.from(diagnosticCopies.chatRead);
            generated['src/page-state-main.js'] = Buffer.from(diagnosticCopies.main);
            generated['src/replay-control-plane-core.js'] = Buffer.from(diagnosticCopies.core);
        }
        const digest = packageDigest(generated);
        generated['src/youtube-chat.js'] = Buffer.from(source.replace('"packageDigest":"' + digestSlot + '"', '"packageDigest":"' + digest + '"'));
        const provenance = { ...identity, packageDigest: digest, extensionID, dirty, inputs,
            digestDefinition: 'SHA256 of sorted [path,SHA256(bytes)] JSON; runtime packageDigest slot normalized to 64 zeros; excludes provenance.json',
            files: Object.fromEntries(Object.entries(generated).map(([k, v]) => [k, hash(v)])) };
        const directory = path.join(resolved, candidate);
        for (const [name, bytes] of Object.entries(generated)) { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), bytes); }
        fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
        packages.push({ candidate, directory, ...provenance });
    }
    return packages;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = process.argv[2] === '--verify' ? verify(path.resolve(process.argv[3]))
        : build(process.argv[2] === '--initial-authority-trace' ? process.argv[3] : process.argv[2],
            { initialAuthorityTrace: process.argv[2] === '--initial-authority-trace' })
            .map(({ candidate, directory, sourceSHA, buildID, packageDigest, extensionID, traceProfile }) => ({ candidate, directory, sourceSHA, buildID, packageDigest, extensionID, traceProfile }));
    console.log(JSON.stringify(result, null, 2));
}
