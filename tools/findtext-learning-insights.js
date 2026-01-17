(function(global){
  const DEFAULT_TEXT = '';

  const safeNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const safeString = (value, fallback = DEFAULT_TEXT) => (value === null || value === undefined) ? fallback : String(value);

  function parseJsonl(text){
    const lines = String(text || '').split(/\r?\n/);
    const entries = [];
    const errors = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if(!trimmed) return;
      try{
        entries.push(JSON.parse(trimmed));
      } catch(err){
        errors.push({ line: idx + 1, message: err?.message || String(err) });
      }
    });
    return { entries, errors };
  }

  function normalizeEntry(entry){
    const safeEntry = entry && typeof entry === 'object' ? entry : {};
    const query = safeEntry.query && typeof safeEntry.query === 'object'
      ? safeEntry.query
      : { raw: safeEntry.query || '', normalized: safeEntry.normalized || '' };
    const candidates = Array.isArray(safeEntry.candidates) ? safeEntry.candidates : [];
    return {
      timestamp: safeString(safeEntry.timestamp, null),
      documentId: safeString(safeEntry.documentId, null),
      page: safeNumber(safeEntry.page, null),
      query: {
        raw: safeString(query.raw, ''),
        normalized: safeString(query.normalized, '')
      },
      toggles: safeEntry.toggles && typeof safeEntry.toggles === 'object' ? safeEntry.toggles : {},
      tokenSource: safeString(safeEntry.tokenSource, null),
      matchSource: safeString(safeEntry.matchSource, null),
      source: safeString(safeEntry.source, safeEntry.tokenSource || null),
      candidates,
      chosenCandidateId: safeString(safeEntry.chosenCandidateId, safeEntry.winnerCandidateId || null),
      winnerCandidateId: safeString(safeEntry.winnerCandidateId, null),
      correctedCandidateId: safeString(safeEntry.correctedCandidateId, null),
      label: safeString(safeEntry.label, null),
      previewExtractedText: safeString(safeEntry.previewExtractedText, null),
      expectedText: safeString(safeEntry.expectedText, null),
      geometryLabel: safeString(safeEntry.geometryLabel, null),
      candidateLabel: safeString(safeEntry.candidateLabel, null),
      cropLabel: safeString(safeEntry.cropLabel, null)
    };
  }

  function isEmailLike(text){
    return /@/.test(String(text || ''));
  }

  function isUrlLike(text){
    return /\bhttps?:\/\/|www\./i.test(String(text || ''));
  }

  function hasMixedAlnum(text){
    return /[\d]/.test(String(text || '')) && /[a-z]/i.test(String(text || ''));
  }

  function editDistance(a, b){
    const left = String(a || '');
    const right = String(b || '');
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for(let i=0;i<=left.length;i++) dp[i][0]=i;
    for(let j=0;j<=right.length;j++) dp[0][j]=j;
    for(let i=1;i<=left.length;i++){
      for(let j=1;j<=right.length;j++){
        dp[i][j] = left[i-1] === right[j-1]
          ? dp[i-1][j-1]
          : Math.min(dp[i-1][j-1], dp[i][j-1], dp[i-1][j]) + 1;
      }
    }
    return dp[left.length][right.length];
  }

  function bucketKeyForEntry(entry){
    const hasCandidates = entry.candidates && entry.candidates.length > 0;
    const hasLabel = entry.label === 'good' || entry.label === 'bad';
    const hasTextPair = entry.previewExtractedText && entry.expectedText;
    const textMismatch = hasTextPair && editDistance(entry.previewExtractedText, entry.expectedText) > 0;
    if(entry.geometryLabel && entry.geometryLabel !== 'ok'){
      return 'geometry';
    }
    if(entry.candidateLabel && entry.candidateLabel !== 'ok'){
      return 'candidate';
    }
    if(entry.label === 'bad' && entry.correctedCandidateId && entry.correctedCandidateId !== entry.chosenCandidateId){
      return 'candidate';
    }
    if(entry.cropLabel && entry.cropLabel !== 'ok'){
      return 'cropText';
    }
    if(hasTextPair && textMismatch){
      return 'cropText';
    }
    if(hasLabel && !hasCandidates){
      return 'miss';
    }
    return entry.label === 'good' ? 'good' : 'unlabeled';
  }

  function summarizeCandidates(entry){
    const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
    const scores = candidates.map(c => safeNumber(c.heuristicScore ?? c.score, 0));
    const sortedScores = scores.slice().sort((a,b)=> b-a);
    const top1 = sortedScores[0] ?? null;
    const top2 = sortedScores[1] ?? null;
    const scoreMargin = (Number.isFinite(top1) && Number.isFinite(top2)) ? top1 - top2 : null;
    return {
      count: candidates.length,
      scoreMargin,
      top1,
      top2
    };
  }

  function extractCandidateText(entry, candidateId){
    const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
    const match = candidates.find(c => c.id === candidateId);
    if(!match) return null;
    return safeString(match.text, null);
  }

  function buildConfusionPairs(entries, options = {}){
    const byText = new Map();
    const byId = new Map();
    entries.forEach(entry => {
      if(entry.label !== 'bad') return;
      const chosen = entry.chosenCandidateId;
      const corrected = entry.correctedCandidateId;
      if(chosen && corrected){
        const key = `${chosen} -> ${corrected}`;
        byId.set(key, (byId.get(key) || 0) + 1);
      }
      const chosenText = extractCandidateText(entry, chosen);
      const correctedText = extractCandidateText(entry, corrected);
      if(chosenText || correctedText){
        const textKey = `${chosenText || '<none>'} -> ${correctedText || '<none>'}`;
        byText.set(textKey, (byText.get(textKey) || 0) + 1);
      }
    });
    const topN = options.topN || 5;
    const topById = Array.from(byId.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN);
    const topByText = Array.from(byText.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN);
    return { byId: topById, byText: topByText };
  }

  function computeSourceCounts(entries){
    const counts = { pdfjs: 0, tesseract: 0, 'tesseract-bboxfix': 0, unknown: 0 };
    entries.forEach(entry => {
      const source = entry.source || entry.tokenSource || 'unknown';
      if(source === 'pdfjs') counts.pdfjs += 1;
      else if(source === 'tesseract') counts.tesseract += 1;
      else if(source === 'tesseract-bbox') counts['tesseract-bboxfix'] += 1;
      else counts.unknown += 1;
    });
    return counts;
  }

  function computeFeatureFlags(entries){
    const counts = {
      containsAtSign: 0,
      looksLikeEmail: 0,
      looksLikeUrl: 0,
      mixedAlnum: 0,
      shortQuery: 0,
      lowConfidence: 0,
      smallBoxArea: 0
    };
    entries.forEach(entry => {
      const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
      const text = candidates[0]?.text || '';
      if(/@/.test(text)) counts.containsAtSign += 1;
      if(isEmailLike(text)) counts.looksLikeEmail += 1;
      if(isUrlLike(text)) counts.looksLikeUrl += 1;
      if(hasMixedAlnum(text)) counts.mixedAlnum += 1;
      if(entry.query?.raw && entry.query.raw.length <= 4) counts.shortQuery += 1;
      const conf = candidates[0]?.features?.tessAvgConfidence ?? null;
      if(Number.isFinite(conf) && conf < 0.75) counts.lowConfidence += 1;
      const area = (candidates[0]?.box?.w || 0) * (candidates[0]?.box?.h || 0);
      if(area && area < 200) counts.smallBoxArea += 1;
    });
    return counts;
  }

  function computeInsights(entries){
    const normalized = entries.map(normalizeEntry);
    const labeled = normalized.filter(entry => entry.label === 'good' || entry.label === 'bad');
    const buckets = {
      geometry: [],
      candidate: [],
      miss: [],
      cropText: [],
      sourceDisagreement: [],
      good: [],
      unlabeled: []
    };
    const grouped = new Map();
    normalized.forEach(entry => {
      const key = `${entry.documentId || ''}::${entry.page || ''}::${entry.query?.normalized || entry.query?.raw || ''}`;
      if(!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(entry);
      const bucket = bucketKeyForEntry(entry);
      buckets[bucket] = buckets[bucket] || [];
      buckets[bucket].push(entry);
    });

    grouped.forEach(groupEntries => {
      const pdfGood = groupEntries.some(entry => entry.source === 'pdfjs' && entry.label === 'good');
      const tessBad = groupEntries.some(entry => entry.source && entry.source !== 'pdfjs' && entry.label === 'bad');
      if(pdfGood && tessBad){
        buckets.sourceDisagreement.push(...groupEntries);
      }
    });

    const totalEvents = normalized.length;
    const labeledEvents = labeled.length;
    const goodCount = labeled.filter(entry => entry.label === 'good').length;
    const badCount = labeled.filter(entry => entry.label === 'bad').length;
    const bySource = computeSourceCounts(normalized);

    const bucketSummaries = Object.entries(buckets).map(([key, list]) => {
      const count = list.length;
      const pct = labeledEvents ? Math.round((count / labeledEvents) * 1000) / 10 : 0;
      const queryCounts = new Map();
      list.forEach(entry => {
        const q = entry.query?.raw || entry.query?.normalized || '<empty>';
        queryCounts.set(q, (queryCounts.get(q) || 0) + 1);
      });
      const topQueries = Array.from(queryCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 5);
      const confusionPairs = buildConfusionPairs(list);
      return {
        bucket: key,
        count,
        pctOfLabeled: pct,
        topQueries,
        confusionPairs
      };
    });

    const candidateStats = labeled.map(entry => summarizeCandidates(entry));
    const scoreMargins = candidateStats.map(stat => stat.scoreMargin).filter(v => Number.isFinite(v));
    const avgMargin = scoreMargins.length
      ? scoreMargins.reduce((sum, v) => sum + v, 0) / scoreMargins.length
      : null;

    const featureFlags = computeFeatureFlags(normalized);

    return {
      totals: {
        totalEvents,
        labeledEvents,
        goodCount,
        badCount,
        bySource
      },
      buckets: bucketSummaries,
      correlations: {
        candidateCounts: candidateStats,
        avgScoreMargin: avgMargin,
        featureFlags,
        notes: {
          pageOffsets: 'not available',
          zoomRotation: 'not available'
        }
      },
      errors: []
    };
  }

  function buildReportText(insights){
    const lines = [];
    lines.push('Learning Insights Report');
    lines.push(`Total events: ${insights.totals.totalEvents}`);
    lines.push(`Labeled events: ${insights.totals.labeledEvents}`);
    lines.push(`Good: ${insights.totals.goodCount} · Bad: ${insights.totals.badCount}`);
    const sources = insights.totals.bySource || {};
    lines.push(`By source: pdfjs=${sources.pdfjs || 0}, tesseract=${sources.tesseract || 0}, tesseract-bboxfix=${sources['tesseract-bboxfix'] || 0}, unknown=${sources.unknown || 0}`);
    lines.push('');
    lines.push('Failure buckets:');
    insights.buckets.forEach(bucket => {
      lines.push(`- ${bucket.bucket}: ${bucket.count} (${bucket.pctOfLabeled}%)`);
      if(bucket.topQueries.length){
        const topQueries = bucket.topQueries.map(([q, c]) => `${q} (${c})`).join(', ');
        lines.push(`  Top queries: ${topQueries}`);
      } else {
        lines.push('  Top queries: insufficient data');
      }
      if(bucket.confusionPairs.byText.length){
        const topPairs = bucket.confusionPairs.byText.map(([k, c]) => `${k} (${c})`).join(', ');
        lines.push(`  Confusion pairs (text): ${topPairs}`);
      } else {
        lines.push('  Confusion pairs (text): insufficient data');
      }
      if(bucket.confusionPairs.byId.length){
        const topIds = bucket.confusionPairs.byId.map(([k, c]) => `${k} (${c})`).join(', ');
        lines.push(`  Confusion pairs (ids): ${topIds}`);
      } else {
        lines.push('  Confusion pairs (ids): insufficient data');
      }
    });
    lines.push('');
    lines.push('Correlations (best effort):');
    lines.push(`Average score margin (top1-top2): ${Number.isFinite(insights.correlations.avgScoreMargin) ? insights.correlations.avgScoreMargin.toFixed(2) : 'not available'}`);
    const flags = insights.correlations.featureFlags || {};
    Object.entries(flags).forEach(([key, value]) => {
      lines.push(`- ${key}: ${value}`);
    });
    lines.push(`Page offsets correlation: ${insights.correlations.notes.pageOffsets}`);
    lines.push(`Zoom/rotation correlation: ${insights.correlations.notes.zoomRotation}`);
    return lines.join('\\n');
  }

  const api = {
    parseJsonl,
    normalizeEntry,
    computeInsights,
    buildReportText
  };

  global.FindTextLearningInsights = api;
})(typeof window !== 'undefined' ? window : globalThis);
