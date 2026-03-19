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

/**
 * Generate the next WFG2 parameter candidate for regeneration.
 *
 * Strategy priority:
 * 1. If learned families have a match, start from family params
 * 2. If previous accepted examples are similar, use their params as starting point
 * 3. Apply controlled perturbations around the current best
 * 4. Avoid repeating recently tried variants
 *
 * @param {object} opts
 * @param {object} opts.currentParams - Current WFG2 params
 * @param {object} opts.docFeatures - Document features
 * @param {number} opts.attemptNumber - How many regenerations so far
 * @param {Array} opts.triedVariants - Previously tried variant labels
 * @param {function} opts.copyParams - WFG2.copyParams function
 * @param {object} opts.familyStore - GraphFamilyStore instance
 * @param {object} opts.trainingStore - GraphTrainingStore instance
 * @returns {{ params, variantLabel, strategy }}
 */
function generateNextCandidate(opts) {
  const { currentParams, docFeatures, attemptNumber, triedVariants, copyParams,
          familyStore, trainingStore } = opts;
  const copy = copyParams || function(p) { return Object.assign({}, p); };
  const tried = new Set(triedVariants || []);
  const attempt = attemptNumber || 1;

  // Perturbation definitions
  const perturbDefs = [
    { key: 'partitionColorTolerance', offsets: [-6, -3, 3, 6, -9, 9], min: 3, max: 50 },
    { key: 'mergeThreshold', offsets: [-5, -3, 3, 5, -8, 8], min: 4, max: 50 },
    { key: 'colorDistFloor', offsets: [-5, -3, 3, 5], min: 0, max: 35 },
    { key: 'colorDistCeiling', offsets: [-8, -5, 5, 8], min: 20, max: 80 },
    { key: 'surfaceUniformityBias', offsets: [-0.15, -0.08, 0.08, 0.15], min: 0, max: 1 },
    { key: 'partitionBoundaryContinuation', offsets: [-0.15, -0.08, 0.08, 0.15], min: 0, max: 1 },
    { key: 'closureWeight', offsets: [-0.08, 0.08, 0.15, -0.15], min: 0, max: 0.6 },
    { key: 'colorWeight', offsets: [-0.10, -0.05, 0.05, 0.10], min: 0.3, max: 0.95 },
    { key: 'partitionMinRegionPixels', offsets: [-24, -12, 12, 24], min: 16, max: 256 },
    { key: 'colorDistGamma', offsets: [-0.4, -0.2, 0.2, 0.4], min: 0.5, max: 3.5 }
  ];

  // Compound variants for variety
  const compounds = [
    { label: 'more-regions', changes: { partitionColorTolerance: -4, mergeThreshold: -4, partitionMinRegionPixels: -16 } },
    { label: 'fewer-regions', changes: { partitionColorTolerance: 5, mergeThreshold: 5, partitionMinRegionPixels: 16 } },
    { label: 'color-sharp', changes: { colorDistFloor: -5, colorWeight: 0.08, colorDistGamma: -0.3 } },
    { label: 'color-soft', changes: { colorDistFloor: 5, colorWeight: -0.08, colorDistGamma: 0.3 } },
    { label: 'tight-boundaries', changes: { partitionBoundaryContinuation: 0.12, closureWeight: 0.10 } },
    { label: 'loose-boundaries', changes: { partitionBoundaryContinuation: -0.12, closureWeight: -0.08 } },
    { label: 'high-merge', changes: { mergeThreshold: 8, surfaceUniformityBias: 0.15 } },
    { label: 'low-merge', changes: { mergeThreshold: -8, surfaceUniformityBias: -0.15 } },
    { label: 'detail-preserve', changes: { partitionMinRegionPixels: -20, partitionColorTolerance: -3, closureWeight: 0.05 } },
    { label: 'simplify', changes: { partitionMinRegionPixels: 32, partitionColorTolerance: 6, mergeThreshold: 6 } }
  ];

  // Strategy 1: On early attempts, try family-based params if available
  if (attempt <= 2 && familyStore && docFeatures?.valid) {
    const match = familyStore.findBestFamily(docFeatures);
    if (match && match.similarity >= 0.55) {
      const famParams = copy(match.family.avgParams);
      const label = 'family-' + (match.family.familyId || 'unknown').slice(0, 8);
      if (!tried.has(label)) {
        return { params: famParams, variantLabel: label, strategy: 'family-match' };
      }
    }
  }

  // Strategy 2: Try similar accepted examples' params
  if (attempt <= 4 && trainingStore && docFeatures?.valid) {
    const similar = trainingStore.findSimilar(docFeatures, 3);
    for (const { example, similarity } of similar) {
      if (similarity < 0.45) continue;
      const label = 'similar-' + (example.id || 'unknown').slice(0, 8);
      if (!tried.has(label) && example.acceptedParams) {
        return { params: copy(example.acceptedParams), variantLabel: label, strategy: 'similar-example' };
      }
    }
  }

  // Strategy 3: Compound variants
  const compoundIdx = (attempt - 1) % compounds.length;
  // Try compounds in order, skip already tried
  for (let i = 0; i < compounds.length; i++) {
    const ci = (compoundIdx + i) % compounds.length;
    const comp = compounds[ci];
    if (tried.has(comp.label)) continue;
    const p = copy(currentParams);
    for (const [k, v] of Object.entries(comp.changes)) {
      if (typeof p[k] === 'number') p[k] += v;
    }
    // Clamp
    for (const def of perturbDefs) {
      if (typeof p[def.key] === 'number') {
        p[def.key] = Math.max(def.min, Math.min(def.max, p[def.key]));
      }
    }
    return { params: p, variantLabel: comp.label, strategy: 'compound' };
  }

  // Strategy 4: Single-parameter perturbations
  for (const def of perturbDefs) {
    for (const offset of def.offsets) {
      const label = def.key + (offset > 0 ? '+' : '') + offset;
      if (tried.has(label)) continue;
      const p = copy(currentParams);
      p[def.key] = Math.max(def.min, Math.min(def.max, (p[def.key] || 0) + offset));
      return { params: p, variantLabel: label, strategy: 'single-perturb' };
    }
  }

  // Strategy 5: Random compound (fallback — should rarely be reached)
  const p = copy(currentParams);
  const label = 'random-' + attempt;
  // Pick 2-3 random perturbations
  const shuffled = perturbDefs.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < 3 && i < shuffled.length; i++) {
    const def = shuffled[i];
    const offIdx = Math.floor(Math.random() * def.offsets.length);
    p[def.key] = Math.max(def.min, Math.min(def.max, (p[def.key] || 0) + def.offsets[offIdx]));
  }
  return { params: p, variantLabel: label, strategy: 'random-compound' };
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

const _glExports = {
  extractDocumentFeatures,
  documentFeatureSimilarity,
  createGraphTrainingStore,
  createGraphFamilyStore,
  generateNextCandidate,
  GRAPH_TRAINING_STORE_KEY,
  GRAPH_FAMILIES_KEY
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _glExports;
}
if (typeof window !== 'undefined') {
  window.GraphLearningStore = _glExports;
}
