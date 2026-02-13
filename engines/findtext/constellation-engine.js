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

  function matchConstellation(constellation, tokens, opts = {}){
    if(!constellation || !Array.isArray(tokens)) return null;
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : (constellation.tolerance || DEFAULT_TOLERANCE);
    const page = opts.page || constellation.page || tokens[0]?.page || 1;
    const pageW = opts.pageW || 1;
    const pageH = opts.pageH || 1;
    const maxResults = Math.max(1, opts.maxResults || 1);
    const normalizeKeywordText = opts.normalizeKeywordText || defaultNormalizeKeywordText;

    const anchorNorm = normalizeKeywordText(constellation.anchor?.normText || constellation.anchor?.text || '');
    if(!anchorNorm) return null;

    const tokenPool = tokens
      .filter(t => !t.page || !page || t.page === page)
      .map(t => ({ token: t, normText: normalizeKeywordText(t.text || t.raw || ''), center: centerNorm(t, pageW, pageH) }));

    const anchorCandidates = tokenPool.filter(t => t.normText === anchorNorm);
    if(!anchorCandidates.length) return null;

    const matches = [];
    const totalEdges = 1 + (constellation.supports?.length || 0) + (constellation.crossLinks?.length || 0);

    for(const anchorCand of anchorCandidates){
      const supportMatches = [];
      let matchedEdges = 1;
      let errorSum = 0;

      constellation.supports.forEach((supportDesc, idx) => {
        const expectedDelta = supportDesc.anchorDelta;
        const candidates = tokenPool.filter(c => c.normText === supportDesc.normText);
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
