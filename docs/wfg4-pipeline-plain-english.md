# WFG4 Pipeline (Plain-English Walkthrough)

This document explains the *actual* WFG4 flow in the current codebase, using the same language users ask in debugging calls: “where is the box, what space is it in, and how do we re-find it later?”

## 1) What happens when a document is uploaded (normalization)

1. The WFG4 engine builds a per-page surface via `prepareDocumentSurface()`, which calls `normalizePage()` on each page.  
2. `normalizePage()` computes a **working size** (possibly downscaled to max edge), then creates grayscale/edge artifacts and stores scale factors between original page space and working space.  
3. In the same normalization pass, it also computes:
   - `globalScan` (lines/containers/candidate regions)
   - `pageStructure` (normalized structural objects for constellation matching)
4. The surface stores a declared coordinate space (`wfg4-canonical-working-v1`) and per-page dimensions/scales, so WFG4 metadata is tied to the working canvas, not raw CSS pixels.

## 2) What happens when user draws the field box in wizard confirm

1. Pointer drag creates `state.selectionPx` on the overlay.
2. In WFG4 direct selection mode, that box is kept directly as `state.snappedPx` (no legacy line snapping).
3. On Confirm, code builds a **CaptureFrame** (`WFG4CaptureFrame.build`) that freezes:
   - display viewport dims,
   - working dims,
   - display→working scale,
   - user box in display px,
   - user box transformed into working px,
   - user box normalized in working space.
4. This is intended as the single source of truth so later steps stop recomputing scale from different nodes.

## 3) How box location is saved

1. Confirm first pre-registers WFG4 field config (`EngineRegistry.registerFieldConfig` → `WFG4Registration.captureVisualReferencePacket`).
2. Registration resolves a canonical box from normalized coordinates against the page’s **working dimensions** and stores:
   - `bbox` (working pixels),
   - `bboxNorm` (normalized),
   - surface size,
   - visual reference patches/features,
   - structural context,
   - constellation,
   - structural identity.
3. Independently, wizard profile save (`upsertFieldInProfile`) persists the field entry with `normBox` and optional `wfg4Config`.

Important: there are two persisted geometry carriers:
- generic profile `normBox` used broadly by extraction paths,
- WFG4-owned `wfg4Config` packet with canonical working-space geometry + structural metadata.

## 4) What happens on run (re-find + extract)

1. Run loads profile fields + stored `wfg4Config`.
2. WFG4 run surface is built again (`prepareDocumentSurface` / `normalizePage`) so runtime has current page working dims/artifacts/pageStructure.
3. For static fields, extraction goes through engine path (`extractFieldValue` → `EngineRegistry.extractScalar` for WFG4).
4. WFG4 localizer attempts structural localization using saved config data and runtime `pageStructure`, then produces a localized/readout box.
5. If localization reports `needsLocalizedReadout`, pipeline OCR-reads the localized box (usually Tesseract bbox tokens) and picks best token in-box.
6. Result returns value + confidence + final box + metadata.

## 5) Why “same wrong result after big changes” can happen (fundamental failure modes)

From logs and current architecture docs, these are the recurring root-level issues:

1. **Space mismatch risk still exists at boundaries.**
   - WFG4 tries to unify around working space, but legacy/general paths still save/use generic `normBox` derived from viewport dimensions.
   - If one path denormalizes against viewport and another against working dims, box can drift even though both are “normalized.”

2. **Source selection is still brittle in non-WFG4 paths.**
   - Page-level “PDF tokens exist => use PDF.js” is known to fail for half-filled/scanned-like PDFs.
   - If wrong token source is chosen early, all later geometric improvements can look useless because readout content is wrong.

3. **Pipeline integration gaps historically made advanced signals additive, not decisive.**
   - Multiple docs call out previous behavior where fallback chain didn’t truly escalate in a hard, deterministic way.
   - So expensive metadata existed, but extraction could still collapse back to old bbox/text fallback behavior.

4. **Config/run mutable shared state can leak partial setup.**
   - If run starts with incomplete/partial config artifacts in state, results can appear unchanged because engine falls back repeatedly.

## 6) Practical sanity checks (what to verify first in a failing WFG4 case)

1. Confirm `wfg4Config.visualReference.captureStatus === "ok"` at config save.
2. Confirm config `surfaceSize` and run working dimensions are both present and sensible.
3. Compare profile `normBox` vs WFG4 packet `bboxNorm` for same field; if materially different, track who wrote each.
4. Confirm localized run box source (`bboxSource`) is structural/reconstructed when expected, not just predicted fallback.
5. Confirm readout backend/token source used for final value (PDF.js vs Tesseract bbox) matches document type reality.
6. Confirm logs show pageStructure + constellation matches exist before refine/readout.

---

If these six checks pass and output is still wrong, the next likely issue is not “missing one more heuristic” but a deterministic contract bug between: **(A) saved geometry space, (B) runtime geometry space, and (C) token coordinate space used for final readout**.
