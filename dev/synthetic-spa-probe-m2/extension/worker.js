importScripts('core.js');
(function () {
  'use strict';
  const P = SPAProbeM2;
  let baseline = null, attempts = 0, retired = false, pending = null;
  const events = [], ports = [];
  function send(port, value) { try { port.postMessage(value); } catch { retired = true; baseline = null; } }
  function stop(reason) {
    if (retired) return;
    retired = true; baseline = null;
    if (pending) { const p = pending; pending = null; send(p.port, { reason, row: p.row }); }
    else for (const port of ports) send(port, { reason, row: null });
  }
  function complete() {
    if (retired || !pending || !pending.queried) return;
    const p = pending, e = p.phase === 0 ? null : events[p.phase - 1];
    if (p.phase > 0 && !e) return; // No timer, polling or fabricated missing-event result.
    if (e) p.row.event = e;
    if (p.row.frame.status !== 'OBSERVED' || p.row.frame.document !== 'SAME' ||
        p.row.frame.urlClass !== P.phases[p.phase] || p.row.frame.lifecycle !== 'active') { stop('FRAME'); return; }
    if (p.phase > 0 && (e.document !== 'SAME' || e.urlClass !== P.phases[p.phase] || e.lifecycle !== 'active')) { stop('EVENT'); return; }
    p.row.status = 'COMPLETE'; pending = null;
    if (p.phase === 3) { retired = true; baseline = null; }
    send(p.port, { reason: 'NONE', row: p.row });
  }
  chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
    try {
      // Reject all nonlocal data BEFORE retaining any event or identity.
      if (!P.local(details.url) || !baseline || retired || details.tabId !== baseline.tab || details.frameId !== 0) return;
      const index = events.length;
      if (index >= 3 || index + 1 > attempts) { stop('EXTRA'); return; }
      const doc = P.key(details.documentId);
      const event = { status: 'OBSERVED', urlClass: P.urlClass(details.url), document: doc ? (doc === baseline.doc ? 'SAME' : 'DIFFERENT') : 'UNKNOWN',
        lifecycle: P.lifecycle(details.documentLifecycle), order: pending?.phase === index + 1 ? (pending.queried ? 'AFTER_QUERY' : 'AFTER_PORT') : 'BEFORE_PORT' };
      events.push(event);
      if (event.document !== 'SAME' || event.urlClass !== P.phases[index + 1] || event.lifecycle !== 'active') { if (pending) pending.row.event = event; stop('EVENT'); return; }
      complete();
    } catch { stop('ERROR'); }
  }, { url: [{ schemes: ['http'], hostEquals: '127.0.0.1', ports: [18765] }] });
  chrome.runtime.onConnect.addListener(port => {
    const match = /^SPA_M2_([0-3])$/.exec(port.name);
    if (!match) { stop('EXTRA'); try { port.disconnect(); } catch {} return; }
    const phase = Number(match[1]);
    if (retired || pending || phase !== attempts || attempts >= 4) {
      send(port, { reason: !baseline && phase > 0 ? 'STATE_LOST' : 'EXTRA', row: P.blank(phase) }); stop('EXTRA'); return;
    }
    attempts += 1; ports.push(port);
    const row = P.blank(phase);
    pending = { phase, port, row, queried: false };
    port.onDisconnect.addListener(() => stop('DISCONNECT'));
    try {
      const sender = port.sender, doc = P.key(sender?.documentId);
      if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0 ||
          !P.local(sender.url) || !doc || P.lifecycle(sender.documentLifecycle) !== 'active') { stop('METADATA'); return; }
      if (phase === 0) baseline = { doc, tab: sender.tab.id };
      if (!baseline) { stop('STATE_LOST'); return; }
      row.senderClass = P.urlClass(sender.url); row.senderLifecycle = P.lifecycle(sender.documentLifecycle);
      row.senderDocument = doc === baseline.doc && sender.tab.id === baseline.tab ? 'SAME' : 'DIFFERENT';
      if (row.senderDocument !== 'SAME') { stop('METADATA'); return; }
      const capture = pending;
      // The query validates supplied tab/frame/document identifiers. It is a snapshot, not a lease.
      Promise.resolve(chrome.webNavigation.getFrame({ tabId: baseline.tab, frameId: 0, documentId: baseline.doc })).then(frame => {
        if (retired || pending !== capture) return;
        if (!frame) { capture.queried = true; stop('FRAME'); return; }
        const id = P.key(frame.documentId);
        capture.row.frame = { status: P.local(frame.url) && !frame.errorOccurred ? 'OBSERVED' : 'MISMATCH', urlClass: P.local(frame.url) ? P.urlClass(frame.url) : 'OTHER',
          document: id ? (id === baseline.doc ? 'SAME' : 'DIFFERENT') : 'UNKNOWN', lifecycle: P.lifecycle(frame.documentLifecycle) };
        capture.queried = true;
        if (capture.row.frame.status !== 'OBSERVED' || capture.row.frame.document !== 'SAME' || capture.row.frame.urlClass !== P.phases[phase] || capture.row.frame.lifecycle !== 'active') stop('FRAME');
        else complete();
      }).catch(() => { if (!retired && pending === capture) { capture.row.frame.status = 'ERROR'; stop('FRAME'); } });
    } catch { stop('ERROR'); }
  });
})();
