(function(global){
  const BASE_RADIUS = 0.35 * Math.SQRT2; // ~0.495 in normalized units
  const EXPANDED_RADIUS = 0.5 * Math.SQRT2; // ~0.707 in normalized units
  const DEFAULT_TOLERANCE = 0.01; // 1% of page
  const MAX_SUPPORTS = 5;

  const normalizeKeywordText = (global.KeywordWeighting?.normalizeKeywordText)
    || (typeof require !== 'undefined' ? require('./keyword-weighting.js').normalizeKeywordText : null)
    || function(txt){
      return (txt || '')
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

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
    return {
      x: x / (pageW || 1),
      y: y / (pageH || 1)
    };
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

  function resolveTokenEligibility(normText, keywordFilter){
    if(!normText){
      return { eligible: false, reason: 'emptyNormalized' };
    }
    if(!keywordFilter){
      return { eligible: true, reason: 'fallbackNoFilter' };
    }
    if(typeof keywordFilter === 'function'){
      const hit = !!keywordFilter(normText);
      return { eligible: hit, reason: hit ? 'keywordFilterFn' : 'keywordFilterFnMiss' };
    }
    if(Array.isArray(keywordFilter)){
      const hit = keywordFilter.includes(normText);
      return { eligible: hit, reason: hit ? 'keywordList' : 'keywordListMiss' };
    }
    if(keywordFilter instanceof Set){
      const hit = keywordFilter.has(normText);
      return { eligible: hit, reason: hit ? 'inKeywordSet' : 'notInKeywordSet' };
    }
    return { eligible: true, reason: 'keywordFilterUnknown' };
  }

  function intersectsBox(token, box){
    if(!token || !box) return false;
    const tx1 = token.x || 0;
    const ty1 = token.y || 0;
    const tx2 = tx1 + (token.w || 0);
    const ty2 = ty1 + (token.h || 0);
    const bx1 = box.x || 0;
    const by1 = box.y || 0;
    const bx2 = bx1 + (box.w || 0);
    const by2 = by1 + (box.h || 0);
    return tx1 < bx2 && tx2 > bx1 && ty1 < by2 && ty2 > by1;
  }

  function captureConstellation(fieldKey, boxPx, normBox, page, pageW, pageH, tokens, opts={}){
    if(!boxPx || !normBox || !Array.isArray(tokens) || !tokens.length){ return null; }
    const origin = { x: normBox.x0n, y: normBox.y0n };
    const radiusPrimary = Number.isFinite(opts.radiusPrimary) ? opts.radiusPrimary : BASE_RADIUS;
    const radiusSecondary = Number.isFinite(opts.radiusSecondary) ? opts.radiusSecondary : EXPANDED_RADIUS;
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
    const keywordFilter = opts.keywordFilter || null;
    const excludeAnchorBoxPx = opts.excludeAnchorBoxPx || null;
    const debug = opts.debug || null;
    const candidates = [];
    const debugEntries = [];
    const addCandidate = (tok) => {
      if(tok?.page && page && tok.page !== page) return;
      const normText = normalizeKeywordText(tok.text || tok.raw || '');
      const center = centerNorm(tok, pageW, pageH);
      const dist = Math.hypot(center.x - origin.x, center.y - origin.y);
      const eligibility = resolveTokenEligibility(normText, keywordFilter);
      const inPrimary = withinRadius(origin, center, radiusPrimary);
      const inSecondary = withinRadius(origin, center, radiusSecondary);
      const entry = { token: tok, center, dist, normText, inPrimary, inSecondary, ...eligibility };
      debugEntries.push(entry);
      if(!eligibility.eligible) return;
      candidates.push(entry);
    };
    tokens.forEach(addCandidate);
    candidates.sort((a,b)=> a.dist - b.dist);

    let filtered = candidates.filter(c => withinRadius(origin, c.center, radiusPrimary));
    let usedExpandedRadius = false;
    if(filtered.length < MAX_SUPPORTS){
      filtered = candidates.filter(c => withinRadius(origin, c.center, radiusSecondary));
      usedExpandedRadius = true;
    }
    if(!filtered.length){
      if(debug?.enabled && (!debug.logOnce || !debug.logged)){
        debug.logged = true;
        console.debug('[find-text][constellation] capture', {
          fieldKey,
          searchTerm: debug.searchTerm || null,
          origin,
          radiusPrimary,
          radiusSecondary,
          usedExpandedRadius,
          keywordFilter: keywordFilter ? { type: keywordFilter.constructor?.name || typeof keywordFilter, size: keywordFilter.size } : null,
          candidates: debugEntries
            .filter(entry => entry.inSecondary)
            .map(entry => ({
              rawText: entry.token?.text || entry.token?.raw || '',
              normalizedText: entry.normText,
              bbox: { x: entry.token?.x || 0, y: entry.token?.y || 0, w: entry.token?.w || 0, h: entry.token?.h || 0, page: entry.token?.page || page },
              center: entry.center,
              distance: entry.dist,
              eligible: entry.eligible,
              reason: entry.reason,
              inPrimary: entry.inPrimary,
              inSecondary: entry.inSecondary,
              overlapsExcludeBox: excludeAnchorBoxPx ? intersectsBox(entry.token, excludeAnchorBoxPx) : false
            })),
          anchor: null,
          supports: []
        });
      }
      return null;
    }
    let anchorIndex = 0;
    let anchorReason = 'distanceRank';
    if(excludeAnchorBoxPx){
      const nextIndex = filtered.findIndex(entry => !intersectsBox(entry.token, excludeAnchorBoxPx));
      if(nextIndex >= 0){
        anchorIndex = nextIndex;
        anchorReason = nextIndex === 0 ? 'distanceRank' : 'anchorOverride:excludeAnchorBox';
      } else {
        anchorReason = 'anchorFallbackInBox';
      }
    }
    const anchor = filtered[anchorIndex];
    const supports = filtered.filter((_, idx) => idx !== anchorIndex).slice(0, MAX_SUPPORTS - 1);
    const fieldSize = { w: normBox.wN, h: normBox.hN };

    const mappedSupports = supports.map(s => ({
      text: s.token.text || s.token.raw || '',
      normText: s.normText,
      center: s.center,
      box: normalizeBoxPx(s.token, pageW, pageH),
      fieldDelta: delta(origin, s.center),
      anchorDelta: delta(anchor.center, s.center)
    }));

    const anchorEntry = {
      text: anchor.token.text || anchor.token.raw || '',
      normText: anchor.normText,
      center: anchor.center,
      box: normalizeBoxPx(anchor.token, pageW, pageH),
      fieldDelta: delta(origin, anchor.center),
      supports: mappedSupports.map((_, idx) => idx)
    };

    const fieldToAnchor = delta(origin, anchor.center);
    const crossLinks = buildCrossLinks(mappedSupports);

    if(debug?.enabled && (!debug.logOnce || !debug.logged)){
      debug.logged = true;
      const filteredSet = new Set(filtered.map(entry => entry.token));
      const candidateDebug = debugEntries
        .filter(entry => entry.inSecondary)
        .map(entry => ({
          rawText: entry.token?.text || entry.token?.raw || '',
          normalizedText: entry.normText,
          bbox: { x: entry.token?.x || 0, y: entry.token?.y || 0, w: entry.token?.w || 0, h: entry.token?.h || 0, page: entry.token?.page || page },
          center: entry.center,
          distance: entry.dist,
          eligible: entry.eligible,
          reason: entry.reason,
          inPrimary: entry.inPrimary,
          inSecondary: entry.inSecondary,
          shortlisted: filteredSet.has(entry.token),
          overlapsExcludeBox: excludeAnchorBoxPx ? intersectsBox(entry.token, excludeAnchorBoxPx) : false
        }));
      console.debug('[find-text][constellation] capture', {
        fieldKey,
        searchTerm: debug.searchTerm || null,
        origin,
        radiusPrimary,
        radiusSecondary,
        usedExpandedRadius,
        keywordFilter: keywordFilter ? { type: keywordFilter.constructor?.name || typeof keywordFilter, size: keywordFilter.size } : null,
        candidates: candidateDebug,
        anchor: anchor
          ? {
            rawText: anchor.token?.text || anchor.token?.raw || '',
            normalizedText: anchor.normText,
            distanceRank: anchorIndex + 1,
            reason: anchorReason
          }
          : null,
        supports: supports.map((support, idx) => ({
          rawText: support.token?.text || support.token?.raw || '',
          normalizedText: support.normText,
          distanceRank: (filtered.indexOf(support) + 1) || (idx + 2),
          reason: 'distanceRank'
        }))
      });
    }

    return {
      fieldKey,
      page,
      origin,
      fieldSize,
      radiusUsed: usedExpandedRadius ? radiusSecondary : radiusPrimary,
      tolerance,
      anchor: anchorEntry,
      supports: mappedSupports,
      crossLinks
    };
  }

  function scoreEdgeMatch(expectedDelta, actualDelta, tolerance){
    const dxErr = Math.abs((actualDelta?.dx || 0) - (expectedDelta?.dx || 0));
    const dyErr = Math.abs((actualDelta?.dy || 0) - (expectedDelta?.dy || 0));
    const pass = dxErr <= tolerance && dyErr <= tolerance;
    const error = dxErr + dyErr;
    return { pass, error, dxErr, dyErr };
  }

  function matchConstellation(constellation, tokens, opts={}){
    if(!constellation || !Array.isArray(tokens)) return null;
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : (constellation.tolerance || DEFAULT_TOLERANCE);
    const page = opts.page || constellation.page || tokens[0]?.page || 1;
    const pageW = opts.pageW || 1;
    const pageH = opts.pageH || 1;
    const maxResults = Math.max(1, opts.maxResults || 1);
    const anchorNorm = normalizeKeywordText(constellation.anchor?.normText || constellation.anchor?.text || '');
    if(!anchorNorm){ return null; }

    const anchorCandidates = tokens
      .filter(t => !t.page || !page || t.page === page)
      .map(t => ({ token: t, normText: normalizeKeywordText(t.text || t.raw || ''), center: centerNorm(t, pageW, pageH) }))
      .filter(t => t.normText === anchorNorm);

    if(!anchorCandidates.length){ return null; }

    const matches = [];
    const totalEdges = 1 + (constellation.supports?.length || 0) + (constellation.crossLinks?.length || 0);

    for(const anchorCand of anchorCandidates){
      const supportMatches = [];
      const supportPool = tokens
        .filter(t => !t.page || !page || t.page === page)
        .map(t => ({ token: t, normText: normalizeKeywordText(t.text || t.raw || ''), center: centerNorm(t, pageW, pageH) }));

      let matchedEdges = 1;
      let errorSum = 0;
      constellation.supports.forEach((supportDesc, idx) => {
        const expectedDelta = supportDesc.anchorDelta;
        const candidates = supportPool.filter(c => c.normText === supportDesc.normText);
        let bestCandidate = null;
        for(const cand of candidates){
          const actualDelta = delta(anchorCand.center, cand.center);
          const score = scoreEdgeMatch(expectedDelta, actualDelta, tolerance);
          if(!score.pass) continue;
          if(!bestCandidate || score.error < bestCandidate.error){
            bestCandidate = { cand, error: score.error, delta: actualDelta, score };
          }
        }
        if(bestCandidate){
          matchedEdges += 1;
          errorSum += bestCandidate.error;
          supportMatches[idx] = {
            token: bestCandidate.cand.token,
            center: bestCandidate.cand.center,
            error: bestCandidate.error,
            delta: bestCandidate.delta
          };
        } else {
          supportMatches[idx] = null;
        }
      });

      if(Array.isArray(constellation.crossLinks) && constellation.crossLinks.length){
        for(const link of constellation.crossLinks){
          const from = supportMatches[link.from];
          const to = supportMatches[link.to];
          if(!from || !to) continue;
          const actualDelta = delta(from.center, to.center);
          const score = scoreEdgeMatch(link.delta, actualDelta, tolerance);
          if(score.pass){
            matchedEdges += 1;
            errorSum += score.error;
          }
        }
      }

      const fieldDelta = constellation.anchor?.fieldDelta || delta(constellation.origin || {x:0,y:0}, constellation.anchor?.center || {x:0,y:0});
      const predictedOrigin = {
        x: anchorCand.center.x - (fieldDelta.dx || 0),
        y: anchorCand.center.y - (fieldDelta.dy || 0)
      };
      const predictedBoxNorm = {
        x: predictedOrigin.x,
        y: predictedOrigin.y,
        w: (constellation.fieldSize?.w || 0),
        h: (constellation.fieldSize?.h || 0)
      };
      const predictedBoxPx = {
        x: predictedBoxNorm.x * pageW,
        y: predictedBoxNorm.y * pageH,
        w: predictedBoxNorm.w * pageW,
        h: predictedBoxNorm.h * pageH,
        page
      };

      matches.push({
        anchor: anchorCand.token,
        anchorCenter: anchorCand.center,
        matchedEdges,
        totalEdges,
        errorSum,
        predictedBoxPx,
        predictedBoxNorm,
        supportMatches: supportMatches.filter(Boolean)
      });
    }

    matches.sort((a,b)=> {
      if(b.matchedEdges !== a.matchedEdges){ return b.matchedEdges - a.matchedEdges; }
      return a.errorSum - b.errorSum;
    });

    return {
      best: matches[0] || null,
      matches: matches.slice(0, maxResults)
    };
  }

  const api = {
    BASE_RADIUS,
    EXPANDED_RADIUS,
    DEFAULT_TOLERANCE,
    captureConstellation,
    matchConstellation
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.KeywordConstellation = api;
})(typeof window !== 'undefined' ? window : globalThis);
