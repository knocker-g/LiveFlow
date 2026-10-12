// Embedded inside the generated ISOLATED-world closure only. No runtime API or message bridge.
function createComparisonRecorder(identity, read, host) {
    let data = null, timer = null;
    const copy = value => JSON.parse(JSON.stringify(value));
    function sample() {
        if (timer === null) return;
        try {
            const frame = read();
            if (data.frames.length < 201) data.frames.push(copy(frame));
            else stop();
            if (frame.at - data.startedAt >= 20000) stop();
        } catch (error) { data.errors.push(String(error.message)); stop(); }
    }
    function stop() {
        if (timer !== null) host.clearInterval(timer);
        timer = null;
        if (data) data.finished = true;
    }
    function start() {
        stop();
        const first = read();
        data = { identity, startedAt: first.at, frames: [copy(first)], events: [], selections: [], launches: [], exits: [],
            errors: [], truncated: false, finished: false,
            limitations: { lostUnaccounted: 'NOT_RUN: canonical full-pipeline ledger must be exported separately',
                overlapDuration: 'SAMPLED_ONLY; 100ms cadence can miss brief overlaps',
                humanReadability: 'NOT_RUN', entryExit: 'sampled DOM only; pair with screen capture' } };
        timer = host.setInterval(sample, 100);
    }
    function record(kind, value) {
        if (timer === null) return;
        try {
            if (data[kind].length < 2000) data[kind].push(copy(value));
            else { data.truncated = true; stop(); }
        } catch (error) { data.errors.push(String(error.message)); stop(); }
    }
    function result() {
        if (!data) return null;
        const frames = data.frames;
        const counts = {}, overlaps = [], pairDurations = {};
        let visible = 0, unavailable = 0;
        const conditionChanges = [];
        const first = frames[0];
        for (const frame of frames) {
            const boxes = frame.boxes || [], s = frame.surface;
            if (!s || !Array.isArray(frame.boxes)) { unavailable++; continue; }
            for (const key of ['videoID', 'generation', 'playbackRate', 'captions', 'viewport', 'settings', 'surface']) {
                if (JSON.stringify(frame[key]) !== JSON.stringify(first[key]) && !conditionChanges.includes(key)) conditionChanges.push(key);
            }
            visible += boxes.filter(b => b.x < s.right && b.x + b.width > s.left && b.y < s.bottom && b.y + b.height > s.top).length;
            if (frame.paused === true || frame.ad === true) { if (!conditionChanges.includes('pause/ad')) conditionChanges.push('pause/ad'); continue; }
            for (let i = 0; i < boxes.length; i++) for (let j = 0; j < i; j++) {
                const a = boxes[i], b = boxes[j];
                if (a.semanticClass !== 'NORMAL' || b.semanticClass !== 'NORMAL') continue;
                const horizontal = Math.max(0, Math.min(a.x + a.width, b.x + b.width, s.right) - Math.max(a.x, b.x, s.left));
                const vertical = Math.max(0, Math.min(a.y + a.height, b.y + b.height, s.bottom) - Math.max(a.y, b.y, s.top));
                if (horizontal && vertical) {
                    const pair = [a.observationID, b.observationID].sort().join('/');
                    overlaps.push({ at: frame.at, pair, horizontal, vertical, area: horizontal * vertical, crossRow: a.y !== b.y });
                    const previous = pairDurations[pair];
                    if (!previous) pairDurations[pair] = { samples: 1, sampledSpanMs: 0, lastAt: frame.at };
                    else { previous.samples++; if (frame.at - previous.lastAt <= 150) previous.sampledSpanMs += frame.at - previous.lastAt; previous.lastAt = frame.at; }
                }
            }
        }
        for (const e of data.events) counts[e.type] = (counts[e.type] || 0) + (e.count ?? 1);
        return copy({ ...data, summary: { launch: data.launches.length, events: counts,
            capacityDrop: counts.CAPACITY_DROPPED || 0, averageVisibleSampled: frames.length && !unavailable ? visible / frames.length : null,
            unavailableFrames: unavailable, conditionChanges,
            normalOverlapSamples: overlaps, sampledPairDurations: pairDurations,
            maxHorizontalPx: overlaps.reduce((m, x) => Math.max(m, x.horizontal), 0),
            maxVerticalPx: overlaps.reduce((m, x) => Math.max(m, x.vertical), 0),
            lostUnaccounted: null, qualification: 'UNQUALIFIED: inspect lifecycle/settings/scene and obtain real capture + canonical ledger' } });
    }
    return Object.freeze({ start, stop, result,
        event: e => record('events', { type: e.type, count: e.count, at: host.now() }),
        selection: s => record('selections', s), launch: l => record('launches', l), exit: e => record('exits', e) });
}
