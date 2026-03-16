'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  text-landmark-extractor.js  –  Text Landmark Discovery
  ─────────────────────────────────────────────────────────────────────────────

  Discovers stable text landmarks across a batch of documents by
  cross-referencing OCR tokens.  Text that appears on most/all documents
  in the batch is "template text" — printed labels, headers, field names —
  and provides vastly more reliable spatial anchors than color-segmented
  region boundaries.

  ─── Why text landmarks? ──────────────────────────────────────────────────

  On a template like a sales contract:
    • "Name/Nom", "Date", "Primary tel:" appear on EVERY instance
    • OCR reads them with ~1-3 px positional accuracy
    • Content matching finds them regardless of crop, scale, or scan quality

  By contrast, region segmentation can produce 12 regions on one scan and
  18 on another from the same template.  Region centroids can shift 10-20 px
  between runs.  Text is the right signal.

  ─── Algorithm ─────────────────────────────────────────────────────────────

  1. Collect all OCR tokens from all batch documents
  2. Normalize token text (lowercase, trim, collapse whitespace)
  3. For each unique normalized text, count how many documents it appears on
  4. Filter to tokens appearing on >= threshold of documents
  5. Filter to tokens with consistent positions (low CV of normalized position)
  6. Filter out tokens that appear multiple times per document (ambiguous)
  7. Group adjacent stable tokens on the same line into landmark phrases
  8. Output: TextLandmark[] with per-document positions

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

function stddev(arr) {
  if (arr.length < 2) return 0;
  var m = mean(arr);
  var sumSq = 0;
  for (var i = 0; i < arr.length; i++) {
    var d = arr[i] - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / arr.length);
}

/**
 * Normalize token text for cross-document comparison.
 * Lowercase, trim, collapse internal whitespace.
 */
function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalize a token's position to 0-1 space using the viewport.
 */
function normalizeTokenPosition(token, viewport) {
  var vpW = viewport.width || viewport.w || 1;
  var vpH = viewport.height || viewport.h || 1;
  return {
    x: (token.x + token.w / 2) / vpW,
    y: (token.y + token.h / 2) / vpH,
    w: token.w / vpW,
    h: token.h / vpH
  };
}

/**
 * Simple edit distance (Levenshtein), normalized to 0-1.
 */
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

/* ── 1. Token Collection & Cross-Document Frequency Analysis ──────────── */

/**
 * Collect and normalize all tokens from all documents in the batch.
 * Returns a map of normalized text → per-document occurrence data.
 *
 * @param {object} batchTokens - { [documentId]: { tokens: Token[], viewport } }
 * @returns {object} tokenIndex - { [normalizedText]: { docOccurrences: { [docId]: [positions] } } }
 */
function buildTokenIndex(batchTokens) {
  var tokenIndex = {};

  var docIds = Object.keys(batchTokens);
  for (var di = 0; di < docIds.length; di++) {
    var docId = docIds[di];
    var docData = batchTokens[docId];
    if (!docData || !docData.tokens || !docData.viewport) continue;

    var tokens = docData.tokens;
    var viewport = docData.viewport;

    for (var ti = 0; ti < tokens.length; ti++) {
      var token = tokens[ti];
      var text = normalizeText(token.text);

      // Skip very short tokens (single characters, punctuation)
      if (text.length < 2) continue;
      // Skip pure numeric tokens (these are often variable values)
      if (/^\d+$/.test(text)) continue;

      var normPos = normalizeTokenPosition(token, viewport);

      if (!tokenIndex[text]) {
        tokenIndex[text] = { docOccurrences: {} };
      }

      if (!tokenIndex[text].docOccurrences[docId]) {
        tokenIndex[text].docOccurrences[docId] = [];
      }

      tokenIndex[text].docOccurrences[docId].push({
        x: normPos.x,
        y: normPos.y,
        w: normPos.w,
        h: normPos.h,
        rawToken: token,
        confidence: token.confidence || 0.5
      });
    }
  }

  return tokenIndex;
}

/* ── 2. Landmark Discovery ────────────────────────────────────────────── */

