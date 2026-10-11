# Bounded role retention evidence

## Boundary and minimal change

`scheduleDanmakuBatch` passes the normalized comment as `payload.message` to Scheduler enqueue. The accepted author-role contract supplies lower-case owner/moderator/member/guest; raw badge interpretation is unchanged.

`scheduler-state-machine.js` prunes stale items, computes pressure/density, and evaluates safe candidates before relief. When selection is absent, `scheduler-runtime.js` permits one relief only at MAX_READABLE with observed physical collision saturation. The first bad boundary was `pending-selection.js` / `relieveSaturation`: it chose the oldest NORMAL regardless of normalized role.

Relief now selects the first ordinary NORMAL (including Member, Guest, missing/unknown role), then the first remaining NORMAL (Owner/Moderator). Within each tier, existing queue order is preserved. SPECIAL remains more protected than all NORMAL: the existing SPECIAL-only saturation policy still retains it until normal temporal expiry or independent emergency safety. No new SPECIAL drop path is introduced.

Only the relief candidate search changed. Safe launch selection, bounded temporal cohort, modular scan order, lane/collision proof, Source Activity, pacing/density thresholds, stale expiry, and emergency oldest-first hard-count removal are unchanged. Owner/Moderator remain NORMAL; no role priority or dedicated lane is added. Protection is bounded: after ordinary NORMAL is exhausted, protected NORMAL can also be relieved.

## Deterministic evidence

- Before Production change, two new guards fail: the queue drops Owner/Moderator before Member/Guest/Unknown; the runtime drops Owner before a newer Member at physical saturation.
- Queue guard after fix: Member -> Guest -> Unknown -> Owner -> Moderator drop order, with SPECIAL retained; same-tier queue ordering preserved.
- Runtime mixed fixture: at MAX_READABLE physical saturation, Member and Guest are relieved first. Once geometry becomes safe, SPECIAL and both protected NORMAL comments launch through the existing selector. Five inputs = three launches + two explicit capacity drops + zero retained; lostUnaccounted=0.
- Role-bearing safe fixture has exactly the same launch order as an otherwise identical guest fixture. This compares actual existing modular scan behavior rather than assuming global FIFO launch.
- All four roles retain the same stale boundary: age 1000 retained, age 1001 explicitly stale-pruned. Owner/Moderator catch-up launches=0. Four inputs = four explicit stale drops; lostUnaccounted=0.
- Independent emergency hard count drops an oldest Owner before a newer Guest. Existing SPECIAL emergency/stale guards remain valid.
- Existing Source Activity/density, one-opportunity, NORMAL progress, SPECIAL preference/protection, READ-only and Safety guards pass. This is deterministic policy evidence; no new real-browser/density visual claim is made.

Role normalization and styling are separate responsibilities. No next issue was started.
