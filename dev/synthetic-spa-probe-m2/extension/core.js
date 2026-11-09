(function (realm) {
  'use strict';
  const origin = 'http://127.0.0.1:18765';
  const phases = Object.freeze(['TOP', 'WATCH', 'TOP', 'WATCH']);
  const classes = ['TOP', 'WATCH', 'OTHER', 'ABSENT', 'ERROR'];
  const identities = ['SAME', 'DIFFERENT', 'UNKNOWN'];
  const lifecycles = ['active', 'cached', 'prerender', 'pending_deletion', 'UNKNOWN'];
  function urlClass(value) {
    if (value === undefined || value === null) return 'ABSENT';
    if (typeof value !== 'string') return 'ERROR';
    try {
      const u = new URL(value);
      if (u.origin !== origin || u.username || u.password || u.hash) return 'OTHER';
      if (u.pathname === '/top' && !u.search) return 'TOP';
      if (u.pathname === '/watch' && u.search === '?v=fixture') return 'WATCH';
      return 'OTHER';
    } catch { return 'ERROR'; }
  }
  function local(value) {
    try { return typeof value === 'string' && new URL(value).origin === origin; } catch { return false; }
  }
  const key = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : null;
  const lifecycle = value => lifecycles.includes(value) ? value : 'UNKNOWN';
  const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
  function blank(phase) {
    return { phase, status: 'UNKNOWN', contentClass: phases[phase], senderClass: 'ABSENT', senderDocument: 'UNKNOWN', senderLifecycle: 'UNKNOWN',
      event: { status: phase === 0 ? 'NOT_APPLICABLE' : 'NOT_OBSERVED', urlClass: 'ABSENT', document: 'UNKNOWN', lifecycle: 'UNKNOWN', order: 'UNKNOWN' },
      frame: { status: 'NOT_OBSERVED', urlClass: 'ABSENT', document: 'UNKNOWN', lifecycle: 'UNKNOWN' } };
  }
  function validRow(r) {
    return exact(r, ['phase', 'status', 'contentClass', 'senderClass', 'senderDocument', 'senderLifecycle', 'event', 'frame']) &&
      Number.isInteger(r.phase) && r.phase >= 0 && r.phase <= 3 && ['COMPLETE', 'UNKNOWN'].includes(r.status) &&
      r.contentClass === phases[r.phase] && classes.includes(r.senderClass) && identities.includes(r.senderDocument) && lifecycles.includes(r.senderLifecycle) &&
      exact(r.event, ['status', 'urlClass', 'document', 'lifecycle', 'order']) &&
      ['OBSERVED', 'NOT_OBSERVED', 'NOT_APPLICABLE'].includes(r.event.status) && classes.includes(r.event.urlClass) && identities.includes(r.event.document) &&
      lifecycles.includes(r.event.lifecycle) && ['BEFORE_PORT', 'AFTER_PORT', 'AFTER_QUERY', 'UNKNOWN'].includes(r.event.order) &&
      exact(r.frame, ['status', 'urlClass', 'document', 'lifecycle']) && ['OBSERVED', 'NOT_OBSERVED', 'ERROR', 'MISMATCH'].includes(r.frame.status) &&
      classes.includes(r.frame.urlClass) && identities.includes(r.frame.document) && lifecycles.includes(r.frame.lifecycle);
  }
  function validReport(v) {
    return exact(v, ['version', 'observer', 'status', 'reason', 'attempts', 'tabs', 'history', 'rows']) &&
      v.version === 'SPA_M2_V1' && v.observer === 'OBSERVER_AFFECTED' && ['COMPLETE', 'UNKNOWN'].includes(v.status) &&
      ['NONE', 'STATE_LOST', 'METADATA', 'FRAME', 'EVENT', 'EXTRA', 'DISCONNECT', 'PAGEHIDE', 'USER_STOP', 'SCHEMA', 'PHASE', 'ERROR'].includes(v.reason) &&
      Number.isInteger(v.attempts) && v.attempts >= 0 && v.attempts <= 4 && v.tabs === 'NOT_REQUESTED_NO_HOST_PERMISSION' &&
      v.history === 'OBSERVED_ONLY_NOT_COMPLETE_HISTORY' && Array.isArray(v.rows) && v.rows.length <= 4 && v.rows.every((r, i) => validRow(r) && r.phase === i);
  }
  realm.SPAProbeM2 = Object.freeze({ origin, phases, urlClass, local, key, lifecycle, blank, validRow, validReport });
})(globalThis);
