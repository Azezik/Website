'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  learning-export.js  –  Formats a Learning session into a plain-text export
                          designed to be pasted directly into an AI assistant
  ─────────────────────────────────────────────────────────────────────────────

  The export is a .txt file containing:
    1. A hardcoded prompt that tells the AI what the data is and what to do
    2. Session metadata (duration, file count)
    3. Per-file annotation summaries
    4. The latest aggregate analysis & recommendations
    5. Raw analysis snapshots showing how recommendations evolved

  The goal: the user downloads the TXT, pastes it into Claude, and Claude
  knows exactly how to use the data to improve WrokitVision parameters.
───────────────────────────────────────────────────────────────────────────────*/

/* ── Hardcoded AI prompt ──────────────────────────────────────────────────── */

const EXPORT_PROMPT = `\
################################################################################
  WROKIT VISION — LEARNING SESSION EXPORT
################################################################################

You are receiving a WrokitVision Learning Session export.

This file contains findings derived from human annotations compared against
WrokitVision's automatic detections across multiple documents. A human user
drew bounding boxes on real documents to mark visual regions, text groups,
labels, field values, shapes, and structural sections. The system compared
those human-drawn boxes against what WrokitVision auto-detected, and produced
parameter recommendations.

YOUR TASK:
1. Analyze the findings below — pay attention to segmentation bias,
   IoU scores, precision/recall, threshold suggestions, and ranking weight
   recommendations.
2. Identify which WrokitVision parameters need adjustment based on the
   evidence.
3. Implement the appropriate parameter changes in the WrokitVision codebase.
   Key areas to tune:
   - Region detection thresholds (mergeThreshold, hardBarrier, minRegionArea)
   - Surface classification thresholds (textDenseSurfaceThreshold,
     panelTextDensityMax)
   - Candidate ranking weights (the 7 scoring weights)
   - Confidence thresholds (per-category acceptance cutoffs)
4. Use the per-file summaries to understand document diversity — different
   document types may reveal different weaknesses.
5. Use the analysis evolution (snapshots over time) to see whether
   recommendations stabilized or shifted as more data was added.

The data below is the complete session evidence. Use it as tuning ground truth.

################################################################################
`;

/* ── Formatting helpers ───────────────────────────────────────────────────── */

function _line(width){ return '─'.repeat(width || 72); }

function _section(title){
  return '\n' + _line() + '\n  ' + title + '\n' + _line() + '\n';
}

function _kv(label, value, indent){
  const pad = ' '.repeat(indent || 2);
  return pad + label + ': ' + value + '\n';
}

function _jsonBlock(obj, indent){
  const pad = ' '.repeat(indent || 4);
  const lines = JSON.stringify(obj, null, 2).split('\n');
  return lines.map(function(l){ return pad + l; }).join('\n') + '\n';
}

/* ── Main export formatter ────────────────────────────────────────────────── */

