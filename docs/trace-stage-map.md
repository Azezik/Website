# Extraction Trace Stage Map

The extraction trace now follows an ordered, numbered stage plan so the viewer can display **“Step N of M”** consistently. Stages must log in this order:

1. **bbox:read** — Required fields: `input.boxPx`, `input.normBox`, `ocrConfig`.
2. **bbox:expand:pass2** — Required fields: `input.boxPx`, `input.expansion`, `output.bbox`.
3. **tokens:rank** — Required fields: `input.tokens`, `output.tokens`, `output.value`.
4. **columns:merge** — Required fields: `input.tokens`, `output.rows`, `output.columns`.
5. **arith:check** — Required fields: `input.lineItems`, `output.subtotal`, `output.total`.
6. **finalize** — Required fields: `output.value`, `confidence`.

Each event automatically populates the label, `stepNumber`, and `stepTotal` from this plan; deviations should be treated as warnings when reviewing traces.

## What to collect when filing a bug
- `traceId`.
- Names of the failing stage(s) (e.g., `tokens:rank`, `arith:check`).
- Any errors or warnings emitted.
- Relevant artifacts (thumbnails/data URLs) that show the issue.
