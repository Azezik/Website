'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  batch-structural-analyst.js  –  Analyzes structural consistency across a
                                    batch of documents sharing the same layout
  ─────────────────────────────────────────────────────────────────────────────

  This module implements Phase 1 of the batch structural learning system.
  It computes stability metrics across documents within a batch session and
  identifies which feature generation parameters are most likely responsible
  for structural inconsistency.

  ─── What it measures ───────────────────────────────────────────────────────

  1. Region count variance across documents
  2. Average region area variance
  3. Region density differences
  4. Adjacency graph similarity (edge count, edge type distribution)
  5. Spatial distribution differences (grid-based density comparison)
  6. Text structure consistency (line/block counts)
  7. Surface type distribution consistency

  ─── What it recommends ─────────────────────────────────────────────────────

  Based on the stability metrics, the analyst identifies which parameters
  are likely responsible for instability:
  - Region segmentation thresholds
  - Color tolerance parameters
  - Edge detection thresholds
  - Region merge/split thresholds
  - Visual proposal thresholds

  ─── Output ─────────────────────────────────────────────────────────────────

  The output is a BatchStabilityReport containing:
  - Per-metric stability scores (0 = unstable, 1 = perfectly stable)
  - An overall stability score
  - Parameter-specific diagnoses
  - Recommended parameter adjustments
  - Preserved intermediate data for future phases

───────────────────────────────────────────────────────────────────────────────*/

/* ── Statistical helpers ────────────────────────────────────────────────── */

function mean(arr) {
  return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (arr.length - 1);
}

function stddev(arr) {
  return Math.sqrt(variance(arr));
}

function coefficientOfVariation(arr) {
  const m = mean(arr);
  if (m === 0) return arr.length > 1 && stddev(arr) > 0 ? Infinity : 0;
  return stddev(arr) / Math.abs(m);
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Jensen-Shannon divergence between two probability distributions.
 * Returns a value between 0 (identical) and 1 (maximally different).
 */
function jensenShannonDivergence(p, q) {
  if (!p || !q || p.length !== q.length || p.length === 0) return 1;
  const m = p.map(function (_, i) { return (p[i] + q[i]) / 2; });
  let klPM = 0, klQM = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && m[i] > 0) klPM += p[i] * Math.log2(p[i] / m[i]);
    if (q[i] > 0 && m[i] > 0) klQM += q[i] * Math.log2(q[i] / m[i]);
  }
  return clamp((klPM + klQM) / 2, 0, 1);
}

/**
 * Convert a CV (coefficient of variation) to a 0-1 stability score.
 * Lower CV = higher stability.
 */
function cvToStability(cv) {
  // CV of 0 = perfect stability (1.0), CV >= 1 = very unstable (near 0)
  return clamp(1 - cv, 0, 1);
}

/* ── 1. Region count stability ──────────────────────────────────────────── */

function analyzeRegionCountStability(documents) {
  const counts = documents.map(function (d) { return d.metrics.regionCount; });
  const cv = coefficientOfVariation(counts);
  return {
    metric: 'region_count',
    stability: cvToStability(cv),
    values: counts,
    mean: Math.round(mean(counts) * 100) / 100,
    stddev: Math.round(stddev(counts) * 100) / 100,
    cv: Math.round(cv * 1000) / 1000,
    min: Math.min.apply(null, counts),
    max: Math.max.apply(null, counts),
    median: median(counts)
  };
}

/* ── 2. Region area stability ───────────────────────────────────────────── */

function analyzeRegionAreaStability(documents) {
  const avgAreas = documents.map(function (d) { return d.metrics.avgRegionArea; });
  const cv = coefficientOfVariation(avgAreas);

  // Also measure per-region area variance across documents
  const allAreas = [];
  for (const doc of documents) {
    for (const rd of doc.regionDescriptors) {
      allAreas.push(rd.normalizedArea);
    }
  }

  return {
    metric: 'region_area',
    stability: cvToStability(cv),
    avgAreaPerDocument: avgAreas,
    mean: Math.round(mean(avgAreas) * 10000) / 10000,
    stddev: Math.round(stddev(avgAreas) * 10000) / 10000,
    cv: Math.round(cv * 1000) / 1000,
    globalAreaMean: Math.round(mean(allAreas) * 10000) / 10000,
    globalAreaStddev: Math.round(stddev(allAreas) * 10000) / 10000
  };
}

