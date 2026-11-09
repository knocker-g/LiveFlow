# Synthetic SPA navigation probe M2

**RUNTIME_NOT_RUN.** Independent localhost DEV experiment. M1 remains untouched.
This directory is loaded as unpacked extension source; no build or package step.
It neither imports nor modifies Product. R5, D8/B5/R7 and release gates stay intact.

## Bounded experiment

One Run SPA probe action performs TOP → WATCH → TOP → WATCH in the original
synthetic Document: four fixed new test Ports, three explicit pushState actions.
Each step waits for one getFrame response and (except initial TOP) its matching
received History event. No retries, polling, keepalive, timers or persistence.
Unknown metadata, mismatch, API failure, disconnect or pagehide stops with UNKNOWN.
If an event/query never arrives, click Stop and report UNKNOWN once; do not refresh
or retry. Missing observations do not prove an operation never happened.

The Content keeps its original Document object; phase events from the cooperative
page are timing hints, never Authority. The Worker matches private browser-provided
tab/frame/document identity to baseline. It compares event document ID/lifecycle
and calls getFrame({tabId, frameId:0, documentId}) exactly once per accepted phase.
The query API validates supplied tab/frame against document ID; results must have
the same documentId and active lifecycle. getFrame need not return frameId: this
experiment relies on the API input-validation contract, not a synthesized result
field. A query is only a snapshot, not a current-active lease at a later grant.

History events are filtered by localhost host, HTTP scheme and fixed port. Callback
also rejects nonlocal URLs and other tabs/frames before storing any event. Only
three sanitized events from the active run are retained. Out-of-order/missing,
extra, wrong-target or replaced-document records stop or remain UNKNOWN. BEFORE_PORT,
AFTER_PORT and AFTER_QUERY describe reception relative to the paired sample, not
an absolute browser clock or complete delivery barrier. No raw timestamps exported.

The only added API permission is webNavigation in THIS extension. It can expose
navigation metadata, so use only a new disposable signed-out profile with no other
tabs/accounts/extensions. No tabs permission, scripting, cookies, storage, debugger,
MAIN injection, Product operation or external network. M1 has no host_permissions;
its content match does not establish tabs.Tab.url access. Therefore **tabs.get is
not invoked** and tabs is NOT_REQUESTED_NO_HOST_PERMISSION. No permission is added
to obtain optional tab URL. The manifest match is port-insensitive; runtime gates
and the event filter restrict actual collection to 127.0.0.1:18765.

## Privacy and interpretation

One JSON: version, OBSERVER_AFFECTED, COMPLETE/UNKNOWN, fixed reason, attempts0..4,
unavailable tabs status, observed-history disclaimer, max4 rows. Each row contains
phase ordinal, fixed Content/sender URL classes, sender Document equality/lifecycle,
event and frame snapshot classifications/equality/lifecycle. Max4096 ASCII bytes,
strict field allowlist at Worker→Content and Content→page. Raw URLs, document/tab/
frame IDs, visitor/account/chat/cookie/token/body/exception strings are never
projected, stored persistently or logged. Raw equality operands live only in private
Worker memory; references are released on retirement. Shared page schema.js is pure
validation/classification code; it holds no extension-private state or API handles.

Worker loss destroys baseline. A later phase cannot create another baseline and
returns STATE_LOST/UNKNOWN. No durable run/restart identity or lossless history is
claimed. Holding test Ports does not guarantee Worker lifetime. A never-delivered
response remains UNKNOWN, not evidence of a rejected browser operation.

COMPLETE is completion of the prescribed samples only. Event WATCH + sender TOP
supports a synthetic source divergence. Same-document getFrame WATCH strengthens
that snapshot comparison only. Neither proves YouTube behavior, original G14 raw
input, a safe Product fix, complete ABA history or atomic current-active Admission.
The fixed ABA sequence demonstrates only received events in this run. Unexpected
behavior is not a license to add Product retry or weaken currentness.

## Offline tests

From the repository/worktree root:

    node --test dev/synthetic-spa-probe-m2/test/fixture.test.mjs dev/synthetic-spa-probe-m2/test/static.test.mjs

Node core only. Tests use actual source and a deterministic VM/event/API fixture;
the local server is not started. M1's 44 tests remain historical; unchanged source
is preserved, and classifier compatibility is checked without claiming new browser
verification. The committed evidence inventory identifies the exact M2 source.

## Future human session — separate review and BROWSER_READY

Do not perform now. ChatGPT first reviews the exact pushed SHA and these files.
Use a NEW isolated signed-out Chrome/Edge profile, sync off, no other extensions
or sites. Close the prior local M1 server through its owning terminal if still
running; this packet does not operate or terminate existing processes.

1. Human runs `node dev/synthetic-spa-probe-m2/server.mjs` from the verified worktree.
   LOCAL_M2_READY is the only ready message. Port collision/error: stop, no alternate
   port or automated process termination.
2. Load only dev/synthetic-spa-probe-m2/extension. Check name Synthetic SPA Navigation
   Probe M2 — LOCAL DEV ONLY, webNavigation only, localhost content scope. No M1 or
   Product extension loaded alongside it. No DevTools/Console/CDP.
3. Open http://127.0.0.1:18765/top. Click Run SPA probe once. The page automatically
   advances all four fixed phases. Do not manually reload, navigate or repeat.
4. Copy the one JSON. If it stalls, Stop and report UNKNOWN once; never poll/retry.
5. Close only this disposable browser and stop this local server in its terminal.

Return only the JSON and any fixed STOP reason. All observations OBSERVER_AFFECTED;
no Product/RC acceptance. No account, YouTube or real chat test is authorized.

API basis (source contracts, not Edge runtime proof):
- https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onHistoryStateUpdated
- https://developer.chrome.com/docs/extensions/reference/api/webNavigation#method-getFrame
- https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions
