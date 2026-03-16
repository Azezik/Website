'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  landmark-matcher.js  –  Content-Based Landmark Matching & BBOX Transfer
  ─────────────────────────────────────────────────────────────────────────────

  Matches text landmarks from the reference document to target documents
  by content, then uses matched positions to transfer user-drawn BBOXes.

  ─── Core Idea ─────────────────────────────────────────────────────────

  Traditional approach:   match regions by geometry → infer correspondence
  This approach:          match text by content → correspondence IS geometry

  When you find "Name/Nom" at (0.05, 0.18) on the reference and at
  (0.08, 0.22) on the target, you have a direct point correspondence.
  No similarity scoring, no region matching.  The content match IS the
  spatial correspondence.

  ─── BBOX Transfer Strategy ───────────────────────────────────────────

  1. Primary: relative-vector prediction from nearby matched landmarks
     "The BBOX is 12% right and 0.2% below 'Primary tel:'"
     → Find 'Primary tel:' on target → predict BBOX position

  2. Secondary: affine transform from all matched landmarks
     Handles global distortion (crop, scale, rotation)

  3. Blend: nearby landmarks → trust relative vectors;
     sparse landmarks → trust global affine

───────────────────────────────────────────────────────────────────────────────*/

var spatialTransform = require('./spatial-transform-estimator');

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(v, dec) {
  var f = Math.pow(10, dec || 4);
  return Math.round(v * f) / f;
}

function mean(arr) {
  return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
}

