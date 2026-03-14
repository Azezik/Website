'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  batch-learning-session.js  –  Manages batch structural learning sessions
  ─────────────────────────────────────────────────────────────────────────────

  A batch learning session groups documents that share the same layout or
  template (e.g., 50 invoices from Supplier A). The session captures
  per-document structural summaries from WrokitVision's analysis pipeline
  and preserves them for cross-document stability analysis.

  This module is separate from the existing human-guided learning mode
  (learning-session.js). It does NOT use user-drawn bounding boxes. Instead,
  it evaluates the internal structural outputs of the system itself.

  ─── Data flow ──────────────────────────────────────────────────────────────

  1. User creates a batch session (createBatchLearningSession)
  2. User attaches processed documents (addDocument) with their analysis
     results from runUploadAnalysis
  3. The session captures a per-document structural summary including:
     - Region feature descriptors
     - Region spatial coordinates (normalized)
     - Adjacency graph structure
     - Neighborhood descriptors
     - Text block/line groupings
  4. The session provides batch-comparable structural features:
     - Normalized spatial distributions
     - Comparable feature vectors
     - Region signature descriptors

  ─── Future phase compatibility ─────────────────────────────────────────────

  The per-document summaries and batch-comparable features are preserved in
  structured form so that future phases can perform:
  - Recurring region clustering
  - Cross-document structural alignment
  - Consensus anchor discovery
  - Structural template generation

───────────────────────────────────────────────────────────────────────────────*/

const BATCH_SESSION_STORAGE_KEY = 'wrokit.learning.batchSessions';

