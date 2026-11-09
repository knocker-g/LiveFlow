(function () {
  'use strict';
  const P = SyntheticProbe, heldDocument = document;
  if (new URL(document.URL).origin !== P.ORIGIN || P.urlClass(document.URL) !== 'TOP') return;
  const ports = [], rows = [];
  let next = 'TOP', pending = false, finished = false;
  function emit(name, value) {
    heldDocument.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(value) }));
  }
  function finish(status) {
    if (finished) return;
    finished = true;
    const report = { version: 'SPA_PROBE_V1', observer: 'OBSERVER_AFFECTED', status,
      workerContinuity: status === 'COMPLETE' && rows[1]?.documentSame === 'SAME' ? 'OBSERVED_SAME_BINDING' : 'UNKNOWN',
      history: 'EPHEMERAL_SAME_DOCUMENT_ONLY', attempts: ports.length, rows };
    emit('lf-probe-report', report);
    for (const port of ports) { try { port.disconnect(); } catch { /* No reconnect. */ } }
    remove();
  }
  function sample(phase) {
    if (finished) return;
    if (pending || phase !== next || ports.length >= 2 || document !== heldDocument || P.urlClass(heldDocument.URL) !== phase) {
      finish('PHASE_REJECTED'); return;
    }
    pending = true;
    const contentClass = P.urlClass(heldDocument.URL);
    let port, answered = false;
    try {
      port = chrome.runtime.connect({ name: 'SPA_PROBE_V1_' + phase });
      ports.push(port);
      port.onDisconnect.addListener(() => { if (!finished) finish('CONNECTION_LOST'); });
      port.onMessage.addListener(reply => {
        if (finished) return;
        if (answered || !P.validReply(reply) || reply.phase !== phase || document !== heldDocument || P.urlClass(heldDocument.URL) !== phase) {
          finish('PHASE_REJECTED'); return;
        }
        answered = true;
        rows.push({ contentClass, ...reply });
        pending = false;
        if (reply.status !== 'COMPLETE') { finish(reply.status); return; }
        if (phase === 'TOP') { next = 'WATCH'; emit('lf-probe-phase-complete', { phase: 'TOP' }); }
        else finish('COMPLETE');
      });
    } catch { finish('ERROR'); }
  }
  const top = () => sample('TOP'), watch = () => sample('WATCH');
  const ready = () => { if (!finished) emit('lf-probe-ready', { version: 'SPA_PROBE_V1' }); };
  const hide = () => finish('CONNECTION_LOST');
  function remove() {
    heldDocument.removeEventListener('lf-probe-top', top);
    heldDocument.removeEventListener('lf-probe-watch', watch);
    heldDocument.removeEventListener('lf-probe-ready-request', ready);
    globalThis.removeEventListener('pagehide', hide);
  }
  heldDocument.addEventListener('lf-probe-top', top);
  heldDocument.addEventListener('lf-probe-watch', watch);
  heldDocument.addEventListener('lf-probe-ready-request', ready);
  globalThis.addEventListener('pagehide', hide, { once: true });
})();
