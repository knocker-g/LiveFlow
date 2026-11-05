'use strict';

// Dormant private-side validation. This module grants no acquisition authority.
const FIELDS = Object.freeze([
    'clientName', 'clientVersion', 'hl', 'gl', 'visitorData', 'userInterfaceTheme',
    'timeZone', 'utcOffsetMinutes', 'platform', 'clientFormFactor', 'browserName',
    'browserVersion', 'osName', 'osVersion', 'screenDensityFloat',
    'screenHeightPoints', 'screenPixelDensity', 'screenWidthPoints'
]);
const MAIN_ERRORS = Object.freeze(['ABSENT_CONTEXT', 'INVALID_SOURCE', 'ACCESSOR_FORBIDDEN',
    'PROTOTYPE_EXHAUSTED', 'INVALID_CONTEXT', 'INVALID_CONTINUATION', 'INVALID_TARGET',
    'INVALID_MODE', 'INVALID_STRING', 'PRECHECK_LIMIT', 'EXTRACTION_EXCEPTION']);
const ERRORS = Object.freeze({ MAIN: MAIN_ERRORS,
    COORDINATOR: ['PERMIT_DENIED', 'DOCUMENT_UNAVAILABLE', 'INJECTION_FAILED', 'RESULT_INVALID', 'RESULT_ROUTE_MISMATCH'],
    OWNER: ['INVALID_RESULT', 'FIELD_TYPE_INVALID', 'INVALID_STRING', 'FIELD_LIMIT',
        'CONTEXT_LIMIT', 'DTO_LIMIT', 'CURRENTNESS_INVALID', 'DEADLINE_EXPIRED', 'DELIVERY_LOST'] });
const LIMITS = Object.freeze({ ordinary: 1024, visitorData: 8192, continuation: 32768,
    targetId: 1024, context: 24576, envelope: 65536 });

function utf8Bytes(value) {
    if (typeof value !== 'string') return null;
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
            bytes += 4;
        } else if (c >= 0xdc00 && c <= 0xdfff) return null;
        else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    return bytes;
}

