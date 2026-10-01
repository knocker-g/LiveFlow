const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GEOMETRY_STATES,
    DIRTY_SIGNALS,
    computeSubtitleGeometry,
    normalizeCandidateGeometry,
    createGeometryAuthority,
    createSubtitleGeometryAdapter
} = require('../src/geometry-adapter.js');

const video = Object.freeze({ x: 0, y: 0, width: 1280, height: 720 });
const visible = (rect, extra = {}) => ({ visible: true, rect, ...extra });
const compute = (candidates, overrides = {}) => computeSubtitleGeometry({ candidates, videoRect: video, safetyMargin: 8, ...overrides });

test('SUB-01 no subtitle is KNOWN_EMPTY', () => {
    assert.equal(compute([]).state, GEOMETRY_STATES.KNOWN_EMPTY);
});

test('SUB-02 visible subtitle is KNOWN_PRESENT', () => {
    assert.equal(compute([visible({ x: 400, y: 600, width: 200, height: 40 })]).state, GEOMETRY_STATES.KNOWN_PRESENT);
});

test('SUB-03 hidden candidates are ignored', () => {
    assert.equal(compute([{ visible: false, rect: { x: 1, y: 1, width: 20, height: 20 } }]).state, GEOMETRY_STATES.KNOWN_EMPTY);
});

test('SUB-04 zero-size rectangles are ignored', () => {
    assert.equal(compute([visible({ x: 1, y: 1, width: 0, height: 20 })]).state, GEOMETRY_STATES.KNOWN_EMPTY);
});

test('SUB-05 off-video rectangles are ignored', () => {
    assert.equal(compute([visible({ x: 1400, y: 800, width: 20, height: 20 })]).state, GEOMETRY_STATES.KNOWN_EMPTY);
});

test('SUB-06 partial overlap is clamped to video intersection before margin', () => {
    const result = compute([visible({ x: -20, y: 100, width: 40, height: 40 })], { safetyMargin: 0 });
    assert.deepEqual(result.exclusionRegions, [{ x: 0, y: 100, width: 20, height: 40 }]);
});

test('SUB-07 multiple subtitle rectangles remain separate', () => {
    const result = compute([
        visible({ x: 100, y: 600, width: 100, height: 30 }),
        visible({ x: 300, y: 600, width: 100, height: 30 })
    ], { safetyMargin: 0 });
    assert.equal(result.exclusionRegions.length, 2);
});

test('SUB-08 separated rectangles are not replaced by a giant union', () => {
    const result = compute([
        visible({ x: 10, y: 10, width: 20, height: 20 }),
        visible({ x: 1000, y: 600, width: 20, height: 20 })
    ], { safetyMargin: 0 });
    assert.deepEqual(result.exclusionRegions.map(({ width, height }) => [width, height]), [[20, 20], [20, 20]]);
});

test('SUB-09 conservative safety margin expands then clamps regions', () => {
    assert.deepEqual(compute([visible({ x: 10, y: 10, width: 20, height: 20 })]).exclusionRegions[0], { x: 2, y: 2, width: 36, height: 36 });
});

test('SUB-10 invalid visible geometry is UNKNOWN and fail closed', () => {
    assert.equal(compute([visible({ x: Number.NaN, y: 0, width: 10, height: 10 })]).state, GEOMETRY_STATES.UNKNOWN);
    assert.equal(normalizeCandidateGeometry({ renderedRect: {}, videoRect: video, actualVelocity: 1, footprint: {} }).safe, false);
    const authority = createGeometryAuthority({ epsilon: 1 });
    authority.update({ state: GEOMETRY_STATES.KNOWN_PRESENT, exclusionRegions: [{ x: 0, y: 0, width: Number.NaN, height: 1 }], capabilityAvailable: true });
    assert.equal(authority.snapshot().geometry.state, GEOMETRY_STATES.UNKNOWN);
});

test('SUB-11 transition state is UNKNOWN', () => {
    assert.equal(compute([], { transitioning: true }).state, GEOMETRY_STATES.UNKNOWN);
});

test('SUB-12 identical normalized geometry does not advance revision', () => {
    const authority = createGeometryAuthority({ epsilon: 0.5 });
    const geometry = compute([visible({ x: 10, y: 10, width: 20, height: 20 })]);
    assert.equal(authority.update(geometry), true);
    assert.equal(authority.update(geometry), false);
    assert.equal(authority.revision(), 1);
});

