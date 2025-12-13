# Fillable PDF Visibility Parity Plan

## Observed Problem
- Fillable (AcroForm) PDFs render correctly in preview because widget appearance streams are composited when drawing the page.
- The extraction/tokenization path reads only the structural page text (e.g., PDF text operators). It ignores annotation appearance streams, so filled field values are invisible to the extractor.
- Flattened PDFs work because the form appearances are baked into the page content stream that the extractor already reads.

## Goal
Restore parity between what the preview renders and what the extraction pipeline reads **without changing the extraction/OCR logic or introducing new modes**. After preprocessing, every PDF should behave like a already-flattened document to the existing pipeline.

## Constraints
- Do **not** modify extraction, OCR, or downstream pipeline behavior.
- Do **not** rely on form-field metadata for extraction or add branching logic per document type.
- Keep runtime and resource use modest; avoid heavyweight full-document rasterization.

## Proposed Approach: Targeted Annotation Flattening Prepass
1. **Detect AcroForm content:** On upload/ingest, quickly check if the file has an `/AcroForm` dictionary and widget annotations with appearance streams. Skip the prepass for already-flat PDFs.
2. **Merge appearances into the page content stream:** For each widget that has an `AP` normal appearance:
   - Import the appearance stream as a Form XObject in the page’s resources.
   - Append a content stream that paints the XObject at the widget’s rectangle using its `/Matrix` and `/Rect` to preserve positioning.
   - Optionally mark the annotations read-only or remove them afterward to avoid double rendering.
3. **Preserve text tokens:** Because appearance streams often contain normal PDF text operators, embedding them into the page content makes those tokens available to the existing text extraction layer. This avoids rasterization and keeps text searchable/selectable.
4. **Keep everything else unchanged:** After the prepass, hand the modified PDF to the existing pipeline unchanged. BBOX, anchors, and micro-expansion continue to operate exactly as today, now with the same visible text available.

## Implementation Notes
- Reuse a robust PDF library that can edit content streams (e.g., pdfcpu, pdf-lib, or a PDFium-based service) to avoid building low-level PDF writing code.
- The prepass can operate in-place by adding a small incremental update, minimizing I/O and memory overhead.
- If an appearance stream is missing, fall back to leaving the field untouched (the behavior matches today). No new extraction modes are introduced.

## Acceptance Criteria
- A fillable PDF that previously showed zero tokens inside a form BBOX now yields the filled text via the normal extraction pipeline.
- Flattened PDFs remain unaffected (no regression in extraction results or performance).
- No changes are required in downstream processing or UI logic.
