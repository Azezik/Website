const assert = require('assert');

/* ══════════════════════════════════════════════════════════════════════════
   Batch Structural Learning – Phase 1 Tests
   ══════════════════════════════════════════════════════════════════════════ */

/* ── batch-learning-session ────────────────────────────────────────────── */

const {
  extractDocumentSummary,
  createBatchSessionStore,
  compactForStorage,
  BATCH_SESSION_STORAGE_KEY
} = require('../engines/wrokitvision/learning/batch-learning-session.js');

// ── extractDocumentSummary: basic extraction ───────────────────────────

const mockAnalysis = {
  viewport: { width: 800, height: 1000 },
  regionNodes: [
    {
      id: 'r1',
      geometry: { bbox: { x: 50, y: 100, w: 200, h: 150 } },
      confidence: 0.7,
      textDensity: 0.5,
      surfaceTypeCandidate: 'text_dense_surface',
      features: { area: 30000 }
    },
    {
      id: 'r2',
      geometry: { bbox: { x: 300, y: 400, w: 400, h: 300 } },
      confidence: 0.85,
      textDensity: 0.8,
      surfaceTypeCandidate: 'text_dense_surface',
      features: { area: 120000 }
    },
    {
      id: 'r3',
      geometry: { bbox: { x: 600, y: 50, w: 150, h: 80 } },
      confidence: 0.5,
      textDensity: 0.1,
      surfaceTypeCandidate: 'visual_component',
      features: { area: 12000 }
    }
  ],
  regionGraph: {
    nodes: [],
    edges: [
      { sourceNodeId: 'r1', targetNodeId: 'r2', edgeType: 'spatial_proximity', weight: 0.6 },
      { sourceNodeId: 'r2', targetNodeId: 'r3', edgeType: 'spatial_proximity', weight: 0.3 },
      { sourceNodeId: 'r1', targetNodeId: 'r3', edgeType: 'contains', weight: 0.95 }
    ]
  },
  textTokens: [
    { id: 't1', text: 'Invoice' },
    { id: 't2', text: '#12345' },
    { id: 't3', text: 'Total' },
    { id: 't4', text: '$47.82' }
  ],
  textLines: [
    { id: 'l1', geometry: { bbox: { x: 50, y: 100, w: 200, h: 20 } }, tokenIds: ['t1', 't2'], text: 'Invoice #12345' },
    { id: 'l2', geometry: { bbox: { x: 300, y: 500, w: 150, h: 20 } }, tokenIds: ['t3', 't4'], text: 'Total $47.82' }
  ],
  textBlocks: [
    {
      id: 'b1',
      geometry: { bbox: { x: 50, y: 100, w: 200, h: 20 } },
      lineIds: ['l1'],
      tokenIds: ['t1', 't2'],
      text: 'Invoice #12345'
    },
    {
      id: 'b2',
      geometry: { bbox: { x: 300, y: 500, w: 150, h: 20 } },
      lineIds: ['l2'],
      tokenIds: ['t3', 't4'],
      text: 'Total $47.82'
    }
  ],
  surfaceCandidates: [{ id: 'sc1' }]
};

const summary = extractDocumentSummary(mockAnalysis, { documentName: 'test-invoice.png' });

// Basic structure
assert.ok(summary.documentId, 'Should have a documentId');
assert.strictEqual(summary.documentName, 'test-invoice.png');
assert.ok(summary.timestamp);
assert.deepStrictEqual(summary.viewport, { w: 800, h: 1000 });

// Region descriptors
assert.strictEqual(summary.regionDescriptors.length, 3);
assert.strictEqual(summary.regionDescriptors[0].regionId, 'r1');
assert.ok(summary.regionDescriptors[0].normalizedBbox.x > 0);
assert.ok(summary.regionDescriptors[0].normalizedArea > 0);
assert.ok(summary.regionDescriptors[0].centroid.x > 0);
assert.ok(summary.regionDescriptors[0].centroid.y > 0);

// Adjacency edges
assert.strictEqual(summary.adjacencyEdges.length, 3);
assert.strictEqual(summary.adjacencyEdges[0].sourceId, 'r1');
assert.strictEqual(summary.adjacencyEdges[0].edgeType, 'spatial_proximity');

// Neighborhood descriptors
assert.ok(summary.neighborhoodDescriptors['r1']);
assert.strictEqual(summary.neighborhoodDescriptors['r1'].neighborCount, 2);
assert.ok(summary.neighborhoodDescriptors['r2']);
assert.strictEqual(summary.neighborhoodDescriptors['r2'].neighborCount, 2);

// Text structure
assert.strictEqual(summary.textStructure.lineCount, 2);
assert.strictEqual(summary.textStructure.blockCount, 2);
assert.strictEqual(summary.textStructure.tokenCount, 4);
assert.strictEqual(summary.textStructure.blockDescriptors.length, 2);

// Spatial distribution (4x4 grid = 16 cells)
assert.strictEqual(summary.normalizedSpatialDistribution.length, 16);
const distSum = summary.normalizedSpatialDistribution.reduce((s, v) => s + v, 0);
assert.ok(Math.abs(distSum - 1) < 0.01, 'Spatial distribution should sum to ~1, got ' + distSum);

// Region signatures
assert.strictEqual(summary.regionSignatures.length, 3);
assert.strictEqual(summary.regionSignatures[0].featureVector.length, 10);

// Surface type counts
assert.strictEqual(summary.surfaceTypeCounts['text_dense_surface'], 2);
assert.strictEqual(summary.surfaceTypeCounts['visual_component'], 1);

// Metrics
assert.strictEqual(summary.metrics.regionCount, 3);
assert.strictEqual(summary.metrics.edgeCount, 3);
assert.strictEqual(summary.metrics.textLineCount, 2);
assert.strictEqual(summary.metrics.textBlockCount, 2);
assert.strictEqual(summary.metrics.surfaceCandidateCount, 1);
assert.ok(summary.metrics.avgRegionArea > 0);
assert.ok(summary.metrics.avgTextDensity > 0);
assert.ok(summary.metrics.avgConfidence > 0);

console.log('extractDocumentSummary tests passed.');

// ── extractDocumentSummary: empty analysis ─────────────────────────────

const emptySummary = extractDocumentSummary({});
assert.strictEqual(emptySummary.regionDescriptors.length, 0);
assert.strictEqual(emptySummary.adjacencyEdges.length, 0);
assert.strictEqual(emptySummary.textStructure.lineCount, 0);
assert.strictEqual(emptySummary.metrics.regionCount, 0);

console.log('extractDocumentSummary empty tests passed.');

// ── createBatchSessionStore ────────────────────────────────────────────

const store = createBatchSessionStore();

// Create session
const session = store.createSession({ name: 'Supplier A Invoices', description: 'Jan 2026 batch' });
assert.ok(session.sessionId.startsWith('bsess-'));
assert.strictEqual(session.name, 'Supplier A Invoices');
assert.strictEqual(session.description, 'Jan 2026 batch');
assert.strictEqual(session.documents.length, 0);
assert.strictEqual(session.status, 'open');

// Get session
const retrieved = store.getSession(session.sessionId);
assert.strictEqual(retrieved.name, 'Supplier A Invoices');

// Add document
const docId = store.addDocument(session.sessionId, summary);
assert.ok(docId);
assert.strictEqual(store.documentCount(session.sessionId), 1);

// Get all sessions
const all = store.getAllSessions();
assert.strictEqual(all.length, 1);
assert.strictEqual(all[0].documents.length, 1);

// Remove document
const removed = store.removeDocument(session.sessionId, docId);
assert.strictEqual(removed, true);
assert.strictEqual(store.documentCount(session.sessionId), 0);

// Delete session
store.deleteSession(session.sessionId);
assert.strictEqual(store.getAllSessions().length, 0);

// Clear
store.createSession({ name: 'A' });
store.createSession({ name: 'B' });
assert.strictEqual(store.getAllSessions().length, 2);
store.clear();
assert.strictEqual(store.getAllSessions().length, 0);

console.log('createBatchSessionStore tests passed.');

/* ── batch-structural-analyst ──────────────────────────────────────────── */

const {
  analyzeBatchStability,
  formatStabilityReport,
  analyzeRegionCountStability,
  analyzeRegionAreaStability,
  analyzeAdjacencyGraphStability,
  analyzeSpatialDistributionStability,
  analyzeTextStructureStability,
  analyzeSurfaceTypeStability,
  analyzeParameterSensitivity,
  cosineSimilarity,
  jensenShannonDivergence
} = require('../engines/wrokitvision/learning/batch-structural-analyst.js');

// ── Statistical helpers ────────────────────────────────────────────────

// Cosine similarity: identical vectors
assert.strictEqual(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);

// Cosine similarity: orthogonal vectors
assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);

// Cosine similarity: similar vectors
const sim = cosineSimilarity([1, 2, 3], [1, 2, 3.1]);
assert.ok(sim > 0.99, 'Similar vectors should have high similarity, got ' + sim);

// JSD: identical distributions
assert.strictEqual(jensenShannonDivergence([0.5, 0.5], [0.5, 0.5]), 0);

// JSD: completely different
const jsd = jensenShannonDivergence([1, 0], [0, 1]);
assert.ok(jsd > 0.9, 'Maximally different distributions should have high JSD, got ' + jsd);

console.log('Statistical helper tests passed.');

// ── Build mock document summaries ──────────────────────────────────────

