# Target Firestore Schema Proposal

## Document Structure

```
users/{uid}/
│
├── meta/
│   └── profile                    # Account metadata
│       {
│         username: string,
│         email: string,
│         createdAt: Timestamp,
│         updatedAt: Timestamp,
│         migrationStatus: 'pending' | 'complete' | 'failed',
│         migrationVersion: number,
│         migratedAt: Timestamp | null,
│         settings: {
│           extractionEngine: string,
│           snapshotMode: boolean,
│           staticDebug: boolean
│         }
│       }
│
├── wizards/{wizardId}             # Wizard metadata (lightweight)
│   │   {
│   │     wizardId: string,
│   │     docType: string,
│   │     displayName: string,
│   │     engine: string,
│   │     status: 'draft' | 'configured' | 'active',
│   │     createdAt: Timestamp,
│   │     updatedAt: Timestamp,
│   │     version: number,           # Conflict detection
│   │     fieldCount: number,
│   │     layoutCount: number
│   │   }
│   │
│   ├── layouts/{layoutId}          # Geometry/layout-level config
│   │   │   {
│   │   │     layoutId: string,      # (was geometryId)
│   │   │     displayName: string,
│   │   │     createdAt: Timestamp,
│   │   │     updatedAt: Timestamp,
│   │   │     version: number,
│   │   │     pageSize: { pageWidthPx, pageHeightPx, aspect },
│   │   │     fieldKeys: [string],   # Ordered list of field keys
│   │   │     profileSnapshot: {     # Lightweight profile metadata
│   │   │       engineType: string,
│   │   │       lastConfiguredAt: Timestamp
│   │   │     }
│   │   │   }
│   │   │
│   │   └── fields/{fieldKey}       # Individual field config
│   │       {
│   │         fieldKey: string,
│   │         label: string,
│   │         fieldType: 'static' | 'area' | 'column',
│   │         bbox: [x0, y0, x1, y1],
│   │         bboxPct: [x0, y0, x1, y1],  # Normalized
│   │         normBox: { ... },
│   │         page: number,
│   │         anchor: { ... } | null,
│   │         landmark: { ... } | null,
│   │         extractionSettings: { ... },
│   │         updatedAt: Timestamp,
│   │         version: number
│   │       }
│   │
│   ├── patterns/{layoutId}         # Pattern bundles (can be large)
│   │   {
│   │     layoutId: string,
│   │     bundleVersion: number,
│   │     updatedAt: Timestamp,
│   │     patternData: { ... },     # The actual pattern bundle
│   │     sizeBytes: number          # Self-reported for monitoring
│   │   }
│   │   NOTE: If > 900KB, split into patterns/{layoutId}/chunks/{chunkIdx}
│   │
│   ├── masterDb/current            # Master DB entries (single doc if <900KB)
│   │   {
│   │     entries: [...],
│   │     updatedAt: Timestamp,
│   │     version: number,
│   │     entryCount: number
│   │   }
│   │
│   ├── masterDbRows/current        # Master DB rows
│   │   {
│   │     rows: [...],
│   │     columns: [...],
│   │     updatedAt: Timestamp,
│   │     version: number
│   │   }
│   │
│   ├── chartReady/current          # Chart-ready data
│   │   {
│   │     data: { ... },
│   │     updatedAt: Timestamp
│   │   }
│   │
│   └── runs/{runId}                # Extraction run summaries (optional)
│       {
│         runId: string,
│         createdAt: Timestamp,
│         fileCount: number,
│         status: 'complete' | 'partial' | 'failed',
│         summary: { ... }
│       }
│
├── templates/                      # Custom wizard templates
│   └── {templateId}
│       {
│         templateId: string,
│         displayName: string,
│         documentTypeId: string,
│         createdAt: Timestamp,
│         updatedAt: Timestamp,
│         config: { ... }
│       }
│
├── models/                         # Saved extraction models
│   └── {modelId}
│       {
│         modelId: string,
│         displayName: string,
│         createdAt: Timestamp,
│         updatedAt: Timestamp,
│         config: { ... }
│       }
│
└── ocrSegments/                    # OCR segment store (chunked)
    └── {segmentId}
        {
          segmentId: string,
          createdAt: Timestamp,
          updatedAt: Timestamp,
          data: { ... },
          sizeBytes: number
        }
        NOTE: Large OCR stores split across multiple docs
```

