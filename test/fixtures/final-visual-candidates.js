// Offline experiments only: never imported by the extension.
const fs = require('node:fs');
const path = require('node:path');
const tuning = require('../../src/phase5-tuning.js');
const geometry = require('../../src/geometry-adapter.js');
const foundations = require('../../src/scheduler-foundations.js');
const { createSchedulerRuntime } = require('../../src/scheduler-runtime.js');
const core = require('../../src/overlay-core.js');
const normalOverlap = require('../../src/normal-overlap-policy.js');
// Historical comparison baselines must not silently adopt the new Production D defaults.
const { normalOverlapPolicy: acceptedOverlap, ...baselineCommon } = tuning.CURRENT;
const baseline = { ...baselineCommon,
    interleavedAnchorStride: { ...baselineCommon.interleavedAnchorStride, DENSE: 2 },
    collisionAllowances: { ...baselineCommon.collisionAllowances,
        BOUNDED_OVERLAP: { ...baselineCommon.collisionAllowances.BOUNDED_OVERLAP, nominalGap: 10, maxCatchUpRatio: .82, maxOverlapDuration: .85 },
        MAXIMUM_READABLE_RESCUE: { ...baselineCommon.collisionAllowances.MAXIMUM_READABLE_RESCUE, nominalGap: 6, maxCatchUpRatio: .95, maxOverlapDuration: 1.1 }
    } };
function candidate(name, duration, stride) {
    return { name, config: { ...baseline,
        interleavedAnchorStride: { ...baseline.interleavedAnchorStride, DENSE: stride },
        collisionAllowances: { ...baseline.collisionAllowances,
            BOUNDED_OVERLAP: { ...baseline.collisionAllowances.BOUNDED_OVERLAP, nominalGap: 4,
                maxCatchUpRatio: 0.95, maxOverlapDuration: duration },
            MAXIMUM_READABLE_RESCUE: { ...baseline.collisionAllowances.MAXIMUM_READABLE_RESCUE, nominalGap: 0,
                maxCatchUpRatio: 1, maxOverlapDuration: duration }
        } } };
}
const candidates = [{ name: 'Baseline', config: baseline }, candidate('A', 1.4, 2), candidate('B', 1.4, 1)];
const candidateC = { name: 'C', config: { ...candidates[2].config, normalOverlapPolicy: normalOverlap.C } };
const palettes = { guest: '#fff', member: '#66e08a', moderator: '#70b7ff', owner: '#ffd75e' };
const strokes = [
    { name: 'Baseline', widths: [1.1, .45, .45, .45], colors: ['#202020', '#12381d', '#183b5c', '#564813'] },
    { name: 'A', widths: [1.4, 1.1, 1.1, 1.1], colors: ['#101010', '#0b2011', '#0e2338', '#302709'] },
    { name: 'B', widths: [1.7, 1.4, 1.4, 1.4], colors: ['#101010', '#0b2011', '#0e2338', '#302709'] }
];