/* ── 3. Region density stability ────────────────────────────────────────── */

function analyzeRegionDensityStability(documents) {
  const densities = documents.map(function (d) { return d.metrics.avgTextDensity; });
  const cv = coefficientOfVariation(densities);
  return {
    metric: 'region_density',
    stability: cvToStability(cv),
    values: densities,
    mean: Math.round(mean(densities) * 1000) / 1000,
    stddev: Math.round(stddev(densities) * 1000) / 1000,
    cv: Math.round(cv * 1000) / 1000
  };
}

/* ── 4. Adjacency graph stability ───────────────────────────────────────── */

function analyzeAdjacencyGraphStability(documents) {
  const edgeCounts = documents.map(function (d) { return d.metrics.edgeCount; });
  const cvEdges = coefficientOfVariation(edgeCounts);

  // Edge type distribution similarity
  const edgeTypeDistributions = documents.map(function (d) {
    const types = { spatial_proximity: 0, contains: 0, other: 0 };
    const total = d.adjacencyEdges.length || 1;
    for (const e of d.adjacencyEdges) {
      if (types.hasOwnProperty(e.edgeType)) types[e.edgeType]++;
      else types.other++;
    }
    return [types.spatial_proximity / total, types.contains / total, types.other / total];
  });

  // Average pairwise JS divergence of edge type distributions
  let totalJSD = 0;
  let pairCount = 0;
  for (let i = 0; i < edgeTypeDistributions.length; i++) {
    for (let j = i + 1; j < edgeTypeDistributions.length; j++) {
      totalJSD += jensenShannonDivergence(edgeTypeDistributions[i], edgeTypeDistributions[j]);
      pairCount++;
    }
  }
  const avgJSD = pairCount > 0 ? totalJSD / pairCount : 0;

  // Average edge weight consistency
  const avgWeights = documents.map(function (d) {
    if (!d.adjacencyEdges.length) return 0;
    return d.adjacencyEdges.reduce(function (s, e) { return s + e.weight; }, 0) / d.adjacencyEdges.length;
  });
  const cvWeights = coefficientOfVariation(avgWeights);

  // Combined graph stability
  const edgeCountStability = cvToStability(cvEdges);
  const edgeDistStability = clamp(1 - avgJSD, 0, 1);
  const edgeWeightStability = cvToStability(cvWeights);
  const combinedStability = (edgeCountStability * 0.4 + edgeDistStability * 0.35 + edgeWeightStability * 0.25);

  return {
    metric: 'adjacency_graph',
    stability: Math.round(combinedStability * 1000) / 1000,
    edgeCountStability: Math.round(edgeCountStability * 1000) / 1000,
    edgeTypeDistributionStability: Math.round(edgeDistStability * 1000) / 1000,
    edgeWeightStability: Math.round(edgeWeightStability * 1000) / 1000,
    edgeCounts: edgeCounts,
    avgEdgeTypeJSD: Math.round(avgJSD * 1000) / 1000,
    avgEdgeWeightCV: Math.round(cvWeights * 1000) / 1000
  };
}

/* ── 5. Spatial distribution stability ──────────────────────────────────── */

function analyzeSpatialDistributionStability(documents) {
  const distributions = documents.map(function (d) { return d.normalizedSpatialDistribution; });

  // Average pairwise cosine similarity
  let totalSim = 0;
  let pairCount = 0;
  for (let i = 0; i < distributions.length; i++) {
    for (let j = i + 1; j < distributions.length; j++) {
      totalSim += cosineSimilarity(distributions[i], distributions[j]);
      pairCount++;
    }
  }
  const avgSimilarity = pairCount > 0 ? totalSim / pairCount : 1;

  // Also compute per-cell variance
  const gridSize = distributions[0] ? distributions[0].length : 0;
  const cellVariances = [];
  for (let c = 0; c < gridSize; c++) {
    const cellValues = distributions.map(function (d) { return d[c] || 0; });
    cellVariances.push(variance(cellValues));
  }
  const avgCellVariance = mean(cellVariances);

  return {
    metric: 'spatial_distribution',
    stability: Math.round(clamp(avgSimilarity, 0, 1) * 1000) / 1000,
    avgPairwiseCosineSimilarity: Math.round(avgSimilarity * 1000) / 1000,
    avgCellVariance: Math.round(avgCellVariance * 10000) / 10000,
    cellVariances: cellVariances.map(function (v) { return Math.round(v * 10000) / 10000; })
  };
}

