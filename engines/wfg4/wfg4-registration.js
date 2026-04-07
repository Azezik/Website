(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory(root);
  } else {
    root.WFG4Registration = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const Types = root.WFG4Types || {};
  const CvOps = root.WFG4OpenCv || {};
  const DEFAULTS = Types.DEFAULTS || {};

  function getPageEntry(surface, page){
    const idx = Math.max(0, (page || 1) - 1);
    return Array.isArray(surface?.pages) ? (surface.pages[idx] || null) : null;
  }

  function resolveCanonicalBox(normBox, pageEntry, pageNumber){
    const working = pageEntry?.dimensions?.working || { width: 1, height: 1 };
    const x = Number(normBox?.x0n || 0) * working.width;
    const y = Number(normBox?.y0n || 0) * working.height;
    const w = Math.max(1, Number(normBox?.wN || 0.001) * working.width);
    const h = Math.max(1, Number(normBox?.hN || 0.001) * working.height);
    return { x, y, w, h, page: pageNumber || 1 };
  }

  async function captureVisualReferencePacket(payload = {}){
    const page = payload.page || 1;
    const normBox = payload.normBox || null;
    const surface = payload.wfg4Surface || null;
    const pageEntry = getPageEntry(surface, page);
    const working = pageEntry?.dimensions?.working || { width: payload.viewport?.width || 1, height: payload.viewport?.height || 1 };
    const canonicalBox = resolveCanonicalBox(normBox, pageEntry, page);

    const packet = {
      schema: Types.WFG4_SCHEMA_VERSION || 'wfg4/v0-phase3',
      method: 'bbox-first-canonical-surface',
      engineType: 'wfg4',
      coordinateSpace: surface?.coordinateSpace || Types.WFG4_NORMALIZATION_VERSION || 'wfg4-canonical-working-v1',
      normalizationVersion: Types.WFG4_NORMALIZATION_VERSION || 'wfg4-canonical-working-v1',
      page,
      geometryId: payload.geometryId || null,
      fieldKey: payload.step?.fieldKey || null,
      surfaceSize: {
        width: Number(working.width || 0),
        height: Number(working.height || 0)
      },
      bbox: {
        x: canonicalBox.x,
        y: canonicalBox.y,
        w: canonicalBox.w,
        h: canonicalBox.h
      },
      bboxNorm: {
        x0: normBox?.x0n || 0,
        y0: normBox?.y0n || 0,
        x1: (normBox?.x0n || 0) + (normBox?.wN || 0),
        y1: (normBox?.y0n || 0) + (normBox?.hN || 0)
      },
      viewport: {
        width: payload.viewport?.width || payload.viewport?.w || 0,
        height: payload.viewport?.height || payload.viewport?.h || 0
      },
      rawBox: payload.rawBox ? {
        x: payload.rawBox.x,
        y: payload.rawBox.y,
        w: payload.rawBox.w,
        h: payload.rawBox.h
      } : null,
      visualReference: {
        neighborhoodScale: DEFAULTS.localNeighborhoodScale || 2.2,
        patches: {}
      },
      phase3Ready: true,
      // Phase 1: carry the pre-computed page-level PageStructure.
      // This is computed once in normalizePage() (wfg4-engine.js) and stored
      // on pageEntry so that both config and runtime share one code path.
      pageStructure: pageEntry?.pageStructure || null
    };

    const cvReadyInfo = CvOps.ensureCvReady
      ? await CvOps.ensureCvReady({
          timeoutMs: payload.cvReadyTimeoutMs || 12000,
          pollMs: payload.cvReadyPollMs || 75,
          autoLoad: true
        })
      : { ok: CvOps.hasCv?.() };
    const _EL = root.EngineLog || null;
    const _fk = packet.fieldKey || '';
    _EL?.engineLog('wfg4-cfg', 'opencv.ready', {
      fieldKey: _fk,
      ok: !!CvOps.hasCv?.(),
      cvReadyOk: !!(cvReadyInfo && cvReadyInfo.ok),
      source: (cvReadyInfo && cvReadyInfo.source) || null
    });
    if(!CvOps.hasCv?.()){
      packet.visualReference.captureStatus = 'cv_unavailable';
      packet.visualReference.captureError = cvReadyInfo?.source || 'opencv_runtime_unavailable';
      _EL?.engineLog('wfg4-cfg', 'registration.result', { fieldKey: _fk, status: 'cv_unavailable' });
      return packet;
    }

    if(!pageEntry?.artifacts?.displayDataUrl){
      packet.visualReference.captureStatus = 'artifact_missing';
      _EL?.engineLog('wfg4-cfg', 'registration.result', { fieldKey: _fk, status: 'artifact_missing' });
      return packet;
    }

    const pageCanvas = await CvOps.dataUrlToCanvas(pageEntry.artifacts.displayDataUrl);
    if(!pageCanvas){
      packet.visualReference.captureStatus = 'page_canvas_decode_failed';
      _EL?.engineLog('wfg4-cfg', 'registration.result', { fieldKey: _fk, status: 'page_canvas_decode_failed' });
      return packet;
    }

    const neighborhoodPad = Math.round(Math.max(canonicalBox.w, canonicalBox.h) * ((DEFAULTS.localNeighborhoodScale || 2.2) - 1) * 0.5);
    const neighborhoodBox = Types.expandBox
      ? Types.expandBox(canonicalBox, neighborhoodPad, { width: pageCanvas.width, height: pageCanvas.height })
      : canonicalBox;
    const fieldPatchCanvas = CvOps.cropCanvas(pageCanvas, canonicalBox);
    const neighborhoodCanvas = CvOps.cropCanvas(pageCanvas, neighborhoodBox);

    if(fieldPatchCanvas?.toDataURL){
      packet.visualReference.patches.field = {
        dataUrl: fieldPatchCanvas.toDataURL('image/png'),
        width: fieldPatchCanvas.width,
        height: fieldPatchCanvas.height
      };
    }
    if(neighborhoodCanvas?.toDataURL){
      packet.visualReference.patches.neighborhood = {
        dataUrl: neighborhoodCanvas.toDataURL('image/png'),
        width: neighborhoodCanvas.width,
        height: neighborhoodCanvas.height,
        box: neighborhoodBox,
        bboxWithinPatch: {
          x: canonicalBox.x - neighborhoodBox.x,
          y: canonicalBox.y - neighborhoodBox.y,
          w: canonicalBox.w,
          h: canonicalBox.h
        }
      };
    }

    const cv = root.cv;
    let fieldMat = null;
    let neighborhoodMat = null;
    let fieldGray = null;
    let neighborhoodGray = null;
    let fieldFeatures = null;
    let neighborhoodFeatures = null;
    try {
      if(fieldPatchCanvas){
        fieldMat = cv.imread(fieldPatchCanvas);
        fieldGray = new cv.Mat();
        cv.cvtColor(fieldMat, fieldGray, cv.COLOR_RGBA2GRAY);
        fieldFeatures = CvOps.orbDetect(fieldGray, DEFAULTS.maxOrbFeatures || 300);
      }
      if(neighborhoodCanvas){
        neighborhoodMat = cv.imread(neighborhoodCanvas);
        neighborhoodGray = new cv.Mat();
        cv.cvtColor(neighborhoodMat, neighborhoodGray, cv.COLOR_RGBA2GRAY);
        neighborhoodFeatures = CvOps.orbDetect(neighborhoodGray, DEFAULTS.maxOrbFeatures || 300);
      }

      packet.visualReference.features = {
        field: fieldFeatures ? {
          keypoints: CvOps.serializeKeypoints(fieldFeatures.keypoints),
          descriptors: CvOps.serializeDescriptors(fieldFeatures.descriptors)
        } : null,
        neighborhood: neighborhoodFeatures ? {
          keypoints: CvOps.serializeKeypoints(neighborhoodFeatures.keypoints),
          descriptors: CvOps.serializeDescriptors(neighborhoodFeatures.descriptors)
        } : null
      };

      // --- Structural context capture (Phase 3 extension) ---
      const structExpandPad = Math.round(Math.max(canonicalBox.w, canonicalBox.h) * (DEFAULTS.structuralExpandRatio || 0.5));
      const structBox = Types.expandBox
        ? Types.expandBox(canonicalBox, structExpandPad, { width: pageCanvas.width, height: pageCanvas.height })
        : canonicalBox;
      const structCropCanvas = CvOps.cropCanvas(pageCanvas, structBox);

      if(structCropCanvas){
        let structMat = null;
        let structGray = null;
        try {
          structMat = cv.imread(structCropCanvas);
          structGray = new cv.Mat();
          cv.cvtColor(structMat, structGray, cv.COLOR_RGBA2GRAY);

          const lines = CvOps.detectEdgesAndLines(structGray, {
            cannyThreshold1: DEFAULTS.cannyThreshold1,
            cannyThreshold2: DEFAULTS.cannyThreshold2,
            houghLineThreshold: DEFAULTS.houghLineThreshold,
            houghMinLineLength: DEFAULTS.houghMinLineLength,
            houghMaxLineGap: DEFAULTS.houghMaxLineGap
          });

          const containers = CvOps.detectContainers(structGray, {
            cannyThreshold1: DEFAULTS.cannyThreshold1,
            cannyThreshold2: DEFAULTS.cannyThreshold2,
            contourMinArea: DEFAULTS.contourMinArea
          });

          // offset lines and containers from crop-local to page coordinates
          const sox = Math.round(structBox.x);
          const soy = Math.round(structBox.y);
          for(const hl of lines.horizontal){ hl.yMid += soy; hl.x1 += sox; hl.x2 += sox; hl.y1 += soy; hl.y2 += soy; }
          for(const vl of lines.vertical){ vl.xMid += sox; vl.x1 += sox; vl.x2 += sox; vl.y1 += soy; vl.y2 += soy; }
          for(const c of containers){ c.x += sox; c.y += soy; }

          const enclosingContainer = CvOps.findEnclosingContainer(canonicalBox, containers, DEFAULTS.containerOverlapThreshold);
          const anchorOffsets = CvOps.computeAnchorOffsets(canonicalBox, lines, enclosingContainer);

          packet.structuralContext = {
            lines: {
              horizontal: lines.horizontal.slice(0, 20),
              vertical: lines.vertical.slice(0, 20)
            },
            container: enclosingContainer ? {
              x: enclosingContainer.x,
              y: enclosingContainer.y,
              w: enclosingContainer.w,
              h: enclosingContainer.h
            } : null,
            anchors: anchorOffsets,
            captureRegion: structBox,
            captureStatus: 'ok'
          };
        } catch(structErr){
          packet.structuralContext = {
            captureStatus: 'structural_capture_failed',
            captureError: String(structErr?.message || structErr || 'unknown')
          };
        } finally {
          if(structMat) structMat.delete();
          if(structGray) structGray.delete();
        }
      } else {
        packet.structuralContext = { captureStatus: 'structural_crop_failed' };
      }

      packet.visualReference.captureStatus = 'ok';
    } catch(err){
      packet.visualReference.captureStatus = 'feature_capture_failed';
      packet.visualReference.captureError = String(err?.message || err || 'unknown_error');
    } finally {
      if(fieldFeatures?.keypoints) fieldFeatures.keypoints.delete();
      if(fieldFeatures?.descriptors) fieldFeatures.descriptors.delete();
      if(neighborhoodFeatures?.keypoints) neighborhoodFeatures.keypoints.delete();
      if(neighborhoodFeatures?.descriptors) neighborhoodFeatures.descriptors.delete();
      if(fieldMat) fieldMat.delete();
      if(neighborhoodMat) neighborhoodMat.delete();
      if(fieldGray) fieldGray.delete();
      if(neighborhoodGray) neighborhoodGray.delete();
    }

    const _captureStatus = (packet.visualReference && packet.visualReference.captureStatus) || 'unknown';
    const _hasNeighborhood = !!(packet.visualReference && packet.visualReference.patches && packet.visualReference.patches.neighborhood);
    const _hasField = !!(packet.visualReference && packet.visualReference.patches && packet.visualReference.patches.field);
    const _hasFeatures = !!(packet.visualReference && packet.visualReference.features && packet.visualReference.features.neighborhood);
    _EL?.engineLog('wfg4-cfg', 'registration.result', {
      fieldKey: _fk,
      status: _captureStatus,
      hasNeighborhoodPatch: _hasNeighborhood,
      hasFieldPatch: _hasField,
      hasFeatures: _hasFeatures,
      structuralStatus: (packet.structuralContext && packet.structuralContext.captureStatus) || null
    });
    return packet;
  }

  return {
    captureVisualReferencePacket
  };
});
