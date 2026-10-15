// Candidate contract model only: does not implement or patch Product transport/Runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
function model({ limit = 8 } = {}) {
    let ownerSequence = 0, operationSequence = 0, active;
    const records = new Map(), operations = new Map(), results = new Map(), pending = [];
    const animations = [{ trajectory: Object.freeze({ x: 100, velocity: 40 }) }];
    const equal = (a, b) => a && b && ['document', 'owner', 'target', 'lifecycle', 'revision'].every(k => a[k] === b[k]);
    function begin(policy) {
        if (policy === 'APPEND' && active) return active;
        active = Object.freeze({ document: 'FIXTURE_DOCUMENT', owner: ++ownerSequence, target: 'FIXTURE_TARGET', lifecycle: 0, revision: 0 });
        records.set(active.owner, { binding: active, input: 0, removed: 0, retired: false }); return active;
    }
    function batch(binding, count, acquisition, renderer, epoch) {
        for (let i = 0; i < count; i++) pending.push({ binding, acquisition, renderer, epoch });
        records.get(binding.owner).input += count;
    }
    function command(binding) {
        if (operations.size >= limit) return null; // Never evict unresolved reconciliation.
        const op = Object.freeze({ operation: ++operationSequence, binding, reason: 'FAIL_CLOSED' });
        operations.set(op.operation, { op, ack: null }); records.get(binding.owner).retired = true; return op;
    }
    function clear(op) {
        const registered = operations.get(op.operation);
        if (!registered || !equal(registered.op.binding, op.binding) || op.reason !== registered.op.reason) return { status: 'NOT_APPLIED_UNKNOWN', count: 0 };
        if (results.has(op.operation)) return { ...results.get(op.operation), status: 'DUPLICATE' };
        if (pending.some(p => !p.binding || !records.has(p.binding.owner))) return { status: 'NOT_APPLIED_UNKNOWN', count: 0 };
        // Model for proposed selective primitive; existing Runtime has no such method yet.
        const actual = pending.filter(p => equal(p.binding, op.binding));
        for (let i = pending.length - 1; i >= 0; i--) if (equal(pending[i].binding, op.binding)) pending.splice(i, 1);
        records.get(op.binding.owner).removed += actual.length; // One event source only.
        const ack = Object.freeze({ operation: op.operation, binding: op.binding, reason: op.reason,
            status: actual.length ? 'APPLIED' : 'STALE_OR_NOT_FOUND', count: actual.length });
        results.set(op.operation, ack); return ack;
    }
    function receive(ack) {
        const r = operations.get(ack.operation), original = results.get(ack.operation);
        if (!r || !equal(r.op.binding, ack.binding) || ack.reason !== r.op.reason || !original ||
            ack.count !== original.count || !['APPLIED', 'STALE_OR_NOT_FOUND', 'DUPLICATE'].includes(ack.status)) return false;
        r.ack ||= original; return true; // Never add ACK count to canonical event count again.
    }
    function closed(binding) {
        return !pending.some(p => equal(p.binding, binding)) &&
            [...operations.values()].filter(r => equal(r.op.binding, binding)).every(r => r.ack);
    }
    return { begin, batch, command, clear, receive, closed, pending, records, animations };
}
test('same segment survives request/renderer/diagnostic generation changes', () => {
    const m = model(), a = m.begin('REPLACE');
    m.batch(a, 2, 7, 1, 0); const b = m.begin('APPEND'); m.batch(b, 1, 8, 3, 1);
    assert.equal(a, b); const op = m.command(a), ack = m.clear(op);
    assert.equal(ack.count, 3); assert.equal(m.records.get(a.owner).removed, 3);
    assert.equal(m.closed(a), false); m.receive(ack); assert.equal(m.closed(a), true);
});
test('delayed old clear selectively removes old owner, preserves mixed new queue and active trajectories', () => {
    const m = model(), a = m.begin('REPLACE'); m.batch(a, 2, 7, 1, 0);
    const op = m.command(a), b = m.begin('REPLACE'); m.batch(b, 3, 8, 1, 1);
    const active = m.animations[0], ack = m.clear(op); assert.equal(ack.count, 2);
    assert.equal(m.pending.length, 3); assert.ok(m.pending.every(p => p.binding === b));
    assert.equal(m.animations[0], active); assert.equal(m.records.get(b.owner).removed, 0);
    assert.equal(m.clear(op).status, 'DUPLICATE'); assert.equal(m.records.get(a.owner).removed, 2);
    m.receive(ack); m.receive(m.clear(op)); assert.equal(m.records.get(a.owner).removed, 2);
});
test('out of order ACKs and owner rotation do not reconcile another operation', () => {
    const m = model(), a = m.begin('REPLACE'); m.batch(a, 1, 1, 1, 0); const x = m.command(a);
    const b = m.begin('REPLACE'); m.batch(b, 2, 2, 1, 1); const y = m.command(b);
    const ax = m.clear(x), ay = m.clear(y);
    assert.equal(m.receive({ ...ay, binding: a }), false); assert.equal(m.closed(a), false);
    m.receive(ay); assert.equal(m.closed(a), false); m.receive(ax); assert.equal(m.closed(a), true);
});
test('unknown composition and missing ACK never permit a fake closure', () => {
    const m = model(), a = m.begin('REPLACE'); m.batch(a, 2, 1, 1, 0); const op = m.command(a);
    m.pending.push({ binding: null }); assert.equal(m.clear(op).status, 'NOT_APPLIED_UNKNOWN');
    assert.equal(m.pending.length, 3); assert.equal(m.closed(a), false);
    m.pending.pop(); m.clear(op); assert.equal(m.pending.length, 0); assert.equal(m.closed(a), false);
});
test('bounded pending operation registry refuses admission rather than evicting unresolved owner', () => {
    const m = model({ limit: 1 }), a = m.begin('REPLACE'); m.batch(a, 1, 1, 1, 0); m.command(a);
    assert.equal(m.command(a), null); assert.equal(m.closed(a), false); assert.equal(m.pending.length, 1);
});