/* ── 6. Text structure stability ────────────────────────────────────────── */

function analyzeTextStructureStability(documents) {
  const lineCounts = documents.map(function (d) { return d.textStructure.lineCount; });
  const blockCounts = documents.map(function (d) { return d.textStructure.blockCount; });
  const tokenCounts = documents.map(function (d) { return d.textStructure.tokenCount; });

  const cvLines = coefficientOfVariation(lineCounts);
  const cvBlocks = coefficientOfVariation(blockCounts);
  const cvTokens = coefficientOfVariation(tokenCounts);

  const lineStability = cvToStability(cvLines);
  const blockStability = cvToStability(cvBlocks);
  const tokenStability = cvToStability(cvTokens);
  const combined = (lineStability * 0.35 + blockStability * 0.35 + tokenStability * 0.3);

  return {
    metric: 'text_structure',
    stability: Math.round(combined * 1000) / 1000,
    lineCountStability: Math.round(lineStability * 1000) / 1000,
    blockCountStability: Math.round(blockStability * 1000) / 1000,
    tokenCountStability: Math.round(tokenStability * 1000) / 1000,
    lineCounts: lineCounts,
    blockCounts: blockCounts,
    avgLines: Math.round(mean(lineCounts) * 10) / 10,
    avgBlocks: Math.round(mean(blockCounts) * 10) / 10,
    avgTokens: Math.round(mean(tokenCounts) * 10) / 10
  };
}

/* ── 7. Surface type distribution stability ─────────────────────────────── */

function analyzeSurfaceTypeStability(documents) {
  // Collect all surface types across the batch
  const allTypes = new Set();
  for (const d of documents) {
    for (const t of Object.keys(d.surfaceTypeCounts || {})) allTypes.add(t);
  }
  const typeList = Array.from(allTypes).sort();

  // Build distribution vectors
  const distributions = documents.map(function (d) {
    const total = Object.values(d.surfaceTypeCounts || {}).reduce(function (s, v) { return s + v; }, 0) || 1;
    return typeList.map(function (t) { return (d.surfaceTypeCounts[t] || 0) / total; });
  });

  // Average pairwise cosine similarity
  let totalSim = 0;
  let pairCount = 0;
  for (let i = 0; i < distributions.length; i++) {
    for (let j = i + 1; j < distributions.length; j++) {
      totalSim += cosineSimilarity(distributions[i], distributions[j]);
      pairCount++;
    }
  }
  const avgSimilarity = pairCount > 0 ? totalSim / pairCount : 1;

  return {
    metric: 'surface_type_distribution',
    stability: Math.round(clamp(avgSimilarity, 0, 1) * 1000) / 1000,
    surfaceTypes: typeList,
    avgPairwiseSimilarity: Math.round(avgSimilarity * 1000) / 1000
  };
}

/* ── Parameter sensitivity analysis ─────────────────────────────────────── */

/**
 * Given stability metrics, identify which parameters are most likely
 * responsible for instability and recommend adjustments.
 */
