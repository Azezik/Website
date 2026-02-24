const assert = require('assert');
const PromoSnapLogic = require('../js/promo-snaplogic.js');

const { applyPromoSnap, deletePromoSnap, listActiveEvents } = PromoSnapLogic;

(function shouldReplaceExistingScheduledEventInsteadOfDuplicating(){
  const events = [
    { id:'ev-stage2', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10', type:'pipeline', active:true, status:'active' }
  ];

  const res = applyPromoSnap(events, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  const active = listActiveEvents(res.events, { leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });

  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].type, 'promo');
  assert.strictEqual(active[0].replacesEventId, 'ev-stage2');

  const original = res.events.find(ev => ev.id === 'ev-stage2');
  assert.strictEqual(original.active, false);
  assert.strictEqual(original.status, 'superseded_by_promo');
})();

(function shouldBeIdempotentWhenSamePromoAppliedTwice(){
  const events = [
    { id:'ev-stage2', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10', type:'pipeline', active:true, status:'active' }
  ];

  const first = applyPromoSnap(events, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  const second = applyPromoSnap(first.events, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });

  assert.strictEqual(second.idempotent, true);
  const active = listActiveEvents(second.events, { leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].type, 'promo');
})();

(function shouldRestoreOriginalEventOnPromoDelete(){
  const base = [
    { id:'ev-stage2', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10', type:'pipeline', active:true, status:'active', payload:{ nextAt:'10:00' } }
  ];

  const created = applyPromoSnap(base, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  const removed = deletePromoSnap(created.events, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });

  const active = listActiveEvents(removed.events, { leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, 'ev-stage2');
  assert.strictEqual(active[0].payload.nextAt, '10:00');
})();

(function shouldCollapsePreexistingDuplicatesToSingleActiveEvent(){
  const events = [
    { id:'ev-a', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10', type:'pipeline', active:true, status:'active' },
    { id:'ev-b', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10', type:'pipeline', active:true, status:'active' }
  ];

  const res = applyPromoSnap(events, { promoId:'promo-1', leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });
  const active = listActiveEvents(res.events, { leadId:'lead-1', stageId:'stage-2', scheduleDate:'2026-02-10' });

  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].type, 'promo');
})();


(function shouldReplaceAcrossStagesByDefaultForSnappedLead(){
  const events = [
    { id:'ev-stage-a', leadId:'lead-1', stageId:'stage-a', scheduleDate:'2026-02-24', type:'pipeline', active:true, status:'active' },
    { id:'ev-stage-b', leadId:'lead-1', stageId:'stage-b', scheduleDate:'2026-02-25', type:'pipeline', active:true, status:'active' }
  ];

  const res = applyPromoSnap(events, { promoId:'promo-x', leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-23' });
  const promo = listActiveEvents(res.events, { leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-23' });

  assert.strictEqual(promo.length, 1);
  assert.deepStrictEqual(promo[0].replacesEventIds.sort(), ['ev-stage-a', 'ev-stage-b']);
  assert.strictEqual(res.events.find(ev => ev.id === 'ev-stage-a').active, false);
  assert.strictEqual(res.events.find(ev => ev.id === 'ev-stage-b').active, false);
})();

(function shouldReplaceFutureStageEventsWhenPromoDateIsEarlier(){
  const events = [
    { id:'ev-24', leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-24', type:'pipeline', active:true, status:'active' },
    { id:'ev-25', leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-25', type:'pipeline', active:true, status:'active' }
  ];

  const res = applyPromoSnap(events, { promoId:'promo-1', leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-23' });
  const promoActive = listActiveEvents(res.events, { leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-23' });

  assert.strictEqual(promoActive.length, 1);
  assert.strictEqual(promoActive[0].type, 'promo');
  assert.deepStrictEqual(promoActive[0].replacesEventIds.sort(), ['ev-24', 'ev-25']);

  const old24 = res.events.find(ev => ev.id === 'ev-24');
  const old25 = res.events.find(ev => ev.id === 'ev-25');
  assert.strictEqual(old24.active, false);
  assert.strictEqual(old25.active, false);

  const deleted = deletePromoSnap(res.events, { promoId:'promo-1', leadId:'lead-1', stageId:'active-snap', scheduleDate:'2026-02-23' });
  assert.strictEqual(deleted.events.find(ev => ev.id === 'ev-24').active, true);
  assert.strictEqual(deleted.events.find(ev => ev.id === 'ev-25').active, true);
})();

console.log('promo-snaplogic tests passed.');