/**
 * Discover text landmarks — stable text that appears across most documents
 * in the batch with consistent positions.
 *
 * @param {object} batchTokens - { [documentId]: { tokens, viewport } }
 * @param {object} [opts]
 * @param {number} [opts.minDocumentFrequency=0.5]  - Min fraction of docs a token must appear on
 * @param {number} [opts.maxOccurrencesPerDoc=2]     - Max times a token can appear per doc (higher = ambiguous)
 * @param {number} [opts.maxPositionCV=0.35]          - Max coefficient of variation of position
 * @param {number} [opts.minTokenLength=2]            - Min character length for a token
 * @returns {object} { landmarks: TextLandmark[], documentCount, discoveredAt }
 */
function discoverLandmarks(batchTokens, opts) {
  opts = opts || {};
  var minDocFrequency = opts.minDocumentFrequency || 0.5;
  var maxOccPerDoc = opts.maxOccurrencesPerDoc || 2;
  var maxPosCV = opts.maxPositionCV || 0.35;
  var minTokenLen = opts.minTokenLength || 2;

  var docIds = Object.keys(batchTokens).filter(function (id) {
    return batchTokens[id] && batchTokens[id].tokens && batchTokens[id].tokens.length > 0;
  });
  var docCount = docIds.length;

  if (docCount < 2) {
    return {
      landmarks: [],
      documentCount: docCount,
      status: 'insufficient_documents',
      message: 'Need at least 2 documents with tokens for landmark discovery.',
      discoveredAt: new Date().toISOString()
    };
  }

  // Step 1: Build cross-document token index
  var tokenIndex = buildTokenIndex(batchTokens);

  // Step 2: Filter to stable tokens
  var stableTokens = [];
  var tokenTexts = Object.keys(tokenIndex);

  for (var ti = 0; ti < tokenTexts.length; ti++) {
    var text = tokenTexts[ti];
    var entry = tokenIndex[text];
    var docsWithToken = Object.keys(entry.docOccurrences);
    var docFrequency = docsWithToken.length / docCount;

    // Must appear on enough documents
    if (docFrequency < minDocFrequency) continue;

    // Must not appear too many times per document (ambiguity filter)
    var tooAmbiguous = false;
    for (var di = 0; di < docsWithToken.length; di++) {
      if (entry.docOccurrences[docsWithToken[di]].length > maxOccPerDoc) {
        tooAmbiguous = true;
        break;
      }
    }
    if (tooAmbiguous) continue;

    // Must have consistent position across documents
    // For tokens appearing once per doc: check position CV
    // For tokens appearing 2x per doc: pick the more consistent occurrence
    var positions = [];
    var bestPositions = {}; // docId → best position

    for (var dj = 0; dj < docsWithToken.length; dj++) {
      var dId = docsWithToken[dj];
      var occs = entry.docOccurrences[dId];

      if (occs.length === 1) {
        positions.push(occs[0]);
        bestPositions[dId] = occs[0];
      } else {
        // Multiple occurrences: pick the one closest to the mean position
        // across other documents (computed after first pass)
        // For now, pick the first occurrence
        positions.push(occs[0]);
        bestPositions[dId] = occs[0];
      }
    }

    // Compute position consistency
    var xs = positions.map(function (p) { return p.x; });
    var ys = positions.map(function (p) { return p.y; });
    var cvX = mean(xs) > 0.01 ? stddev(xs) / mean(xs) : stddev(xs);
    var cvY = mean(ys) > 0.01 ? stddev(ys) / mean(ys) : stddev(ys);
    var posCV = Math.max(cvX, cvY);

    if (posCV > maxPosCV) continue;

    // Passed all filters — this is a stable token
    var posStability = clamp(1 - posCV / maxPosCV, 0, 1);

    stableTokens.push({
      text: text,
      docFrequency: docFrequency,
      docCount: docsWithToken.length,
      positionStability: round(posStability),
      positions: bestPositions,
      meanX: round(mean(xs), 6),
      meanY: round(mean(ys), 6),
      meanW: round(mean(positions.map(function (p) { return p.w; })), 6),
      meanH: round(mean(positions.map(function (p) { return p.h; })), 6)
    });
  }

  // Step 3: Resolve multi-occurrence tokens
  // For tokens that appear 2x per doc, pick the occurrence closest to
  // the mean position computed from single-occurrence docs
  for (var si = 0; si < stableTokens.length; si++) {
    var st = stableTokens[si];
    var entry2 = tokenIndex[st.text];

    for (var dk = 0; dk < docIds.length; dk++) {
      var docId2 = docIds[dk];
      var occs2 = entry2.docOccurrences[docId2];
      if (!occs2 || occs2.length <= 1) continue;

      // Pick occurrence closest to the batch mean position
      var bestDist = Infinity;
      var bestOcc = occs2[0];
      for (var oi = 0; oi < occs2.length; oi++) {
        var dist = Math.sqrt(
          Math.pow(occs2[oi].x - st.meanX, 2) +
          Math.pow(occs2[oi].y - st.meanY, 2)
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestOcc = occs2[oi];
        }
      }
      st.positions[docId2] = bestOcc;
    }
  }

  // Step 4: Group adjacent stable tokens into landmark phrases
  // Tokens on the same line and close together form a phrase landmark
  var landmarks = groupIntoLandmarks(stableTokens, batchTokens, docIds);

  // Sort by confidence (frequency × position stability)
  landmarks.sort(function (a, b) { return b.confidence - a.confidence; });

  return {
    landmarks: landmarks,
    documentCount: docCount,
    stableTokenCount: stableTokens.length,
    status: landmarks.length > 0 ? 'discovered' : 'no_landmarks',
    message: landmarks.length > 0
      ? 'Discovered ' + landmarks.length + ' text landmark(s) across ' + docCount + ' documents.'
      : 'No stable text landmarks found across the batch.',
    discoveredAt: new Date().toISOString()
  };
}

