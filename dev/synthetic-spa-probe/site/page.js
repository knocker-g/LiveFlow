'use strict';
const button = document.getElementById('run');
const status = document.getElementById('status');
const result = document.getElementById('result');
let started = false, moved = false;
function safeReport(text) {
  try {
    const v = JSON.parse(text);
    const keys = (o, names) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === names.length && names.every(k => Object.hasOwn(o, k));
    const one = (x, list) => list.includes(x);
    const statuses = ['COMPLETE', 'NOT_OBSERVED', 'CONNECTION_LOST', 'RUN_LOST', 'UNEXPECTED_ATTEMPT', 'PHASE_REJECTED', 'METADATA_REJECTED', 'CONTEXT_REJECTED', 'ERROR'];
    return keys(v, ['version', 'observer', 'status', 'workerContinuity', 'history', 'attempts', 'rows']) &&
      v.version === 'SPA_PROBE_V1' && v.observer === 'OBSERVER_AFFECTED' && one(v.status, statuses) &&
      one(v.workerContinuity, ['OBSERVED_SAME_BINDING', 'UNKNOWN']) && v.history === 'EPHEMERAL_SAME_DOCUMENT_ONLY' &&
      Number.isInteger(v.attempts) && v.attempts >= 0 && v.attempts <= 2 && Array.isArray(v.rows) && v.rows.length <= 2 &&
      v.rows.every((r, i) => keys(r, ['contentClass', 'phase', 'ordinal', 'status', 'senderClass', 'documentPresence', 'documentSame', 'frame', 'lifecycle']) &&
        r.phase === (i === 0 ? 'TOP' : 'WATCH') && r.ordinal === i + 1 && r.contentClass === r.phase && one(r.status, statuses) &&
        one(r.senderClass, ['TOP', 'WATCH', 'OTHER', 'ABSENT', 'ERROR']) && one(r.documentPresence, ['PRESENT', 'ABSENT', 'UNKNOWN']) &&
        one(r.documentSame, ['SAME', 'DIFFERENT', 'UNKNOWN']) && one(r.frame, ['TOP', 'OTHER', 'UNKNOWN']) &&
        one(r.lifecycle, ['active', 'cached', 'prerender', 'pending_deletion', 'UNKNOWN']));
  } catch { return false; }
}
document.addEventListener('lf-probe-ready', () => { if (!started) { button.disabled = false; status.textContent = 'Ready. One run only.'; } });
button.addEventListener('click', () => {
  if (started) return;
  started = true; button.disabled = true;
  status.textContent = 'Running TOP phase. If it stalls, stop; do not reload or retry.';
  document.dispatchEvent(new Event('lf-probe-top'));
});
document.addEventListener('lf-probe-phase-complete', event => {
  if (!started || moved || event.detail !== '{"phase":"TOP"}') return;
  moved = true;
  history.pushState(null, '', '/watch?v=fixture');
  status.textContent = 'Running WATCH phase in the same Document.';
  // pushState has no standard pushstate event. This is an explicit test hint.
  document.dispatchEvent(new Event('lf-probe-watch'));
});
document.addEventListener('lf-probe-report', event => {
  if (!started || typeof event.detail !== 'string' || event.detail.length > 2048) return;
  // The cooperative synthetic page displays only the extension's fixed projection.
  result.textContent = safeReport(event.detail) ? event.detail : '{"status":"UNEXPECTED_OUTPUT_STOP"}';
  status.textContent = 'Finished. Copy the one JSON result, then close the isolated browser.';
});
document.dispatchEvent(new Event('lf-probe-ready-request'));
