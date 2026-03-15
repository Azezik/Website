'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  batch-field-intelligence.js  –  Phase 3A: Field Intelligence
  ─────────────────────────────────────────────────────────────────────────────

  Uses user corrections to improve extraction geometry (WHERE text is
  extracted from). This phase does NOT perform text normalization, OCR
  cleanup, or pattern correction — it only refines bounding boxes.

  ─── What it does ─────────────────────────────────────────────────────────

  1. Takes Phase 2B extraction results + user text corrections
  2. Generates candidate extraction regions around the original BBOX
  3. Evaluates each candidate by extracting text and comparing to corrected
     value
  4. Selects the best-scoring geometry as the learned refinement
  5. Stores a field geometry profile for future extractions

  ─── Candidate Families ───────────────────────────────────────────────────

  Family 1 – Original BBOX (from Phase 2B as-is)
  Family 2 – Structural Region Expansion (toward containing region bounds)
  Family 3 – Local Geometry Search (shifts, expansions, contractions)

  ─── Scoring Priority ─────────────────────────────────────────────────────

  1. Anchor alignment consistency (geometry stays near anchor-transferred
     position)
  2. OCR/token confidence
  3. Similarity to corrected reference text

───────────────────────────────────────────────────────────────────────────────*/

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(v, dec) {
  var f = Math.pow(10, dec || 3);
  return Math.round(v * f) / f;
}

function mean(arr) {
  return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
}