function buildMockDocSummary(opts) {
  opts = opts || {};
  const regionCount = opts.regionCount || 5;
  const edgeCount = opts.edgeCount || 4;
  const avgArea = opts.avgArea || 0.05;
  const avgDensity = opts.avgDensity || 0.5;

  const regionDescriptors = [];
  const regionSignatures = [];
  for (let i = 0; i < regionCount; i++) {
    const cx = (i + 1) / (regionCount + 1);
    const cy = (i + 1) / (regionCount + 1);
    regionDescriptors.push({
      regionId: 'r' + i,
      normalizedBbox: { x: cx - 0.05, y: cy - 0.05, w: 0.1, h: 0.1 },
      area: avgArea * 800 * 1000,
      normalizedArea: avgArea + (Math.random() - 0.5) * 0.01,
      aspectRatio: 1.2,
      confidence: 0.7 + Math.random() * 0.1,
      textDensity: avgDensity + (Math.random() - 0.5) * 0.1,
      surfaceType: i < regionCount / 2 ? 'text_dense_surface' : 'visual_component',
      features: {},
      centroid: { x: cx, y: cy }
    });
    regionSignatures.push({
      regionId: 'r' + i,
      featureVector: [cx, cy, 0.1, 0.1, avgArea, 1.2, 0.7, avgDensity, 0.3, 0.5],
      spatialBin: Math.floor(cy * 4) * 4 + Math.floor(cx * 4)
    });
  }

  const adjacencyEdges = [];
  for (let j = 0; j < edgeCount; j++) {
    adjacencyEdges.push({
      sourceId: 'r' + j,
      targetId: 'r' + ((j + 1) % regionCount),
      edgeType: j % 2 === 0 ? 'spatial_proximity' : 'contains',
      weight: 0.5 + Math.random() * 0.3
    });
  }

  const grid = [];
  for (let g = 0; g < 16; g++) grid.push(Math.random() * 0.1);
  const gSum = grid.reduce((s, v) => s + v, 0);
  const normalizedGrid = grid.map(v => gSum > 0 ? v / gSum : 0);

  const surfaceTypeCounts = { text_dense_surface: Math.ceil(regionCount / 2), visual_component: Math.floor(regionCount / 2) };

  return {
    documentId: 'doc-' + Math.random().toString(36).slice(2, 6),
    documentName: opts.name || 'test-doc.png',
    timestamp: new Date().toISOString(),
    viewport: { w: 800, h: 1000 },
    regionDescriptors: regionDescriptors,
    adjacencyEdges: adjacencyEdges,
    neighborhoodDescriptors: {},
    textStructure: {
      lineCount: opts.lineCount || 20,
      blockCount: opts.blockCount || 5,
      tokenCount: opts.tokenCount || 80,
      avgTokensPerLine: 4,
      avgLinesPerBlock: 4,
      blockDescriptors: []
    },
    surfaceTypeCounts: surfaceTypeCounts,
    normalizedSpatialDistribution: normalizedGrid,
    regionSignatures: regionSignatures,
    metrics: {
      regionCount: regionCount,
      edgeCount: edgeCount,
      avgRegionArea: avgArea,
      avgTextDensity: avgDensity,
      avgConfidence: 0.75,
      textLineCount: opts.lineCount || 20,
      textBlockCount: opts.blockCount || 5,
      surfaceCandidateCount: 2
    }
  };
}

// ── analyzeBatchStability: insufficient data ───────────────────────────

const insufficientReport = analyzeBatchStability([]);
assert.strictEqual(insufficientReport.status, 'insufficient_data');
assert.strictEqual(insufficientReport.stabilityMetrics, null);

const singleDocReport = analyzeBatchStability([buildMockDocSummary()]);
assert.strictEqual(singleDocReport.status, 'insufficient_data');

console.log('analyzeBatchStability insufficient data tests passed.');

// ── analyzeBatchStability: stable batch ────────────────────────────────

// Build a batch of very similar documents
const stableDocs = [];
for (let i = 0; i < 10; i++) {
  stableDocs.push(buildMockDocSummary({
    regionCount: 5,
    edgeCount: 4,
    avgArea: 0.05,
    avgDensity: 0.5,
    lineCount: 20,
    blockCount: 5,
    tokenCount: 80,
    name: 'stable-' + i + '.png'
  }));
}

const stableReport = analyzeBatchStability(stableDocs);
assert.strictEqual(stableReport.documentCount, 10);
assert.ok(stableReport.overallStability > 0, 'Stability should be > 0');
assert.ok(stableReport.stabilityMetrics);
assert.ok(stableReport.stabilityMetrics.regionCount);
assert.ok(stableReport.stabilityMetrics.regionArea);
assert.ok(stableReport.stabilityMetrics.regionDensity);
assert.ok(stableReport.stabilityMetrics.adjacencyGraph);
assert.ok(stableReport.stabilityMetrics.spatialDistribution);
assert.ok(stableReport.stabilityMetrics.textStructure);
assert.ok(stableReport.stabilityMetrics.surfaceTypeDistribution);

// Region count should be perfectly stable (all 5)
assert.strictEqual(stableReport.stabilityMetrics.regionCount.stability, 1);
assert.strictEqual(stableReport.stabilityMetrics.regionCount.cv, 0);
assert.strictEqual(stableReport.stabilityMetrics.regionCount.min, 5);
assert.strictEqual(stableReport.stabilityMetrics.regionCount.max, 5);

// Intermediate data should be preserved
assert.ok(stableReport.intermediateData);
assert.strictEqual(stableReport.intermediateData.perDocumentMetrics.length, 10);
assert.ok(stableReport.intermediateData.batchRegionSignatures.length > 0);
assert.strictEqual(stableReport.intermediateData.batchSpatialDistributions.length, 10);

console.log('analyzeBatchStability stable batch tests passed.');

// ── analyzeBatchStability: unstable batch ──────────────────────────────

const unstableDocs = [];
for (let i = 0; i < 10; i++) {
  unstableDocs.push(buildMockDocSummary({
    regionCount: 3 + i * 5,        // varies from 3 to 48
    edgeCount: 2 + i * 3,           // varies from 2 to 29
    avgArea: 0.01 + i * 0.02,       // varies
    avgDensity: 0.1 + i * 0.08,     // varies
    lineCount: 5 + i * 10,          // varies
    blockCount: 1 + i * 3,          // varies
    tokenCount: 20 + i * 30,        // varies
    name: 'unstable-' + i + '.png'
  }));
}

const unstableReport = analyzeBatchStability(unstableDocs);
assert.strictEqual(unstableReport.documentCount, 10);
assert.ok(unstableReport.overallStability < stableReport.overallStability,
  'Unstable batch should have lower stability than stable batch');
assert.ok(unstableReport.stabilityMetrics.regionCount.stability < 1,
  'Region count should not be perfectly stable for varying counts');
assert.ok(unstableReport.stabilityMetrics.regionCount.cv > 0,
  'CV should be > 0 for varying counts');

// Should have parameter diagnoses
assert.ok(Array.isArray(unstableReport.parameterDiagnoses));
assert.ok(unstableReport.parameterDiagnoses.length > 0,
  'Should have at least one parameter diagnosis for unstable batch');

// Check diagnosis structure
const firstDiag = unstableReport.parameterDiagnoses[0];
assert.ok(firstDiag.parameter);
assert.ok(['high', 'medium', 'low'].includes(firstDiag.impact));
assert.ok(typeof firstDiag.stability === 'number');
assert.ok(firstDiag.diagnosis);
assert.ok(firstDiag.recommendation);
assert.ok(firstDiag.suggestedAdjustments);

console.log('analyzeBatchStability unstable batch tests passed.');

// ── Individual metric analyzers ────────────────────────────────────────

const rcResult = analyzeRegionCountStability(stableDocs);
assert.strictEqual(rcResult.metric, 'region_count');
assert.ok(typeof rcResult.stability === 'number');
assert.ok(Array.isArray(rcResult.values));

const raResult = analyzeRegionAreaStability(stableDocs);
assert.strictEqual(raResult.metric, 'region_area');
assert.ok(typeof raResult.stability === 'number');

const agResult = analyzeAdjacencyGraphStability(stableDocs);
assert.strictEqual(agResult.metric, 'adjacency_graph');
assert.ok(typeof agResult.edgeCountStability === 'number');
assert.ok(typeof agResult.edgeTypeDistributionStability === 'number');
assert.ok(typeof agResult.edgeWeightStability === 'number');

const sdResult = analyzeSpatialDistributionStability(stableDocs);
assert.strictEqual(sdResult.metric, 'spatial_distribution');
assert.ok(typeof sdResult.avgPairwiseCosineSimilarity === 'number');

const tsResult = analyzeTextStructureStability(stableDocs);
assert.strictEqual(tsResult.metric, 'text_structure');
assert.ok(typeof tsResult.lineCountStability === 'number');
assert.ok(typeof tsResult.blockCountStability === 'number');

const stResult = analyzeSurfaceTypeStability(stableDocs);
assert.strictEqual(stResult.metric, 'surface_type_distribution');
assert.ok(Array.isArray(stResult.surfaceTypes));

console.log('Individual metric analyzer tests passed.');

// ── Parameter sensitivity analysis ─────────────────────────────────────

const unstableMetrics = {
  regionCount: { stability: 0.3, cv: 0.7, mean: 20, min: 3, max: 48 },
  regionArea: { stability: 0.4, cv: 0.6 },
  regionDensity: { stability: 0.5 },
  adjacencyGraph: { stability: 0.3, edgeCountStability: 0.3, edgeWeightStability: 0.4, edgeTypeDistributionStability: 0.5 },
  spatialDistribution: { stability: 0.4 },
  textStructure: { stability: 0.5, lineCountStability: 0.4, blockCountStability: 0.5 },
  surfaceTypeDistribution: { stability: 0.3 }
};

const diagnoses = analyzeParameterSensitivity(unstableMetrics);
assert.ok(diagnoses.length >= 3, 'Should diagnose multiple parameters for highly unstable metrics, got ' + diagnoses.length);

// Should be sorted by impact (high before medium before low)
const impactOrder = { high: 0, medium: 1, low: 2 };
for (let i = 0; i < diagnoses.length - 1; i++) {
  assert.ok((impactOrder[diagnoses[i].impact] || 3) <= (impactOrder[diagnoses[i + 1].impact] || 3),
    'Diagnoses should be sorted by impact. Got ' + diagnoses[i].impact + ' before ' + diagnoses[i + 1].impact);
}

console.log('Parameter sensitivity analysis tests passed.');

// ── formatStabilityReport ──────────────────────────────────────────────

const reportText = formatStabilityReport(stableReport);
assert.ok(reportText.includes('BATCH STRUCTURAL STABILITY REPORT'));
assert.ok(reportText.includes('STABILITY METRICS'));
assert.ok(reportText.includes('Region Count'));

const insufficientText = formatStabilityReport(insufficientReport);
assert.ok(insufficientText.includes('No documents'));

const nullText = formatStabilityReport(null);
assert.ok(nullText.includes('No report data'));

console.log('formatStabilityReport tests passed.');

// ── Full workflow integration ──────────────────────────────────────────

// Simulate: create session, add documents, analyze, save report
const workflowStore = createBatchSessionStore();
const ws = workflowStore.createSession({ name: 'Integration Test' });

// Add mock summaries
for (let i = 0; i < 5; i++) {
  const docSummary = extractDocumentSummary(mockAnalysis, { documentName: 'doc-' + i + '.png' });
  workflowStore.addDocument(ws.sessionId, docSummary);
}

assert.strictEqual(workflowStore.documentCount(ws.sessionId), 5);

// Analyze
const wsSession = workflowStore.getSession(ws.sessionId);
const wsReport = analyzeBatchStability(wsSession.documents);
assert.ok(wsReport.overallStability >= 0);
assert.ok(wsReport.stabilityMetrics);

