/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OCRTrace = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_MAX_EVENTS = 20000;
  const CONFUSION_PAIRS = [
    ['O', '0'],
    ['0', 'O'],
    ['o', '0'],
    ['I', '1'],
    ['1', 'I'],
    ['l', '1'],
    ['1', 'l'],
    ['S', '5'],
    ['5', 'S'],
    ['T', '7'],
    ['7', 'T'],
    ['B', '8'],
    ['8', 'B']
  ];

  const safeString = (val) => (val === null || val === undefined ? '' : String(val));

  function estimateCharDelta(before = '', after = '') {
    const a = safeString(before);
    const b = safeString(after);
    if (!a && !b) return 0;
    const minLen = Math.min(a.length, b.length);
    let diff = Math.abs(a.length - b.length);
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) diff += 1;
    }
    return diff;
  }

  function confusionDelta(before = '', after = '') {
    const a = safeString(before);
    const b = safeString(after);
    const minLen = Math.min(a.length, b.length);
    const counts = {};
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) continue;
      const key = `${a[i]}->${b[i]}`;
      if (CONFUSION_PAIRS.some(([from, to]) => from === a[i] && to === b[i])) {
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }

  function createTraceSession(meta = {}) {
    const runId = `ocrtrace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const enabled = !!meta.enabled;
    return {
      runId,
      startedAt: Date.now(),
      enabled,
      meta: { ...meta },
      events: [],
      maxEvents: Number.isFinite(meta.maxEvents) ? meta.maxEvents : DEFAULT_MAX_EVENTS,
      truncated: false
    };
  }

  function traceEvent(session, event = {}) {
    if (!session || !session.enabled) return false;
    if (session.events.length >= session.maxEvents) {
      if (!session.truncated) {
        session.events.push({
          ts: Date.now(),
          stage: 'other',
          rule: 'trace.truncated',
          before: '',
          after: '',
          deltaSummary: { note: 'trace limit reached', maxEvents: session.maxEvents }
        });
        session.truncated = true;
      }
      return false;
    }
    const before = safeString(event.before);
    const after = safeString(event.after);
    const deltaSummary = event.deltaSummary || {
      charDelta: estimateCharDelta(before, after),
      changed: before !== after
    };
    session.events.push({
      ts: Date.now(),
      docId: event.docId || null,
      pageIndex: Number.isFinite(event.pageIndex) ? event.pageIndex : null,
      fieldKey: event.fieldKey || null,
      stage: event.stage || 'other',
      rule: event.rule || 'unspecified',
      before,
      after,
      deltaSummary,
      confidenceBefore: event.confidenceBefore ?? null,
      confidenceAfter: event.confidenceAfter ?? null,
      confidenceDelta: event.confidenceDelta ?? null,
      source: event.source || 'unknown',
      tokenContext: event.tokenContext || null,
      patched: event.patched ?? null,
      meta: event.meta || null
    });
    return true;
  }

  function summarizeEvents(events = []) {
    const ruleStats = new Map();
    const stageStats = new Map();
    const fieldStats = new Map();
    const overridesByStage = new Map();
    const confusionTotals = {};
    const lastByField = new Map();
    let totalChanges = 0;
    let totalCharDelta = 0;
    let anyFieldRuns = 0;
    let anyFieldPatched = 0;
    let anyFieldConfSum = 0;
    let anyFieldConfCount = 0;
    let anyFieldConfMin = null;
    let anyFieldConfMax = null;

    events.forEach((ev) => {
      const changed = ev.before !== ev.after;
      const ruleKey = ev.rule || 'unspecified';
      const stageKey = ev.stage || 'other';
      const fieldKey = ev.fieldKey || '__unknown__';

      if (!ruleStats.has(ruleKey)) ruleStats.set(ruleKey, { rule: ruleKey, changes: 0, charDelta: 0, count: 0 });
      if (!stageStats.has(stageKey)) stageStats.set(stageKey, { stage: stageKey, count: 0, changes: 0 });
      if (!fieldStats.has(fieldKey)) fieldStats.set(fieldKey, { fieldKey, count: 0, changes: 0, stages: {} });

      const delta = typeof ev.deltaSummary?.charDelta === 'number'
        ? ev.deltaSummary.charDelta
        : estimateCharDelta(ev.before, ev.after);

      ruleStats.get(ruleKey).count += 1;
      stageStats.get(stageKey).count += 1;
      fieldStats.get(fieldKey).count += 1;

      if (changed) {
        totalChanges += 1;
        totalCharDelta += delta;
        ruleStats.get(ruleKey).changes += 1;
        ruleStats.get(ruleKey).charDelta += delta;
        stageStats.get(stageKey).changes += 1;
        fieldStats.get(fieldKey).changes += 1;
      }
      fieldStats.get(fieldKey).stages[stageKey] = (fieldStats.get(fieldKey).stages[stageKey] || 0) + 1;

      if (fieldKey) {
        if (changed && lastByField.has(fieldKey)) {
          overridesByStage.set(stageKey, (overridesByStage.get(stageKey) || 0) + 1);
        }
        if (changed) lastByField.set(fieldKey, ev.after);
      }

      if (stageKey === 'any_field_tesseract_patch') {
        anyFieldRuns += 1;
        if (changed) anyFieldPatched += 1;
        const conf = ev.confidenceAfter;
        if (typeof conf === 'number') {
          anyFieldConfSum += conf;
          anyFieldConfCount += 1;
          anyFieldConfMin = anyFieldConfMin === null ? conf : Math.min(anyFieldConfMin, conf);
          anyFieldConfMax = anyFieldConfMax === null ? conf : Math.max(anyFieldConfMax, conf);
        }
      }

      if (changed) {
        const confusions = confusionDelta(ev.before, ev.after);
        Object.entries(confusions).forEach(([key, count]) => {
          confusionTotals[key] = (confusionTotals[key] || 0) + count;
        });
      }
    });

    const topRules = Array.from(ruleStats.values())
      .sort((a, b) => b.changes - a.changes || b.charDelta - a.charDelta)
      .slice(0, 20);

    return {
      totals: {
        events: events.length,
        changes: totalChanges,
        charDelta: totalCharDelta
      },
      topRules,
      stages: Array.from(stageStats.values()),
      overridesByStage: Array.from(overridesByStage.entries()).map(([stage, count]) => ({ stage, count })),
      anyFieldVerifier: {
        runs: anyFieldRuns,
        patched: anyFieldPatched,
        avgConfidence: anyFieldConfCount ? anyFieldConfSum / anyFieldConfCount : null,
        minConfidence: anyFieldConfMin,
        maxConfidence: anyFieldConfMax
      },
      fields: Array.from(fieldStats.values())
        .sort((a, b) => b.changes - a.changes || b.count - a.count),
      confusionPairs: confusionTotals
    };
  }

  function finalizeTrace(session) {
    if (!session) return { meta: {}, events: [], summary: {} };
    const events = Array.isArray(session.events) ? session.events.slice() : [];
    return {
      meta: {
        runId: session.runId,
        startedAt: session.startedAt,
        endedAt: Date.now(),
        truncated: !!session.truncated,
        ...session.meta
      },
      events,
      summary: summarizeEvents(events)
    };
  }

  function downloadTrace(report, filename = '') {
    if (!report) return false;
    try {
      const payload = JSON.stringify(report, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `ocr-trace-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (err) {
      console.error('OCR trace download failed', err);
      alert('Failed to download OCR trace report.');
      return false;
    }
  }

  return {
    createTraceSession,
    traceEvent,
    finalizeTrace,
    downloadTrace
  };
});

/*
Sample OCR trace report (shape only, values redacted):
{
  "meta": {
    "runId": "ocrtrace_1700000000000_ab12cd",
    "startedAt": 1700000000000,
    "endedAt": 1700000000500,
    "docType": "invoice",
    "wizardId": "default"
  },
  "events": [
    {
      "ts": 1700000000100,
      "docId": "file123",
      "pageIndex": 0,
      "fieldKey": "invoice_total",
      "stage": "field_normalize",
      "rule": "normalizeOcrDigits",
      "before": "$I39.99",
      "after": "$139.99",
      "deltaSummary": { "charDelta": 1, "changed": true },
      "confidenceBefore": null,
      "confidenceAfter": null,
      "source": "unknown"
    }
  ],
  "summary": {
    "totals": { "events": 12, "changes": 6, "charDelta": 18 },
    "topRules": [],
    "stages": [],
    "overridesByStage": [],
    "anyFieldVerifier": { "runs": 1, "patched": 0 },
    "fields": [],
    "confusionPairs": {}
  }
}
*/