function pointDist(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizedEditDistance(a, b) {
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

/* ── 1. Match Landmarks on a Target Document ──────────────────────────── */

/**
 * Match text landmarks from the batch to a specific target document's
 * tokens using content-based matching.
 *
 * For each landmark, searches the target's tokens for the same or similar
 * text.  Returns position pairs (reference position → target position)
 * that can be used directly for transform estimation.
 *
 * @param {object[]} landmarks    - TextLandmark[] from discoverLandmarks()
 * @param {string}   refDocId     - Reference document ID
 * @param {string}   targetDocId  - Target document ID
 * @param {object[]} targetTokens - Target document's OCR tokens
 * @param {object}   targetViewport - { w|width, h|height }
 * @param {object}   [opts]
 * @param {number}   [opts.maxEditDistance=0.3]  - Max normalized edit distance for fuzzy match
 * @returns {object} { matches, matchCount, unmatchedCount }
 */
function matchLandmarksOnTarget(landmarks, refDocId, targetDocId, targetTokens, targetViewport, opts) {
  opts = opts || {};
  var maxEditDist = opts.maxEditDistance || 0.3;

  if (!targetTokens || targetTokens.length === 0 || !landmarks || landmarks.length === 0) {
    return { matches: [], matchCount: 0, unmatchedCount: landmarks ? landmarks.length : 0 };
  }

  var vpW = targetViewport.width || targetViewport.w || 1;
  var vpH = targetViewport.height || targetViewport.h || 1;

  // Build target token lookup: normalized text → [{ token, normPos }]
  var targetIndex = {};
  for (var ti = 0; ti < targetTokens.length; ti++) {
    var tok = targetTokens[ti];
    var normText = normalizeText(tok.text);
    if (normText.length < 2) continue;

    if (!targetIndex[normText]) targetIndex[normText] = [];
    targetIndex[normText].push({
      token: tok,
      normPos: {
        x: (tok.x + tok.w / 2) / vpW,
        y: (tok.y + tok.h / 2) / vpH,
        w: tok.w / vpW,
        h: tok.h / vpH
      }
    });
  }

  var matches = [];
  var unmatched = 0;

  for (var li = 0; li < landmarks.length; li++) {
    var lm = landmarks[li];

    // Get reference position for this landmark
    var refPos = lm.documentPositions[refDocId];
    if (!refPos) continue;

    // Check if the landmark already has a known position on the target
    // (from the batch discovery phase)
    var tgtPos = lm.documentPositions[targetDocId];

    if (tgtPos) {
      // Direct match from batch discovery — highest confidence
      matches.push({
        landmarkId: lm.landmarkId,
        text: lm.text,
        refPosition: { x: refPos.x, y: refPos.y },
        tgtPosition: { x: tgtPos.x, y: tgtPos.y },
        refBbox: { x0n: refPos.x0n, y0n: refPos.y0n, wN: refPos.wN, hN: refPos.hN },
        tgtBbox: { x0n: tgtPos.x0n, y0n: tgtPos.y0n, wN: tgtPos.wN, hN: tgtPos.hN },
        matchType: 'batch_known',
        matchScore: 1.0,
        landmarkConfidence: lm.confidence
      });
      continue;
    }

    // Try content matching on target tokens
    var bestMatch = null;
    var bestScore = 0;

    // For multi-token landmarks, try matching the full phrase
    // by finding constituent tokens in sequence
    var lmTokens = lm.text.split(' ');

    if (lmTokens.length === 1) {
      // Single-token landmark: direct lookup
      var match = findBestTokenMatch(lm.text, targetIndex, maxEditDist, refPos, vpW, vpH);
      if (match) {
        bestMatch = match;
        bestScore = match.score;
      }
    } else {
      // Multi-token landmark: find tokens in sequence
      var phraseMatch = findPhraseMatch(lmTokens, targetIndex, maxEditDist, vpW, vpH);
      if (phraseMatch) {
        bestMatch = phraseMatch;
        bestScore = phraseMatch.score;
      }
    }

    if (bestMatch && bestScore > 0) {
      matches.push({
        landmarkId: lm.landmarkId,
        text: lm.text,
        refPosition: { x: refPos.x, y: refPos.y },
        tgtPosition: bestMatch.position,
        refBbox: { x0n: refPos.x0n, y0n: refPos.y0n, wN: refPos.wN, hN: refPos.hN },
        tgtBbox: bestMatch.bbox,
        matchType: bestMatch.type,
        matchScore: round(bestScore, 4),
        landmarkConfidence: lm.confidence
      });
    } else {
      unmatched++;
    }
  }

  return {
    matches: matches,
    matchCount: matches.length,
    unmatchedCount: unmatched,
    matchRate: landmarks.length > 0 ? round(matches.length / landmarks.length, 4) : 0
  };
}

/**
 * Find the best matching token in the target for a single-token landmark.
 */
function findBestTokenMatch(text, targetIndex, maxEditDist, refPos, vpW, vpH) {
  // Try exact match first
  if (targetIndex[text]) {
    var candidates = targetIndex[text];
    // If multiple, pick the one closest to the reference position
    var best = candidates[0];
    if (candidates.length > 1 && refPos) {
      var bestDist = Infinity;
      for (var ci = 0; ci < candidates.length; ci++) {
        var dist = pointDist(candidates[ci].normPos, refPos);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidates[ci];
        }
      }
    }
    return {
      position: { x: best.normPos.x, y: best.normPos.y },
      bbox: {
        x0n: round(best.normPos.x - best.normPos.w / 2, 6),
        y0n: round(best.normPos.y - best.normPos.h / 2, 6),
        wN: round(best.normPos.w, 6),
        hN: round(best.normPos.h, 6)
      },
      score: 1.0,
      type: 'exact'
    };
  }

  // Try fuzzy match
  var bestFuzzy = null;
  var bestFuzzyScore = 0;
  var targetTexts = Object.keys(targetIndex);

  for (var fi = 0; fi < targetTexts.length; fi++) {
    var tgtText = targetTexts[fi];
    var editDist = normalizedEditDistance(text, tgtText);
    if (editDist > maxEditDist) continue;

    var score = 1 - editDist;
    if (score > bestFuzzyScore) {
      bestFuzzyScore = score;
      var fCands = targetIndex[tgtText];
      var fBest = fCands[0];
      if (fCands.length > 1 && refPos) {
        var fBestDist = Infinity;
        for (var fci = 0; fci < fCands.length; fci++) {
          var fDist = pointDist(fCands[fci].normPos, refPos);
          if (fDist < fBestDist) {
            fBestDist = fDist;
            fBest = fCands[fci];
          }
        }
      }
      bestFuzzy = {
        position: { x: fBest.normPos.x, y: fBest.normPos.y },
        bbox: {
          x0n: round(fBest.normPos.x - fBest.normPos.w / 2, 6),
          y0n: round(fBest.normPos.y - fBest.normPos.h / 2, 6),
          wN: round(fBest.normPos.w, 6),
          hN: round(fBest.normPos.h, 6)
        },
        score: score,
        type: 'fuzzy'
      };
    }
  }

  return bestFuzzy;
}

/**
 * Find a multi-token phrase on the target by matching constituent tokens
 * and checking they appear in sequence on the same line.
 */
function findPhraseMatch(phraseTokens, targetIndex, maxEditDist, vpW, vpH) {
  // Find all occurrences of the first token
  var firstText = phraseTokens[0];
  var firstCandidates = [];

  // Exact and fuzzy search for first token
  var targetTexts = Object.keys(targetIndex);
  for (var fi = 0; fi < targetTexts.length; fi++) {
    var editDist = normalizedEditDistance(firstText, targetTexts[fi]);
    if (editDist <= maxEditDist) {
      var cands = targetIndex[targetTexts[fi]];
      for (var ci = 0; ci < cands.length; ci++) {
        firstCandidates.push({
          entry: cands[ci],
          score: 1 - editDist
        });
      }
    }
  }

  if (firstCandidates.length === 0) return null;

  // For each first-token candidate, try to find the remaining tokens nearby
  var bestPhrase = null;
  var bestScore = 0;

  for (var fci = 0; fci < firstCandidates.length; fci++) {
    var startEntry = firstCandidates[fci];
    var startPos = startEntry.entry.normPos;
    var phraseScore = startEntry.score;
    var phrasePositions = [startPos];
    var allFound = true;

    for (var pi = 1; pi < phraseTokens.length; pi++) {
      var nextText = phraseTokens[pi];
      var nextFound = false;

      for (var nti = 0; nti < targetTexts.length; nti++) {
        var nEditDist = normalizedEditDistance(nextText, targetTexts[nti]);
        if (nEditDist > maxEditDist) continue;

        var nCands = targetIndex[targetTexts[nti]];
        for (var nci = 0; nci < nCands.length; nci++) {
          var nPos = nCands[nci].normPos;
          // Must be on the same line (close Y) and to the right of previous token
          var yDiff = Math.abs(nPos.y - startPos.y);
          if (yDiff > 0.02) continue; // Not same line

          var xGap = nPos.x - phrasePositions[phrasePositions.length - 1].x;
          if (xGap < -0.01 || xGap > 0.15) continue; // Too far or wrong direction

          phrasePositions.push(nPos);
          phraseScore += (1 - nEditDist);
          nextFound = true;
          break;
        }
        if (nextFound) break;
      }

      if (!nextFound) {
        allFound = false;
        break;
      }
    }

    if (!allFound) continue;

    var avgScore = phraseScore / phraseTokens.length;
    if (avgScore > bestScore) {
      bestScore = avgScore;

      // Compute bounding box of all matched tokens
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var ppi = 0; ppi < phrasePositions.length; ppi++) {
        var pp = phrasePositions[ppi];
        if (pp.x - pp.w / 2 < minX) minX = pp.x - pp.w / 2;
        if (pp.x + pp.w / 2 > maxX) maxX = pp.x + pp.w / 2;
        if (pp.y - pp.h / 2 < minY) minY = pp.y - pp.h / 2;
        if (pp.y + pp.h / 2 > maxY) maxY = pp.y + pp.h / 2;
      }

      bestPhrase = {
        position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        bbox: {
          x0n: round(minX, 6),
          y0n: round(minY, 6),
          wN: round(maxX - minX, 6),
          hN: round(maxY - minY, 6)
        },
        score: avgScore,
        type: 'phrase'
      };
    }
  }

  return bestPhrase;
}