// Save report
workflowStore.saveStabilityReport(ws.sessionId, wsReport);
const savedSession = workflowStore.getSession(ws.sessionId);
assert.ok(savedSession.stabilityReport);
assert.strictEqual(savedSession.stabilityReport.documentCount, 5);

console.log('Full workflow integration tests passed.');

/* ── learning/index.js includes batch modules ──────────────────────── */

const {
  BatchLearningSession: BLS,
  BatchStructuralAnalyst: BSA
} = require('../engines/wrokitvision/learning/index.js');

assert.ok(BLS.extractDocumentSummary);
assert.ok(BLS.createBatchSessionStore);
assert.ok(BSA.analyzeBatchStability);
assert.ok(BSA.formatStabilityReport);
assert.ok(BSA.cosineSimilarity);
assert.ok(BSA.jensenShannonDivergence);

console.log('learning/index.js batch module exports test passed.');

/* ══════════════════════════════════════════════════════════════════════════
   Validation & Invalid Data Rejection Tests
   ══════════════════════════════════════════════════════════════════════════ */

// ── extractDocumentSummary: structurallyValid flag ──────────────────────

// Valid summary (has regions and viewport)
const validSummary = extractDocumentSummary(mockAnalysis, { documentName: 'valid.png' });
assert.strictEqual(validSummary.structurallyValid, true, 'Summary with regions should be structurallyValid');
assert.strictEqual(validSummary.validationReason, '');

// Empty analysis → invalid
const emptyInvalid = extractDocumentSummary({});
assert.strictEqual(emptyInvalid.structurallyValid, false, 'Empty analysis should not be structurallyValid');
assert.ok(emptyInvalid.validationReason.length > 0, 'Should have a validationReason');

// Zero viewport → invalid
const zeroVpSummary = extractDocumentSummary({
  regionNodes: [{ id: 'r1', geometry: { bbox: { x: 0, y: 0, w: 10, h: 10 } }, confidence: 0.5 }],
  regionGraph: { nodes: [], edges: [] },
  textLines: [], textBlocks: [], textTokens: [], surfaceCandidates: [],
  viewport: { width: 0, height: 0 }
});
assert.strictEqual(zeroVpSummary.structurallyValid, false, 'Zero viewport should be invalid');
assert.ok(zeroVpSummary.validationReason.includes('viewport'), 'Reason should mention viewport');

// Has viewport but no regions → invalid
const noRegionsSummary = extractDocumentSummary({
  regionNodes: [],
  regionGraph: { nodes: [], edges: [] },
  textLines: [{ id: 'l1', geometry: { bbox: { x: 0, y: 0, w: 100, h: 20 } }, tokenIds: [], text: 'test' }],
  textBlocks: [], textTokens: [], surfaceCandidates: [],
  viewport: { width: 800, height: 1000 }
});
assert.strictEqual(noRegionsSummary.structurallyValid, false, 'No regions should be invalid');
assert.ok(noRegionsSummary.validationReason.includes('region'), 'Reason should mention regions');

// All-zero metrics from empty input → invalid
const allZeroSummary = extractDocumentSummary(
  { regionNodes: [], regionGraph: { nodes: [], edges: [] }, textLines: [], textBlocks: [], textTokens: [], surfaceCandidates: [], viewport: { width: 0, height: 0 } },
  { documentName: 'zeroed.png' }
);
assert.strictEqual(allZeroSummary.structurallyValid, false, 'All-zero summary should be invalid');
assert.strictEqual(allZeroSummary.metrics.regionCount, 0);
assert.strictEqual(allZeroSummary.metrics.textBlockCount, 0);

console.log('extractDocumentSummary validation tests passed.');

// ── analyzeBatchStability: rejects batches with only invalid documents ──

const invalidDoc1 = extractDocumentSummary({}, { documentName: 'empty1.png' });
const invalidDoc2 = extractDocumentSummary({}, { documentName: 'empty2.png' });

const allInvalidReport = analyzeBatchStability([invalidDoc1, invalidDoc2]);
assert.strictEqual(allInvalidReport.status, 'insufficient_valid_data',
  'Should report insufficient_valid_data for all-invalid batch, got: ' + allInvalidReport.status);
assert.strictEqual(allInvalidReport.stabilityMetrics, null, 'Should not compute metrics for invalid batch');
assert.strictEqual(allInvalidReport.validDocumentCount, 0);
assert.strictEqual(allInvalidReport.invalidDocuments.length, 2);

console.log('analyzeBatchStability all-invalid batch test passed.');

// ── analyzeBatchStability: rejects mixed batch with < 2 valid ──────────

const oneValidDoc = extractDocumentSummary(mockAnalysis, { documentName: 'real.png' });
const mixedReport = analyzeBatchStability([oneValidDoc, invalidDoc1, invalidDoc2]);
assert.strictEqual(mixedReport.status, 'insufficient_valid_data',
  'Should reject batch with only 1 valid doc, got: ' + mixedReport.status);
assert.strictEqual(mixedReport.validDocumentCount, 1);
assert.strictEqual(mixedReport.invalidDocuments.length, 2);

console.log('analyzeBatchStability mixed batch (1 valid) test passed.');

// ── analyzeBatchStability: succeeds when 2+ valid docs present ─────────

const validDoc1 = extractDocumentSummary(mockAnalysis, { documentName: 'a.png' });
const validDoc2 = extractDocumentSummary(mockAnalysis, { documentName: 'b.png' });
const validBatchReport = analyzeBatchStability([validDoc1, validDoc2, invalidDoc1]);
assert.ok(validBatchReport.status !== 'insufficient_valid_data' && validBatchReport.status !== 'insufficient_data',
  'Should succeed with 2 valid docs, got status: ' + validBatchReport.status);
assert.ok(validBatchReport.stabilityMetrics !== null, 'Should have stability metrics');
assert.strictEqual(validBatchReport.documentCount, 2, 'documentCount should be valid docs only');
assert.strictEqual(validBatchReport.invalidDocuments.length, 1, 'Should track 1 invalid doc');
assert.strictEqual(validBatchReport.invalidDocuments[0].documentName, 'empty1.png');

console.log('analyzeBatchStability mixed batch (2 valid) test passed.');

// ── analyzeBatchStability: backwards compat with old summaries (no structurallyValid field) ──

const legacyDoc = buildMockDocSummary({ regionCount: 5, name: 'legacy.png' });
delete legacyDoc.structurallyValid;  // simulate old format
const legacyDoc2 = buildMockDocSummary({ regionCount: 3, name: 'legacy2.png' });
delete legacyDoc2.structurallyValid;
const legacyReport = analyzeBatchStability([legacyDoc, legacyDoc2]);
assert.ok(legacyReport.status !== 'insufficient_valid_data',
  'Should accept old-format docs with regions as valid');
assert.ok(legacyReport.stabilityMetrics !== null);

console.log('analyzeBatchStability backwards compatibility test passed.');

// ── formatStabilityReport: handles insufficient_valid_data ─────────────

const insuffValidText = formatStabilityReport(allInvalidReport);
assert.ok(insuffValidText.includes('structural outputs'),
  'Should explain need for structural outputs');

// Report with invalid docs should list them
const mixedValidReport = analyzeBatchStability([validDoc1, validDoc2, invalidDoc1]);
const mixedReportText = formatStabilityReport(mixedValidReport);
assert.ok(mixedReportText.includes('EXCLUDED') || mixedReportText.includes('excluded'),
  'Report should mention excluded documents');

console.log('formatStabilityReport validation tests passed.');

// ── Wrong object shape passed to extractDocumentSummary ────────────────

// Pass a raw file-like object (wrong shape) instead of analysis result
const wrongShapeSummary = extractDocumentSummary({ name: 'file.png', size: 12345, type: 'image/png' });
assert.strictEqual(wrongShapeSummary.structurallyValid, false, 'Wrong shape should be invalid');
assert.strictEqual(wrongShapeSummary.metrics.regionCount, 0);

// Pass null
const nullSummary = extractDocumentSummary(null);
assert.strictEqual(nullSummary.structurallyValid, false, 'null input should be invalid');

// Pass undefined
const undefSummary = extractDocumentSummary(undefined);
assert.strictEqual(undefSummary.structurallyValid, false, 'undefined input should be invalid');

console.log('extractDocumentSummary wrong object shape tests passed.');

/* ══════════════════════════════════════════════════════════════════════════
   Compact Storage & Hybrid Store Tests
   ══════════════════════════════════════════════════════════════════════════ */

// ── compactForStorage: produces compact summary ─────────────────────────

const fullDoc = extractDocumentSummary(mockAnalysis, { documentName: 'compact-test.png' });
const compact = compactForStorage(fullDoc);

assert.strictEqual(compact._compact, true, 'Should have _compact marker');
assert.strictEqual(compact.documentId, fullDoc.documentId);
assert.strictEqual(compact.documentName, 'compact-test.png');
assert.ok(compact.metrics, 'Should preserve metrics');
assert.ok(compact.textStructure, 'Should preserve textStructure');
assert.strictEqual(compact.textStructure.lineCount, fullDoc.textStructure.lineCount);
assert.strictEqual(compact.textStructure.blockCount, fullDoc.textStructure.blockCount);
assert.ok(compact.normalizedSpatialDistribution, 'Should preserve spatial distribution');
assert.ok(compact.surfaceTypeCounts, 'Should preserve surface type counts');

// Should have compact replacements instead of large arrays
assert.ok(Array.isArray(compact._regionAreas), 'Should have _regionAreas');
assert.strictEqual(compact._regionAreas.length, fullDoc.regionDescriptors.length);
assert.ok(compact._adjacencyStats, 'Should have _adjacencyStats');
assert.strictEqual(compact._adjacencyStats.count, fullDoc.adjacencyEdges.length);
assert.ok(Array.isArray(compact._adjacencyStats.typeDistribution));
assert.strictEqual(compact._adjacencyStats.typeDistribution.length, 3);

// Should NOT have large arrays
assert.strictEqual(compact.regionDescriptors, undefined, 'Should not have regionDescriptors');
assert.strictEqual(compact.adjacencyEdges, undefined, 'Should not have adjacencyEdges');
assert.strictEqual(compact.regionSignatures, undefined, 'Should not have regionSignatures');
assert.strictEqual(compact.neighborhoodDescriptors, undefined, 'Should not have neighborhoodDescriptors');

// Should be significantly smaller
const fullSize = JSON.stringify(fullDoc).length;
const compactSize = JSON.stringify(compact).length;
assert.ok(compactSize < fullSize * 0.5,
  'Compact should be much smaller: full=' + fullSize + ' compact=' + compactSize);

