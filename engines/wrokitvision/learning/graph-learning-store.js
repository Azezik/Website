'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  graph-learning-store.js  –  Training Data Store for Graph Learning
  ─────────────────────────────────────────────────────────────────────────────

  Stores accepted graph examples as training data for automatic WFG2 tuning.
  Each accepted example records:
    A. Input document features
    B. Generation metadata (variant ID, regeneration count, etc.)
    C. Accepted WFG2 parameters
    D. Accepted graph outcome stats

  Also manages "learned families" — clusters of successful parameter sets
  grouped by similar document characteristics.
───────────────────────────────────────────────────────────────────────────────*/

const GRAPH_TRAINING_STORE_KEY = 'wfg2.graphTraining.v1';
const GRAPH_FAMILIES_KEY = 'wfg2.graphFamilies.v1';
const MAX_TRAINING_EXAMPLES = 500;
const MAX_FAMILIES = 50;

/* ── Document Feature Extraction ──────────────────────────────────────────── */

/**
 * Extract document features from a normalized surface for training.
 * @param {object} surface - normalizedSurface { gray, r, g, b, width, height, lab }
 * @returns {object} document features
 */
function extractDocumentFeatures(surface) {
  if (!surface || !surface.width || !surface.height) {
    return { width: 0, height: 0, aspectRatio: 1, valid: false };
  }
  const w = surface.width, h = surface.height;
  const n = w * h;
  const gray = surface.gray;
  const r = surface.r, g = surface.g, b = surface.b;

  // Basic geometry
  const aspectRatio = w / h;

  // Dark-light balance
  let darkCount = 0, lightCount = 0, graySum = 0;
  if (gray) {
    for (let i = 0; i < n; i++) {
      graySum += gray[i];
      if (gray[i] < 85) darkCount++;
      else if (gray[i] > 170) lightCount++;
    }
  }
  const meanLuminance = n > 0 ? graySum / n : 128;
  const darkRatio = n > 0 ? darkCount / n : 0;
  const lightRatio = n > 0 ? lightCount / n : 0;
  const darkLightBalance = lightRatio - darkRatio; // -1 = all dark, +1 = all light

  // Colorfulness (mean saturation approximation)
  let colorfulness = 0;
  if (r && g && b) {
    let satSum = 0;
    for (let i = 0; i < n; i++) {
      const maxC = Math.max(r[i], g[i], b[i]);
      const minC = Math.min(r[i], g[i], b[i]);
      satSum += maxC > 0 ? (maxC - minC) / maxC : 0;
    }
    colorfulness = n > 0 ? satSum / n : 0;
  }

  // Edge density (Sobel approximation on grayscale)
  let edgeDensity = 0;
  if (gray && w > 2 && h > 2) {
    let edgeCount = 0;
    const threshold = 30;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
        const gy = Math.abs(gray[idx + w] - gray[idx - w]);
        if (gx + gy > threshold) edgeCount++;
      }
    }
    edgeDensity = edgeCount / ((w - 2) * (h - 2));
  }

  // Background dominance (percentage of most common luminance band)
  let bgDominance = 0;
  if (gray) {
    const bands = new Uint32Array(8);
    for (let i = 0; i < n; i++) {
      bands[Math.min(7, gray[i] >> 5)]++;
    }
    let maxBand = 0;
    for (let i = 0; i < 8; i++) {
      if (bands[i] > maxBand) maxBand = bands[i];
    }
    bgDominance = n > 0 ? maxBand / n : 0;
  }

  // Text density estimate (high-contrast small-area transitions)
  let textDensity = 0;
  if (gray && w > 4 && h > 4) {
    let transitions = 0;
    const step = 2;
    for (let y = 0; y < h; y += step) {
      for (let x = 1; x < w; x++) {
        const diff = Math.abs(gray[y * w + x] - gray[y * w + x - 1]);
        if (diff > 60) transitions++;
      }
    }
    textDensity = transitions / (w * (h / step));
  }

  // Color variance (how much color varies across the image)
  let colorVariance = 0;
  if (r && g && b) {
    let rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < n; i++) { rSum += r[i]; gSum += g[i]; bSum += b[i]; }
    const rMean = rSum / n, gMean = gSum / n, bMean = bSum / n;
    let rVar = 0, gVar = 0, bVar = 0;
    const sampleStep = Math.max(1, Math.floor(n / 10000)); // subsample for speed
    let sampleCount = 0;
    for (let i = 0; i < n; i += sampleStep) {
      rVar += (r[i] - rMean) ** 2;
      gVar += (g[i] - gMean) ** 2;
      bVar += (b[i] - bMean) ** 2;
      sampleCount++;
    }
    colorVariance = sampleCount > 0 ? Math.sqrt((rVar + gVar + bVar) / (3 * sampleCount)) / 255 : 0;
  }

  return {
    width: w,
    height: h,
    aspectRatio: Math.round(aspectRatio * 100) / 100,
    meanLuminance: Math.round(meanLuminance),
    darkLightBalance: Math.round(darkLightBalance * 1000) / 1000,
    colorfulness: Math.round(colorfulness * 1000) / 1000,
    colorVariance: Math.round(colorVariance * 1000) / 1000,
    edgeDensity: Math.round(edgeDensity * 1000) / 1000,
    bgDominance: Math.round(bgDominance * 1000) / 1000,
    textDensity: Math.round(textDensity * 1000) / 1000,
    valid: true
  };
}