/* ── 2. BBOX Transfer via Landmarks ───────────────────────────────────── */

/**
 * Transfer a user-drawn BBOX from reference to target using matched text
 * landmarks.
 *
 * Uses a dual strategy:
 *   1. Relative-vector prediction from nearby matched landmarks (primary)
 *   2. Affine transform from all matched landmarks (secondary)
 *   3. Blend based on local landmark density
 *
 * @param {object}   fieldContext  - FieldContextDescriptor from buildFieldContext()
 * @param {object[]} landmarkMatches - Matches from matchLandmarksOnTarget()
 * @param {object}   [opts]
 * @param {number}   [opts.nearbyRadius=0.25]   - Radius for "nearby" landmarks
 * @param {number}   [opts.localBlendWeight=0.7] - Weight for local prediction vs global
 * @returns {object} { transferredNormBox, confidence, method, diagnostics }
 */
function transferBBoxWithLandmarks(fieldContext, landmarkMatches, opts) {
  opts = opts || {};
  var nearbyRadius = opts.nearbyRadius || 0.25;
  var localBlendWeight = opts.localBlendWeight || 0.7;
  var srcBox = fieldContext.normBox;
  var srcCenter = fieldContext.bboxCenter;

  if (!landmarkMatches || landmarkMatches.length === 0) {
    // No matches at all — identity fallback
    return {
      transferredNormBox: { x0n: srcBox.x0n, y0n: srcBox.y0n, wN: srcBox.wN, hN: srcBox.hN },
      confidence: 0,
      method: 'identity_fallback',
      anchorsUsed: 0,
      diagnostics: { message: 'No landmark matches available' }
    };
  }

  // ── Strategy 1: Relative-vector prediction from nearby landmarks ────

  var contextLandmarks = fieldContext.contextLandmarks || [];
  var predictions = [];

  for (var ci = 0; ci < contextLandmarks.length; ci++) {
    var ctx = contextLandmarks[ci];

    // Find this landmark's match on the target
    var match = null;
    for (var mi = 0; mi < landmarkMatches.length; mi++) {
      if (landmarkMatches[mi].landmarkId === ctx.landmarkId) {
        match = landmarkMatches[mi];
        break;
      }
    }
    if (!match) continue;

    // Predict BBOX center from this landmark's matched position + relative vector
    var predictedX = match.tgtPosition.x + ctx.relX;
    var predictedY = match.tgtPosition.y + ctx.relY;

    // Weight by proximity (closer landmarks → more reliable) and match quality
    var weight = (1 / (ctx.distance + 0.05)) * match.matchScore * match.landmarkConfidence;

    predictions.push({
      x: predictedX,
      y: predictedY,
      weight: weight,
      landmarkId: ctx.landmarkId,
      text: ctx.text,
      distance: ctx.distance
    });
  }

  // ── Strategy 2: Global affine transform from all matched landmarks ──

  var transformPairs = [];
  for (var tmi = 0; tmi < landmarkMatches.length; tmi++) {
    var lmMatch = landmarkMatches[tmi];
    transformPairs.push({
      src: lmMatch.refPosition,
      dst: lmMatch.tgtPosition,
      weight: lmMatch.matchScore * lmMatch.landmarkConfidence,
      anchorId: lmMatch.landmarkId
    });
  }

  var globalTransform = null;
  var globalCoherence = 0;
  if (transformPairs.length >= 1) {
    var robustResult = spatialTransform.estimateRobustTransform(transformPairs, 5, 3);
    if (robustResult.transform) {
      globalTransform = robustResult.transform;
      globalCoherence = robustResult.coherence ? robustResult.coherence.coherenceScore : 0.5;
    }
  }

  // ── Blend strategies ────────────────────────────────────────────────

  var finalX, finalY, finalW, finalH;
  var method;

  if (predictions.length >= 1 && globalTransform) {
    // Both strategies available — blend
    // Weighted average of relative-vector predictions
    var totalW = 0;
    var wX = 0, wY = 0;
    for (var pi = 0; pi < predictions.length; pi++) {
      totalW += predictions[pi].weight;
      wX += predictions[pi].x * predictions[pi].weight;
      wY += predictions[pi].y * predictions[pi].weight;
    }
    var localPredX = totalW > 0 ? wX / totalW : srcCenter.x;
    var localPredY = totalW > 0 ? wY / totalW : srcCenter.y;

    // Global prediction via affine
    var globalPred = spatialTransform.transformPoint(globalTransform, srcCenter);
    var globalBox = spatialTransform.transformNormBox(globalTransform, srcBox);

    // Blend: local prediction for position, global for scale/rotation
    var localConf = clamp(predictions.length / 3, 0.3, 1); // 3+ nearby → full local trust
    var effectiveLocalWeight = localBlendWeight * localConf;
    var effectiveGlobalWeight = 1 - effectiveLocalWeight;

    finalX = localPredX * effectiveLocalWeight + globalPred.x * effectiveGlobalWeight;
    finalY = localPredY * effectiveLocalWeight + globalPred.y * effectiveGlobalWeight;

    // Use global transform for size (handles scale changes)
    finalW = globalBox.wN;
    finalH = globalBox.hN;
    method = 'landmark_blended';

  } else if (predictions.length >= 1) {
    // Only relative-vector predictions
    var totW2 = 0;
    var wX2 = 0, wY2 = 0;
    for (var pi2 = 0; pi2 < predictions.length; pi2++) {
      totW2 += predictions[pi2].weight;
      wX2 += predictions[pi2].x * predictions[pi2].weight;
      wY2 += predictions[pi2].y * predictions[pi2].weight;
    }
    finalX = totW2 > 0 ? wX2 / totW2 : srcCenter.x;
    finalY = totW2 > 0 ? wY2 / totW2 : srcCenter.y;
    finalW = srcBox.wN;
    finalH = srcBox.hN;
    method = 'landmark_relative';

  } else if (globalTransform) {
    // Only global transform (no nearby context landmarks matched)
    var gBox = spatialTransform.transformNormBox(globalTransform, srcBox);
    finalX = gBox.x0n + gBox.wN / 2;
    finalY = gBox.y0n + gBox.hN / 2;
    finalW = gBox.wN;
    finalH = gBox.hN;
    method = 'landmark_global';

  } else {
    // Nothing worked — identity fallback
    finalX = srcCenter.x;
    finalY = srcCenter.y;
    finalW = srcBox.wN;
    finalH = srcBox.hN;
    method = 'identity_fallback';
  }

  // Convert center back to corner coordinates
  var resultX = clamp(finalX - finalW / 2, 0, Math.max(0, 1 - finalW));
  var resultY = clamp(finalY - finalH / 2, 0, Math.max(0, 1 - finalH));
  finalW = clamp(finalW, 0.001, 1);
  finalH = clamp(finalH, 0.001, 1);

  // Compute confidence
  var matchRateContrib = clamp(landmarkMatches.length / 5, 0.2, 1) * 0.3;
  var predictionContrib = clamp(predictions.length / 3, 0, 1) * 0.4;
  var globalContrib = globalCoherence * 0.3;
  var confidence = clamp(matchRateContrib + predictionContrib + globalContrib, 0, 1);

  return {
    transferredNormBox: {
      x0n: round(resultX, 6),
      y0n: round(resultY, 6),
      wN: round(finalW, 6),
      hN: round(finalH, 6)
    },
    confidence: round(confidence, 4),
    method: method,
    anchorsUsed: landmarkMatches.length,
    nearbyLandmarksUsed: predictions.length,
    globalTransformUsed: !!globalTransform,
    diagnostics: {
      predictions: predictions.length,
      totalMatches: landmarkMatches.length,
      globalCoherence: round(globalCoherence, 4),
      decomposed: globalTransform ? spatialTransform.decomposeAffine(globalTransform) : null
    }
  };
}