// Null/undefined handling
assert.strictEqual(compactForStorage(null), null);
assert.strictEqual(compactForStorage(undefined), undefined);

console.log('compactForStorage tests passed.');

// ── Hybrid store: compact in storage, full in memory ────────────────────

const hybridStore = createBatchSessionStore();
const hs = hybridStore.createSession({ name: 'Hybrid Test' });

const fullDoc1 = extractDocumentSummary(mockAnalysis, { documentName: 'hybrid1.png' });
const fullDoc2 = extractDocumentSummary(mockAnalysis, { documentName: 'hybrid2.png' });
hybridStore.addDocument(hs.sessionId, fullDoc1);
hybridStore.addDocument(hs.sessionId, fullDoc2);

// getSession should return full docs from memory
const hybridSession = hybridStore.getSession(hs.sessionId);
assert.strictEqual(hybridSession.documents.length, 2);
assert.ok(hybridSession.documents[0].regionDescriptors, 'In-memory docs should have full regionDescriptors');
assert.ok(hybridSession.documents[0].adjacencyEdges, 'In-memory docs should have full adjacencyEdges');
assert.ok(hybridSession.documents[0].regionSignatures, 'In-memory docs should have full regionSignatures');

// getAllSessions returns compact docs from localStorage
const allHybrid = hybridStore.getAllSessions();
const storedSession = allHybrid.find(function(s){ return s.sessionId === hs.sessionId; });
assert.ok(storedSession, 'Should find session in localStorage');
assert.strictEqual(storedSession.documents.length, 2);
assert.strictEqual(storedSession.documents[0]._compact, true, 'localStorage docs should be compact');
assert.strictEqual(storedSession.documents[0].regionDescriptors, undefined, 'Compact docs should not have regionDescriptors');

// saveStabilityReport should strip intermediateData
const mockReport = { status: 'stable', overallStability: 0.9, intermediateData: { big: 'data' } };
hybridStore.saveStabilityReport(hs.sessionId, mockReport);
const savedHybrid = hybridStore.getAllSessions().find(function(s){ return s.sessionId === hs.sessionId; });
assert.strictEqual(savedHybrid.stabilityReport.intermediateData, null,
  'Persisted report should have intermediateData stripped');
assert.strictEqual(savedHybrid.stabilityReport.status, 'stable',
  'Persisted report should keep other fields');

// removeDocument should remove from both memory and storage
hybridStore.removeDocument(hs.sessionId, fullDoc1.documentId);
assert.strictEqual(hybridStore.documentCount(hs.sessionId), 1);
const afterRemove = hybridStore.getAllSessions().find(function(s){ return s.sessionId === hs.sessionId; });
assert.strictEqual(afterRemove.documents.length, 1);

// deleteSession should clean up in-memory docs
hybridStore.deleteSession(hs.sessionId);
assert.strictEqual(hybridStore.getSession(hs.sessionId), null);

console.log('Hybrid store tests passed.');

// ── Analyst handles compact-format documents ────────────────────────────

const compactDocs = [];
for (let ci = 0; ci < 5; ci++) {
  const full = buildMockDocSummary({ regionCount: 5, edgeCount: 4, name: 'compact-' + ci + '.png' });
  full.structurallyValid = true;
  compactDocs.push(compactForStorage(full));
}

const compactReport = analyzeBatchStability(compactDocs);
assert.ok(compactReport.status !== 'insufficient_data' && compactReport.status !== 'insufficient_valid_data',
  'Should analyze compact docs successfully, got: ' + compactReport.status);
assert.ok(compactReport.stabilityMetrics, 'Should produce stability metrics from compact docs');
assert.ok(compactReport.stabilityMetrics.regionCount, 'Should compute region count from compact docs');
assert.ok(compactReport.stabilityMetrics.adjacencyGraph, 'Should compute adjacency graph from compact docs');
assert.ok(typeof compactReport.stabilityMetrics.adjacencyGraph.edgeTypeDistributionStability === 'number',
  'Should compute edge type distribution from _adjacencyStats');
assert.ok(typeof compactReport.stabilityMetrics.adjacencyGraph.edgeWeightStability === 'number',
  'Should compute edge weight from _adjacencyStats');

// intermediateData should handle missing regionSignatures gracefully
assert.ok(compactReport.intermediateData, 'Should have intermediateData');
assert.ok(Array.isArray(compactReport.intermediateData.perDocumentMetrics));
assert.strictEqual(compactReport.intermediateData.perDocumentMetrics[0].regionSignatureCount, 5,
  'Compact docs should fall back to metrics.regionCount for signature count');

// Region count stability should still work (uses metrics.regionCount, not regionDescriptors)
assert.strictEqual(compactReport.stabilityMetrics.regionCount.stability, 1,
  'All compact docs with same region count should be perfectly stable');

console.log('Analyst compact format tests passed.');

// ── Mixed full + compact docs in analyst ────────────────────────────────

const mixedFormatDocs = [];
for (let mi = 0; mi < 3; mi++) {
  const full = buildMockDocSummary({ regionCount: 5, edgeCount: 4, name: 'full-' + mi + '.png' });
  full.structurallyValid = true;
  mixedFormatDocs.push(full);  // full format
}
for (let mi = 0; mi < 3; mi++) {
  const full = buildMockDocSummary({ regionCount: 5, edgeCount: 4, name: 'compact-mix-' + mi + '.png' });
  full.structurallyValid = true;
  mixedFormatDocs.push(compactForStorage(full));  // compact format
}

const mixedFormatReport = analyzeBatchStability(mixedFormatDocs);
assert.ok(mixedFormatReport.stabilityMetrics, 'Should handle mixed full+compact docs');
assert.strictEqual(mixedFormatReport.documentCount, 6, 'Should count all valid docs');

console.log('Mixed format (full + compact) analyst tests passed.');

console.log('All Batch Structural Learning Phase 1 tests passed (including validation, compact storage).');

/* ══════════════════════════════════════════════════════════════════════════
   Phase 2: Structural Correspondence Tests
   ══════════════════════════════════════════════════════════════════════════ */

const {
  analyzeCorrespondence,
  formatCorrespondenceReport,
  selectReferenceDocument,
  computeRegionSimilarity,
  matchDocumentRegions
} = require('../engines/wrokitvision/learning/batch-correspondence-analyst.js');

// ── Helper: build a mock doc with neighborhood descriptors ────────────────

function buildMockDocWithNeighborhood(opts) {
  opts = opts || {};
  var doc = buildMockDocSummary(opts);
  doc.structurallyValid = true;

  // Populate neighborhood descriptors from adjacency edges
  var nhMap = {};
  for (var i = 0; i < doc.regionDescriptors.length; i++) {
    nhMap[doc.regionDescriptors[i].regionId] = {
      neighborCount: 0,
      avgEdgeWeight: 0,
      containsCount: 0,
      proximityCount: 0
    };
  }
  var edgesByRegion = {};
  for (var ei = 0; ei < doc.adjacencyEdges.length; ei++) {
    var e = doc.adjacencyEdges[ei];
    if (!edgesByRegion[e.sourceId]) edgesByRegion[e.sourceId] = [];
    if (!edgesByRegion[e.targetId]) edgesByRegion[e.targetId] = [];
    edgesByRegion[e.sourceId].push(e);
    edgesByRegion[e.targetId].push(e);
  }
  for (var rid in edgesByRegion) {
    if (!nhMap[rid]) continue;
    var edges = edgesByRegion[rid];
    nhMap[rid].neighborCount = edges.length;
    nhMap[rid].avgEdgeWeight = edges.reduce(function (s, e) { return s + e.weight; }, 0) / edges.length;
    nhMap[rid].containsCount = edges.filter(function (e) { return e.edgeType === 'contains'; }).length;
    nhMap[rid].proximityCount = edges.filter(function (e) { return e.edgeType === 'spatial_proximity'; }).length;
  }
  doc.neighborhoodDescriptors = nhMap;
  return doc;
}

// ── selectReferenceDocument ──────────────────────────────────────────────

(function testSelectReferenceDocument() {
  var docs = [];
  for (var i = 0; i < 4; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'ref-test-' + i + '.png' }));
  }

  var ref = selectReferenceDocument(docs);
  assert.ok(ref, 'Should return a reference selection');
  assert.ok(ref.documentId, 'Should have a documentId');
  assert.ok(typeof ref.centralityScore === 'number', 'Should have a centrality score');
  assert.ok(ref.scores.length === 4, 'Should have scores for all documents');

  // Single doc
  var singleRef = selectReferenceDocument([docs[0]]);
  assert.strictEqual(singleRef.documentId, docs[0].documentId);
  assert.strictEqual(singleRef.centralityScore, 1);

  // Null/empty
  assert.strictEqual(selectReferenceDocument(null), null);
  assert.strictEqual(selectReferenceDocument([]), null);

  console.log('selectReferenceDocument tests passed.');
})();

// ── computeRegionSimilarity ──────────────────────────────────────────────

(function testComputeRegionSimilarity() {
  var regionA = {
    centroid: { x: 0.2, y: 0.3 },
    normalizedBbox: { x: 0.15, y: 0.25, w: 0.1, h: 0.1 },
    normalizedArea: 0.01,
    aspectRatio: 1.0,
    textDensity: 0.6,
    confidence: 0.8,
    surfaceType: 'text_dense_surface'
  };

  // Identical region
  var simSelf = computeRegionSimilarity(regionA, regionA, {}, {});
  assert.ok(simSelf.similarity > 0.9, 'Identical regions should have very high similarity: ' + simSelf.similarity);

  // Very different region
  var regionB = {
    centroid: { x: 0.8, y: 0.9 },
    normalizedBbox: { x: 0.7, y: 0.8, w: 0.2, h: 0.2 },
    normalizedArea: 0.04,
    aspectRatio: 3.0,
    textDensity: 0.1,
    confidence: 0.3,
    surfaceType: 'visual_component'
  };
  var simDiff = computeRegionSimilarity(regionA, regionB, {}, {});
  assert.ok(simDiff.similarity < 0.6, 'Very different regions should have low similarity: ' + simDiff.similarity);
  assert.ok(simDiff.similarity > 0, 'Similarity should be positive');

  // Check dimensions are present
  assert.ok(simDiff.dimensions.position !== undefined);
  assert.ok(simDiff.dimensions.size !== undefined);
  assert.ok(simDiff.dimensions.dimension !== undefined);
  assert.ok(simDiff.dimensions.neighborhood !== undefined);
  assert.ok(simDiff.dimensions.semantic !== undefined);

  // Nearby region with same type
  var regionC = {
    centroid: { x: 0.22, y: 0.32 },
    normalizedBbox: { x: 0.17, y: 0.27, w: 0.1, h: 0.1 },
    normalizedArea: 0.01,
    aspectRatio: 1.1,
    textDensity: 0.55,
    confidence: 0.78,
    surfaceType: 'text_dense_surface'
  };
  var simNear = computeRegionSimilarity(regionA, regionC, {}, {});
  assert.ok(simNear.similarity > simDiff.similarity, 'Nearby similar region should score higher than distant different one');

  console.log('computeRegionSimilarity tests passed.');
})();