function analyzeParameterSensitivity(stabilityMetrics) {
  const diagnoses = [];

  const regionCount = stabilityMetrics.regionCount;
  const regionArea = stabilityMetrics.regionArea;
  const regionDensity = stabilityMetrics.regionDensity;
  const adjacencyGraph = stabilityMetrics.adjacencyGraph;
  const spatialDist = stabilityMetrics.spatialDistribution;
  const textStructure = stabilityMetrics.textStructure;
  const surfaceType = stabilityMetrics.surfaceTypeDistribution;

  // 1. Region segmentation thresholds
  if (regionCount.stability < 0.7) {
    const avgCount = regionCount.mean;
    const range = regionCount.max - regionCount.min;
    diagnoses.push({
      parameter: 'region_segmentation_thresholds',
      impact: 'high',
      stability: regionCount.stability,
      diagnosis: 'Region count varies significantly across documents (CV=' + regionCount.cv +
        '). Range: ' + regionCount.min + '-' + regionCount.max + '.',
      recommendation: range > avgCount * 0.5
        ? 'Increase mergeThreshold to reduce over-segmentation sensitivity. Consider raising minRegionArea to filter noise.'
        : 'Fine-tune mergeThreshold. Current variation suggests threshold is near a tipping point for this document type.',
      suggestedAdjustments: {
        mergeThreshold: regionCount.cv > 0.5 ? 'increase by 20-40%' : 'increase by 10-20%',
        minRegionArea: regionCount.max > avgCount * 2 ? 'increase by 30%' : 'no change needed'
      }
    });
  }

  // 2. Color tolerance parameters
  if (regionArea.stability < 0.7 && regionCount.stability > 0.5) {
    diagnoses.push({
      parameter: 'color_tolerance',
      impact: 'medium',
      stability: regionArea.stability,
      diagnosis: 'Region areas vary while region counts are relatively stable. ' +
        'This suggests color-based segmentation boundaries are shifting across documents.',
      recommendation: 'Increase color tolerance to produce more consistent region boundaries. ' +
        'The segmentation may be sensitive to minor color/contrast variations.',
      suggestedAdjustments: {
        colorTolerance: 'increase by 15-25%',
        contrastThreshold: 'relax by 10%'
      }
    });
  }

  // 3. Edge detection thresholds
  if (adjacencyGraph.stability < 0.7) {
    diagnoses.push({
      parameter: 'edge_detection_thresholds',
      impact: adjacencyGraph.stability < 0.5 ? 'high' : 'medium',
      stability: adjacencyGraph.stability,
      diagnosis: 'Graph structure varies significantly (edge count CV, type distribution divergence, weight inconsistency).',
      recommendation: 'Stabilize edge detection by adjusting the hardBarrier threshold. ' +
        'Proximity-based edges may need a more consistent distance threshold.',
      suggestedAdjustments: {
        hardBarrier: adjacencyGraph.edgeCountStability < 0.5 ? 'increase by 20%' : 'increase by 10%',
        proximityThreshold: adjacencyGraph.edgeWeightStability < 0.5 ? 'increase to reduce weak edges' : 'no change needed'
      }
    });
  }

  // 4. Region merge/split thresholds
  if (spatialDist.stability < 0.7) {
    diagnoses.push({
      parameter: 'region_merge_split_thresholds',
      impact: 'medium',
      stability: spatialDist.stability,
      diagnosis: 'Spatial distribution of regions varies across documents. ' +
        'Regions are appearing in different locations or sizes relative to the page.',
      recommendation: 'Adjust merge/split thresholds to produce more consistent spatial layouts. ' +
        'The system may be merging or splitting regions inconsistently.',
      suggestedAdjustments: {
        mergeSensitivity: 'reduce by 15% to be less aggressive with merging',
        splitThreshold: 'increase by 10% to require stronger evidence before splitting'
      }
    });
  }

  // 5. Visual proposal thresholds
  if (surfaceType.stability < 0.7) {
    diagnoses.push({
      parameter: 'visual_proposal_thresholds',
      impact: surfaceType.stability < 0.5 ? 'high' : 'medium',
      stability: surfaceType.stability,
      diagnosis: 'Surface type classification varies across documents. ' +
        'The system is classifying similar regions differently.',
      recommendation: 'Adjust visual proposal confidence thresholds and surface type decision boundaries.',
      suggestedAdjustments: {
        proposalConfidenceMin: 'increase to filter low-confidence proposals',
        textDenseSurfaceThreshold: 'adjust based on actual text density distribution'
      }
    });
  }

  // 6. Text structure instability
  if (textStructure.stability < 0.7) {
    diagnoses.push({
      parameter: 'text_grouping_thresholds',
      impact: 'low',
      stability: textStructure.stability,
      diagnosis: 'Text line/block grouping varies across documents. This may indicate ' +
        'inconsistent line spacing detection or block merging behavior.',
      recommendation: 'Review text line grouping band tolerance and block stacking gap threshold.',
      suggestedAdjustments: {
        lineBandTolerance: textStructure.lineCountStability < 0.6 ? 'increase by 20%' : 'no change needed',
        blockGapThreshold: textStructure.blockCountStability < 0.6 ? 'increase by 15%' : 'no change needed'
      }
    });
  }

  // Sort by impact (high first)
  const impactOrder = { high: 0, medium: 1, low: 2 };
  diagnoses.sort(function (a, b) {
    return (impactOrder[a.impact] || 3) - (impactOrder[b.impact] || 3);
  });

  return diagnoses;
}

