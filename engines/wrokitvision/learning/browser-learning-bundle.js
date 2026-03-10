/*───────────────────────────────────────────────────────────────────────────────
  browser-learning-bundle.js  –  Browser-side Wrokit Vision Learning module
  ─────────────────────────────────────────────────────────────────────────────
  Sets window.WrokitVisionLearning with the full learning API.
  This is a self-contained browser build that does not depend on require().
───────────────────────────────────────────────────────────────────────────────*/
(function(root){
  'use strict';

  /* ── Shared helpers ────────────────────────────────────────────────────── */

  function clamp01(v){
    const n = Number(v);
    if(!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  let _idCounter = 0;
  function generateId(prefix){
    _idCounter += 1;
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return prefix + '-' + ts + '-' + rnd + '-' + _idCounter;
  }

  function normalizeBox(rawBox, viewport){
    const x = Number(rawBox && rawBox.x) || 0;
    const y = Number(rawBox && rawBox.y) || 0;
    const w = Math.max(0, Number(rawBox && rawBox.w) || 0);
    const h = Math.max(0, Number(rawBox && rawBox.h) || 0);
    const vpW = Math.max(1, Number(viewport && viewport.w) || 1);
    const vpH = Math.max(1, Number(viewport && viewport.h) || 1);
    return {
      x0n: clamp01(x / vpW),
      y0n: clamp01(y / vpH),
      wN:  clamp01(w / vpW),
      hN:  clamp01(h / vpH)
    };
  }

  /* ── Annotation categories ─────────────────────────────────────────────── */

  var ANNOTATION_CATEGORIES = Object.freeze([
    'visual_region', 'text_group', 'label', 'shape',
    'field_value', 'structural_section', 'other'
  ]);

  /* ── Learning prompts ──────────────────────────────────────────────────── */

  var LEARNING_PROMPTS = Object.freeze([
    { id: 'visual_regions', category: 'visual_region', title: 'Visual Regions',
      instruction: 'Draw boxes around all distinct visual regions you can see. These are areas that look like separate sections, panels, cards, or blocks. Keep drawing until the image is broken into meaningful parts.', multiBox: true },
    { id: 'text_groups', category: 'text_group', title: 'Text Groups',
      instruction: 'Draw boxes around groups of text that belong together. For example: an address block, a set of line items, a title area, or any cluster of text that forms a logical unit.', multiBox: true },
    { id: 'labels', category: 'label', title: 'Labels & Headings',
      instruction: 'Draw boxes around any labels, headings, or titles. These are words or phrases that name or describe something else, like "Invoice Number", "Total", "Ship To", or "Date".', multiBox: true },
    { id: 'field_values', category: 'field_value', title: 'Field Values',
      instruction: 'Draw boxes around specific data values. These are the actual numbers, dates, names, or codes that a label refers to — the content you would want to extract.', multiBox: true },
    { id: 'shapes', category: 'shape', title: 'Shapes & Non-Text Elements',
      instruction: 'Draw boxes around non-text visual elements: logos, icons, dividers, decorative borders, images, or any visual element that is not text. Skip this if there are none.', multiBox: true, optional: true },
    { id: 'structural_sections', category: 'structural_section', title: 'Structural Sections',
      instruction: 'Draw boxes around the major structural divisions of the document. For example: header area, body/content area, footer area, sidebar. These are the biggest organizational blocks.', multiBox: true, optional: true }
  ]);

  /* ── AnnotationBox factory ─────────────────────────────────────────────── */

  function createAnnotationBox(opts){
    opts = opts || {};
    var cat = ANNOTATION_CATEGORIES.indexOf(opts.category) >= 0 ? opts.category : 'other';
    var raw = {
      x: Number(opts.rawBox && opts.rawBox.x) || 0,
      y: Number(opts.rawBox && opts.rawBox.y) || 0,
      w: Math.max(0, Number(opts.rawBox && opts.rawBox.w) || 0),
      h: Math.max(0, Number(opts.rawBox && opts.rawBox.h) || 0)
    };
    return {
      boxId: generateId('abox'),
      label: String(opts.label || '').trim() || cat,
      category: cat,
      normBox: normalizeBox(raw, opts.viewport),
      rawBox: raw,
      tokens: Array.isArray(opts.tokenIds) ? opts.tokenIds : [],
      text: String(opts.text || ''),
      confidence: 1.0,
      notes: String(opts.notes || '')
    };
  }

  /* ── Snapshot region ───────────────────────────────────────────────────── */

  function snapshotRegion(region, viewport){
    var bbox = (region && region.geometry && region.geometry.bbox) || (region && region.bbox) || {};
    var vpW = Math.max(1, Number(viewport && viewport.w) || 1);
    var vpH = Math.max(1, Number(viewport && viewport.h) || 1);

    var x = Number(bbox.x), y = Number(bbox.y);
    var w = Number(bbox.w), h = Number(bbox.h);

    if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)){
      x = Number(region && region.x);
      y = Number(region && region.y);
      w = Number(region && region.w);
      h = Number(region && region.h);
    }

    if((!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) &&
       Number.isFinite(region && region.nx) && Number.isFinite(region && region.ny) &&
       Number.isFinite(region && region.nw) && Number.isFinite(region && region.nh)){
      x = Number(region.nx) * vpW;
      y = Number(region.ny) * vpH;
      w = Number(region.nw) * vpW;
      h = Number(region.nh) * vpH;
    }

    x = Number.isFinite(x) ? x : 0;
    y = Number.isFinite(y) ? y : 0;
    w = Math.max(0, Number.isFinite(w) ? w : 0);
    h = Math.max(0, Number.isFinite(h) ? h : 0);

    return {
      regionId: (region && region.id) || null,
      bbox: { x: x, y: y, w: w, h: h },
      normBox: normalizeBox({ x: x, y: y, w: w, h: h }, viewport),
      confidence: Number(region && region.confidence) || 0,
      textDensity: Number(region && region.textDensity) || 0,
      surfaceType: (region && region.surfaceTypeCandidate) || 'unknown'
    };
  }

  /* ── AnnotationRecord factory ──────────────────────────────────────────── */

  function createAnnotationRecord(opts){
    opts = opts || {};
    return {
      recordId: generateId('lrec'),
      imageId: String(opts.imageId || ''),
      imageName: String(opts.imageName || ''),
      timestamp: new Date().toISOString(),
      viewport: { w: Number(opts.viewport && opts.viewport.w) || 0, h: Number(opts.viewport && opts.viewport.h) || 0 },
      annotations: Array.isArray(opts.annotations) ? opts.annotations : [],
      autoRegions: Array.isArray(opts.autoRegions) ? opts.autoRegions : [],
      metadata: opts.metadata || {}
    };
  }

  /* ── IoU ────────────────────────────────────────────────────────────────── */

  function computeIoU(boxA, boxB){
    var ax0 = Number(boxA && (boxA.x0n != null ? boxA.x0n : boxA.x)) || 0;
    var ay0 = Number(boxA && (boxA.y0n != null ? boxA.y0n : boxA.y)) || 0;
    var ax1 = ax0 + (Number(boxA && (boxA.wN != null ? boxA.wN : boxA.w)) || 0);
    var ay1 = ay0 + (Number(boxA && (boxA.hN != null ? boxA.hN : boxA.h)) || 0);
    var bx0 = Number(boxB && (boxB.x0n != null ? boxB.x0n : boxB.x)) || 0;
    var by0 = Number(boxB && (boxB.y0n != null ? boxB.y0n : boxB.y)) || 0;
    var bx1 = bx0 + (Number(boxB && (boxB.wN != null ? boxB.wN : boxB.w)) || 0);
    var by1 = by0 + (Number(boxB && (boxB.hN != null ? boxB.hN : boxB.h)) || 0);
    var interX = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
    var interY = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    var interArea = interX * interY;
    var areaA = (ax1 - ax0) * (ay1 - ay0);
    var areaB = (bx1 - bx0) * (by1 - by0);
    var unionArea = areaA + areaB - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  /* ── Region comparison ─────────────────────────────────────────────────── */

  function compareAnnotationsToRegions(annotations, autoRegions, iouThreshold){
    if(iouThreshold == null) iouThreshold = 0.3;
    var humanBoxes = (annotations || []).filter(function(a){
      return a.category === 'visual_region' || a.category === 'structural_section';
    });
    var matchedHuman = {}, matchedAuto = {}, matches = [];
    for(var hi = 0; hi < humanBoxes.length; hi++){
      var bestIoU = 0, bestAutoIdx = -1;
      for(var ai = 0; ai < (autoRegions || []).length; ai++){
        var iou = computeIoU(humanBoxes[hi].normBox, autoRegions[ai].normBox);
        if(iou > bestIoU){ bestIoU = iou; bestAutoIdx = ai; }
      }
      if(bestIoU >= iouThreshold && bestAutoIdx >= 0){
        matchedHuman[hi] = true; matchedAuto[bestAutoIdx] = true;
        matches.push({ humanBox: humanBoxes[hi], autoRegion: autoRegions[bestAutoIdx], iou: bestIoU });
      }
    }
    var missedBySystem = humanBoxes.filter(function(_, i){ return !matchedHuman[i]; });
    var extraDetections = (autoRegions || []).filter(function(_, i){ return !matchedAuto[i]; });
    var matchedAutoCount = Object.keys(matchedAuto).length;
    var matchedHumanCount = Object.keys(matchedHuman).length;
    return {
      matches: matches,
      missedBySystem: missedBySystem,
      extraDetections: extraDetections,
      stats: {
        humanRegionCount: humanBoxes.length,
        autoRegionCount: (autoRegions || []).length,
        matchCount: matches.length,
        missedCount: missedBySystem.length,
        extraCount: extraDetections.length,
        averageIoU: matches.length ? matches.reduce(function(s, m){ return s + m.iou; }, 0) / matches.length : 0,
        precision: (autoRegions || []).length ? matchedAutoCount / (autoRegions || []).length : 0,
        recall: humanBoxes.length ? matchedHumanCount / humanBoxes.length : 0
      }
    };
  }

  /* ── Learning Store ────────────────────────────────────────────────────── */

  var STORAGE_KEY = 'wrokit.learning.annotations';

  function createLearningStore(storage){
    var backend = storage || root.localStorage;
    function _load(){
      try { var raw = backend.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
      catch(e){ return []; }
    }
    function _save(records){ backend.setItem(STORAGE_KEY, JSON.stringify(records)); }
    return {
      addRecord: function(record){ var r = _load(); r.push(record); _save(r); return record.recordId; },
      getAllRecords: function(){ return _load(); },
      getRecordsByImage: function(imageId){ return _load().filter(function(r){ return r.imageId === imageId; }); },
      getRecord: function(recordId){ return _load().find(function(r){ return r.recordId === recordId; }) || null; },
      deleteRecord: function(recordId){ _save(_load().filter(function(r){ return r.recordId !== recordId; })); },
      count: function(){ return _load().length; },
      totalAnnotations: function(){ return _load().reduce(function(s, r){ return s + (r.annotations ? r.annotations.length : 0); }, 0); },
      stats: function(){
        var records = _load();
        var totalBoxes = records.reduce(function(s, r){ return s + (r.annotations ? r.annotations.length : 0); }, 0);
        var categories = {};
        records.forEach(function(rec){ (rec.annotations || []).forEach(function(ann){ categories[ann.category] = (categories[ann.category] || 0) + 1; }); });
        return { totalRecords: records.length, totalBoxes: totalBoxes, categories: categories };
      },
      clear: function(){ _save([]); },
      exportJSON: function(){ return JSON.stringify(_load(), null, 2); },
      importJSON: function(json){
        try {
          var incoming = JSON.parse(json);
          if(!Array.isArray(incoming)) return 0;
          var existing = _load();
          var ids = {}; existing.forEach(function(r){ ids[r.recordId] = true; });
          var added = 0;
          incoming.forEach(function(r){ if(r.recordId && !ids[r.recordId]){ existing.push(r); ids[r.recordId] = true; added++; } });
          _save(existing); return added;
        } catch(e){ return 0; }
      }
    };
  }

  /* ── Learning Session ──────────────────────────────────────────────────── */

  function createLearningSession(opts){
    opts = opts || {};
    var vp = { w: Number(opts.viewport && opts.viewport.w) || 0, h: Number(opts.viewport && opts.viewport.h) || 0 };
    var tokens = opts.tokens || [];
    var annotations = [];
    var finalized = false;
    var detectedRegions = Array.isArray(opts.analysisResult && opts.analysisResult.autoRegions) ? (opts.analysisResult && opts.analysisResult.autoRegions) : ((opts.analysisResult && opts.analysisResult.regionNodes) || []);
    var autoRegions = detectedRegions.map(function(r){ return snapshotRegion(r, vp); });

    return {
      getPrompts: function(){ return LEARNING_PROMPTS; },
      getCategories: function(){ return ANNOTATION_CATEGORIES; },
      addAnnotation: function(o){
        if(finalized) throw new Error('Session already finalized');
        var box = createAnnotationBox({ label: o && o.label, category: o && o.category, rawBox: o && o.rawBox, viewport: vp, tokenIds: o && o.tokenIds, text: o && o.text, notes: o && o.notes });
        annotations.push(box);
        return box;
      },
      undoLast: function(){ if(finalized) throw new Error('Session already finalized'); return annotations.pop() || null; },
      removeAnnotation: function(boxId){ if(finalized) throw new Error('Session already finalized'); var idx = -1; annotations.forEach(function(a, i){ if(a.boxId === boxId) idx = i; }); if(idx >= 0) return annotations.splice(idx, 1)[0]; return null; },
      annotationCount: function(){ return annotations.length; },
      getAnnotations: function(){ return annotations.slice(); },
      getAnnotationsByCategory: function(cat){ return annotations.filter(function(a){ return a.category === cat; }); },
      getAutoRegions: function(){ return autoRegions; },
      compareToAutoRegions: function(t){ return compareAnnotationsToRegions(annotations, autoRegions, t); },
      finalize: function(o){
        if(finalized) throw new Error('Session already finalized');
        finalized = true;
        var comparison = compareAnnotationsToRegions(annotations, autoRegions);
        return createAnnotationRecord({
          imageId: o && o.imageId, imageName: o && o.imageName,
          viewport: vp, annotations: annotations.slice(), autoRegions: autoRegions,
          metadata: Object.assign({}, (o && o.metadata) || {}, { comparison: comparison.stats, tokenCount: Array.isArray(tokens) ? tokens.length : 0 })
        });
      },
      isFinalized: function(){ return finalized; }
    };
  }

  /* ── Learning Analyst ──────────────────────────────────────────────────── */

  function median(arr){ if(!arr.length) return 0; var s = arr.slice().sort(function(a,b){ return a-b; }); var m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; }
  function mean(arr){ return arr.length ? arr.reduce(function(s,v){ return s+v; }, 0) / arr.length : 0; }
  function percentile(arr, p){ if(!arr.length) return 0; var s = arr.slice().sort(function(a,b){ return a-b; }); return s[Math.max(0, Math.min(s.length-1, Math.floor(s.length*p)))]; }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function analyzeRegionDetection(records){
    var comparisons = [], humanAreas = [], autoAreas = [];
    records.forEach(function(rec){
      var comp = compareAnnotationsToRegions(rec.annotations, rec.autoRegions);
      comparisons.push(comp);
      var vpArea = (rec.viewport && rec.viewport.w || 1) * (rec.viewport && rec.viewport.h || 1);
      (rec.annotations || []).forEach(function(a){ if(a.category==='visual_region'||a.category==='structural_section') humanAreas.push(a.normBox.wN*a.normBox.hN*vpArea); });
      (rec.autoRegions || []).forEach(function(a){ autoAreas.push(a.normBox.wN*a.normBox.hN*vpArea); });
    });
    var avgHuman = mean(comparisons.map(function(c){ return c.stats.humanRegionCount; }));
    var avgAuto = mean(comparisons.map(function(c){ return c.stats.autoRegionCount; }));
    var avgIoU = mean(comparisons.map(function(c){ return c.stats.averageIoU; }));
    var avgPrecision = mean(comparisons.map(function(c){ return c.stats.precision; }));
    var avgRecall = mean(comparisons.map(function(c){ return c.stats.recall; }));
    var bias = 'balanced';
    if(avgAuto > avgHuman * 1.5) bias = 'over';
    else if(avgAuto < avgHuman * 0.7) bias = 'under';
    var sugMerge = 32;
    if(bias === 'over') sugMerge = clamp(Math.round(32 * Math.sqrt(avgAuto / Math.max(1, avgHuman))), 32, 64);
    else if(bias === 'under') sugMerge = clamp(Math.round(32 / Math.sqrt(avgHuman / Math.max(1, avgAuto))), 16, 32);
    var smallestH = humanAreas.length ? percentile(humanAreas, 0.05) : 2000;
    return {
      segmentationBias: bias, suggestedMergeThreshold: sugMerge,
      suggestedMinRegionArea: Math.max(500, Math.round(smallestH * 0.5)),
      evidence: { recordCount: records.length, avgHumanRegionCount: Math.round(avgHuman*10)/10, avgAutoRegionCount: Math.round(avgAuto*10)/10, avgIoU: Math.round(avgIoU*1000)/1000, avgPrecision: Math.round(avgPrecision*1000)/1000, avgRecall: Math.round(avgRecall*1000)/1000 }
    };
  }

  function analyzeAll(records){
    if(!Array.isArray(records) || !records.length) return { status: 'insufficient_data', message: 'No annotation records found. Use Learning mode to annotate some images first.', recordCount: 0, recommendations: null };
    var totalAnns = records.reduce(function(s, r){ return s + (r.annotations ? r.annotations.length : 0); }, 0);
    var rd = analyzeRegionDetection(records);
    var status = records.length < 5 ? 'early' : records.length < 15 ? 'developing' : 'ready';
    var msgs = {
      early: records.length + ' images annotated (' + totalAnns + ' boxes). Recommendations are preliminary.',
      developing: records.length + ' images annotated (' + totalAnns + ' boxes). Recommendations are becoming reliable.',
      ready: records.length + ' images annotated (' + totalAnns + ' boxes). Enough data for confident recommendations.'
    };
    return { status: status, message: msgs[status], recordCount: records.length, totalAnnotations: totalAnns, recommendations: { regionDetection: rd } };
  }

  /* ── Session Log ──────────────────────────────────────────────────────── */
  /*  Accumulates learning activity across multiple files into a single
   *  exportable session.  Persisted to localStorage.  */

  var SESSION_STORAGE_KEY = 'wrokit.learning.sessionLog';

  function _categorySummary(annotations){
    var counts = {};
    (annotations || []).forEach(function(a){ counts[a.category] = (counts[a.category] || 0) + 1; });
    return counts;
  }

  function createSessionLog(storage){
    var backend = storage || root.localStorage;

    function _load(){
      try { var raw = backend.getItem(SESSION_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
      catch(e){ return null; }
    }
    function _save(s){ backend.setItem(SESSION_STORAGE_KEY, JSON.stringify(s)); }

    function _createEmpty(){
      return {
        sessionId: generateId('lsess'),
        startedAt: new Date().toISOString(),
        fileEntries: [],
        analysisSnapshots: [],
        latestAggregate: null
      };
    }

    function _ensure(){
      var s = _load();
      if(!s){ s = _createEmpty(); _save(s); }
      return s;
    }

    return {
      getSession: function(){ return _ensure(); },
      hasSession: function(){ return !!_load(); },
      fileCount: function(){ var s = _load(); return s ? s.fileEntries.length : 0; },

      addFileEntry: function(record){
        var s = _ensure();
        s.fileEntries.push({
          recordId: record.recordId,
          imageName: record.imageName || record.imageId || 'unknown',
          timestamp: record.timestamp || new Date().toISOString(),
          viewport: record.viewport,
          annotationCount: (record.annotations || []).length,
          categoryBreakdown: _categorySummary(record.annotations),
          autoRegionCount: (record.autoRegions || []).length,
          comparisonStats: (record.metadata && record.metadata.comparison) || null
        });
        _save(s);
      },

      addAnalysisSnapshot: function(report){
        var s = _ensure();
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

      newSession: function(){ _save(_createEmpty()); },

      getExportData: function(){ return _ensure(); }
    };
  }

  /* ── Session Export Formatter ────────────────────────────────────────── */

  var EXPORT_PROMPT =
    '################################################################################\n' +
    '  WROKIT VISION \u2014 LEARNING SESSION EXPORT\n' +
    '################################################################################\n' +
    '\n' +
    'You are receiving a WrokitVision Learning Session export.\n' +
    '\n' +
    'This file contains findings derived from human annotations compared against\n' +
    'WrokitVision\'s automatic detections across multiple documents. A human user\n' +
    'drew bounding boxes on real documents to mark visual regions, text groups,\n' +
    'labels, field values, shapes, and structural sections. The system compared\n' +
    'those human-drawn boxes against what WrokitVision auto-detected, and produced\n' +
    'parameter recommendations.\n' +
    '\n' +
    'YOUR TASK:\n' +
    '1. Analyze the findings below \u2014 pay attention to segmentation bias,\n' +
    '   IoU scores, precision/recall, threshold suggestions, and ranking weight\n' +
    '   recommendations.\n' +
    '2. Identify which WrokitVision parameters need adjustment based on the\n' +
    '   evidence.\n' +
    '3. Implement the appropriate parameter changes in the WrokitVision codebase.\n' +
    '   Key areas to tune:\n' +
    '   - Region detection thresholds (mergeThreshold, hardBarrier, minRegionArea)\n' +
    '   - Surface classification thresholds (textDenseSurfaceThreshold,\n' +
    '     panelTextDensityMax)\n' +
    '   - Candidate ranking weights (the 7 scoring weights)\n' +
    '   - Confidence thresholds (per-category acceptance cutoffs)\n' +
    '4. Use the per-file summaries to understand document diversity \u2014 different\n' +
    '   document types may reveal different weaknesses.\n' +
    '5. Use the analysis evolution (snapshots over time) to see whether\n' +
    '   recommendations stabilized or shifted as more data was added.\n' +
    '\n' +
    'The data below is the complete session evidence. Use it as tuning ground truth.\n' +
    '\n' +
    '################################################################################\n';

  function _fmtLine(w){ var s = ''; for(var i = 0; i < (w||72); i++) s += '\u2500'; return s; }
  function _fmtSection(title){ return '\n' + _fmtLine() + '\n  ' + title + '\n' + _fmtLine() + '\n'; }
  function _fmtKv(label, value, indent){ return new Array((indent||2)+1).join(' ') + label + ': ' + value + '\n'; }
  function _fmtJson(obj, indent){
    var pad = new Array((indent||4)+1).join(' ');
    return JSON.stringify(obj, null, 2).split('\n').map(function(l){ return pad + l; }).join('\n') + '\n';
  }

  function _computeEvidenceStrength(latestAggregate){
    if(!latestAggregate) return { level: 'none', note: 'No aggregate analysis available.' };
    var recordCount = Number(latestAggregate.recordCount) || 0;
    var totalAnnotations = Number(latestAggregate.totalAnnotations) || 0;
    var autoAvg = Number(latestAggregate.recommendations && latestAggregate.recommendations.regionDetection && latestAggregate.recommendations.regionDetection.evidence && latestAggregate.recommendations.regionDetection.evidence.avgAutoRegionCount) || 0;

    if(recordCount === 0) return { level: 'none', note: 'No records were analyzed in this session.' };
    if(autoAvg <= 0){
      return { level: 'weak', note: 'Auto-detected region count is zero in analyzed records; recommendations are low-confidence until detection capture is verified.' };
    }
    if(recordCount < 5 || totalAnnotations < 30){
      return { level: 'weak', note: 'Small evidence sample. Treat recommendations as directional and gather more annotated files.' };
    }
    if(recordCount < 15 || totalAnnotations < 120){
      return { level: 'moderate', note: 'Evidence is usable but still limited. Validate changes against additional files.' };
    }
    return { level: 'strong', note: 'Recommendation evidence is supported by a broad session sample.' };
  }

  function formatSessionExport(sessionData){
    if(!sessionData) return EXPORT_PROMPT + '\n[No session data available]\n';

    var out = EXPORT_PROMPT;

    /* Session overview */
    out += _fmtSection('SESSION OVERVIEW');
    out += _fmtKv('Session ID', sessionData.sessionId || 'unknown');
    out += _fmtKv('Started', sessionData.startedAt || 'unknown');
    out += _fmtKv('Exported', new Date().toISOString());
    out += _fmtKv('Files annotated', (sessionData.fileEntries || []).length);
    var totalBoxes = (sessionData.fileEntries || []).reduce(function(s, f){ return s + (f.annotationCount || 0); }, 0);
    out += _fmtKv('Total annotation boxes', totalBoxes);
    var totalAuto = (sessionData.fileEntries || []).reduce(function(s, f){ return s + (f.autoRegionCount || 0); }, 0);
    out += _fmtKv('Total auto-detected regions', totalAuto);
    out += _fmtKv('Analysis snapshots', (sessionData.analysisSnapshots || []).length);

    /* Per-file summaries */
    if(sessionData.fileEntries && sessionData.fileEntries.length){
      out += _fmtSection('PER-FILE ANNOTATION SUMMARIES');
      for(var i = 0; i < sessionData.fileEntries.length; i++){
        var f = sessionData.fileEntries[i];
        out += '\n  File ' + (i+1) + ': ' + (f.imageName || 'unknown') + '\n';
        out += _fmtKv('Timestamp', f.timestamp || 'unknown', 4);
        out += _fmtKv('Viewport', f.viewport ? f.viewport.w + ' x ' + f.viewport.h : 'unknown', 4);
        out += _fmtKv('Human annotations', f.annotationCount || 0, 4);
        out += _fmtKv('Auto-detected regions', f.autoRegionCount || 0, 4);
        if(f.categoryBreakdown){
          out += '    Category breakdown:\n';
          var cats = Object.keys(f.categoryBreakdown);
          for(var c = 0; c < cats.length; c++){
            out += '      ' + cats[c].replace(/_/g, ' ') + ': ' + f.categoryBreakdown[cats[c]] + '\n';
          }
        }
        if(f.comparisonStats){
          out += '    Comparison vs auto-detection:\n';
          out += _fmtKv('Matched regions', f.comparisonStats.matchCount || 0, 6);
          out += _fmtKv('Missed by system', f.comparisonStats.missedCount || 0, 6);
          out += _fmtKv('Extra detections', f.comparisonStats.extraCount || 0, 6);
          out += _fmtKv('Average IoU', (f.comparisonStats.averageIoU || 0).toFixed(3), 6);
          out += _fmtKv('Precision', (f.comparisonStats.precision || 0).toFixed(3), 6);
          out += _fmtKv('Recall', (f.comparisonStats.recall || 0).toFixed(3), 6);
        }
      }
    }

    /* Latest aggregate analysis */
    if(sessionData.latestAggregate){
      out += _fmtSection('LATEST AGGREGATE ANALYSIS');
      out += _fmtKv('Status', sessionData.latestAggregate.status || 'unknown');
      out += _fmtKv('Summary', sessionData.latestAggregate.message || '');
      out += _fmtKv('Records analyzed', sessionData.latestAggregate.recordCount || 0);
      out += _fmtKv('Total annotations', sessionData.latestAggregate.totalAnnotations || 0);
      var evidenceStrength = _computeEvidenceStrength(sessionData.latestAggregate);
      out += _fmtKv('Recommendation evidence strength', evidenceStrength.level);
      out += _fmtKv('Evidence note', evidenceStrength.note);
      var recs = sessionData.latestAggregate.recommendations;
      if(recs){
        if(recs.regionDetection){
          out += '\n  Region Detection:\n';
          out += _fmtKv('Segmentation bias', recs.regionDetection.segmentationBias || 'unknown', 4);
          out += _fmtKv('Suggested mergeThreshold', recs.regionDetection.suggestedMergeThreshold, 4);
          out += _fmtKv('Suggested minRegionArea', recs.regionDetection.suggestedMinRegionArea, 4);
          if(recs.regionDetection.evidence){ out += '    Evidence:\n'; out += _fmtJson(recs.regionDetection.evidence, 6); }
        }
        if(recs.surfaceClassification){
          out += '\n  Surface Classification:\n';
          out += _fmtKv('Suggested textDenseThreshold', recs.surfaceClassification.suggestedTextDenseThreshold, 4);
          out += _fmtKv('Suggested panelTextDensityMax', recs.surfaceClassification.suggestedPanelTextDensityMax, 4);
          if(recs.surfaceClassification.evidence){ out += '    Evidence:\n'; out += _fmtJson(recs.surfaceClassification.evidence, 6); }
        }
        if(recs.rankingWeights){
          out += '\n  Candidate Ranking Weights:\n';
          if(recs.rankingWeights.suggestedWeights){ out += '    Suggested weights:\n'; out += _fmtJson(recs.rankingWeights.suggestedWeights, 6); }
          if(recs.rankingWeights.evidence){ out += '    Evidence:\n'; out += _fmtJson(recs.rankingWeights.evidence, 6); }
        }
        if(recs.confidenceThresholds){
          out += '\n  Confidence Thresholds:\n';
          out += _fmtKv('Suggested minConfidence', recs.confidenceThresholds.suggestedMinConfidence, 4);
          if(recs.confidenceThresholds.evidence){ out += '    Evidence:\n'; out += _fmtJson(recs.confidenceThresholds.evidence, 6); }
        }
      }
    }

    /* Analysis evolution */
    if(sessionData.analysisSnapshots && sessionData.analysisSnapshots.length > 1){
      out += _fmtSection('ANALYSIS EVOLUTION (snapshots over time)');
      out += '  Shows how recommendations changed as more files were annotated.\n\n';
      for(var si = 0; si < sessionData.analysisSnapshots.length; si++){
        var snap = sessionData.analysisSnapshots[si];
        out += '  Snapshot ' + (si+1) + '  [' + (snap.timestamp || '') + ']\n';
        out += _fmtKv('Records at time', snap.recordCountAtTime || 0, 4);
        out += _fmtKv('Status', snap.status || 'unknown', 4);
        if(snap.recommendations){ out += '    Recommendations:\n'; out += _fmtJson(snap.recommendations, 6); }
        out += '\n';
      }
    }

    /* Footer */
    out += _fmtSection('END OF EXPORT');
    out += '  Use the data above to implement WrokitVision parameter improvements.\n';
    out += '  Focus on the latest aggregate analysis for current recommendations,\n';
    out += '  and use the per-file summaries and analysis evolution for context.\n';

    return out;
  }

  /* ── Public API ────────────────────────────────────────────────────────── */

  root.WrokitVisionLearning = {
    ANNOTATION_CATEGORIES: ANNOTATION_CATEGORIES,
    LEARNING_PROMPTS: LEARNING_PROMPTS,
    createAnnotationBox: createAnnotationBox,
    createAnnotationRecord: createAnnotationRecord,
    snapshotRegion: snapshotRegion,
    normalizeBox: normalizeBox,
    computeIoU: computeIoU,
    compareAnnotationsToRegions: compareAnnotationsToRegions,
    createLearningStore: createLearningStore,
    createLearningSession: createLearningSession,
    analyzeAll: analyzeAll,
    createSessionLog: createSessionLog,
    formatSessionExport: formatSessionExport,
    STORAGE_KEY: STORAGE_KEY,
    SESSION_STORAGE_KEY: SESSION_STORAGE_KEY
  };

})(typeof self !== 'undefined' ? self : this);