/* ── 3. Landmark Grouping ─────────────────────────────────────────────── */

/**
 * Group adjacent stable tokens on the same line into landmark phrases.
 *
 * Two stable tokens are grouped if:
 * - They are on the same horizontal line (Y centroids within 0.5 × min height)
 * - They are adjacent (X gap < 2 × max token width in the pair)
 *
 * @param {object[]} stableTokens - Array of stable token descriptors
 * @param {object}   batchTokens  - Raw batch token data
 * @param {string[]} docIds       - Document IDs in the batch
 * @returns {object[]} TextLandmark[] - Grouped landmark phrases
 */
function groupIntoLandmarks(stableTokens, batchTokens, docIds) {
  if (stableTokens.length === 0) return [];

  // Sort stable tokens by mean position (Y then X) for grouping
  var sorted = stableTokens.slice().sort(function (a, b) {
    if (Math.abs(a.meanY - b.meanY) > 0.02) return a.meanY - b.meanY;
    return a.meanX - b.meanX;
  });

  // Build adjacency groups
  var used = {};
  var groups = [];

  for (var i = 0; i < sorted.length; i++) {
    if (used[i]) continue;

    var group = [sorted[i]];
    used[i] = true;

    // Try to extend the group with adjacent tokens
    var lastToken = sorted[i];
    for (var j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      var candidate = sorted[j];

      // Same line check: Y centroids close
      var yDiff = Math.abs(candidate.meanY - lastToken.meanY);
      var avgH = (lastToken.meanH + candidate.meanH) / 2;
      if (yDiff > avgH * 1.5) break; // Past this line

      // Adjacent check: X gap reasonable
      var xGap = candidate.meanX - (lastToken.meanX + lastToken.meanW / 2);
      var maxGap = Math.max(lastToken.meanW, candidate.meanW) * 2;

      if (xGap >= 0 && xGap < maxGap) {
        group.push(candidate);
        used[j] = true;
        lastToken = candidate;
      }
    }

    groups.push(group);
  }

  // Convert groups to landmarks
  var landmarks = [];
  var lmIdx = 0;

  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    var combinedText = g.map(function (t) { return t.text; }).join(' ');

    // Compute per-document positions for the group (bounding box of all tokens)
    var documentPositions = {};
    var avgFreq = mean(g.map(function (t) { return t.docFrequency; }));
    var avgStab = mean(g.map(function (t) { return t.positionStability; }));

    for (var dk = 0; dk < docIds.length; dk++) {
      var docId = docIds[dk];
      var allPresent = true;

      // Check all tokens in group have a position for this doc
      for (var tgi = 0; tgi < g.length; tgi++) {
        if (!g[tgi].positions[docId]) {
          allPresent = false;
          break;
        }
      }

      if (!allPresent) continue;

      // Compute bounding box of all tokens in the group
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var sumConf = 0;

      for (var tgi2 = 0; tgi2 < g.length; tgi2++) {
        var pos = g[tgi2].positions[docId];
        var tokenLeft = pos.x - pos.w / 2;
        var tokenRight = pos.x + pos.w / 2;
        var tokenTop = pos.y - pos.h / 2;
        var tokenBottom = pos.y + pos.h / 2;

        if (tokenLeft < minX) minX = tokenLeft;
        if (tokenRight > maxX) maxX = tokenRight;
        if (tokenTop < minY) minY = tokenTop;
        if (tokenBottom > maxY) maxY = tokenBottom;
        sumConf += pos.confidence;
      }

      documentPositions[docId] = {
        x: round((minX + maxX) / 2, 6),
        y: round((minY + maxY) / 2, 6),
        w: round(maxX - minX, 6),
        h: round(maxY - minY, 6),
        x0n: round(minX, 6),
        y0n: round(minY, 6),
        wN: round(maxX - minX, 6),
        hN: round(maxY - minY, 6),
        confidence: round(sumConf / g.length, 4)
      };
    }

    var docsWithLandmark = Object.keys(documentPositions).length;
    if (docsWithLandmark < 2) continue; // Not enough documents

    var confidence = clamp(
      (docsWithLandmark / docIds.length) * 0.5 + avgStab * 0.5,
      0, 1
    );

    landmarks.push({
      landmarkId: 'lm-' + lmIdx++,
      text: combinedText,
      tokenCount: g.length,
      frequency: round(docsWithLandmark / docIds.length, 4),
      positionStability: round(avgStab, 4),
      confidence: round(confidence, 4),
      documentPositions: documentPositions,
      meanPosition: {
        x: round(mean(g.map(function (t) { return t.meanX; })), 6),
        y: round(mean(g.map(function (t) { return t.meanY; })), 6)
      }
    });
  }

  // Also keep individual stable tokens as separate landmarks
  // (they may not group with anything but are still valuable)
  for (var si = 0; si < stableTokens.length; si++) {
    var st = stableTokens[si];
    // Check if this token is already part of a multi-token landmark
    var alreadyCovered = landmarks.some(function (lm) {
      return lm.tokenCount > 1 && lm.text.indexOf(st.text) >= 0 &&
        Math.abs(lm.meanPosition.x - st.meanX) < 0.05 &&
        Math.abs(lm.meanPosition.y - st.meanY) < 0.02;
    });

    if (alreadyCovered) continue;

    var docPositions = {};
    var docIdsForToken = Object.keys(st.positions);
    for (var dti = 0; dti < docIdsForToken.length; dti++) {
      var dId = docIdsForToken[dti];
      var pos = st.positions[dId];
      docPositions[dId] = {
        x: round(pos.x, 6),
        y: round(pos.y, 6),
        w: round(pos.w, 6),
        h: round(pos.h, 6),
        x0n: round(pos.x - pos.w / 2, 6),
        y0n: round(pos.y - pos.h / 2, 6),
        wN: round(pos.w, 6),
        hN: round(pos.h, 6),
        confidence: round(pos.confidence, 4)
      };
    }

    var docsCount = Object.keys(docPositions).length;
    if (docsCount < 2) continue;

    var conf = clamp(
      (docsCount / docIds.length) * 0.5 + st.positionStability * 0.5,
      0, 1
    );

    landmarks.push({
      landmarkId: 'lm-' + lmIdx++,
      text: st.text,
      tokenCount: 1,
      frequency: round(docsCount / docIds.length, 4),
      positionStability: st.positionStability,
      confidence: round(conf, 4),
      documentPositions: docPositions,
      meanPosition: {
        x: round(st.meanX, 6),
        y: round(st.meanY, 6)
      }
    });
  }

  return landmarks;
}