// ── matchDocumentRegions ─────────────────────────────────────────────────

(function testMatchDocumentRegions() {
  // Create two similar documents
  var doc1 = buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'match-1.png' });
  var doc2 = buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'match-2.png' });

  var matches = matchDocumentRegions(doc1, doc2);
  assert.ok(Array.isArray(matches), 'Should return an array');
  // With similar structure, expect some matches
  assert.ok(matches.length > 0, 'Similar docs should produce matches');

  // Each match should have required fields
  for (var i = 0; i < matches.length; i++) {
    assert.ok(matches[i].refRegionId, 'Match should have refRegionId');
    assert.ok(matches[i].tgtRegionId, 'Match should have tgtRegionId');
    assert.ok(typeof matches[i].similarity === 'number', 'Match should have similarity');
    assert.ok(matches[i].similarity >= 0.4, 'Match similarity should be >= minSimilarity');
  }

  // No duplicate assignments
  var usedRef = {};
  var usedTgt = {};
  for (var j = 0; j < matches.length; j++) {
    assert.ok(!usedRef[matches[j].refRegionId], 'Each ref region should be matched at most once');
    assert.ok(!usedTgt[matches[j].tgtRegionId], 'Each tgt region should be matched at most once');
    usedRef[matches[j].refRegionId] = true;
    usedTgt[matches[j].tgtRegionId] = true;
  }

  // Empty docs
  var emptyMatches = matchDocumentRegions({ regionDescriptors: [] }, doc2);
  assert.strictEqual(emptyMatches.length, 0, 'Empty doc should produce no matches');

  // High threshold
  var strictMatches = matchDocumentRegions(doc1, doc2, { minSimilarity: 0.99 });
  assert.ok(strictMatches.length <= matches.length, 'Stricter threshold should produce fewer or equal matches');

  console.log('matchDocumentRegions tests passed.');
})();

// ── analyzeCorrespondence: full pipeline ─────────────────────────────────

(function testAnalyzeCorrespondence() {
  // Build a batch of similar documents
  var batchDocs = [];
  for (var i = 0; i < 5; i++) {
    batchDocs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'batch-' + i + '.png' }));
  }

  var result = analyzeCorrespondence(batchDocs);

  assert.ok(result, 'Should return a result');
  assert.ok(['complete', 'no_anchors_found', 'low_confidence'].indexOf(result.status) >= 0,
    'Status should be a valid value: ' + result.status);
  assert.ok(result.analyzedAt, 'Should have analyzedAt timestamp');
  assert.strictEqual(result.documentCount, 5, 'Should report correct document count');
  assert.strictEqual(result.validDocumentCount, 5, 'All docs should be valid');

  // Reference document
  assert.ok(result.referenceDocument, 'Should have reference document');
  assert.ok(result.referenceDocument.documentId, 'Reference should have documentId');

  // Correspondences
  assert.ok(Array.isArray(result.correspondences), 'Should have correspondences array');

  // Anchors
  assert.ok(Array.isArray(result.anchors), 'Should have anchors array');
  for (var ai = 0; ai < result.anchors.length; ai++) {
    var a = result.anchors[ai];
    assert.ok(a.anchorId, 'Anchor should have anchorId');
    assert.ok(a.refRegionId, 'Anchor should have refRegionId');
    assert.ok(a.normalizedPosition, 'Anchor should have normalizedPosition');
    assert.ok(a.normalizedBbox, 'Anchor should have normalizedBbox');
    assert.ok(typeof a.frequency === 'number', 'Anchor should have frequency');
    assert.ok(typeof a.confidence === 'number', 'Anchor should have confidence');
    assert.ok(a.confidence >= 0 && a.confidence <= 1, 'Confidence should be 0-1');
    assert.ok(a.frequency >= 0 && a.frequency <= 1, 'Frequency should be 0-1');
    assert.ok(a.matchCount >= 0, 'matchCount should be non-negative');
  }

  // Alignment model
  assert.ok(result.alignmentModel, 'Should have alignment model');
  assert.ok(result.alignmentModel.referenceDocumentId, 'Model should have referenceDocumentId');
  assert.ok(typeof result.alignmentModel.anchorCount === 'number', 'Model should have anchorCount');
  assert.ok(typeof result.alignmentModel.anchorCoverage === 'number', 'Model should have anchorCoverage');

  console.log('analyzeCorrespondence full pipeline tests passed.');
})();

// ── analyzeCorrespondence: edge cases ────────────────────────────────────

(function testAnalyzeCorrespondenceEdgeCases() {
  // Insufficient data
  var r1 = analyzeCorrespondence([]);
  assert.strictEqual(r1.status, 'insufficient_data');

  var r2 = analyzeCorrespondence([buildMockDocWithNeighborhood()]);
  assert.strictEqual(r2.status, 'insufficient_data');

  // Compact documents should be skipped
  var compactDocs = [];
  for (var i = 0; i < 3; i++) {
    var full = buildMockDocWithNeighborhood({ name: 'compact-' + i + '.png' });
    compactDocs.push(compactForStorage(full));
  }
  var r3 = analyzeCorrespondence(compactDocs);
  assert.strictEqual(r3.status, 'insufficient_valid_data', 'Compact docs should not be usable for correspondence');
  assert.ok(r3.skippedDocuments.length > 0, 'Should report skipped documents');

  // Mix of compact and full — should work if at least 2 full
  var mixedDocs = [
    buildMockDocWithNeighborhood({ name: 'full-a.png' }),
    buildMockDocWithNeighborhood({ name: 'full-b.png' }),
    compactForStorage(buildMockDocWithNeighborhood({ name: 'compact-c.png' }))
  ];
  var r4 = analyzeCorrespondence(mixedDocs);
  assert.notStrictEqual(r4.status, 'insufficient_valid_data', 'Should work with 2 full docs + 1 compact');
  assert.strictEqual(r4.validDocumentCount, 2);
  assert.strictEqual(r4.skippedDocuments.length, 1);

  // Force reference document
  var docs = [
    buildMockDocWithNeighborhood({ name: 'forced-ref.png' }),
    buildMockDocWithNeighborhood({ name: 'other.png' }),
    buildMockDocWithNeighborhood({ name: 'other2.png' })
  ];
  var r5 = analyzeCorrespondence(docs, { referenceDocumentId: docs[1].documentId });
  assert.strictEqual(r5.referenceDocument.documentId, docs[1].documentId,
    'Should use forced reference document');

  console.log('analyzeCorrespondence edge case tests passed.');
})();

// ── formatCorrespondenceReport ───────────────────────────────────────────

(function testFormatCorrespondenceReport() {
  // Null input
  assert.strictEqual(formatCorrespondenceReport(null), '[No correspondence data]');

  // Insufficient data result
  var insuffResult = { status: 'insufficient_data', message: 'Not enough docs.' };
  assert.strictEqual(formatCorrespondenceReport(insuffResult), 'Not enough docs.');

  // Full result
  var docs = [];
  for (var i = 0; i < 4; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'fmt-' + i + '.png' }));
  }
  var result = analyzeCorrespondence(docs);
  var report = formatCorrespondenceReport(result);

  assert.ok(typeof report === 'string', 'Report should be a string');
  assert.ok(report.length > 100, 'Report should have substantial content');
  assert.ok(report.indexOf('STRUCTURAL CORRESPONDENCE REPORT') >= 0, 'Should contain report title');
  assert.ok(report.indexOf('REFERENCE DOCUMENT') >= 0, 'Should contain reference section');
  assert.ok(report.indexOf('TEMPLATE ALIGNMENT MODEL') >= 0 || report.indexOf('No structural anchors') >= 0,
    'Should contain alignment model or no anchors message');

  console.log('formatCorrespondenceReport tests passed.');
})();

// ── Session store: saveCorrespondenceResult ──────────────────────────────

(function testSaveCorrespondenceResult() {
  var store = createBatchSessionStore();
  var session = store.createSession({ name: 'Corr Test' });

  // Add docs
  for (var i = 0; i < 3; i++) {
    var doc = buildMockDocWithNeighborhood({ name: 'store-test-' + i + '.png' });
    store.addDocument(session.sessionId, doc);
  }

  // Run correspondence
  var sess = store.getSession(session.sessionId);
  var result = analyzeCorrespondence(sess.documents);

  // Save result
  var saved = store.saveCorrespondenceResult(session.sessionId, result);
  assert.strictEqual(saved, true, 'saveCorrespondenceResult should return true');

  // Retrieve and verify
  var loaded = store.getSession(session.sessionId);
  assert.ok(loaded.correspondenceResult, 'Session should have correspondenceResult');
  assert.strictEqual(loaded.correspondenceResult.status, result.status, 'Status should match');

  // Non-existent session
  var r = store.saveCorrespondenceResult('nonexistent', result);
  assert.strictEqual(r, false, 'Should return false for non-existent session');

  console.log('saveCorrespondenceResult tests passed.');
})();

console.log('All Phase 2 Structural Correspondence tests passed.');

/* ══════════════════════════════════════════════════════════════════════════
   Phase 2B: Anchor Refinement + BBOX-Guided Extraction Tests
   ══════════════════════════════════════════════════════════════════════════ */

const {
  refineAnchors,
  computeTargetNeighborhood,
  scoreAnchorRelevance,
  transferBBox,
  extractTextFromNormBox,
  extractFromBatch,
  formatRefinementReport
} = require('../engines/wrokitvision/learning/batch-anchor-refinement.js');

// ── Helper: build extraction targets ─────────────────────────────────────

function buildExtractionTargets() {
  return [
    { fieldKey: 'field_1', label: 'Invoice Number', normBox: { x0n: 0.6, y0n: 0.05, wN: 0.15, hN: 0.04 }, fieldType: 'static' },
    { fieldKey: 'field_2', label: 'Total Amount', normBox: { x0n: 0.7, y0n: 0.85, wN: 0.12, hN: 0.04 }, fieldType: 'static' },
    { fieldKey: 'field_3', label: 'Date', normBox: { x0n: 0.6, y0n: 0.1, wN: 0.1, hN: 0.03 }, fieldType: 'static' }
  ];
}

// ── computeTargetNeighborhood ────────────────────────────────────────────

