(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory(root);
  } else {
    root.WFG4Localization = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const Types = root.WFG4Types || {};
  const CvOps = root.WFG4OpenCv || {};
  const DEFAULTS = Types.DEFAULTS || {};

  function getPageEntry(surface, page){
    const idx = Math.max(0, (page || 1) - 1);
    return Array.isArray(surface?.pages) ? (surface.pages[idx] || null) : null;
  }

  function resolvePredictedBox(ref, pageEntry){
    const working = pageEntry?.dimensions?.working || { width: 1, height: 1 };
    if(ref?.bboxNorm){
      const x = Number(ref.bboxNorm.x0 || 0) * working.width;
      const y = Number(ref.bboxNorm.y0 || 0) * working.height;
      const w = Math.max(1, (Number(ref.bboxNorm.x1 || 0) - Number(ref.bboxNorm.x0 || 0)) * working.width);
      const h = Math.max(1, (Number(ref.bboxNorm.y1 || 0) - Number(ref.bboxNorm.y0 || 0)) * working.height);
      return { x, y, w, h, page: ref.page || 1 };
    }
    if(ref?.bbox){
      return { x: ref.bbox.x, y: ref.bbox.y, w: ref.bbox.w, h: ref.bbox.h, page: ref.page || 1 };
    }
    return null;
  }

  function addOffset(points, offset){
    return points.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));
  }

  function applyPageAlignmentToBox(box, alignment, pageEntry){
    if(!box || !alignment?.transformN || !pageEntry?.dimensions?.working) return box || null;
    const W = Math.max(1, Number(pageEntry.dimensions.working.width || 1));
    const H = Math.max(1, Number(pageEntry.dimensions.working.height || 1));
    const t = alignment.transformN || {};
    const sx = Number.isFinite(t.sx) ? Number(t.sx) : 1;
    const sy = Number.isFinite(t.sy) ? Number(t.sy) : 1;
    const txN = Number.isFinite(t.txN) ? Number(t.txN) : 0;
    const tyN = Number.isFinite(t.tyN) ? Number(t.tyN) : 0;
    const xN = Number(box.x || 0) / W;
    const yN = Number(box.y || 0) / H;
    const wN = Math.max(1 / W, Number(box.w || 1) / W);
    const hN = Math.max(1 / H, Number(box.h || 1) / H);
    const out = {
      x: ((sx * xN) + txN) * W,
      y: ((sy * yN) + tyN) * H,
      w: Math.max(1, (sx * wN) * W),
      h: Math.max(1, (sy * hN) * H),
      page: box.page || 1
    };
    return Types.expandBox ? Types.expandBox(out, 0, { width: W, height: H }) : out;
  }

  const STATUS = (Types.LOCALIZATION_STATUS || { SUCCESS:'success', FAILED:'failed', DEGRADED_FALLBACK:'degraded_fallback' });
  const BBOX_SRC = (Types.BBOX_SOURCE || {
    LOCALIZED_PROJECTED: 'localized_projected',
    LOCALIZED_REFINED: 'localized_refined',
    PREDICTED_FALLBACK: 'predicted_fallback',
    STRUCTURAL_FALLBACK: 'structural_fallback',
    STRUCTURAL_RECONSTRUCTED: 'structural_reconstructed',
    LEGACY_BOX: 'legacy_box'
  });

  function failedResult(predictedBox, boxPx, reason, attempts){
    return {
      ok: false,
      status: STATUS.FAILED,
      localizedBox: null,
      predictedBox: predictedBox || boxPx || null,
      projectedBox: null,
      refinedBox: null,
      finalReadoutBox: null,
      bboxSource: null,
      localizationConfidence: 0.05,
      transformModel: 'none',
      matchCount: 0,
      inliers: 0,
      inlierRatio: 0,
      usedRefine: false,
      refineScore: 0,
      usedStructural: false,
      structuralAdjustments: [],
      structuralDebug: null,
      fallbackUsed: false,
      attempts: attempts || [],
      reason: reason || 'localization_failed'
    };
  }

  async function attemptOnWindow(ctx, searchBox, label){
    const { cv, runtimeCanvas, refNeighborhoodCanvas, refFieldCanvas, ref, page, predictedBox } = ctx;
    const runtimeSearchCanvas = CvOps.cropCanvas(runtimeCanvas, searchBox);
    if(!runtimeSearchCanvas){
      return { ok:false, reason:'search_window_crop_failed', label, matchCount:0, inliers:0, inlierRatio:0, transformModel:'none' };
    }
    let refMat=null, runMat=null, refGray=null, runGray=null, refFeatures=null, runFeatures=null, matrix=null;
    let localized = null, orbProjectedBox = null, postRefineBox = null;
    let transformModel='none', inliers=0, inlierRatio=0, matchCount=0, refineScore=0, usedRefine=false;
    let fieldDescriptorCount = 0, refineScale = 1, fieldVerified = false;
    try {
      refMat = cv.imread(refNeighborhoodCanvas);
      runMat = cv.imread(runtimeSearchCanvas);
      refGray = new cv.Mat();
      runGray = new cv.Mat();
      cv.cvtColor(refMat, refGray, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(runMat, runGray, cv.COLOR_RGBA2GRAY);
      refFeatures = CvOps.orbDetect(refGray, DEFAULTS.maxOrbFeatures || 300);
      runFeatures = CvOps.orbDetect(runGray, DEFAULTS.maxOrbFeatures || 300);
      const matches = CvOps.matchFeatures(refFeatures.descriptors, runFeatures.descriptors, DEFAULTS.ratioTest || 0.78);
      matchCount = matches.length;
      const transform = CvOps.estimateTransform(refFeatures.keypoints, runFeatures.keypoints, matches, {
        minGoodMatchesForHomography: DEFAULTS.minGoodMatchesForHomography,
        minGoodMatchesForAffine: DEFAULTS.minGoodMatchesForAffine,
        minInliersHomography: DEFAULTS.minInliersHomography,
        minInliersAffine: DEFAULTS.minInliersAffine,
        minInlierRatio: DEFAULTS.minInlierRatio
      });
      matrix = transform.matrix;
      transformModel = transform.model;
      inliers = transform.inliers || 0;
      inlierRatio = transform.inlierRatio || 0;

      if(transform.ok && matrix){
        const refBboxInNeighborhood = ref.visualReference?.patches?.neighborhood?.bboxWithinPatch || ref.bbox;
        const srcCorners = Types.boxToCorners ? Types.boxToCorners(refBboxInNeighborhood) : [];
        const projectedInSearch = CvOps.projectPoints(matrix, transformModel, srcCorners);
        const projectedOnPage = addOffset(projectedInSearch, { x: searchBox.x, y: searchBox.y });
        localized = Types.cornersToBox ? Types.cornersToBox(projectedOnPage, page) : predictedBox;
        if(localized && isScaleOutlier(localized, predictedBox)){
          return {
            ok: false,
            label,
            matchCount,
            inliers,
            inlierRatio,
            transformModel,
            reason: 'scale_guard_rejected_projected_box'
          };
        }
        orbProjectedBox = localized ? { ...localized } : null;
      }

      if(refFieldCanvas && localized){
        const refFieldMat = cv.imread(refFieldCanvas);
        const refFieldGray = new cv.Mat();
        cv.cvtColor(refFieldMat, refFieldGray, cv.COLOR_RGBA2GRAY);
        // Diagnostic: how many ORB features the field patch itself carries.
        // Weak field-patch descriptor counts indicate that matching is being
        // driven almost entirely by neighborhood context, which is the
        // failure mode the user reported (right region, wrong target inside).
        try {
          const fpFeats = CvOps.orbDetect(refFieldGray, DEFAULTS.maxOrbFeatures || 300);
          fieldDescriptorCount = Number(fpFeats?.keypoints?.size?.() || 0);
          fpFeats.keypoints?.delete?.();
          fpFeats.descriptors?.delete?.();
        } catch(_e){ fieldDescriptorCount = 0; }

        const fullRuntimeRgba = cv.imread(runtimeCanvas);
        const fullRuntimeGray = new cv.Mat();
        cv.cvtColor(fullRuntimeRgba, fullRuntimeGray, cv.COLOR_RGBA2GRAY);
        // Multi-scale template refinement = field-level identification under
        // cross-zoom/scale drift. Resists weak field descriptors by relying on
        // direct intensity correlation of the field patch itself.
        const refined = CvOps.localTemplateRefine(fullRuntimeGray, refFieldGray, localized, DEFAULTS.minTemplateScore || 0.42);
        if(refined.ok){
          const refinedBox = { ...refined.box, page };
          if(isScaleOutlier(refinedBox, predictedBox)){
            return {
              ok: false,
              label,
              matchCount,
              inliers,
              inlierRatio,
              transformModel,
              reason: 'scale_guard_rejected_refined_box'
            };
          }
          localized = refinedBox;
          usedRefine = true;
          fieldVerified = true;
          refineScale = refined.scale || 1;
          postRefineBox = { ...localized };
        }
        refineScore = refined.score || 0;
        fullRuntimeGray.delete();
        fullRuntimeRgba.delete();
        refFieldGray.delete();
        refFieldMat.delete();
      }

      return {
        ok: !!matrix,
        label,
        matchCount,
        inliers,
        inlierRatio,
        transformModel,
        usedRefine,
        refineScore,
        refineScale,
        fieldDescriptorCount,
        fieldVerified,
        localized,
        orbProjectedBox,
        postRefineBox,
        reason: matrix ? null : 'insufficient_geometric_consensus'
      };
    } catch(err){
      return { ok:false, label, matchCount, inliers, inlierRatio, transformModel, reason: `localization_error:${String(err?.message || err || 'unknown')}` };
    } finally {
      if(matrix) matrix.delete();
      if(refFeatures?.keypoints) refFeatures.keypoints.delete();
      if(refFeatures?.descriptors) refFeatures.descriptors.delete();
      if(runFeatures?.keypoints) runFeatures.keypoints.delete();
      if(runFeatures?.descriptors) runFeatures.descriptors.delete();
      if(refMat) refMat.delete();
      if(runMat) runMat.delete();
      if(refGray) refGray.delete();
      if(runGray) runGray.delete();
    }
  }

  function clampBoxToBounds(box, bounds){
    return Types.expandBox ? Types.expandBox(box, 0, bounds) : box;
  }

  function enforceReadoutFloor(localizedBox, predictedBox, bounds){
    if(!localizedBox || !predictedBox) return localizedBox || predictedBox || null;
    const minSideRatio = Number(DEFAULTS.readoutMinSideRatio || 0.92);
    const targetW = Math.max(Number(localizedBox.w || 1), Number(predictedBox.w || 1) * minSideRatio);
    const targetH = Math.max(Number(localizedBox.h || 1), Number(predictedBox.h || 1) * minSideRatio);
    const cx = Number(localizedBox.x || 0) + (Number(localizedBox.w || 1) / 2);
    const cy = Number(localizedBox.y || 0) + (Number(localizedBox.h || 1) / 2);
    const floored = {
      x: cx - (targetW / 2),
      y: cy - (targetH / 2),
      w: targetW,
      h: targetH,
      page: localizedBox.page || predictedBox.page || 1
    };
    return clampBoxToBounds(floored, bounds);
  }

  function computeScaleDelta(box, refBox){
    if(!box || !refBox) return null;
    const bw = Math.max(1, Number(box.w || 1));
    const bh = Math.max(1, Number(box.h || 1));
    const rw = Math.max(1, Number(refBox.w || 1));
    const rh = Math.max(1, Number(refBox.h || 1));
    return { wRatio: bw / rw, hRatio: bh / rh, areaRatio: (bw * bh) / (rw * rh) };
  }

  function isScaleOutlier(box, refBox){
    const d = computeScaleDelta(box, refBox);
    if(!d) return false;
    const minSideRatio = Number(DEFAULTS.localizationMinSideRatio || 0.45);
    const maxSideRatio = Number(DEFAULTS.localizationMaxSideRatio || 2.2);
    const minAreaRatio = Number(DEFAULTS.localizationMinAreaRatio || 0.20);
    const maxAreaRatio = Number(DEFAULTS.localizationMaxAreaRatio || 4.2);
    return (
      d.wRatio < minSideRatio || d.wRatio > maxSideRatio ||
      d.hRatio < minSideRatio || d.hRatio > maxSideRatio ||
      d.areaRatio < minAreaRatio || d.areaRatio > maxAreaRatio
    );
  }

  async function localizeFieldVisual(payload = {}){
    const fieldSpec = payload.fieldSpec || {};
    const ref = fieldSpec.wfg4Config || payload.wfg4Config || null;
    const surface = payload.wfg4Surface || null;
    const page = fieldSpec.page || ref?.page || 1;
    const pageEntry = getPageEntry(surface, page);
    const predictedBoxBase = resolvePredictedBox(ref, pageEntry) || payload.boxPx || null;
    const pageAlignment = payload.pageAlignment || null;
    const predictedBox = applyPageAlignmentToBox(predictedBoxBase, pageAlignment, pageEntry) || predictedBoxBase || null;
    const allowDegradedFallback = !!(payload.allowDegradedFallback ?? DEFAULTS.allowDegradedFallback);

    const _EL = root.EngineLog || null;
    const _fk = fieldSpec.fieldKey || '';
    if(!ref || !pageEntry || !predictedBox){
      _EL?.engineLog('wfg4-run', 'localize.result', { fieldKey: _fk, status: STATUS.FAILED, reason: 'missing_reference_or_surface', attemptsTried: 0 });
      return failedResult(predictedBox, payload.boxPx, 'missing_reference_or_surface', []);
    }

    if(!CvOps.hasCv?.() || !ref?.visualReference?.patches?.neighborhood?.dataUrl){
      _EL?.engineLog('wfg4-run', 'localize.result', { fieldKey: _fk, status: STATUS.FAILED, reason: 'cv_or_reference_patch_unavailable', attemptsTried: 0 });
      return failedResult(predictedBox, payload.boxPx, 'cv_or_reference_patch_unavailable', []);
    }

    const runtimeCanvas = await CvOps.dataUrlToCanvas(pageEntry.artifacts?.displayDataUrl || null);
    const refNeighborhoodCanvas = await CvOps.dataUrlToCanvas(ref.visualReference.patches.neighborhood.dataUrl);
    const refFieldCanvas = await CvOps.dataUrlToCanvas(ref.visualReference.patches.field?.dataUrl || null);
    if(!runtimeCanvas || !refNeighborhoodCanvas){
      _EL?.engineLog('wfg4-run', 'localize.result', { fieldKey: _fk, status: STATUS.FAILED, reason: 'canvas_decode_failed', attemptsTried: 0 });
      return failedResult(predictedBox, payload.boxPx, 'canvas_decode_failed', []);
    }

    const cv = root.cv;
    const bounds = { width: runtimeCanvas.width, height: runtimeCanvas.height };
    const basePad = Math.max(DEFAULTS.searchWindowMinPadPx || 40, Math.round(Math.max(predictedBox.w, predictedBox.h) * (DEFAULTS.searchWindowPadRatio || 0.35)));
    const widenMult = DEFAULTS.widenedSearchWindowMultiplier || 2.0;
    const maxAttempts = DEFAULTS.maxLocalizationAttemptsPerField || 4;
    const maxMs = DEFAULTS.maxLocalizationMsPerField || 2500;

    // Phase 4: structural candidate selection.
    // Runs before the window loop. Viable structural candidates (anchored to a
    // real runtime structural object) become primary search windows.  ORB on
    // the predicted box is used only when no viable structural candidate exists
    // or when all structural windows fail to produce a match.
    const rtPageStructure    = pageEntry?.pageStructure    || null;
    const configConstellation = ref?.constellation         || null;
    let structCandidates         = [];
    let hasViableStructCandidates = false;
    let structMatches            = [];
    let structMatchDebug         = null;
    let acceptedStructMatches    = [];
    if(rtPageStructure && configConstellation && CvOps.selectConstellationCandidates){
      try {
        structCandidates = CvOps.selectConstellationCandidates(
          configConstellation, rtPageStructure,
          { maxCandidates: DEFAULTS.globalScanTopCandidates || 5 }
        ) || [];
        hasViableStructCandidates = structCandidates.some(c => c.viable && c.anchorObjId !== null);
      } catch(_e){ structCandidates = []; }
    }

    // Phase 5: constellation-level structural matching.
    // Promotes Phase 4's coarse anchor shortlist to scored, member-correspondence-
    // bearing matches via a relation-graph scorer that tolerates partial matches
    // and supports repeated constellations.  Accepted matches drive the search
    // window order; if no candidate is accepted we fall back to Phase 4's raw
    // viable list, and if even those are absent we keep the legacy ORB-first path.
    const cfgBboxGeometry = ref?.bboxGeometry || null;
    if(rtPageStructure && configConstellation && structCandidates.length && CvOps.matchConstellationCandidates){
      try {
        const matchRes = CvOps.matchConstellationCandidates(
          configConstellation, rtPageStructure, structCandidates,
          {
            acceptThreshold:     DEFAULTS.constellationAcceptThreshold     || 0.35,
            memberSearchRadiusN: DEFAULTS.constellationMemberSearchRadiusN || 0.08,
            maxMatches:          DEFAULTS.globalScanTopCandidates          || 5,
            bboxGeometry:        cfgBboxGeometry
          }
        ) || { matches: [], debug: null };
        structMatches         = matchRes.matches || [];
        structMatchDebug      = matchRes.debug   || null;
        acceptedStructMatches = structMatches.filter(m => m.accepted);
        if(acceptedStructMatches.length > 0) hasViableStructCandidates = true;
      } catch(_e){ structMatches = []; structMatchDebug = { error: String(_e?.message || _e) }; }
    }

    _EL?.engineLog('wfg4-run', 'struct.candidates', {
      fieldKey: _fk,
      candidateCount: structCandidates.length,
      viableCount: structCandidates.filter(c => c.viable).length,
      hasViable: hasViableStructCandidates
    });
    // Phase 6: field reconstruction from matched constellation.
    // For every accepted Phase 5 match, project the config field bbox into
    // runtime page-normalized coordinates using a hierarchical transform
    // (page → constellation → field). The resulting reconstructedBoxPx
    // becomes the basis for the structural search windows below, replacing
    // the simple-translation D_struct boxes from Phase 4. ORB still acts
    // only as a final precision refine within those windows.
    let structReconstructions = [];
    if(acceptedStructMatches.length > 0 && CvOps.reconstructFieldFromMatch){
      const cfgFieldBboxN = ref?.bboxNorm
        ? { x0: ref.bboxNorm.x0, y0: ref.bboxNorm.y0, x1: ref.bboxNorm.x1, y1: ref.bboxNorm.y1 }
        : null;
      const surfaceSize = pageEntry?.dimensions?.working || null;
      const cfgStructIdent = ref?.structuralIdentity || null;
      if(cfgFieldBboxN && surfaceSize){
        for(let mi = 0; mi < acceptedStructMatches.length; mi++){
          try {
            const rec = CvOps.reconstructFieldFromMatch(
              configConstellation, cfgStructIdent, cfgFieldBboxN,
              acceptedStructMatches[mi], rtPageStructure, surfaceSize,
              {
                minAffineCorrespondences: DEFAULTS.reconstructionMinAffineCorrespondences || 4,
                rowSnapEnabled:           DEFAULTS.reconstructionRowSnapEnabled !== false,
                bboxGeometry:             cfgBboxGeometry
              }
            );
            if(rec && rec.ok){
              acceptedStructMatches[mi].reconstruction = rec;
              structReconstructions.push({ matchRank: acceptedStructMatches[mi].rank, ...rec });
            }
          } catch(_e){ /* best-effort, skip on failure */ }
        }
      }
    }

    _EL?.engineLog('wfg4-run', 'struct.reconstructions', {
      fieldKey: _fk,
      reconstructionCount: structReconstructions.length,
      topModel:            structReconstructions[0] ? structReconstructions[0].transformModel  : null,
      topPairs:            structReconstructions[0] ? structReconstructions[0].correspondencesUsed : 0,
      topUsedRowSnap:      structReconstructions[0] ? structReconstructions[0].usedRowSnap     : false
    });

    _EL?.engineLog('wfg4-run', 'struct.matches', {
      fieldKey: _fk,
      matchCount:    structMatches.length,
      acceptedCount: acceptedStructMatches.length,
      topScore:      structMatches[0] ? structMatches[0].finalScore : 0,
      topPartial:    structMatches[0] ? structMatches[0].partial    : null,
      topCoverage:   structMatches[0] ? structMatches[0].memberCoverage : 0,
      topRelationConsistency: structMatches[0] ? structMatches[0].relationConsistencyRatio : 0
    });
    _EL?.engineLog('wfg4-run', 'scale.baseline', {
      fieldKey: _fk,
      pageAlignmentModel: pageAlignment?.model || null,
      pageAlignmentConfidence: Number(pageAlignment?.confidence || 0),
      predictedW: Math.round(predictedBox.w || 0),
      predictedH: Math.round(predictedBox.h || 0),
      minSideRatio: Number(DEFAULTS.localizationMinSideRatio || 0.45),
      maxSideRatio: Number(DEFAULTS.localizationMaxSideRatio || 2.2),
      minAreaRatio: Number(DEFAULTS.localizationMinAreaRatio || 0.20),
      maxAreaRatio: Number(DEFAULTS.localizationMaxAreaRatio || 4.2)
    });

    // Phase 7: refine-only mode.  When at least one accepted Phase 5 match
    // produced a Phase 6 reconstruction, ORB/template are restricted to a
    // tight precision-refine pass around the reconstructed box(es).  ORB no
    // longer determines field identity; the reconstructed box is the
    // primary localizer and ORB output is accepted only if its drift is
    // within a small bound.  Repeated-constellation output is governed by
    // `repeatedConstellationPolicy` ('single' or 'multi').
    const refineOnlyMode = structReconstructions.length > 0;
    const repeatedPolicy = DEFAULTS.repeatedConstellationPolicy || 'single';
    const refinePadPx    = Math.max(
      DEFAULTS.structuralRefinePadPx || 18,
      Math.round(Math.max(predictedBox.w, predictedBox.h) * (DEFAULTS.structuralRefinePadRatio || 0.12))
    );
    const refineMaxDriftPx = Math.max(
      DEFAULTS.structuralRefineMaxDriftPx || 12,
      Math.round(Math.max(predictedBox.w, predictedBox.h) * (DEFAULTS.structuralRefineMaxDriftRatio || 0.10))
    );

    const windows = [];
    if(refineOnlyMode){
      // One tight refine window per accepted reconstruction (single = 1).
      const reconList = repeatedPolicy === 'multi'
        ? structReconstructions
        : structReconstructions.slice(0, 1);
      const cap = Math.min(reconList.length, Math.max(1, maxAttempts));
      for(let ri = 0; ri < cap; ri++){
        const rb = reconList[ri].reconstructedBoxPx;
        const refineBox = { x: rb.x, y: rb.y, w: rb.w, h: rb.h, page };
        windows.push({
          label: `R_refine_${ri}`,
          box:   clampBoxToBounds(Types.expandBox(refineBox, refinePadPx, bounds), bounds),
          reconstructionRank: ri,
          reconstructedBoxPx: rb
        });
      }
    } else if(hasViableStructCandidates){
      // Structural windows are primary; reserve at least 1 slot for ORB fallback.
      // Prefer Phase 5 accepted matches (sorted by relation-graph finalScore);
      // fall back to Phase 4 raw viable candidates if Phase 5 produced none.
      const sourceList = acceptedStructMatches.length > 0
        ? acceptedStructMatches
        : structCandidates.filter(c => c.viable);
      const maxStructWin   = Math.min(sourceList.length, Math.max(1, maxAttempts - 1));
      const W = runtimeCanvas.width, H = runtimeCanvas.height;
      for(let ci = 0; ci < maxStructWin; ci++){
        const cand = sourceList[ci];
        // Phase 6: prefer the reconstructed field box for this match (built
        // by the hierarchical transform).  Fall back to the simple
        // translated predicted box only if no reconstruction is attached.
        let structBox;
        if(cand.reconstruction && cand.reconstruction.reconstructedBoxPx){
          const rb = cand.reconstruction.reconstructedBoxPx;
          structBox = { x: rb.x, y: rb.y, w: rb.w, h: rb.h, page };
        } else {
          const shiftX = (cand.estimatedTranslationN.dxN || 0) * W;
          const shiftY = (cand.estimatedTranslationN.dyN || 0) * H;
          structBox = {
            x: predictedBox.x + shiftX, y: predictedBox.y + shiftY,
            w: predictedBox.w,          h: predictedBox.h,
            page
          };
        }
        windows.push({ label:`D_struct_${ci}`, box: clampBoxToBounds(Types.expandBox(structBox, basePad, bounds), bounds) });
      }
      // ORB fallback: original predicted box runs only if all structural windows miss.
      windows.push({ label:'A_predicted', box: clampBoxToBounds(Types.expandBox(predictedBox, basePad, bounds), bounds) });
    } else {
      // No viable structural candidates — standard ORB-first behavior.
      windows.push({ label:'A_predicted', box: clampBoxToBounds(Types.expandBox(predictedBox, basePad, bounds), bounds) });
      windows.push({ label:'B_widened',   box: clampBoxToBounds(Types.expandBox(predictedBox, Math.round(basePad * widenMult), bounds), bounds) });
      const globalScan    = pageEntry.globalScan || null;
      const topCandidates = Array.isArray(globalScan?.candidateRegions) ? globalScan.candidateRegions.slice(0, DEFAULTS.globalScanTopCandidates || 3) : [];
      for(let i = 0; i < topCandidates.length; i++){
        const cand = topCandidates[i];
        if(!cand) continue;
        const candBox = { x: cand.x, y: cand.y, w: Math.max(predictedBox.w, cand.w || 0), h: Math.max(predictedBox.h, cand.h || 0), page };
        windows.push({ label:`C_globalScan_${i}`, box: clampBoxToBounds(Types.expandBox(candBox, basePad, bounds), bounds) });
      }
    }

    const ctx = { cv, runtimeCanvas, refNeighborhoodCanvas, refFieldCanvas, ref, page, predictedBox };
    const attemptsLog = [];
    const startedAt = Date.now();
    let best = null;

    for(let i=0; i<windows.length && i<maxAttempts; i++){
      if((Date.now() - startedAt) > maxMs){
        attemptsLog.push({ label: windows[i].label, skipped:true, reason:'time_budget_exhausted' });
        break;
      }
      const res = await attemptOnWindow(ctx, windows[i].box, windows[i].label);
      attemptsLog.push({
        label: res.label,
        ok: !!res.ok,
        matchCount: res.matchCount || 0,
        inliers: res.inliers || 0,
        inlierRatio: res.inlierRatio || 0,
        transformModel: res.transformModel || 'none',
        fieldDescriptorCount: res.fieldDescriptorCount || 0,
        fieldVerified: !!res.fieldVerified,
        refineScore: res.refineScore || 0,
        refineScale: res.refineScale || 1,
        reason: res.reason || null
      });
      _EL?.engineLog('wfg4-run', 'localize.attempt', {
        fieldKey: _fk,
        attempt: res.label,
        ok: !!res.ok,
        matchCount: res.matchCount || 0,
        inliers: res.inliers || 0,
        inlierRatio: Number((res.inlierRatio || 0).toFixed(3)),
        transformModel: res.transformModel || 'none',
        reason: res.reason || null
      });
      if(res.ok && res.localized){
        best = res;
        break;
      }
      if(!best || (res.matchCount || 0) > (best.matchCount || 0)){
        best = res;
      }
    }

    // Consolidate best attempt.
    let localized = best?.localized || null;
    let orbProjectedBox = best?.orbProjectedBox || null;
    let postRefineBox = best?.postRefineBox || null;
    let transformModel = best?.transformModel || 'none';
    let inliers = best?.inliers || 0;
    let inlierRatio = best?.inlierRatio || 0;
    let matchCount = best?.matchCount || 0;
    let refineScore = best?.refineScore || 0;
    let usedRefine = !!best?.usedRefine;
    let attemptsWon = !!(best && best.ok && localized);

    // Phase 7: refine-only mode (with BBOX-exactness authority gating).
    // The reconstructed box is the authoritative localized box ONLY when
    // the Phase 6 reconstruction passes geometric constraint gates
    // (reconstructionConfidence).  When constraints are violated, the
    // reconstruction's authority is reduced — it may be blended with or
    // replaced by the predicted box.
    //
    // ORB output is accepted only as a small precision correction within
    // `refineMaxDriftPx` of the reconstructed center.  Anything beyond
    // that bound is discarded — ORB cannot relocate the field.
    let usedStructuralReconstruction = false;
    let preRefineBox  = null;
    let postRefineBox2 = null; // Phase 7 final refined box (vs Phase 6 internal postRefineBox)
    let refineDriftPx = 0;
    let refineWithinBound = false;
    let reconstructionAuthorityReduced = false;
    const topReconstruction = structReconstructions.length > 0 ? structReconstructions[0] : null;
    // BBOX-exactness: read reconstruction confidence from Phase 6.
    // Values below 0.5 indicate geometry constraint violations; below 0.3
    // means the reconstruction is likely in the wrong structural region.
    const topReconConfidence = (topReconstruction && typeof topReconstruction.reconstructionConfidence === 'number')
      ? topReconstruction.reconstructionConfidence : 1.0;
    // Also read the Phase 5 match quality for this reconstruction's source match.
    const topMatchQuality = (acceptedStructMatches.length > 0)
      ? (acceptedStructMatches[0].finalScore || 0) : 0;
    const topMatchCoverage = (acceptedStructMatches.length > 0)
      ? (acceptedStructMatches[0].memberCoverage || 0) : 0;
    const topAnchorBboxConsistency = (acceptedStructMatches.length > 0)
      ? (acceptedStructMatches[0].anchorBboxConsistency ?? 1.0) : 1.0;

    if(refineOnlyMode && topReconstruction && topReconstruction.reconstructedBoxPx){
      const reconBox = { ...topReconstruction.reconstructedBoxPx, page };
      preRefineBox = { ...reconBox };

      // BBOX-exactness: authority gating.
      // When reconstruction confidence is low (geometry constraints violated)
      // AND match quality is weak, reduce reconstruction authority by falling
      // back to predicted box instead of blindly locking in.
      const reconIsWeak = topReconConfidence < 0.50;
      const matchIsWeak = topMatchQuality < 0.55 || topMatchCoverage < 0.55;
      const anchorDisagreement = topAnchorBboxConsistency < 0.70;

      if(reconIsWeak && (matchIsWeak || anchorDisagreement)){
        // Reconstruction failed geometric validation and the match that
        // produced it is also weak. Fall back to predicted box rather
        // than locking in a wrong reconstruction.
        localized = predictedBox ? { ...predictedBox } : reconBox;
        reconstructionAuthorityReduced = true;
        usedStructuralReconstruction = false;
        _EL?.engineLog('wfg4-run', 'phase7.authority_reduced', {
          fieldKey: _fk,
          reconConfidence: topReconConfidence,
          matchScore: topMatchQuality,
          matchCoverage: topMatchCoverage,
          anchorBboxConsistency: topAnchorBboxConsistency,
          geometryViolations: topReconstruction.geometryViolations || [],
          action: 'fallback_to_predicted'
        });
      } else {
        // Reconstruction passes authority gate — use it as primary.
        localized = reconBox;
        usedStructuralReconstruction = true;
      }

      // Optional precision correction from ORB (only if reconstruction was accepted).
      if(usedStructuralReconstruction && attemptsWon && best && best.localized){
        const rcx = reconBox.x + reconBox.w / 2;
        const rcy = reconBox.y + reconBox.h / 2;
        const ocx = best.localized.x + best.localized.w / 2;
        const ocy = best.localized.y + best.localized.h / 2;
        refineDriftPx = Math.sqrt((ocx - rcx) * (ocx - rcx) + (ocy - rcy) * (ocy - rcy));
        if(refineDriftPx <= refineMaxDriftPx){
          localized      = { ...best.localized };
          postRefineBox2 = { ...localized };
          refineWithinBound = true;
        } else {
          // Drift too large — ORB tried to relocate the field. Reject.
          attemptsWon = false;
        }
      }
    } else if(!attemptsWon && topReconstruction && topReconstruction.reconstructedBoxPx){
      // No refine-only mode (defensive): keep the Phase 6 adoption path,
      // but only if reconstruction confidence is adequate.
      if(topReconConfidence >= 0.40){
        localized = { ...topReconstruction.reconstructedBoxPx, page };
        usedStructuralReconstruction = true;
      } else {
        reconstructionAuthorityReduced = true;
      }
    }

    // Structural refinement (only as controlled fallback when geometric localization failed,
    // or as refinement boost when it succeeded).
    let structuralAdjustments = [];
    let structuralDebug = null;
    let usedStructural = false;
    const structuralCtx = ref?.structuralContext || null;
    const structBaseBox = localized || predictedBox;
    if(structuralCtx?.captureStatus === 'ok' && structBaseBox){
      let rtGray = null;
      let rtRgba = null;
      try {
        rtRgba = cv.imread(runtimeCanvas);
        rtGray = new cv.Mat();
        cv.cvtColor(rtRgba, rtGray, cv.COLOR_RGBA2GRAY);
        const orbConfidence = Math.min(1, (matchCount / 30) * 0.5 + inlierRatio * 0.5);
        const orbIsWeak = !attemptsWon || orbConfidence < (DEFAULTS.orbWeakConfidenceThreshold || 0.4);
        const structResult = CvOps.structuralRefineBox(structBaseBox, structuralCtx, rtGray, {
          structuralSnapMaxPx: orbIsWeak ? (DEFAULTS.structuralSnapMaxPx || 8) * 2 : (DEFAULTS.structuralSnapMaxPx || 8),
          anchorMaxSearchDist: DEFAULTS.anchorMaxSearchDist,
          containerOverlapThreshold: DEFAULTS.containerOverlapThreshold,
          cannyThreshold1: DEFAULTS.cannyThreshold1,
          cannyThreshold2: DEFAULTS.cannyThreshold2,
          houghLineThreshold: DEFAULTS.houghLineThreshold,
          houghMinLineLength: DEFAULTS.houghMinLineLength,
          houghMaxLineGap: DEFAULTS.houghMaxLineGap,
          contourMinArea: DEFAULTS.contourMinArea
        });
        if(structResult.ok){
          localized = structResult.box;
          structuralAdjustments = structResult.adjustments || [];
          usedStructural = true;
        }
        structuralDebug = structResult.debug || null;
      } catch(_e){ /* best-effort */ } finally {
        if(rtGray) rtGray.delete();
        if(rtRgba) rtRgba.delete();
      }
    }

    // Localization status gate.
    const localizationSucceeded = attemptsWon; // geometric consensus achieved
    if(!localizationSucceeded && !usedStructural && !usedStructuralReconstruction){
      if(allowDegradedFallback){
        _EL?.engineLog('wfg4-run', 'localize.result', { fieldKey: _fk, status: STATUS.DEGRADED_FALLBACK, reason: 'degraded_fallback_predicted_box', attemptsTried: attemptsLog.length, matchCount, inliers });
        return {
          ok: false,
          status: STATUS.DEGRADED_FALLBACK,
          localizedBox: predictedBox,
          predictedBox,
          projectedBox: null,
          refinedBox: null,
          finalReadoutBox: predictedBox,
          bboxSource: BBOX_SRC.PREDICTED_FALLBACK,
          localizationConfidence: 0.12,
          transformModel,
          matchCount,
          inliers,
          inlierRatio,
          usedRefine,
          refineScore,
          usedStructural: false,
          structuralAdjustments: [],
          structuralDebug: null,
          structuralCandidates: structCandidates,
          structuralMatches: structMatches,
          structuralMatchDebug: structMatchDebug,
          structuralReconstructions: structReconstructions,
          fallbackUsed: true,
          attempts: attemptsLog,
          reason: 'degraded_fallback_predicted_box'
        };
      }
      const _allFailReason = attemptsLog.length ? ('all_attempts_failed:' + (attemptsLog[attemptsLog.length-1].reason || 'insufficient_geometric_consensus')) : 'no_attempts_run';
      _EL?.engineLog('wfg4-run', 'localize.result', { fieldKey: _fk, status: STATUS.FAILED, reason: _allFailReason, attemptsTried: attemptsLog.length, matchCount, inliers });
      return failedResult(
        predictedBox,
        payload.boxPx,
        _allFailReason,
        attemptsLog
      );
    }

    // Confidence
    const orbScore = Math.min(1, (matchCount / 30));
    const inlierScore = Math.min(1, inlierRatio);
    // Re-weight: field-level (template) verification is the strongest signal
    // that we identified the actual target inside the neighborhood, not just
    // the surrounding area. Neighborhood-only matches are downweighted.
    const refineBoost = usedRefine ? Math.max(0, Math.min(1, refineScore)) * 0.30 : 0;
    const fieldVerifiedBoost = best?.fieldVerified ? 0.10 : 0;
    const structuralBoost = usedStructural ? 0.1 : 0;
    const baseConfidence = (orbScore * 0.30) + (inlierScore * 0.30) + refineBoost + fieldVerifiedBoost + structuralBoost;
    const localizationConfidence = Math.max(0.05, Math.min(0.98, baseConfidence));

    // bboxSource
    let bboxSource;
    if(localizationSucceeded && usedRefine) bboxSource = BBOX_SRC.LOCALIZED_REFINED;
    else if(localizationSucceeded) bboxSource = BBOX_SRC.LOCALIZED_PROJECTED;
    else if(usedStructural) bboxSource = BBOX_SRC.STRUCTURAL_FALLBACK;
    else if(usedStructuralReconstruction) bboxSource = BBOX_SRC.STRUCTURAL_RECONSTRUCTED;
    else bboxSource = BBOX_SRC.PREDICTED_FALLBACK;

    let finalBox = enforceReadoutFloor(localized || predictedBox, predictedBox, bounds);

    // BBOX-exactness: footprint drift prevention.
    // After readout floor enforcement, cap the final bbox size to prevent
    // it from inflating beyond the config footprint.  This directly
    // addresses the "bbox footprint grows and captures adjacent text" failure.
    if(finalBox && predictedBox && cfgBboxGeometry){
      const maxFootprintGrowth = 1.60; // allow up to 60% growth for scale adaptation
      const maxW = predictedBox.w * maxFootprintGrowth;
      const maxH = predictedBox.h * maxFootprintGrowth;
      if(finalBox.w > maxW || finalBox.h > maxH){
        const fcx = finalBox.x + finalBox.w / 2;
        const fcy = finalBox.y + finalBox.h / 2;
        const cappedW = Math.min(finalBox.w, maxW);
        const cappedH = Math.min(finalBox.h, maxH);
        finalBox = clampBoxToBounds({
          x: fcx - cappedW / 2,
          y: fcy - cappedH / 2,
          w: cappedW,
          h: cappedH,
          page: finalBox.page || 1
        }, bounds);
      }
    }

    // Phase 7: per-instance output for repeated constellations.
    // When policy = 'multi', emit one instance per accepted reconstruction
    // (top first). Single-mode collapses to a single-element array for
    // schema continuity but does not change downstream consumers that read
    // `finalReadoutBox` only.
    let instances = null;
    if(usedStructuralReconstruction && structReconstructions.length > 0){
      const list = (repeatedPolicy === 'multi') ? structReconstructions : structReconstructions.slice(0, 1);
      instances = list.map((r, idx) => ({
        rank:               idx,
        matchRank:          r.matchRank,
        bbox:               { ...r.reconstructedBoxPx, page },
        transformModel:     r.transformModel,
        correspondencesUsed:r.correspondencesUsed,
        usedRowSnap:        r.usedRowSnap
      }));
    }

    // Phase 7 diagnostics summary.
    const selectedConstellation = (acceptedStructMatches[0] && structReconstructions[0]) ? {
      matchRank:                acceptedStructMatches[0].rank,
      anchorObjId:              acceptedStructMatches[0].anchorObjId,
      anchorType:               acceptedStructMatches[0].anchorType,
      finalScore:               acceptedStructMatches[0].finalScore,
      memberCoverage:           acceptedStructMatches[0].memberCoverage,
      relationConsistencyRatio: acceptedStructMatches[0].relationConsistencyRatio,
      distConsistencyRatio:     acceptedStructMatches[0].distConsistencyRatio,
      anchorBboxConsistency:    acceptedStructMatches[0].anchorBboxConsistency,
      partial:                  acceptedStructMatches[0].partial,
      transformModel:           structReconstructions[0].transformModel,
      correspondencesUsed:      structReconstructions[0].correspondencesUsed,
      usedRowSnap:              structReconstructions[0].usedRowSnap,
      reconstructionConfidence: structReconstructions[0].reconstructionConfidence,
      geometryViolations:       structReconstructions[0].geometryViolations,
      translationDriftN:        structReconstructions[0].translationDriftN
    } : null;
    const pageStructureSummary = rtPageStructure ? {
      regionCount:          (rtPageStructure.regions          || []).length,
      rowBandCount:         (rtPageStructure.rowBands         || []).length,
      structuralObjectCount:(rtPageStructure.structuralObjects|| []).length
    } : null;
    const fieldLevelConstellation = ref?.structuralIdentity?.miniConstellation || null;
    const _finalStatus = (localizationSucceeded || usedStructural || usedStructuralReconstruction) ? STATUS.SUCCESS : STATUS.FAILED;
    _EL?.engineLog('wfg4-run', 'struct.refine', {
      fieldKey: _fk,
      refineOnlyMode,
      usedStructuralReconstruction,
      reconstructionAuthorityReduced,
      topReconConfidence: Number(topReconConfidence.toFixed(4)),
      topMatchQuality: Number(topMatchQuality.toFixed(4)),
      topMatchCoverage: Number(topMatchCoverage.toFixed(4)),
      topAnchorBboxConsistency: Number(topAnchorBboxConsistency.toFixed(4)),
      refineWithinBound,
      refineDriftPx: Number(refineDriftPx.toFixed(2)),
      refineMaxDriftPx,
      repeatedPolicy,
      instanceCount: instances ? instances.length : 0
    });
    _EL?.engineLog('wfg4-run', 'localize.result', {
      fieldKey: _fk,
      status: _finalStatus,
      bboxSource,
      attemptsTried: attemptsLog.length,
      matchCount,
      inliers,
      usedRefine,
      usedStructural,
      fallbackUsed: !localizationSucceeded && usedStructural,
      localizationConfidence: Number(localizationConfidence.toFixed(3))
    });
    return {
      ok: true,
      status: _finalStatus,
      localizedBox: finalBox,
      predictedBox,
      projectedBox: orbProjectedBox,
      refinedBox: postRefineBox,
      finalReadoutBox: finalBox,
      bboxSource,
      localizationConfidence,
      transformModel,
      matchCount,
      inliers,
      inlierRatio,
      usedRefine,
      refineScore,
      usedStructural,
      structuralAdjustments,
      structuralDebug,
      structuralCandidates: structCandidates,
      structuralMatches: structMatches,
      structuralMatchDebug: structMatchDebug,
      structuralReconstructions: structReconstructions,
      pageAlignment,
      instances,
      selectedConstellation,
      pageStructureSummary,
      fieldLevelConstellation,
      preRefineBox,
      postRefineBoxPhase7: postRefineBox2,
      refineDriftPx,
      refineWithinBound,
      refineOnlyMode,
      reconstructionAuthorityReduced,
      topReconConfidence,
      repeatedConstellationPolicy: repeatedPolicy,
      fallbackUsed: !localizationSucceeded && usedStructural,
      attempts: attemptsLog,
      // legacy keys for backward compatibility
      orbProjectedBox,
      postRefineBox,
      reason: localizationSucceeded
        ? null
        : (usedStructural
            ? 'structural_fallback'
            : (usedStructuralReconstruction
                ? 'structural_reconstructed'
                : 'insufficient_geometric_consensus'))
    };
  }

  return {
    localizeFieldVisual
  };
});
