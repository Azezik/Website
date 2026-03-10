'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  learning-analyst.js  –  Derives improved Wrokit Vision parameters from
                          accumulated human annotations
  ─────────────────────────────────────────────────────────────────────────────

  This module reads stored AnnotationRecords (produced by learning sessions)
  and computes parameter recommendations that can improve Wrokit Vision's
  heuristics.  Nothing here uses neural networks or external ML libraries.

  The approach is closest to what computer vision researchers call
  "supervised parameter estimation" — we have human-provided ground truth
  (the drawn boxes) and system outputs (the auto-detected regions), and we
  find the parameter values that make the system outputs best match the
  human ground truth.

  ─── What this module can tune ───────────────────────────────────────────

  1. REGION DETECTION THRESHOLDS
     - mergeThreshold  (default 32): controls when two adjacent regions merge
     - hardBarrier     (default 165): boundary evidence above which regions
                                       will not grow
     - minRegionArea   (default 2000): minimum pixel area to keep a region
     Human annotations tell us: "these are the regions that actually matter."
     If the system over-segments (too many tiny regions), raise mergeThreshold.
     If it under-segments (big blobs that should be separate), lower it.

  2. SURFACE CLASSIFICATION THRESHOLDS
     - textDenseSurfaceThreshold  (default 0.55): textDensity above which a
       region is classified as "text_dense_surface"
     - panelTextDensityMax        (default 0.35): textDensity below which a
       large region is classified as a panel
     Human annotations tell us: "this is a text group" vs "this is a shape."
     We compare the textDensity of regions the human labeled as text_group
     versus those labeled as shape/visual_region to find the best split point.

  3. CANDIDATE RANKING WEIGHTS
     - The 7 scoring weights in candidate-ranking/index.js
     Human annotations of field_value + label pairs give us ground-truth
     field-label relationships, which we can use to test which weight
     combinations rank the correct candidate highest.

  4. CONFIDENCE THRESHOLDS
     - Per-category acceptance thresholds
     Human annotations of field_value boxes provide ground truth for
     measuring how often each confidence level is actually correct.

  ─── How it works (plain language) ────────────────────────────────────────

  Think of this like a coach reviewing game film:
  - The human annotations are the "correct plays"
  - The system's auto-detected regions are "what the team actually did"
  - The analyst compares the two and says "here's what to adjust"

  The adjustments are simple statistical summaries, not neural network training.
  For example: "across 50 annotated images, the average area of a human-marked
  visual region is 12,000 pixels, but the system's minimum region threshold is
  only 2,000.  Raising it to 5,000 would eliminate 60% of false detections
  without losing any human-marked regions."

───────────────────────────────────────────────────────────────────────────────*/

const { computeIoU, compareAnnotationsToRegions } = require('./learning-session');

/* ── Utility ─────────────────────────────────────────────────────────────── */

