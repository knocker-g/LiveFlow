(function () {
  'use strict';
  const P = SPAProbeM2, held = document;
  if (!P.local(held.URL) || P.urlClass(held.URL) !== 'TOP') return;
  const rows = [], ports = [];
  let next = 0, pending = false, finished = false;
  function emit(type, value) { held.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(value) })); }
  function finish(reason) {
    if (finished) return;
    finished = true;
    const report = { version: 'SPA_M2_V1', observer: 'OBSERVER_AFFECTED', status: reason === 'NONE' ? 'COMPLETE' : 'UNKNOWN', reason,
      attempts: ports.length, tabs: 'NOT_REQUESTED_NO_HOST_PERMISSION', history: 'OBSERVED_ONLY_NOT_COMPLETE_HISTORY', rows };
    emit('m2-report', report);
    held.removeEventListener('m2-phase', sample); held.removeEventListener('m2-ready-request', ready); held.removeEventListener('m2-stop', stop);
    globalThis.removeEventListener('pagehide', hide);
    for (const port of ports) { try { port.disconnect(); } catch {} }
  }
  function sample(event) {
    if (finished) return;
    if (pending || document !== held || event.detail !== String(next) || next >= 4 || P.urlClass(held.URL) !== P.phases[next]) { finish('PHASE'); return; }
    const phase = next; pending = true;
    try {
      const port = chrome.runtime.connect({ name: 'SPA_M2_' + phase }); ports.push(port);
      let answered = false;
      port.onDisconnect.addListener(() => finish('DISCONNECT'));
      port.onMessage.addListener(message => {
        if (finished) return;
        try {
          const reason = message.reason, row = message.row;
          if (!message || Object.keys(message).length !== 2 || !['NONE', 'STATE_LOST', 'METADATA', 'FRAME', 'EVENT', 'EXTRA', 'DISCONNECT', 'ERROR'].includes(reason)) { finish('SCHEMA'); return; }
          if (reason !== 'NONE' && row === null) { finish(reason); return; }
          if (answered || !P.validRow(row) || row.phase !== phase || document !== held || P.urlClass(held.URL) !== P.phases[phase]) { finish('SCHEMA'); return; }
          answered = true; rows.push(row); pending = false;
          if (reason !== 'NONE' || row.status !== 'COMPLETE') { finish(reason === 'NONE' ? 'SCHEMA' : reason); return; }
          next += 1;
          if (next === 4) finish('NONE'); else emit('m2-complete', { phase });
        } catch { finish('SCHEMA'); }
      });
    } catch { finish('ERROR'); }
  }
  const ready = () => emit('m2-ready', { version: 'SPA_M2_V1' });
  const stop = () => finish('USER_STOP'), hide = () => finish('PAGEHIDE');
  held.addEventListener('m2-phase', sample); held.addEventListener('m2-ready-request', ready); held.addEventListener('m2-stop', stop);
  globalThis.addEventListener('pagehide', hide, { once: true });
})();
