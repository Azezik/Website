'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  batch-anchor-refinement.js  –  Phase 2B: Refine Anchors + BBOX-Guided
                                  Extraction
  ─────────────────────────────────────────────────────────────────────────────

  Operates on top of Phase 2 correspondence results to refine anchors based
  on user-drawn BBOX extraction targets.

  ─── What it does ─────────────────────────────────────────────────────────

  1. Takes user-drawn BBOX extraction targets (normalized coordinates)
  2. Computes local structural neighborhoods around each target
  3. Scores each Phase 2 anchor by its relevance to target neighborhoods
  4. Produces a refined anchor set that is target-aware
  5. Uses refined anchors to transfer extraction targets across batch docs
  6. Extracts text from transferred target regions

  ─── Config / field representation ────────────────────────────────────────

  Extraction targets follow the same schema used by WrokitVision config:
    {
      fieldKey:  string,        // canonical key
      label:     string,        // display name
      normBox:   { x0n, y0n, wN, hN },  // normalized 0-1 coordinates
      fieldType: 'static'
    }

  This mirrors the real SkinV2 config pipeline so Phase 2B can later
  inform or replace the standard config/run behavior.

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

/** Euclidean distance between two {x,y} points in normalized space. */
function pointDist(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

/** Center of a normalized bbox {x0n, y0n, wN, hN}. */
function normBoxCenter(nb) {
  return { x: nb.x0n + nb.wN / 2, y: nb.y0n + nb.hN / 2 };
}

/** Convert a region descriptor's normalizedBbox {x, y, w, h} to normBox format. */
function regionToNormBox(rd) {
  var b = rd.normalizedBbox;
  return { x0n: b.x, y0n: b.y, wN: b.w, hN: b.h };
}

/** IoU between two normBox objects. */
function normBoxIoU(a, b) {
  var ax0 = a.x0n, ay0 = a.y0n, ax1 = a.x0n + a.wN, ay1 = a.y0n + a.hN;
  var bx0 = b.x0n, by0 = b.y0n, bx1 = b.x0n + b.wN, by1 = b.y0n + b.hN;
  var ix0 = Math.max(ax0, bx0), iy0 = Math.max(ay0, by0);
  var ix1 = Math.min(ax1, bx1), iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  var inter = (ix1 - ix0) * (iy1 - iy0);
  var union = a.wN * a.hN + b.wN * b.hN - inter;
  return union > 0 ? inter / union : 0;
}

/* ── 1. Local Neighborhood Computation ───────────────────────────────────── */

/**
 * For a user-drawn BBOX target, compute its local structural neighborhood
 * from the reference document's region descriptors.
 *
 * The neighborhood captures which regions are near, overlapping, or
 * structurally related to the target — providing context for anchor scoring.
 *
 * @param {object} target - { fieldKey, label, normBox: {x0n,y0n,wN,hN} }
 * @param {object} refDoc - Reference document summary (full)
 * @returns {object} Neighborhood descriptor
 */
function computeTargetNeighborhood(target, refDoc) {
  var nb = target.normBox;
  var tgtCenter = normBoxCenter(nb);
  var regions = refDoc.regionDescriptors || [];
  var nhDescs = refDoc.neighborhoodDescriptors || {};

  var neighbors = [];
  for (var i = 0; i < regions.length; i++) {
    var r = regions[i];
    var rNb = regionToNormBox(r);
    var rCenter = r.centroid;
    var dist = pointDist(tgtCenter, rCenter);
    var overlap = normBoxIoU(nb, rNb);

    // Compute proximity score: nearby and overlapping regions rank higher
    var proxScore = clamp(1 - dist / 0.5, 0, 1);     // within ~50% of page
    var overlapScore = overlap > 0 ? 0.5 + overlap * 0.5 : 0;
    var combinedProximity = Math.max(proxScore, overlapScore);

    if (combinedProximity > 0.05) {
      neighbors.push({
        regionId: r.regionId,
        centroid: rCenter,
        normalizedBbox: r.normalizedBbox,
        normalizedArea: r.normalizedArea,
        surfaceType: r.surfaceType,
        textDensity: r.textDensity,
        confidence: r.confidence,
        distance: round(dist, 4),
        overlap: round(overlap, 4),
        proximity: round(combinedProximity, 4),
        neighborhoodDescriptor: nhDescs[r.regionId] || {}
      });
    }
  }

  // Sort by proximity descending
  neighbors.sort(function (a, b) { return b.proximity - a.proximity; });

  return {
    fieldKey: target.fieldKey,
    targetCenter: tgtCenter,
    targetNormBox: nb,
    neighborCount: neighbors.length,
    neighbors: neighbors,
    // Summary metrics for the local area
    avgDistance: neighbors.length > 0 ? round(mean(neighbors.map(function (n) { return n.distance; })), 4) : 0,
    avgTextDensity: neighbors.length > 0 ? round(mean(neighbors.map(function (n) { return n.textDensity; })), 4) : 0,
    overlappingRegionCount: neighbors.filter(function (n) { return n.overlap > 0; }).length
  };
}

/* ── 2. Anchor Relevance Scoring ─────────────────────────────────────────── */

/**
 * Score a Phase 2 anchor by its relevance to a set of target neighborhoods.
 *
 * A good anchor for extraction is one that:
 * - Is spatially close to at least one target
 * - Is part of the same local structural neighborhood
 * - Has high batch-wide stability (frequency/confidence from Phase 2)
 * - Is not a giant page-level region that dominates everything
 *
 * @param {object} anchor - Phase 2 anchor object
 * @param {object[]} neighborhoods - Array of target neighborhood descriptors
 * @returns {object} { relevanceScore, bestTargetKey, details }
 */
function scoreAnchorRelevance(anchor, neighborhoods) {
  var bestScore = 0;
  var bestTargetKey = null;
  var allDetails = [];

  for (var ni = 0; ni < neighborhoods.length; ni++) {
    var nh = neighborhoods[ni];
    var tgtCenter = nh.targetCenter;
    var anchorCenter = anchor.normalizedPosition;

    // 1. Spatial proximity to target
    var dist = pointDist(tgtCenter, anchorCenter);
    var proxScore = clamp(1 - dist / 0.4, 0, 1);   // closer = better, range ~40% of page

    // 2. Overlap with target box
    var anchorNb = { x0n: anchor.normalizedBbox.x, y0n: anchor.normalizedBbox.y,
                     wN: anchor.normalizedBbox.w, hN: anchor.normalizedBbox.h };
    var overlap = normBoxIoU(nh.targetNormBox, anchorNb);
    var overlapScore = overlap > 0 ? 0.3 + overlap * 0.7 : 0;

    // 3. Neighborhood membership: is this anchor's region among the target's local neighbors?
    var isLocalNeighbor = false;
    for (var nni = 0; nni < nh.neighbors.length; nni++) {
      if (nh.neighbors[nni].regionId === anchor.refRegionId) {
        isLocalNeighbor = true;
        break;
      }
    }
    var membershipScore = isLocalNeighbor ? 0.8 : 0;

    // 4. Size penalty: penalize giant page-level regions
    var sizePenalty = 1;
    if (anchor.normalizedArea > 0.15) {
      sizePenalty = clamp(1 - (anchor.normalizedArea - 0.15) / 0.35, 0.2, 1);
    }

    // 5. Batch stability bonus from Phase 2
    var stabilityBonus = anchor.confidence * 0.3;

    // Combined local relevance for this target
    var localRelevance = (
      proxScore * 0.30 +
      overlapScore * 0.20 +
      membershipScore * 0.25 +
      stabilityBonus * 0.25
    ) * sizePenalty;

    allDetails.push({
      targetFieldKey: nh.fieldKey,
      proximity: round(proxScore, 4),
      overlap: round(overlapScore, 4),
      membership: round(membershipScore, 4),
      sizePenalty: round(sizePenalty, 4),
      stabilityBonus: round(stabilityBonus, 4),
      localRelevance: round(localRelevance, 4)
    });

    if (localRelevance > bestScore) {
      bestScore = localRelevance;
      bestTargetKey = nh.fieldKey;
    }
  }

  return {
    relevanceScore: round(bestScore, 4),
    bestTargetKey: bestTargetKey,
    details: allDetails
  };
}

/* ── 3. Anchor Refinement ────────────────────────────────────────────────── */

/**
 * Refine Phase 2 anchors based on user-drawn extraction targets.
 *
 * @param {object}   correspondenceResult - Phase 2 output from analyzeCorrespondence()
 * @param {object[]} extractionTargets    - Array of { fieldKey, label, normBox }
 * @param {object}   refDoc              - Reference document summary (full)
 * @param {object}   [opts]
 * @param {number}   [opts.relevanceThreshold=0.15]  - Min relevance to keep anchor
 * @returns {object} RefinementResult
 */
function refineAnchors(correspondenceResult, extractionTargets, refDoc, opts) {
  opts = opts || {};
  var relevanceThreshold = opts.relevanceThreshold || 0.15;

  if (!correspondenceResult || !correspondenceResult.anchors) {
    return {
      status: 'no_correspondence',
      message: 'No Phase 2 correspondence results available.',
      refinedAnchors: [],
      removedAnchors: [],
      extractionTargets: extractionTargets || [],
      targetNeighborhoods: [],
      alignmentModel: null
    };
  }

  if (!extractionTargets || extractionTargets.length === 0) {
    return {
      status: 'no_targets',
      message: 'No extraction targets defined.',
      refinedAnchors: [],
      removedAnchors: [],
      extractionTargets: [],
      targetNeighborhoods: [],
      alignmentModel: null
    };
  }

  // Step 1: Compute target neighborhoods
  var neighborhoods = [];
  for (var ti = 0; ti < extractionTargets.length; ti++) {
    neighborhoods.push(computeTargetNeighborhood(extractionTargets[ti], refDoc));
  }

  // Step 2: Score each anchor by relevance to targets
  var anchors = correspondenceResult.anchors;
  var refined = [];
  var removed = [];

  for (var ai = 0; ai < anchors.length; ai++) {
    var anchor = anchors[ai];
    var scoring = scoreAnchorRelevance(anchor, neighborhoods);

    var enrichedAnchor = {};
    for (var k in anchor) {
      if (anchor.hasOwnProperty(k)) enrichedAnchor[k] = anchor[k];
    }
    enrichedAnchor.relevanceScore = scoring.relevanceScore;
    enrichedAnchor.bestTargetKey = scoring.bestTargetKey;
    enrichedAnchor.relevanceDetails = scoring.details;

    if (scoring.relevanceScore >= relevanceThreshold) {
      refined.push(enrichedAnchor);
    } else {
      removed.push(enrichedAnchor);
    }
  }

  // Sort refined by relevance descending
  refined.sort(function (a, b) { return b.relevanceScore - a.relevanceScore; });

  // Step 3: Build refined alignment model
  var refinedModel = {
    referenceDocumentId: correspondenceResult.referenceDocument.documentId,
    referenceDocumentName: correspondenceResult.referenceDocument.documentName,
    anchorCount: refined.length,
    removedCount: removed.length,
    originalCount: anchors.length,
    anchorRetentionRate: anchors.length > 0 ? round(refined.length / anchors.length, 4) : 0,
    avgRelevanceScore: refined.length > 0 ? round(mean(refined.map(function (a) { return a.relevanceScore; })), 4) : 0,
    avgConfidence: refined.length > 0 ? round(mean(refined.map(function (a) { return a.confidence; })), 4) : 0,
    extractionTargetCount: extractionTargets.length,
    anchors: refined,
    createdAt: new Date().toISOString()
  };

  // Determine status
  var status = 'refined';
  var message = '';
  if (refined.length === 0) {
    status = 'no_relevant_anchors';
    message = 'No anchors are relevant to the defined extraction targets. ' +
      'The targets may be in areas with low structural consistency across the batch.';
  } else {
    message = 'Refined from ' + anchors.length + ' to ' + refined.length + ' anchors. ' +
      'Removed ' + removed.length + ' irrelevant anchor(s). ' +
      'Average relevance: ' + round(refinedModel.avgRelevanceScore * 100, 1) + '%.';
  }

  return {
    status: status,
    message: message,
    refinedAnchors: refined,
    removedAnchors: removed,
    extractionTargets: extractionTargets,
    targetNeighborhoods: neighborhoods,
    refinedAlignmentModel: refinedModel,
    analyzedAt: new Date().toISOString()
  };
}

/* ── 4. BBOX Transfer / Extraction ───────────────────────────────────────── */

/**
 * Transfer a user-defined BBOX from the reference document to a target
 * document using refined anchors.
 *
 * The transfer uses nearby anchor correspondences to compute an affine-like
 * offset between the reference and target coordinate spaces. If no anchors
 * are nearby the target, it falls back to identity (same normalized position).
 *
 * This mirrors the intent of the normal WrokitVision run pipeline's
 * geometry transfer, designed so it can later inform the standard run flow.
 *
 * @param {object}   target      - { fieldKey, label, normBox }
 * @param {object[]} refinedAnchors  - Anchors from refineAnchors()
 * @param {object}   correspondenceResult - Phase 2 output
 * @param {string}   targetDocId - ID of the document to transfer to
 * @param {object}   targetDoc   - Target document summary
 * @returns {object} { transferredNormBox, confidence, method, anchorUsed }
 */
function transferBBox(target, refinedAnchors, correspondenceResult, targetDocId, targetDoc) {
  var srcBox = target.normBox;
  var srcCenter = normBoxCenter(srcBox);

  // Find correspondences for this target document
  var docCorrespondences = (correspondenceResult.correspondences || []).filter(
    function (c) { return c.tgtDocumentId === targetDocId; }
  );

  // Find the nearest relevant anchors that have a match in the target doc
  var anchorPairs = [];
  for (var ai = 0; ai < refinedAnchors.length; ai++) {
    var anchor = refinedAnchors[ai];
    // Find this anchor's correspondence in the target doc
    var match = null;
    for (var ci = 0; ci < docCorrespondences.length; ci++) {
      if (docCorrespondences[ci].refRegionId === anchor.refRegionId) {
        match = docCorrespondences[ci];
        break;
      }
    }
    if (!match) continue;

    // Find the target region descriptor
    var tgtRegion = null;
    var tgtRegions = targetDoc.regionDescriptors || [];
    for (var ri = 0; ri < tgtRegions.length; ri++) {
      if (tgtRegions[ri].regionId === match.tgtRegionId) {
        tgtRegion = tgtRegions[ri];
        break;
      }
    }
    if (!tgtRegion) continue;

    var dist = pointDist(srcCenter, anchor.normalizedPosition);
    anchorPairs.push({
      anchor: anchor,
      match: match,
      tgtRegion: tgtRegion,
      distance: dist,
      weight: clamp(1 - dist / 0.5, 0.1, 1) * match.similarity
    });
  }

  // Sort by distance (closest first)
  anchorPairs.sort(function (a, b) { return a.distance - b.distance; });

  if (anchorPairs.length === 0) {
    // Fallback: identity transfer (same normalized position)
    return {
      transferredNormBox: { x0n: srcBox.x0n, y0n: srcBox.y0n, wN: srcBox.wN, hN: srcBox.hN },
      confidence: 0.3,
      method: 'identity_fallback',
      anchorsUsed: 0
    };
  }

  // Use the top-N nearest anchor pairs to compute a weighted offset
  var maxAnchors = Math.min(anchorPairs.length, 5);
  var totalWeight = 0;
  var offsetX = 0, offsetY = 0;
  var scaleW = 0, scaleH = 0;

  for (var pi = 0; pi < maxAnchors; pi++) {
    var pair = anchorPairs[pi];
    var refCenter = pair.anchor.normalizedPosition;
    var tgtCenter = pair.tgtRegion.centroid;

    // Offset = how much the anchor shifted from ref to target
    var dx = tgtCenter.x - refCenter.x;
    var dy = tgtCenter.y - refCenter.y;

    // Scale = ratio of target region size to reference region size
    var refBbox = pair.anchor.normalizedBbox;
    var tgtBbox = pair.tgtRegion.normalizedBbox;
    var sw = refBbox.w > 0 ? tgtBbox.w / refBbox.w : 1;
    var sh = refBbox.h > 0 ? tgtBbox.h / refBbox.h : 1;

    offsetX += dx * pair.weight;
    offsetY += dy * pair.weight;
    scaleW += sw * pair.weight;
    scaleH += sh * pair.weight;
    totalWeight += pair.weight;
  }

  if (totalWeight > 0) {
    offsetX /= totalWeight;
    offsetY /= totalWeight;
    scaleW /= totalWeight;
    scaleH /= totalWeight;
  } else {
    offsetX = 0; offsetY = 0; scaleW = 1; scaleH = 1;
  }

  // Clamp scale to reasonable range (50% - 200% of original)
  scaleW = clamp(scaleW, 0.5, 2.0);
  scaleH = clamp(scaleH, 0.5, 2.0);

  // Apply offset and scale to source box
  var newW = srcBox.wN * scaleW;
  var newH = srcBox.hN * scaleH;
  var newX = srcBox.x0n + offsetX;
  var newY = srcBox.y0n + offsetY;

  // Clamp to page bounds
  newX = clamp(newX, 0, 1 - newW);
  newY = clamp(newY, 0, 1 - newH);
  newW = clamp(newW, 0.001, 1);
  newH = clamp(newH, 0.001, 1);

  // Confidence based on anchor quality and count
  var avgMatchSim = mean(anchorPairs.slice(0, maxAnchors).map(function (p) { return p.match.similarity; }));
  var confidence = clamp(avgMatchSim * (0.5 + 0.5 * Math.min(maxAnchors, 3) / 3), 0, 1);

  return {
    transferredNormBox: { x0n: round(newX, 6), y0n: round(newY, 6), wN: round(newW, 6), hN: round(newH, 6) },
    confidence: round(confidence, 4),
    method: 'anchor_weighted_transfer',
    anchorsUsed: maxAnchors,
    offset: { x: round(offsetX, 6), y: round(offsetY, 6) },
    scale: { w: round(scaleW, 4), h: round(scaleH, 4) }
  };
}

/**
 * Extract text from tokens within a normalized bounding box.
 *
 * This mirrors the tokensInBox pattern from the main extraction pipeline.
 * Tokens must have { x, y, w, h, text } in pixel coordinates.
 * The normBox is denormalized using the viewport.
 *
 * @param {object}   normBox  - { x0n, y0n, wN, hN }
 * @param {object[]} tokens   - Array of { x, y, w, h, text, ... }
 * @param {object}   viewport - { width|w, height|h }
 * @returns {object} { text, tokenCount, confidence }
 */
function extractTextFromNormBox(normBox, tokens, viewport) {
  if (!normBox || !tokens || !tokens.length || !viewport) {
    return { text: '', tokenCount: 0, confidence: 0 };
  }

  var vpW = viewport.width || viewport.w || 1;
  var vpH = viewport.height || viewport.h || 1;

  // Denormalize box to pixel coordinates
  var boxPx = {
    x: normBox.x0n * vpW,
    y: normBox.y0n * vpH,
    w: normBox.wN * vpW,
    h: normBox.hN * vpH
  };

  // Find tokens within box (mirrors tokensInBox logic)
  var matched = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    var overlapX = Math.min(t.x + t.w, boxPx.x + boxPx.w) - Math.max(t.x, boxPx.x);
    var overlapY = Math.min(t.y + t.h, boxPx.y + boxPx.h) - Math.max(t.y, boxPx.y);
    if (overlapX <= 0 || overlapY <= 0) continue;

    // Token center must be inside box
    var cx = t.x + t.w / 2;
    var cy = t.y + t.h / 2;
    if (cx < boxPx.x || cx > boxPx.x + boxPx.w) continue;
    if (cy < boxPx.y || cy > boxPx.y + boxPx.h) continue;

    matched.push(t);
  }

  // Sort tokens by position (top-to-bottom, left-to-right)
  matched.sort(function (a, b) {
    var ay = a.y + a.h / 2, by = b.y + b.h / 2;
    // Group into lines (~10px tolerance)
    if (Math.abs(ay - by) > Math.min(a.h, b.h) * 0.5) return ay - by;
    return a.x - b.x;
  });

  // Group into lines and join
  var lines = [];
  var currentLine = [];
  var lastY = -Infinity;

  for (var mi = 0; mi < matched.length; mi++) {
    var tok = matched[mi];
    var tokY = tok.y + tok.h / 2;
    if (currentLine.length > 0 && Math.abs(tokY - lastY) > tok.h * 0.5) {
      lines.push(currentLine.map(function (t) { return t.text; }).join(' '));
      currentLine = [];
    }
    currentLine.push(tok);
    lastY = tokY;
  }
  if (currentLine.length > 0) {
    lines.push(currentLine.map(function (t) { return t.text; }).join(' '));
  }

  var text = lines.join('\n').trim();
  var avgConf = matched.length > 0
    ? mean(matched.map(function (t) { return t.confidence || 0.5; }))
    : 0;

  return {
    text: text,
    tokenCount: matched.length,
    confidence: round(avgConf, 4)
  };
}

