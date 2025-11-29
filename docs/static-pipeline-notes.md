# Static field pipeline notes

- **Capture (CONFIG):** the user draws a CSS-space box that is converted to px. `assembleStaticField` snaps to nearby OCR lines, but the search box stays anchored to the saved bbox and uses `StaticFieldMode.assembleStaticFieldPipeline` so line metrics and text match the preview.
- **Storage:** the normalized bbox, page, and line metrics from the assembled box are stored with the profile.
- **Extraction (RUN):** the saved bbox is denormalized and sent through the same `assembleStaticField` helper. Tokens are collected inside that box only (with the same overlap rules) and assembled top-to-bottom/left-to-right, ensuring the RUN result equals the CONFIG preview.
- **Customer name/address fix:** RUN mode previously re-snapped with `snapToLine` and a height multiplier for `customer_address`, which stretched the blue box and altered line counts. Both modes now share the same assembly helper and drop the height multiplier so the blue box reflects the actual search region.
- **Debugging aids:** static-debug now logs stored line metrics and the transformed bbox used for RUN mode, making it easier to compare customer fields against salesperson/store behavior.
