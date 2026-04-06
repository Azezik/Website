(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WFG4OpenCv = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const Types = root.WFG4Types || {};
  const clamp = Types.clamp || ((v,min,max)=>Math.max(min,Math.min(max,v)));

  function hasCv(){
    const cv = root.cv;
    return !!(cv && typeof cv.imread === 'function' && typeof cv.ORB === 'function');
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
    if(!runtimeGray || !refPatchGray || !projectedBox) return { ok:false, box:projectedBox, score:0 };
    const searchPad = Math.max(20, Math.round(Math.max(projectedBox.w, projectedBox.h) * 0.3));
    const x = clamp(Math.round(projectedBox.x - searchPad), 0, Math.max(0, runtimeGray.cols - 2));
    const y = clamp(Math.round(projectedBox.y - searchPad), 0, Math.max(0, runtimeGray.rows - 2));
    const w = clamp(Math.round(projectedBox.w + (searchPad * 2)), refPatchGray.cols + 1, runtimeGray.cols - x);
    const h = clamp(Math.round(projectedBox.h + (searchPad * 2)), refPatchGray.rows + 1, runtimeGray.rows - y);
    if(w <= refPatchGray.cols || h <= refPatchGray.rows) return { ok:false, box:projectedBox, score:0 };

    const roi = runtimeGray.roi(new cv.Rect(x, y, w, h));
    const resultCols = w - refPatchGray.cols + 1;
    const resultRows = h - refPatchGray.rows + 1;
    const result = new cv.Mat(resultRows, resultCols, cv.CV_32FC1);
    cv.matchTemplate(roi, refPatchGray, result, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(result);

    const bestBox = {
      x: x + mm.maxLoc.x,
      y: y + mm.maxLoc.y,
      w: refPatchGray.cols,
      h: refPatchGray.rows,
      page: projectedBox.page || 1
    };

    roi.delete();
    result.delete();

    return {
      ok: mm.maxVal >= (minScore || 0.42),
      box: bestBox,
      score: Number(mm.maxVal || 0)
    };
  }

  return {
    hasCv,
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
    localTemplateRefine
  };
});