function run(config, shape, options = {}) {
    let now = 0, timer = null;
    const binding = { target: 'fixture', timeline: 'fixed', generation: 1 };
    const exclusion = { x: 0, y: 256, width: 960, height: 64 };
    const authority = geometry.createGeometryAuthority({ epsilon: 1 });
    const adapter = geometry.createSubtitleGeometryAdapter({ authority,
        readGeometry: () => ({ state: 'KNOWN_PRESENT', exclusionRegions: [exclusion], capabilityAvailable: true }) });
    const active = [], launches = [], events = [], frames = [], pairSamples = [], normalSamples = [];
    const ingress = [], launchGaps = [];
    const widths = [180, 300, 480, 720];
    const runtime = createSchedulerRuntime({ clock: () => now, generation: () => 1,
        scheduleOneShot(callback, delay) { timer = { callback, due: now + delay }; return timer; },
        cancelOneShot(value) { if (timer === value) timer = null; },
        sourceActivityBinding: () => binding, sourceActivityTime: () => now,
        geometryAdapter: adapter, observe: e => events.push(e),
        candidateProof(item, state, policy) {
            const message = item.payload;
            const generated = geometry.generateDensityLaneCandidates({ videoRect: { x: 0, y: 0, width: 960, height: 320 },
                renderedWidth: message.width, renderedHeight: message.special ? 68 : 32,
                actualVelocity: message.velocity, footprint: {}, lineHeight: config.lineHeight, laneGap: config.laneGap,
                densityPolicy: policy, laneBandFractions: config.laneBandFractions,
                interleavedAnchorStride: config.interleavedAnchorStride, exclusionRegions: state.exclusionRegions,
                special: message.special });
            const stamp = list => list.map(c => ({ ...c, rectangle: { ...c.rectangle, snapshotAt: now / 1000, occlusionHistoryKnown: true } }));
            let ranked = tuning.rankDensityRescuePlacements(stamp(generated.baseCandidates), stamp(generated.interleavedCandidates),
                stamp(generated.expansionCandidates), active, message.id, policy.density,
                options.preferInterleaved ?? Boolean(config.normalOverlapPolicy));
            const selection = options.selectCandidates?.({ candidates: ranked, active, density: policy.density, config });
            if (selection) ranked = selection.candidates;
            options.onCandidates?.({ id: message.id, at: now, density: policy.density, candidates: ranked, active, selection: selection?.diagnostic });
            return { candidates: ranked, activeComments: active };
        },
        launch(message, proof) {
            if (!foundations.isOutsideHardExclusions(proof.rectangle, [exclusion])) throw Error('subtitle intrusion');
            if (message.special && proof.interleaved) throw Error('SPECIAL interleaving');
            const overlappingRows = active.filter(a => proof.rectangle.y < a.y + a.height && a.y < proof.rectangle.y + proof.rectangle.height);
            if (overlappingRows.length) launchGaps.push(Math.min(...overlappingRows.map(a => proof.rectangle.x - a.x - a.width)));
            const record = { ...proof.rectangle, anchorIndex: proof.anchorIndex, interleaved: proof.interleaved,
                id: message.id, special: message.special, at: now, initialX: proof.rectangle.x };
            if (config.normalOverlapPolicy) {
                const episodes = normalOverlap.recordEpisodes(record, active, now / 1000);
                record.occlusionEpisodes = episodes[0]; record.occlusionHistoryKnown = true;
                active.forEach((a, i) => { a.occlusionHistoryKnown = normalOverlap.historyKnown(a, active.filter(r => r !== a)); a.occlusionEpisodes = episodes[i + 1]; });
            }
            active.push(record); launches.push({ ...record }); options.onLaunch?.({ id: message.id, at: now, proof }); return true;
        },
        config: { maxPendingAge: core.DANMAKU_TARGET_DURATION_MS, maxPendingCount: core.DANMAKU_MAX_RENDER_QUEUE,
            pendingPressureCapacity: core.DANMAKU_MAX_RENDER_QUEUE, scanDepth: 5, cohortMaximumItems: 5,
            cohortMaximumSpan: core.DANMAKU_MAX_BATCH_SPREAD_MS,
            pacing: { userBaseInterval: 120, minimumInterval: 80, maximumRescueFraction: .75 },
            density: { attackThresholds: [.5, .75, .9], releaseThresholds: [.2, .35, .5], minimumAttackResidence: 2, releaseDwell: 4 },
            sourceActivity: { bandThresholdsPerSecond: [1, 2, 4], promotionResidence: 2, releaseDwell: 2 },
            collisionAllowances: config.collisionAllowances, normalOverlapPolicy: config.normalOverlapPolicy }
    });
    let nextArrival = 0, count = 0, reported = 0;
    for (now = 0; now <= 40000; now += 20) {
        for (const a of active) a.x = a.initialX - a.velocity * (now - a.at) / 1000;
        for (let i = active.length - 1; i >= 0; i--) if (active[i].x + active[i].width <= 0) active.splice(i, 1);
        if (now <= 20000 && now >= nextArrival) {
            const special = count % 37 === 0;
            const width = special ? 650 : widths[count % widths.length];
            const velocity = tuning.applyLengthAwareVelocity(core.calculateDanmakuSpeed({ overlayWidth: 960, commentWidth: width,
                minSpeed: config.minimumSpeed, maxSpeed: config.maximumSpeed }), width, 960, config.lengthVelocity, config.maximumSpeed);
            const message = { id: `fixed-${count}`, width, velocity, special, message: { authorRole: 'guest' } };
            runtime.enqueue(message, { id: message.id, enqueuedAt: now,
                rendererType: special ? 'liveChatPaidMessageRenderer' : 'liveChatTextMessageRenderer', footprint: {} });
            ingress.push({ mediaTimeMs: now, displayable: true, temporalClass: 'CURRENT_WINDOW' });
            count++; nextArrival += shape === 'HIGH' ? 300 : 120;
        }
        runtime.observeSourceActivity({ eventBinding: binding, mediaTimeMs: now, windowStartMs: Math.max(0, now - 10000),
            windowEndMs: now, facts: ingress.slice(reported) });
        reported = ingress.length;
        if (timer && timer.due <= now) { const callback = timer.callback; timer = null; const before = launches.length;
            callback(); if (launches.length - before > 1) throw Error('multiple launches'); }
        if (now % 200 === 0) {
            const status = runtime.status();
            frames.push({ at: now, band: status.sourceActivityBand, density: status.density, active: active.map(a => ({ ...a })) });
            for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
                const a = active[i], b = active[j];
                const vertical = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
                const horizontal = Math.max(0, Math.min(960, a.x + a.width, b.x + b.width) - Math.max(0, a.x, b.x));
                if (vertical && horizontal) {
                    const sample = { at: now, pair: [a.id, b.id].sort().join('/'), vertical, horizontal, crossRow: a.y !== b.y };
                    pairSamples.push(sample);
                    if (!a.special && !b.special) normalSamples.push(sample);
                }
            }
        }
    }
    const drops = Object.fromEntries(['STALE_PRUNED', 'CAPACITY_DROPPED', 'EMERGENCY_PENDING_DROPPED'].map(type =>
        [type, events.filter(e => e.type === type).reduce((s, e) => s + e.count, 0)]));
    const pending = runtime.status().pendingCount;
    const residence = key => frames.filter(f => f.at >= 5000 && f.at <= 20000).reduce((r, f) =>
        (r[f[key]] = (r[f[key]] || 0) + 1, r), {});
    const durations = {};
    for (const p of pairSamples) durations[p.pair] = (durations[p.pair] || 0) + .2;
    const normalDurations = {};
    for (const p of normalSamples) normalDurations[p.pair] = (normalDurations[p.pair] || 0) + .2;
    return { shape, ingress: count, launches: launches.length, specialLaunches: launches.filter(a => a.special).length,
        interleaved: launches.filter(a => a.interleaved).length, drops, pending,
        lostUnaccounted: count - launches.length - Object.values(drops).reduce((a, b) => a + b, 0) - pending,
        collisionEvaluations: events.filter(e => e.type === 'COLLISION_BLOCKED').length,
        minimumLaunchHorizontalGapPx: launchGaps.length ? Math.min(...launchGaps) : null,
        averageLaunchHorizontalGapPx: launchGaps.length ? launchGaps.reduce((a, b) => a + b, 0) / launchGaps.length : null,
        averageVisible: frames.filter(f => f.at >= 5000 && f.at <= 20000).reduce((s, f) => s + f.active.filter(a => a.x < 960 && a.x + a.width > 0).length, 0) / 76,
        peakVisible: Math.max(...frames.filter(f => f.at <= 20000).map(f => f.active.filter(a => a.x < 960 && a.x + a.width > 0).length)),
        maxVerticalOverlapPx: Math.max(0, ...pairSamples.map(p => p.vertical)),
        maxHorizontalOverlapPx: Math.max(0, ...pairSamples.map(p => p.horizontal)),
        maxSampledPairOverlapSeconds: Math.max(0, ...Object.values(durations)),
        normalOverlap: { horizontalPx: Math.max(0, ...normalSamples.map(p => p.horizontal)),
            verticalPx: Math.max(0, ...normalSamples.map(p => p.vertical)),
            crossRowVerticalPx: Math.max(0, ...normalSamples.filter(p => p.crossRow).map(p => p.vertical)),
            sampledPairSeconds: Math.max(0, ...Object.values(normalDurations)), samples: normalSamples.length },
        sourceShape: residence('band'), displayShape: residence('density'), frames, launchesDetail: launches };
}

