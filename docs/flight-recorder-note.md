# Flight Recorder instrumentation notes

Files touched:
- `invoice-wizard.js`
- `docs/flight-recorder-note.md`

Log tags emitted:
- `[flight-recorder]` events tagged: `config.pre-save`, `config.post-save`, `config.field-captured`, `run.start`, `run.loaded`, `run.post-merge`, `run.post-ensure`, `run.before-extract`, `run.after-extract`.
- `[GEOM_DROPPED]` geometry regression warnings.
- Trace stages added for field spans: `extract.start`, `extract.done`.
