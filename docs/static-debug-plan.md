# Static Run-Mode Debug Notes

## Coordinate Paths
- Configured static boxes: percent coords converted with `toPx`, which multiplies viewport width/height by `devicePixelRatio` before computing pixels. Then `applyTransform` also multiplies viewport dimensions by `devicePixelRatio` while rotating/scaling around page center. Tokens from `pdfjs` text content use the raw viewport transform without device-pixel scaling. This means static boxes are in device pixels while tokens remain in CSS/viewport pixels, so when `devicePixelRatio > 1` boxes can be ~2× larger/off-position yet anchors still pass because anchor metrics reuse the same DPR-scaled canvas size.

## Token Selection Rules
- Run-mode static attempts use `tokensInBox` with `minOverlap = 0.7`. With the suspected DPR drift, token vertical overlap falls below 0.7, yielding `hits=0` even when text is visually inside the box. Config-mode defaults to 0.5 and the shared StaticFieldMode helper also defaults to 0.5.

## Fingerprint Gating
- In run mode, when OCR hits exist but `fingerprintOk` is false, confidence is set to `0`, effectively blanking the field even if anchors pass. That explains the customer_name case (text captured, anchors fail, fingerprint mismatch -> conf 0).

## Hypotheses
1. **DPR scale mismatch:** static boxes and anchor metrics are computed in device pixels; tokens are in viewport/CSS pixels. With `devicePixelRatio > 1`, boxes sit right/large relative to tokens, so `tokensInBox` never sees overlap (anchors stay OK because they use the same scaled canvas). Low-risk fix: normalize statics to viewport pixels (drop DPR multiplier) or scale tokens similarly for statics only; add a debug toggle to compare.
2. **Overlap tolerance too strict for statics:** run-mode `minOverlap=0.7` plus minor alignment drift means near-miss tokens are discarded. Low-risk fix: for static fields in run mode, temporarily relax to 0.5 (guarded behind static-debug flag) to confirm hits appear without touching grid behavior.
3. **Fingerprint gate blanks valid-but-off-target text:** when text is captured but fingerprint differs, confidence becomes 0. Possible tweak: if anchors pass but fingerprint fails, return low confidence instead of zero (statics only) so users can see the string. Keep grid untouched.

## Proposed Debug Steps (no code yet)
- Instrument a one-shot comparison logging both the DPR-scaled box and a viewport-pixel version, then run `tokensInBox` against both to confirm the hit gap on the provided invoice.
- Add a temporary static-only flag to drop `minOverlap` to 0.5 and log hit counts to see if Group A fields (store_name, invoice_number, etc.) start returning tokens.
- Log confidence decisions when `fingerprintOk=false` but `hits>0` to verify blanking behavior and ensure grid path unaffected.
