# Wrokit Vision: Lightweight Learning Roadmap

## Overview

This document outlines a practical, phased approach to making Wrokit Vision
behave more like a learning system — without requiring a full machine learning
pipeline, external libraries, or deep technical expertise.

The core idea: Wrokit Vision already scores and ranks candidates using multiple
weighted factors. "Learning" in this context means systematically adjusting
those factors based on recorded outcomes, rather than hand-tuning them through
manual review.

---

## Phase 1: Structured Feedback Logging

**Goal:** Replace informal screenshot review with structured, machine-readable
outcome records.

**What to build:**

A feedback log — a JSON file (or set of files) where each entry records:

```json
{
  "imageId": "receipt-0042",
  "fieldType": "invoice_number",
  "systemPick": { "text": "INV-2024-001", "confidence": 0.72, "rank": 1 },
  "correctAnswer": { "text": "INV-2024-001", "wasCorrect": true },
  "alternativeCandidates": [
    { "text": "2024-001", "confidence": 0.58, "rank": 2 },
    { "text": "001", "confidence": 0.41, "rank": 3 }
  ],
  "timestamp": "2026-03-10T14:30:00Z"
}
```

For incorrect results, `wasCorrect` is `false` and `correctAnswer.text` records
what the answer should have been.

**Integration point:** After `wrokit-vision-engine.js` performs candidate
ranking and selection, emit the feedback record before returning the result.
During normal operation this can write to a local log file. During evaluation
runs it accumulates into a batch results file.

**Effort:** Small. One new utility function and a few lines at the extraction
return point.

---

## Phase 2: Evaluation Harness

**Goal:** Run Wrokit Vision against a set of annotated test images and measure
accuracy automatically.

**What to build:**

1. **Annotation file format** — a simple manifest listing images and their
   correct field values:

```json
[
  {
    "imageFile": "test-images/receipt-001.png",
    "ocrFile": "test-images/receipt-001-ocr.json",
    "fields": {
      "store_name": "ACME Hardware",
      "total": "47.82",
      "date": "2025-11-15"
    }
  }
]
```

2. **Evaluation script** — reads the manifest, runs the Wrokit Vision pipeline
   on each image, compares outputs to expected values, and produces a summary:

```
Total images:    50
Total fields:    150
Correct:         112 (74.7%)
Incorrect:        28 (18.7%)
Low-confidence:   10 (6.7%)

Per-field breakdown:
  store_name:      82% correct
  invoice_number:  71% correct
  total:           78% correct
  date:            68% correct
```

**Why this matters:** Without an evaluation harness, every change is tested by
eyeballing. With one, you can measure whether a change helps or hurts across
all your test cases at once.

**Effort:** Medium. Requires writing the evaluation script and annotating an
initial set of test images (aim for 30+ images to start).

---

## Phase 3: Confidence Calibration

**Goal:** Adjust the confidence threshold per field type based on observed
reliability.

**Current state:** A single fixed threshold of `0.64` in
`wrokit-vision-engine.js` governs acceptance for all field types.

**What to build:**

Using Phase 1 feedback data, compute per-field-type reliability curves:

```
When confidence >= 0.80:  store_name correct 95%,  date correct 88%
When confidence >= 0.70:  store_name correct 87%,  date correct 72%
When confidence >= 0.60:  store_name correct 74%,  date correct 61%
```

Then set per-field thresholds to the confidence level where accuracy is
acceptable (e.g., 80%+):

```json
{
  "store_name": 0.65,
  "invoice_number": 0.70,
  "total": 0.60,
  "date": 0.75
}
```

**Integration point:** Replace the single `0.64` threshold check with a lookup
into the per-field calibration table. The table is loaded from a config file
that gets updated whenever the calibration script runs on new data.

**Effort:** Small code change + depends on having enough feedback data
(Phase 1) and an evaluation harness (Phase 2) to compute the curves.

---

## Phase 4: Scoring Weight Tuning

