importScripts('core.js');
(function () {
  'use strict';
  const P = SyntheticProbe;
  let count = 0, baseline = null, retired = false;
  // Private ephemeral equality operands. Never returned, persisted, or logged.
  // Losing this worker loses the run; WATCH cannot create a new baseline.
  chrome.runtime.onConnect.addListener(port => {
    const phase = port.name === 'SPA_PROBE_V1_TOP' ? 'TOP' : port.name === 'SPA_PROBE_V1_WATCH' ? 'WATCH' : null;
    if (!phase) { retired = true; baseline = null; port.disconnect(); return; }
    count = Math.min(count + 1, 3);
    let reply = P.unknown(phase, 'ERROR');
    try {
      if (retired || count > 2) { retired = true; reply = P.unknown(phase, 'UNEXPECTED_ATTEMPT'); }
      else {
        const sender = port.sender;
        if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0 ||
            new URL(sender.url).origin !== P.ORIGIN) {
          retired = true; reply = P.unknown(phase, 'METADATA_REJECTED');
        } else if ((phase === 'TOP' && count !== 1) || (phase === 'WATCH' && !baseline)) {
          retired = true; reply = P.unknown(phase, 'RUN_LOST');
        } else {
          const key = P.documentKey(sender.documentId);
          const meta = P.metadata(sender);
          if (phase === 'TOP') baseline = { key, tab: sender.tab.id, frame: sender.frameId };
          const sameContext = baseline.tab === sender.tab.id && baseline.frame === sender.frameId;
          reply = { phase, ordinal: phase === 'TOP' ? 1 : 2, status: sameContext ? 'COMPLETE' : 'CONTEXT_REJECTED', ...meta,
            documentSame: sameContext && key && baseline.key ? (key === baseline.key ? 'SAME' : 'DIFFERENT') : 'UNKNOWN' };
          if (!sameContext) retired = true;
          if (phase === 'WATCH') { retired = true; baseline = null; }
        }
      }
      port.onDisconnect.addListener(() => { retired = true; baseline = null; });
      port.postMessage(reply);
    } catch {
      retired = true; baseline = null;
      try { port.postMessage(P.unknown(phase, 'ERROR')); } catch { /* No retry. */ }
    }
  });
})();
