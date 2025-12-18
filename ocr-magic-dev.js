(function () {
  const pipeline = (typeof OcrMagicPipeline !== 'undefined') ? OcrMagicPipeline : null;
  const builder = (typeof BuilderFieldRow !== 'undefined') ? BuilderFieldRow : null;
  if (!pipeline || !builder) {
    console.warn('OCRMAGIC sandbox missing dependencies.');
    return;
  }

  const els = {
    fieldList: document.getElementById('sandbox-field-list'),
    addFieldBtn: document.getElementById('add-field-btn'),
    runBtn: document.getElementById('run-ocr-btn'),
    resetBtn: document.getElementById('reset-learning-btn'),
    output: document.getElementById('corrected-output'),
    traceSteps: document.getElementById('trace-steps'),
    debugToggle: document.getElementById('debug-toggle'),
    debugLog: document.getElementById('debug-log'),
    activeFieldLabel: document.getElementById('active-field-label')
  };

  const store = new pipeline.SegmentModelStore('ocrmagic.dev.sandbox');
  const state = {
    fields: [],
    activeFieldId: null,
    lastDebug: null
  };

  const genId = (prefix = 'field') => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

  function createField() {
    return {
      id: genId('field'),
      fieldType: 'static',
      name: '',
      magicType: pipeline.MAGIC_DATA_TYPE.ANY,
      rawInput: ''
    };
  }

  function getActiveField() {
    if (!state.fields.length) return null;
    const active = state.fields.find((f) => f.id === state.activeFieldId);
    return active || state.fields[0];
  }

  function setActiveField(fieldId) {
    state.activeFieldId = fieldId;
    document.querySelectorAll('.custom-field-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.fieldId === fieldId);
    });
    updateActiveFieldLabel();
  }

  function updateActiveFieldLabel() {
    const field = getActiveField();
    if (!field || !els.activeFieldLabel) return;
    const idx = state.fields.indexOf(field) + 1;
    const name = (field.name || `Field ${idx}`).trim();
    els.activeFieldLabel.textContent = `Active: ${name} (${field.fieldType || 'static'})`;
  }

  function removeField(fieldId) {
    if (state.fields.length <= 1) return;
    state.fields = state.fields.filter((f) => f.id !== fieldId);
    if (!state.fields.find((f) => f.id === state.activeFieldId)) {
      state.activeFieldId = state.fields[0]?.id || null;
    }
    renderFields();
  }

  function ensureField() {
    if (!state.fields.length) state.fields.push(createField());
    if (!state.activeFieldId) state.activeFieldId = state.fields[0].id;
  }

  function renderFields() {
    ensureField();
    if (!els.fieldList) return;
    els.fieldList.innerHTML = '';
    state.fields.forEach((field, idx) => {
      const row = builder.createFieldRow({
        field,
        index: idx,
        magicTypeOptions: pipeline.MAGIC_DATA_TYPE,
        onDelete: () => removeField(field.id),
        onChange: () => setActiveField(field.id)
      });
      row.dataset.fieldId = field.id;
      row.addEventListener('click', () => setActiveField(field.id));

      const rawWrap = document.createElement('div');
      rawWrap.className = 'field-row-raw';
      const label = document.createElement('label');
      label.textContent = 'RAW OCR / Input Text';
      const textarea = document.createElement('textarea');
      textarea.className = 'sandbox-textarea';
      textarea.placeholder = 'Paste OCR output here...';
      textarea.value = field.rawInput || '';
      textarea.addEventListener('focus', () => setActiveField(field.id));
      textarea.addEventListener('input', (e) => { field.rawInput = e.target.value; });

      rawWrap.appendChild(label);
      rawWrap.appendChild(textarea);
      row.appendChild(rawWrap);
      els.fieldList.appendChild(row);
    });
    setActiveField(getActiveField()?.id);
  }

  function escapeHtml(str = '') {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function diffMarkup(before = '', after = '') {
    const max = Math.max(before.length, after.length);
    let html = '';
    let changes = 0;
    for (let i = 0; i < max; i++) {
      const prev = before[i] ?? '';
      const next = after[i] ?? '';
      if (prev === next) {
        html += escapeHtml(next || ' ');
      } else {
        changes += 1;
        const title = `${prev || '∅'} → ${next || '∅'}`;
        const display = next || ' ';
        html += `<mark class="diff-change" title="${escapeHtml(title)}">${escapeHtml(display)}</mark>`;
      }
    }
    return { html: html.replace(/ /g, '&nbsp;'), hasChanges: changes > 0 };
  }

  function renderSegmentCard(seg) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    const layout = seg.learnedLayout || ''.padStart(seg.slotLength, '?');
    card.innerHTML = `
      <div><strong>Segment:</strong> ${escapeHtml(seg.segmentId || 'segment')}</div>
      <div><strong>Slot String:</strong> ${escapeHtml(seg.slotString || '')}</div>
      <div><strong>Learned Layout:</strong> ${escapeHtml(layout)}</div>
      <div><strong>DV:</strong> ${seg.deliberateViolation ? 'TRUE' : 'false'} (eligible ${seg.dvEligible || 0}, contradictions ${seg.dvContradictions || 0})</div>
      <div><strong>Scores:</strong> L[${(seg.slotScores?.letterScore || []).join(', ')}] N[${(seg.slotScores?.numberScore || []).join(', ')}]</div>
    `;
    return card;
  }

  function buildDiffBlock(title, before, after, notes = []) {
    const wrap = document.createElement('div');
    wrap.className = 'trace-block';
    const heading = document.createElement('div');
    heading.className = 'trace-title';
    heading.textContent = title;
    const diff = diffMarkup(before || '', after || '');
    const body = document.createElement('div');
    body.className = 'diff-line';
    body.innerHTML = diff.html || '&nbsp;';
    wrap.appendChild(heading);
    wrap.appendChild(body);
    const note = document.createElement('div');
    note.className = 'diff-note';
    if (diff.hasChanges || (notes && notes.length)) {
      const allNotes = notes && notes.length ? notes : ['Changes applied.'];
      note.textContent = allNotes.join(' | ');
    } else {
      note.textContent = 'No changes applied.';
    }
    wrap.appendChild(note);
    return wrap;
  }

  function renderTrace(debug) {
    if (!els.traceSteps) return;
    els.traceSteps.innerHTML = '';
    if (!debug) return;

    const rawText = debug.rawText || '';
    const station1Text = debug.station1?.l1Text || debug.station1?.cleaned || rawText;
    const station2Text = debug.station2?.typedText || station1Text;
    const station4Text = debug.station4?.finalText || station2Text;

    els.traceSteps.appendChild(buildDiffBlock('RAW', '', rawText));
    els.traceSteps.appendChild(buildDiffBlock('Station 1 (Layer 1)', rawText, station1Text, (debug.station1?.layer1Edits || []).map((e) => `${e.from}->${e.to} @${e.index}`)));
    els.traceSteps.appendChild(buildDiffBlock(`Station 2 (Magic Type: ${(debug.fieldCtx?.magicType || '').toString().toUpperCase() || 'ANY'})`, station1Text, station2Text, (debug.station2?.typeEdits || []).map((e) => `${e.from}->${e.to} @${e.index}`)));

    const station3Block = document.createElement('div');
    station3Block.className = 'trace-block';
    const title = document.createElement('div');
    title.className = 'trace-title';
    title.textContent = 'Station 3 (Fingerprint & DV)';
    station3Block.appendChild(title);
    const desc = document.createElement('div');
    desc.className = 'diff-note';
    desc.textContent = 'Extraction + scoring only. Text unchanged.';
    station3Block.appendChild(desc);
    (debug.station3?.segments || []).forEach((seg) => station3Block.appendChild(renderSegmentCard(seg)));
    if (!(debug.station3?.segments || []).length) {
      const none = document.createElement('div');
      none.className = 'diff-note';
      none.textContent = 'No segments extracted.';
      station3Block.appendChild(none);
    }
    els.traceSteps.appendChild(station3Block);

    els.traceSteps.appendChild(buildDiffBlock('Station 4 (Layout Corrections)', station2Text, station4Text, (debug.station4?.fingerprintEdits || []).map((e) => `${e.from}->${e.to} @${e.slotIndex} (${e.learned})`)));
    els.traceSteps.appendChild(buildDiffBlock('FINAL', rawText, station4Text));
  }

  function runSandbox() {
    const field = getActiveField();
    if (!field) return;
    const idx = state.fields.indexOf(field) + 1;
    const ctx = {
      wizardId: 'ocrmagic-dev-sandbox',
      accountId: 'demo-account',
      fieldName: (field.name || `Field ${idx}`).trim() || `Field ${idx}`,
      magicType: field.magicType || pipeline.MAGIC_DATA_TYPE.ANY,
      segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] }
    };
    const rawText = field.rawInput || '';
    const result = pipeline.runOcrMagic(ctx, rawText, store);
    state.lastDebug = result.debug;
    if (els.output) {
      els.output.value = result.finalText || '';
    }
    renderTrace(result.debug);
    if (els.debugLog) {
      els.debugLog.textContent = JSON.stringify(result.debug, null, 2);
    }
  }

  function resetLearning() {
    const field = getActiveField();
    if (!field) return;
    store.resetField({ wizardId: 'ocrmagic-dev-sandbox', fieldName: (field.name || '').trim() || 'Field' });
    renderTrace(state.lastDebug);
  }

  function bindEvents() {
    if (els.addFieldBtn) els.addFieldBtn.addEventListener('click', () => {
      state.fields.push(createField());
      renderFields();
    });
    if (els.runBtn) els.runBtn.addEventListener('click', runSandbox);
    if (els.resetBtn) els.resetBtn.addEventListener('click', resetLearning);
    if (els.debugToggle && els.debugLog) {
      els.debugToggle.addEventListener('change', (e) => {
        els.debugLog.style.display = e.target.checked ? 'block' : 'none';
      });
    }
  }

  bindEvents();
  renderFields();
})();