**Goal:** Automatically find better weights for the candidate ranking factors.

**Current state:** Candidate ranking in `wrokit-vision-engine.js` and
`candidate-ranking/index.js` combines multiple sub-scores (distance, label
hint, format validity, structural fit, cross-field consistency) with
hand-chosen weights.

**What to build:**

1. **Extract weights into a config file** rather than hardcoded constants:

```json
{
  "distanceWeight": 0.30,
  "labelHintWeight": 0.25,
  "formatWeight": 0.20,
  "structuralWeight": 0.15,
  "crossFieldWeight": 0.10
}
```

2. **Weight tuning script** that:
   - Loads the annotated test set (Phase 2 manifest)
   - Tries many combinations of weights (grid search)
   - For each combination, runs the evaluation and records accuracy
   - Picks the combination that maximizes overall accuracy
   - Saves the best weights to the config file

This can be a brute-force search over a reasonable grid. With 5 weights and
10 values each, that is 100,000 combinations — each just re-scoring existing
candidates without re-running the full pipeline, so it runs in seconds.

**Integration point:** Scoring functions read weights from the config file
instead of using hardcoded values. The tuning script writes to the same file.

**Effort:** Medium. Requires refactoring weight constants into config (small)
and writing the grid search script (moderate).

---

## Phase 5: Pattern-Based Rule Discovery (Future)

**Goal:** Automatically discover new heuristic rules from annotated examples.

This phase is not recommended until Phases 1-4 are complete and producing
diminishing returns. It involves analyzing systematic failure patterns in the
feedback log and generating new rules — for example:

- "When the correct store name was missed, it was in the top 10% of the image
  85% of the time → add a positional bias for store_name toward the top."
- "Date fields are frequently confused with invoice numbers when both are
  numeric → add a mutual exclusion constraint."

This is the closest to "real" machine learning in spirit but can still be done
with simple statistical analysis rather than neural networks.

---

## Data Collection Guidance

### What to collect

| Priority | Source | Why |
|----------|--------|-----|
| High | Real documents from actual Wrokit use cases | Directly relevant; exercises real failure modes |
| High | Existing failure cases (screenshots already reviewed) | Known problem areas that need improvement |
| Medium | Public datasets (SROIE, CORD, FUNSD) | Large, pre-annotated, broadens coverage |
| Low | Random screenshots (Google Maps, etc.) | Wrong domain; Wrokit Vision is built for document-like layouts |

### Recommended public datasets

- **SROIE** (Scanned Receipts OCR and Information Extraction)
  - 1,000 receipt images, labeled with store name, date, address, total
  - Closest match to typical Wrokit Vision use cases
  - https://rrc.cvc.uab.es/?ch=13

- **CORD** (Consolidated Receipt Dataset)
  - 11,000 receipt images, 30 labeled field types
  - Much larger; good for weight tuning at scale
  - Available via Hugging Face datasets

- **FUNSD** (Form Understanding in Noisy Scanned Documents)
  - 199 form images with key-value pair annotations
  - Good for testing form/invoice extraction
  - https://guillaumejaume.github.io/FUNSD/

### Annotation format

Keep it simple. A spreadsheet or JSON file with:
- Image filename
- For each field: the correct text value
- Optional: bounding box coordinates of the correct answer

The bounding box is nice to have but not essential for Phases 1-4. The text
value alone is sufficient for measuring accuracy.

---

## Implementation Order

```
Phase 1 (Feedback Log)         ← Start here. Foundation for everything else.
    |
Phase 2 (Evaluation Harness)   ← Enables measuring improvement objectively.
    |
Phase 3 (Confidence Cal.)      ← Quick win once you have data.
    |
Phase 4 (Weight Tuning)        ← Biggest systematic improvement.
    |
Phase 5 (Rule Discovery)       ← Only if Phases 1-4 plateau.
```

Each phase builds on the previous one. No phase requires external ML libraries,
GPU hardware, or specialized knowledge beyond basic JavaScript and JSON.