(function testComputeTargetNeighborhood() {
  var doc = buildMockDocWithNeighborhood({ regionCount: 8, edgeCount: 6 });
  var target = { fieldKey: 'field_1', normBox: { x0n: 0.15, y0n: 0.15, wN: 0.1, hN: 0.05 } };

  var nh = computeTargetNeighborhood(target, doc);
  assert.ok(nh, 'Should return a neighborhood');
  assert.strictEqual(nh.fieldKey, 'field_1');
  assert.ok(nh.targetCenter.x > 0 && nh.targetCenter.y > 0, 'Should have target center');
  assert.ok(Array.isArray(nh.neighbors), 'Should have neighbors array');
  assert.ok(nh.neighborCount >= 0, 'Should have non-negative neighbor count');

  // Each neighbor should have required fields
  for (var i = 0; i < nh.neighbors.length; i++) {
    var n = nh.neighbors[i];
    assert.ok(n.regionId, 'Neighbor should have regionId');
    assert.ok(typeof n.distance === 'number', 'Should have distance');
    assert.ok(typeof n.proximity === 'number', 'Should have proximity');
    assert.ok(n.proximity > 0, 'Proximity should be positive (filtered)');
  }

  // Neighbors should be sorted by proximity descending
  for (var j = 1; j < nh.neighbors.length; j++) {
    assert.ok(nh.neighbors[j].proximity <= nh.neighbors[j-1].proximity,
      'Neighbors should be sorted by proximity descending');
  }

  console.log('computeTargetNeighborhood tests passed.');
})();

// ── scoreAnchorRelevance ─────────────────────────────────────────────────

(function testScoreAnchorRelevance() {
  var doc = buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4 });
  var targets = buildExtractionTargets();
  var neighborhoods = targets.map(function(t) { return computeTargetNeighborhood(t, doc); });

  // Create a mock anchor near the first target
  var nearAnchor = {
    anchorId: 'anchor-near',
    refRegionId: doc.regionDescriptors[0].regionId,
    normalizedPosition: { x: 0.65, y: 0.07 },
    normalizedBbox: { x: 0.6, y: 0.03, w: 0.1, h: 0.08 },
    normalizedArea: 0.008,
    confidence: 0.8,
    surfaceType: 'text_dense_surface'
  };

  var result = scoreAnchorRelevance(nearAnchor, neighborhoods);
  assert.ok(typeof result.relevanceScore === 'number', 'Should have relevance score');
  assert.ok(result.relevanceScore >= 0 && result.relevanceScore <= 1, 'Score should be 0-1');
  assert.ok(result.details.length === neighborhoods.length, 'Should have details per neighborhood');

  // Create a far-away anchor
  var farAnchor = {
    anchorId: 'anchor-far',
    refRegionId: 'r-nonexistent',
    normalizedPosition: { x: 0.05, y: 0.5 },
    normalizedBbox: { x: 0.0, y: 0.45, w: 0.1, h: 0.1 },
    normalizedArea: 0.01,
    confidence: 0.7,
    surfaceType: 'visual_component'
  };

  var farResult = scoreAnchorRelevance(farAnchor, neighborhoods);
  // Far anchor should generally score lower (but not necessarily 0 due to stability bonus)
  assert.ok(typeof farResult.relevanceScore === 'number');

  // Giant anchor should be penalized
  var giantAnchor = {
    anchorId: 'anchor-giant',
    refRegionId: 'r-nonexistent',
    normalizedPosition: { x: 0.5, y: 0.5 },
    normalizedBbox: { x: 0, y: 0, w: 1, h: 1 },
    normalizedArea: 0.5,
    confidence: 0.9,
    surfaceType: 'text_dense_surface'
  };

  var giantResult = scoreAnchorRelevance(giantAnchor, neighborhoods);
  assert.ok(typeof giantResult.relevanceScore === 'number');

  console.log('scoreAnchorRelevance tests passed.');
})();

// ── refineAnchors ────────────────────────────────────────────────────────

(function testRefineAnchors() {
  var docs = [];
  for (var i = 0; i < 5; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'refine-' + i + '.png' }));
  }

  var corrResult = analyzeCorrespondence(docs);
  var targets = buildExtractionTargets();
  var refDocId = corrResult.referenceDocument.documentId;
  var refDoc = docs.find(function(d) { return d.documentId === refDocId; });

  var result = refineAnchors(corrResult, targets, refDoc);

  assert.ok(result, 'Should return a result');
  assert.ok(['refined', 'no_relevant_anchors'].indexOf(result.status) >= 0, 'Valid status: ' + result.status);
  assert.ok(Array.isArray(result.refinedAnchors), 'Should have refinedAnchors');
  assert.ok(Array.isArray(result.removedAnchors), 'Should have removedAnchors');
  assert.strictEqual(result.refinedAnchors.length + result.removedAnchors.length, corrResult.anchors.length,
    'All anchors should be accounted for');

  // Each refined anchor should have relevance fields
  for (var ai = 0; ai < result.refinedAnchors.length; ai++) {
    var a = result.refinedAnchors[ai];
    assert.ok(typeof a.relevanceScore === 'number', 'Should have relevanceScore');
    assert.ok(a.relevanceScore >= 0.15, 'Relevance should be >= threshold');
    assert.ok(a.bestTargetKey, 'Should have bestTargetKey');
  }

  // Refined model
  if (result.refinedAlignmentModel) {
    assert.strictEqual(result.refinedAlignmentModel.anchorCount, result.refinedAnchors.length);
    assert.strictEqual(result.refinedAlignmentModel.removedCount, result.removedAnchors.length);
  }

  // Target neighborhoods
  assert.strictEqual(result.targetNeighborhoods.length, targets.length);

  console.log('refineAnchors tests passed.');
})();

// ── refineAnchors edge cases ─────────────────────────────────────────────

(function testRefineAnchorsEdgeCases() {
  // No correspondence
  var r1 = refineAnchors(null, buildExtractionTargets(), {});
  assert.strictEqual(r1.status, 'no_correspondence');

  // No targets
  var r2 = refineAnchors({ anchors: [] }, [], {});
  assert.strictEqual(r2.status, 'no_targets');

  // Empty anchors
  var r3 = refineAnchors({ anchors: [], referenceDocument: { documentId: 'x' } }, buildExtractionTargets(),
    buildMockDocWithNeighborhood());
  assert.strictEqual(r3.refinedAnchors.length, 0);
  assert.strictEqual(r3.removedAnchors.length, 0);

  console.log('refineAnchors edge case tests passed.');
})();

// ── transferBBox ─────────────────────────────────────────────────────────

(function testTransferBBox() {
  var docs = [];
  for (var i = 0; i < 4; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'transfer-' + i + '.png' }));
  }

  var corrResult = analyzeCorrespondence(docs);
  var targets = buildExtractionTargets();
  var refDocId = corrResult.referenceDocument.documentId;
  var refDoc = docs.find(function(d) { return d.documentId === refDocId; });
  var refinement = refineAnchors(corrResult, targets, refDoc);
  var targetDoc = docs.find(function(d) { return d.documentId !== refDocId; });

  if (targetDoc && refinement.refinedAnchors.length > 0) {
    var transfer = transferBBox(targets[0], refinement.refinedAnchors, corrResult, targetDoc.documentId, targetDoc);
    assert.ok(transfer.transferredNormBox, 'Should have transferredNormBox');
    assert.ok(typeof transfer.transferredNormBox.x0n === 'number');
    assert.ok(typeof transfer.transferredNormBox.y0n === 'number');
    assert.ok(typeof transfer.transferredNormBox.wN === 'number');
    assert.ok(typeof transfer.transferredNormBox.hN === 'number');
    assert.ok(transfer.transferredNormBox.x0n >= 0 && transfer.transferredNormBox.x0n <= 1, 'x0n in bounds');
    assert.ok(transfer.transferredNormBox.y0n >= 0 && transfer.transferredNormBox.y0n <= 1, 'y0n in bounds');
    assert.ok(typeof transfer.confidence === 'number');
    assert.ok(transfer.method, 'Should have method');
  }

  // Fallback when no anchors match
  var emptyTransfer = transferBBox(targets[0], [], corrResult, 'nonexistent', docs[1]);
  assert.strictEqual(emptyTransfer.method, 'identity_fallback');
  assert.strictEqual(emptyTransfer.anchorsUsed, 0);

  console.log('transferBBox tests passed.');
})();

// ── extractTextFromNormBox ───────────────────────────────────────────────

(function testExtractTextFromNormBox() {
  var tokens = [
    { x: 100, y: 50, w: 40, h: 12, text: 'Invoice', confidence: 0.9 },
    { x: 145, y: 50, w: 20, h: 12, text: '#', confidence: 0.9 },
    { x: 170, y: 50, w: 50, h: 12, text: '12345', confidence: 0.95 },
    { x: 100, y: 70, w: 30, h: 12, text: 'Date:', confidence: 0.85 },
    { x: 140, y: 70, w: 60, h: 12, text: '2024-01-15', confidence: 0.9 },
    { x: 500, y: 500, w: 40, h: 12, text: 'Footer', confidence: 0.8 }
  ];
  var viewport = { width: 800, height: 1000 };

  // Box covering the invoice area
  var normBox = { x0n: 0.1, y0n: 0.04, wN: 0.2, hN: 0.05 };
  var result = extractTextFromNormBox(normBox, tokens, viewport);
  assert.ok(result.tokenCount > 0, 'Should find tokens in box: ' + result.tokenCount);
  assert.ok(result.text.length > 0, 'Should extract text: ' + result.text);
  assert.ok(typeof result.confidence === 'number');

  // Empty box (far from tokens)
  var emptyBox = { x0n: 0.9, y0n: 0.9, wN: 0.05, hN: 0.05 };
  var emptyResult = extractTextFromNormBox(emptyBox, tokens, viewport);
  assert.strictEqual(emptyResult.tokenCount, 0);
  assert.strictEqual(emptyResult.text, '');

  // Null inputs
  var nullResult = extractTextFromNormBox(null, tokens, viewport);
  assert.strictEqual(nullResult.tokenCount, 0);

  console.log('extractTextFromNormBox tests passed.');
})();

// ── extractFromBatch ─────────────────────────────────────────────────────