/**
 * Run extraction across all batch documents for all extraction targets.
 *
 * @param {object}   refinementResult      - Output from refineAnchors()
 * @param {object}   correspondenceResult  - Phase 2 output
 * @param {object}   refDoc                - Reference document summary
 * @param {object[]} batchDocuments        - All batch document summaries (full)
 * @param {object}   batchTokens           - { [documentId]: { tokens, viewport } }
 * @returns {object} ExtractionResult
 */
function extractFromBatch(refinementResult, correspondenceResult, refDoc, batchDocuments, batchTokens) {
  if (!refinementResult || refinementResult.status === 'no_relevant_anchors') {
    return {
      status: 'no_anchors',
      message: 'No refined anchors available for extraction.',
      results: []
    };
  }

  var targets = refinementResult.extractionTargets;
  var refinedAnchors = refinementResult.refinedAnchors;
  var refDocId = correspondenceResult.referenceDocument.documentId;
  var results = [];

  for (var di = 0; di < batchDocuments.length; di++) {
    var doc = batchDocuments[di];
    if (doc._compact || doc.structurallyValid === false) continue;

    var docTokenData = batchTokens[doc.documentId];
    var isRefDoc = doc.documentId === refDocId;
    var docResult = {
      documentId: doc.documentId,
      documentName: doc.documentName || '',
      isReference: isRefDoc,
      fields: []
    };

    for (var ti = 0; ti < targets.length; ti++) {
      var target = targets[ti];
      var transferResult;

      if (isRefDoc) {
        // Reference doc: use original BBOX directly
        transferResult = {
          transferredNormBox: target.normBox,
          confidence: 1,
          method: 'reference_identity',
          anchorsUsed: 0
        };
      } else {
        // Transfer BBOX using refined anchors
        transferResult = transferBBox(target, refinedAnchors, correspondenceResult, doc.documentId, doc);
      }

      // Extract text if tokens available
      var extraction = { text: '', tokenCount: 0, confidence: 0 };
      if (docTokenData && docTokenData.tokens) {
        extraction = extractTextFromNormBox(
          transferResult.transferredNormBox,
          docTokenData.tokens,
          docTokenData.viewport
        );
      }

      docResult.fields.push({
        fieldKey: target.fieldKey,
        label: target.label,
        sourceNormBox: target.normBox,
        transferredNormBox: transferResult.transferredNormBox,
        transferConfidence: transferResult.confidence,
        transferMethod: transferResult.method,
        anchorsUsed: transferResult.anchorsUsed,
        extractedText: extraction.text,
        tokenCount: extraction.tokenCount,
        textConfidence: extraction.confidence
      });
    }

    results.push(docResult);
  }

  return {
    status: 'complete',
    message: 'Extracted ' + targets.length + ' field(s) from ' + results.length + ' document(s).',
    extractionTargets: targets,
    documentCount: results.length,
    results: results,
    extractedAt: new Date().toISOString()
  };
}

