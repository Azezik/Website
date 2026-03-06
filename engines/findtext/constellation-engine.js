(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineFindTextConstellation = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const BASE_RADIUS = 0.35 * Math.SQRT2;
  const EXPANDED_RADIUS = 0.5 * Math.SQRT2;
  const DEFAULT_TOLERANCE = 0.01;
  const MAX_SUPPORTS = 5;

  function defaultNormalizeKeywordText(txt){
    return (txt || '')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeBoxPx(box, pageW, pageH){
    return {
      x: (box?.x || 0) / (pageW || 1),
      y: (box?.y || 0) / (pageH || 1),
      w: (box?.w || 0) / (pageW || 1),
      h: (box?.h || 0) / (pageH || 1)
    };
  }

  function centerNorm(token, pageW, pageH){
    const x = (token?.x || 0) + (token?.w || 0) / 2;
    const y = (token?.y || 0) + (token?.h || 0) / 2;
    return { x: x / (pageW || 1), y: y / (pageH || 1) };
  }

  function withinRadius(origin, candidate, radius){
    const dx = (candidate.x || 0) - (origin.x || 0);
    const dy = (candidate.y || 0) - (origin.y || 0);
    return Math.hypot(dx, dy) <= radius;
  }

  function delta(from, to){
    return {
      dx: (to?.x || 0) - (from?.x || 0),
      dy: (to?.y || 0) - (from?.y || 0)
    };
  }

  function buildCrossLinks(supports){
    const links = [];
    for(let i=0; i<supports.length-1; i++){
      links.push({ from: i, to: i+1, delta: delta(supports[i].center, supports[i+1].center) });
    }
    return links;
  }

  function shouldIncludeToken(normText, keywordFilter){
    if(!keywordFilter) return true;
    if(typeof keywordFilter === 'function') return !!keywordFilter(normText);
    if(Array.isArray(keywordFilter)) return keywordFilter.includes(normText);
    if(keywordFilter instanceof Set) return keywordFilter.has(normText);
    return true;
  }

  function captureConstellation(fieldKey, boxPx, normBox, page, pageW, pageH, tokens, opts = {}){
    if(!boxPx || !normBox || !Array.isArray(tokens) || !tokens.length) return null;
    const origin = { x: normBox.x0n, y: normBox.y0n };
    const radiusPrimary = Number.isFinite(opts.radiusPrimary) ? opts.radiusPrimary : BASE_RADIUS;
    const radiusSecondary = Number.isFinite(opts.radiusSecondary) ? opts.radiusSecondary : EXPANDED_RADIUS;
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
    const keywordFilter = opts.keywordFilter || null;
    const normalizeKeywordText = opts.normalizeKeywordText || defaultNormalizeKeywordText;

    const candidates = [];
    tokens.forEach((tok) => {
      if(tok?.page && page && tok.page !== page) return;
      const normText = normalizeKeywordText(tok.text || tok.raw || '');
      if(!shouldIncludeToken(normText, keywordFilter)) return;
      const center = centerNorm(tok, pageW, pageH);
      const dist = Math.hypot(center.x - origin.x, center.y - origin.y);
      candidates.push({ token: tok, center, dist, normText });
    });
    candidates.sort((a,b)=> a.dist - b.dist);

    let filtered = candidates.filter(c => withinRadius(origin, c.center, radiusPrimary));
    if(filtered.length < MAX_SUPPORTS){
      filtered = candidates.filter(c => withinRadius(origin, c.center, radiusSecondary));
    }
    if(!filtered.length) return null;

    const picked = filtered.slice(0, MAX_SUPPORTS);
    const anchor = picked[0];
    const supports = picked.slice(1);

    const mappedSupports = supports.map(s => ({
      text: s.token.text || s.token.raw || '',
      normText: s.normText,
      center: s.center,
      box: normalizeBoxPx(s.token, pageW, pageH),
      fieldDelta: delta(origin, s.center),
      anchorDelta: delta(anchor.center, s.center)
    }));

    return {
      fieldKey,
      page,
      origin,
      fieldSize: { w: normBox.wN, h: normBox.hN },
      radiusUsed: filtered === candidates ? radiusPrimary : radiusSecondary,
      tolerance,
      anchor: {
        text: anchor.token.text || anchor.token.raw || '',
        normText: anchor.normText,
        center: anchor.center,
        box: normalizeBoxPx(anchor.token, pageW, pageH),
        fieldDelta: delta(origin, anchor.center),
        supports: mappedSupports.map((_, idx) => idx)
      },
      supports: mappedSupports,
      crossLinks: buildCrossLinks(mappedSupports)
    };
  }

  function scoreEdgeMatch(expectedDelta, actualDelta, tolerance){
    const dxErr = Math.abs((actualDelta?.dx || 0) - (expectedDelta?.dx || 0));
    const dyErr = Math.abs((actualDelta?.dy || 0) - (expectedDelta?.dy || 0));
    return { pass: dxErr <= tolerance && dyErr <= tolerance, error: dxErr + dyErr, dxErr, dyErr };
  }

  function levenshteinDistance(a = '', b = ''){
    const s = String(a || '');
    const t = String(b || '');
    if(s === t) return 0;
    if(!s.length) return t.length;
    if(!t.length) return s.length;
    const prev = new Array(t.length + 1);
    const curr = new Array(t.length + 1);
    for(let j=0; j<=t.length; j++) prev[j] = j;
    for(let i=1; i<=s.length; i++){
      curr[0] = i;
      for(let j=1; j<=t.length; j++){
        const cost = s[i-1] === t[j-1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + cost);
      }
      for(let j=0; j<=t.length; j++) prev[j] = curr[j];
    }
    return prev[t.length];
  }

  function isCompatibleNormText(expectedNorm, candidateNorm){
    const expected = String(expectedNorm || '');
    const candidate = String(candidateNorm || '');
    if(!expected || !candidate) return false;
    if(expected === candidate) return true;
    if(expected.length >= 4 && candidate.includes(expected)) return true;
    if(candidate.length >= 4 && expected.includes(candidate)) return true;
    const maxLen = Math.max(expected.length, candidate.length);
    if(maxLen <= 3) return false;
    return levenshteinDistance(expected, candidate) <= 1;
  }

  function median(values = []){
    const nums = values.filter(v => Number.isFinite(v));
    if(!nums.length) return 0;
    const sorted = nums.slice().sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
  }

  function estimateBridgeOffset(constellation, tokenPool, textMatcher){
    const descriptors = [
      constellation.anchor ? { normText: constellation.anchor.normText || constellation.anchor.text || '', center: constellation.anchor.center } : null,
      ...((constellation.supports || []).map(s => ({ normText: s.normText || s.text || '', center: s.center })))
    ].filter(Boolean);
    if(!descriptors.length) return { dx: 0, dy: 0, samples: 0 };
    const deltas = [];
    for(const desc of descriptors){
      const matches = tokenPool.filter(t => textMatcher(desc.normText, t.normText));
      if(!matches.length) continue;
      let best = null;
      for(const cand of matches){
        const dx = (cand.center.x || 0) - (desc.center?.x || 0);
        const dy = (cand.center.y || 0) - (desc.center?.y || 0);
        const err = Math.hypot(dx, dy);
        if(!best || err < best.err){ best = { dx, dy, err }; }
      }
      if(best) deltas.push(best);
    }
    if(!deltas.length) return { dx: 0, dy: 0, samples: 0 };
    return { dx: median(deltas.map(d => d.dx)), dy: median(deltas.map(d => d.dy)), samples: deltas.length };
  }

  function computeConstellationMatches(constellation, tokenPool, opts = {}){
    const {
      tolerance,
      totalEdges,
      page,
      pageW,
      pageH,
      anchorMatcher,
      supportMatcher,
      bridgeOffset = { dx: 0, dy: 0 },
      minAnchorDistance = null
    } = opts;
    const anchorNorm = (constellation.anchor?.normText || constellation.anchor?.text || '').toString();
    let anchorCandidates = tokenPool.filter(t => anchorMatcher(anchorNorm, t.normText));
    if(!anchorCandidates.length && Number.isFinite(minAnchorDistance)){
      const expected = {
        x: (constellation.anchor?.center?.x || 0) + (bridgeOffset.dx || 0),
        y: (constellation.anchor?.center?.y || 0) + (bridgeOffset.dy || 0)
      };
      anchorCandidates = tokenPool
        .map(t => ({ ...t, __dist: Math.hypot((t.center.x || 0) - expected.x, (t.center.y || 0) - expected.y) }))
        .filter(t => t.__dist <= minAnchorDistance)
        .sort((a,b)=> a.__dist - b.__dist)
        .slice(0, 3);
    }
    if(!anchorCandidates.length) return [];

    const matches = [];
    for(const anchorCand of anchorCandidates){
      const supportMatches = [];
      let matchedEdges = 1;
      let errorSum = 0;

      (constellation.supports || []).forEach((supportDesc, idx) => {
        const expectedDelta = supportDesc.anchorDelta;
        const candidates = tokenPool.filter(c => supportMatcher(supportDesc.normText, c.normText));
        let bestCandidate = null;
        for(const cand of candidates){
          const actualDelta = delta(anchorCand.center, cand.center);
          const score = scoreEdgeMatch(expectedDelta, actualDelta, tolerance);
          if(!score.pass) continue;
          if(!bestCandidate || score.error < bestCandidate.error){
            bestCandidate = { cand, error: score.error, delta: actualDelta };
          }
        }
        if(bestCandidate){
          matchedEdges += 1;
          errorSum += bestCandidate.error;
          supportMatches[idx] = { token: bestCandidate.cand.token, center: bestCandidate.cand.center, error: bestCandidate.error, delta: bestCandidate.delta };
        } else {
          supportMatches[idx] = null;
        }
      });

      if(Array.isArray(constellation.crossLinks) && constellation.crossLinks.length){
        for(const link of constellation.crossLinks){
          const from = supportMatches[link.from];
          const to = supportMatches[link.to];
          if(!from || !to) continue;
          const score = scoreEdgeMatch(link.delta, delta(from.center, to.center), tolerance);
          if(score.pass){
            matchedEdges += 1;
            errorSum += score.error;
          }
        }
      }

      const fieldDelta = constellation.anchor?.fieldDelta || delta(constellation.origin || {x:0,y:0}, constellation.anchor?.center || {x:0,y:0});
      const predictedBoxNorm = {
        x: anchorCand.center.x - (fieldDelta.dx || 0),
        y: anchorCand.center.y - (fieldDelta.dy || 0),
        w: constellation.fieldSize?.w || 0,
        h: constellation.fieldSize?.h || 0
      };

      matches.push({
        anchor: anchorCand.token,
        anchorCenter: anchorCand.center,
        matchedEdges,
        totalEdges,
        errorSum,
        predictedBoxNorm,
        predictedBoxPx: {
          x: predictedBoxNorm.x * pageW,
          y: predictedBoxNorm.y * pageH,
          w: predictedBoxNorm.w * pageW,
          h: predictedBoxNorm.h * pageH,
          page
        },
        supportMatches: supportMatches.filter(Boolean)
      });
    }
    return matches;
  }

  function matchConstellation(constellation, tokens, opts = {}){
    if(!constellation || !Array.isArray(tokens)) return null;
    const toleranceBase = Number.isFinite(opts.tolerance) ? opts.tolerance : (constellation.tolerance || DEFAULT_TOLERANCE);
    const page = opts.page || constellation.page || tokens[0]?.page || 1;
    const pageW = opts.pageW || 1;
    const pageH = opts.pageH || 1;
    const maxResults = Math.max(1, opts.maxResults || 1);
    const normalizeKeywordText = opts.normalizeKeywordText || defaultNormalizeKeywordText;
    const source = String(opts.source || opts.tokenSource || '').toLowerCase();
    const bridgeEnabled = opts.enableCrossSourceBridge !== false;

    const anchorNorm = normalizeKeywordText(constellation.anchor?.normText || constellation.anchor?.text || '');
    if(!anchorNorm) return null;

    const tokenPool = tokens
      .filter(t => !t.page || !page || t.page === page)
      .map(t => ({ token: t, normText: normalizeKeywordText(t.text || t.raw || ''), center: centerNorm(t, pageW, pageH) }));

    const totalEdges = 1 + (constellation.supports?.length || 0) + (constellation.crossLinks?.length || 0);
    const strictMatcher = (expected, actual) => expected === actual;
    const compatMatcher = (expected, actual) => isCompatibleNormText(expected, actual);

    let matches = computeConstellationMatches(constellation, tokenPool, {
      tolerance: toleranceBase,
      totalEdges,
      page,
      pageW,
      pageH,
      anchorMatcher: strictMatcher,
      supportMatcher: strictMatcher
    });

    const strictBest = matches[0] || null;
    const strictStrong = !!(strictBest && strictBest.matchedEdges >= Math.max(2, Math.ceil(totalEdges * 0.5)));

    if((!strictStrong || !matches.length) && bridgeEnabled){
      const sourceToleranceBoost = source.includes('tesseract') ? 2.5 : 1.8;
      const bridgeTolerance = Math.max(toleranceBase * sourceToleranceBoost, toleranceBase + 0.01);
      const bridgeOffset = estimateBridgeOffset(constellation, tokenPool, compatMatcher);
      const bridgedMatches = computeConstellationMatches(constellation, tokenPool, {
        tolerance: bridgeTolerance,
        totalEdges,
        page,
        pageW,
        pageH,
        anchorMatcher: compatMatcher,
        supportMatcher: compatMatcher,
        bridgeOffset,
        minAnchorDistance: 0.12
      }).map(m => ({ ...m, bridgeApplied: true, bridgeOffset, bridgeTolerance }));
      if(bridgedMatches.length){
        matches = matches.concat(bridgedMatches);
      }
    }

    matches.sort((a,b)=> (b.matchedEdges - a.matchedEdges) || (a.errorSum - b.errorSum));
    return { best: matches[0] || null, matches: matches.slice(0, maxResults) };
  }


  return {
    BASE_RADIUS,
    EXPANDED_RADIUS,
    DEFAULT_TOLERANCE,
    normalizeBoxPx,
    centerNorm,
    delta,
    scoreEdgeMatch,
    captureConstellation,
    matchConstellation
  };
});