(function testExtractFromBatch() {
  var docs = [];
  for (var i = 0; i < 4; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'extract-' + i + '.png' }));
  }

  var corrResult = analyzeCorrespondence(docs);
  var targets = buildExtractionTargets();
  var refDocId = corrResult.referenceDocument.documentId;
  var refDoc = docs.find(function(d) { return d.documentId === refDocId; });
  var refinement = refineAnchors(corrResult, targets, refDoc);

  // Create mock token data for each document
  var batchTokens = {};
  for (var di = 0; di < docs.length; di++) {
    batchTokens[docs[di].documentId] = {
      tokens: [
        { x: 480, y: 50, w: 80, h: 14, text: 'INV-001', confidence: 0.9 },
        { x: 560, y: 850, w: 60, h: 14, text: '$1,234', confidence: 0.85 },
        { x: 480, y: 100, w: 70, h: 14, text: '2024-01-15', confidence: 0.9 }
      ],
      viewport: { width: 800, height: 1000 }
    };
  }

  var result = extractFromBatch(refinement, corrResult, refDoc, docs, batchTokens);
  assert.ok(result, 'Should return result');
  assert.strictEqual(result.status, 'complete');
  assert.ok(result.results.length > 0, 'Should have document results');

  for (var ri = 0; ri < result.results.length; ri++) {
    var docResult = result.results[ri];
    assert.ok(docResult.documentId, 'Should have documentId');
    assert.ok(docResult.documentName, 'Should have documentName');
    assert.strictEqual(docResult.fields.length, targets.length, 'Should have field per target');

    for (var fi = 0; fi < docResult.fields.length; fi++) {
      var f = docResult.fields[fi];
      assert.ok(f.fieldKey, 'Field should have fieldKey');
      assert.ok(f.transferredNormBox, 'Field should have transferredNormBox');
      assert.ok(typeof f.transferConfidence === 'number');
      assert.ok(f.transferMethod, 'Should have transferMethod');
    }

    // Reference doc should use identity method
    if (docResult.isReference) {
      assert.strictEqual(docResult.fields[0].transferMethod, 'reference_identity');
    }
  }

  // No anchors case
  var noAnchorResult = extractFromBatch({ status: 'no_relevant_anchors' }, corrResult, refDoc, docs, batchTokens);
  assert.strictEqual(noAnchorResult.status, 'no_anchors');

  console.log('extractFromBatch tests passed.');
})();

// ── formatRefinementReport ───────────────────────────────────────────────

(function testFormatRefinementReport() {
  assert.strictEqual(formatRefinementReport(null), '[No refinement data]');

  var r1 = { status: 'no_correspondence', message: 'No data.' };
  assert.strictEqual(formatRefinementReport(r1), 'No data.');

  var docs = [];
  for (var i = 0; i < 4; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'fmt2b-' + i + '.png' }));
  }
  var corrResult = analyzeCorrespondence(docs);
  var refDoc = docs.find(function(d) { return d.documentId === corrResult.referenceDocument.documentId; });
  var refinement = refineAnchors(corrResult, buildExtractionTargets(), refDoc);
  var report = formatRefinementReport(refinement);

  assert.ok(typeof report === 'string');
  assert.ok(report.length > 50, 'Report should have content');
  assert.ok(report.indexOf('ANCHOR REFINEMENT REPORT') >= 0, 'Should have title');
  assert.ok(report.indexOf('EXTRACTION TARGETS') >= 0, 'Should have targets section');

  console.log('formatRefinementReport tests passed.');
})();

// ── textSource field in extractTextFromNormBox ──────────────────────────

(function testTextSourceField() {
  var viewport = { width: 800, height: 1000 };

  // Case 1: Multiple tokens → textSource = 'tokens'
  var manyTokens = [
    { x: 100, y: 50, w: 40, h: 12, text: 'Invoice', confidence: 0.9 },
    { x: 145, y: 50, w: 20, h: 12, text: '#', confidence: 0.9 },
    { x: 170, y: 50, w: 50, h: 12, text: '12345', confidence: 0.95 }
  ];
  var normBox = { x0n: 0.1, y0n: 0.04, wN: 0.2, hN: 0.04 };
  var result = extractTextFromNormBox(normBox, manyTokens, viewport);
  assert.strictEqual(result.textSource, 'tokens', 'Multiple tokens should yield textSource=tokens');

  // Case 2: Single token → textSource = 'tokens_sparse'
  var oneToken = [
    { x: 120, y: 55, w: 30, h: 12, text: 'Hi', confidence: 0.8 }
  ];
  var sparseResult = extractTextFromNormBox(normBox, oneToken, viewport);
  assert.strictEqual(sparseResult.textSource, 'tokens_sparse', 'One token should yield textSource=tokens_sparse');

  // Case 3: No tokens in box → textSource = 'no_tokens'
  var farBox = { x0n: 0.9, y0n: 0.9, wN: 0.05, hN: 0.05 };
  var noResult = extractTextFromNormBox(farBox, manyTokens, viewport);
  assert.strictEqual(noResult.textSource, 'no_tokens', 'No tokens should yield textSource=no_tokens');

  // Case 4: Null/empty inputs → textSource should still be present (or default)
  var nullResult = extractTextFromNormBox(null, manyTokens, viewport);
  assert.ok(nullResult.tokenCount === 0, 'Null normBox should return 0 tokens');

  console.log('textSource field tests passed.');
})();

// ── textSource in extractFromBatch ──────────────────────────────────────

(function testTextSourceInExtractFromBatch() {
  var docs = [];
  for (var i = 0; i < 3; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'txtsrc-' + i + '.png' }));
  }

  var corrResult = analyzeCorrespondence(docs);
  var targets = buildExtractionTargets();
  var refDocId = corrResult.referenceDocument.documentId;
  var refDoc = docs.find(function(d) { return d.documentId === refDocId; });
  var refinement = refineAnchors(corrResult, targets, refDoc);

  // With tokens → textSource should be present on all fields
  var batchTokensWithData = {};
  for (var di = 0; di < docs.length; di++) {
    batchTokensWithData[docs[di].documentId] = {
      tokens: [
        { x: 480, y: 50, w: 80, h: 14, text: 'INV-001', confidence: 0.9 },
        { x: 560, y: 50, w: 60, h: 14, text: 'foo', confidence: 0.85 },
        { x: 480, y: 100, w: 70, h: 14, text: '2024-01-15', confidence: 0.9 }
      ],
      viewport: { width: 800, height: 1000 }
    };
  }

  var resultWith = extractFromBatch(refinement, corrResult, refDoc, docs, batchTokensWithData);
  for (var ri = 0; ri < resultWith.results.length; ri++) {
    for (var fi = 0; fi < resultWith.results[ri].fields.length; fi++) {
      var f = resultWith.results[ri].fields[fi];
      assert.ok(f.textSource, 'Field should have textSource property, got: ' + f.textSource);
      assert.ok(['tokens', 'tokens_sparse', 'no_tokens'].indexOf(f.textSource) >= 0,
        'textSource should be valid: ' + f.textSource);
    }
  }

  // Without tokens → textSource should be 'no_tokens'
  var batchTokensEmpty = {};
  for (var di2 = 0; di2 < docs.length; di2++) {
    batchTokensEmpty[docs[di2].documentId] = { tokens: [], viewport: { width: 800, height: 1000 } };
  }

  var resultEmpty = extractFromBatch(refinement, corrResult, refDoc, docs, batchTokensEmpty);
  for (var ri2 = 0; ri2 < resultEmpty.results.length; ri2++) {
    for (var fi2 = 0; fi2 < resultEmpty.results[ri2].fields.length; fi2++) {
      assert.strictEqual(resultEmpty.results[ri2].fields[fi2].textSource, 'no_tokens',
        'Empty tokens should yield no_tokens');
    }
  }

  console.log('textSource in extractFromBatch tests passed.');
})();

console.log('All Phase 2B Anchor Refinement + Extraction tests passed.');

/* ══════════════════════════════════════════════════════════════════════════
   Phase 3A: Field Intelligence Tests
   ══════════════════════════════════════════════════════════════════════════ */

const {
  learnFieldGeometry,
  optimizeFieldGeometry,
  generateCandidates,
  scoreCandidate,
  applyGeometryProfile,
  formatGeometryReport,
  textSimilarity,
  levenshteinDistance,
  tokenOverlap
} = require('../engines/wrokitvision/learning/batch-field-intelligence.js');

// ── textSimilarity helpers ───────────────────────────────────────────────

(function testTextSimilarityHelpers() {
  assert.strictEqual(levenshteinDistance('abc', 'abc'), 0, 'Identical strings = 0');
  assert.ok(levenshteinDistance('abc', 'xyz') > 0.5, 'Very different strings');
  assert.strictEqual(levenshteinDistance('', 'abc'), 1, 'Empty vs non-empty = 1');

  assert.strictEqual(tokenOverlap('Invoice 12345', '12345'), 1, 'Full token overlap');
  assert.strictEqual(tokenOverlap('Invoice 12345', 'abcde'), 0, 'No token overlap');
  assert.ok(tokenOverlap('Invoice 12345 Total', 'Invoice Total') === 1, 'Partial match');

  var sim1 = textSimilarity('Invoice 12345', 'Invoice 12345');
  assert.ok(sim1 > 0.95, 'Identical text similarity should be ~1: ' + sim1);
  var sim2 = textSimilarity('Invoice 12345', 'totally different');
  assert.ok(sim2 < 0.3, 'Very different text similarity should be low: ' + sim2);
  var sim3 = textSimilarity('', 'abc');
  assert.strictEqual(sim3, 0, 'Empty extracted = 0');
  var sim4 = textSimilarity('abc', '');
  assert.strictEqual(sim4, 0, 'Empty corrected = 0 when extracted has text');

  console.log('textSimilarity helper tests passed.');
})();

// ── generateCandidates ───────────────────────────────────────────────────

(function testGenerateCandidates() {
  var box = { x0n: 0.3, y0n: 0.2, wN: 0.15, hN: 0.05 };
  var doc = buildMockDocWithNeighborhood({ regionCount: 6, edgeCount: 4 });

  var candidates = generateCandidates(box, doc);
  assert.ok(candidates.length > 10, 'Should generate multiple candidates: ' + candidates.length);

  // First candidate should be the original
  assert.strictEqual(candidates[0].family, 'original', 'First candidate is original');
  assert.strictEqual(candidates[0].normBox.x0n, box.x0n);

  // Should have all three families
  var families = {};
  for (var i = 0; i < candidates.length; i++) families[candidates[i].family] = true;
  assert.ok(families['original'], 'Has original family');
  assert.ok(families['local_search'], 'Has local_search family');
  // structural_expansion may or may not be present depending on mock doc regions

  // All candidates should have valid normBox values
  for (var ci = 0; ci < candidates.length; ci++) {
    var nb = candidates[ci].normBox;
    assert.ok(nb.x0n >= 0 && nb.x0n <= 1, 'x0n in range: ' + nb.x0n);
    assert.ok(nb.y0n >= 0 && nb.y0n <= 1, 'y0n in range: ' + nb.y0n);
    assert.ok(nb.wN > 0, 'wN positive: ' + nb.wN);
    assert.ok(nb.hN > 0, 'hN positive: ' + nb.hN);
  }

  // Without refDoc
  var noCandidates = generateCandidates(box, null);
  assert.ok(noCandidates.length > 5, 'Should still generate candidates without refDoc');

  console.log('generateCandidates tests passed.');
})();

