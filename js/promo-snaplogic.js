(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromoSnapLogic = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  function cloneEvent(event){ return { ...(event || {}) }; }

  function parseDateValue(value){
    if(typeof value !== 'string' || !value) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  function isOnOrAfter(dateA, dateB){
    const a = parseDateValue(dateA);
    const b = parseDateValue(dateB);
    if(a === null || b === null) return String(dateA || '') >= String(dateB || '');
    return a >= b;
  }

  function buildScheduleKey(event, opts = {}){
    const useStage = opts.matchStage !== false;
    return [event?.leadId || '', event?.scheduleDate || '', useStage ? (event?.stageId || '') : ''].join('::');
  }

  function listActiveEvents(events = [], scheduleRef = {}, opts = {}){
    const key = buildScheduleKey(scheduleRef, opts);
    return events.filter(ev => !!ev?.active && buildScheduleKey(ev, opts) === key);
  }

  function deactivateEvent(event, reason, atISO){
    return {
      ...cloneEvent(event),
      active: false,
      status: reason || 'superseded',
      endedAtISO: atISO || new Date().toISOString()
    };
  }

  function activateEvent(event, atISO){
    return {
      ...cloneEvent(event),
      active: true,
      status: 'active',
      restoredAtISO: atISO || new Date().toISOString()
    };
  }

  function assertSingleActive(events = [], scheduleRef = {}, opts = {}){
    const active = listActiveEvents(events, scheduleRef, opts);
    if(active.length > 1){
      const ids = active.map(ev => ev.id || '(missing-id)');
      throw new Error(`Schedule invariant violated: multiple active events for key ${buildScheduleKey(scheduleRef, opts)} => ${ids.join(', ')}`);
    }
    return active[0] || null;
  }

  function applyPromoSnap(events = [], promo = {}, opts = {}){
    const atISO = promo.appliedAtISO || new Date().toISOString();
    const ref = {
      leadId: promo.leadId,
      scheduleDate: promo.scheduleDate,
      stageId: promo.stageId
    };
    if(!ref.leadId || !ref.scheduleDate) throw new Error('promo.leadId and promo.scheduleDate are required');
    if(!promo.promoId) throw new Error('promo.promoId is required');

    const next = events.map(cloneEvent);
    const activeForKey = listActiveEvents(next, ref, opts);

    const existingPromo = activeForKey.find(ev => ev.type === 'promo' && ev.promoId === promo.promoId);
    if(existingPromo){
      return { events: next, promoEvent: existingPromo, replacedEvent: null, idempotent: true };
    }

    const shouldMatchStageForReplacement = opts.replaceAcrossStages === false ? (opts.matchStage !== false) : false;
    const replacementTargets = next.filter(ev => {
      if(!ev?.active || ev.type === 'promo') return false;
      if(ev.leadId !== ref.leadId) return false;
      if(shouldMatchStageForReplacement && (ev.stageId || null) !== (ref.stageId || null)) return false;
      return isOnOrAfter(ev.scheduleDate, ref.scheduleDate);
    });

    replacementTargets.forEach((target) => {
      const replaceIdx = next.findIndex(ev => ev.id === target.id);
      if(replaceIdx < 0) return;
      next[replaceIdx] = {
        ...deactivateEvent(next[replaceIdx], 'superseded_by_promo', atISO),
        replacedByPromoId: promo.promoId
      };
    });

    const toReplace = replacementTargets[0] || activeForKey.find(ev => ev.type !== 'promo') || activeForKey[0] || null;

    const promoEventId = promo.eventId || `promo:${promo.promoId}:${ref.leadId}:${ref.scheduleDate}:${ref.stageId || 'all'}`;
    const promoEvent = {
      id: promoEventId,
      leadId: ref.leadId,
      stageId: ref.stageId || null,
      scheduleDate: ref.scheduleDate,
      type: 'promo',
      promoId: promo.promoId,
      active: true,
      status: 'active',
      createdAtISO: atISO,
      replacesEventId: toReplace?.id || null,
      replacesEventIds: replacementTargets.map(ev => ev.id)
    };

    next.forEach((ev, idx) => {
      if(ev.id === promoEvent.id){
        next[idx] = deactivateEvent(ev, 'replaced_by_newer_promo_event', atISO);
      }
    });

    next.push(promoEvent);

    const activeAfter = listActiveEvents(next, ref, opts).filter(ev => ev.active);
    if(activeAfter.length > 1){
      for(let i = 0; i < activeAfter.length - 1; i += 1){
        const ev = activeAfter[i];
        const idx = next.findIndex(item => item.id === ev.id);
        if(idx >= 0) next[idx] = deactivateEvent(next[idx], 'superseded_for_uniqueness', atISO);
      }
    }

    assertSingleActive(next, ref, opts);
    return { events: next, promoEvent, replacedEvent: toReplace || null, idempotent: false };
  }

  function deletePromoSnap(events = [], promo = {}, opts = {}){
    const atISO = promo.deletedAtISO || new Date().toISOString();
    const ref = {
      leadId: promo.leadId,
      scheduleDate: promo.scheduleDate,
      stageId: promo.stageId
    };
    if(!ref.leadId || !ref.scheduleDate) throw new Error('promo.leadId and promo.scheduleDate are required');
    if(!promo.promoId) throw new Error('promo.promoId is required');

    const next = events.map(cloneEvent);
    const active = listActiveEvents(next, ref, opts);
    const activePromo = active.find(ev => ev.type === 'promo' && ev.promoId === promo.promoId);
    if(!activePromo){
      return { events: next, restoredEvent: null, promoEvent: null, noOp: true };
    }

    const promoIdx = next.findIndex(ev => ev.id === activePromo.id);
    if(promoIdx >= 0){
      next[promoIdx] = deactivateEvent(next[promoIdx], 'promo_deleted', atISO);
    }

    const replacedIds = Array.isArray(activePromo.replacesEventIds) && activePromo.replacesEventIds.length
      ? activePromo.replacesEventIds
      : (activePromo.replacesEventId ? [activePromo.replacesEventId] : []);

    let restoredEvent = null;
    replacedIds.forEach((replacedId) => {
      const prevIdx = next.findIndex(ev => ev.id === replacedId);
      if(prevIdx < 0) return;
      const restored = {
        ...activateEvent(next[prevIdx], atISO),
        replacedByPromoId: null
      };
      next[prevIdx] = restored;
      if(!restoredEvent) restoredEvent = restored;
    });

    assertSingleActive(next, ref, opts);
    return { events: next, restoredEvent, promoEvent: next[promoIdx] || null, noOp: false };
  }

  return {
    buildScheduleKey,
    listActiveEvents,
    assertSingleActive,
    applyPromoSnap,
    deletePromoSnap
  };
});
