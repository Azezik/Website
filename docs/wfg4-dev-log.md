## 2026-04-05 — Phase 2A / 2B (Canonical Surface + Config Display Substitution)

### Summary
- Implemented real WFG4 canonical surface generation in `WFG4Engine.prepareDocumentSurface(...)` using OpenCV.js operations (resize, grayscale, Gaussian denoise, Canny edges) with browser-safe fallback behavior.
- Implemented config-mode display-surface substitution for WFG4 so the user draws directly on the WFG4 canonical surface (no dual visible surface in config mode).
- Updated config capture behavior for WFG4 to keep user bbox geometry in the canonical WFG4 surface space.

### Files Modified
- `engines/core/wfg4-engine.js`
- `invoice-wizard.js`
- `docs/wfg4-dev-log.md`

### Key Architectural Decisions
- Reused the existing `#pdfCanvas` viewer base node as the canonical-surface display target in config mode to avoid UI shell redesign.
- Used existing `syncWfg4SurfaceContext('config'|'run')` seam to build canonical surface and trigger config-time display swap only for WFG4.
- Isolated display substitution via helper routing (`getActiveDisplaySurfaceNode`) so overlay sizing/pinning uses canonical surface only when WFG4 config display is active.
- Disabled raw-token snapping behavior for WFG4 config selections; selection boxes are captured directly from the canonical display geometry.

### Assumptions
- OpenCV.js may not always be present at runtime; canonical-surface generation remains functional with graceful canvas fallback diagnostics.
- Existing token streams remain raw-render-derived; WFG4 scalar extraction now scales token boxes to canonical page space when needed.

### Risks / Uncertainties
- Some diagnostic/learning helper paths that rely on active display node now follow the canonical display while WFG4 config mode is active; this is intended for coordinate consistency but should be validated in advanced debug workflows.
- Canvas data URL artifacts increase in-memory surface payload size for large multi-page documents.
