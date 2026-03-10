'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  learning-store.js  –  Persistent annotation store for Wrokit Vision Learning
  ─────────────────────────────────────────────────────────────────────────────

  Stores human-drawn bounding-box annotations collected during Learning mode
  sessions. These annotations become reusable training data that Wrokit Vision
  can use to improve region detection, structural understanding, and extraction
  ranking across many documents.

  Storage format: an array of AnnotationRecord objects persisted to localStorage
  (browser) or an in-memory map (Node).  Each record captures:
    - The image/document identity
    - All human-drawn boxes for that image
    - The auto-detected regions at the time of annotation (for comparison)
    - Viewport dimensions (for normalization)

  AnnotationRecord schema:
  {
    recordId:     string,           // unique ID for this annotation set
    imageId:      string,           // identifier for the source image/document
    imageName:    string,           // human-readable filename
    timestamp:    string,           // ISO 8601 creation time
    viewport:     { w, h },         // viewport at annotation time
    annotations:  AnnotationBox[],  // human-drawn boxes (see below)
    autoRegions:  RegionSnapshot[], // system-detected regions at annotation time
    metadata:     {}                // optional extra info (source, notes, etc.)
  }

  AnnotationBox schema:
  {
    boxId:        string,           // unique box ID
    label:        string,           // semantic label chosen by user
    category:     string,           // one of the ANNOTATION_CATEGORIES
    normBox:      { x0n, y0n, wN, hN },   // normalized 0–1 coordinates
    rawBox:       { x, y, w, h },          // pixel coordinates at draw time
    tokens:       string[],         // OCR token IDs overlapping this box
    text:         string,           // concatenated text content (if any)
    confidence:   number,           // 1.0 for human-drawn (ground truth)
    notes:        string            // optional user notes
  }

  RegionSnapshot schema (mirrors the system's own region format):
  {
    regionId:     string,
    bbox:         { x, y, w, h },
    normBox:      { x0n, y0n, wN, hN },
    confidence:   number,
    textDensity:  number,
    surfaceType:  string
  }
───────────────────────────────────────────────────────────────────────────────*/

const STORAGE_KEY = 'wrokit.learning.annotations';

const ANNOTATION_CATEGORIES = Object.freeze([
  'visual_region',      // a distinct visual area (panel, card, section)
  'text_group',         // a coherent group of text (address block, line items)
  'label',              // a label or heading (field name, section title)
  'shape',              // a non-text visual element (logo, icon, divider)
  'field_value',        // a specific data value (price, date, ID number)
  'structural_section', // a major structural division (header, footer, sidebar)
  'other'               // anything that doesn't fit the above
]);

/* ── Helpers ─────────────────────────────────────────────────────────────── */

let _idCounter = 0;
function generateId(prefix){
  _idCounter += 1;
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rnd}-${_idCounter}`;
}

function clamp01(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeBox(rawBox, viewport){
  const x = Number(rawBox?.x) || 0;
  const y = Number(rawBox?.y) || 0;
  const w = Math.max(0, Number(rawBox?.w) || 0);
  const h = Math.max(0, Number(rawBox?.h) || 0);
  const vpW = Math.max(1, Number(viewport?.w) || 1);
  const vpH = Math.max(1, Number(viewport?.h) || 1);
  return {
    x0n: clamp01(x / vpW),
    y0n: clamp01(y / vpH),
    wN:  clamp01(w / vpW),
    hN:  clamp01(h / vpH)
  };
}

function snapshotRegion(region, viewport){
  const bbox = region?.geometry?.bbox || region?.bbox || {};
  const x = Number(bbox.x) || 0;
  const y = Number(bbox.y) || 0;
  const w = Math.max(0, Number(bbox.w) || 0);
  const h = Math.max(0, Number(bbox.h) || 0);
  return {
    regionId:    region?.id || null,
    bbox:        { x, y, w, h },
    normBox:     normalizeBox({ x, y, w, h }, viewport),
    confidence:  Number(region?.confidence) || 0,
    textDensity: Number(region?.textDensity) || 0,
    surfaceType: region?.surfaceTypeCandidate || 'unknown'
  };
}

/* ── AnnotationBox factory ───────────────────────────────────────────────── */

function createAnnotationBox({ label, category, rawBox, viewport, tokenIds, text, notes } = {}){
  const cat = ANNOTATION_CATEGORIES.includes(category) ? category : 'other';
  const raw = {
    x: Number(rawBox?.x) || 0,
    y: Number(rawBox?.y) || 0,
    w: Math.max(0, Number(rawBox?.w) || 0),
    h: Math.max(0, Number(rawBox?.h) || 0)
  };
  return {
    boxId:      generateId('abox'),
    label:      String(label || '').trim() || cat,
    category:   cat,
    normBox:    normalizeBox(raw, viewport),
    rawBox:     raw,
    tokens:     Array.isArray(tokenIds) ? tokenIds : [],
    text:       String(text || ''),
    confidence: 1.0,
    notes:      String(notes || '')
  };
}

/* ── AnnotationRecord factory ────────────────────────────────────────────── */

function createAnnotationRecord({ imageId, imageName, viewport, annotations, autoRegions, metadata } = {}){
  return {
    recordId:    generateId('lrec'),
    imageId:     String(imageId || ''),
    imageName:   String(imageName || ''),
    timestamp:   new Date().toISOString(),
    viewport:    { w: Number(viewport?.w) || 0, h: Number(viewport?.h) || 0 },
    annotations: Array.isArray(annotations) ? annotations : [],
    autoRegions: Array.isArray(autoRegions) ? autoRegions : [],
    metadata:    metadata || {}
  };
}

/* ── Storage backend ─────────────────────────────────────────────────────── */

function createLearningStore(storage){
  // storage: anything with getItem/setItem (localStorage, or an in-memory shim)
  const backend = storage || createMemoryBackend();

  function _load(){
    try {
      const raw = backend.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(_e){ return []; }
  }

  function _save(records){
    backend.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  return {
    /** Append one annotation record. Returns the recordId. */
    addRecord(record){
      const records = _load();
      records.push(record);
      _save(records);
      return record.recordId;
    },

    /** Get all annotation records. */
    getAllRecords(){
      return _load();
    },

    /** Get records for a specific image. */
    getRecordsByImage(imageId){
      return _load().filter(r => r.imageId === imageId);
    },

    /** Get a single record by ID. */
    getRecord(recordId){
      return _load().find(r => r.recordId === recordId) || null;
    },

    /** Delete a record by ID. */
    deleteRecord(recordId){
      const records = _load().filter(r => r.recordId !== recordId);
      _save(records);
    },

    /** Total number of stored annotation records. */
    count(){
      return _load().length;
    },

    /** Total number of individual boxes across all records. */
    totalAnnotations(){
      return _load().reduce((sum, r) => sum + (r.annotations?.length || 0), 0);
    },

    /** Summary stats for quick display. */
    stats(){
      const records = _load();
      const totalBoxes = records.reduce((sum, r) => sum + (r.annotations?.length || 0), 0);
      const categories = {};
      for(const rec of records){
        for(const ann of rec.annotations || []){
          categories[ann.category] = (categories[ann.category] || 0) + 1;
        }
      }
      return {
        totalRecords: records.length,
        totalBoxes,
        categories,
        oldestTimestamp: records.length ? records[0].timestamp : null,
        newestTimestamp: records.length ? records[records.length - 1].timestamp : null
      };
    },

    /** Clear all learning data. */
    clear(){
      _save([]);
    },

    /** Export all records as a JSON string (for backup/sharing). */
    exportJSON(){
      return JSON.stringify(_load(), null, 2);
    },

    /** Import records from a JSON string (merges with existing). */
    importJSON(json){
      try {
        const incoming = JSON.parse(json);
        if(!Array.isArray(incoming)) return 0;
        const existing = _load();
        const existingIds = new Set(existing.map(r => r.recordId));
        let added = 0;
        for(const rec of incoming){
          if(rec.recordId && !existingIds.has(rec.recordId)){
            existing.push(rec);
            existingIds.add(rec.recordId);
            added += 1;
          }
        }
        _save(existing);
        return added;
      } catch(_e){ return 0; }
    }
  };
}

/* ── In-memory fallback for Node / tests ─────────────────────────────────── */

function createMemoryBackend(){
  const map = new Map();
  return {
    getItem(key){ return map.get(key) || null; },
    setItem(key, value){ map.set(key, value); }
  };
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  ANNOTATION_CATEGORIES,
  createAnnotationBox,
  createAnnotationRecord,
  snapshotRegion,
  normalizeBox,
  createLearningStore,
  createMemoryBackend,
  STORAGE_KEY
};
