'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  Wrokit Vision Learning Module  –  Public API
  ─────────────────────────────────────────────────────────────────────────────

  This module provides a lightweight, annotation-driven learning system for
  Wrokit Vision.  It reuses the existing config-mode bounding-box drawing
  interface and turns human-drawn boxes into reusable training data.

  Three sub-modules:

  1. LearningStore    – Persists annotation records across sessions
  2. LearningSession  – Manages a single annotation session for one image
  3. LearningAnalyst  – Derives parameter recommendations from stored data

  ─── Quick-start usage ────────────────────────────────────────────────────

  // 1. Create a store (pass localStorage in browser, or omit for in-memory)
  const store = LearningStore.createLearningStore(localStorage);

  // 2. Start a session when user uploads an image in LEARN mode
  const session = LearningSession.createLearningSession({
    viewport: { w: 800, h: 1100 },
    tokens: ocrTokens,
    analysisResult: precomputeResult
  });

  // 3. Present prompts to user
  const prompts = session.getPrompts();
  // → show prompts[0].instruction, let user draw boxes

  // 4. As user draws each box, record it
  session.addAnnotation({
    label: 'company logo',
    category: 'shape',
    rawBox: { x: 20, y: 15, w: 120, h: 60 },
    tokenIds: [],
    text: ''
  });

  // 5. When user finishes, finalize and store
  const record = session.finalize({ imageId: 'receipt-042', imageName: 'receipt.png' });
  store.addRecord(record);

  // 6. After annotating many images, run analysis
  const report = LearningAnalyst.analyzeAll(store.getAllRecords());
  console.log(report.recommendations);
  // → { regionDetection: { suggestedMergeThreshold: 38, ... },
  //     surfaceClassification: { suggestedTextDenseThreshold: 0.50, ... },
  //     rankingWeights: { suggestedWeights: { ... } },
  //     confidenceThresholds: { suggestedMinConfidence: 0.60, ... } }

───────────────────────────────────────────────────────────────────────────────*/

const LearningStore = require('./learning-store');
const LearningSession = require('./learning-session');
const LearningAnalyst = require('./learning-analyst');
const LearningSessionLog = require('./learning-session-log');
const LearningExport = require('./learning-export');
const BatchLearningSession = require('./batch-learning-session');
const BatchStructuralAnalyst = require('./batch-structural-analyst');
const BatchCorrespondenceAnalyst = require('./batch-correspondence-analyst');

module.exports = {
  LearningStore,
  LearningSession,
  LearningAnalyst,
  LearningSessionLog,
  LearningExport,
  BatchLearningSession,
  BatchStructuralAnalyst,
  BatchCorrespondenceAnalyst
};