let _idCounter = 0;
function _genId(prefix) {
  _idCounter += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '-' + _idCounter;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/* ── Per-document structural summary extraction ─────────────────────────── */

/**
 * Extracts a reusable structural summary from a WrokitVision analysis result.
 * The summary preserves enough information for cross-document comparison
 * and future phase algorithms.
 *
 * @param {object} analysisResult - Output from runUploadAnalysis()
 * @param {object} opts - { documentId, documentName, viewport }
 * @returns {object} DocumentStructuralSummary
 */
function extractDocumentSummary(analysisResult, opts) {
  opts = opts || {};
  const ar = analysisResult || {};
  const regionNodes = ar.regionNodes || [];
  const regionGraph = ar.regionGraph || { nodes: [], edges: [] };
  const textLines = ar.textLines || [];
  const textBlocks = ar.textBlocks || [];
  const textTokens = ar.textTokens || [];
  const surfaceCandidates = ar.surfaceCandidates || [];
  const viewport = ar.viewport || opts.viewport || { width: 0, height: 0 };
  const vpW = Number(viewport.width || viewport.w) || 1;
  const vpH = Number(viewport.height || viewport.h) || 1;

  // Extract region feature descriptors
  const regionDescriptors = regionNodes.map(function (r) {
    const bbox = r.geometry && r.geometry.bbox || {};
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Number(bbox.w) || 0;
    const h = Number(bbox.h) || 0;
    return {
      regionId: r.id,
      normalizedBbox: {
        x: clamp01(x / vpW),
        y: clamp01(y / vpH),
        w: clamp01(w / vpW),
        h: clamp01(h / vpH)
      },
      area: w * h,
      normalizedArea: clamp01((w * h) / (vpW * vpH)),
      aspectRatio: h > 0 ? w / h : 0,
      confidence: Number(r.confidence) || 0,
      textDensity: Number(r.textDensity) || 0,
      surfaceType: r.surfaceTypeCandidate || 'unknown',
      features: r.features || {},
      centroid: {
        x: clamp01((x + w / 2) / vpW),
        y: clamp01((y + h / 2) / vpH)
      }
    };
  });

  // Extract adjacency graph structure
  const adjacencyEdges = (regionGraph.edges || []).map(function (e) {
    return {
      sourceId: e.sourceNodeId,
      targetId: e.targetNodeId,
      edgeType: e.edgeType,
      weight: Number(e.weight) || 0
    };
  });

  // Compute neighborhood descriptors per region
  const neighborhoodMap = {};
  for (const e of adjacencyEdges) {
    if (!neighborhoodMap[e.sourceId]) neighborhoodMap[e.sourceId] = [];
    if (!neighborhoodMap[e.targetId]) neighborhoodMap[e.targetId] = [];
    neighborhoodMap[e.sourceId].push({ neighborId: e.targetId, edgeType: e.edgeType, weight: e.weight });
    neighborhoodMap[e.targetId].push({ neighborId: e.sourceId, edgeType: e.edgeType, weight: e.weight });
  }

  const neighborhoodDescriptors = {};
  for (const rd of regionDescriptors) {
    const neighbors = neighborhoodMap[rd.regionId] || [];
    neighborhoodDescriptors[rd.regionId] = {
      neighborCount: neighbors.length,
      avgEdgeWeight: neighbors.length
        ? neighbors.reduce(function (s, n) { return s + n.weight; }, 0) / neighbors.length
        : 0,
      containsCount: neighbors.filter(function (n) { return n.edgeType === 'contains'; }).length,
      proximityCount: neighbors.filter(function (n) { return n.edgeType === 'spatial_proximity'; }).length
    };
  }

  // Text structure summary
  const textStructure = {
    lineCount: textLines.length,
    blockCount: textBlocks.length,
    tokenCount: textTokens.length,
    avgTokensPerLine: textLines.length
      ? textTokens.length / textLines.length
      : 0,
    avgLinesPerBlock: textBlocks.length
      ? textLines.length / textBlocks.length
      : 0,
    blockDescriptors: textBlocks.map(function (b) {
      const bbox = b.geometry && b.geometry.bbox || {};
      return {
        blockId: b.id,
        normalizedBbox: {
          x: clamp01((Number(bbox.x) || 0) / vpW),
          y: clamp01((Number(bbox.y) || 0) / vpH),
          w: clamp01((Number(bbox.w) || 0) / vpW),
          h: clamp01((Number(bbox.h) || 0) / vpH)
        },
        lineCount: (b.lineIds || []).length,
        tokenCount: (b.tokenIds || []).length,
        textLength: (b.text || '').length
      };
    })
  };

  // Compute normalized spatial distribution (grid-based density)
  const gridSize = 4; // 4x4 grid
  const spatialGrid = [];
  for (let i = 0; i < gridSize * gridSize; i++) spatialGrid.push(0);
  for (const rd of regionDescriptors) {
    const gx = Math.min(gridSize - 1, Math.floor(rd.centroid.x * gridSize));
    const gy = Math.min(gridSize - 1, Math.floor(rd.centroid.y * gridSize));
    spatialGrid[gy * gridSize + gx] += rd.normalizedArea;
  }
  // Normalize the grid
  const gridSum = spatialGrid.reduce(function (s, v) { return s + v; }, 0);
  const normalizedSpatialDistribution = spatialGrid.map(function (v) {
    return gridSum > 0 ? v / gridSum : 0;
  });

  // Compute comparable feature vectors for each region
  const regionSignatures = regionDescriptors.map(function (rd) {
    const nh = neighborhoodDescriptors[rd.regionId] || {};
    return {
      regionId: rd.regionId,
      featureVector: [
        rd.normalizedBbox.x,
        rd.normalizedBbox.y,
        rd.normalizedBbox.w,
        rd.normalizedBbox.h,
        rd.normalizedArea,
        rd.aspectRatio > 10 ? 10 : rd.aspectRatio,
        rd.confidence,
        rd.textDensity,
        (nh.neighborCount || 0) / 10,
        (nh.avgEdgeWeight || 0)
      ],
      spatialBin: (Math.min(gridSize - 1, Math.floor(rd.centroid.y * gridSize))) * gridSize +
        Math.min(gridSize - 1, Math.floor(rd.centroid.x * gridSize))
    };
  });

  // Surface type distribution
  const surfaceTypeCounts = {};
  for (const rd of regionDescriptors) {
    surfaceTypeCounts[rd.surfaceType] = (surfaceTypeCounts[rd.surfaceType] || 0) + 1;
  }

  const metrics = {
    regionCount: regionNodes.length,
    edgeCount: adjacencyEdges.length,
    avgRegionArea: regionDescriptors.length
      ? regionDescriptors.reduce(function (s, r) { return s + r.normalizedArea; }, 0) / regionDescriptors.length
      : 0,
    avgTextDensity: regionDescriptors.length
      ? regionDescriptors.reduce(function (s, r) { return s + r.textDensity; }, 0) / regionDescriptors.length
      : 0,
    avgConfidence: regionDescriptors.length
      ? regionDescriptors.reduce(function (s, r) { return s + r.confidence; }, 0) / regionDescriptors.length
      : 0,
    textLineCount: textLines.length,
    textBlockCount: textBlocks.length,
    surfaceCandidateCount: surfaceCandidates.length
  };

  // Structural validity check: a document must have real structural outputs
  // to participate in batch stability analysis.
  const hasRegions = metrics.regionCount > 0;
  const hasViewport = vpW > 1 && vpH > 1;
  const structurallyValid = hasRegions && hasViewport;
  const validationReason = !hasViewport
    ? 'Missing or zero viewport dimensions'
    : !hasRegions
      ? 'No regions detected — WrokitVision analysis may not have run or the image produced no structural output'
      : '';

  return {
    documentId: opts.documentId || _genId('bdoc'),
    documentName: opts.documentName || '',
    timestamp: new Date().toISOString(),
    viewport: { w: vpW, h: vpH },

    // Structural validity flag — batch analysis must exclude invalid documents
    structurallyValid: structurallyValid,
    validationReason: validationReason,

    // Per-document structural data (preserved for future phases)
    regionDescriptors: regionDescriptors,
    adjacencyEdges: adjacencyEdges,
    neighborhoodDescriptors: neighborhoodDescriptors,
    textStructure: textStructure,
    surfaceTypeCounts: surfaceTypeCounts,

    // Batch-comparable features
    normalizedSpatialDistribution: normalizedSpatialDistribution,
    regionSignatures: regionSignatures,

    // Aggregate scalars for quick comparison
    metrics: metrics
  };
}

/* ── Compact summary for storage ──────────────────────────────────────── */

/**
 * Strips a full document summary down to the minimum data the stability
 * analyst needs.  Reduces per-document size from ~150 KB to ~2 KB by
 * replacing large per-region arrays with pre-aggregated statistics.
 *
 * Full summaries are kept in memory for the active session; only compact
 * summaries are written to localStorage.
 */
function compactForStorage(doc) {
  if (!doc) return doc;
  // Pre-aggregate adjacency edge statistics so the full edge array
  // does not need to be persisted.
  var edgeTypes = { spatial_proximity: 0, contains: 0, other: 0 };
  var weightSum = 0;
  var edges = doc.adjacencyEdges || [];
  for (var i = 0; i < edges.length; i++) {
    var et = edges[i].edgeType;
    if (edgeTypes.hasOwnProperty(et)) edgeTypes[et]++;
    else edgeTypes.other++;
    weightSum += (edges[i].weight || 0);
  }
  var edgeTotal = edges.length || 1;

  return {
    documentId: doc.documentId,
    documentName: doc.documentName,
    timestamp: doc.timestamp,
    viewport: doc.viewport,
    structurallyValid: doc.structurallyValid,
    validationReason: doc.validationReason,
    metrics: doc.metrics,
    surfaceTypeCounts: doc.surfaceTypeCounts,
    normalizedSpatialDistribution: doc.normalizedSpatialDistribution,
    textStructure: {
      lineCount: doc.textStructure.lineCount,
      blockCount: doc.textStructure.blockCount,
      tokenCount: doc.textStructure.tokenCount,
      avgTokensPerLine: doc.textStructure.avgTokensPerLine,
      avgLinesPerBlock: doc.textStructure.avgLinesPerBlock
      // blockDescriptors intentionally omitted — large, not needed for stability analysis
    },
    // Compact replacements for large arrays:
    _regionAreas: (doc.regionDescriptors || []).map(function (r) {
      return Math.round((r.normalizedArea || 0) * 100000) / 100000;
    }),
    _adjacencyStats: {
      count: edges.length,
      typeDistribution: [
        edgeTypes.spatial_proximity / edgeTotal,
        edgeTypes.contains / edgeTotal,
        edgeTypes.other / edgeTotal
      ],
      avgWeight: edges.length ? weightSum / edges.length : 0
    },
    _compact: true  // marker so analyst knows this is a compact summary
  };
}

/* ── Batch session store ────────────────────────────────────────────────── */

/**
 * Hybrid store: full document summaries live in memory for the active
 * browser session; only compact (~2 KB) summaries are written to
 * localStorage so multi-document batches never exceed the 5 MB quota.
 *
 * When the page reloads, in-memory data is lost but compact summaries
 * are loaded from localStorage — enough for re-running stability analysis.
 */
function createBatchSessionStore(storage) {
  const backend = storage || _memoryBackend();

  // In-memory map: sessionId → full document summary array
  const _memDocs = {};

  function _load() {
    try {
      const raw = backend.getItem(BATCH_SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_e) { return []; }
  }

  function _save(sessions) {
    try {
      backend.setItem(BATCH_SESSION_STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {
      // If storage still fails after compaction, warn but don't crash
      console.warn('[BatchSessionStore] localStorage write failed:', e.message || e);
    }
  }

  return {
    /** Create a new batch learning session. */
    createSession(opts) {
      opts = opts || {};
      const sessions = _load();
      const session = {
        sessionId: _genId('bsess'),
        name: String(opts.name || 'Untitled Batch'),
        description: String(opts.description || ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        documents: [],
        stabilityReport: null,
        status: 'open'
      };
      sessions.push(session);
      _memDocs[session.sessionId] = [];
      _save(sessions);
      return session;
    },

    /** Get all sessions. */
    getAllSessions() {
      return _load();
    },

    /**
     * Get a session by ID.
     * Returns documents from in-memory (full) if available,
     * otherwise falls back to compact localStorage copies.
     */
    getSession(sessionId) {
      const sessions = _load();
      const session = sessions.find(function (s) { return s.sessionId === sessionId; }) || null;
      if (!session) return null;
      // Merge in-memory full documents if available
      if (_memDocs[sessionId] && _memDocs[sessionId].length) {
        session.documents = _memDocs[sessionId];
      }
      return session;
    },

    /**
     * Add a document summary to a session.
     * Full summary is kept in memory; compact version is persisted.
     */
    addDocument(sessionId, documentSummary) {
      const sessions = _load();
      const session = sessions.find(function (s) { return s.sessionId === sessionId; });
      if (!session) return null;

      // Keep full summary in memory
      if (!_memDocs[sessionId]) _memDocs[sessionId] = [];
      _memDocs[sessionId].push(documentSummary);

      // Persist only compact summary to localStorage
      session.documents.push(compactForStorage(documentSummary));
      session.updatedAt = new Date().toISOString();
      _save(sessions);

      return documentSummary.documentId;
    },

    /** Remove a document from a session. */
    removeDocument(sessionId, documentId) {
      const sessions = _load();
      const session = sessions.find(function (s) { return s.sessionId === sessionId; });
      if (!session) return false;
      const idx = session.documents.findIndex(function (d) { return d.documentId === documentId; });
      if (idx < 0) return false;
      session.documents.splice(idx, 1);
      session.updatedAt = new Date().toISOString();
      _save(sessions);
      // Also remove from in-memory
      if (_memDocs[sessionId]) {
        const mIdx = _memDocs[sessionId].findIndex(function (d) { return d.documentId === documentId; });
        if (mIdx >= 0) _memDocs[sessionId].splice(mIdx, 1);
      }
      return true;
    },

    /** Store a stability report for a session. */
    saveStabilityReport(sessionId, report) {
      const sessions = _load();
      const session = sessions.find(function (s) { return s.sessionId === sessionId; });
      if (!session) return false;
      // Strip intermediateData from persisted report — it contains large
      // per-region signature arrays that are only useful in-memory.
      var persistReport = report;
      if (report && report.intermediateData) {
        persistReport = Object.assign({}, report);
        persistReport.intermediateData = null;
      }
      session.stabilityReport = persistReport;
      session.updatedAt = new Date().toISOString();
      _save(sessions);
      return true;
    },

    /** Store a correspondence result (Phase 2) for a session. */
    saveCorrespondenceResult(sessionId, result) {
      const sessions = _load();
      const session = sessions.find(function (s) { return s.sessionId === sessionId; });
      if (!session) return false;
      // Strip large correspondences array from persisted result — keep only
      // the alignment model and anchors for storage efficiency.
      var persistResult = result;
      if (result && result.correspondences && result.correspondences.length > 50) {
        persistResult = Object.assign({}, result);
        persistResult.correspondences = null;
        persistResult._correspondencesStripped = true;
      }
      session.correspondenceResult = persistResult;
      session.updatedAt = new Date().toISOString();
      _save(sessions);
      return true;
    },

    /** Delete a session. */
    deleteSession(sessionId) {
      const sessions = _load().filter(function (s) { return s.sessionId !== sessionId; });
      _save(sessions);
      delete _memDocs[sessionId];
    },

    /** Get document count for a session. */
    documentCount(sessionId) {
      if (_memDocs[sessionId]) return _memDocs[sessionId].length;
      const session = this.getSession(sessionId);
      return session ? session.documents.length : 0;
    },

    /** Clear all batch sessions. */
    clear() {
      _save([]);
      for (var k in _memDocs) delete _memDocs[k];
    }
  };
}

/* ── In-memory fallback ─────────────────────────────────────────────────── */

function _memoryBackend() {
  const map = new Map();
  return {
    getItem(key) { return map.get(key) || null; },
    setItem(key, value) { map.set(key, value); }
  };
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  extractDocumentSummary,
  compactForStorage,
  createBatchSessionStore,
  BATCH_SESSION_STORAGE_KEY
};
