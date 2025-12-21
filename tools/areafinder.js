(function(global){
  const keywordModule = global.KeywordWeighting || require('./keyword-weighting.js') || {};
  const normalizeKeywordText = keywordModule.normalizeKeywordText || ((text='') => text.toString().toLowerCase().trim());

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function toPctBox(bboxPx = {}, pageW = 1, pageH = 1){
    return {
      x0: (bboxPx.x || 0) / pageW,
      y0: (bboxPx.y || 0) / pageH,
      x1: ((bboxPx.x || 0) + (bboxPx.w || 0)) / pageW,
      y1: ((bboxPx.y || 0) + (bboxPx.h || 0)) / pageH
    };
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

  function relError(orientation, mergedBox){
    if(!orientation || !mergedBox) return 0;
    return 0;
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

  function findAreaOccurrencesForPage(areaEntries = [], tokens = [], opts = {}){
    const pageW = Math.max(1, opts.pageW || 1);
    const pageH = Math.max(1, opts.pageH || 1);
    const occurrences = [];

    const normTokenText = (text) => normalizeKeywordText ? normalizeKeywordText(text) : (text || '').toLowerCase().trim();

    for(const area of areaEntries){
      const fp = area?.areaFingerprint;
      if(!fp || !fp.orientation || !fp.bboxPct) continue;
      const expectedW = Math.max(1, (fp.bboxPct.x1 - fp.bboxPct.x0) * pageW);
      const expectedH = Math.max(1, (fp.bboxPct.y1 - fp.bboxPct.y0) * pageH);
      const page = fp.page || area.page || 1;
      const topRightText = fp.orientation.topRight?.normText;
      const bottomLeftText = fp.orientation.bottomLeft?.normText;
      const topRightMatches = topRightText
        ? tokens.filter(t => (t.page || 1) === page && normTokenText(t.text || t.raw || '') === topRightText)
        : [];
      const bottomLeftMatches = bottomLeftText
        ? tokens.filter(t => (t.page || 1) === page && normTokenText(t.text || t.raw || '') === bottomLeftText)
        : [];

      const seeds = topRightMatches.length ? topRightMatches : bottomLeftMatches;
      if(!seeds.length) continue;

      for(const seed of seeds){
        const seedOrientation = topRightMatches.includes(seed) ? fp.orientation.topRight : fp.orientation.bottomLeft;
        const altOrientation = seedOrientation === fp.orientation.topRight ? fp.orientation.bottomLeft : fp.orientation.topRight;

        const seedBox = boxFromOrientationToken(seed, seedOrientation?.edgeOffsets || {});
        if(!seedBox) continue;

        let partnerBox = null;
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
          const err = relError(seedOrientation, mergedBox);
          if(err !== null) relErrs.push(err);
        }
        if(partnerBox && altOrientation){
          const err = relError(altOrientation, mergedBox);
          if(err !== null) relErrs.push(err);
        }
        const relPenalty = relErrs.length ? Math.max(...relErrs) : 0;
        const confidence = clamp((sizeRatioW + sizeRatioH) / 2 * (1 - relPenalty * 0.8), 0, 1);

        const bboxNorm = toPctBox(mergedBox, pageW, pageH);
        const occurrence = {
          areaId: area.areaId || area.fieldKey || '',
          fieldKey: area.fieldKey || area.areaId || '',
          page,
          bboxPx: { x: mergedBox.x, y: mergedBox.y, w: mergedBox.w, h: mergedBox.h, page },
          bboxNorm,
          confidence,
          source: 'areafinder',
          validation: {
            sizeRatioW,
            sizeRatioH,
            relPenalty,
            orientationsUsed: [seedOrientation ? seedOrientation.role || (topRightMatches.includes(seed) ? 'topRight' : 'bottomLeft') : null, partnerBox ? (altOrientation?.role || (partnerBox === seedBox ? 'topRight' : 'bottomLeft')) : null].filter(Boolean)
          }
        };

        if(occurrences.some(o => o.page === page && overlaps(o.bboxPx, occurrence.bboxPx))){
          continue;
        }
        occurrences.push(occurrence);
      }
    }
    return occurrences;
  }

  const api = { findAreaOccurrencesForPage };
  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.AreaFinder = api;
})(typeof window !== 'undefined' ? window : globalThis);
