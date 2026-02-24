# Promo SnapLogic Overwrite Investigation

## Scope checked
I searched this repository for promotion, cohort, lead pipeline, stage scheduling, and overwrite/replacement flows that would explain duplicate event creation during promo snap application.

## Findings
- No promotion/snap-application domain code exists in this repository (no `promotion`, `promo`, `cohort`, `lead`, `stage`, or scheduling modules for CRM-style events were found outside unrelated OCR/UI wording).
- The only widespread uses of "event" are browser/UI handlers and OCR trace diagnostics, not business scheduling records.
- Because of that, the reported behavior (promo creating duplicate lead events instead of overwriting Stage 2) cannot be validated or patched directly in this codebase.

## Likely root cause pattern (for the service that owns promo scheduling)
In the scheduler service that applies promo snaps, the write path is likely performing **append/create** semantics instead of an **idempotent upsert/replace** keyed by the lead's active schedule identity.

Typical failure modes:
1. Match key too weak/incorrect (matching only date, not `leadId + pipelineStageId + eventSlot` or canonical event id).
2. Promo application always inserts a new event row/document before retiring prior active event.
3. Existing-event lookup scoped incorrectly (wrong cohort subset, stale index, or different status filter).
4. Missing single-source-of-truth invariant (multiple "active" events allowed for same lead/date).

## Recommended correction model
Implement promo snap as transactional replacement:
1. Resolve canonical current active scheduled event for target lead/stage/date.
2. Persist a linkage record:
   - `promoEvent.replacesEventId = originalEventId`
   - `originalEvent.replacedByPromoEventId = promoEventId`
3. Mark original event inactive/superseded (do not leave two active rows).
4. Enforce DB uniqueness for active schedule identity (e.g., unique index on `leadId + scheduleDate + active=true` or stricter stage-slot key).
5. On promo deletion, restore by linkage (`replacesEventId`) and reactivate original.

## Verification checklist for owning service
- During promo create, log: lookup query, matched event id, and replacement action.
- Assert postcondition: exactly one active scheduled event per lead/date (or lead/stage/date).
- Add integration tests:
  - create promo over existing stage event => one active event, promo linked to original
  - delete promo => original event restored with exact prior state
  - repeat promo create (idempotency) => no duplicate active events

## Notes
If you share the repository/service that contains promotion scheduling, I can patch this directly with concrete code and tests.
