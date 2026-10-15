(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LiveFlowDiagnosticScopeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    // Diagnostic transport only. Never gates a read, launch or lifecycle transition.
    function createScopes(lifecycle, value, apply, { maximumBuffered = 64, maximumArchives = 8,
        closureValid = () => true, closureReady = () => true } = {}) {
        let epoch = 0, discardedIncomplete = 0;
        const scopes = new Map();
        const make = (generation, data) => ({ epoch, lifecycle: generation, value: data,
            sequence: 0, terminal: false, waiting: false, fault: false, buffer: new Map() });
        scopes.set(epoch, make(lifecycle, value));
        function complete(s) { return s.terminal && !s.waiting && !s.fault && s.buffer.size === 0; }
        function reconcile() {
            for (const s of scopes.values()) if (s.waiting && closureReady(s.value)) {
                s.waiting = false;
                if (!closureValid(s.value)) s.fault = true;
            }
        }
        function open(generation, data) {
            epoch += 1;
            scopes.set(epoch, make(generation, data));
            while (scopes.size > maximumArchives + 1) {
                const [id, old] = scopes.entries().next().value;
                if (!complete(old)) discardedIncomplete += 1;
                scopes.delete(id);
            }
            return epoch;
        }
        function receive(message) {
            const s = scopes.get(message.diagnosticScopeEpoch);
            const seq = message.diagnosticSequence;
            if (!s || message.pageLifecycleGeneration !== s.lifecycle ||
                !Number.isSafeInteger(seq) || seq < 1) return false;
            if (seq <= s.sequence || s.buffer.has(seq)) return false;
            if (s.terminal) {
                // A CLOSED terminal archive is immutable; report late transport faults outside it.
                if (complete(s)) discardedIncomplete += 1;
                else s.fault = true;
                return false;
            }
            if (s.buffer.size >= maximumBuffered || seq > s.sequence + maximumBuffered) {
                s.fault = true; return false;
            }
            s.buffer.set(seq, message);
            let applied = false;
            while (s.buffer.has(s.sequence + 1) && !s.terminal) {
                const next = s.buffer.get(s.sequence + 1);
                s.buffer.delete(++s.sequence);
                apply(s.value, next);
                if (next.diagnosticIncomplete === true) s.fault = true;
                if (next.diagnosticTerminal === true) {
                    s.terminal = true;
                    s.waiting = !closureReady(s.value);
                    if (!s.waiting && !closureValid(s.value)) s.fault = true;
                }
                applied = true;
            }
            if (s.terminal && s.buffer.size) s.fault = true;
            return applied && s.epoch === epoch;
        }
        function status() {
            return { epoch, discardedIncomplete,
                incomplete: discardedIncomplete > 0 || [...scopes.values()].some(s =>
                    s.fault || s.waiting || !closureReady(s.value) || s.buffer.size > 0 || s.sequence === 0 || (s.epoch !== epoch && !complete(s))),
                scopes: [...scopes.values()].map(s => ({ epoch: s.epoch, lifecycle: s.lifecycle,
                    sequence: s.sequence, buffered: s.buffer.size,
                    state: s.fault || s.waiting || !closureReady(s.value) || s.buffer.size || s.sequence === 0 || (s.epoch !== epoch && !complete(s)) ? 'INCOMPLETE' :
                        s.terminal ? 'CLOSED' : 'OPEN', value: s.value })) };
        }
        return Object.freeze({ open, receive, reconcile, status, currentEpoch: () => epoch,
            currentLifecycle: () => scopes.get(epoch).lifecycle });
    }
    return Object.freeze({ createScopes });
});
