# Wrokit Vision: Lightweight Learning System

## Overview

This document describes the Learning mode system for Wrokit Vision — a
lightweight, annotation-driven approach to improving the system's heuristics
using the existing config-mode bounding-box drawing interface.

**Key insight:** Wrokit already has an annotation mechanism. In config mode, the
user draws bounding boxes around fields. Those boxes are human-provided ground
truth. The Learning module promotes that same interaction from "template setup
for one wizard" into "reusable training data across many documents."

---

## Architecture

### What changed

| Component | Before | After |
|-----------|--------|-------|
| `tools/wizard-mode.js` | Two modes: CONFIG, RUN | Three modes: CONFIG, RUN, **LEARN** |
| Annotation data | One-off wizard geometry | Reusable training records in `LearningStore` |
| Region detection params | Hardcoded constants | Can be tuned from annotation data |
| Ranking weights | Hardcoded in `candidate-ranking/index.js` | Analyzable against annotation ground truth |

### New modules

```
engines/wrokitvision/learning/
├── index.js              ← Public API (imports the three sub-modules)
├── learning-store.js     ← Persists annotation records (localStorage or memory)
├── learning-session.js   ← Manages one annotation session per image
└── learning-analyst.js   ← Derives parameter recommendations from stored data
```

### How it fits into the existing pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    EXISTING WROKIT PIPELINE                  │
│                                                             │
│  CONFIG mode ──→ User draws bbox ──→ Profile saved          │
│                                       ↓                     │
│  RUN mode ────→ Load profile ────→ Extract fields           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    NEW LEARNING PIPELINE                     │
│                                                             │
│  LEARN mode ──→ User draws boxes ──→ AnnotationRecord saved │
│                  (same canvas UI)     ↓                     │
│                                  LearningStore accumulates  │
│                                       ↓                     │
│                                  LearningAnalyst runs       │
│                                       ↓                     │
│                                  Parameter recommendations  │
│                                       ↓                     │
│                                  Feed back into pipeline:   │
│                                  • merge threshold          │
│                                  • min region area          │
│                                  • surface thresholds       │
│                                  • ranking weights          │
│                                  • confidence thresholds    │
└─────────────────────────────────────────────────────────────┘
```

---

## How Learning Mode Works (User Perspective)

1. **Enter Learning mode** (like entering Config mode, but purpose is annotation)
2. **Upload an image** — system runs precompute as usual (region detection, OCR)
3. **System presents prompts** — broader than config mode:
   - "Draw boxes around all distinct visual regions"
   - "Mark all meaningful text groups"
   - "Mark labels and headings"
   - "Mark specific data values"
   - "Mark non-text elements (logos, icons, dividers)" (optional)
   - "Mark major structural sections (header, body, footer)" (optional)
4. **Draw as many boxes as needed per prompt** — not one box per field,
   but as many as it takes to fully segment the image
5. **Session finalizes** — system compares human boxes against auto-detected
   regions and stores the full annotation record

### Key difference from Config mode

| | Config Mode | Learning Mode |
|---|-------------|---------------|
| Purpose | Build one template for extraction | Build training data for improvement |
| Boxes per image | One per field (5-15 typical) | Many per category (20-50+ typical) |
| What boxes represent | "Extract this field here" | "This is a meaningful region/group/label" |
| Output | Profile with field geometry | AnnotationRecord in LearningStore |
| Reuse | One wizard, many documents | Many documents, improving one system |

---

## Data Schema

### AnnotationRecord (what gets stored per image)

```json
{
  "recordId": "lrec-m3f8k-a2x9-1",
  "imageId": "receipt-042",
  "imageName": "receipt.png",
  "timestamp": "2026-03-10T14:30:00.000Z",
  "viewport": { "w": 800, "h": 1100 },
  "annotations": [
    {
      "boxId": "abox-m3f8k-b4y2-1",
      "label": "company header",
      "category": "visual_region",
      "normBox": { "x0n": 0.05, "y0n": 0.02, "wN": 0.90, "hN": 0.12 },
      "rawBox": { "x": 40, "y": 22, "w": 720, "h": 132 },
      "tokens": ["tok-001", "tok-002", "tok-003"],
      "text": "ACME Hardware Store",
      "confidence": 1.0,
      "notes": ""
    }
  ],
  "autoRegions": [
    {
      "regionId": "sr-001",
      "bbox": { "x": 35, "y": 18, "w": 730, "h": 140 },
      "normBox": { "x0n": 0.044, "y0n": 0.016, "wN": 0.913, "hN": 0.127 },
      "confidence": 0.62,
      "textDensity": 0.45,
      "surfaceType": "region_surface"
    }
  ],
  "metadata": {
    "comparison": {
      "humanRegionCount": 8,
      "autoRegionCount": 12,
      "matchCount": 6,
      "missedCount": 2,
      "extraCount": 6,
      "averageIoU": 0.58,
      "precision": 0.50,
      "recall": 0.75
    }
  }
}
```

### Annotation categories

| Category | What to draw | Example |
|----------|-------------|---------|
| `visual_region` | Distinct visual areas | A panel, card, or bordered section |
| `text_group` | Coherent text clusters | An address block, line item group |
| `label` | Labels, headings, titles | "Invoice Number", "Total", "Date" |
| `field_value` | Specific data values | "INV-2024-001", "$47.82", "2025-11-15" |
| `shape` | Non-text visual elements | Logo, icon, divider line |
| `structural_section` | Major document divisions | Header area, body, footer |

---

## What the Analyst Produces

After annotating 5+ images, `LearningAnalyst.analyzeAll()` returns:

### 1. Region Detection Recommendations

```json
{
  "segmentationBias": "over",
  "suggestedMergeThreshold": 38,
  "suggestedMinRegionArea": 3500,
  "evidence": {
    "avgHumanRegionCount": 8.2,
    "avgAutoRegionCount": 14.6,
    "avgIoU": 0.52,
    "avgRecall": 0.78
  }
}
```

**Plain language:** "The system is detecting too many regions (14.6 auto vs 8.2
human). Raising the merge threshold from 32 to 38 would make it combine more
small regions into larger ones, closer to what the human drew."

### 2. Surface Classification Recommendations

```json
{
  "suggestedTextDenseThreshold": 0.50,
  "suggestedPanelTextDensityMax": 0.30,
  "evidence": {
    "medianTextDensity": 0.62,
    "medianNonTextDensity": 0.18,
    "splitAccuracy": 0.89
  }
}
```

### 3. Ranking Weight Recommendations

```json
{
  "suggestedWeights": {
    "anchorTextSimilarity": 0.22,
    "nearbyLabelSimilarity": 0.20,
    "structuralSimilarity": 0.14,
    "containingRegionSimilarity": 0.10,
    "siblingArrangementSimilarity": 0.10,
    "localGeometrySimilarity": 0.13,
    "graphRelationshipSimilarity": 0.11
  }
}
```

### 4. Confidence Threshold Recommendations

```json
{
  "suggestedMinConfidence": 0.60,
  "evidence": {
    "medianMatchedConfidence": 0.72,
    "medianUnmatchedConfidence": 0.41,
    "bestF1": 0.85
  }
}
```

---

## Classical Computer Vision Concepts Used

The analyst module uses several well-established techniques, none of which
require neural networks or ML libraries:

| Technique | What it does | Where used |
|-----------|-------------|-----------|
| **IoU (Intersection over Union)** | Measures overlap between two boxes (0–1 scale) | Comparing human vs auto regions |
| **Precision / Recall** | How many auto regions are correct vs how many correct regions were found | Region detection analysis |
| **F1 Score** | Single number combining precision and recall | Confidence threshold optimization |
| **Decision stump** | Finding the best single cutoff value to split two groups | Surface classification threshold |
| **Grid search** | Trying many parameter combinations to find the best | Weight tuning |
| **Percentile statistics** | Finding the 5th-percentile smallest human region | Min region area suggestion |

---

## Data Collection Guidance

### What makes good learning data

The most valuable images for Learning mode are:

1. **Real documents from actual Wrokit use cases** — whatever you actually extract
2. **Existing failure cases** — images where Wrokit Vision got something wrong
3. **Diverse layouts** — same document type from different sources
4. **Public datasets** (SROIE, CORD, FUNSD) — large, pre-annotated collections

### How many images to annotate

| Count | Quality of recommendations |
|-------|---------------------------|
| 1-4 | Too early — preliminary only |
| 5-14 | Developing — useful directional signal |
| 15-30 | Reliable — confident recommendations |
| 30+ | Strong — ready for weight tuning |

### Random screenshots (Google Maps, etc.)

Not recommended for Learning mode. Wrokit Vision is built for document-like
layouts with text fields. Random visual scenes exercise different capabilities
than the system actually needs.

---

## Implementation Status

- [x] `WizardMode.LEARN` added to `tools/wizard-mode.js`
- [x] `learning-store.js` — annotation persistence with import/export
- [x] `learning-session.js` — session management with auto-region comparison
- [x] `learning-analyst.js` — parameter recommendation engine
- [x] `learning/index.js` — public API
- [ ] UI integration — wire Learning mode into `invoice-wizard.js` UI
- [ ] Apply recommendations — auto-update parameters from analyst output
- [ ] Batch evaluation harness — run extraction with tuned params across test set