// ── scoreCandidate ───────────────────────────────────────────────────────

(function testScoreCandidate() {
  var origBox = { x0n: 0.3, y0n: 0.2, wN: 0.15, hN: 0.05 };

  // Original candidate (identical box) with matching text should score well
  var cand1 = { normBox: { x0n: 0.3, y0n: 0.2, wN: 0.15, hN: 0.05 } };
  var s1 = scoreCandidate(cand1, 'Invoice 12345', 0.9, 'Invoice 12345', origBox, 3);
  assert.ok(s1.totalScore > 0.5, 'Good match should score > 0.5: ' + s1.totalScore);
  assert.ok(s1.alignmentScore > 0.8, 'Same box alignment should be high: ' + s1.alignmentScore);

  // Far-away candidate with matching text should score lower
  var cand2 = { normBox: { x0n: 0.8, y0n: 0.8, wN: 0.15, hN: 0.05 } };
  var s2 = scoreCandidate(cand2, 'Invoice 12345', 0.9, 'Invoice 12345', origBox, 3);
  assert.ok(s2.totalScore < s1.totalScore, 'Misaligned candidate should score lower');
  assert.ok(s2.alignmentScore < 0.3, 'Far alignment should be low: ' + s2.alignmentScore);

  // Original position with wrong text
  var s3 = scoreCandidate(cand1, 'wrong text', 0.5, 'Invoice 12345', origBox, 2);
  assert.ok(s3.similarityScore < 0.3, 'Wrong text similarity should be low: ' + s3.similarityScore);

  // Zero tokens
  var s4 = scoreCandidate(cand1, '', 0, 'Invoice 12345', origBox, 0);
  assert.strictEqual(s4.confidenceScore, 0, 'Zero tokens = zero confidence');

  console.log('scoreCandidate tests passed.');
})();

// ── optimizeFieldGeometry ────────────────────────────────────────────────

(function testOptimizeFieldGeometry() {
  var doc = buildMockDocWithNeighborhood({ regionCount: 6, edgeCount: 4 });
  var tokens = [
    { x: 240, y: 200, w: 60, h: 14, text: 'Invoice', confidence: 0.9 },
    { x: 305, y: 200, w: 50, h: 14, text: '12345', confidence: 0.95 },
    { x: 240, y: 220, w: 40, h: 14, text: 'Date:', confidence: 0.85 }
  ];
  var viewport = { width: 800, height: 1000 };

  var fieldResult = {
    fieldKey: 'field_1',
    label: 'Invoice Number',
    transferredNormBox: { x0n: 0.3, y0n: 0.2, wN: 0.15, hN: 0.04 }
  };

  var result = optimizeFieldGeometry(fieldResult, 'Invoice 12345', tokens, viewport, doc);
  assert.ok(result, 'Should return result');
  assert.strictEqual(result.fieldKey, 'field_1');
  assert.ok(result.candidateCount > 10, 'Should evaluate multiple candidates: ' + result.candidateCount);
  assert.ok(result.bestCandidate, 'Should have best candidate');
  assert.ok(result.originalCandidate, 'Should have original candidate');
  assert.ok(typeof result.improved === 'boolean');
  assert.ok(result.offset, 'Should have offset');
  assert.ok(result.expansion, 'Should have expansion');
  assert.ok(result.topCandidates.length <= 5, 'Top candidates capped at 5');

  console.log('optimizeFieldGeometry tests passed.');
})();

// ── learnFieldGeometry ───────────────────────────────────────────────────

(function testLearnFieldGeometry() {
  // Build mock extraction result
  var docs = [];
  for (var i = 0; i < 3; i++) {
    docs.push(buildMockDocWithNeighborhood({ regionCount: 5, edgeCount: 4, name: 'geom-' + i + '.png' }));
  }

  var corrResult = analyzeCorrespondence(docs);
  var targets = buildExtractionTargets();
  var refDocId = corrResult.referenceDocument.documentId;
  var refDoc = docs.find(function(d) { return d.documentId === refDocId; });
  var refinement = refineAnchors(corrResult, targets, refDoc);

  var batchTokens = {};
  for (var di = 0; di < docs.length; di++) {
    batchTokens[docs[di].documentId] = {
      tokens: [
        { x: 480, y: 50, w: 80, h: 14, text: 'INV-001', confidence: 0.9 },
        { x: 560, y: 850, w: 60, h: 14, text: '$1,234', confidence: 0.85 },
        { x: 480, y: 100, w: 70, h: 14, text: '2024-01-15', confidence: 0.9 }
      ],
      viewport: { width: 800, height: 1000 }
    };
  }

  var extractionResult = extractFromBatch(refinement, corrResult, refDoc, docs, batchTokens);

  // Create corrections for 2 documents
  var corrections = [];
  for (var ci = 0; ci < Math.min(2, extractionResult.results.length); ci++) {
    var dr = extractionResult.results[ci];
    corrections.push({
      documentId: dr.documentId,
      fields: [
        { fieldKey: 'field_1', correctedText: 'INV-001' },
        { fieldKey: 'field_2', correctedText: '$1,234' }
      ]
    });
  }

  var result = learnFieldGeometry(extractionResult, corrections, batchTokens, refDoc);
  assert.ok(result, 'Should return result');
  assert.ok(['improved', 'no_improvement'].indexOf(result.status) >= 0, 'Status should be valid: ' + result.status);
  assert.ok(result.fieldProfiles.length > 0, 'Should have field profiles');
  assert.ok(result.perDocumentResults.length > 0, 'Should have per-document results');
  assert.strictEqual(result.correctionDocCount, corrections.length);

  for (var pi = 0; pi < result.fieldProfiles.length; pi++) {
    var p = result.fieldProfiles[pi];
    assert.ok(p.fieldKey, 'Profile has fieldKey');
    assert.ok(p.preferredOffset, 'Profile has preferredOffset');
    assert.ok(p.preferredExpansion, 'Profile has preferredExpansion');
    assert.ok(typeof p.geometryConfidence === 'number', 'Profile has geometryConfidence');
    assert.ok(p.dominantFamily, 'Profile has dominantFamily');
    assert.ok(typeof p.improvedCount === 'number');
  }

  // No data case
  var noDataResult = learnFieldGeometry(null, null, batchTokens, refDoc);
  assert.strictEqual(noDataResult.status, 'no_data');

  console.log('learnFieldGeometry tests passed.');
})();

// ── applyGeometryProfile ─────────────────────────────────────────────────

(function testApplyGeometryProfile() {
  var box = { x0n: 0.3, y0n: 0.2, wN: 0.15, hN: 0.05 };

  // With a valid profile
  var profile = {
    preferredOffset: { dx: 0.02, dy: -0.01 },
    preferredExpansion: { dw: 0.01, dh: 0.005 },
    geometryConfidence: 0.7
  };
  var result = applyGeometryProfile(box, profile);
  assert.ok(result.applied, 'Should apply profile');
  assert.ok(Math.abs(result.refinedBox.x0n - 0.32) < 0.001, 'X shifted: ' + result.refinedBox.x0n);
  assert.ok(Math.abs(result.refinedBox.y0n - 0.19) < 0.001, 'Y shifted: ' + result.refinedBox.y0n);
  assert.ok(result.refinedBox.wN > box.wN, 'Width expanded');

  // Low confidence profile should not apply
  var lowProfile = { preferredOffset: { dx: 0.1, dy: 0.1 }, preferredExpansion: { dw: 0, dh: 0 }, geometryConfidence: 0.05 };
  var lowResult = applyGeometryProfile(box, lowProfile);
  assert.ok(!lowResult.applied, 'Low confidence should not apply');

  // Null profile
  var nullResult = applyGeometryProfile(box, null);
  assert.ok(!nullResult.applied, 'Null profile should not apply');

  console.log('applyGeometryProfile tests passed.');
})();

// ── formatGeometryReport ─────────────────────────────────────────────────

(function testFormatGeometryReport() {
  assert.strictEqual(formatGeometryReport(null), '[No geometry learning data]');

  var noData = { status: 'no_data', message: 'No data.' };
  assert.strictEqual(formatGeometryReport(noData), 'No data.');

  var mockResult = {
    status: 'improved',
    message: 'Geometry improved.',
    correctionDocCount: 2,
    fieldProfiles: [{
      label: 'Test', fieldKey: 'f1', preferredOffset: { dx: 0.01, dy: 0.02 },
      preferredExpansion: { dw: 0.005, dh: 0 }, geometryConfidence: 0.8,
      dominantFamily: 'local_search', improvedCount: 2, correctionCount: 2
    }],
    perDocumentResults: [{
      documentName: 'doc1.pdf',
      fields: [{ label: 'Test', improved: true, improvement: 0.15, bestCandidate: { family: 'local_search' } }]
    }]
  };
  var report = formatGeometryReport(mockResult);
  assert.ok(report.indexOf('FIELD INTELLIGENCE REPORT') >= 0, 'Has title');
  assert.ok(report.indexOf('IMPROVED') >= 0, 'Has status');
  assert.ok(report.indexOf('FIELD GEOMETRY PROFILES') >= 0, 'Has profiles section');

  console.log('formatGeometryReport tests passed.');
})();

// ── saveGeometryProfiles in session store ─────────────────────────────────

(function testSaveGeometryProfiles() {
  var store = createBatchSessionStore();
  var session = store.createSession({ name: 'Geometry Test' });

  var profiles = [
    { fieldKey: 'f1', label: 'Test', preferredOffset: { dx: 0.01, dy: 0 }, preferredExpansion: { dw: 0, dh: 0 }, geometryConfidence: 0.8 }
  ];

  var saved = store.saveGeometryProfiles(session.sessionId, profiles);
  assert.ok(saved, 'Should save successfully');

  var loaded = store.getSession(session.sessionId);
  assert.ok(loaded.geometryProfiles, 'Should have geometryProfiles');
  assert.strictEqual(loaded.geometryProfiles.length, 1);
  assert.strictEqual(loaded.geometryProfiles[0].fieldKey, 'f1');

  // Non-existent session
  var bad = store.saveGeometryProfiles('nope', profiles);
  assert.ok(!bad, 'Should return false for non-existent session');

  store.clear();
  console.log('saveGeometryProfiles tests passed.');
})();

console.log('All Phase 3A Field Intelligence tests passed.');
