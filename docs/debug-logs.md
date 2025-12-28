# Debug Logging & Trace Viewer

## Where traces live and what they contain
- Traces are stored in-memory via `TraceStore` under the global `debugTraces` instance. Each trace has:
  - `traceId` (UUID), `spanKey` with `{ docId, pageIndex, fieldKey }`, `started` timestamp, and an `events` array. 【F:trace.js†L1-L99】
- Events now include standardized metadata: `stage`, `stageLabel`, `stepNumber`, `stepTotal`, `stagePlan`, `docMeta`, `fieldMeta`, `bbox`, `counts`, `ocrConfig`, `heuristics`, `confidence`, `timing`, `notes`, `inputsSnapshot`, `ts`, `durationMs`, `input`, `output`, normalized `warnings`/`errors`, and optional `artifact` (usually a data URL for viewer thumbnails). Duration defaults to the time since the prior event unless `durationMs` is provided. Warnings/errors are always `{ code, message, details }` objects for clean copy/paste. 【F:trace.js†L43-L112】
- The helper `traceEvent(spanKey, stage, payload)` lazily creates or reuses a trace keyed by `(docId, pageIndex, fieldKey)`, auto-fills doc/field metadata (and bbox when provided), and appends an event with the payload merged into the standardized envelope. 【F:trace.js†L125-L148】
- You can export a trace to a JSON file with `exportTraceFile(traceId)`, which downloads `trace-<id>.json`. 【F:trace.js†L101-L107】
- You can copy the raw JSON to the clipboard with `copyTraceJson(traceId)`. It pretty-prints the entire trace (including all events) before copying. 【F:trace.js†L108-L118】

## How traces are grouped and filtered in the viewer
- `trace-viewer.js` reads `window.debugTraces.traces` and builds dropdown filters:
  - Document filter from `spanKey.docId`.
  - Field filter from `spanKey.fieldKey`.
  - Stage filter from all event stages. 【F:trace-viewer.js†L2-L30】
- Thumbnails show only events that match the active doc/field/stage filters **and** that have an `artifact`. Clicking a thumbnail selects that event. 【F:trace-viewer.js†L31-L61】
- Overlays while viewing a selected event:
  - Selection box from `input.boxPx`/`normBox` or `output.rect` (`ovSel` toggle).
  - Token boxes (optionally with confidence heatmap) from `output.tokens` (`ovTok`, `ovHeat`).
  - Anchors from `output.anchors` (`ovAnc`). 【F:trace-viewer.js†L70-L118】
- The “Copy Trace” button copies the entire trace JSON for the selected event’s `traceId` (via `copyTraceJson`). 【F:trace-viewer.js†L52-L61】

## Copy/paste workflow for debugging
1. Open the trace viewer, apply doc/field/stage filters to isolate the failing run.
2. Click a thumbnail to load its artifact and overlays; use toggles to reveal selection/tokens/anchors.
3. Press **Copy Trace** to grab the full JSON, or call `copyTraceJson(<traceId>)` in the console.
4. When pasting into a bug report, include:
   - `traceId`.
   - Which stages failed or misbehaved.
   - Any `warnings`/`errors`.
   - Links or data URLs from `artifact` when relevant (e.g., highlight issues).
   - Optional: specific `input`/`output` snippets that show bad anchors/tokens.

## Triage checklist
1. **Locate the failing stage.** Filter by stage or scan `events` for warnings/errors; note `durationMs` spikes.
2. **Inspect inputs.** Check `input.boxPx/normBox` for bbox drift; validate stage-specific inputs.
3. **Inspect outputs.** Review `tokens`, `anchors`, and derived fields; turn on heatmap to spot low confidence.
4. **Cross-check artifacts.** Ensure overlays align with the rendered thumbnail; verify the correct page/field.
5. **Correlate timing.** Use `durationMs` to see where time is spent; long durations may mean OCR/anchor issues.
6. **Summarize.** Record traceId, failing stage, warnings/errors, and any suspicious artifacts/tokens.

## Example snippets
### Healthy stage
```json
{
  "stage": "anchor-detect",
  "stageLabel": "Anchor detect",
  "stepNumber": 2,
  "docMeta": { "docId": "file-123", "pageIndex": 0 },
  "fieldMeta": { "fieldKey": "invoice_total" },
  "bbox": { "pixel": { "x": 120, "y": 300, "w": 180, "h": 60 } },
  "durationMs": 12,
  "input": { "boxPx": { "x": 120, "y": 300, "w": 180, "h": 60 } },
  "output": { "anchors": [{ "x": 132, "y": 312, "w": 40, "h": 16 }] },
  "warnings": [],
  "errors": []
}
```

### Problematic stage
```json
{
  "stage": "tokenize",
  "stageLabel": "Tokenize",
  "stepNumber": 1,
  "durationMs": 240,
  "input": { "normBox": { "x0n": 0.42, "y0n": 0.18, "wN": 0.12, "hN": 0.04 } },
  "output": { "tokens": [], "anchors": [] },
  "warnings": [{ "code": "no_tokens", "message": "no tokens in bbox" }],
  "errors": []
}
```

Use overlays to confirm whether the bbox is correct; empty `tokens` with a long `durationMs` often point to OCR failures or mismatched coordinates.
