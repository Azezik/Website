# Store name extraction anomaly

## Observations
- In config mode, the UI shows the green user-drawn box and snapped blue box tightly around the store name, yet the extracted value is a nearby date. This means the extraction pipeline is pulling text outside the intended rectangle even before run-mode heuristics apply.

## Likely causes
1. **Snap-to-line override during config selection**
   - `assembleTokensFromBox` immediately snaps to the nearest line (`snapToLine`) unless `strict` is set, then builds the search box and hit list from that snapped region.【F:invoice-wizard.js†L1821-L1835】
   - Config-mode extraction for static fields always calls this helper without `strict`, so any OCR gap or thin selection can snap to a neighboring line (e.g., the “Sales Date” row) and replace the intended store-name text.【F:invoice-wizard.js†L3058-L3105】

2. **Y-offset and render-scale coupling in OCR crops**
   - `getOcrCropForSelection` converts normalized boxes to CSS space, applies transforms, then multiplies by render-scale factors **and** adds `offY` when drawing from the source canvas.【F:invoice-wizard.js†L2592-L2697】
   - If `offY` already shifts the canvas for multi-page stacking, the extra addition can vertically misplace the crop, causing OCR to read the wrong part of the page while the overlay still appears correct.

3. **Loose overlap thresholds**
   - Config mode uses a 0.5 minimum overlap for static fields, so partially overlapping tokens can be included when the snapped line crosses into neighboring content.【F:invoice-wizard.js†L2981-L2984】【F:invoice-wizard.js†L1821-L1835】

## Fixes implemented
1. **Honor the drawn box in config mode**
   - Config captures now run `assembleTokensFromBox` with `strict: true`, which skips `snapToLine` entirely and reads only inside the user’s drawn rectangle.【F:invoice-wizard.js†L1821-L1835】【F:invoice-wizard.js†L3068-L3091】
   - `snapToLine` also clamps any config-mode expansion to the original selection, so even indirect callers cannot drift outside the highlighted box.【F:invoice-wizard.js†L1805-L1830】

2. **Clamp OCR crop origin to the page coordinate space**
   - (Still planned) Audit `offY` usage in `getOcrCropForSelection` to ensure render-scale and page offsets are not double-applied; add assertions/logs comparing the final crop box to the normalized input before drawing.

3. **Tighten overlap rules near conflicting labels**
   - Config-mode assembly now requires a higher `minOverlap` (0.7) so adjacent lines like “Sales Date” no longer pass the overlap filter when the selection is thin or partially touches nearby text.【F:invoice-wizard.js†L2990-L2997】

4. **Regression safeguards**
   - (Still planned) Add unit-style checks around box normalization/denormalization and cropping math to confirm that normalized coordinates round-trip to the same logical pixels under scale/rotation settings.
