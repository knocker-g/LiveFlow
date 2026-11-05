'use strict';

// Dormant in-process observation only. No public channel or Scope completion API.
const pending = require('./pending-selection.js');

function createBridgeAdmissionObserver({ runtime, pendingOwner }) {
    const owner = pending.clonePendingOwner(pendingOwner);
    if (!owner || (runtime !== null && typeof runtime?.enqueue !== 'function')) return null;
    const observations = new WeakMap(), faults = new Set();
    const counts = { attempts: 0, admitted: 0, rejected: 0, unknown: 0 };
    function increment(key) {
        if (counts[key] >= Number.MAX_SAFE_INTEGER) faults.add('COUNTER_OVERFLOW');
        else counts[key]++;
    }
    function snapshot() {
        try {
            if (typeof runtime?.queue?.snapshot !== 'function' || typeof runtime?.status !== 'function' ||
                typeof runtime?.queue?.successfulLaunchSequence !== 'function') return null;
            const items = runtime.queue.snapshot(), state = runtime.status().state;
            const credit = runtime.queue.successfulLaunchSequence();
            if (!Array.isArray(items) || !['IDLE', 'ARMED'].includes(state) || !Number.isSafeInteger(credit) || credit < 0 ||
                items.some(item => !item || !Object.isFrozen(item) || !pending.clonePendingOwner(item.pendingOwner))) return null;
            return { items: items.slice(), credit };
        } catch (_) { return null; }
    }
    function publish(record, status, reason, returned, addedOwned = null) {
        record.receipt = Object.freeze({ status, reason, returned, addedOwned,
            projection: status === 'UNKNOWN' ? null : Object.freeze({
                enqueued: status === 'ADMITTED' ? 1 : 0,
                bridgeAdmissionRejected: status === 'VERIFIED_NO_ADMISSION' ? 1 : 0,
                pendingExplicitDrop: 0 }) });
        increment(status === 'ADMITTED' ? 'admitted' : status === 'VERIFIED_NO_ADMISSION' ? 'rejected' : 'unknown');
        if (status === 'UNKNOWN') faults.add(reason);
    }
    function enqueue(occurrence, payload, options) {
        if (!occurrence || typeof occurrence !== 'object' || observations.has(occurrence)) {
            faults.add('INVALID_OR_DUPLICATE_OCCURRENCE');
            throw new TypeError('INVALID_OR_DUPLICATE_OCCURRENCE');
        }
        const record = { receipt: null };
        observations.set(occurrence, record); increment('attempts');
        if (runtime === null) {
            publish(record, 'VERIFIED_NO_ADMISSION', 'RUNTIME_UNAVAILABLE', false, 0);
            // Arithmetic disposition is known, but no Runtime collector exists.
            faults.add('RUNTIME_UNAVAILABLE');
            return false;
        }
        const before = snapshot();
        let returned;
        try { returned = runtime.enqueue(payload, options); }
        catch (error) {
            const after = snapshot();
            let added = null;
            try {
                if (before && after) added = after.items.filter(item => !before.items.includes(item) && pending.samePendingOwner(item.pendingOwner, owner)).length;
            } catch (_) { /* Incomplete observation must not replace the original exception. */ }
            publish(record, 'UNKNOWN', 'ENQUEUE_THROWN', null, added);
            throw error; // Preserve the original exception, including partial mutation.
        }
        const after = snapshot();
        try {
            if (!before || !after || !pending.samePendingOwner(payload?.pendingOwner, owner)) {
                publish(record, 'UNKNOWN', 'QUEUE_EVIDENCE_UNAVAILABLE', typeof returned === 'boolean' ? returned : null);
                return returned;
            }
            const added = after.items.filter(item => !before.items.includes(item));
            const addedOwned = added.filter(item => pending.samePendingOwner(item.pendingOwner, owner));
            const unchanged = before.credit === after.credit && before.items.length === after.items.length &&
                before.items.every((item, index) => item === after.items[index]);
            if (returned === false && unchanged && addedOwned.length === 0) {
                publish(record, 'VERIFIED_NO_ADMISSION', 'ENQUEUE_DECLINED_NO_ADMISSION', false, 0);
            } else if (returned === true && added.length === 1 && addedOwned.length === 1 &&
                addedOwned[0].payload === payload && before.credit === after.credit && after.items.length === before.items.length + 1 &&
                before.items.every((item, index) => item === after.items[index])) {
                publish(record, 'ADMITTED', 'SUCCESSFUL_ENQUEUE', true, 1);
            } else {
                // A real immediate capacity removal, unusual return, or contradictory
                // result needs its own actual producer. Never reinterpret it as rejection.
                publish(record, 'UNKNOWN', 'ADMISSION_EVIDENCE_INCONSISTENT', typeof returned === 'boolean' ? returned : null, addedOwned.length);
            }
        } catch (_) {
            // Observing a payload/queue descriptor must not replace the actual
            // enqueue return with an instrumentation exception.
            publish(record, 'UNKNOWN', 'ADMISSION_METADATA_UNKNOWN', typeof returned === 'boolean' ? returned : null);
        }
        return returned;
    }
    return Object.freeze({
        enqueue,
        receipt: occurrence => observations.get(occurrence)?.receipt || null,
        status: () => Object.freeze({ ...counts, state: faults.size ? 'UNKNOWN' : 'OBSERVING',
            faults: Object.freeze([...faults]), scopeClosure: 'NOT_IMPLEMENTED' })
    });
}

module.exports = Object.freeze({ createBridgeAdmissionObserver });
