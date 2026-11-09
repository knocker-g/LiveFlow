(function (realm) {
  'use strict';
  const ORIGIN = 'http://127.0.0.1:18765';
  function urlClass(value) {
    if (value === undefined || value === null) return 'ABSENT';
    if (typeof value !== 'string') return 'ERROR';
    try {
      const u = new URL(value);
      if (u.origin !== ORIGIN || u.username || u.password || u.hash) return 'OTHER';
      if (u.pathname === '/top' && !u.search) return 'TOP';
      if (u.pathname === '/watch' && u.search === '?v=fixture') return 'WATCH';
      return 'OTHER';
    } catch { return 'ERROR'; }
  }
  function documentKey(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : null;
  }
  function metadata(sender) {
    try {
      const key = documentKey(sender.documentId);
      const frame = sender.frameId;
      const lifecycle = sender.documentLifecycle;
      return {
        senderClass: urlClass(sender.url),
        documentPresence: key ? 'PRESENT' : sender.documentId == null ? 'ABSENT' : 'UNKNOWN',
        frame: frame === 0 ? 'TOP' : Number.isSafeInteger(frame) && frame > 0 ? 'OTHER' : 'UNKNOWN',
        lifecycle: ['active', 'cached', 'prerender', 'pending_deletion'].includes(lifecycle) ? lifecycle : 'UNKNOWN'
      };
    } catch { return { senderClass: 'ERROR', documentPresence: 'UNKNOWN', frame: 'UNKNOWN', lifecycle: 'UNKNOWN' }; }
  }
  const statuses = ['COMPLETE', 'NOT_OBSERVED', 'CONNECTION_LOST', 'RUN_LOST', 'UNEXPECTED_ATTEMPT', 'PHASE_REJECTED', 'METADATA_REJECTED', 'CONTEXT_REJECTED', 'ERROR'];
  function exact(object, keys) {
    return object && Object.getPrototypeOf(object) === Object.prototype &&
      Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k));
  }
  function validReply(v) {
    return exact(v, ['phase', 'ordinal', 'status', 'senderClass', 'documentPresence', 'documentSame', 'frame', 'lifecycle']) &&
      ['TOP', 'WATCH'].includes(v.phase) && v.ordinal === (v.phase === 'TOP' ? 1 : 2) && statuses.includes(v.status) &&
      ['TOP', 'WATCH', 'OTHER', 'ABSENT', 'ERROR'].includes(v.senderClass) &&
      ['PRESENT', 'ABSENT', 'UNKNOWN'].includes(v.documentPresence) &&
      ['SAME', 'DIFFERENT', 'UNKNOWN'].includes(v.documentSame) &&
      ['TOP', 'OTHER', 'UNKNOWN'].includes(v.frame) &&
      ['active', 'cached', 'prerender', 'pending_deletion', 'UNKNOWN'].includes(v.lifecycle);
  }
  function unknown(phase, status) {
    return { phase, ordinal: phase === 'TOP' ? 1 : 2, status, senderClass: 'ABSENT', documentPresence: 'UNKNOWN', documentSame: 'UNKNOWN', frame: 'UNKNOWN', lifecycle: 'UNKNOWN' };
  }
  realm.SyntheticProbe = Object.freeze({ ORIGIN, urlClass, documentKey, metadata, validReply, unknown });
})(globalThis);
