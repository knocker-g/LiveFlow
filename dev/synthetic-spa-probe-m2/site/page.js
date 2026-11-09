(function () {
  'use strict';
  const P = SPAProbeM2, button = document.getElementById('run'), stop = document.getElementById('stop');
  const result = document.getElementById('result'), status = document.getElementById('status');
  let started = false, expected = 0;
  document.addEventListener('m2-ready', () => { if (!started) { button.disabled = false; status.textContent = 'Ready. One run only.'; } });
  button.addEventListener('click', () => {
    if (started) return;
    started = true; button.disabled = true; stop.disabled = false;
    status.textContent = 'Running. If no result arrives, Stop once; never reload or retry.';
    document.dispatchEvent(new CustomEvent('m2-phase', { detail: '0' }));
  });
  document.addEventListener('m2-complete', event => {
    if (!started || expected > 2 || event.detail !== JSON.stringify({ phase: expected })) return;
    expected += 1;
    history.pushState(null, '', P.phases[expected] === 'TOP' ? '/top' : '/watch?v=fixture');
    document.dispatchEvent(new CustomEvent('m2-phase', { detail: String(expected) }));
  });
  stop.addEventListener('click', () => { if (started) document.dispatchEvent(new Event('m2-stop')); });
  document.addEventListener('m2-report', event => {
    if (!started || typeof event.detail !== 'string' || event.detail.length > 4096) return;
    try { result.textContent = P.validReport(JSON.parse(event.detail)) ? event.detail : '{"status":"UNKNOWN","reason":"SCHEMA"}'; }
    catch { result.textContent = '{"status":"UNKNOWN","reason":"SCHEMA"}'; }
    stop.disabled = true; status.textContent = 'Stopped. Copy this one JSON; close isolated browser.';
  });
  document.dispatchEvent(new Event('m2-ready-request'));
})();
