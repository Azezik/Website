# WFG3 Phase 1 Prompt: Reduce Early Token Muting (Let Stage D Decide)

Use this prompt for the **next implementation pass**.

---

## Role
You are implementing **Phase 1** of WFG3 stabilization in the JS pipeline:
- `engines/wrokitvision/wfg3/wfg3-stages-ac.js`
- `engines/wrokitvision/wfg3/wfg3-stages-df.js`
- `engines/wrokitvision/wfg3/wfg3-browser-engine.js`

This phase is intentionally narrow: **reduce aggressive token suppression in Stage C and preserve weak/ambiguous evidence so Stage D can decide what is structurally valid**.

Do **not** introduce a new dual-token system. Do **not** redesign Stage D globally yet.

---

## Core Intent
Current behavior mutes weak tokens too early. We want to:
1. **Keep more candidate tokens** (including weak contrast tokens).
2. **Defer rejection to Stage D graph consistency** instead of hard dropping in Stage C.
3. Preserve backward compatibility via config flags and defaults that can be A/B tested.

Think: “Generate broadly, prune by structure.”

---

## Phase 1 Scope (Do this)

### A) Stage C: Replace hard drops with soft tagging where possible
In `wfg3-stages-ac.js`, identify every place we currently do hard suppression and change behavior to prefer retention + metadata.

#### Required behavior changes
1. **Token confidence gate (`tokenMinConfidence`)**
   - Current pattern: `if (tok.confidence < minConf) continue;`
   - New Phase 1 behavior:
     - Keep token unless an explicit strict-mode flag is enabled.
     - Add a token flag like `tok._weakConfidence = true` when below threshold.

2. **Scaffold local evidence gate (`scaffoldEvidenceGateMin`)**
   - Current pattern: skip candidate if local evidence is below gate.
   - New behavior:
     - Option to allow low-evidence candidates (tag with `_weakEvidence = true`) when relaxed mode is on.

3. **Per-tile trimming and budget clamps**
   - Where tokens are sorted and weakest discarded to satisfy `seedMaxPerTile`, reduce aggressiveness.
   - New behavior:
     - Keep broader set in relaxed mode, or raise cap substantially via new params.
     - If trimming still occurs, prefer dropping exact near-duplicates before low-confidence uniques.

4. **NMS / spacing suppression**
   - Keep suppression to avoid explosions, but make it tunable and less aggressive.
   - Add a relaxed-mode multiplier (e.g., smaller NMS radius, smaller min spacing).

5. **Token cap behavior**
   - If cap is hit, expose telemetry counters so we know muting came from cap pressure.

### B) Stage D: Add a lightweight structural cleanup pass (no major redesign)
In `wfg3-stages-df.js`, after adjacency/chains are built, add a small cleanup that removes obvious garbage tokens by structure:

1. **Isolated token / tiny-fragment pruning by topology**
   - Remove components that are structurally non-credible (e.g., singleton or tiny fragments with no supporting alignment).
   - Keep this conservative and configurable.

2. **Degree/context-based weak token culling**
   - Tokens tagged `_weakConfidence` or `_weakEvidence` should be removable **only if** they have poor graph support.
   - If weak tokens participate in coherent chains, keep them.

3. **Do not over-prune loops/curves**
   - Add guardrails so curved low-contrast boundaries are not erased just for being weak.

### C) Browser defaults: add explicit Phase 1 knobs
In `wfg3-browser-engine.js` defaults, add parameters to switch between current strict behavior and Phase 1 relaxed behavior.

Minimum new params to add:
- `phase1RelaxedTokenRetention` (bool)
- `phase1StrictConfidenceDrop` (bool, default false in relaxed profile)
- `phase1WeakTokenPruneMinSupport` (numeric)
- `phase1NmsRadiusScale` (numeric multiplier)
- `phase1SpacingScale` (numeric multiplier)
- `phase1MaxTokensScale` (numeric multiplier)

Use these to avoid hardcoding behavior and make testing easy.

---

## Non-Goals (Do NOT do in this phase)
1. No macro+micro multi-scale graph redesign.
2. No global pattern-matching engine for repeating motifs yet.
3. No major refactor of Stage D ordering/bridging logic beyond lightweight structural cleanup.
4. No new persistence/profile schema changes unless absolutely necessary.

---

## Design Constraints
- Keep code modular and readable; avoid monolithic functions.
- Add helper functions for new filtering logic instead of inlining complex conditionals.
- Preserve backward compatibility: strict legacy behavior should still be selectable.
- Keep telemetry/debug counters so we can compare before/after muting impact.

---

## Acceptance Criteria
1. Stage C no longer aggressively drops weak tokens by default in relaxed mode.
2. Stage D performs structural pruning so obvious garbage is removed downstream.
3. Token count increases in weak-gradient regions without catastrophic graph explosion.
4. Chain continuity improves on low-contrast sides of gradients/signs.
5. Repeating-pattern scenes do not regress badly (no massive false chain explosion).
6. All new behavior is controlled by config toggles in browser defaults.

---

## Required Output from Implementer
When you finish implementation, provide:
1. List of changed files and functions.
2. Explanation of new flow (Stage C retention -> Stage D structural pruning).
3. New config parameters and defaults.
4. Before/after metrics on at least one benchmark image:
   - token count
   - chain count
   - bridges accepted
   - count of weak-tagged tokens retained vs pruned
5. Risks and next-step recommendations for Phase 2 (macro+micro reasoning).

---

## Suggested commit title
`WFG3 Phase 1: relax Stage C token muting and defer weak-token pruning to Stage D`