/* ── Full batch stability analysis ──────────────────────────────────────── */

/**
 * Analyze structural consistency across all documents in a batch session.
 *
 * @param {object[]} documents - Array of DocumentStructuralSummary objects
 * @returns {object} BatchStabilityReport
 */
function analyzeBatchStability(documents) {
  if (!Array.isArray(documents) || documents.length < 2) {
    return {
      status: 'insufficient_data',
      message: documents && documents.length === 1
        ? 'Need at least 2 documents for batch stability analysis. Currently have 1.'
        : 'No documents in this batch session.',
      documentCount: documents ? documents.length : 0,
      stabilityMetrics: null,
      parameterDiagnoses: null,
      overallStability: null,
      intermediateData: null
    };
  }

  // Compute all stability metrics
  const regionCount = analyzeRegionCountStability(documents);
  const regionArea = analyzeRegionAreaStability(documents);
  const regionDensity = analyzeRegionDensityStability(documents);
  const adjacencyGraph = analyzeAdjacencyGraphStability(documents);
  const spatialDistribution = analyzeSpatialDistributionStability(documents);
  const textStructure = analyzeTextStructureStability(documents);
  const surfaceTypeDistribution = analyzeSurfaceTypeStability(documents);

  const stabilityMetrics = {
    regionCount: regionCount,
    regionArea: regionArea,
    regionDensity: regionDensity,
    adjacencyGraph: adjacencyGraph,
    spatialDistribution: spatialDistribution,
    textStructure: textStructure,
    surfaceTypeDistribution: surfaceTypeDistribution
  };

  // Overall stability: weighted average of all metric stabilities
  const weights = {
    regionCount: 0.20,
    regionArea: 0.15,
    regionDensity: 0.10,
    adjacencyGraph: 0.20,
    spatialDistribution: 0.15,
    textStructure: 0.10,
    surfaceTypeDistribution: 0.10
  };
  let overallStability = 0;
  for (const key of Object.keys(weights)) {
    overallStability += (stabilityMetrics[key].stability || 0) * weights[key];
  }
  overallStability = Math.round(overallStability * 1000) / 1000;

  // Parameter sensitivity analysis
  const parameterDiagnoses = analyzeParameterSensitivity(stabilityMetrics);

  // Determine overall status
  let status = 'stable';
  if (overallStability < 0.5) status = 'unstable';
  else if (overallStability < 0.7) status = 'moderately_stable';
  else if (overallStability < 0.85) status = 'mostly_stable';

  const statusMessages = {
    unstable: 'Structural outputs are highly inconsistent across the batch. Multiple parameters need adjustment.',
    moderately_stable: 'Structural outputs show moderate inconsistency. Some parameters may need tuning.',
    mostly_stable: 'Structural outputs are mostly consistent. Minor parameter adjustments may improve stability.',
    stable: 'Structural outputs are consistent across the batch. Parameters are well-tuned for this document type.'
  };

  // Preserve intermediate data for future phases
  const intermediateData = {
    perDocumentMetrics: documents.map(function (d) {
      return {
        documentId: d.documentId,
        documentName: d.documentName,
        metrics: d.metrics,
        normalizedSpatialDistribution: d.normalizedSpatialDistribution,
        regionSignatureCount: d.regionSignatures.length
      };
    }),
    batchRegionSignatures: documents.flatMap(function (d) {
      return d.regionSignatures.map(function (rs) {
        return {
          documentId: d.documentId,
          regionId: rs.regionId,
          featureVector: rs.featureVector,
          spatialBin: rs.spatialBin
        };
      });
    }),
    batchSpatialDistributions: documents.map(function (d) {
      return {
        documentId: d.documentId,
        distribution: d.normalizedSpatialDistribution
      };
    })
  };

  return {
    status: status,
    message: statusMessages[status],
    documentCount: documents.length,
    analyzedAt: new Date().toISOString(),
    overallStability: overallStability,
    stabilityMetrics: stabilityMetrics,
    parameterDiagnoses: parameterDiagnoses,
    intermediateData: intermediateData
  };
}

