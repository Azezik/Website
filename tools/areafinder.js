(function(global){
  const keywordModule = global.KeywordWeighting || require('./keyword-weighting.js') || {};
  const normalizeKeywordText = keywordModule.normalizeKeywordText || ((text='') => text.toString().toLowerCase().trim());

  const DEFAULT_TOLERANCE = 0.015;
  const MAX_SUPPORTS = 7;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function normalizeBoxPx(box = {}, pageW = 1, pageH = 1){
    return {
      x: (box.x || 0) / pageW,
      y: (box.y || 0) / pageH,
      w: (box.w || 0) / pageW,
      h: (box.h || 0) / pageH
    };
  }

  const tokenCenterNorm = (token, pageW = 1, pageH = 1) => {
    const x = (token?.x || 0) + (token?.w || 0) / 2;
    const y = (token?.y || 0) + (token?.h || 0) / 2;
    return { x: x / pageW, y: y / pageH };
  };

  const delta = (from = {}, to = {}) => ({
    dx: (to.x || 0) - (from.x || 0),
    dy: (to.y || 0) - (from.y || 0)
  });

  function boxFromPct(bboxPct = {}, pageW = 1, pageH = 1){
    return {
      x: (bboxPct.x0 || 0) * pageW,
      y: (bboxPct.y0 || 0) * pageH,
      w: Math.max(0, ((bboxPct.x1 || 0) - (bboxPct.x0 || 0)) * pageW),
      h: Math.max(0, ((bboxPct.y1 || 0) - (bboxPct.y0 || 0)) * pageH)
    };
  }

  const tokenInsideBox = (token, boxPx = {}) => {
    if(!token || !boxPx) return false;
    const cx = (token.x || 0) + (token.w || 0) / 2;
    const cy = (token.y || 0) + (token.h || 0) / 2;
    return cx >= boxPx.x && cx <= boxPx.x + boxPx.w && cy >= boxPx.y && cy <= boxPx.y + boxPx.h;
  };

  function buildCrossLinks(supports){
    const links = [];
    for(let i=0; i<supports.length-1; i++){
      links.push({ from: i, to: i+1, delta: delta(supports[i].center, supports[i+1].center) });
    }
    return links;
  }

  function toPctBox(bboxPx = {}, pageW = 1, pageH = 1){
    return {
      x0: (bboxPx.x || 0) / pageW,
      y0: (bboxPx.y || 0) / pageH,
      x1: ((bboxPx.x || 0) + (bboxPx.w || 0)) / pageW,
      y1: ((bboxPx.y || 0) + (bboxPx.h || 0)) / pageH
    };
  }

  function edgeOffsetError(token, candidateBox, expectedOffsets){
    if(!token || !candidateBox || !expectedOffsets) return null;
    const denomX = Math.max(1, candidateBox.w || 0);
    const denomY = Math.max(1, candidateBox.h || 0);
    const offsets = {
      left: ((token.x || 0) - (candidateBox.x || 0)) / denomX,
      top: ((token.y || 0) - (candidateBox.y || 0)) / denomY,
      right: (((candidateBox.x || 0) + (candidateBox.w || 0)) - ((token.x || 0) + (token.w || 0))) / denomX,
      bottom: (((candidateBox.y || 0) + (candidateBox.h || 0)) - ((token.y || 0) + (token.h || 0))) / denomY
    };
    const diffs = ['left','top','right','bottom']
      .map(k => Math.abs((expectedOffsets[k] || 0) - (offsets[k] || 0)));
    return Math.max(...diffs);
  }

  function scoreLayout(fp, candidateBox, tokens, normTokenText){
    if(!fp || !candidateBox) return { matchRatio: 0, positionPenalty: 1, matched: 0 };
    const expectedW = Math.max(1, candidateBox.w || 0);
    const expectedH = Math.max(1, candidateBox.h || 0);
    const diag = Math.hypot(expectedW, expectedH) || 1;
    const keywords = fp.keywords || [];
    let matched = 0;
    let totalPosErr = 0;
    let totalEdgeErr = 0;
    const page = candidateBox.page || 1;

    for(const kw of keywords){
      const cxExpected = (candidateBox.x || 0) + (kw.centerRel?.cx || 0) * expectedW;
      const cyExpected = (candidateBox.y || 0) + (kw.centerRel?.cy || 0) * expectedH;
      const tol = Math.max(expectedW, expectedH) * 0.08;
      const candidates = (tokens || []).filter(t => (t.page || 1) === page && normTokenText(t.text || t.raw || '') === kw.normText);
      let best = null;
      for(const t of candidates){
        const cCx = (t.x || 0) + (t.w || 0) / 2;
        const cCy = (t.y || 0) + (t.h || 0) / 2;
        const dist = Math.hypot(cCx - cxExpected, cCy - cyExpected);
        if(dist > tol) continue;
        const edgeErr = edgeOffsetError(t, candidateBox, kw.edgeOffsets || {}) ?? 1;
        const score = dist / diag + edgeErr;
        if(!best || score < best.score){
          best = { dist, edgeErr, score };
        }
      }
      if(best){
        matched += 1;
        totalPosErr += Math.min(1, best.dist / diag);
        totalEdgeErr += Math.min(1, best.edgeErr);
      }
    }

    const denom = Math.max(1, keywords.length);
    const matchRatio = keywords.length ? matched / denom : 1;
    const avgPosErr = matched ? totalPosErr / Math.max(1, matched) : 0;
    const avgEdgeErr = matched ? totalEdgeErr / Math.max(1, matched) : 0;
    const positionPenalty = matched ? Math.min(1, (avgPosErr * 0.6) + (avgEdgeErr * 0.4)) : 0;
    return { matchRatio, positionPenalty, matched };
  }

  function boxFromOrientationToken(token, edgeOffsets){
    if(!token || !edgeOffsets) return null;
    const dxDenom = 1 - (edgeOffsets.left || 0) - (edgeOffsets.right || 0);
    const dyDenom = 1 - (edgeOffsets.top || 0) - (edgeOffsets.bottom || 0);
    if(dxDenom <= 0 || dyDenom <= 0) return null;
    const w = (token.w || 0) / dxDenom;
    const h = (token.h || 0) / dyDenom;
    const x = (token.x || 0) - (edgeOffsets.left || 0) * w;
    const y = (token.y || 0) - (edgeOffsets.top || 0) * h;
    return { x, y, w, h, page: token.page || 1 };
  }

  function mergeBoxes(boxes = []){
    if(!boxes.length) return null;
    const sum = boxes.reduce((acc, b) => ({
      x: acc.x + (b.x || 0),
      y: acc.y + (b.y || 0),
      w: acc.w + (b.w || 0),
      h: acc.h + (b.h || 0)
    }), { x:0, y:0, w:0, h:0 });
    return {
      x: sum.x / boxes.length,
      y: sum.y / boxes.length,
      w: sum.w / boxes.length,
      h: sum.h / boxes.length,
      page: boxes[0]?.page || 1
    };
  }

  function relError(orientation, mergedBox, token){
    if(!orientation || !mergedBox || !token) return 0;
    const err = edgeOffsetError(token, mergedBox, orientation.edgeOffsets || {});
    return Number.isFinite(err) ? err : 0;
  }

  function overlaps(a, b){
    if(!a || !b) return false;
    const ax1 = (a.x || 0) + (a.w || 0);
    const ay1 = (a.y || 0) + (a.h || 0);
    const bx1 = (b.x || 0) + (b.w || 0);
    const by1 = (b.y || 0) + (b.h || 0);
    const xOverlap = Math.max(0, Math.min(ax1, bx1) - Math.max(a.x || 0, b.x || 0));
    const yOverlap = Math.max(0, Math.min(ay1, by1) - Math.max(a.y || 0, b.y || 0));
    const area = (a.w || 0) * (a.h || 0);
    const overlapArea = xOverlap * yOverlap;
    return area > 0 && overlapArea / area > 0.25;
  }

  function captureAreaConstellation(areaBox, tokens = [], pageW = 1, pageH = 1, opts = {}){
    if(!areaBox) return null;
    const bboxPct = areaBox.bboxPct || (areaBox.normBox ? {
      x0: areaBox.normBox.x0n,
      y0: areaBox.normBox.y0n,
      x1: areaBox.normBox.x0n + areaBox.normBox.wN,
      y1: areaBox.normBox.y0n + areaBox.normBox.hN
    } : null);
    if(!bboxPct) return null;

    const areaPx = areaBox.rawBox || boxFromPct(bboxPct, pageW, pageH);
    if(!areaPx || !Number.isFinite(areaPx.w) || !Number.isFinite(areaPx.h) || areaPx.w <= 0 || areaPx.h <= 0){
      return null;
    }

    const areaPage = areaBox.page || areaBox.pageNumber || bboxPct.page || 1;
    const origin = { x: bboxPct.x0 || 0, y: bboxPct.y0 || 0 };
    const fieldSize = { w: Math.max(0, (bboxPct.x1 || 0) - (bboxPct.x0 || 0)), h: Math.max(0, (bboxPct.y1 || 0) - (bboxPct.y0 || 0)) };
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
    const maxSupports = Math.max(0, Math.min(Number.isFinite(opts.maxSupports) ? opts.maxSupports : MAX_SUPPORTS, 12));

    const candidates = (tokens || [])
      .filter(t => (!t.page || !areaPage || t.page === areaPage) && tokenInsideBox(t, areaPx))
      .map(t => {
        const center = tokenCenterNorm(t, pageW, pageH);
        const normText = normalizeKeywordText(t.text || t.raw || '');
        return {
          token: t,
          center,
          normText,
          distToOrigin: Math.hypot(center.x - origin.x, center.y - origin.y)
        };
      })
      .filter(c => !!c.normText)
      .sort((a,b) => a.distToOrigin - b.distToOrigin);

    if(!candidates.length){
      return null;
    }

    const anchor = candidates[0];
    const supports = candidates.slice(1, 1 + maxSupports);

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

    const crossLinks = buildCrossLinks(mappedSupports);
    const minSupportMatches = Number.isFinite(opts.minSupportMatches)
      ? opts.minSupportMatches
      : Math.min(2, mappedSupports.length);

    return {
      page: areaPage,
      bboxPct,
      origin,
      fieldSize,
      tolerance,
      anchor: anchorEntry,
      supports: mappedSupports,
      crossLinks,
      minSupportMatches
    };
  }

  function scoreEdgeMatch(expectedDelta, actualDelta, tolerance){
    const dxErr = Math.abs((actualDelta?.dx || 0) - (expectedDelta?.dx || 0));
    const dyErr = Math.abs((actualDelta?.dy || 0) - (expectedDelta?.dy || 0));
    const pass = dxErr <= tolerance && dyErr <= tolerance;
    const error = dxErr + dyErr;
    return { pass, error, dxErr, dyErr };
  }

  function matchAreaConstellation(fp, tokens = [], opts = {}){
    const constellation = fp?.areaConstellation || fp?.constellation || fp;
    if(!constellation || !constellation.anchor) return null;
    const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : (constellation.tolerance || DEFAULT_TOLERANCE);
    const page = opts.page || fp?.page || constellation.page || tokens[0]?.page || 1;
    const pageW = opts.pageW || 1;
    const pageH = opts.pageH || 1;
    const maxResults = Math.max(1, opts.maxResults || 5);
    const totalSupports = constellation.supports?.length || 0;
    const minSupportMatches = Number.isFinite(opts.minSupportMatches)
      ? opts.minSupportMatches
      : Math.max(0, Number.isFinite(constellation.minSupportMatches) ? constellation.minSupportMatches : Math.min(2, totalSupports));
    const anchorNorm = normalizeKeywordText(constellation.anchor.normText || constellation.anchor.text || '');
    if(!anchorNorm){ return null; }

    const supportPool = (tokens || [])
      .filter(t => (!t.page || !page || t.page === page))
      .map(t => ({ token: t, normText: normalizeKeywordText(t.text || t.raw || ''), center: tokenCenterNorm(t, pageW, pageH) }));

    const anchorCandidates = supportPool.filter(c => c.normText === anchorNorm);
    if(!anchorCandidates.length) return null;

    const matches = [];
    let matchSeq = 0;
    const totalEdges = 1 + totalSupports + (constellation.crossLinks?.length || 0);

    for(const anchorCand of anchorCandidates){
      const supportMatches = [];
      let matchedEdges = 1;
      let matchedSupports = 0;
      let errorSum = 0;

      (constellation.supports || []).forEach((supportDesc, idx) => {
        const expectedDelta = supportDesc.anchorDelta;
        const expectedNorm = normalizeKeywordText(supportDesc.normText || supportDesc.text || '');
        const candidates = supportPool.filter(c => c.normText === expectedNorm);
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
          matchedSupports += 1;
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

      if(Array.isArray(constellation.crossLinks)){
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

      if(matchedSupports < minSupportMatches){
        continue;
      }

      const fieldDelta = constellation.anchor.fieldDelta || delta(constellation.origin || {x:0,y:0}, constellation.anchor.center || {x:0,y:0});
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

      const matchedEdgeRatio = matchedEdges / Math.max(1, totalEdges);
      const supportCoverage = matchedSupports / Math.max(1, totalSupports || 1);
      const errorPenalty = Math.min(1, (errorSum / Math.max(1, matchedEdges)) / Math.max(tolerance, 1e-6));
      const confidence = clamp((matchedEdgeRatio * 0.65) + (supportCoverage * 0.25) + ((1 - errorPenalty) * 0.1), 0, 1);

      matches.push({
        matchId: `constellation-${matchSeq++}`,
        anchor: anchorCand.token,
        anchorCenter: anchorCand.center,
        matchedEdges,
        totalEdges,
        matchedSupports,
        totalSupports,
        errorSum,
        error: errorSum,
        predictedBoxPx,
        predictedBoxNorm,
        supportMatches: supportMatches.filter(Boolean),
        confidence
      });
    }

    matches.sort((a,b)=>{
      if(b.confidence !== a.confidence) return b.confidence - a.confidence;
      if(b.matchedEdges !== a.matchedEdges) return b.matchedEdges - a.matchedEdges;
      return a.errorSum - b.errorSum;
    });

    return {
      best: matches[0] || null,
      matches: matches.slice(0, maxResults)
    };
  }

  function findAreaOccurrencesForPage(areaEntries = [], tokens = [], opts = {}){
    const pageW = Math.max(1, opts.pageW || 1);
    const pageH = Math.max(1, opts.pageH || 1);
    const pageFilter = opts.page || null;
    const occurrences = [];

    const normTokenText = (text) => normalizeKeywordText ? normalizeKeywordText(text) : (text || '').toLowerCase().trim();

    for(const area of areaEntries){
      const fp = area?.areaFingerprint;
      if(!fp || !fp.bboxPct) continue;
      const page = pageFilter || fp.page || area.page || 1;

      const constellationMatches = fp.areaConstellation
        ? matchAreaConstellation(fp, tokens, { page, pageW, pageH, maxResults: opts.maxResults || 5 })
        : null;
      const totalMatches = constellationMatches?.matches?.length || 0;
      const matchedOccurrences = (constellationMatches?.matches || []).map(match => {
        const bboxNorm = match.predictedBoxNorm
          ? {
              x0: match.predictedBoxNorm.x,
              y0: match.predictedBoxNorm.y,
              x1: match.predictedBoxNorm.x + (match.predictedBoxNorm.w || 0),
              y1: match.predictedBoxNorm.y + (match.predictedBoxNorm.h || 0)
            }
          : toPctBox(match.predictedBoxPx, pageW, pageH);
        const anchorText = match.anchor ? (match.anchor.text || match.anchor.raw || '') : '';
        const supportMatches = (match.supportMatches || []).map(s => {
          const text = s?.token?.text || s?.token?.raw || '';
          return {
            text,
            normText: normTokenText(text),
            error: s?.error ?? null
          };
        });
        return {
          areaId: area.areaId || area.fieldKey || '',
          fieldKey: area.fieldKey || area.areaId || '',
          page,
          bboxPx: match.predictedBoxPx,
          bboxNorm,
          matchesFound: totalMatches,
          anchor: anchorText ? { text: anchorText, normText: normTokenText(anchorText) } : null,
          supportMatches,
          matchId: match.matchId,
          matchedEdges: match.matchedEdges,
          totalEdges: match.totalEdges,
          error: match.error ?? match.errorSum,
          constellationMatch: match.matchId ? { id: match.matchId, score: match.confidence ?? 0 } : null,
          confidence: match.confidence ?? 0,
          source: 'area-constellation',
          validation: {
            anchorText,
            supportMatches,
            supportMatchCount: match.supportMatches?.length ?? supportMatches.length,
            matchedEdges: match.matchedEdges,
            totalEdges: match.totalEdges,
            matchedSupports: match.matchedSupports,
            totalSupports: match.totalSupports,
            error: match.error ?? match.errorSum,
            errorSum: match.errorSum
          }
        };
      });

      const existingMatchCount = matchedOccurrences.length;
      const fallbackMatches = (!matchedOccurrences.length && fp.orientation)
        ? (() => {
            const expectedW = Math.max(1, (fp.bboxPct.x1 - fp.bboxPct.x0) * pageW);
            const expectedH = Math.max(1, (fp.bboxPct.y1 - fp.bboxPct.y0) * pageH);
            const topRightText = fp.orientation.topRight?.normText;
            const bottomLeftText = fp.orientation.bottomLeft?.normText;
            const topRightMatches = topRightText
              ? tokens.filter(t => (t.page || 1) === page && normTokenText(t.text || t.raw || '') === topRightText)
              : [];
            const bottomLeftMatches = bottomLeftText
              ? tokens.filter(t => (t.page || 1) === page && normTokenText(t.text || t.raw || '') === bottomLeftText)
              : [];

            const seeds = topRightMatches.length ? topRightMatches : bottomLeftMatches;
            if(!seeds.length) return [];

            const localMatches = [];
            for(const seed of seeds){
              const seedOrientation = topRightMatches.includes(seed) ? fp.orientation.topRight : fp.orientation.bottomLeft;
              const altOrientation = seedOrientation === fp.orientation.topRight ? fp.orientation.bottomLeft : fp.orientation.topRight;

              const seedBox = boxFromOrientationToken(seed, seedOrientation?.edgeOffsets || {});
              if(!seedBox) continue;

              let partnerBox = null;
              let partnerToken = null;
              if(altOrientation && (altOrientation === fp.orientation.topRight ? topRightMatches : bottomLeftMatches).length){
                const partners = altOrientation === fp.orientation.topRight ? topRightMatches : bottomLeftMatches;
                let best = null;
                for(const partner of partners){
                  const box = boxFromOrientationToken(partner, altOrientation.edgeOffsets || {});
                  if(!box) continue;
                  const dist = Math.hypot((box.x || 0) - (seedBox.x || 0), (box.y || 0) - (seedBox.y || 0));
                  if(!best || dist < best.dist){ best = { box, partner, dist }; }
                }
                partnerBox = best?.box || null;
                partnerToken = best?.partner || null;
              }

              const mergedBox = mergeBoxes(partnerBox ? [seedBox, partnerBox] : [seedBox]);
              if(!mergedBox) continue;
              mergedBox.pageWidth = pageW;
              mergedBox.pageHeight = pageH;

              const sizeRatioW = Math.min(expectedW, mergedBox.w || 1) / Math.max(expectedW, mergedBox.w || 1);
              const sizeRatioH = Math.min(expectedH, mergedBox.h || 1) / Math.max(expectedH, mergedBox.h || 1);
              const sizeOk = sizeRatioW >= 0.6 && sizeRatioH >= 0.6;
              if(!sizeOk) continue;

              const relErrs = [];
              if(seedOrientation){
                const err = relError(seedOrientation, mergedBox, seed);
                if(err !== null) relErrs.push(err);
              }
              if(partnerBox && altOrientation){
                const err = relError(altOrientation, mergedBox, partnerToken);
                if(err !== null) relErrs.push(err);
              }
              const relPenalty = relErrs.length ? Math.max(...relErrs) : 0;

              const layout = scoreLayout(fp, mergedBox, tokens, normTokenText);
              if(layout.matchRatio < 0.35) continue;
              const geometryScore = clamp((sizeRatioW + sizeRatioH) / 2, 0, 1);
              const layoutScore = clamp(layout.matchRatio * (1 - layout.positionPenalty * 0.7), 0, 1);
              const confidence = clamp(geometryScore * 0.4 + layoutScore * 0.6 * (1 - relPenalty * 0.5), 0, 1);

              const bboxNorm = toPctBox(mergedBox, pageW, pageH);
              const supportMatches = partnerToken ? [{ text: partnerToken.text || partnerToken.raw || '', normText: normTokenText(partnerToken.text || partnerToken.raw || '') }] : [];
              const anchorText = seed?.text || seed?.raw || '';
              localMatches.push({
                areaId: area.areaId || area.fieldKey || '',
                fieldKey: area.fieldKey || area.areaId || '',
                page,
                bboxPx: { x: mergedBox.x, y: mergedBox.y, w: mergedBox.w, h: mergedBox.h, page },
                bboxNorm,
                matchesFound: existingMatchCount || localMatches.length || 1,
                anchor: anchorText ? { text: anchorText, normText: normTokenText(anchorText) } : null,
                supportMatches,
                confidence,
                source: 'area-orientation',
                validation: {
                  anchorText,
                  supportMatches,
                  sizeRatioW,
                  sizeRatioH,
                  relPenalty,
                  layout,
                  orientationsUsed: [seedOrientation ? seedOrientation.role || (topRightMatches.includes(seed) ? 'topRight' : 'bottomLeft') : null, partnerBox ? (altOrientation?.role || (partnerBox === seedBox ? 'topRight' : 'bottomLeft')) : null].filter(Boolean)
                }
              });
            }
            return localMatches;
          })()
        : [];

      const allMatches = matchedOccurrences.length ? matchedOccurrences : fallbackMatches;
      for(const occurrence of allMatches){
        if(occurrences.some(o => o.page === occurrence.page && overlaps(o.bboxPx, occurrence.bboxPx))){
          continue;
        }
        occurrences.push(occurrence);
      }
    }
    return occurrences;
  }

  const api = { findAreaOccurrencesForPage, captureAreaConstellation, matchAreaConstellation };
  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.AreaFinder = api;
})(typeof window !== 'undefined' ? window : globalThis);