test('SUB-13 changes within EPSILON do not advance revision', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    authority.update(compute([visible({ x: 10, y: 10, width: 20, height: 20 })], { safetyMargin: 0 }));
    assert.equal(authority.update(compute([visible({ x: 10.5, y: 10, width: 20, height: 20 })], { safetyMargin: 0 })), false);
});

test('SUB-14 meaningful movement advances revision', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    authority.update(compute([visible({ x: 10, y: 10, width: 20, height: 20 })], { safetyMargin: 0 }));
    assert.equal(authority.update(compute([visible({ x: 20, y: 10, width: 20, height: 20 })], { safetyMargin: 0 })), true);
    assert.equal(authority.revision(), 2);
});

test('SUB-15 subtitle appearance advances revision', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    authority.update(compute([]));
    authority.update(compute([visible({ x: 10, y: 10, width: 20, height: 20 })]));
    assert.equal(authority.revision(), 2);
});

test('SUB-16 subtitle disappearance advances revision', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    authority.update(compute([visible({ x: 10, y: 10, width: 20, height: 20 })]));
    authority.update(compute([]));
    assert.equal(authority.revision(), 2);
});

test('SUB-17 rectangle order alone does not advance revision', () => {
    const authority = createGeometryAuthority({ epsilon: 0 });
    const a = visible({ x: 10, y: 10, width: 20, height: 20 });
    const b = visible({ x: 100, y: 100, width: 20, height: 20 });
    authority.update(compute([a, b], { safetyMargin: 0 }));
    assert.equal(authority.update(compute([b, a], { safetyMargin: 0 })), false);
});

test('SUB-18 fullscreen and observer signals mark dirty without making launch decisions', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    let reads = 0;
    const adapter = createSubtitleGeometryAdapter({ authority, readGeometry: () => { reads += 1; return compute([]); } });
    adapter.refresh();
    assert.equal(adapter.markDirty(DIRTY_SIGNALS.FULLSCREEN), true);
    assert.equal(adapter.status().dirty, true);
    assert.equal(reads, 1);
    assert.equal(adapter.status().geometry.state, GEOMETRY_STATES.KNOWN_EMPTY);
});

test('SUB-19 capability failure disables avoidance without requesting global stop', () => {
    const authority = createGeometryAuthority({ epsilon: 1 });
    const adapter = createSubtitleGeometryAdapter({
        authority,
        readGeometry: () => compute([], { capabilityAvailable: false })
    });
    adapter.refresh();
    assert.equal(adapter.status().geometry.state, GEOMETRY_STATES.UNKNOWN);
    assert.equal(adapter.status().geometry.capabilityAvailable, false);
    assert.equal(adapter.status().globalStopRequired, false);
});

test('SUB-20 raw subtitle text is neither parsed nor retained', () => {
    const result = compute([visible({ x: 10, y: 10, width: 20, height: 20 }, { text: 'private subtitle contents' })]);
    assert.equal(JSON.stringify(result).includes('private subtitle contents'), false);
    assert.equal(Object.hasOwn(result.exclusionRegions[0], 'text'), false);
});

test('candidate geometry preserves full horizontal width but requires complete vertical bounds', () => {
    const footprint = Object.freeze({ width: 300, height: 90, kind: 'SPECIAL' });
    const clipped = normalizeCandidateGeometry({
        renderedRect: { x: -10, y: 10, width: 40, height: 90 },
        videoRect: video,
        actualVelocity: 240,
        footprint
    });
    assert.equal(clipped.safe, true);
    assert.deepEqual(clipped.rectangle, { x: -10, y: 10, width: 40, height: 90, velocity: 240 });
    const bottomClipped = normalizeCandidateGeometry({
        renderedRect: { x: 10, y: 650, width: 40, height: 90 },
        videoRect: video,
        actualVelocity: 240,
        footprint
    });
    assert.equal(bottomClipped.safe, false);
    assert.equal(bottomClipped.rectangle, null);
    const result = normalizeCandidateGeometry({
        renderedRect: { x: 10, y: 10, width: 40, height: 90 },
        videoRect: video,
        actualVelocity: 240,
        footprint
    });
    assert.deepEqual(result.rectangle, { x: 10, y: 10, width: 40, height: 90, velocity: 240 });
    assert.equal(result.footprint, footprint);
});