/* ── Report formatter ───────────────────────────────────────────────────── */

function formatStabilityReport(report) {
  if (!report) return '[No report data]';
  if (report.status === 'insufficient_data') return report.message;

  let out = '';
  out += '══════════════════════════════════════════════════════════════\n';
  out += '  BATCH STRUCTURAL STABILITY REPORT\n';
  out += '══════════════════════════════════════════════════════════════\n\n';
  out += '  Status: ' + report.status.toUpperCase() + '\n';
  out += '  Overall Stability: ' + (report.overallStability * 100).toFixed(1) + '%\n';
  out += '  Documents analyzed: ' + report.documentCount + '\n';
  out += '  Analyzed at: ' + report.analyzedAt + '\n\n';
  out += '  ' + report.message + '\n';

  out += '\n──────────────────────────────────────────────────────────────\n';
  out += '  STABILITY METRICS\n';
  out += '──────────────────────────────────────────────────────────────\n\n';

  const metrics = report.stabilityMetrics;
  if (metrics) {
    const metricNames = {
      regionCount: 'Region Count',
      regionArea: 'Region Area',
      regionDensity: 'Region Density',
      adjacencyGraph: 'Adjacency Graph',
      spatialDistribution: 'Spatial Distribution',
      textStructure: 'Text Structure',
      surfaceTypeDistribution: 'Surface Type Distribution'
    };
    for (const key of Object.keys(metricNames)) {
      const m = metrics[key];
      if (!m) continue;
      const pct = (m.stability * 100).toFixed(1);
      const bar = _stabilityBar(m.stability);
      out += '  ' + metricNames[key].padEnd(28) + bar + '  ' + pct + '%\n';
    }
  }

  if (report.parameterDiagnoses && report.parameterDiagnoses.length) {
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  PARAMETER DIAGNOSES & RECOMMENDATIONS\n';
    out += '──────────────────────────────────────────────────────────────\n';

    for (const d of report.parameterDiagnoses) {
      out += '\n  [' + d.impact.toUpperCase() + ' IMPACT] ' + d.parameter.replace(/_/g, ' ') + '\n';
      out += '    Stability: ' + (d.stability * 100).toFixed(1) + '%\n';
      out += '    Diagnosis: ' + d.diagnosis + '\n';
      out += '    Recommendation: ' + d.recommendation + '\n';
      if (d.suggestedAdjustments) {
        out += '    Suggested adjustments:\n';
        for (const key of Object.keys(d.suggestedAdjustments)) {
          out += '      ' + key + ': ' + d.suggestedAdjustments[key] + '\n';
        }
      }
    }
  } else {
    out += '\n  No parameter issues detected. The feature graph generation\n';
    out += '  parameters are well-tuned for this document type.\n';
  }

  out += '\n══════════════════════════════════════════════════════════════\n';
  return out;
}

function _stabilityBar(stability) {
  const filled = Math.round(stability * 20);
  const empty = 20 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  analyzeBatchStability,
  formatStabilityReport,
  // Expose individual analyzers for targeted use
  analyzeRegionCountStability,
  analyzeRegionAreaStability,
  analyzeRegionDensityStability,
  analyzeAdjacencyGraphStability,
  analyzeSpatialDistributionStability,
  analyzeTextStructureStability,
  analyzeSurfaceTypeStability,
  analyzeParameterSensitivity,
  // Expose statistical helpers for testing
  cosineSimilarity,
  jensenShannonDivergence
};
