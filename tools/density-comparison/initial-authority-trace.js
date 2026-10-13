// Dev-only collector: injected into generated MAIN, never manifest-loaded in Production.
function createInitialAuthorityTrace(identity) {
    const capacity = 256, buffer = new Array(capacity);
    const provenance = {};
    for (const key of ['sourceSHA', 'commonBuildID']) {
        if (typeof identity?.[key] === 'string' && /^[a-f0-9]{40,64}$/.test(identity[key])) provenance[key] = identity[key];
    }
    let sequence = 0, count = 0, cursor = 0, collectorFault = false, firstMismatch = null;
    const numeric = new Set(['lifecycle', 'revision', 'generation', 'epoch', 'activeGeneration',
        'readCount', 'messageCount', 'transitionCount', 'mismatchCount', 'mismatchDelta']);
    const enums = new Set(('UNKNOWN NONE NOT_INITIALIZED PRESENT ABSENT VISIBLE HIDDEN PAUSED PLAYING ENDED SEEKING INVALID_TIMING ' +
        'CURRENT STALE SUPPORTED UNSUPPORTED ALLOWED DENIED ACCEPTED REJECTED SUCCESS FAILURE NO_OP ' +
        'BOOTSTRAP SEQUENTIAL REANCHOR OBSERVED_UNUSED CONSUMED INVALID AUTHORIZED CLAIMED ' +
        'STOPPED BOOTSTRAPPING READING BUFFER_PAUSED SUSPENDED REANCHORING AD MEDIA_PAUSED ' +
        'FORBIDDEN_EVENT PHASE_MISMATCH FORBIDDEN_LEGACY_TRANSITION CAPABILITY_PATH_MISMATCH ' +
        'AUTHORITY_FAILURE AUTHORITY_INVALID AUTHORITY_STALE AUTHORITY_CONSUMED AUTHORITY_REPEATED AUTHORITY_KIND_MISMATCH ' +
        'GRANT_INVALID GRANT_CONSUMED BOOTSTRAP_RESPONSE SEQUENTIAL_RESPONSE REANCHOR_RESPONSE ' +
        'LIFECYCLE_START BOOTSTRAP_AUTHORIZED BOOTSTRAP_SUCCEEDED BOOTSTRAP_FAILED SEQUENTIAL_AUTHORIZED SEQUENTIAL_SUCCEEDED ' +
        'INITIAL_ALIGNMENT_REQUIRED SEEK_STARTED SEEK_COMPLETED HIDDEN_ENTER VISIBLE_ENTER AD_ENTER AD_EXIT_READY ' +
        'MEDIA_PAUSE MEDIA_PLAY PLAYBACK_RATE_CHANGED BUFFER_HIGH_WATERMARK BUFFER_LOW_WATERMARK ' +
        'EARLY_RESUME_AUTHORIZED EARLY_RESUME_COMPLETED REANCHOR_SUCCEEDED REANCHOR_FAILED DISABLE ' +
        'GENERATION_INVALIDATED TARGET_REPLACED PRECONDITION_FAILED STARTED AUTHORIZATION_FAILED AD_ACTIVE ' +
        'NEW_PAGE_STATE PAGE_STATE_REJECTED NAV_INVALIDATE MODE_TRANSITION READ_START READ_START_REJECTED READ_STOP ' +
        'READ_REQUEST_BEGIN READ_RESPONSE_RECEIVED BOOTSTRAP_TARGET_MISMATCH PAGE_STATE_STALE STALE_GENERATION').split(' '));
    for (const value of ('SEQUENTIAL_FAILED EARLY_RESUME_ELIGIBLE REANCHOR_AUTHORIZED TARGET_CHANGED NAVIGATION ' +
        'CAPABILITY_LOST CAPABILITY_REQUIRED_UNAVAILABLE LEGACY_IMPLICIT_BOOTSTRAP RAW_DEFERRED_START_PATH').split(' ')) enums.add(value);
    const fields = new Set(['visibility', 'media', 'phase', 'beforePhase', 'afterPhase', 'event', 'path', 'reason',
        'kind', 'authorityState', 'beforeState', 'afterState', 'grantState', 'outcome', 'ownership', 'currentness',
        'capability', 'failure', 'mismatch', 'retention', 'inFlight']);
    for (const reason of ['NAVIGATION_PENDING', 'AUTHORITY_NOT_CURRENT', 'TARGET_NOT_CURRENT',
        'WAIT_AUTHORITY_CHANGED', 'WAIT_MEDIA_CHANGED']) enums.add(reason);
    for (const reason of ['WINDOW_OR_ORIGIN', 'SOURCE_GUARD', 'EXPECTED_LIFECYCLE', 'REEVALUATION_DISABLED']) enums.add(reason);
    function record(step, details = {}) {
        try {
            // Step labels are compile-time instrumentation constants, not arbitrary payload strings.
            if (typeof step !== 'string' || !/^[A-Z_]+$/.test(step) || step.length > 64) { collectorFault = true; return; }
            const row = { sequence: ++sequence, step };
            for (const key of [...numeric, ...fields]) {
                const value = details[key];
                if (value === undefined) continue;
                if (numeric.has(key) && Number.isSafeInteger(value) && value >= 0) row[key] = value;
                else if (fields.has(key)) row[key] = enums.has(value) ? value : 'UNKNOWN';
            }
            buffer[cursor] = row; cursor = (cursor + 1) % capacity; count = Math.min(capacity, count + 1);
            if (!firstMismatch && row.mismatchDelta > 0) firstMismatch = {
                sequence: row.sequence, event: row.event, path: row.path, mismatch: row.mismatch,
                beforePhase: row.beforePhase, afterPhase: row.afterPhase
            };
        } catch { collectorFault = true; }
    }
    function fault() { collectorFault = true; }
    function snapshot() {
        const rows = Array.from({ length: count }, (_, i) => ({ ...buffer[(cursor - count + i + capacity) % capacity] }));
        return { profile: 'INITIAL_AUTHORITY_ORDER_V1', identity: { ...provenance }, capacity,
            total: sequence, truncated: sequence > capacity, collectorFault, firstMismatch: firstMismatch ? { ...firstMismatch } : null, rows };
    }
    return Object.freeze({ record, fault, snapshot });
}
module.exports = { createInitialAuthorityTrace };
