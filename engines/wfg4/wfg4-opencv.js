(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WFG4OpenCv = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const Types = root.WFG4Types || {};
  const clamp = Types.clamp || ((v,min,max)=>Math.max(min,Math.min(max,v)));
  const DEFAULT_OPENCV_JS_URL = 'vendor/opencv/4.10.0/opencv.js';
  let cvScriptLoadPromise = null;

  function hasCv(){
    const cv = root.cv;
    return !!(cv && typeof cv.imread === 'function' && typeof cv.ORB === 'function');
  }

  function wait(ms){
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function loadCvScript(opts = {}){
    if(hasCv()) return Promise.resolve({ ok:true, source:'already_loaded' });
    if(typeof document === 'undefined'){
      return Promise.resolve({ ok:false, source:'no_document' });
    }
    if(cvScriptLoadPromise) return cvScriptLoadPromise;
    const scriptUrl = String(opts.scriptUrl || DEFAULT_OPENCV_JS_URL || '').trim();
    if(!scriptUrl){
      return Promise.resolve({ ok:false, source:'missing_script_url' });
    }
    const existing = document.querySelector('script[data-wfg4-opencv="true"]');
    if(existing){
      cvScriptLoadPromise = Promise.resolve({ ok:true, source:'existing_tag' });
      return cvScriptLoadPromise;
    }
    cvScriptLoadPromise = new Promise(resolve => {
      const s = document.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      s.dataset.wfg4Opencv = 'true';
      s.onload = () => resolve({ ok:true, source:'loaded', scriptUrl });
      s.onerror = () => resolve({ ok:false, source:'load_error', scriptUrl });
      document.head?.appendChild(s);
    });
    return cvScriptLoadPromise;
  }

  async function ensureCvReady(opts = {}){
    if(hasCv()) return { ok:true, ready:true, source:'already_ready' };
    const timeoutMs = Math.max(200, Number(opts.timeoutMs || 12000));
    const pollMs = Math.max(25, Number(opts.pollMs || 75));
    const autoLoad = opts.autoLoad !== false;
    if(autoLoad){
      await loadCvScript(opts);
    }
    const cv = root.cv;
    if(cv && typeof cv.then === 'function'){
      try {
        await Promise.race([
          cv,
          wait(timeoutMs)
        ]);
      } catch(_err){
        // fall through to polling; final status determined below
      }
    }
    const start = Date.now();
    while((Date.now() - start) < timeoutMs){
      if(hasCv()){
        return { ok:true, ready:true, source:'runtime_ready' };
      }
      await wait(pollMs);
    }
    return { ok:false, ready:false, source:'timeout_or_unavailable' };
  }

  function dataUrlToCanvas(dataUrl){
    return new Promise((resolve) => {
      if(!dataUrl || typeof document === 'undefined') return resolve(null);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
        canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if(!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function cropCanvas(sourceCanvas, box){
    if(!sourceCanvas || !box || typeof document === 'undefined') return null;
    const x = clamp(Math.round(box.x || 0), 0, Math.max(0, sourceCanvas.width - 1));
    const y = clamp(Math.round(box.y || 0), 0, Math.max(0, sourceCanvas.height - 1));
    const w = clamp(Math.round(box.w || 1), 1, Math.max(1, sourceCanvas.width - x));
    const h = clamp(Math.round(box.h || 1), 1, Math.max(1, sourceCanvas.height - y));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if(!ctx) return null;
    ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
    return canvas;
  }

  function orbDetect(grayMat, maxFeatures){
    const cv = root.cv;
    const orb = new cv.ORB(Math.max(100, maxFeatures || 300));
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    orb.detectAndCompute(grayMat, new cv.Mat(), keypoints, descriptors, false);
    orb.delete();
    return { keypoints, descriptors };
  }

  function serializeKeypoints(keypoints){
    const out = [];
    const count = Number(keypoints?.size?.() || 0);
    for(let i=0; i<count; i++){
      const kp = keypoints.get(i);
      out.push([kp.pt.x, kp.pt.y, kp.size, kp.angle, kp.response, kp.octave, kp.class_id]);
    }
    return out;
  }

  function deserializeKeypoints(serialized){
    const cv = root.cv;
    const vec = new cv.KeyPointVector();
    if(!Array.isArray(serialized)) return vec;
    for(const row of serialized){
      if(!Array.isArray(row) || row.length < 2) continue;
      vec.push_back(new cv.KeyPoint(
        Number(row[0] || 0),
        Number(row[1] || 0),
        Number(row[2] || 1),
        Number(row[3] || 0),
        Number(row[4] || 0),
        Number(row[5] || 0),
        Number(row[6] || -1)
      ));
    }
    return vec;
  }

  function matToBase64(mat){
    if(!mat || !mat.data || !mat.rows || !mat.cols) return null;
    const bytes = mat.data;
    let binary = '';
    const chunk = 0x8000;
    for(let i=0; i<bytes.length; i += chunk){
      const sub = bytes.subarray(i, Math.min(bytes.length, i + chunk));
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }

  function base64ToMat(base64, rows, cols, type){
    const cv = root.cv;
    if(!base64 || !rows || !cols) return new cv.Mat();
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for(let i=0; i<bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mat = new cv.Mat(rows, cols, type || cv.CV_8U);
    mat.data.set(bytes);
    return mat;
  }

  function serializeDescriptors(desc){
    if(!desc || !desc.rows || !desc.cols || !desc.data || !desc.data.length) return null;
    return {
      rows: desc.rows,
      cols: desc.cols,
      type: desc.type(),
      data: matToBase64(desc)
    };
  }

  function deserializeDescriptors(payload){
    const cv = root.cv;
    if(!payload?.data || !payload.rows || !payload.cols) return new cv.Mat();
    return base64ToMat(payload.data, payload.rows, payload.cols, payload.type || cv.CV_8U);
  }

  function matchFeatures(refDescriptors, runDescriptors, ratioTest){
    const cv = root.cv;
    const goodMatches = [];
    if(!refDescriptors || !runDescriptors || refDescriptors.empty() || runDescriptors.empty()) return goodMatches;
    const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const knn = new cv.DMatchVectorVector();
    matcher.knnMatch(refDescriptors, runDescriptors, knn, 2);
    for(let i=0; i<knn.size(); i++){
      const pair = knn.get(i);
      if(!pair || pair.size() < 2) continue;
      const m = pair.get(0);
      const n = pair.get(1);
      if(m.distance < (ratioTest || 0.78) * n.distance){
        goodMatches.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance });
      }
      pair.delete();
    }
    knn.delete();
    matcher.delete();
    return goodMatches;
  }

  function estimateTransform(refKeypoints, runKeypoints, goodMatches, thresholds){
    const cv = root.cv;
    const limits = thresholds || {};
    if(!Array.isArray(goodMatches) || !goodMatches.length){
      return { ok:false, model:'none', inliers:0, inlierRatio:0, matrix:null };
    }

    const srcPts = [];
    const dstPts = [];
    for(const m of goodMatches){
      const src = refKeypoints.get(m.queryIdx).pt;
      const dst = runKeypoints.get(m.trainIdx).pt;
      srcPts.push(src.x, src.y);
      dstPts.push(dst.x, dst.y);
    }
    const srcMat = cv.matFromArray(goodMatches.length, 1, cv.CV_32FC2, srcPts);
    const dstMat = cv.matFromArray(goodMatches.length, 1, cv.CV_32FC2, dstPts);

    let model = 'none';
    let matrix = null;
    let minInliers = limits.minInliersAffine || 5;
    let inliers = 0;

    if(goodMatches.length >= (limits.minGoodMatchesForHomography || 10)){
      const maskH = new cv.Mat();
      const h = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3.0, maskH);
      if(h && !h.empty()){
        for(let i=0; i<maskH.rows; i++) if(maskH.data[i]) inliers += 1;
        model = 'homography';
        matrix = h;
        minInliers = limits.minInliersHomography || 8;
      } else if(h){
        h.delete();
      }
      maskH.delete();
    }

    if(!matrix && goodMatches.length >= (limits.minGoodMatchesForAffine || 6)){
      const affMask = new cv.Mat();
      const a = cv.estimateAffinePartial2D(srcMat, dstMat, affMask, cv.RANSAC, 3.0);
      if(a && !a.empty()){
        inliers = 0;
        for(let i=0; i<affMask.rows; i++) if(affMask.data[i]) inliers += 1;
        model = 'affine';
        matrix = a;
        minInliers = limits.minInliersAffine || 5;
      } else if(a){
        a.delete();
      }
      affMask.delete();
    }

    const inlierRatio = goodMatches.length ? (inliers / goodMatches.length) : 0;

    srcMat.delete();
    dstMat.delete();

    const ok = !!matrix
      && inliers >= minInliers
      && inlierRatio >= (limits.minInlierRatio || 0.35);

    if(!ok && matrix){
      matrix.delete();
      matrix = null;
      model = 'none';
    }

    return { ok, model, inliers, inlierRatio, matrix };
  }


  function projectPoints(matrix, model, points){
    const cv = root.cv;
    if(!matrix || !Array.isArray(points) || !points.length) return [];
    if(model === 'homography'){
      const srcArr = [];
      for(const p of points){ srcArr.push(p.x, p.y); }
      const src = cv.matFromArray(points.length, 1, cv.CV_32FC2, srcArr);
      const dst = new cv.Mat();
      cv.perspectiveTransform(src, dst, matrix);
      const out = [];
      for(let i=0; i<points.length; i++){
        out.push({ x: dst.data32F[i * 2], y: dst.data32F[i * 2 + 1] });
      }
      src.delete();
      dst.delete();
      return out;
    }
    if(model === 'affine'){
      const a = matrix.data64F;
      return points.map(p => ({
        x: (a[0] * p.x) + (a[1] * p.y) + a[2],
        y: (a[3] * p.x) + (a[4] * p.y) + a[5]
      }));
    }
    return [];
  }

  function localTemplateRefine(runtimeGray, refPatchGray, projectedBox, minScore){
    const cv = root.cv;
    if(!runtimeGray || !refPatchGray || !projectedBox) return { ok:false, box:projectedBox, score:0, scale:1 };
    // Wider search pad helps when projection is slightly off due to scale drift.
    const searchPad = Math.max(24, Math.round(Math.max(projectedBox.w, projectedBox.h) * 0.45));
    const x = clamp(Math.round(projectedBox.x - searchPad), 0, Math.max(0, runtimeGray.cols - 2));
    const y = clamp(Math.round(projectedBox.y - searchPad), 0, Math.max(0, runtimeGray.rows - 2));
    const w = clamp(Math.round(projectedBox.w + (searchPad * 2)), 4, runtimeGray.cols - x);
    const h = clamp(Math.round(projectedBox.h + (searchPad * 2)), 4, runtimeGray.rows - y);
    const roi = runtimeGray.roi(new cv.Rect(x, y, w, h));

    // Multi-scale template refinement: tries a small ladder of scales so that
    // when the run document differs in zoom / DPI / scan resolution from the
    // config-time canonical surface, the field patch can still be located
    // precisely. Without this, single-scale matchTemplate degrades sharply at
    // even ~10% scale drift.
    const scales = [0.80, 0.88, 0.94, 1.00, 1.06, 1.13, 1.22, 1.32];
    let best = { ok:false, box:projectedBox, score:0, scale:1 };
    for(const s of scales){
      const sw = Math.max(4, Math.round(refPatchGray.cols * s));
      const sh = Math.max(4, Math.round(refPatchGray.rows * s));
      if(sw >= w || sh >= h) continue;
      const scaled = new cv.Mat();
      try {
        cv.resize(refPatchGray, scaled, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
        const resultCols = w - sw + 1;
        const resultRows = h - sh + 1;
        const result = new cv.Mat(resultRows, resultCols, cv.CV_32FC1);
        cv.matchTemplate(roi, scaled, result, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(result);
        const score = Number(mm.maxVal || 0);
        if(score > best.score){
          best = {
            ok: false,
            box: {
              x: x + mm.maxLoc.x,
              y: y + mm.maxLoc.y,
              w: sw,
              h: sh,
              page: projectedBox.page || 1
            },
            score,
            scale: s
          };
        }
        result.delete();
      } catch(_e){ /* skip this scale */ } finally {
        scaled.delete();
      }
    }
    roi.delete();
    best.ok = best.score >= (minScore || 0.42);
    return best;
  }

  // --- Structural detection functions (Phase 3 extension) ---

  function detectEdgesAndLines(grayMat, opts){
    const cv = root.cv;
    const o = opts || {};
    const edges = new cv.Mat();
    cv.Canny(grayMat, edges, o.cannyThreshold1 || 50, o.cannyThreshold2 || 150);

    const lines = new cv.Mat();
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180,
      o.houghLineThreshold || 40,
      o.houghMinLineLength || 30,
      o.houghMaxLineGap || 10);

    const horizontal = [];
    const vertical = [];
    for(let i = 0; i < lines.rows; i++){
      const x1 = lines.data32S[i * 4];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      if(dy < 5 && dx > 10){
        horizontal.push({ x1, y1, x2, y2, yMid: (y1 + y2) / 2 });
      } else if(dx < 5 && dy > 10){
        vertical.push({ x1, y1, x2, y2, xMid: (x1 + x2) / 2 });
      }
    }

    edges.delete();
    lines.delete();
    return { horizontal, vertical };
  }

  function detectContainers(grayMat, opts){
    const cv = root.cv;
    const o = opts || {};
    const edges = new cv.Mat();
    cv.Canny(grayMat, edges, o.cannyThreshold1 || 50, o.cannyThreshold2 || 150);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    const rects = [];
    for(let i = 0; i < contours.size(); i++){
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if(area < (o.contourMinArea || 200)){ cnt.delete(); continue; }
      const approx = new cv.Mat();
      const peri = cv.arcLength(cnt, true);
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if(approx.rows === 4){
        const br = cv.boundingRect(approx);
        rects.push({ x: br.x, y: br.y, w: br.width, h: br.height, area });
      }
      approx.delete();
      cnt.delete();
    }

    contours.delete();
    hierarchy.delete();
    edges.delete();

    rects.sort((a, b) => a.area - b.area);
    return rects;
  }

  function findEnclosingContainer(bbox, containers, overlapThreshold, refSizeHint){
    const thresh = overlapThreshold || 0.7;
    const bx1 = bbox.x, by1 = bbox.y, bx2 = bbox.x + bbox.w, by2 = bbox.y + bbox.h;
    const bArea = Math.max(1, bbox.w * bbox.h);
    let best = null;
    let bestScore = -Infinity;
    for(const c of containers){
      const cx1 = c.x, cy1 = c.y, cx2 = c.x + c.w, cy2 = c.y + c.h;
      const ix1 = Math.max(bx1, cx1), iy1 = Math.max(by1, cy1);
      const ix2 = Math.min(bx2, cx2), iy2 = Math.min(by2, cy2);
      if(ix1 >= ix2 || iy1 >= iy2) continue;
      const iArea = (ix2 - ix1) * (iy2 - iy1);
      if((iArea / bArea) < thresh) continue;
      // Disambiguate using a closeness-of-fit score: prefer containers whose
      // size matches an optional reference size hint, otherwise prefer the
      // smallest enclosing container. This avoids snapping a single cell to
      // its enclosing table.
      let score;
      const cArea = Math.max(1, c.w * c.h);
      if(refSizeHint && refSizeHint.area > 0){
        const ratio = Math.min(cArea, refSizeHint.area) / Math.max(cArea, refSizeHint.area);
        score = ratio - (Math.abs(c.w - refSizeHint.w) + Math.abs(c.h - refSizeHint.h)) / 1000;
      } else {
        score = -cArea;
      }
      if(score > bestScore){ bestScore = score; best = c; }
    }
    return best;
  }

  function computeAnchorOffsets(bbox, lines, container){
    const bTop = bbox.y;
    const bBottom = bbox.y + bbox.h;
    const bLeft = bbox.x;
    const bRight = bbox.x + bbox.w;
    const maxDist = 9999;

    let nearestAbove = maxDist, nearestBelow = maxDist;
    let nearestLeft = maxDist, nearestRight = maxDist;

    for(const hl of lines.horizontal){
      if(hl.x1 > bRight || hl.x2 < bLeft) continue;
      const dist = bTop - hl.yMid;
      if(dist > 0 && dist < nearestAbove) nearestAbove = dist;
      const distBelow = hl.yMid - bBottom;
      if(distBelow > 0 && distBelow < nearestBelow) nearestBelow = distBelow;
    }

    for(const vl of lines.vertical){
      if(vl.y1 > bBottom || vl.y2 < bTop) continue;
      const dist = bLeft - vl.xMid;
      if(dist > 0 && dist < nearestLeft) nearestLeft = dist;
      const distRight = vl.xMid - bRight;
      if(distRight > 0 && distRight < nearestRight) nearestRight = distRight;
    }

    const anchors = {
      distAbove: nearestAbove < maxDist ? nearestAbove : null,
      distBelow: nearestBelow < maxDist ? nearestBelow : null,
      distLeft: nearestLeft < maxDist ? nearestLeft : null,
      distRight: nearestRight < maxDist ? nearestRight : null
    };

    if(container){
      anchors.containerOffset = {
        top: bbox.y - container.y,
        left: bbox.x - container.x,
        bottom: (container.y + container.h) - (bbox.y + bbox.h),
        right: (container.x + container.w) - (bbox.x + bbox.w)
      };
      anchors.relativePosition = {
        xRatio: container.w > 0 ? (bbox.x - container.x) / container.w : 0,
        yRatio: container.h > 0 ? (bbox.y - container.y) / container.h : 0,
        wRatio: container.w > 0 ? bbox.w / container.w : 1,
        hRatio: container.h > 0 ? bbox.h / container.h : 1
      };
    }

    return anchors;
  }

  // ---------------------------------------------------------------------------
  // buildPageStructure — Phase 1 structural prepass
  //
  // Produces a normalized PageStructure from a full-page gray mat.  This is
  // the single shared implementation used by both config-time (via pageEntry
  // stored on the surface) and runtime flows.  It replaces ad-hoc per-call
  // detectEdgesAndLines / detectContainers invocations for page-level use.
  //
  // Returned schema: 'wfg4/page-structure/v1'
  // All geometry in .geom / *N fields is normalized to [0, 1] page coords.
  // ---------------------------------------------------------------------------
  function buildPageStructure(grayMat, surfaceSize, opts){
    var o = opts || {};
    var W = Math.max(1, Number((surfaceSize && surfaceSize.width) ? surfaceSize.width : (grayMat ? grayMat.cols : 1)));
    var H = Math.max(1, Number((surfaceSize && surfaceSize.height) ? surfaceSize.height : (grayMat ? grayMat.rows : 1)));

    // Row-band clustering gap: at least 10px or 2% of page height
    var rowBandGapPx = Math.max(10, Math.round(H * 0.02));
    // A horizontal band is classified as a separator when its x-span
    // covers ≥ 25% of page width (configurable via opts)
    var separatorSpanThreshold = (typeof o.separatorSpanThreshold === 'number') ? o.separatorSpanThreshold : 0.25;

    var rawLines = detectEdgesAndLines(grayMat, o);
    var rawContainers = detectContainers(grayMat, o);

    // --- Regions (rectangular containers), normalized ---
    var regions = [];
    for(var ci = 0; ci < rawContainers.length; ci++){
      var c = rawContainers[ci];
      var cArea = c.area || (c.w * c.h);
      regions.push({
        id: 'r' + ci,
        xPx: c.x, yPx: c.y, wPx: c.w, hPx: c.h, areaPx: cArea,
        xN: c.x / W, yN: c.y / H, wN: c.w / W, hN: c.h / H,
        areaN: cArea / (W * H)
      });
    }

    // --- Row bands: cluster nearby horizontal lines by yMid ---
    var hLines = rawLines.horizontal.slice().sort(function(a, b){ return a.yMid - b.yMid; });
    var bandGroups = [];
    for(var li = 0; li < hLines.length; li++){
      var hl = hLines[li];
      var last = bandGroups.length ? bandGroups[bandGroups.length - 1] : null;
      if(last && (hl.yMid - last.yMax) <= rowBandGapPx){
        last.lines.push(hl);
        last.yMax = hl.yMid;
      } else {
        bandGroups.push({ lines: [hl], yMax: hl.yMid });
      }
    }

    var rowBands = [];
    for(var bi = 0; bi < bandGroups.length; bi++){
      var grp = bandGroups[bi];
      var ySum = 0;
      var y1Px = Infinity, y2Px = -Infinity;
      var x1Px = Infinity, x2Px = -Infinity;
      for(var k = 0; k < grp.lines.length; k++){
        var gl = grp.lines[k];
        ySum += gl.yMid;
        if(gl.yMid < y1Px) y1Px = gl.yMid;
        if(gl.yMid > y2Px) y2Px = gl.yMid;
        if(gl.x1 < x1Px) x1Px = gl.x1;
        if(gl.x2 > x2Px) x2Px = gl.x2;
      }
      var yPx = ySum / grp.lines.length;
      var spanN = Math.max(0, x2Px - x1Px) / W;
      rowBands.push({
        id: 'rb' + bi,
        yPx: yPx, y1Px: y1Px, y2Px: y2Px,
        yN: yPx / H, y1N: y1Px / H, y2N: y2Px / H,
        x1Px: x1Px, x2Px: x2Px,
        x1N: x1Px / W, x2N: x2Px / W,
        spanN: spanN,
        lineCount: grp.lines.length,
        isSeparator: spanN >= separatorSpanThreshold
      });
    }

    // --- Unified structural object list (for Phase 2+ constellation use) ---
    var soId = 0;
    var structuralObjects = [];
    for(var ri2 = 0; ri2 < regions.length; ri2++){
      var r = regions[ri2];
      structuralObjects.push({
        id: 'so' + (soId++),
        type: 'region',
        ref: r.id,
        geom: {
          xN: r.xN, yN: r.yN, wN: r.wN, hN: r.hN,
          cxN: r.xN + r.wN / 2, cyN: r.yN + r.hN / 2
        }
      });
    }
    for(var rbi2 = 0; rbi2 < rowBands.length; rbi2++){
      var rb = rowBands[rbi2];
      structuralObjects.push({
        id: 'so' + (soId++),
        type: rb.isSeparator ? 'separator' : 'row_band',
        ref: rb.id,
        geom: {
          xN: rb.x1N, yN: rb.y1N,
          wN: Math.max(0, rb.x2N - rb.x1N), hN: Math.max(0, rb.y2N - rb.y1N),
          cxN: (rb.x1N + rb.x2N) / 2, cyN: rb.yN
        }
      });
    }

    return {
      schema: 'wfg4/page-structure/v1',
      surfaceSize: { width: W, height: H },
      regions: regions,
      rowBands: rowBands,
      structuralObjects: structuralObjects
    };
  }

  // ---------------------------------------------------------------------------
  // computeFieldStructuralIdentity — Phase 3 field-level structural identity
  //
  // Given the field bbox (normalized), the Phase 1 PageStructure, and the
  // Phase 2 Constellation, computes:
  //   • bbox relative to the constellation frame (cx, cy, w, h as ratios)
  //   • bbox relative to the containing row band (if one can be identified)
  //   • distances to nearby structural objects (normalized)
  //   • overlap relationships with row bands and slot-like areas
  //   • a field-level mini-constellation: containing row, nearest separator,
  //     adjacent rows above/below, relevant slot/value band (if detectable)
  //   • object↔bbox relationships for each mini-constellation member
  //
  // Input:
  //   fieldBboxNorm  — { x0, y0, x1, y1 } 0..1 page-normalized
  //   pageStructure  — Phase 1 PageStructure
  //   constellation  — Phase 2 Constellation (may be null)
  //   opts           — optional overrides
  //
  // Returns: structuralIdentity object, or null on bad input.
  // ---------------------------------------------------------------------------
  function computeFieldStructuralIdentity(fieldBboxNorm, pageStructure, constellation, opts){
    if(!fieldBboxNorm || !pageStructure) return null;
    var o = opts || {};

    // Field geometry
    var fxN  = Number(fieldBboxNorm.x0 || 0);
    var fyN  = Number(fieldBboxNorm.y0 || 0);
    var fx1N = Number(fieldBboxNorm.x1 || 0);
    var fy1N = Number(fieldBboxNorm.y1 || 0);
    var fwN  = Math.max(0, fx1N - fxN);
    var fhN  = Math.max(0, fy1N - fyN);
    var fcxN = fxN + fwN / 2;
    var fcyN = fyN + fhN / 2;

    var rowBands = Array.isArray(pageStructure.rowBands)          ? pageStructure.rowBands          : [];
    var objects  = Array.isArray(pageStructure.structuralObjects) ? pageStructure.structuralObjects : [];

    // ---- (A) bbox relative to constellation frame ----
    // The constellation frame is defined by its owningRegion when available,
    // otherwise by the bounding box of all member geometries.
    var bboxRelConstellation = null;
    if(constellation){
      var frameXN, frameYN, frameWN, frameHN;
      if(constellation.regionGeomNorm){
        var rg = constellation.regionGeomNorm;
        frameXN = rg.xN; frameYN = rg.yN; frameWN = rg.wN; frameHN = rg.hN;
      } else if(Array.isArray(constellation.members) && constellation.members.length){
        // Derive frame from bounding box of member centers
        var minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity;
        for(var mi = 0; mi < constellation.members.length; mi++){
          var mg = constellation.members[mi].geom;
          if(!mg) continue;
          if(mg.cxN < minCx) minCx = mg.cxN;
          if(mg.cxN > maxCx) maxCx = mg.cxN;
          if(mg.cyN < minCy) minCy = mg.cyN;
          if(mg.cyN > maxCy) maxCy = mg.cyN;
        }
        if(minCx < Infinity){
          // Add a small margin around the member centers
          var margin = 0.02;
          frameXN = Math.max(0, minCx - margin);
          frameYN = Math.max(0, minCy - margin);
          frameWN = Math.min(1, maxCx + margin) - frameXN;
          frameHN = Math.min(1, maxCy + margin) - frameYN;
        }
      }
      if(typeof frameWN === 'number' && frameWN > 0 && typeof frameHN === 'number' && frameHN > 0){
        bboxRelConstellation = {
          // center position as ratio of constellation frame
          cxRatio: frameWN > 0 ? (fcxN - frameXN) / frameWN : 0.5,
          cyRatio: frameHN > 0 ? (fcyN - frameYN) / frameHN : 0.5,
          // size as ratio of constellation frame
          wRatio:  frameWN > 0 ? fwN / frameWN : fwN,
          hRatio:  frameHN > 0 ? fhN / frameHN : fhN,
          // top-left also useful for reconstruction
          x0Ratio: frameWN > 0 ? (fxN - frameXN) / frameWN : 0,
          y0Ratio: frameHN > 0 ? (fyN - frameYN) / frameHN : 0,
          frameGeom: { xN: frameXN, yN: frameYN, wN: frameWN, hN: frameHN }
        };
      }
    }

    // ---- (B) Containing row band ----
    // The row band whose mean-y is closest to the field center y, and whose
    // y range overlaps the field vertically.
    var containingBand = null;
    var bestBandDist = Infinity;
    for(var rbi = 0; rbi < rowBands.length; rbi++){
      var rb = rowBands[rbi];
      // Row band overlaps field vertically if its y range intersects [fyN, fy1N]
      var bandTop = Math.min(rb.y1N, rb.y2N);
      var bandBot = Math.max(rb.y1N, rb.y2N);
      var overlaps = bandBot >= fyN && bandTop <= fy1N;
      var nearField = Math.abs(rb.yN - fcyN) < (fhN * 2 + 0.05);
      if(!overlaps && !nearField) continue;
      var distToBand = Math.abs(rb.yN - fcyN);
      if(distToBand < bestBandDist){
        bestBandDist = distToBand;
        containingBand = rb;
      }
    }

    // ---- bbox relative to containing row band ----
    var bboxRelRow = null;
    if(containingBand){
      // Row bands have a well-defined y (mean) but limited height.
      // Express field position relative to row band's x-span.
      var rbW = Math.max(1e-6, containingBand.x2N - containingBand.x1N);
      bboxRelRow = {
        bandId:     containingBand.id,
        xInBandRatio: rbW > 0 ? (fcxN - containingBand.x1N) / rbW : 0.5,
        wInBandRatio: rbW > 0 ? fwN / rbW : fwN,
        distFromBandYN: fcyN - containingBand.yN  // signed: positive → field below band
      };
    }

    // ---- (C) Distances to nearby structural objects (normalized) ----
    var nearbyDistThresh = typeof o.nearbyDistThresh === 'number' ? o.nearbyDistThresh : 0.25;
    var nearbyObjects = [];
    for(var oi = 0; oi < objects.length; oi++){
      var obj = objects[oi];
      var g = obj.geom;
      if(!g) continue;
      var dx = g.cxN - fcxN;
      var dy = g.cyN - fcyN;
      var distN = Math.sqrt(dx * dx + dy * dy);
      if(distN < 0.005 || distN > nearbyDistThresh) continue;
      nearbyObjects.push({
        objId: obj.id,
        type:  obj.type,
        distN: distN,
        dxN:   dx,
        dyN:   dy
      });
    }
    // Keep up to 8, sorted by distance
    nearbyObjects.sort(function(a, b){ return a.distN - b.distN; });
    if(nearbyObjects.length > 8) nearbyObjects = nearbyObjects.slice(0, 8);

    // ---- (D) Overlap with row bands / slot-like areas ----
    var rowOverlaps = [];
    for(var rbi2 = 0; rbi2 < rowBands.length; rbi2++){
      var rb2 = rowBands[rbi2];
      // Vertical overlap: field y range vs band y range (use ±halfLineWidth=0.005)
      var bandHalfH = Math.max(0.005, (rb2.y2N - rb2.y1N) / 2);
      var bandMidY  = rb2.yN;
      var overlapTop    = Math.max(fyN,  bandMidY - bandHalfH);
      var overlapBottom = Math.min(fy1N, bandMidY + bandHalfH);
      if(overlapBottom <= overlapTop) continue;
      // Horizontal overlap: field x range vs band x span
      var hOverlapLeft  = Math.max(fxN,  rb2.x1N);
      var hOverlapRight = Math.min(fx1N, rb2.x2N);
      if(hOverlapRight <= hOverlapLeft) continue;
      var vOverlapRatio = fhN > 0 ? (overlapBottom - overlapTop) / fhN : 0;
      var hOverlapRatio = fwN > 0 ? (hOverlapRight - hOverlapLeft) / fwN : 0;
      rowOverlaps.push({
        bandId:        rb2.id,
        isSeparator:   rb2.isSeparator,
        vOverlapRatio: vOverlapRatio,
        hOverlapRatio: hOverlapRatio
      });
    }

    // ---- (E) Field-level mini-constellation ----
    // Members: containing row, nearest separator above, nearest separator below,
    // adjacent row above, adjacent row below, and nearest slot/value band
    // (a row band that partially overlaps the field horizontally but is not
    // the containing band — this approximates a value column boundary).

    var miniMembers = [];
    var miniRelations = [];

    function addMiniObj(label, rbOrObj, geom){
      if(!rbOrObj) return;
      miniMembers.push({ label: label, id: rbOrObj.id, geom: geom });
    }

    // Field pseudo-object for relation computation
    var fieldGeom = { xN: fxN, yN: fyN, wN: fwN, hN: fhN, cxN: fcxN, cyN: fcyN };

    // Containing row
    if(containingBand){
      var cbGeom = {
        xN: containingBand.x1N, yN: containingBand.yN,
        wN: containingBand.x2N - containingBand.x1N, hN: 0,
        cxN: (containingBand.x1N + containingBand.x2N) / 2,
        cyN: containingBand.yN
      };
      addMiniObj('containing_row', containingBand, cbGeom);
    }

    // Adjacent rows: closest row band above and below the field
    var closestAbove = null, closestBelow = null;
    var distAbove = Infinity, distBelow = Infinity;
    for(var rbi3 = 0; rbi3 < rowBands.length; rbi3++){
      var rb3 = rowBands[rbi3];
      if(containingBand && rb3.id === containingBand.id) continue;
      if(rb3.yN < fyN){
        var d = fyN - rb3.yN;
        if(d < distAbove){ distAbove = d; closestAbove = rb3; }
      } else if(rb3.yN > fy1N){
        var d2 = rb3.yN - fy1N;
        if(d2 < distBelow){ distBelow = d2; closestBelow = rb3; }
      }
    }
    if(closestAbove){
      var abGeom = {
        xN: closestAbove.x1N, yN: closestAbove.yN,
        wN: closestAbove.x2N - closestAbove.x1N, hN: 0,
        cxN: (closestAbove.x1N + closestAbove.x2N) / 2, cyN: closestAbove.yN
      };
      addMiniObj('adjacent_row_above', closestAbove, abGeom);
    }
    if(closestBelow){
      var blGeom = {
        xN: closestBelow.x1N, yN: closestBelow.yN,
        wN: closestBelow.x2N - closestBelow.x1N, hN: 0,
        cxN: (closestBelow.x1N + closestBelow.x2N) / 2, cyN: closestBelow.yN
      };
      addMiniObj('adjacent_row_below', closestBelow, blGeom);
    }

    // Nearest separator above and below
    var nearSepAbove = null, nearSepBelow = null;
    var dSepAbove = Infinity, dSepBelow = Infinity;
    for(var rbi4 = 0; rbi4 < rowBands.length; rbi4++){
      var rb4 = rowBands[rbi4];
      if(!rb4.isSeparator) continue;
      if(rb4.yN <= fcyN){
        var ds = fcyN - rb4.yN;
        if(ds < dSepAbove){ dSepAbove = ds; nearSepAbove = rb4; }
      } else {
        var ds2 = rb4.yN - fcyN;
        if(ds2 < dSepBelow){ dSepBelow = ds2; nearSepBelow = rb4; }
      }
    }
    if(nearSepAbove){
      var saGeom = {
        xN: nearSepAbove.x1N, yN: nearSepAbove.yN,
        wN: nearSepAbove.x2N - nearSepAbove.x1N, hN: 0,
        cxN: (nearSepAbove.x1N + nearSepAbove.x2N) / 2, cyN: nearSepAbove.yN
      };
      addMiniObj('separator_above', nearSepAbove, saGeom);
    }
    if(nearSepBelow){
      var sbGeom = {
        xN: nearSepBelow.x1N, yN: nearSepBelow.yN,
        wN: nearSepBelow.x2N - nearSepBelow.x1N, hN: 0,
        cxN: (nearSepBelow.x1N + nearSepBelow.x2N) / 2, cyN: nearSepBelow.yN
      };
      addMiniObj('separator_below', nearSepBelow, sbGeom);
    }

    // Slot/value band: a row band that overlaps the field's y range AND whose
    // x-span does NOT fully cover the field's x range — suggesting a column
    // boundary / slot divider near the field.
    var slotBand = null;
    var bestSlotScore = -1;
    for(var rbi5 = 0; rbi5 < rowBands.length; rbi5++){
      var rb5 = rowBands[rbi5];
      if(containingBand && rb5.id === containingBand.id) continue;
      // Must overlap field y range
      if(rb5.yN < fyN - fhN || rb5.yN > fy1N + fhN) continue;
      // Partial x overlap with field
      var hOvL = Math.max(fxN, rb5.x1N), hOvR = Math.min(fx1N, rb5.x2N);
      if(hOvR <= hOvL) continue;
      // x span should NOT fully contain the field (otherwise it's just another row)
      var isSlotCandidate = rb5.spanN < 0.5 || (rb5.x1N > fxN - 0.02 && rb5.x2N < fx1N + 0.02);
      if(!isSlotCandidate) continue;
      var slotScore = (hOvR - hOvL) / Math.max(1e-6, fwN);
      if(slotScore > bestSlotScore){ bestSlotScore = slotScore; slotBand = rb5; }
    }
    if(slotBand){
      var svGeom = {
        xN: slotBand.x1N, yN: slotBand.yN,
        wN: slotBand.x2N - slotBand.x1N, hN: 0,
        cxN: (slotBand.x1N + slotBand.x2N) / 2, cyN: slotBand.yN
      };
      addMiniObj('slot_value_band', slotBand, svGeom);
    }

    // Object↔bbox relations for each mini member (field bbox as the reference)
    for(var mmi = 0; mmi < miniMembers.length; mmi++){
      var mm = miniMembers[mmi];
      var mg = mm.geom;
      if(!mg) continue;
      var mdx = mg.cxN - fcxN;
      var mdy = mg.cyN - fcyN;
      var mdistN = Math.sqrt(mdx * mdx + mdy * mdy);
      miniRelations.push({
        label:     mm.label,
        memberId:  mm.id,
        distN:     mdistN,
        dxN:       mdx,
        dyN:       mdy,
        // Signed offsets from field edges to member center
        distFromTopN:    mg.cyN - fyN,
        distFromBottomN: mg.cyN - fy1N,
        distFromLeftN:   mg.cxN - fxN,
        distFromRightN:  mg.cxN - fx1N
      });
    }

    return {
      schema: 'wfg4/field-structural-identity/v1',

      // (A) Bbox relative to constellation frame
      bboxRelConstellation: bboxRelConstellation,

      // (B) Bbox relative to containing row band
      containingBandId: containingBand ? containingBand.id : null,
      bboxRelRow:       bboxRelRow,

      // (C) Normalized distances to nearby structural objects
      nearbyObjects: nearbyObjects,

      // (D) Row band overlap map
      rowOverlaps: rowOverlaps,

      // (E) Field-level mini-constellation
      miniConstellation: {
        members:   miniMembers,
        relations: miniRelations
      }
    };
  }

  // ---------------------------------------------------------------------------
  // selectConstellationCandidates — Phase 4 runtime candidate selection
  //
  // Given the config-time constellation (Phase 2) and the runtime PageStructure
  // (Phase 1, already on pageEntry.pageStructure), identifies up to maxK runtime
  // structural objects that could serve as anchors for the constellation.
  //
  // Scoring is coarse and position-led:
  //   • position score — how close the runtime object's center is to the
  //     config constellation's coarsePagePosition (linear decay to 0 at 0.30)
  //   • type bonus    — +0.25 if the object matches the dominant config member type
  //
  // Deduplication: candidates whose centers are within 0.08 page-diagonal are
  // merged (best score wins).
  //
  // A position-prior candidate (zero translation, score=0.15, viable=false)
  // is appended if no structural anchor is found near the config center.
  // This lets the runtime fall back to "assume same layout" without treating it
  // as a real structural match.
  //
  // Each candidate carries:
  //   rank, score, viable (score >= viableScoreThresh && anchorObjId != null),
  //   anchorObjId, anchorType, centerN, estimatedTranslationN
  //
  // Returns: Array<candidate> sorted by score desc (empty array on bad input).
  // ---------------------------------------------------------------------------
  function selectConstellationCandidates(configConstellation, runtimePageStructure, opts){
    if(!configConstellation || !runtimePageStructure) return [];
    var o = opts || {};
    var maxK            = typeof o.maxCandidates       === 'number' ? o.maxCandidates       : 5;
    var viableThresh    = typeof o.viableScoreThresh   === 'number' ? o.viableScoreThresh   : 0.20;
    var dedupRadiusN    = typeof o.dedupRadiusN        === 'number' ? o.dedupRadiusN        : 0.08;
    var posDecayAt      = typeof o.posDecayAt          === 'number' ? o.posDecayAt          : 0.30;

    var configCenter  = configConstellation.coarsePagePosition || { xN: 0.5, yN: 0.5 };
    var configMembers = Array.isArray(configConstellation.members) ? configConstellation.members : [];

    // Dominant member type in the config constellation
    var cfgTypeCounts = { separator: 0, row_band: 0, region: 0 };
    for(var mi = 0; mi < configMembers.length; mi++){
      var t = configMembers[mi].type;
      cfgTypeCounts[t] = (cfgTypeCounts[t] || 0) + 1;
    }
    var domType = 'row_band';
    var domCount = 0;
    var tkeys = ['separator', 'row_band', 'region'];
    for(var ti = 0; ti < tkeys.length; ti++){
      if((cfgTypeCounts[tkeys[ti]] || 0) > domCount){
        domCount = cfgTypeCounts[tkeys[ti]];
        domType  = tkeys[ti];
      }
    }

    var rtObjects = Array.isArray(runtimePageStructure.structuralObjects) ? runtimePageStructure.structuralObjects : [];

    // Score every runtime structural object
    var scored = [];
    for(var oi = 0; oi < rtObjects.length; oi++){
      var obj = rtObjects[oi];
      var g = obj.geom;
      if(!g) continue;
      var dx = g.cxN - configCenter.xN;
      var dy = g.cyN - configCenter.yN;
      var distN = Math.sqrt(dx * dx + dy * dy);
      var posScore = Math.max(0, 1.0 - distN / Math.max(0.01, posDecayAt));
      if(posScore < 0.05) continue; // too far to be relevant
      var typeBonus = (obj.type === domType) ? 0.25 : 0;
      scored.push({
        score:                posScore + typeBonus,
        anchorObjId:          obj.id,
        anchorType:           obj.type,
        centerN:              { xN: g.cxN, yN: g.cyN },
        estimatedTranslationN:{ dxN: g.cxN - configCenter.xN, dyN: g.cyN - configCenter.yN }
      });
    }
    scored.sort(function(a, b){ return b.score - a.score; });

    // Deduplicate: if two candidates are within dedupRadiusN, keep the best
    var results = [];
    for(var si = 0; si < scored.length && results.length < maxK; si++){
      var cand = scored[si];
      var isDup = false;
      for(var ri = 0; ri < results.length; ri++){
        var ex = results[ri];
        var cdx = cand.centerN.xN - ex.centerN.xN;
        var cdy = cand.centerN.yN - ex.centerN.yN;
        if(Math.sqrt(cdx * cdx + cdy * cdy) < dedupRadiusN){ isDup = true; break; }
      }
      if(!isDup){
        results.push({
          rank:                 results.length,
          score:                cand.score,
          viable:               cand.score >= viableThresh,
          anchorObjId:          cand.anchorObjId,
          anchorType:           cand.anchorType,
          centerN:              cand.centerN,
          estimatedTranslationN:cand.estimatedTranslationN
        });
      }
    }

    // Append a position-prior candidate if no structural anchor is near the config center
    var priorCovered = results.some(function(r){
      var pdx = r.centerN.xN - configCenter.xN;
      var pdy = r.centerN.yN - configCenter.yN;
      return Math.sqrt(pdx * pdx + pdy * pdy) < 0.05 && r.anchorObjId !== null;
    });
    if(!priorCovered && results.length < maxK){
      results.push({
        rank:                 results.length,
        score:                0.15,
        viable:               false,             // explicitly not a real structural match
        anchorObjId:          null,
        anchorType:           'position_prior',
        centerN:              { xN: configCenter.xN, yN: configCenter.yN },
        estimatedTranslationN:{ dxN: 0, dyN: 0 }
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // buildConstellation — Phase 2 constellation construction (config time)
  //
  // Given a normalized field bbox and a PageStructure (Phase 1), selects a
  // small (3–6 object), spatially-distributed set of structural objects that
  // collectively constrain the field's geometry.  Uses 8-sector coverage
  // selection so that the chosen members are distributed around the field
  // rather than clustered on one side.
  //
  // Input:
  //   fieldBboxNorm — { x0, y0, x1, y1 } in 0..1 page-normalized coords
  //   pageStructure — PageStructure produced by buildPageStructure()
  //   opts          — optional overrides (minMembers, maxMembers, minDistN,
  //                   nearbyThresholdN, separatorWeight, rowBandWeight,
  //                   regionWeight)
  //
  // Returns: constellation object, or null on bad input.
  // ---------------------------------------------------------------------------
  function buildConstellation(fieldBboxNorm, pageStructure, opts){
    if(!fieldBboxNorm || !pageStructure) return null;
    var o = opts || {};

    // Field geometry in normalized coords
    var fxN  = Number(fieldBboxNorm.x0 || 0);
    var fyN  = Number(fieldBboxNorm.y0 || 0);
    var fx1N = Number(fieldBboxNorm.x1 || 0);
    var fy1N = Number(fieldBboxNorm.y1 || 0);
    var fwN  = Math.max(0, fx1N - fxN);
    var fhN  = Math.max(0, fy1N - fyN);
    var fcxN = fxN + fwN / 2;
    var fcyN = fyN + fhN / 2;

    var minMembers       = typeof o.minMembers === 'number'       ? o.minMembers       : 3;
    var maxMembers       = typeof o.maxMembers === 'number'       ? o.maxMembers       : 6;
    var minDistN         = typeof o.minDistN === 'number'         ? o.minDistN         : 0.01;
    var nearbyThreshN    = typeof o.nearbyThresholdN === 'number' ? o.nearbyThresholdN : 0.15;
    var wSeparator       = typeof o.separatorWeight === 'number'  ? o.separatorWeight  : 3;
    var wRowBand         = typeof o.rowBandWeight === 'number'    ? o.rowBandWeight    : 2;
    var wRegion          = typeof o.regionWeight === 'number'     ? o.regionWeight     : 1;

    var objects  = Array.isArray(pageStructure.structuralObjects) ? pageStructure.structuralObjects : [];
    var regions  = Array.isArray(pageStructure.regions)           ? pageStructure.regions           : [];
    var rowBands = Array.isArray(pageStructure.rowBands)          ? pageStructure.rowBands          : [];

    // ----- Owning region: smallest region that encloses ≥70% of field bbox -----
    var owningRegion = null;
    var bestOwnerArea = Infinity;
    for(var ri = 0; ri < regions.length; ri++){
      var reg = regions[ri];
      var ox0 = Math.max(fxN, reg.xN),  oy0 = Math.max(fyN, reg.yN);
      var ox1 = Math.min(fx1N, reg.xN + reg.wN), oy1 = Math.min(fy1N, reg.yN + reg.hN);
      if(ox1 <= ox0 || oy1 <= oy0) continue;
      var overlapN = (ox1 - ox0) * (oy1 - oy0);
      var fieldArea = Math.max(1e-10, fwN * fhN);
      if(overlapN / fieldArea >= 0.7 && reg.areaN < bestOwnerArea){
        bestOwnerArea = reg.areaN;
        owningRegion = reg;
      }
    }
    var owningRegionGeom = owningRegion
      ? { xN: owningRegion.xN, yN: owningRegion.yN, wN: owningRegion.wN, hN: owningRegion.hN }
      : null;

    // ----- 8-sector helper -----
    // In a y-down coordinate system (screen/page coords):
    //   N = upward on page (dy < 0), S = downward, E = right, W = left
    var SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    function getSector(dx, dy){
      var deg = Math.atan2(dy, dx) * 180 / Math.PI; // [-180, 180]
      if(deg > -22.5  && deg <=  22.5)  return 'E';
      if(deg >  22.5  && deg <=  67.5)  return 'SE';
      if(deg >  67.5  && deg <= 112.5)  return 'S';
      if(deg > 112.5  && deg <= 157.5)  return 'SW';
      if(deg >  157.5 || deg <= -157.5) return 'W';
      if(deg > -157.5 && deg <= -112.5) return 'NW';
      if(deg > -112.5 && deg <=  -67.5) return 'N';
      return 'NE'; // -67.5 < deg <= -22.5
    }

    // Distance score: prefer objects 0.05..0.30 page-diagonals away
    function distanceScore(distN){
      if(distN < 0.03) return 0.15;
      if(distN < 0.05) return 0.55;
      if(distN <= 0.30) return 1.00;
      if(distN <= 0.50) return 0.65;
      return 0.25;
    }

    // ----- Score every structural object; keep best per sector -----
    var typeWeights = { separator: wSeparator, row_band: wRowBand, region: wRegion };
    var sectorBest  = {}; // sector -> { obj, score, distN, sector }

    for(var oi = 0; oi < objects.length; oi++){
      var obj = objects[oi];
      var g = obj.geom;
      if(!g) continue;
      var dx = g.cxN - fcxN;
      var dy = g.cyN - fcyN;
      var distN = Math.sqrt(dx * dx + dy * dy);
      if(distN < minDistN) continue;

      var sector = getSector(dx, dy);
      var score  = (typeWeights[obj.type] || 1) * distanceScore(distN);

      if(!sectorBest[sector] || score > sectorBest[sector].score){
        sectorBest[sector] = { obj: obj, score: score, distN: distN, sector: sector };
      }
    }

    // Collect sector winners, sort best-first, cap at maxMembers
    var candidates = [];
    for(var si = 0; si < SECTORS.length; si++){
      var sc = SECTORS[si];
      if(sectorBest[sc]) candidates.push(sectorBest[sc]);
    }
    candidates.sort(function(a, b){ return b.score - a.score; });
    var selected = candidates.slice(0, maxMembers);
    // Warn callers (via member count) if fewer than minMembers could be found —
    // but don't error; caller must tolerate partial constellations.

    // ----- Build members array -----
    var members = [];
    for(var mi = 0; mi < selected.length; mi++){
      var cand = selected[mi];
      members.push({
        objId:  cand.obj.id,
        type:   cand.obj.type,
        ref:    cand.obj.ref,
        geom:   cand.obj.geom,
        sector: cand.sector,
        distN:  cand.distN
      });
    }

    // ----- Object↔object relations between every pair of members -----
    // Thresholds for alignment classification (fraction of page dimensions)
    var yAlignThreshN = 0.02; // centers within 2% page-height → horizontally aligned
    var xAlignThreshN = 0.02; // centers within 2% page-width  → vertically aligned

    var relations = [];
    for(var ai = 0; ai < members.length; ai++){
      for(var bi = ai + 1; bi < members.length; bi++){
        var ma = members[ai], mb = members[bi];
        var ga = ma.geom,    gb = mb.geom;
        var rdx = gb.cxN - ga.cxN;   // positive → b is right of a
        var rdy = gb.cyN - ga.cyN;   // positive → b is below a (y-down)
        var rdistN = Math.sqrt(rdx * rdx + rdy * rdy);

        // Primary spatial order of b relative to a
        var hOrder = Math.abs(rdx) < xAlignThreshN ? 'same_h'   : (rdx > 0 ? 'right_of' : 'left_of');
        var vOrder = Math.abs(rdy) < yAlignThreshN ? 'same_v'   : (rdy > 0 ? 'below'    : 'above');

        // Dominant axis
        var alignment;
        if(Math.abs(rdy) < yAlignThreshN)      alignment = 'horizontal';
        else if(Math.abs(rdx) < xAlignThreshN) alignment = 'vertical';
        else                                    alignment = 'diagonal';

        // Containment: does a's box contain b's center, or vice versa?
        var bCxInA = gb.cxN >= ga.xN && gb.cxN <= ga.xN + ga.wN;
        var bCyInA = gb.cyN >= ga.yN && gb.cyN <= ga.yN + ga.hN;
        var aCxInB = ga.cxN >= gb.xN && ga.cxN <= gb.xN + gb.wN;
        var aCyInB = ga.cyN >= gb.yN && ga.cyN <= gb.yN + gb.hN;
        var containment = 'none';
        if(bCxInA && bCyInA)      containment = 'from_contains_to';
        else if(aCxInB && aCyInB) containment = 'to_contains_from';

        relations.push({
          fromId:      ma.objId,
          toId:        mb.objId,
          distN:       rdistN,
          alignment:   alignment,
          hOrder:      hOrder,
          vOrder:      vOrder,
          containment: containment
        });
      }
    }

    // ----- Nearby row bands and separators -----
    // Include row bands whose mean y is within nearbyThreshN of the field,
    // or whose y range overlaps the field's y range.
    var nearbyRowBands   = [];
    var nearbySeparators = [];
    for(var rbi = 0; rbi < rowBands.length; rbi++){
      var rb = rowBands[rbi];
      // Distance from band mean-y to nearest field edge (0 if overlapping)
      var distToField = 0;
      if(rb.yN < fyN)       distToField = fyN - rb.yN;
      else if(rb.yN > fy1N) distToField = rb.yN - fy1N;
      if(distToField > nearbyThreshN) continue;
      var rbEntry = {
        id:        rb.id,
        yN:        rb.yN,
        x1N:       rb.x1N,
        x2N:       rb.x2N,
        spanN:     rb.spanN,
        lineCount: rb.lineCount,
        isSeparator: rb.isSeparator
      };
      if(rb.isSeparator) nearbySeparators.push(rbEntry);
      else               nearbyRowBands.push(rbEntry);
    }

    return {
      schema:            'wfg4/constellation/v1',
      id:                null,               // set by caller (e.g. fieldKey)
      owningRegion:      owningRegion
        ? { id: owningRegion.id, geom: owningRegionGeom }
        : null,
      regionGeomNorm:    owningRegionGeom,
      coarsePagePosition: { xN: fcxN, yN: fcyN },
      memberCount:       members.length,
      members:           members,
      relations:         relations,
      nearbyRowBands:    nearbyRowBands,
      nearbySeparators:  nearbySeparators
    };
  }

  function structuralRefineBox(projectedBox, structuralCtx, runtimeGray, opts){
    const cv = root.cv;
    const o = opts || {};
    if(!structuralCtx || !runtimeGray || !projectedBox) return { ok: false, box: projectedBox, adjustments: [] };

    const snapMax = o.structuralSnapMaxPx || 8;
    const searchDist = o.anchorMaxSearchDist || 80;
    const adjustments = [];
    const debug = {
      localRegion: null,
      lines: { horizontal: [], vertical: [] },
      containers: [],
      matchedContainer: null
    };
    let box = { x: projectedBox.x, y: projectedBox.y, w: projectedBox.w, h: projectedBox.h, page: projectedBox.page || 1 };

    // extract local region for structural analysis
    const pad = Math.max(searchDist, Math.round(Math.max(box.w, box.h) * 0.6));
    const bounds = { width: runtimeGray.cols, height: runtimeGray.rows };
    const Types = root.WFG4Types || {};
    const localBox = Types.expandBox ? Types.expandBox(box, pad, bounds) : box;

    const roi = runtimeGray.roi(new cv.Rect(
      clamp(Math.round(localBox.x), 0, runtimeGray.cols - 1),
      clamp(Math.round(localBox.y), 0, runtimeGray.rows - 1),
      clamp(Math.round(localBox.w), 1, runtimeGray.cols - Math.round(localBox.x)),
      clamp(Math.round(localBox.h), 1, runtimeGray.rows - Math.round(localBox.y))
    ));
    debug.localRegion = {
      x: clamp(Math.round(localBox.x), 0, runtimeGray.cols - 1),
      y: clamp(Math.round(localBox.y), 0, runtimeGray.rows - 1),
      w: clamp(Math.round(localBox.w), 1, runtimeGray.cols - Math.round(localBox.x)),
      h: clamp(Math.round(localBox.h), 1, runtimeGray.rows - Math.round(localBox.y))
    };

    const localLines = detectEdgesAndLines(roi, o);
    const localContainers = detectContainers(roi, o);

    // offset lines/containers to page coordinates
    const ox = Math.round(localBox.x);
    const oy = Math.round(localBox.y);
    for(const hl of localLines.horizontal){ hl.yMid += oy; hl.x1 += ox; hl.x2 += ox; hl.y1 += oy; hl.y2 += oy; }
    for(const vl of localLines.vertical){ vl.xMid += ox; vl.x1 += ox; vl.x2 += ox; vl.y1 += oy; vl.y2 += oy; }
    for(const c of localContainers){ c.x += ox; c.y += oy; }
    debug.lines.horizontal = localLines.horizontal.slice(0, 80);
    debug.lines.vertical = localLines.vertical.slice(0, 80);
    debug.containers = localContainers.slice(0, 80);

    roi.delete();

    // snap to container boundaries if config had a container
    if(structuralCtx.container && structuralCtx.anchors?.containerOffset){
      const cfgC = structuralCtx.container;
      const refSizeHint = { w: cfgC.w, h: cfgC.h, area: cfgC.w * cfgC.h };
      const rp = structuralCtx.anchors.relativePosition;
      const rtContainer = findEnclosingContainer(box, localContainers, o.containerOverlapThreshold || 0.7, refSizeHint);
      if(rtContainer && rp){
        debug.matchedContainer = { x: rtContainer.x, y: rtContainer.y, w: rtContainer.w, h: rtContainer.h };
        const newX = rtContainer.x + rp.xRatio * rtContainer.w;
        const newY = rtContainer.y + rp.yRatio * rtContainer.h;
        // Re-derive width/height from the runtime container so that when the
        // run document is scaled differently, the field box scales with the
        // container instead of staying at the config-time pixel size.
        const newW = Math.max(2, (rp.wRatio || (box.w / Math.max(1, cfgC.w))) * rtContainer.w);
        const newH = Math.max(2, (rp.hRatio || (box.h / Math.max(1, cfgC.h))) * rtContainer.h);
        const dx = newX - box.x;
        const dy = newY - box.y;
        if(Math.abs(dx) <= searchDist && Math.abs(dy) <= searchDist){
          box.x = newX;
          box.y = newY;
          box.w = newW;
          box.h = newH;
          adjustments.push('container_snap');
        }
      }
    }

    // snap edges to nearest lines using config-time anchor offsets
    const anchors = structuralCtx.anchors || {};
    if(anchors.distAbove !== null && anchors.distAbove !== undefined){
      for(const hl of localLines.horizontal){
        const candidateY = hl.yMid + anchors.distAbove;
        const shift = candidateY - box.y;
        if(Math.abs(shift) <= snapMax && hl.x1 <= box.x + box.w && hl.x2 >= box.x){
          box.y = candidateY;
          adjustments.push('snap_above');
          break;
        }
      }
    }
    if(anchors.distLeft !== null && anchors.distLeft !== undefined){
      for(const vl of localLines.vertical){
        const candidateX = vl.xMid + anchors.distLeft;
        const shift = candidateX - box.x;
        if(Math.abs(shift) <= snapMax && vl.y1 <= box.y + box.h && vl.y2 >= box.y){
          box.x = candidateX;
          adjustments.push('snap_left');
          break;
        }
      }
    }
    if(anchors.distBelow !== null && anchors.distBelow !== undefined){
      for(const hl of localLines.horizontal){
        const candidateBottom = hl.yMid - anchors.distBelow;
        const candidateH = candidateBottom - box.y;
        if(candidateH > 4 && Math.abs(candidateH - box.h) <= snapMax && hl.x1 <= box.x + box.w && hl.x2 >= box.x){
          box.h = candidateH;
          adjustments.push('snap_below');
          break;
        }
      }
    }
    if(anchors.distRight !== null && anchors.distRight !== undefined){
      for(const vl of localLines.vertical){
        const candidateRight = vl.xMid - anchors.distRight;
        const candidateW = candidateRight - box.x;
        if(candidateW > 4 && Math.abs(candidateW - box.w) <= snapMax && vl.y1 <= box.y + box.h && vl.y2 >= box.y){
          box.w = candidateW;
          adjustments.push('snap_right');
          break;
        }
      }
    }

    return {
      ok: adjustments.length > 0,
      box,
      adjustments,
      debug
    };
  }

  return {
    DEFAULT_OPENCV_JS_URL,
    hasCv,
    loadCvScript,
    ensureCvReady,
    dataUrlToCanvas,
    cropCanvas,
    orbDetect,
    serializeKeypoints,
    deserializeKeypoints,
    serializeDescriptors,
    deserializeDescriptors,
    matchFeatures,
    estimateTransform,
    projectPoints,
    localTemplateRefine,
    detectEdgesAndLines,
    detectContainers,
    findEnclosingContainer,
    computeAnchorOffsets,
    structuralRefineBox,
    buildPageStructure,
    buildConstellation,
    computeFieldStructuralIdentity,
    selectConstellationCandidates
  };
});
