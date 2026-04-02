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
    tokenMinConfidence:       0.05,  // discard tokens below this confidence
    phase1RelaxedTokenRetention: false, // keep weak tokens for Stage D in relaxed mode
    phase1StrictConfidenceDrop:  true,  // if true, preserve legacy hard confidence drops
    phase1NmsRadiusScale:        1.0,   // scales NMS/suppression radius
    phase1SpacingScale:          1.0,   // scales scaffold min spacing
    phase1MaxTokensScale:        1.0,   // scales scaffold max token cap

    // Stage C: Tile-based seeding (experimental)
    tokenSeedingMode:         'global_stride', // 'global_stride' | 'tile_min_coverage'
    seedTileSizePx:           64,
    seedMinPerTile:           2,
    seedMaxPerTile:           40,
    seedExtraScale:           1.5,   // multiplier for extra nodes in strong tiles
    seedStaggeredPass:        false,
    seedFallbackMode:         'grid', // 'grid' | 'low_gradient'
    seedNmsRadiusPx:          3,
    seedRefinementEnabled:    false,
    seedRefinementMaxDensity: 2.0,   // max densification multiplier

    // Stage C: Uniform scaffold seeding (experimental)
    scaffoldSpacingPx:        12,    // base lattice spacing in pixels
    scaffoldStaggered:        true,  // add half-offset second pass
    scaffoldEvidenceGateMin:  0.04,  // minimum local evidence to accept a scaffold point
    scaffoldSnapRadius:       4,     // max pixels to snap toward a stronger local peak
    scaffoldSnapEnabled:      true,  // enable/disable local snap
    scaffoldMaxTokens:        25000, // global token cap (browser safety)
    scaffoldMinSpacing:       5,     // minimum distance between final tokens after snap

    // Stage C: Structured contour mode (tokenSeedingMode = 'structured_contour')
    // Uses connected component analysis + arc tracing + PCA tangents + fan color sampling.
    structuredContourMinCompSize:       10,   // min edge pixels for a structural component (smaller = noise)
    structuredContourMinTokensPerComp:  2,    // minimum tokens to place per structural component
    structuredContourMaxTokensPerComp:  400,  // maximum tokens per structural component
    structuredContourArcStep:           8,    // base arc-length interval between tokens (pixels)
    structuredContourCurvatureBoost:    2.0,  // density multiplier at high-curvature regions
    structuredContourNmsRadius:         4,    // intra-component NMS suppression radius (pixels)

    // Stage C: Enhanced token construction (used by structured_contour internally)
    tokenEnhancedTangentRadius:         5,    // neighborhood radius (px) for PCA tangent estimation
    tokenSideFanCount:                  3,    // sample points per side for averaged color
    tokenSideFanSpread:                 2     // tangent-axis offset per fan sample (px)
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

  /* ── Shared: construct a single token from a pixel position ── */

  function _makeToken(id, px, py, surface, evidence, cfg) {
    var w = surface.width, h = surface.height;
    var gx = evidence.gradX, gy = evidence.gradY;
    var sampleD = cfg.tokenSideSamplePx;
    var deMax = cfg.tokenConfidenceDeltaEMax;
    var idx = py * w + px;

    var hasLab = !!surface.lab;
    var L  = hasLab ? surface.lab.L : null;
    var la = hasLab ? surface.lab.a : null;
    var lb = hasLab ? surface.lab.b : null;
    var grayArr = surface.gray;

    // Local gradient → normal direction
    var rawGx = gx[idx], rawGy = gy[idx];
    var gMag = Math.sqrt(rawGx * rawGx + rawGy * rawGy);
    var nx, ny;
    if (gMag < 0.001) {
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
      if (aMag < 0.001) { nx = 1; ny = 0; }
      else { nx = accX / aMag; ny = accY / aMag; }
    } else {
      nx = rawGx / gMag; ny = rawGy / gMag;
    }

    var tx = -ny, ty = nx;

    var lx = CV.clamp(Math.round(px + nx * sampleD), 0, w - 1);
    var ly = CV.clamp(Math.round(py + ny * sampleD), 0, h - 1);
    var rx = CV.clamp(Math.round(px - nx * sampleD), 0, w - 1);
    var ry = CV.clamp(Math.round(py - ny * sampleD), 0, h - 1);

    var leftLab, rightLab, deltaE;
    if (hasLab) {
      var li = ly * w + lx, rri = ry * w + rx;
      leftLab  = [L[li],  la[li],  lb[li]];
      rightLab = [L[rri], la[rri], lb[rri]];
      var dL = leftLab[0] - rightLab[0];
      var da = leftLab[1] - rightLab[1];
      var db = leftLab[2] - rightLab[2];
      deltaE = Math.sqrt(dL * dL + da * da + db * db);
    } else {
      var lVal = grayArr[ly * w + lx];
      var rVal = grayArr[ry * w + rx];
      leftLab  = [lVal * (100 / 255), 0, 0];
      rightLab = [rVal * (100 / 255), 0, 0];
      deltaE = Math.abs(leftLab[0] - rightLab[0]);
    }

    var confidence = Math.min(1.0, deltaE / deMax);
    return {
      id: id, x: px, y: py,
      tangentX: tx, tangentY: ty,
      normalX: nx, normalY: ny,
      leftLab: leftLab, rightLab: rightLab,
      deltaE: deltaE, confidence: confidence
    };
  }

  /* ── Evidence score for candidate ranking (tile mode) ── */

  function _evidenceScore(px, py, evidence, w) {
    var idx = py * w + px;
    var ew = evidence.edgeWeighted[idx] / 255.0;
    var gm = Math.min(evidence.gradMag[idx] / 255.0, 1.0);
    var ld = Math.min(evidence.labDelta[idx] / 100.0, 1.0);
    return 0.5 * ew + 0.3 * gm + 0.2 * ld;
  }

  function _phase1KeepWeakToken(cfg) {
    return cfg.phase1RelaxedTokenRetention === true && cfg.phase1StrictConfidenceDrop !== true;
  }

  function _scaledPositive(value, scale, minValue) {
    var s = (typeof scale === 'number' && isFinite(scale) && scale > 0) ? scale : 1.0;
    var out = Math.round(value * s);
    return Math.max(minValue, out);
  }

  /* ── NMS: suppress nearby candidates within radius (by descending score) ── */

  function _nmsFilter(candidates, radius) {
    // candidates: [{x,y,score},...] — mutated sort OK, returns new array
    if (!candidates.length || radius <= 0) return candidates;
    candidates.sort(function (a, b) { return b.score - a.score; });
    var r2 = radius * radius;
    var kept = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var suppress = false;
      for (var j = 0; j < kept.length; j++) {
        var dx = c.x - kept[j].x, dy = c.y - kept[j].y;
        if (dx * dx + dy * dy < r2) { suppress = true; break; }
      }
      if (!suppress) kept.push(c);
    }
    return kept;
  }

  /* ── Fallback: evenly spaced grid points ── */

  function _fallbackGrid(x0, y0, x1, y1, count) {
    var tw = x1 - x0, th = y1 - y0;
    if (tw < 1 || th < 1) return [];
    var side = Math.max(1, Math.ceil(Math.sqrt(count)));
    var pts = [];
    for (var gy = 0; gy < side; gy++) {
      for (var gx = 0; gx < side; gx++) {
        if (pts.length >= count) break;
        var px = x0 + Math.round((gx + 0.5) * tw / side);
        var py = y0 + Math.round((gy + 0.5) * th / side);
        pts.push({ x: Math.min(px, x1 - 1), y: Math.min(py, y1 - 1) });
      }
    }
    return pts;
  }

  /* ── Fallback: low-gradient sampling ── */

  function _fallbackLowGradient(x0, y0, x1, y1, evidence, w, count, nmsR) {
    var pts = [];
    for (var py = y0; py < y1; py += 2) {
      for (var px = x0; px < x1; px += 2) {
        var gm = evidence.gradMag[py * w + px];
        pts.push({ x: px, y: py, score: 1.0 / (1.0 + gm) });
      }
    }
    if (!pts.length) return _fallbackGrid(x0, y0, x1, y1, count);
    var filtered = _nmsFilter(pts, nmsR);
    var result = [];
    for (var i = 0; i < Math.min(count, filtered.length); i++) {
      result.push({ x: filtered[i].x, y: filtered[i].y });
    }
    return result;
  }

  /* ── Original global-stride seeding (preserved exactly) ── */

  function _seedGlobalStride(surface, evidence, cfg) {
    var w = surface.width, h = surface.height;
    var edge = evidence.edgeBinary;
    var step = Math.max(1, cfg.tokenStep);
    var minConf = cfg.tokenMinConfidence;
    var keepWeak = _phase1KeepWeakToken(cfg);

    var positions = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (edge[y * w + x] > 0) positions.push(x | (y << 16));
      }
    }

    var tokens = [];
    var nextId = 0;
    for (var pi = 0; pi < positions.length; pi += step) {
      var packed = positions[pi];
      var px = packed & 0xFFFF;
      var py = packed >>> 16;
      var tok = _makeToken(nextId, px, py, surface, evidence, cfg);
      if (tok.confidence < minConf) {
        if (!keepWeak) continue;
        tok._weakConfidence = true;
      }
      tok.id = nextId++;
      tokens.push(tok);
    }
    return tokens;
  }

  /* ── Tile-based minimum-coverage seeding (new experimental mode) ── */

  function _seedTileMinCoverage(surface, evidence, cfg) {
    var w = surface.width, h = surface.height;
    var edge = evidence.edgeBinary;
    var tileSz = Math.max(8, cfg.seedTileSizePx || 64);
    var minPer = Math.max(1, cfg.seedMinPerTile || 2);
    var maxPer = Math.max(minPer, cfg.seedMaxPerTile || 40);
    var extraScale = Math.max(1.0, cfg.seedExtraScale || 1.5);
    var nmsR = _scaledPositive(cfg.seedNmsRadiusPx || 3, cfg.phase1NmsRadiusScale || 1.0, 1);
    var fallbackMode = cfg.seedFallbackMode || 'grid';
    var minConf = cfg.tokenMinConfidence;
    var keepWeak = _phase1KeepWeakToken(cfg);

    var tilesX = Math.ceil(w / tileSz);
    var tilesY = Math.ceil(h / tileSz);

    // Pre-collect edge pixel positions per tile
    // Use a flat array indexed by tile to avoid object overhead
    var tileCount = tilesX * tilesY;
    var tileLists = new Array(tileCount);
    for (var ti = 0; ti < tileCount; ti++) tileLists[ti] = [];

    for (var ey = 0; ey < h; ey++) {
      var tyIdx = (ey / tileSz) | 0;
      var rowOff = ey * w;
      for (var ex = 0; ex < w; ex++) {
        if (edge[rowOff + ex] > 0) {
          var txIdx = (ex / tileSz) | 0;
          tileLists[tyIdx * tilesX + txIdx].push(ex | (ey << 16));
        }
      }
    }

    // Compute global mean evidence score for adaptive allocation
    var scoreSum = 0, scoreCount = 0;
    var tileScored = new Array(tileCount); // [{x,y,score}[]]
    for (var t = 0; t < tileCount; t++) {
      var list = tileLists[t];
      var scored = [];
      for (var si = 0; si < list.length; si++) {
        var spx = list[si] & 0xFFFF;
        var spy = list[si] >>> 16;
        var sc = _evidenceScore(spx, spy, evidence, w);
        scored.push({ x: spx, y: spy, score: sc });
        scoreSum += sc;
        scoreCount++;
      }
      tileScored[t] = scored;
    }
    var globalMeanScore = scoreCount > 0 ? scoreSum / scoreCount : 0.1;

    var tokens = [];
    var nextId = 0;

    // Debug info
    var debugInfo = {
      tileSz: tileSz, tilesX: tilesX, tilesY: tilesY,
      perTileCounts: new Int32Array(tileCount),
      fallbackTiles: [],
      totalEdgeCandidates: scoreCount
    };

    for (var tyI = 0; tyI < tilesY; tyI++) {
      for (var txI = 0; txI < tilesX; txI++) {
        var tIdx = tyI * tilesX + txI;
        var x0 = txI * tileSz;
        var y0 = tyI * tileSz;
        var x1 = Math.min(x0 + tileSz, w);
        var y1 = Math.min(y0 + tileSz, h);

        var candidates = tileScored[tIdx];

        if (candidates.length > 0) {
          // Compute tile mean evidence score
          var tileMean = 0;
          for (var ci = 0; ci < candidates.length; ci++) tileMean += candidates[ci].score;
          tileMean /= candidates.length;

          // Budget: minPer + extra proportional to evidence strength
          var extra = Math.round((tileMean / Math.max(globalMeanScore, 0.01)) * extraScale);
          var budget = Math.min(maxPer, Math.max(minPer, minPer + extra));

          // NMS to prevent clumping
          var filtered = _nmsFilter(candidates, nmsR);

          // Take top-budget (already sorted by score descending from NMS)
          var selected = filtered.length > budget ? filtered.slice(0, budget) : filtered;

          for (var si2 = 0; si2 < selected.length; si2++) {
            var tok = _makeToken(nextId, selected[si2].x, selected[si2].y, surface, evidence, cfg);
            if (tok.confidence < minConf) {
              if (!keepWeak) continue;
              tok._weakConfidence = true;
            }
            tok.id = nextId++;
            tokens.push(tok);
          }
          debugInfo.perTileCounts[tIdx] = selected.length;
        } else {
          // Soft-edge fallback: check edgeWeighted for partial/soft edges
          // that Canny missed but gradient still supports
          var softCandidates = [];
          var edgeW = evidence.edgeWeighted;
          var softThresh = 40; // ~15% of 255 — catches moderate gradient
          for (var spy = y0; spy < y1; spy++) {
            var sRowOff = spy * w;
            for (var spx = x0; spx < x1; spx++) {
              if (edgeW[sRowOff + spx] >= softThresh) {
                softCandidates.push({
                  x: spx, y: spy,
                  score: _evidenceScore(spx, spy, evidence, w)
                });
              }
            }
          }

          if (softCandidates.length > 0) {
            var softFiltered = _nmsFilter(softCandidates, nmsR);
            var softBudget = Math.min(maxPer, Math.max(minPer, softFiltered.length));
            var softSelected = softFiltered.length > softBudget
              ? softFiltered.slice(0, softBudget) : softFiltered;

            for (var sfi = 0; sfi < softSelected.length; sfi++) {
              var stok = _makeToken(nextId, softSelected[sfi].x, softSelected[sfi].y,
                                    surface, evidence, cfg);
              if (stok.confidence < minConf) {
                if (!keepWeak) continue;
                stok._weakConfidence = true;
              }
              stok.id = nextId++;
              stok._softEdge = true;
              tokens.push(stok);
            }
            debugInfo.perTileCounts[tIdx] = softSelected.length;
          } else {
            // Hard fallback: tile has no edge or soft-edge candidates
            debugInfo.fallbackTiles.push(tIdx);

            var fallbackPts;
            if (fallbackMode === 'low_gradient') {
              fallbackPts = _fallbackLowGradient(x0, y0, x1, y1, evidence, w, minPer, nmsR);
            } else {
              fallbackPts = _fallbackGrid(x0, y0, x1, y1, minPer);
            }

            for (var fi = 0; fi < fallbackPts.length; fi++) {
              var ftok = _makeToken(nextId, fallbackPts[fi].x, fallbackPts[fi].y,
                                    surface, evidence, cfg);
              ftok.id = nextId++;
              ftok._fallback = true;
              tokens.push(ftok);
            }
            debugInfo.perTileCounts[tIdx] = fallbackPts.length;
          }
        }
      }
    }

    return { tokens: tokens, debugInfo: debugInfo };
  }

  /* ── Staggered second pass (thin-line protection) ── */

  function _staggeredPass(surface, evidence, cfg, existingTokens) {
    var w = surface.width, h = surface.height;
    var edge = evidence.edgeBinary;
    var tileSz = Math.max(8, cfg.seedTileSizePx || 64);
    var half = tileSz >> 1;
    var minPer = Math.max(1, ((cfg.seedMinPerTile || 2) >> 1) || 1);
    var maxPer = Math.max(minPer, ((cfg.seedMaxPerTile || 40) >> 1) || 1);
    var nmsR = _scaledPositive(cfg.seedNmsRadiusPx || 3, cfg.phase1NmsRadiusScale || 1.0, 1);
    var minConf = cfg.tokenMinConfidence;
    var keepWeak = _phase1KeepWeakToken(cfg);
    var nmsR2 = nmsR * nmsR;

    // Build spatial set of existing positions for dedup
    var posSet = {};
    for (var ei = 0; ei < existingTokens.length; ei++) {
      var et = existingTokens[ei];
      posSet[et.x + ',' + et.y] = true;
    }

    // Offset tile grid by half
    var tilesX = Math.ceil(w / tileSz) + 1;
    var tilesY = Math.ceil(h / tileSz) + 1;

    // Collect edge pixels into offset tiles
    var tileLists = {};
    for (var ey = 0; ey < h; ey++) {
      var tyIdx = ((ey - half) / tileSz) | 0;
      var rowOff = ey * w;
      for (var ex = 0; ex < w; ex++) {
        if (edge[rowOff + ex] > 0) {
          var txIdx = ((ex - half) / tileSz) | 0;
          var tKey = txIdx + ',' + tyIdx;
          if (!tileLists[tKey]) tileLists[tKey] = [];
          tileLists[tKey].push(ex | (ey << 16));
        }
      }
    }

    var nextId = 0;
    for (var ni = 0; ni < existingTokens.length; ni++) {
      if (existingTokens[ni].id >= nextId) nextId = existingTokens[ni].id + 1;
    }

    var newTokens = [];
    for (var tKey2 in tileLists) {
      var list = tileLists[tKey2];
      var scored = [];
      for (var si = 0; si < list.length; si++) {
        var spx = list[si] & 0xFFFF;
        var spy = list[si] >>> 16;
        scored.push({ x: spx, y: spy, score: _evidenceScore(spx, spy, evidence, w) });
      }
      var filtered = _nmsFilter(scored, nmsR);
      var budget = Math.min(maxPer, Math.max(minPer, filtered.length));
      var selected = filtered.length > budget ? filtered.slice(0, budget) : filtered;

      for (var si2 = 0; si2 < selected.length; si2++) {
        var sx = selected[si2].x, sy = selected[si2].y;
        // Dedup: skip if too close to existing token
        var pk = sx + ',' + sy;
        if (posSet[pk]) continue;

        // Distance-based dedup against existing tokens (check nearby)
        var tooClose = false;
        for (var ci = 0; ci < existingTokens.length; ci++) {
          var dx = sx - existingTokens[ci].x, dy = sy - existingTokens[ci].y;
          if (dx * dx + dy * dy < nmsR2) { tooClose = true; break; }
        }
        if (tooClose) continue;

        var tok = _makeToken(nextId, sx, sy, surface, evidence, cfg);
        if (tok.confidence < minConf) {
          if (!keepWeak) continue;
          tok._weakConfidence = true;
        }
        tok.id = nextId++;
        tok._staggered = true;
        newTokens.push(tok);
        posSet[pk] = true;
      }
    }
    return newTokens;
  }

  /* ── Local refinement pass (corridor densification) ── */

  function _refinementPass(surface, evidence, cfg, tokens) {
    if (!tokens.length || tokens.length < 4) return [];

    var maxDensity = cfg.seedRefinementMaxDensity || 2.0;
    var nmsR = cfg.seedNmsRadiusPx || 3;
    var w = surface.width, h = surface.height;
    var originalCount = tokens.length;
    var maxNew = Math.floor(originalCount * (maxDensity - 1.0));
    if (maxNew <= 0) return [];

    // Build spatial grid for fast neighbor lookup
    var cell = Math.max(4, nmsR * 2);
    var grid = {};
    for (var gi = 0; gi < tokens.length; gi++) {
      var gk = ((tokens[gi].x / cell) | 0) + ',' + ((tokens[gi].y / cell) | 0);
      if (!grid[gk]) grid[gk] = [];
      grid[gk].push(tokens[gi]);
    }

    var radius = (cfg.graphNeighborRadius || 4) * 2.5;
    var cosTol = Math.cos(25 * Math.PI / 180); // tighter than Stage D default
    var sideTol = 15.0;

    var newTokens = [];
    var nextId = 0;
    for (var ni = 0; ni < tokens.length; ni++) {
      if (tokens[ni].id >= nextId) nextId = tokens[ni].id + 1;
    }

    var usedPos = {};
    for (var ui = 0; ui < tokens.length; ui++) usedPos[tokens[ui].x + ',' + tokens[ui].y] = true;

    for (var ti = 0; ti < tokens.length; ti++) {
      if (newTokens.length >= maxNew) break;
      var t = tokens[ti];
      var gcx = (t.x / cell) | 0, gcy = (t.y / cell) | 0;

      // Find corridor neighbors
      var corridorNeis = [];
      for (var dgy = -1; dgy <= 1; dgy++) {
        for (var dgx = -1; dgx <= 1; dgx++) {
          var nk = (gcx + dgx) + ',' + (gcy + dgy);
          var bucket = grid[nk];
          if (!bucket) continue;
          for (var bi = 0; bi < bucket.length; bi++) {
            var n = bucket[bi];
            if (n.id === t.id) continue;
            var ddx = n.x - t.x, ddy = n.y - t.y;
            var dist = Math.sqrt(ddx * ddx + ddy * ddy);
            if (dist > radius || dist < 1) continue;
            var dot = Math.abs(t.tangentX * n.tangentX + t.tangentY * n.tangentY);
            if (dot < cosTol) continue;
            // Side agreement
            var ll = Math.sqrt(
              Math.pow(t.leftLab[0] - n.leftLab[0], 2) +
              Math.pow(t.leftLab[1] - n.leftLab[1], 2) +
              Math.pow(t.leftLab[2] - n.leftLab[2], 2));
            var rr = Math.sqrt(
              Math.pow(t.rightLab[0] - n.rightLab[0], 2) +
              Math.pow(t.rightLab[1] - n.rightLab[1], 2) +
              Math.pow(t.rightLab[2] - n.rightLab[2], 2));
            if (ll <= sideTol && rr <= sideTol) corridorNeis.push(n);
          }
        }
      }

      if (corridorNeis.length < 2) continue;

      // Densify: place midpoints to first 2 corridor neighbors
      for (var cn = 0; cn < Math.min(2, corridorNeis.length); cn++) {
        if (newTokens.length >= maxNew) break;
        var mx = ((t.x + corridorNeis[cn].x) >> 1);
        var my = ((t.y + corridorNeis[cn].y) >> 1);
        var mk = mx + ',' + my;
        if (usedPos[mk]) continue;
        if (mx < 0 || mx >= w || my < 0 || my >= h) continue;
        var mtok = _makeToken(nextId, mx, my, surface, evidence, cfg);
        mtok.id = nextId++;
        mtok._refined = true;
        newTokens.push(mtok);
        usedPos[mk] = true;
      }
    }
    return newTokens;
  }

  /* ── Uniform scaffold seeding (experimental: fair spatial sampling) ── */

  /**
   * _localEvidenceAt — sample a small neighborhood and return max evidence.
   * Uses edgeWeighted, gradMag, labDelta within a 3×3 window.
   * Returns a value in [0, 1].
   */
  function _localEvidenceAt(px, py, evidence, w, h) {
    var best = 0;
    for (var dy = -1; dy <= 1; dy++) {
      var sy = py + dy;
      if (sy < 0 || sy >= h) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var sx = px + dx;
        if (sx < 0 || sx >= w) continue;
        var idx = sy * w + sx;
        var ew = evidence.edgeWeighted[idx] / 255.0;
        var gm = Math.min(evidence.gradMag[idx] / 255.0, 1.0);
        var ld = Math.min(evidence.labDelta[idx] / 100.0, 1.0);
        var val = 0.4 * ew + 0.35 * gm + 0.25 * ld;
        if (val > best) best = val;
      }
    }
    return best;
  }

  /**
   * _snapToLocalPeak — find the pixel with strongest evidence within snapRadius.
   * Returns {x, y, snapped: boolean}.
   */
  function _snapToLocalPeak(px, py, evidence, w, h, snapRadius) {
    var bestX = px, bestY = py;
    var bestScore = -1;
    var r = snapRadius;
    var y0 = Math.max(0, py - r), y1 = Math.min(h - 1, py + r);
    var x0 = Math.max(0, px - r), x1 = Math.min(w - 1, px + r);
    var r2 = r * r;
    for (var sy = y0; sy <= y1; sy++) {
      for (var sx = x0; sx <= x1; sx++) {
        var ddx = sx - px, ddy = sy - py;
        if (ddx * ddx + ddy * ddy > r2) continue;
        var idx = sy * w + sx;
        var ew = evidence.edgeWeighted[idx] / 255.0;
        var gm = Math.min(evidence.gradMag[idx] / 255.0, 1.0);
        var sc = 0.5 * ew + 0.5 * gm;
        if (sc > bestScore) {
          bestScore = sc;
          bestX = sx;
          bestY = sy;
        }
      }
    }
    return { x: bestX, y: bestY, snapped: (bestX !== px || bestY !== py) };
  }

  function _seedUniformScaffold(surface, evidence, cfg) {
    var w = surface.width, h = surface.height;
    var tileSz = Math.max(8, cfg.seedTileSizePx || 64);
    var minPer = Math.max(1, cfg.seedMinPerTile || 2);
    var maxPer = Math.max(minPer, cfg.seedMaxPerTile || 40);
    var spacing = Math.max(4, cfg.scaffoldSpacingPx || 12);
    var doStagger = cfg.scaffoldStaggered !== false;
    var gateMin = cfg.scaffoldEvidenceGateMin || 0.04;
    var snapR = Math.max(0, cfg.scaffoldSnapRadius || 4);
    var doSnap = cfg.scaffoldSnapEnabled !== false && snapR > 0;
    var maxTokens = _scaledPositive(cfg.scaffoldMaxTokens || 25000, cfg.phase1MaxTokensScale || 1.0, 1000);
    var minSpacing = _scaledPositive(cfg.scaffoldMinSpacing || 5, cfg.phase1SpacingScale || 1.0, 1);
    var minConf = cfg.tokenMinConfidence;
    var fallbackMode = cfg.seedFallbackMode || 'grid';
    var nmsR = _scaledPositive(cfg.seedNmsRadiusPx || 3, cfg.phase1NmsRadiusScale || 1.0, 1);
    var keepWeak = _phase1KeepWeakToken(cfg);
    var relaxedMode = cfg.phase1RelaxedTokenRetention === true;

    if (relaxedMode) {
      maxPer = Math.max(maxPer, Math.round(maxPer * 1.5));
      gateMin = Math.max(0, gateMin * 0.6);
    }

    var tilesX = Math.ceil(w / tileSz);
    var tilesY = Math.ceil(h / tileSz);
    var tileCount = tilesX * tilesY;

    // Debug tracking (tile-compatible shape)
    var debugInfo = {
      tileSz: tileSz, tilesX: tilesX, tilesY: tilesY,
      perTileCounts: new Int32Array(tileCount),
      fallbackTiles: [],
      totalEdgeCandidates: 0,
      spacing: spacing,
      staggered: doStagger,
      proposedCount: 0,
      gatedOutCount: 0,
      snappedCount: 0,
      spacingSuppressedCount: 0,
      capReachedCount: 0,
      confidenceDropCount: 0,
      totalTokens: 0
    };

    var tokens = [];
    var nextId = 0;

    // Global occupancy grid for minimum spacing enforcement (across tiles)
    var occCell = Math.max(3, minSpacing);
    var occW = Math.ceil(w / occCell);
    var occH = Math.ceil(h / occCell);
    var occupied = new Uint8Array(occW * occH);

    function isOccupied(px, py) {
      var gcx = (px / occCell) | 0;
      var gcy = (py / occCell) | 0;
      for (var dy = -1; dy <= 1; dy++) {
        var cy = gcy + dy;
        if (cy < 0 || cy >= occH) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var cx = gcx + dx;
          if (cx < 0 || cx >= occW) continue;
          if (occupied[cy * occW + cx]) return true;
        }
      }
      return false;
    }

    function markOccupied(px, py) {
      var gcx = (px / occCell) | 0;
      var gcy = (py / occCell) | 0;
      if (gcx >= 0 && gcx < occW && gcy >= 0 && gcy < occH) {
        occupied[gcy * occW + gcx] = 1;
      }
    }

    /**
     * Run scaffold lattice within one tile.
     * Returns number of tokens created for this tile.
     */
    function scaffoldTile(tx0, ty0, tx1, ty1, tIdx) {
      var tileTokensBefore = tokens.length;

      // Pass 1: primary lattice within tile
      for (var gy = ty0; gy < ty1; gy += spacing) {
        for (var gx = tx0; gx < tx1; gx += spacing) {
          if (tokens.length >= maxTokens) { debugInfo.capReachedCount++; break; }
          debugInfo.proposedCount++;

          var px = gx, py = gy;
          var weakEvidence = false;

          // Light local evidence gating
          var localEv = _localEvidenceAt(px, py, evidence, w, h);
          if (localEv < gateMin) {
            if (!keepWeak) { debugInfo.gatedOutCount++; continue; }
            weakEvidence = true;
          }

          // Optional local snap toward stronger evidence peak
          if (doSnap) {
            var snapped = _snapToLocalPeak(px, py, evidence, w, h, snapR);
            // Clamp snap result to within tile bounds
            px = Math.max(tx0, Math.min(tx1 - 1, snapped.x));
            py = Math.max(ty0, Math.min(ty1 - 1, snapped.y));
            if (snapped.snapped) debugInfo.snappedCount++;
          }

          // Minimum spacing enforcement
          if (isOccupied(px, py)) { debugInfo.spacingSuppressedCount++; continue; }

          // Construct token
          var tok = _makeToken(nextId, px, py, surface, evidence, cfg);
          if (tok.confidence < minConf) {
            if (!keepWeak) { debugInfo.confidenceDropCount++; continue; }
            tok._weakConfidence = true;
          }
          if (weakEvidence) tok._weakEvidence = true;

          tok.id = nextId++;
          tok._scaffold = true;
          tok._scaffoldPass = 1;
          tokens.push(tok);
          markOccupied(px, py);
        }
      }

      // Pass 2: staggered half-offset lattice within tile
      if (doStagger) {
        var halfX = (spacing / 2) | 0;
        var halfY = (spacing / 2) | 0;
        for (var gy2 = ty0 + halfY; gy2 < ty1; gy2 += spacing) {
          for (var gx2 = tx0 + halfX; gx2 < tx1; gx2 += spacing) {
            if (tokens.length >= maxTokens) { debugInfo.capReachedCount++; break; }
            debugInfo.proposedCount++;

            var px2 = gx2, py2 = gy2;
            var weakEvidence2 = false;

            var localEv2 = _localEvidenceAt(px2, py2, evidence, w, h);
            if (localEv2 < gateMin) {
              if (!keepWeak) { debugInfo.gatedOutCount++; continue; }
              weakEvidence2 = true;
            }

            if (doSnap) {
              var snapped2 = _snapToLocalPeak(px2, py2, evidence, w, h, snapR);
              px2 = Math.max(tx0, Math.min(tx1 - 1, snapped2.x));
              py2 = Math.max(ty0, Math.min(ty1 - 1, snapped2.y));
              if (snapped2.snapped) debugInfo.snappedCount++;
            }

            if (isOccupied(px2, py2)) { debugInfo.spacingSuppressedCount++; continue; }

            var tok2 = _makeToken(nextId, px2, py2, surface, evidence, cfg);
            if (tok2.confidence < minConf) {
              if (!keepWeak) { debugInfo.confidenceDropCount++; continue; }
              tok2._weakConfidence = true;
            }
            if (weakEvidence2) tok2._weakEvidence = true;

            tok2.id = nextId++;
            tok2._scaffold = true;
            tok2._scaffoldPass = 2;
            tokens.push(tok2);
            markOccupied(px2, py2);
          }
        }
      }

      var tileTokenCount = tokens.length - tileTokensBefore;

      // Enforce per-tile max: if scaffold produced too many, trim weakest
      if (tileTokenCount > maxPer) {
        // Sort this tile's tokens by confidence ascending, remove weakest
        var tileSlice = tokens.splice(tileTokensBefore, tileTokenCount);
        tileSlice.sort(function (a, b) { return b.confidence - a.confidence; });
        var kept = tileSlice.slice(0, maxPer);
        for (var ki = 0; ki < kept.length; ki++) tokens.push(kept[ki]);
        tileTokenCount = kept.length;
      }

      return tileTokenCount;
    }

    // ── Iterate over tiles ──
    for (var tyI = 0; tyI < tilesY; tyI++) {
      for (var txI = 0; txI < tilesX; txI++) {
        var tIdx = tyI * tilesX + txI;
        var x0 = txI * tileSz;
        var y0 = tyI * tileSz;
        var x1 = Math.min(x0 + tileSz, w);
        var y1 = Math.min(y0 + tileSz, h);

        var tileTokensBefore = tokens.length;
        var count = scaffoldTile(x0, y0, x1, y1, tIdx);

        // Enforce per-tile minimum: if scaffold produced too few, use fallback
        if (count < minPer) {
          debugInfo.fallbackTiles.push(tIdx);
          var fallbackPts;
          if (fallbackMode === 'low_gradient') {
            fallbackPts = _fallbackLowGradient(x0, y0, x1, y1, evidence, w, minPer - count, nmsR);
          } else {
            fallbackPts = _fallbackGrid(x0, y0, x1, y1, minPer - count);
          }
          for (var fi = 0; fi < fallbackPts.length; fi++) {
            if (tokens.length >= maxTokens) break;
            var fpx = fallbackPts[fi].x, fpy = fallbackPts[fi].y;
            if (isOccupied(fpx, fpy)) continue;
            var ftok = _makeToken(nextId, fpx, fpy, surface, evidence, cfg);
            ftok.id = nextId++;
            ftok._scaffold = true;
            ftok._fallback = true;
            tokens.push(ftok);
            markOccupied(fpx, fpy);
          }
          count = tokens.length - tileTokensBefore;
        }

        debugInfo.perTileCounts[tIdx] = count;
      }
    }

    debugInfo.totalTokens = tokens.length;

    return { tokens: tokens, debugInfo: debugInfo };
  }

  /* ── Structured Contour mode: component analysis ── */

  /**
   * _computeComponentInfo
   * Runs connected-component labeling on edgeBinary and classifies each
   * component as structural (size >= minSize) or noise (size < minSize).
   *
   * Returns:
   *   labels:          Int32Array  — per-pixel component id (0 = background)
   *   count:           number      — total number of components
   *   sizes:           Int32Array  — pixel count per component id
   *   isNoise:         Uint8Array  — 1 if component id is noise
   *   noiseMap:        Uint8Array  — 1 for pixels belonging to noise components
   *   componentPixels: Object      — compId → Array<flatPixelIndex> (structural only)
   */
  function _computeComponentInfo(edgeBinary, w, h, minSize) {
    var n = w * h;
    var cc = CV.connectedComponents(edgeBinary, w, h);
    var labels = cc.labels;
    var count  = cc.count;

    // Count pixels per component
    var sizes = new Int32Array(count + 1);
    for (var i = 0; i < n; i++) {
      if (labels[i] > 0) sizes[labels[i]]++;
    }

    // Mark components too small to be structural boundaries
    var isNoise = new Uint8Array(count + 1);
    for (var c = 1; c <= count; c++) {
      if (sizes[c] < minSize) isNoise[c] = 1;
    }

    // Build noise mask and per-component pixel lists (structural only)
    var noiseMap = new Uint8Array(n);
    var componentPixels = {};
    for (var j = 0; j < n; j++) {
      var lbl = labels[j];
      if (lbl === 0) continue;
      if (isNoise[lbl]) {
        noiseMap[j] = 1;
      } else {
        if (!componentPixels[lbl]) componentPixels[lbl] = [];
        componentPixels[lbl].push(j);
      }
    }

    return {
      labels: labels, count: count, sizes: sizes,
      isNoise: isNoise, noiseMap: noiseMap, componentPixels: componentPixels
    };
  }

  /* ── Structured Contour mode: PCA tangent estimation ── */

  /**
   * _estimateArcTangent
   * Estimates the local boundary tangent at (px, py) using 2-D PCA over
   * all component edge pixels within `radius` pixels.  Falls back to the
   * local gradient direction when fewer than 3 neighbors are found.
   *
   * Returns { tx, ty, nx, ny } — unit tangent and unit normal vectors.
   * The normal is aligned with the local gradient direction.
   */
  function _estimateArcTangent(px, py, labels, compId, w, h, gx, gy, radius) {
    var r = radius, r2 = r * r;
    var y0 = Math.max(0, py - r), y1 = Math.min(h - 1, py + r);
    var x0 = Math.max(0, px - r), x1 = Math.min(w - 1, px + r);

    // Collect neighboring component pixels (centered at origin)
    var ptXs = [], ptYs = [], count = 0;
    var sumX = 0, sumY = 0;
    for (var sy = y0; sy <= y1; sy++) {
      var roff = sy * w;
      for (var sx = x0; sx <= x1; sx++) {
        var ddx = sx - px, ddy = sy - py;
        if (ddx * ddx + ddy * ddy > r2) continue;
        if (labels[roff + sx] !== compId) continue;
        ptXs.push(ddx); ptYs.push(ddy);
        sumX += ddx; sumY += ddy; count++;
      }
    }

    if (count < 3) {
      // Gradient fallback (same as _makeToken)
      var gi = py * w + px;
      var rawGx = gx[gi], rawGy = gy[gi];
      var gmag = Math.sqrt(rawGx * rawGx + rawGy * rawGy);
      var fnx, fny;
      if (gmag < 0.001) {
        // 3×3 neighborhood average fallback
        var accX = 0, accY = 0;
        for (var fdy = -1; fdy <= 1; fdy++) {
          for (var fdx = -1; fdx <= 1; fdx++) {
            var fsy = py + fdy, fsx = px + fdx;
            if (fsy >= 0 && fsy < h && fsx >= 0 && fsx < w) {
              accX += gx[fsy * w + fsx]; accY += gy[fsy * w + fsx];
            }
          }
        }
        var aMag = Math.sqrt(accX * accX + accY * accY);
        if (aMag < 0.001) { fnx = 1; fny = 0; } else { fnx = accX / aMag; fny = accY / aMag; }
      } else { fnx = rawGx / gmag; fny = rawGy / gmag; }
      return { tx: -fny, ty: fnx, nx: fnx, ny: fny };
    }

    // 2-D PCA — compute mean-centered covariance matrix
    var mX = sumX / count, mY = sumY / count;
    var cxx = 0, cxy = 0, cyy = 0;
    for (var pi = 0; pi < count; pi++) {
      var cx = ptXs[pi] - mX, cy = ptYs[pi] - mY;
      cxx += cx * cx; cxy += cx * cy; cyy += cy * cy;
    }
    cxx /= count; cxy /= count; cyy /= count;

    // Eigendecomposition of 2×2 symmetric matrix
    var tr   = cxx + cyy;
    var det  = cxx * cyy - cxy * cxy;
    var disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
    var lam1 = tr * 0.5 + disc; // largest eigenvalue

    // Corresponding eigenvector (principal component = tangent direction)
    var evx, evy;
    if (Math.abs(cxy) > 1e-7) {
      evx = lam1 - cyy; evy = cxy;
    } else {
      evx = cxx >= cyy ? 1 : 0;
      evy = cxx >= cyy ? 0 : 1;
    }
    var emag = Math.sqrt(evx * evx + evy * evy);
    if (emag < 1e-8) { evx = 1; evy = 0; } else { evx /= emag; evy /= emag; }

    // Normal is perpendicular to tangent; align sign with local gradient
    var gi2 = py * w + px;
    var nx = -evy, ny = evx;
    if (nx * gx[gi2] + ny * gy[gi2] < 0) { nx = -nx; ny = -ny; }

    return { tx: evx, ty: evy, nx: nx, ny: ny };
  }

  /* ── Structured Contour mode: averaged fan-based side color sampling ── */

  /**
   * _sampleSideColorFan
   * Samples LAB color at `fanCount` positions spread ±fanSpread pixels along
   * the tangent on each side of the boundary, then averages.  Reduces noise
   * compared to the single-point sample in _makeToken.
   *
   * Returns { leftLab, rightLab, deltaE }.
   */
  function _sampleSideColorFan(px, py, nx, ny, tx, ty, surface, sampleD, fanCount, fanSpread) {
    var w = surface.width, h = surface.height;
    var hasLab = !!surface.lab;
    var Larr = hasLab ? surface.lab.L : null;
    var aarr = hasLab ? surface.lab.a : null;
    var barr = hasLab ? surface.lab.b : null;
    var gray = surface.gray;

    var lL = 0, la = 0, lb = 0;
    var rL = 0, ra = 0, rb = 0;
    var half = (fanCount - 1) * 0.5;

    for (var fi = 0; fi < fanCount; fi++) {
      var tOff = fanCount > 1 ? (fi - half) * fanSpread : 0;
      var bx = px + tx * tOff;
      var by = py + ty * tOff;

      var lx = CV.clamp(Math.round(bx + nx * sampleD), 0, w - 1);
      var ly = CV.clamp(Math.round(by + ny * sampleD), 0, h - 1);
      var rx = CV.clamp(Math.round(bx - nx * sampleD), 0, w - 1);
      var ry = CV.clamp(Math.round(by - ny * sampleD), 0, h - 1);

      if (hasLab) {
        var li = ly * w + lx, rri = ry * w + rx;
        lL += Larr[li]; la += aarr[li]; lb += barr[li];
        rL += Larr[rri]; ra += aarr[rri]; rb += barr[rri];
      } else {
        lL += gray[ly * w + lx]  * (100 / 255);
        rL += gray[ry * w + rx] * (100 / 255);
      }
    }

    var invN     = 1 / fanCount;
    var leftLab  = [lL * invN, la * invN, lb * invN];
    var rightLab = [rL * invN, ra * invN, rb * invN];
    var dL = leftLab[0] - rightLab[0];
    var da = leftLab[1] - rightLab[1];
    var db = leftLab[2] - rightLab[2];

    return { leftLab: leftLab, rightLab: rightLab,
             deltaE: Math.sqrt(dL * dL + da * da + db * db) };
  }

  /* ── Structured Contour mode: enhanced token construction ── */

  /**
   * _makeTokenStructured
   * Constructs a boundary token using PCA-based tangent estimation and
   * fan-averaged side color sampling.  Preserves the same core token
   * contract fields as _makeToken so Stage D continues to work unchanged.
   * Adds three optional metadata fields (componentId, arcPosition, curvature)
   * that Stage D ignores.
   */
  function _makeTokenStructured(id, px, py, surface, evidence, labels, compId,
                                arcPos, curv, cfg) {
    var sampleD   = cfg.tokenSideSamplePx;
    var deMax     = cfg.tokenConfidenceDeltaEMax;
    var tRadius   = cfg.tokenEnhancedTangentRadius || 5;
    var fanCount  = cfg.tokenSideFanCount  || 3;
    var fanSpread = cfg.tokenSideFanSpread || 2;
    var w = surface.width, h = surface.height;

    var dir = _estimateArcTangent(
      px, py, labels, compId, w, h,
      evidence.gradX, evidence.gradY, tRadius
    );

    var sides = _sampleSideColorFan(
      px, py, dir.nx, dir.ny, dir.tx, dir.ty,
      surface, sampleD, fanCount, fanSpread
    );

    var confidence = Math.min(1.0, sides.deltaE / deMax);

    return {
      // ── Core Stage D contract fields (unchanged semantics) ──
      id: id, x: px, y: py,
      tangentX: dir.tx, tangentY: dir.ty,
      normalX:  dir.nx, normalY:  dir.ny,
      leftLab:  sides.leftLab, rightLab: sides.rightLab,
      deltaE:   sides.deltaE,  confidence: confidence,
      // ── Additive structural metadata — Stage D ignores these ──
      componentId: compId,
      arcPosition: arcPos,
      curvature:   curv
    };
  }

  /* ── Structured Contour mode: arc tracing ── */

  /**
   * _traceComponentArc
   * Performs a greedy arc walk through the edge pixels of a single component.
   * Prefers direction-consistent steps; gaps are bridged with a zero-cost jump
   * using a monotone scan so total cost is O(n).
   *
   * @param  {Array<number>}  pixelIndices  flat pixel indices for this component
   * @param  {number}         w             image width (for coordinate unpacking)
   * @returns {{
   *   arcOrder:     Array<number>,   indices into pixelIndices, in walk order
   *   arcPositions: Float32Array,    normalized arc position per pixelIndices slot
   *   curvature:    Float32Array,    local curvature per slot  (0=straight, 1=U-turn)
   *   totalLength:  number           total arc length in pixels
   * }}
   */
  function _traceComponentArc(pixelIndices, w) {
    var n = pixelIndices.length;
    if (n === 0) {
      return { arcOrder: [], arcPositions: new Float32Array(0),
               curvature: new Float32Array(0), totalLength: 0 };
    }

    // Build coordinate arrays and fast reverse lookup (flatIndex → coordIndex)
    var xs = new Int16Array(n), ys = new Int16Array(n);
    var posMap = {}; // flatPixelIndex → coord index
    for (var i = 0; i < n; i++) {
      xs[i] = pixelIndices[i] % w;
      ys[i] = (pixelIndices[i] / w) | 0;
      posMap[pixelIndices[i]] = i;
    }

    // Find a good start pixel — prefer an endpoint (≤1 neighbor in 8-connectivity)
    var startCoord = 0;
    outer: for (var s = 0; s < n; s++) {
      var cx0 = xs[s], cy0 = ys[s], nc = 0;
      for (var sdy = -1; sdy <= 1; sdy++) {
        for (var sdx = -1; sdx <= 1; sdx++) {
          if (sdx === 0 && sdy === 0) continue;
          if (posMap[(cy0 + sdy) * w + (cx0 + sdx)] !== undefined) nc++;
        }
      }
      if (nc <= 1) { startCoord = s; break outer; }
    }

    // Greedy walk — prefer direction continuation, O(n) total with monotone jump scan
    var visited    = new Uint8Array(n);
    var arcOrder   = [];
    var arcCumLen  = [];
    var cumLen     = 0;
    var unvisited  = 0; // monotone pointer for O(n) jump fallback

    arcOrder.push(startCoord);
    arcCumLen.push(0);
    visited[startCoord] = 1;

    while (arcOrder.length < n) {
      var cur  = arcOrder[arcOrder.length - 1];
      var curX = xs[cur], curY = ys[cur];

      // Previous step direction (for alignment preference)
      var prevDx = 0, prevDy = 0;
      if (arcOrder.length >= 2) {
        var prev = arcOrder[arcOrder.length - 2];
        prevDx = curX - xs[prev]; prevDy = curY - ys[prev];
      }

      // Find best unvisited 8-neighbor
      var bestNext = -1, bestScore = -Infinity, bestDist = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var ny2 = curY + dy;
        if (ny2 < 0) continue;
        for (var dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          var nx2 = curX + dx;
          if (nx2 < 0) continue;
          var ni = posMap[ny2 * w + nx2];
          if (ni === undefined || visited[ni]) continue;
          var stepDist = Math.sqrt(dx * dx + dy * dy);
          var dot = (prevDx !== 0 || prevDy !== 0)
            ? (dx * prevDx + dy * prevDy) /
              (stepDist * Math.sqrt(prevDx * prevDx + prevDy * prevDy))
            : 0;
          var score = dot - stepDist * 0.05;
          if (score > bestScore) {
            bestScore = score; bestNext = ni; bestDist = stepDist;
          }
        }
      }

      if (bestNext < 0) {
        // Jump over a gap — O(n) total with monotone scan
        while (unvisited < n && visited[unvisited]) unvisited++;
        if (unvisited >= n) break;
        bestNext = unvisited;
        bestDist = 0; // gap contributes no arc length
      }

      cumLen += bestDist;
      arcOrder.push(bestNext);
      arcCumLen.push(cumLen);
      visited[bestNext] = 1;
    }

    var totalLength = cumLen;

    // Normalized arc positions (per coord index)
    var arcPositions = new Float32Array(n);
    for (var ai = 0; ai < arcOrder.length; ai++) {
      arcPositions[arcOrder[ai]] = totalLength > 0 ? arcCumLen[ai] / totalLength : 0;
    }

    // Local curvature — turning angle over a ±3-step window, normalized 0..1
    var curvature = new Float32Array(n);
    var win = 3;
    for (var ci = win; ci < arcOrder.length - win; ci++) {
      var p0 = arcOrder[ci - win], p1 = arcOrder[ci], p2 = arcOrder[ci + win];
      var v1x = xs[p1] - xs[p0], v1y = ys[p1] - ys[p0];
      var v2x = xs[p2] - xs[p1], v2y = ys[p2] - ys[p1];
      var m1 = Math.sqrt(v1x * v1x + v1y * v1y);
      var m2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (m1 < 0.1 || m2 < 0.1) continue;
      var cosA = (v1x * v2x + v1y * v2y) / (m1 * m2);
      cosA = Math.max(-1, Math.min(1, cosA));
      curvature[p1] = Math.acos(cosA) / Math.PI; // 0 = straight, 1 = U-turn
    }

    return { arcOrder: arcOrder, arcPositions: arcPositions,
             curvature: curvature, totalLength: totalLength };
  }

  /* ── Structured Contour mode: main seeding function ── */

  /**
   * _seedStructuredContour
   * Structure-aware token seeding pipeline:
   *   1. Connected component analysis — filters noise components
   *   2. Arc tracing per structural component
   *   3. Regular arc-length sampling with curvature-aware density
   *   4. PCA tangent + fan color sampling per token
   *
   * Output tokens use the same Stage D contract fields (id, x, y,
   * tangentX/Y, normalX/Y, leftLab, rightLab, deltaE, confidence).
   * Three additive fields (componentId, arcPosition, curvature) are
   * attached but Stage D does not read them.
   */
  function _seedStructuredContour(surface, evidence, cfg) {
    var w = surface.width, h = surface.height;

    var minCompSize = cfg.structuredContourMinCompSize       || 10;
    var minPerComp  = cfg.structuredContourMinTokensPerComp  || 2;
    var maxPerComp  = cfg.structuredContourMaxTokensPerComp  || 400;
    var arcStep     = cfg.structuredContourArcStep           || 8;
    var curvBoost   = cfg.structuredContourCurvatureBoost    || 2.0;
    var nmsR        = cfg.structuredContourNmsRadius         || 4;
    var maxTokens   = _scaledPositive(
      cfg.scaffoldMaxTokens || 25000, cfg.phase1MaxTokensScale || 1.0, 1000
    );
    var minConf  = cfg.tokenMinConfidence;
    var keepWeak = _phase1KeepWeakToken(cfg);

    // ── Step 1: Component analysis — structural vs noise classification ──
    var compInfo = _computeComponentInfo(evidence.edgeBinary, w, h, minCompSize);

    var tokens = [];
    var nextId = 0;

    // ── Step 2: Process components largest-first (structural priority) ──
    var compIds = Object.keys(compInfo.componentPixels);
    compIds.sort(function (a, b) { return compInfo.sizes[+b] - compInfo.sizes[+a]; });

    for (var ci = 0; ci < compIds.length; ci++) {
      if (tokens.length >= maxTokens) break;

      var compId       = +compIds[ci];
      var pixelIndices = compInfo.componentPixels[compId];

      // ── Step 3: Arc trace — establishes walk order, arc positions, curvature ──
      var arcData  = _traceComponentArc(pixelIndices, w);
      var arcLen   = arcData.totalLength;
      var arcOrder = arcData.arcOrder;

      // ── Step 4: Token budget proportional to arc length ──
      var baseBudget = Math.max(1, Math.round(arcLen / Math.max(1, arcStep)));
      var budget     = Math.max(minPerComp, Math.min(maxPerComp, baseBudget));
      var stepSize   = Math.max(1, arcLen / budget);

      // ── Step 5: Walk arc, sample at regular intervals (curvature-aware) ──
      var candidates = [];
      var nextSample = 0;

      for (var ai = 0; ai < arcOrder.length; ai++) {
        var aIdx     = arcOrder[ai];
        var cumArcPx = arcData.arcPositions[aIdx] * arcLen;

        if (cumArcPx < nextSample) continue;

        var spx  = pixelIndices[aIdx] % w;
        var spy  = (pixelIndices[aIdx] / w) | 0;
        var curv = arcData.curvature[aIdx];

        // Curvature-aware step: tighter spacing at corners
        var stepMod = 1.0 / Math.max(0.3, 1.0 + curvBoost * curv);
        nextSample  = cumArcPx + stepSize * stepMod;

        candidates.push({
          x: spx, y: spy,
          score:  _evidenceScore(spx, spy, evidence, w),
          curv:   curv,
          aIdx:   aIdx,
          arcPos: arcData.arcPositions[aIdx]
        });
      }

      // ── Step 6: NMS within component — prevents local crowding ──
      var filtered = _nmsFilter(candidates, nmsR);
      var selected = filtered.length > budget ? filtered.slice(0, budget) : filtered;

      // ── Step 7: Build enhanced tokens ──
      for (var si = 0; si < selected.length; si++) {
        if (tokens.length >= maxTokens) break;

        var tok = _makeTokenStructured(
          nextId,
          selected[si].x, selected[si].y,
          surface, evidence,
          compInfo.labels, compId,
          selected[si].arcPos, selected[si].curv,
          cfg
        );

        if (tok.confidence < minConf) {
          if (!keepWeak) continue;
          tok._weakConfidence = true;
        }
        tok.id = nextId++;
        tok._structuredContour = true;
        tokens.push(tok);
      }
    }

    return tokens;
  }

  /* ── Main Stage C entry point ── */

  /**
   * @param {Object} surface    NormalizedSurface
   * @param {Object} evidence   BoundaryEvidence
   * @param {Object} [cfg]      override config
   * @returns {Array}           BoundaryToken[]
   */
  function stageC_boundaryTokens(surface, evidence, cfg) {
    cfg = cfg || DEFAULT_CONFIG_AC;
    var mode = cfg.tokenSeedingMode || 'global_stride';

    // ── structured_contour: component-aware, arc-traced, PCA-tangent mode ──
    if (mode === 'structured_contour') {
      var scTokens = _seedStructuredContour(surface, evidence, cfg);
      // Fallback: if no structural components found, use global_stride
      if (!scTokens.length) scTokens = _seedGlobalStride(surface, evidence, cfg);
      return scTokens;
    }

    if (mode === 'uniform_scaffold') {
      var scaffoldResult = _seedUniformScaffold(surface, evidence, cfg);
      var scaffoldTokens = scaffoldResult.tokens;
      var scaffoldDebug = scaffoldResult.debugInfo;

      // Attach debug info (non-enumerable so it won't break iteration)
      scaffoldDebug.mode = 'uniform_scaffold';
      scaffoldTokens._tileDebugInfo = scaffoldDebug;
      scaffoldTokens._scaffoldDebugInfo = scaffoldDebug;

      return scaffoldTokens;
    }

    if (mode === 'tile_min_coverage') {
      var result = _seedTileMinCoverage(surface, evidence, cfg);
      var tokens = result.tokens;
      var debugInfo = result.debugInfo;

      // Staggered second pass
      var staggerCount = 0;
      if (cfg.seedStaggeredPass) {
        var staggerTokens = _staggeredPass(surface, evidence, cfg, tokens);
        for (var si = 0; si < staggerTokens.length; si++) tokens.push(staggerTokens[si]);
        staggerCount = staggerTokens.length;
      }

      // Optional refinement pass
      var refineCount = 0;
      if (cfg.seedRefinementEnabled) {
        var refineTokens = _refinementPass(surface, evidence, cfg, tokens);
        for (var ri = 0; ri < refineTokens.length; ri++) tokens.push(refineTokens[ri]);
        refineCount = refineTokens.length;
      }

      // Attach debug info to returned array (non-enumerable so it won't break iteration)
      debugInfo.staggerCount = staggerCount;
      debugInfo.refineCount = refineCount;
      debugInfo.totalTokens = tokens.length;
      tokens._tileDebugInfo = debugInfo;

      return tokens;
    }

    // Default: original global_stride mode
    return _seedGlobalStride(surface, evidence, cfg);
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