/* ── 3. Batch Extraction via Landmarks ────────────────────────────────── */

/**
 * Run the full landmark-based extraction pipeline across a batch.
 *
 * This is the primary entry point that replaces the region-based
 * Phase 2 + Phase 2B pipeline when text landmarks are available.
 *
 * @param {object}   batchTokens       - { [documentId]: { tokens, viewport } }
 * @param {object[]} extractionTargets - [{ fieldKey, label, normBox }]
 * @param {string}   refDocId          - Reference document ID (where user drew BBOXes)
 * @param {object}   [opts]
 * @param {object}   [opts.landmarks]  - Pre-computed landmarks (skip discovery)
 * @returns {object} ExtractionResult
 */
function extractWithLandmarks(batchTokens, extractionTargets, refDocId, opts) {
  opts = opts || {};

  if (!batchTokens || !extractionTargets || extractionTargets.length === 0) {
    return {
      status: 'no_data',
      message: 'No batch tokens or extraction targets provided.',
      results: [],
      landmarks: []
    };
  }

  var extractTextFromNormBox = require('./batch-anchor-refinement').extractTextFromNormBox;
  var landmarkExtractor = require('./text-landmark-extractor');

  // Step 1: Discover text landmarks across the batch
  var landmarkResult = opts.landmarks || landmarkExtractor.discoverLandmarks(batchTokens, {
    minDocumentFrequency: opts.minDocumentFrequency || 0.5,
    maxPositionCV: opts.maxPositionCV || 0.35
  });

  var landmarks = landmarkResult.landmarks || [];

  if (landmarks.length === 0) {
    return {
      status: 'no_landmarks',
      message: 'No text landmarks discovered. Consider using region-based extraction as fallback.',
      results: [],
      landmarks: [],
      landmarkReport: landmarkResult
    };
  }

  // Step 2: Build field context descriptors for each extraction target
  var fieldContexts = {};
  for (var ti = 0; ti < extractionTargets.length; ti++) {
    var target = extractionTargets[ti];
    fieldContexts[target.fieldKey] = landmarkExtractor.buildFieldContext(
      target, landmarks, refDocId, { maxDistance: 0.4, maxLandmarks: 10 }
    );
  }

  // Step 3: Process each document in the batch
  var docIds = Object.keys(batchTokens);
  var results = [];

  for (var di = 0; di < docIds.length; di++) {
    var docId = docIds[di];
    var docData = batchTokens[docId];
    if (!docData || !docData.tokens) continue;

    var isRefDoc = docId === refDocId;
    var docResult = {
      documentId: docId,
      documentName: docData.documentName || docId,
      isReference: isRefDoc,
      fields: []
    };

    // Match landmarks on this target document
    var matchResult = null;
    if (!isRefDoc) {
      matchResult = matchLandmarksOnTarget(
        landmarks, refDocId, docId,
        docData.tokens, docData.viewport,
        { maxEditDistance: opts.maxEditDistance || 0.3 }
      );
    }

    for (var fi = 0; fi < extractionTargets.length; fi++) {
      var field = extractionTargets[fi];
      var transferResult;

      if (isRefDoc) {
        // Reference doc: use original BBOX directly
        transferResult = {
          transferredNormBox: field.normBox,
          confidence: 1,
          method: 'reference_identity',
          anchorsUsed: 0,
          nearbyLandmarksUsed: 0
        };
      } else {
        // Transfer BBOX using landmark-based matching
        var fieldCtx = fieldContexts[field.fieldKey];
        transferResult = transferBBoxWithLandmarks(
          fieldCtx,
          matchResult ? matchResult.matches : [],
          { nearbyRadius: 0.25, localBlendWeight: 0.7 }
        );
      }

      // Extract text from the transferred BBOX
      var extraction = { text: '', tokenCount: 0, confidence: 0 };
      if (docData.tokens && docData.viewport) {
        extraction = extractTextFromNormBox(
          transferResult.transferredNormBox,
          docData.tokens,
          docData.viewport
        );
      }

      docResult.fields.push({
        fieldKey: field.fieldKey,
        label: field.label,
        sourceNormBox: field.normBox,
        transferredNormBox: transferResult.transferredNormBox,
        transferConfidence: transferResult.confidence,
        transferMethod: transferResult.method,
        anchorsUsed: transferResult.anchorsUsed,
        nearbyLandmarksUsed: transferResult.nearbyLandmarksUsed || 0,
        extractedText: extraction.text,
        tokenCount: extraction.tokenCount,
        textConfidence: extraction.confidence,
        textSource: extraction.textSource || 'no_tokens'
      });
    }

    // Attach per-document match diagnostics
    if (matchResult) {
      docResult.landmarkMatchDiagnostics = {
        matchCount: matchResult.matchCount,
        unmatchedCount: matchResult.unmatchedCount,
        matchRate: matchResult.matchRate
      };
    }

    results.push(docResult);
  }

  return {
    status: 'complete',
    message: 'Extracted ' + extractionTargets.length + ' field(s) from ' + results.length +
      ' document(s) using ' + landmarks.length + ' text landmark(s).',
    extractionTargets: extractionTargets,
    documentCount: results.length,
    landmarkCount: landmarks.length,
    results: results,
    landmarks: landmarks,
    fieldContexts: fieldContexts,
    extractedAt: new Date().toISOString()
  };
}

