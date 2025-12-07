# Custom Wizard Implementation Technical Report

## Goals and Constraints
- Add a **Custom Wizard** mode that lets users define up to 30 fields (Static or Dynamic) with free-text names.
- Reuse existing config/run pipelines for static and dynamic fields; only the source of questions/field metadata changes.
- Keep the existing predefined wizard unchanged and available.

## Data Model & Persistence
### Core Entities
- **WizardTemplate** (new)
  - `id` (UUID)
  - `documentTypeId` (references the document/template the wizard is tied to)
  - `wizardName` (string, required, unique per `documentTypeId`)
  - `fields` (array of `WizardField`)
  - `createdBy`, `createdAt`, `updatedAt`, `version`
- **WizardField**
  - `id` (UUID)
  - `wizardTemplateId`
  - `name` (string, required)
  - `fieldType` (enum: `static`, `dynamic`)
  - `order` (int, creation order)
- **QuestionnaireItem** (generated view)
  - `questionIndex` (int)
  - `totalQuestions` (int)
  - `prompt` ("Please highlight the <Field Name>")
  - `fieldId`, `fieldType`, `order`

### Storage Location
- Persist `WizardTemplate` in the same persistence layer as existing wizard/config templates (e.g., MasterDB/config store) alongside the predefined templates.
- For run/extraction, maintain a **fieldId → MasterDB column** mapping derived from the normalized field name (`customer_name`) per wizard template.

### Derived Artifacts
- **Question list**: generated at save time and cached with the template for fast load in Config Mode; ordered by all Static fields first (by `order`), then Dynamic fields (by `order`).
- **MasterDB mapping**: at save/update, create/update columns for each field in the document’s schema if absent; store mapping `{fieldId, columnName}` on the template.

## UI/UX Flow
### Document Dashboard
- Buttons:
  - **Configure Wizard**: unchanged; uses the wizard selected in **Saved Wizards** dropdown.
  - **Configure Custom Wizard**: opens **Build Your Wizard** for the current document/template.
- **Saved Wizards dropdown**:
  - List predefined wizard (default) plus saved `WizardTemplate` entries (`wizardName`).
  - Selecting a custom wizard + clicking **Configure Wizard** loads the Config page with that wizard’s questions.

### Build Your Wizard Page
1. **Wizard Name input** (required).
2. **Fields area**
   - Display `Total fields: N`.
   - Field rows (order labels 1..N) styled like existing Extracted Data pills.
   - Each row: `Field Type` dropdown (Static default), `Field Name` text input (required).
3. **Add Field** button
   - Max 30; on overflow show "Max number of Fields reached".
   - Adds new field with default `Static` and empty name; updates order labels and total.
4. **Save Custom Wizard** button
   - Validations:
     - Wizard name non-empty.
     - ≥1 field.
     - All Field Names non-empty.
   - Defaults: missing `Field Type` → `Static`.
   - On success:
     - Persist `WizardTemplate` and derived questions/mappings.
     - Register wizard in Saved Wizards.
     - Redirect to Config Mode preloaded with the new question list.

### Config Mode (Custom Wizard)
- Same layout/UX as existing Config Mode.
- Loads questions from selected wizard template (predefined or custom) via a unified `loadWizard(templateId)` API.
- Uses `questionIndex/totalQuestions` to show progress.
- For each question, the underlying `fieldId`/`fieldType` drives the existing static/dynamic configuration and saves bounding boxes as today.

## Backend/Frontend Integration
- **APIs**
  - `POST /wizard-templates` to create; `PUT /wizard-templates/:id` to update; `GET /wizard-templates?documentTypeId=` for dropdown; `GET /wizard-templates/:id/questions` for Config Mode.
  - Responses include fields, derived questions, and field-to-column mappings.
- **Client state**
  - Dashboard fetches wizard list on load/after save; sets selected wizard for Configure Wizard action.
  - Build page maintains local field array; on save, sends normalized payload.
  - Config page requests questions for the selected wizard and passes them into the existing pipeline.

## Reuse of Existing Pipelines
- Config pipeline already expects a list of questions with linked static/dynamic fields. We supply the same shape (prompt, fieldId, fieldType, order, questionIndex, totalQuestions), so downstream logic remains unchanged.
- Run pipeline uses stored config + field metadata (static/dynamic) and MasterDB schema; custom templates share the same data contracts, so no extraction changes are required.

## Edge Cases & Policies
- **Editing a wizard**: If a custom wizard is edited after configs exist, keep versioning: new save increments `version`; existing configs reference the version they were created with. Warn users that changing fields may require reconfiguration.
- **Deleting a wizard**: If allowed, prevent deletion when active configurations/runs exist, or soft-delete and hide from dropdown while keeping historical runs pinned to the last available version.
- **Renaming fields**: Update display names, but keep `fieldId` stable so configs/runs remain valid; column mapping uses `fieldId`, not display string.
- **Changing field type**: Requires new version; prompt user to reconfigure affected fields since bbox semantics differ.
- **Max fields enforcement**: Server-side validation mirrors UI limit (30) to avoid oversized payloads.
- **Uniqueness**: Enforce `wizardName` uniqueness per document type to avoid dropdown confusion.
- **Migration/defaults**: Predefined wizard is represented as a `WizardTemplate` in-memory or via a flag; loader chooses between predefined or stored custom template based on dropdown selection.

## Hook Points
- **Dashboard**: extend wizard loader to include custom templates; wire **Configure Custom Wizard** to the build page route with current document/template context.
- **Build Page**: new UI and save logic; calls create/update APIs.
- **Config Page**: change data source to `loadWizard(selectedWizardId)`; once questions are loaded, reuse existing question navigation and bbox capture components.
- **MasterDB layer**: on template save, ensure schema has columns for each `fieldId`; keep mapping for run-time extraction results.

## Success Criteria
- Users can create named custom wizards with up to 30 fields, save them, and see them in **Saved Wizards**.
- Running **Configure Wizard** with a selected custom wizard presents the generated questions and uses existing static/dynamic configuration behaviors.
- Run-mode extraction and MasterDB outputs continue to function without pipeline changes for both predefined and custom wizards.