function writePreview(output) {
    const results = candidates.map(c => ({ name: c.name, policy: c.config, runs: ['HIGH', 'BURST'].map(s => run(c.config, s)) }));
    fs.writeFileSync(path.join(output, 'final-visual-results.json'), JSON.stringify(results.map(c => ({ name: c.name,
        policy: c.policy, runs: c.runs.map(({ frames, launchesDetail, ...summary }) => summary) })), null, 2));
    const data = JSON.stringify(results).replace(/</g, '\\u003c');
    const rows = strokes.map(s => `<section><h3>Typography ${s.name}</h3>${['dark', 'bright'].map(bg =>
        `<div class="${bg}">${Object.entries(palettes).map(([role, fill], i) => `<p style="color:${fill};-webkit-text-stroke:${s.widths[i]}px ${s.colors[i]}">${role}: 接続点も読みやすく！盛り上がってきた Thank you</p>`).join('')}<p class="special">Alice · ¥500<br>ありがとう！ SPECIAL unchanged</p></div>`).join('')}</section>`).join('');
    fs.writeFileSync(path.join(output, 'final-visual-preview.html'), `<!doctype html><meta charset="utf-8"><title>LiveFlow final visual comparison</title>
<style>body{font:16px sans-serif;background:#eee;margin:20px} .grid{display:flex;gap:16px;flex-wrap:wrap}section{flex:1;min-width:440px}p{font:600 28px/32px sans-serif;paint-order:stroke fill;white-space:nowrap}.dark{background:linear-gradient(120deg,#121820,#46505b);padding:12px}.bright{background:linear-gradient(120deg,#fff,#dde6c7);padding:12px}.special{color:white;background:rgba(24,24,24,.8);-webkit-text-stroke:.8px rgba(0,0,0,.85);padding:4px 8px;width:max-content}canvas{width:960px;max-width:100%;border:1px solid #999}</style>
<h1>Density and Typography — independent offline candidates</h1><p style="font:16px sans-serif">Fixed measured rectangles; simplified renderer. No Production changes. Density retains baseline outlines.</p>
<label>Time <input id="time" type="range" min="0" max="20000" step="200" value="14000"></label><span id="stamp"></span>
<div id="density"></div><h2>Typography: same strings, size and backgrounds</h2><div class="grid">${rows}</div>
<script>const data=${data};const root=document.getElementById('density');for(const shape of ['HIGH','BURST']){const h=document.createElement('h2');h.textContent=shape;root.append(h);for(const c of data){const r=c.runs.find(r=>r.shape===shape);const label=document.createElement('div');label.textContent=c.name+' launches='+r.launches+' visible(avg)='+r.averageVisible.toFixed(2)+' drops='+JSON.stringify(r.drops);root.append(label);const canvas=document.createElement('canvas');canvas.width=960;canvas.height=320;canvas.dataset.c=c.name;canvas.dataset.shape=shape;root.append(canvas)}}function draw(){const t=Number(document.getElementById('time').value);document.getElementById('stamp').textContent=t/1000+'s';for(const canvas of root.querySelectorAll('canvas')){const run=data.find(c=>c.name===canvas.dataset.c).runs.find(r=>r.shape===canvas.dataset.shape);const frame=run.frames.find(f=>f.at===t);const ctx=canvas.getContext('2d');ctx.fillStyle='#38434d';ctx.fillRect(0,0,960,320);ctx.fillStyle='#111';ctx.fillRect(0,256,960,64);ctx.fillStyle='white';ctx.font='18px sans-serif';ctx.fillText('Subtitle hard exclusion',320,294);for(const a of frame.active){ctx.save();ctx.beginPath();ctx.rect(a.x,a.y,a.width,a.height);ctx.clip();if(a.special){ctx.fillStyle='rgba(24,24,24,.8)';ctx.fillRect(a.x,a.y,a.width,a.height)}ctx.font='600 28px sans-serif';ctx.lineWidth=a.special?.8:1.1;ctx.strokeStyle=a.special?'rgba(0,0,0,.85)':'#202020';ctx.fillStyle='white';const text=a.special?'SPECIAL ありがとう！':'盛り上がってきた！ '+a.id;ctx.strokeText(text,a.x,a.y+27);ctx.fillText(text,a.x,a.y+27);ctx.restore()}}}document.getElementById('time').oninput=draw;draw();</script>`);
    return results;
}
module.exports = { candidates, candidateC, strokes, run, writePreview };
if (require.main === module) writePreview(path.resolve(__dirname, '../../docs'));