/** Normalized Levenshtein distance (0 = identical, 1 = totally different). */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return 1;
  if (!b.length) return 1;

  var matrix = [];
  for (var i = 0; i <= b.length; i++) matrix[i] = [i];
  for (var j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (i = 1; i <= b.length; i++) {
    for (j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length] / Math.max(a.length, b.length);
}

/** Token overlap score: fraction of corrected tokens found in extracted text. */
function tokenOverlap(extracted, corrected) {
  if (!corrected || !corrected.trim()) return 0;
  var corrTokens = corrected.toLowerCase().split(/\s+/).filter(Boolean);
  if (corrTokens.length === 0) return 0;
  var extLower = extracted.toLowerCase();
  var found = 0;
  for (var i = 0; i < corrTokens.length; i++) {
    if (extLower.indexOf(corrTokens[i]) >= 0) found++;
  }
  return found / corrTokens.length;
}

/** Text similarity combining edit distance and token overlap. */
function textSimilarity(extracted, corrected) {
  if (!corrected || !corrected.trim()) return extracted ? 0 : 1;
  if (!extracted || !extracted.trim()) return 0;
  var editSim = 1 - levenshteinDistance(extracted.trim(), corrected.trim());
  var tokSim = tokenOverlap(extracted, corrected);
  return editSim * 0.6 + tokSim * 0.4;
}

/** Center of a normBox. */
function normBoxCenter(nb) {
  return { x: nb.x0n + nb.wN / 2, y: nb.y0n + nb.hN / 2 };
}

/** Euclidean distance between two {x,y} points. */
function pointDist(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

/** IoU between two normBox objects. */
function normBoxIoU(a, b) {
  var ax1 = a.x0n + a.wN, ay1 = a.y0n + a.hN;
  var bx1 = b.x0n + b.wN, by1 = b.y0n + b.hN;
  var ix0 = Math.max(a.x0n, b.x0n), iy0 = Math.max(a.y0n, b.y0n);
  var ix1 = Math.min(ax1, bx1), iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  var inter = (ix1 - ix0) * (iy1 - iy0);
  var union = a.wN * a.hN + b.wN * b.hN - inter;
  return union > 0 ? inter / union : 0;
}

/* ── Extract text from a normBox (mirrors batch-anchor-refinement.js) ──── */

function extractTextFromNormBox(normBox, tokens, viewport) {
  if (!normBox || !tokens || !tokens.length || !viewport) {
    return { text: '', tokenCount: 0, confidence: 0 };
  }

  var vpW = viewport.width || viewport.w || 1;
  var vpH = viewport.height || viewport.h || 1;
  var bx = normBox.x0n * vpW, by = normBox.y0n * vpH;
  var bw = normBox.wN * vpW, bh = normBox.hN * vpH;

  var matched = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    var ox = Math.min(t.x + t.w, bx + bw) - Math.max(t.x, bx);
    var oy = Math.min(t.y + t.h, by + bh) - Math.max(t.y, by);
    if (ox <= 0 || oy <= 0) continue;
    // Include token if >=50% of its area overlaps, or center is inside box
    var overlapArea = ox * oy;
    var tokenArea = (t.w * t.h) || 1;
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    var centerInside = cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
    if (centerInside || (overlapArea / tokenArea) >= 0.5) {
      matched.push(t);
    }
  }

  matched.sort(function (a, b) {
    var ay = a.y + a.h / 2, by2 = b.y + b.h / 2;
    if (Math.abs(ay - by2) > Math.min(a.h, b.h) * 0.5) return ay - by2;
    return a.x - b.x;
  });

  var lines = [], curLine = [], lastY = -Infinity;
  for (var mi = 0; mi < matched.length; mi++) {
    var tk = matched[mi], tkY = tk.y + tk.h / 2;
    if (curLine.length > 0 && Math.abs(tkY - lastY) > tk.h * 0.5) {
      lines.push(curLine.map(function (t) { return t.text; }).join(' '));
      curLine = [];
    }
    curLine.push(tk); lastY = tkY;
  }
  if (curLine.length > 0) lines.push(curLine.map(function (t) { return t.text; }).join(' '));

  var text = lines.join('\n').trim();
  var avgC = matched.length > 0 ? mean(matched.map(function (t) { return t.confidence || 0.5; })) : 0;
  return { text: text, tokenCount: matched.length, confidence: round(avgC, 4) };
}

/* ── 1. Candidate Generation ─────────────────────────────────────────────── */

/**
 * Generate candidate BBOX regions for geometry optimization.
 *
 * @param {object} originalBox  - The Phase 2B transferred normBox {x0n, y0n, wN, hN}
 * @param {object} refDoc       - Reference document summary (for structural regions)
 * @returns {object[]} Array of { normBox, family, label }
 */
function generateCandidates(originalBox, refDoc) {
  var candidates = [];

  // ── Family 1: Original BBOX ──────────────────────────────────────────
  candidates.push({
    normBox: { x0n: originalBox.x0n, y0n: originalBox.y0n, wN: originalBox.wN, hN: originalBox.hN },
    family: 'original',
    label: 'Original BBOX'
  });

  // ── Family 2: Structural Region Expansion ────────────────────────────
  var regions = (refDoc && refDoc.regionDescriptors) || [];
  var boxCenter = normBoxCenter(originalBox);
  var originalArea = originalBox.wN * originalBox.hN;
  var maxExpansionArea = originalArea * 2;

  // Find the best containing/overlapping region
  var bestRegion = null;
  var bestOverlap = 0;
  for (var ri = 0; ri < regions.length; ri++) {
    var r = regions[ri];
    var rNb = { x0n: r.normalizedBbox.x, y0n: r.normalizedBbox.y, wN: r.normalizedBbox.w, hN: r.normalizedBbox.h };
    var rArea = rNb.wN * rNb.hN;
    // Skip giant page-level regions
    if (rArea > 0.4) continue;
    var overlap = normBoxIoU(originalBox, rNb);
    // Also check if center is inside region
    var centerInside = boxCenter.x >= rNb.x0n && boxCenter.x <= rNb.x0n + rNb.wN &&
                       boxCenter.y >= rNb.y0n && boxCenter.y <= rNb.y0n + rNb.hN;
    var score = overlap + (centerInside ? 0.5 : 0);
    if (score > bestOverlap && rArea <= maxExpansionArea) {
      bestOverlap = score;
      bestRegion = rNb;
    }
  }

  if (bestRegion) {
    // Expand original box toward region boundaries
    var expX = Math.min(originalBox.x0n, bestRegion.x0n);
    var expY = Math.min(originalBox.y0n, bestRegion.y0n);
    var expX1 = Math.max(originalBox.x0n + originalBox.wN, bestRegion.x0n + bestRegion.wN);
    var expY1 = Math.max(originalBox.y0n + originalBox.hN, bestRegion.y0n + bestRegion.hN);
    var expW = expX1 - expX;
    var expH = expY1 - expY;

    // Enforce 2x area limit
    if (expW * expH <= maxExpansionArea) {
      candidates.push({
        normBox: { x0n: round(expX, 6), y0n: round(expY, 6), wN: round(expW, 6), hN: round(expH, 6) },
        family: 'structural_expansion',
        label: 'Structural region expansion'
      });
    }

    // Also try a partial expansion (blend original and region boundaries)
    var blendFactor = 0.5;
    var blendX = originalBox.x0n + (expX - originalBox.x0n) * blendFactor;
    var blendY = originalBox.y0n + (expY - originalBox.y0n) * blendFactor;
    var blendX1 = (originalBox.x0n + originalBox.wN) + (expX1 - (originalBox.x0n + originalBox.wN)) * blendFactor;
    var blendY1 = (originalBox.y0n + originalBox.hN) + (expY1 - (originalBox.y0n + originalBox.hN)) * blendFactor;
    var blendW = blendX1 - blendX;
    var blendH = blendY1 - blendY;
    if (blendW * blendH <= maxExpansionArea && blendW > 0 && blendH > 0) {
      candidates.push({
        normBox: { x0n: round(blendX, 6), y0n: round(blendY, 6), wN: round(blendW, 6), hN: round(blendH, 6) },
        family: 'structural_expansion',
        label: 'Partial region expansion (50%)'
      });
    }
  }

  // ── Family 3: Local Geometry Search ──────────────────────────────────
  // Use wider search range (±30% shift, ±25% expand) to avoid missing
  // optimal positions that fall outside the previous ±20%/±15% range.
  var stepX = originalBox.wN * 0.3;
  var stepY = originalBox.hN * 0.3;
  var expandFrac = 0.25;

  // Horizontal shifts
  var shifts = [
    { dx: -stepX, dy: 0, label: 'Shift left' },
    { dx: stepX, dy: 0, label: 'Shift right' },
    { dx: 0, dy: -stepY, label: 'Shift up' },
    { dx: 0, dy: stepY, label: 'Shift down' },
    { dx: -stepX, dy: -stepY, label: 'Shift up-left' },
    { dx: stepX, dy: -stepY, label: 'Shift up-right' },
    { dx: -stepX, dy: stepY, label: 'Shift down-left' },
    { dx: stepX, dy: stepY, label: 'Shift down-right' }
  ];

  for (var si = 0; si < shifts.length; si++) {
    var s = shifts[si];
    var nx = clamp(originalBox.x0n + s.dx, 0, 1 - originalBox.wN);
    var ny = clamp(originalBox.y0n + s.dy, 0, 1 - originalBox.hN);
    candidates.push({
      normBox: { x0n: round(nx, 6), y0n: round(ny, 6), wN: originalBox.wN, hN: originalBox.hN },
      family: 'local_search',
      label: s.label
    });
  }

  // Expansion variants
  var expVariants = [
    { dw: expandFrac, dh: 0, label: 'Expand width' },
    { dw: 0, dh: expandFrac, label: 'Expand height' },
    { dw: expandFrac, dh: expandFrac, label: 'Expand both' },
    { dw: -expandFrac, dh: 0, label: 'Contract width' },
    { dw: 0, dh: -expandFrac, label: 'Contract height' },
    { dw: -expandFrac, dh: -expandFrac, label: 'Contract both' }
  ];

  for (var ei = 0; ei < expVariants.length; ei++) {
    var e = expVariants[ei];
    var ew = originalBox.wN * (1 + e.dw);
    var eh = originalBox.hN * (1 + e.dh);
    if (ew < 0.005 || eh < 0.005) continue; // Too small
    if (ew * eh > maxExpansionArea) continue; // Too large
    // Center the resize
    var ex = originalBox.x0n - (ew - originalBox.wN) / 2;
    var ey = originalBox.y0n - (eh - originalBox.hN) / 2;
    ex = clamp(ex, 0, Math.max(0, 1 - ew));
    ey = clamp(ey, 0, Math.max(0, 1 - eh));
    candidates.push({
      normBox: { x0n: round(ex, 6), y0n: round(ey, 6), wN: round(ew, 6), hN: round(eh, 6) },
      family: 'local_search',
      label: e.label
    });
  }

  // Combined shift + resize
  var combos = [
    { dx: -stepX, dw: expandFrac, label: 'Shift left + expand' },
    { dx: stepX, dw: expandFrac, label: 'Shift right + expand' },
    { dy: -stepY, dh: expandFrac, label: 'Shift up + expand' },
    { dy: stepY, dh: expandFrac, label: 'Shift down + expand' }
  ];

  for (var ci = 0; ci < combos.length; ci++) {
    var c = combos[ci];
    var cw = originalBox.wN * (1 + (c.dw || 0));
    var ch = originalBox.hN * (1 + (c.dh || 0));
    if (cw * ch > maxExpansionArea) continue;
    var cx = clamp(originalBox.x0n + (c.dx || 0) - ((cw - originalBox.wN) / 2), 0, Math.max(0, 1 - cw));
    var cy = clamp(originalBox.y0n + (c.dy || 0) - ((ch - originalBox.hN) / 2), 0, Math.max(0, 1 - ch));
    candidates.push({
      normBox: { x0n: round(cx, 6), y0n: round(cy, 6), wN: round(cw, 6), hN: round(ch, 6) },
      family: 'local_search',
      label: c.label
    });
  }

  return candidates;
}

/* ── 2. Candidate Scoring ────────────────────────────────────────────────── */

/**
 * Score a candidate region for a given field correction.
 *
 * Scoring priority:
 *   1. Anchor alignment consistency (geometry near original)
 *   2. OCR/token confidence
 *   3. Similarity to corrected reference text
 *
 * @param {object}   candidate    - { normBox, family, label }
 * @param {string}   extractedText - Text extracted from the candidate region
 * @param {number}   extractionConfidence - OCR/token confidence for the extraction
 * @param {string}   correctedText - User-provided corrected text
 * @param {object}   originalBox   - Original Phase 2B BBOX for alignment scoring
 * @param {number}   tokenCount    - Number of tokens found in region
 * @returns {object} { totalScore, alignmentScore, confidenceScore, similarityScore }
 */
function scoreCandidate(candidate, extractedText, extractionConfidence, correctedText, originalBox, tokenCount) {
  // 1. Anchor alignment consistency (40% weight)
  // Prefer candidates close to the original anchor-transferred position
  var origCenter = normBoxCenter(originalBox);
  var candCenter = normBoxCenter(candidate.normBox);
  var centerDist = pointDist(origCenter, candCenter);
  var iou = normBoxIoU(originalBox, candidate.normBox);

  // High IoU and close centers = high alignment
  var alignmentScore = iou * 0.6 + clamp(1 - centerDist / 0.15, 0, 1) * 0.4;

  // 2. OCR/token confidence (30% weight)
  var confidenceScore = 0;
  if (tokenCount > 0) {
    confidenceScore = clamp(extractionConfidence, 0, 1) * 0.7 +
      clamp(tokenCount / 5, 0, 1) * 0.3; // Bonus for finding more tokens
  }

  // 3. Text similarity to corrected value (30% weight)
  var similarityScore = textSimilarity(extractedText, correctedText);

  var totalScore = alignmentScore * 0.40 + confidenceScore * 0.30 + similarityScore * 0.30;

  return {
    totalScore: round(totalScore, 4),
    alignmentScore: round(alignmentScore, 4),
    confidenceScore: round(confidenceScore, 4),
    similarityScore: round(similarityScore, 4)
  };
}

/* ── 3. Geometry Optimization ────────────────────────────────────────────── */

/**
 * Optimize extraction geometry for a single field on a single document.
 *
 * @param {object}   fieldResult   - Field result from extractFromBatch
 * @param {string}   correctedText - User correction for this field
 * @param {object[]} tokens        - Document tokens
 * @param {object}   viewport      - Document viewport
 * @param {object}   refDoc        - Reference document summary (for structural regions)
 * @returns {object} OptimizationResult for this field
 */
function optimizeFieldGeometry(fieldResult, correctedText, tokens, viewport, refDoc) {
  var originalBox = fieldResult.transferredNormBox;

  // Generate all candidate regions
  var candidates = generateCandidates(originalBox, refDoc);

  // Evaluate each candidate
  var scored = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var cand = candidates[ci];
    var extraction = extractTextFromNormBox(cand.normBox, tokens, viewport);
    var scoring = scoreCandidate(
      cand, extraction.text, extraction.confidence, correctedText, originalBox, extraction.tokenCount
    );

    scored.push({
      normBox: cand.normBox,
      family: cand.family,
      label: cand.label,
      extractedText: extraction.text,
      tokenCount: extraction.tokenCount,
      extractionConfidence: extraction.confidence,
      totalScore: scoring.totalScore,
      alignmentScore: scoring.alignmentScore,
      confidenceScore: scoring.confidenceScore,
      similarityScore: scoring.similarityScore
    });
  }

  // Sort by total score descending
  scored.sort(function (a, b) { return b.totalScore - a.totalScore; });

  var best = scored[0] || null;
  var original = scored.find(function (s) { return s.family === 'original'; });

  // Compute offset and expansion from original to best
  var offset = null, expansion = null;
  if (best) {
    offset = {
      dx: round(best.normBox.x0n - originalBox.x0n, 6),
      dy: round(best.normBox.y0n - originalBox.y0n, 6)
    };
    expansion = {
      dw: round(best.normBox.wN - originalBox.wN, 6),
      dh: round(best.normBox.hN - originalBox.hN, 6)
    };
  }

  // Determine improvement
  var improved = best && original && best.totalScore > original.totalScore;
  var improvement = (best && original) ? round(best.totalScore - original.totalScore, 4) : 0;

  return {
    fieldKey: fieldResult.fieldKey,
    label: fieldResult.label,
    originalBox: originalBox,
    bestCandidate: best,
    originalCandidate: original,
    improved: improved,
    improvement: improvement,
    offset: offset,
    expansion: expansion,
    candidateCount: scored.length,
    topCandidates: scored.slice(0, 5),
    geometryConfidence: best ? best.totalScore : 0
  };
}

