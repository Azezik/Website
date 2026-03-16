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

  /* ══════════════════════════════════════════════════════════════════════════
     Batch Structural Learning  –  Phase 1
     ══════════════════════════════════════════════════════════════════════════ */

  var BATCH_SESSION_STORAGE_KEY = 'wrokit.learning.batchSessions';

  /* ── Statistical helpers ──────────────────────────────────────────────── */

  function _mean(arr){ return arr.length ? arr.reduce(function(s,v){return s+v;},0)/arr.length : 0; }
  function _variance(arr){
    if(arr.length < 2) return 0;
    var m = _mean(arr);
    return arr.reduce(function(s,v){return s+(v-m)*(v-m);},0)/(arr.length-1);
  }
  function _stddev(arr){ return Math.sqrt(_variance(arr)); }
  function _cv(arr){
    var m = _mean(arr);
    if(m === 0) return arr.length > 1 && _stddev(arr) > 0 ? Infinity : 0;
    return _stddev(arr) / Math.abs(m);
  }
  function _median(arr){
    if(!arr.length) return 0;
    var sorted = arr.slice().sort(function(a,b){return a-b;});
    var mid = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  }
  function _clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  function _cosineSim(a, b){
    if(!a||!b||a.length!==b.length||!a.length) return 0;
    var dot=0, mA=0, mB=0;
    for(var i=0;i<a.length;i++){ dot+=a[i]*b[i]; mA+=a[i]*a[i]; mB+=b[i]*b[i]; }
    var d = Math.sqrt(mA)*Math.sqrt(mB);
    return d>0 ? dot/d : 0;
  }

  function _jsd(p, q){
    if(!p||!q||p.length!==q.length||!p.length) return 1;
    var m = p.map(function(_,i){ return (p[i]+q[i])/2; });
    var klPM=0, klQM=0;
    for(var i=0;i<p.length;i++){
      if(p[i]>0&&m[i]>0) klPM += p[i]*Math.log2(p[i]/m[i]);
      if(q[i]>0&&m[i]>0) klQM += q[i]*Math.log2(q[i]/m[i]);
    }
    return _clamp((klPM+klQM)/2, 0, 1);
  }

  function _cvToStability(cv){ return _clamp(1-cv, 0, 1); }

  /* ── Extract document structural summary ──────────────────────────────── */

  function extractDocumentSummary(analysisResult, opts){
    opts = opts || {};
    var ar = analysisResult || {};
    var regionNodes = ar.regionNodes || [];
    var regionGraph = ar.regionGraph || {nodes:[],edges:[]};
    var textLines = ar.textLines || [];
    var textBlocks = ar.textBlocks || [];
    var textTokens = ar.textTokens || [];
    var surfaceCandidates = ar.surfaceCandidates || [];
    var viewport = ar.viewport || opts.viewport || {width:0,height:0};
    var vpW = Number(viewport.width||viewport.w)||1;
    var vpH = Number(viewport.height||viewport.h)||1;

    var regionDescriptors = regionNodes.map(function(r){
      var bbox = (r.geometry&&r.geometry.bbox)||{};
      var x=Number(bbox.x)||0, y=Number(bbox.y)||0, w=Number(bbox.w)||0, h=Number(bbox.h)||0;
      return {
        regionId: r.id,
        normalizedBbox: {x:clamp01(x/vpW),y:clamp01(y/vpH),w:clamp01(w/vpW),h:clamp01(h/vpH)},
        area: w*h,
        normalizedArea: clamp01((w*h)/(vpW*vpH)),
        aspectRatio: h>0 ? w/h : 0,
        confidence: Number(r.confidence)||0,
        textDensity: Number(r.textDensity)||0,
        surfaceType: r.surfaceTypeCandidate||'unknown',
        features: r.features||{},
        centroid: {x:clamp01((x+w/2)/vpW), y:clamp01((y+h/2)/vpH)}
      };
    });

    var adjacencyEdges = (regionGraph.edges||[]).map(function(e){
      return {sourceId:e.sourceNodeId,targetId:e.targetNodeId,edgeType:e.edgeType,weight:Number(e.weight)||0};
    });

    var neighborhoodMap = {};
    for(var ei=0;ei<adjacencyEdges.length;ei++){
      var e = adjacencyEdges[ei];
      if(!neighborhoodMap[e.sourceId]) neighborhoodMap[e.sourceId]=[];
      if(!neighborhoodMap[e.targetId]) neighborhoodMap[e.targetId]=[];
      neighborhoodMap[e.sourceId].push({neighborId:e.targetId,edgeType:e.edgeType,weight:e.weight});
      neighborhoodMap[e.targetId].push({neighborId:e.sourceId,edgeType:e.edgeType,weight:e.weight});
    }

    // Build region lookup for structural topology encoding
    var regionById = {};
    for(var rli=0;rli<regionDescriptors.length;rli++){ regionById[regionDescriptors[rli].regionId] = regionDescriptors[rli]; }

    var neighborhoodDescriptors = {};
    for(var ri=0;ri<regionDescriptors.length;ri++){
      var rd = regionDescriptors[ri];
      var neighbors = neighborhoodMap[rd.regionId]||[];
      var containsEdges = neighbors.filter(function(n){return n.edgeType==='contains';});
      var proximityEdges = neighbors.filter(function(n){return n.edgeType==='spatial_proximity';});
      var adjacencyEdgesL = neighbors.filter(function(n){return n.edgeType==='spatial_adjacency';});

      // Structural topology: relative positions of neighbors
      var neighborVectors = [];
      for(var nvi=0;nvi<neighbors.length;nvi++){
        var nRegion = regionById[neighbors[nvi].neighborId];
        if(!nRegion) continue;
        var dx = nRegion.centroid.x - rd.centroid.x;
        var dy = nRegion.centroid.y - rd.centroid.y;
        var dist = Math.sqrt(dx*dx+dy*dy);
        var angle = Math.atan2(dy,dx);
        neighborVectors.push({
          neighborId:neighbors[nvi].neighborId, edgeType:neighbors[nvi].edgeType, weight:neighbors[nvi].weight,
          relDx:Math.round(dx*10000)/10000, relDy:Math.round(dy*10000)/10000,
          distance:Math.round(dist*10000)/10000, angle:Math.round(angle*1000)/1000,
          neighborAspectRatio:nRegion.aspectRatio>10?10:Math.round(nRegion.aspectRatio*100)/100,
          neighborNormArea:Math.round(nRegion.normalizedArea*100000)/100000,
          neighborSurfaceType:nRegion.surfaceType
        });
      }
      neighborVectors.sort(function(a,b){return a.angle-b.angle;});

      var edgeTypeDist = {contains:containsEdges.length, spatial_proximity:proximityEdges.length, spatial_adjacency:adjacencyEdgesL.length};

      // Containment context
      var containedBy = [];
      var containsRegions = [];
      for(var ci2=0;ci2<containsEdges.length;ci2++){
        var cNeighbor = regionById[containsEdges[ci2].neighborId];
        if(!cNeighbor) continue;
        if(cNeighbor.normalizedArea > rd.normalizedArea) containedBy.push(containsEdges[ci2].neighborId);
        else containsRegions.push(containsEdges[ci2].neighborId);
      }

      neighborhoodDescriptors[rd.regionId] = {
        neighborCount: neighbors.length,
        avgEdgeWeight: neighbors.length ? neighbors.reduce(function(s,n){return s+n.weight;},0)/neighbors.length : 0,
        containsCount: containsEdges.length,
        proximityCount: proximityEdges.length,
        adjacencyCount: adjacencyEdgesL.length,
        neighborVectors: neighborVectors,
        edgeTypeDist: edgeTypeDist,
        containedBy: containedBy,
        containsRegions: containsRegions,
        containmentDepth: containedBy.length
      };
    }

    var textStructure = {
      lineCount: textLines.length,
      blockCount: textBlocks.length,
      tokenCount: textTokens.length,
      avgTokensPerLine: textLines.length ? textTokens.length/textLines.length : 0,
      avgLinesPerBlock: textBlocks.length ? textLines.length/textBlocks.length : 0,
      blockDescriptors: textBlocks.map(function(b){
        var bb = (b.geometry&&b.geometry.bbox)||{};
        return {
          blockId:b.id,
          normalizedBbox:{x:clamp01((Number(bb.x)||0)/vpW),y:clamp01((Number(bb.y)||0)/vpH),w:clamp01((Number(bb.w)||0)/vpW),h:clamp01((Number(bb.h)||0)/vpH)},
          lineCount:(b.lineIds||[]).length,
          tokenCount:(b.tokenIds||[]).length,
          textLength:(b.text||'').length
        };
      })
    };

    var gridSize = 4;
    var spatialGrid = [];
    for(var g=0;g<gridSize*gridSize;g++) spatialGrid.push(0);
    for(var si=0;si<regionDescriptors.length;si++){
      var srd = regionDescriptors[si];
      var gx = Math.min(gridSize-1, Math.floor(srd.centroid.x*gridSize));
      var gy = Math.min(gridSize-1, Math.floor(srd.centroid.y*gridSize));
      spatialGrid[gy*gridSize+gx] += srd.normalizedArea;
    }
    var gridSum = spatialGrid.reduce(function(s,v){return s+v;},0);
    var normalizedSpatialDistribution = spatialGrid.map(function(v){return gridSum>0?v/gridSum:0;});

    var regionSignatures = regionDescriptors.map(function(rd2){
      var nh = neighborhoodDescriptors[rd2.regionId]||{};
      var feat2 = rd2.features||{};
      return {
        regionId: rd2.regionId,
        featureVector: [
          rd2.normalizedBbox.x, rd2.normalizedBbox.y, rd2.normalizedBbox.w, rd2.normalizedBbox.h,
          rd2.normalizedArea, rd2.aspectRatio>10?10:rd2.aspectRatio,
          rd2.confidence, rd2.textDensity, (nh.neighborCount||0)/10, nh.avgEdgeWeight||0,
          (nh.adjacencyCount||0)/10, (nh.containmentDepth||0)/5,
          feat2.rectangularity||1, feat2.solidity||1
        ],
        spatialBin: Math.min(gridSize-1,Math.floor(rd2.centroid.y*gridSize))*gridSize + Math.min(gridSize-1,Math.floor(rd2.centroid.x*gridSize))
      };
    });

    var surfaceTypeCounts = {};
    for(var sti=0;sti<regionDescriptors.length;sti++){
      var st = regionDescriptors[sti].surfaceType;
      surfaceTypeCounts[st] = (surfaceTypeCounts[st]||0)+1;
    }

    var metrics = {
      regionCount: regionNodes.length,
      edgeCount: adjacencyEdges.length,
      avgRegionArea: regionDescriptors.length ? regionDescriptors.reduce(function(s,r){return s+r.normalizedArea;},0)/regionDescriptors.length : 0,
      avgTextDensity: regionDescriptors.length ? regionDescriptors.reduce(function(s,r){return s+r.textDensity;},0)/regionDescriptors.length : 0,
      avgConfidence: regionDescriptors.length ? regionDescriptors.reduce(function(s,r){return s+r.confidence;},0)/regionDescriptors.length : 0,
      textLineCount: textLines.length,
      textBlockCount: textBlocks.length,
      surfaceCandidateCount: surfaceCandidates.length
    };

    var hasRegions = metrics.regionCount > 0;
    var hasViewport = vpW > 1 && vpH > 1;
    var structurallyValid = hasRegions && hasViewport;
    var validationReason = !hasViewport
      ? 'Missing or zero viewport dimensions'
      : !hasRegions
        ? 'No regions detected — WrokitVision analysis may not have run or the image produced no structural output'
        : '';

    return {
      documentId: opts.documentId || generateId('bdoc'),
      documentName: opts.documentName || '',
      timestamp: new Date().toISOString(),
      viewport: {w:vpW,h:vpH},
      structurallyValid: structurallyValid,
      validationReason: validationReason,
      regionDescriptors: regionDescriptors,
      adjacencyEdges: adjacencyEdges,
      neighborhoodDescriptors: neighborhoodDescriptors,
      textStructure: textStructure,
      surfaceTypeCounts: surfaceTypeCounts,
      normalizedSpatialDistribution: normalizedSpatialDistribution,
      regionSignatures: regionSignatures,
      metrics: metrics
    };
  }

  /* ── Batch stability analysis ─────────────────────────────────────────── */

  function analyzeBatchStability(documents){
    if(!Array.isArray(documents) || documents.length < 2){
      return {
        status: 'insufficient_data',
        message: documents && documents.length === 1
          ? 'Need at least 2 documents. Currently have 1.'
          : 'No documents in this batch session.',
        documentCount: documents ? documents.length : 0,
        validDocumentCount: 0, invalidDocuments: [],
        stabilityMetrics: null, parameterDiagnoses: null, overallStability: null, intermediateData: null
      };
    }

    // Filter to structurally valid documents only
    var validDocs = [], invalidDocs = [];
    for(var vdi=0;vdi<documents.length;vdi++){
      var vdoc = documents[vdi];
      var isValid = vdoc.structurallyValid === true ||
        (vdoc.structurallyValid === undefined &&
         vdoc.metrics && vdoc.metrics.regionCount > 0 &&
         vdoc.viewport && vdoc.viewport.w > 1 && vdoc.viewport.h > 1);
      if(isValid) validDocs.push(vdoc);
      else invalidDocs.push({
        documentId: vdoc.documentId||'(unknown)',
        documentName: vdoc.documentName||'(unnamed)',
        reason: vdoc.validationReason||'No structural outputs (0 regions detected)'
      });
    }

    if(validDocs.length < 2){
      var invMsg = invalidDocs.length > 0
        ? ' ' + invalidDocs.length + ' document(s) excluded (no structural outputs).'
        : '';
      return {
        status: 'insufficient_valid_data',
        message: 'Need at least 2 documents with real structural outputs. Found ' +
          validDocs.length + ' valid out of ' + documents.length + ' total.' + invMsg,
        documentCount: documents.length,
        validDocumentCount: validDocs.length, invalidDocuments: invalidDocs,
        stabilityMetrics: null, parameterDiagnoses: null, overallStability: null, intermediateData: null
      };
    }

    documents = validDocs;

    // Region count stability
    var rcCounts = documents.map(function(d){return d.metrics.regionCount;});
    var rcCV = _cv(rcCounts);
    var regionCount = {
      metric:'region_count', stability:_cvToStability(rcCV), values:rcCounts,
      mean:Math.round(_mean(rcCounts)*100)/100, stddev:Math.round(_stddev(rcCounts)*100)/100,
      cv:Math.round(rcCV*1000)/1000, min:Math.min.apply(null,rcCounts), max:Math.max.apply(null,rcCounts), median:_median(rcCounts)
    };

    // Region area stability
    var raAvgs = documents.map(function(d){return d.metrics.avgRegionArea;});
    var raCV = _cv(raAvgs);
    var regionArea = {
      metric:'region_area', stability:_cvToStability(raCV),
      mean:Math.round(_mean(raAvgs)*10000)/10000, stddev:Math.round(_stddev(raAvgs)*10000)/10000,
      cv:Math.round(raCV*1000)/1000
    };

    // Region density stability
    var rdVals = documents.map(function(d){return d.metrics.avgTextDensity;});
    var rdCV = _cv(rdVals);
    var regionDensity = {
      metric:'region_density', stability:_cvToStability(rdCV), values:rdVals,
      mean:Math.round(_mean(rdVals)*1000)/1000, cv:Math.round(rdCV*1000)/1000
    };

    // Adjacency graph stability
    var egCounts = documents.map(function(d){return d.metrics.edgeCount;});
    var egCV = _cv(egCounts);
    var etDists = documents.map(function(d){
      if(d._adjacencyStats) return d._adjacencyStats.typeDistribution;
      var edges = d.adjacencyEdges || [];
      var types={spatial_proximity:0,contains:0,other:0};
      var total = edges.length||1;
      for(var i=0;i<edges.length;i++){
        var et=edges[i].edgeType;
        if(types.hasOwnProperty(et)) types[et]++; else types.other++;
      }
      return [types.spatial_proximity/total, types.contains/total, types.other/total];
    });
    var totalJSD=0, pc=0;
    for(var i=0;i<etDists.length;i++) for(var j=i+1;j<etDists.length;j++){ totalJSD+=_jsd(etDists[i],etDists[j]); pc++; }
    var avgJSD = pc>0 ? totalJSD/pc : 0;
    var awVals = documents.map(function(d){
      if(d._adjacencyStats) return d._adjacencyStats.avgWeight;
      var edges = d.adjacencyEdges || [];
      if(!edges.length) return 0;
      return edges.reduce(function(s,e){return s+e.weight;},0)/edges.length;
    });
    var awCV = _cv(awVals);
    var ecStab = _cvToStability(egCV), edStab = _clamp(1-avgJSD,0,1), ewStab = _cvToStability(awCV);
    var adjacencyGraph = {
      metric:'adjacency_graph', stability:Math.round((ecStab*0.4+edStab*0.35+ewStab*0.25)*1000)/1000,
      edgeCountStability:Math.round(ecStab*1000)/1000,
      edgeTypeDistributionStability:Math.round(edStab*1000)/1000,
      edgeWeightStability:Math.round(ewStab*1000)/1000,
      edgeCounts:egCounts, avgEdgeTypeJSD:Math.round(avgJSD*1000)/1000
    };

    // Spatial distribution stability
    var spDists = documents.map(function(d){return d.normalizedSpatialDistribution;});
    var totalSim=0, spc=0;
    for(var si=0;si<spDists.length;si++) for(var sj=si+1;sj<spDists.length;sj++){ totalSim+=_cosineSim(spDists[si],spDists[sj]); spc++; }
    var avgSim = spc>0 ? totalSim/spc : 1;
    var spatialDistribution = {
      metric:'spatial_distribution', stability:Math.round(_clamp(avgSim,0,1)*1000)/1000,
      avgPairwiseCosineSimilarity:Math.round(avgSim*1000)/1000
    };

    // Text structure stability
    var tlCounts = documents.map(function(d){return d.textStructure.lineCount;});
    var tbCounts = documents.map(function(d){return d.textStructure.blockCount;});
    var ttCounts = documents.map(function(d){return d.textStructure.tokenCount;});
    var tlS=_cvToStability(_cv(tlCounts)), tbS=_cvToStability(_cv(tbCounts)), ttS=_cvToStability(_cv(ttCounts));
    var textStructure = {
      metric:'text_structure', stability:Math.round((tlS*0.35+tbS*0.35+ttS*0.3)*1000)/1000,
      lineCountStability:Math.round(tlS*1000)/1000, blockCountStability:Math.round(tbS*1000)/1000,
      tokenCountStability:Math.round(ttS*1000)/1000,
      avgLines:Math.round(_mean(tlCounts)*10)/10, avgBlocks:Math.round(_mean(tbCounts)*10)/10
    };

    // Surface type stability
    var allTypes = {};
    for(var di=0;di<documents.length;di++){
      var stc = documents[di].surfaceTypeCounts||{};
      for(var t in stc) if(stc.hasOwnProperty(t)) allTypes[t]=true;
    }
    var typeList = Object.keys(allTypes).sort();
    var stDists = documents.map(function(d){
      var total = 0; for(var t in (d.surfaceTypeCounts||{})) if(d.surfaceTypeCounts.hasOwnProperty(t)) total+=d.surfaceTypeCounts[t];
      total = total||1;
      return typeList.map(function(t){return (d.surfaceTypeCounts[t]||0)/total;});
    });
    var stTotal=0, stPc=0;
    for(var sti=0;sti<stDists.length;sti++) for(var stj=sti+1;stj<stDists.length;stj++){ stTotal+=_cosineSim(stDists[sti],stDists[stj]); stPc++; }
    var stAvg = stPc>0 ? stTotal/stPc : 1;
    var surfaceTypeDistribution = {
      metric:'surface_type_distribution', stability:Math.round(_clamp(stAvg,0,1)*1000)/1000,
      surfaceTypes:typeList, avgPairwiseSimilarity:Math.round(stAvg*1000)/1000
    };

    var stabilityMetrics = {
      regionCount:regionCount, regionArea:regionArea, regionDensity:regionDensity,
      adjacencyGraph:adjacencyGraph, spatialDistribution:spatialDistribution,
      textStructure:textStructure, surfaceTypeDistribution:surfaceTypeDistribution
    };

    // Overall stability
    var weights = {regionCount:0.20,regionArea:0.15,regionDensity:0.10,adjacencyGraph:0.20,spatialDistribution:0.15,textStructure:0.10,surfaceTypeDistribution:0.10};
    var overall = 0;
    for(var wk in weights) if(weights.hasOwnProperty(wk)) overall += (stabilityMetrics[wk].stability||0)*weights[wk];
    overall = Math.round(overall*1000)/1000;

    // Parameter diagnoses
    var diagnoses = [];
    if(regionCount.stability < 0.7){
      diagnoses.push({parameter:'region_segmentation_thresholds',impact:'high',stability:regionCount.stability,
        diagnosis:'Region count varies significantly (CV='+regionCount.cv+').',
        recommendation:'Increase mergeThreshold to reduce over-segmentation sensitivity.',
        suggestedAdjustments:{mergeThreshold:regionCount.cv>0.5?'increase by 20-40%':'increase by 10-20%'}});
    }
    if(regionArea.stability < 0.7 && regionCount.stability > 0.5){
      diagnoses.push({parameter:'color_tolerance',impact:'medium',stability:regionArea.stability,
        diagnosis:'Region areas vary while counts are stable. Color-based boundaries may be shifting.',
        recommendation:'Increase color tolerance for more consistent region boundaries.',
        suggestedAdjustments:{colorTolerance:'increase by 15-25%'}});
    }
    if(adjacencyGraph.stability < 0.7){
      diagnoses.push({parameter:'edge_detection_thresholds',impact:adjacencyGraph.stability<0.5?'high':'medium',stability:adjacencyGraph.stability,
        diagnosis:'Graph structure varies significantly across documents.',
        recommendation:'Adjust hardBarrier threshold to stabilize edge detection.',
        suggestedAdjustments:{hardBarrier:adjacencyGraph.edgeCountStability<0.5?'increase by 20%':'increase by 10%'}});
    }
    if(spatialDistribution.stability < 0.7){
      diagnoses.push({parameter:'region_merge_split_thresholds',impact:'medium',stability:spatialDistribution.stability,
        diagnosis:'Spatial distribution of regions varies across documents.',
        recommendation:'Adjust merge/split thresholds for consistent spatial layouts.',
        suggestedAdjustments:{mergeSensitivity:'reduce by 15%'}});
    }
    if(surfaceTypeDistribution.stability < 0.7){
      diagnoses.push({parameter:'visual_proposal_thresholds',impact:surfaceTypeDistribution.stability<0.5?'high':'medium',stability:surfaceTypeDistribution.stability,
        diagnosis:'Surface type classification varies across documents.',
        recommendation:'Adjust visual proposal confidence thresholds.',
        suggestedAdjustments:{proposalConfidenceMin:'increase to filter low-confidence proposals'}});
    }
    if(textStructure.stability < 0.7){
      diagnoses.push({parameter:'text_grouping_thresholds',impact:'low',stability:textStructure.stability,
        diagnosis:'Text line/block grouping varies across documents.',
        recommendation:'Review line grouping tolerance and block stacking gap threshold.',
        suggestedAdjustments:{lineBandTolerance:textStructure.lineCountStability<0.6?'increase by 20%':'no change'}});
    }
    var impactOrder = {high:0,medium:1,low:2};
    diagnoses.sort(function(a,b){return (impactOrder[a.impact]||3)-(impactOrder[b.impact]||3);});

    var status = 'stable';
    if(overall < 0.5) status = 'unstable';
    else if(overall < 0.7) status = 'moderately_stable';
    else if(overall < 0.85) status = 'mostly_stable';

    var msgs = {
      unstable:'Structural outputs are highly inconsistent. Multiple parameters need adjustment.',
      moderately_stable:'Moderate inconsistency detected. Some parameters may need tuning.',
      mostly_stable:'Mostly consistent. Minor adjustments may improve stability.',
      stable:'Consistent structural outputs. Parameters are well-tuned for this document type.'
    };

    var intermediateData = {
      perDocumentMetrics: documents.map(function(d){
        var sigs = d.regionSignatures || [];
        return {documentId:d.documentId,documentName:d.documentName,metrics:d.metrics,
          normalizedSpatialDistribution:d.normalizedSpatialDistribution,regionSignatureCount:sigs.length};
      }),
      batchRegionSignatures: [],
      batchSpatialDistributions: documents.map(function(d){
        return {documentId:d.documentId,distribution:d.normalizedSpatialDistribution};
      })
    };
    for(var bdi=0;bdi<documents.length;bdi++){
      var bdoc = documents[bdi];
      var bdocSigs = bdoc.regionSignatures || [];
      for(var bri=0;bri<bdocSigs.length;bri++){
        var rs = bdocSigs[bri];
        intermediateData.batchRegionSignatures.push({documentId:bdoc.documentId,regionId:rs.regionId,featureVector:rs.featureVector,spatialBin:rs.spatialBin});
      }
    }

    return {
      status:status, message:msgs[status], documentCount:documents.length,
      validDocumentCount:validDocs.length, invalidDocuments:invalidDocs,
      analyzedAt:new Date().toISOString(), overallStability:overall,
      stabilityMetrics:stabilityMetrics, parameterDiagnoses:diagnoses, intermediateData:intermediateData
    };
  }

  /* ── Report formatter ─────────────────────────────────────────────────── */

  function formatStabilityReport(report){
    if(!report) return '[No report data]';
    if(report.status === 'insufficient_data' || report.status === 'insufficient_valid_data') return report.message;
    var out = '';
    out += '══════════════════════════════════════════════════════════════\n';
    out += '  BATCH STRUCTURAL STABILITY REPORT\n';
    out += '══════════════════════════════════════════════════════════════\n\n';
    out += '  Status: ' + report.status.toUpperCase() + '\n';
    out += '  Overall Stability: ' + (report.overallStability*100).toFixed(1) + '%\n';
    out += '  Documents analyzed: ' + report.documentCount + '\n';
    if(report.invalidDocuments && report.invalidDocuments.length > 0){
      out += '  Documents excluded (invalid): ' + report.invalidDocuments.length + '\n';
    }
    out += '  Analyzed at: ' + report.analyzedAt + '\n\n';
    out += '  ' + report.message + '\n';
    if(report.invalidDocuments && report.invalidDocuments.length > 0){
      out += '\n  EXCLUDED DOCUMENTS:\n';
      for(var ivi=0;ivi<report.invalidDocuments.length;ivi++){
        var inv = report.invalidDocuments[ivi];
        out += '    - ' + (inv.documentName||inv.documentId) + ': ' + inv.reason + '\n';
      }
    }
    out += '\n──────────────────────────────────────────────────────────────\n';
    out += '  STABILITY METRICS\n';
    out += '──────────────────────────────────────────────────────────────\n\n';
    var metrics = report.stabilityMetrics;
    if(metrics){
      var names = {regionCount:'Region Count',regionArea:'Region Area',regionDensity:'Region Density',
        adjacencyGraph:'Adjacency Graph',spatialDistribution:'Spatial Distribution',
        textStructure:'Text Structure',surfaceTypeDistribution:'Surface Type Distribution'};
      for(var mk in names){
        if(!names.hasOwnProperty(mk)||!metrics[mk]) continue;
        var pct = (metrics[mk].stability*100).toFixed(1);
        var filled = Math.round(metrics[mk].stability*20);
        var bar = '[' + Array(filled+1).join('\u2588') + Array(21-filled).join('\u2591') + ']';
        out += '  ' + (names[mk]+'                            ').slice(0,28) + bar + '  ' + pct + '%\n';
      }
    }
    if(report.parameterDiagnoses && report.parameterDiagnoses.length){
      out += '\n──────────────────────────────────────────────────────────────\n';
      out += '  PARAMETER DIAGNOSES & RECOMMENDATIONS\n';
      out += '──────────────────────────────────────────────────────────────\n';
      for(var pi=0;pi<report.parameterDiagnoses.length;pi++){
        var d = report.parameterDiagnoses[pi];
        out += '\n  [' + d.impact.toUpperCase() + ' IMPACT] ' + d.parameter.replace(/_/g,' ') + '\n';
        out += '    Stability: ' + (d.stability*100).toFixed(1) + '%\n';
        out += '    Diagnosis: ' + d.diagnosis + '\n';
        out += '    Recommendation: ' + d.recommendation + '\n';
        if(d.suggestedAdjustments){
          out += '    Suggested adjustments:\n';
          for(var ak in d.suggestedAdjustments){
            if(d.suggestedAdjustments.hasOwnProperty(ak)) out += '      '+ak+': '+d.suggestedAdjustments[ak]+'\n';
          }
        }
      }
    } else {
      out += '\n  No parameter issues detected. Parameters are well-tuned.\n';
    }
    out += '\n══════════════════════════════════════════════════════════════\n';
    return out;
  }

  /* ── Compact storage helper ───────────────────────────────────────────── */

  function compactForStorage(doc) {
    if (!doc) return doc;
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
      },
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
      _compact: true
    };
  }

  /* ── Batch session store ──────────────────────────────────────────────── */

  function createBatchSessionStore(storage){
    var backend = storage || (function(){
      var m = {};
      return {getItem:function(k){return m[k]||null;},setItem:function(k,v){m[k]=v;}};
    })();

    var _memDocs = {};
    var _memCorrespondence = {};

    function _load(){
      try { var raw=backend.getItem(BATCH_SESSION_STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
      catch(_e){ return []; }
    }
    function _save(sessions){
      try { backend.setItem(BATCH_SESSION_STORAGE_KEY, JSON.stringify(sessions)); }
      catch(e){ console.warn('[BatchSessionStore] localStorage write failed:', e.message || e); }
    }

    return {
      createSession: function(opts){
        opts = opts||{};
        var sessions = _load();
        var session = {
          sessionId:generateId('bsess'), name:String(opts.name||'Untitled Batch'),
          description:String(opts.description||''), createdAt:new Date().toISOString(),
          updatedAt:new Date().toISOString(), documents:[], stabilityReport:null, status:'open'
        };
        sessions.push(session);
        _memDocs[session.sessionId] = [];
        _save(sessions);
        return session;
      },
      getAllSessions: function(){ return _load(); },
      getSession: function(sessionId){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;})||null;
        if(!session) return null;
        if(_memDocs[sessionId] && _memDocs[sessionId].length){
          session.documents = _memDocs[sessionId];
        }
        if(_memCorrespondence[sessionId]){
          session.correspondenceResult = _memCorrespondence[sessionId];
        }
        return session;
      },
      addDocument: function(sessionId, docSummary){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;});
        if(!session) return null;
        if(!_memDocs[sessionId]) _memDocs[sessionId] = [];
        _memDocs[sessionId].push(docSummary);
        session.documents.push(compactForStorage(docSummary));
        session.updatedAt = new Date().toISOString();
        _save(sessions);
        return docSummary.documentId;
      },
      removeDocument: function(sessionId, documentId){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;});
        if(!session) return false;
        var idx = -1;
        for(var i=0;i<session.documents.length;i++){ if(session.documents[i].documentId===documentId){idx=i;break;} }
        if(idx<0) return false;
        session.documents.splice(idx,1);
        session.updatedAt = new Date().toISOString();
        _save(sessions);
        if(_memDocs[sessionId]){
          var mIdx = -1;
          for(var j=0;j<_memDocs[sessionId].length;j++){ if(_memDocs[sessionId][j].documentId===documentId){mIdx=j;break;} }
          if(mIdx>=0) _memDocs[sessionId].splice(mIdx,1);
        }
        return true;
      },
      saveStabilityReport: function(sessionId, report){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;});
        if(!session) return false;
        var persistReport = report;
        if(report && report.intermediateData){
          persistReport = {};
          for(var rk in report) if(report.hasOwnProperty(rk)) persistReport[rk] = report[rk];
          persistReport.intermediateData = null;
        }
        session.stabilityReport = persistReport;
        session.updatedAt = new Date().toISOString();
        _save(sessions);
        return true;
      },
      saveCorrespondenceResult: function(sessionId, result){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;});
        if(!session) return false;
        if(result){ _memCorrespondence[sessionId] = result; }
        var persistResult = result;
        if(result && result.correspondences && result.correspondences.length > 50){
          persistResult = {};
          for(var ck in result) if(result.hasOwnProperty(ck)) persistResult[ck] = result[ck];
          persistResult.correspondences = null;
          persistResult._correspondencesStripped = true;
        }
        session.correspondenceResult = persistResult;
        session.updatedAt = new Date().toISOString();
        _save(sessions);
        return true;
      },
      saveGeometryProfiles: function(sessionId, profiles){
        var sessions = _load();
        var session = sessions.find(function(s){return s.sessionId===sessionId;});
        if(!session) return false;
        session.geometryProfiles = profiles;
        session.updatedAt = new Date().toISOString();
        _save(sessions);
        return true;
      },
      deleteSession: function(sessionId){
        var sessions = _load().filter(function(s){return s.sessionId!==sessionId;});
        _save(sessions);
        delete _memDocs[sessionId];
        delete _memCorrespondence[sessionId];
      },
      documentCount: function(sessionId){
        if(_memDocs[sessionId]) return _memDocs[sessionId].length;
        var session = this.getSession(sessionId);
        return session ? session.documents.length : 0;
      },
      clear: function(){ _save([]); for(var k in _memDocs) delete _memDocs[k]; }
    };
  }

  /* ── Phase 2: Structural Correspondence ────────────────────────────────── */

  function _euclideanDist(a,b){
    var sum=0;for(var i=0;i<a.length;i++){var d=(a[i]||0)-(b[i]||0);sum+=d*d;}
    return Math.sqrt(sum);
  }

  function _cosineSim(a,b){
    if(!a||!b||a.length!==b.length||a.length===0)return 0;
    var dot=0,magA=0,magB=0;
    for(var i=0;i<a.length;i++){dot+=a[i]*b[i];magA+=a[i]*a[i];magB+=b[i]*b[i];}
    var d=Math.sqrt(magA)*Math.sqrt(magB);return d>0?dot/d:0;
  }

  function _mean(arr){return arr.length?arr.reduce(function(s,v){return s+v;},0)/arr.length:0;}
  function _round(v,dec){var f=Math.pow(10,dec||3);return Math.round(v*f)/f;}
  function _clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}

  function selectReferenceDocument(documents){
    if(!documents||!documents.length)return null;
    if(documents.length===1){
      return {documentId:documents[0].documentId,documentName:documents[0].documentName||'',centralityScore:1,scores:[{documentId:documents[0].documentId,avgSimilarity:1}]};
    }
    var fvs=documents.map(function(d){
      var sd=d.normalizedSpatialDistribution||[];var m=d.metrics||{};
      return sd.concat([(m.regionCount||0)/50,m.avgRegionArea||0,m.avgTextDensity||0,m.avgConfidence||0,(m.edgeCount||0)/100]);
    });
    var scores=[];
    for(var i=0;i<documents.length;i++){
      var ts=0,cnt=0;
      for(var j=0;j<documents.length;j++){if(i===j)continue;ts+=_cosineSim(fvs[i],fvs[j]);cnt++;}
      scores.push({documentId:documents[i].documentId,documentName:documents[i].documentName||'',avgSimilarity:cnt>0?ts/cnt:0});
    }
    scores.sort(function(a,b){return b.avgSimilarity-a.avgSimilarity;});
    var best=scores[0];
    return {documentId:best.documentId,documentName:best.documentName,centralityScore:_round(best.avgSimilarity),
      scores:scores.map(function(s){return{documentId:s.documentId,documentName:s.documentName,avgSimilarity:_round(s.avgSimilarity)};})};
  }

  function computeRegionSimilarity(rA,rB,nhA,nhB){
    nhA=nhA||{};nhB=nhB||{};
    // Position similarity
    var posDist=Math.sqrt(Math.pow(rA.centroid.x-rB.centroid.x,2)+Math.pow(rA.centroid.y-rB.centroid.y,2));
    var posSim=_clamp(1-posDist/1.414,0,1);
    // Shape similarity: aspect ratio + rectangularity + solidity
    var arA=Math.min(rA.aspectRatio,10),arB=Math.min(rB.aspectRatio,10);
    var aspectSim=_clamp(1-Math.abs(arA-arB)/Math.max(arA,arB,0.1),0,1);
    var fA=rA.features||{},fB=rB.features||{};
    var rectSim=1-Math.abs((fA.rectangularity||1)-(fB.rectangularity||1));
    var solidSim=1-Math.abs((fA.solidity||1)-(fB.solidity||1));
    var shapeSim=_clamp(aspectSim*0.5+rectSim*0.25+solidSim*0.25,0,1);
    // Size similarity
    var areaDiff=Math.abs(rA.normalizedArea-rB.normalizedArea);var maxArea=Math.max(rA.normalizedArea,rB.normalizedArea,0.001);
    var sizeSim=_clamp(1-areaDiff/maxArea,0,1);
    // Dimension similarity
    var dimSim=_clamp(1-(Math.abs(rA.normalizedBbox.w-rB.normalizedBbox.w)+Math.abs(rA.normalizedBbox.h-rB.normalizedBbox.h)),0,1);
    // Structural topology similarity (enhanced)
    var ncA=nhA.neighborCount||0,ncB=nhB.neighborCount||0;
    var neighborCountSim=1-Math.abs(ncA-ncB)/Math.max(ncA,ncB,1);
    var edgeWeightSim=1-Math.abs((nhA.avgEdgeWeight||0)-(nhB.avgEdgeWeight||0));
    var edgeTypeSim=1;
    if(nhA.edgeTypeDist&&nhB.edgeTypeDist){
      var dA=nhA.edgeTypeDist,dB=nhB.edgeTypeDist;
      var tA=(dA.contains||0)+(dA.spatial_proximity||0)+(dA.spatial_adjacency||0);
      var tB=(dB.contains||0)+(dB.spatial_proximity||0)+(dB.spatial_adjacency||0);
      if(tA>0&&tB>0){
        var cS=1-Math.abs((dA.contains||0)/tA-(dB.contains||0)/tB);
        var pS=1-Math.abs((dA.spatial_proximity||0)/tA-(dB.spatial_proximity||0)/tB);
        var aS=1-Math.abs((dA.spatial_adjacency||0)/tA-(dB.spatial_adjacency||0)/tB);
        edgeTypeSim=(cS+pS+aS)/3;
      }
    }
    var depthA=nhA.containmentDepth||0,depthB=nhB.containmentDepth||0;
    var depthSim=1-Math.abs(depthA-depthB)/Math.max(depthA,depthB,1);
    var topoSim=_clamp(neighborCountSim*0.25+edgeWeightSim*0.15+edgeTypeSim*0.35+depthSim*0.25,0,1);
    // Semantic similarity (text-based signals down-weighted)
    var confSim=1-Math.abs(rA.confidence-rB.confidence);
    var typeSim=rA.surfaceType===rB.surfaceType?1:0.3;
    var tdSim=1-Math.abs(rA.textDensity-rB.textDensity);
    var semSim=_clamp(typeSim*0.5+confSim*0.35+tdSim*0.15,0,1);
    // Structure-first weighted combination
    var combined=posSim*0.25+shapeSim*0.15+sizeSim*0.10+dimSim*0.10+topoSim*0.25+semSim*0.15;
    return {similarity:_round(combined,4),dimensions:{position:_round(posSim,4),shape:_round(shapeSim,4),size:_round(sizeSim,4),dimension:_round(dimSim,4),topology:_round(topoSim,4),semantic:_round(semSim,4)}};
  }

  function matchDocumentRegions(refDoc,targetDoc,opts){
    opts=opts||{};var minSim=opts.minSimilarity||0.4;
    var rr=refDoc.regionDescriptors||[],tr=targetDoc.regionDescriptors||[];
    var rnh=refDoc.neighborhoodDescriptors||{},tnh=targetDoc.neighborhoodDescriptors||{};
    if(!rr.length||!tr.length)return[];
    var cands=[];
    for(var ri=0;ri<rr.length;ri++){for(var ti=0;ti<tr.length;ti++){
      var sim=computeRegionSimilarity(rr[ri],tr[ti],rnh[rr[ri].regionId],tnh[tr[ti].regionId]);
      if(sim.similarity>=minSim)cands.push({refId:rr[ri].regionId,tgtId:tr[ti].regionId,sim:sim.similarity,dims:sim.dimensions});
    }}
    cands.sort(function(a,b){return b.sim-a.sim;});
    var usedR={},usedT={},matches=[];
    for(var ci=0;ci<cands.length;ci++){
      var c=cands[ci];if(usedR[c.refId]||usedT[c.tgtId])continue;
      usedR[c.refId]=true;usedT[c.tgtId]=true;
      matches.push({refRegionId:c.refId,tgtRegionId:c.tgtId,tgtDocumentId:targetDoc.documentId,tgtDocumentName:targetDoc.documentName||'',similarity:c.sim,dimensions:c.dims});
    }
    return matches;
  }

  function analyzeCorrespondence(documents,opts){
    opts=opts||{};var minSim=opts.minSimilarity||0.4;var anchorMinFreq=opts.anchorMinFrequency||0.5;
    if(!Array.isArray(documents)||documents.length<2){
      return{status:'insufficient_data',message:documents&&documents.length===1?'Need at least 2 documents.':'No documents provided.',
        referenceDocument:null,correspondences:[],anchors:[],alignmentModel:null,analyzedAt:new Date().toISOString()};
    }
    var validDocs=[],skippedDocs=[];
    for(var di=0;di<documents.length;di++){
      var doc=documents[di];
      if(doc.structurallyValid!==false&&doc.regionDescriptors&&doc.regionDescriptors.length>0&&!doc._compact){validDocs.push(doc);}
      else{skippedDocs.push({documentId:doc.documentId||'(unknown)',documentName:doc.documentName||'(unnamed)',
        reason:doc._compact?'Compact summary — re-upload document':doc.structurallyValid===false?(doc.validationReason||'Not valid'):'No region descriptors'});}
    }
    if(validDocs.length<2){
      return{status:'insufficient_valid_data',message:'Need at least 2 documents with full structural data. Found '+validDocs.length+' valid out of '+documents.length+'.',
        skippedDocuments:skippedDocs,referenceDocument:null,correspondences:[],anchors:[],alignmentModel:null,analyzedAt:new Date().toISOString()};
    }
    var refSel;
    if(opts.referenceDocumentId){
      var fr=validDocs.find(function(d){return d.documentId===opts.referenceDocumentId;});
      refSel=fr?{documentId:fr.documentId,documentName:fr.documentName||'',centralityScore:null,scores:null}:selectReferenceDocument(validDocs);
    }else{refSel=selectReferenceDocument(validDocs);}
    var refDoc=validDocs.find(function(d){return d.documentId===refSel.documentId;});
    var otherDocs=validDocs.filter(function(d){return d.documentId!==refDoc.documentId;});
    var allCorr=[];
    for(var oi=0;oi<otherDocs.length;oi++){
      var ms=matchDocumentRegions(refDoc,otherDocs[oi],{minSimilarity:minSim});
      for(var mi=0;mi<ms.length;mi++)allCorr.push(ms[mi]);
    }
    var refRegions=refDoc.regionDescriptors||[];var refNH=refDoc.neighborhoodDescriptors||{};
    var anchorCands={};
    for(var ri=0;ri<refRegions.length;ri++){
      var rr=refRegions[ri];
      anchorCands[rr.regionId]={refRegionId:rr.regionId,normalizedBbox:rr.normalizedBbox,centroid:rr.centroid,
        normalizedArea:rr.normalizedArea,aspectRatio:rr.aspectRatio,surfaceType:rr.surfaceType,
        textDensity:rr.textDensity,confidence:rr.confidence,neighborhoodDescriptor:refNH[rr.regionId]||{},
        matchedDocuments:[],matchSimilarities:[],matchDimensions:[]};
    }
    for(var ci=0;ci<allCorr.length;ci++){
      var corr=allCorr[ci];var ac=anchorCands[corr.refRegionId];
      if(ac){ac.matchedDocuments.push(corr.tgtDocumentId);ac.matchSimilarities.push(corr.similarity);ac.matchDimensions.push(corr.dimensions);}
    }
    var totalOther=otherDocs.length;var anchors=[];
    for(var regionId in anchorCands){
      if(!anchorCands.hasOwnProperty(regionId))continue;
      var a=anchorCands[regionId];var freq=totalOther>0?a.matchedDocuments.length/totalOther:0;
      if(freq>=anchorMinFreq){
        var avgSim=_mean(a.matchSimilarities);
        var avgDims={};
        if(a.matchDimensions.length>0){var dks=Object.keys(a.matchDimensions[0]);
          for(var dki=0;dki<dks.length;dki++){var dk=dks[dki];avgDims[dk]=_round(_mean(a.matchDimensions.map(function(md){return md[dk]||0;})),4);}
        }
        anchors.push({anchorId:'anchor-'+regionId,refRegionId:a.refRegionId,normalizedPosition:a.centroid,normalizedBbox:a.normalizedBbox,
          normalizedArea:a.normalizedArea,aspectRatio:_round(a.aspectRatio,4),surfaceType:a.surfaceType,textDensity:_round(a.textDensity,4),
          frequency:_round(freq,4),matchCount:a.matchedDocuments.length,totalDocuments:totalOther,
          avgSimilarity:_round(avgSim,4),avgDimensions:avgDims,confidence:_round(_clamp(freq*0.5+avgSim*0.5,0,1),4),matchedDocumentIds:a.matchedDocuments});
      }
    }
    anchors.sort(function(a,b){return b.confidence-a.confidence;});
    var am={referenceDocumentId:refDoc.documentId,referenceDocumentName:refDoc.documentName||'',
      anchorCount:anchors.length,totalRegionsInReference:refRegions.length,
      anchorCoverage:refRegions.length>0?_round(anchors.length/refRegions.length,4):0,
      avgAnchorConfidence:anchors.length>0?_round(_mean(anchors.map(function(a){return a.confidence;})),4):0,
      avgAnchorFrequency:anchors.length>0?_round(_mean(anchors.map(function(a){return a.frequency;})),4):0,
      documentCount:validDocs.length,anchors:anchors,createdAt:new Date().toISOString()};
    var status='complete',message='';
    if(anchors.length===0){status='no_anchors_found';message='No recurring structural anchors found across the batch.';}
    else if(am.avgAnchorConfidence<0.5){status='low_confidence';message='Correspondences found but with low confidence.';}
    else{message='Discovered '+anchors.length+' structural anchor(s) across '+validDocs.length+' documents with '+_round(am.avgAnchorConfidence*100,1)+'% avg confidence.';}
    return{status:status,message:message,analyzedAt:new Date().toISOString(),documentCount:documents.length,
      validDocumentCount:validDocs.length,skippedDocuments:skippedDocs,
      referenceDocument:{documentId:refSel.documentId,documentName:refSel.documentName,centralityScore:refSel.centralityScore,centralityScores:refSel.scores},
      correspondences:allCorr,anchors:anchors,alignmentModel:am};
  }

  function formatCorrespondenceReport(result){
    if(!result)return'[No correspondence data]';
    if(result.status==='insufficient_data'||result.status==='insufficient_valid_data')return result.message;
    var out='';
    out+='══════════════════════════════════════════════════════════════\n';
    out+='  STRUCTURAL CORRESPONDENCE REPORT (Phase 2)\n';
    out+='══════════════════════════════════════════════════════════════\n\n';
    out+='  Status: '+result.status.toUpperCase().replace(/_/g,' ')+'\n';
    out+='  Documents analyzed: '+result.validDocumentCount+(result.skippedDocuments&&result.skippedDocuments.length>0?' ('+result.skippedDocuments.length+' skipped)':'')+'\n';
    out+='  Analyzed at: '+result.analyzedAt+'\n\n';
    out+='  '+result.message+'\n';
    if(result.skippedDocuments&&result.skippedDocuments.length>0){
      out+='\n  SKIPPED DOCUMENTS:\n';
      for(var si=0;si<result.skippedDocuments.length;si++){var sd=result.skippedDocuments[si];out+='    - '+(sd.documentName||sd.documentId)+': '+sd.reason+'\n';}
    }
    if(result.referenceDocument){
      out+='\n──────────────────────────────────────────────────────────────\n  REFERENCE DOCUMENT\n──────────────────────────────────────────────────────────────\n\n';
      out+='  Selected: '+(result.referenceDocument.documentName||result.referenceDocument.documentId)+'\n';
      if(result.referenceDocument.centralityScore!=null)out+='  Centrality Score: '+(result.referenceDocument.centralityScore*100).toFixed(1)+'%\n';
    }
    if(result.anchors&&result.anchors.length>0){
      out+='\n──────────────────────────────────────────────────────────────\n  STRUCTURAL ANCHORS ('+result.anchors.length+' discovered)\n──────────────────────────────────────────────────────────────\n';
      for(var ai=0;ai<result.anchors.length;ai++){
        var a=result.anchors[ai];
        out+='\n  Anchor '+(ai+1)+': '+a.anchorId+'\n';
        out+='    Position: ('+(a.normalizedPosition.x*100).toFixed(1)+'%, '+(a.normalizedPosition.y*100).toFixed(1)+'%)\n';
        out+='    Size: '+(a.normalizedArea*100).toFixed(2)+'% of page\n';
        out+='    Type: '+a.surfaceType+'\n';
        out+='    Frequency: '+a.matchCount+'/'+a.totalDocuments+' ('+(a.frequency*100).toFixed(0)+'%)\n';
        var filled=Math.round(a.confidence*20);
        out+='    Confidence: ['+'\u2588'.repeat(filled)+'\u2591'.repeat(20-filled)+']  '+(a.confidence*100).toFixed(1)+'%\n';
        out+='    Avg Similarity: '+(a.avgSimilarity*100).toFixed(1)+'%\n';
      }
    }else{out+='\n  No structural anchors discovered.\n';}
    if(result.alignmentModel){
      var am=result.alignmentModel;
      out+='\n──────────────────────────────────────────────────────────────\n  TEMPLATE ALIGNMENT MODEL\n──────────────────────────────────────────────────────────────\n\n';
      out+='  Anchors: '+am.anchorCount+' / '+am.totalRegionsInReference+' reference regions\n';
      out+='  Anchor Coverage: '+(am.anchorCoverage*100).toFixed(1)+'%\n';
      out+='  Avg Anchor Confidence: '+(am.avgAnchorConfidence*100).toFixed(1)+'%\n';
      out+='  Avg Anchor Frequency: '+(am.avgAnchorFrequency*100).toFixed(1)+'%\n';
    }
    out+='\n══════════════════════════════════════════════════════════════\n';
    return out;
  }

  /* ── Phase 2B: Anchor Refinement + BBOX-Guided Extraction ──────────────── */

  function _normBoxCenter(nb){return{x:nb.x0n+nb.wN/2,y:nb.y0n+nb.hN/2};}
  function _normBoxIoU(a,b){
    var ax1=a.x0n+a.wN,ay1=a.y0n+a.hN,bx1=b.x0n+b.wN,by1=b.y0n+b.hN;
    var ix0=Math.max(a.x0n,b.x0n),iy0=Math.max(a.y0n,b.y0n),ix1=Math.min(ax1,bx1),iy1=Math.min(ay1,by1);
    if(ix1<=ix0||iy1<=iy0)return 0;
    var inter=(ix1-ix0)*(iy1-iy0),union=a.wN*a.hN+b.wN*b.hN-inter;
    return union>0?inter/union:0;
  }
  function _pointDist(a,b){return Math.sqrt(Math.pow(a.x-b.x,2)+Math.pow(a.y-b.y,2));}

  function computeTargetNeighborhood(target,refDoc){
    var nb=target.normBox,tc=_normBoxCenter(nb),regions=refDoc.regionDescriptors||[],nhDescs=refDoc.neighborhoodDescriptors||{};
    var neighbors=[],containingRegions=[];
    for(var i=0;i<regions.length;i++){
      var r=regions[i],rNb={x0n:r.normalizedBbox.x,y0n:r.normalizedBbox.y,wN:r.normalizedBbox.w,hN:r.normalizedBbox.h};
      var dist=_pointDist(tc,r.centroid),overlap=_normBoxIoU(nb,rNb);
      // Check containment
      var regionContainsBbox=rNb.x0n<=nb.x0n&&rNb.y0n<=nb.y0n&&(rNb.x0n+rNb.wN)>=(nb.x0n+nb.wN)&&(rNb.y0n+rNb.hN)>=(nb.y0n+nb.hN);
      var prox=_clamp(1-dist/0.5,0,1),overlapS=overlap>0?0.5+overlap*0.5:0,combined=Math.max(prox,overlapS);
      if(combined>0.05){
        var dx=r.centroid.x-tc.x,dy=r.centroid.y-tc.y,angle=Math.atan2(dy,dx);
        var nhDesc=nhDescs[r.regionId]||{};
        neighbors.push({regionId:r.regionId,centroid:r.centroid,normalizedBbox:r.normalizedBbox,
          normalizedArea:r.normalizedArea,aspectRatio:r.aspectRatio,surfaceType:r.surfaceType,textDensity:r.textDensity,confidence:r.confidence,
          distance:_round(dist,4),overlap:_round(overlap,4),proximity:_round(combined,4),neighborhoodDescriptor:nhDesc,
          relDx:_round(dx,4),relDy:_round(dy,4),angle:_round(angle,3),containsBbox:regionContainsBbox,
          containmentDepth:nhDesc.containmentDepth||0,edgeTypeDist:nhDesc.edgeTypeDist||{}});
      }
      if(regionContainsBbox)containingRegions.push({regionId:r.regionId,normalizedArea:r.normalizedArea,aspectRatio:r.aspectRatio,surfaceType:r.surfaceType,normalizedBbox:r.normalizedBbox});
    }
    neighbors.sort(function(a,b){return b.proximity-a.proximity;});
    containingRegions.sort(function(a,b){return a.normalizedArea-b.normalizedArea;});
    // Structural fingerprint: top-N neighbors sorted by angle
    var topN=Math.min(neighbors.length,8),structuralFingerprint=[];
    for(var si=0;si<topN;si++){
      var sn=neighbors[si];
      structuralFingerprint.push({relDx:sn.relDx,relDy:sn.relDy,angle:sn.angle,distance:sn.distance,
        normalizedArea:sn.normalizedArea,aspectRatio:_round(Math.min(sn.aspectRatio||0,10),2),surfaceType:sn.surfaceType,containsBbox:sn.containsBbox});
    }
    structuralFingerprint.sort(function(a,b){return a.angle-b.angle;});
    return{fieldKey:target.fieldKey,targetCenter:tc,targetNormBox:nb,neighborCount:neighbors.length,neighbors:neighbors,
      containingRegions:containingRegions,innermostContainer:containingRegions.length>0?containingRegions[0]:null,
      structuralFingerprint:structuralFingerprint,
      avgDistance:neighbors.length>0?_round(_mean(neighbors.map(function(n){return n.distance;})),4):0,
      avgTextDensity:neighbors.length>0?_round(_mean(neighbors.map(function(n){return n.textDensity;})),4):0,
      overlappingRegionCount:neighbors.filter(function(n){return n.overlap>0;}).length};
  }

  function scoreAnchorRelevance(anchor,neighborhoods){
    var bestScore=0,bestKey=null,allDetails=[];
    for(var ni=0;ni<neighborhoods.length;ni++){
      var nh=neighborhoods[ni],tc=nh.targetCenter,ac=anchor.normalizedPosition;
      var dist=_pointDist(tc,ac),proxS=_clamp(1-dist/0.4,0,1);
      var anb={x0n:anchor.normalizedBbox.x,y0n:anchor.normalizedBbox.y,wN:anchor.normalizedBbox.w,hN:anchor.normalizedBbox.h};
      var overlap=_normBoxIoU(nh.targetNormBox,anb),overlapS=overlap>0?0.3+overlap*0.7:0;
      var isMember=false;
      for(var j=0;j<nh.neighbors.length;j++){if(nh.neighbors[j].regionId===anchor.refRegionId){isMember=true;break;}}
      var memberS=isMember?0.8:0;
      var sizeP=1;if(anchor.normalizedArea>0.15)sizeP=_clamp(1-(anchor.normalizedArea-0.15)/0.35,0.2,1);
      var stabB=anchor.confidence*0.3;
      var local=(proxS*0.30+overlapS*0.20+memberS*0.25+stabB*0.25)*sizeP;
      allDetails.push({targetFieldKey:nh.fieldKey,proximity:_round(proxS,4),overlap:_round(overlapS,4),membership:_round(memberS,4),sizePenalty:_round(sizeP,4),stabilityBonus:_round(stabB,4),localRelevance:_round(local,4)});
      if(local>bestScore){bestScore=local;bestKey=nh.fieldKey;}
    }
    return{relevanceScore:_round(bestScore,4),bestTargetKey:bestKey,details:allDetails};
  }

  function refineAnchors(correspondenceResult,extractionTargets,refDoc,opts){
    opts=opts||{};var relThresh=opts.relevanceThreshold||0.15;
    if(!correspondenceResult||!correspondenceResult.anchors)return{status:'no_correspondence',message:'No Phase 2 correspondence results.',refinedAnchors:[],removedAnchors:[],extractionTargets:extractionTargets||[],targetNeighborhoods:[],refinedAlignmentModel:null};
    if(!extractionTargets||extractionTargets.length===0)return{status:'no_targets',message:'No extraction targets.',refinedAnchors:[],removedAnchors:[],extractionTargets:[],targetNeighborhoods:[],refinedAlignmentModel:null};
    var neighborhoods=[];
    for(var ti=0;ti<extractionTargets.length;ti++)neighborhoods.push(computeTargetNeighborhood(extractionTargets[ti],refDoc));
    var anchors=correspondenceResult.anchors,refined=[],removed=[];
    for(var ai=0;ai<anchors.length;ai++){
      var a=anchors[ai],scoring=scoreAnchorRelevance(a,neighborhoods);
      var ea={};for(var k in a)if(a.hasOwnProperty(k))ea[k]=a[k];
      ea.relevanceScore=scoring.relevanceScore;ea.bestTargetKey=scoring.bestTargetKey;ea.relevanceDetails=scoring.details;
      if(scoring.relevanceScore>=relThresh)refined.push(ea);else removed.push(ea);
    }
    refined.sort(function(a,b){return b.relevanceScore-a.relevanceScore;});
    var rm={referenceDocumentId:correspondenceResult.referenceDocument.documentId,referenceDocumentName:correspondenceResult.referenceDocument.documentName,
      anchorCount:refined.length,removedCount:removed.length,originalCount:anchors.length,
      anchorRetentionRate:anchors.length>0?_round(refined.length/anchors.length,4):0,
      avgRelevanceScore:refined.length>0?_round(_mean(refined.map(function(a){return a.relevanceScore;})),4):0,
      avgConfidence:refined.length>0?_round(_mean(refined.map(function(a){return a.confidence;})),4):0,
      extractionTargetCount:extractionTargets.length,anchors:refined,createdAt:new Date().toISOString()};
    var status='refined',message='';
    if(refined.length===0){status='no_relevant_anchors';message='No anchors relevant to the extraction targets.';}
    else{message='Refined from '+anchors.length+' to '+refined.length+' anchors. Removed '+removed.length+'. Avg relevance: '+_round(rm.avgRelevanceScore*100,1)+'%.';}
    return{status:status,message:message,refinedAnchors:refined,removedAnchors:removed,extractionTargets:extractionTargets,targetNeighborhoods:neighborhoods,refinedAlignmentModel:rm,analyzedAt:new Date().toISOString()};
  }

  /* ── Spatial Transform Estimator (inlined) ─────────────────────────────── */

  function _stClamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
  function _stRound(v,dec){var f=Math.pow(10,dec||4);return Math.round(v*f)/f;}
  function _stMedian(arr){
    if(!arr.length)return 0;
    var sorted=arr.slice().sort(function(a,b){return a-b;});
    var mid=Math.floor(sorted.length/2);
    return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  }

  function _estimateSimilarityTransform(pairs){
    if(!pairs||pairs.length===0)return null;
    if(pairs.length===1){
      var p=pairs[0];
      return{a:1,b:0,c:0,d:1,tx:p.dst.x-p.src.x,ty:p.dst.y-p.src.y};
    }
    var totalW=0,avgSrcX=0,avgSrcY=0,avgDstX=0,avgDstY=0;
    for(var i=0;i<pairs.length;i++){
      var w=pairs[i].weight||1;
      avgSrcX+=pairs[i].src.x*w;avgSrcY+=pairs[i].src.y*w;
      avgDstX+=pairs[i].dst.x*w;avgDstY+=pairs[i].dst.y*w;
      totalW+=w;
    }
    avgSrcX/=totalW;avgSrcY/=totalW;avgDstX/=totalW;avgDstY/=totalW;
    var srcDistSum=0,dstDistSum=0;
    for(var j=0;j<pairs.length;j++){
      var wj=pairs[j].weight||1;
      srcDistSum+=wj*Math.sqrt(Math.pow(pairs[j].src.x-avgSrcX,2)+Math.pow(pairs[j].src.y-avgSrcY,2));
      dstDistSum+=wj*Math.sqrt(Math.pow(pairs[j].dst.x-avgDstX,2)+Math.pow(pairs[j].dst.y-avgDstY,2));
    }
    var scale=srcDistSum>1e-8?dstDistSum/srcDistSum:1;
    scale=_stClamp(scale,0.7,1.5);
    return{a:scale,b:0,c:0,d:scale,tx:avgDstX-scale*avgSrcX,ty:avgDstY-scale*avgSrcY};
  }

  function _solve3x3(a11,a12,a13,a21,a22,a23,a31,a32,a33,b1,b2,b3){
    var det=a11*(a22*a33-a23*a32)-a12*(a21*a33-a23*a31)+a13*(a21*a32-a22*a31);
    if(Math.abs(det)<1e-12)return null;
    var x1=(b1*(a22*a33-a23*a32)-a12*(b2*a33-a23*b3)+a13*(b2*a32-a22*b3))/det;
    var x2=(a11*(b2*a33-a23*b3)-b1*(a21*a33-a23*a31)+a13*(a21*b3-b2*a31))/det;
    var x3=(a11*(a22*b3-b2*a32)-a12*(a21*b3-b2*a31)+b1*(a21*a32-a22*a31))/det;
    return[x1,x2,x3];
  }

  function _estimateAffineTransform(pairs){
    if(!pairs||pairs.length<3){
      if(pairs&&pairs.length>=1)return _estimateSimilarityTransform(pairs);
      return null;
    }
    var n=pairs.length;
    var sxx=0,sxy=0,sx=0,syy=0,sy=0,sw=0;
    var sxX=0,syX=0,sX=0,sxY=0,syY=0,sY=0;
    for(var i=0;i<n;i++){
      var p=pairs[i],w=p.weight||1;
      var x=p.src.x,y=p.src.y,X=p.dst.x,Y=p.dst.y;
      sxx+=w*x*x;sxy+=w*x*y;sx+=w*x;syy+=w*y*y;sy+=w*y;sw+=w;
      sxX+=w*x*X;syX+=w*y*X;sX+=w*X;
      sxY+=w*x*Y;syY+=w*y*Y;sY+=w*Y;
    }
    var params1=_solve3x3(sxx,sxy,sx,sxy,syy,sy,sx,sy,sw,sxX,syX,sX);
    var params2=_solve3x3(sxx,sxy,sx,sxy,syy,sy,sx,sy,sw,sxY,syY,sY);
    if(!params1||!params2)return _estimateSimilarityTransform(pairs);
    return{a:params1[0],b:params1[1],tx:params1[2],c:params2[0],d:params2[1],ty:params2[2]};
  }

  function _transformPoint(transform,point){
    return{x:transform.a*point.x+transform.b*point.y+transform.tx,
           y:transform.c*point.x+transform.d*point.y+transform.ty};
  }

  function _transformNormBox(transform,normBox){
    var corners=[
      {x:normBox.x0n,y:normBox.y0n},
      {x:normBox.x0n+normBox.wN,y:normBox.y0n},
      {x:normBox.x0n+normBox.wN,y:normBox.y0n+normBox.hN},
      {x:normBox.x0n,y:normBox.y0n+normBox.hN}
    ];
    var transformed=corners.map(function(c){return _transformPoint(transform,c);});
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(var i=0;i<transformed.length;i++){
      if(transformed[i].x<minX)minX=transformed[i].x;
      if(transformed[i].y<minY)minY=transformed[i].y;
      if(transformed[i].x>maxX)maxX=transformed[i].x;
      if(transformed[i].y>maxY)maxY=transformed[i].y;
    }
    return{x0n:_stClamp(minX,0,1),y0n:_stClamp(minY,0,1),wN:_stClamp(maxX-minX,0.001,1),hN:_stClamp(maxY-minY,0.001,1)};
  }

  function _analyzeTransformCoherence(transform,pairs,madThreshold){
    if(!transform||!pairs||pairs.length===0)return{coherenceScore:0,residuals:[],outliers:[],inliers:pairs||[]};
    madThreshold=madThreshold||3;
    var residuals=[];
    for(var i=0;i<pairs.length;i++){
      var predicted=_transformPoint(transform,pairs[i].src);
      var actual=pairs[i].dst;
      var residual=_pointDist(predicted,actual);
      residuals.push({index:i,anchorId:pairs[i].anchorId||null,predicted:predicted,actual:actual,residual:residual});
    }
    var residualValues=residuals.map(function(r){return r.residual;});
    var medianResidual=_stMedian(residualValues);
    var absDeviations=residualValues.map(function(r){return Math.abs(r-medianResidual);});
    var mad=_stMedian(absDeviations);
    var scaledMAD=mad*1.4826;
    var outliers=[],inliers=[];
    for(var j=0;j<residuals.length;j++){
      var isOutlier=scaledMAD>1e-6&&residuals[j].residual>medianResidual+madThreshold*scaledMAD;
      residuals[j].isOutlier=isOutlier;
      if(isOutlier)outliers.push(pairs[j]);
      else inliers.push(pairs[j]);
    }
    var residualScore=_stClamp(1-medianResidual/0.05,0,1);
    var outlierRatio=pairs.length>0?outliers.length/pairs.length:0;
    var outlierScore=_stClamp(1-outlierRatio*2,0,1);
    var coherenceScore=residualScore*0.6+outlierScore*0.4;
    return{coherenceScore:_stRound(coherenceScore),medianResidual:_stRound(medianResidual,6),mad:_stRound(scaledMAD,6),
      outlierCount:outliers.length,inlierCount:inliers.length,residuals:residuals,outliers:outliers,inliers:inliers};
  }

  function _estimateRobustTransform(pairs,maxIterations,madThreshold){
    maxIterations=maxIterations||3;madThreshold=madThreshold||3;
    if(!pairs||pairs.length===0)return{transform:null,coherence:null,iterations:0,usedPairs:[]};
    var currentPairs=pairs.slice();var transform=null;var coherence=null;var iter=0;
    for(iter=0;iter<maxIterations;iter++){
      transform=_estimateAffineTransform(currentPairs);
      if(!transform)break;
      coherence=_analyzeTransformCoherence(transform,currentPairs,madThreshold);
      if(coherence.outlierCount===0||coherence.coherenceScore>0.9)break;
      if(coherence.inliers.length>=1)currentPairs=coherence.inliers;
      else break;
    }
    return{transform:transform,coherence:coherence,iterations:iter+1,usedPairs:currentPairs};
  }

  function _decomposeAffine(t){
    if(!t)return null;
    var scaleX=Math.sqrt(t.a*t.a+t.c*t.c);
    var scaleY=Math.sqrt(t.b*t.b+t.d*t.d);
    var rotation=Math.atan2(t.c,t.a)*180/Math.PI;
    var skew=Math.atan2(t.b,t.d)*180/Math.PI+rotation;
    return{translateX:_stRound(t.tx,6),translateY:_stRound(t.ty,6),scaleX:_stRound(scaleX,6),scaleY:_stRound(scaleY,6),rotation:_stRound(rotation,4),skew:_stRound(skew,4)};
  }

  function _buildAnchorPairs(refinedAnchors,correspondences,targetDocId,targetDoc){
    var docCorrespondences=(correspondences||[]).filter(function(c){return c.tgtDocumentId===targetDocId;});
    var tgtRegions=targetDoc.regionDescriptors||[];
    var pairs=[];
    for(var ai=0;ai<refinedAnchors.length;ai++){
      var anchor=refinedAnchors[ai];
      var match=null;
      for(var ci=0;ci<docCorrespondences.length;ci++){
        if(docCorrespondences[ci].refRegionId===anchor.refRegionId){match=docCorrespondences[ci];break;}
      }
      if(!match)continue;
      var tgtRegion=null;
      for(var ri=0;ri<tgtRegions.length;ri++){
        if(tgtRegions[ri].regionId===match.tgtRegionId){tgtRegion=tgtRegions[ri];break;}
      }
      if(!tgtRegion)continue;
      pairs.push({
        src:{x:anchor.normalizedPosition.x,y:anchor.normalizedPosition.y},
        dst:{x:tgtRegion.centroid.x,y:tgtRegion.centroid.y},
        weight:(anchor.relevanceScore||0.5)*(match.similarity||0.5),
        anchorId:anchor.anchorId,matchSimilarity:match.similarity,
        refBbox:anchor.normalizedBbox,tgtBbox:tgtRegion.normalizedBbox
      });
    }
    return pairs;
  }

  function _estimateSpatialTransform(refinedAnchors,correspondenceResult,targetDocId,targetDoc){
    var pairs=_buildAnchorPairs(refinedAnchors,correspondenceResult.correspondences,targetDocId,targetDoc);
    if(pairs.length===0)return{status:'no_pairs',transform:{a:1,b:0,c:0,d:1,tx:0,ty:0},coherence:{coherenceScore:0},pairCount:0,isIdentity:true,diagnostics:{message:'No anchor pairs found for target document'}};
    var result=_estimateRobustTransform(pairs,3,3);
    if(!result.transform)return{status:'estimation_failed',transform:{a:1,b:0,c:0,d:1,tx:0,ty:0},coherence:{coherenceScore:0},pairCount:pairs.length,isIdentity:true,diagnostics:{message:'Transform estimation failed — using identity'}};
    var decomposed=_decomposeAffine(result.transform);
    var sane=true;
    if(Math.abs(decomposed.scaleX-1)>0.5||Math.abs(decomposed.scaleY-1)>0.5)sane=false;
    if(Math.abs(decomposed.rotation)>15)sane=false;
    if(Math.abs(decomposed.translateX)>0.3||Math.abs(decomposed.translateY)>0.3)sane=false;
    if(!sane){
      var simpleTransform=_estimateSimilarityTransform(result.usedPairs);
      var simpleCoherence=_analyzeTransformCoherence(simpleTransform,result.usedPairs);
      var simpleDecomposed=_decomposeAffine(simpleTransform);
      return{status:'simplified',transform:simpleTransform,coherence:simpleCoherence,pairCount:result.usedPairs.length,pairs:result.usedPairs,isIdentity:false,decomposed:simpleDecomposed,iterations:result.iterations,diagnostics:{message:'Full affine was too extreme — fell back to similarity transform',originalDecomposed:decomposed}};
    }
    return{status:'estimated',transform:result.transform,coherence:result.coherence,pairCount:result.usedPairs.length,pairs:result.usedPairs,isIdentity:false,decomposed:decomposed,iterations:result.iterations,diagnostics:null};
  }

  function _estimateLocalTransform(fieldNormBox,pairs,globalTransform,opts){
    opts=opts||{};
    var localRadius=opts.localRadius||0.2;
    var minLocalPairs=opts.minLocalPairs||2;
    var globalBlend=opts.globalBlend||0.3;
    var fieldCenter={x:fieldNormBox.x0n+fieldNormBox.wN/2,y:fieldNormBox.y0n+fieldNormBox.hN/2};
    if(!pairs||pairs.length===0)return{localTransform:globalTransform,blendedTransform:globalTransform,localPairCount:0,isLocal:false};
    var weightedPairs=[];
    for(var i=0;i<pairs.length;i++){
      var dist=_pointDist(fieldCenter,pairs[i].src);
      var spatialWeight=Math.exp(-Math.pow(dist/localRadius,2));
      var combinedWeight=spatialWeight*(pairs[i].weight||1);
      if(combinedWeight>0.01)weightedPairs.push({src:pairs[i].src,dst:pairs[i].dst,weight:combinedWeight,anchorId:pairs[i].anchorId});
    }
    if(weightedPairs.length<minLocalPairs)return{localTransform:globalTransform,blendedTransform:globalTransform,localPairCount:weightedPairs.length,isLocal:false};
    var localTransform=_estimateAffineTransform(weightedPairs);
    if(!localTransform)return{localTransform:globalTransform,blendedTransform:globalTransform,localPairCount:weightedPairs.length,isLocal:false};
    var localConfidence=_stClamp(weightedPairs.length/5,0,1);
    var localWeight=(1-globalBlend)*localConfidence;
    var globalWeight=1-localWeight;
    var blended={
      a:localTransform.a*localWeight+globalTransform.a*globalWeight,
      b:localTransform.b*localWeight+globalTransform.b*globalWeight,
      c:localTransform.c*localWeight+globalTransform.c*globalWeight,
      d:localTransform.d*localWeight+globalTransform.d*globalWeight,
      tx:localTransform.tx*localWeight+globalTransform.tx*globalWeight,
      ty:localTransform.ty*localWeight+globalTransform.ty*globalWeight
    };
    return{localTransform:localTransform,blendedTransform:blended,localPairCount:weightedPairs.length,isLocal:true,localConfidence:_stRound(localConfidence),localWeight:_stRound(localWeight)};
  }

  /* ── transferBBox (spatial-transform-based) ──────────────────────────── */

  function transferBBox(target,refinedAnchors,correspondenceResult,targetDocId,targetDoc,opts){
    opts=opts||{};
    var srcBox=target.normBox,srcCenter=_normBoxCenter(srcBox);
    // Stage 1+2: Estimate spatial transform model
    var transformModel=opts.precomputedTransform||null;
    if(!transformModel){
      transformModel=_estimateSpatialTransform(refinedAnchors,correspondenceResult,targetDocId,targetDoc);
    }
    if(!transformModel||transformModel.pairCount===0){
      return{transferredNormBox:{x0n:srcBox.x0n,y0n:srcBox.y0n,wN:srcBox.wN,hN:srcBox.hN},confidence:0.3,method:'identity_fallback',anchorsUsed:0,transformModel:transformModel};
    }
    // Stage 3: Estimate field-local transform
    var usedPairs=transformModel.pairs||[];
    var localResult=_estimateLocalTransform(srcBox,usedPairs,transformModel.transform,{localRadius:0.2,minLocalPairs:2,globalBlend:0.3});
    var effectiveTransform=localResult.blendedTransform||transformModel.transform;
    // Stage 4: Transform BBOX through the model
    var transformedBox=_transformNormBox(effectiveTransform,srcBox);
    var newX=transformedBox.x0n,newY=transformedBox.y0n,newW=transformedBox.wN,newH=transformedBox.hN;
    // Stage 5: Structural neighborhood refinement
    var tgtRegions=targetDoc.regionDescriptors||[];
    var tgtNhDescs=targetDoc.neighborhoodDescriptors||{};
    var txCenter={x:newX+newW/2,y:newY+newH/2};
    if(tgtRegions.length>0){
      var txNormBox={x0n:newX,y0n:newY,wN:newW,hN:newH};
      var refNeighborhood=opts.targetNeighborhood||null;
      // Build structural context at transferred position on target
      var nearbyTargetRegions=[];
      var diagThreshold=Math.sqrt(newW*newW+newH*newH)*1.0;
      for(var lri=0;lri<tgtRegions.length;lri++){
        var lr=tgtRegions[lri];
        var lrDist=_pointDist(txCenter,lr.centroid);
        if(lrDist>diagThreshold)continue;
        var lrNormBox={x0n:lr.normalizedBbox.x,y0n:lr.normalizedBbox.y,wN:lr.normalizedBbox.w,hN:lr.normalizedBbox.h};
        nearbyTargetRegions.push({region:lr,normBox:lrNormBox,distance:lrDist,iou:_normBoxIoU(txNormBox,lrNormBox),nhDesc:tgtNhDescs[lr.regionId]||{}});
      }
      if(refNeighborhood&&refNeighborhood.structuralFingerprint&&nearbyTargetRegions.length>0){
        var bestNudge=null,bestNudgeScore=0;
        for(var nri=0;nri<nearbyTargetRegions.length;nri++){
          var candidate=nearbyTargetRegions[nri],cr=candidate.region;
          // Geometric overlap and proximity
          var geoScore=candidate.iou*0.3+(1-candidate.distance/diagThreshold)*0.2;
          // Shape similarity to innermost container
          var shapeSim2=0;
          if(refNeighborhood.innermostContainer){
            var ic=refNeighborhood.innermostContainer;
            var arSim2=1-Math.abs(Math.min(cr.aspectRatio,10)-Math.min(ic.aspectRatio,10))/Math.max(Math.min(cr.aspectRatio,10),Math.min(ic.aspectRatio,10),0.1);
            var areaSim2=1-Math.abs(cr.normalizedArea-ic.normalizedArea)/Math.max(cr.normalizedArea,ic.normalizedArea,0.001);
            shapeSim2=_clamp(arSim2*0.5+areaSim2*0.5,0,1);
          }
          // Structural topology match
          var topoSim2=0;
          if(candidate.nhDesc.edgeTypeDist){
            var depthSim2=1-Math.abs((candidate.nhDesc.containmentDepth||0)-(refNeighborhood.innermostContainer?1:0))/3;
            var cEdges=candidate.nhDesc.edgeTypeDist;
            var cTotal=(cEdges.contains||0)+(cEdges.spatial_proximity||0)+(cEdges.spatial_adjacency||0);
            var adjSim2=cTotal>0?_clamp((cEdges.spatial_adjacency||0)/cTotal,0,1):0.5;
            topoSim2=_clamp(depthSim2*0.6+adjSim2*0.4,0,1);
          }
          // Surface type consistency
          var typeSim2=0;
          if(refNeighborhood.neighbors&&refNeighborhood.neighbors.length>0){
            var topRefTypes={};var nCount=Math.min(refNeighborhood.neighbors.length,5);
            for(var rti=0;rti<nCount;rti++)topRefTypes[refNeighborhood.neighbors[rti].surfaceType]=true;
            if(topRefTypes[cr.surfaceType])typeSim2=1;
          }
          var nudgeScore=geoScore*0.35+shapeSim2*0.25+topoSim2*0.25+typeSim2*0.15;
          if(nudgeScore>bestNudgeScore&&nudgeScore>0.12){bestNudgeScore=nudgeScore;bestNudge={center:cr.centroid,normBox:candidate.normBox,score:nudgeScore};}
        }
        if(bestNudge){
          var nudgeStrength=_clamp(bestNudgeScore*0.35,0,0.35);
          newX=txCenter.x+(bestNudge.center.x-txCenter.x)*nudgeStrength-newW/2;
          newY=txCenter.y+(bestNudge.center.y-txCenter.y)*nudgeStrength-newH/2;
        }
      } else {
        // Fallback: simple proximity-based nudge
        var bestSimple=null,bestSimpleScore=0;
        for(var si2=0;si2<nearbyTargetRegions.length;si2++){
          var sc=nearbyTargetRegions[si2];
          var simpleScore=sc.iou*0.5+(1-sc.distance/diagThreshold)*0.3;
          var sizMatch=1-Math.abs(sc.region.normalizedArea-(newW*newH))/Math.max(sc.region.normalizedArea,newW*newH,0.001);
          simpleScore+=_clamp(sizMatch,0,1)*0.2;
          if(simpleScore>bestSimpleScore&&simpleScore>0.15){bestSimpleScore=simpleScore;bestSimple={center:sc.region.centroid};}
        }
        if(bestSimple){
          var sNudge=_clamp(bestSimpleScore*0.25,0,0.25);
          newX=txCenter.x+(bestSimple.center.x-txCenter.x)*sNudge-newW/2;
          newY=txCenter.y+(bestSimple.center.y-txCenter.y)*sNudge-newH/2;
        }
      }
    }
    newX=_clamp(newX,0,1-newW);newY=_clamp(newY,0,1-newH);newW=_clamp(newW,0.001,1);newH=_clamp(newH,0.001,1);
    var coherenceScore=(transformModel.coherence&&transformModel.coherence.coherenceScore)||0.5;
    var pairCountFactor=_clamp(transformModel.pairCount/5,0.3,1);
    var localFactor=localResult.isLocal?1.1:1.0;
    var confidence=_clamp(coherenceScore*pairCountFactor*localFactor,0,1);
    var netOffsetX=(newX+newW/2)-srcCenter.x,netOffsetY=(newY+newH/2)-srcCenter.y;
    return{transferredNormBox:{x0n:_round(newX,6),y0n:_round(newY,6),wN:_round(newW,6),hN:_round(newH,6)},confidence:_round(confidence,4),
      method:transformModel.isIdentity?'identity_fallback':'spatial_transform',anchorsUsed:transformModel.pairCount,
      offset:{x:_round(netOffsetX,6),y:_round(netOffsetY,6)},scale:{w:_round(newW/srcBox.wN,4),h:_round(newH/srcBox.hN,4)},
      transformModel:{status:transformModel.status,coherenceScore:coherenceScore,decomposed:transformModel.decomposed||null,localTransformUsed:localResult.isLocal,localPairCount:localResult.localPairCount}};
  }

  function extractTextFromNormBox(normBox,tokens,viewport){
    if(!normBox||!tokens||!tokens.length||!viewport)return{text:'',tokenCount:0,confidence:0};
    var vpW=viewport.width||viewport.w||1,vpH=viewport.height||viewport.h||1;
    var bx=normBox.x0n*vpW,by=normBox.y0n*vpH,bw=normBox.wN*vpW,bh=normBox.hN*vpH;
    var matched=[];
    for(var i=0;i<tokens.length;i++){
      var t=tokens[i],ox=Math.min(t.x+t.w,bx+bw)-Math.max(t.x,bx),oy=Math.min(t.y+t.h,by+bh)-Math.max(t.y,by);
      if(ox<=0||oy<=0)continue;
      var cx=t.x+t.w/2,cy=t.y+t.h/2;
      if(cx<bx||cx>bx+bw||cy<by||cy>by+bh)continue;
      matched.push(t);
    }
    matched.sort(function(a,b){var ay=a.y+a.h/2,by2=b.y+b.h/2;if(Math.abs(ay-by2)>Math.min(a.h,b.h)*0.5)return ay-by2;return a.x-b.x;});
    var lines=[],curLine=[],lastY=-Infinity;
    for(var mi=0;mi<matched.length;mi++){
      var tk=matched[mi],tkY=tk.y+tk.h/2;
      if(curLine.length>0&&Math.abs(tkY-lastY)>tk.h*0.5){lines.push(curLine.map(function(t){return t.text;}).join(' '));curLine=[];}
      curLine.push(tk);lastY=tkY;
    }
    if(curLine.length>0)lines.push(curLine.map(function(t){return t.text;}).join(' '));
    var text=lines.join('\n').trim();
    var avgC=matched.length>0?_mean(matched.map(function(t){return t.confidence||0.5;})):0;
    var textSource=matched.length>=2?'tokens':(matched.length>0?'tokens_sparse':'no_tokens');
    return{text:text,tokenCount:matched.length,confidence:_round(avgC,4),textSource:textSource};
  }

  function extractFromBatch(refinementResult,correspondenceResult,refDoc,batchDocuments,batchTokens){
    if(!refinementResult||refinementResult.status==='no_relevant_anchors')return{status:'no_anchors',message:'No refined anchors available.',results:[]};
    var targets=refinementResult.extractionTargets,ra=refinementResult.refinedAnchors;
    var refDocId=correspondenceResult.referenceDocument.documentId,results=[];
    for(var di=0;di<batchDocuments.length;di++){
      var doc=batchDocuments[di];if(doc._compact||doc.structurallyValid===false)continue;
      var dt=batchTokens[doc.documentId],isRef=doc.documentId===refDocId;
      var dr={documentId:doc.documentId,documentName:doc.documentName||'',isReference:isRef,fields:[]};
      // Pre-compute spatial transform model once per target document
      var precomputedTransform=null;
      if(!isRef){
        precomputedTransform=_estimateSpatialTransform(ra,correspondenceResult,doc.documentId,doc);
      }
      // Build target neighborhood lookup for local refinement
      var targetNeighborhoods={};
      if(refinementResult.targetNeighborhoods){
        for(var nhi=0;nhi<refinementResult.targetNeighborhoods.length;nhi++){
          var nh=refinementResult.targetNeighborhoods[nhi];
          targetNeighborhoods[nh.fieldKey]=nh;
        }
      }
      for(var ti=0;ti<targets.length;ti++){
        var target=targets[ti],tr;
        if(isRef)tr={transferredNormBox:target.normBox,confidence:1,method:'reference_identity',anchorsUsed:0};
        else tr=transferBBox(target,ra,correspondenceResult,doc.documentId,doc,{precomputedTransform:precomputedTransform,targetNeighborhood:targetNeighborhoods[target.fieldKey]||null});
        var ext={text:'',tokenCount:0,confidence:0};
        if(dt&&dt.tokens)ext=extractTextFromNormBox(tr.transferredNormBox,dt.tokens,dt.viewport);
        dr.fields.push({fieldKey:target.fieldKey,label:target.label,sourceNormBox:target.normBox,transferredNormBox:tr.transferredNormBox,
          transferConfidence:tr.confidence,transferMethod:tr.method,anchorsUsed:tr.anchorsUsed,extractedText:ext.text,tokenCount:ext.tokenCount,textConfidence:ext.confidence,textSource:ext.textSource||'no_tokens'});
      }
      // Attach per-document transform diagnostics
      if(precomputedTransform&&!precomputedTransform.isIdentity){
        dr.transformDiagnostics={status:precomputedTransform.status,pairCount:precomputedTransform.pairCount,
          coherenceScore:precomputedTransform.coherence?_round(precomputedTransform.coherence.coherenceScore,4):0,
          decomposed:precomputedTransform.decomposed||null,
          outlierCount:precomputedTransform.coherence?precomputedTransform.coherence.outlierCount||0:0,
          iterations:precomputedTransform.iterations||0};
      }
      results.push(dr);
    }
    return{status:'complete',message:'Extracted '+targets.length+' field(s) from '+results.length+' document(s).',extractionTargets:targets,documentCount:results.length,results:results,extractedAt:new Date().toISOString()};
  }

  function formatRefinementReport(result){
    if(!result)return'[No refinement data]';
    if(result.status==='no_correspondence'||result.status==='no_targets')return result.message;
    var out='';
    out+='══════════════════════════════════════════════════════════════\n';
    out+='  ANCHOR REFINEMENT REPORT (Phase 2B)\n';
    out+='══════════════════════════════════════════════════════════════\n\n';
    out+='  Status: '+result.status.toUpperCase().replace(/_/g,' ')+'\n';
    out+='  '+result.message+'\n';
    if(result.refinedAlignmentModel){
      var m=result.refinedAlignmentModel;
      out+='\n  Anchors: '+m.anchorCount+' kept / '+m.removedCount+' removed (of '+m.originalCount+')\n';
      out+='  Retention: '+(m.anchorRetentionRate*100).toFixed(1)+'%\n';
      out+='  Avg Relevance: '+(m.avgRelevanceScore*100).toFixed(1)+'%\n';
    }
    if(result.extractionTargets&&result.extractionTargets.length>0){
      out+='\n──────────────────────────────────────────────────────────────\n  EXTRACTION TARGETS\n──────────────────────────────────────────────────────────────\n';
      for(var ti=0;ti<result.extractionTargets.length;ti++){
        var t=result.extractionTargets[ti];
        out+='\n  '+t.label+' ('+t.fieldKey+'): ('+(t.normBox.x0n*100).toFixed(1)+'%, '+(t.normBox.y0n*100).toFixed(1)+'%) '+(t.normBox.wN*100).toFixed(1)+'% x '+(t.normBox.hN*100).toFixed(1)+'%\n';
      }
    }
    if(result.refinedAnchors&&result.refinedAnchors.length>0){
      out+='\n──────────────────────────────────────────────────────────────\n  REFINED ANCHORS ('+result.refinedAnchors.length+')\n──────────────────────────────────────────────────────────────\n';
      for(var ai=0;ai<result.refinedAnchors.length;ai++){
        var a=result.refinedAnchors[ai];
        out+='\n  '+a.anchorId+'  rel='+(a.relevanceScore*100).toFixed(1)+'%  conf='+(a.confidence*100).toFixed(1)+'%  target='+(a.bestTargetKey||'none')+'\n';
      }
    }
    out+='\n══════════════════════════════════════════════════════════════\n';
    return out;
  }

  function formatExtractionReport(extractionResult){
    if(!extractionResult||!extractionResult.results)return'[No extraction data]';
    var out='';
    out+='══════════════════════════════════════════════════════════════\n';
    out+='  EXTRACTION REPORT (Phase 2B)\n';
    out+='══════════════════════════════════════════════════════════════\n\n';
    out+='  '+extractionResult.message+'\n';
    for(var di=0;di<extractionResult.results.length;di++){
      var doc=extractionResult.results[di];
      out+='\n──────────────────────────────────────────────────────────────\n';
      out+='  '+(doc.documentName||doc.documentId)+(doc.isReference?' (REFERENCE)':'')+'\n';
      if(doc.transformDiagnostics){
        var td=doc.transformDiagnostics;
        out+='  Transform: '+td.status+'  pairs='+td.pairCount+'  coherence='+(td.coherenceScore*100).toFixed(1)+'%  outliers='+td.outlierCount+'\n';
        if(td.decomposed){
          out+='    Translation: ('+(td.decomposed.translateX*100).toFixed(2)+'%, '+(td.decomposed.translateY*100).toFixed(2)+'%)';
          out+='  Scale: ('+td.decomposed.scaleX.toFixed(3)+', '+td.decomposed.scaleY.toFixed(3)+')';
          if(Math.abs(td.decomposed.rotation)>0.1)out+='  Rot: '+td.decomposed.rotation.toFixed(1)+'°';
          out+='\n';
        }
      }
      for(var fi=0;fi<doc.fields.length;fi++){
        var f=doc.fields[fi];
        out+='    '+f.label+': ';
        if(f.transferMethod==='reference_identity')out+='(reference — original BBOX)\n';
        else{
          out+=f.transferMethod+'  conf='+(f.transferConfidence*100).toFixed(0)+'%\n';
        }
        out+='      Text: '+(f.extractedText||'(empty)').substring(0,60)+'  tokens='+f.tokenCount+'\n';
      }
    }
    out+='\n══════════════════════════════════════════════════════════════\n';
    return out;
  }

  /* ── Phase 3A: Field Intelligence ──────────────────────────────────────── */

  function _levenshteinDistance(a,b){
    if(a===b)return 0;if(!a.length)return 1;if(!b.length)return 1;
    var m=[];for(var i=0;i<=b.length;i++)m[i]=[i];for(var j=0;j<=a.length;j++)m[0][j]=j;
    for(i=1;i<=b.length;i++){for(j=1;j<=a.length;j++){
      if(b.charAt(i-1)===a.charAt(j-1))m[i][j]=m[i-1][j-1];
      else m[i][j]=Math.min(m[i-1][j-1]+1,m[i][j-1]+1,m[i-1][j]+1);
    }}
    return m[b.length][a.length]/Math.max(a.length,b.length);
  }

  function _tokenOverlap(ext,corr){
    if(!corr||!corr.trim())return 0;
    var ct=corr.toLowerCase().split(/\s+/).filter(Boolean);if(!ct.length)return 0;
    var el=ext.toLowerCase(),found=0;
    for(var i=0;i<ct.length;i++){if(el.indexOf(ct[i])>=0)found++;}
    return found/ct.length;
  }

  function _textSimilarity(ext,corr){
    if(!corr||!corr.trim())return ext?0:1;if(!ext||!ext.trim())return 0;
    return(1-_levenshteinDistance(ext.trim(),corr.trim()))*0.6+_tokenOverlap(ext,corr)*0.4;
  }

  function _normBoxCenter3(nb){return{x:nb.x0n+nb.wN/2,y:nb.y0n+nb.hN/2};}
  function _pointDist3(a,b){return Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y));}
  function _normBoxIoU3(a,b){
    var ax1=a.x0n+a.wN,ay1=a.y0n+a.hN,bx1=b.x0n+b.wN,by1=b.y0n+b.hN;
    var ix0=Math.max(a.x0n,b.x0n),iy0=Math.max(a.y0n,b.y0n),ix1=Math.min(ax1,bx1),iy1=Math.min(ay1,by1);
    if(ix1<=ix0||iy1<=iy0)return 0;var inter=(ix1-ix0)*(iy1-iy0);var union=a.wN*a.hN+b.wN*b.hN-inter;
    return union>0?inter/union:0;
  }

  function generateCandidates(originalBox,refDoc){
    var candidates=[];
    candidates.push({normBox:{x0n:originalBox.x0n,y0n:originalBox.y0n,wN:originalBox.wN,hN:originalBox.hN},family:'original',label:'Original BBOX'});
    var regions=(refDoc&&refDoc.regionDescriptors)||[];
    var boxCenter=_normBoxCenter3(originalBox);
    var origArea=originalBox.wN*originalBox.hN,maxExpArea=origArea*2;
    var bestR=null,bestOv=0;
    for(var ri=0;ri<regions.length;ri++){
      var r=regions[ri],rNb={x0n:r.normalizedBbox.x,y0n:r.normalizedBbox.y,wN:r.normalizedBbox.w,hN:r.normalizedBbox.h};
      if(rNb.wN*rNb.hN>0.4)continue;
      var ov=_normBoxIoU3(originalBox,rNb);
      var ci2=boxCenter.x>=rNb.x0n&&boxCenter.x<=rNb.x0n+rNb.wN&&boxCenter.y>=rNb.y0n&&boxCenter.y<=rNb.y0n+rNb.hN;
      var sc=ov+(ci2?0.5:0);
      if(sc>bestOv&&rNb.wN*rNb.hN<=maxExpArea){bestOv=sc;bestR=rNb;}
    }
    if(bestR){
      var eX=Math.min(originalBox.x0n,bestR.x0n),eY=Math.min(originalBox.y0n,bestR.y0n);
      var eX1=Math.max(originalBox.x0n+originalBox.wN,bestR.x0n+bestR.wN),eY1=Math.max(originalBox.y0n+originalBox.hN,bestR.y0n+bestR.hN);
      var eW=eX1-eX,eH=eY1-eY;
      if(eW*eH<=maxExpArea)candidates.push({normBox:{x0n:_round(eX,6),y0n:_round(eY,6),wN:_round(eW,6),hN:_round(eH,6)},family:'structural_expansion',label:'Structural region expansion'});
      var bf=0.5,bX=originalBox.x0n+(eX-originalBox.x0n)*bf,bY=originalBox.y0n+(eY-originalBox.y0n)*bf;
      var bX1=(originalBox.x0n+originalBox.wN)+(eX1-(originalBox.x0n+originalBox.wN))*bf;
      var bY1=(originalBox.y0n+originalBox.hN)+(eY1-(originalBox.y0n+originalBox.hN))*bf;
      var bW=bX1-bX,bH=bY1-bY;
      if(bW*bH<=maxExpArea&&bW>0&&bH>0)candidates.push({normBox:{x0n:_round(bX,6),y0n:_round(bY,6),wN:_round(bW,6),hN:_round(bH,6)},family:'structural_expansion',label:'Partial region expansion (50%)'});
    }
    var stX=originalBox.wN*0.2,stY=originalBox.hN*0.2,ef=0.15;
    var shifts=[{dx:-stX,dy:0},{dx:stX,dy:0},{dx:0,dy:-stY},{dx:0,dy:stY},{dx:-stX,dy:-stY},{dx:stX,dy:-stY},{dx:-stX,dy:stY},{dx:stX,dy:stY}];
    for(var si=0;si<shifts.length;si++){
      var s=shifts[si];
      candidates.push({normBox:{x0n:_round(_clamp(originalBox.x0n+s.dx,0,1-originalBox.wN),6),y0n:_round(_clamp(originalBox.y0n+s.dy,0,1-originalBox.hN),6),wN:originalBox.wN,hN:originalBox.hN},family:'local_search',label:'Shift'});
    }
    var evs=[{dw:ef,dh:0},{dw:0,dh:ef},{dw:ef,dh:ef},{dw:-ef,dh:0},{dw:0,dh:-ef},{dw:-ef,dh:-ef}];
    for(var ei=0;ei<evs.length;ei++){
      var e=evs[ei],ew=originalBox.wN*(1+e.dw),eh=originalBox.hN*(1+e.dh);
      if(ew<0.005||eh<0.005||ew*eh>maxExpArea)continue;
      var ex=_clamp(originalBox.x0n-(ew-originalBox.wN)/2,0,Math.max(0,1-ew));
      var ey=_clamp(originalBox.y0n-(eh-originalBox.hN)/2,0,Math.max(0,1-eh));
      candidates.push({normBox:{x0n:_round(ex,6),y0n:_round(ey,6),wN:_round(ew,6),hN:_round(eh,6)},family:'local_search',label:'Resize'});
    }
    var combos=[{dx:-stX,dw:ef},{dx:stX,dw:ef},{dy:-stY,dh:ef},{dy:stY,dh:ef}];
    for(var cci=0;cci<combos.length;cci++){
      var cc=combos[cci],cw=originalBox.wN*(1+(cc.dw||0)),ch=originalBox.hN*(1+(cc.dh||0));
      if(cw*ch>maxExpArea)continue;
      var ccx=_clamp(originalBox.x0n+(cc.dx||0)-((cw-originalBox.wN)/2),0,Math.max(0,1-cw));
      var ccy=_clamp(originalBox.y0n+(cc.dy||0)-((ch-originalBox.hN)/2),0,Math.max(0,1-ch));
      candidates.push({normBox:{x0n:_round(ccx,6),y0n:_round(ccy,6),wN:_round(cw,6),hN:_round(ch,6)},family:'local_search',label:'Shift+Resize'});
    }
    return candidates;
  }

  function scoreCandidate(candidate,extractedText,extractionConfidence,correctedText,originalBox,tokenCount){
    var origC=_normBoxCenter3(originalBox),candC=_normBoxCenter3(candidate.normBox);
    var cDist=_pointDist3(origC,candC),iou=_normBoxIoU3(originalBox,candidate.normBox);
    var alignScore=iou*0.6+_clamp(1-cDist/0.15,0,1)*0.4;
    var confScore=0;
    if(tokenCount>0)confScore=_clamp(extractionConfidence,0,1)*0.7+_clamp(tokenCount/5,0,1)*0.3;
    var simScore=_textSimilarity(extractedText,correctedText);
    var total=alignScore*0.40+confScore*0.30+simScore*0.30;
    return{totalScore:_round(total,4),alignmentScore:_round(alignScore,4),confidenceScore:_round(confScore,4),similarityScore:_round(simScore,4)};
  }

  function optimizeFieldGeometry(fieldResult,correctedText,tokens,viewport,refDoc){
    var origBox=fieldResult.transferredNormBox;
    var candidates=generateCandidates(origBox,refDoc);
    var scored=[];
    for(var ci=0;ci<candidates.length;ci++){
      var cand=candidates[ci],ext=extractTextFromNormBox(cand.normBox,tokens,viewport);
      var sc=scoreCandidate(cand,ext.text,ext.confidence,correctedText,origBox,ext.tokenCount);
      scored.push({normBox:cand.normBox,family:cand.family,label:cand.label,extractedText:ext.text,tokenCount:ext.tokenCount,extractionConfidence:ext.confidence,
        totalScore:sc.totalScore,alignmentScore:sc.alignmentScore,confidenceScore:sc.confidenceScore,similarityScore:sc.similarityScore});
    }
    scored.sort(function(a,b){return b.totalScore-a.totalScore;});
    var best=scored[0]||null,orig=scored.find(function(s){return s.family==='original';});
    var offset=null,expansion=null;
    if(best){
      offset={dx:_round(best.normBox.x0n-origBox.x0n,6),dy:_round(best.normBox.y0n-origBox.y0n,6)};
      expansion={dw:_round(best.normBox.wN-origBox.wN,6),dh:_round(best.normBox.hN-origBox.hN,6)};
    }
    var improved=best&&orig&&best.totalScore>orig.totalScore;
    var improvement=(best&&orig)?_round(best.totalScore-orig.totalScore,4):0;
    return{fieldKey:fieldResult.fieldKey,label:fieldResult.label,originalBox:origBox,bestCandidate:best,originalCandidate:orig,
      improved:improved,improvement:improvement,offset:offset,expansion:expansion,candidateCount:scored.length,topCandidates:scored.slice(0,5),geometryConfidence:best?best.totalScore:0};
  }

  function learnFieldGeometry(extractionResult,corrections,batchTokens,refDoc,opts){
    if(!extractionResult||!extractionResult.results||!corrections||!corrections.length)
      return{status:'no_data',message:'No extraction results or corrections provided.',fieldProfiles:[],perDocumentResults:[]};
    var targets=extractionResult.extractionTargets||[],perDocResults=[],fieldOpts={};
    for(var ti=0;ti<targets.length;ti++)fieldOpts[targets[ti].fieldKey]=[];
    for(var ci=0;ci<corrections.length;ci++){
      var corr=corrections[ci];
      var docRes=extractionResult.results.find(function(r){return r.documentId===corr.documentId;});
      if(!docRes)continue;
      var dt=batchTokens[corr.documentId];if(!dt)continue;
      var dor={documentId:corr.documentId,documentName:docRes.documentName,fields:[]};
      for(var fi=0;fi<corr.fields.length;fi++){
        var fc=corr.fields[fi];
        var fr=docRes.fields.find(function(f){return f.fieldKey===fc.fieldKey;});if(!fr)continue;
        var oRes=optimizeFieldGeometry(fr,fc.correctedText,dt.tokens,dt.viewport,refDoc);
        dor.fields.push(oRes);
        if(fieldOpts[fc.fieldKey])fieldOpts[fc.fieldKey].push(oRes);
      }
      perDocResults.push(dor);
    }
    var fieldProfiles=[];
    for(var fk in fieldOpts){
      if(!fieldOpts.hasOwnProperty(fk))continue;
      var fo=fieldOpts[fk];if(!fo.length)continue;
      var tgt=targets.find(function(t){return t.fieldKey===fk;});
      var aDx=_mean(fo.map(function(o){return o.offset?o.offset.dx:0;}));
      var aDy=_mean(fo.map(function(o){return o.offset?o.offset.dy:0;}));
      var aDw=_mean(fo.map(function(o){return o.expansion?o.expansion.dw:0;}));
      var aDh=_mean(fo.map(function(o){return o.expansion?o.expansion.dh:0;}));
      var aC=_mean(fo.map(function(o){return o.geometryConfidence;}));
      var iC=fo.filter(function(o){return o.improved;}).length;
      var fCounts={};
      for(var oi=0;oi<fo.length;oi++){var bf2=fo[oi].bestCandidate?fo[oi].bestCandidate.family:'original';fCounts[bf2]=(fCounts[bf2]||0)+1;}
      var domFam='original',maxFC=0;for(var fm in fCounts){if(fCounts[fm]>maxFC){maxFC=fCounts[fm];domFam=fm;}}
      var aNh=null;
      if(refDoc&&tgt){
        var tc=_normBoxCenter3(tgt.normBox);
        var nr=(refDoc.regionDescriptors||[]).filter(function(r){return _pointDist3(tc,r.centroid)<0.2;});
        aNh={nearbyRegionCount:nr.length,nearbyRegionTypes:nr.map(function(r){return r.surfaceType;}),avgDistance:nr.length>0?_round(_mean(nr.map(function(r){return _pointDist3(tc,r.centroid);})),4):0};
      }
      fieldProfiles.push({fieldKey:fk,label:tgt?tgt.label:fk,originalBox:tgt?tgt.normBox:null,preferredOffset:{dx:_round(aDx,6),dy:_round(aDy,6)},
        preferredExpansion:{dw:_round(aDw,6),dh:_round(aDh,6)},geometryConfidence:_round(aC,4),dominantFamily:domFam,correctionCount:fo.length,improvedCount:iC,anchorNeighborhood:aNh,learnedAt:new Date().toISOString()});
    }
    var tI=fieldProfiles.reduce(function(s,p){return s+p.improvedCount;},0);
    var tC=fieldProfiles.reduce(function(s,p){return s+p.correctionCount;},0);
    return{status:tI>0?'improved':'no_improvement',
      message:tI>0?'Geometry improved for '+tI+' of '+tC+' field corrections across '+fieldProfiles.length+' field(s).':'No geometry improvement found. Original positions are optimal.',
      fieldProfiles:fieldProfiles,perDocumentResults:perDocResults,correctionDocCount:corrections.length,learnedAt:new Date().toISOString()};
  }

  function applyGeometryProfile(transferredBox,fieldProfile){
    if(!fieldProfile||!fieldProfile.preferredOffset||fieldProfile.geometryConfidence<0.1)return{refinedBox:transferredBox,applied:false};
    var nX=transferredBox.x0n+fieldProfile.preferredOffset.dx,nY=transferredBox.y0n+fieldProfile.preferredOffset.dy;
    var nW=transferredBox.wN+fieldProfile.preferredExpansion.dw,nH=transferredBox.hN+fieldProfile.preferredExpansion.dh;
    nW=_clamp(nW,0.005,1);nH=_clamp(nH,0.005,1);nX=_clamp(nX,0,Math.max(0,1-nW));nY=_clamp(nY,0,Math.max(0,1-nH));
    return{refinedBox:{x0n:_round(nX,6),y0n:_round(nY,6),wN:_round(nW,6),hN:_round(nH,6)},applied:true};
  }

  function formatGeometryReport(result){
    if(!result)return'[No geometry learning data]';if(result.status==='no_data')return result.message;
    var out='══════════════════════════════════════════════════════════════\n';
    out+='  FIELD INTELLIGENCE REPORT (Phase 3A)\n══════════════════════════════════════════════════════════════\n\n';
    out+='  Status: '+result.status.toUpperCase().replace(/_/g,' ')+'\n  '+result.message+'\n  Corrected Documents: '+result.correctionDocCount+'\n';
    if(result.fieldProfiles&&result.fieldProfiles.length>0){
      out+='\n──────────────────────────────────────────────────────────────\n  FIELD GEOMETRY PROFILES\n──────────────────────────────────────────────────────────────\n';
      for(var pi=0;pi<result.fieldProfiles.length;pi++){
        var p=result.fieldProfiles[pi];
        out+='\n  '+p.label+' ('+p.fieldKey+')\n';
        out+='    Offset: dx='+(p.preferredOffset.dx*100).toFixed(2)+'%, dy='+(p.preferredOffset.dy*100).toFixed(2)+'%\n';
        out+='    Expansion: dw='+(p.preferredExpansion.dw*100).toFixed(2)+'%, dh='+(p.preferredExpansion.dh*100).toFixed(2)+'%\n';
        out+='    Confidence: '+(p.geometryConfidence*100).toFixed(1)+'%\n';
        out+='    Best Family: '+p.dominantFamily.replace(/_/g,' ')+'\n';
        out+='    Improved: '+p.improvedCount+'/'+p.correctionCount+'\n';
      }
    }
    out+='\n══════════════════════════════════════════════════════════════\n';
    return out;
  }

  /* ── Text Landmark Extraction & Matching ──────────────────────────────── */

  function _normalizeTokenText(text){if(!text)return'';return text.toLowerCase().trim().replace(/\s+/g,' ');}

  function _normalizeTokenPos(token,viewport){
    var vpW=viewport.width||viewport.w||1,vpH=viewport.height||viewport.h||1;
    return{x:(token.x+token.w/2)/vpW,y:(token.y+token.h/2)/vpH,w:token.w/vpW,h:token.h/vpH};
  }

  function discoverLandmarks(batchTokens,opts){
    opts=opts||{};var minDocFreq=opts.minDocumentFrequency||0.5;
    var maxOccPerDoc=opts.maxOccurrencesPerDoc||2;var maxPosCV=opts.maxPositionCV||0.35;
    var docIds=Object.keys(batchTokens).filter(function(id){return batchTokens[id]&&batchTokens[id].tokens&&batchTokens[id].tokens.length>0;});
    var docCount=docIds.length;
    if(docCount<2)return{landmarks:[],documentCount:docCount,status:'insufficient_documents',message:'Need at least 2 documents.',discoveredAt:new Date().toISOString()};
    // Build cross-document token index
    var tokenIdx={};
    for(var di=0;di<docIds.length;di++){var dId=docIds[di];var docData=batchTokens[dId];if(!docData||!docData.tokens)continue;
      var toks=docData.tokens;var vp=docData.viewport;
      for(var ti=0;ti<toks.length;ti++){var tok=toks[ti];var txt=_normalizeTokenText(tok.text);
        if(txt.length<2||/^\d+$/.test(txt))continue;
        var np=_normalizeTokenPos(tok,vp);if(!tokenIdx[txt])tokenIdx[txt]={occ:{}};
        if(!tokenIdx[txt].occ[dId])tokenIdx[txt].occ[dId]=[];
        tokenIdx[txt].occ[dId].push({x:np.x,y:np.y,w:np.w,h:np.h,confidence:tok.confidence||0.5});
      }
    }
    // Filter to stable tokens
    var landmarks=[];var lmIdx=0;var txts=Object.keys(tokenIdx);
    for(var i=0;i<txts.length;i++){var text=txts[i];var e=tokenIdx[text];var docs=Object.keys(e.occ);
      if(docs.length/docCount<minDocFreq)continue;
      var ambig=false;for(var d=0;d<docs.length;d++){if(e.occ[docs[d]].length>maxOccPerDoc){ambig=true;break;}}
      if(ambig)continue;
      var positions={};var xs=[],ys=[];
      for(var d2=0;d2<docs.length;d2++){var dId2=docs[d2];var occ=e.occ[dId2];var p=occ[0];
        positions[dId2]={x:_round(p.x,6),y:_round(p.y,6),w:_round(p.w,6),h:_round(p.h,6),
          x0n:_round(p.x-p.w/2,6),y0n:_round(p.y-p.h/2,6),wN:_round(p.w,6),hN:_round(p.h,6),confidence:_round(p.confidence,4)};
        xs.push(p.x);ys.push(p.y);
      }
      var mx=_mean(xs),my=_mean(ys);var sdx=_stddev(xs),sdy=_stddev(ys);
      var cvX=mx>0.01?sdx/mx:sdx;var cvY=my>0.01?sdy/my:sdy;
      if(Math.max(cvX,cvY)>maxPosCV)continue;
      var posStab=_clamp(1-Math.max(cvX,cvY)/maxPosCV,0,1);
      var conf=_clamp((docs.length/docCount)*0.5+posStab*0.5,0,1);
      landmarks.push({landmarkId:'lm-'+lmIdx++,text:text,tokenCount:1,frequency:_round(docs.length/docCount,4),
        positionStability:_round(posStab,4),confidence:_round(conf,4),documentPositions:positions,
        meanPosition:{x:_round(mx,6),y:_round(my,6)}});
    }
    landmarks.sort(function(a,b){return b.confidence-a.confidence;});
    return{landmarks:landmarks,documentCount:docCount,stableTokenCount:landmarks.length,
      status:landmarks.length>0?'discovered':'no_landmarks',
      message:landmarks.length>0?'Discovered '+landmarks.length+' text landmark(s) across '+docCount+' documents.':'No stable text landmarks found.',
      discoveredAt:new Date().toISOString()};
  }

  function buildFieldContext(target,landmarks,refDocId,opts){
    opts=opts||{};var maxDist=opts.maxDistance||0.4;var maxLm=opts.maxLandmarks||10;
    var nb=target.normBox;var cx=nb.x0n+nb.wN/2,cy=nb.y0n+nb.hN/2;var ctxLms=[];
    for(var li=0;li<landmarks.length;li++){var lm=landmarks[li];var lp=lm.documentPositions[refDocId];if(!lp)continue;
      var rx=cx-lp.x,ry=cy-lp.y;var dist=Math.sqrt(rx*rx+ry*ry);if(dist>maxDist)continue;
      ctxLms.push({landmarkId:lm.landmarkId,text:lm.text,relX:_round(rx,6),relY:_round(ry,6),
        distance:_round(dist,6),landmarkConfidence:lm.confidence,landmarkPosition:{x:lp.x,y:lp.y}});
    }
    ctxLms.sort(function(a,b){return a.distance-b.distance;});
    if(ctxLms.length>maxLm)ctxLms=ctxLms.slice(0,maxLm);
    return{fieldKey:target.fieldKey,label:target.label,normBox:nb,bboxCenter:{x:cx,y:cy},
      contextLandmarks:ctxLms,contextLandmarkCount:ctxLms.length};
  }

  function matchLandmarksOnTarget(landmarks,refDocId,targetDocId,targetTokens,targetViewport,opts){
    opts=opts||{};var maxED=opts.maxEditDistance||0.3;
    if(!targetTokens||!targetTokens.length||!landmarks||!landmarks.length)
      return{matches:[],matchCount:0,unmatchedCount:landmarks?landmarks.length:0};
    var vpW=targetViewport.width||targetViewport.w||1,vpH=targetViewport.height||targetViewport.h||1;
    var tgtIdx={};
    for(var ti=0;ti<targetTokens.length;ti++){var tk=targetTokens[ti];var nt=_normalizeTokenText(tk.text);
      if(nt.length<2)continue;if(!tgtIdx[nt])tgtIdx[nt]=[];
      tgtIdx[nt].push({token:tk,normPos:{x:(tk.x+tk.w/2)/vpW,y:(tk.y+tk.h/2)/vpH,w:tk.w/vpW,h:tk.h/vpH}});
    }
    var matches=[],unmatched=0;
    for(var li=0;li<landmarks.length;li++){var lm=landmarks[li];
      var rp=lm.documentPositions[refDocId];if(!rp)continue;
      var tp=lm.documentPositions[targetDocId];
      if(tp){matches.push({landmarkId:lm.landmarkId,text:lm.text,refPosition:{x:rp.x,y:rp.y},
        tgtPosition:{x:tp.x,y:tp.y},matchType:'batch_known',matchScore:1.0,landmarkConfidence:lm.confidence});continue;}
      // Exact match
      if(tgtIdx[lm.text]){var cs=tgtIdx[lm.text];var best=cs[0];
        if(cs.length>1){var bd=Infinity;for(var ci=0;ci<cs.length;ci++){var d=_pointDist(cs[ci].normPos,rp);if(d<bd){bd=d;best=cs[ci];}}}
        matches.push({landmarkId:lm.landmarkId,text:lm.text,refPosition:{x:rp.x,y:rp.y},
          tgtPosition:{x:best.normPos.x,y:best.normPos.y},matchType:'exact',matchScore:1.0,landmarkConfidence:lm.confidence});
      }else{unmatched++;}
    }
    return{matches:matches,matchCount:matches.length,unmatchedCount:unmatched,
      matchRate:landmarks.length>0?_round(matches.length/landmarks.length,4):0};
  }

  function transferBBoxWithLandmarks(fieldContext,landmarkMatches,opts){
    opts=opts||{};var localBW=opts.localBlendWeight||0.7;
    var srcBox=fieldContext.normBox;var srcCX=fieldContext.bboxCenter.x,srcCY=fieldContext.bboxCenter.y;
    if(!landmarkMatches||!landmarkMatches.length)
      return{transferredNormBox:{x0n:srcBox.x0n,y0n:srcBox.y0n,wN:srcBox.wN,hN:srcBox.hN},confidence:0,method:'identity_fallback',anchorsUsed:0};
    // Relative-vector predictions
    var ctx=fieldContext.contextLandmarks||[];var preds=[];
    for(var ci=0;ci<ctx.length;ci++){var c=ctx[ci];var m=null;
      for(var mi=0;mi<landmarkMatches.length;mi++){if(landmarkMatches[mi].landmarkId===c.landmarkId){m=landmarkMatches[mi];break;}}
      if(!m)continue;var w=(1/(c.distance+0.05))*m.matchScore*m.landmarkConfidence;
      preds.push({x:m.tgtPosition.x+c.relX,y:m.tgtPosition.y+c.relY,weight:w});
    }
    // Global transform
    var pairs=[];for(var ti=0;ti<landmarkMatches.length;ti++){var lm=landmarkMatches[ti];
      pairs.push({src:lm.refPosition,dst:lm.tgtPosition,weight:lm.matchScore*lm.landmarkConfidence,anchorId:lm.landmarkId});}
    var gT=null,gCoh=0;
    if(pairs.length>=1){var rr=_estimateRobustTransform(pairs,5,3);if(rr.transform){gT=rr.transform;gCoh=rr.coherence?rr.coherence.coherenceScore:0.5;}}
    var fX,fY,fW=srcBox.wN,fH=srcBox.hN,method;
    if(preds.length>=1&&gT){var tw=0,wx=0,wy=0;
      for(var pi=0;pi<preds.length;pi++){tw+=preds[pi].weight;wx+=preds[pi].x*preds[pi].weight;wy+=preds[pi].y*preds[pi].weight;}
      var lpx=tw>0?wx/tw:srcCX,lpy=tw>0?wy/tw:srcCY;
      var gp=_transformPoint(gT,{x:srcCX,y:srcCY});var gb=_transformNormBox(gT,srcBox);
      var lc=_clamp(preds.length/3,0.3,1);var lw=localBW*lc;var gw=1-lw;
      fX=lpx*lw+gp.x*gw;fY=lpy*lw+gp.y*gw;fW=gb.wN;fH=gb.hN;method='landmark_blended';
    }else if(preds.length>=1){var tw2=0,wx2=0,wy2=0;
      for(var pi2=0;pi2<preds.length;pi2++){tw2+=preds[pi2].weight;wx2+=preds[pi2].x*preds[pi2].weight;wy2+=preds[pi2].y*preds[pi2].weight;}
      fX=tw2>0?wx2/tw2:srcCX;fY=tw2>0?wy2/tw2:srcCY;method='landmark_relative';
    }else if(gT){var gb2=_transformNormBox(gT,srcBox);fX=gb2.x0n+gb2.wN/2;fY=gb2.y0n+gb2.hN/2;fW=gb2.wN;fH=gb2.hN;method='landmark_global';
    }else{fX=srcCX;fY=srcCY;method='identity_fallback';}
    var rX=_clamp(fX-fW/2,0,Math.max(0,1-fW)),rY=_clamp(fY-fH/2,0,Math.max(0,1-fH));
    fW=_clamp(fW,0.001,1);fH=_clamp(fH,0.001,1);
    var conf=_clamp(_clamp(landmarkMatches.length/5,0.2,1)*0.3+_clamp(preds.length/3,0,1)*0.4+gCoh*0.3,0,1);
    return{transferredNormBox:{x0n:_round(rX,6),y0n:_round(rY,6),wN:_round(fW,6),hN:_round(fH,6)},
      confidence:_round(conf,4),method:method,anchorsUsed:landmarkMatches.length,nearbyLandmarksUsed:preds.length};
  }

  function extractWithLandmarks(batchTokens,extractionTargets,refDocId,opts){
    opts=opts||{};
    if(!batchTokens||!extractionTargets||!extractionTargets.length)
      return{status:'no_data',message:'No batch tokens or extraction targets provided.',results:[],landmarks:[]};
    var lr=opts.landmarks||discoverLandmarks(batchTokens,{minDocumentFrequency:opts.minDocumentFrequency||0.5,maxPositionCV:opts.maxPositionCV||0.35});
    var landmarks=lr.landmarks||[];
    if(!landmarks.length)return{status:'no_landmarks',message:'No text landmarks discovered.',results:[],landmarks:[],landmarkReport:lr};
    var fCtxs={};for(var ti=0;ti<extractionTargets.length;ti++){var t=extractionTargets[ti];
      fCtxs[t.fieldKey]=buildFieldContext(t,landmarks,refDocId,{maxDistance:0.4,maxLandmarks:10});}
    var docIds=Object.keys(batchTokens);var results=[];
    for(var di=0;di<docIds.length;di++){var dId=docIds[di];var dd=batchTokens[dId];if(!dd||!dd.tokens)continue;
      var isRef=dId===refDocId;var dr={documentId:dId,documentName:dd.documentName||dId,isReference:isRef,fields:[]};
      var mr=null;if(!isRef)mr=matchLandmarksOnTarget(landmarks,refDocId,dId,dd.tokens,dd.viewport,{maxEditDistance:opts.maxEditDistance||0.3});
      for(var fi=0;fi<extractionTargets.length;fi++){var field=extractionTargets[fi];var tr;
        if(isRef){tr={transferredNormBox:field.normBox,confidence:1,method:'reference_identity',anchorsUsed:0,nearbyLandmarksUsed:0};
        }else{tr=transferBBoxWithLandmarks(fCtxs[field.fieldKey],mr?mr.matches:[],{nearbyRadius:0.25,localBlendWeight:0.7});}
        var ext={text:'',tokenCount:0,confidence:0};
        if(dd.tokens&&dd.viewport)ext=extractTextFromNormBox(tr.transferredNormBox,dd.tokens,dd.viewport);
        dr.fields.push({fieldKey:field.fieldKey,label:field.label,sourceNormBox:field.normBox,
          transferredNormBox:tr.transferredNormBox,transferConfidence:tr.confidence,transferMethod:tr.method,
          anchorsUsed:tr.anchorsUsed,nearbyLandmarksUsed:tr.nearbyLandmarksUsed||0,
          extractedText:ext.text,tokenCount:ext.tokenCount,textConfidence:ext.confidence,textSource:ext.textSource||'no_tokens'});
      }
      if(mr)dr.landmarkMatchDiagnostics={matchCount:mr.matchCount,unmatchedCount:mr.unmatchedCount,matchRate:mr.matchRate};
      results.push(dr);
    }
    return{status:'complete',message:'Extracted '+extractionTargets.length+' field(s) from '+results.length+' document(s) using '+landmarks.length+' landmark(s).',
      extractionTargets:extractionTargets,documentCount:results.length,landmarkCount:landmarks.length,results:results,landmarks:landmarks,
      fieldContexts:fCtxs,extractedAt:new Date().toISOString()};
  }

  function extractWithLandmarkFallback(refinementResult,correspondenceResult,refDoc,batchDocuments,batchTokens,extractionTargets,opts){
    opts=opts||{};var refDocId=refDoc.documentId;
    // Primary: structure-based extraction using region correspondences
    var regionResult=extractFromBatch(refinementResult,correspondenceResult,refDoc,batchDocuments,batchTokens);
    regionResult.extractionStrategy='structure_based';
    if(regionResult.status==='complete'&&regionResult.results&&regionResult.results.length>0){
      // Supplement with landmarks for low-confidence fields
      if(batchTokens&&Object.keys(batchTokens).length>=2&&extractionTargets&&extractionTargets.length>0){
        try{
          var landmarkResult=extractWithLandmarks(batchTokens,extractionTargets,refDocId,opts);
          if(landmarkResult.status==='complete'&&landmarkResult.landmarkCount>=3){
            for(var di=0;di<regionResult.results.length;di++){
              var rDoc=regionResult.results[di];if(rDoc.isReference)continue;
              var lDoc=null;
              for(var ldi=0;ldi<landmarkResult.results.length;ldi++){
                if(landmarkResult.results[ldi].documentId===rDoc.documentId){lDoc=landmarkResult.results[ldi];break;}
              }
              if(!lDoc)continue;
              for(var fi=0;fi<rDoc.fields.length;fi++){
                var rField=rDoc.fields[fi];if(rField.transferConfidence>=0.7)continue;
                var lField=null;
                for(var lfi=0;lfi<lDoc.fields.length;lfi++){
                  if(lDoc.fields[lfi].fieldKey===rField.fieldKey){lField=lDoc.fields[lfi];break;}
                }
                if(!lField||lField.transferConfidence<=rField.transferConfidence)continue;
                var sw=rField.transferConfidence,lw=lField.transferConfidence,tw=sw+lw;
                if(tw>0){
                  sw/=tw;lw/=tw;
                  rField.transferredNormBox={
                    x0n:_round(rField.transferredNormBox.x0n*sw+lField.transferredNormBox.x0n*lw,6),
                    y0n:_round(rField.transferredNormBox.y0n*sw+lField.transferredNormBox.y0n*lw,6),
                    wN:_round(rField.transferredNormBox.wN*sw+lField.transferredNormBox.wN*lw,6),
                    hN:_round(rField.transferredNormBox.hN*sw+lField.transferredNormBox.hN*lw,6)
                  };
                  rField.transferConfidence=_round(Math.max(rField.transferConfidence,lField.transferConfidence),4);
                  rField.transferMethod='structure_landmark_blend';rField.landmarkBoost=true;
                }
              }
            }
            regionResult.landmarkSupplementApplied=true;regionResult.landmarkCount=landmarkResult.landmarkCount;
          }
        }catch(e){regionResult.landmarkSupplementError=e.message||String(e);}
      }
      return regionResult;
    }
    // Fallback: pure landmarks if structure failed
    if(batchTokens&&Object.keys(batchTokens).length>=2&&extractionTargets&&extractionTargets.length>0){
      var fallbackResult=extractWithLandmarks(batchTokens,extractionTargets,refDocId,opts);
      if(fallbackResult.status==='complete'&&fallbackResult.landmarkCount>=3){
        fallbackResult.extractionStrategy='text_landmarks_fallback';return fallbackResult;
      }
    }
    return regionResult;
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
    SESSION_STORAGE_KEY: SESSION_STORAGE_KEY,
    // Batch Structural Learning (Phase 1)
    extractDocumentSummary: extractDocumentSummary,
    analyzeBatchStability: analyzeBatchStability,
    formatStabilityReport: formatStabilityReport,
    createBatchSessionStore: createBatchSessionStore,
    compactForStorage: compactForStorage,
    BATCH_SESSION_STORAGE_KEY: BATCH_SESSION_STORAGE_KEY,
    // Structural Correspondence (Phase 2)
    analyzeCorrespondence: analyzeCorrespondence,
    formatCorrespondenceReport: formatCorrespondenceReport,
    selectReferenceDocument: selectReferenceDocument,
    computeRegionSimilarity: computeRegionSimilarity,
    matchDocumentRegions: matchDocumentRegions,
    // Anchor Refinement + Extraction (Phase 2B)
    refineAnchors: refineAnchors,
    computeTargetNeighborhood: computeTargetNeighborhood,
    scoreAnchorRelevance: scoreAnchorRelevance,
    transferBBox: transferBBox,
    extractTextFromNormBox: extractTextFromNormBox,
    extractFromBatch: extractFromBatch,
    extractWithLandmarkFallback: extractWithLandmarkFallback,
    formatRefinementReport: formatRefinementReport,
    formatExtractionReport: formatExtractionReport,
    // Text Landmark Pipeline
    discoverLandmarks: discoverLandmarks,
    buildFieldContext: buildFieldContext,
    matchLandmarksOnTarget: matchLandmarksOnTarget,
    transferBBoxWithLandmarks: transferBBoxWithLandmarks,
    extractWithLandmarks: extractWithLandmarks,
    // Field Intelligence (Phase 3A)
    learnFieldGeometry: learnFieldGeometry,
    optimizeFieldGeometry: optimizeFieldGeometry,
    generateCandidates: generateCandidates,
    scoreCandidate: scoreCandidate,
    applyGeometryProfile: applyGeometryProfile,
    formatGeometryReport: formatGeometryReport
  };

})(typeof self !== 'undefined' ? self : this);
