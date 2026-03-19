'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  object-learning-engine.js  –  Object Learning ML System for WFG2
  ─────────────────────────────────────────────────────────────────────────────

  Schema-driven learning layer that teaches the system how to locate a field
  using structural similarity within WFG2 region graphs.

  Core concepts:
  - Reference Descriptor: structural fingerprint of a field's location
  - Feature Vector: comparison metrics between a candidate and reference
  - Scoring Model: modular interface for predicting match likelihood
  - Training Data: collected through user feedback (confirm/adjust/reject)

  This module operates ON TOP of WFG2 — it never modifies core segmentation.
───────────────────────────────────────────────────────────────────────────────*/

const OBJECT_LEARNING_VERSION = 1;
const STORAGE_KEY_PREFIX = 'wrokit.objectLearning';

/* ── Geometry helpers ─────────────────────────────────────────────────────── */

function bboxArea(b) { return Math.max(0, (b.w || 0) * (b.h || 0)); }
function bboxCenter(b) { return { x: (b.x || 0) + (b.w || 0) / 2, y: (b.y || 0) + (b.h || 0) / 2 }; }
function bboxAspect(b) { return (b.h || 1) > 0 ? (b.w || 1) / (b.h || 1) : 1; }

function intersectArea(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = x2 - x1, h = y2 - y1;
  return (w > 0 && h > 0) ? (w * h) : 0;
}