/* ── 4. Batch Geometry Learning ──────────────────────────────────────────── */

/**
 * Run geometry optimization across multiple corrected documents.
 *
 * For each field, optimizes geometry on each corrected document, then
 * aggregates to produce a consensus geometry profile.
 *
 * @param {object}   extractionResult  - Output from extractFromBatch()
 * @param {object[]} corrections       - Array of { documentId, fields: [{ fieldKey, correctedText }] }
 * @param {object}   batchTokens       - { [documentId]: { tokens, viewport } }
 * @param {object}   refDoc            - Reference document summary
 * @param {object}   [opts]
 * @returns {object} GeometryLearningResult
 */
function learnFieldGeometry(extractionResult, corrections, batchTokens, refDoc, opts) {
  opts = opts || {};

  if (!extractionResult || !extractionResult.results || !corrections || corrections.length === 0) {
    return {
      status: 'no_data',
      message: 'No extraction results or corrections provided.',
      fieldProfiles: [],
      perDocumentResults: []
    };
  }

  var targets = extractionResult.extractionTargets || [];
  var perDocumentResults = [];
  var fieldOptimizations = {}; // fieldKey → [ optimization results across docs ]

  // Initialize field optimization arrays
  for (var ti = 0; ti < targets.length; ti++) {
    fieldOptimizations[targets[ti].fieldKey] = [];
  }

  // Process each corrected document
  for (var ci = 0; ci < corrections.length; ci++) {
    var corr = corrections[ci];
    var docResult = extractionResult.results.find(function (r) { return r.documentId === corr.documentId; });
    if (!docResult) continue;

    var docTokenData = batchTokens[corr.documentId];
    if (!docTokenData) continue;

    var docOptResults = {
      documentId: corr.documentId,
      documentName: docResult.documentName,
      fields: []
    };

    for (var fi = 0; fi < corr.fields.length; fi++) {
      var fieldCorr = corr.fields[fi];
      var fieldResult = docResult.fields.find(function (f) { return f.fieldKey === fieldCorr.fieldKey; });
      if (!fieldResult) continue;

      var optResult = optimizeFieldGeometry(
        fieldResult, fieldCorr.correctedText, docTokenData.tokens, docTokenData.viewport, refDoc
      );
      docOptResults.fields.push(optResult);

      if (fieldOptimizations[fieldCorr.fieldKey]) {
        fieldOptimizations[fieldCorr.fieldKey].push(optResult);
      }
    }

    perDocumentResults.push(docOptResults);
  }

  // Aggregate per-field geometry profiles
  var fieldProfiles = [];
  for (var fk in fieldOptimizations) {
    if (!fieldOptimizations.hasOwnProperty(fk)) continue;
    var opts2 = fieldOptimizations[fk];
    if (opts2.length === 0) continue;

    var target = targets.find(function (t) { return t.fieldKey === fk; });

    // Compute consensus offset/expansion using confidence-weighted averages
    // so that higher-confidence corrections have more influence.
    var totalWeight = 0;
    var wDx = 0, wDy = 0, wDw = 0, wDh = 0, wConf = 0;
    for (var wi = 0; wi < opts2.length; wi++) {
      var optW = Math.max(opts2[wi].geometryConfidence, 0.01); // avoid zero weight
      totalWeight += optW;
      wDx += (opts2[wi].offset ? opts2[wi].offset.dx : 0) * optW;
      wDy += (opts2[wi].offset ? opts2[wi].offset.dy : 0) * optW;
      wDw += (opts2[wi].expansion ? opts2[wi].expansion.dw : 0) * optW;
      wDh += (opts2[wi].expansion ? opts2[wi].expansion.dh : 0) * optW;
      wConf += opts2[wi].geometryConfidence * optW;
    }
    var avgDx = totalWeight > 0 ? wDx / totalWeight : 0;
    var avgDy = totalWeight > 0 ? wDy / totalWeight : 0;
    var avgDw = totalWeight > 0 ? wDw / totalWeight : 0;
    var avgDh = totalWeight > 0 ? wDh / totalWeight : 0;
    var avgConf = totalWeight > 0 ? wConf / totalWeight : 0;
    var improvedCount = opts2.filter(function (o) { return o.improved; }).length;

    // Find the dominant winning family
    var familyCounts = {};
    for (var oi = 0; oi < opts2.length; oi++) {
      var bf = opts2[oi].bestCandidate ? opts2[oi].bestCandidate.family : 'original';
      familyCounts[bf] = (familyCounts[bf] || 0) + 1;
    }
    var dominantFamily = 'original';
    var maxFamilyCount = 0;
    for (var fam in familyCounts) {
      if (familyCounts[fam] > maxFamilyCount) {
        maxFamilyCount = familyCounts[fam];
        dominantFamily = fam;
      }
    }

    // Build anchor neighborhood summary from ref doc
    var anchorNeighborhood = null;
    if (refDoc && target) {
      var tCenter = normBoxCenter(target.normBox);
      var nearbyRegions = (refDoc.regionDescriptors || []).filter(function (r) {
        var d = pointDist(tCenter, r.centroid);
        return d < 0.2;
      });
      anchorNeighborhood = {
        nearbyRegionCount: nearbyRegions.length,
        nearbyRegionTypes: nearbyRegions.map(function (r) { return r.surfaceType; }),
        avgDistance: nearbyRegions.length > 0 ? round(mean(nearbyRegions.map(function (r) { return pointDist(tCenter, r.centroid); })), 4) : 0
      };
    }

    fieldProfiles.push({
      fieldKey: fk,
      label: target ? target.label : fk,
      originalBox: target ? target.normBox : null,
      preferredOffset: { dx: round(avgDx, 6), dy: round(avgDy, 6) },
      preferredExpansion: { dw: round(avgDw, 6), dh: round(avgDh, 6) },
      geometryConfidence: round(avgConf, 4),
      dominantFamily: dominantFamily,
      correctionCount: opts2.length,
      improvedCount: improvedCount,
      anchorNeighborhood: anchorNeighborhood,
      learnedAt: new Date().toISOString()
    });
  }

  var totalImproved = fieldProfiles.reduce(function (s, p) { return s + p.improvedCount; }, 0);
  var totalCorrections = fieldProfiles.reduce(function (s, p) { return s + p.correctionCount; }, 0);

  return {
    status: totalImproved > 0 ? 'improved' : 'no_improvement',
    message: totalImproved > 0
      ? 'Geometry improved for ' + totalImproved + ' of ' + totalCorrections + ' field corrections across ' + fieldProfiles.length + ' field(s).'
      : 'No geometry improvement found. The original BBOX positions are already optimal for the given corrections.',
    fieldProfiles: fieldProfiles,
    perDocumentResults: perDocumentResults,
    correctionDocCount: corrections.length,
    learnedAt: new Date().toISOString()
  };
}

