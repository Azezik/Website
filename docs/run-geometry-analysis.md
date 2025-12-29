# RUN geometry path vs. CONFIG geometry

## Pipeline map (selection → active profile → extraction)
1) **Wizard selection (UI):** the dashboard stores the chosen wizard via `model-select` and `resolveSelectedWizardContext`, which returns the persistent `wizardId` (custom/template/model) plus any attached profile stub. `resolveRunWizardContext` then propagates that same `wizardId` and passes the selected or in-memory profile onward as `runCtx.profile`.  
2) **Config persistence:** when fields are captured in CONFIG, `saveProfile` persists the profile (including `normBox`/`bboxPct`/`rawBox`) under `wiz.profile.<username>.<docType>.<wizardId>`, so the geometry lives under the wizard’s persistent ID.  
3) **RUN load:** `runModeExtractFileWithProfile` looks up the stored profile with the same key, then builds `incomingProfile = migrateProfile(clonePlain(profile))` from `runCtx.profile` and calls `mergeProfileGeometry(incomingProfile, storedProfile)`.  
4) **Resolution/iteration:** `state.profile = resolvedProfile`; static extraction then iterates fields and calls `resolveStaticPlacement`, which relies on `normBox`/`staticGeom` to produce `placement.boxPx` before attempting fallback heuristics.

## Where geometry is dropped
* `mergeProfileGeometry` only walks `preferred.fields` (the incoming profile) and returns `{ ...fallback, ...preferred, fields: mergedFields }`. If `runCtx.profile` is truthy but lacks geometry—or even lacks field rows—`preferred` wins and the loaded `storedProfile` geometry is discarded. Any field whose geometry exists only in `storedProfile` disappears from `resolvedProfile`, so `resolveStaticPlacement` receives `null` boxes and RUN falls back to label/keyword scans.
* First missing point: the computed `resolvedProfile` in `runModeExtractFileWithProfile` when `incomingProfile` overrides `storedProfile` despite having no usable boxes; subsequent static extraction logs show empty `placement` inputs because `activeProfile.fields[*].normBox/bbox` are already blank.

## Summary root-cause statement
RUN is loading the correct stored profile for the selected `wizardId`, but `mergeProfileGeometry` replaces it with the geometry-less `incomingProfile` coming from the wizard selection context. Because the merge trusts the preferred profile wholesale, any CONFIG geometry loaded from storage is dropped before extraction, leaving `resolveStaticPlacement` with null boxes even though CONFIG saved them under the matching `wizardId`.
