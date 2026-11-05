'use strict';

const { createBootstrapCourier } = require('./bootstrap-coordinator.js');
const { validateEnvelope } = require('./bootstrap-contract.js');
const { exactManifest } = require('./production-manifest.js');
const PORT_NAME = 'liveflow-bootstrap-private-v1';
const installedAPIs = new WeakSet();
// Diagnostic-only, incarnation-local seal. Never inferred from queue/lifetime.
let anyRouteAttempted = false;
let workerDiagnostic = null;

function targetFromURL(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !['www.youtube.com','youtube.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
        if (url.pathname === '/watch') { const values = url.searchParams.getAll('v'); return values.length === 1 && values[0] ? values[0] : null; }
        const match = /^\/live\/([^/]+)$/.exec(url.pathname); return match ? decodeURIComponent(match[1]) : null;
    } catch (_) { return null; }
}
function installWorker(api, diagnostic = null) {
    try {
    // One diagnostic instance per incarnation: replacement cannot rearm output.
    if (diagnostic && !workerDiagnostic) workerDiagnostic = diagnostic;
    if (diagnostic !== workerDiagnostic) diagnostic = null;
    if (anyRouteAttempted) diagnostic?.seal();
    if (typeof api?.runtime?.onConnect?.addListener !== 'function' || typeof api?.scripting?.executeScript !== 'function' ||
        typeof api?.runtime?.getManifest !== 'function' || installedAPIs.has(api)) {
        diagnostic?.record('W_API_OR_DUPLICATE_REJECT'); diagnostic?.flush(); return false;
    }
    installedAPIs.add(api);
    let manifest;
    try { manifest = api.runtime.getManifest(); } catch (_) {
        diagnostic?.record('W_MANIFEST_READ_THROW'); diagnostic?.flush(); return false;
    }
    if (!exactManifest(manifest)) {
        diagnostic?.record('W_MANIFEST_REJECT'); diagnostic?.flush(); return false;
    }
    api.runtime.onConnect.addListener(port => {
        let used = false, closed = false;
        try {
            const sender = port.sender, route = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
            const targetId = targetFromURL(sender.url);
            const envelopeTrace = diagnostic ? [0, 0] : undefined;
            const checked = validateEnvelope({ version: 1, operationId: '0'.repeat(32), route,
                result: { status: 'ERROR', stage: 'COORDINATOR', code: 'PERMIT_DENIED' } }, envelopeTrace);
            let rejection = 1;
            if (port.name !== PORT_NAME || (rejection = 2, sender.id !== api.runtime.id) ||
                (rejection = 3, !targetId) || (rejection = 4, !checked.valid) || (rejection = 5, route.frameId !== 0)) {
                port.disconnect(); diagnostic?.record('W_SENDER_REJECT');
                if (diagnostic) diagnostic.record(rejection === 1 ? 'PORT_NAME_MISMATCH' :
                    rejection === 2 ? 'EXTENSION_ID_MISMATCH' : rejection === 3 ? 'TARGET_INVALID' :
                    rejection === 5 ? 'FRAME_INVALID' : envelopeTrace[0] === 1 ? 'ENVELOPE_INVALID_TAB_ID' :
                    envelopeTrace[0] === 2 ? 'ENVELOPE_INVALID_FRAME_ID' : envelopeTrace[0] === 3 ?
                        envelopeTrace[1] === 1 ? 'DOCUMENT_ID_UNDEFINED' : envelopeTrace[1] === 2 ? 'DOCUMENT_ID_NULL' :
                        envelopeTrace[1] === 3 ? 'DOCUMENT_ID_OTHER_NONSTRING' : envelopeTrace[1] === 4 ?
                        'DOCUMENT_ID_STRING_INVALID_FORMAT' : 'ENVELOPE_INVALID_UNCLASSIFIED' : 'ENVELOPE_INVALID_UNCLASSIFIED');
                diagnostic?.flush(); return;
            }
            const original = Object.freeze(checked.value.route);
            port.onDisconnect.addListener(() => { closed = true; });
            port.onMessage.addListener(message => {
                if (used || closed) return;
                used = true;
                if (!message || Object.keys(message).length !== 2 || message.kind !== 'EXTRACT' ||
                    typeof message.operationId !== 'string' || !/^[0-9a-f]{32}$/.test(message.operationId)) { port.disconnect(); return; }
                // This acknowledges one extension-private transport dispatch only.
                // The original ISOLATED Owner already consumed its real permit.
                // No READ Authority, cursor, CP or recovery state exists here.
                const operationId = message.operationId;
                const courier = createBootstrapCourier({ scripting: api.scripting, extensionId: api.runtime.id,
                    channel: port, operationId, consumePermit: request => request.operationId === operationId &&
                        ['tabId','frameId','documentId'].every(key => request.route[key] === original[key]) ? true : null });
                void courier.dispatch();
            });
            anyRouteAttempted = true;
            workerDiagnostic?.seal();
            port.postMessage({ kind: 'ROUTE', route: original, targetId });
        } catch (_) {
            try { port.disconnect(); } catch (_) { /* No retry or reflection. */ }
            diagnostic?.record('W_PRE_ROUTE_SETUP_THROW'); diagnostic?.flush();
        }
    });
    diagnostic?.record('W_LISTENER_REGISTER_RETURNED'); diagnostic?.flush();
    return true;
    } catch (error) {
        diagnostic?.record('W_INSTALL_THROW'); diagnostic?.flush();
        throw error;
    }
}
module.exports = Object.freeze({ installWorker, targetFromURL });
