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
    activeFieldLabel: document.getElementById('active-field-label'),
    traceSelector: document.getElementById('trace-selector'),
    tracePassSelect: document.getElementById('trace-pass-select'),
    traceLineSelect: document.getElementById('trace-line-select'),
    passResults: document.getElementById('pass-results'),
    passResultsPanel: document.getElementById('pass-results-panel'),
    warning: document.getElementById('multiline-warning')
  };

  const store = new pipeline.SegmentModelStore('ocrmagic.dev.sandbox');
  const state = {
    fields: [],
    activeFieldId: null,
    lastDebug: null,
    trace: { passIndex: 0, lineIndex: 0 }
  };

  const genId = (prefix = 'field') => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

  function createField() {
    return {
      id: genId('field'),
      fieldType: 'static',
      name: '',
      magicType: pipeline.MAGIC_DATA_TYPE.ANY,
      rawInput: '',
      multiLineEnabled: false,
      passHistory: [],
      pendingLargeRun: false,
      lastOutput: '',
      lastDebug: null,
      passCounter: 0
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
    const field = getActiveField();
    state.lastDebug = field?.lastDebug || null;
    state.trace = { passIndex: 0, lineIndex: 0 };
    updateRunButtonLabel();
    renderPassResults();
    updateTraceSelector();
    renderTraceForCurrentSelection();
    updateOutputText();
    updateWarning('');
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
      const toggleWrap = document.createElement('label');
      toggleWrap.className = 'toggle-inline';
      toggleWrap.style.marginLeft = '8px';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!field.multiLineEnabled;
      toggle.addEventListener('change', (e) => {
        field.multiLineEnabled = !!e.target.checked;
        if (!field.multiLineEnabled) {
          field.passHistory = [];
          field.pendingLargeRun = false;
          field.passCounter = 0;
        }
        state.trace = { passIndex: 0, lineIndex: 0 };
        renderPassResults();
        updateOutputText();
        renderTraceForCurrentSelection();
        updateRunButtonLabel();
      });
      toggleWrap.appendChild(toggle);
      toggleWrap.appendChild(document.createTextNode('Enable multi-line'));
      label.appendChild(toggleWrap);
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

  function parseMultiline(rawText = '') {
    return String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length);
  }

  function sanitizeLineForPass(rawLine = '') {
    const asString = String(rawLine ?? '');
    if (asString.includes('\n')) {
      console.error('Dev safety: embedded newline found in line before runOcrMagic.', { length: asString.length });
    }
    return asString.replace(/\r?\n/g, ' ').trim();
  }

  function countEdits(debug = {}) {
    const s1 = (debug.station1?.layer1Edits || []).length;
    const s2 = (debug.station2?.typeEdits || []).length;
    const s4 = (debug.station4?.fingerprintEdits || []).length;
    return s1 + s2 + s4;
  }

  function runPass(lines = [], fieldCtx = {}) {
    const linesOut = [];
    const debugs = [];
    let changedCount = 0;
    let editCount = 0;
    lines.forEach((rawLine) => {
      const line = sanitizeLineForPass(rawLine);
      const res = pipeline.runOcrMagic(fieldCtx, line, store);
      const output = res.finalText || '';
      linesOut.push(output);
      debugs.push(res.debug);
      if (output !== line) changedCount += 1;
      editCount += countEdits(res.debug);
      const expectedSegments = Array.isArray(fieldCtx.segmenterConfig?.segments)
        ? fieldCtx.segmenterConfig.segments.length
        : 0;
      const segments = res.debug?.station3?.segments || [];
      if (expectedSegments > 1 && segments.length === 1 && segments[0]?.segmentId === 'full') {
        console.warn('Segmenter dev check: expected multiple segments but got single full.', {
          fieldName: fieldCtx.fieldName,
          inputLength: line.length,
          hadNewline: /\n/.test(rawLine || '')
        });
      }
    });
    return { linesOut, debugs, changedCount, editCount, totalLines: lines.length };
  }

  function renderPassBlock(passIndex, passResult, isLatest = false, totalPasses = 0) {
    const block = document.createElement('details');
    block.className = 'panel minimal';
    block.open = passIndex === 0 || isLatest;

    const summary = document.createElement('summary');
    const displayIndex = passResult.passNumber || passIndex + 1;
    summary.textContent = `Pass ${displayIndex} — Lines: ${passResult.totalLines || passResult.linesOut.length}, Changed: ${passResult.changedCount}, Edits: ${passResult.editCount || 0}`;
    block.appendChild(summary);

    const textarea = document.createElement('textarea');
    textarea.className = 'log-viewer sandbox-output';
    textarea.readOnly = true;
    textarea.value = (passResult.linesOut || []).join('\n');
    block.appendChild(textarea);

    if (isLatest && totalPasses < 10) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn primary';
      const currentPassNumber = passResult.passNumber || passIndex + 1;
      const nextPassNum = currentPassNumber + 1;
      btn.textContent = currentPassNumber === 1 ? `Run Pass ${nextPassNum} (use Pass 1 output as input)` : `Repeat pass (run Pass ${nextPassNum})`;
      btn.addEventListener('click', () => runSandbox(true));
      block.appendChild(btn);
    }

    return block;
  }

  function updateRunButtonLabel() {
    if (!els.runBtn) return;
    const field = getActiveField();
    if (field?.multiLineEnabled) {
      const nextPassNum = (field.passCounter || 0) + 1;
      els.runBtn.textContent = nextPassNum === 1 ? 'Run Pass 1' : `Repeat pass (run Pass ${nextPassNum})`;
    } else {
      els.runBtn.textContent = 'RUN OCR MAGIC';
    }
  }

  function renderSegmentCard(seg) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    const layout = seg.learnedLayout || ''.padStart(seg.slotLength, '?');
    const chunkLines = (seg.chunks || []).map((c) => {
      const parts = [
        `[#${c.index}] ${escapeHtml(c.rawChunk || '')}`,
        `alnum:${escapeHtml(c.chunkAlnum || '')}`,
        `type:${escapeHtml(c.chunkType || '?')}`,
        `layout:${escapeHtml(c.learnedLayout || '')}`,
        `L:${c.Lscore || 0} N:${c.Nscore || 0}`
      ];
      return parts.join(' | ');
    });
    card.innerHTML = `
      <div><strong>Segment:</strong> ${escapeHtml(seg.segmentId || 'segment')}</div>
      <div><strong>Raw Segment Text:</strong> ${escapeHtml(seg.rawSegmentText || '')}</div>
      <div><strong>Slot String:</strong> ${escapeHtml(seg.slotString || '')}</div>
      <div><strong>Learned Layout:</strong> ${escapeHtml(layout)}</div>
      <div><strong>DV:</strong> ${seg.deliberateViolation ? 'TRUE' : 'false'} (eligible ${seg.dvEligible || 0}, contradictions ${seg.dvContradictions || 0})</div>
      <div><strong>Scores:</strong> L[${(seg.slotScores?.letterScore || []).join(', ')}] N[${(seg.slotScores?.numberScore || []).join(', ')}]</div>
      <div><strong>Learned Chunk Types:</strong> ${escapeHtml(seg.learnedChunkTypes || '')}</div>
      <div><strong>Chunks:</strong><br>${chunkLines.join('<br>') || 'None'}</div>
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

    els.traceSteps.appendChild(buildDiffBlock('Station 4 (Layout Corrections)', station2Text, station4Text, (debug.station4?.fingerprintEdits || []).map((e) => {
      if (e.blocked) {
        return `${e.reason || 'blocked'} @${e.slotIndex} [chunk ${e.chunkIndex ?? '-'} ${e.learnedChunkType || '?'}]`;
      }
      return `${e.from}->${e.to} @${e.slotIndex} (${e.learned}) [chunk ${e.chunkIndex ?? '-'} ${e.learnedChunkType || '?'}]`;
    })));
    els.traceSteps.appendChild(buildDiffBlock('FINAL', rawText, station4Text));
  }

  function updateWarning(message = '') {
    if (!els.warning) return;
    els.warning.textContent = message || '\u00a0';
  }

  function updateOutputText() {
    if (!els.output) return;
    const field = getActiveField();
    els.output.value = field?.lastOutput || '';
  }

  function renderPassResults() {
    if (!els.passResults || !els.passResultsPanel) return;
    const field = getActiveField();
    els.passResults.innerHTML = '';
    if (!field || !field.multiLineEnabled || !(field.passHistory || []).length) {
      els.passResultsPanel.style.display = 'none';
      return;
    }
    const passes = field.passHistory || [];
    passes.forEach((pass, idx) => {
      const block = renderPassBlock(idx, pass, idx === passes.length - 1, passes.length);
      els.passResults.appendChild(block);
    });
    els.passResultsPanel.style.display = 'block';
  }

  function updateTraceSelector() {
    const field = getActiveField();
    if (!els.traceSelector || !els.tracePassSelect || !els.traceLineSelect) return;
    if (!field || !field.multiLineEnabled || !(field.passHistory || []).length) {
      els.traceSelector.style.display = 'none';
      return;
    }

    const passCount = field.passHistory.length;
    state.trace.passIndex = Math.min(state.trace.passIndex, passCount - 1);
    const activePass = field.passHistory[state.trace.passIndex];
    const lineCount = Math.max(1, (activePass?.linesOut || []).length);
    state.trace.lineIndex = Math.min(state.trace.lineIndex, lineCount - 1);

    els.tracePassSelect.innerHTML = '';
    for (let i = 0; i < passCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Pass ${field.passHistory[i]?.passNumber || i + 1}`;
      if (i === state.trace.passIndex) opt.selected = true;
      els.tracePassSelect.appendChild(opt);
    }

    els.traceLineSelect.innerHTML = '';
    for (let i = 0; i < lineCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Line ${i + 1}`;
      if (i === state.trace.lineIndex) opt.selected = true;
      els.traceLineSelect.appendChild(opt);
    }

    els.traceSelector.style.display = 'flex';
  }

  function renderTraceForCurrentSelection() {
    const field = getActiveField();
    let debug = null;
    if (field?.multiLineEnabled && (field.passHistory || []).length) {
      const pass = field.passHistory[state.trace.passIndex];
      debug = pass?.debugs?.[state.trace.lineIndex] || null;
    } else {
      debug = field?.lastDebug || state.lastDebug;
    }
    state.lastDebug = debug;
    renderTrace(debug);
    if (els.debugLog) {
      els.debugLog.textContent = debug ? JSON.stringify(debug, null, 2) : '';
    }
  }

  function buildFieldContext(field) {
    const idx = state.fields.indexOf(field) + 1;
    const isAddress = /address/i.test((field.name || `Field ${idx}`).trim());
    const segmenterConfig = isAddress
      ? { mode: 'first2_last2', segments: [{ id: 'address:first2', strategy: 'first2' }, { id: 'address:last2', strategy: 'last2' }] }
      : { mode: 'full', segments: [{ id: 'full', strategy: 'full' }] };
    return {
      wizardId: 'ocrmagic-dev-sandbox',
      accountId: 'demo-account',
      fieldName: (field.name || `Field ${idx}`).trim() || `Field ${idx}`,
      magicType: field.magicType || pipeline.MAGIC_DATA_TYPE.ANY,
      segmenterConfig
    };
  }

  function runSingleLine() {
    const field = getActiveField();
    if (!field) return;
    const ctx = buildFieldContext(field);
    const rawText = field.rawInput || '';
    const result = pipeline.runOcrMagic(ctx, rawText, store);
    state.lastDebug = result.debug;
    field.lastDebug = result.debug;
    field.lastOutput = result.finalText || '';
    field.passHistory = [];
    field.pendingLargeRun = false;
    field.passCounter = 0;
    updateWarning('');
    state.trace = { passIndex: 0, lineIndex: 0 };
    renderPassResults();
    updateTraceSelector();
    updateOutputText();
    renderTraceForCurrentSelection();
    updateRunButtonLabel();
  }

  function runMultiLinePass() {
    const field = getActiveField();
    if (!field) return;
    const ctx = buildFieldContext(field);
    const sourceLines = (field.passHistory.length ? field.passHistory[field.passHistory.length - 1].linesOut : parseMultiline(field.rawInput || ''));
    if (!sourceLines.length) {
      field.passHistory = [];
      field.lastOutput = '';
      field.pendingLargeRun = false;
      field.passCounter = 0;
      updateWarning('');
      renderPassResults();
      updateTraceSelector();
      renderTraceForCurrentSelection();
      updateOutputText();
      updateRunButtonLabel();
      return;
    }

    if (sourceLines.length > 300 && !field.pendingLargeRun) {
      field.pendingLargeRun = true;
      updateWarning(`Warning: ${sourceLines.length} lines detected. Click run again to proceed in multi-line mode.`);
      return;
    }

    field.pendingLargeRun = false;
    updateWarning('');

    const passResult = runPass(sourceLines, ctx);
    field.passCounter += 1;
    passResult.passNumber = field.passCounter;
    field.passHistory.push(passResult);
    if (field.passHistory.length > 10) {
      field.passHistory = field.passHistory.slice(-10);
    }
    field.lastOutput = passResult.linesOut.join('\n');
    field.lastDebug = passResult.debugs?.[0] || null;
    state.trace = { passIndex: field.passHistory.length - 1, lineIndex: 0 };

    renderPassResults();
    updateTraceSelector();
    updateOutputText();
    renderTraceForCurrentSelection();
    updateRunButtonLabel();
  }

  function runSandbox() {
    const field = getActiveField();
    if (!field) return;
    if (field.multiLineEnabled) {
      runMultiLinePass();
    } else {
      runSingleLine();
    }
  }

  function resetLearning() {
    const field = getActiveField();
    if (!field) return;
    store.resetField({ wizardId: 'ocrmagic-dev-sandbox', fieldName: (field.name || '').trim() || 'Field' });
    field.passHistory = [];
    field.lastOutput = '';
    field.lastDebug = null;
    field.pendingLargeRun = false;
    field.passCounter = 0;
    state.lastDebug = null;
    state.trace = { passIndex: 0, lineIndex: 0 };
    updateWarning('');
    updateOutputText();
    renderPassResults();
    updateTraceSelector();
    renderTraceForCurrentSelection();
    updateRunButtonLabel();
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
    if (els.tracePassSelect) {
      els.tracePassSelect.addEventListener('change', (e) => {
        state.trace.passIndex = parseInt(e.target.value, 10) || 0;
        state.trace.lineIndex = 0;
        updateTraceSelector();
        renderTraceForCurrentSelection();
      });
    }
    if (els.traceLineSelect) {
      els.traceLineSelect.addEventListener('change', (e) => {
        state.trace.lineIndex = parseInt(e.target.value, 10) || 0;
        renderTraceForCurrentSelection();
      });
    }
  }

  bindEvents();
  renderFields();
})();
