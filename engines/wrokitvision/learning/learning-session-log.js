'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  learning-session-log.js  –  Accumulates learning activity across multiple
                               files into a single exportable session
  ─────────────────────────────────────────────────────────────────────────────

  A "session" in this context is NOT the per-file annotation session from
  learning-session.js.  Instead it represents a user-initiated *campaign*:
  the user opens a session, annotates many files over time, and eventually
  exports or starts fresh.

  The session log accumulates:
    - Per-file annotation summaries (filename, box counts by category,
      viewport, timestamp)
    - Per-file analysis snapshots (the output of analyzeAll at each save)
    - A running aggregate analysis across all files in the session

  Session data is persisted to localStorage so it survives page reloads.

  Key behaviors:
    - Uploading a new file does NOT reset the session
    - Exporting does NOT reset the session
    - Only "New Session" explicitly clears it
───────────────────────────────────────────────────────────────────────────────*/

const SESSION_STORAGE_KEY = 'wrokit.learning.sessionLog';

let _idCounter = 0;
function _genId(){
  _idCounter += 1;
  return 'lsess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '-' + _idCounter;
}

function _categorySummary(annotations){
  const counts = {};
  for(const ann of (annotations || [])){
    counts[ann.category] = (counts[ann.category] || 0) + 1;
  }
  return counts;
}

/* ── Session log factory ──────────────────────────────────────────────────── */

function createSessionLog(storage){
  const backend = storage || _memoryBackend();

  function _load(){
    try {
      const raw = backend.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(_e){ return null; }
  }

  function _save(session){
    backend.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  function _ensureSession(){
    let s = _load();
    if(!s){
      s = _createEmpty();
      _save(s);
    }
    return s;
  }

  function _createEmpty(){
    return {
      sessionId: _genId(),
      startedAt: new Date().toISOString(),
      fileEntries: [],          // per-file summaries
      analysisSnapshots: [],    // per-save analysis results
      latestAggregate: null     // most recent cross-session analysis
    };
  }

  return {
    /** Get (or auto-create) the current session. */
    getSession(){
      return _ensureSession();
    },

    /** Whether a session exists. */
    hasSession(){
      return !!_load();
    },

    /** Number of files recorded so far. */
    fileCount(){
      const s = _load();
      return s ? s.fileEntries.length : 0;
    },

    /**
     * Log a completed file annotation.
     * @param {object} record - The AnnotationRecord from learning-session.finalize()
     */
    addFileEntry(record){
      const s = _ensureSession();
      s.fileEntries.push({
        recordId: record.recordId,
        imageName: record.imageName || record.imageId || 'unknown',
        timestamp: record.timestamp || new Date().toISOString(),
        viewport: record.viewport,
        annotationCount: (record.annotations || []).length,
        categoryBreakdown: _categorySummary(record.annotations),
        autoRegionCount: (record.autoRegions || []).length,
        comparisonStats: record.metadata?.comparison || null
      });
      _save(s);
    },

    /**
     * Log an analysis snapshot (output of analyzeAll).
     * @param {object} report - The full analyzeAll result
     */
    addAnalysisSnapshot(report){
      const s = _ensureSession();
      s.analysisSnapshots.push({
        timestamp: new Date().toISOString(),
        recordCountAtTime: report.recordCount || 0,
        status: report.status,
        message: report.message,
        recommendations: report.recommendations || null
      });
      s.latestAggregate = report;
      _save(s);
    },

    /** Start a new session, clearing the current one. */
    newSession(){
      _save(_createEmpty());
    },

    /** Get the full session data for export. */
    getExportData(){
      return _ensureSession();
    }
  };
}

function _memoryBackend(){
  const map = new Map();
  return {
    getItem(key){ return map.get(key) || null; },
    setItem(key, value){ map.set(key, value); }
  };
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  createSessionLog,
  SESSION_STORAGE_KEY
};
