'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  spatial-transform-estimator.js  –  Spatial Transformation Estimation
  ─────────────────────────────────────────────────────────────────────────────

  Estimates a spatial transformation model between a reference document and
  a target document using matched anchor correspondences.

  ─── What it does ─────────────────────────────────────────────────────────

  1. Takes matched anchor pairs (reference position → target position)
  2. Estimates a best-fit affine transformation (translation, scale, rotation, skew)
  3. Analyzes transform coherence (residual analysis, outlier detection)
  4. Provides per-field local transforms using spatially-weighted anchor subsets
  5. Warps BBOX coordinates through the estimated transform

  ─── Transform Model ─────────────────────────────────────────────────────

  Affine transform:  [x']   [a  b  tx] [x]
                     [y'] = [c  d  ty] [y]
                     [1 ]   [0  0  1 ] [1]

  Where:
    a, d = scale factors (with possible rotation component)
    b, c = shear/rotation components
    tx, ty = translation

  Estimated via least-squares from anchor correspondences.

  ─── Coherence Analysis ──────────────────────────────────────────────────

  After estimation, computes:
  - Per-anchor residuals (predicted vs actual target position)
  - Median Absolute Deviation (MAD) of residuals
  - Outlier detection (residuals > 3 × MAD)
  - RANSAC-like iterative refinement if outliers detected
  - Global coherence score

  ─── Local Transforms ───────────────────────────────────────────────────

  For each field BBOX, estimates a spatially-weighted local transform using
  only nearby anchors, with distance-based weighting. This handles piecewise
  deformation where different parts of the page may have shifted differently.

───────────────────────────────────────────────────────────────────────────────*/

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(v, dec) {
  var f = Math.pow(10, dec || 4);
  return Math.round(v * f) / f;
}

function mean(arr) {
  return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
}

function median(arr) {
  if (!arr.length) return 0;
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pointDist(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

/* ── 1. Affine Transform Estimation (Least-Squares) ──────────────────────── */

/**
 * Estimate the best-fit affine transform from a set of point correspondences
 * using weighted least squares.
 *
 * The affine model has 6 parameters: [a, b, tx, c, d, ty]
 * such that:
 *   x' = a*x + b*y + tx
 *   y' = c*x + d*y + ty
 *
 * We solve via the normal equations: (A^T W A) params = A^T W b
 *
 * @param {object[]} pairs - Array of { src: {x,y}, dst: {x,y}, weight: number }
 * @returns {object|null} { a, b, c, d, tx, ty } or null if underdetermined
 */
function estimateAffineTransform(pairs) {
  if (!pairs || pairs.length < 3) {
    // Need at least 3 non-collinear points for a full affine.
    // With fewer, fall back to similarity (translation + uniform scale)
    if (pairs && pairs.length >= 1) {
      return estimateSimilarityTransform(pairs);
    }
    return null;
  }

  // Build the weighted normal equations for 6 parameters
  // For each pair: x' = a*x + b*y + tx,  y' = c*x + d*y + ty
  // We solve two independent 3-parameter systems:
  //   System 1 (for a, b, tx):  x' = a*x + b*y + tx
  //   System 2 (for c, d, ty):  y' = c*x + d*y + ty

  var n = pairs.length;

  // Accumulate for system 1: x' = a*x + b*y + tx
  var sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, sw = 0;
  var sxX = 0, syX = 0, sX = 0; // X is dst.x
  var sxY = 0, syY = 0, sY = 0; // Y is dst.y

  for (var i = 0; i < n; i++) {
    var p = pairs[i];
    var w = p.weight || 1;
    var x = p.src.x, y = p.src.y;
    var X = p.dst.x, Y = p.dst.y;

    sxx += w * x * x;
    sxy += w * x * y;
    sx += w * x;
    syy += w * y * y;
    sy += w * y;
    sw += w;

    sxX += w * x * X;
    syX += w * y * X;
    sX += w * X;

    sxY += w * x * Y;
    syY += w * y * Y;
    sY += w * Y;
  }

  // System 1: [sxx sxy sx] [a ]   [sxX]
  //           [sxy syy sy] [b ] = [syX]
  //           [sx  sy  sw] [tx]   [sX ]
  var params1 = solve3x3(
    sxx, sxy, sx,
    sxy, syy, sy,
    sx, sy, sw,
    sxX, syX, sX
  );

  // System 2: [sxx sxy sx] [c ]   [sxY]
  //           [sxy syy sy] [d ] = [syY]
  //           [sx  sy  sw] [ty]   [sY ]
  var params2 = solve3x3(
    sxx, sxy, sx,
    sxy, syy, sy,
    sx, sy, sw,
    sxY, syY, sY
  );

  if (!params1 || !params2) {
    // Singular matrix — fall back to similarity
    return estimateSimilarityTransform(pairs);
  }

  return {
    a: params1[0],
    b: params1[1],
    tx: params1[2],
    c: params2[0],
    d: params2[1],
    ty: params2[2]
  };
}

/**
 * Solve a 3x3 linear system using Cramer's rule.
 * Returns [x1, x2, x3] or null if determinant is near zero.
 */
function solve3x3(a11, a12, a13, a21, a22, a23, a31, a32, a33, b1, b2, b3) {
  var det = a11 * (a22 * a33 - a23 * a32) -
    a12 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * a32 - a22 * a31);

  if (Math.abs(det) < 1e-12) return null;

  var x1 = (b1 * (a22 * a33 - a23 * a32) -
    a12 * (b2 * a33 - a23 * b3) +
    a13 * (b2 * a32 - a22 * b3)) / det;

  var x2 = (a11 * (b2 * a33 - a23 * b3) -
    b1 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * b3 - b2 * a31)) / det;

  var x3 = (a11 * (a22 * b3 - b2 * a32) -
    a12 * (a21 * b3 - b2 * a31) +
    b1 * (a21 * a32 - a22 * a31)) / det;

  return [x1, x2, x3];
}

/**
 * Fallback: estimate a similarity transform (translation + uniform scale)
 * from 1-2 point pairs.
 */
function estimateSimilarityTransform(pairs) {
  if (!pairs || pairs.length === 0) return null;

  if (pairs.length === 1) {
    // Pure translation
    var p = pairs[0];
    return {
      a: 1, b: 0,
      c: 0, d: 1,
      tx: p.dst.x - p.src.x,
      ty: p.dst.y - p.src.y
    };
  }

  // 2+ pairs: estimate translation + scale
  var totalW = 0;
  var avgSrcX = 0, avgSrcY = 0, avgDstX = 0, avgDstY = 0;
  for (var i = 0; i < pairs.length; i++) {
    var w = pairs[i].weight || 1;
    avgSrcX += pairs[i].src.x * w;
    avgSrcY += pairs[i].src.y * w;
    avgDstX += pairs[i].dst.x * w;
    avgDstY += pairs[i].dst.y * w;
    totalW += w;
  }
  avgSrcX /= totalW; avgSrcY /= totalW;
  avgDstX /= totalW; avgDstY /= totalW;

  // Compute scale from average distances to centroid
  var srcDistSum = 0, dstDistSum = 0;
  for (var j = 0; j < pairs.length; j++) {
    var wj = pairs[j].weight || 1;
    srcDistSum += wj * Math.sqrt(
      Math.pow(pairs[j].src.x - avgSrcX, 2) +
      Math.pow(pairs[j].src.y - avgSrcY, 2)
    );
    dstDistSum += wj * Math.sqrt(
      Math.pow(pairs[j].dst.x - avgDstX, 2) +
      Math.pow(pairs[j].dst.y - avgDstY, 2)
    );
  }

  var scale = srcDistSum > 1e-8 ? dstDistSum / srcDistSum : 1;
  scale = clamp(scale, 0.7, 1.5); // Safety clamp

  return {
    a: scale, b: 0,
    c: 0, d: scale,
    tx: avgDstX - scale * avgSrcX,
    ty: avgDstY - scale * avgSrcY
  };
}

/* ── 2. Transform Application ────────────────────────────────────────────── */

/**
 * Apply an affine transform to a point.
 */
function transformPoint(transform, point) {
  return {
    x: transform.a * point.x + transform.b * point.y + transform.tx,
    y: transform.c * point.x + transform.d * point.y + transform.ty
  };
}

/**
 * Apply an affine transform to a normBox {x0n, y0n, wN, hN}.
 *
 * Transforms all 4 corners, then takes the axis-aligned bounding box
 * of the result (handles rotation/skew correctly).
 */
function transformNormBox(transform, normBox) {
  var corners = [
    { x: normBox.x0n, y: normBox.y0n },
    { x: normBox.x0n + normBox.wN, y: normBox.y0n },
    { x: normBox.x0n + normBox.wN, y: normBox.y0n + normBox.hN },
    { x: normBox.x0n, y: normBox.y0n + normBox.hN }
  ];

  var transformed = corners.map(function (c) { return transformPoint(transform, c); });

  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < transformed.length; i++) {
    if (transformed[i].x < minX) minX = transformed[i].x;
    if (transformed[i].y < minY) minY = transformed[i].y;
    if (transformed[i].x > maxX) maxX = transformed[i].x;
    if (transformed[i].y > maxY) maxY = transformed[i].y;
  }

  return {
    x0n: clamp(minX, 0, 1),
    y0n: clamp(minY, 0, 1),
    wN: clamp(maxX - minX, 0.001, 1),
    hN: clamp(maxY - minY, 0.001, 1)
  };
}

/* ── 3. Coherence Analysis & Outlier Rejection ───────────────────────────── */

/**
 * Analyze the coherence of a transform model against its anchor pairs.
 *
 * Computes residuals (predicted vs actual target position) for each anchor,
 * then detects outliers using Median Absolute Deviation (MAD).
 *
 * @param {object}   transform - Affine transform {a,b,c,d,tx,ty}
 * @param {object[]} pairs     - Anchor pairs [{src, dst, weight, anchorId}]
 * @param {number}   [madThreshold=3] - Outlier threshold in MAD units
 * @returns {object} CoherenceAnalysis
 */
function analyzeTransformCoherence(transform, pairs, madThreshold) {
  if (!transform || !pairs || pairs.length === 0) {
    return { coherenceScore: 0, residuals: [], outliers: [], inliers: pairs || [] };
  }
  madThreshold = madThreshold || 3;

  var residuals = [];
  for (var i = 0; i < pairs.length; i++) {
    var predicted = transformPoint(transform, pairs[i].src);
    var actual = pairs[i].dst;
    var residual = pointDist(predicted, actual);
    residuals.push({
      index: i,
      anchorId: pairs[i].anchorId || null,
      predicted: predicted,
      actual: actual,
      residual: residual
    });
  }

  var residualValues = residuals.map(function (r) { return r.residual; });
  var medianResidual = median(residualValues);

  // MAD = median(|residual - median(residual)|)
  var absDeviations = residualValues.map(function (r) { return Math.abs(r - medianResidual); });
  var mad = median(absDeviations);
  // Scale MAD to be comparable to standard deviation (for normal distributions)
  var scaledMAD = mad * 1.4826;

  var outliers = [];
  var inliers = [];
  for (var j = 0; j < residuals.length; j++) {
    var isOutlier = scaledMAD > 1e-6 && residuals[j].residual > medianResidual + madThreshold * scaledMAD;
    residuals[j].isOutlier = isOutlier;
    if (isOutlier) {
      outliers.push(pairs[j]);
    } else {
      inliers.push(pairs[j]);
    }
  }

  // Coherence score: based on median residual and outlier ratio
  // Low residual + few outliers = high coherence
  var residualScore = clamp(1 - medianResidual / 0.05, 0, 1); // 5% page distance = score 0
  var outlierRatio = pairs.length > 0 ? outliers.length / pairs.length : 0;
  var outlierScore = clamp(1 - outlierRatio * 2, 0, 1); // >50% outliers = score 0
  var coherenceScore = residualScore * 0.6 + outlierScore * 0.4;

  return {
    coherenceScore: round(coherenceScore),
    medianResidual: round(medianResidual, 6),
    mad: round(scaledMAD, 6),
    outlierCount: outliers.length,
    inlierCount: inliers.length,
    residuals: residuals,
    outliers: outliers,
    inliers: inliers
  };
}

/* ── 4. RANSAC-Like Iterative Refinement ─────────────────────────────────── */

/**
 * Iteratively refine the affine transform by removing outliers and
 * re-estimating until stable.
 *
 * @param {object[]} pairs - All anchor pairs
 * @param {number}   [maxIterations=3]
 * @param {number}   [madThreshold=3]
 * @returns {object} { transform, coherence, iterations, usedPairs }
 */
function estimateRobustTransform(pairs, maxIterations, madThreshold) {
  maxIterations = maxIterations || 3;
  madThreshold = madThreshold || 3;

  if (!pairs || pairs.length === 0) {
    return { transform: null, coherence: null, iterations: 0, usedPairs: [] };
  }

  var currentPairs = pairs.slice();
  var transform = null;
  var coherence = null;

  for (var iter = 0; iter < maxIterations; iter++) {
    transform = estimateAffineTransform(currentPairs);
    if (!transform) break;

    coherence = analyzeTransformCoherence(transform, currentPairs, madThreshold);

    // If no outliers or coherence is high enough, stop
    if (coherence.outlierCount === 0 || coherence.coherenceScore > 0.9) break;

    // Remove outliers and re-estimate (but keep at least 3 pairs for affine)
    if (coherence.inliers.length >= 3) {
      currentPairs = coherence.inliers;
    } else if (coherence.inliers.length >= 1) {
      // Fall back to similarity transform with inliers
      currentPairs = coherence.inliers;
    } else {
      break;
    }
  }

  return {
    transform: transform,
    coherence: coherence,
    iterations: iter + 1,
    usedPairs: currentPairs
  };
}

/* ── 5. Field-Local Transform Estimation ─────────────────────────────────── */

/**
 * Estimate a spatially-weighted local transform for a specific field BBOX.
 *
 * Uses distance-based weighting so nearby anchors have more influence.
 * This handles piecewise deformation where different parts of the page
 * may have shifted differently.
 *
 * @param {object}   fieldNormBox - Field BBOX in reference coordinates {x0n, y0n, wN, hN}
 * @param {object[]} pairs        - All anchor pairs with positions
 * @param {object}   globalTransform - The global affine transform (fallback)
 * @param {object}   [opts]
 * @param {number}   [opts.localRadius=0.2]    - Radius for local weighting (fraction of page)
 * @param {number}   [opts.minLocalPairs=2]    - Min pairs for local estimate
 * @param {number}   [opts.globalBlend=0.3]    - Blend factor for global transform
 * @returns {object} { localTransform, blendedTransform, localPairCount, isLocal }
 */
function estimateLocalTransform(fieldNormBox, pairs, globalTransform, opts) {
  opts = opts || {};
  var localRadius = opts.localRadius || 0.2;
  var minLocalPairs = opts.minLocalPairs || 2;
  var globalBlend = opts.globalBlend || 0.3;

  var fieldCenter = {
    x: fieldNormBox.x0n + fieldNormBox.wN / 2,
    y: fieldNormBox.y0n + fieldNormBox.hN / 2
  };

  if (!pairs || pairs.length === 0) {
    return {
      localTransform: globalTransform,
      blendedTransform: globalTransform,
      localPairCount: 0,
      isLocal: false
    };
  }

  // Compute distance-weighted pairs
  var weightedPairs = [];
  for (var i = 0; i < pairs.length; i++) {
    var dist = pointDist(fieldCenter, pairs[i].src);
    // Gaussian-like weighting: nearby anchors contribute more
    var spatialWeight = Math.exp(-Math.pow(dist / localRadius, 2));
    // Combine with original weight
    var combinedWeight = spatialWeight * (pairs[i].weight || 1);

    if (combinedWeight > 0.01) {
      weightedPairs.push({
        src: pairs[i].src,
        dst: pairs[i].dst,
        weight: combinedWeight,
        anchorId: pairs[i].anchorId
      });
    }
  }

  if (weightedPairs.length < minLocalPairs) {
    return {
      localTransform: globalTransform,
      blendedTransform: globalTransform,
      localPairCount: weightedPairs.length,
      isLocal: false
    };
  }

  var localTransform = estimateAffineTransform(weightedPairs);
  if (!localTransform) {
    return {
      localTransform: globalTransform,
      blendedTransform: globalTransform,
      localPairCount: weightedPairs.length,
      isLocal: false
    };
  }

  // Blend local and global transforms
  // Near many anchors → trust local more; sparse anchors → trust global more
  var localConfidence = clamp(weightedPairs.length / 5, 0, 1); // 5+ local pairs = full confidence
  var localWeight = (1 - globalBlend) * localConfidence + (1 - localConfidence) * 0;
  var globalWeight = 1 - localWeight;

  var blended = {
    a: localTransform.a * localWeight + globalTransform.a * globalWeight,
    b: localTransform.b * localWeight + globalTransform.b * globalWeight,
    c: localTransform.c * localWeight + globalTransform.c * globalWeight,
    d: localTransform.d * localWeight + globalTransform.d * globalWeight,
    tx: localTransform.tx * localWeight + globalTransform.tx * globalWeight,
    ty: localTransform.ty * localWeight + globalTransform.ty * globalWeight
  };

  return {
    localTransform: localTransform,
    blendedTransform: blended,
    localPairCount: weightedPairs.length,
    isLocal: true,
    localConfidence: round(localConfidence),
    localWeight: round(localWeight)
  };
}

/* ── 6. Build Anchor Pairs from Correspondence Data ──────────────────────── */

/**
 * Build point-pair correspondences from Phase 2 anchors and correspondences.
 *
 * @param {object[]} refinedAnchors      - Refined anchors with normalizedPosition/normalizedBbox
 * @param {object[]} correspondences     - Phase 2 correspondences
 * @param {string}   targetDocId         - Target document ID
 * @param {object}   targetDoc           - Target document summary (with regionDescriptors)
 * @returns {object[]} Array of { src: {x,y}, dst: {x,y}, weight, anchorId, refBbox, tgtBbox }
 */
function buildAnchorPairs(refinedAnchors, correspondences, targetDocId, targetDoc) {
  var docCorrespondences = (correspondences || []).filter(
    function (c) { return c.tgtDocumentId === targetDocId; }
  );
  var tgtRegions = targetDoc.regionDescriptors || [];

  var pairs = [];
  for (var ai = 0; ai < refinedAnchors.length; ai++) {
    var anchor = refinedAnchors[ai];

    // Find correspondence for this anchor in target doc
    var match = null;
    for (var ci = 0; ci < docCorrespondences.length; ci++) {
      if (docCorrespondences[ci].refRegionId === anchor.refRegionId) {
        match = docCorrespondences[ci];
        break;
      }
    }
    if (!match) continue;

    // Find target region
    var tgtRegion = null;
    for (var ri = 0; ri < tgtRegions.length; ri++) {
      if (tgtRegions[ri].regionId === match.tgtRegionId) {
        tgtRegion = tgtRegions[ri];
        break;
      }
    }
    if (!tgtRegion) continue;

    pairs.push({
      src: { x: anchor.normalizedPosition.x, y: anchor.normalizedPosition.y },
      dst: { x: tgtRegion.centroid.x, y: tgtRegion.centroid.y },
      weight: (anchor.relevanceScore || 0.5) * (match.similarity || 0.5),
      anchorId: anchor.anchorId,
      matchSimilarity: match.similarity,
      refBbox: anchor.normalizedBbox,
      tgtBbox: tgtRegion.normalizedBbox
    });
  }

  return pairs;
}

/* ── 7. Full Transform Pipeline ──────────────────────────────────────────── */

/**
 * Estimate a complete spatial transform model for a target document.
 *
 * This is the main entry point used by the BBOX transfer pipeline.
 *
 * @param {object[]} refinedAnchors      - Refined anchors
 * @param {object}   correspondenceResult - Phase 2 correspondence output
 * @param {string}   targetDocId          - Target document ID
 * @param {object}   targetDoc            - Target document summary
 * @returns {object} SpatialTransformModel
 */
function estimateSpatialTransform(refinedAnchors, correspondenceResult, targetDocId, targetDoc) {
  // Step 1: Build anchor pairs
  var pairs = buildAnchorPairs(
    refinedAnchors,
    correspondenceResult.correspondences,
    targetDocId,
    targetDoc
  );

  if (pairs.length === 0) {
    return {
      status: 'no_pairs',
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, // identity
      coherence: { coherenceScore: 0 },
      pairCount: 0,
      isIdentity: true,
      diagnostics: { message: 'No anchor pairs found for target document' }
    };
  }

  // Step 2: Estimate robust global transform
  var result = estimateRobustTransform(pairs, 3, 3);

  if (!result.transform) {
    return {
      status: 'estimation_failed',
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      coherence: { coherenceScore: 0 },
      pairCount: pairs.length,
      isIdentity: true,
      diagnostics: { message: 'Transform estimation failed — using identity' }
    };
  }

  // Step 3: Decompose transform for diagnostics
  var decomposed = decomposeAffine(result.transform);

  // Step 4: Sanity check — reject transforms that are too extreme
  var sane = true;
  if (Math.abs(decomposed.scaleX - 1) > 0.5 || Math.abs(decomposed.scaleY - 1) > 0.5) sane = false;
  if (Math.abs(decomposed.rotation) > 15) sane = false; // >15 degrees
  if (Math.abs(decomposed.translateX) > 0.3 || Math.abs(decomposed.translateY) > 0.3) sane = false;

  if (!sane) {
    // Fall back to simpler model (translation + scale only)
    var simpleTransform = estimateSimilarityTransform(result.usedPairs);
    var simpleCoherence = analyzeTransformCoherence(simpleTransform, result.usedPairs);
    var simpleDecomposed = decomposeAffine(simpleTransform);
    return {
      status: 'simplified',
      transform: simpleTransform,
      coherence: simpleCoherence,
      pairCount: result.usedPairs.length,
      pairs: result.usedPairs,
      isIdentity: false,
      decomposed: simpleDecomposed,
      iterations: result.iterations,
      diagnostics: {
        message: 'Full affine was too extreme — fell back to similarity transform',
        originalDecomposed: decomposed
      }
    };
  }

  return {
    status: 'estimated',
    transform: result.transform,
    coherence: result.coherence,
    pairCount: result.usedPairs.length,
    pairs: result.usedPairs,
    isIdentity: false,
    decomposed: decomposed,
    iterations: result.iterations,
    diagnostics: null
  };
}

/**
 * Decompose an affine transform into interpretable components.
 */
function decomposeAffine(t) {
  if (!t) return null;
  var scaleX = Math.sqrt(t.a * t.a + t.c * t.c);
  var scaleY = Math.sqrt(t.b * t.b + t.d * t.d);
  var rotation = Math.atan2(t.c, t.a) * 180 / Math.PI;
  var skew = Math.atan2(t.b, t.d) * 180 / Math.PI + rotation;

  return {
    translateX: round(t.tx, 6),
    translateY: round(t.ty, 6),
    scaleX: round(scaleX, 6),
    scaleY: round(scaleY, 6),
    rotation: round(rotation, 4),
    skew: round(skew, 4)
  };
}

/* ── 8. Diagnostic Report ────────────────────────────────────────────────── */

function formatTransformReport(model) {
  if (!model) return '[No transform model]';

  var out = '';
  out += '──────────────────────────────────────────────────────────────\n';
  out += '  SPATIAL TRANSFORM MODEL\n';
  out += '──────────────────────────────────────────────────────────────\n\n';
  out += '  Status: ' + (model.status || 'unknown').toUpperCase() + '\n';
  out += '  Anchor Pairs Used: ' + model.pairCount + '\n';

  if (model.coherence) {
    out += '  Coherence Score: ' + (model.coherence.coherenceScore * 100).toFixed(1) + '%\n';
    if (model.coherence.medianResidual != null) {
      out += '  Median Residual: ' + (model.coherence.medianResidual * 100).toFixed(3) + '% of page\n';
    }
    if (model.coherence.outlierCount != null) {
      out += '  Outliers: ' + model.coherence.outlierCount + ' / ' +
        (model.coherence.inlierCount + model.coherence.outlierCount) + '\n';
    }
  }

  if (model.decomposed) {
    out += '\n  Transform Decomposition:\n';
    out += '    Translation: (' + (model.decomposed.translateX * 100).toFixed(2) + '%, ' +
      (model.decomposed.translateY * 100).toFixed(2) + '%)\n';
    out += '    Scale: (' + model.decomposed.scaleX.toFixed(4) + ', ' +
      model.decomposed.scaleY.toFixed(4) + ')\n';
    out += '    Rotation: ' + model.decomposed.rotation.toFixed(2) + ' deg\n';
    if (Math.abs(model.decomposed.skew) > 0.1) {
      out += '    Skew: ' + model.decomposed.skew.toFixed(2) + ' deg\n';
    }
  }

  if (model.isIdentity) {
    out += '\n  WARNING: Using identity transform (no spatial correction)\n';
  }

  if (model.diagnostics && model.diagnostics.message) {
    out += '\n  Diagnostics: ' + model.diagnostics.message + '\n';
  }

  out += '──────────────────────────────────────────────────────────────\n';
  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  estimateAffineTransform,
  estimateSimilarityTransform,
  estimateRobustTransform,
  estimateSpatialTransform,
  estimateLocalTransform,
  buildAnchorPairs,
  transformPoint,
  transformNormBox,
  analyzeTransformCoherence,
  decomposeAffine,
  formatTransformReport
};