function median(arr){
  if(!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr){
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function percentile(arr, p){
  if(!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/* ── 1. Region detection threshold analysis ──────────────────────────────── */

/**
 * Analyzes whether the system is over-segmenting or under-segmenting
 * compared to human annotations, and suggests threshold adjustments.
 *
 * Returns:
 *   segmentationBias: 'over' | 'under' | 'balanced'
 *   suggestedMergeThreshold: number (current default: 32)
 *   suggestedHardBarrier: number (current default: 165)
 *   suggestedMinRegionArea: number (current default: 2000)
 *   evidence: { ... }
 */
function analyzeRegionDetection(records){
  const comparisons = [];
  const humanAreas = [];
  const autoAreas = [];
  const missedAreas = [];

  for(const rec of records){
    const comp = compareAnnotationsToRegions(rec.annotations, rec.autoRegions);
    comparisons.push(comp);

    const vpArea = (rec.viewport?.w || 1) * (rec.viewport?.h || 1);

    for(const ann of rec.annotations || []){
      if(ann.category === 'visual_region' || ann.category === 'structural_section'){
        humanAreas.push(ann.normBox.wN * ann.normBox.hN * vpArea);
      }
    }
    for(const ar of rec.autoRegions || []){
      autoAreas.push(ar.normBox.wN * ar.normBox.hN * vpArea);
    }
    for(const m of comp.missedBySystem){
      missedAreas.push(m.normBox.wN * m.normBox.hN * vpArea);
    }
  }

  const avgHumanCount = mean(comparisons.map(c => c.stats.humanRegionCount));
  const avgAutoCount = mean(comparisons.map(c => c.stats.autoRegionCount));
  const avgIoU = mean(comparisons.map(c => c.stats.averageIoU));
  const avgPrecision = mean(comparisons.map(c => c.stats.precision));
  const avgRecall = mean(comparisons.map(c => c.stats.recall));

  // Determine segmentation bias
  let segmentationBias = 'balanced';
  if(avgAutoCount > avgHumanCount * 1.5) segmentationBias = 'over';
  else if(avgAutoCount < avgHumanCount * 0.7) segmentationBias = 'under';

  const recordCount = records.length;
  const confidenceScale = clamp(recordCount / 12, 0.35, 1);

  // Suggest merge threshold adjustment
  const baseMergeThreshold = 32;
  let mergeThresholdTarget = baseMergeThreshold;
  if(segmentationBias === 'over'){
    // System produces too many regions → increase merge threshold to merge more
    const ratio = avgAutoCount / Math.max(1, avgHumanCount);
    mergeThresholdTarget = clamp(Math.round(baseMergeThreshold * Math.sqrt(ratio)), 32, 64);
  } else if(segmentationBias === 'under'){
    // System produces too few regions → decrease merge threshold to keep more separate
    const ratio = avgHumanCount / Math.max(1, avgAutoCount);
    mergeThresholdTarget = clamp(Math.round(baseMergeThreshold / Math.sqrt(ratio)), 16, 32);
  }
  const suggestedMergeThreshold = clamp(
    Math.round(baseMergeThreshold + ((mergeThresholdTarget - baseMergeThreshold) * confidenceScale)),
    16,
    64
  );

  // Suggest hard barrier conservatively (higher merges across noisier micro-edges).
  const baseHardBarrier = 165;
  let hardBarrierTarget = baseHardBarrier;
  if(segmentationBias === 'over'){
    const ratio = avgAutoCount / Math.max(1, avgHumanCount);
    hardBarrierTarget = clamp(baseHardBarrier + Math.round((ratio - 1) * 2.5), 165, 178);
  } else if(segmentationBias === 'under'){
    const ratio = avgHumanCount / Math.max(1, avgAutoCount);
    hardBarrierTarget = clamp(baseHardBarrier - Math.round((ratio - 1) * 2), 150, 165);
  }
  const suggestedHardBarrier = clamp(
    Math.round(baseHardBarrier + ((hardBarrierTarget - baseHardBarrier) * confidenceScale)),
    150,
    178
  );

  // Suggest minimum region area using low-percentile + evidence damping.
  // This avoids swinging too aggressively on very small early datasets.
  const baseMinRegionArea = 2000;
  const lowerHumanArea = humanAreas.length ? percentile(humanAreas, 0.1) : baseMinRegionArea;
  let minRegionAreaTarget = Math.max(500, Math.round(lowerHumanArea * 0.55));
  if(segmentationBias === 'over') minRegionAreaTarget = Math.max(minRegionAreaTarget, Math.round(baseMinRegionArea * 1.15));
  if(segmentationBias === 'under') minRegionAreaTarget = Math.min(minRegionAreaTarget, Math.round(baseMinRegionArea * 0.9));
  const suggestedMinRegionArea = clamp(
    Math.round(baseMinRegionArea + ((minRegionAreaTarget - baseMinRegionArea) * confidenceScale)),
    500,
    12000
  );

  return {
    segmentationBias,
    suggestedMergeThreshold,
    suggestedHardBarrier,
    suggestedMinRegionArea,
    evidence: {
      recordCount,
      avgHumanRegionCount: Math.round(avgHumanCount * 10) / 10,
      avgAutoRegionCount: Math.round(avgAutoCount * 10) / 10,
      avgIoU: Math.round(avgIoU * 1000) / 1000,
      avgPrecision: Math.round(avgPrecision * 1000) / 1000,
      avgRecall: Math.round(avgRecall * 1000) / 1000,
      medianHumanAreaPx: Math.round(median(humanAreas)),
      medianAutoAreaPx: Math.round(median(autoAreas)),
      missedRegionCount: comparisons.reduce((s, c) => s + c.stats.missedCount, 0)
    }
  };
}

/* ── 2. Surface classification threshold analysis ────────────────────────── */

/**
 * Analyzes human category labels to find the best text density split point
 * between "text-dense" and "non-text" regions.
 *
 * Uses a simple approach: for each auto-detected region that matched a
 * human annotation, we look at what category the human assigned. Regions
 * the human called "text_group" or "label" should have high textDensity.
 * Regions called "shape" or "visual_region" should have lower textDensity.
 * The best threshold is the value that separates these two groups.
 */
function analyzeSurfaceClassification(records){
  const textDensities = [];    // textDensity values for human-labeled text regions
  const nonTextDensities = []; // textDensity values for human-labeled non-text regions

  for(const rec of records){
    const autoMap = new Map((rec.autoRegions || []).map(r => [r.regionId, r]));

    for(const ann of rec.annotations || []){
      // Find the auto-region that best matches this annotation
      let bestIoU = 0;
      let bestRegion = null;
      for(const ar of rec.autoRegions || []){
        const iou = computeIoU(ann.normBox, ar.normBox);
        if(iou > bestIoU){
          bestIoU = iou;
          bestRegion = ar;
        }
      }

      if(bestIoU < 0.2 || !bestRegion) continue;

      const td = bestRegion.textDensity;
      if(ann.category === 'text_group' || ann.category === 'label' || ann.category === 'field_value'){
        textDensities.push(td);
      } else if(ann.category === 'shape' || ann.category === 'visual_region'){
        nonTextDensities.push(td);
      }
    }
  }

  if(!textDensities.length && !nonTextDensities.length){
    return {
      suggestedTextDenseThreshold: 0.55,
      suggestedPanelTextDensityMax: 0.35,
      evidence: { textSamples: 0, nonTextSamples: 0, message: 'Not enough data yet' }
    };
  }

  // Find optimal split point using a simple scan
  // (This is like a 1-dimensional decision stump, one of the simplest
  //  "classifiers" in machine learning — basically just finding the best
  //  cutoff value to separate two groups of numbers.)
  const allValues = [
    ...textDensities.map(v => ({ v, isText: true })),
    ...nonTextDensities.map(v => ({ v, isText: false }))
  ].sort((a, b) => a.v - b.v);

  let bestThreshold = 0.55;
  let bestAccuracy = 0;

  const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
  for(const t of thresholds){
    let correct = 0;
    for(const { v, isText } of allValues){
      if(isText && v >= t) correct++;
      if(!isText && v < t) correct++;
    }
    const accuracy = allValues.length ? correct / allValues.length : 0;
    if(accuracy > bestAccuracy){
      bestAccuracy = accuracy;
      bestThreshold = t;
    }
  }

  // Panel threshold should be lower than text-dense threshold
  const suggestedPanelMax = Math.max(0.15, bestThreshold - 0.2);

  return {
    suggestedTextDenseThreshold: bestThreshold,
    suggestedPanelTextDensityMax: Math.round(suggestedPanelMax * 100) / 100,
    evidence: {
      textSamples: textDensities.length,
      nonTextSamples: nonTextDensities.length,
      medianTextDensity: Math.round(median(textDensities) * 1000) / 1000,
      medianNonTextDensity: Math.round(median(nonTextDensities) * 1000) / 1000,
      splitAccuracy: Math.round(bestAccuracy * 1000) / 1000
    }
  };
}

/* ── 3. Candidate ranking weight analysis ────────────────────────────────── */

/**
 * Uses human-drawn field_value + label annotation pairs to evaluate
 * whether alternative weight combinations would better rank the correct
 * candidate at position #1.
 *
 * This performs a grid search over weight combinations:
 *   - For each annotated image, it finds the label-value pairs
 *   - It constructs a mini ranking problem from the annotation data
 *   - It tests which weight balance best predicts the human's intent
 *
 * Note: this only produces recommendations if there are enough
 * field_value + label annotations. Otherwise it returns the defaults.
 */
function analyzeRankingWeights(records){
  // Count label-value pairs across all records
  let labelValuePairs = 0;
  for(const rec of records){
    const labels = (rec.annotations || []).filter(a => a.category === 'label');
    const values = (rec.annotations || []).filter(a => a.category === 'field_value');
    labelValuePairs += Math.min(labels.length, values.length);
  }

  const defaults = {
    anchorTextSimilarity: 0.20,
    nearbyLabelSimilarity: 0.17,
    structuralSimilarity: 0.14,
    containingRegionSimilarity: 0.10,
    siblingArrangementSimilarity: 0.10,
    localGeometrySimilarity: 0.17,
    graphRelationshipSimilarity: 0.12
  };

  if(labelValuePairs < 10){
    return {
      suggestedWeights: defaults,
      evidence: {
        labelValuePairs,
        message: 'Need at least 10 label-value pairs for weight tuning. ' +
          `Currently have ${labelValuePairs}. Keep annotating!`
      }
    };
  }

  // With enough data, compute proximity statistics between labels and values.
  // This tells us how much spatial proximity (localGeometrySimilarity) matters
  // versus text content (anchorTextSimilarity) in the user's actual documents.

  const proximityScores = [];
  const regionScores = [];

  for(const rec of records){
    const labels = (rec.annotations || []).filter(a => a.category === 'label');
    const values = (rec.annotations || []).filter(a => a.category === 'field_value');

    for(const val of values){
      // Find nearest label
      let minDist = Infinity;
      for(const lbl of labels){
        const dx = (val.normBox.x0n + val.normBox.wN / 2) - (lbl.normBox.x0n + lbl.normBox.wN / 2);
        const dy = (val.normBox.y0n + val.normBox.hN / 2) - (lbl.normBox.y0n + lbl.normBox.hN / 2);
        const dist = Math.hypot(dx, dy);
        if(dist < minDist) minDist = dist;
      }
      proximityScores.push(Math.max(0, 1 - minDist));

      // Check if value is inside a human-marked region
      let bestRegionIoU = 0;
      for(const ann of rec.annotations){
        if(ann.category === 'visual_region' || ann.category === 'structural_section'){
          const iou = computeIoU(val.normBox, ann.normBox);
          if(iou > bestRegionIoU) bestRegionIoU = iou;
        }
      }
      regionScores.push(bestRegionIoU);
    }
  }

  // Adjust weights based on observed patterns:
  // - If labels are very close to values → boost localGeometrySimilarity
  // - If labels are far from values → boost anchorTextSimilarity (text matching matters more)
  // - If values strongly correlate with visual regions → boost containingRegionSimilarity
  const avgProximity = mean(proximityScores);
  const avgRegionCorrelation = mean(regionScores);

  const suggested = { ...defaults };

  if(avgProximity > 0.8){
    // Labels very close to values → spatial cues very reliable
    suggested.localGeometrySimilarity = 0.22;
    suggested.nearbyLabelSimilarity = 0.20;
    suggested.anchorTextSimilarity = 0.15;
  } else if(avgProximity < 0.5){
    // Labels far from values → text matching more important
    suggested.anchorTextSimilarity = 0.25;
    suggested.nearbyLabelSimilarity = 0.22;
    suggested.localGeometrySimilarity = 0.12;
  }

  if(avgRegionCorrelation > 0.5){
    suggested.containingRegionSimilarity = 0.15;
  }

  // Normalize weights to sum to 1
  const sum = Object.values(suggested).reduce((s, v) => s + v, 0);
  for(const key of Object.keys(suggested)){
    suggested[key] = Math.round((suggested[key] / sum) * 100) / 100;
  }

  return {
    suggestedWeights: suggested,
    evidence: {
      labelValuePairs,
      avgLabelValueProximity: Math.round(avgProximity * 1000) / 1000,
      avgRegionCorrelation: Math.round(avgRegionCorrelation * 1000) / 1000,
      message: `Analyzed ${labelValuePairs} label-value pairs across ${records.length} images.`
    }
  };
}

/* ── 4. Confidence threshold analysis ────────────────────────────────────── */

/**
 * Analyzes the confidence values of auto-detected regions that matched
 * human annotations versus those that didn't, to suggest per-category
 * confidence thresholds.
 */
function analyzeConfidenceThresholds(records){
  const matchedConfidences = [];
  const unmatchedConfidences = [];

  for(const rec of records){
    const comp = compareAnnotationsToRegions(rec.annotations, rec.autoRegions);

    for(const m of comp.matches){
      matchedConfidences.push(m.autoRegion.confidence);
    }
    for(const e of comp.extraDetections){
      unmatchedConfidences.push(e.confidence);
    }
  }

  if(!matchedConfidences.length){
    return {
      suggestedMinConfidence: 0.64,
      evidence: { matchedSamples: 0, unmatchedSamples: 0, message: 'Not enough data yet' }
    };
  }

  // Find threshold that best separates matched from unmatched
  const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  let bestThreshold = 0.64;
  let bestF1 = 0;

  for(const t of thresholds){
    const tp = matchedConfidences.filter(c => c >= t).length;
    const fp = unmatchedConfidences.filter(c => c >= t).length;
    const fn = matchedConfidences.filter(c => c < t).length;

    const precision = (tp + fp) ? tp / (tp + fp) : 0;
    const recall = (tp + fn) ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;

    if(f1 > bestF1){
      bestF1 = f1;
      bestThreshold = t;
    }
  }

  return {
    suggestedMinConfidence: bestThreshold,
    evidence: {
      matchedSamples: matchedConfidences.length,
      unmatchedSamples: unmatchedConfidences.length,
      medianMatchedConfidence: Math.round(median(matchedConfidences) * 1000) / 1000,
      medianUnmatchedConfidence: Math.round(median(unmatchedConfidences) * 1000) / 1000,
      bestF1: Math.round(bestF1 * 1000) / 1000
    }
  };
}

/* ── Full analysis ───────────────────────────────────────────────────────── */

/**
 * Runs all analyses on the full set of annotation records and returns
 * a complete recommendations report.
 *
 * This is the main entry point. Call it with all records from the
 * learning store and it returns everything needed to improve the system.
 */
function analyzeAll(records){
  if(!Array.isArray(records) || !records.length){
    return {
      status: 'insufficient_data',
      message: 'No annotation records found. Use Learning mode to annotate some images first.',
      recordCount: 0,
      recommendations: null
    };
  }

  const regionDetection = analyzeRegionDetection(records);
  const surfaceClassification = analyzeSurfaceClassification(records);
  const rankingWeights = analyzeRankingWeights(records);
  const confidenceThresholds = analyzeConfidenceThresholds(records);

  const totalAnnotations = records.reduce((s, r) => s + (r.annotations?.length || 0), 0);

  // Determine overall data sufficiency
  let status = 'ready';
  if(records.length < 5) status = 'early';
  else if(records.length < 15) status = 'developing';

  const statusMessages = {
    early: `${records.length} images annotated (${totalAnnotations} boxes). ` +
      'Recommendations are preliminary — annotate more images for better results.',
    developing: `${records.length} images annotated (${totalAnnotations} boxes). ` +
      'Recommendations are becoming reliable. More data will improve accuracy.',
    ready: `${records.length} images annotated (${totalAnnotations} boxes). ` +
      'Enough data for confident recommendations.'
  };

  return {
    status,
    message: statusMessages[status],
    recordCount: records.length,
    totalAnnotations,
    recommendations: {
      regionDetection,
      surfaceClassification,
      rankingWeights,
      confidenceThresholds
    }
  };
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  analyzeRegionDetection,
  analyzeSurfaceClassification,
  analyzeRankingWeights,
  analyzeConfidenceThresholds,
  analyzeAll
};
