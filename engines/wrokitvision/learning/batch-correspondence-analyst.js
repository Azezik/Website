'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  batch-correspondence-analyst.js  –  Phase 2: Structural Correspondence
  ─────────────────────────────────────────────────────────────────────────────

  Operates on top of the Phase 1 batch structural summaries to discover
  cross-document structural correspondences.  It answers the question:
  "Across these documents, which structural elements correspond to each other?"

  ─── What it does ─────────────────────────────────────────────────────────

  1. Selects a reference document (structural centroid of the batch)
  2. Compares regions across documents using multi-dimensional similarity
  3. Identifies candidate region correspondences
  4. Discovers recurring structural anchors across the batch
  5. Produces a Template Alignment Model

  ─── What it does NOT do ──────────────────────────────────────────────────

  • Regenerate feature graphs
  • Modify OCR or segmentation pipelines
  • Alter Phase 1 stability metrics
  • Perform extraction

───────────────────────────────────────────────────────────────────────────────*/

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function euclideanDistance(a, b) {
  var sum = 0;
  for (var i = 0; i < a.length; i++) {
    var d = (a[i] || 0) - (b[i] || 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  var dot = 0, magA = 0, magB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  var denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function mean(arr) {
  return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
}

function round(v, decimals) {
  var f = Math.pow(10, decimals || 3);
  return Math.round(v * f) / f;
}

/* ── 1. Reference Document Selection ─────────────────────────────────────── */

/**
 * Select the document whose structural summary is most similar to all others.
 * Uses the normalizedSpatialDistribution and metrics as a proxy for
 * structural centrality.
 *
 * @param {object[]} documents - Array of full DocumentStructuralSummary objects
 * @returns {{ documentId: string, documentName: string, centralityScore: number, scores: object[] }}
 */
function selectReferenceDocument(documents) {
  if (!documents || documents.length === 0) return null;
  if (documents.length === 1) {
    return {
      documentId: documents[0].documentId,
      documentName: documents[0].documentName || '',
      centralityScore: 1,
      scores: [{ documentId: documents[0].documentId, avgSimilarity: 1 }]
    };
  }

  // Build a feature vector per document for centrality comparison:
  // [spatialDistribution(16), regionCount_norm, avgArea, avgTextDensity, avgConfidence, edgeCount_norm]
  var featureVectors = documents.map(function (d) {
    var sd = d.normalizedSpatialDistribution || [];
    var m = d.metrics || {};
    return sd.concat([
      (m.regionCount || 0) / 50,    // normalize to ~0-1 range
      m.avgRegionArea || 0,
      m.avgTextDensity || 0,
      m.avgConfidence || 0,
      (m.edgeCount || 0) / 100      // normalize to ~0-1 range
    ]);
  });

  // Compute avg cosine similarity of each doc to all others
  var scores = [];
  for (var i = 0; i < documents.length; i++) {
    var totalSim = 0;
    var count = 0;
    for (var j = 0; j < documents.length; j++) {
      if (i === j) continue;
      totalSim += cosineSimilarity(featureVectors[i], featureVectors[j]);
      count++;
    }
    scores.push({
      documentId: documents[i].documentId,
      documentName: documents[i].documentName || '',
      avgSimilarity: count > 0 ? totalSim / count : 0
    });
  }

  // Pick highest centrality
  scores.sort(function (a, b) { return b.avgSimilarity - a.avgSimilarity; });
  var best = scores[0];

  return {
    documentId: best.documentId,
    documentName: best.documentName,
    centralityScore: round(best.avgSimilarity),
    scores: scores.map(function (s) {
      return { documentId: s.documentId, documentName: s.documentName, avgSimilarity: round(s.avgSimilarity) };
    })
  };
}

/* ── 2. Region Similarity Computation ────────────────────────────────────── */

/**
 * Compute a multi-dimensional similarity score between two regions.
 *
 * Structure-first design: the primary signals are geometric shape,
 * spatial layout, containment depth, and neighborhood topology.
 * Text/semantic signals are retained as supporting evidence only.
 *
 * Dimensions considered (ordered by weight):
 * - Position similarity (normalized bbox centroids)
 * - Shape similarity (aspect ratio, rectangularity, solidity)
 * - Dimension similarity (normalized width + height)
 * - Structural topology (neighbor count, edge type distribution, containment depth)
 * - Semantic similarity (surface type, confidence — text density down-weighted)
 *
 * @param {object} regionA - Region descriptor from document A
 * @param {object} regionB - Region descriptor from document B
 * @param {object} nhA - Neighborhood descriptor for regionA
 * @param {object} nhB - Neighborhood descriptor for regionB
 * @returns {{ similarity: number, dimensions: object }}
 */
function computeRegionSimilarity(regionA, regionB, nhA, nhB) {
  nhA = nhA || {};
  nhB = nhB || {};

  // Position similarity: 1 - euclidean distance between centroids
  var positionDist = Math.sqrt(
    Math.pow((regionA.centroid.x - regionB.centroid.x), 2) +
    Math.pow((regionA.centroid.y - regionB.centroid.y), 2)
  );
  var positionSimilarity = clamp(1 - positionDist / 1.414, 0, 1);

  // Shape similarity: aspect ratio + rectangularity + solidity
  var arA = Math.min(regionA.aspectRatio, 10);
  var arB = Math.min(regionB.aspectRatio, 10);
  var arDiff = Math.abs(arA - arB);
  var maxAr = Math.max(arA, arB, 0.1);
  var aspectSimilarity = clamp(1 - arDiff / maxAr, 0, 1);

  var featA = regionA.features || {};
  var featB = regionB.features || {};
  var rectSim = 1 - Math.abs((featA.rectangularity || 1) - (featB.rectangularity || 1));
  var solidSim = 1 - Math.abs((featA.solidity || 1) - (featB.solidity || 1));

  var shapeSimilarity = clamp(aspectSimilarity * 0.5 + rectSim * 0.25 + solidSim * 0.25, 0, 1);

  // Size similarity: compare normalized areas
  var areaDiff = Math.abs(regionA.normalizedArea - regionB.normalizedArea);
  var maxArea = Math.max(regionA.normalizedArea, regionB.normalizedArea, 0.001);
  var sizeSimilarity = clamp(1 - areaDiff / maxArea, 0, 1);

  // Dimension similarity (width and height independently)
  var wDiff = Math.abs(regionA.normalizedBbox.w - regionB.normalizedBbox.w);
  var hDiff = Math.abs(regionA.normalizedBbox.h - regionB.normalizedBbox.h);
  var dimensionSimilarity = clamp(1 - (wDiff + hDiff), 0, 1);

  // Structural topology similarity (enhanced)
  var ncA = nhA.neighborCount || 0;
  var ncB = nhB.neighborCount || 0;
  var maxNc = Math.max(ncA, ncB, 1);
  var neighborCountSim = 1 - Math.abs(ncA - ncB) / maxNc;

  var ewA = nhA.avgEdgeWeight || 0;
  var ewB = nhB.avgEdgeWeight || 0;
  var edgeWeightSim = 1 - Math.abs(ewA - ewB);

  // Edge type distribution similarity
  var edgeTypeSim = 1;
  if (nhA.edgeTypeDist && nhB.edgeTypeDist) {
    var distA = nhA.edgeTypeDist;
    var distB = nhB.edgeTypeDist;
    var totalA = (distA.contains || 0) + (distA.spatial_proximity || 0) + (distA.spatial_adjacency || 0);
    var totalB = (distB.contains || 0) + (distB.spatial_proximity || 0) + (distB.spatial_adjacency || 0);
    if (totalA > 0 && totalB > 0) {
      var cSim = 1 - Math.abs((distA.contains || 0) / totalA - (distB.contains || 0) / totalB);
      var pSim = 1 - Math.abs((distA.spatial_proximity || 0) / totalA - (distB.spatial_proximity || 0) / totalB);
      var aSim = 1 - Math.abs((distA.spatial_adjacency || 0) / totalA - (distB.spatial_adjacency || 0) / totalB);
      edgeTypeSim = (cSim + pSim + aSim) / 3;
    }
  }

  // Containment depth similarity
  var depthA = nhA.containmentDepth || 0;
  var depthB = nhB.containmentDepth || 0;
  var depthSim = 1 - Math.abs(depthA - depthB) / Math.max(depthA, depthB, 1);

  var topologySimilarity = clamp(
    neighborCountSim * 0.25 +
    edgeWeightSim * 0.15 +
    edgeTypeSim * 0.35 +
    depthSim * 0.25, 0, 1);

  // Semantic similarity: surface type + confidence (text density down-weighted)
  var confSim = 1 - Math.abs(regionA.confidence - regionB.confidence);
  var typeSim = regionA.surfaceType === regionB.surfaceType ? 1 : 0.3;
  var tdSim = 1 - Math.abs(regionA.textDensity - regionB.textDensity);

  // Surface type and confidence are structural signals; text density is text-based
  var semanticSimilarity = clamp(typeSim * 0.5 + confSim * 0.35 + tdSim * 0.15, 0, 1);

  // Structure-first weighted combination
  // Geometry/structure: position(25) + shape(15) + size(10) + dimension(10) + topology(25) = 85%
  // Text/semantic: semantic(15) = 15%
  var weights = {
    position: 0.25,
    shape: 0.15,
    size: 0.10,
    dimension: 0.10,
    topology: 0.25,
    semantic: 0.15
  };

  var combined =
    positionSimilarity * weights.position +
    shapeSimilarity * weights.shape +
    sizeSimilarity * weights.size +
    dimensionSimilarity * weights.dimension +
    topologySimilarity * weights.topology +
    semanticSimilarity * weights.semantic;

  return {
    similarity: round(combined, 4),
    dimensions: {
      position: round(positionSimilarity, 4),
      shape: round(shapeSimilarity, 4),
      size: round(sizeSimilarity, 4),
      dimension: round(dimensionSimilarity, 4),
      topology: round(topologySimilarity, 4),
      semantic: round(semanticSimilarity, 4)
    }
  };
}

/* ── 3. Cross-Document Region Matching ───────────────────────────────────── */

/**
 * For each region in the reference document, find the best matching region
 * in the target document using the multi-dimensional similarity score.
 *
 * Uses a greedy assignment: best matches are assigned first, each target
 * region can only be matched once.
 *
 * @param {object} refDoc - Reference document summary (full)
 * @param {object} targetDoc - Target document summary (full)
 * @param {object} opts - { minSimilarity: number }
 * @returns {object[]} Array of match objects
 */
function matchDocumentRegions(refDoc, targetDoc, opts) {
  opts = opts || {};
  var minSimilarity = opts.minSimilarity || 0.4;

  var refRegions = refDoc.regionDescriptors || [];
  var tgtRegions = targetDoc.regionDescriptors || [];
  var refNH = refDoc.neighborhoodDescriptors || {};
  var tgtNH = targetDoc.neighborhoodDescriptors || {};

  if (!refRegions.length || !tgtRegions.length) return [];

  // Compute all pairwise similarities
  var candidates = [];
  for (var ri = 0; ri < refRegions.length; ri++) {
    for (var ti = 0; ti < tgtRegions.length; ti++) {
      var sim = computeRegionSimilarity(
        refRegions[ri], tgtRegions[ti],
        refNH[refRegions[ri].regionId],
        tgtNH[tgtRegions[ti].regionId]
      );
      if (sim.similarity >= minSimilarity) {
        candidates.push({
          refRegionId: refRegions[ri].regionId,
          refRegionIdx: ri,
          tgtRegionId: tgtRegions[ti].regionId,
          tgtRegionIdx: ti,
          similarity: sim.similarity,
          dimensions: sim.dimensions
        });
      }
    }
  }

  // Sort by similarity descending
  candidates.sort(function (a, b) { return b.similarity - a.similarity; });

  // Two-pass greedy assignment: first pass assigns greedily, second pass
  // attempts to improve by finding swaps that increase total similarity.
  var usedRef = {};
  var usedTgt = {};
  var matches = [];
  var matchByRef = {};
  var matchByTgt = {};

  // Pass 1: Standard greedy assignment
  for (var ci = 0; ci < candidates.length; ci++) {
    var c = candidates[ci];
    if (usedRef[c.refRegionId] || usedTgt[c.tgtRegionId]) continue;
    usedRef[c.refRegionId] = true;
    usedTgt[c.tgtRegionId] = true;
    var m = {
      refRegionId: c.refRegionId,
      tgtRegionId: c.tgtRegionId,
      tgtDocumentId: targetDoc.documentId,
      tgtDocumentName: targetDoc.documentName || '',
      similarity: c.similarity,
      dimensions: c.dimensions
    };
    matches.push(m);
    matchByRef[c.refRegionId] = m;
    matchByTgt[c.tgtRegionId] = m;
  }

  // Pass 2: Attempt improvement swaps — check if any unmatched pair would
  // produce a higher total similarity by displacing an existing match
  for (var ci2 = 0; ci2 < candidates.length; ci2++) {
    var c2 = candidates[ci2];
    if (usedRef[c2.refRegionId] && usedTgt[c2.tgtRegionId]) continue;
    if (!usedRef[c2.refRegionId] && !usedTgt[c2.tgtRegionId]) continue; // both free, already handled

    // Check if this candidate can improve by displacing an existing match
    var existingRef = matchByRef[c2.refRegionId];
    var existingTgt = matchByTgt[c2.tgtRegionId];

    if (existingRef && !usedTgt[c2.tgtRegionId]) {
      // c2 wants refRegion that's already matched; compare scores
      if (c2.similarity > existingRef.similarity) {
        // Displace existing match, free its target
        delete usedTgt[existingRef.tgtRegionId];
        delete matchByTgt[existingRef.tgtRegionId];
        matches.splice(matches.indexOf(existingRef), 1);
        // Assign new match
        usedTgt[c2.tgtRegionId] = true;
        var m2 = {
          refRegionId: c2.refRegionId, tgtRegionId: c2.tgtRegionId,
          tgtDocumentId: targetDoc.documentId, tgtDocumentName: targetDoc.documentName || '',
          similarity: c2.similarity, dimensions: c2.dimensions
        };
        matches.push(m2);
        matchByRef[c2.refRegionId] = m2;
        matchByTgt[c2.tgtRegionId] = m2;
      }
    } else if (existingTgt && !usedRef[c2.refRegionId]) {
      if (c2.similarity > existingTgt.similarity) {
        delete usedRef[existingTgt.refRegionId];
        delete matchByRef[existingTgt.refRegionId];
        matches.splice(matches.indexOf(existingTgt), 1);
        usedRef[c2.refRegionId] = true;
        var m3 = {
          refRegionId: c2.refRegionId, tgtRegionId: c2.tgtRegionId,
          tgtDocumentId: targetDoc.documentId, tgtDocumentName: targetDoc.documentName || '',
          similarity: c2.similarity, dimensions: c2.dimensions
        };
        matches.push(m3);
        matchByRef[c2.refRegionId] = m3;
        matchByTgt[c2.tgtRegionId] = m3;
      }
    }
  }

  return matches;
}

/* ── 4. Batch Correspondence & Anchor Discovery ──────────────────────────── */

/**
 * Run cross-document correspondence analysis across the entire batch.
 *
 * @param {object[]} documents - Array of full DocumentStructuralSummary objects
 *                               (must have regionDescriptors, not compact)
 * @param {object}   [opts]   - Options
 * @param {number}   [opts.minSimilarity=0.4]   - Minimum similarity for a match
 * @param {number}   [opts.anchorMinFrequency=0.5] - Min frequency (0-1) for an anchor
 * @param {string}   [opts.referenceDocumentId]  - Force a specific reference document
 * @returns {object} CorrespondenceResult
 */
function analyzeCorrespondence(documents, opts) {
  opts = opts || {};
  var minSimilarity = opts.minSimilarity || 0.4;
  var anchorMinFrequency = opts.anchorMinFrequency || 0.5;

  // Validate inputs
  if (!Array.isArray(documents) || documents.length < 2) {
    return {
      status: 'insufficient_data',
      message: documents && documents.length === 1
        ? 'Need at least 2 documents for correspondence analysis. Currently have 1.'
        : 'No documents provided for correspondence analysis.',
      referenceDocument: null,
      correspondences: [],
      anchors: [],
      alignmentModel: null,
      analyzedAt: new Date().toISOString()
    };
  }

  // Filter to structurally valid documents with full region data
  var validDocs = [];
  var skippedDocs = [];
  for (var di = 0; di < documents.length; di++) {
    var doc = documents[di];
    var isValid = doc.structurallyValid !== false &&
      doc.regionDescriptors && doc.regionDescriptors.length > 0 &&
      !doc._compact;
    if (isValid) {
      validDocs.push(doc);
    } else {
      skippedDocs.push({
        documentId: doc.documentId || '(unknown)',
        documentName: doc.documentName || '(unnamed)',
        reason: doc._compact
          ? 'Compact summary — full region data required (re-upload document)'
          : doc.structurallyValid === false
            ? (doc.validationReason || 'Not structurally valid')
            : 'No region descriptors available'
      });
    }
  }

  if (validDocs.length < 2) {
    return {
      status: 'insufficient_valid_data',
      message: 'Need at least 2 documents with full structural data for correspondence analysis. ' +
        'Found ' + validDocs.length + ' valid out of ' + documents.length + ' total. ' +
        (skippedDocs.length > 0
          ? skippedDocs.length + ' document(s) were skipped (compact or invalid).'
          : ''),
      skippedDocuments: skippedDocs,
      referenceDocument: null,
      correspondences: [],
      anchors: [],
      alignmentModel: null,
      analyzedAt: new Date().toISOString()
    };
  }

  // Step 1: Select reference document
  var refSelection;
  if (opts.referenceDocumentId) {
    var forcedRef = validDocs.find(function (d) { return d.documentId === opts.referenceDocumentId; });
    if (forcedRef) {
      refSelection = {
        documentId: forcedRef.documentId,
        documentName: forcedRef.documentName || '',
        centralityScore: null,
        scores: null
      };
    } else {
      refSelection = selectReferenceDocument(validDocs);
    }
  } else {
    refSelection = selectReferenceDocument(validDocs);
  }

  var refDoc = validDocs.find(function (d) { return d.documentId === refSelection.documentId; });

  // Step 2: Match regions across all non-reference documents
  var allCorrespondences = [];
  var otherDocs = validDocs.filter(function (d) { return d.documentId !== refDoc.documentId; });

  for (var oi = 0; oi < otherDocs.length; oi++) {
    var matches = matchDocumentRegions(refDoc, otherDocs[oi], { minSimilarity: minSimilarity });
    for (var mi = 0; mi < matches.length; mi++) {
      allCorrespondences.push(matches[mi]);
    }
  }

  // Step 3: Aggregate matches to discover anchors
  // For each reference region, count how many documents it matched in
  var refRegions = refDoc.regionDescriptors || [];
  var refNH = refDoc.neighborhoodDescriptors || {};
  var anchorCandidates = {};

  for (var ri = 0; ri < refRegions.length; ri++) {
    var rr = refRegions[ri];
    anchorCandidates[rr.regionId] = {
      refRegionId: rr.regionId,
      normalizedBbox: rr.normalizedBbox,
      centroid: rr.centroid,
      normalizedArea: rr.normalizedArea,
      aspectRatio: rr.aspectRatio,
      surfaceType: rr.surfaceType,
      textDensity: rr.textDensity,
      confidence: rr.confidence,
      neighborhoodDescriptor: refNH[rr.regionId] || {},
      matchedDocuments: [],
      matchSimilarities: [],
      matchDimensions: []
    };
  }

  for (var ci = 0; ci < allCorrespondences.length; ci++) {
    var corr = allCorrespondences[ci];
    var anchor = anchorCandidates[corr.refRegionId];
    if (anchor) {
      anchor.matchedDocuments.push(corr.tgtDocumentId);
      anchor.matchSimilarities.push(corr.similarity);
      anchor.matchDimensions.push(corr.dimensions);
    }
  }

  // Step 4: Filter to recurring anchors
  var totalOtherDocs = otherDocs.length;
  var anchors = [];

  // Soft frequency threshold: anchors below anchorMinFrequency are still
  // included but with a penalized confidence, down to a hard floor of
  // anchorMinFrequency * 0.5.  This captures "almost anchors" that appear
  // in ~40% of docs instead of silently discarding them.
  var softFloor = anchorMinFrequency * 0.5;

  for (var regionId in anchorCandidates) {
    if (!anchorCandidates.hasOwnProperty(regionId)) continue;
    var ac = anchorCandidates[regionId];
    var frequency = totalOtherDocs > 0 ? ac.matchedDocuments.length / totalOtherDocs : 0;

    // Hard floor: skip truly rare matches
    if (frequency < softFloor) continue;

    var avgSimilarity = mean(ac.matchSimilarities);

    // Compute average dimension scores across matches
    var avgDimensions = {};
    if (ac.matchDimensions.length > 0) {
      var dimKeys = Object.keys(ac.matchDimensions[0]);
      for (var dki = 0; dki < dimKeys.length; dki++) {
        var dk = dimKeys[dki];
        avgDimensions[dk] = round(mean(ac.matchDimensions.map(function (md) { return md[dk] || 0; })), 4);
      }
    }

    // Confidence: combines frequency and avg similarity.
    // Apply a soft penalty for anchors below the frequency threshold
    // instead of a hard cutoff.
    var frequencyFactor = frequency >= anchorMinFrequency
      ? frequency
      : frequency * (frequency / anchorMinFrequency); // quadratic decay below threshold
    var anchorConfidence = clamp(frequencyFactor * 0.5 + avgSimilarity * 0.5, 0, 1);

    anchors.push({
      anchorId: 'anchor-' + regionId,
      refRegionId: ac.refRegionId,
      normalizedPosition: ac.centroid,
      normalizedBbox: ac.normalizedBbox,
      normalizedArea: ac.normalizedArea,
      aspectRatio: round(ac.aspectRatio, 4),
      surfaceType: ac.surfaceType,
      textDensity: round(ac.textDensity, 4),
      frequency: round(frequency, 4),
      matchCount: ac.matchedDocuments.length,
      totalDocuments: totalOtherDocs,
      avgSimilarity: round(avgSimilarity, 4),
      avgDimensions: avgDimensions,
      confidence: round(anchorConfidence, 4),
      matchedDocumentIds: ac.matchedDocuments
    });
  }

  // Sort anchors by confidence descending
  anchors.sort(function (a, b) { return b.confidence - a.confidence; });

  // Step 5: Build Template Alignment Model
  var alignmentModel = {
    referenceDocumentId: refDoc.documentId,
    referenceDocumentName: refDoc.documentName || '',
    anchorCount: anchors.length,
    totalRegionsInReference: refRegions.length,
    anchorCoverage: refRegions.length > 0 ? round(anchors.length / refRegions.length, 4) : 0,
    avgAnchorConfidence: anchors.length > 0 ? round(mean(anchors.map(function (a) { return a.confidence; })), 4) : 0,
    avgAnchorFrequency: anchors.length > 0 ? round(mean(anchors.map(function (a) { return a.frequency; })), 4) : 0,
    documentCount: validDocs.length,
    anchors: anchors,
    createdAt: new Date().toISOString()
  };

  // Determine overall status
  var status = 'complete';
  var message = '';
  if (anchors.length === 0) {
    status = 'no_anchors_found';
    message = 'No recurring structural anchors were found across the batch. ' +
      'This may indicate high structural variability or that documents do not share a common template.';
  } else if (alignmentModel.avgAnchorConfidence < 0.5) {
    status = 'low_confidence';
    message = 'Structural correspondences were found but with low confidence. ' +
      'The documents may share a template but with significant variation.';
  } else {
    message = 'Discovered ' + anchors.length + ' structural anchor(s) across ' +
      validDocs.length + ' documents with ' + round(alignmentModel.avgAnchorConfidence * 100, 1) +
      '% average confidence.';
  }

  return {
    status: status,
    message: message,
    analyzedAt: new Date().toISOString(),
    documentCount: documents.length,
    validDocumentCount: validDocs.length,
    skippedDocuments: skippedDocs,
    referenceDocument: {
      documentId: refSelection.documentId,
      documentName: refSelection.documentName,
      centralityScore: refSelection.centralityScore,
      centralityScores: refSelection.scores
    },
    correspondences: allCorrespondences,
    anchors: anchors,
    alignmentModel: alignmentModel
  };
}

/* ── Report Formatter ────────────────────────────────────────────────────── */

/**
 * Format a correspondence analysis result as a human-readable text report.
 *
 * @param {object} result - Output from analyzeCorrespondence()
 * @returns {string}
 */
function formatCorrespondenceReport(result) {
  if (!result) return '[No correspondence data]';
  if (result.status === 'insufficient_data' || result.status === 'insufficient_valid_data') {
    return result.message;
  }

  var out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  STRUCTURAL CORRESPONDENCE REPORT (Phase 2)\n';
  out += '══════════════════════════════════════════════════════════════\n\n';

  out += '  Status: ' + result.status.toUpperCase().replace(/_/g, ' ') + '\n';
  out += '  Documents analyzed: ' + result.validDocumentCount +
    (result.skippedDocuments && result.skippedDocuments.length > 0
      ? ' (' + result.skippedDocuments.length + ' skipped)'
      : '') + '\n';
  out += '  Analyzed at: ' + result.analyzedAt + '\n\n';
  out += '  ' + result.message + '\n';

  if (result.skippedDocuments && result.skippedDocuments.length > 0) {
    out += '\n  SKIPPED DOCUMENTS:\n';
    for (var si = 0; si < result.skippedDocuments.length; si++) {
      var sd = result.skippedDocuments[si];
      out += '    - ' + (sd.documentName || sd.documentId) + ': ' + sd.reason + '\n';
    }
  }

  // Reference document
  if (result.referenceDocument) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  REFERENCE DOCUMENT\n';
    out += '──────────────────────────────────────────────────────────────\n\n';
    out += '  Selected: ' + (result.referenceDocument.documentName || result.referenceDocument.documentId) + '\n';
    if (result.referenceDocument.centralityScore != null) {
      out += '  Centrality Score: ' + (result.referenceDocument.centralityScore * 100).toFixed(1) + '%\n';
    }
  }

  // Anchors
  if (result.anchors && result.anchors.length > 0) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  STRUCTURAL ANCHORS (' + result.anchors.length + ' discovered)\n';
    out += '──────────────────────────────────────────────────────────────\n';

    for (var ai = 0; ai < result.anchors.length; ai++) {
      var a = result.anchors[ai];
      out += '\n  Anchor ' + (ai + 1) + ': ' + a.anchorId + '\n';
      out += '    Position: (' + (a.normalizedPosition.x * 100).toFixed(1) + '%, ' +
        (a.normalizedPosition.y * 100).toFixed(1) + '%)\n';
      out += '    Size: ' + (a.normalizedArea * 100).toFixed(2) + '% of page\n';
      out += '    Type: ' + a.surfaceType + '\n';
      out += '    Frequency: ' + a.matchCount + '/' + a.totalDocuments +
        ' (' + (a.frequency * 100).toFixed(0) + '%)\n';
      out += '    Confidence: ' + _confidenceBar(a.confidence) + '  ' +
        (a.confidence * 100).toFixed(1) + '%\n';
      out += '    Avg Similarity: ' + (a.avgSimilarity * 100).toFixed(1) + '%\n';
    }
  } else {
    out += '\n  No structural anchors discovered.\n';
  }

  // Alignment model summary
  if (result.alignmentModel) {
    var am = result.alignmentModel;
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  TEMPLATE ALIGNMENT MODEL\n';
    out += '──────────────────────────────────────────────────────────────\n\n';
    out += '  Anchors: ' + am.anchorCount + ' / ' + am.totalRegionsInReference + ' reference regions\n';
    out += '  Anchor Coverage: ' + (am.anchorCoverage * 100).toFixed(1) + '%\n';
    out += '  Avg Anchor Confidence: ' + (am.avgAnchorConfidence * 100).toFixed(1) + '%\n';
    out += '  Avg Anchor Frequency: ' + (am.avgAnchorFrequency * 100).toFixed(1) + '%\n';
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

function _confidenceBar(confidence) {
  var filled = Math.round(confidence * 20);
  var empty = 20 - filled;
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ']';
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  analyzeCorrespondence,
  formatCorrespondenceReport,
  selectReferenceDocument,
  computeRegionSimilarity,
  matchDocumentRegions
};
