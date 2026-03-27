/**
 * WFG3 Stages A–C  (Phase 2)
 *
 * Stage A: Normalization
 * Stage B: Boundary Evidence
 * Stage C: Boundary Tokens
 *
 * Depends on: wfg3-cv.js (window._WFG3_CV)
 * Exposes:    window._WFG3_Stages  (consumed by later phases and the public API)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  if (!CV) throw new Error('wfg3-stages-ac.js requires wfg3-cv.js to be loaded first.');

  /* ==================================================================
   *  Stage contracts (plain-object shapes – no classes, no prototypes)
   * ================================================================== */

  /**
   * NormalizedSurface
   * -----------------
   * {
   *   kind:   'wfg3-normalized-surface',
   *   width:  number,          // post-resize width
   *   height: number,          // post-resize height
   *   gray:   Uint8Array,      // denoised grayscale  (w*h)
   *   rgb:    { r, g, b: Uint8Array } | null,
   *   lab:    { L, a, b: Float32Array } | null,
   *   source: { width, height, scale },
   *   artifacts: {
   *     denoised: boolean,
   *     hasColor: boolean,
   *     hasLab:   boolean,
   *     denoiseMode: string
   *   }
   * }
   *
   * BoundaryEvidence
   * ----------------
   * {
   *   kind:         'wfg3-boundary-evidence',
   *   width:        number,
   *   height:       number,
   *   edgeBinary:   Uint8Array,     // 0 or 255
   *   edgeWeighted: Uint8Array,     // 0-255 combined strength
   *   gradX:        Float32Array,   // Sobel dx
   *   gradY:        Float32Array,   // Sobel dy
   *   gradMag:      Float32Array,   // sqrt(dx^2+dy^2)
   *   labDelta:     Float32Array,   // per-pixel max neighbor deltaE
   *   contourCount: number          // number of connected edge segments
   * }
   *
   * BoundaryToken
   * -------------
   * {
   *   id:         number,
   *   x:          number,            // pixel column
   *   y:          number,            // pixel row
   *   tangentX:   number,            // unit tangent along boundary
   *   tangentY:   number,
   *   normalX:    number,            // unit normal (gradient direction)
   *   normalY:    number,
   *   leftLab:    [L, a, b],         // LAB sample on normal side
   *   rightLab:   [L, a, b],         // LAB sample on anti-normal side
   *   deltaE:     number,            // Euclidean LAB distance across boundary
   *   confidence: number             // 0–1 (deltaE / scale, clamped)
   * }
   */

  /* ==================================================================
   *  Default configuration for Stages A–C
   *  (frozen object – later phases add their own config sections)
   * ================================================================== */

  var DEFAULT_CONFIG_AC = Object.freeze({
    // Stage A
    maxDim:          1400,
    denoiseMode:     'bilateral',   // 'bilateral' | 'gaussian'
    denoiseRadius:   2,             // bilateral radius or gaussian radius
    bilateralSigmaC: 35,
    bilateralSigmaS: 35,

    // Stage B
    cannyLow:            60,
    cannyHigh:           160,
    sobelKsize:          3,          // not used by pure-JS (always 3) but kept for OpenCV path
    labDeltaThreshold:   12.0,
    morphRadius:         1,
    edgeWeightCanny:     0.7,
    edgeWeightGradient:  0.3,

    // Stage C
    tokenStep:                2,     // sample every Nth edge pixel (in scan order)
    tokenSideSamplePx:        3,     // pixels offset along normal for side LAB sampling
    tokenConfidenceDeltaEMax: 40.0,  // deltaE at which confidence = 1.0
    tokenMinConfidence:       0.05   // discard tokens below this confidence
  });

  /* ==================================================================
   *  Stage A: Normalization
   * ================================================================== */

  /**
   * @param {Object} imageData  { gray, r?, g?, b?, rgba?, width, height }
   * @param {Object} opts       { maxSide?: number }
   * @param {Object} [cfg]      override config
   * @returns {Object|null}     NormalizedSurface
   */
  function stageA_normalize(imageData, opts, cfg) {
    cfg = cfg || DEFAULT_CONFIG_AC;
    if (!imageData || !imageData.width || !imageData.height) return null;

    var srcW = imageData.width;
    var srcH = imageData.height;
    var maxSide = (opts && opts.maxSide) || cfg.maxDim;
    var longest = Math.max(srcW, srcH);
    var scale = 1.0;
    var dstW = srcW, dstH = srcH;

    if (longest > maxSide) {
      scale = maxSide / longest;
      dstW = Math.round(srcW * scale);
      dstH = Math.round(srcH * scale);
    }

    // --- Obtain or synthesize channel arrays ---
    var gray = imageData.gray;
    var hasColor = !!(imageData.r && imageData.g && imageData.b);
    var rCh = imageData.r, gCh = imageData.g, bCh = imageData.b;

    // If we only have rgba, unpack it
    if (!hasColor && imageData.rgba) {
      var rgba = imageData.rgba;
      var n0 = srcW * srcH;
      rCh = new Uint8Array(n0);
      gCh = new Uint8Array(n0);
      bCh = new Uint8Array(n0);
      for (var ri = 0; ri < n0; ri++) {
        rCh[ri] = rgba[ri * 4];
        gCh[ri] = rgba[ri * 4 + 1];
        bCh[ri] = rgba[ri * 4 + 2];
      }
      hasColor = true;
    }

    // If no gray provided, compute from color
    if (!gray && hasColor) {
      gray = new Uint8Array(srcW * srcH);
      for (var gi = 0; gi < gray.length; gi++) {
        gray[gi] = Math.round(0.299 * rCh[gi] + 0.587 * gCh[gi] + 0.114 * bCh[gi]);
      }
    }

    if (!gray) return null;

    // --- Resize if needed ---
    if (scale < 1.0) {
      gray = CV.resizeGray(gray, srcW, srcH, dstW, dstH);
      if (hasColor) {
        var resized = CV.resizeRGB(rCh, gCh, bCh, srcW, srcH, dstW, dstH);
        rCh = resized.r; gCh = resized.g; bCh = resized.b;
      }
    }

    // --- Denoise grayscale ---
    var denoised;
    var denoiseMode = cfg.denoiseMode || 'bilateral';
    if (denoiseMode === 'gaussian') {
      denoised = CV.gaussianBlur(gray, dstW, dstH, cfg.denoiseRadius);
    } else {
      denoised = CV.bilateralFilter(gray, dstW, dstH, cfg.denoiseRadius, cfg.bilateralSigmaC, cfg.bilateralSigmaS);
    }

    // --- Contrast stretch ---
    denoised = CV.contrastStretch(denoised, dstW * dstH);

    // --- LAB conversion ---
    var lab = null;
    var rgb = null;
    if (hasColor) {
      rgb = { r: rCh, g: gCh, b: bCh };
      lab = CV.rgbToLAB(rCh, gCh, bCh, dstW * dstH);
    }

    return {
      kind: 'wfg3-normalized-surface',
      width: dstW,
      height: dstH,
      gray: denoised,
      rgb: rgb,
      lab: lab,
      source: { width: srcW, height: srcH, scale: scale },
      artifacts: {
        denoised: true,
        hasColor: hasColor,
        hasLab: !!lab,
        denoiseMode: denoiseMode
      }
    };
  }

  /* ==================================================================
   *  Stage B: Boundary Evidence
   * ================================================================== */

  /**
   * @param {Object} surface    NormalizedSurface
   * @param {Object} [cfg]      override config
   * @returns {Object}          BoundaryEvidence
   */
  function stageB_boundaryEvidence(surface, cfg) {
    cfg = cfg || DEFAULT_CONFIG_AC;
    var w = surface.width, h = surface.height, n = w * h;

    // 1. Canny edge detection on denoised grayscale
    var canny = CV.cannyEdge(surface.gray, w, h, cfg.cannyLow, cfg.cannyHigh);

    // 2. Sobel gradients
    var sobel = CV.sobelGradients(surface.gray, w, h);

    // 3. LAB neighbor delta (color-distance edges)
    var labDelta;
    var labEdge;
    if (surface.lab) {
      labDelta = CV.labNeighborDelta(surface.lab.L, surface.lab.a, surface.lab.b, w, h);
      labEdge = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        labEdge[i] = labDelta[i] >= cfg.labDeltaThreshold ? 255 : 0;
      }
    } else {
      labDelta = new Float32Array(n);
      labEdge = new Uint8Array(n);
    }

    // 4. Union of Canny + LAB edges
    var edgeUnion = new Uint8Array(n);
    for (var j = 0; j < n; j++) {
      edgeUnion[j] = (canny[j] || labEdge[j]) ? 255 : 0;
    }

    // 5. Morphological close to bridge small gaps
    var edgeBinary = CV.morphClose(edgeUnion, w, h, cfg.morphRadius);

    // 6. Weighted edge map: blend binary edges with gradient magnitude
    var maxMag = 0;
    for (var mi = 0; mi < n; mi++) if (sobel.mag[mi] > maxMag) maxMag = sobel.mag[mi];
    var magScale = maxMag > 0 ? 255.0 / maxMag : 0;

    var edgeWeighted = new Uint8Array(n);
    var wCanny = cfg.edgeWeightCanny;
    var wGrad = cfg.edgeWeightGradient;
    for (var k = 0; k < n; k++) {
      var eVal = edgeBinary[k] * wCanny;
      var gVal = CV.clamp(Math.round(sobel.mag[k] * magScale), 0, 255) * wGrad;
      edgeWeighted[k] = CV.clamp(Math.round(eVal + gVal), 0, 255);
    }

    // 7. Count connected edge segments (lightweight: count transitions in binary)
    //    A proper contour count will come in Phase 3; for now use connected components.
    var ccResult = CV.connectedComponents(edgeBinary, w, h);

    return {
      kind: 'wfg3-boundary-evidence',
      width: w,
      height: h,
      edgeBinary: edgeBinary,
      edgeWeighted: edgeWeighted,
      gradX: sobel.gx,
      gradY: sobel.gy,
      gradMag: sobel.mag,
      labDelta: labDelta,
      contourCount: ccResult.count
    };
  }

  /* ==================================================================
   *  Stage C: Boundary Tokens
   * ================================================================== */

  /**
   * @param {Object} surface    NormalizedSurface
   * @param {Object} evidence   BoundaryEvidence
   * @param {Object} [cfg]      override config
   * @returns {Array}           BoundaryToken[]
   */
  function stageC_boundaryTokens(surface, evidence, cfg) {
    cfg = cfg || DEFAULT_CONFIG_AC;
    var w = surface.width, h = surface.height;
    var edge = evidence.edgeBinary;
    var gx = evidence.gradX;
    var gy = evidence.gradY;
    var step = Math.max(1, cfg.tokenStep);
    var sampleD = cfg.tokenSideSamplePx;
    var deMax = cfg.tokenConfidenceDeltaEMax;
    var minConf = cfg.tokenMinConfidence;

    // Collect edge pixel positions in scan order
    var positions = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (edge[y * w + x] > 0) positions.push(x | (y << 16));
      }
    }

    var hasLab = !!surface.lab;
    var L = hasLab ? surface.lab.L : null;
    var la = hasLab ? surface.lab.a : null;
    var lb = hasLab ? surface.lab.b : null;
    // Fallback: use grayscale as pseudo-L if no color
    var grayArr = surface.gray;

    var tokens = [];
    var nextId = 0;

    for (var pi = 0; pi < positions.length; pi += step) {
      var packed = positions[pi];
      var px = packed & 0xFFFF;
      var py = packed >>> 16;
      var idx = py * w + px;

      // Local gradient → normal direction
      var rawGx = gx[idx];
      var rawGy = gy[idx];
      var gMag = Math.sqrt(rawGx * rawGx + rawGy * rawGy);

      var nx, ny;
      if (gMag < 0.001) {
        // Zero gradient at this pixel: try a small neighborhood average
        var accX = 0, accY = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var sy = py + dy, sx = px + dx;
            if (sy >= 0 && sy < h && sx >= 0 && sx < w) {
              accX += gx[sy * w + sx];
              accY += gy[sy * w + sx];
            }
          }
        }
        var aMag = Math.sqrt(accX * accX + accY * accY);
        if (aMag < 0.001) { nx = 1; ny = 0; } // degenerate: pick arbitrary
        else { nx = accX / aMag; ny = accY / aMag; }
      } else {
        nx = rawGx / gMag;
        ny = rawGy / gMag;
      }

      // Tangent = 90 degrees to normal
      var tx = -ny;
      var ty = nx;

      // Sample LAB (or gray) on each side of the boundary
      var lx = CV.clamp(Math.round(px + nx * sampleD), 0, w - 1);
      var ly = CV.clamp(Math.round(py + ny * sampleD), 0, h - 1);
      var rx = CV.clamp(Math.round(px - nx * sampleD), 0, w - 1);
      var ry = CV.clamp(Math.round(py - ny * sampleD), 0, h - 1);

      var leftLab, rightLab, deltaE;

      if (hasLab) {
        var li = ly * w + lx;
        var rri = ry * w + rx;
        leftLab = [L[li], la[li], lb[li]];
        rightLab = [L[rri], la[rri], lb[rri]];
        var dL = leftLab[0] - rightLab[0];
        var da = leftLab[1] - rightLab[1];
        var db = leftLab[2] - rightLab[2];
        deltaE = Math.sqrt(dL * dL + da * da + db * db);
      } else {
        var lVal = grayArr[ly * w + lx];
        var rVal = grayArr[ry * w + rx];
        leftLab = [lVal * (100 / 255), 0, 0];
        rightLab = [rVal * (100 / 255), 0, 0];
        deltaE = Math.abs(leftLab[0] - rightLab[0]);
      }

      var confidence = Math.min(1.0, deltaE / deMax);
      if (confidence < minConf) continue;

      tokens.push({
        id: nextId++,
        x: px,
        y: py,
        tangentX: tx,
        tangentY: ty,
        normalX: nx,
        normalY: ny,
        leftLab: leftLab,
        rightLab: rightLab,
        deltaE: deltaE,
        confidence: confidence
      });
    }

    return tokens;
  }

  /* ==================================================================
   *  Public API for Phase 2
   * ================================================================== */

  global._WFG3_Stages = global._WFG3_Stages || {};
  global._WFG3_Stages.DEFAULT_CONFIG_AC = DEFAULT_CONFIG_AC;
  global._WFG3_Stages.stageA = stageA_normalize;
  global._WFG3_Stages.stageB = stageB_boundaryEvidence;
  global._WFG3_Stages.stageC = stageC_boundaryTokens;

})(typeof window !== 'undefined' ? window : globalThis);
