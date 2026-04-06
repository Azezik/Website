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

  function structuralRefineBox(projectedBox, structuralCtx, runtimeGray, opts){
    const cv = root.cv;
    const o = opts || {};
    if(!structuralCtx || !runtimeGray || !projectedBox) return { ok: false, box: projectedBox, adjustments: [] };

    const snapMax = o.structuralSnapMaxPx || 8;
    const searchDist = o.anchorMaxSearchDist || 80;
    const adjustments = [];
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

    const localLines = detectEdgesAndLines(roi, o);
    const localContainers = detectContainers(roi, o);

    // offset lines/containers to page coordinates
    const ox = Math.round(localBox.x);
    const oy = Math.round(localBox.y);
    for(const hl of localLines.horizontal){ hl.yMid += oy; hl.x1 += ox; hl.x2 += ox; hl.y1 += oy; hl.y2 += oy; }
    for(const vl of localLines.vertical){ vl.xMid += ox; vl.x1 += ox; vl.x2 += ox; vl.y1 += oy; vl.y2 += oy; }
    for(const c of localContainers){ c.x += ox; c.y += oy; }

    roi.delete();

    // snap to container boundaries if config had a container
    if(structuralCtx.container && structuralCtx.anchors?.containerOffset){
      const cfgC = structuralCtx.container;
      const refSizeHint = { w: cfgC.w, h: cfgC.h, area: cfgC.w * cfgC.h };
      const rp = structuralCtx.anchors.relativePosition;
      const rtContainer = findEnclosingContainer(box, localContainers, o.containerOverlapThreshold || 0.7, refSizeHint);
      if(rtContainer && rp){
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
      adjustments
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
    structuralRefineBox
  };
});