/* ── 4. Report Formatter ──────────────────────────────────────────────── */

function formatLandmarkExtractionReport(result) {
  if (!result || !result.results) return '[No landmark extraction data]';

  var out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  LANDMARK-BASED EXTRACTION REPORT\n';
  out += '══════════════════════════════════════════════════════════════\n\n';
  out += '  ' + result.message + '\n';
  out += '  Landmarks Used: ' + result.landmarkCount + '\n';

  for (var di = 0; di < result.results.length; di++) {
    var doc = result.results[di];
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  ' + (doc.documentName || doc.documentId) +
      (doc.isReference ? ' (REFERENCE)' : '') + '\n';

    if (doc.landmarkMatchDiagnostics) {
      var lmd = doc.landmarkMatchDiagnostics;
      out += '  Landmarks Matched: ' + lmd.matchCount + '/' +
        (lmd.matchCount + lmd.unmatchedCount) +
        ' (' + (lmd.matchRate * 100).toFixed(0) + '%)\n';
    }

    for (var fi = 0; fi < doc.fields.length; fi++) {
      var f = doc.fields[fi];
      out += '    ' + f.label + ': ';
      if (f.transferMethod === 'reference_identity') {
        out += '(reference — original BBOX)\n';
      } else {
        out += f.transferMethod + '  conf=' + (f.transferConfidence * 100).toFixed(0) + '%';
        out += '  nearby=' + (f.nearbyLandmarksUsed || 0);
        out += '  total=' + f.anchorsUsed;
        out += '\n';
      }
      out += '      Text: ' + (f.extractedText || '(empty)').substring(0, 60) +
        '  tokens=' + f.tokenCount + '\n';
    }
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────── */

module.exports = {
  matchLandmarksOnTarget,
  transferBBoxWithLandmarks,
  extractWithLandmarks,
  formatLandmarkExtractionReport,
  // Expose internals for testing
  findBestTokenMatch,
  findPhraseMatch
};
