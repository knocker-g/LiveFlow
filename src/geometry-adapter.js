(function (global) {
    const GEOMETRY_STATES = Object.freeze({
        KNOWN_EMPTY: 'KNOWN_EMPTY',
        KNOWN_PRESENT: 'KNOWN_PRESENT',
        UNKNOWN: 'UNKNOWN'
    });
    const DIRTY_SIGNALS = Object.freeze({
        MUTATION: 'MUTATION',
        RESIZE: 'RESIZE',
        FULLSCREEN: 'FULLSCREEN',
        VIDEO_GEOMETRY: 'VIDEO_GEOMETRY'
    });

    function validRect(rect) {
        return rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
            rect.width > 0 && rect.height > 0;
    }

    function intersectRect(left, right) {
        if (!validRect(left) || !validRect(right)) return null;
        const x = Math.max(left.x, right.x);
        const y = Math.max(left.y, right.y);
        const edgeX = Math.min(left.x + left.width, right.x + right.width);
        const edgeY = Math.min(left.y + left.height, right.y + right.height);
        if (edgeX <= x || edgeY <= y) return null;
        return { x, y, width: edgeX - x, height: edgeY - y };
    }

    function applyMargin(rect, videoRect, margin) {
        if (!validRect(rect) || !validRect(videoRect) || !Number.isFinite(margin) || margin < 0) return null;
        return intersectRect({
            x: rect.x - margin,
            y: rect.y - margin,
            width: rect.width + margin * 2,
            height: rect.height + margin * 2
        }, videoRect);
    }

    function sortRegions(regions) {
        return regions.slice().sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
    }

    function computeSubtitleGeometry({ candidates, videoRect, safetyMargin, transitioning = false, capabilityAvailable = true } = {}) {
        if (transitioning || !capabilityAvailable || !validRect(videoRect) || !Array.isArray(candidates) ||
            !Number.isFinite(safetyMargin) || safetyMargin < 0) {
            return Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, exclusionRegions: Object.freeze([]), capabilityAvailable: capabilityAvailable === true });
        }
        const regions = [];
        for (const candidate of candidates) {
            if (!candidate || candidate.visible !== true) continue;
            if (!candidate.rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(candidate.rect[key]))) {
                return Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, exclusionRegions: Object.freeze([]), capabilityAvailable: true });
            }
            if (candidate.rect.width <= 0 || candidate.rect.height <= 0) continue;
            const intersection = intersectRect(candidate.rect, videoRect);
            if (!intersection) continue;
            const expanded = applyMargin(intersection, videoRect, safetyMargin);
            if (expanded) regions.push(Object.freeze(expanded));
        }
        const normalized = Object.freeze(sortRegions(regions));
        return Object.freeze({
            state: normalized.length ? GEOMETRY_STATES.KNOWN_PRESENT : GEOMETRY_STATES.KNOWN_EMPTY,
            exclusionRegions: normalized,
            capabilityAvailable: true
        });
    }

    function normalizeCandidateGeometry({ renderedRect, videoRect, actualVelocity, footprint } = {}) {
        if (!validRect(renderedRect) || !validRect(videoRect) || !Number.isFinite(actualVelocity) || actualVelocity <= 0 ||
            !footprint || typeof footprint !== 'object') {
            return Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, safe: false, rectangle: null, footprint: footprint || null });
        }
        const rectangle = intersectRect(renderedRect, videoRect);
        if (!rectangle) return Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, safe: false, rectangle: null, footprint });
        if (renderedRect.y < videoRect.y || renderedRect.y + renderedRect.height > videoRect.y + videoRect.height) {
            return Object.freeze({ state: GEOMETRY_STATES.KNOWN_PRESENT, safe: false, rectangle: null, footprint });
        }
        return Object.freeze({
            state: GEOMETRY_STATES.KNOWN_PRESENT,
            safe: true,
            rectangle: Object.freeze({ ...renderedRect, velocity: actualVelocity }),
            footprint
        });
    }

    function equivalentGeometry(left, right, epsilon) {
        if (!left || !right || left.state !== right.state || left.capabilityAvailable !== right.capabilityAvailable) return false;
        if (left.exclusionRegions.length !== right.exclusionRegions.length) return false;
        for (let index = 0; index < left.exclusionRegions.length; index += 1) {
            const a = left.exclusionRegions[index];
            const b = right.exclusionRegions[index];
            if (['x', 'y', 'width', 'height'].some((key) => Math.abs(a[key] - b[key]) > epsilon)) return false;
        }
        return true;
    }

    function normalizeGeometryState(next) {
        const capabilityAvailable = next?.capabilityAvailable === true;
        const regions = Array.isArray(next?.exclusionRegions) ? sortRegions(next.exclusionRegions) : [];
        const structurallyValid = Object.values(GEOMETRY_STATES).includes(next?.state) &&
            regions.every(validRect) &&
            (next.state !== GEOMETRY_STATES.KNOWN_EMPTY || regions.length === 0) &&
            (next.state !== GEOMETRY_STATES.KNOWN_PRESENT || regions.length > 0) &&
            (next.state !== GEOMETRY_STATES.UNKNOWN || regions.length === 0);
        if (!structurallyValid) {
            return Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, exclusionRegions: Object.freeze([]), capabilityAvailable });
        }
        return Object.freeze({ state: next.state, exclusionRegions: Object.freeze(regions), capabilityAvailable });
    }

    function createGeometryAuthority({ epsilon } = {}) {
        if (!Number.isFinite(epsilon) || epsilon < 0) return null;
        let revision = 0;
        let geometry = Object.freeze({ state: GEOMETRY_STATES.UNKNOWN, exclusionRegions: Object.freeze([]), capabilityAvailable: true });
        function update(next) {
            const normalized = normalizeGeometryState(next);
            if (equivalentGeometry(geometry, normalized, epsilon)) return false;
            geometry = normalized;
            revision += 1;
            return true;
        }
        return Object.freeze({
            update,
            snapshot: () => Object.freeze({ revision, geometry }),
            revision: () => revision
        });
    }

    function createSubtitleGeometryAdapter({ authority, readGeometry } = {}) {
        if (!authority || typeof authority.update !== 'function' || typeof authority.snapshot !== 'function' || typeof readGeometry !== 'function') return null;
        let dirty = true;
        let lastDirtySignal = null;
        function markDirty(signal) {
            if (!Object.values(DIRTY_SIGNALS).includes(signal)) return false;
            dirty = true;
            lastDirtySignal = signal;
            return true;
        }
        function refresh() {
            if (!dirty) return Object.freeze({ refreshed: false, changed: false, ...authority.snapshot() });
            const next = readGeometry();
            const changed = authority.update(next);
            dirty = false;
            return Object.freeze({ refreshed: true, changed, ...authority.snapshot() });
        }
        return Object.freeze({
            markDirty,
            refresh,
            status: () => Object.freeze({ dirty, lastDirtySignal, ...authority.snapshot(), globalStopRequired: false })
        });
    }

    const api = {
        GEOMETRY_STATES,
        DIRTY_SIGNALS,
        intersectRect,
        computeSubtitleGeometry,
        normalizeCandidateGeometry,
        createGeometryAuthority,
        createSubtitleGeometryAdapter
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowGeometryAdapter = api;
})(typeof window !== 'undefined' ? window : globalThis);
