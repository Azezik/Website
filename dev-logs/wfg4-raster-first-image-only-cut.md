# WFG4 Forensic Debug Note — PDF Crop Reads Above Box

## Binary answer
Are we OCRing the correct pixels for PDFs?
**Before fix: NO** (when WFG4 canonical display is active and `original != working`).

## Root cause (exact)
`engines/core/wfg4-capture-frame.js` (`buildCaptureFrame`) treated `userBoxDisplayPx` as if it were in `pageEntry.dimensions.original`.

In WFG4 config canonical mode, the user actually draws on the **canonical viewer surface** (`state.pageViewports`, i.e. working-sized display).

So for PDFs where `original` is larger than `working`, this extra conversion:
- `sX = workingW / originalW`
- `sY = workingH / originalH`

scaled the already-working-space display box **again**, shifting OCR crop origin upward/left.

This matches the observed bug: OCR reading text above the selected box.

## First divergence point
- **File:** `engines/core/wfg4-capture-frame.js`
- **Function:** `buildCaptureFrame`
- **Variables:** `displayW`, `displayH`, `sX`, `sY`, `userBoxDisplayPx -> userBoxWorkingPx`
- **Divergence:** PDF canonical display still used `original` dims for display basis instead of active viewer dims.

## Fix implemented
1. In `buildCaptureFrame`, when `state.wfg4.configDisplayActive` is true, display dimensions now come from active page viewport (`state.pageViewports[idx]`) rather than `original`.
2. Mirrored the same fix in config fallback mapping path inside `invoice-wizard.js` confirm flow.
3. Added forensic logging + crop artifact output in `ocrWfg4CropReadout`:
   - logs display/stored/working boxes
   - logs source canvas identity + dimensions
   - writes debug crops and metadata:
     - `debug/wfg4-crops/crop_image_from_pdf.png`
     - `debug/wfg4-crops/crop_image_from_image.png`
     - matching `.json` files with exact coordinates

## Where to inspect runtime forensic output
- Console logs:
  - `[wfg4-box-debug]`
  - `[wfg4-crop-debug]`
- Files:
  - `debug/wfg4-crops/crop_image_from_pdf.png`
  - `debug/wfg4-crops/crop_image_from_image.png`
  - `debug/wfg4-crops/crop_image_from_pdf.json`
  - `debug/wfg4-crops/crop_image_from_image.json`
