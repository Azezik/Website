# Architecture Assessment Report: Wizard Data Persistence Refactor

## 1. Current Data Model & Write Paths

### 1.1 Firestore Document Structure (Current)
```
Users/{uid}/
  meta/profile          → { username, email, createdAt }

Users/{uid}/Accounts/{username}/
  Backups/manual        → { payload: <ENTIRE localStorage blob>, updatedAt }

Usernames/{usernameLower} → { uid, usernameDisplay, createdAt }
```

### 1.2 localStorage Key Map (Current)
| Key Pattern | Data Type | Approx Size |
|---|---|---|
| `wiz.session` | Session state (username, docType, wizardId) | ~100B |
| `wiz.profile.{user}.{docType}[.{wizardId}][.{geometryId}]` | Full profile with fields, bboxes, geometry | 10KB–500KB+ |
| `wiz.geometries.{user}.{docType}[.{wizardId}]` | Geometry metadata list | 1–5KB |
| `wiz.patternBundle.{docType}.{wizardId}[.{geometryId}]` | Pattern bundles (learned extraction patterns) | 50KB–2MB+ |
| `accounts.{user}.wizards.{docType}[.{wizardId}].masterdb` | Master DB entries | 5–100KB |
| `accounts.{user}.wizards.{docType}[.{wizardId}].masterdb_rows` | Master DB rows | 10–500KB |
| `accounts.{user}.wizards.{docType}[.{wizardId}].batch_log` | Batch processing log | 1–50KB |
| `accounts.{user}.wizards.{docType}[.{wizardId}].chartready` | Chart-ready data | 5–100KB |
| `ocrmagic.segmentStore` | OCR segment store | 100KB–5MB |
| `ocrmagic.segmentStore.chunks` | OCR chunk index | 50KB–2MB |
| `wiz.customTemplates` | User-defined wizard templates | 1–50KB |
| `wiz.models` | Saved extraction models | 1–50KB |
| `wiz.staticDebug` | Debug flag | <100B |
| `wiz.snapshotMode` | Snapshot mode flag | <100B |
| `extractedWizard.{user}` | Last-used wizard selection | ~200B |
| `wiz.extractionEngine` | Engine type preference | <100B |

**Total potential per-user footprint: 500KB to 10MB+**
(localStorage limit is typically 5–10MB across all origins)

### 1.3 Write Paths (Current)
1. **Profile save** (`saveProfile()` at line 4180): Debounced via `setTimeout`, writes entire serialized profile to localStorage. On quota exceeded, attempts `reclaimLocalStorageForProfileSave()` then retries.
2. **Pattern bundle save** (line 4063): Writes full pattern JSON to localStorage.
3. **Master DB** (`LS.setDb/setRows/setBatchLog/setChartReady`): Direct synchronous writes.
4. **Backup to cloud** (`backupToCloud()` line 17345): Manual user action. Reads ALL localStorage, builds monolithic payload, writes single Firestore doc at `Users/{uid}/Accounts/{username}/Backups/manual`.
5. **Restore from cloud** (`restoreFromCloud()` line 17394): Reads single doc, overwrites ALL localStorage entries.

## 2. Anti-Patterns Causing Quota & Coupling Issues

### 2.1 Monolithic Backup Blob
The entire user state is serialized into a single Firestore document. Firestore max doc size is 1MB. As WrokitVision data grows, this WILL hit the Firestore doc size limit too — not just localStorage.

### 2.2 localStorage as Primary Store
localStorage is synchronous, blocking, size-limited (~5-10MB), and has no query capability. Profile saves happen on every wizard step interaction via debounced timer, writing the FULL profile each time (not deltas).

### 2.3 Username Coupled into Storage Keys
Storage keys embed `username` directly (e.g., `wiz.profile.{user}.{docType}`). This means:
- Username changes break all data lookups
- Multi-user scenarios on the same browser cause namespace collisions
- The username had to be "spoofed" before auth existed, creating the legacy coupling

### 2.4 No Incremental Persistence
Every save writes the complete profile object. No delta tracking. No dirty flags. This means a 500KB profile gets rewritten to localStorage on every field bbox adjustment.

### 2.5 No Conflict Resolution
No version counters, no timestamps on individual documents. Multi-tab edits silently overwrite each other.

### 2.6 No Error Recovery
Quota exceeded errors show `alert()` and abort. No queue, no retry, no degraded-mode persistence.

## 3. Target Firestore Schema

See `docs/target-schema.md` for the full normalized schema proposal.

## 4. Migration Strategy

### Phase 1: Dual-Write (Feature-flagged)
- New writes go to both localStorage (for backward compat) and Firestore
- Reads prefer Firestore, fall back to localStorage
- Feature flag: `wrokit.firestorePrimary` in localStorage

### Phase 2: One-Time Migration
- On first authenticated load with feature flag enabled:
  1. Read existing localStorage data
  2. Read existing `Backups/manual` payload (if exists)
  3. Merge (localStorage wins for newer data via timestamps)
  4. Write normalized documents to new Firestore schema
  5. Write migration marker: `users/{uid}/meta/migration → { status: 'complete', migratedAt, sourceVersion }`

### Phase 3: localStorage as Cache Only
- localStorage becomes write-through cache for recently-accessed wizard data
- Cache TTL: 24 hours
- Max cache size: 2MB (self-enforcing with LRU eviction)

### Phase 4: Remove Legacy Paths
- Remove `Backups/manual` write path
- Remove username-keyed localStorage patterns
- Clean up legacy code

## 5. Security Rules Implications

Current rules allow blanket read/write under `Users/{userId}/**`. New schema needs:
- Per-document type validation
- Server timestamp enforcement
- Field-level size limits
- See `firestore.rules` updates in implementation

## 6. Indexing Requirements

Composite indexes needed:
- `users/{uid}/wizards` → query by `docType + status + updatedAt`
- `users/{uid}/wizards/{wid}/runs` → query by `createdAt DESC`

Single-field indexes (auto-created by Firestore):
- `updatedAt`, `createdAt`, `docType`, `status`

## 7. Cost/Performance Tradeoffs

| Concern | Monolithic (Current) | Normalized (Proposed) |
|---|---|---|
| Reads per wizard load | 1 (but huge) | 3-5 (small docs) |
| Writes per config step | 1 huge localStorage write | 1-2 small Firestore writes |
| Firestore cost | Low (rare manual backup) | Medium (incremental writes) |
| Write frequency | Every debounce tick (~300ms) | Batched per step confirm (~5-30s) |
| Offline support | Full (localStorage) | Firestore offline cache + localStorage fallback |
| Max data size | 5-10MB (localStorage limit) | Effectively unlimited |
| Multi-tab | Last-write-wins (silent) | Version-checked writes |

### Write Frequency Controls
- **Debounce**: 2 second debounce on field-level changes (batched)
- **Step-level persist**: Write on wizard step "Confirm/Next"
- **Batch writes**: Use Firestore `writeBatch()` for multi-doc updates
- **Rate limit**: Max 1 write per second per document path