/* ── 4. Field Context Descriptor ──────────────────────────────────────── */

/**
 * Build a field context descriptor for a user-drawn BBOX on the reference
 * document.  Captures the relative position vectors from nearby text
 * landmarks to the BBOX center — the BBOX's "structural address."
 *
 * @param {object}   target      - { fieldKey, label, normBox: {x0n,y0n,wN,hN} }
 * @param {object[]} landmarks   - TextLandmark[] from discoverLandmarks()
 * @param {string}   refDocId    - Reference document ID
 * @param {object}   [opts]
 * @param {number}   [opts.maxDistance=0.4]    - Max distance to include a landmark (normalized)
 * @param {number}   [opts.maxLandmarks=10]    - Max context landmarks per field
 * @returns {object} FieldContextDescriptor
 */
function buildFieldContext(target, landmarks, refDocId, opts) {
  opts = opts || {};
  var maxDist = opts.maxDistance || 0.4;
  var maxLandmarks = opts.maxLandmarks || 10;

  var nb = target.normBox;
  var bboxCenter = {
    x: nb.x0n + nb.wN / 2,
    y: nb.y0n + nb.hN / 2
  };

  var contextLandmarks = [];

  for (var li = 0; li < landmarks.length; li++) {
    var lm = landmarks[li];
    var lmPos = lm.documentPositions[refDocId];
    if (!lmPos) continue;

    var relX = bboxCenter.x - lmPos.x;
    var relY = bboxCenter.y - lmPos.y;
    var distance = Math.sqrt(relX * relX + relY * relY);

    if (distance > maxDist) continue;

    contextLandmarks.push({
      landmarkId: lm.landmarkId,
      text: lm.text,
      relX: round(relX, 6),
      relY: round(relY, 6),
      distance: round(distance, 6),
      landmarkConfidence: lm.confidence,
      landmarkPosition: { x: lmPos.x, y: lmPos.y }
    });
  }

  // Sort by distance (closest first)
  contextLandmarks.sort(function (a, b) { return a.distance - b.distance; });

  // Limit to maxLandmarks
  if (contextLandmarks.length > maxLandmarks) {
    contextLandmarks = contextLandmarks.slice(0, maxLandmarks);
  }

  return {
    fieldKey: target.fieldKey,
    label: target.label,
    normBox: nb,
    bboxCenter: bboxCenter,
    contextLandmarks: contextLandmarks,
    contextLandmarkCount: contextLandmarks.length
  };
}