/* ── 5. Apply Learned Geometry ───────────────────────────────────────────── */

/**
 * Apply learned geometry refinements to a transferred BBOX.
 *
 * Used during extraction: after Phase 2B transfers the BBOX, apply the
 * learned offset/expansion to refine the extraction region.
 *
 * @param {object} transferredBox - Phase 2B transferred normBox
 * @param {object} fieldProfile   - Geometry profile from learnFieldGeometry
 * @returns {object} { refinedBox, applied }
 */
function applyGeometryProfile(transferredBox, fieldProfile) {
  if (!fieldProfile || !fieldProfile.preferredOffset || fieldProfile.geometryConfidence < 0.1) {
    return { refinedBox: transferredBox, applied: false };
  }

  var newX = transferredBox.x0n + fieldProfile.preferredOffset.dx;
  var newY = transferredBox.y0n + fieldProfile.preferredOffset.dy;
  var newW = transferredBox.wN + fieldProfile.preferredExpansion.dw;
  var newH = transferredBox.hN + fieldProfile.preferredExpansion.dh;

  // Clamp to page bounds
  newW = clamp(newW, 0.005, 1);
  newH = clamp(newH, 0.005, 1);
  newX = clamp(newX, 0, Math.max(0, 1 - newW));
  newY = clamp(newY, 0, Math.max(0, 1 - newH));

  return {
    refinedBox: { x0n: round(newX, 6), y0n: round(newY, 6), wN: round(newW, 6), hN: round(newH, 6) },
    applied: true
  };
}

