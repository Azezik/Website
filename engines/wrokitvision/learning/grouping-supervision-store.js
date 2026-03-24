'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  grouping-supervision-store.js  –  Supervised Grouping Training Data Store
  ─────────────────────────────────────────────────────────────────────────────

  Stores local supervised feedback for the WFG2 grouping layer:
    - Boundary-level labels: merge / keep-separate between adjacent atomic regions
    - Cluster-level annotations: converted to pairwise merge constraints
    - Feature snapshots at labeling time for later model training
    - Session/image provenance for corpus management

  Design goals:
    - Data survives page refresh (localStorage)
    - Hours of training produce a reusable, exportable corpus
    - Each label records enough context (features, params, image identity)
      to be useful for offline model training later
───────────────────────────────────────────────────────────────────────────────*/

const GROUPING_SUPERVISION_KEY = 'wfg2.groupingSupervision.v1';
const MAX_SUPERVISION_EXAMPLES = 5000;

/* ── Core Store ──────────────────────────────────────────────────────────── */

function createGroupingSupervisionStore(storage) {
  const store = storage || localStorage;

  function _load() {
    try {
      const raw = store.getItem(GROUPING_SUPERVISION_KEY);
      return raw ? JSON.parse(raw) : { sessions: [], boundaryLabels: [], clusterAnnotations: [] };
    } catch (e) { return { sessions: [], boundaryLabels: [], clusterAnnotations: [] }; }
  }

  function _save(data) {
    try {
      // Trim boundary labels to max
      if (data.boundaryLabels.length > MAX_SUPERVISION_EXAMPLES) {
        data.boundaryLabels = data.boundaryLabels.slice(-MAX_SUPERVISION_EXAMPLES);
      }
      store.setItem(GROUPING_SUPERVISION_KEY, JSON.stringify(data));
    } catch (e) { console.error('[GroupingSupervision] Failed to save', e); }
  }

  return {
    /**
     * Register a supervision session (one image + one set of engine params).
     * @param {object} session
     * @param {string} session.sessionId - unique session ID
     * @param {string} session.fileId - image/document identifier
     * @param {string} session.fileName - human-readable name
     * @param {object} session.engineParams - WFG2 params used for partition
     * @param {object} session.surfaceSize - { width, height }
     * @param {number} session.atomicRegionCount - number of atomic regions
     * @param {string} session.pipelineMode - partition/hybrid/etc
     * @returns {string} sessionId
     */
    registerSession(session) {
      const data = _load();
      const sid = session.sessionId || ('gsup-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
      data.sessions.push({
        sessionId: sid,
        fileId: session.fileId || null,
        fileName: session.fileName || '',
        engineParams: session.engineParams || {},
        surfaceSize: session.surfaceSize || { width: 0, height: 0 },
        atomicRegionCount: session.atomicRegionCount || 0,
        pipelineMode: session.pipelineMode || 'partition',
        createdAt: new Date().toISOString()
      });
      // Keep only last 200 sessions
      if (data.sessions.length > 200) data.sessions = data.sessions.slice(-200);
      _save(data);
      return sid;
    },

    /**
     * Add a boundary-level label (merge / keep-separate).
     * @param {object} label
     * @param {string} label.sessionId - supervision session
     * @param {string} label.nodeIdA - atomic node ID (e.g. 'wfg2-p-3')
     * @param {string} label.nodeIdB - atomic node ID (e.g. 'wfg2-p-7')
     * @param {number} label.partitionIdA - partition region ID
     * @param {number} label.partitionIdB - partition region ID
     * @param {string} label.label - 'merge' or 'keep'
     * @param {object} label.features - snapshot of boundary features at labeling time
     * @param {object} [label.nodeFeatures] - features of the two nodes { a: {...}, b: {...} }
     */
    addBoundaryLabel(label) {
      const data = _load();
      data.boundaryLabels.push({
        id: 'bl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        sessionId: label.sessionId,
        nodeIdA: label.nodeIdA,
        nodeIdB: label.nodeIdB,
        partitionIdA: label.partitionIdA,
        partitionIdB: label.partitionIdB,
        label: label.label, // 'merge' | 'keep'
        features: label.features || {},
        nodeFeatures: label.nodeFeatures || null,
        timestamp: new Date().toISOString()
      });
      _save(data);
    },

    /**
     * Add a cluster annotation (user lassoed a group of fragments).
     * Internally converts to pairwise merge constraints between adjacent members.
     *
     * @param {object} annotation
     * @param {string} annotation.sessionId
     * @param {Array<string>} annotation.memberNodeIds - atomic node IDs in the cluster
     * @param {Array<{from: string, to: string}>} annotation.adjacencyPairs - which members are adjacent
     * @param {object} [annotation.boundingBox] - lasso bounding box
     */
    addClusterAnnotation(annotation) {
      const data = _load();
      const clusterEntry = {
        id: 'ca-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        sessionId: annotation.sessionId,
        memberNodeIds: annotation.memberNodeIds || [],
        adjacencyPairs: annotation.adjacencyPairs || [],
        boundingBox: annotation.boundingBox || null,
        timestamp: new Date().toISOString()
      };
      data.clusterAnnotations.push(clusterEntry);

      // Convert to pairwise merge labels for adjacent members
      for (const pair of (annotation.adjacencyPairs || [])) {
        const a = pair.from, b = pair.to;
        // Only add if both are in the cluster
        if (annotation.memberNodeIds.includes(a) && annotation.memberNodeIds.includes(b)) {
          data.boundaryLabels.push({
            id: 'bl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            sessionId: annotation.sessionId,
            nodeIdA: a,
            nodeIdB: b,
            partitionIdA: null, // will be resolved from node if needed
            partitionIdB: null,
            label: 'merge',
            features: {},
            nodeFeatures: null,
            source: 'cluster',
            clusterId: clusterEntry.id,
            timestamp: new Date().toISOString()
          });
        }
      }

      // Keep cluster annotations bounded
      if (data.clusterAnnotations.length > 1000) {
        data.clusterAnnotations = data.clusterAnnotations.slice(-1000);
      }
      _save(data);
    },

    /**
     * Get all boundary labels for a given session.
     * @param {string} sessionId
     * @returns {Array}
     */
    getBoundaryLabelsForSession(sessionId) {
      const data = _load();
      return data.boundaryLabels.filter(bl => bl.sessionId === sessionId);
    },

    /**
     * Get all boundary labels across all sessions.
     * @returns {Array}
     */
    getAllBoundaryLabels() {
      return _load().boundaryLabels;
    },

    /**
     * Get all cluster annotations for a session.
     * @param {string} sessionId
     * @returns {Array}
     */
    getClusterAnnotationsForSession(sessionId) {
      const data = _load();
      return data.clusterAnnotations.filter(ca => ca.sessionId === sessionId);
    },

    /**
     * Build supervision constraints suitable for computeGroupedGraph().
     * Aggregates all labels for a session into { merges, keeps }.
     * @param {string} sessionId
     * @returns {{ merges: Array<{a: string, b: string}>, keeps: Array<{a: string, b: string}> }}
     */
    buildConstraints(sessionId) {
      const labels = this.getBoundaryLabelsForSession(sessionId);
      const merges = [], keeps = [];
      // Last label wins for a given pair
      const pairMap = new Map();
      for (const bl of labels) {
        const key = bl.nodeIdA < bl.nodeIdB ? bl.nodeIdA + '|' + bl.nodeIdB : bl.nodeIdB + '|' + bl.nodeIdA;
        pairMap.set(key, bl);
      }
      for (const [, bl] of pairMap) {
        if (bl.label === 'merge') merges.push({ a: bl.nodeIdA, b: bl.nodeIdB });
        else if (bl.label === 'keep') keeps.push({ a: bl.nodeIdA, b: bl.nodeIdB });
      }
      return { merges, keeps };
    },

    /**
     * Get summary statistics.
     * @returns {object}
     */
    getSummary() {
      const data = _load();
      const mergeCount = data.boundaryLabels.filter(bl => bl.label === 'merge').length;
      const keepCount = data.boundaryLabels.filter(bl => bl.label === 'keep').length;
      return {
        sessionCount: data.sessions.length,
        totalBoundaryLabels: data.boundaryLabels.length,
        mergeLabels: mergeCount,
        keepLabels: keepCount,
        clusterAnnotations: data.clusterAnnotations.length
      };
    },

    /**
     * Export all data for offline analysis / model training.
     * @returns {object}
     */
    exportAll() {
      const data = _load();
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...data
      };
    },

    /**
     * Clear all supervision data.
     */
    clear() {
      _save({ sessions: [], boundaryLabels: [], clusterAnnotations: [] });
    },

    /** Storage key for external access */
    STORAGE_KEY: GROUPING_SUPERVISION_KEY
  };
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

const _gsExports = {
  createGroupingSupervisionStore,
  GROUPING_SUPERVISION_KEY
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _gsExports;
}
if (typeof window !== 'undefined') {
  window.GroupingSupervisionStore = _gsExports;
}