## Key Design Decisions

### 1. Document Size Management
- Firestore max document size: 1MB
- Target max document size: 900KB (with 100KB safety margin)
- Documents that could exceed this (patternBundles, ocrSegments) get chunked into subcollection docs
- `sizeBytes` field enables monitoring without re-reading

### 2. ID Strategy
- `wizardId`: Preserved from existing system (already generated)
- `layoutId`: Maps to existing `geometryId` (renamed for clarity)
- `fieldKey`: Preserved from existing field keys
- `templateId` / `modelId`: Reuse existing IDs or generate UUIDs

### 3. Version/Conflict Fields
- Every mutable document has `version: number` (increment on write)
- Every mutable document has `updatedAt: Timestamp` (server timestamp)
- Multi-tab conflict resolution: last-write-wins with version check
  - Read version before write
  - If remote version > local version, prompt user or merge

### 4. Denormalization Choices
- `wizard.fieldCount` and `wizard.layoutCount` are denormalized for list views
- `layout.fieldKeys` is denormalized so layout load doesn't require reading all fields
- These are updated in the same batch as the source-of-truth writes

### 5. What Goes in Cloud Storage vs Firestore
- **Firestore**: All structured data (profiles, fields, patterns, master DB)
- **Cloud Storage** (future): Raw document images, full OCR output, large binary artifacts
- Firestore metadata docs reference Cloud Storage URIs where applicable

## Before/After Module Interaction

### BEFORE (Current):
```
┌───────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Wizard UI    │────▶│ LS object    │────▶│  localStorage   │
│  (invoice-    │     │ (in invoice- │     │  (browser)      │
│   wizard.js)  │     │  wizard.js)  │     └─────────────────┘
└───────────────┘     └──────────────┘              │
                             │              ┌───────▼─────────┐
                             │  manual      │  Firestore      │
                             └─────────────▶│  Backups/manual │
                               backup btn   │  (single blob)  │
                                            └─────────────────┘
```

### AFTER (Proposed):
```
┌───────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Wizard UI    │────▶│ WizardDataService│────▶│ FirestoreRepo    │
│  (invoice-    │     │  (js/data/       │     │  (js/data/       │
│   wizard.js)  │     │   wizard-data-   │     │   firestore-     │
└───────────────┘     │   service.js)    │     │   repo.js)       │
                      └──────┬───────────┘     └────────┬─────────┘
                             │                          │
                      ┌──────▼───────────┐     ┌────────▼─────────┐
                      │ LocalCacheAdapter│     │  Firestore       │
                      │  (js/data/       │     │  (normalized     │
                      │   local-cache.js)│     │   collections)   │
                      └──────┬───────────┘     └──────────────────┘
                             │
                      ┌──────▼───────────┐
                      │  localStorage    │
                      │  (cache only,    │
                      │   size-limited)  │
                      └──────────────────┘
```

## Module Inventory

| Module | Path | Responsibility |
|--------|------|----------------|
| `FirestoreRepo` | `js/data/firestore-repo.js` | CRUD against Firestore normalized schema |
| `LocalCacheAdapter` | `js/data/local-cache.js` | localStorage as LRU cache with TTL |
| `WriteQueue` | `js/data/write-queue.js` | Debounced, batched writes with retry |
| `WizardDataService` | `js/data/wizard-data-service.js` | Orchestrates reads/writes, conflict resolution |
| `MigrationUtility` | `js/data/migration.js` | One-time migration from legacy to normalized |
| `DataTelemetry` | `js/data/telemetry.js` | Payload size, write count, error tracking |