function fail(code) { throw code; }
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESULT');
    return value;
}
function data(value, key) {
    const d = Object.getOwnPropertyDescriptor(record(value), key);
    if (!d || !Object.hasOwn(d, 'value')) fail('INVALID_RESULT');
    return d.value;
}
function exact(value, keys) {
    record(value);
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail('INVALID_RESULT');
    for (const key of keys) data(value, key);
}
function string(value, cap, nonempty = false) {
    const n = utf8Bytes(value);
    if (n === null) fail('INVALID_STRING');
    if (nonempty && !value.length) fail('INVALID_RESULT');
    if (n > cap) fail('FIELD_LIMIT');
    return value;
}
function field(key, value) {
    if (typeof value === 'string') {
        if (!value.length) fail('FIELD_TYPE_INVALID');
        if (['utcOffsetMinutes', 'screenDensityFloat', 'screenHeightPoints', 'screenPixelDensity', 'screenWidthPoints'].includes(key)) fail('FIELD_TYPE_INVALID');
        return string(value, key === 'visitorData' ? LIMITS.visitorData : LIMITS.ordinary);
    }
    const integer = key === 'clientName' || key === 'utcOffsetMinutes' || key === 'screenHeightPoints' || key === 'screenWidthPoints';
    const density = key === 'screenDensityFloat' || key === 'screenPixelDensity';
    if (typeof value !== 'number' || !(integer ? Number.isSafeInteger(value) : density && Number.isFinite(value)) ||
        (key !== 'clientName' && key !== 'utcOffsetMinutes' && value < 0)) fail('FIELD_TYPE_INVALID');
    return value;
}
function contextProjection(value) {
    exact(value, ['client']);
    const client = data(value, 'client');
    record(client);
    const keys = Reflect.ownKeys(client);
    if (!keys.length || keys.some(key => !FIELDS.includes(key))) fail('INVALID_RESULT');
    const result = { client: Object.create(null) };
    for (const key of FIELDS) if (keys.includes(key)) result.client[key] = field(key, data(client, key));
    if (utf8Bytes(JSON.stringify(result)) > LIMITS.context) fail('CONTEXT_LIMIT');
    return result;
}
function success(value) {
    exact(value, ['status', 'source', 'targetId', 'mode', 'continuation', 'context']);
    const status = data(value, 'status'), source = data(value, 'source'), mode = data(value, 'mode');
    if (status !== 'OK' || !['C1', 'C2', 'C3'].includes(source) || !['live', 'replay'].includes(mode)) fail('INVALID_RESULT');
    return { status: 'OK', source,
        targetId: string(data(value, 'targetId'), LIMITS.targetId, true), mode,
        continuation: string(data(value, 'continuation'), LIMITS.continuation, true),
        context: contextProjection(data(value, 'context')) };
}
function attempt(project) {
    try { return { valid: true, value: project() }; }
    catch (code) { return { valid: false, code: ERRORS.OWNER.includes(code) ? code : 'INVALID_RESULT' }; }
}
function validateMainResult(value) {
    // `valid` means schema/budget validity only, including well-shaped ERRORs.
    // It is not source authentication, currentness, a permit or admission.
    return attempt(() => {
        if (data(value, 'status') === 'OK') return success(value);
        exact(value, ['status', 'code']);
        const status = data(value, 'status'), code = data(value, 'code');
        if (status !== 'ERROR' || !MAIN_ERRORS.includes(code)) fail('INVALID_RESULT');
        return { status: 'ERROR', code };
    });
}
function validateEnvelope(value, diagnosticTrace = undefined) {
    // Actual private sender/route equality, deadline and terminal CAS belong to
    // the future owner. A schema-valid OWNER tag is not courier authorization.
    return attempt(() => {
        exact(value, ['version', 'operationId', 'route', 'result']);
        const operationId = data(value, 'operationId');
        if (data(value, 'version') !== 1 || typeof operationId !== 'string' || !/^[0-9a-f]{32}$/.test(operationId)) fail('INVALID_RESULT');
        const route = data(value, 'route');
        exact(route, ['tabId', 'frameId', 'documentId']);
        const tabId = data(route, 'tabId'), documentId = data(route, 'documentId');
        // Optional private per-call numeric scratch cell; never an admission input.
        // Keep the original upfront tab/document reads and operand short-circuit.
        if (!Number.isSafeInteger(tabId) || tabId < 0) {
            try { if (diagnosticTrace) diagnosticTrace[0] = 1; } catch (_) { /* Evidence only. */ }
            fail('INVALID_RESULT');
        }
        if (data(route, 'frameId') !== 0) {
            try { if (diagnosticTrace) diagnosticTrace[0] = 2; } catch (_) { /* Evidence only. */ }
            fail('INVALID_RESULT');
        }
        if (typeof documentId !== 'string') {
            try { if (diagnosticTrace) {
                diagnosticTrace[0] = 3;
                diagnosticTrace[1] = documentId === undefined ? 1 : documentId === null ? 2 : 3;
            } } catch (_) { /* Evidence only. */ }
            fail('INVALID_RESULT');
        }
        if (!(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(documentId) ||
            (/^[0-9A-Fa-f]{32}$/.test(documentId) && !/^0{32}$/.test(documentId)))) {
            try { if (diagnosticTrace) { diagnosticTrace[0] = 3; diagnosticTrace[1] = 4; } } catch (_) { /* Evidence only. */ }
            fail('INVALID_RESULT');
        }
        const raw = data(value, 'result');
        let result;
        if (data(raw, 'status') === 'OK') result = success(raw);
        else {
            exact(raw, ['status', 'stage', 'code']);
            const stage = data(raw, 'stage'), code = data(raw, 'code');
            if (data(raw, 'status') !== 'ERROR' || typeof stage !== 'string' || typeof code !== 'string' ||
                !Object.hasOwn(ERRORS, stage) || !ERRORS[stage].includes(code)) fail('INVALID_RESULT');
            result = { status: 'ERROR', stage, code };
        }
        const projected = { version: 1, operationId, route: { tabId, frameId: 0, documentId }, result };
        if (utf8Bytes(JSON.stringify(projected)) > LIMITS.envelope) fail('DTO_LIMIT');
        return projected;
    });
}

module.exports = Object.freeze({ FIELDS, MAIN_ERRORS, LIMITS, utf8Bytes, validateMainResult, validateEnvelope });
