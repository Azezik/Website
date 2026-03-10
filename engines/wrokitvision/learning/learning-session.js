'use strict';

/*───────────────────────────────────────────────────────────────────────────────
  learning-session.js  –  Manages a single Learning mode annotation session
  ─────────────────────────────────────────────────────────────────────────────

  A learning session wraps the user interaction for one image:
    1. User uploads an image/document
    2. System runs precompute (region detection, text detection) as usual
    3. System presents prompts asking user to draw boxes around regions
    4. User draws boxes using the same overlay canvas as config mode
    5. Session collects all boxes and saves them as an AnnotationRecord

  The session reuses config mode's drawing infrastructure but changes the
  interaction model:
    - Instead of one box per named field, user can draw many boxes freely
    - Prompts are broader: "mark visual regions", "mark text groups", etc.
    - Each box gets a category label, not a field key
    - The session compares human boxes against auto-detected regions

  Usage:
    const session = createLearningSession({ viewport, tokens, analysisResult });
    session.addAnnotation({ label, category, rawBox, tokenIds, text });
    session.addAnnotation({ ... });
    const record = session.finalize({ imageId, imageName });
    // record is an AnnotationRecord ready for learningStore.addRecord()
───────────────────────────────────────────────────────────────────────────────*/

const {
  ANNOTATION_CATEGORIES,
  createAnnotationBox,
  createAnnotationRecord,
  snapshotRegion
} = require('./learning-store');

/* ── Prompt definitions ──────────────────────────────────────────────────── */

/**
 * Learning prompts define the sequence of annotation tasks presented to the
 * user. Each prompt asks the user to mark a specific type of visual element.
 *
 * Unlike config mode (which iterates field-specific steps), learning prompts
 * are broad and encourage the user to draw as many boxes as needed per prompt.
 */
const LEARNING_PROMPTS = Object.freeze([
  {
    id: 'visual_regions',
    category: 'visual_region',
    title: 'Visual Regions',
    instruction: 'Draw boxes around all distinct visual regions you can see. ' +
      'These are areas that look like separate sections, panels, cards, or blocks. ' +
      'Keep drawing until the image is broken into meaningful parts.',
    multiBox: true
  },
  {
    id: 'text_groups',
    category: 'text_group',
    title: 'Text Groups',
    instruction: 'Draw boxes around groups of text that belong together. ' +
      'For example: an address block, a set of line items, a title area, ' +
      'or any cluster of text that forms a logical unit.',
    multiBox: true
  },
  {
    id: 'labels',
    category: 'label',
    title: 'Labels & Headings',
    instruction: 'Draw boxes around any labels, headings, or titles. ' +
      'These are words or phrases that name or describe something else, ' +
      'like "Invoice Number", "Total", "Ship To", or "Date".',
    multiBox: true
  },
  {
    id: 'field_values',
    category: 'field_value',
    title: 'Field Values',
    instruction: 'Draw boxes around specific data values. ' +
      'These are the actual numbers, dates, names, or codes ' +
      'that a label refers to — the content you would want to extract.',
    multiBox: true
  },
  {
    id: 'shapes',
    category: 'shape',
    title: 'Shapes & Non-Text Elements',
    instruction: 'Draw boxes around non-text visual elements: ' +
      'logos, icons, dividers, decorative borders, images, or any ' +
      'visual element that is not text. Skip this if there are none.',
    multiBox: true,
    optional: true
  },
  {
    id: 'structural_sections',
    category: 'structural_section',
    title: 'Structural Sections',
    instruction: 'Draw boxes around the major structural divisions of the document. ' +
      'For example: header area, body/content area, footer area, sidebar. ' +
      'These are the biggest organizational blocks.',
    multiBox: true,
    optional: true
  }
]);

/* ── IoU (Intersection over Union) ───────────────────────────────────────── */

/**
 * Computes how much two boxes overlap, from 0 (no overlap) to 1 (identical).
 * This is a standard measure used to compare human-drawn vs auto-detected regions.
 *
 * In plain language: if you drew a box and the system also drew a box, IoU
 * tells you what fraction of the combined area is shared by both boxes.
 */
