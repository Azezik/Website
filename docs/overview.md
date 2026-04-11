Introduction
Wrokit is a system for using human intelligence to rapidly indicate where valuable information appears on a specific document type.
Within Wrokit, the terms document, file, and image are interchangeable when referring to ingest. The system must not be designed around PDF-specific assumptions. PDF is only one possible input format, not a defining architectural concept. Wrokit must treat all supported inputs as visual documents rather than building core logic around any single file type.
A useful way to think about Wrokit is as a DVD player. The system should be composed of clearly separated parts, with each part having its own responsibility and contract.
The first major component is the equivalent of the DVD itself: the wizard file.
Wizard Builder
Wrokit includes a Wizard Builder, whose purpose is to create wizard files.
A wizard file defines the schema of the information a user wants to capture from a document type. The Wizard Builder allows a creator to assign a title to the wizard, which serves as its name. It also allows the creator to define as many fields as needed. For example, a user might begin with a field called name, then add another field called date, and continue adding fields such as invoice number, subtotal, or total.
Each field can also be assigned a data type from a dropdown menu. The available data types are:
numeric only
text only
any
These data types are not used directly for extraction. Their purpose is to act as helpful flags that support later processes.
Once the wizard has been saved, the wizard definition is complete. At that point, the next step is not extraction, but configuration.
Separation Between Wizard Creation and Wizard Configuration
Wizard creation and wizard configuration must be treated as completely separate processes.
A wizard file should be portable. Someone should be able to create a wizard, send that wizard file to someone else, and that second person should be able to configure it independently.
Configuration does not rewrite the schema itself. Instead, configuration creates or defines the wizard’s geometry. This process is called wizard config.
For example, imagine there is an invoice wizard containing fields such as date, invoice number, subtotal, and total. That same wizard should be reusable across multiple invoice templates. If invoices are received from several different companies, the schema does not need to change. Instead, the same wizard can be configured separately for each distinct invoice layout.
In other words, one wizard can support multiple document templates, with each template having its own geometry configuration.
The geometry configuration is associated with the wizard file. The wizard defines what fields exist. The configuration defines where those fields appear for a specific template.
Wizard Config Flow
When a user uploads a wizard and chooses to configure its geometry, the wizard configuration system reads the wizard file and generates a step-by-step questionnaire.
This questionnaire proceeds field by field, in order.
For example, if the wizard contains the fields invoice number, date, subtotal, and total, the configuration flow will ask the user where each field is located on the document. It would begin with a prompt such as:
“Where is the invoice number?”
The system then continues through the remaining fields in sequence, guiding the user through the process of locating each one.
This is the beginning of how Wrokit turns a generic field definition into a template-specific configuration.
Send the next section.
Configuration Surface and Geometry Writing
The configuration window for this part of Wrokit must be designed around a guided, field-by-field configuration flow.
The configuration process begins with a file upload. The user clicks upload and provides a file. That file may be a PDF or an image. Wrokit must not rely on PDF-specific tooling at this stage or at the architectural level in general. Wrokit operates in an optical space. That means every uploaded file, regardless of original format, must be converted into the same visual working surface before any downstream processing begins.
This is non-negotiable.
Optical-First Ingest
As soon as a file is uploaded, Wrokit must immediately rasterize and normalize it so that every input type is treated identically in the next stages.
The purpose of this step is to eliminate file-type-specific behavior as early as possible. A PDF and an image may arrive through different input paths, but once ingested, they must become the same kind of internal object: a normalized visual document surface.
From that point forward, the system should not care whether the source file began as a PDF or an image. All further processing should operate on the rasterized, normalized visual result.
Preprocessing Before User Interaction
Before the document is shown back to the user, Wrokit performs a preprocessing phase. This phase occurs during a loading state and is handled by a separate module: the extraction engine.
This separation is important. The wizard config flow is responsible for guiding the user through configuration. The extraction engine is responsible for analyzing the uploaded visual document and generating the structural information that will be used to write the geometry.
This engine must run entirely in the browser. For that reason, Wrokit should use OpenCV.js.
Structural Modeling of the Document
Once the file has been rasterized and normalized, Wrokit loads it into OpenCV.js and begins building a structural model of the document.
This structural model starts at the broadest level.
First, Wrokit identifies the outer edges of the document itself. It records the size, dimensions, and overall page boundaries, and ties all of this into a coordinate space. The goal is to establish a reliable spatial frame of reference for everything that follows.
After identifying the outer page edges, Wrokit begins building a rough understanding of the major areas within the document. This process should work from the outside inward. Rather than immediately trying to localize small details, the system should first understand the broad structure of the page.
This includes identifying the main content regions and the spatial relationship between the physical edge of the page and the areas where meaningful content actually begins.
In practical terms, Wrokit needs to understand both of the following:
where the true page boundary is
where the meaningful interior content area begins
Most documents have spacing between the page edge and the actual content. Text and key information typically do not run all the way to the edge of the page. Wrokit needs to capture that relationship. It must understand the outer page perimeter, but it must also understand the perimeter of the main content regions inside that page.
This produces what can be called a perimeter and size mapping.
Perimeter and Size Mapping
The perimeter and size mapping is a foundational layer of the geometry model.
It describes the large-scale spatial structure of the document, including:
the outer boundaries of the page
the major interior content boundaries
the relationship between page size and content placement
the approximate corners and extents of the document’s main structural areas
This mapping is intentionally broader and more global than later structural analysis. Its purpose is not to localize a specific field immediately, but to create an overall understanding of how the template is laid out.
That broad understanding becomes part of the coordinate and relational system that later field-level geometry will rely on.
User Annotation as Source of Truth
Once preprocessing is complete, Wrokit presents the document back to the user and begins the step-by-step configuration questions.
For example, the system may ask:
“Where is the invoice number?”
The user then responds by drawing a bounding box over the relevant area of the document.
This user-drawn box must be treated as a source of truth.
In the configuration process, the human annotation is not a weak hint. It is authoritative input. A human deliberately identified the correct region, and that action is highly valuable. The geometry-writing process must treat the user’s bounding box as one of the most trustworthy pieces of information in the entire system.
Field Constellation Mapping
After the user draws a bounding box, Wrokit uses that box as the center of a localized structural analysis.
Using the overall document size, the perimeter mapping, and nearby structural information, Wrokit builds what can be described as a constellation around that field.
Within a reasonably generous radius around the user’s box, the system looks for prominent anchors. These anchors are nearby structural features that can help re-identify the field later, even if the field itself cannot be matched directly.
Wrokit then records the relationships among:
the user’s bounding box
the nearby anchors
the anchors relative to one another
the field relative to the broader document structure
The purpose of this is resilience. If Wrokit cannot later find the exact target box directly, it can still use the surrounding structural constellation to estimate the correct location. By finding several of the same anchors again and understanding their relationships, the system can triangulate an accurate estimate of where the field should be.
Writing the Geometry File
All of this spatial and relational information is written into the geometry file during configuration.
The geometry file is therefore not just a list of boxes. It is a spatial model of a specific template and the locations of the information Wrokit needs to extract from it.
This geometry file contains two levels of information.
The first level is general template geometry. This includes the global spatial model of the page, such as:
perimeter and size mapping
general internal structural mapping
page-level coordinate relationships
broad layout characteristics of the template
The second level is field-specific geometry.
For each field, Wrokit stores the structural and relational data tied to the user’s bounding box. This data is isolated to that field and represents the logic for finding that field later.
For example, in an invoice template, the invoice number field would have its own field-level geometry entry containing the user’s authoritative box and the local relational structure needed to recover it. The date field would have a separate field-level geometry entry. The same would apply for subtotal, total, and any other configured field.
Each field’s geometry is independent in the sense that it contains the specific spatial logic required to find that field.
Field-by-Field Completion
Wrokit repeats this process one field at a time.
For each field in the wizard, the system asks the user where that field is, receives a user-drawn bounding box, builds a local structural constellation around it, and writes that information into the geometry file.
By the end of the wizard config flow, the geometry file becomes a complete spatial representation of that template, containing both the document-level structural model and the field-level logic needed to locate each required piece of information.
Field Confirmation, Extraction Preview, and Run-Time Extraction
Once a bounding box has been drawn for a field, Wrokit continues the configuration process at the field level.
At that moment, Wrokit performs OCR only on the exact area inside the user’s box. It does not run OCR across the full page. Full-page OCR is not part of this configuration flow. The OCR step is intentionally limited to the region the user explicitly identified.
The text extracted from that boxed area is then shown back to the user in a preview section located below the main document viewport. This section is called Extraction Preview.
The purpose of Extraction Preview is to give the user immediate feedback on what Wrokit believes it has read from the selected region, while still keeping the user inside the configuration flow.
Field Confirmation
When the user is satisfied with the box they drew, they click Confirm.
Confirming the field saves the user’s bounding box together with all relevant geometry associated with it. This includes:
the box coordinates
the box size
the box size relative to overall document size
the box position relative to the overall coordinate space
the box relationship to the document perimeter mapping
the box relationship to nearby structural anchors
the local structural fingerprint around the box
any other information required to redraw that box later in the same place and at the same relative size
This save operation is field-specific. It writes the geometry needed to recover that field later during run-time extraction.
Once the field is confirmed, Wrokit advances to the next question defined by the wizard.
For example, if the first question was:
“Where is the invoice number?”
then after confirmation the next question might be:
“Where is the date?”
The same process repeats for every field in the wizard until all fields have been addressed.
Skipping Fields
Wrokit should allow the user to skip a field during configuration.
However, skipping a field does not alter the schema of the master output. The field still exists because it was defined in the wizard. Therefore, the corresponding column must still exist in the output structure.
If a user skips a field during configuration, that field remains part of the schema, but its values will be blank unless it is configured later. In other words, skipping a field does not remove the column. It only means Wrokit does not yet have field geometry for extracting it.
This preserves schema consistency across all documents processed under that wizard.
Completion of Configuration
Once the user has gone through all fields and clicks Save, the configuration phase is complete.
At that point, Wrokit saves the resulting geometry as a specific template geometry associated with that wizard. This geometry is stored within the user’s account and linked to the corresponding wizard.
The finished result of configuration is therefore not just a completed interaction flow, but a reusable geometry profile for one specific template.
Master DB Engine
Once configuration data exists, Wrokit uses a separate engine called the Master DB Engine.
The role of the Master DB Engine is to interpret the wizard schema into a structured output table, represented initially as a CSV-like model.
The wizard defines the columns.
If the wizard contains fields such as:
invoice number
date
subtotal
total
then the Master DB schema will contain those exact column headers in that order.
The values extracted for each processed document become rows beneath those headers.
During configuration, the OCR values captured from the config document may be written as the first row of this structure, since they represent the first successful extraction aligned to the schema. More broadly, the config process establishes both the schema and the first verified example of populated field values.
The important point is that the wizard defines the output structure, and run-time extraction populates that structure document by document.
Account Structure and Post-Config Access
When a user creates or imports a wizard, that wizard is saved into their Wizard Manager.
When they configure a template against that wizard, the resulting geometry is also saved under that wizard in their account.
In addition, the wizard and its associated extraction outputs should be visible within the user’s broader Document Dashboard.
Inside the Wizard Manager, each wizard can be expanded to show details and related assets. One of those assets should be an Extracted Data view. This view displays a preview of the Master DB output for that wizard, including the schema and current extracted rows.
Run Phase
After configuration is complete, Wrokit enters its second major operational phase: run.
If config is the phase where Wrokit learns the geometry of a template, run is the phase where Wrokit applies that learned geometry to newly uploaded documents.
This is where Wrokit performs actual repeated extraction at scale.
For example, a user may configure a wizard and geometry for a pay stub template. Once that is done, they should be able to go to the Document Dashboard, select that wizard or geometry, and drag in a batch of files, such as 50 pay stubs.
Wrokit should then process those uploaded documents one by one using the previously saved configuration. The result is a populated Master DB where each processed document contributes one additional row.
If one config document already exists as the first row, then processing 50 more matching documents would produce a total of 51 rows.
Run Uses Config
The run phase depends directly on the geometry created during config.
When a new document is uploaded for extraction, Wrokit begins by comparing that run document to the saved configuration geometry.
The first thing it examines is the perimeter mapping.
It checks the broad structure of the new document against the configured document. This includes questions such as:
is the document proportionally the same shape
is the document larger or smaller than the configured version
has the content shifted inward or outward relative to the page edges
is the overall layout scaled uniformly
This comparison produces what can be called the transformation model.
Transformation Model
The transformation model describes how the configured geometry must be adjusted to fit the current run document.
For example, if the run document has the same overall proportions as the configured document but is simply a different scale, Wrokit should proportionally resize the entire stored geometry model.
This must be treated as a relational transformation.
If a field was previously a certain distance from an anchor, and the new document is scaled down by a known amount, then that field’s expected position relative to that anchor should scale down accordingly.
The same applies to:
box size
box position
anchor spacing
structural region spacing
page-level perimeter relationships
Conceptually, this should behave like scaling a full structured layer in a design tool. Wrokit is not adjusting one measurement in isolation. It is resizing the entire relevant structural model together.
The perimeter structure is the first layer used to estimate this transformation. Once Wrokit has a reasonable idea of how the current document differs from the configured one, it applies that transformation broadly to the rest of the stored geometry.
Field-by-Field Localization During Run
After the transformation model has been established, Wrokit begins locating fields one at a time, in wizard order.
For each field, Wrokit first attempts to redraw the expected bounding box in the transformed location where that field should appear.
It then compares that predicted region against the structural fingerprint saved during configuration. This includes checking whether the region still appears to match the kind of container, surrounding structure, and spatial relationships expected for that field.
If the predicted box appears valid, Wrokit proceeds with localized OCR for that field.
If the predicted box does not sufficiently match, Wrokit falls back to the field’s stored constellation logic.
In that case, Wrokit searches for the landmarks and nearby anchors recorded during configuration. It compares how those landmarks relate to one another and how they relate to the expected field position. Using those relationships, Wrokit triangulates where the field’s box should actually be in the current document.
This lets Wrokit recover the field even when simple direct redraw is not enough.
Run-Time Field Logic Summary
For each field, run should follow this general pattern:
Start with the transformed expected box location.
Compare that expected region against the stored structural fingerprint.
If it matches well enough, accept it.
If it does not match well enough, search for the recorded anchor constellation.
Use anchor relationships to re-estimate the field location.
Verify the resulting box.
OCR only that localized area.
Write the extracted value into the correct column of the Master DB row.
This process repeats field by field until the entire document has been extracted.
Writing Rows to Master DB
Once all configured fields for a run document have been processed, Wrokit writes a new row into the Master DB output.
Each value is written to the column defined by the wizard schema.
After that row is complete, Wrokit moves on to the next uploaded document if the user submitted a batch.
This continues until all documents in the batch have been processed.
The result is a structured dataset built from:
a reusable wizard schema
one or more template geometries
repeated localized extraction driven by human-authored configuration
The core idea is that config writes the spatial intelligence once, and run reuses it repeatedly.
