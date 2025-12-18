(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const COMMON_SUBS = require('./common-subs.js');
    const layer1 = require('./ocrmagic-layer1.js');
    module.exports = factory(COMMON_SUBS, layer1);
  } else {
    root.OcrMagicPipeline = factory(root.COMMON_SUBS, root.OCRMagicLayer1 || root);
  }
})(typeof self !== 'undefined' ? self : this, function (COMMON_SUBS, layer1Module) {
  if (!COMMON_SUBS) {
    throw new Error('COMMON_SUBS module is required for OCRMAGIC pipeline.');
  }

  const MAGIC_DATA_TYPE = {
    ANY: 'any',
    TEXT: 'text_only',
    NUMERIC: 'numeric_only'
  };

  const station1_layer1Adjacency = layer1Module?.station1_layer1Adjacency
    || layer1Module?.runBaseOcrMagic
    || ((raw = '') => ({ l1Text: String(raw ?? ''), layer1Flags: [], layer1Edits: [], rulesApplied: [] }));

  function normalizeMagicType(value) {
    const v = String(value ?? '').toLowerCase();
    if (!v) return MAGIC_DATA_TYPE.ANY;
    if (v.includes('text')) return MAGIC_DATA_TYPE.TEXT;
    if (v.includes('num')) return MAGIC_DATA_TYPE.NUMERIC;
    if (v === MAGIC_DATA_TYPE.TEXT) return MAGIC_DATA_TYPE.TEXT;
    if (v === MAGIC_DATA_TYPE.NUMERIC) return MAGIC_DATA_TYPE.NUMERIC;
    return MAGIC_DATA_TYPE.ANY;
  }

  const isAlnum = (ch) => /[A-Za-z0-9]/.test(ch);

  function ensureLength(arr = [], len = 0) {
    const out = Array.isArray(arr) ? arr.slice() : [];
    while (out.length < len) out.push(0);
    return out;
  }

  class SegmentModelStore {
    constructor(storageKey = 'ocrmagic.segmentStore', { persist = true } = {}) {
      this.storageKey = storageKey;
      this.persist = persist && typeof localStorage !== 'undefined';
      this.records = this.persist ? this.loadFromStorage() : {};
    }

    loadFromStorage() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return {};
        return JSON.parse(raw) || {};
      } catch (err) {
        return {};
      }
    }

    save() {
      if (!this.persist || typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.records));
      } catch (err) {
        /* ignore persistence errors in sandbox */
      }
    }

    getRecord(segmentKey, slotLength = 0) {
      const rec = this.records[segmentKey] || {
        letterScore: [],
        numberScore: [],
        dvEligible: 0,
        dvContradictions: 0,
        deliberateViolation: false
      };
      rec.letterScore = ensureLength(rec.letterScore, slotLength);
      rec.numberScore = ensureLength(rec.numberScore, slotLength);
      this.records[segmentKey] = rec;
      return rec;
    }

    updateScores(segmentKey, slotString) {
      const rec = this.getRecord(segmentKey, slotString.length);
      for (let i = 0; i < slotString.length; i++) {
        const ch = slotString[i];
        if (!COMMON_SUBS.isAmbiguous(ch)) {
          if (/[0-9]/.test(ch)) rec.numberScore[i] = (rec.numberScore[i] || 0) + 5;
          else if (/[A-Za-z]/.test(ch)) rec.letterScore[i] = (rec.letterScore[i] || 0) + 5;
        }
      }
      this.records[segmentKey] = rec;
      this.save();
      return rec;
    }

    updateDvStats(segmentKey, { dvEligible = 0, dvContradictions = 0 } = {}) {
      const rec = this.getRecord(segmentKey);
      rec.dvEligible += dvEligible;
      rec.dvContradictions += dvContradictions;
      this.records[segmentKey] = rec;
      this.save();
      return rec;
    }

    resetField({ wizardId = '', fieldName = '' } = {}) {
      const prefix = `${wizardId}::${fieldName}::`;
      let removed = false;
      Object.keys(this.records).forEach((key) => {
        if (prefix.trim() && key.startsWith(prefix)) {
          delete this.records[key];
          removed = true;
        }
      });
      if (removed) this.save();
      return removed;
    }
  }

  const defaultSegmentStore = new SegmentModelStore();

  function station2_magicType(text = '', magicType = MAGIC_DATA_TYPE.ANY) {
    const typed = [];
    const typeEdits = [];
    const normalized = normalizeMagicType(magicType);
    const source = String(text ?? '');
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      let next = ch;
      if (normalized === MAGIC_DATA_TYPE.TEXT && COMMON_SUBS.isAmbiguousDigit(ch)) {
        next = COMMON_SUBS.digitToLetter(ch, source[i - 1] || '');
      } else if (normalized === MAGIC_DATA_TYPE.NUMERIC && COMMON_SUBS.isAmbiguousLetter(ch)) {
        next = COMMON_SUBS.letterToDigit(ch);
      }
      if (next !== ch && COMMON_SUBS.isValidOcrMagicSubstitution(ch, next)) {
        typeEdits.push({ index: i, from: ch, to: next });
      }
      typed.push(next);
    }
    return { typedText: typed.join(''), typeEdits, magicType: normalized };
  }

  function extractSegmentsFromText(text = '', fieldCtx = {}) {
    const source = String(text ?? '');
    const tokens = source.length ? source.split(/\s+/g).filter(Boolean) : [];
    const isAddress = /address/i.test(String(fieldCtx.fieldName || ''));

    const buildSegment = (segmentId, tokenSlice, rawOverride = null) => {
      const rawSegmentText = rawOverride !== null
        ? rawOverride
        : (Array.isArray(tokenSlice) ? tokenSlice.join(' ') : source);
      const slotString = COMMON_SUBS.stripToAlnum(rawSegmentText);
      const slotMap = [];
      for (let i = 0, slotIdx = 0; i < rawSegmentText.length; i++) {
        const ch = rawSegmentText[i];
        if (isAlnum(ch)) {
          slotMap.push({ slotIndex: slotIdx, originalIndex: i, char: ch });
          slotIdx += 1;
        }
      }
      const indexMap = slotMap.map(m => m.originalIndex);
      return {
        segmentId,
        rawSegmentText,
        slotString,
        slotLength: slotString.length,
        slotMap,
        indexMap,
        start: -1,
        end: -1
      };
    };

    if (!isAddress) {
      return [buildSegment('full', [], source)];
    }

    const count = tokens.length;
    if (count === 0) return [];
    if (count === 1) return [buildSegment('address:first1', [tokens[0]])];
    if (count === 2) return [buildSegment('address:first2', tokens.slice(0, 2))];
    if (count === 3) return [buildSegment('address:first2', tokens.slice(0, 2))];
    return [
      buildSegment('address:first2', tokens.slice(0, 2)),
      buildSegment('address:last2', tokens.slice(-2))
    ];
  }

  function deriveLearnedLayout(record, slotLength) {
    const layout = [];
    let learnedCount = 0;
    let hasL = false;
    let hasN = false;
    for (let i = 0; i < slotLength; i++) {
      const letterScore = record.letterScore?.[i] || 0;
      const numberScore = record.numberScore?.[i] || 0;
      const total = letterScore + numberScore;
      const dominance = Math.abs(letterScore - numberScore);
      if (total >= 20 && dominance >= 15) {
        if (letterScore > numberScore) {
          layout.push('L');
          hasL = true;
        }
        else if (numberScore > letterScore) {
          layout.push('N');
          hasN = true;
        }
        learnedCount += 1;
      } else {
        layout.push('?');
      }
    }
    return { learnedLayout: layout.join(''), learnedCount, hasL, hasN };
  }

  function station3_fingerprintAndScore(typedText = '', fieldCtx = {}, store = defaultSegmentStore) {
    const wizardId = fieldCtx.wizardId || 'sandbox-wizard';
    const fieldName = fieldCtx.fieldName || 'Field';
    const segments = extractSegmentsFromText(typedText, fieldCtx);
    const results = segments.map((seg) => {
      const segmentKey = `${wizardId}::${fieldName}::${seg.segmentId}::${seg.slotLength}`;
      const record = store.updateScores(segmentKey, seg.slotString);
      const { learnedLayout, learnedCount, hasL, hasN } = deriveLearnedLayout(record, seg.slotLength);
      const coverage = seg.slotLength ? learnedCount / seg.slotLength : 0;
      const layoutArr = learnedLayout.split('');
      let hasMixedAdjacency = false;
      for (let i = 0; i < layoutArr.length - 1; i++) {
        const a = layoutArr[i];
        const b = layoutArr[i + 1];
        if ((a === 'L' || a === 'N') && (b === 'L' || b === 'N') && a !== b) {
          hasMixedAdjacency = true;
          break;
        }
      }
      const hasAnyMixed = hasL && hasN;
      const dvTrigger = coverage >= 0.6 && hasAnyMixed && hasMixedAdjacency;
      const deliberateViolation = (store.records?.[segmentKey]?.deliberateViolation) || dvTrigger;
      if (store.records) {
        store.records[segmentKey] = {
          ...(store.records[segmentKey] || {}),
          letterScore: ensureLength(record.letterScore, seg.slotLength),
          numberScore: ensureLength(record.numberScore, seg.slotLength),
          deliberateViolation
        };
        store.save();
      }
      return {
        ...seg,
        segmentKey,
        learnedLayout,
        deliberateViolation,
        slotScores: {
          letterScore: ensureLength(record.letterScore, seg.slotLength),
          numberScore: ensureLength(record.numberScore, seg.slotLength)
        },
        learnedCoverage: coverage,
        hasAnyMixed,
        hasMixedAdjacency
      };
    });
    return { segments: results };
  }

  function station4_applyFingerprintFixes(typedText = '', stage3Result = {}, fieldCtx = {}) {
    const source = String(typedText ?? '');
    const segments = stage3Result?.segments || [];
    const dvSegments = segments.filter((s) => s.deliberateViolation);
    if (!dvSegments.length) return { finalText: source, fingerprintEdits: [] };

    const sorted = dvSegments.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    let cursor = 0;
    const parts = [];
    const fingerprintEdits = [];

    sorted.forEach((seg) => {
      const start = typeof seg.start === 'number' && seg.start >= 0
        ? seg.start
        : source.indexOf(seg.rawSegmentText, cursor);
      if (start < 0) return;
      const before = source.slice(cursor, start);
      parts.push(before);
      const corrected = [];
      const slotString = seg.slotString || '';
      const layoutArr = (seg.learnedLayout || '').split('');
      for (let i = 0; i < slotString.length; i++) {
        const ch = slotString[i];
        let next = ch;
        const learned = layoutArr[i];
        if (learned === '?') {
          fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, skipped: true, learned });
        } else if (learned === 'N' && COMMON_SUBS.isAmbiguousLetter(ch)) {
          next = COMMON_SUBS.letterToDigit(ch);
        } else if (learned === 'L' && COMMON_SUBS.isAmbiguousDigit(ch)) {
          const left = corrected[i - 1] || '';
          next = COMMON_SUBS.digitToLetter(ch, left);
        }
        if (next !== ch) {
          fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, from: ch, to: next, learned });
        }
        corrected.push(next);
      }
      const correctedSlotString = corrected.join('');
      const correctedSegment = COMMON_SUBS.rehydrateAlnum(seg.rawSegmentText, correctedSlotString);
      parts.push(correctedSegment);
      cursor = start + seg.rawSegmentText.length;
    });
    parts.push(source.slice(cursor));
    return { finalText: parts.join(''), fingerprintEdits };
  }

  function runOcrMagic(fieldCtx = {}, rawText = '', store = defaultSegmentStore) {
    const station1 = station1_layer1Adjacency(rawText);
    const magicType = normalizeMagicType(fieldCtx.magicType || fieldCtx.magicDataType);
    const station2 = station2_magicType(station1.l1Text || station1.cleaned || rawText, magicType);
    const station3 = station3_fingerprintAndScore(station2.typedText, { ...fieldCtx, magicType }, store);
    const station4 = station4_applyFingerprintFixes(station2.typedText, station3, fieldCtx);
    return {
      finalText: station4.finalText,
      debug: {
        rawText,
        fieldCtx: { ...fieldCtx, magicType },
        station1,
        station2,
        station3,
        station4
      }
    };
  }

  const api = {
    MAGIC_DATA_TYPE,
    station1_layer1Adjacency,
    station2_magicType,
    station3_fingerprintAndScore,
    station4_applyFingerprintFixes,
    runOcrMagic,
    SegmentModelStore,
    normalizeMagicType
  };

  if (typeof self !== 'undefined') {
    self.OcrMagicPipeline = api;
  }

  return api;
});
