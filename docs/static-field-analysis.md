# Static field misread analysis (customer name/address case)

## Why "WHEATON MIKE" was missed
- The saved customer-name box on the sample doc is centered on the street line (y≈198, h≈15), so the snapper only sees tokens that are ≥75% inside that rectangle. The intended name line (“WHEATON MIKE”) sits above that box and never enters the in-box token set, so the snap step returns the street address.
- After cleaning, the street line fails the expected name fingerprint (code mismatch), so scoring drops. During triangulation the system lets distant lines outrank the hint: a far-away label (“Sold To Ship To Information”) wins because it has a matching fingerprint and keyword boost, even though it is vertically distant from the hint box.
- The name does surface as a candidate, but OCR concatenates neighboring tokens into a long string (“WHEATON MIKE WHEATON MIKE Store: 50 CLUB PISCINE NEPEAN”), which breaks the fingerprint and drags down its score.

### Why the saved box moved off the correctly selected name line
- In Config mode the user drew the box on the name line and the UI showed the right text, but the profile persisted a different rectangle: the normalized bbox stored with the profile for `customer_name` is the y≈198 street-line box logged during Run. That means the config save wrote the *snapped* street-line box (or an older cached bbox) rather than the drawn name-line box.
- The most likely causes in this flow are: (1) we reuse `state.snappedPx` when saving, so if the snapper drifted to the street line before save, that offset bbox gets serialized; and (2) we reload cached profiles on re-open, so if the newer config session did not overwrite the stored bbox (autosave suppressed or profile reverted), Run still uses the stale street-line geometry even though the on-screen selection was correct.
- Net effect: Run mode starts from the persisted street-line bbox, never sees “WHEATON MIKE” in-box, and downstream ranking then jumps to the far “Sold To” label.

## Fix adjustments to add (static fields only)
- **Save the drawn bbox, not the snap:** When persisting a static field in Config, serialize the user-drawn rectangle, not `state.snappedPx`. That guarantees Run starts from the same geometry that produced the fingerprint. If we need to store the snap for preview, keep it separately and never overwrite the source bbox.
- **Hint-first lock:** If the snap/hint box already contains a candidate that passes the fingerprint/format checks, keep that candidate and stop. Do not look outside the user box in that case—micro-expansion is only for when the box is empty or the in-box text fails the expected pattern.
- **Hint-centric ranking:** When the snap/hint yields any tokens but none pass the fingerprint, penalize candidates whose boxes sit outside a tight halo of the hint (e.g., >1–1.5× box height away), even if their fingerprints match. That keeps distant labels from outranking nearby but imperfect in-box text while still allowing a gentle fallback.
- **Nearest-line fallback:** If the snapped text fails the fingerprint but the box clearly intersects a line, prefer the best candidate within a small vertical expansion above/below the hint before considering far-off lines. This would pick “WHEATON MIKE” above the street line instead of jumping to the header label.
- **Concatenation guard:** When concatenated tokens change the fingerprint class (e.g., name → long mixed string), split on clear label dividers (“Store:”, “Salesperson:”) and re-evaluate fingerprints on each segment. Use the segment nearest the hint center as the candidate.

## Expected run-time flow vs. previous behavior
- **Intended flow (per spec):** Load the saved bbox from Config, re-snap to tokens that are ≥75% inside that original box, extract text, and, if it matches the stored fingerprint, stop. Only when the in-box text fails the fingerprint should we expand slightly or try triangulation/keyword assists.
- **What was happening:** After re-snapping, even fingerprint-valid, in-box results could still be replaced later by keyword triangulation; fingerprint-failing in-box text was sometimes immediately accepted without exploring better nearby lines; and distant labels could outrank hint-adjacent text because the hint candidate was not locked.
- **Updated behavior to implement:**
  - In-box fingerprint hits lock the result and skip triangulation.
  - If the hint text fails the fingerprint, keep searching but stay near the hint: small padded re-snaps look for a fingerprint-valid line first, retain the best hint-adjacent candidate for fallback, and consider distant keyword matches only after these nearby attempts fail.
  - Persist the drawn bbox so the re-snap starts from the same geometry seen in Config; use a separate, non-persisted snap box for UI preview only.