function computeIoU(boxA, boxB){
  const ax0 = Number(boxA?.x0n ?? boxA?.x) || 0;
  const ay0 = Number(boxA?.y0n ?? boxA?.y) || 0;
  const ax1 = ax0 + (Number(boxA?.wN ?? boxA?.w) || 0);
  const ay1 = ay0 + (Number(boxA?.hN ?? boxA?.h) || 0);

  const bx0 = Number(boxB?.x0n ?? boxB?.x) || 0;
  const by0 = Number(boxB?.y0n ?? boxB?.y) || 0;
  const bx1 = bx0 + (Number(boxB?.wN ?? boxB?.w) || 0);
  const by1 = by0 + (Number(boxB?.hN ?? boxB?.h) || 0);

  const interX = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const interY = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const interArea = interX * interY;

  const areaA = (ax1 - ax0) * (ay1 - ay0);
  const areaB = (bx1 - bx0) * (by1 - by0);
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/* ── Region comparison ───────────────────────────────────────────────────── */

/**
 * Compares human-drawn annotations against the system's auto-detected regions.
 * Returns a comparison report that shows:
 *   - Which human boxes matched a system region (true positives)
 *   - Which human boxes had no matching system region (missed by system)
 *   - Which system regions had no matching human box (extra detections)
 *
 * iouThreshold: minimum overlap to count as a "match" (default 0.3 = 30%)
 */
function compareAnnotationsToRegions(annotations, autoRegions, iouThreshold = 0.3){
  const humanBoxes = (annotations || []).filter(a =>
    a.category === 'visual_region' || a.category === 'structural_section'
  );

  const matchedHuman = new Set();
  const matchedAuto  = new Set();
  const matches = [];

  for(let hi = 0; hi < humanBoxes.length; hi++){
    let bestIoU = 0;
    let bestAutoIdx = -1;
    for(let ai = 0; ai < autoRegions.length; ai++){
      const iou = computeIoU(humanBoxes[hi].normBox, autoRegions[ai].normBox);
      if(iou > bestIoU){
        bestIoU = iou;
        bestAutoIdx = ai;
      }
    }
    if(bestIoU >= iouThreshold && bestAutoIdx >= 0){
      matchedHuman.add(hi);
      matchedAuto.add(bestAutoIdx);
      matches.push({
        humanBox: humanBoxes[hi],
        autoRegion: autoRegions[bestAutoIdx],
        iou: bestIoU
      });
    }
  }

  const missedBySystem = humanBoxes.filter((_, i) => !matchedHuman.has(i));
  const extraDetections = autoRegions.filter((_, i) => !matchedAuto.has(i));

  const precision = autoRegions.length ? matchedAuto.size / autoRegions.length : 0;
  const recall = humanBoxes.length ? matchedHuman.size / humanBoxes.length : 0;

  return {
    matches,
    missedBySystem,
    extraDetections,
    stats: {
      humanRegionCount: humanBoxes.length,
      autoRegionCount: autoRegions.length,
      matchCount: matches.length,
      missedCount: missedBySystem.length,
      extraCount: extraDetections.length,
      averageIoU: matches.length
        ? matches.reduce((s, m) => s + m.iou, 0) / matches.length
        : 0,
      precision,
      recall
    }
  };
}

/* ── Learning session ────────────────────────────────────────────────────── */

function createLearningSession({ viewport, tokens, analysisResult } = {}){
  const vp = { w: Number(viewport?.w) || 0, h: Number(viewport?.h) || 0 };
  const annotations = [];
  let finalized = false;

  // Snapshot auto-detected regions at session start
  const autoRegions = (analysisResult?.regionNodes || []).map(r => snapshotRegion(r, vp));

  return {
    /** The prompts to present to the user, in order. */
    getPrompts(){
      return LEARNING_PROMPTS;
    },

    /** Get the current prompt categories available. */
    getCategories(){
      return ANNOTATION_CATEGORIES;
    },

    /** Add a human-drawn annotation box. */
    addAnnotation({ label, category, rawBox, tokenIds, text, notes } = {}){
      if(finalized) throw new Error('Session already finalized');
      const box = createAnnotationBox({ label, category, rawBox, viewport: vp, tokenIds, text, notes });
      annotations.push(box);
      return box;
    },

    /** Remove the last annotation (undo). */
    undoLast(){
      if(finalized) throw new Error('Session already finalized');
      return annotations.pop() || null;
    },

    /** Remove a specific annotation by boxId. */
    removeAnnotation(boxId){
      if(finalized) throw new Error('Session already finalized');
      const idx = annotations.findIndex(a => a.boxId === boxId);
      if(idx >= 0) return annotations.splice(idx, 1)[0];
      return null;
    },

    /** Current annotation count. */
    annotationCount(){
      return annotations.length;
    },

    /** Get all current annotations. */
    getAnnotations(){
      return annotations.slice();
    },

    /** Get annotations filtered by category. */
    getAnnotationsByCategory(category){
      return annotations.filter(a => a.category === category);
    },

    /** Get the auto-detected regions (for overlay display). */
    getAutoRegions(){
      return autoRegions;
    },

    /** Compare current human annotations against auto-detected regions. */
    compareToAutoRegions(iouThreshold){
      return compareAnnotationsToRegions(annotations, autoRegions, iouThreshold);
    },

    /**
     * Finalize the session and produce an AnnotationRecord.
     * Call this when the user is done annotating the current image.
     */
    finalize({ imageId, imageName, metadata } = {}){
      if(finalized) throw new Error('Session already finalized');
      finalized = true;

      const comparison = compareAnnotationsToRegions(annotations, autoRegions);

      const record = createAnnotationRecord({
        imageId,
        imageName,
        viewport: vp,
        annotations: annotations.slice(),
        autoRegions,
        metadata: {
          ...(metadata || {}),
          comparison: comparison.stats,
          tokenCount: Array.isArray(tokens) ? tokens.length : 0
        }
      });

      return record;
    },

    /** Whether finalize() has been called. */
    isFinalized(){
      return finalized;
    }
  };
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  LEARNING_PROMPTS,
  computeIoU,
  compareAnnotationsToRegions,
  createLearningSession
};