function formatSessionExport(sessionData){
  if(!sessionData) return EXPORT_PROMPT + '\n[No session data available]\n';

  let out = EXPORT_PROMPT;

  /* ── Session overview ──────────────────────────────────────────────────── */
  out += _section('SESSION OVERVIEW');
  out += _kv('Session ID', sessionData.sessionId || 'unknown');
  out += _kv('Started', sessionData.startedAt || 'unknown');
  out += _kv('Exported', new Date().toISOString());
  out += _kv('Files annotated', (sessionData.fileEntries || []).length);

  const totalBoxes = (sessionData.fileEntries || []).reduce(function(s, f){
    return s + (f.annotationCount || 0);
  }, 0);
  out += _kv('Total annotation boxes', totalBoxes);

  const totalAutoRegions = (sessionData.fileEntries || []).reduce(function(s, f){
    return s + (f.autoRegionCount || 0);
  }, 0);
  out += _kv('Total auto-detected regions', totalAutoRegions);
  out += _kv('Analysis snapshots', (sessionData.analysisSnapshots || []).length);

  /* ── Per-file summaries ────────────────────────────────────────────────── */
  if(sessionData.fileEntries && sessionData.fileEntries.length){
    out += _section('PER-FILE ANNOTATION SUMMARIES');

    for(var i = 0; i < sessionData.fileEntries.length; i++){
      var f = sessionData.fileEntries[i];
      out += '\n  File ' + (i + 1) + ': ' + (f.imageName || 'unknown') + '\n';
      out += _kv('Timestamp', f.timestamp || 'unknown', 4);
      out += _kv('Viewport', (f.viewport ? f.viewport.w + ' x ' + f.viewport.h : 'unknown'), 4);
      out += _kv('Human annotations', f.annotationCount || 0, 4);
      out += _kv('Auto-detected regions', f.autoRegionCount || 0, 4);

      if(f.categoryBreakdown){
        out += '    Category breakdown:\n';
        var cats = Object.keys(f.categoryBreakdown);
        for(var c = 0; c < cats.length; c++){
          out += '      ' + cats[c].replace(/_/g, ' ') + ': ' + f.categoryBreakdown[cats[c]] + '\n';
        }
      }

      if(f.comparisonStats){
        out += '    Comparison vs auto-detection:\n';
        out += _kv('Matched regions', f.comparisonStats.matchCount || 0, 6);
        out += _kv('Missed by system', f.comparisonStats.missedCount || 0, 6);
        out += _kv('Extra detections', f.comparisonStats.extraCount || 0, 6);
        out += _kv('Average IoU', (f.comparisonStats.averageIoU || 0).toFixed(3), 6);
        out += _kv('Precision', (f.comparisonStats.precision || 0).toFixed(3), 6);
        out += _kv('Recall', (f.comparisonStats.recall || 0).toFixed(3), 6);
      }
    }
  }

  /* ── Latest aggregate analysis ─────────────────────────────────────────── */
  if(sessionData.latestAggregate){
    out += _section('LATEST AGGREGATE ANALYSIS');
    out += _kv('Status', sessionData.latestAggregate.status || 'unknown');
    out += _kv('Summary', sessionData.latestAggregate.message || '');
    out += _kv('Records analyzed', sessionData.latestAggregate.recordCount || 0);
    out += _kv('Total annotations', sessionData.latestAggregate.totalAnnotations || 0);

    var recs = sessionData.latestAggregate.recommendations;
    if(recs){
      if(recs.regionDetection){
        out += '\n  Region Detection:\n';
        out += _kv('Segmentation bias', recs.regionDetection.segmentationBias || 'unknown', 4);
        out += _kv('Suggested mergeThreshold', recs.regionDetection.suggestedMergeThreshold, 4);
        out += _kv('Suggested minRegionArea', recs.regionDetection.suggestedMinRegionArea, 4);
        if(recs.regionDetection.evidence){
          out += '    Evidence:\n';
          out += _jsonBlock(recs.regionDetection.evidence, 6);
        }
      }

      if(recs.surfaceClassification){
        out += '\n  Surface Classification:\n';
        out += _kv('Suggested textDenseThreshold', recs.surfaceClassification.suggestedTextDenseThreshold, 4);
        out += _kv('Suggested panelTextDensityMax', recs.surfaceClassification.suggestedPanelTextDensityMax, 4);
        if(recs.surfaceClassification.evidence){
          out += '    Evidence:\n';
          out += _jsonBlock(recs.surfaceClassification.evidence, 6);
        }
      }

      if(recs.rankingWeights){
        out += '\n  Candidate Ranking Weights:\n';
        if(recs.rankingWeights.suggestedWeights){
          out += '    Suggested weights:\n';
          out += _jsonBlock(recs.rankingWeights.suggestedWeights, 6);
        }
        if(recs.rankingWeights.evidence){
          out += '    Evidence:\n';
          out += _jsonBlock(recs.rankingWeights.evidence, 6);
        }
      }

      if(recs.confidenceThresholds){
        out += '\n  Confidence Thresholds:\n';
        out += _kv('Suggested minConfidence', recs.confidenceThresholds.suggestedMinConfidence, 4);
        if(recs.confidenceThresholds.evidence){
          out += '    Evidence:\n';
          out += _jsonBlock(recs.confidenceThresholds.evidence, 6);
        }
      }
    }
  }

  /* ── Analysis evolution (snapshots) ─────────────────────────────────────── */
  if(sessionData.analysisSnapshots && sessionData.analysisSnapshots.length > 1){
    out += _section('ANALYSIS EVOLUTION (snapshots over time)');
    out += '  Shows how recommendations changed as more files were annotated.\n\n';

    for(var s = 0; s < sessionData.analysisSnapshots.length; s++){
      var snap = sessionData.analysisSnapshots[s];
      out += '  Snapshot ' + (s + 1) + '  [' + (snap.timestamp || '') + ']\n';
      out += _kv('Records at time', snap.recordCountAtTime || 0, 4);
      out += _kv('Status', snap.status || 'unknown', 4);
      if(snap.recommendations){
        out += '    Recommendations:\n';
        out += _jsonBlock(snap.recommendations, 6);
      }
      out += '\n';
    }
  }

  /* ── Footer ────────────────────────────────────────────────────────────── */
  out += _section('END OF EXPORT');
  out += '  Use the data above to implement WrokitVision parameter improvements.\n';
  out += '  Focus on the latest aggregate analysis for current recommendations,\n';
  out += '  and use the per-file summaries and analysis evolution for context.\n';

  return out;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  formatSessionExport,
  EXPORT_PROMPT
};
