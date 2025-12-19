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

  const PCS_MIN_CONSIDERED = 2;
  const PCS_MIN_SCORE = 0.8;
  const PCS_MAX_CONFLICTS = 2;

  const STRONG_DIGITS = new Set(['2', '3', '4', '6', '8', '9']);
  const STRONG_LETTERS = new Set(
    'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').concat('abcdefghijklmnopqrstuvwxyz'.split(''))
  );

  function toChunkSignature(lengths = []) {
    if (!Array.isArray(lengths) || !lengths.length) return '0';
    return lengths.join(',');
  }

  function pcsEvaluate(slotString = '', learnedLayout = '') {
    let support = 0;
    let conflicts = 0;
    let unknowns = 0;
    const slot = String(slotString ?? '');
    const layout = String(learnedLayout ?? '');
    const limit = Math.min(slot.length, layout.length);

    for (let i = 0; i < limit; i++) {
      const learned = layout[i];
      if (learned === '?') continue;
      const ch = slot[i];
      if (COMMON_SUBS.isAmbiguous(ch)) {
        unknowns += 1;
        continue;
      }
      if (STRONG_DIGITS.has(ch)) {
        if (learned === 'N') support += 1;
        else conflicts += 1;
        continue;
      }
      if (/[A-Za-z]/.test(ch) && !COMMON_SUBS.isAmbiguous(ch)) {
        if (learned === 'L') support += 1;
        else conflicts += 1;
      }
    }

    const considered = support + conflicts;
    const score = considered ? support / considered : 0;
    const hasSufficientEvidence = considered >= PCS_MIN_CONSIDERED;
    const hasTooManyConflicts = conflicts >= PCS_MAX_CONFLICTS;
    const meetsScore = score >= PCS_MIN_SCORE;
    return {
      okToCorrect: hasSufficientEvidence && !hasTooManyConflicts && meetsScore,
      support,
      conflicts,
      unknowns,
      score,
      considered
    };
  }

  class SegmentModelStore {
    constructor(storageKey = 'ocrmagic.segmentStore', { persist = true } = {}) {
      this.storageKey = storageKey;
      this.persist = persist && typeof localStorage !== 'undefined';
      this.records = this.persist ? this.loadFromStorage() : {};
      this.chunkRecords = this.persist ? this.loadChunksFromStorage() : {};
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

    loadChunksFromStorage() {
      try {
        const raw = localStorage.getItem(`${this.storageKey}.chunks`);
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
        localStorage.setItem(`${this.storageKey}.chunks`, JSON.stringify(this.chunkRecords || {}));
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

    getChunkRecord(chunkKey, chunkCount = 0) {
      const rec = this.chunkRecords[chunkKey] || { chunkScores: [], chunkLayouts: [] };
      while (rec.chunkScores.length < chunkCount) {
        rec.chunkScores.push({ Lscore: 0, Nscore: 0 });
      }
      while (rec.chunkLayouts.length < chunkCount) {
        rec.chunkLayouts.push({ letterScore: [], numberScore: [] });
      }
      this.chunkRecords[chunkKey] = rec;
      return rec;
    }

    updateChunkScores(chunkKey, chunkUpdates = []) {
      const rec = this.getChunkRecord(chunkKey, chunkUpdates.length);
      chunkUpdates.forEach((score, idx) => {
        const existing = rec.chunkScores[idx] || { Lscore: 0, Nscore: 0 };
        rec.chunkScores[idx] = {
          Lscore: (existing.Lscore || 0) + (score.Lscore || 0),
          Nscore: (existing.Nscore || 0) + (score.Nscore || 0)
        };
      });
      this.chunkRecords[chunkKey] = rec;
      this.save();
      return rec;
    }

    updateChunkLayoutScores(chunkKey, chunkSlotStrings = []) {
      const rec = this.getChunkRecord(chunkKey, chunkSlotStrings.length);
      chunkSlotStrings.forEach((slotString, idx) => {
        const chunkLayout = rec.chunkLayouts[idx] || { letterScore: [], numberScore: [] };
        const slot = String(slotString || '');
        const letterScore = ensureLength(chunkLayout.letterScore, slot.length);
        const numberScore = ensureLength(chunkLayout.numberScore, slot.length);
        for (let i = 0; i < slot.length; i++) {
          const ch = slot[i];
          if (!COMMON_SUBS.isAmbiguous(ch)) {
            if (/[0-9]/.test(ch)) numberScore[i] = (numberScore[i] || 0) + 5;
            else if (/[A-Za-z]/.test(ch)) letterScore[i] = (letterScore[i] || 0) + 5;
          }
        }
        rec.chunkLayouts[idx] = { letterScore, numberScore };
      });
      this.chunkRecords[chunkKey] = rec;
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
      Object.keys(this.chunkRecords || {}).forEach((key) => {
        if (prefix.trim() && key.startsWith(prefix)) {
          delete this.chunkRecords[key];
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
    const segmenterConfig = fieldCtx.segmenterConfig || { segments: [{ id: 'full', strategy: 'full' }] };

    const buildSegment = (segmentId, rawSegmentText) => {
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

    const segmentsCfg = Array.isArray(segmenterConfig?.segments) && segmenterConfig.segments.length
      ? segmenterConfig.segments
      : [{ id: 'full', strategy: 'full' }];

    return segmentsCfg.map((segDef) => {
      const strategy = segDef.strategy || 'full';
      let rawSegmentText = source;
      if (strategy === 'first2') rawSegmentText = tokens.slice(0, 2).join(' ');
      else if (strategy === 'last2') rawSegmentText = tokens.slice(-2).join(' ');
      else if (strategy === 'first1') rawSegmentText = tokens.slice(0, 1).join(' ');
      return buildSegment(segDef.id || 'full', rawSegmentText || source);
    });
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
      const rawChunks = (seg.rawSegmentText || '').trim().length
        ? (seg.rawSegmentText || '').trim().split(/\s+/)
        : [];
      const chunkAlnums = rawChunks.map((c) => COMMON_SUBS.stripToAlnum(c));
      const chunkScores = chunkAlnums.map((chunk) => {
        let Lscore = 0;
        let Nscore = 0;
        for (const ch of chunk) {
          if (STRONG_DIGITS.has(ch)) Nscore += 5;
          else if (STRONG_LETTERS.has(ch) && !COMMON_SUBS.isAmbiguous(ch)) Lscore += 5;
        }
        return { Lscore, Nscore };
      });
      const chunkKey = `${wizardId}::${fieldName}::${seg.segmentId}::chunks::${chunkScores.length}::${toChunkSignature(chunkAlnums.map(c => c.length))}`;
      const chunkRecord = store.updateChunkScores(chunkKey, chunkScores);
      const chunkLayoutRecord = store.updateChunkLayoutScores(chunkKey, chunkAlnums);
      const learnedChunkTypes = (chunkRecord.chunkScores || []).map((score) => {
        const total = (score.Lscore || 0) + (score.Nscore || 0);
        const dominance = Math.abs((score.Lscore || 0) - (score.Nscore || 0));
        if (total >= 20 && dominance >= 15) {
          if ((score.Lscore || 0) > (score.Nscore || 0)) return 'L';
          if ((score.Nscore || 0) > (score.Lscore || 0)) return 'N';
        }
        return '?';
      }).join('');
      const chunkLayouts = (chunkLayoutRecord.chunkLayouts || []).map((layoutScores, idx) => {
        const chunkLen = (chunkAlnums[idx] || '').length;
        const derived = deriveLearnedLayout({
          letterScore: ensureLength(layoutScores.letterScore, chunkLen),
          numberScore: ensureLength(layoutScores.numberScore, chunkLen)
        }, chunkLen);
        return {
          learnedLayout: derived.learnedLayout,
          learnedCount: derived.learnedCount,
          hasL: derived.hasL,
          hasN: derived.hasN,
          slotLength: chunkLen,
          slotScores: {
            letterScore: ensureLength(layoutScores.letterScore, chunkLen),
            numberScore: ensureLength(layoutScores.numberScore, chunkLen)
          }
        };
      });
      const chunkLayoutString = chunkLayouts.map((c, idx) => c.learnedLayout || ''.padStart((chunkAlnums[idx] || '').length, '?')).join('');
      const baseLayoutArr = (learnedLayout || ''.padStart(seg.slotLength, '?')).split('');
      const mergedLayoutArr = (chunkLayoutString || '').split('');
      while (mergedLayoutArr.length < seg.slotLength) mergedLayoutArr.push('?');
      const layoutArr = mergedLayoutArr.map((ch, idx) => (ch && ch !== '?') ? ch : (baseLayoutArr[idx] || '?'));
      const layoutString = layoutArr.join('');
      const learnedCountCombined = (layoutArr.filter((c) => c === 'L' || c === 'N').length);
      const hasLCombined = layoutArr.includes('L');
      const hasNCombined = layoutArr.includes('N');
      const hasAnyMixedCombined = hasLCombined && hasNCombined;
      const coverage = seg.slotLength ? learnedCountCombined / seg.slotLength : 0;
      let hasMixedAdjacency = false;
      for (let i = 0; i < layoutArr.length - 1; i++) {
        const a = layoutArr[i];
        const b = layoutArr[i + 1];
        if ((a === 'L' || a === 'N') && (b === 'L' || b === 'N') && a !== b) {
          hasMixedAdjacency = true;
          break;
        }
      }
      const hasAnyMixed = hasAnyMixedCombined || (hasL && hasN);
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
        learnedLayout: layoutString,
        deliberateViolation,
          slotScores: {
            letterScore: ensureLength(record.letterScore, seg.slotLength),
            numberScore: ensureLength(record.numberScore, seg.slotLength)
          },
          chunkLayoutString,
          learnedCoverage: coverage,
          hasAnyMixed,
          hasMixedAdjacency,
          chunks: rawChunks.map((rawChunk, idx) => ({
            index: idx,
            rawChunk,
            chunkAlnum: chunkAlnums[idx] || '',
            chunkType: learnedChunkTypes[idx] || '?',
            Lscore: (chunkRecord.chunkScores[idx] || {}).Lscore || 0,
            Nscore: (chunkRecord.chunkScores[idx] || {}).Nscore || 0,
            learnedLayout: (chunkLayouts[idx] || {}).learnedLayout || ''.padStart((chunkAlnums[idx] || '').length, '?'),
            slotScores: (chunkLayouts[idx] || {}).slotScores || { letterScore: [], numberScore: [] }
          })),
          learnedChunkTypes
        };
      });
      return { segments: results };
  }

  function station4_applyFingerprintFixes(typedText = '', stage3Result = {}, fieldCtx = {}) {
    const source = String(typedText ?? '');
    const segments = stage3Result?.segments || [];
    const dvSegments = segments.filter((s) => s.deliberateViolation);
    if (!dvSegments.length) return { finalText: source, fingerprintEdits: [], pcsEvaluations: [] };

    const sorted = dvSegments.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    let cursor = 0;
    const parts = [];
    const fingerprintEdits = [];
    const pcsEvaluations = [];

    sorted.forEach((seg) => {
      const start = typeof seg.start === 'number' && seg.start >= 0
        ? seg.start
        : source.indexOf(seg.rawSegmentText, cursor);
      if (start < 0) return;
      const before = source.slice(cursor, start);
      parts.push(before);
      const corrected = [];
      const slotString = seg.slotString || '';
      const posToChunkIndex = [];
      const posToChunkOffset = [];
      const chunkAlnumLengths = (seg.chunks || []).map((c) => (c.chunkAlnum || '').length);
      let chunkCursor = 0;
      chunkAlnumLengths.forEach((len, idx) => {
        for (let i = 0; i < len; i++) {
          posToChunkIndex[chunkCursor + i] = idx;
          posToChunkOffset[chunkCursor + i] = i;
        }
        chunkCursor += len;
      });
      const layoutArr = (seg.learnedLayout || '').split('');
      const pcs = pcsEvaluate(slotString, seg.learnedLayout || '');
      pcsEvaluations.push({
        segmentId: seg.segmentId,
        segmentKey: seg.segmentKey,
        okToCorrect: pcs.okToCorrect,
        support: pcs.support,
        conflicts: pcs.conflicts,
        unknowns: pcs.unknowns,
        score: pcs.score,
        considered: pcs.considered,
        learnedLayout: seg.learnedLayout,
        slotLength: slotString.length,
        note: pcs.okToCorrect ? 'Stage4: PCS ok' : 'Stage4: skipped (PCS not met)',
        skipReason: pcs.okToCorrect ? undefined : 'PCS_SKIP'
      });
      if (!pcs.okToCorrect) {
        cursor = start + seg.rawSegmentText.length;
        parts.push(seg.rawSegmentText);
        return;
      }
      for (let i = 0; i < slotString.length; i++) {
        const ch = slotString[i];
        let next = ch;
        const chunkIndex = posToChunkIndex[i] ?? null;
        const chunkOffset = posToChunkOffset[i] ?? 0;
        const chunkLayout = ((seg.chunks || [])[chunkIndex] || {}).learnedLayout || '';
        const chunkLearned = chunkLayout[chunkOffset];
        const learned = (chunkLearned && chunkLearned !== '?') ? chunkLearned : layoutArr[i];
        const learnedChunkType = (seg.learnedChunkTypes || '')[chunkIndex] || '?';
        const expectedType = learned;
        if (learned === '?') {
          fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, skipped: true, learned, chunkIndex, learnedChunkType });
        } else if (learned === 'N' && COMMON_SUBS.isAmbiguousLetter(ch)) {
          if (learnedChunkType === 'L' || (learnedChunkType === 'N' && !COMMON_SUBS.isAmbiguousLetter(ch))) {
            fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, from: ch, to: ch, learned, chunkIndex, learnedChunkType, blocked: true, reason: `blocked by chunkType=${learnedChunkType}` });
          } else {
            next = COMMON_SUBS.letterToDigit(ch);
          }
        } else if (learned === 'L' && COMMON_SUBS.isAmbiguousDigit(ch)) {
          if (learnedChunkType === 'N') {
            fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, from: ch, to: ch, learned, chunkIndex, learnedChunkType, blocked: true, reason: `blocked by chunkType=${learnedChunkType}` });
          } else {
            const left = corrected[i - 1] || '';
            next = COMMON_SUBS.digitToLetter(ch, left);
          }
        }
        if (next !== ch) {
          fingerprintEdits.push({ segmentId: seg.segmentId, slotIndex: i, from: ch, to: next, learned, chunkIndex, learnedChunkType, expectedType });
        }
        corrected.push(next);
      }
      const correctedSlotString = corrected.join('');
      const correctedSegment = COMMON_SUBS.rehydrateAlnum(seg.rawSegmentText, correctedSlotString);
      parts.push(correctedSegment);
      cursor = start + seg.rawSegmentText.length;
    });
    parts.push(source.slice(cursor));
    return { finalText: parts.join(''), fingerprintEdits, pcsEvaluations };
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
    normalizeMagicType,
    pcsEvaluate
  };

  if (typeof self !== 'undefined') {
    self.OcrMagicPipeline = api;
  }

  return api;
});
