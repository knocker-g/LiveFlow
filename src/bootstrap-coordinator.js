'use strict';

const extractBootstrap = require('./bootstrap-extractor.js');
const { validateMainResult, validateEnvelope } = require('./bootstrap-contract.js');

// Dormant private-channel adapter, not a runtime listener or acquisition owner.
// consumePermit is a private harness port until M2 supplies the real owner.
// Only true/false recognizes the original operation (grant/denial). Anything
// else, including a lost reply, is unrecognized: no reflected application DTO.
// A valid route/schema or operationId is correlation, never READ authority.
function createBootstrapCourier({ scripting, extensionId, channel, operationId, consumePermit }) {
    let started = false, active = true, subscribed = false;
    let port = channel, permit = consumePermit, execute = null, route = null;
    const outcome = status => Object.freeze({ status });

    function release() {
        active = false;
        if (subscribed) {
            subscribed = false;
            try { port.onDisconnect.removeListener(interrupt); } catch { /* No retry or raw error. */ }
        }
        port = null; permit = null; execute = null;
    }
    function interrupt() { release(); }

    // Browser MessageSender only; no payload-selected route, URL or function.
    try {
        const sender = port.sender;
        const candidate = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
        const checked = validateEnvelope({ version: 1, operationId, route: candidate,
            result: { status: 'ERROR', stage: 'COORDINATOR', code: 'PERMIT_DENIED' } });
        if (typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId) && sender.id === extensionId &&
            checked.valid && typeof permit === 'function' && typeof port.postMessage === 'function' &&
            typeof port.onDisconnect.addListener === 'function' && typeof port.onDisconnect.removeListener === 'function' &&
            typeof scripting.executeScript === 'function') {
            route = Object.freeze(checked.value.route);
            execute = scripting.executeScript.bind(scripting);
            // Observe the original channel as soon as this operation is bound,
            // including a disconnect before dispatch is called.
            subscribed = true;
            port.onDisconnect.addListener(interrupt);
        }
    } catch { release(); /* No reflection for unrouteable/unavailable input. */ }

    function envelope(result) {
        return validateEnvelope({ version: 1, operationId, route, result });
    }
    function error(code) {
        return { status: 'ERROR', stage: 'COORDINATOR', code };
    }
    function deliver(result) {
        if (!active) return outcome('INTERRUPTED');
        let checked = envelope(result);
        // Owner validation failures must not be asserted by this courier.
        if (!checked.valid) checked = envelope(error('RESULT_INVALID'));
        if (!checked.valid) return outcome('DROPPED');
        // Terminal before calling the original channel (including reentrancy).
        const destination = port;
        release();
        try {
            destination.postMessage(checked.value);
            return outcome('DELIVERED'); // Sent, NOT an owner admission/receipt ACK.
        } catch { return outcome('INTERRUPTED'); }
    }
    function inspect(results) {
        if (!Array.isArray(results) || results.length !== 1) return error('RESULT_INVALID');
        const item = results[0];
        if (!item || typeof item !== 'object') return error('RESULT_INVALID');
        if (item.frameId !== route.frameId || item.documentId !== route.documentId) return error('RESULT_ROUTE_MISMATCH');
        const checked = validateMainResult(item.result);
        if (!checked.valid) return error('RESULT_INVALID');
        return checked.value.status === 'OK' ? checked.value
            : { status: 'ERROR', stage: 'MAIN', code: checked.value.code };
    }
    async function dispatch() {
        if (started) return outcome('IGNORED');
        started = true;
        if (!active || !route || !execute) { release(); return outcome('DROPPED'); }
        try {
            let granted;
            try { granted = await permit(Object.freeze({ operationId, route })); }
            catch { return outcome('INTERRUPTED'); }
            if (!active) return outcome('INTERRUPTED');
            if (granted !== true && granted !== false) return outcome('DROPPED');
            if (granted === false) return deliver(error('PERMIT_DENIED'));
            let results;
            try {
                results = await execute({ target: { tabId: route.tabId, documentIds: [route.documentId] },
                    world: 'MAIN', func: extractBootstrap });
            } catch { return deliver(error('INJECTION_FAILED')); }
            if (!active) return outcome('INTERRUPTED');
            return deliver(inspect(results));
        } catch { return deliver(error('RESULT_INVALID')); }
        finally { release(); }
    }
    return Object.freeze({ dispatch, interrupt });
}

module.exports = Object.freeze({ createBootstrapCourier });
