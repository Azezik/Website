Spec: Post-Configuration Extraction (BBox-First, Layout-Agnostic)
Purpose
These rules apply after the wizard is configured.
They do not reject user inputs during configuration.
They guide automatic extraction on future documents by starting from the user’s saved rectangle for each field, then looking a little around it if needed.
If content is unusual but still plausible, keep it (don’t reject). Use the rules to rank/clean, not to block.
Core Principle (must follow)
Start inside the saved bbox for that field on the saved page.
If nothing clean is found, expand the search area in small steps around that bbox only (micro-expansion).
Never roam the whole page. Never ignore the bbox.
Search Strategy (all scalar fields: store name, invoice #, dates, totals, etc.)
For each field with a saved bbox:
Pass 1 — Inside the box
Read all tokens inside the bbox.
Clean obvious noise: trim, collapse double spaces, drop trailing “:” or “#”.
If the box contains both a label and a value (e.g., “Invoice # 12345”), prefer the value on the same line to the right of the label, else immediately below.
If the exact field format is detected (see field rules below), take it and stop.
Pass 2 — In-box refinement
If duplicates like “ADAM BEDNAREK ADAM BEDNAREK” appear, deduplicate contiguous repeats and keep one.
If multiple candidates remain, rank by:
(a) label strength inside the box,
(b) format certainty (e.g., date looks like a date; money looks like money),
(c) distance from the bbox center or from the label,
(d) plausibility checks (e.g., unit × qty ≈ amount; subtotal + tax − discounts ≈ total).
If a clear winner exists, take it and stop.
Pass 3 — Micro-expansion around the box
If still not confident, expand the bbox slightly in all directions (small padding).
Do this in small increments (e.g., a tiny ring around the box), up to a modest cap (keep total expansion modest—just enough to catch nearby drift).
Within each expansion step, repeat Pass 1 and Pass 2 logic.
If a label word for this field is found inside the box or near its edges, bias the search to the right/same-line or just below that label first.
Stop expanding once a confident candidate is found or the cap is reached.
Pass 4 — Fallback (don’t block)
If nothing matches strict formats, pick the most plausible text found in the last expansion step (closest to label or center), mark it low confidence, and return it rather than null.
Notes:
“Label words” are field-specific synonyms like “Invoice #”, “Subtotal”, “Tax”, etc.
Keep logs of what was found and how (helpful for debugging but not required in this spec).
Column Fields (Description, SKU, Qty, Unit Price)
The user drew the entire column during configuration. For future docs:
Stay inside the column bbox. Only allow a tiny horizontal tolerance for OCR jitter; otherwise do not leave the column.
Remove the header row if it matches known header words for that column.
Build rows by grouping tokens that align horizontally (share a similar y-band).
Wrapped descriptions: if a row’s description continues on the next line without numbers in Qty/Unit/Amount columns, merge those lines into the same description.
Cross-check columns on the same row (if present):
Qty must be numeric;
Unit Price must look like money;
Amount (if you have it) ≈ Qty × Unit (allow small tolerance).
Do not fetch values outside the column box to “complete” rows; only use sibling columns if they’re also configured by the user and we have their own bboxes.
Field-Specific Expectations (used for ranking/cleaning, not blocking)
Use these to prefer likely candidates inside/near the bbox:
Store / Business Name
Should look like a company name (words ≥3 letters).
Avoid choosing addresses, emails, URLs, phones, or the word “invoice”.
If a label like “Vendor / Seller / Company” appears in or touching the box, prefer the text right of or below that label inside the box.
Department / Division
Short words/phrases; often near the store name box the user selected.
Avoid addresses/phones/emails.
Invoice Number
Usually a single code: mostly digits, may include letters/dashes.
Not a date, not a currency value.
If label text like “Invoice # / Invoice No.” is inside the box, prefer the value right of or below it.
Invoice Date
One date in a common format (YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, or “Month DD, YYYY”).
Prefer the date tied to “Invoice/Issued” wording if visible in or touching the box.
Salesperson / Rep
Likely a person’s name (2–3 capitalized words), maybe with an email.
If name appears duplicated (OCR), deduplicate. Keep the name; email is optional secondary.
Customer (Sold To)
A person or company name.
If the box also shows “Ship To,” prefer the Bill To / Sold To portion if both appear inside.
Customer Address
Address lines under/near the customer name inside the box:
Street number + street name;
City + province/state + postal/ZIP.
For CA: detect A1A 1A1; for US: 12345 or 12345-6789.
Prefer the billing address if both billing/shipping are in the box.
Columns
Description (Column)
Free text; allow punctuation and long phrases.
Merge wrapped lines until a numeric shows up in the same row band in other configured columns.
SKU / Product Code (Column)
Compact code: letters/digits with optional - . / _.
Avoid long natural-language strings.
Quantity (Column)
Pure number (allow decimals). No currency symbols.
Optional sanity range if helpful (not blocking).
Unit Price (Column)
Looks like money.
If Qty and Amount exist on the same row (and are configured), prefer the Unit that satisfies Qty × Unit ≈ Amount.
Totals & Taxes (scalar boxes)
Subtotal
Looks like money.
If line items are available, Subtotal ≈ sum of line amounts (tolerance). (This is a boost, not a blocker.)
Discounts
Money amount; can be negative.
Typically ≤ Subtotal (soft check).
Tax (HST/GST/PST/VAT)
Money amount; if a nearby rate (e.g., 13%) shows up in or touching the box, boost candidates consistent with Subtotal × rate.
Invoice Total / Grand Total
Money amount.
Prefer labels like “Grand Total / Amount Due / Balance Due” if visible in or touching the box.
Boost the candidate closest to Subtotal − Discounts + Tax (if those are known).
OCR Cleanup & Edge Cases
Trim spaces; remove extra : or # at ends.
Deduplicate exact repeated phrases inside the box.
Handle common OCR confusions (O/0, I/1, S/5) cautiously—use field context to choose the sensible variant.
Never drop a value just because it doesn’t match the ideal pattern; if it’s the best nearby candidate, keep it with lower confidence.
Confidence & Ties
Compute a simple internal score from: label presence, format match, and distance from center/label.
Arithmetic and cross-column consistency add a bonus to the score.
On ties, pick the candidate nearest to the center of the user’s bbox (or nearest to the detected label inside the box).
Non-Rejection Policy (important)
During configuration: accept whatever the user highlights.
During extraction: never discard the field outright. If strict patterns fail, return the best nearby text found within the micro-expansion boundary and mark it low confidence.
Tunable Behaviors (plain language)
“Micro-expansion size”: a very small padding added around the bbox, applied in a few steps, with a modest cap.
“Same-line band”: the vertical thickness considered “same line” when walking right from a label.
“Tolerance”: allowed difference for arithmetic checks (e.g., a few cents or a small percent).
