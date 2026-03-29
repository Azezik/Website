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
    scaffoldMinSpacing:       5      // minimum distance between final tokens after snap
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
      if (tok.confidence < minConf) continue;
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
    var nmsR = Math.max(1, cfg.seedNmsRadiusPx || 3);
    var fallbackMode = cfg.seedFallbackMode || 'grid';
    var minConf = cfg.tokenMinConfidence;

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
            if (tok.confidence >= minConf) {
              tok.id = nextId++;
              tokens.push(tok);
            }
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
              if (stok.confidence >= minConf) {
                stok.id = nextId++;
                stok._softEdge = true;
                tokens.push(stok);
              }
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
    var nmsR = Math.max(1, cfg.seedNmsRadiusPx || 3);
    var minConf = cfg.tokenMinConfidence;
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
        if (tok.confidence >= minConf) {
          tok.id = nextId++;
          tok._staggered = true;
          newTokens.push(tok);
          posSet[pk] = true;
        }
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
    var maxTokens = cfg.scaffoldMaxTokens || 25000;
    var minSpacing = cfg.scaffoldMinSpacing || 5;
    var minConf = cfg.tokenMinConfidence;
    var fallbackMode = cfg.seedFallbackMode || 'grid';
    var nmsR = Math.max(1, cfg.seedNmsRadiusPx || 3);

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

          // Light local evidence gating
          var localEv = _localEvidenceAt(px, py, evidence, w, h);
          if (localEv < gateMin) { debugInfo.gatedOutCount++; continue; }

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
          if (tok.confidence < minConf) { debugInfo.confidenceDropCount++; continue; }

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

            var localEv2 = _localEvidenceAt(px2, py2, evidence, w, h);
            if (localEv2 < gateMin) { debugInfo.gatedOutCount++; continue; }

            if (doSnap) {
              var snapped2 = _snapToLocalPeak(px2, py2, evidence, w, h, snapR);
              px2 = Math.max(tx0, Math.min(tx1 - 1, snapped2.x));
              py2 = Math.max(ty0, Math.min(ty1 - 1, snapped2.y));
              if (snapped2.snapped) debugInfo.snappedCount++;
            }

            if (isOccupied(px2, py2)) { debugInfo.spacingSuppressedCount++; continue; }

            var tok2 = _makeToken(nextId, px2, py2, surface, evidence, cfg);
            if (tok2.confidence < minConf) { debugInfo.confidenceDropCount++; continue; }

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