/* ── 5. Report Formatter ──────────────────────────────────────────────── */

function formatLandmarkReport(result) {
  if (!result) return '[No landmark data]';
  if (result.status === 'insufficient_documents') return result.message;

  var out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  TEXT LANDMARK DISCOVERY REPORT\n';
  out += '══════════════════════════════════════════════════════════════\n\n';
  out += '  Status: ' + result.status.toUpperCase().replace(/_/g, ' ') + '\n';
  out += '  Documents: ' + result.documentCount + '\n';
  out += '  Stable Tokens: ' + (result.stableTokenCount || 0) + '\n';
  out += '  Landmarks: ' + result.landmarks.length + '\n';
  out += '  ' + result.message + '\n';

  if (result.landmarks.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  DISCOVERED LANDMARKS\n';
    out += '──────────────────────────────────────────────────────────────\n';

    for (var li = 0; li < result.landmarks.length; li++) {
      var lm = result.landmarks[li];
      out += '\n  ' + lm.landmarkId + ': "' + lm.text + '"\n';
      out += '    Frequency: ' + (lm.frequency * 100).toFixed(0) + '% of docs\n';
      out += '    Position Stability: ' + (lm.positionStability * 100).toFixed(0) + '%\n';
      out += '    Confidence: ' + (lm.confidence * 100).toFixed(0) + '%\n';
      out += '    Mean Position: (' + (lm.meanPosition.x * 100).toFixed(1) + '%, ' +
        (lm.meanPosition.y * 100).toFixed(1) + '%)\n';
    }
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────── */

module.exports = {
  discoverLandmarks,
  buildFieldContext,
  buildTokenIndex,
  formatLandmarkReport,
  // Expose for testing
  normalizeText,
  normalizedEditDistance
};
