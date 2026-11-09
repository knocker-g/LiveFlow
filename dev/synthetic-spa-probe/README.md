# Synthetic SPA Port probe

Independent localhost-only MV3 experiment. **RUNTIME_NOT_RUN** at this checkpoint.
It does not import, build, modify or authorize LiveFlow Product, its Authority,
Owner, permits, extraction or reading. Two synthetic test Ports are not permission
for Product retry. No account, cookies, chat, YouTube, DevTools or automation.

## Offline verification

From this directory, run `node --test test/fixture.test.mjs test/static.test.mjs`.
Node core only; no install step or dependency download. Source is loaded directly
as an unpacked test extension; no build/package/ZIP is generated.

## Future human run — separate review and BROWSER_READY required

Do not execute this browser procedure as part of the offline task.

1. Have ChatGPT review the exact pushed commit and manifest. Use a NEW isolated,
   disposable, signed-out Chrome profile, sync off, no unrelated extensions; never
   use regular profiles or copy cookies. Browser creation/launch is not yet done.
2. From this directory, human runs `node server.mjs` in a terminal. It binds only
   127.0.0.1:18765. On `LOCAL_SERVER_UNAVAILABLE_STOP`, stop; do not use another
   port. There are no request logs, network fetches or personal data endpoints.
3. Human loads only the `extension` directory through Chrome's Load unpacked UI.
   Confirm name `Synthetic SPA Port Probe — LOCAL DEV ONLY`. No API permissions,
   broad hosts or Product extension. Match patterns cannot constrain a port;
   Content and Worker both restrict execution to the fixed localhost port.
4. Open `http://127.0.0.1:18765/top` once. Click **Run SPA probe** once when ready.
   The cooperative page explicitly notifies TOP, waits for that result, performs
   pushState to `/watch?v=fixture`, then explicitly notifies WATCH. pushState alone
   emits no standard pushstate event. No reload/ABA control in this minimal run.
5. Copy the single fixed JSON displayed in the page. If waiting never finishes,
   stop and report NOT_OBSERVED; never reconnect, refresh or repeat to fill gaps.
   Stop on unexpected phase/metadata/context/disconnect or extension mismatch.
6. Close only the isolated browser; human stops the local server with Ctrl+C.
   No browser/profile cleanup is performed by this task.

## Interpretation and privacy

Each row reports ordinal 1/TOP or 2/WATCH, Content category, sender URL category,
documentId presence, equality to baseline, frame category and creation-time
lifecycle. URL parsing is strict synthetic route matching, not LiveFlow's parser.
Only browser-originated sender metadata is compared inside this independent Worker.
Raw identity operands remain private and ephemeral; no storage, file download,
telemetry, extra message channel, timers, polling or automatic reconnection.
Events from the cooperative page are test phase hints, never Product Authority.

COMPLETE means the fixed samples were collected, not proof of current-active
target at a later Admission or browser run acceptance. Missing documentId is
ABSENT/UNKNOWN; stable tab/frame never substitutes for Document equality. A
different Document is DIFFERENT. Lifecycle is the connection-time enum only.
Worker loss/restart is not fully observable: WATCH without its private baseline
is RUN_LOST; disconnect stops; any missing result remains NOT_OBSERVED/UNKNOWN.
OBSERVED_SAME_BINDING proves only equality of the two available private metadata
samples, not a durable Worker epoch or historical continuity. Port presence is
not a Worker keepalive guarantee. Reports are bounded to 2 rows / 2048 characters.

All future observations are OBSERVER_AFFECTED and synthetic/cooperative. WATCH
after SPA suggests only that this browser can expose an updated sender URL;
TOP suggests a new Port may not help; OTHER/ABSENT/ERROR/UNKNOWN is inconclusive.
Neither outcome establishes YouTube sender behavior, a Product root cause,
ABA safety, active-current Authority, repair, release PASS or a normative change.
Optional ABA/reload is intentionally omitted; the offline ABA fixture only shows
that endpoint equality cannot establish change history. Do not add runtime cases.