function iou(a, b) {
  const inter = intersectArea(a, b);
  const union = bboxArea(a) + bboxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function distance(p1, p2) {
  const dx = (p1.x || 0) - (p2.x || 0);
  const dy = (p1.y || 0) - (p2.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function containsBbox(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    (inner.x + inner.w) <= (outer.x + outer.w) &&
    (inner.y + inner.h) <= (outer.y + outer.h);
}

/* ── Reference Descriptor ─────────────────────────────────────────────────── */

/**
 * Build a reference descriptor from a user-drawn BBOX on a WFG2 graph.
 * This captures the structural context of where a field is located.
 */
function buildReferenceDescriptor(bbox, graph, surfaceSize) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const vpW = surfaceSize?.width || 1;
  const vpH = surfaceSize?.height || 1;

  // Find regions that intersect the BBOX
  const intersecting = [];
  for (const node of nodes) {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const ov = intersectArea(bbox, nb);
    if (ov > 0) {
      intersecting.push({ node, overlapArea: ov, overlapRatio: ov / Math.max(1, bboxArea(bbox)) });
    }
  }
  intersecting.sort((a, b) => b.overlapArea - a.overlapArea);

  // Primary region: maximum overlap
  const primary = intersecting[0] || null;

  // Parent region: smallest region that fully contains the BBOX
  let parent = null;
  let parentArea = Infinity;
  for (const node of nodes) {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const na = bboxArea(nb);
    if (containsBbox(nb, bbox) && na < parentArea && na > bboxArea(bbox)) {
      parent = node;
      parentArea = na;
    }
  }

  // Child regions: regions fully inside the BBOX
  const children = [];
  for (const node of nodes) {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    if (containsBbox(bbox, nb)) {
      children.push(node.id);
    }
  }

  // Local neighborhood (above / below / left / right)
  const bboxCtr = bboxCenter(bbox);
  const neighborhood = { above: [], below: [], left: [], right: [] };
  const maxDist = Math.max(vpW, vpH) * 0.3; // search within 30% of image

  for (const node of nodes) {
    const nc = node.center || bboxCenter(node.bbox || { x: 0, y: 0, w: 0, h: 0 });
    const dist = distance(bboxCtr, nc);
    if (dist > maxDist || dist < 1) continue;
    // Skip if the node IS the primary or is inside the bbox
    if (primary && node.id === primary.node.id) continue;
    if (containsBbox(bbox, node.bbox || { x: 0, y: 0, w: 0, h: 0 })) continue;

    const dx = nc.x - bboxCtr.x;
    const dy = nc.y - bboxCtr.y;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    if (absDy > absDx) {
      if (dy < 0) neighborhood.above.push({ id: node.id, dist });
      else neighborhood.below.push({ id: node.id, dist });
    } else {
      if (dx < 0) neighborhood.left.push({ id: node.id, dist });
      else neighborhood.right.push({ id: node.id, dist });
    }
  }

  // Sort each direction by distance
  for (const dir of ['above', 'below', 'left', 'right']) {
    neighborhood[dir].sort((a, b) => a.dist - b.dist);
    neighborhood[dir] = neighborhood[dir].slice(0, 5); // keep closest 5
  }

  // Compute structural metrics for the reference
  const refArea = bboxArea(bbox);
  const normArea = refArea / Math.max(1, vpW * vpH);

  return {
    primary_region_id: primary?.node?.id || null,
    primary_overlap_ratio: primary?.overlapRatio || 0,
    intersecting_region_ids: intersecting.map(h => h.node.id),
    intersecting_count: intersecting.length,
    parent_region_id: parent?.id || null,
    child_region_ids: children,
    child_count: children.length,
    neighborhood,
    neighbor_counts: {
      above: neighborhood.above.length,
      below: neighborhood.below.length,
      left: neighborhood.left.length,
      right: neighborhood.right.length,
      total: neighborhood.above.length + neighborhood.below.length +
        neighborhood.left.length + neighborhood.right.length
    },
    avg_neighbor_distance: _avgNeighborDist(neighborhood),
    bbox_aspect: bboxAspect(bbox),
    bbox_normalized_area: normArea,
    bbox_normalized: {
      x: bbox.x / vpW, y: bbox.y / vpH,
      w: bbox.w / vpW, h: bbox.h / vpH
    },
    bbox_center_normalized: { x: bboxCtr.x / vpW, y: bboxCtr.y / vpH },
    parent_area_ratio: parent ? bboxArea(parent.bbox || {}) / Math.max(1, vpW * vpH) : 0,
    parent_aspect: parent ? bboxAspect(parent.bbox || {}) : 0,
    child_density: children.length > 0 ? children.length / Math.max(1, normArea * 1000) : 0,
    primary_confidence: primary?.node?.confidence || 0,
    primary_compactness: primary?.node?.compactness || 0,
    primary_surface_uniformity: primary?.node?.surfaceUniformity || 0,
    surface_width: vpW,
    surface_height: vpH
  };
}

function _avgNeighborDist(neighborhood) {
  let sum = 0, count = 0;
  for (const dir of ['above', 'below', 'left', 'right']) {
    for (const n of neighborhood[dir]) {
      sum += n.dist;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/* ── Candidate Generation ─────────────────────────────────────────────────── */

/**
 * Generate candidate regions from a WFG2 graph.
 * Each candidate is a potential location for the field.
 */
function generateCandidates(graph, surfaceSize) {
  const nodes = graph?.nodes || [];
  const vpW = surfaceSize?.width || 1;
  const vpH = surfaceSize?.height || 1;

  return nodes.map(node => {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    return {
      candidate_id: node.id,
      bbox: { x: nb.x, y: nb.y, w: nb.w, h: nb.h },
      center: node.center || bboxCenter(nb),
      area: bboxArea(nb),
      normalized_area: bboxArea(nb) / Math.max(1, vpW * vpH),
      aspect: bboxAspect(nb),
      confidence: node.confidence || 0,
      compactness: node.compactness || 0,
      surface_uniformity: node.surfaceUniformity || 0,
      color_confidence: node.colorConfidence || 0,
      node_ref: node
    };
  });
}

/* ── Feature Vector Construction ──────────────────────────────────────────── */

/**
 * Compute a feature vector comparing a candidate to the reference descriptor.
 * All features are deterministic — no randomness.
 */
function computeFeatureVector(candidate, referenceDescriptor, graph, surfaceSize) {
  const ref = referenceDescriptor;
  const vpW = surfaceSize?.width || 1;
  const vpH = surfaceSize?.height || 1;
  const nodes = graph?.nodes || [];
  const candBbox = candidate.bbox;
  const candCenter = candidate.center;

  // Normalized candidate values
  const candNormArea = candidate.normalized_area;
  const candAspect = candidate.aspect;
  const candCenterNorm = { x: candCenter.x / vpW, y: candCenter.y / vpH };

  // ── Shape / Size ──
  const aspect_ratio_diff = Math.abs(candAspect - ref.bbox_aspect);
  const area_ratio = ref.bbox_normalized_area > 0 ? candNormArea / ref.bbox_normalized_area : 0;
  const width_ratio = ref.bbox_normalized.w > 0 ? (candBbox.w / vpW) / ref.bbox_normalized.w : 0;
  const height_ratio = ref.bbox_normalized.h > 0 ? (candBbox.h / vpH) / ref.bbox_normalized.h : 0;

  // ── Position ──
  const center_dx = candCenterNorm.x - ref.bbox_center_normalized.x;
  const center_dy = candCenterNorm.y - ref.bbox_center_normalized.y;

  // ── Parent Context ──
  let parent_area_ratio = 0;
  let parent_aspect_diff = 0;
  // Find the candidate's parent (smallest containing region)
  let candParent = null;
  let candParentArea = Infinity;
  for (const node of nodes) {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const na = bboxArea(nb);
    if (containsBbox(nb, candBbox) && na < candParentArea && na > candidate.area) {
      candParent = node;
      candParentArea = na;
    }
  }
  if (candParent) {
    const cpNormArea = candParentArea / Math.max(1, vpW * vpH);
    parent_area_ratio = ref.parent_area_ratio > 0 ? cpNormArea / ref.parent_area_ratio : 0;
    parent_aspect_diff = Math.abs(bboxAspect(candParent.bbox || {}) - ref.parent_aspect);
  }

  // ── Neighborhood ──
  const candNeighborhood = _computeNeighborhood(candBbox, candCenter, nodes, vpW, vpH, candidate.candidate_id);
  const neighbors_above_diff = Math.abs(candNeighborhood.above - ref.neighbor_counts.above);
  const neighbors_below_diff = Math.abs(candNeighborhood.below - ref.neighbor_counts.below);
  const neighbors_left_diff = Math.abs(candNeighborhood.left - ref.neighbor_counts.left);
  const neighbors_right_diff = Math.abs(candNeighborhood.right - ref.neighbor_counts.right);
  const neighbor_count_diff = Math.abs(candNeighborhood.total - ref.neighbor_counts.total);
  const avg_neighbor_distance_diff = Math.abs(candNeighborhood.avgDist - ref.avg_neighbor_distance) /
    Math.max(1, Math.max(vpW, vpH));

  // ── Child Structure ──
  const candChildren = [];
  for (const node of nodes) {
    const nb = node.bbox || { x: 0, y: 0, w: 0, h: 0 };
    if (containsBbox(candBbox, nb) && node.id !== candidate.candidate_id) {
      candChildren.push(node.id);
    }
  }
  const child_region_count_diff = Math.abs(candChildren.length - ref.child_count);
  const candChildDensity = candChildren.length > 0 ? candChildren.length / Math.max(1, candNormArea * 1000) : 0;
  const child_density_diff = Math.abs(candChildDensity - ref.child_density);

  // ── Visual / Fill ──
  const color_distance = Math.abs((candidate.color_confidence || 0) - (ref.primary_confidence || 0));
  const fill_uniformity_diff = Math.abs((candidate.surface_uniformity || 0) - (ref.primary_surface_uniformity || 0));
  const edge_density_diff = 0; // Would need raw pixel data — placeholder
  const contour_compactness_diff = Math.abs((candidate.compactness || 0) - (ref.primary_compactness || 0));

  // ── Text ──
  const text_density_diff = 0; // Would need OCR data — placeholder

  // ── Fallback (1-region system) ──
  const cluster_density_diff = 0;
  const cluster_boundary_strength_diff = 0;

  return {
    // Shape / Size
    aspect_ratio_diff,
    area_ratio,
    width_ratio,
    height_ratio,
    // Position
    center_dx,
    center_dy,
    // Parent Context
    parent_area_ratio,
    parent_aspect_diff,
    // Neighborhood
    neighbors_above_diff,
    neighbors_below_diff,
    neighbors_left_diff,
    neighbors_right_diff,
    neighbor_count_diff,
    avg_neighbor_distance_diff,
    // Child Structure
    child_region_count_diff,
    child_density_diff,
    // Visual / Fill
    color_distance,
    fill_uniformity_diff,
    edge_density_diff,
    contour_compactness_diff,
    // Text
    text_density_diff,
    // Fallback
    cluster_density_diff,
    cluster_boundary_strength_diff
  };
}

function _computeNeighborhood(bbox, center, nodes, vpW, vpH, selfId) {
  const maxDist = Math.max(vpW, vpH) * 0.3;
  const counts = { above: 0, below: 0, left: 0, right: 0, total: 0 };
  let distSum = 0, distCount = 0;

  for (const node of nodes) {
    if (node.id === selfId) continue;
    const nc = node.center || bboxCenter(node.bbox || { x: 0, y: 0, w: 0, h: 0 });
    const dist = distance(center, nc);
    if (dist > maxDist || dist < 1) continue;
    if (containsBbox(bbox, node.bbox || { x: 0, y: 0, w: 0, h: 0 })) continue;

    const dx = nc.x - center.x;
    const dy = nc.y - center.y;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    if (absDy > absDx) {
      if (dy < 0) counts.above++;
      else counts.below++;
    } else {
      if (dx < 0) counts.left++;
      else counts.right++;
    }
    counts.total++;
    distSum += dist;
    distCount++;
  }

  counts.avgDist = distCount > 0 ? distSum / distCount : 0;
  return counts;
}

/* ── Scoring Model Interface ──────────────────────────────────────────────── */

/**
 * Create a scoring model.
 * Initial implementation: weighted distance scoring.
 * Interface supports replacement with ML model.
 */
function createScoringModel() {
  // Feature weights — learned from data or defaults
  // These are NOT hardcoded final weights — they are initial values
  // that get replaced by data-driven weights via updateWeights()
  let weights = _defaultWeights();
  let trainingData = [];

  function _defaultWeights() {
    return {
      aspect_ratio_diff: -2.0,
      area_ratio: -1.5,       // penalize deviation from 1.0
      width_ratio: -1.5,
      height_ratio: -1.5,
      center_dx: -3.0,
      center_dy: -3.0,
      parent_area_ratio: -0.8,
      parent_aspect_diff: -0.5,
      neighbors_above_diff: -0.4,
      neighbors_below_diff: -0.4,
      neighbors_left_diff: -0.4,
      neighbors_right_diff: -0.4,
      neighbor_count_diff: -0.3,
      avg_neighbor_distance_diff: -0.5,
      child_region_count_diff: -0.3,
      child_density_diff: -0.2,
      color_distance: -0.8,
      fill_uniformity_diff: -0.6,
      edge_density_diff: -0.2,
      contour_compactness_diff: -0.4,
      text_density_diff: -0.3,
      cluster_density_diff: -0.1,
      cluster_boundary_strength_diff: -0.1
    };
  }

  return {
    /**
     * Predict a match score for a feature vector.
     * Returns a value in [0, 1] — higher = better match.
     */
    predict(featureVector) {
      let score = 0;
      for (const [key, weight] of Object.entries(weights)) {
        let val = featureVector[key] || 0;
        // For ratio features, penalize deviation from 1.0
        if (key === 'area_ratio' || key === 'width_ratio' || key === 'height_ratio' || key === 'parent_area_ratio') {
          val = Math.abs(val - 1.0);
        }
        score += val * weight;
      }
      // Convert to 0-1 range via sigmoid
      return 1.0 / (1.0 + Math.exp(-score));
    },

    /**
     * Add training example.
     * @param {object} featureVector
     * @param {number} label - 1 for positive, 0 for negative
     */
    addTrainingExample(featureVector, label) {
      trainingData.push({ features: featureVector, label: label });
    },

    /**
     * Update weights from training data using simple gradient-based learning.
     * This is a basic logistic regression update — can be replaced with
     * a proper ML model.
     */
    updateWeights() {
      if (trainingData.length < 2) return;

      const lr = 0.01; // learning rate
      const iterations = 50;

      for (let iter = 0; iter < iterations; iter++) {
        const gradients = {};
        for (const key of Object.keys(weights)) gradients[key] = 0;

        for (const example of trainingData) {
          const predicted = this.predict(example.features);
          const error = example.label - predicted;

          for (const [key, weight] of Object.entries(weights)) {
            let val = example.features[key] || 0;
            if (key === 'area_ratio' || key === 'width_ratio' || key === 'height_ratio' || key === 'parent_area_ratio') {
              val = Math.abs(val - 1.0);
            }
            gradients[key] += error * val;
          }
        }

        // Apply gradients
        for (const key of Object.keys(weights)) {
          weights[key] += lr * (gradients[key] / trainingData.length);
        }
      }
    },

    /** Get current weights for serialization */
    getWeights() { return { ...weights }; },

    /** Set weights from saved state */
    setWeights(w) { if (w) weights = { ..._defaultWeights(), ...w }; },

    /** Get training data for serialization */
    getTrainingData() { return trainingData.slice(); },

    /** Set training data from saved state */
    setTrainingData(data) { trainingData = Array.isArray(data) ? data.slice() : []; },

    /** Get training data count */
    trainingCount() { return trainingData.length; },

    /** Reset to defaults */
    reset() {
      weights = _defaultWeights();
      trainingData = [];
    }
  };
}

/* ── Field Configuration ──────────────────────────────────────────────────── */

/**
 * Create a field configuration object for object learning.
 * This is what gets saved as part of the schema.
 */
function createFieldConfig(fieldId, referenceBbox, referenceDescriptor) {
  return {
    version: OBJECT_LEARNING_VERSION,
    field_id: fieldId,
    reference_bbox: { ...referenceBbox },
    reference_descriptor: referenceDescriptor,
    training_data: [],
    model_weights: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    training_count: 0,
    accuracy_history: []
  };
}

/**
 * Add a training example to a field configuration.
 */
function addTrainingExample(fieldConfig, example) {
  if (!fieldConfig || !example) return fieldConfig;
  fieldConfig.training_data.push(example);
  fieldConfig.training_count = fieldConfig.training_data.length;
  fieldConfig.updated_at = new Date().toISOString();
  return fieldConfig;
}

/* ── Storage ──────────────────────────────────────────────────────────────── */

function createObjectLearningStore(storage) {
  const backend = storage || _createMemoryBackend();
  const CONFIGS_KEY = STORAGE_KEY_PREFIX + '.fieldConfigs';
  const SESSIONS_KEY = STORAGE_KEY_PREFIX + '.sessions';

  function _loadConfigs() {
    try {
      const raw = backend.getItem(CONFIGS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_e) { return {}; }
  }

  function _saveConfigs(configs) {
    backend.setItem(CONFIGS_KEY, JSON.stringify(configs));
  }

  function _loadSessions() {
    try {
      const raw = backend.getItem(SESSIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_e) { return {}; }
  }

  function _saveSessions(sessions) {
    backend.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  return {
    /** Save a field configuration */
    saveFieldConfig(fieldId, config) {
      const configs = _loadConfigs();
      configs[fieldId] = config;
      _saveConfigs(configs);
    },

    /** Get a field configuration */
    getFieldConfig(fieldId) {
      return _loadConfigs()[fieldId] || null;
    },

    /** Get all field configurations */
    getAllFieldConfigs() {
      return _loadConfigs();
    },

    /** Delete a field configuration */
    deleteFieldConfig(fieldId) {
      const configs = _loadConfigs();
      delete configs[fieldId];
      _saveConfigs(configs);
    },

    /** Save batch session state */
    saveBatchSession(sessionId, sessionData) {
      const sessions = _loadSessions();
      sessions[sessionId] = sessionData;
      _saveSessions(sessions);
    },

    /** Get batch session state */
    getBatchSession(sessionId) {
      return _loadSessions()[sessionId] || null;
    },

    /** Clear all data */
    clear() {
      _saveConfigs({});
      _saveSessions({});
    }
  };
}

function _createMemoryBackend() {
  const map = new Map();
  return {
    getItem(key) { return map.get(key) || null; },
    setItem(key, value) { map.set(key, value); }
  };
}

/* ── Score and rank candidates ────────────────────────────────────────────── */

/**
 * Score all candidates against a reference descriptor and return ranked results.
 */
function scoreAndRankCandidates(candidates, referenceDescriptor, graph, surfaceSize, model) {
  const scored = candidates.map(candidate => {
    const featureVector = computeFeatureVector(candidate, referenceDescriptor, graph, surfaceSize);
    const score = model.predict(featureVector);
    return {
      candidate_id: candidate.candidate_id,
      bbox: candidate.bbox,
      center: candidate.center,
      score,
      feature_vector: featureVector,
      node_ref: candidate.node_ref
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ── Graph Statistics Descriptor ───────────────────────────────────────────
   Captures structural statistics of a WFG2 graph for similarity comparison.
   Saved alongside the reference descriptor during configuration.
──────────────────────────────────────────────────────────────────────────── */

/**
 * Compute a structural statistics descriptor for a WFG2 graph.
 * This captures the "shape" of the graph itself — not any specific region.
 */
function computeGraphStats(graph, surfaceSize) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const vpW = surfaceSize?.width || 1;
  const vpH = surfaceSize?.height || 1;
  const totalArea = vpW * vpH;

  if (!nodes.length) {
    return {
      region_count: 0, meaningful_region_count: 0,
      avg_region_area: 0, median_region_area: 0,
      area_std_dev: 0, area_cv: 0,
      dominant_region_coverage: 0, top3_region_coverage: 0,
      avg_aspect_ratio: 0, aspect_ratio_std: 0,
      edge_count: 0, avg_edges_per_node: 0,
      neighbor_count_distribution: { mean: 0, std: 0 },
      containment_depth_max: 0, containment_edge_count: 0,
      avg_confidence: 0, avg_compactness: 0,
      area_histogram: [0, 0, 0, 0, 0],
      collapsed: true, quality_score: 0
    };
  }

  // Region areas (normalized)
  const areas = nodes.map(n => bboxArea(n.bbox || {}) / Math.max(1, totalArea));
  const sortedAreas = areas.slice().sort((a, b) => b - a);
  const sumArea = areas.reduce((s, a) => s + a, 0);
  const avgArea = sumArea / areas.length;
  const medianArea = sortedAreas[Math.floor(sortedAreas.length / 2)];

  // Standard deviation of areas
  const areaVariance = areas.reduce((s, a) => s + (a - avgArea) ** 2, 0) / areas.length;
  const areaStd = Math.sqrt(areaVariance);
  const areaCV = avgArea > 0 ? areaStd / avgArea : 0; // coefficient of variation

  // Dominant region coverage
  const dominantCoverage = sortedAreas[0] || 0;
  const top3Coverage = sortedAreas.slice(0, 3).reduce((s, a) => s + a, 0);

  // Meaningful regions (area > 0.1% of total)
  const meaningfulCount = areas.filter(a => a > 0.001).length;

  // Aspect ratios
  const aspects = nodes.map(n => bboxAspect(n.bbox || {}));
  const avgAspect = aspects.reduce((s, a) => s + a, 0) / aspects.length;
  const aspectVar = aspects.reduce((s, a) => s + (a - avgAspect) ** 2, 0) / aspects.length;
  const aspectStd = Math.sqrt(aspectVar);

  // Edge / adjacency stats
  const neighborCounts = {};
  for (const node of nodes) neighborCounts[node.id] = 0;
  let containmentEdges = 0;
  for (const edge of edges) {
    if (edge.kind === 'contains' || edge.kind === 'containment') {
      containmentEdges++;
    }
    if (neighborCounts[edge.from] !== undefined) neighborCounts[edge.from]++;
    if (neighborCounts[edge.to] !== undefined) neighborCounts[edge.to]++;
  }
  const ncValues = Object.values(neighborCounts);
  const ncMean = ncValues.length ? ncValues.reduce((s, v) => s + v, 0) / ncValues.length : 0;
  const ncVar = ncValues.length ? ncValues.reduce((s, v) => s + (v - ncMean) ** 2, 0) / ncValues.length : 0;

  // Containment depth
  let maxDepth = 0;
  for (const node of nodes) {
    const depth = node.features?.containmentDepth || 0;
    if (depth > maxDepth) maxDepth = depth;
  }

  // Confidence and compactness
  const confidences = nodes.map(n => n.confidence || 0);
  const avgConf = confidences.reduce((s, c) => s + c, 0) / confidences.length;
  const compactnesses = nodes.map(n => n.compactness || 0);
  const avgCompact = compactnesses.reduce((s, c) => s + c, 0) / compactnesses.length;

  // Area histogram (5 bins: tiny / small / medium / large / dominant)
  const histogram = [0, 0, 0, 0, 0];
  for (const a of areas) {
    if (a < 0.005) histogram[0]++;
    else if (a < 0.02) histogram[1]++;
    else if (a < 0.08) histogram[2]++;
    else if (a < 0.25) histogram[3]++;
    else histogram[4]++;
  }

  // Quality score: penalize collapsed (1 region) or over-fragmented graphs
  const collapsed = nodes.length <= 1;
  let quality = 1.0;
  if (collapsed) quality = 0.1;
  else if (meaningfulCount < 3) quality *= 0.5;
  if (dominantCoverage > 0.9) quality *= 0.4; // one region dominates
  if (nodes.length > 200) quality *= 0.6; // over-fragmented

  return {
    region_count: nodes.length,
    meaningful_region_count: meaningfulCount,
    avg_region_area: avgArea,
    median_region_area: medianArea,
    area_std_dev: areaStd,
    area_cv: areaCV,
    dominant_region_coverage: dominantCoverage,
    top3_region_coverage: top3Coverage,
    avg_aspect_ratio: avgAspect,
    aspect_ratio_std: aspectStd,
    edge_count: edges.length,
    avg_edges_per_node: nodes.length ? edges.length / nodes.length : 0,
    neighbor_count_distribution: { mean: ncMean, std: Math.sqrt(ncVar) },
    containment_depth_max: maxDepth,
    containment_edge_count: containmentEdges,
    avg_confidence: avgConf,
    avg_compactness: avgCompact,
    area_histogram: histogram,
    collapsed,
    quality_score: quality
  };
}

/* ── Graph Structural Similarity ──────────────────────────────────────────
   Compares two graph stats descriptors to produce a combined similarity
   score. Higher = more similar.
──────────────────────────────────────────────────────────────────────────── */

function computeGraphSimilarity(refStats, candidateStats) {
  if (!refStats || !candidateStats) return 0;

  // Helper: ratio similarity — 1.0 when equal, decays toward 0
  function ratioSim(a, b) {
    if (a === 0 && b === 0) return 1;
    const ratio = Math.min(a, b) / Math.max(a, b, 1e-9);
    return ratio;
  }

  // Helper: difference similarity — 1.0 when equal, decays
  function diffSim(a, b, scale) {
    return Math.exp(-Math.abs(a - b) / Math.max(scale, 1e-9));
  }

  // Helper: histogram similarity (cosine-like)
  function histogramSim(h1, h2) {
    let dot = 0, mag1 = 0, mag2 = 0;
    for (let i = 0; i < h1.length; i++) {
      dot += h1[i] * h2[i];
      mag1 += h1[i] * h1[i];
      mag2 += h2[i] * h2[i];
    }
    const denom = Math.sqrt(mag1) * Math.sqrt(mag2);
    return denom > 0 ? dot / denom : 0;
  }

  const r = refStats, c = candidateStats;

  // ── Component scores ──

  // 1. Region count similarity (weight: 0.18)
  const regionCountSim = ratioSim(
    Math.max(r.meaningful_region_count, 1),
    Math.max(c.meaningful_region_count, 1)
  );

  // 2. Average region size similarity (weight: 0.12)
  const avgAreaSim = r.avg_region_area > 0 && c.avg_region_area > 0
    ? ratioSim(r.avg_region_area, c.avg_region_area)
    : (r.avg_region_area === 0 && c.avg_region_area === 0 ? 1 : 0);

  // 3. Median region size similarity (weight: 0.08)
  const medianAreaSim = r.median_region_area > 0 && c.median_region_area > 0
    ? ratioSim(r.median_region_area, c.median_region_area)
    : (r.median_region_area === 0 && c.median_region_area === 0 ? 1 : 0);

  // 4. Dominant region coverage similarity (weight: 0.10)
  const dominantSim = diffSim(r.dominant_region_coverage, c.dominant_region_coverage, 0.3);

  // 5. Region size distribution similarity via histogram (weight: 0.12)
  const histSim = histogramSim(r.area_histogram, c.area_histogram);

  // 6. Area coefficient of variation similarity (weight: 0.06)
  const cvSim = diffSim(r.area_cv, c.area_cv, 2.0);

  // 7. Adjacency pattern similarity (weight: 0.10)
  const adjSim = ratioSim(
    Math.max(r.avg_edges_per_node, 0.1),
    Math.max(c.avg_edges_per_node, 0.1)
  );

  // 8. Neighbor count distribution similarity (weight: 0.06)
  const ncMeanSim = diffSim(r.neighbor_count_distribution.mean, c.neighbor_count_distribution.mean, 5);
  const ncStdSim = diffSim(r.neighbor_count_distribution.std, c.neighbor_count_distribution.std, 3);
  const neighborDistSim = (ncMeanSim + ncStdSim) / 2;

  // 9. Containment / hierarchy similarity (weight: 0.06)
  const depthSim = diffSim(r.containment_depth_max, c.containment_depth_max, 3);
  const containEdgeSim = r.region_count > 0 && c.region_count > 0
    ? ratioSim(
        r.containment_edge_count / r.region_count,
        c.containment_edge_count / Math.max(c.region_count, 1)
      )
    : 1;
  const hierarchySim = (depthSim + containEdgeSim) / 2;

  // 10. Quality gate — penalize collapsed or degenerate graphs (weight: 0.12)
  const qualitySim = Math.min(r.quality_score, c.quality_score);

  // ── Weighted combination ──
  const components = {
    region_count: { score: regionCountSim, weight: 0.18 },
    avg_region_area: { score: avgAreaSim, weight: 0.12 },
    median_region_area: { score: medianAreaSim, weight: 0.08 },
    dominant_coverage: { score: dominantSim, weight: 0.10 },
    area_distribution: { score: histSim, weight: 0.12 },
    area_cv: { score: cvSim, weight: 0.06 },
    adjacency: { score: adjSim, weight: 0.10 },
    neighbor_distribution: { score: neighborDistSim, weight: 0.06 },
    hierarchy: { score: hierarchySim, weight: 0.06 },
    quality: { score: qualitySim, weight: 0.12 }
  };

  let totalScore = 0, totalWeight = 0;
  for (const comp of Object.values(components)) {
    totalScore += comp.score * comp.weight;
    totalWeight += comp.weight;
  }

  return {
    similarity: totalWeight > 0 ? totalScore / totalWeight : 0,
    components
  };
}

/* ── Parameter Variant Generation ─────────────────────────────────────────
   Generates a controlled set of WFG2 parameter variants around a base
   parameter set. Uses targeted perturbations on parameters most likely
   to affect graph structure.
──────────────────────────────────────────────────────────────────────────── */

/**
 * Generate parameter variants for graph normalization.
 * @param {object} baseParams - The effective WFG2 params (from Graph Learning baseline)
 * @param {object} copyParamsFn - The WFG2 copyParams function
 * @param {number} variantCount - How many variants to generate (default 7)
 * @returns {Array<{label: string, params: object}>}
 */
function generateParameterVariants(baseParams, copyParamsFn, variantCount) {
  const count = variantCount || 7;
  const variants = [];
  const copy = copyParamsFn || function(p) { return Object.assign({}, p); };

  // Always include the base params as variant 0
  variants.push({ label: 'baseline', params: copy(baseParams) });

  // Key parameters that most affect graph structure
  const perturbations = [
    // partitionColorTolerance: controls region granularity
    { key: 'partitionColorTolerance', offsets: [-5, -3, 3, 5, 8] },
    // partitionMinRegionPixels: minimum region size
    { key: 'partitionMinRegionPixels', offsets: [-32, -16, 16, 32] },
    // partitionBoundaryContinuation: boundary repair aggressiveness
    { key: 'partitionBoundaryContinuation', offsets: [-0.15, -0.08, 0.08, 0.15] },
    // colorDistFloor: minimum color distance for edges
    { key: 'colorDistFloor', offsets: [-6, -3, 3, 6] },
    // colorDistCeiling: max color distance
    { key: 'colorDistCeiling', offsets: [-10, -5, 5, 10] },
    // mergeThreshold: region merge aggressiveness
    { key: 'mergeThreshold', offsets: [-5, -3, 3, 5] },
    // closureWeight: closure reinforcement
    { key: 'closureWeight', offsets: [-0.08, 0.08, 0.15] },
    // surfaceUniformityBias: intra-region uniformity relaxation
    { key: 'surfaceUniformityBias', offsets: [-0.15, -0.08, 0.08, 0.15] }
  ];

  // Generate single-parameter perturbations (most targeted)
  for (const perturb of perturbations) {
    for (const offset of perturb.offsets) {
      if (variants.length >= count) break;
      const p = copy(baseParams);
      const baseVal = p[perturb.key];
      if (baseVal === undefined) continue;
      p[perturb.key] = baseVal + offset;
      // Clamp to reasonable ranges
      if (perturb.key === 'partitionColorTolerance') p[perturb.key] = Math.max(3, Math.min(40, p[perturb.key]));
      if (perturb.key === 'partitionMinRegionPixels') p[perturb.key] = Math.max(16, Math.min(256, p[perturb.key]));
      if (perturb.key === 'partitionBoundaryContinuation') p[perturb.key] = Math.max(0, Math.min(1, p[perturb.key]));
      if (perturb.key === 'colorDistFloor') p[perturb.key] = Math.max(5, Math.min(40, p[perturb.key]));
      if (perturb.key === 'colorDistCeiling') p[perturb.key] = Math.max(20, Math.min(80, p[perturb.key]));
      if (perturb.key === 'mergeThreshold') p[perturb.key] = Math.max(5, Math.min(40, p[perturb.key]));
      if (perturb.key === 'closureWeight') p[perturb.key] = Math.max(0, Math.min(0.5, p[perturb.key]));
      if (perturb.key === 'surfaceUniformityBias') p[perturb.key] = Math.max(0.2, Math.min(1.0, p[perturb.key]));
      variants.push({
        label: perturb.key + (offset > 0 ? '+' : '') + offset,
        params: p
      });
    }
    if (variants.length >= count) break;
  }

  // If still under count, add compound variants (2 parameters shifted together)
  if (variants.length < count) {
    const compoundSets = [
      { changes: { partitionColorTolerance: -3, mergeThreshold: -3 }, label: 'tighter+less_merge' },
      { changes: { partitionColorTolerance: 3, mergeThreshold: 3 }, label: 'looser+more_merge' },
      { changes: { partitionColorTolerance: -4, partitionMinRegionPixels: -16 }, label: 'finer_grained' },
      { changes: { partitionColorTolerance: 4, partitionMinRegionPixels: 16 }, label: 'coarser' },
      { changes: { closureWeight: 0.10, partitionBoundaryContinuation: 0.10 }, label: 'stronger_closure' },
      { changes: { colorDistFloor: -4, colorDistCeiling: -8 }, label: 'more_color_sensitive' },
      { changes: { colorDistFloor: 4, colorDistCeiling: 8 }, label: 'less_color_sensitive' }
    ];
    for (const compound of compoundSets) {
      if (variants.length >= count) break;
      const p = copy(baseParams);
      for (const [k, v] of Object.entries(compound.changes)) {
        if (p[k] !== undefined) p[k] += v;
      }
      variants.push({ label: compound.label, params: p });
    }
  }

  return variants.slice(0, count);
}

/* ── Graph Normalization (Pre-Match Stage) ────────────────────────────────
   Runs WFG2 with multiple parameter variants and selects the graph
   most structurally similar to the reference.
──────────────────────────────────────────────────────────────────────────── */

/**
 * Select the best graph for a document by running multiple WFG2 variants.
 *
 * @param {object} normalizedSurface - The document's normalized surface
 * @param {object} referenceGraphStats - Graph stats from the reference document
 * @param {object} baseParams - Base WFG2 params (from Graph Learning)
 * @param {function} generateFeatureGraphFn - WFG2.generateFeatureGraph
 * @param {function} copyParamsFn - WFG2.copyParams
 * @param {object} options - { variantCount, pipelineMode }
 * @returns {{ bestGraph, bestParams, bestSimilarity, bestLabel, variants }}
 */
function selectBestGraph(normalizedSurface, referenceGraphStats, baseParams,
                         generateFeatureGraphFn, copyParamsFn, options) {
  const opts = options || {};
  const variantCount = opts.variantCount || 9;
  const pipelineMode = opts.pipelineMode || 'partition';
  const surfaceSize = { width: normalizedSurface.width, height: normalizedSurface.height };

  const variants = generateParameterVariants(baseParams, copyParamsFn, variantCount);

  let bestGraph = null;
  let bestSimilarity = -1;
  let bestLabel = 'baseline';
  let bestParams = baseParams;
  const results = [];

  for (const variant of variants) {
    const p = variant.params;
    p.pipelineMode = pipelineMode;
    let graph;
    try {
      graph = generateFeatureGraphFn(normalizedSurface, p);
    } catch (e) {
      results.push({ label: variant.label, similarity: 0, error: true, stats: null });
      continue;
    }
    if (!graph || !graph.nodes) {
      results.push({ label: variant.label, similarity: 0, error: false, stats: null });
      continue;
    }

    const stats = computeGraphStats(graph, surfaceSize);
    const simResult = computeGraphSimilarity(referenceGraphStats, stats);
    const sim = simResult.similarity;

    results.push({
      label: variant.label,
      similarity: sim,
      components: simResult.components,
      stats,
      region_count: graph.nodes.length
    });

    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestGraph = graph;
      bestLabel = variant.label;
      bestParams = variant.params;
    }
  }

  // Sort results by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return {
    bestGraph,
    bestParams,
    bestSimilarity,
    bestLabel,
    variants: results,
    variantCount: variants.length
  };
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

const _exports = {
  OBJECT_LEARNING_VERSION,
  // Geometry
  bboxArea, bboxCenter, bboxAspect, intersectArea, iou, distance, containsBbox,
  // Reference
  buildReferenceDescriptor,
  // Candidates
  generateCandidates,
  // Features
  computeFeatureVector,
  // Model
  createScoringModel,
  // Config
  createFieldConfig, addTrainingExample,
  // Storage
  createObjectLearningStore,
  // Scoring
  scoreAndRankCandidates,
  // Graph normalization
  computeGraphStats, computeGraphSimilarity, generateParameterVariants, selectBestGraph
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
}
if (typeof window !== 'undefined') {
  window.ObjectLearningEngine = _exports;
}