/* ── 6. Report Formatter ─────────────────────────────────────────────────── */

function formatGeometryReport(result) {
  if (!result) return '[No geometry learning data]';
  if (result.status === 'no_data') return result.message;

  var out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  FIELD INTELLIGENCE REPORT (Phase 3A)\n';
  out += '══════════════════════════════════════════════════════════════\n\n';
  out += '  Status: ' + result.status.toUpperCase().replace(/_/g, ' ') + '\n';
  out += '  ' + result.message + '\n';
  out += '  Corrected Documents: ' + result.correctionDocCount + '\n';

  if (result.fieldProfiles && result.fieldProfiles.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  FIELD GEOMETRY PROFILES\n';
    out += '──────────────────────────────────────────────────────────────\n';

    for (var pi = 0; pi < result.fieldProfiles.length; pi++) {
      var p = result.fieldProfiles[pi];
      out += '\n  ' + p.label + ' (' + p.fieldKey + ')\n';
      out += '    Offset: dx=' + (p.preferredOffset.dx * 100).toFixed(2) + '%, dy=' + (p.preferredOffset.dy * 100).toFixed(2) + '%\n';
      out += '    Expansion: dw=' + (p.preferredExpansion.dw * 100).toFixed(2) + '%, dh=' + (p.preferredExpansion.dh * 100).toFixed(2) + '%\n';
      out += '    Confidence: ' + (p.geometryConfidence * 100).toFixed(1) + '%\n';
      out += '    Best Family: ' + p.dominantFamily.replace(/_/g, ' ') + '\n';
      out += '    Improved: ' + p.improvedCount + '/' + p.correctionCount + ' corrections\n';
    }
  }

  if (result.perDocumentResults && result.perDocumentResults.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  PER-DOCUMENT DETAILS\n';
    out += '──────────────────────────────────────────────────────────────\n';

    for (var di = 0; di < result.perDocumentResults.length; di++) {
      var dr = result.perDocumentResults[di];
      out += '\n  ' + dr.documentName + '\n';
      for (var fi = 0; fi < dr.fields.length; fi++) {
        var f = dr.fields[fi];
        out += '    ' + f.label + ': ';
        if (f.improved) {
          out += 'IMPROVED (+'  + (f.improvement * 100).toFixed(1) + '%) → ' + (f.bestCandidate ? f.bestCandidate.family.replace(/_/g, ' ') : '') + '\n';
        } else {
          out += 'no improvement (original optimal)\n';
        }
      }
    }
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  learnFieldGeometry,
  optimizeFieldGeometry,
  generateCandidates,
  scoreCandidate,
  applyGeometryProfile,
  formatGeometryReport,
  // Expose helpers for testing
  textSimilarity,
  levenshteinDistance,
  tokenOverlap
};