/* ── Feature Similarity ───────────────────────────────────────────────────── */

/**
 * Compute similarity between two document feature sets (0-1).
 */
function documentFeatureSimilarity(a, b) {
  if (!a?.valid || !b?.valid) return 0;

  function diffSim(va, vb, scale) {
    return Math.exp(-Math.abs(va - vb) / Math.max(scale, 1e-9));
  }

  const sims = [
    diffSim(a.aspectRatio, b.aspectRatio, 1.0) * 0.10,
    diffSim(a.meanLuminance, b.meanLuminance, 60) * 0.10,
    diffSim(a.darkLightBalance, b.darkLightBalance, 0.5) * 0.08,
    diffSim(a.colorfulness, b.colorfulness, 0.3) * 0.15,
    diffSim(a.colorVariance, b.colorVariance, 0.2) * 0.10,
    diffSim(a.edgeDensity, b.edgeDensity, 0.15) * 0.15,
    diffSim(a.bgDominance, b.bgDominance, 0.3) * 0.12,
    diffSim(a.textDensity, b.textDensity, 0.1) * 0.20
  ];

  return sims.reduce((s, v) => s + v, 0);
}

/* ── Training Store ───────────────────────────────────────────────────────── */

function createGraphTrainingStore(storage) {
  const store = storage || localStorage;

  function _load() {
    try {
      const raw = store.getItem(GRAPH_TRAINING_STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function _save(data) {
    try {
      // Trim to max
      const trimmed = data.slice(-MAX_TRAINING_EXAMPLES);
      store.setItem(GRAPH_TRAINING_STORE_KEY, JSON.stringify(trimmed));
    } catch (e) { console.error('[GraphTraining] Failed to save', e); }
  }

  return {
    /** Add an accepted training example */
    addExample(example) {
      const data = _load();
      data.push({
        ...example,
        id: 'glt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        savedAt: new Date().toISOString()
      });
      _save(data);
      return data.length;
    },

    /** Get all training examples */
    getAll() { return _load(); },

    /** Get count */
    count() { return _load().length; },

    /** Find examples with similar document features */
    findSimilar(docFeatures, topK) {
      const all = _load();
      if (!all.length) return [];
      const scored = all.map(ex => ({
        example: ex,
        similarity: documentFeatureSimilarity(docFeatures, ex.documentFeatures)
      }));
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, topK || 5);
    },

    /** Clear all training data */
    clear() { _save([]); }
  };
}

/* ── Family Store ─────────────────────────────────────────────────────────── */

function createGraphFamilyStore(storage) {
  const store = storage || localStorage;

  function _load() {
    try {
      const raw = store.getItem(GRAPH_FAMILIES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function _save(data) {
    try {
      store.setItem(GRAPH_FAMILIES_KEY, JSON.stringify(data.slice(-MAX_FAMILIES)));
    } catch (e) { console.error('[GraphFamilies] Failed to save', e); }
  }

  return {
    /** Get all families */
    getAll() { return _load(); },

    /**
     * Update families from a new accepted example.
     * Finds or creates a family that matches the document features.
     */
    updateFromExample(example) {
      const families = _load();
      const docF = example.documentFeatures;
      if (!docF?.valid) return families;

      // Find best matching family
      let bestIdx = -1, bestSim = 0;
      for (let i = 0; i < families.length; i++) {
        const sim = documentFeatureSimilarity(docF, families[i].centroidFeatures);
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
      }

      if (bestSim >= 0.70 && bestIdx >= 0) {
        // Merge into existing family
        const fam = families[bestIdx];
        fam.exampleCount = (fam.exampleCount || 0) + 1;
        fam.lastUpdated = new Date().toISOString();
        // Running average of params (exponential moving average)
        const alpha = 1 / Math.min(fam.exampleCount, 10);
        if (fam.avgParams && example.acceptedParams) {
          for (const key of Object.keys(example.acceptedParams)) {
            if (typeof example.acceptedParams[key] === 'number' && typeof fam.avgParams[key] === 'number') {
              fam.avgParams[key] = fam.avgParams[key] * (1 - alpha) + example.acceptedParams[key] * alpha;
            }
          }
        }
        // Update centroid features (moving average)
        if (fam.centroidFeatures) {
          for (const key of Object.keys(docF)) {
            if (typeof docF[key] === 'number' && typeof fam.centroidFeatures[key] === 'number') {
              fam.centroidFeatures[key] = fam.centroidFeatures[key] * (1 - alpha) + docF[key] * alpha;
            }
          }
        }
        // Keep recent accepted params list (last 5)
        if (!fam.recentParams) fam.recentParams = [];
        fam.recentParams.push(example.acceptedParams);
        if (fam.recentParams.length > 5) fam.recentParams.shift();
      } else {
        // Create new family
        families.push({
          familyId: 'gfam-' + Date.now().toString(36),
          centroidFeatures: { ...docF },
          avgParams: { ...(example.acceptedParams || {}) },
          recentParams: [example.acceptedParams],
          exampleCount: 1,
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        });
      }

      _save(families);
      return families;
    },

    /**
     * Find the best matching family for a document.
     * Returns { family, similarity } or null.
     */
    findBestFamily(docFeatures) {
      if (!docFeatures?.valid) return null;
      const families = _load();
      let best = null, bestSim = 0;
      for (const fam of families) {
        const sim = documentFeatureSimilarity(docFeatures, fam.centroidFeatures);
        if (sim > bestSim) { bestSim = sim; best = fam; }
      }
      if (best && bestSim >= 0.50) return { family: best, similarity: bestSim };
      return null;
    },

    /** Clear all families */
    clear() { _save([]); }
  };
}

/* ── Smart Regeneration Strategy ──────────────────────────────────────────── */

/*
  AUDIT RESULTS — Parameters that actually affect partition-mode output:
  ═══════════════════════════════════════════════════════════════════════
  HIGH IMPACT (used directly in computePartition flood fill):
    partitionColorTolerance — controls region formation via color distance
    chromaWeight            — controls color vs luminance dominance in flood fill

  MEDIUM IMPACT (used in partition or color boundary):
    partitionMinRegionPixels       — minimum pixel count to keep a region
    partitionBoundaryContinuation  — boundary repair aggressiveness
    colorDistFloor                 — dead-zone for small color differences
    colorDistCeiling               — ceiling for color boundary signal
    colorDistGamma                 — non-linear color distance curve

  NO EFFECT IN PARTITION MODE (structural-only or dead code):
    mergeThreshold          — structural pipeline only (not called)
    surfaceUniformityBias   — structural pipeline only
    gridSize                — structural pipeline only
    edgeSensitivity         — structural pipeline only
    minRegionArea           — structural pipeline only
    colorMergePenalty       — structural pipeline only
    parentContourBonus      — structural pipeline only
    rectangularBiasPenalty  — structural pipeline only
    fragmentationTolerance  — DEAD CODE (never used anywhere)
    partitionLocalRefinementRange — DEAD CODE (never used anywhere)
    partitionScore*W        — DEAD CODE (never used anywhere)

  LOW EFFECT (affects intermediate maps not used by partition):
    closureWeight   — only affects combinedEvidence map (unused by partition)
    colorWeight     — only affects combinedEvidence map (unused by partition)
    luminanceWeight — only affects combinedEvidence map (unused by partition)
    varianceWeight  — only affects combinedEvidence map (unused by partition)
    closureRadius   — only affects closureMap (unused by partition)
*/

/** Parameters that actually affect partition-mode output, with valid ranges */
const EFFECTIVE_PARAMS = [
  { key: 'partitionColorTolerance', min: 3, max: 50, impact: 'high' },
  { key: 'chromaWeight',            min: 0.3, max: 1.0, impact: 'high' },
  { key: 'partitionMinRegionPixels', min: 16, max: 300, impact: 'medium' },
  { key: 'partitionBoundaryContinuation', min: 0, max: 1, impact: 'medium' },
  { key: 'colorDistFloor',          min: 0, max: 35, impact: 'medium' },
  { key: 'colorDistCeiling',        min: 20, max: 80, impact: 'medium' },
  { key: 'colorDistGamma',          min: 0.5, max: 3.5, impact: 'medium' }
];

function _clampEffective(p) {
  for (const def of EFFECTIVE_PARAMS) {
    if (typeof p[def.key] === 'number') {
      p[def.key] = Math.max(def.min, Math.min(def.max, p[def.key]));
    }
  }
  return p;
}

/* ── Graph Change Detection ───────────────────────────────────────────────── */

/**
 * Compute a lightweight structural fingerprint from graph stats.
 * Used to detect whether a regeneration actually changed the graph.
 */
function computeGraphFingerprint(graphStats) {
  if (!graphStats) return null;
  return {
    regionCount: graphStats.region_count || graphStats.regionCount || 0,
    meaningfulRegionCount: graphStats.meaningful_region_count || graphStats.meaningfulRegionCount || 0,
    dominantCoverage: graphStats.dominant_region_coverage || graphStats.dominantRegionCoverage || 0,
    avgArea: graphStats.avg_region_area || graphStats.avgRegionArea || 0,
    medianArea: graphStats.median_region_area || graphStats.medianRegionArea || 0,
    edgeCount: graphStats.edge_count || graphStats.edgeCount || 0,
    avgEdgesPerNode: graphStats.avg_edges_per_node || graphStats.avgEdgesPerNode || 0,
    qualityScore: graphStats.quality_score || graphStats.qualityScore || 0
  };
}

/**
 * Measure how much a graph changed between two fingerprints.
 * Returns { changed: boolean, delta: object, magnitude: number }
 */
function measureGraphChange(prevFP, newFP) {
  if (!prevFP || !newFP) return { changed: true, delta: {}, magnitude: 1.0 };

  const delta = {
    regionCount: newFP.regionCount - prevFP.regionCount,
    meaningfulRegionCount: newFP.meaningfulRegionCount - prevFP.meaningfulRegionCount,
    dominantCoverage: Math.round((newFP.dominantCoverage - prevFP.dominantCoverage) * 1000) / 1000,
    avgArea: Math.round((newFP.avgArea - prevFP.avgArea) * 10000) / 10000,
    edgeCount: newFP.edgeCount - prevFP.edgeCount,
    qualityScore: Math.round((newFP.qualityScore - prevFP.qualityScore) * 1000) / 1000
  };

  // Magnitude: how much did the graph actually change? (0 = identical, 1+ = major change)
  const regionPct = prevFP.regionCount > 0
    ? Math.abs(delta.regionCount) / prevFP.regionCount
    : (delta.regionCount !== 0 ? 1 : 0);
  const coverageDelta = Math.abs(delta.dominantCoverage);
  const edgePct = prevFP.edgeCount > 0
    ? Math.abs(delta.edgeCount) / prevFP.edgeCount
    : (delta.edgeCount !== 0 ? 1 : 0);

  const magnitude = regionPct * 0.5 + coverageDelta * 0.3 + edgePct * 0.2;

  // Threshold: anything below 2% is effectively unchanged
  const changed = magnitude > 0.02;

  return { changed, delta, magnitude: Math.round(magnitude * 1000) / 1000 };
}

/**
 * Describe the parameter changes applied in human-readable form.
 */
function describeParamChanges(prevParams, newParams) {
  if (!prevParams || !newParams) return [];
  const changes = [];
  for (const def of EFFECTIVE_PARAMS) {
    const prev = prevParams[def.key];
    const next = newParams[def.key];
    if (prev === undefined || next === undefined) continue;
    const diff = next - prev;
    if (Math.abs(diff) < 0.001) continue;
    const sign = diff > 0 ? '+' : '';
    const val = typeof next === 'number' && next % 1 !== 0
      ? sign + diff.toFixed(2)
      : sign + Math.round(diff);
    changes.push(def.key.replace('partition', 'p.') + ': ' + val);
  }
  return changes;
}

/* ── Feedback types ───────────────────────────────────────────────────────── */

const FEEDBACK_TYPES = Object.freeze({
  REGENERATE: 'regenerate',
  TOO_FEW: 'too_few_regions',
  TOO_MANY: 'too_many_regions',
  GOOD: 'good'
});

/* ── Feedback-directed strategy pools ─────────────────────────────────────── */

/**
 * Compound strategies specifically for "too few regions" feedback.
 * All changes bias toward MORE separation, MORE sensitivity, LESS merging.
 */
const TOO_FEW_COMPOUNDS = [
  { label: 'split-strong', changes: { partitionColorTolerance: -6, partitionMinRegionPixels: -20 } },
  { label: 'split-moderate', changes: { partitionColorTolerance: -4, chromaWeight: 0.08 } },
  { label: 'split-sensitive', changes: { colorDistFloor: -6, colorDistCeiling: -10 } },
  { label: 'split-fine', changes: { partitionMinRegionPixels: -30, partitionColorTolerance: -3 } },
  { label: 'split-color-boost', changes: { chromaWeight: 0.12, colorDistFloor: -5, colorDistGamma: -0.4 } },
  { label: 'split-aggressive', changes: { partitionColorTolerance: -9, partitionMinRegionPixels: -24, colorDistFloor: -4 } },
  { label: 'split-boundary', changes: { partitionBoundaryContinuation: 0.15, colorDistCeiling: -8 } },
  { label: 'split-gamma-low', changes: { colorDistGamma: -0.6, partitionColorTolerance: -3 } }
];

/**
 * Compound strategies specifically for "too many regions" feedback.
 * All changes bias toward LESS fragmentation, MORE merging, FEWER regions.
 */
const TOO_MANY_COMPOUNDS = [
  { label: 'merge-strong', changes: { partitionColorTolerance: 7, partitionMinRegionPixels: 24 } },
  { label: 'merge-moderate', changes: { partitionColorTolerance: 5, chromaWeight: -0.08 } },
  { label: 'merge-desensitize', changes: { colorDistFloor: 6, colorDistCeiling: 10 } },
  { label: 'merge-coarse', changes: { partitionMinRegionPixels: 40, partitionColorTolerance: 4 } },
  { label: 'merge-color-relax', changes: { chromaWeight: -0.12, colorDistFloor: 5, colorDistGamma: 0.4 } },
  { label: 'merge-aggressive', changes: { partitionColorTolerance: 10, partitionMinRegionPixels: 32, colorDistFloor: 5 } },
  { label: 'merge-smooth', changes: { partitionBoundaryContinuation: -0.15, colorDistCeiling: 10 } },
  { label: 'merge-gamma-high', changes: { colorDistGamma: 0.6, partitionColorTolerance: 4 } }
];

/**
 * Neutral compound strategies for undirected "regenerate" feedback.
 * Explores in all directions using only partition-effective parameters.
 */
const NEUTRAL_COMPOUNDS = [
  { label: 'more-regions', changes: { partitionColorTolerance: -5, partitionMinRegionPixels: -16 } },
  { label: 'fewer-regions', changes: { partitionColorTolerance: 6, partitionMinRegionPixels: 20 } },
  { label: 'color-sharp', changes: { colorDistFloor: -5, chromaWeight: 0.08, colorDistGamma: -0.3 } },
  { label: 'color-soft', changes: { colorDistFloor: 5, chromaWeight: -0.08, colorDistGamma: 0.3 } },
  { label: 'tight-boundaries', changes: { partitionBoundaryContinuation: 0.15, colorDistCeiling: -8 } },
  { label: 'loose-boundaries', changes: { partitionBoundaryContinuation: -0.15, colorDistCeiling: 8 } },
  { label: 'detail-preserve', changes: { partitionMinRegionPixels: -24, partitionColorTolerance: -4 } },
  { label: 'simplify', changes: { partitionMinRegionPixels: 32, partitionColorTolerance: 7 } },
  { label: 'gamma-low', changes: { colorDistGamma: -0.5, colorDistFloor: -3 } },
  { label: 'gamma-high', changes: { colorDistGamma: 0.5, colorDistFloor: 3 } }
];

/**
 * Generate the next WFG2 parameter candidate for regeneration.
 *
 * @param {object} opts
 * @param {object} opts.currentParams - Current WFG2 params
 * @param {object} opts.docFeatures - Document features
 * @param {number} opts.attemptNumber - How many regenerations so far
 * @param {Array} opts.triedVariants - Previously tried variant labels
 * @param {function} opts.copyParams - WFG2.copyParams function
 * @param {object} opts.familyStore - GraphFamilyStore instance
 * @param {object} opts.trainingStore - GraphTrainingStore instance
 * @param {string} opts.feedback - Feedback type: 'regenerate', 'too_few_regions', 'too_many_regions'
 * @returns {{ params, variantLabel, strategy, paramChanges }}
 */
function generateNextCandidate(opts) {
  const { currentParams, docFeatures, attemptNumber, triedVariants, copyParams,
          familyStore, trainingStore, feedback } = opts;
  const copy = copyParams || function(p) { return Object.assign({}, p); };
  const tried = new Set(triedVariants || []);
  const attempt = attemptNumber || 1;
  const feedbackType = feedback || FEEDBACK_TYPES.REGENERATE;

  // Select compound pool based on feedback
  let compounds;
  if (feedbackType === FEEDBACK_TYPES.TOO_FEW) {
    compounds = TOO_FEW_COMPOUNDS;
  } else if (feedbackType === FEEDBACK_TYPES.TOO_MANY) {
    compounds = TOO_MANY_COMPOUNDS;
  } else {
    compounds = NEUTRAL_COMPOUNDS;
  }

  // Single-param perturbations (only effective params, larger offsets)
  const perturbDefs = [
    { key: 'partitionColorTolerance', offsets: [-8, -5, 5, 8, -12, 12], min: 3, max: 50 },
    { key: 'chromaWeight',            offsets: [-0.12, -0.06, 0.06, 0.12], min: 0.3, max: 1.0 },
    { key: 'partitionMinRegionPixels', offsets: [-30, -16, 16, 30], min: 16, max: 300 },
    { key: 'partitionBoundaryContinuation', offsets: [-0.18, -0.10, 0.10, 0.18], min: 0, max: 1 },
    { key: 'colorDistFloor',          offsets: [-6, -3, 3, 6], min: 0, max: 35 },
    { key: 'colorDistCeiling',        offsets: [-10, -5, 5, 10], min: 20, max: 80 },
    { key: 'colorDistGamma',          offsets: [-0.5, -0.25, 0.25, 0.5], min: 0.5, max: 3.5 }
  ];

  // For directed feedback, filter perturbations to the right direction
  let directedPerturbDefs = perturbDefs;
  if (feedbackType === FEEDBACK_TYPES.TOO_FEW) {
    directedPerturbDefs = perturbDefs.map(def => {
      let offsets;
      if (def.key === 'partitionColorTolerance') offsets = [-8, -5, -12];
      else if (def.key === 'partitionMinRegionPixels') offsets = [-30, -16, -40];
      else if (def.key === 'chromaWeight') offsets = [0.06, 0.12, 0.18];
      else if (def.key === 'colorDistFloor') offsets = [-6, -3, -9];
      else if (def.key === 'colorDistCeiling') offsets = [-10, -5, -15];
      else if (def.key === 'colorDistGamma') offsets = [-0.5, -0.25, -0.75];
      else if (def.key === 'partitionBoundaryContinuation') offsets = [0.10, 0.18, 0.25];
      else offsets = def.offsets;
      return { ...def, offsets };
    });
  } else if (feedbackType === FEEDBACK_TYPES.TOO_MANY) {
    directedPerturbDefs = perturbDefs.map(def => {
      let offsets;
      if (def.key === 'partitionColorTolerance') offsets = [8, 5, 12];
      else if (def.key === 'partitionMinRegionPixels') offsets = [30, 16, 40];
      else if (def.key === 'chromaWeight') offsets = [-0.06, -0.12, -0.18];
      else if (def.key === 'colorDistFloor') offsets = [6, 3, 9];
      else if (def.key === 'colorDistCeiling') offsets = [10, 5, 15];
      else if (def.key === 'colorDistGamma') offsets = [0.5, 0.25, 0.75];
      else if (def.key === 'partitionBoundaryContinuation') offsets = [-0.10, -0.18, -0.25];
      else offsets = def.offsets;
      return { ...def, offsets };
    });
  }

  function _makeResult(params, variantLabel, strategy) {
    const changes = describeParamChanges(currentParams, params);
    return { params: _clampEffective(params), variantLabel, strategy, paramChanges: changes };
  }

  // Strategy 1: On early attempts with neutral feedback, try family-based params
  if (feedbackType === FEEDBACK_TYPES.REGENERATE && attempt <= 2 && familyStore && docFeatures?.valid) {
    const match = familyStore.findBestFamily(docFeatures);
    if (match && match.similarity >= 0.55) {
      const famParams = copy(match.family.avgParams);
      const label = 'family-' + (match.family.familyId || 'unknown').slice(0, 8);
      if (!tried.has(label)) {
        return _makeResult(famParams, label, 'family-match');
      }
    }
  }

  // Strategy 2: Try similar accepted examples' params (neutral only)
  if (feedbackType === FEEDBACK_TYPES.REGENERATE && attempt <= 4 && trainingStore && docFeatures?.valid) {
    const similar = trainingStore.findSimilar(docFeatures, 3);
    for (const { example, similarity } of similar) {
      if (similarity < 0.45) continue;
      const label = 'similar-' + (example.id || 'unknown').slice(0, 8);
      if (!tried.has(label) && example.acceptedParams) {
        return _makeResult(copy(example.acceptedParams), label, 'similar-example');
      }
    }
  }

  // Strategy 3: Compound variants from feedback-appropriate pool
  for (let i = 0; i < compounds.length; i++) {
    const ci = ((attempt - 1) + i) % compounds.length;
    const comp = compounds[ci];
    if (tried.has(comp.label)) continue;
    const p = copy(currentParams);
    for (const [k, v] of Object.entries(comp.changes)) {
      if (typeof p[k] === 'number') p[k] += v;
    }
    return _makeResult(p, comp.label, feedbackType === FEEDBACK_TYPES.REGENERATE ? 'compound' : 'directed-' + feedbackType);
  }

  // Strategy 4: Single-parameter perturbations (direction-filtered)
  for (const def of directedPerturbDefs) {
    for (const offset of def.offsets) {
      const label = def.key + (offset > 0 ? '+' : '') + offset;
      if (tried.has(label)) continue;
      const p = copy(currentParams);
      p[def.key] = Math.max(def.min, Math.min(def.max, (p[def.key] || 0) + offset));
      return _makeResult(p, label, 'single-perturb');
    }
  }

  // Strategy 5: Random compound from effective params only
  const p = copy(currentParams);
  const label = 'random-' + attempt;
  const shuffled = directedPerturbDefs.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < 3 && i < shuffled.length; i++) {
    const def = shuffled[i];
    const offIdx = Math.floor(Math.random() * def.offsets.length);
    p[def.key] = Math.max(def.min, Math.min(def.max, (p[def.key] || 0) + def.offsets[offIdx]));
  }
  return _makeResult(p, label, 'random-compound');
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

const _glExports = {
  extractDocumentFeatures,
  documentFeatureSimilarity,
  createGraphTrainingStore,
  createGraphFamilyStore,
  generateNextCandidate,
  computeGraphFingerprint,
  measureGraphChange,
  describeParamChanges,
  EFFECTIVE_PARAMS,
  FEEDBACK_TYPES,
  GRAPH_TRAINING_STORE_KEY,
  GRAPH_FAMILIES_KEY
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _glExports;
}
if (typeof window !== 'undefined') {
  window.GraphLearningStore = _glExports;
}
