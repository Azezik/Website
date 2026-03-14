const assert = require('assert');

/* ══════════════════════════════════════════════════════════════════════════
   Batch Structural Learning – Phase 1 Tests
   ══════════════════════════════════════════════════════════════════════════ */

/* ── batch-learning-session ────────────────────────────────────────────── */

const {
  extractDocumentSummary,
  createBatchSessionStore,
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

console.log('All Batch Structural Learning Phase 1 tests passed (including validation).');
