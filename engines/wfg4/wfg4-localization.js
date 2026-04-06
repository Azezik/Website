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

  async function localizeFieldVisual(payload = {}){
    const fieldSpec = payload.fieldSpec || {};
    const ref = fieldSpec.wfg4Config || payload.wfg4Config || null;
    const surface = payload.wfg4Surface || null;
    const page = fieldSpec.page || ref?.page || 1;
    const pageEntry = getPageEntry(surface, page);
    const predictedBox = resolvePredictedBox(ref, pageEntry) || payload.boxPx || null;

    if(!ref || !pageEntry || !predictedBox){
      return {
        ok:false,
        localizedBox: payload.boxPx || null,
        localizationConfidence: 0.1,
        reason: 'missing_reference_or_surface'
      };
    }

    if(!CvOps.hasCv?.() || !ref?.visualReference?.patches?.neighborhood?.dataUrl){
      return {
        ok:false,
        localizedBox: predictedBox,
        localizationConfidence: 0.15,
        reason: 'cv_or_reference_patch_unavailable'
      };
    }

    const runtimeCanvas = await CvOps.dataUrlToCanvas(pageEntry.artifacts?.displayDataUrl || null);
    const refNeighborhoodCanvas = await CvOps.dataUrlToCanvas(ref.visualReference.patches.neighborhood.dataUrl);
    const refFieldCanvas = await CvOps.dataUrlToCanvas(ref.visualReference.patches.field?.dataUrl || null);
    if(!runtimeCanvas || !refNeighborhoodCanvas){
      return {
        ok:false,
        localizedBox: predictedBox,
        localizationConfidence: 0.15,
        reason: 'canvas_decode_failed'
      };
    }

    const cv = root.cv;
    const pad = Math.max(DEFAULTS.searchWindowMinPadPx || 40, Math.round(Math.max(predictedBox.w, predictedBox.h) * (DEFAULTS.searchWindowPadRatio || 0.35)));
    const searchBox = Types.expandBox
      ? Types.expandBox(predictedBox, pad, { width: runtimeCanvas.width, height: runtimeCanvas.height })
      : predictedBox;
    const runtimeSearchCanvas = CvOps.cropCanvas(runtimeCanvas, searchBox);
    if(!runtimeSearchCanvas){
      return {
        ok:false,
        localizedBox: predictedBox,
        localizationConfidence: 0.1,
        reason: 'search_window_crop_failed'
      };
    }

    let refMat = null;
    let runMat = null;
    let refGray = null;
    let runGray = null;
    let refFeatures = null;
    let runFeatures = null;
    let matrix = null;
    let localized = predictedBox;
    let orbProjectedBox = null;
    let postRefineBox = null;
    let transformModel = 'none';
    let inliers = 0;
    let inlierRatio = 0;
    let matchCount = 0;
    let refineScore = 0;
    let usedRefine = false;

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
        const srcCorners = Types.boxToCorners
          ? Types.boxToCorners(refBboxInNeighborhood)
          : [];
        const projectedInSearch = CvOps.projectPoints(matrix, transformModel, srcCorners);
        const projectedOnPage = addOffset(projectedInSearch, { x: searchBox.x, y: searchBox.y });
        localized = Types.cornersToBox
          ? Types.cornersToBox(projectedOnPage, page)
          : predictedBox;
        orbProjectedBox = localized ? { ...localized } : null;
      }

      if(refFieldCanvas && localized){
        const refFieldMat = cv.imread(refFieldCanvas);
        const refFieldGray = new cv.Mat();
        cv.cvtColor(refFieldMat, refFieldGray, cv.COLOR_RGBA2GRAY);

        const fullRuntimeRgba = cv.imread(runtimeCanvas);
        const fullRuntimeGray = new cv.Mat();
        cv.cvtColor(fullRuntimeRgba, fullRuntimeGray, cv.COLOR_RGBA2GRAY);
        const refined = CvOps.localTemplateRefine(fullRuntimeGray, refFieldGray, localized, DEFAULTS.minTemplateScore || 0.42);
        if(refined.ok){
          localized = { ...refined.box, page };
          usedRefine = true;
          postRefineBox = { ...localized };
        }
        refineScore = refined.score || 0;

        fullRuntimeGray.delete();
        fullRuntimeRgba.delete();
        refFieldGray.delete();
        refFieldMat.delete();
      }

      // --- Structural anchor refinement (Phase 3 extension) ---
      let structuralAdjustments = [];
      let usedStructural = false;
      const structuralCtx = ref?.structuralContext || null;
      const orbConfidence = Math.min(1, (matchCount / 30) * 0.5 + inlierRatio * 0.5);
      const orbIsWeak = !matrix || orbConfidence < (DEFAULTS.orbWeakConfidenceThreshold || 0.4);

      if(structuralCtx?.captureStatus === 'ok' && localized){
        let rtGray = null;
        let rtRgba = null;
        try {
          rtRgba = cv.imread(runtimeCanvas);
          rtGray = new cv.Mat();
          cv.cvtColor(rtRgba, rtGray, cv.COLOR_RGBA2GRAY);

          const structResult = CvOps.structuralRefineBox(localized, structuralCtx, rtGray, {
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
        } catch(e){
          // structural refinement is best-effort; fall through
        } finally {
          if(rtGray) rtGray.delete();
          if(rtRgba) rtRgba.delete();
        }
      }

      const orbScore = Math.min(1, (matchCount / 30));
      const inlierScore = Math.min(1, inlierRatio);
      const refineBoost = usedRefine ? Math.max(0, Math.min(1, refineScore)) * 0.2 : 0;
      const structuralBoost = usedStructural ? 0.1 : 0;
      const baseConfidence = (orbScore * 0.4) + (inlierScore * 0.4) + refineBoost + structuralBoost;
      const localizationConfidence = Math.max(0.05, Math.min(0.98, baseConfidence));

      return {
        ok: !!(matrix || usedStructural),
        localizedBox: localized || predictedBox,
        predictedBox: predictedBox || null,
        orbProjectedBox: orbProjectedBox || null,
        postRefineBox: postRefineBox || (usedStructural ? localized : null),
        localizationConfidence,
        transformModel,
        matchCount,
        inliers,
        inlierRatio,
        usedRefine,
        refineScore,
        usedStructural,
        structuralAdjustments,
        reason: matrix ? null : (usedStructural ? 'structural_fallback' : 'insufficient_geometric_consensus')
      };
    } catch(err){
      return {
        ok:false,
        localizedBox: predictedBox,
        localizationConfidence: 0.12,
        transformModel,
        matchCount,
        inliers,
        inlierRatio,
        usedRefine,
        refineScore,
        reason: `localization_error:${String(err?.message || err || 'unknown')}`
      };
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

  return {
    localizeFieldVisual
  };
});
