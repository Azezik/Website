# Custom Master DB Export Plan

## Updated Goals
- Allow Master DB exports that rely solely on static fields defined in the wizard configuration (works for both standard and custom setups).
- Support "custom" Master DB exports for custom wizards without altering the legacy invoice export output.
- Trigger the custom-export mode automatically when a wizard is saved from the Build Your Wizard page (no UI toggle/button needed).

## Behavior Outline
- **Default (legacy) behavior:** If a saved wizard does not carry the custom master DB flag, continue using the existing invoice-oriented export pipeline and headers so current outputs remain unchanged.
- **Automatic custom mode:** When the user clicks **Save Wizard** on the Build Your Wizard page, mark the wizard profile as eligible for custom Master DB export (e.g., set `isCustomMasterDb: true` plus the configured static schema). This removes the need for a visible toggle.
- **Config-driven static schema:** Persist the ordered list of static fields (built-in and custom questions) with labels/keys. This list becomes the column schema for the custom export branch.
- **Optional line items:** Keep line-item export off by default in custom mode; allow opt-in via a stored flag so custom wizards that capture rows can include them without affecting static-only cases.
- **Non-custom safety:** Any wizard profile lacking the custom flag keeps the exact current Master DB export behavior and header ordering.

## Implementation Steps (no code yet)
1. **Persist auto-flag on save**
   - On Save Wizard, automatically store `isCustomMasterDb: true` and the static-field schema alongside the wizard profile payload.
   - Ensure legacy configs saved before this change remain `false`/unset to preserve outputs.

2. **Branch export entry point**
   - Early in the Master DB export flow, check `isCustomMasterDb` (or similar). If `false`/missing, run the existing pipeline untouched; if `true`, generate headers/rows from the saved static schema instead of the legacy header constants.

3. **Schema-driven header + row assembly**
   - Use the stored static-field list (built-ins and custom answers) to build the header order and populate row values.
   - Support optional line items via a separate flag; keep default off to avoid changing current outputs.

4. **Regression + scenario coverage**
   - Confirm a legacy invoice config (custom flag absent) produces identical CSV to current baselines.
   - Validate custom wizard cases: (a) static-only, (b) static + optional line items, ensuring headers/rows follow the saved schema.
   - Add guard tests asserting that only the presence of the custom flag toggles behavior.

## Notes
- No UI toggle is required; the auto-flag on Save Wizard acts as the switch.
- Avoid touching the legacy header definitions or normalization routines for non-custom exports.

## Suggested tasks
- **Add explicit custom export mode without changing standard output**
  - Persist `isCustomMasterDb` automatically on Save Wizard and default it to `false`/absent for existing configs.
  - Branch the Master DB export entry point so legacy exports run unchanged when the flag is not set.
  - Keep legacy header constants and normalization logic untouched in the non-custom path.

- **Support config-driven static schema for custom and static-only exports**
  - Save the ordered list of static fields (built-ins and custom questions) with labels/keys alongside the wizard profile when saving.
  - In the custom export branch, build headers/rows directly from this list and populate values from the stored answers.
  - Provide an opt-in flag for line items (default off) so custom wizards can include rows without affecting static-only exports.

- **Validation and regression coverage**
  - Baseline current invoice exports with `isCustomMasterDb` absent/false to confirm outputs remain identical.
  - Add scenarios covering custom static-only exports and custom exports with line items enabled.
  - Include guard tests proving the custom flag is the sole trigger for the new behavior.