/* ── 5. Report Formatter ─────────────────────────────────────────────────── */

function formatRefinementReport(result) {
  if (!result) return '[No refinement data]';
  if (result.status === 'no_correspondence' || result.status === 'no_targets') {
    return result.message;
  }

  var out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  ANCHOR REFINEMENT REPORT (Phase 2B)\n';
  out += '══════════════════════════════════════════════════════════════\n\n';
  out += '  Status: ' + result.status.toUpperCase().replace(/_/g, ' ') + '\n';
  out += '  ' + result.message + '\n';

  if (result.refinedAlignmentModel) {
    var m = result.refinedAlignmentModel;
    out += '\n  Anchors: ' + m.anchorCount + ' kept / ' + m.removedCount + ' removed (of ' + m.originalCount + ' total)\n';
    out += '  Retention Rate: ' + (m.anchorRetentionRate * 100).toFixed(1) + '%\n';
    out += '  Avg Relevance: ' + (m.avgRelevanceScore * 100).toFixed(1) + '%\n';
    out += '  Avg Confidence: ' + (m.avgConfidence * 100).toFixed(1) + '%\n';
  }

  if (result.extractionTargets && result.extractionTargets.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  EXTRACTION TARGETS\n';
    out += '──────────────────────────────────────────────────────────────\n';
    for (var ti = 0; ti < result.extractionTargets.length; ti++) {
      var t = result.extractionTargets[ti];
      out += '\n  Target ' + (ti + 1) + ': ' + t.label + ' (' + t.fieldKey + ')\n';
      out += '    Box: (' + (t.normBox.x0n * 100).toFixed(1) + '%, ' + (t.normBox.y0n * 100).toFixed(1) + '%) ';
      out += (t.normBox.wN * 100).toFixed(1) + '% x ' + (t.normBox.hN * 100).toFixed(1) + '%\n';
    }
  }

  if (result.refinedAnchors && result.refinedAnchors.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  REFINED ANCHORS (' + result.refinedAnchors.length + ')\n';
    out += '──────────────────────────────────────────────────────────────\n';
    for (var ai = 0; ai < result.refinedAnchors.length; ai++) {
      var a = result.refinedAnchors[ai];
      out += '\n  ' + a.anchorId + '  relevance=' + (a.relevanceScore * 100).toFixed(1) +
        '%  conf=' + (a.confidence * 100).toFixed(1) + '%  target=' + (a.bestTargetKey || 'none') + '\n';
    }
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  refineAnchors,
  computeTargetNeighborhood,
  scoreAnchorRelevance,
  transferBBox,
  extractTextFromNormBox,
  extractFromBatch,
  formatRefinementReport
};
