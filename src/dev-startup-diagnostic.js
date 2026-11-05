'use strict';

// DEV build entry only. No Product objects, clocks, storage or async work.
const RESULT_ERRORS = Object.freeze([
    ['COORDINATOR', 'INJECTION_FAILED'], ['COORDINATOR', 'RESULT_INVALID'], ['COORDINATOR', 'RESULT_ROUTE_MISMATCH'],
    ['MAIN', 'ABSENT_CONTEXT'], ['MAIN', 'INVALID_SOURCE'], ['MAIN', 'ACCESSOR_FORBIDDEN'],
    ['MAIN', 'PROTOTYPE_EXHAUSTED'], ['MAIN', 'INVALID_CONTEXT'], ['MAIN', 'INVALID_CONTINUATION'],
    ['MAIN', 'INVALID_TARGET'], ['MAIN', 'INVALID_MODE'], ['MAIN', 'INVALID_STRING'],
    ['MAIN', 'PRECHECK_LIMIT'], ['MAIN', 'EXTRACTION_EXCEPTION']
].map(pair => Object.freeze(pair)));
const CODES = Object.freeze(['C_START_ENTER','C_INSTALL_DENY','C_API_DENY','C_URL_DENY','C_CONTENT_STARTED',
    'C_CONNECT_RETURNED','C_CONNECT_THROW','C_ROUTE_ACCEPTED','C_ROUTE_REJECTED','C_PORT_DISCONNECTED',
    'C_NATIVE_CAPTURE_FAILED','C_ADMISSION_ACCEPTED','C_ADMISSION_DENIED','C_OWNER_CREATED','C_OWNER_NULL',
    'C_CONSTRUCT_THROW','C_EXTRACT_POSTED','C_EXTRACT_POST_FAILED','C_CANDIDATE_MESSAGE_SEEN',
    'C_BOOTSTRAP_ACCEPTED_RETURN','O_PREPERMIT_WAIT',
    'O_PREPERMIT_V1_FACTS_TERMINAL','O_PREPERMIT_V1_MEDIA_INELIGIBLE','O_PREPERMIT_V1_UNCLASSIFIED',
    'O_POLICY_DENIED','O_CAPABILITY_DENIED_UNCLASSIFIED',
    'O_BOOTSTRAP_RESERVED','O_PERMIT_CONSUMED',
    'O_BOOTSTRAP_V2_SCHEMA_INVALID','O_BOOTSTRAP_V2_OPERATION_MISMATCH','O_BOOTSTRAP_V2_ROUTE_MISMATCH',
    ...RESULT_ERRORS.map(pair => 'O_BOOTSTRAP_V3_RESULT_ERROR_' + pair[0] + '_' + pair[1]),
    'O_BOOTSTRAP_V3_RESULT_ERROR_UNCLASSIFIED','O_BOOTSTRAP_V2_MODE_MISMATCH','O_BOOTSTRAP_V2_TARGET_MISMATCH','O_BOOTSTRAP_DEADLINE',
    'O_CURRENTNESS_DENIED','O_READ_ELIGIBILITY_WAIT','O_GRANT_DENIED','O_READ_CALL_REACHED']);
const SCHEMA = Object.freeze({ version: 3, table: 'OWNER_BOOTSTRAP_RESULT_ERROR_V3', slots: 16 });
function createRecorder(consoleReceiver) {
    const slots = new Array(16).fill(-1), seen = new Array(CODES.length).fill(false);
    let size = 0, sent = 0, blocked = false, incomplete = false, emitting = false, faultSent = false, interrupted = false;
    let sink = null;
    try { sink = Function.prototype.bind.call(consoleReceiver.log, consoleReceiver); } catch (_) { incomplete = true; }
    function record(code, stage, resultCode) {
        if (emitting) { incomplete = true; interrupted = true; return; }
        if (code === 'O_BOOTSTRAP_V2_RESULT_ERROR') {
            const pair = RESULT_ERRORS.find(value => stage === value[0] && resultCode === value[1]);
            code = pair ? 'O_BOOTSTRAP_V3_RESULT_ERROR_' + pair[0] + '_' + pair[1] : 'O_BOOTSTRAP_V3_RESULT_ERROR_UNCLASSIFIED';
        }
        const index = CODES.indexOf(code);
        if (index < 0) { incomplete = true; return; }
        if (seen[index]) { incomplete = true; return; }
        seen[index] = true;
        if (size === 16) { incomplete = true; return; }
        slots[size++] = index;
    }
    return Object.freeze({ record,
        block() { if (emitting) { incomplete = true; interrupted = true; } blocked = true; },
        complete() { if (emitting) { incomplete = true; interrupted = true; return; } blocked = false; },
        fault() { incomplete = true; },
        flush() {
            if (emitting) { incomplete = true; interrupted = true; return; }
            if (blocked || !sink) return;
            emitting = true;
            interrupted = false;
            try {
                while (sent < size && !blocked && !interrupted) { const index = slots[sent++]; sink('LF_DEV_STARTUP_V1:' + CODES[index]); }
                if (incomplete && !faultSent && !blocked) { faultSent = true; sink('LF_DEV_STARTUP_V1:DIAG_INCOMPLETE'); }
            } catch (_) { incomplete = true; sink = null; }
            finally { emitting = false; }
        }
    });
}
module.exports = Object.freeze({ createRecorder, CODES, SCHEMA });
