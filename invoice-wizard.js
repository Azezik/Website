// ===== pdf.js & tesseract bindings (must appear before any getDocument call) =====
const pdfjsLibRef = window.pdfjsLib;
const TesseractRef = window.Tesseract;
const StaticFieldMode = window.StaticFieldMode || null;
const KeywordWeighting = window.KeywordWeighting || null;
const KeywordConstellation = window.KeywordConstellation || null;
const AreaScoping = window.AreaScoping || null;
const AreaFinder = window.AreaFinder || null;

const STATIC_DEBUG_STORAGE_KEY = 'wiz.staticDebug';
const LEGACY_PDF_SCALE = 1.5;
const BASE_PDF_SCALE = (window.devicePixelRatio || 1) * LEGACY_PDF_SCALE;
const PDF_CSS_SCALE = LEGACY_PDF_SCALE / BASE_PDF_SCALE;

function loadStoredStaticDebugPref(){
  try {
    const stored = localStorage.getItem(STATIC_DEBUG_STORAGE_KEY);
    if(stored === '1') return true;
    if(stored === '0') return false;
  } catch(err){ /* ignore storage failures */ }
  return null;
}
function persistStaticDebugPref(enabled){
  try { localStorage.setItem(STATIC_DEBUG_STORAGE_KEY, enabled ? '1' : '0'); }
  catch(err){ /* ignore storage failures */ }
}

const STATIC_DEBUG_FORCED = true;
const storedStaticDebug = loadStoredStaticDebugPref();
let DEBUG_STATIC_FIELDS = STATIC_DEBUG_FORCED ? true : Boolean(
  window.DEBUG_STATIC_FIELDS ??
  (storedStaticDebug !== null ? storedStaticDebug : true) ??
  /static-debug/i.test(location.search)
);
if(storedStaticDebug === null || STATIC_DEBUG_FORCED){
  persistStaticDebugPref(true);
}
window.DEBUG_STATIC_FIELDS = true;
let staticDebugLogs = [];

let DEBUG_OCRMAGIC = STATIC_DEBUG_FORCED ? true : Boolean(window.__DEBUG_OCRMAGIC__ ?? window.DEBUG_STATIC_FIELDS);
window.__DEBUG_OCRMAGIC__ = true;
const DEBUG_FLATTEN_COMPARE = Boolean(window.DEBUG_FLATTEN_COMPARE ?? /flatten-debug/i.test(location.search));
window.DEBUG_FLATTEN_COMPARE = DEBUG_FLATTEN_COMPARE;

const MAX_STATIC_CANDIDATES = 12;
const MIN_STATIC_ACCEPT_SCORE = 0.7;
const STATIC_LINE_DIFF_WEIGHTS = { 0: 1.0, 1: 0.75, 2: 0.35, default: 0.10 };
const STATIC_FP_SCORES = { ok: 1.3, fail: 0.5 };

function staticDebugEnabled(){ return true; }
function ocrMagicDebugEnabled(){ return true; }
function mirrorDebugLog(line, details=null, level='log'){
  const logger = console[level] ? console[level].bind(console) : console.log.bind(console);
  if(staticDebugEnabled()){
    staticDebugLogs.push(details !== null ? { line, details } : line);
  }
  logger(line, details);
}
function logStaticDebug(message, details){
  if(!staticDebugEnabled()) return;
  const line = `[static-debug] ${message}`;
  staticDebugLogs.push(details ? { line, details } : line);
  if(details !== undefined){ console.log(line, details); }
  else { console.log(line); }
}

function ocrMagicDebug(info){
  if(!window || !ocrMagicDebugEnabled()) return;
  const payload = info || {};
  const line = `[ocrmagic] ${payload.event || ''}`.trim();
  staticDebugLogs.push({ line, details: payload });
  console.log(line, payload);
}
(function sanityLog(){
  mirrorDebugLog(
    '[pdf.js] version: ' + (pdfjsLibRef?.version || '<unknown>') + ' workerSrc: ' + (pdfjsLibRef?.GlobalWorkerOptions?.workerSrc || '<unset>'),
    null,
    'log'
  );
})();

function formatBoxForLog(box){
  if(!box) return '<null>';
  const { x=0, y=0, w=0, h=0, page } = box;
  return `{x:${Math.round(x)},y:${Math.round(y)},w:${Math.round(w)},h:${Math.round(h)},page:${page||'?'}}`;
}
function formatArrayBox(boxArr){
  return Array.isArray(boxArr) ? `[${boxArr.map(v=>Math.round(v??0)).join(',')}]` : '<none>';
}

/* Invoice Wizard (vanilla JS, pdf.js + tesseract.js)
   - Works with invoice-wizard.html structure & styles.css theme
   - Renders PDFs/images, multi-page, overlay box drawing
   - Snap-to-line + landmarks + anchor offsets
   - Saves vendor profiles (normalized bbox + page), exports JSON
   - Simple local "DB" + live results table (union of keys)
   - Batch drag/drop (dashboard) and single-file (wizard) flows
   --------------------------------------------------------------------
   HTML it expects (all present in your page):
     #login-section, #dashboard, #wizard-section
     #pdfCanvas, #imgCanvas, #overlayCanvas
     #prevPageBtn, #nextPageBtn, #pageIndicator, #ocrToggle
     #boxModeBtn, #rawDataBtn, #clearSelectionBtn, #backBtn, #skipBtn, #confirmBtn
     #fieldsPreview, #savedJson, #exportBtn, #finishWizardBtn
    #wizard-file  (single-file open), #file-input + #dropzone (batch)
   Tesseract.js is already included by the page.
*/

/* ------------------------ Globals / State ------------------------- */
const els = {
  // auth / nav
  loginSection:    document.getElementById('login-section'),
  loginForm:       document.getElementById('login-form'),
  username:        document.getElementById('username'),
  email:           document.getElementById('email'),
  password:        document.getElementById('password'),
  signupBtn:       document.getElementById('signup-btn'),
  app:             document.getElementById('app'),
  tabs:            document.querySelectorAll('#dashTabs button'),
  docDashboard:    document.getElementById('document-dashboard'),
  wizardManager:   document.getElementById('wizard-manager'),
  preconfiguredWizards: document.getElementById('preconfigured-wizards'),
  preconfiguredWizardList: document.getElementById('preconfigured-wizard-list'),
  preconfiguredWizardEmpty: document.getElementById('preconfigured-wizard-empty'),
  wizardExportPanel: document.getElementById('wizard-export'),
  wizardDetailsPanel: document.getElementById('wizard-details'),
  wizardDetailsBackBtn: document.getElementById('wizard-details-back'),
  wizardDetailsActions: document.getElementById('wizard-details-actions'),
  wizardDetailsLog: document.getElementById('wizard-details-log'),
  wizardExportTitle: document.getElementById('wizard-export-title'),
  wizardExportDescription: document.getElementById('wizard-export-description'),
  wizardExportCounter: document.getElementById('wizard-export-counter'),
  wizardExportCancelBtn: document.getElementById('wizard-export-cancel'),
  wizardExportConfirmBtn: document.getElementById('wizard-export-confirm'),
  extractedData:   document.getElementById('extracted-data'),
  reports:         document.getElementById('reports'),
  wizardManagerList: document.getElementById('wizard-manager-list'),
  wizardManagerEmpty: document.getElementById('wizard-manager-empty'),
  wizardManagerNewBtn: document.getElementById('wizard-manager-new'),
  wizardManagerImportBtn: document.getElementById('wizard-manager-import'),
  wizardDefinitionImportInput: document.getElementById('wizard-definition-import'),
  docType:         document.getElementById('doc-type'),
  dataWizardSelect: document.getElementById('data-wizard-select'),
  dataDocType:     document.getElementById('data-doc-type'),
  showBoxesToggle: document.getElementById('show-boxes-toggle'),
  showRingToggles: document.querySelectorAll('.show-ring-toggle'),
  showMatchToggles: document.querySelectorAll('.show-match-toggle'),
  showOcrBoxesToggle: document.getElementById('show-ocr-boxes-toggle'),
  rawDataToggle:  document.getElementById('raw-data-toggle'),
  showRawToggle: document.getElementById('show-raw-toggle'),
  viewSnapshotBtn: document.getElementById('view-snapshot-btn'),
  exportMasterDbDataBtn: document.getElementById('export-master-db-data-btn'),
  snapshotStatus: document.getElementById('snapshotStatus'),
  snapshotPanel: document.getElementById('snapshotPanel'),
  closeSnapshotBtn: document.getElementById('closeSnapshotBtn'),
  regenerateSnapshotBtn: document.getElementById('regenerateSnapshotBtn'),
  snapshotMeta: document.getElementById('snapshotMeta'),
  snapshotList: document.getElementById('snapshotList'),
  snapshotAreaDebug: document.getElementById('snapshotAreaDebug'),
  snapshotDetail: document.getElementById('snapshotDetail'),
  ocrCropList:    document.getElementById('ocrCropList'),
  telemetryPanel: document.getElementById('telemetryPanel'),
  traceViewer:    document.getElementById('traceViewer'),
  traceHeader:    document.getElementById('traceHeader'),
  traceSummary:   document.getElementById('traceSummary'),
  traceWaterfall: document.getElementById('traceWaterfall'),
  traceDetail:    document.getElementById('traceDetail'),
  traceExportBtn: document.getElementById('traceExportBtn'),
  configureBtn:    document.getElementById('configure-btn'),
  configureCustomBtn: document.getElementById('configure-custom-btn'),
  newWizardBtn:    document.getElementById('new-wizard-btn'),
  demoBtn:         document.getElementById('demo-btn'),
  staticDebugBtn:  document.getElementById('static-debug-btn'),
  staticDebugCopy: document.getElementById('copyStaticDebug'),
  snapshotModeToggle: document.getElementById('snapshot-mode-toggle'),
  uploadBtn:       document.getElementById('upload-btn'),
  resetModelBtn:   document.getElementById('reset-model-btn'),
  logoutBtn:       document.getElementById('logout-btn'),
  dropzone:        document.getElementById('dropzone'),
  fileInput:       document.getElementById('file-input'),
  staticDebugModal: document.getElementById('staticDebugModal'),
  staticDebugClose: document.getElementById('closeStaticDebug'),
  staticDebugText:  document.getElementById('staticDebugText'),
  staticDebugRefresh: document.getElementById('refreshStaticDebug'),
  staticDebugClear: document.getElementById('clearStaticDebug'),
  staticDebugToggle: document.getElementById('staticDebugToggle'),
  staticDebugDownload: document.getElementById('downloadStaticDebug'),

  // wizard
  wizardSection:   document.getElementById('wizard-section'),
  wizardFile:      document.getElementById('wizard-file'),
  wizardTitle:     document.querySelector('#wizard-section h2'),
  wizardSubhead:   document.querySelector('#wizard-section > p.sub'),
  viewer:          document.getElementById('viewer'),
  promptBar:       document.getElementById('promptBar'),

  pageControls:    document.getElementById('pageControls'),
  prevPageBtn:     document.getElementById('prevPageBtn'),
  nextPageBtn:     document.getElementById('nextPageBtn'),
  pageIndicator:   document.getElementById('pageIndicator'),
  ocrToggle:       document.getElementById('ocrToggle'),

  pdfCanvas:       document.getElementById('pdfCanvas'),
  imgCanvas:       document.getElementById('imgCanvas'),
  overlayCanvas:   document.getElementById('overlayCanvas'),
  overlayHud:      document.getElementById('overlayHud'),

  boxModeBtn:      document.getElementById('boxModeBtn'),
  rawDataBtn:      document.getElementById('rawDataBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  backBtn:         document.getElementById('backBtn'),
  skipBtn:         document.getElementById('skipBtn'),
  confirmBtn:      document.getElementById('confirmBtn'),

  stepLabel:       document.getElementById('stepLabel'),
  questionText:    document.getElementById('questionText'),

  fieldsPreview:   document.getElementById('fieldsPreview'),
  savedJson:       document.getElementById('savedJson'),
  exportMasterDbBtn: document.getElementById('exportMasterDbBtn'),
  exportMissingBtn: document.getElementById('exportMissingBtn'),
  exportBtn:       document.getElementById('exportBtn'),
  finishWizardBtn: document.getElementById('finishWizardBtn'),
  backupCloudBtn: document.getElementById('backup-cloud-btn'),
  restoreCloudBtn: document.getElementById('restore-cloud-btn'),

  // Custom wizard builder
  builderSection: document.getElementById('builder-section'),
  builderNameInput: document.getElementById('custom-wizard-name'),
  builderFieldsList: document.getElementById('custom-fields-list'),
  builderFieldCount: document.getElementById('custom-field-count'),
  builderAddFieldBtn: document.getElementById('add-custom-field'),
  builderSaveBtn: document.getElementById('save-custom-wizard'),
  builderCancelBtn: document.getElementById('cancel-custom-wizard'),
  builderNameError: document.getElementById('wizard-name-error'),
  builderFieldNameError: document.getElementById('field-name-error'),
  builderFieldLimitMsg: document.getElementById('field-limit-msg'),
};

(function ensureResultsMount() {
  if (!document.getElementById('resultsMount')) {
    const div = document.createElement('div');
    div.id = 'resultsMount';
    els.extractedData?.appendChild(div);
  }
})();

const defaultWizardTitle = els.wizardTitle?.textContent || 'Wizard Configuration';
const defaultWizardSubhead = els.wizardSubhead?.textContent || '';
const runWizardTitle = 'Wizard Run Mode';
const runWizardSubhead = 'Drop a document to extract using the saved wizard.';
const isSkinV2 = document.body.classList.contains('skin-v2');
const sessionBootstrap = (()=>{
  try {
    return window.SessionStore?.getActiveSession?.() || null;
  } catch(err){
    console.warn('[session] bootstrap read failed', err);
    return null;
  }
})();

const DEFAULT_WIZARD_ID = 'default';
const DEFAULT_GEOMETRY_ID = 'geom0';
const MAX_CUSTOM_FIELDS = 30;
const CUSTOM_WIZARD_KEY = 'wiz.customTemplates';
const EXTRACTED_WIZARD_SELECTION_KEY = 'wiz.extractedSelection';

const PROFILE_TYPE = { STATIC_PROFILE:'STATIC_PROFILE', CUSTOM_WIZARD:'CUSTOM_WIZARD' };
const magicTypeResolutionLog = new Set();

function normalizeWizardId(raw){
  if(raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if(!trimmed) return '';
  return trimmed.replace(/\s+/g, '_');
}

function readEnvWizardBootstrap(){
  if(typeof window === 'undefined') return null;
  const env = window.__ENV__ || {};
  const cfg = env.profileConfig || env.PROFILE_CONFIG || env.profile || env.PROFILE || {};
  const profileName = env.WIZARD_PROFILE_NAME || env.PROFILE_NAME || cfg.profileName || cfg.name || cfg.wizardName || '';
  const wizardId = normalizeWizardId(env.WIZARD_PROFILE_ID || env.PROFILE_ID || env.WIZARD_ID || cfg.wizardId || cfg.profileId || cfg.id || profileName);
  const profileType = (env.WIZARD_PROFILE_TYPE || env.PROFILE_TYPE || cfg.profileType || cfg.type || '').toUpperCase();
  const docType = env.DOC_TYPE || env.DOCUMENT_TYPE || env.docType || cfg.docType || '';
  const profileVersionRaw = env.PROFILE_VERSION ?? cfg.profileVersion ?? cfg.version;
  const profileVersion = Number.isFinite(Number(profileVersionRaw)) ? Number(profileVersionRaw) : null;
  const patternBundle = env.PATTERN_BUNDLE || env.patternBundle || cfg.patternBundle || null;
  const profile = cfg.profile || null;
  const username = env.WIZARD_USERNAME || env.PROFILE_USERNAME || env.username || null;
  if(profileName || wizardId || docType || patternBundle || profile){
    return { profileName, wizardId, profileType, docType, profileVersion, patternBundle, profile, username };
  }
  return null;
}

const envWizardBootstrap = readEnvWizardBootstrap();

const modeHelpers = (typeof WizardMode !== 'undefined') ? WizardMode : null;
const ModeEnum = modeHelpers?.WizardMode || { CONFIG:'CONFIG', RUN:'RUN' };
const modeController = modeHelpers?.createModeController ? modeHelpers.createModeController(console) : null;
const runDiagnostics = modeHelpers?.createRunDiagnostics ? modeHelpers.createRunDiagnostics() : null;
const runLoopGuard = modeHelpers?.createRunLoopGuard ? modeHelpers.createRunLoopGuard() : (()=>{
  const active = new Set();
  return {
    start(key){
      if(!key) return true;
      if(active.has(key)) return false;
      active.add(key);
      return true;
    },
    finish(key){ if(!key) return; active.delete(key); }
  };
})();

function isConfigMode(){ return state.mode === ModeEnum.CONFIG; }
function isRunMode(){ return state.mode === ModeEnum.RUN; }

function guardInteractive(label){
  const blocked = modeController?.guardInteractive ? modeController.guardInteractive(label) : false;
  if(blocked) return true;
  if(isRunMode()){
    mirrorDebugLog(`[run-mode] ${label} called during RUN mode; skipping.`, null, 'warn');
    return true;
  }
  return false;
}

const PAGE_ROLE = { FIRST:'first', LAST:'last', EXPLICIT:'explicit' };
const VERTICAL_ANCHOR = { TOP:'top', BOTTOM:'bottom' };
const HEADER_FIELD_KEYS = new Set([
  'store_name','department_division','invoice_number','invoice_date','salesperson_rep',
  'customer_name','customer_address'
]);
const FOOTER_FIELD_KEYS = new Set([
  'subtotal_amount','discounts_amount','tax_amount','invoice_total','deposit','balance',
  'payment_method','payment_status'
]);
const BOTTOM_ANCHOR_FIELD_KEYS = new Set([
  'subtotal_amount','discounts_amount','tax_amount','invoice_total','deposit','balance',
  'payment_method','payment_status'
]);

function showTab(id){
  const sections = [els.docDashboard, els.extractedData, els.reports];
  if(isSkinV2 && els.wizardManager){
    sections.push(els.wizardManager);
  }
  if(els.preconfiguredWizards){
    sections.push(els.preconfiguredWizards);
  }
  if(els.wizardExportPanel){
    sections.push(els.wizardExportPanel);
  }
  if(els.wizardDetailsPanel){
    sections.push(els.wizardDetailsPanel);
  }
  sections.forEach(sec => {
    if(sec) sec.style.display = sec.id === id ? 'block' : 'none';
  });
  els.tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.target === id));
  if(id === 'wizard-manager'){
    renderWizardManagerList(state.activeWizardId);
  } else if(id === 'preconfigured-wizards'){
    renderPreconfiguredWizardList();
    loadPreconfiguredWizards();
  } else if(id === 'extracted-data'){
    syncExtractedWizardSelector();
    renderResultsTable();
    renderReports();
  }
}

function showWizardDetailsTab(wizardId){
  state.activeWizardId = wizardId || '';
  showTab('wizard-details');
  renderWizardDetailsActions();
  renderWizardBatchLog(state.activeWizardId);
}
els.tabs.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.target)));
if(els.showOcrBoxesToggle){ els.showOcrBoxesToggle.checked = /debug/i.test(location.search); }

let state = {
  username: sessionBootstrap?.username || null,
  docType: sessionBootstrap?.docType || envWizardBootstrap?.docType || 'invoice',
  activeWizardId: isSkinV2 ? (envWizardBootstrap?.wizardId || sessionBootstrap?.wizardId || '') : DEFAULT_WIZARD_ID,
  activeGeometryId: DEFAULT_GEOMETRY_ID,
  wizardTemplates: [],
  preconfiguredWizards: [],
  preconfiguredStatus: 'idle',
  preconfiguredError: null,
  extractedWizardId: '',
  extractedWizardDocType: '',
  mode: ModeEnum.CONFIG,
  modes: { rawData: false },
  snapshotMode: false,
  snapshotDirty: false,
  profile: null,             // Vendor profile (landmarks + fields + tableHints)
  pdf: null,                 // pdf.js document
  isImage: false,
  pageNum: 1,
  numPages: 1,
  viewport: { w: 0, h: 0, scale: 1 },
  pageViewports: [],       // viewport per page
  pageOffsets: [],         // y-offset of each page within pdfCanvas
  tokensByPage: [],          // {page:number: Token[] in px}
  keywordIndexByPage: {},   // per-page keyword bbox cache
  areaMatchesByPage: {},    // per-page detected area occurrences
  areaOccurrencesById: {},  // area occurrences keyed by areaId
  areaExtractions: {},      // resolved subordinate values keyed by areaId
  selectionCss: null,        // current user-drawn selection (CSS units, page-relative)
  selectionPx: null,         // current user-drawn selection (px, page-relative)
  snappedCss: null,          // snapped line box (CSS units, page-relative)
  snappedPx: null,           // snapped line box (px, page-relative)
  snappedText: '',           // snapped line text
  areaSelections: {},        // cached AREABOX selections keyed by areaId
  pageTransform: { scale:1, rotation:0 }, // calibration transform per page
  telemetry: [],            // extraction telemetry
  grayCanvases: {},         // cached grayscale canvases by page
  matchPoints: [],          // ring/anchor match points
  steps: [],                 // wizard steps
  stepIdx: 0,
  currentFileName: '',
  currentFileId: '',        // unique id per opened file
  currentLineItems: [],
  savedFieldsRecord: null,
  lastOcrCropPx: null,
  cropAudits: [],
  cropHashes: {},        // per page hash map for duplicate detection
  pageSnapshots: {},     // tracks saved full-page debug PNGs
  pageRenderPromises: [],
  staticDebugLogs,
  pageRenderReady: [],
  currentTraceId: null,
  selectedRunId: '',
  lastSnapshotManifestId: '',
  snapshotPanels: { activePage: null },
  overlayPinned: false,
  overlayMetrics: null,
  pendingSelection: null,
  lastOcrCropCss: null,
  lineLayout: null,
  snappedLineMetrics: null,
  debugLineAnchors: [],
  builderFields: [],
  builderEditingId: null,
  currentAreaRows: [],
  wizardComplete: false,
};

let loginHydrated = false;

function normalizeStaticDebugLogs(logs = staticDebugLogs){
  return logs.map(entry => {
    if(typeof entry === 'string') return entry;
    if(entry && typeof entry === 'object'){
      if(entry.details !== undefined){
        try { return `${entry.line || ''} ${JSON.stringify(entry.details)}`.trim(); }
        catch(e){ return entry.line || ''; }
      }
      return entry.line || '';
    }
    return String(entry ?? '');
  });
}
window.getStaticDebugLogs = () => staticDebugLogs.slice();
window.clearStaticDebugLogs = () => {
  staticDebugLogs.length = 0;
  if(window.debugTraces?.reset){ window.debugTraces.reset(); }
  else if(window.debugTraces?.traces){ window.debugTraces.traces.length = 0; }
  return [];
};

function serializeTraceEvents(){
  const traces = window.debugTraces?.traces || [];
  if(!traces.length) return '(no trace events)';
  try{
    return JSON.stringify(traces, null, 2);
  }catch(err){
    return `Trace serialization failed: ${err?.message || err}`;
  }
}
function buildFullDebugDump(){
  const logs = window.getStaticDebugLogs ? window.getStaticDebugLogs() : [];
  const lines = normalizeStaticDebugLogs(logs);
  const traceBlock = serializeTraceEvents();
  return [
    '=== STATIC DEBUG LOGS ===',
    ...lines,
    '',
    '=== TRACE EVENTS (copy/paste JSON) ===',
    traceBlock
  ].join('\n');
}

function showStaticDebugModal(){
  if(!els.staticDebugModal) return;
  els.staticDebugModal.style.display = 'flex';
  els.staticDebugModal.classList.add('open');
  syncStaticDebugToggleUI();
  renderStaticDebugLogs();
}
function hideStaticDebugModal(){
  if(!els.staticDebugModal) return;
  els.staticDebugModal.classList.remove('open');
  els.staticDebugModal.style.display = 'none';
}
function renderStaticDebugLogs(){
  if(!els.staticDebugText) return;
  els.staticDebugText.value = buildFullDebugDump();
}
function downloadStaticDebugLogs(){
  try {
    const text = buildFullDebugDump() || '(no logs)';
    const blob = new Blob([text], { type:'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `static-debug-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  } catch(err){
    console.error('static debug download failed', err);
    alert('Failed to download static debug logs.');
  }
}
function syncStaticDebugToggleUI(){
  if(els.staticDebugToggle){
    els.staticDebugToggle.checked = !!window.DEBUG_STATIC_FIELDS;
  }
}

function runKeyForFile(file){
  if(modeHelpers?.runKeyForFile) return modeHelpers.runKeyForFile(file);
  if(!file) return '';
  return `${file.name||''}::${Number.isFinite(file.size)?file.size:0}::${Number.isFinite(file.lastModified)?file.lastModified:0}`;
}

function clearTransientStateLocal(){
  if(modeHelpers?.clearTransientState) return modeHelpers.clearTransientState(state);
  state.stepIdx = 0; state.steps = [];
  state.selectionCss = null; state.selectionPx = null;
  state.snappedCss = null; state.snappedPx = null; state.snappedText = '';
  state.wizardComplete = false;
  state.areaSelections = {};
  state.pendingSelection = null; state.matchPoints = [];
  state.snappedLineMetrics = null;
  state.overlayMetrics = null; state.overlayPinned = false;
  state.pdf = null; state.isImage = false;
  state.pageNum = 1; state.numPages = 0;
  state.viewport = { w:0, h:0, scale:1 };
  state.pageOffsets = []; state.pageViewports = [];
  state.pageRenderPromises = []; state.pageRenderReady = [];
  state.pageSnapshots = {}; state.grayCanvases = {};
  state.telemetry = []; state.currentTraceId = null;
  state.lastOcrCropPx = null; state.lastOcrCropCss = null;
  state.cropAudits = []; state.cropHashes = {};
  state.tokensByPage = []; state.currentLineItems = [];
  state.areaMatchesByPage = {}; state.areaOccurrencesById = {}; state.areaExtractions = {}; state.currentAreaRows = [];
  state.currentFileId = ''; state.currentFileName = '';
  state.lineLayout = null;
  state.lastSnapshotManifestId = '';
  state.snapshotPanels = { activePage: null };
  return state;
}

function clearConfigResultsUi({ preserveProfileJson = true } = {}){
  state.savedFieldsRecord = null;
  state.selectedRunId = '';
  if(els.fieldsPreview) els.fieldsPreview.innerHTML = '<p class="sub">No fields yet.</p>';
  if(preserveProfileJson && els.savedJson){
    els.savedJson.textContent = serializeProfile(state.profile);
  } else if(els.savedJson){
    els.savedJson.textContent = '';
  }
  const fDiv = document.getElementById('confirmedFields');
  if(fDiv) fDiv.innerHTML = '<p class="sub">No fields yet.</p>';
  const liDiv = document.getElementById('confirmedLineItems');
  if(liDiv) liDiv.innerHTML = '<p class="sub">No line items.</p>';
}

function resetWizardFileInput(){
  if(!els.wizardFile) return { beforeLength: 0, afterLength: 0 };
  const beforeLength = (els.wizardFile.value || '').length;
  try { els.wizardFile.value = ''; } catch(err){}
  let afterLength = (els.wizardFile.value || '').length;
  if(afterLength){
    const clone = els.wizardFile.cloneNode(true);
    els.wizardFile.parentNode?.replaceChild(clone, els.wizardFile);
    els.wizardFile = clone;
    els.wizardFile.addEventListener('change', handleWizardFileChange);
    afterLength = (els.wizardFile.value || '').length;
  }
  return { beforeLength, afterLength };
}

function resetConfigSessionState(reason = 'config-entry'){
  const preStepIdx = state.stepIdx;
  const preWizardComplete = state.wizardComplete;
  const fileInputLengths = resetWizardFileInput();
  clearTransientStateLocal();
  state.wizardComplete = false;
  resetDocArtifacts();
  if(els.imgCanvas){
    els.imgCanvas.src = '';
    els.imgCanvas.style.display = 'none';
  }
  if(els.pdfCanvas){
    const ctx = els.pdfCanvas.getContext('2d');
    if(ctx) ctx.clearRect(0, 0, els.pdfCanvas.width, els.pdfCanvas.height);
    els.pdfCanvas.style.display = 'block';
  }
  if(els.pageControls) els.pageControls.style.display = 'none';
  if(els.overlayHud) els.overlayHud.textContent = '';
  clearConfigResultsUi({ preserveProfileJson: true });
  console.info('[config-reset]', {
    reason,
    username: state.username,
    docType: state.docType,
    wizardId: currentWizardId(),
    activeWizardId: state.activeWizardId,
    activeGeometryId: state.activeGeometryId,
    stepIdxBefore: preStepIdx,
    stepIdxAfter: state.stepIdx,
    wizardCompleteBefore: preWizardComplete,
    wizardCompleteAfter: state.wizardComplete,
    fileInputLengthBefore: fileInputLengths.beforeLength,
    fileInputLengthAfter: fileInputLengths.afterLength
  });
}

function wipeAllWizardData(){
  try {
    localStorage.clear();
  } catch(err){
    console.warn('Failed to clear localStorage', err);
  }
  state.profile = null;
  state.activeWizardId = isSkinV2 ? '' : DEFAULT_WIZARD_ID;
  state.wizardTemplates = [];
  clearTransientStateLocal();
  resetDocArtifacts();
  cleanupDoc();
  hydrateFingerprintsFromProfile(null);
  refreshWizardTemplates();
  populateModelSelect();
  renderWizardManagerList();
  renderSavedFieldsTable();
  renderConfirmedTables();
  renderResultsTable();
  if(els.wizardSection) els.wizardSection.style.display = 'none';
  setWizardMode(ModeEnum.CONFIG);
  initStepsFromActiveWizard();
}

function resetDocArtifacts(){
  cleanupDoc();
  state.grayCanvases = {};
  state.telemetry = [];
  state.currentTraceId = null;
  state.lastOcrCropPx = null;
  state.lastOcrCropCss = null;
  state.cropAudits = [];
  state.cropHashes = {};
  state.pdf = null;
  state.isImage = false;
  state.viewport = { w:0, h:0, scale:1 };
  state.pageNum = 1;
  state.numPages = 0;
  state.lastSnapshotManifestId = '';
  state.snapshotPanels = { activePage: null };
  renderTelemetry();
}

function syncModeUi(){
  const isConfig = isConfigMode();
  if(els.promptBar){ els.promptBar.style.display = isConfig ? 'flex' : 'none'; }
  [els.backBtn, els.skipBtn, els.confirmBtn].forEach(btn=>{ if(btn) btn.style.display = isConfig ? '' : 'none'; });
  if(els.wizardTitle){ els.wizardTitle.textContent = isConfig ? defaultWizardTitle : runWizardTitle; }
  if(els.wizardSubhead){ els.wizardSubhead.textContent = isConfig ? defaultWizardSubhead : runWizardSubhead; }
}

function setWizardMode(nextMode){
  const normalized = nextMode === ModeEnum.RUN ? ModeEnum.RUN : ModeEnum.CONFIG;
  state.mode = normalized;
  modeController?.setMode?.(normalized);
  syncModeUi();
}

function activateRunMode(opts = {}){
  clearTransientStateLocal();
  setWizardMode(ModeEnum.RUN);
  try {
    const wizId = currentWizardId();
    const key = LS.profileKey(state.username, state.docType, wizId);
    console.info('[id-drift][activateRunMode]', JSON.stringify({
      isSkinV2,
      username: state.username,
      docType: state.docType,
      activeWizardId: state.activeWizardId,
      currentWizardId: wizId,
      profileKey: key
    }));
  } catch(err){ console.warn('[id-drift][activateRunMode] log failed', err); }
  if(opts.clearDoc !== false) resetDocArtifacts();
}

function activateConfigMode(){
  resetConfigSessionState('activate-config-mode');
  setWizardMode(ModeEnum.CONFIG);
  initStepsFromActiveWizard();
  if(state.steps && state.steps.length){
    goToStep(0);
  } else {
    setWizardCompletionMode(false);
  }
}

function notifyRunIssue(message){
  const msg = message || 'Run validation failed. Please try again.';
  const toast = (typeof window !== 'undefined') ? (window.showToast || window.toast || null) : null;
  if(typeof toast === 'function'){
    toast(msg);
    return;
  }
  if(typeof modeHelpers?.notify === 'function'){
    modeHelpers.notify(msg, { variant:'error', mode:'run' });
    return;
  }
  alert(msg);
}

window.__debugBlankAvoided = window.__debugBlankAvoided || 0;
function bumpDebugBlank(){
  window.__debugBlankAvoided = (window.__debugBlankAvoided || 0) + 1;
}

function firstCustomWizardId(){
  const template = (state.wizardTemplates || []).find(t => t?.id);
  return template?.id || '';
}

function resolveWizardId(opts = {}){
  const preferCustom = !!opts.preferCustom;
  const allowTemplateFallback = opts.allowTemplateFallback !== false;
  const candidates = [];
  const activeId = state.activeWizardId;
  const profileId = state.profile?.wizardId;
  if(preferCustom){
    if(activeId && activeId !== DEFAULT_WIZARD_ID) candidates.push(activeId);
    if(profileId && profileId !== DEFAULT_WIZARD_ID) candidates.push(profileId);
    if(allowTemplateFallback){
      const tplId = firstCustomWizardId();
      if(tplId) candidates.push(tplId);
    }
  } else {
    if(activeId) candidates.push(activeId);
    if(profileId) candidates.push(profileId);
  }
  const resolved = candidates.find(Boolean);
  if(resolved && resolved !== state.activeWizardId){
    state.activeWizardId = resolved;
  }
  return resolved || (preferCustom ? '' : DEFAULT_WIZARD_ID);
}

function requireCustomWizard(opts = {}){
  const wizardId = resolveWizardId({ preferCustom: true, allowTemplateFallback: opts.allowTemplateFallback });
  if(!wizardId && opts.promptBuilder){
    if(isSkinV2){
      alert('Please create a custom wizard in Wizard Manager.');
      showWizardManagerTab();
    } else {
      openBuilder();
    }
  }
  return wizardId;
}

function currentWizardId(){
  return resolveWizardId({ preferCustom: isSkinV2 });
}

function syncActiveWizardId(profile){
  const incoming = profile?.wizardId;
  if(!incoming) return;
  if(state.activeWizardId !== incoming){
    state.activeWizardId = incoming;
  }
}

function currentGeometryId(){
  return state.activeGeometryId || DEFAULT_GEOMETRY_ID;
}

function syncActiveGeometryId(profile){
  const incoming = profile?.geometryId;
  if(!incoming) return;
  if(state.activeGeometryId !== incoming){
    state.activeGeometryId = incoming;
  }
}

function getActiveProfileType(){
  const wizardId = currentWizardId();
  return wizardId && wizardId !== DEFAULT_WIZARD_ID ? PROFILE_TYPE.CUSTOM_WIZARD : PROFILE_TYPE.STATIC_PROFILE;
}

function genId(prefix='wiz'){
  if(typeof crypto !== 'undefined' && crypto.randomUUID){ return crypto.randomUUID(); }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function looksLikeGeneratedId(val=''){
  if(typeof val !== 'string') return false;
  return /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(val)
    || /^field-\d{13}-/i.test(val)
    || /^wiz-\d{13}-/i.test(val);
}

function normalizeFieldKey(name='', usedKeys=new Set(), fallbackPrefix='field'){
  const base = (name || '').toLowerCase()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallbackPrefix;
  let candidate = base;
  let suffix = 2;
  while(usedKeys.has(candidate)){
    candidate = `${base}_${suffix++}`;
  }
  usedKeys.add(candidate);
  return candidate;
}

function normalizeTemplateFields(fields){
  const used = new Set();
  const sanitizeKey = (name='', fallback='field') => (name || '').toLowerCase()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
  return (fields || []).map((field, idx) => {
    const name = (field?.name || '').trim();
    const fallback = `field_${idx + 1}`;
    const preferredKey = field?.fieldKey && !looksLikeGeneratedId(field.fieldKey) ? field.fieldKey : '';
    const sanitizedKey = sanitizeKey(preferredKey || name, fallback);
    const aliasedKey = FIELD_ALIASES[sanitizedKey] || sanitizedKey;
    const key = normalizeFieldKey(aliasedKey, used, aliasedKey || fallback);
    const rawType = (field?.fieldType || field?.type || 'static').toLowerCase();
    const normalizedType = rawType === 'dynamic' ? 'dynamic' : (rawType === 'areabox' ? 'areabox' : 'static');
    const magicDataType = normalizeMagicDataType(field?.magicDataType || field?.magicType);
    const isArea = normalizedType === 'areabox';
    const claimedSubordinate = field?.isSubordinate === true || !!field?.areaRelativeBox;
    const areaId = isArea
      ? (field.areaId || field.id || field.fieldKey || key)
      : (claimedSubordinate ? (field.areaId || null) : null);
    const isSubordinate = !isArea && (field?.isSubordinate === true || !!field?.areaRelativeBox);
    const allowGlobal = !isSubordinate && !isArea;
    const isGlobal = allowGlobal && !!field?.isGlobal;
    return {
      ...field,
      fieldType: normalizedType,
      areaId: areaId || undefined,
      isArea,
      isSubordinate,
      isGlobal,
      fieldKey: key,
      magicDataType,
      magicType: magicDataType
    };
  });
}

function deriveMasterDbSchema(fields){
  const sorted = (fields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return sorted
    .filter(f => (f.fieldType || f.type || 'static') === 'static')
    .map(f => {
      const normalizedType = (f.fieldType || f.type || 'static').toLowerCase();
      const isArea = !!f.isArea || normalizedType === 'areabox';
      const declaredSubordinate = f.isSubordinate === true || !!f.areaRelativeBox;
      const areaId = isArea ? (f.areaId || f.id || f.fieldId || f.fieldKey) : (declaredSubordinate ? (f.areaId || null) : null);
      const isSubordinate = !isArea && declaredSubordinate;
      return {
        fieldKey: f.fieldKey,
        label: f.label || f.name || f.fieldKey,
        isArea,
        isSubordinate,
        areaId: areaId || undefined,
        nonExtractable: !!f.nonExtractable || isArea,
        isGlobal: !!f.isGlobal
      };
    });
}

function deriveGlobalFields(fields){
  const sorted = (fields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return sorted
    .filter(f => (f.fieldType || f.type || 'static') === 'static')
    .filter(f => !f.isArea && !f.isSubordinate && !!f.isGlobal)
    .map(f => ({
      fieldKey: f.fieldKey,
      label: f.label || f.name || f.fieldKey,
      isGlobal: true
    }));
}

function normalizeMasterDbConfig(config, fields){
  const staticFields = deriveMasterDbSchema(fields);
  const derivedGlobalFields = deriveGlobalFields(fields);
  const includeLineItems = !!config?.includeLineItems;
  const isCustomMasterDb = isSkinV2 ? true : !!config?.isCustomMasterDb;
  const templateAreas = Array.isArray(config?.areas) ? config.areas : [];
  const normalizedTemplateAreas = templateAreas
    .map(a => ({
      ...a,
      id: a?.id || a?.areaId || a?.name || a?.key,
      name: a?.name || a?.label || a?.id || a?.areaId || a?.key
    }))
    .filter(a => a.id || a.name);
  const lineItemFields = Array.isArray(config?.lineItemFields)
    ? config.lineItemFields.map(f => ({ fieldKey: f.fieldKey, label: f.label || f.name || f.fieldKey }))
    : [];
  const globalFields = Array.isArray(config?.globalFields)
    ? config.globalFields.map(f => ({ fieldKey: f.fieldKey, label: f.label || f.name || f.fieldKey }))
    : derivedGlobalFields;
  const areaFieldKeysFromConfig = Array.isArray(config?.areaFieldKeys) ? config.areaFieldKeys : [];
  const areaFieldKeysFromFields = (fields || [])
    .filter(f => f && (f.isArea || f.isSubordinate))
    .map(f => f.fieldKey)
    .filter(Boolean);
  const areaFieldKeys = Array.from(new Set([...areaFieldKeysFromConfig, ...areaFieldKeysFromFields]));
  const documentFieldKeys = Array.isArray(config?.documentFieldKeys)
    ? config.documentFieldKeys.filter(Boolean)
    : staticFields.filter(f => !areaFieldKeys.includes(f.fieldKey)).map(f => f.fieldKey);
  const derivedAreas = Array.isArray(fields)
    ? fields.filter(f => f && (f.isArea || (f.fieldType || f.type) === 'areabox')).map(f => ({
      id: f.areaId || f.fieldKey,
      name: f.label || f.name || f.fieldKey
    }))
    : [];
  const areaMap = new Map();
  normalizedTemplateAreas.forEach(area => {
    const id = area.id || area.name;
    if(!id) return;
    areaMap.set(id, area);
  });
  derivedAreas.forEach(area => {
    if(!area?.id) return;
    if(!areaMap.has(area.id)){
      areaMap.set(area.id, { ...area, aliases: [] });
    }
  });
  const areas = Array.from(areaMap.values());
  return { isCustomMasterDb, staticFields, includeLineItems, lineItemFields, globalFields, areaFieldKeys, documentFieldKeys, areas };
}

function normalizeTemplate(template){
  if(!template) return template;
  const fields = normalizeTemplateFields(template.fields);
  const masterDbConfig = normalizeMasterDbConfig(template.masterDbConfig || template, fields);
  return { ...template, fields, masterDbConfig, isCustomMasterDb: !!masterDbConfig.isCustomMasterDb };
}

function buildMasterDbConfigFromProfile(profile, templateConfig, template){
  const profileFields = Array.isArray(profile?.fields) ? profile.fields : [];
  const templateFields = Array.isArray(template?.fields) ? template.fields : [];
  const templateByKey = new Map(templateFields.map(f => [f.fieldKey, f]));
  const templateById = new Map();
  templateFields.forEach(f => {
    const key = f.id || f.fieldId;
    if(key) templateById.set(key, f);
  });

  const normalizeField = (field, templateField) => {
    const source = templateField || field || {};
    const fieldKey = source.fieldKey || field?.fieldKey;
    const rawType = (field?.fieldType || field?.type || source.fieldType || source.type || 'static').toLowerCase();
    const normalizedType = rawType === 'dynamic' ? 'dynamic' : (rawType === 'areabox' ? 'areabox' : 'static');
    const declaredSubordinate = (field?.isSubordinate === true || source.isSubordinate === true || !!field?.areaRelativeBox || !!source.areaRelativeBox);
    const inferredAreaId = normalizedType === 'areabox'
      ? (source.areaId || field?.areaId || source.id || source.fieldId || fieldKey)
      : (declaredSubordinate ? (source.areaId || field?.areaId || null) : null);
    const isArea = !!(field?.isArea || source.isArea || normalizedType === 'areabox');
    const isSubordinate = !isArea && declaredSubordinate;
    const isGlobal = !isArea && !isSubordinate && !!(field?.isGlobal ?? source.isGlobal);
    const label = field?.label || field?.name || source.label || source.name || fieldKey;
    const nonExtractable = field?.nonExtractable ?? source.nonExtractable ?? isArea;
    return {
      ...source,
      ...field,
      fieldKey,
      fieldId: field?.fieldId || field?.id || source.id || source.fieldId,
      fieldType: normalizedType,
      type: normalizedType === 'dynamic' ? 'column' : 'static',
      areaId: inferredAreaId || undefined,
      isArea,
      isSubordinate,
      isGlobal,
      nonExtractable,
      label,
      name: field?.name || source.name || label
    };
  };

  const mergedMap = new Map();
  profileFields.forEach(f => {
    const tpl = templateByKey.get(f.fieldKey) || templateById.get(f.fieldId || f.id);
    const merged = normalizeField(f, tpl);
    if(merged?.fieldKey) mergedMap.set(merged.fieldKey, merged);
  });
  templateFields.forEach(tf => {
    if(mergedMap.has(tf.fieldKey)) return;
    const merged = normalizeField(tf, tf);
    if(merged?.fieldKey) mergedMap.set(merged.fieldKey, merged);
  });
  const mergedFields = Array.from(mergedMap.values());

  const includeLineItems = templateConfig?.includeLineItems
    ?? profile?.masterDbConfig?.includeLineItems
    ?? mergedFields.some(f => (f.type || f.fieldType) === 'column' || (f.fieldType || f.type) === 'dynamic');

  const templateLineItems = mergedFields
    .filter(f => (f.fieldType || f.type) === 'dynamic')
    .map(f => ({ fieldKey: f.fieldKey, label: f.label || f.name || f.fieldKey }));
  const lineItemFields = Array.isArray(templateConfig?.lineItemFields)
    ? templateConfig.lineItemFields
    : Array.isArray(profile?.masterDbConfig?.lineItemFields) && profile.masterDbConfig.lineItemFields.length
      ? profile.masterDbConfig.lineItemFields
      : templateLineItems;

  const isCustomMasterDb = isSkinV2 ? true : (templateConfig?.isCustomMasterDb ?? profile?.masterDbConfig?.isCustomMasterDb ?? false);
  const globalFields = Array.isArray(templateConfig?.globalFields) && templateConfig.globalFields.length
    ? templateConfig.globalFields
    : deriveGlobalFields(mergedFields);
  const areaFieldKeysFromTemplate = mergedFields.filter(f => f.isArea || f.isSubordinate).map(f => f.fieldKey).filter(Boolean);
  const areaFieldKeysFromConfig = Array.isArray(templateConfig?.areaFieldKeys) ? templateConfig.areaFieldKeys : [];
  const areaFieldKeys = Array.from(new Set([...areaFieldKeysFromConfig, ...areaFieldKeysFromTemplate]));
  const documentFieldKeys = Array.isArray(templateConfig?.documentFieldKeys)
    ? templateConfig.documentFieldKeys.filter(Boolean)
    : mergedFields
        .filter(f => (f.fieldType || f.type || 'static') === 'static' && !areaFieldKeys.includes(f.fieldKey))
        .map(f => f.fieldKey);
  const areasFromConfig = Array.isArray(templateConfig?.areas) ? templateConfig.areas : [];
  const areasFromTemplate = mergedFields
    .filter(f => f.isArea)
    .map(f => ({ id: f.areaId || f.fieldKey, name: f.label || f.name || f.fieldKey }));
  const areaMap = new Map();
  areasFromConfig.forEach(area => {
    const id = area?.id || area?.areaId || area?.name;
    if(!id) return;
    areaMap.set(id, area);
  });
  areasFromTemplate.forEach(area => {
    if(!area?.id || areaMap.has(area.id)) return;
    areaMap.set(area.id, area);
  });
  const areas = Array.from(areaMap.values());

  const configInput = {
    ...templateConfig,
    isCustomMasterDb,
    includeLineItems,
    lineItemFields,
    globalFields,
    areaFieldKeys,
    documentFieldKeys,
    areas
  };
  return normalizeMasterDbConfig(configInput, mergedFields);
}

function getStoredTemplates(){
  try{ return JSON.parse(localStorage.getItem(CUSTOM_WIZARD_KEY) || '[]'); }
  catch{ return []; }
}

function setStoredTemplates(arr){
  localStorage.setItem(CUSTOM_WIZARD_KEY, JSON.stringify(arr));
}

function loadTemplatesForUser(user, docType){
  if(!user) return [];
  const all = getStoredTemplates().map(normalizeTemplate);
  return all.filter(t => t.username === user && t.documentTypeId === docType);
}

function remapProfileFieldKeys(profile, mapping = {}, templateFields = []){
  if(!profile || !mapping || !Object.keys(mapping).length) return false;
  let changed = false;
  const templateByKey = Object.fromEntries((templateFields || []).map(f => [f.fieldKey, f]));
  const mapKey = key => {
    if(mapping[key]){ changed = true; return mapping[key]; }
    return key;
  };
  if(Array.isArray(profile.fields)){
    profile.fields.forEach(f => {
      const newKey = mapKey(f.fieldKey);
      if(newKey !== f.fieldKey) f.fieldKey = newKey;
      const tpl = templateByKey[newKey];
      if(tpl){
        const nextLabel = tpl.label || tpl.name || tpl.fieldKey;
        if(f.label !== nextLabel) f.label = nextLabel;
        if(!f.type) f.type = tpl.type || ((tpl.fieldType || tpl.type) === 'dynamic' ? 'column' : 'static');
      }
    });
  }
  if(profile.tableHints){
    const cols = profile.tableHints.columns || {};
    Object.values(cols).forEach(col => { if(col?.fieldKey) col.fieldKey = mapKey(col.fieldKey); });
    if(profile.tableHints.rowAnchor?.fieldKey){
      profile.tableHints.rowAnchor.fieldKey = mapKey(profile.tableHints.rowAnchor.fieldKey);
    }
  }
  return changed;
}

function persistTemplate(user, docType, template){
  const templates = getStoredTemplates();
  const idx = templates.findIndex(t => t.id === template.id);
  const normalized = normalizeTemplate({ ...template, username: user, documentTypeId: docType });
  const nextTemplates = templates.map(normalizeTemplate);
  if(idx >= 0) nextTemplates[idx] = normalized; else nextTemplates.push(normalized);
  setStoredTemplates(nextTemplates);
  return normalized;
}

function getWizardTemplateById(id){
  if(!id) return null;
  return (state.wizardTemplates || []).find(t => t.id === id) || null;
}

function injectEnvWizardTemplate(){
  if(!envWizardBootstrap) return;
  if(envWizardBootstrap.profileType && envWizardBootstrap.profileType !== PROFILE_TYPE.CUSTOM_WIZARD) return;
  if(envWizardBootstrap.docType && envWizardBootstrap.docType !== state.docType) return;
  const wizardId = envWizardBootstrap.wizardId || normalizeWizardId(envWizardBootstrap.profileName);
  if(!wizardId) return;
  const existing = (state.wizardTemplates || []).some(t => t.id === wizardId);
  if(existing) return;
  state.wizardTemplates = [
    {
      id: wizardId,
      wizardName: envWizardBootstrap.profileName || wizardId,
      documentTypeId: state.docType,
      version: envWizardBootstrap.profileVersion || PROFILE_VERSION,
      fields: []
    },
    ...(state.wizardTemplates || [])
  ];
}

function refreshWizardTemplates(){
  state.wizardTemplates = loadTemplatesForUser(state.username, state.docType);
  injectEnvWizardTemplate();
  syncExtractedWizardSelector();
  return state.wizardTemplates;
}

function getWizardDocType(wizardId){
  if(!wizardId) return '';
  const tpl = getWizardTemplateById(wizardId);
  return tpl?.documentTypeId || '';
}

function loadExtractedWizardSelection(){
  const user = state.username || '';
  if(!user) return null;
  try{
    const raw = localStorage.getItem(`${EXTRACTED_WIZARD_SELECTION_KEY}.${user}`);
    return raw ? JSON.parse(raw) : null;
  } catch(err){
    console.warn('[extracted-data] failed to load selection', err);
    return null;
  }
}

function persistExtractedWizardSelection(wizardId, docType){
  const user = state.username || '';
  if(!user) return;
  try{
    const payload = { wizardId: wizardId || '', docType: docType || state.docType || '' };
    localStorage.setItem(`${EXTRACTED_WIZARD_SELECTION_KEY}.${user}`, JSON.stringify(payload));
  } catch(err){
    console.warn('[extracted-data] failed to persist selection', err);
  }
}

function clearExtractedWizardSelectionForWizard(username, docType, wizardId){
  if(!username || !wizardId) return false;
  const stored = loadExtractedWizardSelection();
  const matchesStored = stored?.wizardId === wizardId && (!docType || stored?.docType === docType);
  const matchesState = state.extractedWizardId === wizardId && (!docType || state.extractedWizardDocType === docType);
  if(!matchesStored && !matchesState) return false;
  state.extractedWizardId = '';
  state.extractedWizardDocType = state.docType;
  persistExtractedWizardSelection('', state.docType);
  console.info('[wizard-delete] cleared extracted wizard selection', {
    username,
    docType,
    wizardId
  });
  return true;
}

function collectWizardOptionsForExtractedData(){
  const options = [];
  const seen = new Set();
  const keyFor = (wizardId, docType) => `${docType || ''}::${wizardId || '__blank__'}`;
  const storedTemplates = getStoredTemplates()
    .map(normalizeTemplate)
    .filter(t => t.username === state.username && (t.documentTypeId || state.docType) === state.docType);
  const templateByKey = new Map(storedTemplates.map(t => [keyFor(t.id, t.documentTypeId || state.docType), t]));
  const push = (wizardId, label, docType) => {
    const key = keyFor(wizardId, docType);
    if(seen.has(key)) return;
    options.push({ wizardId: wizardId || '', label, docType: docType || state.docType });
    seen.add(key);
  };
  push('', '(Last used)', state.docType);
  push(DEFAULT_WIZARD_ID, 'Default Wizard', state.docType);
  (state.wizardTemplates || []).forEach(t => push(t.id, t.wizardName || t.id, t.documentTypeId || state.docType));
  const activeId = state.activeWizardId || '';
  if(activeId){
    const activeDocType = getWizardDocType(activeId) || state.docType;
    if(!seen.has(keyFor(activeId, activeDocType))){
      push(activeId, 'Active Wizard', activeDocType);
    }
  }
  if(state.username){
    const contexts = collectWizardContextsForUser(state.username);
    contexts.forEach((wizardMap, docType) => {
      wizardMap.forEach((_geometryIds, wizardId) => {
        const tpl = templateByKey.get(keyFor(wizardId, docType));
        const label = tpl?.wizardName || tpl?.id || wizardId || 'Wizard';
        push(wizardId, label, docType);
      });
    });
  }
  return options;
}

function syncExtractedWizardSelector(desiredId = null){
  const sel = els.dataWizardSelect;
  if(!sel) return;
  const options = collectWizardOptionsForExtractedData();
  sel.innerHTML = options.map(opt => `<option value="${opt.wizardId}" data-doc-type="${opt.docType || state.docType}">${opt.label}</option>`).join('');
  const stored = loadExtractedWizardSelection();
  const desired = desiredId ?? stored?.wizardId ?? state.extractedWizardId ?? state.activeWizardId ?? '';
  const hasDesired = options.some(opt => opt.wizardId === desired);
  const fallback = hasDesired
    ? desired
    : (options.find(opt => opt.wizardId === state.activeWizardId)?.wizardId || options[0]?.wizardId || '');
  sel.value = fallback;
  const selected = sel.selectedOptions?.[0];
  state.extractedWizardId = sel.value || '';
  const resolvedDocType = selected?.dataset.docType || stored?.docType || getWizardDocType(state.extractedWizardId) || state.docType;
  state.extractedWizardDocType = resolvedDocType || state.docType;
  persistExtractedWizardSelection(state.extractedWizardId, state.extractedWizardDocType);
}

function resolveExtractedWizardContext(){
  syncExtractedWizardSelector();
  const sel = els.dataWizardSelect;
  const selectedValue = sel?.value || state.extractedWizardId || '';
  const stored = loadExtractedWizardSelection();
  const selectedDocType = sel?.selectedOptions?.[0]?.dataset.docType || state.extractedWizardDocType || stored?.docType || '';
  let wizardId = selectedValue;
  if(!wizardId){
    wizardId = state.activeWizardId || currentWizardId() || DEFAULT_WIZARD_ID;
  }
  let docType = selectedDocType || getWizardDocType(wizardId) || state.docType;
  if(!docType) docType = state.docType;
  state.extractedWizardId = wizardId;
  state.extractedWizardDocType = docType;
  persistExtractedWizardSelection(wizardId, docType);
  return { wizardId, docType };
}

/* ---------------------- Storage / Persistence --------------------- */
const LS = {
  profileKey: (u, d, wizardId = DEFAULT_WIZARD_ID, geometryId = null) => {
    const base = `wiz.profile.${u}.${d}${wizardId && wizardId !== DEFAULT_WIZARD_ID ? `.${wizardId}` : ''}`;
    return geometryId ? `${base}.${geometryId}` : base;
  },
  geometryMetaKey: (u, d, wizardId = DEFAULT_WIZARD_ID) => `wiz.geometries.${u}.${d}${wizardId && wizardId !== DEFAULT_WIZARD_ID ? `.${wizardId}` : ''}`,
  dbKey: (u, d, wizardId = DEFAULT_WIZARD_ID) => `accounts.${u}.wizards.${d}${wizardId && wizardId !== DEFAULT_WIZARD_ID ? `.${wizardId}` : ''}.masterdb`,
  rowsKey: (u, d, wizardId = DEFAULT_WIZARD_ID) => `accounts.${u}.wizards.${d}${wizardId && wizardId !== DEFAULT_WIZARD_ID ? `.${wizardId}` : ''}.masterdb_rows`,
  batchLogKey: (u, d, wizardId = DEFAULT_WIZARD_ID) => `accounts.${u}.wizards.${d}${wizardId && wizardId !== DEFAULT_WIZARD_ID ? `.${wizardId}` : ''}.batch_log`,
  getDb(u, d, wizardId = DEFAULT_WIZARD_ID) {
    const raw = localStorage.getItem(this.dbKey(u, d, wizardId));
    return raw ? JSON.parse(raw) : [];
    },
  setDb(u, d, arr, wizardId = DEFAULT_WIZARD_ID){ localStorage.setItem(this.dbKey(u, d, wizardId), JSON.stringify(arr)); },
  hasRows(u, d, wizardId = DEFAULT_WIZARD_ID){ return localStorage.getItem(this.rowsKey(u, d, wizardId)) !== null; },
  getRows(u, d, wizardId = DEFAULT_WIZARD_ID){
    const raw = localStorage.getItem(this.rowsKey(u, d, wizardId));
    return normalizeRowsPayload(raw ? JSON.parse(raw) : []);
  },
  setRows(u, d, rows, wizardId = DEFAULT_WIZARD_ID){
    const payload = normalizeRowsPayload(rows);
    localStorage.setItem(this.rowsKey(u, d, wizardId), JSON.stringify(payload));
  },
  getBatchLog(u, d, wizardId = DEFAULT_WIZARD_ID){
    const raw = localStorage.getItem(this.batchLogKey(u, d, wizardId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  },
  setBatchLog(u, d, entries, wizardId = DEFAULT_WIZARD_ID){
    localStorage.setItem(this.batchLogKey(u, d, wizardId), JSON.stringify(Array.isArray(entries) ? entries : []));
  },
  getProfile(u,d,wizardId = DEFAULT_WIZARD_ID, geometryId = null){
    const keys = [];
    const isDefaultGeom = !geometryId || geometryId === DEFAULT_GEOMETRY_ID;
    keys.push(this.profileKey(u,d,wizardId, geometryId || null));
    if(isDefaultGeom && geometryId){
      keys.push(this.profileKey(u,d,wizardId, null));
    }
    for(const key of keys){
      const raw = localStorage.getItem(key);
      if(raw){
        try { return JSON.parse(raw, jsonReviver); } catch(err){ continue; }
      }
    }
    return null;
  },
  setProfile(u,d,p,wizardId = DEFAULT_WIZARD_ID, geometryId = null){ localStorage.setItem(this.profileKey(u,d,wizardId, geometryId || null), serializeProfile(p)); },
  removeProfile(u,d,wizardId = DEFAULT_WIZARD_ID, geometryId = null){
    localStorage.removeItem(this.profileKey(u,d,wizardId, geometryId || null));
  },
  getGeometries(u,d,wizardId = DEFAULT_WIZARD_ID){
    try{
      const raw = localStorage.getItem(this.geometryMetaKey(u,d,wizardId));
      const parsed = raw ? JSON.parse(raw, jsonReviver) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch(err){ return []; }
  },
  setGeometries(u,d,list,wizardId = DEFAULT_WIZARD_ID){
    try{
      localStorage.setItem(this.geometryMetaKey(u,d,wizardId), JSON.stringify(Array.isArray(list) ? list : []));
    } catch(err){ console.warn('[geom-meta][persist-failed]', err); }
  }
};

function normalizeGeometryMeta(meta={}, idx=0){
  const geometryId = meta.geometryId || `${DEFAULT_GEOMETRY_ID}${idx ? `_${idx}` : ''}`;
  const displayName = meta.displayName || `Layout ${idx + 1}`;
  const createdAt = meta.createdAt || new Date().toISOString();
  const pageSize = meta.pageSize || null;
  return { geometryId, displayName, createdAt, pageSize };
}

function geometryPageSizeFromState(){
  const vp = (state.pageViewports && state.pageViewports[0]) || state.viewport || {};
  const width = vp.width || vp.w || 0;
  const height = vp.height || vp.h || 0;
  if(!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0){
    return null;
  }
  return { pageWidthPx: width, pageHeightPx: height, aspect: height ? width/height : null };
}

function getGeometryIndex(username, docType, wizardId, derivedIds = []){
  const stored = LS.getGeometries(username, docType, wizardId);
  const seen = new Map();
  const push = (entry, idx=0) => {
    if(!entry || !entry.geometryId) return;
    if(!seen.has(entry.geometryId)){
      seen.set(entry.geometryId, normalizeGeometryMeta(entry, idx));
    }
  };
  stored.forEach((meta, idx)=>push(meta, idx));
  derivedIds.forEach((gid, idx)=>{
    if(!gid) return;
    push({ geometryId: gid, displayName: `Layout ${seen.size + 1}` }, stored.length + idx);
  });
  if(!seen.size){
    push({ geometryId: DEFAULT_GEOMETRY_ID, displayName: 'Layout 1' }, 0);
  }
  return Array.from(seen.values());
}

function upsertGeometryMeta(username, docType, wizardId, meta){
  const index = getGeometryIndex(username, docType, wizardId);
  const existingIdx = index.findIndex(m => m.geometryId === meta.geometryId);
  if(existingIdx >= 0){
    index[existingIdx] = { ...index[existingIdx], ...meta };
  } else {
    index.push(normalizeGeometryMeta(meta, index.length));
  }
  LS.setGeometries(username, docType, index, wizardId);
  return index;
}

function collectGeometryIdsForWizard(username, docType, wizardId){
  const ids = new Set();
  (LS.getGeometries(username, docType, wizardId) || []).forEach(meta => {
    if(meta?.geometryId) ids.add(meta.geometryId);
  });
  const userPattern = escapeRegex(username);
  const docPattern = escapeRegex(docType);
  const wizardTarget = wizardId || DEFAULT_WIZARD_ID;
  const wizardPattern = escapeRegex(wizardTarget);
  for(let i=0;i<localStorage.length;i++){
    const key = localStorage.key(i);
    if(!key) continue;
    const profileMatch = key.match(new RegExp(`^wiz\\.profile\\.${userPattern}\\.${docPattern}(?:\\.([^\\.]+))?(?:\\.([^\\.]+))?$`));
    if(profileMatch){
      const wid = profileMatch[1] || DEFAULT_WIZARD_ID;
      const gid = profileMatch[2] || DEFAULT_GEOMETRY_ID;
      if(wid === wizardTarget){
        ids.add(gid);
      }
      continue;
    }
    const patternMatch = key.match(new RegExp(`^wiz\\.patternBundle\\.${docPattern}\\.(?:${wizardPattern})(?:\\.([^\\.]+))?$`));
    if(patternMatch){
      const gid = patternMatch[1] || DEFAULT_GEOMETRY_ID;
      ids.add(gid);
    }
  }
  if(!ids.size){
    ids.add(DEFAULT_GEOMETRY_ID);
  }
  return Array.from(ids);
}

function scrubSegmentStoreForWizard(wizardId, geometryId=null){
  if(!wizardId || typeof localStorage === 'undefined') return;
  const storeRaw = localStorage.getItem('ocrmagic.segmentStore');
  const chunkRaw = localStorage.getItem('ocrmagic.segmentStore.chunks');
  try{
    const store = storeRaw ? JSON.parse(storeRaw) : null;
    if(store && typeof store === 'object'){
      Object.keys(store).forEach(k => {
        if(geometryId){
          if(k.startsWith(`${wizardId}::${geometryId}`)) delete store[k];
        } else if(k.startsWith(`${wizardId}::`)){
          delete store[k];
        }
      });
      localStorage.setItem('ocrmagic.segmentStore', JSON.stringify(store));
    }
  } catch(err){ console.warn('[import] scrub segment store failed', err); }
  try{
    const chunkStore = chunkRaw ? JSON.parse(chunkRaw) : null;
    if(chunkStore && typeof chunkStore === 'object'){
      Object.keys(chunkStore).forEach(k => {
        if(geometryId){
          if(k.startsWith(`${wizardId}::${geometryId}`)) delete chunkStore[k];
        } else if(k.startsWith(`${wizardId}::`)){
          delete chunkStore[k];
        }
      });
      localStorage.setItem('ocrmagic.segmentStore.chunks', JSON.stringify(chunkStore));
    }
  } catch(err){ console.warn('[import] scrub segment chunk store failed', err); }
}

function clearWizardArtifacts(username, docType, wizardId){
  if(!wizardId) return;
  let geometryIds = [DEFAULT_GEOMETRY_ID];
  try { geometryIds = collectGeometryIdsForWizard(username, docType, wizardId); } catch(err){ geometryIds = [DEFAULT_GEOMETRY_ID]; }
  try { LS.removeProfile(username, docType, wizardId); } catch(err){}
  try { localStorage.removeItem(LS.dbKey(username, docType, wizardId)); } catch(err){}
  try { localStorage.removeItem(LS.rowsKey(username, docType, wizardId)); } catch(err){}
  try {
    geometryIds.forEach(gid => {
      const patternKey = patternStoreKey(docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid);
      localStorage.removeItem(patternKey);
    });
    const legacyPatternKey = patternStoreKey(docType, wizardId);
    localStorage.removeItem(legacyPatternKey);
  } catch(err){}
  geometryIds.forEach(gid => scrubSegmentStoreForWizard(wizardId, gid));
}

function removeWizardProfileVariants(username, docType, wizardId, geometryIds = []){
  const ids = new Set([...(geometryIds || []), DEFAULT_GEOMETRY_ID]);
  ids.forEach(gid => {
    const keyId = gid === DEFAULT_GEOMETRY_ID ? null : gid;
    try { LS.removeProfile(username, docType, wizardId, keyId); } catch(err){}
  });
  if(!wizardId) return;
  try {
    const prefix = `wiz.profile.${username}.${docType}.${wizardId}`;
    const keysToRemove = [];
    for(let i=0;i<localStorage.length;i++){
      const key = localStorage.key(i);
      if(key && key.startsWith(prefix)) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch(err){ console.warn('[wizard-delete] profile key scan failed', err); }
}

async function deleteWizardFromCloud(username, docType, wizardId){
  const api = window.firebaseApi;
  if(!api?.db || !api?.doc || !api?.getDoc || !api?.setDoc){
    console.info('[wizard-delete][cloud] firebase unavailable', { wizardId, docType });
    return false;
  }
  const { user, username: resolvedUsername } = await resolveAuthenticatedIdentity('wizard-delete', { usernameHint: username });
  if(!user || !resolvedUsername){
    console.info('[wizard-delete][cloud] no authenticated user', { wizardId, docType });
    return false;
  }
  const targetUsername = resolvedUsername || username;
  const ref = api.doc(api.db, 'Users', user.uid, 'Accounts', targetUsername, 'Backups', 'manual');
  try{
    const snap = await api.getDoc(ref);
    if(!snap.exists()){
      console.info('[wizard-delete][cloud] no backup document', { wizardId, docType, username: targetUsername });
      return false;
    }
    const data = snap.data() || {};
    const payload = data?.payload;
    if(!payload || typeof payload !== 'object'){
      console.info('[wizard-delete][cloud] no payload to update', { wizardId, docType, username: targetUsername });
      return false;
    }
    let changed = false;
    if(Array.isArray(payload.customTemplates)){
      const nextTemplates = payload.customTemplates.filter(t => !(t?.id === wizardId && (!docType || t?.documentTypeId === docType)));
      if(nextTemplates.length !== payload.customTemplates.length){
        payload.customTemplates = nextTemplates;
        changed = true;
      }
    }
    if(payload.wizards && payload.wizards[docType] && payload.wizards[docType][wizardId]){
      delete payload.wizards[docType][wizardId];
      if(!Object.keys(payload.wizards[docType]).length){
        delete payload.wizards[docType];
      }
      changed = true;
    }
    if(!changed){
      console.info('[wizard-delete][cloud] nothing to remove', { wizardId, docType, username: targetUsername });
      return false;
    }
    await api.setDoc(ref, { payload, updatedAt: new Date().toISOString() }, { merge: true });
    console.info('[wizard-delete][cloud] removed wizard data', { wizardId, docType, username: targetUsername });
    return true;
  } catch(err){
    console.warn('[wizard-delete][cloud] failed to update backup', err);
    return false;
  }
}

async function deleteWizardEverywhere(username, docType, wizardId){
  if(!wizardId) return;
  const geometryIds = collectGeometryIdsForWizard(username, docType, wizardId);
  console.info('[wizard-delete] start', { username, docType, wizardId, geometryIds });
  removeWizardProfileVariants(username, docType, wizardId, geometryIds);
  try { localStorage.removeItem(LS.geometryMetaKey(username, docType, wizardId)); } catch(err){}
  try { localStorage.removeItem(LS.dbKey(username, docType, wizardId)); } catch(err){}
  try { localStorage.removeItem(LS.rowsKey(username, docType, wizardId)); } catch(err){}
  try {
    geometryIds.forEach(gid => {
      const patternKey = patternStoreKey(docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid);
      localStorage.removeItem(patternKey);
    });
    localStorage.removeItem(patternStoreKey(docType, wizardId));
  } catch(err){ console.warn('[wizard-delete] pattern cleanup failed', err); }
  scrubSegmentStoreForWizard(wizardId);
  clearExtractedWizardSelectionForWizard(username, docType, wizardId);
  await deleteWizardFromCloud(username, docType, wizardId);
  console.info('[wizard-delete] complete', { username, docType, wizardId });
}

function countWords(text){
  return (String(text || '').trim().match(/\S+/g) || []).length;
}

function normalizeWizardDescription(text){
  return String(text || '').trim();
}

function buildExportMetadata({ title, description, existing } = {}){
  const nowIso = new Date().toISOString();
  const createdAt = existing?.createdAt || nowIso;
  const cleanedTitle = String(title || existing?.title || '').trim();
  const cleanedDescription = String(description ?? existing?.description ?? '').trim();
  return {
    title: cleanedTitle,
    description: cleanedDescription,
    createdAt,
    updatedAt: existing?.createdAt ? nowIso : undefined
  };
}

function exportWizardDefinition(docType, wizardId, exportMetadataOverride = null){
  const templates = getStoredTemplates();
  const template = templates.find(t => t.id === wizardId && t.documentTypeId === docType);
  if(!template){
    alert('Wizard definition not found.');
    return;
  }
  const exportMetadata = exportMetadataOverride
    ? buildExportMetadata({ ...exportMetadataOverride, existing: template.exportMetadata })
    : buildExportMetadata({ title: template.exportMetadata?.title || template.wizardName || template.id, description: template.exportMetadata?.description || '', existing: template.exportMetadata });
  const payload = {
    kind: 'wizard-definition',
    version: PROFILE_VERSION,
    wizardId: wizardId,
    docType,
    wizardName: template.wizardName || exportMetadata?.title || template.id,
    fields: template.fields || [],
    masterDbConfig: template.masterDbConfig || null,
    exportMetadata,
    source: { exportedAt: new Date().toISOString(), exportedBy: state.username || null }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wzrd.definition.${docType || 'invoice'}.${wizardId}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importWizardDefinition(defJson, options = {}){
  if(!defJson || typeof defJson !== 'object'){
    alert('Invalid wizard definition file.');
    return;
  }
  const fields = Array.isArray(defJson.fields) ? defJson.fields : [];
  if(!fields.length){
    alert('Wizard definition is missing fields.');
    return;
  }
  const exportMetadata = defJson.exportMetadata && typeof defJson.exportMetadata === 'object'
    ? buildExportMetadata({ title: defJson.exportMetadata?.title, description: defJson.exportMetadata?.description, existing: defJson.exportMetadata })
    : null;
  const name = (exportMetadata?.title || defJson.wizardName || defJson.name || '').trim() || 'Imported Wizard';
  const docType = defJson.docType || defJson.documentTypeId || state.docType || 'invoice';
  const newWizardId = genId('wiz');
  const template = normalizeTemplate({
    id: newWizardId,
    wizardName: name,
    fields,
    documentTypeId: docType,
    masterDbConfig: defJson.masterDbConfig || null,
    exportMetadata,
    sourceWizardId: defJson.wizardId || defJson.id || null,
    sourceImportMeta: defJson.source || null
  });
  persistTemplate(state.username, docType, template);
  clearWizardArtifacts(state.username, docType, newWizardId);
  state.docType = docType;
  state.activeWizardId = newWizardId;
  refreshWizardTemplates();
  populateModelSelect(`custom:${newWizardId}`);
  if(options.postImport === 'wizard-manager'){
    showWizardManagerTab(newWizardId);
  } else {
    openBuilder(template);
    alert('Wizard imported. Review and save to continue configuration.');
  }
  return newWizardId;
}

function cloneJsonSafe(obj){
  try {
    return JSON.parse(JSON.stringify(obj, jsonReplacer));
  } catch(err){
    return null;
  }
}

function escapeRegex(str){
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectWizardContextsForUser(username){
  const contexts = new Map(); // docType -> Map<wizardId, Set<geometryId>>
  const userPattern = escapeRegex(username);
  const addCtx = (docType, wizardId, geometryId = DEFAULT_GEOMETRY_ID) => {
    if(!docType || !wizardId) return;
    if(!contexts.has(docType)) contexts.set(docType, new Map());
    const wizMap = contexts.get(docType);
    if(!wizMap.has(wizardId)) wizMap.set(wizardId, new Set());
    wizMap.get(wizardId).add(geometryId || DEFAULT_GEOMETRY_ID);
  };
  for(let i=0;i<localStorage.length;i++){
    const key = localStorage.key(i);
    if(!key) continue;
    const profileMatch = key.match(new RegExp(`^wiz\\.profile\\.${userPattern}\\.([^\\.]+)(?:\\.([^\\.]+))?(?:\\.([^\\.]+))?$`));
    if(profileMatch){
      const docType = profileMatch[1];
      const wizardId = profileMatch[2] || DEFAULT_WIZARD_ID;
      const geometryId = profileMatch[3] || DEFAULT_GEOMETRY_ID;
      addCtx(docType, wizardId, geometryId);
      continue;
    }
    const geometryIndexMatch = key.match(new RegExp(`^wiz\\.geometries\\.${userPattern}\\.([^\\.]+)(?:\\.([^\\.]+))?$`));
    if(geometryIndexMatch){
      const docType = geometryIndexMatch[1];
      const wizardId = geometryIndexMatch[2] || DEFAULT_WIZARD_ID;
      const metas = LS.getGeometries(username, docType, wizardId);
      metas.forEach(meta => addCtx(docType, wizardId, meta?.geometryId || DEFAULT_GEOMETRY_ID));
      continue;
    }
    const accountMatch = key.match(new RegExp(`^accounts\\.${userPattern}\\.wizards\\.([^\\.]+)(?:\\.([^\\.]+))?\\.(?:masterdb|masterdb_rows)$`));
    if(accountMatch){
      const docType = accountMatch[1];
      const wizardId = accountMatch[2] || DEFAULT_WIZARD_ID;
      addCtx(docType, wizardId);
      continue;
    }
    const patternMatch = key.match(/^wiz\.patternBundle\.([^.]+)\.([^.]+)(?:\.([^.]+))?$/);
    if(patternMatch){
      const docType = patternMatch[1];
      const wizardId = patternMatch[2] || DEFAULT_WIZARD_ID;
      const geometryId = patternMatch[3] || DEFAULT_GEOMETRY_ID;
      addCtx(docType, wizardId, geometryId);
    }
  }
  return contexts;
}

function buildBackupPayload(username){
  const nowIso = new Date().toISOString();
  const payload = {
    username,
    savedAt: nowIso,
    session: null,
    staticDebug: null,
    snapshotMode: null,
    customTemplates: [],
    models: [],
    ocrmagic: {},
    wizards: {}
  };
  try {
    const sessionRaw = localStorage.getItem('wiz.session');
    payload.session = sessionRaw ? JSON.parse(sessionRaw) : null;
  } catch(err){ payload.session = null; }
  try { payload.staticDebug = localStorage.getItem(STATIC_DEBUG_STORAGE_KEY); } catch(err){ payload.staticDebug = null; }
  try { payload.snapshotMode = localStorage.getItem(SNAPSHOT_MODE_KEY); } catch(err){ payload.snapshotMode = null; }

  try {
    const templates = getStoredTemplates();
    payload.customTemplates = Array.isArray(templates) ? templates.filter(t => t?.username === username) : [];
  } catch(err){ payload.customTemplates = []; }

  try {
    const models = getModels();
    payload.models = Array.isArray(models) ? models.filter(m => m?.username === username) : [];
  } catch(err){ payload.models = []; }

  try {
    payload.ocrmagic.segmentStore = localStorage.getItem('ocrmagic.segmentStore') || null;
    payload.ocrmagic.segmentStoreChunks = localStorage.getItem('ocrmagic.segmentStore.chunks') || null;
  } catch(err){ payload.ocrmagic = {}; }

  const contexts = collectWizardContextsForUser(username);
  contexts.forEach((wizardMap, docType) => {
    if(!payload.wizards[docType]) payload.wizards[docType] = {};
    wizardMap.forEach((geometryIds, wizardId) => {
      const wizardEntry = {};
      const profile = LS.getProfile(username, docType, wizardId);
      if(profile) wizardEntry.profile = cloneJsonSafe(profile) || profile;
      const db = LS.getDb(username, docType, wizardId);
      if(db && db.length) wizardEntry.masterDb = cloneJsonSafe(db) || db;
      const rows = LS.getRows(username, docType, wizardId);
      if(rows && rows.rows && rows.rows.length) wizardEntry.masterDbRows = cloneJsonSafe(rows) || rows;
      const patternKey = patternStoreKey(docType, wizardId);
      try{
        const patternRaw = localStorage.getItem(patternKey);
        if(patternRaw){
          wizardEntry.patternBundle = JSON.parse(patternRaw, jsonReviver);
        }
      } catch(err){ /* ignore pattern parse failures */ }
      const geometriesEntry = {};
      const geomMetaList = LS.getGeometries(username, docType, wizardId) || [];
      geometryIds.forEach(gid => {
        const geomEntry = {};
        const geomProfile = LS.getProfile(username, docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid);
        if(geomProfile) geomEntry.profile = cloneJsonSafe(geomProfile) || geomProfile;
        try{
          const geomPatternKey = patternStoreKey(docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid);
          const patternRaw = localStorage.getItem(geomPatternKey);
          if(patternRaw){
            geomEntry.patternBundle = JSON.parse(patternRaw, jsonReviver);
          }
        } catch(err){ /* ignore pattern parse failures */ }
        if(Object.keys(geomEntry).length){
          geomEntry.geometryId = gid;
          const meta = geomMetaList.find(m => m?.geometryId === gid);
          if(meta){
            geomEntry.displayName = meta.displayName;
            geomEntry.createdAt = meta.createdAt;
            geomEntry.pageSize = meta.pageSize || null;
          }
          geometriesEntry[gid] = geomEntry;
        }
      });
      if(Object.keys(geometriesEntry).length){
        wizardEntry.geometries = geometriesEntry;
      }
      payload.wizards[docType][wizardId] = wizardEntry;
    });
  });

  return payload;
}

function mergeAndSetTemplatesForUser(username, incoming = []){
  const existing = getStoredTemplates();
  const filtered = Array.isArray(existing) ? existing.filter(t => t?.username !== username) : [];
  const normalizedIncoming = Array.isArray(incoming) ? incoming.map(normalizeTemplate) : [];
  setStoredTemplates([...filtered, ...normalizedIncoming]);
}

function mergeAndSetModelsForUser(username, incoming = []){
  const existing = getModels();
  const filtered = Array.isArray(existing) ? existing.filter(m => m?.username !== username) : [];
  const normalizedIncoming = Array.isArray(incoming) ? incoming.map(m => ({ ...m, username })) : [];
  setModels([...filtered, ...normalizedIncoming]);
}

function applyRestorePayload(payload){
  if(!payload || typeof payload !== 'object') throw new Error('Invalid restore payload');
  const username = payload.username || state.username || sessionBootstrap?.username || 'demo';
  if(payload.session){
    try { localStorage.setItem('wiz.session', JSON.stringify(payload.session)); } catch(err){ console.warn('[restore] session persist failed', err); }
  }
  if(payload.staticDebug !== null && payload.staticDebug !== undefined){
    try { localStorage.setItem(STATIC_DEBUG_STORAGE_KEY, payload.staticDebug); } catch(err){ console.warn('[restore] staticDebug persist failed', err); }
  }
  if(payload.snapshotMode !== null && payload.snapshotMode !== undefined){
    try { localStorage.setItem(SNAPSHOT_MODE_KEY, payload.snapshotMode); } catch(err){ console.warn('[restore] snapshotMode persist failed', err); }
  }
  if(payload.customTemplates){
    mergeAndSetTemplatesForUser(username, payload.customTemplates);
  }
  if(payload.models){
    mergeAndSetModelsForUser(username, payload.models);
  }
  if(payload.ocrmagic){
    try {
      if(payload.ocrmagic.segmentStore !== undefined) localStorage.setItem('ocrmagic.segmentStore', payload.ocrmagic.segmentStore);
      if(payload.ocrmagic.segmentStoreChunks !== undefined) localStorage.setItem('ocrmagic.segmentStore.chunks', payload.ocrmagic.segmentStoreChunks);
    } catch(err){ console.warn('[restore] ocrmagic persist failed', err); }
  }
  const wizards = payload.wizards || {};
  Object.entries(wizards).forEach(([docType, byWizard]) => {
    Object.entries(byWizard || {}).forEach(([wizardId, data]) => {
      const geometryEntries = data?.geometries && typeof data.geometries === 'object' ? data.geometries : null;
      const legacyGeometryId = DEFAULT_GEOMETRY_ID;
      if(data?.profile) LS.setProfile(username, docType, data.profile, wizardId);
      if(data?.masterDb) LS.setDb(username, docType, data.masterDb, wizardId);
      if(data?.masterDbRows) LS.setRows(username, docType, data.masterDbRows, wizardId);
      if(data?.patternBundle){
        try{
          const key = patternStoreKey(docType, wizardId);
          localStorage.setItem(key, JSON.stringify(data.patternBundle, jsonReplacer));
        } catch(err){ console.warn('[restore] pattern bundle persist failed', err); }
      }
      if(geometryEntries){
        Object.entries(geometryEntries).forEach(([geometryId, geomData]) => {
          const gid = geometryId || DEFAULT_GEOMETRY_ID;
          if(geomData?.profile) LS.setProfile(username, docType, geomData.profile, wizardId, gid);
          if(geomData?.patternBundle){
            try{
              const key = patternStoreKey(docType, wizardId, gid);
              localStorage.setItem(key, JSON.stringify(geomData.patternBundle, jsonReplacer));
            } catch(err){ console.warn('[restore] pattern bundle persist failed', err); }
          }
          upsertGeometryMeta(username, docType, wizardId, {
            geometryId: gid,
            displayName: geomData?.displayName || geomData?.geometryId || `Layout ${gid}`,
            createdAt: geomData?.createdAt || new Date().toISOString(),
            pageSize: geomData?.profile?.geometry?.pageSize || geomData?.pageSize || null
          });
        });
      } else {
        // Legacy payload: mirror into default geometry entry.
        upsertGeometryMeta(username, docType, wizardId, {
          geometryId: legacyGeometryId,
          displayName: 'Layout 1',
          createdAt: new Date().toISOString(),
          pageSize: data?.profile?.geometry?.pageSize || null
        });
        if(data?.profile){
          LS.setProfile(username, docType, data.profile, wizardId, legacyGeometryId);
        }
        if(data?.patternBundle){
          try{
            const key = patternStoreKey(docType, wizardId, legacyGeometryId);
            localStorage.setItem(key, JSON.stringify(data.patternBundle, jsonReplacer));
          } catch(err){ console.warn('[restore] pattern bundle persist failed', err); }
        }
      }
    });
  });
  refreshWizardTemplates();
  populateModelSelect();
  renderWizardManagerList();
  renderResultsTable();
}

function summarizeProfileGeometryForLog(profile){
  const fields = Array.isArray(profile?.fields) ? profile.fields : [];
  const missingNormBoxKeys = [];
  let withNormBox = 0;
  fields.forEach(f => {
    const hasNormBox = !!(f?.normBox || f?.bboxPct || (Array.isArray(f?.bbox) && f.bbox.length === 4 && f.bbox.every(v => typeof v === 'number')));
    if(hasNormBox) withNormBox += 1; else missingNormBoxKeys.push(f?.fieldKey || f?.fieldId || '<unknown>');
  });
  return { fieldCount: fields.length, withNormBox, missingNormBoxKeys };
}

function logProfileStorage(tag, opts = {}){
  try {
    const mode = opts.mode || (isRunMode() ? 'RUN' : 'CONFIG');
    const docType = opts.docType || state.docType || null;
    const wizardId = opts.wizardId || currentWizardId() || null;
    const geometryId = opts.geometryId || currentGeometryId() || null;
    const profileKey = opts.profileKey || (wizardId ? LS.profileKey(state.username, docType, wizardId, geometryId === DEFAULT_GEOMETRY_ID ? null : geometryId) : null);
    const stats = summarizeProfileGeometryForLog(opts.profile);
    const missingList = stats.missingNormBoxKeys.join(',');
    console.info(`[profile-${tag}] mode=${mode} docType=${docType} wizardId=${wizardId} geometryId=${geometryId} key=${profileKey} fields=${stats.fieldCount} withNormBox=${stats.withNormBox} missing=[${missingList}]`);
  } catch(err){ console.warn(`[profile-${tag}] log failed`, err); }
}

const MASTERDB_FILE_ID_HEADER = 'File ID';
function extractFileIdFromRow(row){
  const fileIdx = MasterDB?.HEADERS ? MasterDB.HEADERS.indexOf(MASTERDB_FILE_ID_HEADER) : -1;
  if(row && typeof row === 'object' && row.fileId) return row.fileId;
  const cells = Array.isArray(row) ? row : (row && Array.isArray(row.cells) ? row.cells : null);
  if(!cells || fileIdx < 0) return '';
  return cells[fileIdx] || '';
}

function buildMasterDbRowsFromRecord(record){
  try {
    const { header, rows } = MasterDB.flatten(record);
    return {
      header: Array.isArray(header) ? header : null,
      rows: rows.map(r => ({ fileId: record.fileId || record.fileHash || '', cells: r }))
    };
  } catch(err){
    console.error('Failed to build MasterDB rows from record', record?.fileId || record?.fileHash, err);
    return { header: null, rows: [] };
  }
}

function rebuildMasterDbRows(db){
  const aggregate = { header: null, rows: [] };
  (db || []).forEach(rec => {
    const built = buildMasterDbRowsFromRecord(rec);
    if(!aggregate.header && built.header) aggregate.header = built.header;
    aggregate.rows.push(...built.rows);
  });
  return aggregate;
}

function refreshMasterDbRowsStore(db, compiled){
  const dt = state.docType;
  const user = state.username;
  const wizardId = currentWizardId();
  const hadRows = LS.hasRows(user, dt, wizardId);
  let payload = hadRows ? (LS.getRows(user, dt, wizardId) || { header: null, rows: [] }) : { header: null, rows: [] };
  let rows = payload.rows || [];
  let header = payload.header;
  if(!hadRows && Array.isArray(db)){
    const rebuilt = rebuildMasterDbRows(db);
    rows = rebuilt.rows;
    header = header || rebuilt.header;
  }
  const builtRows = compiled ? buildMasterDbRowsFromRecord(compiled) : { header: null, rows: [] };
  const targetFile = compiled?.fileId;
  if(targetFile && builtRows.rows.length){
    rows = rows.filter(r => extractFileIdFromRow(r) !== targetFile);
  }
  if(compiled){
    rows = rows.concat(builtRows.rows);
    if(!header && builtRows.header) header = builtRows.header;
  }
  const normalizedHeader = header || MasterDB.HEADERS;
  const nextPayload = { header: normalizedHeader, rows };
  LS.setRows(user, dt, nextPayload, wizardId);
  return nextPayload;
}

function getOrHydrateMasterRows(user, docType, wizardId = null){
  const resolvedWizardId = wizardId || currentWizardId();
  let payload = LS.getRows(user, docType, resolvedWizardId) || { header: null, rows: [] };
  if((payload.rows || []).length) return payload;
  const db = LS.getDb(user, docType, resolvedWizardId);
  if(!db.length) return payload;
  payload = rebuildMasterDbRows(db);
  if(!payload.header) payload.header = MasterDB.HEADERS;
  LS.setRows(user, docType, payload, resolvedWizardId);
  return payload;
}

window.dumpMaster = function(){
  const { docType: dt, wizardId } = resolveExtractedWizardContext();
  const payload = getOrHydrateMasterRows(state.username, dt, wizardId);
  console.log('[MasterDB rows]', payload);
  return payload;
};

/* ---------- Profile versioning & persistence helpers ---------- */
const PROFILE_VERSION = 8;
const PATTERN_BUNDLE_VERSION = 3;
const PATTERN_STORE_KEY_PREFIX = 'wiz.patternBundle';
const migrations = {
  1: p => { (p.fields||[]).forEach(f=>{ if(!f.type) f.type = 'static'; }); },
  2: p => {
    (p.fields||[]).forEach(f=>{
      const lm = f.landmark;
      if(lm){
        if(lm.ringMask && !(lm.ringMask instanceof Uint8Array)) lm.ringMask = Uint8Array.from(Array.isArray(lm.ringMask)?lm.ringMask:Object.values(lm.ringMask));
        if(lm.edgePatch && !(lm.edgePatch instanceof Uint8Array)) lm.edgePatch = Uint8Array.from(Array.isArray(lm.edgePatch)?lm.edgePatch:Object.values(lm.edgePatch));
      }
    });
  },
  3: p => {
    (p.fields||[]).forEach(f=>{
      if(f.normBox){
        let chk = validateSelection(f.normBox);
        if(!chk.ok){
          let nb = null;
          if(f.bboxPct){
            const tmp = { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 };
            const v = validateSelection(tmp);
            if(v.ok) nb = v.normBox;
          }
          if(!nb && f.rawBox){
            const v = validateSelection(f.rawBox);
            if(v.ok) nb = v.normBox;
          }
          if(nb){
            f.normBox = nb;
            delete f.boxError;
            if(!f.bboxPct){
              f.bboxPct = { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
            }
          } else {
            f.boxError = chk.reason;
          }
        }
        return;
      }
      const rb = f.rawBox;
      if(!rb) return;
      const chk = validateSelection(rb);
      if(chk.ok){
        f.normBox = chk.normBox;
        if(!f.bboxPct){
          const nb = chk.normBox;
          f.bboxPct = { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
        }
      } else {
        f.boxError = 'invalid_box_input';
      }
    });
  },
  4: p => {
    const fields = p.fields || [];
    const ensureAnchorFromBox = bbox => {
      if(!bbox) return null;
      const x0 = Number.isFinite(bbox.x0) ? bbox.x0 : (Array.isArray(bbox) ? bbox[0] : null);
      const y0 = Number.isFinite(bbox.y0) ? bbox.y0 : (Array.isArray(bbox) ? bbox[1] : null);
      const x1 = Number.isFinite(bbox.x1) ? bbox.x1 : (Array.isArray(bbox) ? bbox[2] : null);
      const y1 = Number.isFinite(bbox.y1) ? bbox.y1 : (Array.isArray(bbox) ? bbox[3] : null);
      if(![x0,y0,x1,y1].every(v => Number.isFinite(v))) return null;
      const box = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      const fallback = box.h ? box.h/2 : 0;
      return anchorMetricsFromBox(box, 1, 1, [], fallback);
    };
    fields.forEach(f => {
      if(!f.anchorMetrics){
        const source = f.bboxPct || (Array.isArray(f.bbox) ? { x0:f.bbox[0], y0:f.bbox[1], x1:f.bbox[2], y1:f.bbox[3] } : (f.normBox ? { x0:f.normBox.x0n, y0:f.normBox.y0n, x1:f.normBox.x0n + f.normBox.wN, y1:f.normBox.y0n + f.normBox.hN } : null));
        const metrics = ensureAnchorFromBox(source);
        if(metrics) f.anchorMetrics = metrics;
      }
      if(f.type === 'column'){
        f.column = f.column || {};
        if(f.column.anchorSample && !f.column.anchorSampleMetrics){
          const sample = f.column.anchorSample;
          const cy = Number.isFinite(sample.cyNorm) ? sample.cyNorm : 0;
          const hNorm = Number.isFinite(sample.hNorm) ? Math.max(0, sample.hNorm) : 0;
          const y = Math.max(0, cy - hNorm/2);
          const x0 = Number.isFinite(sample.x0Norm) ? Math.max(0, sample.x0Norm) : 0;
          const x1 = Number.isFinite(sample.x1Norm) ? Math.max(x0, sample.x1Norm) : x0;
          const box = { x: x0, y, w: Math.max(0, x1 - x0), h: hNorm };
          const metrics = anchorMetricsFromBox(box, 1, 1, [hNorm], hNorm);
          if(metrics) f.column.anchorSampleMetrics = metrics;
        }
      }
    });
    if(p.tableHints){
      const cols = p.tableHints.columns || {};
      Object.values(cols).forEach(col => {
        if(col && !col.anchorSampleMetrics){
          const field = fields.find(f => f.fieldKey === col.fieldKey);
          if(field?.column?.anchorSampleMetrics){
            col.anchorSampleMetrics = field.column.anchorSampleMetrics;
          }
        }
      });
      if(p.tableHints.rowAnchor && !p.tableHints.rowAnchor.metrics){
        const field = fields.find(f => f.fieldKey === p.tableHints.rowAnchor.fieldKey);
        if(field?.column?.anchorSampleMetrics){
          p.tableHints.rowAnchor.metrics = field.column.anchorSampleMetrics;
        }
      }
    }
  },
  5: p => {
    const fields = p.fields || [];
    fields.forEach(f => {
      if(f.type !== 'static') return;
      const anchor = inferVerticalAnchor(f);
      f.verticalAnchor = anchor;
      const role = inferPageRole(f, f.page || 1);
      if(!f.pageRole) f.pageRole = role;
      if(!Number.isFinite(f.pageIndex)){
        const rawPage = Number.isFinite(f.page) ? (f.page - 1) : 0;
        f.pageIndex = rawPage;
      }
      if(!f.staticGeom){
        const nb = normBoxFromField(f);
        const geom = buildStaticGeometry(nb, anchor);
        if(geom) f.staticGeom = geom;
      } else if(!f.staticGeom.anchor){
        f.staticGeom.anchor = anchor;
      }
    });
  },
  6: p => {
    const fields = p.fields || [];
    fields.forEach(f => {
      if(f.type !== 'static') return;
      const mask = Array.isArray(f.configMask) ? f.configMask.slice(0,4) : null;
      const normalized = mask && mask.length === 4 ? mask.map(v => Number(v) || 0) : [1,1,1,1];
      // Always trust the user-drawn box for static fields unless explicitly removed.
      normalized[0] = 1; normalized[1] = 1;
      const allZero = normalized.every(v => v === 0);
      f.configMask = allZero ? [1,1,1,1] : normalized;
    });
  },
  7: p => {
    p.masterDbConfig = buildMasterDbConfigFromProfile(p, p.masterDbConfig || null);
  }
};

function migrateProfile(p){
  if(!p) return p;
  if(!p.wizardId) p.wizardId = DEFAULT_WIZARD_ID;
  let v = p.version || 1;
  while(v < PROFILE_VERSION){
    const m = migrations[v];
    if(m) m(p);
    v++; p.version = v;
  }
  return p;
}

function rleEncode(u8){
  const out=[]; let curr=0, len=0;
  for(let i=0;i<u8.length;i++){
    const v=u8[i];
    if(v===curr) len++; else { out.push(len); curr=v; len=1; }
  }
  out.push(len);
  return out;
}
function rleDecode(data,len){
  const out=new Uint8Array(len); let curr=0, idx=0;
  for(const run of data){ out.fill(curr, idx, idx+run); idx+=run; curr = curr?0:1; }
  return out;
}

function sortObj(o){
  if(Array.isArray(o)) return o.map(sortObj);
  if(o && typeof o === 'object' && !(o instanceof Uint8Array)){
    const out={}; Object.keys(o).sort().forEach(k=>{ out[k]=sortObj(o[k]); }); return out;
  }
  return o;
}

function jsonReplacer(key, value){
  if(value instanceof Uint8Array){
    const size = this.patchSize || Math.sqrt(value.length);
    return {type:'rle', data:rleEncode(value), width:size, height:size};
  }
  return value;
}
function b64ToU8(str){ const bin = atob(str); const u8 = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }
function jsonReviver(key, value){
  if(value){
    if(value.type === 'rle' && Array.isArray(value.data)){
      return rleDecode(value.data, (value.width||0)*(value.height||0));
    }
    if(value.type === 'b64' && typeof value.data === 'string'){
      return b64ToU8(value.data);
    }
  }
  return value;
}

function serializeProfile(p){
  return JSON.stringify(sortObj(migrateProfile(structuredClone(p))), jsonReplacer, 2);
}

function patternStoreKey(docType, wizardId = DEFAULT_WIZARD_ID, geometryId = null){
  const safeDoc = String(docType || 'invoice').replace(/\s+/g, '_');
  const safeWizard = wizardId || DEFAULT_WIZARD_ID;
  const base = `${PATTERN_STORE_KEY_PREFIX}.${safeDoc}.${safeWizard}`;
  return geometryId ? `${base}.${geometryId}` : base;
}

function importPatternBundle(bundle, meta = {}){
  if(!bundle || typeof bundle !== 'object') return 0;
  const { patterns, version, profileVersion, fields } = bundle;
  const source = meta.source || bundle.source || 'bundle';
  const uri = meta.uri || bundle.uri || null;
  const bundleVersion = Number.isFinite(version) ? version : PATTERN_BUNDLE_VERSION;
  const fieldCount = Array.isArray(fields) ? fields.length : null;
  const patternCount = patterns && typeof patterns === 'object' ? Object.keys(patterns).length : 0;
  if(patternCount && patterns && typeof patterns === 'object'){
    FieldDataEngine.importPatterns(patterns, { source, uri, version: bundleVersion ?? profileVersion ?? PATTERN_BUNDLE_VERSION });
    ocrMagicDebug({
      event: 'ocrmagic.patterns.load',
      source,
      uri,
      version: bundleVersion,
      profileVersion,
      fieldCount,
      count: patternCount
    });
    return patternCount;
  }
  return 0;
}

function readPatternBundleFromCache(docType, wizardId, geometryId = null){
  try{
    const key = patternStoreKey(docType, wizardId, geometryId || null);
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    const parsed = JSON.parse(raw, jsonReviver);
    if(!parsed || typeof parsed !== 'object') return null;
    const parsedVersion = Number.isFinite(parsed.version) ? parsed.version : PATTERN_BUNDLE_VERSION;
    if(parsedVersion !== PATTERN_BUNDLE_VERSION){
      ocrMagicDebug({ event: 'ocrmagic.patterns.cache.stale', key, foundVersion: parsed.version, expected: PATTERN_BUNDLE_VERSION });
      return null;
    }
    return { key, bundle: { ...parsed, version: parsedVersion } };
  } catch(err){
    console.warn('Failed to read pattern bundle cache', err);
    return null;
  }
}

function persistPatternBundle(profile, { patterns=null } = {}){
  if(!profile || !isSkinV2 || !window?.localStorage) return null;
  try{
    const docType = profile.docType || state.docType || 'invoice';
    const wizardId = profile.wizardId || currentWizardId();
    const geometryId = profile.geometryId || state.activeGeometryId || null;
    try {
      const key = patternStoreKey(docType, wizardId, geometryId || null);
      const exported = patterns || FieldDataEngine.exportPatterns();
      const patternCount = exported && typeof exported === 'object' ? Object.keys(exported).length : 0;
      console.info('[id-drift][persistPatternBundle]', JSON.stringify({
        docType,
        wizardId,
        geometryId,
        patternKey: key,
        patternCount
      }));
    } catch(err){ console.warn('[id-drift][persistPatternBundle] log failed', err); }
    const exported = patterns || FieldDataEngine.exportPatterns();
    // Merge any persisted fingerprints from the profile to avoid count mismatches
    // (e.g., pattern bundle says fieldCount=2 but only 1 pattern key gets written).
    const merged = { ...collectPersistedFingerprints(profile), ...clonePlain(exported) };
    // Ensure every fieldKey has an entry, even if empty, so count aligns with fields.
    (profile.fields || []).forEach(f => {
      if(f?.fieldKey && merged[f.fieldKey] === undefined){
        merged[f.fieldKey] = merged[f.fieldKey] || {};
      }
    });
    const bundle = {
      version: PATTERN_BUNDLE_VERSION,
      profileVersion: profile.version || PROFILE_VERSION,
      docType,
      wizardId,
      geometryId: geometryId || null,
      fields: (profile.fields || []).map(f => ({ fieldKey: f.fieldKey, type: f.type, label: f.label })),
      updatedAt: new Date().toISOString(),
      patterns: merged
    };
    const key = patternStoreKey(docType, wizardId, geometryId || null);
    localStorage.setItem(key, JSON.stringify(bundle));
    const patternCount = Object.keys(bundle.patterns || {}).length;
    ocrMagicDebug({ event: 'ocrmagic.patterns.cache.write', key, count: patternCount, fieldCount: bundle.fields.length, version: bundle.version, patterns: Object.keys(bundle.patterns || {}) });
    return { key, bundle };
  } catch(err){
    console.warn('Failed to persist pattern bundle', err);
    return null;
  }
}

function applyEnvProfileConfig(cfg){
  if(!cfg) return;
  const wizardId = cfg.wizardId || normalizeWizardId(cfg.profileName);
  if(cfg.docType){
    state.docType = cfg.docType;
  }
  if(wizardId && !state.activeWizardId){
    state.activeWizardId = wizardId;
  }
  if(cfg.profile && !state.profile){
    const hydrated = migrateProfile(clonePlain(cfg.profile));
    if(wizardId && !hydrated.wizardId) hydrated.wizardId = wizardId;
    if(cfg.docType && !hydrated.docType) hydrated.docType = cfg.docType;
    state.profile = hydrated;
  }
  if(cfg.patternBundle){
    const normalized = {
      ...cfg.patternBundle,
      version: Number.isFinite(cfg.patternBundle?.version) ? cfg.patternBundle.version : PATTERN_BUNDLE_VERSION,
      profileVersion: cfg.patternBundle?.profileVersion ?? cfg.profileVersion ?? cfg.profile?.version ?? null,
      wizardId: wizardId || cfg.patternBundle?.wizardId,
      docType: cfg.docType || cfg.patternBundle?.docType || state.docType || 'invoice'
    };
    const importedCount = importPatternBundle(normalized, { source: 'env', uri: 'env.patternBundle' });
    if(importedCount > 0 && state.profile){
      persistPatternBundle(state.profile, { patterns: normalized.patterns });
    }
  }
}

function resolvePatternBundleUri(docType){
  const env = (typeof window !== 'undefined' && window.__ENV__) ? window.__ENV__ : {};
  const direct = (typeof window !== 'undefined' ? (window.PATTERN_BUNDLE_URL || window.PATTERN_STORE_URI || window.PATTERN_STORE_URL) : null) || env.PATTERN_BUNDLE_URL || env.PATTERN_STORE_URI || env.PATTERN_STORE_URL;
  if(typeof direct === 'string' && direct.trim()){
    return direct.replace('{docType}', docType || 'invoice');
  }
  return null;
}

function refreshPatternBundleFromRemote(profile){
  if(!isSkinV2 || typeof fetch !== 'function') return;
  const docType = profile?.docType || state.docType || 'invoice';
  const wizardId = profile?.wizardId || currentWizardId();
  const uri = resolvePatternBundleUri(docType);
  ocrMagicDebug({ event: 'ocrmagic.patterns.resolve', uri, docType, wizardId });
  if(!uri) return;
  fetch(uri, { cache: 'no-cache' })
    .then(res => {
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(bundle => {
      const importedCount = importPatternBundle(bundle, { source:'remote', uri });
      if(importedCount > 0 && profile){
        persistPatternBundle(profile, { patterns: bundle.patterns });
      }
    })
    .catch(err => {
      ocrMagicDebug({ event: 'ocrmagic.patterns.load_failed', uri, reason: err?.message || String(err) });
      console.warn('Pattern bundle fetch failed', err);
    });
}

function normalizeRowsPayload(payload){
  if(!payload) return { header: null, rows: [] };
  if(Array.isArray(payload)) return { header: null, rows: payload };
  if(typeof payload === 'object'){
    const header = Array.isArray(payload.header) ? payload.header : null;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return { header, rows };
  }
  return { header: null, rows: [] };
}

let saveTimer=null;
function saveProfile(u, d, p, wizardId = currentWizardId(), geometryId = currentGeometryId()){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    const resolvedGeometryId = geometryId || DEFAULT_GEOMETRY_ID;
    const key = LS.profileKey(u, d, wizardId, resolvedGeometryId === DEFAULT_GEOMETRY_ID ? null : resolvedGeometryId);
    const pageSize = geometryPageSizeFromState();
    const geometryMeta = {
      geometryId: resolvedGeometryId,
      displayName: p?.geometry?.displayName || `Layout ${getGeometryIndex(u, d, wizardId).length + 1}`,
      createdAt: p?.geometry?.createdAt || new Date().toISOString(),
      pageSize: pageSize || p?.geometry?.pageSize || null
    };
    p.geometryId = resolvedGeometryId;
    p.geometry = { ...(p.geometry || {}), ...geometryMeta };
    logProfileStorage('save', {
      mode: isRunMode() ? 'RUN' : 'CONFIG',
      docType: d,
      wizardId,
        geometryId: resolvedGeometryId,
        profileKey: key,
        profile: p
      });
    const preSaveSnapshot = snapshotProfileGeometry(p);
    traceSnapshot('config.pre-save',{
      stage:'config.pre-save',
      mode:'config',
      username:u,
      docType:d,
      wizardId,
      profileKey:key,
      profile:p,
      snapshot: preSaveSnapshot,
      note:'before-persist'
    });
    try{
      upsertGeometryMeta(u, d, wizardId, geometryMeta);
      LS.setProfile(u, d, p, wizardId, resolvedGeometryId === DEFAULT_GEOMETRY_ID ? null : resolvedGeometryId);
    } catch(err){
      console.error('saveProfile', err);
      alert('Failed to save profile');
      return;
    }
    try {
      const hasGeom = Array.isArray(p?.fields) && p.fields.some(hasFieldGeometry);
      console.info('[id-drift][saveProfile]', JSON.stringify({
        isSkinV2,
        username: u,
        docType: d,
        wizardId,
        geometryId: resolvedGeometryId,
        profileKey: key,
        hasGeometry: hasGeom
      }));
    } catch(err){ console.warn('[id-drift][saveProfile] log failed', err); }
    try{
      traceEvent(
        { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: 0, fieldKey: 'profile' },
        'save.persisted',
        {
          stageLabel:'Profile saved',
          stepNumber:0,
          notes:'Persisted profile to local storage',
          inputsSnapshot:{ docType:d, wizardId },
          output:{ docType:d }
        }
      );
    }catch{}
    try{
      const persistedProfile = loadProfile(u, d, wizardId, resolvedGeometryId);
      const postSaveSnapshot = snapshotProfileGeometry(persistedProfile);
      traceSnapshot('config.post-save',{
        stage:'config.post-save',
        mode:'config',
        username:u,
        docType:d,
        wizardId,
        profileKey:key,
        profile: persistedProfile,
        snapshot: postSaveSnapshot,
        previousSnapshot: preSaveSnapshot,
        note:'read-after-save'
      });
    }catch(err){
      console.warn('[flight-recorder][config.post-save] snapshot failed', err);
    }
  },300);
}
function loadProfile(u, d, wizardId = currentWizardId(), geometryId = currentGeometryId()){
  try{
    const resolvedGeometryId = geometryId || DEFAULT_GEOMETRY_ID;
    const raw = LS.getProfile(u, d, wizardId, resolvedGeometryId === DEFAULT_GEOMETRY_ID ? null : resolvedGeometryId);
    const migrated = ensureConfiguredFlag(migrateProfile(raw));
    if(migrated && !migrated.geometryId){
      migrated.geometryId = resolvedGeometryId;
    }
    logProfileStorage('load', {
      mode: isRunMode() ? 'RUN' : 'CONFIG',
      docType: d,
      wizardId,
      geometryId: resolvedGeometryId,
      profileKey: LS.profileKey(u, d, wizardId, resolvedGeometryId === DEFAULT_GEOMETRY_ID ? null : resolvedGeometryId),
      profile: migrated
    });
    return migrated;
  }catch(e){ console.error('loadProfile', e); return null; }
}

// Raw and compiled stores
const rawStore = new FieldMap(); // {fileId: [{fieldKey,value,page,bbox,ts}]}
const fileMeta = {};       // {fileId: {fileName}}
const SNAPSHOT_BYTE_LIMIT = 2_500_000;
const SNAPSHOT_PIXEL_CAP = 14_000_000;
const SNAPSHOT_MAX_PAGES = 16;
const SNAPSHOT_THUMB_MAX_W = 260;
const snapshotStore = (typeof SnapshotStore === 'function')
  ? new SnapshotStore({ maxBytes: SNAPSHOT_BYTE_LIMIT, maxPages: SNAPSHOT_MAX_PAGES })
  : { get(){ return null; }, set(){}, reset(){}, upsertPage(){ return null; } };

const MODELS_KEY = 'wiz.models';
function getModels(){ try{ return JSON.parse(localStorage.getItem(MODELS_KEY) || '[]', jsonReviver); } catch{ return []; } }
function setModels(m){ localStorage.setItem(MODELS_KEY, JSON.stringify(m, jsonReplacer)); }

function saveCurrentProfileAsModel(){
  if(isSkinV2){
    // In skinV2 we rely on custom wizard templates instead of model snapshots.
    return;
  }
  ensureProfile();
  const id = `${state.username}:${state.docType}:${Date.now()}`;
  const wizardId = currentWizardId();
  const models = getModels();
  models.push({ id, username: state.username, docType: state.docType, wizardId, profile: state.profile });
  setModels(models);
  populateModelSelect();
  alert('Wizard model saved.');
}

function populateModelSelect(forceValue){
  const sel = document.getElementById('model-select');
  if(!sel) return;
  const models = isSkinV2 ? [] : getModels().filter(m => m.username === state.username && m.docType === state.docType);
  const current = forceValue || sel.value;
  const options = [];
  if(isSkinV2){
    options.push({ value: '', label: '— Select a custom wizard —' });
  } else {
    options.push({ value: DEFAULT_WIZARD_ID, label: 'Default Wizard' });
  }
  options.push(...(state.wizardTemplates || []).map(t => ({ value: `custom:${t.id}`, label: t.wizardName })));
  options.push(...models.map(m => ({ value: `model:${m.id}`, label: new Date(parseInt(m.id.split(':').pop(),10)).toLocaleString() })));

  sel.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  const activeCustom = state.activeWizardId && state.activeWizardId !== DEFAULT_WIZARD_ID ? `custom:${state.activeWizardId}` : '';
  const desired = current || (isSkinV2 ? activeCustom : (state.activeWizardId ? activeCustom || state.activeWizardId : DEFAULT_WIZARD_ID));
  const hasDesired = options.some(o => o.value === desired);
  sel.value = hasDesired ? desired : (isSkinV2 ? activeCustom || '' : DEFAULT_WIZARD_ID);
}

function loadModelById(id){
  const m = getModels().find(x => x.id === id);
  if(!m) return null;
  const wizardId = m.wizardId || (isSkinV2 ? state.activeWizardId || firstCustomWizardId() : DEFAULT_WIZARD_ID);
  state.activeWizardId = wizardId;
  state.profile = migrateProfile(m.profile);
  hydrateFingerprintsFromProfile(state.profile);
  return m;
}
function peekModelById(id){
  return getModels().find(x => x.id === id) || null;
}

function resolveSelectedWizardContext(){
  const sel = document.getElementById('model-select');
  const value = sel?.value || '';
  const label = sel?.selectedOptions?.[0]?.textContent?.trim() || '';
  const base = { value, label, wizardId: '', source: '', modelId: '', model: null, displayName: label || '' };
  if(value === DEFAULT_WIZARD_ID){
    return { ...base, wizardId: DEFAULT_WIZARD_ID, source: 'default', displayName: label || 'Default Wizard' };
  }
  if(value.startsWith('custom:')){
    const wizardId = value.replace('custom:','').trim();
    const tpl = getWizardTemplateById(wizardId);
    return { ...base, wizardId, source: 'custom', displayName: label || tpl?.wizardName || wizardId };
  }
  if(value.startsWith('model:')){
    const modelId = value.replace('model:','');
    const model = peekModelById(modelId);
    const wizardId = model?.wizardId || '';
    return { ...base, wizardId, source: 'model', modelId, model, displayName: label || model?.wizardName || wizardId };
  }
  if(!value && state.activeWizardId){
    const tpl = getWizardTemplateById(state.activeWizardId);
    return { ...base, wizardId: state.activeWizardId, source: 'activeWizard', displayName: label || tpl?.wizardName || state.activeWizardId };
  }
  return base;
}

function logWizardSelection(event, ctx){
  try {
    console.info('[wizard-select]', JSON.stringify({
      event,
      wizardId: ctx?.wizardId || null,
      displayName: ctx?.displayName || ctx?.label || null,
      source: ctx?.source || null,
      value: ctx?.value || null,
      modelId: ctx?.modelId || null,
      activeWizardId: state.activeWizardId,
      profileWizardId: state.profile?.wizardId || null
    }));
  } catch(err){ console.warn('[wizard-select] log failed', err); }
}

function resolveRunWizardContext(opts = {}){
  const selection = resolveSelectedWizardContext();
  const incomingProfile = opts.profileOverride ? migrateProfile(clonePlain(opts.profileOverride)) : null;
  const modelProfile = selection.model ? migrateProfile(clonePlain(selection.model.profile)) : null;
  let wizardId = selection.wizardId || incomingProfile?.wizardId || modelProfile?.wizardId || state.activeWizardId || currentWizardId();
  // If the selection is empty but we have a profile with geometry, prefer that profile's wizardId to avoid running the wrong wizard.
  if(!wizardId && incomingProfile?.wizardId){
    wizardId = incomingProfile.wizardId;
  }
  const displayName = selection.displayName || selection.label || (wizardId === DEFAULT_WIZARD_ID ? 'Default Wizard' : wizardId);
  const ctx = {
    wizardId,
    displayName,
    selectionValue: selection.value,
    selectionSource: selection.source || '',
    modelId: selection.modelId || '',
    profile: modelProfile || incomingProfile || state.profile
  };
  if(!wizardId){
    const payload = {
      ...ctx,
      selectionValue: selection.value,
      selectionLabel: selection.label,
      activeWizardId: state.activeWizardId,
      profileWizardId: state.profile?.wizardId || null
    };
    console.error('[wizard-select][error]', payload);
    throw new Error('No wizard selected or resolvable. Please choose a wizard before running extraction.');
  }
  if(ctx.profile && !ctx.profile.wizardId){
    ctx.profile.wizardId = wizardId;
  }
  return ctx;
}

/* ------------------------- Utilities ------------------------------ */
const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));

function inferVerticalAnchor(field){
  const anchor = field?.verticalAnchor || field?.staticGeom?.anchor;
  if(anchor === VERTICAL_ANCHOR.TOP || anchor === VERTICAL_ANCHOR.BOTTOM) return anchor;
  const key = field?.fieldKey || '';
  return BOTTOM_ANCHOR_FIELD_KEYS.has(key) ? VERTICAL_ANCHOR.BOTTOM : VERTICAL_ANCHOR.TOP;
}

function inferPageRole(field, page=1){
  if(field?.pageRole === PAGE_ROLE.FIRST || field?.pageRole === PAGE_ROLE.LAST || field?.pageRole === PAGE_ROLE.EXPLICIT){
    return field.pageRole;
  }
  const key = field?.fieldKey || '';
  if(FOOTER_FIELD_KEYS.has(key)) return PAGE_ROLE.LAST;
  if(HEADER_FIELD_KEYS.has(key)) return PAGE_ROLE.FIRST;
  return page === 1 ? PAGE_ROLE.FIRST : PAGE_ROLE.EXPLICIT;
}

function normBoxFromField(field){
  const nbRaw = field?.normBox || field?.nb || (field?.bboxPct ? { x0n:field.bboxPct.x0, y0n:field.bboxPct.y0, wN:field.bboxPct.x1 - field.bboxPct.x0, hN:field.bboxPct.y1 - field.bboxPct.y0 } : null) || (field?.bbox ? { x0n:field.bbox.x0, y0n:field.bbox.y0, wN:field.bbox.x1 - field.bbox.x0, hN:field.bbox.y1 - field.bbox.y0 } : null);
  if(!nbRaw) return null;
  if(!validateNormBox(nbRaw).ok) return null;
  return { x0n: nbRaw.x0n, y0n: nbRaw.y0n, wN: nbRaw.wN, hN: nbRaw.hN };
}

function normalizeConfigMask(field){
  if(!field) return [1,1,1,1];
  const mask = Array.isArray(field.configMask) ? field.configMask.slice(0,4) : null;
  const normalized = mask && mask.length === 4 ? mask.map(v => Number(v) || 0) : [1,1,1,1];
  normalized[0] = 1; // always trust x
  normalized[1] = 1; // always trust y
  if(normalized.every(v => v === 0)) return [1,1,1,1];
  return normalized;
}

function buildStaticGeometry(normBox, anchor){
  if(!normBox) return null;
  const geom = {
    x0n: clamp(normBox.x0n ?? 0, 0, 1),
    wN: clamp(normBox.wN ?? 0, 0, 1),
    hN: clamp(normBox.hN ?? 0, 0, 1),
    anchor: anchor || VERTICAL_ANCHOR.TOP,
    yNorm: 0
  };
  if(geom.wN <= 0 || geom.hN <= 0) return null;
  if(geom.anchor === VERTICAL_ANCHOR.BOTTOM){
    geom.yNorm = clamp(1 - (normBox.y0n + geom.hN), 0, 1);
  } else {
    geom.yNorm = clamp(normBox.y0n ?? 0, 0, 1);
  }
  return geom;
}

function geometryToNormBox(geom){
  if(!geom) return null;
  const x0n = geom.x0n ?? 0;
  const wN = geom.wN ?? 0;
  const hN = geom.hN ?? 0;
  if(wN <= 0 || hN <= 0) return null;
  const y0n = geom.anchor === VERTICAL_ANCHOR.BOTTOM
    ? clamp(1 - (geom.yNorm ?? 0) - hN, 0, 1 - hN)
    : clamp(geom.yNorm ?? 0, 0, 1 - hN);
  return { x0n, y0n, wN, hN };
}

function resolveStaticPlacement(field, viewports=[], totalPages){
  if(!field || field.type !== 'static') return { pageNumber: field?.page || 1, pageRole: inferPageRole(field, field?.page || 1), anchor: inferVerticalAnchor(field), normBox: normBoxFromField(field) };
  const pages = Math.max(1, Number.isFinite(totalPages) ? totalPages : (viewports?.length || 1));
  const role = inferPageRole(field, field.page || 1);
  const anchor = inferVerticalAnchor(field);
  const configMask = normalizeConfigMask(field);
  const pageIdx = role === PAGE_ROLE.LAST
    ? pages - 1
    : (role === PAGE_ROLE.FIRST ? 0 : clamp(Number.isFinite(field.pageIndex) ? field.pageIndex : ((field.page||1) - 1), 0, pages - 1));
  const pageNumber = pageIdx + 1;
  const geom = field.staticGeom || buildStaticGeometry(normBoxFromField(field), anchor);
  const normBox = geometryToNormBox(geom);
  const vp = viewports[pageIdx] || {};
  const W = Math.max(1, (vp.width ?? vp.w) || 1);
  const H = Math.max(1, (vp.height ?? vp.h) || 1);
  let boxPx = null;
  if(normBox){
    const { sx, sy, sw, sh } = denormalizeBox(normBox, W, H);
    boxPx = applyTransform({ x: sx, y: sy, w: sw, h: sh, page: pageNumber });
  }
  const bboxArr = normBox ? [normBox.x0n, normBox.y0n, normBox.x0n + normBox.wN, normBox.y0n + normBox.hN] : null;
  return { pageNumber, pageRole: role, anchor, normBox, bbox: bboxArr, boxPx, configMask };
}

function summarizeTokens(tokens=[], max=5){
  if(!tokens.length) return '';
  return tokens.slice(0, max).map(t => (t.text || '').trim()).filter(Boolean).join(' | ');
}

function summarizeTokenCache(){
  const store = state.tokensByPage || [];
  const entries = Array.isArray(store)
    ? store
        .map((tokens, idx) => tokens ? { page: idx, tokens } : null)
        .filter(Boolean)
    : Object.entries(store || {}).map(([k,v]) => ({ page: Number(k) || 0, tokens: v }));
  let totalTokens = 0;
  const perPage = [];
  for(const entry of entries){
    const count = Array.isArray(entry.tokens) ? entry.tokens.length : (entry.tokens?.length || 0);
    const page = entry.page || (perPage.length + 1);
    if(page > 0 || count > 0){
      perPage.push({ page, tokens: count });
    }
    totalTokens += count;
  }
  const pageCount = state.numPages || perPage.length || (Array.isArray(store) ? store.length : entries.length) || 0;
  return { totalTokens, pageCount, perPage };
}

// Convert normalized [0-1] coords into the canonical logical pixel space used by
// pdf.js tokens (CSS/document pixels, not device pixels). Any rendering scale or
// devicePixelRatio should be applied only when drawing, not when computing these
// logical coordinates.
const toPx = (vp, pctBox) => {
  const w = ((vp.w ?? vp.width) || 1);
  const h = ((vp.h ?? vp.height) || 1);
  const x = pctBox.x0 * w;
  const y = pctBox.y0 * h;
  const wPx = (pctBox.x1 - pctBox.x0) * w;
  const hPx = (pctBox.y1 - pctBox.y0) * h;
  return { x, y, w: wPx, h: hPx, page: pctBox.page };
};

const toPct = (vp, pxBox) => {
  const w = ((vp.w ?? vp.width) || 1);
  const h = ((vp.h ?? vp.height) || 1);
  return {
    x0: pxBox.x / w,
    y0: pxBox.y / h,
    x1: (pxBox.x + pxBox.w) / w,
    y1: (pxBox.y + pxBox.h) / h,
    page: pxBox.page
  };
};

function computeAreaRelativeBox(areaPct, fieldPct){
  if(!areaPct || !fieldPct) return null;
  const areaW = (areaPct.x1 - areaPct.x0);
  const areaH = (areaPct.y1 - areaPct.y0);
  if(areaW <= 0 || areaH <= 0) return null;
  return {
    x0: (fieldPct.x0 - areaPct.x0) / areaW,
    y0: (fieldPct.y0 - areaPct.y0) / areaH,
    x1: (fieldPct.x1 - areaPct.x0) / areaW,
    y1: (fieldPct.y1 - areaPct.y0) / areaH
  };
}

function serializeAreaConstellation(constellation){
  if(!constellation) return null;
  const serializePoint = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y)) ? { x: p.x, y: p.y } : null;
  const serializeBox = (b) => (!b || !Number.isFinite(b.w) || !Number.isFinite(b.h))
    ? null
    : { x: b.x || 0, y: b.y || 0, w: b.w, h: b.h, page: b.page };
  const serializeDelta = (d) => ({ dx: Number.isFinite(d?.dx) ? d.dx : 0, dy: Number.isFinite(d?.dy) ? d.dy : 0 });
  const serializeSupport = (s) => ({
    text: s?.text || '',
    normText: s?.normText || '',
    center: serializePoint(s?.center) || { x: 0, y: 0 },
    box: serializeBox(s?.box),
    fieldDelta: serializeDelta(s?.fieldDelta),
    anchorDelta: serializeDelta(s?.anchorDelta)
  });
  const anchor = constellation.anchor ? {
    text: constellation.anchor.text || '',
    normText: constellation.anchor.normText || '',
    center: serializePoint(constellation.anchor.center) || { x: 0, y: 0 },
    box: serializeBox(constellation.anchor.box),
    fieldDelta: serializeDelta(constellation.anchor.fieldDelta),
    supports: Array.isArray(constellation.anchor.supports) ? [...constellation.anchor.supports] : []
  } : null;

  return {
    page: constellation.page,
    bboxPct: constellation.bboxPct,
    origin: serializePoint(constellation.origin) || { x: 0, y: 0 },
    fieldSize: constellation.fieldSize ? { w: constellation.fieldSize.w || 0, h: constellation.fieldSize.h || 0 } : null,
    tolerance: constellation.tolerance,
    anchor,
    supports: Array.isArray(constellation.supports) ? constellation.supports.map(serializeSupport) : [],
    crossLinks: Array.isArray(constellation.crossLinks)
      ? constellation.crossLinks.map(link => ({ from: link.from, to: link.to, delta: serializeDelta(link.delta) }))
      : [],
    minSupportMatches: constellation.minSupportMatches
  };
}

function buildAreaFingerprint(areaBox, tokens, pageW=1, pageH=1){
  if(!areaBox) return null;
  const bboxPct = areaBox.bboxPct || (areaBox.normBox ? {
    x0: areaBox.normBox.x0n,
    y0: areaBox.normBox.y0n,
    x1: areaBox.normBox.x0n + areaBox.normBox.wN,
    y1: areaBox.normBox.y0n + areaBox.normBox.hN
  } : null);
  const areaPx = areaBox.rawBox || (bboxPct ? {
    x: (bboxPct.x0 || 0) * pageW,
    y: (bboxPct.y0 || 0) * pageH,
    w: Math.max(0, ((bboxPct.x1 || 0) - (bboxPct.x0 || 0)) * pageW),
    h: Math.max(0, ((bboxPct.y1 || 0) - (bboxPct.y0 || 0)) * pageH)
  } : null);

  if(!bboxPct || !areaPx || !Number.isFinite(areaPx.w) || !Number.isFinite(areaPx.h) || areaPx.w <= 0 || areaPx.h <= 0){
    return null;
  }

  const areaPage = areaBox.page || areaBox.pageNumber || (Array.isArray(tokens) ? tokens[0]?.page : null);
  const insideArea = (tokens || []).filter(t => {
    if(!t || (t.page && areaPage && t.page !== areaPage)) return false;
    const cx = (t.x || 0) + (t.w || 0) / 2;
    const cy = (t.y || 0) + (t.h || 0) / 2;
    return cx >= areaPx.x && cx <= areaPx.x + areaPx.w && cy >= areaPx.y && cy <= areaPx.y + areaPx.h;
  });

  const keywords = insideArea.map((t, idx) => {
    const norm = normalizeBBoxForPage({ x: t.x, y: t.y, w: t.w, h: t.h, page: t.page }, pageW, pageH) || { x:0, y:0, w:0, h:0 };
    const text = t.text || t.raw || '';
    const normText = normalizeKeywordText(text);
    const centerRel = {
      cx: ((t.x || 0) + (t.w || 0) / 2 - areaPx.x) / areaPx.w,
      cy: ((t.y || 0) + (t.h || 0) / 2 - areaPx.y) / areaPx.h
    };
    const edgeOffsets = {
      left: ((t.x || 0) - areaPx.x) / areaPx.w,
      top: ((t.y || 0) - areaPx.y) / areaPx.h,
      right: ((areaPx.x + areaPx.w) - ((t.x || 0) + (t.w || 0))) / areaPx.w,
      bottom: ((areaPx.y + areaPx.h) - ((t.y || 0) + (t.h || 0))) / areaPx.h
    };
    return { id: idx, text, normText, bboxNorm: norm, centerRel, edgeOffsets };
  }).filter(k => k.normText);

  const neighborFor = (kw) => {
    const scored = keywords
      .filter(other => other !== kw)
      .map(other => {
        const dx = other.centerRel.cx - kw.centerRel.cx;
        const dy = other.centerRel.cy - kw.centerRel.cy;
        const dist = Math.hypot(dx, dy);
        return { id: other.id, text: other.text, dx, dy, dist };
      })
      .sort((a,b)=>a.dist - b.dist)
      .slice(0, 3);
    return scored;
  };

  keywords.forEach(k => { k.neighbors = neighborFor(k); });

  const preferKeywordCandidates = keywords.filter(k => /[a-z]/i.test(k.normText));

  const pickCornerKeyword = (targetCx, targetCy, role) => {
    if(!keywords.length) return null;
    const pool = preferKeywordCandidates.length ? preferKeywordCandidates : keywords;
    let best = pool[0];
    let bestScore = Infinity;
    for(let i=0;i<pool.length;i++){
      const kw = pool[i];
      const dist = Math.hypot(kw.centerRel.cx - targetCx, kw.centerRel.cy - targetCy);
      const edgeProximity = Math.min(
        kw.edgeOffsets.left + kw.edgeOffsets.top,
        kw.edgeOffsets.right + kw.edgeOffsets.bottom
      );
      const score = dist * 0.8 + edgeProximity * 0.3;
      if(score < bestScore){ best = kw; bestScore = score; }
    }
    return {
      keywordId: best.id,
      text: best.text,
      normText: best.normText,
      bboxNorm: best.bboxNorm,
      centerRel: best.centerRel,
      edgeOffsets: best.edgeOffsets,
      distanceToCorner: Math.hypot(best.centerRel.cx - targetCx, best.centerRel.cy - targetCy),
      role
    };
  };

  const areaConstellationRaw = (AreaFinder?.captureAreaConstellation)
    ? AreaFinder.captureAreaConstellation(areaBox, tokens, pageW, pageH, {})
    : null;
  const areaConstellation = serializeAreaConstellation(areaConstellationRaw);

  return {
    // This fingerprint captures the shape of the AREABOX plus normalized keyword layout
    // so RUN mode can validate orientation/size without re-OCR or new coordinate systems.
    page: areaPage,
    bboxPct,
    keywords,
    areaConstellation,
    orientation: {
      topRight: pickCornerKeyword(1, 0, 'topRight'),
      bottomLeft: pickCornerKeyword(0, 1, 'bottomLeft')
    }
  };
}

function setAreaSelection(areaId, payload){
  if(!areaId || !payload) return;
  state.areaSelections = state.areaSelections || {};
  state.areaSelections[areaId] = clonePlain(payload);
}

function getAreaSelection(areaId){
  if(!areaId || !state.areaSelections) return null;
  return state.areaSelections[areaId] || null;
}

function resolveAreaBoxPx(occurrence){
  if(!occurrence) return null;
  if(occurrence.bboxPx && Number.isFinite(occurrence.bboxPx.x) && Number.isFinite(occurrence.bboxPx.y)){
    const page = occurrence.bboxPx.page || occurrence.page || 1;
    return { ...occurrence.bboxPx, page };
  }
  const norm = occurrence.bboxNorm || occurrence.bboxPct || null;
  if(!norm) return null;
  const page = occurrence.page || norm.page || 1;
  const vp = state.pageViewports[(page||1)-1] || state.viewport || {};
  const box = toPx({ w: vp.width ?? vp.w ?? 1, h: vp.height ?? vp.h ?? 1 }, { x0: norm.x0, y0: norm.y0, x1: norm.x1, y1: norm.y1, page });
  return { x: box.x, y: box.y, w: box.w, h: box.h, page };
}

function absoluteBoxFromRelative(relativeBox, areaBoxPx){
  if(!relativeBox || !areaBoxPx || !Number.isFinite(areaBoxPx.w) || !Number.isFinite(areaBoxPx.h)) return null;
  const x0 = areaBoxPx.x + (relativeBox.x0 || 0) * areaBoxPx.w;
  const y0 = areaBoxPx.y + (relativeBox.y0 || 0) * areaBoxPx.h;
  const x1 = areaBoxPx.x + (relativeBox.x1 || 0) * areaBoxPx.w;
  const y1 = areaBoxPx.y + (relativeBox.y1 || 0) * areaBoxPx.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, page: areaBoxPx.page };
}

function tokensWithinArea(tokens, areaBoxPx){
  if(!Array.isArray(tokens) || !areaBoxPx) return [];
  return tokensInBox(tokens, areaBoxPx, { minOverlap: 0 });
}

function resolveAreaField(areaId){
  if(!areaId || !state.profile?.fields) return null;
  return state.profile.fields.find(f => (f.isArea || f.fieldType === 'areabox') && (f.areaId === areaId || f.fieldKey === areaId || f.id === areaId)) || null;
}

function isExplicitSubordinate(field){
  if(AreaScoping?.isExplicitSubordinate) return AreaScoping.isExplicitSubordinate(field);
  if(!field || field.isArea || field.fieldType === 'areabox') return false;
  if(field.isSubordinate === true) return true;
  if(field.areaRelativeBox) return true;
  return false;
}

function pickAreaScope(areaId, targetPage, options = {}){
  const { lowConfidenceFloor = 0.2 } = options || {};
  const candidates = (state.areaOccurrencesById?.[areaId] || [])
    .map(occ => ({ occ, box: resolveAreaBoxPx(occ) }))
    .filter(entry => !!entry.box);
  const fallbackArea = resolveAreaField(areaId);
  const fallbackOccurrence = fallbackArea ? buildSavedAreaOccurrence(fallbackArea) : null;
  if(fallbackOccurrence){
    const fbBox = resolveAreaBoxPx(fallbackOccurrence);
    if(fbBox){
      candidates.push({
        occ: { ...fallbackOccurrence, source: fallbackOccurrence.source || 'config-fallback' },
        box: fbBox
      });
    }
  }
  if(!candidates.length) return null;
  const pageMatches = candidates.filter(entry => (entry.box.page || entry.occ.page || 1) === targetPage);
  const scoped = (pageMatches.length ? pageMatches : candidates).sort((a,b)=> (b.occ?.confidence ?? 0) - (a.occ?.confidence ?? 0));
  let chosen = scoped[0];
  const configFallback = scoped.find(entry => entry.occ?.source === 'config' || entry.occ?.source === 'config-fallback');
  if(chosen && (chosen.occ?.confidence ?? 0) < lowConfidenceFloor && configFallback){
    chosen = configFallback;
  }
  return chosen;
}

function groupFieldsByArea(fields = []){
  const map = new Map();
  fields.forEach(f => {
    const isArea = f && (f.isArea || f.fieldType === 'areabox');
    const areaId = isArea ? (f.areaId || f.id || f.fieldKey) : (f.areaId || null);
    if(isArea){
      if(!map.has(areaId)) map.set(areaId, { area: f, subs: [] });
      else map.get(areaId).area = map.get(areaId).area || f;
    }
  });
  fields.forEach(f => {
    if(!f || f.isArea || f.fieldType === 'areabox') return;
    if(!isExplicitSubordinate(f) || !f.areaId) return;
    if(!map.has(f.areaId)) map.set(f.areaId, { area: null, subs: [] });
    map.get(f.areaId).subs.push(f);
  });
  return map;
}

function seedAreaOccurrencesFromConfig(groups){
  if(!state.areaOccurrencesById) state.areaOccurrencesById = {};
  for(const [areaId, entry] of groups.entries()){
    if(!areaId || !entry?.area) continue;
    const existing = state.areaOccurrencesById[areaId] || [];
    if(existing.length) continue;

    const area = entry.area;
    const areaBox = area.areaBox || null;
    const pctBox = areaBox?.bboxPct
      || (Array.isArray(area.bbox) ? { x0: area.bbox[0], y0: area.bbox[1], x1: area.bbox[2], y1: area.bbox[3] } : null)
      || area.bboxPct
      || null;
    const normFromBox = (!pctBox && area.normBox)
      ? { x0: area.normBox.x0n, y0: area.normBox.y0n, x1: area.normBox.x0n + area.normBox.wN, y1: area.normBox.y0n + area.normBox.hN }
      : null;
    const page = areaBox?.page || area.areaFingerprint?.page || area.page || area.pageNumber || 1;
    const bboxNorm = pctBox || normFromBox;
    const rawBox = areaBox?.rawBox || null;
    const hasPxBox = rawBox && [rawBox.x, rawBox.y, rawBox.w, rawBox.h].every(v => Number.isFinite(v));

    if(!bboxNorm && !hasPxBox) continue;

    const occurrence = { areaId, page };
    if(bboxNorm){
      occurrence.bboxNorm = { x0: bboxNorm.x0, y0: bboxNorm.y0, x1: bboxNorm.x1, y1: bboxNorm.y1, page };
    }
    if(hasPxBox){
      occurrence.bboxPx = { x: rawBox.x, y: rawBox.y, w: rawBox.w, h: rawBox.h, page };
    }

    state.areaOccurrencesById[areaId] = [occurrence];
  }
}

function persistAreaRows(rows = []){
  state.areaExtractions = {};
  state.currentAreaRows = rows;
  rows.forEach(row => {
    if(!row || !row.areaId) return;
    if(!state.areaExtractions[row.areaId]) state.areaExtractions[row.areaId] = [];
    state.areaExtractions[row.areaId].push(row);
  });
}

function buildAreaOccurrencesPayload(){
  const occurrences = [];
  const rowsByArea = new Map();
  (state.currentAreaRows || []).forEach(row => {
    if(!row?.areaId) return;
    const idx = Number.isFinite(row.occurrenceIndex) ? row.occurrenceIndex : (rowsByArea.get(row.areaId)?.length || 0);
    if(!rowsByArea.has(row.areaId)) rowsByArea.set(row.areaId, []);
    rowsByArea.get(row.areaId)[idx] = row;
  });

  const areaMap = state.areaOccurrencesById || {};
  Object.entries(areaMap).forEach(([areaId, occListRaw]) => {
    const occList = Array.isArray(occListRaw) ? occListRaw : [];
    occList.forEach((occ, idx) => {
      const matchedRow = (rowsByArea.get(areaId) || [])[idx] || null;
      const entry = clonePlain(occ || {});
      entry.areaId = entry.areaId || areaId;
      entry.areaName = entry.areaName || resolveAreaLabel(entry.areaId, entry.areaName || null);
      entry.occurrenceIndex = Number.isFinite(entry.occurrenceIndex) ? entry.occurrenceIndex : idx;
      if(matchedRow){
        entry.fields = clonePlain(matchedRow.fields || {});
        entry.page = entry.page || matchedRow.page;
        entry.bboxNorm = entry.bboxNorm || entry.bboxPct || matchedRow.bboxNorm || matchedRow.bboxPct || null;
        entry.bboxPx = entry.bboxPx || matchedRow.bboxPx || null;
        entry.confidence = entry.confidence ?? matchedRow.confidence ?? null;
        entry.constellationMatch = entry.constellationMatch || matchedRow.constellationMatch || null;
        entry.matchMetrics = entry.matchMetrics || matchedRow.matchMetrics || null;
      }
      occurrences.push(entry);
    });
  });

  (state.currentAreaRows || []).forEach(row => {
    if(!row?.areaId) return;
    const idx = Number.isFinite(row.occurrenceIndex) ? row.occurrenceIndex : null;
    const already = occurrences.some(o => o.areaId === row.areaId && (Number.isFinite(idx) ? (Number.isFinite(o.occurrenceIndex) && o.occurrenceIndex === idx) : !Number.isFinite(o.occurrenceIndex)));
    if(already) return;
    occurrences.push({
      areaId: row.areaId,
      areaName: resolveAreaLabel(row.areaId, row.areaName || null),
      occurrenceIndex: idx,
      page: row.page,
      bboxNorm: row.bboxNorm || row.bboxPct || null,
      bboxPx: row.bboxPx || null,
      fields: clonePlain(row.fields || {}),
      confidence: row.confidence ?? null,
      constellationMatch: row.constellationMatch || null,
      matchMetrics: row.matchMetrics || null
    });
  });

  return occurrences;
}

const normalizeBox = (boxPx, canvasW, canvasH) => ({
  x0n: boxPx.x / canvasW,
  y0n: boxPx.y / canvasH,
  wN: boxPx.w / canvasW,
  hN: boxPx.h / canvasH
});

const denormalizeBox = (normBox, W, H) => ({
  sx: Math.round(normBox.x0n * W),
  sy: Math.round(normBox.y0n * H),
  sw: Math.max(1, Math.round(normBox.wN * W)),
  sh: Math.max(1, Math.round(normBox.hN * H))
});

function getViewportDimensions(viewport){
  const width = Math.max(1, ((viewport?.width ?? viewport?.w) || 0) || 1);
  const height = Math.max(1, ((viewport?.height ?? viewport?.h) || 0) || 1);
  return { width, height };
}

function getPageViewportSize(page){
  const vp = state.pageViewports[(page||1)-1] || state.viewport || {};
  return getViewportDimensions(vp);
}

function getOverlayFlags(){
  const ringsOn = Array.from(els.showRingToggles||[]).some(t=>t.checked);
  const matchesOn = Array.from(els.showMatchToggles||[]).some(t=>t.checked);
  return {
    boxes: !!els.showBoxesToggle?.checked,
    rings: ringsOn,
    matches: matchesOn,
    ocr: !!els.showOcrBoxesToggle?.checked
  };
}

function overlayFlagsEqual(a,b){
  if(!a || !b) return false;
  return ['boxes','rings','matches','ocr'].every(k => !!a[k] === !!b[k]);
}

function median(values){
  if(!values?.length) return 0;
  const sorted = values.slice().sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
}

function anchorMetricsFromBox(box, pageWidth, pageHeight, heights=[], fallbackHeight=0){
  if(!box || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0){
    return null;
  }
  const x = Number.isFinite(box.x) ? box.x : null;
  const y = Number.isFinite(box.y) ? box.y : null;
  const w = Number.isFinite(box.w) ? box.w : null;
  const h = Number.isFinite(box.h) ? box.h : null;
  if([x,y,w,h].some(v => !Number.isFinite(v))){
    return null;
  }
  const leftPx = Math.max(0, x);
  const topPx = Math.max(0, y);
  const widthPx = Math.max(0, w);
  const heightPx = Math.max(0, h);
  const rightPx = Math.max(0, pageWidth - (leftPx + widthPx));
  const bottomPx = Math.max(0, pageHeight - (topPx + heightPx));
  const cleanHeights = (heights || []).map(v => Number.isFinite(v) ? v : null).filter(v => Number.isFinite(v) && v > 0);
  let textHeightPx = cleanHeights.length ? median(cleanHeights) : 0;
  if(!textHeightPx && Number.isFinite(fallbackHeight) && fallbackHeight > 0){
    textHeightPx = fallbackHeight;
  }
  const clampPct = (val, denom) => denom ? Math.max(0, Math.min(1, val / denom)) : 0;
  return {
    topPx,
    bottomPx,
    leftPx,
    rightPx,
    pageWidthPx: pageWidth,
    pageHeightPx: pageHeight,
    topPct: clampPct(topPx, pageHeight),
    bottomPct: clampPct(bottomPx, pageHeight),
    leftPct: clampPct(leftPx, pageWidth),
    rightPct: clampPct(rightPx, pageWidth),
    textHeightPx,
    textHeightPct: clampPct(textHeightPx, pageHeight)
  };
}

function computeFieldAnchorMetrics({ normBox, rawBox, tokens, page, extras }){
  const rb = rawBox || {};
  let { canvasW: pageWidth, canvasH: pageHeight } = rb;
  if(!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0){
    const dims = getPageViewportSize(page);
    pageWidth = dims.width;
    pageHeight = dims.height;
  }
  const box = (Number.isFinite(rb.x) && Number.isFinite(rb.y) && Number.isFinite(rb.w) && Number.isFinite(rb.h))
    ? { x: rb.x, y: rb.y, w: rb.w, h: rb.h }
    : normBox
      ? { x: normBox.x0n * pageWidth, y: normBox.y0n * pageHeight, w: normBox.wN * pageWidth, h: normBox.hN * pageHeight }
      : null;
  if(!box) return null;
  const heights = (tokens || []).map(t => Number.isFinite(t?.h) ? t.h : null).filter(v => Number.isFinite(v) && v > 0);
  let fallbackHeight = heights.length ? median(heights) : 0;
  if(!fallbackHeight && extras?.column){
    const samples=[];
    if(extras.column.anchorSample && Number.isFinite(extras.column.anchorSample.hNorm)){
      samples.push(extras.column.anchorSample.hNorm * pageHeight);
    }
    if(Array.isArray(extras.column.rowSamples)){
      extras.column.rowSamples.forEach(s => {
        if(Number.isFinite(s.hNorm)) samples.push(s.hNorm * pageHeight);
      });
    }
    if(samples.length){ fallbackHeight = median(samples); }
  }
  if(!fallbackHeight && Number.isFinite(box.h)){ fallbackHeight = box.h / 2; }
  return anchorMetricsFromBox(box, pageWidth, pageHeight, heights, fallbackHeight);
}

function projectAnchorDistance(savedPct, savedPx, savedPageDim, targetPageDim){
  if(Number.isFinite(savedPct)){ return savedPct * targetPageDim; }
  if(Number.isFinite(savedPx) && Number.isFinite(savedPageDim) && savedPageDim > 0){
    return (savedPx / savedPageDim) * targetPageDim;
  }
  return null;
}

function projectColumnFera(fera, pageWidth, pageHeight){
  if(!fera || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0){
    return null;
  }
  const left = projectAnchorDistance(fera.leftPct, fera.leftPx, fera.pageWidthPx, pageWidth);
  const right = projectAnchorDistance(fera.rightPct, fera.rightPx, fera.pageWidthPx, pageWidth);
  const top = projectAnchorDistance(fera.topPct, fera.topPx, fera.pageHeightPx, pageHeight);
  const bottom = projectAnchorDistance(fera.bottomPct, fera.bottomPx, fera.pageHeightPx, pageHeight);
  const x0 = Number.isFinite(left) ? Math.max(0, left) : null;
  const x1 = Number.isFinite(right) ? Math.min(pageWidth, pageWidth - right) : null;
  const y0 = Number.isFinite(top) ? Math.max(0, top) : null;
  const y1 = Number.isFinite(bottom) ? Math.min(pageHeight, pageHeight - bottom) : null;
  const width = Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0 ? x1 - x0 : null;
  const height = Number.isFinite(y0) && Number.isFinite(y1) && y1 > y0 ? y1 - y0 : null;
  const centerX = Number.isFinite(x0) && Number.isFinite(width) ? x0 + width/2 : null;
  return {
    left: Number.isFinite(left) ? left : null,
    right: Number.isFinite(right) ? right : null,
    top: Number.isFinite(top) ? top : null,
    bottom: Number.isFinite(bottom) ? bottom : null,
    x0: Number.isFinite(x0) ? x0 : null,
    x1: Number.isFinite(x1) ? x1 : null,
    y0: Number.isFinite(y0) ? y0 : null,
    y1: Number.isFinite(y1) ? y1 : null,
    width,
    height,
    centerX
  };
}

function anchorMetricsSatisfied(saved, candidate, debugCtx=null){
  if(!saved || !candidate){
    return { ok: true, softOk: true, status: 'skip', matches: 0, textMatch: false, tolerance: 0, nearMisses: 0 };
  }
  const targetHeight = candidate.pageHeightPx || 0;
  const targetWidth = candidate.pageWidthPx || 0;
  const expectedTop = projectAnchorDistance(saved.topPct, saved.topPx, saved.pageHeightPx, targetHeight);
  const expectedBottom = projectAnchorDistance(saved.bottomPct, saved.bottomPx, saved.pageHeightPx, targetHeight);
  const expectedLeft = projectAnchorDistance(saved.leftPct, saved.leftPx, saved.pageWidthPx, targetWidth);
  const expectedRight = projectAnchorDistance(saved.rightPct, saved.rightPx, saved.pageWidthPx, targetWidth);
  const expectedText = projectAnchorDistance(saved.textHeightPct, saved.textHeightPx, saved.pageHeightPx, targetHeight);
  const distances = [
    { expected: expectedTop, actual: candidate.topPx, label:'top' },
    { expected: expectedBottom, actual: candidate.bottomPx, label:'bottom' },
    { expected: expectedLeft, actual: candidate.leftPx, label:'left' },
    { expected: expectedRight, actual: candidate.rightPx, label:'right' }
  ];
  const available = distances.filter(d => Number.isFinite(d.expected) && Number.isFinite(d.actual));
  const minDim = Math.min(targetHeight || 0, targetWidth || 0);
  let toleranceBase = Number.isFinite(expectedText) ? expectedText : candidate.textHeightPx;
  if(!Number.isFinite(toleranceBase) || toleranceBase <= 0){
    toleranceBase = minDim * 0.02;
  }
  const pctFloor = Number.isFinite(minDim) && minDim > 0 ? minDim * 0.025 : 0;
  if(!Number.isFinite(toleranceBase) || toleranceBase <= 0){ toleranceBase = 4; }
  const tolerance = Math.max(4, Math.max(toleranceBase * 1.35, pctFloor));
  const softTolerance = tolerance * 2.25;
  const edgeStats = available.map(d => ({
    label: d.label,
    delta: Math.abs(d.actual - d.expected),
    within: Math.abs(d.actual - d.expected) <= tolerance,
    soft: Math.abs(d.actual - d.expected) <= softTolerance
  }));
  const matches = edgeStats.filter(e => e.within).length;
  const nearMisses = edgeStats.filter(e => !e.within && e.soft).length;
  const textMatch = Number.isFinite(expectedText) && Number.isFinite(candidate.textHeightPx)
    ? Math.abs(candidate.textHeightPx - expectedText) <= softTolerance
    : false;
  if(!available.length){
    const ok = !Number.isFinite(expectedText) || textMatch;
    const softOk = !ok; // allow degrade when nothing to compare
    return { ok, softOk, status: ok ? 'ok' : 'soft', matches: 0, textMatch, tolerance, nearMisses };
  }
  const required = Math.min(2, available.length);
  let ok = matches >= required || (matches >= 1 && required === 1);
  if(!ok && matches === required - 1 && textMatch){
    ok = true;
  }
  const softOk = !ok && (matches + nearMisses >= required || textMatch);
  const status = ok ? 'ok' : (softOk ? 'soft' : 'fail');
  if(staticDebugEnabled() && debugCtx?.enabled){
    const annotated = distances.map(d => {
      const ready = Number.isFinite(d.expected) && Number.isFinite(d.actual);
      const delta = ready ? Math.round(d.actual - d.expected) : null;
      const edgeOk = ready ? Math.abs(d.actual - d.expected) <= tolerance : null;
      const edgeSoft = ready ? Math.abs(d.actual - d.expected) <= softTolerance : null;
      return `${d.label}=${ready ? (edgeOk ? 'OK' : edgeSoft ? 'SOFT' : 'FAIL') + ` (${delta >= 0 ? '+' : ''}${delta}px)` : 'n/a'}`;
    }).join(', ');
    const heightStatus = Number.isFinite(expectedText) && Number.isFinite(candidate.textHeightPx)
      ? `${Math.abs(candidate.textHeightPx - expectedText) <= softTolerance ? 'OK' : 'FAIL'} (${Math.round(candidate.textHeightPx - expectedText)}px)`
      : 'n/a';
    logStaticDebug(
      `field=${debugCtx.fieldKey||''} page=${debugCtx.page||''} anchors: ${annotated}, height=${heightStatus} tol=${Math.round(tolerance)} soft=${Math.round(softTolerance)} viewport=${Math.round(targetWidth)}x${Math.round(targetHeight)} -> status=${status}`
    );
  }
  return { ok, softOk, status, matches, textMatch, tolerance, nearMisses };
}

function anchorMatchForBox(savedMetrics, box, tokens, viewportW, viewportH, debugCtx=null){
  if(!savedMetrics) return { ok: true, softOk: true, status: 'skip', matches: 0, textMatch: false, tolerance: 0, nearMisses: 0, score: 1 };
  if(!box || !Number.isFinite(viewportW) || !Number.isFinite(viewportH) || viewportW <= 0 || viewportH <= 0){
    return { ok:false, softOk:false, status:'fail', matches:0, textMatch:false, tolerance:0, nearMisses:0, score:0 };
  }
  const heights = (tokens || []).map(t => Number.isFinite(t?.h) ? t.h : null).filter(v => Number.isFinite(v) && v > 0);
  const fallbackHeight = heights.length ? median(heights) : (Number.isFinite(box.h) ? box.h : 0);
  const metrics = anchorMetricsFromBox(box, viewportW, viewportH, heights, fallbackHeight);
  if(!metrics){
    return { ok:false, softOk:true, status:'soft', matches:0, textMatch:false, tolerance:0, nearMisses:0, score:0.75 };
  }
  const res = anchorMetricsSatisfied(savedMetrics, metrics, debugCtx);
  const score = res.ok ? 1 : res.softOk ? 0.82 : 0;
  return { ...res, score };
}

function validateNormBox(nb){
  if(!nb) return { ok:false, reason:'invalid_box_input' };
  const vals = [nb.x0n, nb.y0n, nb.wN, nb.hN];
  if(vals.some(v => typeof v !== 'number' || !Number.isFinite(v))){
    return { ok:false, reason:'invalid_box_input' };
  }
  const { x0n, y0n, wN, hN } = nb;
  if(wN <= 0 || hN <= 0 || wN > 1 || hN > 1 || x0n < 0 || y0n < 0 || x0n > 1 || y0n > 1 || x0n + wN > 1 || y0n + hN > 1){
    return { ok:false, reason:'invalid_box_input' };
  }
  return { ok:true };
}

function validateSelection(sel){
  if(!sel) return { ok:false, reason:'invalid_box_input' };
  // already normalized?
  if(sel.x0n !== undefined || sel.wN !== undefined){
    const nb = { x0n:Number(sel.x0n), y0n:Number(sel.y0n), wN:Number(sel.wN), hN:Number(sel.hN) };
    const v = validateNormBox(nb);
    return v.ok ? { ok:true, normBox: nb } : { ok:false, reason:v.reason };
  }
  // legacy pixel coordinates
  const canvasW = Number(sel.canvasW0 ?? sel.canvasW);
  const canvasH = Number(sel.canvasH0 ?? sel.canvasH);
  const vals = [sel.x, sel.y, sel.w, sel.h, canvasW, canvasH];
  if(vals.every(v => typeof v === 'number' && Number.isFinite(v)) && sel.w > 0 && sel.h > 0 && canvasW > 0 && canvasH > 0){
    const nb = { x0n: sel.x / canvasW, y0n: sel.y / canvasH, wN: sel.w / canvasW, hN: sel.h / canvasH };
    const v = validateNormBox(nb);
    return v.ok ? { ok:true, normBox: nb } : { ok:false, reason:'invalid_box_input' };
  }
  return { ok:false, reason:'invalid_box_input' };
}

function applyTransform(boxPx, transform=state.pageTransform, opts={}){
  const { scale=1, rotation=0 } = transform || {};
  if(scale === 1 && rotation === 0) return { ...boxPx };
  const vp = state.pageViewports[boxPx.page-1] || state.viewport;
  const wPage = ((vp.w ?? vp.width) || 1);
  const hPage = ((vp.h ?? vp.height) || 1);
  const cx = wPage/2, cy = hPage/2;
  const x = boxPx.x + boxPx.w/2;
  const y = boxPx.y + boxPx.h/2;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  let dx = (x - cx) * scale;
  let dy = (y - cy) * scale;
  const x2 = dx*cos - dy*sin + cx;
  const y2 = dx*sin + dy*cos + cy;
  const w = boxPx.w * scale;
  const h = boxPx.h * scale;
  return { x: x2 - w/2, y: y2 - h/2, w, h, page: boxPx.page };
}

function intersect(a,b){ return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function bboxOfTokens(tokens){
  const x1 = Math.min(...tokens.map(t=>t.x)), y1 = Math.min(...tokens.map(t=>t.y));
  const x2 = Math.max(...tokens.map(t=>t.x + t.w)), y2 = Math.max(...tokens.map(t=>t.y + t.h));
  return { x:x1, y:y1, w:x2-x1, h:y2-y1, page: tokens[0]?.page ?? state.pageNum };
}
function cosine3Gram(a,b){
  const grams = s=>{ s=(s||'').toLowerCase(); const m=new Map(); for(let i=0;i<s.length-2;i++){ const g=s.slice(i,i+3); m.set(g,(m.get(g)||0)+1);} return m; };
  const A=grams(a), B=grams(b); let dot=0, nA=0, nB=0;
  A.forEach((v,k)=>{ nA+=v*v; if(B.has(k)) dot+=v*B.get(k); });
  B.forEach(v=>{ nB+=v*v; });
  return (dot===0)?0:(dot/Math.sqrt(nA*nB));
}

function collapseAdjacentDuplicates(str){
  if(!str) return '';
  let out = str;
  const re = /(\b[\w#&.-]+(?:\s+[\w#&.-]+)*)\s+\1\b/gi;
  do { var prev = out; out = out.replace(re, '$1'); } while(out !== prev);
  return out;
}

function normalizeMoney(raw){
  if(!raw) return '';
  const sign = /-/.test(raw) ? '-' : '';
  const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g,'');
  const num = parseFloat(cleaned);
  if(isNaN(num)) return '';
  const abs = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return sign + abs;
}

function normalizeDate(raw){
  if(!raw) return '';
  const txt = raw.trim().replace(/(\d)(st|nd|rd|th)/gi, '$1');
  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
  };
  let y,m,d;
  let match;
  if((match = txt.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/))){
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if((match = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))){
    const a = +match[1], b = +match[2];
    // if first part >12 assume DD/MM/YYYY else MM/DD/YYYY
    if(a > 12){ d = a; m = b; } else { m = a; d = b; }
    y = +match[3];
  } else if((match = txt.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/))){
    m = months[match[1].slice(0,3).toLowerCase()] || 0;
    d = +match[2];
    y = +match[3];
  }
  if(!y || !m || !d) return '';
  const pad = n => n.toString().padStart(2,'0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

const KNOWN_LEXICON = [
  'DELIVERY','PICKUP','SUBTOTAL','TOTAL','BALANCE','DEPOSIT','CONTINUATION','GST','QST','HST'
];

const KEYWORD_CATALOGUE = {
  store_name: {
    en: [
      'store', 'vendor', 'seller', 'company', 'business', 'organization', 'institution', 'entity',
      'provider', 'supplier', 'market', 'branch', 'office'
    ]
  },
  department_division: {
    en: ['department', 'division', 'branch', 'section', 'sections', 'chapter', 'chapters', 'part', 'parts']
  },
  invoice_number: {
    en: [
      'invoice number', 'invoice no', 'invoice #', 'inv #', 'inv no', 'invoice', 'account', 'accounts',
      'application', 'certificate', 'code', 'contract', 'coverage', 'form', 'format', 'formats', 'id',
      'identification', 'label', 'labels', 'ledger', 'number', 'numbers', 'numbered', 'order', 'orders',
      'page', 'pages', 'policy', 'reference', 'references', 'report', 'request', 'review', 'transaction',
      'transactions', 'entry', 'document', 'documents', 'table', 'tables', 'figure', 'figures', 'trade'
    ]
  },
  invoice_date: {
    en: [
      'invoice date', 'date of issue', 'issued date', 'date', 'dates', 'issued', 'delivery', 'effective',
      'expiry', 'period', 'periods', 'time', 'times', 'term', 'terms', 'year', 'years', 'hours'
    ]
  },
  salesperson_rep: {
    en: [
      'salesperson', 'sales rep', 'representative', 'agent', 'broker', 'brokerage', 'contact', 'author',
      'authors', 'employee', 'sales', 'support'
    ]
  },
  customer_name: {
    en: [
      'customer', 'client', 'bill to', 'sold to', 'customers', 'clients', 'buyer', 'member', 'owner',
      'holder', 'user', 'users', 'person', 'people', 'reader', 'readers', 'employer', 'name', 'names',
      'title', 'titles'
    ]
  },
  customer_address: {
    en: [
      'address', 'billing address', 'bill to address', 'customer address', 'city', 'postal', 'province',
      'region', 'zip', 'location', 'phone', 'telephone', 'email', 'contact', 'office', 'branch', 'insurance'
    ]
  },
  subtotal_amount: {
    en: [
      'subtotal', 'sub total', 'average', 'net', 'description', 'describe', 'describes', 'details', 'information',
      'content', 'contents', 'note', 'notes', 'text', 'texts', 'example', 'examples', 'item', 'items',
      'quantity', 'price', 'product', 'service', 'services', 'sales', 'definition', 'definitions', 'include',
      'includes', 'including', 'guidelines', 'instructions', 'disclosure'
    ]
  },
  discounts_amount: { en: ['discount', 'discounts', 'credit', 'refund'] },
  tax_amount: {
    en: ['tax', 'hst', 'gst', 'qst', 'vat', 'taxes', 'rate', 'rates', 'fee', 'fees', 'charge', 'charges', 'commission', 'commissions']
  },
  invoice_total: {
    en: [
      'total', 'grand total', 'amount due', 'balance due', 'amount', 'amounts', 'balance', 'balances',
      'outstanding', 'principal', 'value', 'values', 'price', 'available', 'limit', 'assets', 'liability',
      'income', 'financial', 'investment', 'portfolio', 'interest', 'process', 'purpose', 'risk'
    ]
  },
  payment_method: {
    en: [
      'payment method', 'paid with', 'payment', 'payments', 'bank', 'banking', 'cash', 'certificate', 'credit',
      'currency', 'debit', 'deposit', 'deposits', 'exchange', 'fund', 'funds', 'payroll', 'transfer', 'refund',
      'settlement', 'wages', 'method'
    ]
  },
  payment_status: {
    en: ['payment status', 'status', 'confirmation', 'authorization', 'verification', 'notice', 'statement', 'security', 'signature']
  }
};

const KEYWORD_RELATION_SCOPE = new Set([
  'store_name',
  'department_division',
  'invoice_number',
  'invoice_date',
  'salesperson_rep',
  'customer_name',
  'customer_address',
  'subtotal_amount',
  'discounts_amount',
  'tax_amount',
  'invoice_total',
  'payment_method',
  'payment_status'
]);

function getKeywordCatalogue(){
  return KEYWORD_CATALOGUE;
}

function editDistance(a,b){
  const dp = Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) dp[i][0]=i;
  for(let j=0;j<=b.length;j++) dp[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      dp[i][j] = a[i-1]===b[j-1]
        ? dp[i-1][j-1]
        : Math.min(dp[i-1][j-1], dp[i][j-1], dp[i-1][j]) + 1;
    }
  }
  return dp[a.length][b.length];
}

function applyOcrCorrections(txt, fieldKey=''){
  const alphaMap = { '0':'O', '1':'I', '5':'S', '7':'T', '8':'B' };
  const numMap   = { 'O':'0', 'I':'1', 'l':'1', 'S':'5', 'B':'8' };
  const corrections = [];
  let out = txt;
  const numericField = /invoice_number|sku|quantity|qty|invoice_total|subtotal_amount|amount|unit_price|price|balance|deposit|discounts_amount|discount|tax_amount|unit|grand|date/i.test(fieldKey) || /^[-\d.,]+$/.test(out);
  if(numericField){
    for(const [k,v] of Object.entries(numMap)){
      const repl = out.replace(new RegExp(k,'g'), v);
      if(repl !== out && /^[-\d.,]+$/.test(repl)){
        corrections.push(`${k}->${v}`);
        out = repl;
      }
    }
  } else {
    let bestLex = '';
    let bestDist = Infinity;
    for(const lex of KNOWN_LEXICON){
      const d = editDistance(out.toUpperCase(), lex);
      if(d < bestDist){ bestDist = d; bestLex = lex; }
    }
    for(const [k,v] of Object.entries(alphaMap)){
      const repl = out.replace(new RegExp(k,'g'), v);
      if(editDistance(repl.toUpperCase(), bestLex) < editDistance(out.toUpperCase(), bestLex)){
        corrections.push(`${k}->${v}`);
        out = repl;
      }
    }
    if(bestDist <= 2 && out.toUpperCase() !== bestLex){
      corrections.push(`${out}->${bestLex}`);
      out = bestLex;
    }
  }
  return { text: out, corrections };
}

function codeOf(str){
  const text = String(str ?? '');
  const hasLetters = /[A-Za-z]/.test(text);
  const hasDigits = /[0-9]/.test(text);
  const hasBoth = hasLetters && hasDigits;
  const hasSeparators = /[-_/.,:]/.test(text) || /\s/.test(text);
  const coreLength = text.replace(/[^A-Za-z0-9]/g, '').length;
  const isShort = coreLength <= 10;
  return [hasLetters, hasDigits, hasBoth, hasSeparators, isShort].map(v => (v ? '1' : '0')).join('');
}

function shapeOf(str){
  let out = '';
  for(const ch of str){
    if(/[A-Z]/.test(ch)) out += 'A';
    else if(/[0-9]/.test(ch)) out += '9';
    else if(ch === '-') out += '-';
    else if(ch === '/') out += '/';
    else if(ch === '.') out += '.';
    else if(/\s/.test(ch)) out += '_';
    else out += '?';
  }
  return out;
}

function digitRatio(str){
  if(!str.length) return 0;
  const digits = (str.match(/[0-9]/g) || []).length;
  return digits / str.length;
}

// ---------------------- OCRMAGIC overview ----------------------
// Layer-1 base OCRMAGIC (runBaseOcrMagic) now runs immediately on the raw OCR
// string with type-agnostic confusion-pair cleanup before any MAGIC DATA TYPE
// logic, learning, or fingerprints. MAGIC_DATA_TYPE.ANY is the mixed-field
// type (BOTH in the spec) meaning letters + digits + symbols are expected.
const MAGIC_DATA_TYPE = { ANY:'any', TEXT:'text', NUMERIC:'numeric' };
const runBaseOcrMagic = window.runBaseOcrMagic;

function normalizeMagicDataType(val){
  if(val === null || val === undefined) return null;
  const v = String(val).trim();
  if(!v) return null;
  const lower = v.toLowerCase();
  if(lower.includes('text')) return MAGIC_DATA_TYPE.TEXT;
  if(lower.includes('num')) return MAGIC_DATA_TYPE.NUMERIC;
  if(lower === 'all numbers') return MAGIC_DATA_TYPE.NUMERIC;
  if(lower === MAGIC_DATA_TYPE.ANY || lower === 'both') return MAGIC_DATA_TYPE.ANY;
  return null;
}

function inferMagicDataTypeFromFieldKey(fieldKey=''){
  const key = String(fieldKey || '').toLowerCase();
  if(/amount|total|tax|balance|subtotal|deposit|price|qty|quantity|unit|number/.test(key)) return MAGIC_DATA_TYPE.NUMERIC;
  if(/name|address|store|description|salesperson|department|rep/.test(key)) return MAGIC_DATA_TYPE.TEXT;
  return MAGIC_DATA_TYPE.ANY;
}

function resolveMagicDataType(fieldKey){
  const entry = getProfileFieldEntry(fieldKey) || (state.steps || []).find(s => s.fieldKey === fieldKey);
  const configured = entry?.magicDataType || entry?.magicType;
  const normalizedConfigured = normalizeMagicDataType(configured);
  const source = normalizedConfigured ? 'configured' : 'inferred';
  const magicType = normalizedConfigured || inferMagicDataTypeFromFieldKey(fieldKey);
  const profileType = getActiveProfileType();
  logMagicTypeResolution(fieldKey, magicType, { profileType, source });
  return { magicType, source, isExplicit: Boolean(normalizedConfigured) };
}

function logMagicTypeResolution(fieldKey, magicType, { profileType = getActiveProfileType(), source='inferred' }={}){
  if(!fieldKey) return;
  const key = `${profileType}::${currentWizardId()}::${fieldKey}`;
  if(magicTypeResolutionLog.has(key)) return;
  magicTypeResolutionLog.add(key);
  ocrMagicDebug({ event: 'ocrmagic.magicType.resolve', profileType, fieldKey, magicDataType: magicType || 'UNSET', source });
}

function getMagicDataType(fieldKey){
  return resolveMagicDataType(fieldKey).magicType;
}

function clonePlain(obj){
  if(obj === null || typeof obj !== 'object') return obj;
  if(typeof structuredClone === 'function'){
    try { return structuredClone(obj); }
    catch(err){ /* fall through */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

const FieldDataEngine = (() => {
  const patterns = {};
  const CONFUSION_PAIRS = [
    { letter:'O', digit:'0' },
    { letter:'o', digit:'0' },
    { letter:'I', digit:'1' },
    { letter:'l', digit:'1' },
    { letter:'T', digit:'7' },
    { letter:'S', digit:'5' },
    { letter:'B', digit:'8' }
  ];
  const FIXED_WORDS = new Set(['EXT', 'GST', 'HST', 'TOTAL']);
  const POSITION_SLOTS = ['first','second','secondLast','last'];
  const WRONG_EVENT_THRESHOLD = 3;

  function logAvoidSuppression({ ftype, pairKey, sig, phase }){
    const p = ensurePattern(ftype);
    const count = p.avoid?.[pairKey]?.[sig] || 0;
    ocrMagicDebug({
      event: 'ocrmagic.suppress',
      fieldKey: ftype || 'UNKNOWN',
      pairKey,
      context: sig,
      count,
      threshold: WRONG_EVENT_THRESHOLD,
      phase
    });
  }

  function ensurePattern(ftype){
    const existing = patterns[ftype];
    if(existing){
      if(!existing.avoid) existing.avoid = {};
      if(!existing.posTemplates) existing.posTemplates = {};
      if(!existing.code) existing.code = {};
      if(!existing.shape) existing.shape = {};
      if(!existing.len) existing.len = {};
      if(!existing.digit) existing.digit = {};
      return existing;
    }
    return patterns[ftype] = { code:{}, shape:{}, len:{}, digit:{}, avoid:{}, posTemplates:{} };
  }

  function normalizeOcrDigits(text, { fieldKey='', magicType=MAGIC_DATA_TYPE.NUMERIC, learningEnabled=true }={}){
  if(text === null || text === undefined) return text;
  const str = String(text);
  const currencySymbols = new Set(['$', '€', '£', '¥', '₹']);
  const tokens = str.split(/\s+/g).filter(Boolean);
  const converted = tokens.map(tok => convertToken(tok, 'digit', { fieldKey, magicType, learningEnabled }).text);
  const joined = converted.join(' ');
    let out = '';
    const isDigit = ch => ch >= '0' && ch <= '9';
    const isDecimalPunct = ch => ch === '.' || ch === ',';
    const prevNonSpace = (idx, s) => {
      for(let i=idx;i>=0;i--){
        if(s[i] !== ' ') return s[i];
      }
      return '';
    };
    const nextNonSpace = (idx, s) => {
      for(let i=idx;i<s.length;i++){
        if(s[i] !== ' ') return s[i];
      }
      return '';
    };
    for(let i=0;i<joined.length;i++){
      const ch = joined[i];
      const prev = i>0 ? joined[i-1] : '';
      const next = i<joined.length-1 ? joined[i+1] : '';
      const prevNs = prevNonSpace(i-1, joined);
      const nextNs = nextNonSpace(i+1, joined);
      const prevCurrencyOrDigit = isDigit(prevNs) || currencySymbols.has(prevNs);
      const nextLooksNumeric = isDigit(nextNs) || isDecimalPunct(nextNs);
      if(ch === 'I' || ch === 'l'){
        let shouldConvert = false;
        if(i === 0){
          const ahead = nextNonSpace(1, joined);
          if(isDigit(ahead) || isDecimalPunct(ahead)) shouldConvert = true;
          else if(currencySymbols.has(ahead)){
            const afterCurrency = nextNonSpace(joined.indexOf(ahead, i+1) + 1, joined);
            if(isDigit(afterCurrency)) shouldConvert = true;
          }
        }
        if(!shouldConvert && prevCurrencyOrDigit && nextLooksNumeric) shouldConvert = true;
        if(!shouldConvert && isDigit(prev) && isDigit(next)) shouldConvert = true;
        if(!shouldConvert && isDigit(prev) && isDecimalPunct(next)) shouldConvert = true;
        if(!shouldConvert && isDecimalPunct(next) && isDigit(joined[i+2]||'')) shouldConvert = true;
        out += shouldConvert ? '1' : ch;
        continue;
      }
      if(ch === 'O'){
        if((isDigit(prev) && isDigit(next)) || (prevCurrencyOrDigit && isDigit(nextNs))) {
          out += '0';
          continue;
        }
      }
      if(ch === 'T'){
        if(prevCurrencyOrDigit && nextLooksNumeric) {
          out += '7';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  function contextSignature(token='', idx=0){
    const prev = token[idx-1] || '';
    const next = token[idx+1] || '';
    const prevIsDigit = /[0-9]/.test(prev);
    const nextIsDigit = /[0-9]/.test(next);
    const prevIsLetter = /[A-Za-z]/.test(prev);
    const nextIsLetter = /[A-Za-z]/.test(next);
    const atStart = idx === 0;
    const atEnd = idx === token.length - 1;
    const short = token.length <= 3;
    const long = token.length >= 8;
    return [prevIsDigit, nextIsDigit, prevIsLetter, nextIsLetter, atStart, atEnd, short, long].map(v => v ? '1' : '0').join('');
  }

  function tokenShapeSignature(token=''){
    return token.split('').map(ch => {
      if(/[A-Za-z]/.test(ch)) return 'L';
      if(/[0-9]/.test(ch)) return '#';
      return 'P';
    }).join('');
  }

  function shouldAvoidPair(ftype, pairKey, sig){
    const p = ensurePattern(ftype);
    const bucket = p.avoid[pairKey] || {};
    return (bucket[sig] || 0) >= WRONG_EVENT_THRESHOLD;
  }

  function recordWrongEvent(ftype, pairKey, sig){
    const p = ensurePattern(ftype);
    const bucket = p.avoid[pairKey] || (p.avoid[pairKey] = {});
    bucket[sig] = (bucket[sig] || 0) + 1;
    ocrMagicDebug({
      event: 'ocrmagic.wrongEvent',
      fieldKey: ftype || 'UNKNOWN',
      pairKey,
      context: sig,
      count: bucket[sig],
      threshold: WRONG_EVENT_THRESHOLD
    });
  }

  function dominantPosShape(ftype, slot){
    const p = ensurePattern(ftype);
    const slotData = p.posTemplates?.[slot];
    if(!slotData) return null;
    const sorted = Object.entries(slotData).sort((a,b)=>b[1]-a[1]);
    return sorted[0]?.[0] || null;
  }

  function learnPosTemplates(ftype, tokens=[]){
    if(!tokens.length) return;
    const p = ensurePattern(ftype);
    POSITION_SLOTS.forEach(slot => { if(!p.posTemplates[slot]) p.posTemplates[slot] = {}; });
    const shapes = [
      { slot:'first', token: tokens[0] },
      { slot:'second', token: tokens[1] },
      { slot:'secondLast', token: tokens[tokens.length-2] },
      { slot:'last', token: tokens[tokens.length-1] }
    ];
    shapes.forEach(({slot, token}) => {
      if(!token) return;
      const sig = tokenShapeSignature(token);
      const bucket = p.posTemplates[slot];
      bucket[sig] = (bucket[sig] || 0) + 1;
    });
  }

  function formatGuard(original='', candidate=''){
    const upper = original.toUpperCase();
    if(FIXED_WORDS.has(upper) && upper !== candidate.toUpperCase()) return true;
    const money = /^\$?[0-9][0-9,]*([.][0-9]{2})?$/;
    if(money.test(original) && !money.test(candidate)) return true;
    const postal = /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i;
    if(postal.test(original) && !postal.test(candidate)) return true;
    return false;
  }

  function convertToken(token='', expectation='neutral', { fieldKey='', magicType=MAGIC_DATA_TYPE.ANY, silent=false, learningEnabled=true }={}){
    const chars = token.split('');
    const usedPairs = [];
    const usedContexts = [];
    const pairKeyOf = (from, to) => `${from}->${to}`;
    const shouldFavorDigits = expectation === 'digit';
    const shouldFavorLetters = expectation === 'letter';
    const neutral = expectation === 'neutral';
    CONFUSION_PAIRS.forEach(pair => {
      chars.forEach((ch, idx) => {
        if(ch !== pair.letter && ch !== pair.digit) return;
        const sig = contextSignature(token, idx);
        let target = ch;
        if(shouldFavorDigits){
          target = pair.digit;
        } else if(shouldFavorLetters){
          target = pair.letter;
        } else if(neutral){
          const digitNeighbors = /[0-9]/.test(token[idx-1]||'') || /[0-9]/.test(token[idx+1]||'');
          const letterNeighbors = /[A-Za-z]/.test(token[idx-1]||'') || /[A-Za-z]/.test(token[idx+1]||'');
          if(digitNeighbors && !letterNeighbors) target = pair.digit;
          else if(letterNeighbors && !digitNeighbors) target = pair.letter;
        }
        if(target === ch) return;
        const key = pairKeyOf(ch, target);
        if(!silent && learningEnabled && shouldAvoidPair(fieldKey, key, sig)){
          logAvoidSuppression({ ftype: fieldKey, pairKey: key, sig, phase: 'token-convert' });
          return;
        }
        chars[idx] = target;
        usedPairs.push(key);
        usedContexts.push(sig);
      });
    });
    const preCollapseText = chars.join('');
    const favorDigitsByMagic = magicType === MAGIC_DATA_TYPE.NUMERIC;
    const favorLettersByMagic = magicType === MAGIC_DATA_TYPE.TEXT;
    const shouldCollapseRepeats = magicType === MAGIC_DATA_TYPE.TEXT;
    if(shouldCollapseRepeats){
      const pairByChar = new Map();
      CONFUSION_PAIRS.forEach(pair => {
        pairByChar.set(pair.letter, pair);
        pairByChar.set(pair.digit, pair);
      });
      const collapsed = [];
      let i = 0;
      while(i < chars.length){
        const ch = chars[i];
        const pair = pairByChar.get(ch);
        if(!pair){
          collapsed.push(ch);
          i++;
          continue;
        }
        let j = i + 1;
        while(j < chars.length && pairByChar.get(chars[j]) === pair){ j++; }
        const runLength = j - i;
        const runHasLetter = chars.slice(i, j).some(ch => /[A-Za-z]/.test(ch));
        const runHasDigit = chars.slice(i, j).some(ch => /[0-9]/.test(ch));
        const target = favorDigitsByMagic ? pair.digit : (favorLettersByMagic ? pair.letter : null);
        if(runLength > 1 && target && runHasLetter && runHasDigit){
          let blocked = false;
          for(let k=i;k<j;k++){
            const origCh = chars[k];
            const key = pairKeyOf(origCh, target);
            const sig = contextSignature(token, k);
            if(origCh !== target){
              if(!silent && learningEnabled && shouldAvoidPair(fieldKey, key, sig)){
                logAvoidSuppression({ ftype: fieldKey, pairKey: key, sig, phase: 'repeat-collapse' });
                blocked = true; break;
              }
            }
          }
          if(!blocked){
            for(let k=i;k<j;k++){
              const origCh = chars[k];
              const key = pairKeyOf(origCh, target);
              const sig = contextSignature(token, k);
              usedPairs.push(key);
              usedContexts.push(sig);
            }
            collapsed.push(target);
          } else {
            for(let k=i;k<j;k++) collapsed.push(chars[k]);
          }
        } else {
          collapsed.push(ch);
        }
        i = j;
      }
      chars.splice(0, chars.length, ...collapsed);
    }
    const text = chars.join('');
    const hasDigits = /[0-9]/.test(text);
    const hasLetters = /[A-Za-z]/.test(text);
    const magicMismatch = (magicType === MAGIC_DATA_TYPE.NUMERIC && hasLetters)
      || (magicType === MAGIC_DATA_TYPE.TEXT && hasDigits);
    return {
      text,
      usedPairs,
      usedContexts,
      magicMismatch,
      collapseChanged: preCollapseText !== text,
      collapseBefore: preCollapseText,
      collapseAfter: text
    };
  }

  function enforceNumericIntegrity(text=''){
    const map = new Map([
      ['O','0'],['o','0'],['I','1'],['l','1'],['T','7'],['S','5'],['B','8']
    ]);
    const mapped = text.split('').map(ch => map.get(ch) || ch).join('');
    return mapped.replace(/[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  }

  function scoreVariant({ text, expectation, slotShape, magicType, original }){
    let score = 0;
    const digitCount = (text.match(/[0-9]/g) || []).length;
    const letterCount = (text.match(/[A-Za-z]/g) || []).length;
    const hasDigits = digitCount > 0;
    const hasLetters = letterCount > 0;
    if(magicType === MAGIC_DATA_TYPE.NUMERIC){
      score += hasLetters ? -3 : 4;
    } else if(magicType === MAGIC_DATA_TYPE.TEXT){
      score += hasDigits ? -3 : 3;
    } else {
      if(hasDigits && hasLetters) score += 1;
      if(hasDigits && !hasLetters && /[A-Za-z]/.test(original) && original.replace(/[^A-Za-z]/g,'').length > (original.match(/[0-9]/g)||[]).length){
        score -= 1;
      }
    }
    if(expectation === 'digit' && hasDigits) score += 1;
    if(expectation === 'letter' && hasLetters) score += 1;
    if(slotShape){
      const candShape = tokenShapeSignature(text);
      score += candShape === slotShape ? 1 : -1;
    }
    if(formatGuard(original, text)) score -= 5;
    return score;
  }

  function applyOcrMagic(rawText='', { fieldKey='', magicType=MAGIC_DATA_TYPE.ANY, spanKey, mode, profileType, archetype, learningEnabled=true, magicTypeSource='inferred', layer1RulesApplied=[] }={}){
    const tokens = String(rawText || '').split(/\s+/g).filter(Boolean);
    const positionalShapes = POSITION_SLOTS.reduce((acc, slot) => ({ ...acc, [slot]: dominantPosShape(fieldKey, slot) }), {});
    const correctedTokens = [];
    const correctionsApplied = [];
    const numericTokens = [];
    let repeatCollapsed = false;

    ocrMagicDebug({
      event: 'ocrmagic.learning.gate',
      fieldKey: fieldKey || 'UNKNOWN',
      magicDataType: magicType || 'UNSET',
      learningEnabled: !!learningEnabled,
      magicTypeSource,
      mode: mode || state.mode || ModeEnum.RUN
    });

    tokens.forEach((token, idx) => {
      const digits = (token.match(/[0-9]/g) || []).length;
      const letters = (token.match(/[A-Za-z]/g) || []).length;
      const expectation = magicType === MAGIC_DATA_TYPE.NUMERIC ? 'digit'
        : magicType === MAGIC_DATA_TYPE.TEXT ? 'letter'
        : (()=>{
            if(digits > letters) return 'digit';
            if(letters > digits) return 'letter';
            return 'neutral';
          })();
      const slot = idx === 0 ? 'first' : idx === 1 ? 'second' : (idx === tokens.length - 1 ? 'last' : (idx === tokens.length - 2 ? 'secondLast' : null));
      const slotShape = slot ? positionalShapes[slot] : null;
      const variants = [];
      const seen = new Set();
      const addVariant = (exp) => {
        if(seen.has(exp)) return;
        seen.add(exp);
        variants.push({ ...convertToken(token, exp, { fieldKey, magicType, learningEnabled }), expectation: exp, original: token, slotShape });
      };
      addVariant('neutral');
      if(magicType === MAGIC_DATA_TYPE.NUMERIC){
        addVariant('digit');
      } else if(magicType === MAGIC_DATA_TYPE.TEXT){
        addVariant('letter');
      } else {
        addVariant(expectation);
        if(digits > 0 && digits >= letters) addVariant('digit');
        if(letters > 0) addVariant('letter');
      }
      variants.forEach(v => { v.score = scoreVariant({ text: v.text, expectation: v.expectation, slotShape, magicType, original: token }); });
      const best = variants.reduce((a,b)=> b.score > a.score ? b : a, variants[0]);
      correctedTokens.push(best.text);
      numericTokens.push(convertToken(token, 'digit', { fieldKey, magicType, silent:true, learningEnabled }).text);
      if(best.text !== token){
        best.usedPairs.forEach((pair, i)=> correctionsApplied.push({ pair, context: best.usedContexts[i], from: token, to: best.text, index: idx }));
      }
      if(best.collapseChanged){
        repeatCollapsed = true;
        if(spanKey){
          traceEvent(spanKey,'ocrmagic.repeatCollapse',{
            from: best.collapseBefore,
            to: best.collapseAfter,
            expectation: best.expectation,
            magicType,
            stageLabel:'Repeat collapse',
            stepNumber:3,
            counts:{ tokens: tokens.length },
            heuristics:{ repeatCollapsed:true },
            notes:'Collapsed repeated characters during OCR magic token cleanup'
          });
        }
      }
      const bestScore = best.score;
      variants.forEach(v => {
        if(v === best) return;
        if(learningEnabled && v.usedPairs?.length && v.magicMismatch && bestScore > v.score){
          v.usedPairs.forEach((pair, i)=> recordWrongEvent(fieldKey, pair, v.usedContexts[i]));
        }
      });
    });
    let cleaned = correctedTokens.join(' ').trim();
    let numericCandidate = numericTokens.join(' ').trim();
    const appliedProfileType = profileType || getActiveProfileType();
    const appliedArchetype = archetype || 'UNKNOWN';
    const baseRules = Array.isArray(layer1RulesApplied) ? layer1RulesApplied : [];
    const rulesApplied = [...baseRules];
    if(magicType === MAGIC_DATA_TYPE.NUMERIC){
      rulesApplied.push('numeric-only-field');
      const digitSafe = correctedTokens.map(tok => convertToken(tok, 'digit', { fieldKey, magicType, learningEnabled }).text);
      const enforced = enforceNumericIntegrity(digitSafe.join(' '));
      if(enforced !== cleaned){
        rulesApplied.push('numeric-letter-strip');
        cleaned = enforced;
      }
      numericCandidate = enforced;
    }
    else if(magicType === MAGIC_DATA_TYPE.TEXT) rulesApplied.push('text-only-field');
    if(correctionsApplied.length) rulesApplied.push('token-substitution');
    if(repeatCollapsed) rulesApplied.push('repeat-collapse');
    if(spanKey) traceEvent(spanKey,'ocrmagic',{
      magicType,
      cleaned,
      tokens: correctedTokens,
      stageLabel:'OCR magic apply',
      stepNumber:3,
      counts:{ tokens: correctedTokens.length, numericTokens: numericTokens.length },
      heuristics:{ repeatCollapsed, rulesApplied },
      inputsSnapshot:{ cleanedPreview: cleaned.slice(0,120) }
    });
    ocrMagicDebug({
      event: 'ocrmagic.apply',
      mode: mode || state.mode || ModeEnum.RUN,
      profileType: appliedProfileType,
      fieldKey: fieldKey || 'UNKNOWN',
      magicDataType: magicType || 'UNSET',
      magicTypeSource,
      archetype: appliedArchetype,
      raw: rawText,
      cleaned,
      rulesApplied
    });
    return { value: cleaned, corrections: correctionsApplied, tokens: correctedTokens, numericCandidate, rulesApplied };
  }

  function learn(ftype, value){
    if(!value) return;
    const p = ensurePattern(ftype);
    const c = codeOf(value);
    const s = shapeOf(value);
    const l = value.length;
    const d = digitRatio(value).toFixed(2);
    p.code[c] = (p.code[c] || 0) + 1;
    p.shape[s] = (p.shape[s] || 0) + 1;
    p.len[l] = (p.len[l] || 0) + 1;
    p.digit[d] = (p.digit[d] || 0) + 1;
  }

  function dominant(ftype){
    const p = ensurePattern(ftype);
    const maxKey = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1])[0]?.[0];
    return { code: maxKey(p.code), shape: maxKey(p.shape), len: +maxKey(p.len), digit: parseFloat(maxKey(p.digit)) };
  }

  function clean(ftype, input, mode='RUN', spanKey){
    const arr = Array.isArray(input) ? input : [{text:String(input||'')}];
    const lineStrs = Array.isArray(input) ? groupIntoLines(arr).map(L=>L.tokens.map(t=>t.text).join(' ').trim()) : [String(input||'')];
    const raw = lineStrs.join(' ').trim();
    const tokenCount = lineStrs.join(' ').split(/\s+/g).filter(Boolean).length;
    if(spanKey) traceEvent(spanKey,'clean.start',{
      raw,
      stageLabel:'Clean start',
      stepNumber:2,
      counts:{ lines: lineStrs.length, tokens: tokenCount },
      inputsSnapshot:{ raw }
    });
    const baseResult = runBaseOcrMagic(raw);
    const baseCleaned = typeof baseResult === 'string' ? baseResult : (baseResult?.cleaned ?? String(raw ?? ''));
    const layer1RulesApplied = Array.isArray(baseResult?.rulesApplied) ? baseResult.rulesApplied : [];
    let txt = baseCleaned.replace(/\s+/g,' ').trim().replace(/[#:—•]*$/, '');
    const magicTypeInfo = resolveMagicDataType(ftype);
    const magicType = magicTypeInfo.magicType;
    const profileEntry = getProfileFieldEntry(ftype);
    const archetype = profileEntry?.archetype || profileEntry?.kind || profileEntry?.type || null;
    const profileType = getActiveProfileType();
    const magic = applyOcrMagic(txt, { fieldKey: ftype, magicType, spanKey, mode, profileType, archetype, learningEnabled: magicTypeInfo.isExplicit, magicTypeSource: magicTypeInfo.source, layer1RulesApplied });
    txt = magic.value || txt;
    let correctionsApplied = magic.corrections || [];
    const magicTokens = magic.tokens || txt.split(/\s+/g).filter(Boolean);
    const numericCandidate = magic.numericCandidate || txt;
    let invalidReason = null;
    let validity = 'ok';
    let warningOnly = false;
    const warnings = [];
    let hardInvalid = false;
    const flagWarning = (reason) => {
      if(reason){
        invalidReason = invalidReason || reason;
        warnings.push(reason);
      }
      validity = 'warning';
      warningOnly = true;
    };
    const flagInvalid = (reason) => {
      if(reason){
        invalidReason = invalidReason || reason;
        warnings.push(reason);
      }
      validity = 'invalid';
      hardInvalid = true;
    };
    const isLikelyDateText = (text) => /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(text) || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text);
    if(/date/i.test(ftype)){ const n=normalizeDate(txt); if(n) txt=n; }
    else if(/total|subtotal|tax|amount|price|balance|deposit|discount|unit|grand|quantity|qty/.test(ftype)){
      // Normalize common OCR digit confusions (e.g., $I3999 -> 13999.00) before stripping non-numeric chars.
      const digitSafe = normalizeOcrDigits(numericCandidate, { fieldKey: ftype, magicType, learningEnabled: magicTypeInfo.isExplicit });
      const n=digitSafe.replace(/[^0-9.-]/g,''); const num=parseFloat(n); if(!isNaN(num)) txt=num.toFixed(/unit|price|amount|total|tax|subtotal|grand/.test(ftype)?2:0);
    } else if(/sku|product_code/.test(ftype)){
      txt = txt.replace(/\s+/g,'').toUpperCase();
      const sanitized = txt.replace(/[^A-Z0-9\-_.\/]/g,'');
      const upperRaw = raw.toUpperCase();
      const digitsSeparatorsOnly = /^[0-9\s:\/\-.]+$/.test(upperRaw);
      const slashCount = (upperRaw.match(/\//g)||[]).length;
      const dashCount = (upperRaw.match(/-/g)||[]).length;
      const colonCount = (upperRaw.match(/:/g)||[]).length;
      const hasTime = /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(upperRaw);
      const hasMonthWord = /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/.test(upperRaw);
      const isoDate = /\b(?:19|20)\d{2}[\/-]\d{1,2}[\/-]\d{1,2}\b/.test(upperRaw);
      const euroDate = /\b\d{1,2}[\/-]\d{1,2}[\/-](?:19|20)\d{2}\b/.test(upperRaw);
      const containsAlpha = /[A-Z]/.test(sanitized);
      const looksLikeDate = digitsSeparatorsOnly && (isoDate || euroDate);
      const looksLikeTimestamp = digitsSeparatorsOnly && hasTime && (slashCount || dashCount || colonCount >= 2);
      const mixedSlashColon = digitsSeparatorsOnly && slashCount && colonCount;
      if(hasMonthWord || looksLikeTimestamp || (looksLikeDate && !containsAlpha) || mixedSlashColon){
        flagWarning('looks_like_date');
      }
      txt = sanitized;
    }
    if(magicType === MAGIC_DATA_TYPE.NUMERIC && isLikelyDateText(raw || '')){
      flagWarning('type_mismatch_date_like');
    }
    const confBase = arr.reduce((s,t)=>s+(t.confidence||1),0)/arr.length;
    let conf = confBase;
    if(validity === 'warning'){
      conf = conf * 0.82;
    }
    const code = codeOf(txt);
    const shape = shapeOf(txt);
    const digit = digitRatio(txt);
    const before = dominant(ftype);
    const fingerprintMatch = !hardInvalid && (!before.code || before.code === code);
    const shouldLearn = !hardInvalid && validity !== 'warning' && (mode === 'CONFIG' || magicTypeInfo.isExplicit || fingerprintMatch);
    if(shouldLearn){
      learn(ftype, txt);
      learnPosTemplates(ftype, magicTokens);
    }
    const dom = shouldLearn ? dominant(ftype) : before;
    const isValidValue = !hardInvalid;
    let score=0;
    if(!hardInvalid && dom.code && dom.code===code) score++;
    if(!hardInvalid && dom.shape && dom.shape===shape) score++;
    if(!hardInvalid && dom.len && dom.len===txt.length) score++;
    if(!hardInvalid && dom.digit && Math.abs(dom.digit-digit)<0.01) score++;
    if(spanKey) traceEvent(spanKey,'clean.success',{
      value:txt,
      score,
      isValid: isValidValue,
      invalidReason,
      magicType,
      stageLabel:'Clean success',
      stepNumber:4,
      confidence:{ score, isValid: isValidValue, fingerprintMatch },
      heuristics:{ magicType },
      notes: invalidReason ? `invalid:${invalidReason}` : null
    });
    if(state.mode === ModeEnum.RUN && staticDebugEnabled() && isStaticFieldDebugTarget(spanKey?.fieldKey || ftype)){
      const expectedCode = getDominantFingerprintCode(ftype, spanKey?.fieldKey || ftype);
      const fingerprintOk = fingerprintMatches(ftype, code, mode, spanKey?.fieldKey, { enabled:false, fieldKey: spanKey?.fieldKey || ftype, cleanedValue: txt });
      logStaticDebug(
        `field=${spanKey?.fieldKey || ftype || ''} cleaned="${txt}" code=${code || '<none>'} expected=${expectedCode || '<none>'} -> fingerprintOk=${fingerprintOk}`,
        { field: spanKey?.fieldKey || ftype, cleaned: txt, code, expected: expectedCode, fingerprintOk }
      );
    }
    return {
      value: hardInvalid ? '' : txt,
      raw: hardInvalid ? '' : raw,
      rawOriginal: raw,
      corrected: txt,
      conf,
      code,
      shape,
      score,
      correctionsApplied,
      digit,
      fingerprintMatch,
      isValid: isValidValue,
      invalidReason,
      validity,
      warnings
    };
  }

  function exportPatterns(){ return patterns; }
  function importPatterns(p, ctx = {}){
    Object.keys(patterns).forEach(k => delete patterns[k]);
    if(!p || typeof p !== 'object'){
      ocrMagicDebug({ event: 'ocrmagic.patterns.import', importedKeys: [], count: 0, source: ctx.source || null, uri: ctx.uri || ctx.path || null, version: ctx.version ?? null });
      return;
    }
    for(const [key, data] of Object.entries(p)){
      if(data && typeof data === 'object'){
        patterns[key] = clonePlain(data);
        ensurePattern(key);
      }
    }
    const importedKeys = Object.keys(patterns);
    ocrMagicDebug({
      event: 'ocrmagic.patterns.import',
      importedKeys,
      count: importedKeys.length,
      source: ctx.source || null,
      uri: ctx.uri || ctx.path || null,
      version: ctx.version ?? null
    });
  }

  return { codeOf, shapeOf, digitRatio, clean, exportPatterns, importPatterns, dominant };
})();

function mostCommonKey(counts){
  if(!counts || typeof counts !== 'object') return null;
  let bestKey = null;
  let bestCount = -Infinity;
  for(const [key, value] of Object.entries(counts)){
    const num = Number(value) || 0;
    if(num > bestCount){
      bestKey = key;
      bestCount = num;
    }
  }
  return bestKey;
}

function getProfileFieldEntry(fieldKey){
  if(!fieldKey || !state.profile?.fields) return null;
  return state.profile.fields.find(f => f.fieldKey === fieldKey) || null;
}

function isStaticFieldDebugTarget(fieldKey){
  if(!staticDebugEnabled()) return false;
  if(!fieldKey) return true;
  const entry = getProfileFieldEntry(fieldKey);
  return !entry || entry.type !== 'column';
}

function getDominantFingerprintCode(ftype, profileKey){
  const dom = ftype ? FieldDataEngine.dominant(ftype) : null;
  if(dom?.code) return dom.code;
  if(profileKey && profileKey !== ftype){
    const altDom = FieldDataEngine.dominant(profileKey);
    if(altDom?.code) return altDom.code;
  }
  const searchKeys = [];
  if(profileKey) searchKeys.push(profileKey);
  if(ftype && !searchKeys.includes(ftype)) searchKeys.push(ftype);
  for(const key of searchKeys){
    const entry = getProfileFieldEntry(key);
    if(!entry?.fingerprints || typeof entry.fingerprints !== 'object') continue;
    const fp = entry.fingerprints;
    if(fp.code && typeof fp.code === 'object'){
      const best = mostCommonKey(fp.code);
      if(best) return best;
    }
    const direct = fp[key];
    if(direct && typeof direct === 'object' && direct.code){
      const best = mostCommonKey(direct.code);
      if(best) return best;
    }
    for(const value of Object.values(fp)){
      if(value && typeof value === 'object' && value.code){
        const best = mostCommonKey(value.code);
        if(best) return best;
      }
    }
  }
  return null;
}

function fingerprintMatches(ftype, code, mode = state.mode, profileKey, debugCtx=null){
  if(mode === 'CONFIG') return true;
  const expected = getDominantFingerprintCode(ftype, profileKey);
  if(!expected) return true;
  if(typeof code !== 'string') return false;
  const ok = code === expected;
  if(staticDebugEnabled() && debugCtx?.enabled){
    logStaticDebug(
      `field=${debugCtx.fieldKey||ftype||''} fingerprint code=${code||'<none>'} expected=${expected} -> fingerprintOk=${ok}`,
      { field: debugCtx.fieldKey || ftype, cleaned: debugCtx.cleanedValue, code, expected, fingerprintOk: ok }
    );
  }
  return ok;
}

function collectPersistedFingerprints(profile){
  const out = {};
  if(!profile?.fields) return out;
  for(const field of profile.fields){
    const prints = field?.fingerprints;
    if(!prints || typeof prints !== 'object') continue;
    if(prints.code || prints.shape || prints.len || prints.digit){
      out[field.fieldKey] = clonePlain(prints);
      continue;
    }
    for(const [key, data] of Object.entries(prints)){
      if(data && typeof data === 'object'){
        out[key] = clonePlain(data);
      }
    }
  }
  return out;
}

function hydrateFingerprintsFromProfile(profile){
  const docType = profile?.docType || state.docType || 'invoice';
  const wizardId = profile?.wizardId || currentWizardId();
  const geometryId = profile?.geometryId || state.activeGeometryId || null;
  const logPatternDiag = (source, importedCount, extra={})=>{
    if(state.mode !== ModeEnum.RUN) return;
    const exported = FieldDataEngine.exportPatterns ? FieldDataEngine.exportPatterns() : {};
    const keys = exported && typeof exported === 'object' ? Object.keys(exported) : [];
    console.info('[run-mode][diag] pattern import', {
      source,
      importedCount,
      keys,
      docType,
      wizardId,
      geometryId,
      fieldCount: extra.fieldCount ?? null,
      cachedCount: extra.cachedCount ?? null
    });
  };
  if(isSkinV2){
    const cached = readPatternBundleFromCache(docType, wizardId, geometryId || null);
    if(cached?.bundle){
      const cachedCount = cached.bundle.patterns && typeof cached.bundle.patterns === 'object' ? Object.keys(cached.bundle.patterns).length : 0;
      const imported = cachedCount ? importPatternBundle(cached.bundle, { source: 'cache', uri: cached.key }) : 0;
      if(imported > 0){
        logPatternDiag('cache', imported, { fieldCount: Array.isArray(profile?.fields) ? profile.fields.length : null, cachedCount });
        // If the bundle is missing entries for fields, backfill from profile fingerprints.
        const fieldCount = Array.isArray(profile?.fields) ? profile.fields.length : 0;
        if(imported < fieldCount){
          const tallies = collectPersistedFingerprints(profile);
          if(Object.keys(tallies).length){
            FieldDataEngine.importPatterns(tallies, { source: 'profile.fingerprints.backfill', version: profile?.version || null });
            persistPatternBundle(profile, { patterns: { ...cached.bundle.patterns, ...tallies } });
            logPatternDiag('profile.fingerprints.backfill', Object.keys(tallies).length, { fieldCount, cachedCount: imported });
          }
        }
        refreshPatternBundleFromRemote(profile);
        return;
      }
    }
  }
  const tallies = collectPersistedFingerprints(profile);
  const tallyCount = Object.keys(tallies).length;
  if(tallyCount){
    FieldDataEngine.importPatterns(tallies, { source: 'profile.fingerprints', version: profile?.version || null });
    logPatternDiag('profile.fingerprints', tallyCount, { fieldCount: Array.isArray(profile?.fields) ? profile.fields.length : null });
    if(isSkinV2 && profile){
      persistPatternBundle(profile, { patterns: tallies });
    }
  }
  if(isSkinV2){
    refreshPatternBundleFromRemote(profile);
  }
}

function groupIntoLines(tokens, tol=4){
  const sorted = [...tokens].sort((a,b)=> (a.y + a.h/2) - (b.y + b.h/2));
  const lines = [];
  for(const t of sorted){
    const cy = t.y + t.h/2;
    const line = lines.find(L => Math.abs(L.cy - cy) <= tol && L.page === t.page);
    if(line){ line.tokens.push(t); line.cy = (line.cy*line.tokens.length + cy)/(line.tokens.length+1); }
    else lines.push({page:t.page, cy, tokens:[t]});
  }
  lines.forEach(L => L.tokens.sort((a,b)=>a.x-b.x));
  return lines;
}
function tokensInBox(tokens, box, opts={}){
  const { minOverlap, minContainFraction=null, boxPad=0 } = opts || {};
  if(!box) return [];
  const padded = boxPad ? { x: box.x - boxPad, y: box.y - boxPad, w: box.w + boxPad*2, h: box.h + boxPad*2, page: box.page } : box;
  return tokens.filter(t => {
    if(t.page !== padded.page) return false;
    const overlapX = Math.min(t.x + t.w, padded.x + padded.w) - Math.max(t.x, padded.x);
    const overlapY = Math.min(t.y + t.h, padded.y + padded.h) - Math.max(t.y, padded.y);
    if(overlapX <= 0 || overlapY <= 0) return false;
    const overlapArea = overlapX * overlapY;
    const containFraction = overlapArea / (t.w * t.h);
    if(minContainFraction !== null && containFraction < minContainFraction) return false;
    const needOverlap = typeof minOverlap === 'number'
      ? minOverlap
      : (isConfigMode() ? 0.5 : 0.7);
    if(overlapY / t.h < needOverlap) return false;
    if(minContainFraction === null){
      const cx = t.x + t.w/2;
      if(cx < padded.x || cx > padded.x + padded.w) return false;
    }
    return true;
  }).sort((a,b)=>{
    const ay = a.y + a.h/2, by = b.y + b.h/2;
    return ay === by ? a.x - b.x : ay - by;
  });
}
function lineBounds(line){
  const xs = line.tokens.map(t=>t.x), ys = line.tokens.map(t=>t.y);
  const x2s = line.tokens.map(t=>t.x + t.w), y2s = line.tokens.map(t=>t.y + t.h);
  const left = Math.min(...xs), right = Math.max(...x2s);
  const top = Math.min(...ys), bottom = Math.max(...y2s);
  return { left, right, top, bottom, width: right-left, height: bottom-top, cy: line.cy, page: line.page, tokens: line.tokens };
}

function normalizeKeywordText(text){
  return (text || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeTokenBounds(tokens){
  if(!Array.isArray(tokens) || !tokens.length) return null;
  const xs = tokens.map(t=>t.x);
  const ys = tokens.map(t=>t.y);
  const x2s = tokens.map(t=>t.x + t.w);
  const y2s = tokens.map(t=>t.y + t.h);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...x2s) - Math.min(...xs),
    h: Math.max(...y2s) - Math.min(...ys),
    page: tokens[0]?.page
  };
}

function normalizeBBoxForPage(box, pageW, pageH){
  if(!box || !pageW || !pageH) return null;
  return {
    x: box.x / pageW,
    y: box.y / pageH,
    w: box.w / pageW,
    h: box.h / pageH,
    page: box.page
  };
}

function median(nums=[]){
  if(!nums.length) return 0;
  const sorted = nums.slice().sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
}

function summarizeLineMetrics(lines=[]){
  const heights = (lines||[]).map(L => L?.height ?? (L?.bottom ?? 0) - (L?.top ?? 0)).filter(h => Number.isFinite(h) && h > 0);
  const lineCount = (lines||[]).length;
  if(!heights.length) return { lineCount, lineHeights: { min:0, max:0, median:0 } };
  return {
    lineCount,
    lineHeights: {
      min: Math.min(...heights),
      max: Math.max(...heights),
      median: median(heights)
    }
  };
}
function selectLinesForStatic(lines, hintPx, { multiline=false }={}){
  if(!hintPx) return [];
  const containFraction = 0.75;
  const verticalPad = 2;
  const paddedBox = { x: hintPx.x, y: hintPx.y - verticalPad, w: hintPx.w, h: hintPx.h + verticalPad*2, page: hintPx.page };
  const scored = lines
    .filter(L => L.page === paddedBox.page)
    .map(L => {
      const insideTokens = tokensInBox(L.tokens, paddedBox, { minContainFraction: containFraction });
      const coverage = insideTokens.length / Math.max(1, L.tokens.length);
      const cy = (L.top + L.bottom) / 2;
      return { line: L, insideTokens, coverage, cy };
    })
    .filter(entry => entry.insideTokens.length && entry.coverage >= 0.5)
    .filter(entry => (entry.line.bottom > paddedBox.y) && (entry.line.top < paddedBox.y + paddedBox.h))
    .sort((a,b)=> a.line.top - b.line.top || a.line.left - b.line.left);
  if(!scored.length) return [];
  if(!multiline){
    const cy = paddedBox.y + paddedBox.h/2;
    let best = scored[0];
    let bestScore = Infinity;
    for(const entry of scored){
      const dy = Math.abs(entry.cy - cy);
      const score = dy + (1 - entry.coverage) * 20;
      if(score < bestScore){ bestScore = score; best = entry; }
    }
    return best ? [best] : [];
  }
  const anchor = scored.find(entry => entry.cy >= paddedBox.y && entry.cy <= paddedBox.y + paddedBox.h) || scored[0];
  const ordered = scored.filter(entry => entry.line.top >= anchor.line.top);
  const maxGap = Math.max(4, Math.min(anchor.line.height * 0.6, 12));
  const selected = [anchor];
  let prev = anchor;
  for(const entry of ordered){
    if(entry === anchor) continue;
    if(entry.line.top - prev.line.bottom <= maxGap){ selected.push(entry); prev = entry; }
  }
  return selected.sort((a,b)=> a.line.top - b.line.top || a.line.left - b.line.left);
}
function snapStaticToLines(tokens, hintPx, opts={}){
  const { multiline=false, marginPx=4 } = opts || {};
  const containFraction = 0.75;
  const verticalPad = 2;
  const lines = groupIntoLines(tokens, 4).map(lineBounds);
  const selected = selectLinesForStatic(lines, hintPx, { multiline });
  if(!selected.length){
    const fallback = snapToLine(tokens, hintPx, marginPx, { ...opts, minContainFraction: containFraction, boxPad: verticalPad, skipConfigUnion: true });
    const metrics = summarizeLineMetrics([]);
    return { ...fallback, lines: [], lineCount: metrics.lineCount, lineHeights: metrics.lineHeights, lineMetrics: metrics };
  }
  const selectedTokens = selected.flatMap(entry => entry.insideTokens.length ? entry.insideTokens : entry.line.tokens);
  const selectedLines = selected.map(entry => entry.line);
  const left = Math.min(...selectedTokens.map(t=>t.x));
  const right = Math.max(...selectedTokens.map(t=>t.x + t.w));
  const top = Math.min(...selectedTokens.map(t=>t.y));
  const bottom = Math.max(...selectedTokens.map(t=>t.y + t.h));
  let box = { x:left, y:top, w:right-left, h:bottom-top, page:hintPx.page };
  const expanded = { x: box.x - marginPx, y: box.y - marginPx, w: box.w + marginPx*2, h: box.h + marginPx*2, page: hintPx.page };
  let finalBox = expanded;
  if(hintPx && hintPx.w > 0){
    const widthCap = Math.max(hintPx.w + marginPx*2, hintPx.w * 1.05);
    const tokensWidth = right - left;
    const targetWidth = Math.max(Math.min(finalBox.w, widthCap), tokensWidth);
    if(finalBox.w > targetWidth){
      const minLeft = Math.max(finalBox.x, right - targetWidth);
      const maxLeft = Math.min(finalBox.x + finalBox.w - targetWidth, left);
      let newLeft = finalBox.x + (finalBox.w - targetWidth) / 2;
      if(newLeft < minLeft) newLeft = minLeft;
      if(newLeft > maxLeft) newLeft = maxLeft;
      const newRight = newLeft + targetWidth;
      finalBox = { x: newLeft, y: finalBox.y, w: newRight - newLeft, h: finalBox.h, page: finalBox.page };
    }
  }
  const lineTexts = selected.map(entry => (entry.insideTokens.length ? entry.insideTokens : entry.line.tokens).map(t=>t.text).join(' ').trim()).filter(Boolean);
  const text = multiline ? lineTexts.join('\n') : (lineTexts[0] || '');
  const metrics = summarizeLineMetrics(selectedLines);
  return { box: finalBox, text, lines: selectedLines, lineCount: metrics.lineCount, lineHeights: metrics.lineHeights, lineMetrics: metrics };
}
function resolveStaticOverlap(entries){
  const groups = [];
  const overlapX = (a,b)=> Math.max(0, Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x));
  const sameBand = (a,b)=> overlapX(a,b) >= Math.max(4, Math.min(a.box.w, b.box.w) * 0.3);
  const expectedLines = entry => entry?.expectedLineCount ?? entry?.lineMetrics?.lineCount ?? entry?.lineCount ?? (entry?.lines?.length || 0);
  const observedLines = entry => entry?.lines?.length || 0;
  const lineOverlaps = (line, top, bottom) => {
    const lTop = line?.top ?? (line?.cy ?? 0) - (line?.height ?? 0)/2;
    const lBottom = line?.bottom ?? lTop + (line?.height ?? 0);
    return lBottom > top && lTop < bottom;
  };
  const linesInSpan = (entry, top, bottom)=> (entry?.lines||[]).filter(L => lineOverlaps(L, top, bottom));
  const trimBoxToLines = (entry, keepLines=[], pad=0, trimTop=true)=>{
    if(!entry?.box) return;
    const bottomEdge = entry.box.y + entry.box.h;
    if(trimTop){
      const anchor = keepLines[0] || {};
      const targetTop = anchor.top ?? entry.box.y;
      const newTop = clamp(targetTop - pad, entry.box.y, targetTop);
      entry.box.y = newTop;
      entry.box.h = Math.max(1, bottomEdge - entry.box.y);
    } else {
      const anchor = keepLines[keepLines.length-1] || {};
      const targetBottom = anchor.bottom ?? bottomEdge;
      const newBottom = clamp(targetBottom + pad, entry.box.y + 1, bottomEdge);
      entry.box.h = Math.max(1, newBottom - entry.box.y);
    }
    entry.lines = (entry.lines||[]).filter(L => lineOverlaps(L, entry.box.y, entry.box.y + entry.box.h));
  };
  const resolveWithLineCounts = (topEntry, bottomEntry, overlapTop, overlapBottom) => {
    const aExp = expectedLines(topEntry) || 0;
    const bExp = expectedLines(bottomEntry) || 0;
    const aObs = observedLines(topEntry) || 0;
    const bObs = observedLines(bottomEntry) || 0;
    if(!aObs && !bObs) return false;
    const aDiff = Math.abs(aObs - (aExp || aObs));
    const bDiff = Math.abs(bObs - (bExp || bObs));
    if(aDiff === bDiff) return false;
    const winner = aDiff < bDiff ? topEntry : bottomEntry;
    const loser = winner === topEntry ? bottomEntry : topEntry;
    const overlapLinesWinner = linesInSpan(winner, overlapTop, overlapBottom);
    const overlapLinesLoser = linesInSpan(loser, overlapTop, overlapBottom);
    if(!overlapLinesWinner.length || !overlapLinesLoser.length) return false;
    const keepLines = (loser.lines||[]).filter(L => !lineOverlaps(L, overlapTop, overlapBottom));
    if(!keepLines.length) return false;
    const metrics = summarizeLineMetrics(overlapLinesLoser);
    const pad = (metrics?.lineHeights?.median || 0) * 0.35;
    const keepTop = Math.min(...keepLines.map(l=>l.top));
    const keepBottom = Math.max(...keepLines.map(l=>l.bottom));
    const overlapCenter = (overlapTop + overlapBottom)/2;
    const trimTop = overlapCenter <= ((loser.box.y + loser.box.h/2)) || (Math.max(...overlapLinesLoser.map(l=>l.bottom)) <= keepTop);
    const trimBottom = Math.min(...overlapLinesLoser.map(l=>l.top)) >= keepBottom;
    trimBoxToLines(loser, keepLines, pad, trimBottom ? false : trimTop);
    if(staticDebugEnabled()){
      logStaticDebug(
        `overlap-resolve winner=${winner.fieldKey||''} loser=${loser.fieldKey||''} aDiff=${aDiff} bDiff=${bDiff} pad=${pad.toFixed(2)}`,
        { overlapTop, overlapBottom, winner: winner.fieldKey, loser: loser.fieldKey, winnerExpected: expectedLines(winner), winnerObserved: observedLines(winner), loserExpected: expectedLines(loser), loserObserved: observedLines(loser), pad }
      );
    }
    return true;
  };
  for(const entry of entries){
    let group = groups.find(g => g.some(e => sameBand(e, entry)));
    if(group) group.push(entry); else groups.push([entry]);
  }
  const gap = 1;
  for(const group of groups){
    group.sort((a,b)=> (a.box.y) - (b.box.y));
    for(let i=0; i<group.length-1; i++){
      const a = group[i], b = group[i+1];
      const overlapY = (a.box.y + a.box.h) - b.box.y;
      if(overlapY <= 0) continue;
      const overlapTop = b.box.y;
      const overlapBottom = Math.min(a.box.y + a.box.h, b.box.y + b.box.h);
      const resolved = resolveWithLineCounts(a, b, overlapTop, overlapBottom);
      if(resolved) continue;
      const aBottoms = (a.lines||[]).map(L=>L.bottom);
      const bTops = (b.lines||[]).map(L=>L.top);
      const aBottom = Math.max(a.box.y + 1, aBottoms.length ? Math.max(...aBottoms) : (a.box.y + a.box.h));
      const bTop = Math.min(b.box.y + b.box.h - 1, bTops.length ? Math.min(...bTops) : b.box.y);
      let split = Math.max(aBottom, bTop);
      const maxSplit = b.box.y + b.box.h - 1;
      split = clamp(split, a.box.y + 1, maxSplit);
      const newABottom = Math.max(a.box.y + 1, split - gap/2);
      const bBottom = b.box.y + b.box.h;
      const newBTop = Math.min(split + gap/2, bBottom - 1);
      a.box.h = Math.max(1, newABottom - a.box.y);
      b.box.y = Math.max(b.box.y, newBTop);
      b.box.h = Math.max(1, bBottom - b.box.y);
    }
  }
  return entries;
}
function stepSpecForField(fieldKey=''){
  return (state.steps||[]).find(s=>s.fieldKey === fieldKey)
    || DEFAULT_FIELDS.find(s=>s.fieldKey === fieldKey)
    || {};
}
function pxBoxFromField(field){
  const nb = normBoxFromField(field);
  if(!nb) return null;
  const page = field.page || 1;
  const vp = state.pageViewports[page-1] || state.viewport || {};
  const W = Math.max(1, (vp.width ?? vp.w) || 1);
  const H = Math.max(1, (vp.height ?? vp.h) || 1);
  const { sx, sy, sw, sh } = denormalizeBox(nb, W, H);
  return applyTransform({ x:sx, y:sy, w:sw, h:sh, page });
}
function buildStaticOverlapEntries(page, currentFieldKey, tokens){
  const siblings = (state.profile?.fields || []).filter(f => f.type === 'static' && f.page === page && f.fieldKey !== currentFieldKey);
  return siblings.map(f => {
    const box = pxBoxFromField(f);
    if(!box) return null;
    const spec = stepSpecForField(f.fieldKey || '');
    const snap = snapStaticToLines(tokens, box, { multiline: !!spec.isMultiline });
    const expectedLineCount = f.lineMetrics?.lineCount ?? f.lineCount ?? snap.lineCount;
    return snap ? { fieldKey: f.fieldKey, box: snap.box, lines: snap.lines || [], expectedLineCount } : null;
  }).filter(Boolean);
}
function snapToLine(tokens, hintPx, marginPx=6, opts={}){
  const { skipConfigUnion=false } = opts || {};
  const hits = tokensInBox(tokens, hintPx, opts);
  if(!hits.length) return { box: hintPx, text: '' };
  const bandCy = hits.map(t => t.y + t.h/2).reduce((a,b)=>a+b,0)/hits.length;
  const line = groupIntoLines(tokens, 4).find(L => Math.abs(L.cy - bandCy) <= 4);
  const lineTokens = line ? tokensInBox(line.tokens, hintPx, opts) : hits;
  // Horizontally limit to tokens inside the hint box, but keep full line height
  const left   = Math.min(...hits.map(t => t.x));
  const right  = Math.max(...hits.map(t => t.x + t.w));
  const top    = Math.min(...lineTokens.map(t => t.y));
  const bottom = Math.max(...lineTokens.map(t => t.y + t.h));
  const tokenLeft = Math.min(...lineTokens.map(t => t.x));
  const tokenRight = Math.max(...lineTokens.map(t => t.x + t.w));
  const box = { x:left, y:top, w:right-left, h:bottom-top, page:hintPx.page };
  const expanded = { x:box.x - marginPx, y:box.y - marginPx, w:box.w + marginPx*2, h:box.h + marginPx*2, page:hintPx.page };
  let finalBox = expanded;
  if(isConfigMode() && hintPx && !skipConfigUnion){
    const needsWidth = hintPx.w > 0 && finalBox.w < hintPx.w * 0.75;
    const needsHeight = hintPx.h > 0 && finalBox.h < hintPx.h * 0.75;
    if(needsWidth || needsHeight){
      const unionLeft = Math.min(finalBox.x, hintPx.x);
      const unionTop = Math.min(finalBox.y, hintPx.y);
      const unionRight = Math.max(finalBox.x + finalBox.w, hintPx.x + hintPx.w);
      const unionBottom = Math.max(finalBox.y + finalBox.h, hintPx.y + hintPx.h);
      finalBox = { x: unionLeft, y: unionTop, w: unionRight - unionLeft, h: unionBottom - unionTop, page: hintPx.page };
    }
  }
  if(hintPx && hintPx.w > 0){
    const widthCap = hintPx.w * 1.1;
    const tokensWidth = tokenRight - tokenLeft;
    const targetWidth = Math.max(Math.min(finalBox.w, widthCap), tokensWidth);
    if(finalBox.w > targetWidth){
      const minLeft = Math.max(finalBox.x, tokenRight - targetWidth);
      const maxLeft = Math.min(finalBox.x + finalBox.w - targetWidth, tokenLeft);
      let newLeft = finalBox.x + (finalBox.w - targetWidth) / 2;
      if(newLeft < minLeft) newLeft = minLeft;
      if(newLeft > maxLeft) newLeft = maxLeft;
      const newRight = newLeft + targetWidth;
      finalBox = { x: newLeft, y: finalBox.y, w: newRight - newLeft, h: finalBox.h, page: finalBox.page };
    }
  }
  const text = lineTokens.map(t => t.text).join(' ').trim();
  return { box: finalBox, text };
}

/* ---------------------------- Regexes ----------------------------- */
const RE = {
  currency: /([-$]?\s?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{2})?)/,
  date: /([0-3]?\d[\-\/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2})[\-\/\s]\d{2,4})/i,
  orderLike: /(?:order|invoice|no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9-]{5,})/i,
  sku: /\b([A-Z0-9]{3,}[-_/]?[A-Z0-9]{2,})\b/,
  taxCode: /\b(?:HST|QST)\s*(?:#|no\.?|number)?\s*[:\-]?\s*([0-9A-Z\- ]{8,})\b/i,
  percent: /\b(\d{1,2}(?:\.\d{1,2})?)\s*%/,
};

const FIELD_ALIASES = {
  order_number: 'invoice_number',
  sales_date: 'invoice_date',
  salesperson: 'salesperson_rep',
  customer_name: 'customer_name',
  sold_to_block: 'customer_address',
  store: 'store_name',
  subtotal: 'subtotal_amount',
  hst: 'tax_amount',
  qst: 'tax_amount',
  total: 'invoice_total'
};

const COLUMN_OUT_KEYS = {
  product_description: 'description',
  sku_col: 'sku',
  quantity_col: 'quantity',
  unit_price_col: 'unit_price',
  line_total_col: 'amount',
  line_number_col: 'line_no'
};

const ANCHOR_HINTS = {
  store_name: ['store', 'business'],
  department_division: ['department', 'division'],
  invoice_number: ['invoice number', 'invoice no', 'inv no'],
  invoice_date: ['invoice date', 'date'],
  salesperson_rep: ['salesperson', 'rep'],
  customer_name: ['customer', 'sold to', 'bill to'],
  customer_address: ['address', 'customer address'],
  subtotal_amount: ['subtotal', 'sub-total'],
  discounts_amount: ['discount', 'discounts'],
  tax_amount: ['tax', 'hst', 'gst', 'qst'],
  invoice_total: ['total', 'grand total', 'amount due']
};

/* --------------------------- Landmarks ---------------------------- */
function ensureProfile(requestedWizardId, requestedGeometryId = null){
  const wizardId = requestedWizardId || currentWizardId();
  const resolvedWizardId = wizardId || currentWizardId();
  const resolvedGeometryId = requestedGeometryId || currentGeometryId();
  const profileKey = resolvedWizardId ? LS.profileKey(state.username, state.docType, resolvedWizardId, resolvedGeometryId === DEFAULT_GEOMETRY_ID ? null : resolvedGeometryId) : null;
  if(!resolvedWizardId){
    console.warn('[id-drift][ensureProfile] missing wizardId', { requestedWizardId, activeWizardId: state.activeWizardId, profileWizardId: state.profile?.wizardId || null });
    return null;
  }
  if(state.profile && state.profile.wizardId === resolvedWizardId && state.profile.geometryId === resolvedGeometryId){
    hydrateFingerprintsFromProfile(state.profile);
    ensureConfiguredFlag(state.profile);
    syncActiveGeometryId(state.profile);
    try {
      const hasGeom = Array.isArray(state.profile.fields) && state.profile.fields.some(hasFieldGeometry);
      console.info('[id-drift][ensureProfile]', JSON.stringify({
        isSkinV2,
        username: state.username,
        docType: state.docType,
        activeWizardId: state.activeWizardId,
        activeGeometryId: state.activeGeometryId,
        wizardId: resolvedWizardId,
        geometryId: resolvedGeometryId,
        requestedWizardId,
        profileKey,
        foundProfile: true,
        hasGeometry: hasGeom
      }));
    } catch(err){ console.warn('[id-drift][ensureProfile] log failed', err); }
    return state.profile;
  }

  const existing = loadProfile(state.username, state.docType, resolvedWizardId, resolvedGeometryId);
  try {
    const hasGeom = Array.isArray(existing?.fields) && existing.fields.some(hasFieldGeometry);
    console.info('[id-drift][ensureProfile]', JSON.stringify({
      isSkinV2,
      username: state.username,
      docType: state.docType,
      activeWizardId: state.activeWizardId,
      activeGeometryId: state.activeGeometryId,
      wizardId: resolvedWizardId,
      geometryId: resolvedGeometryId,
      requestedWizardId,
      profileKey,
      foundProfile: !!existing,
      hasGeometry: hasGeom
    }));
  } catch(err){ console.warn('[id-drift][ensureProfile] log failed', err); }
  const templateRaw = resolvedWizardId === DEFAULT_WIZARD_ID ? null : getWizardTemplateById(resolvedWizardId);
  const template = normalizeTemplate(templateRaw);
  const templateFields = template ? (template.fields || []).map(f => {
    const normalizedType = (f.fieldType || 'static').toLowerCase();
    const isArea = normalizedType === 'areabox';
    const areaId = isArea ? (f.areaId || f.id || f.fieldKey) : (f.areaId || null);
    const isSubordinate = !!areaId && !isArea;
    const allowGlobal = !isArea && !isSubordinate;
    const resolvedType = normalizedType === 'dynamic' ? 'dynamic' : (isArea ? 'areabox' : 'static');
    const magicDataType = normalizeMagicDataType(f.magicDataType || f.magicType);
    return {
      fieldId: f.id,
      fieldKey: f.fieldKey,
      label: f.name || f.fieldKey,
      type: resolvedType === 'dynamic' ? 'column' : 'static',
      fieldType: resolvedType,
      kind: resolvedType === 'dynamic' ? 'block' : 'value',
      mode: resolvedType === 'dynamic' ? 'column' : 'cell',
      order: f.order || 0,
      areaId,
      isArea,
      isSubordinate,
      isGlobal: allowGlobal ? !!f.isGlobal : false,
      magicDataType,
      magicType: magicDataType
    };
  }) : [];
  const remapById = template ? Object.fromEntries((template.fields || []).map(f => [f.id, f.fieldKey])) : {};
  if(existing){ remapProfileFieldKeys(existing, remapById, templateFields); }
  const geometryIndex = getGeometryIndex(state.username, state.docType, resolvedWizardId, collectGeometryIdsForWizard(state.username, state.docType, resolvedWizardId));
  const geometryMeta = geometryIndex.find(m => m.geometryId === resolvedGeometryId) || normalizeGeometryMeta({ geometryId: resolvedGeometryId, displayName: `Layout ${geometryIndex.length + 1}` });

  state.profile = existing || {
    username: state.username,
    docType: state.docType,
    wizardId: resolvedWizardId,
    geometryId: resolvedGeometryId,
    geometry: geometryMeta,
    version: PROFILE_VERSION,
    fields: templateFields,
    globals: [],
    landmarks: [
      // General identifiers
      { landmarkKey:'sales_bill',     page:0, type:'text', text:'Sales Bill',  strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'invoice_title',  page:0, type:'text', text:'Invoice',     strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'salesperson',    page:0, type:'text', text:'Salesperson', strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'sales_date',     page:0, type:'text', text:'Sales Date',  strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'delivery_date',  page:0, type:'text', text:'Delivery Date', strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'term',           page:0, type:'text', text:'Term',        strategy:'exact' },
      { landmarkKey:'customer_title', page:0, type:'text', text:'Customer',    strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'store',          page:0, type:'text', text:'Store',       strategy:'fuzzy', threshold:0.86 },

      // Address/info blocks
      { landmarkKey:'sold_to',        page:0, type:'text', text:'Sold To',     strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'ship_to',        page:0, type:'text', text:'Ship To',     strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'information',    page:0, type:'text', text:'Information', strategy:'fuzzy', threshold:0.86 },

      // Line-item headers
      { landmarkKey:'line_header',    page:0, type:'text', text:'Line',        strategy:'exact' },
      { landmarkKey:'sku_header',     page:0, type:'text', text:'Sku',         strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'description_hdr',page:0, type:'text', text:'Description', strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'supplier_hdr',   page:0, type:'text', text:'Supplier',    strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'style_hdr',      page:0, type:'text', text:'Style',       strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'finish_hdr',     page:0, type:'text', text:'Finish',      strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'qty_header',     page:0, type:'text', text:'Qty',         strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'price_header',   page:0, type:'text', text:'Price',       strategy:'exact' },
      { landmarkKey:'amount_header',  page:0, type:'text', text:'Amount',      strategy:'exact' },
      { landmarkKey:'item_notes_hdr', page:0, type:'text', text:'Notes',       strategy:'fuzzy', threshold:0.86 },

      // Totals
      { landmarkKey:'subtotal_hdr',   page:0, type:'text', text:'Sub-Total',   strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'hst_hdr',        page:0, type:'text', text:'HST',         strategy:'exact' },
      { landmarkKey:'qst_hdr',        page:0, type:'text', text:'QST',         strategy:'exact' },
      { landmarkKey:'gst_hdr',        page:0, type:'text', text:'GST',         strategy:'exact' },
      { landmarkKey:'tax_hdr',        page:0, type:'text', text:'Tax',         strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'total_hdr',      page:0, type:'text', text:'Total',       strategy:'exact' },
      { landmarkKey:'deposit_hdr',    page:0, type:'text', text:'Deposit',     strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'balance_hdr',    page:0, type:'text', text:'Balance',     strategy:'fuzzy', threshold:0.86 },
    ],
    tableHints: {
      headerLandmarks: ['sku_header','description_hdr','qty_header','price_header'],
      rowBandHeightPx: 18,
      columns: {},
      rowAnchor: null
    }
  };
  if(state.profile){
    state.profile.geometryId = resolvedGeometryId;
    state.profile.geometry = { ...(state.profile.geometry || {}), ...geometryMeta };
    upsertGeometryMeta(state.username, state.docType, resolvedWizardId, state.profile.geometry);
    syncActiveGeometryId(state.profile);
  }
  state.profile.isConfigured = ensureConfiguredFlag(existing || null)?.isConfigured || false;

  if(state.profile && !state.profile.wizardId){
    state.profile.wizardId = resolvedWizardId;
  }

  if(existing?.fields?.length){
    state.profile.fields = existing.fields.map(f => ({
      ...f,
      type: f.type || 'static',
      fieldKey: FIELD_ALIASES[f.fieldKey] || f.fieldKey
    }));
    state.profile.fields.forEach(f=>{
      if(f.normBox){
        const chk = validateSelection(f.normBox);
        if(!chk.ok){
          let nb = null;
          if(f.bboxPct){
            const tmp = { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 };
            const v = validateSelection(tmp);
            if(v.ok) nb = v.normBox;
          }
          if(!nb && f.rawBox){
            const v = validateSelection(f.rawBox);
            if(v.ok) nb = v.normBox;
          }
          if(nb){
            f.normBox = nb;
            delete f.boxError;
            if(!f.bboxPct){
              f.bboxPct = { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
            }
          } else {
            f.boxError = chk.reason;
          }
        }
      } else if(f.rawBox){
        const chk = validateSelection(f.rawBox);
        if(chk.ok){
          f.normBox = chk.normBox;
          if(!f.bboxPct){
            const nb = chk.normBox;
            f.bboxPct = { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
          }
        } else {
          f.boxError = chk.reason;
        }
      }
    });
  }

  state.profile.tableHints = state.profile.tableHints || { headerLandmarks: ['sku_header','description_hdr','qty_header','price_header'], rowBandHeightPx: 18, columns: {}, rowAnchor: null };
  state.profile.tableHints.columns = state.profile.tableHints.columns || {};
  if(state.profile.tableHints.rowAnchor === undefined){ state.profile.tableHints.rowAnchor = null; }
  const templateConfig = template?.masterDbConfig || null;
  state.profile.masterDbConfig = buildMasterDbConfigFromProfile(state.profile, templateConfig, template);
  ensureConfiguredFlag(state.profile);
  hydrateFingerprintsFromProfile(state.profile);
  saveProfile(state.username, state.docType, state.profile);
  if(isSkinV2){
    persistPatternBundle(state.profile);
  }
}

/* ------------------------ Wizard Steps --------------------------- */
const DEFAULT_FIELDS = [
  // Header / Transaction (single cell highlights)
  {
    fieldKey: 'store_name',
    label: 'Store / Business Name',
    prompt: 'Highlight the Store / Business Name on the invoice header.',
    kind: 'value',
    mode: 'cell',
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'department_division',
    label: 'Department / Division',
    prompt: 'Highlight the Department / Division (if shown).',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'invoice_number',
    label: 'Invoice #',
    prompt: 'Highlight the Invoice #.',
    kind: 'value',
    mode: 'cell',
    regex: RE.orderLike.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'invoice_date',
    label: 'Invoice Date',
    prompt: 'Highlight the Invoice Date.',
    kind: 'value',
    mode: 'cell',
    regex: RE.date.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'salesperson_rep',
    label: 'Salesperson',
    prompt: 'Highlight the Salesperson (if shown).',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'customer_name',
    label: 'Customer Name',
    prompt: 'Highlight the Customer Name.',
    kind: 'value',
    mode: 'cell',
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'customer_address',
    label: 'Customer Address',
    prompt: 'Draw a box around the Customer Address (include city, province/state, postal code).',
    kind: 'block',
    mode: 'cell',
    isMultiline: true,
    required: false,
    type: 'static'
  },

  // Line-Item Columns
  {
    fieldKey: 'line_number_col',
    label: 'Line #',
    prompt: 'Identify the Line # column (if shown).',
    kind: 'block',
    mode: 'column',
    required: false,
    regex: '[0-9]+',
    type: 'column'
  },
  {
    fieldKey: 'sku_col',
    label: 'Item Code (SKU)',
    prompt: 'Identify the Item Code (SKU) column.',
    kind: 'block',
    mode: 'column',
    required: false,
    regex: RE.sku.source,
    type: 'column'
  },
  {
    fieldKey: 'product_description',
    label: 'Item Description',
    prompt: 'Identify the Item Description column.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: '.+',
    type: 'column'
  },
  {
    fieldKey: 'quantity_col',
    label: 'Quantity',
    prompt: 'Identify the Quantity column.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: '[0-9]+(?:\\.[0-9]+)?',
    type: 'column'
  },
  {
    fieldKey: 'unit_price_col',
    label: 'Unit Price',
    prompt: 'Identify the Unit Price column.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: RE.currency.source,
    type: 'column'
  },

  // Totals & Taxes (single cell highlights)
  {
    fieldKey: 'subtotal_amount',
    label: 'Subtotal',
    prompt: 'Highlight the Subtotal value in the totals area.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'discounts_amount',
    label: 'Discount',
    prompt: 'Highlight the Discount value (if shown).',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'tax_amount',
    label: 'Tax Amount',
    prompt: 'Highlight the Tax Amount value.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'invoice_total',
    label: 'Invoice Total',
    prompt: 'Highlight the Invoice Total value.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'payment_method',
    label: 'Payment Method',
    prompt: 'Highlight the Payment Method (if shown).',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'payment_status',
    label: 'Payment Status',
    prompt: 'Highlight the Payment Status (if shown).',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  }
];

function generateQuestionsFromTemplate(template){
  const normalized = normalizeTemplate(template);
  if(!normalized) return [];
  const sorted = (normalized.fields || []).slice().sort((a,b)=> (a.order || 0) - (b.order || 0));
  const byArea = new Map();
  sorted.forEach(f => {
    const normalizedType = (f.fieldType || 'static').toLowerCase();
    const isArea = normalizedType === 'areabox';
    const areaId = isArea ? (f.areaId || f.id || f.fieldKey) : (f.areaId || null);
    if(isArea){
      byArea.set(areaId, byArea.get(areaId) || { area: f, subs: [] });
      byArea.get(areaId).area = f;
    } else if(areaId){
      byArea.set(areaId, byArea.get(areaId) || { area: null, subs: [] });
      byArea.get(areaId).subs.push(f);
    }
  });

  const ordered = [];
  const seen = new Set();
  const pushField = (f) => {
    const key = f.id || f.fieldKey;
    if(!key || seen.has(key)) return false;
    ordered.push(f);
    seen.add(key);
    return true;
  };

  sorted.forEach(f => {
    const normalizedType = (f.fieldType || 'static').toLowerCase();
    const isArea = normalizedType === 'areabox';
    if(!isArea) return;
    if(!pushField(f)) return;
    const areaId = f.areaId || f.id || f.fieldKey;
    const subs = (byArea.get(areaId)?.subs || []).slice().sort((a,b)=> (a.order || 0) - (b.order || 0));
    subs.forEach(sf => pushField(sf));
  });

  sorted.forEach(f => {
    if(!pushField(f) && f.areaId && !byArea.get(f.areaId)?.area){
      pushField(f);
    }
  });

  const total = ordered.length || 0;
  return ordered.map((f, idx) => {
    const normalizedType = (f.fieldType || 'static').toLowerCase();
    const isArea = normalizedType === 'areabox';
    const isDynamic = normalizedType === 'dynamic';
    return {
      fieldId: f.id,
      fieldKey: f.fieldKey,
      name: f.name || f.fieldKey,
      fieldType: isDynamic ? 'dynamic' : (isArea ? 'areabox' : 'static'),
      areaId: f.areaId,
      isArea,
      isSubordinate: !!f.areaId && !isArea,
      magicDataType: normalizeMagicDataType(f.magicDataType || f.magicType),
      prompt: isArea ? `Please highlight one ${f.name} area.` : `Please highlight the ${f.name}`,
      order: idx + 1,
      questionIndex: idx + 1,
      totalQuestions: total
    };
  });
}

function initStepsFromProfile(){
  const profFields = (state.profile?.fields || []).map(f => ({...f}));
  const byKey = Object.fromEntries(profFields.map(f=>[f.fieldKey, f]));
  state.steps = DEFAULT_FIELDS.map(d => ({
    ...byKey[d.fieldKey],
    fieldKey: d.fieldKey,
    prompt: d.prompt,
    regex: d.regex || byKey[d.fieldKey]?.regex || undefined,
    kind: d.kind,
    label: d.label,
    mode: d.mode,
    required: d.required,
    type: d.type
  }));
  state.stepIdx = 0;
  updatePrompt();
}

function buildStepsFromTemplate(template){
  const profFields = (state.profile?.fields || []).map(f => ({...f}));
  const byKey = Object.fromEntries(profFields.map(f=>[f.fieldKey, f]));
  const questions = generateQuestionsFromTemplate(template);
  return questions.map(q => {
    const type = q.fieldType === 'dynamic' ? 'column' : 'static';
    const isArea = q.fieldType === 'areabox';
    return {
      ...byKey[q.fieldKey],
      fieldKey: q.fieldKey,
      prompt: q.prompt,
      kind: type === 'column' ? 'block' : 'value',
      label: q.name,
      mode: type === 'column' ? 'column' : 'cell',
      required: true,
      type,
      fieldType: q.fieldType,
      areaId: q.areaId,
      isArea,
      isSubordinate: !!q.isSubordinate,
      magicDataType: normalizeMagicDataType(q.magicDataType || q.magicType || byKey[q.fieldKey]?.magicDataType || byKey[q.fieldKey]?.magicType),
      magicType: normalizeMagicDataType(q.magicDataType || q.magicType || byKey[q.fieldKey]?.magicDataType || byKey[q.fieldKey]?.magicType)
    };
  });
}

function initStepsFromActiveWizard(){
  let wizardId = currentWizardId();
  if(isSkinV2 && wizardId === DEFAULT_WIZARD_ID){
    wizardId = requireCustomWizard({ allowTemplateFallback: true, promptBuilder: false });
    state.activeWizardId = wizardId || state.activeWizardId || firstCustomWizardId();
    if(!wizardId){
      showWizardManagerTab();
    }
  }
  if(wizardId === DEFAULT_WIZARD_ID){
    initStepsFromProfile();
    return;
  }
  const template = normalizeTemplate(getWizardTemplateById(wizardId));
  if(!template){
    state.activeWizardId = isSkinV2 ? (wizardId || firstCustomWizardId()) : DEFAULT_WIZARD_ID;
    initStepsFromProfile();
    return;
  }
  ensureProfile();
  state.steps = buildStepsFromTemplate(template);
  state.stepIdx = 0;
  updatePrompt();
}

function resetBuilderErrors(){
  if(els.builderNameError) els.builderNameError.style.display = 'none';
  if(els.builderFieldNameError) els.builderFieldNameError.style.display = 'none';
}

function normalizeAreaLink(field){
  if(!field) return null;
  if(!field.id) field.id = genId('field');
  if(field.fieldType === 'areabox'){
    field.isArea = true;
    field.areaId = field.areaId || field.id;
    field.isSubordinate = false;
    field.isGlobal = false;
    field.nonExtractable = true;
    return field.areaId;
  }
  if(field.areaId){
    field.isSubordinate = true;
    field.isArea = false;
    field.isGlobal = false;
    field.nonExtractable = !!field.nonExtractable && !field.isGlobal;
    return field.areaId;
  }
  field.isArea = false;
  field.isSubordinate = false;
  field.isGlobal = !!field.isGlobal;
  field.nonExtractable = !!field.nonExtractable && !field.isGlobal;
  return null;
}

function resequenceBuilderFields(){
  if(!Array.isArray(state.builderFields)) state.builderFields = [];
  state.builderFields.forEach((f, i) => { f.order = i + 1; });
}

function removeSubordinateFields(areaId){
  if(!areaId || !Array.isArray(state.builderFields)) return;
  state.builderFields = state.builderFields.filter(f => f.fieldType === 'areabox' || f.areaId !== areaId);
  resequenceBuilderFields();
}

function addSubordinateField(areaField){
  if(!areaField || !Array.isArray(state.builderFields)) return;
  if(state.builderFields.length >= MAX_CUSTOM_FIELDS){
    if(els.builderFieldLimitMsg) els.builderFieldLimitMsg.style.display = 'inline';
    return;
  }
  const areaId = normalizeAreaLink(areaField) || areaField.id;
  const fields = state.builderFields;
  const areaIdx = fields.findIndex(f => f.id === areaField.id);
  if(areaIdx < 0) return;
  const newField = {
    id: genId('field'),
    fieldType: 'static',
    name: '',
    order: 0,
    fieldKey: '',
    areaId,
    isSubordinate: true,
    magicType: MAGIC_DATA_TYPE.ANY,
    magicDataType: MAGIC_DATA_TYPE.ANY,
    isGlobal: false
  };
  let insertAt = areaIdx;
  for(let i = areaIdx + 1; i < fields.length; i++){
    if(fields[i].areaId === areaId) insertAt = i;
    else if(fields[i].fieldType === 'areabox'){ break; }
    else if(!fields[i].areaId){ break; }
  }
  fields.splice(insertAt + 1, 0, newField);
  resequenceBuilderFields();
  renderBuilderFields();
}

function renderBuilderFields(){
  const list = els.builderFieldsList;
  if(!list) return;
  list.innerHTML = '';
  const fields = Array.isArray(state.builderFields) ? state.builderFields : [];
  fields.forEach(normalizeAreaLink);
  fields.sort((a,b)=> (a.order || 0) - (b.order || 0));
  resequenceBuilderFields();

  const byArea = new Map();
  fields.forEach(f => {
    if(f.fieldType === 'areabox') return;
    if(f.areaId){
      if(!byArea.has(f.areaId)) byArea.set(f.areaId, []);
      byArea.get(f.areaId).push(f);
    }
  });

  const rootFields = fields.filter(f => !f.areaId || f.fieldType === 'areabox');
  rootFields.forEach((field, idx) => {
    const fieldIndex = fields.indexOf(field);
    const displayIndex = field.order || (fieldIndex + 1);
    const handleChange = (changedField, changeIdx, key, meta={}) => {
      if(key === 'fieldType'){
        if(changedField.fieldType === 'areabox'){
          normalizeAreaLink(changedField);
        } else if(meta.previousType === 'areabox'){
          const oldAreaId = changedField.areaId || changedField.id;
          changedField.areaId = null;
          changedField.isArea = false;
          removeSubordinateFields(oldAreaId);
        }
        resequenceBuilderFields();
        renderBuilderFields();
        return;
      }
      if(key === 'name' && changedField.fieldType === 'areabox'){
        changedField.prompt = `Please highlight the ${changedField.name}`;
      }
    };

    let row = null;
    if(typeof BuilderFieldRow !== 'undefined' && typeof BuilderFieldRow.createFieldRow === 'function'){
      row = BuilderFieldRow.createFieldRow({
        field,
        index: displayIndex - 1,
        magicTypeOptions: MAGIC_DATA_TYPE,
        onDelete: () => removeBuilderField(fieldIndex),
        onChange: handleChange
      });
    }
    if(!row){
      row = document.createElement('div');
      row.className = 'custom-field-row';

      const idxBadge = document.createElement('span');
      idxBadge.className = 'field-index';
      idxBadge.textContent = `Field ${displayIndex}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'delete-field-btn';
      deleteBtn.title = 'Delete field';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', ()=> removeBuilderField(idx));

      const typeSel = document.createElement('select');
      typeSel.className = 'field-type';
      ['areabox','static','dynamic'].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt === 'areabox' ? 'Areabox' : (opt === 'static' ? 'Static' : 'Dynamic');
        typeSel.appendChild(o);
      });
      typeSel.value = (field.fieldType || 'static');
      typeSel.addEventListener('change', e => {
        const prev = field.fieldType;
        field.fieldType = e.target.value;
        handleChange(field, fieldIndex, 'fieldType', { previousType: prev });
      });

      const magicSel = document.createElement('select');
      magicSel.className = 'field-magic-type';
      [
        { value: MAGIC_DATA_TYPE.ANY, label: 'ANY' },
        { value: MAGIC_DATA_TYPE.TEXT, label: 'TEXT ONLY' },
        { value: MAGIC_DATA_TYPE.NUMERIC, label: 'NUMERIC ONLY' }
      ].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value; o.textContent = opt.label;
        magicSel.appendChild(o);
      });
      magicSel.value = normalizeMagicDataType(field.magicType || field.magicDataType);
      magicSel.addEventListener('change', e => {
        const v = normalizeMagicDataType(e.target.value);
        field.magicType = v;
        field.magicDataType = v;
      });

      const nameInput = document.createElement('input');
      nameInput.className = 'field-name';
      nameInput.placeholder = field.fieldType === 'areabox' ? 'Area name' : 'Field name';
      nameInput.value = field.name || '';
      nameInput.addEventListener('input', e => { field.name = e.target.value; handleChange(field, fieldIndex, 'name'); });

      const allowGlobal = (field.fieldType || '').toLowerCase() !== 'areabox';
      let globalToggle = null;
      if(allowGlobal){
        globalToggle = document.createElement('label');
        globalToggle.className = 'field-global-toggle';
        const globalCheckbox = document.createElement('input');
        globalCheckbox.type = 'checkbox';
        globalCheckbox.checked = !!field.isGlobal;
        globalCheckbox.addEventListener('change', (e)=> { field.isGlobal = !!e.target.checked; handleChange(field, fieldIndex, 'isGlobal'); });
        const globalText = document.createElement('span');
        globalText.textContent = 'Global Field';
        globalToggle.appendChild(globalCheckbox);
        globalToggle.appendChild(globalText);
      }

      row.appendChild(idxBadge);
      row.appendChild(typeSel);
      row.appendChild(magicSel);
      row.appendChild(nameInput);
      if(allowGlobal && globalToggle) row.appendChild(globalToggle);
      row.appendChild(deleteBtn);
    }
    list.appendChild(row);

    if(field.fieldType === 'areabox'){
      const subContainer = document.createElement('div');
      subContainer.className = 'sub-field-container';
      const areaId = field.areaId || field.id;
      const subFields = (byArea.get(areaId) || []).sort((a,b)=> (a.order || 0) - (b.order || 0));
      subFields.forEach((subField, subIdx) => {
        const subRow = BuilderFieldRow.createFieldRow({
          field: subField,
          index: (subField.order || subIdx + 1) - 1,
          magicTypeOptions: MAGIC_DATA_TYPE,
          onDelete: () => removeBuilderField(fields.indexOf(subField)),
          onChange: handleChange,
          isSubordinate: true,
          allowAreaType: false
        });
        subContainer.appendChild(subRow);
      });
      const addSubBtn = document.createElement('button');
      addSubBtn.type = 'button';
      addSubBtn.className = 'btn add-sub-field-btn';
      addSubBtn.textContent = 'Add field to area';
      addSubBtn.addEventListener('click', () => addSubordinateField(field));
      subContainer.appendChild(addSubBtn);
      list.appendChild(subContainer);
    }
  });
  if(els.builderFieldCount) els.builderFieldCount.textContent = String(fields.length);
  if(els.builderFieldLimitMsg){
    els.builderFieldLimitMsg.style.display = fields.length >= MAX_CUSTOM_FIELDS ? 'inline' : 'none';
  }
}

function ensureBuilderField(){
  if(state.builderFields && state.builderFields.length) return;
  state.builderFields = [{ id: genId('field'), fieldType: 'static', name: '', order: 1, fieldKey: '', magicType: MAGIC_DATA_TYPE.ANY, magicDataType: MAGIC_DATA_TYPE.ANY, isGlobal: false }];
}

function addBuilderField(){
  if(!Array.isArray(state.builderFields)) state.builderFields = [];
  if(state.builderFields.length >= MAX_CUSTOM_FIELDS){
    if(els.builderFieldLimitMsg) els.builderFieldLimitMsg.style.display = 'inline';
    return;
  }
  const nextOrder = state.builderFields.length + 1;
  state.builderFields.push({ id: genId('field'), fieldType: 'static', name: '', order: nextOrder, fieldKey: '', magicType: MAGIC_DATA_TYPE.ANY, magicDataType: MAGIC_DATA_TYPE.ANY, isGlobal: false });
  renderBuilderFields();
}

function removeBuilderField(idx){
  if(!Array.isArray(state.builderFields)) state.builderFields = [];
  if(idx < 0 || idx >= state.builderFields.length) return;
  const removed = state.builderFields[idx];
  const removedAreaId = removed?.fieldType === 'areabox' ? (removed.areaId || removed.id) : null;
  state.builderFields.splice(idx, 1);
  if(removedAreaId){
    state.builderFields = state.builderFields.filter(f => f.areaId !== removedAreaId);
  }
  resequenceBuilderFields();
  renderBuilderFields();
}

function openBuilder(template=null){
  resetBuilderErrors();
  if(template){
    const normalizedTemplate = normalizeTemplate(template);
    state.builderEditingId = normalizedTemplate.id;
    const sortedFields = (normalizedTemplate.fields || []).slice().sort((a,b)=> (a.order||0) - (b.order||0));
    const normalizedFields = sortedFields.map(f => {
      const mt = normalizeMagicDataType(f.magicDataType || f.magicType);
      return { ...f, magicType: mt, magicDataType: mt };
    });
    state.builderFields = normalizedFields;
    if(els.builderNameInput) els.builderNameInput.value = normalizedTemplate.wizardName || '';
  } else {
    state.builderEditingId = null;
    if(els.builderNameInput) els.builderNameInput.value = '';
    state.builderFields = [];
  }
  ensureBuilderField();
  renderBuilderFields();
  if(els.app) els.app.style.display = 'none';
  if(els.wizardSection) els.wizardSection.style.display = 'none';
  if(els.builderSection) els.builderSection.style.display = 'block';
}

function getWizardDisplayTitle(template){
  const title = template?.exportMetadata?.title || template?.wizardName || template?.id;
  return String(title || '').trim() || 'Untitled Wizard';
}

function getWizardDescription(template){
  const description = template?.exportMetadata?.description || '';
  return normalizeWizardDescription(description);
}

function createWizardDescriptionElement(description){
  const desc = document.createElement('div');
  desc.className = 'wizard-description';
  desc.textContent = description || 'No description provided.';
  desc.addEventListener('click', () => {
    desc.classList.toggle('expanded');
  });
  return desc;
}

function updateWizardExportCounter(){
  if(!els.wizardExportDescription || !els.wizardExportCounter) return;
  const words = countWords(els.wizardExportDescription.value);
  els.wizardExportCounter.textContent = `${words} / 250 words`;
}

function enforceWizardExportWordLimit(){
  if(!els.wizardExportDescription) return;
  const words = (els.wizardExportDescription.value.match(/\S+/g) || []);
  if(words.length <= 250){
    updateWizardExportCounter();
    return;
  }
  const trimmed = words.slice(0, 250).join(' ');
  els.wizardExportDescription.value = trimmed;
  updateWizardExportCounter();
}

function openWizardExportPanel(template){
  if(!template) return;
  const title = template.exportMetadata?.title || template.wizardName || template.id || '';
  const description = template.exportMetadata?.description || '';
  if(els.wizardExportTitle) els.wizardExportTitle.value = title;
  if(els.wizardExportDescription) els.wizardExportDescription.value = description;
  updateWizardExportCounter();
  showTab('wizard-export');
  state.activeWizardId = template.id || state.activeWizardId;
  state.docType = template.documentTypeId || state.docType;
}

function confirmWizardExport(){
  const template = getWizardTemplateById(state.activeWizardId);
  if(!template){
    alert('Wizard definition not found.');
    return;
  }
  enforceWizardExportWordLimit();
  const titleInput = (els.wizardExportTitle?.value || '').trim();
  const descriptionInput = normalizeWizardDescription(els.wizardExportDescription?.value || '');
  const title = titleInput || template.wizardName || template.id || 'Untitled Wizard';
  const exportMetadata = buildExportMetadata({
    title,
    description: descriptionInput,
    existing: template.exportMetadata
  });
  const updatedTemplate = normalizeTemplate({
    ...template,
    wizardName: template.wizardName || title,
    exportMetadata
  });
  persistTemplate(state.username, template.documentTypeId || state.docType, updatedTemplate);
  refreshWizardTemplates();
  exportWizardDefinition(template.documentTypeId || state.docType, template.id, exportMetadata);
  showWizardManagerTab(template.id);
}

function getWizardConfigurationStatus(template){
  const docType = template?.documentTypeId || state.docType;
  const wizardId = template?.id || DEFAULT_WIZARD_ID;
  const geometryIds = collectGeometryIdsForWizard(state.username, docType, wizardId);
  const hasConfiguredProfile = geometryIds.some(gid => {
    const profile = loadProfile(state.username, docType, wizardId, gid);
    const hasGeom = Array.isArray(profile?.fields) && profile.fields.some(hasFieldGeometry);
    return profile?.isConfigured && hasGeom;
  });
  return { docType, wizardId, geometryIds, hasConfiguredProfile };
}

function createWizardSettingsButton({ wizardId, hasConfiguredProfile }){
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'btn';
  settingsBtn.textContent = hasConfiguredProfile ? 'Settings' : 'Configure';
  settingsBtn.addEventListener('click', () => {
    showWizardDetailsTab(wizardId);
  });
  return settingsBtn;
}

function createWizardEditButton(template){
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    openBuilder(template);
  });
  return editBtn;
}

function createWizardExportButton(template){
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn';
  exportBtn.textContent = 'Add Template';
  exportBtn.addEventListener('click', () => {
    openWizardExportPanel(template);
  });
  return exportBtn;
}

function removeWizardTemplateLocal(wizardId, docType){
  if(!wizardId) return false;
  const templates = getStoredTemplates();
  const nextTemplates = templates.filter(t => !(t?.id === wizardId && (!docType || (t?.documentTypeId || state.docType) === docType)));
  if(nextTemplates.length === templates.length) return false;
  setStoredTemplates(nextTemplates);
  return true;
}

function createWizardDeleteButton(template){
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if(!template?.id) return;
    const wizardTitle = getWizardDisplayTitle(template);
    const docType = template.documentTypeId || state.docType;
    const msg = `Delete "${wizardTitle}"? This will remove the wizard and its saved configurations.`;
    if(!confirm(msg)) return;
    removeWizardTemplateLocal(template.id, docType);
    refreshWizardTemplates();
    if(state.activeWizardId === template.id){
      state.activeWizardId = '';
    }
    showWizardManagerTab();
    await deleteWizardEverywhere(state.username, docType, template.id);
  });
  return deleteBtn;
}

function renderWizardDetailsActions(){
  if(!els.wizardDetailsActions) return;
  els.wizardDetailsActions.innerHTML = '';
  const template = getWizardTemplateById(state.activeWizardId);
  if(!template) return;
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(createWizardEditButton(template));
  actions.appendChild(createWizardExportButton(template));
  actions.appendChild(createWizardDeleteButton(template));
  els.wizardDetailsActions.appendChild(actions);
}

function renderWizardBatchLog(wizardId){
  if(!els.wizardDetailsLog) return;
  const resolvedWizardId = wizardId || state.activeWizardId || DEFAULT_WIZARD_ID;
  const entries = LS.getBatchLog(state.username, state.docType, resolvedWizardId);
  els.wizardDetailsLog.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'sub';
  header.style.marginBottom = '8px';
  header.textContent = `Batch log (${entries.length})`;
  els.wizardDetailsLog.appendChild(header);
  if(!entries.length){
    const empty = document.createElement('div');
    empty.className = 'sub';
    empty.textContent = 'No batch runs recorded yet.';
    els.wizardDetailsLog.appendChild(empty);
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'results-table-scroll';
  const table = document.createElement('table');
  table.className = 'line-items-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Processed', 'File', 'Status', 'Reason', 'Geometry'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  entries.slice().reverse().forEach(entry => {
    const row = document.createElement('tr');
    const processed = entry?.processedAtISO ? new Date(entry.processedAtISO).toLocaleString() : '';
    const cells = [
      processed || '-',
      entry?.fileName || '-',
      entry?.status || '-',
      entry?.reason || '-',
      entry?.geometryId || '-'
    ];
    cells.forEach(value => {
      const td = document.createElement('td');
      td.textContent = value;
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  els.wizardDetailsLog.appendChild(wrapper);
}

function renderWizardManagerList(selectedId=null){
  if(!els.wizardManagerList) return;
  const templates = refreshWizardTemplates();
  els.wizardManagerList.innerHTML = '';
  const empty = !templates.length;
  if(els.wizardManagerEmpty){
    els.wizardManagerEmpty.style.display = empty ? 'block' : 'none';
  }
  if(empty) return;
  const list = document.createElement('div');
  list.className = 'wizard-table';
  let selectedRow = null;
  templates.forEach(t => {
    const { docType, wizardId, geometryIds, hasConfiguredProfile } = getWizardConfigurationStatus(t);
    const geometryMeta = getGeometryIndex(state.username, docType, wizardId, geometryIds);
    const row = document.createElement('div');
    row.className = 'wizard-row';
    if(selectedId && t.id === selectedId){
      row.classList.add('selected');
      selectedRow = row;
    }
    const info = document.createElement('div');
    info.className = 'wizard-info';
    const name = document.createElement('div');
    name.className = 'wizard-name';
    name.textContent = getWizardDisplayTitle(t);
    const description = createWizardDescriptionElement(getWizardDescription(t));
    const meta = document.createElement('div');
    meta.className = 'wizard-meta';
    meta.textContent = `ID: ${t.id || ''} • ${geometryMeta.length} layout${geometryMeta.length === 1 ? '' : 's'}`;
    const actions = document.createElement('div');
    actions.className = 'wizard-actions';
    actions.appendChild(createWizardSettingsButton({ wizardId, hasConfiguredProfile }));
    info.appendChild(name);
    info.appendChild(description);
    info.appendChild(meta);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
  els.wizardManagerList.appendChild(list);
  if(selectedRow){
    requestAnimationFrame(() => {
      selectedRow.scrollIntoView({ block: 'nearest' });
    });
  }
}

function showWizardManagerTab(selectedId = state.activeWizardId){
  showTab('wizard-manager');
  renderWizardManagerList(selectedId);
}

function renderPreconfiguredWizardList(){
  if(!els.preconfiguredWizardList || !els.preconfiguredWizardEmpty) return;
  els.preconfiguredWizardList.innerHTML = '';
  const isLoading = state.preconfiguredStatus === 'loading';
  const isError = state.preconfiguredStatus === 'error';
  const isReady = state.preconfiguredStatus === 'ready';
  const empty = isReady && !state.preconfiguredWizards.length;
  els.preconfiguredWizardEmpty.style.display = (isLoading || isError || empty) ? 'block' : 'none';
  if(isLoading){
    els.preconfiguredWizardEmpty.textContent = 'Loading pre-configured wizards...';
    return;
  }
  if(isError){
    els.preconfiguredWizardEmpty.textContent = state.preconfiguredError || 'Failed to load pre-configured wizards.';
    return;
  }
  if(empty){
    els.preconfiguredWizardEmpty.textContent = 'No pre-configured wizards available.';
    return;
  }
  const list = document.createElement('div');
  list.className = 'wizard-table';
  state.preconfiguredWizards.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'wizard-row';
    const info = document.createElement('div');
    info.className = 'wizard-info';
    const name = document.createElement('div');
    name.className = 'wizard-name';
    name.textContent = entry.title || 'Untitled Wizard';
    const description = createWizardDescriptionElement(entry.description || '');
    const meta = document.createElement('div');
    meta.className = 'wizard-meta';
    meta.textContent = entry.id ? `Catalog ID: ${entry.id}` : 'Catalog wizard';
    const actions = document.createElement('div');
    actions.className = 'wizard-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn primary';
    addBtn.textContent = 'Add to Wizard Manager';
    addBtn.addEventListener('click', async () => {
      if(!entry.definition){
        alert('Unable to import this wizard right now.');
        return;
      }
      const newWizardId = importWizardDefinition(entry.definition, { postImport: 'wizard-manager' });
      if(newWizardId){
        showWizardManagerTab(newWizardId);
      }
    });
    actions.appendChild(addBtn);
    info.appendChild(name);
    info.appendChild(description);
    info.appendChild(meta);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
  els.preconfiguredWizardList.appendChild(list);
}

async function loadPreconfiguredWizards(){
  if(state.preconfiguredStatus === 'loading' || state.preconfiguredStatus === 'ready') return;
  state.preconfiguredStatus = 'loading';
  state.preconfiguredError = null;
  renderPreconfiguredWizardList();
  try{
    const manifestResp = await fetch('preconfigured_wizards/manifest.json', { cache: 'no-store' });
    if(!manifestResp.ok) throw new Error(`Manifest fetch failed (${manifestResp.status})`);
    const manifest = await manifestResp.json();
    if(!Array.isArray(manifest)) throw new Error('Manifest is not an array.');
    const entries = await Promise.all(manifest.map(async (entry) => {
      try{
        const path = entry?.path || '';
        if(!path) return null;
        const wizardResp = await fetch(path, { cache: 'no-store' });
        if(!wizardResp.ok) throw new Error(`Wizard fetch failed (${wizardResp.status})`);
        const definition = await wizardResp.json();
        const exportMetadata = definition?.exportMetadata || {};
        return {
          id: entry?.id || definition?.wizardId || null,
          path,
          title: entry?.title || exportMetadata?.title || definition?.wizardName || '',
          description: entry?.description || exportMetadata?.description || '',
          definition
        };
      } catch(err){
        console.warn('[preconfigured] wizard load failed', err);
        return null;
      }
    }));
    state.preconfiguredWizards = entries.filter(Boolean);
    state.preconfiguredStatus = 'ready';
  } catch(err){
    console.error('[preconfigured] load failed', err);
    state.preconfiguredStatus = 'error';
    state.preconfiguredError = err?.message || 'Failed to load pre-configured wizards.';
  }
  renderPreconfiguredWizardList();
}

function closeBuilder(){
  if(els.builderSection) els.builderSection.style.display = 'none';
  if(els.app) els.app.style.display = 'block';
  resetBuilderErrors();
}

function saveBuilderTemplate(){
  resetBuilderErrors();
  const name = (els.builderNameInput?.value || '').trim();
  const seededFields = (state.builderFields || []).map((f, idx) => ({ ...f, id: f.id || genId('field'), order: idx + 1 }));
  seededFields.forEach(normalizeAreaLink);
  const preparedFields = seededFields.map(f => {
    const mt = normalizeMagicDataType(f.magicDataType || f.magicType);
    const normalizedType = (f.fieldType || 'static') === 'dynamic'
      ? 'dynamic'
      : ((f.fieldType || 'static') === 'areabox' ? 'areabox' : 'static');
    const normalizedAreaId = normalizedType === 'areabox' ? (f.areaId || f.id) : (f.areaId || null);
    const allowGlobal = !normalizedAreaId && normalizedType !== 'areabox';
    return {
      ...f,
      id: f.id || genId('field'),
      name: (f.name || '').trim(),
      fieldType: normalizedType,
      areaId: normalizedAreaId || undefined,
      isArea: normalizedType === 'areabox',
      isSubordinate: !!normalizedAreaId && normalizedType !== 'areabox',
      isGlobal: allowGlobal ? !!f.isGlobal : false,
      order: f.order,
      magicDataType: mt,
      magicType: mt
    };
  });
  const normalizedFields = normalizeTemplateFields(preparedFields).map(f => ({
    id: f.id || genId('field'),
    name: f.name,
    fieldType: f.fieldType,
    order: f.order,
    fieldKey: f.fieldKey,
    areaId: f.areaId,
    isArea: f.isArea,
    isSubordinate: f.isSubordinate,
    isGlobal: f.isGlobal,
    magicDataType: normalizeMagicDataType(f.magicDataType || f.magicType),
    magicType: normalizeMagicDataType(f.magicDataType || f.magicType)
  }));
  const hasName = !!name;
  const hasFields = normalizedFields.length > 0;
  if(normalizedFields.length > MAX_CUSTOM_FIELDS){
    if(els.builderFieldLimitMsg) els.builderFieldLimitMsg.style.display = 'inline';
    return null;
  }
  const missingFieldNames = normalizedFields.some(f => !f.name);
  if(!hasName && els.builderNameError) els.builderNameError.style.display = 'block';
  if((!hasFields || missingFieldNames) && els.builderFieldNameError) els.builderFieldNameError.style.display = 'block';
  if(!hasName || !hasFields || missingFieldNames) return null;

  // Subordinate fields store areaId linking back to their parent Areabox so later configuration/run steps can scope boxes to the owning area without changing coordinate systems.
  const template = {
    id: state.builderEditingId || genId('wizard'),
    wizardName: name,
    fields: normalizedFields,
    masterDbConfig: {
      isCustomMasterDb: true,
      includeLineItems: normalizedFields.some(f => f.fieldType === 'dynamic'),
      staticFields: deriveMasterDbSchema(normalizedFields),
      lineItemFields: normalizedFields
        .filter(f => f.fieldType === 'dynamic')
        .map(f => ({ fieldKey: f.fieldKey, label: f.name || f.fieldKey }))
    }
  };
  const saved = persistTemplate(state.username, state.docType, template);
  refreshWizardTemplates();
  state.activeWizardId = saved.id;
  state.profile = null;
  populateModelSelect(`custom:${saved.id}`);
  if(els.modelSelect){
    els.modelSelect.value = `custom:${saved.id}`;
  }
  renderWizardManagerList(saved.id);
  activateConfigMode();
  if(els.builderSection) els.builderSection.style.display = 'none';
  if(els.wizardSection) els.wizardSection.style.display = 'block';
  if(els.app) els.app.style.display = 'none';
  return saved;
}

function setWizardCompletionMode(isComplete){
  state.wizardComplete = !!isComplete;
  if(!els.confirmBtn) return;
  els.confirmBtn.textContent = isComplete ? 'Save Wizard' : 'Confirm';
}

function updatePrompt(){
  const step = state.steps[state.stepIdx];
  els.stepLabel.textContent = `Step ${state.stepIdx+1}/${state.steps.length}`;
  els.questionText.textContent = step?.prompt || 'Highlight field';
}

function goToStep(idx){
  const max = state.steps.length - 1;
  state.stepIdx = Math.max(0, Math.min(idx, max));
  setWizardCompletionMode(false);
  els.confirmBtn.disabled = false;
  els.skipBtn.disabled = false;
  updatePrompt();
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; state.snappedLineMetrics = null; state.matchPoints=[]; drawOverlay();
}

function finishWizard(){
  setWizardCompletionMode(true);
  els.confirmBtn.disabled = false;
  els.skipBtn.disabled = true;
  els.backBtn.disabled = false;
  els.stepLabel.textContent = 'Wizard complete';
  els.questionText.textContent = 'Click “Save & Return” or export JSON.';
}

function saveWizardAndReturn(){
  saveCurrentProfileAsModel();
  compileDocument(state.currentFileId);
  activateRunMode({ clearDoc: true });
  els.wizardSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('extracted-data');
  populateModelSelect();
}

function afterConfirmAdvance(){
  if(state.stepIdx < state.steps.length - 1){
    goToStep(state.stepIdx + 1);
  } else {
    finishWizard();
  }
}

/* --------------------- Landmark utilities ------------------------ */
function findLandmark(tokens, spec, viewportPx){
  const lines = groupIntoLines(tokens);
  const withinPrior = spec.bbox
    ? lines.filter(L => L.tokens.some(t => intersect(toPx(viewportPx, {x0:spec.bbox[0],y0:spec.bbox[1],x1:spec.bbox[2],y1:spec.bbox[3],page:spec.page}), t)))
    : lines;

  for(const L of withinPrior){
    const txt = L.tokens.map(t=>t.text).join(' ').trim();
    if(spec.strategy === 'exact' && txt.toLowerCase().includes(spec.text.toLowerCase())) return bboxOfTokens(L.tokens);
    if(spec.strategy === 'regex' && new RegExp(spec.text,'i').test(txt)) return bboxOfTokens(L.tokens);
    if(spec.strategy === 'fuzzy'){ const score = cosine3Gram(txt, spec.text); if(score >= (spec.threshold ?? 0.86)) return bboxOfTokens(L.tokens); }
  }
  return null;
}
function boxFromAnchor(landmarkPx, anchor, viewportPx){
  const {dx,dy,w,h} = anchor; // normalized offsets relative to page
  return { x: landmarkPx.x + dx*viewportPx.w, y: landmarkPx.y + dy*viewportPx.h, w: w*viewportPx.w, h: h*viewportPx.h, page: landmarkPx.page };
}

function ensureGrayCanvas(page){
  if(state.grayCanvases[page]) return state.grayCanvases[page];
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  const offY = state.pageOffsets[page-1] || 0;
  const vp = state.pageViewports[page-1] || state.viewport;
  const w = src.width;
  const h = Math.round((vp.h ?? vp.height) || 1);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, offY, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0,0,w,h);
  for(let i=0;i<img.data.length;i+=4){
    const g = Math.round(0.299*img.data[i] + 0.587*img.data[i+1] + 0.114*img.data[i+2]);
    img.data[i]=img.data[i+1]=img.data[i+2]=g;
  }
  ctx.putImageData(img,0,0);
  state.grayCanvases[page]=canvas;
  return canvas;
}

function sobelEdges(data, w, h){
  const out = new Uint8Array(w*h);
  const thresh = 0.3;
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i = y*w + x;
      const gx = -data[i-w-1] -2*data[i-1] -data[i+w-1] + data[i-w+1] +2*data[i+1] + data[i+w+1];
      const gy = -data[i-w-1] -2*data[i-w] -data[i-w+1] + data[i+w-1] +2*data[i+w] + data[i+w+1];
      const g = Math.sqrt(gx*gx + gy*gy);
      out[i] = g > thresh ? 1 : 0;
    }
  }
  return out;
}

function captureRingLandmark(boxPx, rot=0){
  const src = ensureGrayCanvas(boxPx.page);
  const pad = 8;
  const side = Math.max(boxPx.w, boxPx.h) + pad*2;
  const x = Math.round(boxPx.x + boxPx.w/2 - side/2);
  const y = Math.round(boxPx.y + boxPx.h/2 - side/2);
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const cctx = canvas.getContext('2d');
  cctx.translate(size/2, size/2);
  if(rot) cctx.rotate(-rot);
  cctx.translate(-size/2, -size/2);
  cctx.drawImage(src, x, y, side, side, 0, 0, size, size);
  const img = cctx.getImageData(0,0,size,size);
  const lum = new Float32Array(size*size);
  const ringMask = new Uint8Array(size*size);
  const cx=size/2, cy=size/2;
  const delta = 5;
  const innerR = (size/2) * (Math.max(boxPx.w, boxPx.h) / side) + delta;
  const outerR = size/2 - delta;
  let sum=0, sumSq=0, count=0;
  for(let j=0;j<size;j++){
    for(let i=0;i<size;i++){
      const idx = j*size + i;
      const val = img.data[idx*4];
      lum[idx]=val;
      const dx=i-cx, dy=j-cy; const dist=Math.sqrt(dx*dx+dy*dy);
      const m = (dist>=innerR && dist<=outerR)?1:0;
      ringMask[idx]=m;
      if(m){ sum+=val; sumSq+=val*val; count++; }
    }
  }
  const mean = count?sum/count:0;
  const std = count?Math.sqrt(sumSq/count - mean*mean):1;
  const norm = new Float32Array(size*size);
  for(let i=0;i<norm.length;i++) norm[i] = (lum[i]-mean)/std;
  const edgePatch = sobelEdges(norm, size, size);
  for(let i=0;i<edgePatch.length;i++) if(!ringMask[i]) edgePatch[i]=0;
  return { patchSize:size, ringMask, edgePatch, mean, std,
    offset:{dx:0,dy:0,w:boxPx.w/side,h:boxPx.h/side} };
}

function edgeScore(sample, tmpl, half=null){
  const mask = tmpl.ringMask;
  const w = tmpl.patchSize;
  let count=0, sumA=0, sumB=0;
  for(let i=0;i<mask.length;i++){
    if(!mask[i]) continue;
    const x=i%w;
    if(half==='right' && x < w/2) continue;
    if(half==='left' && x >= w/2) continue;
    sumA += sample.edgePatch[i];
    sumB += tmpl.edgePatch[i];
    count++;
  }
  const meanA = count?sumA/count:0;
  const meanB = count?sumB/count:0;
  let num=0, dA=0, dB=0, match=0;
  for(let i=0;i<mask.length;i++){
    if(!mask[i]) continue;
    const x=i%w;
    if(half==='right' && x < w/2) continue;
    if(half==='left' && x >= w/2) continue;
    const a = sample.edgePatch[i];
    const b = tmpl.edgePatch[i];
    num += (a-meanA)*(b-meanB);
    dA += (a-meanA)*(a-meanA);
    dB += (b-meanB)*(b-meanB);
    if(a===b) match++;
  }
  if(dA>0 && dB>0) return { score: num/Math.sqrt(dA*dB), comparator:'edge_zncc' };
  return { score: count?match/count:-1, comparator:'edge_hamming' };
}

function matchRingLandmark(lm, guessPx, half=null){
  const vp = state.pageViewports[guessPx.page-1] || state.viewport;
  const range = 0.25 * ((vp.h ?? vp.height) || 1);
  const step = 4;
  let best = { score:-1, box:null, comparator:null };
  for(let dy=-range; dy<=range; dy+=step){
    for(let dx=-range; dx<=range; dx+=step){
      const box = { x: guessPx.x+dx, y: guessPx.y+dy, w: guessPx.w, h: guessPx.h, page: guessPx.page };
      const sample = captureRingLandmark(box, state.pageTransform.rotation);
      const {score, comparator} = edgeScore(sample, lm, half);
      if(score > best.score){ best = { score, box, comparator }; }
    }
  }
  const thresh = half ? 0.60 : 0.75;
  if(best.score >= thresh){ best.box.score = best.score; best.box.comparator = best.comparator; return best.box; }
  return null;
}

function anchorAssist(hints=[], tokens=[], guessPx){
  if(!hints.length || !tokens.length) return null;
  const rx = new RegExp(hints.map(h=>h.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'), 'i');
  const near = tokens.filter(t=> t.page===guessPx.page && rx.test(t.text) && Math.abs((t.y+t.h/2)-(guessPx.y+guessPx.h/2)) < guessPx.h*4);
  if(!near.length) return null;
  const lab = near[0];
  const right = tokens.filter(t=> t.page===lab.page && t.x > lab.x + lab.w + 2 && Math.abs((t.y+t.h/2)-(lab.y+lab.h/2)) < lab.h*1.5);
  if(right.length){ return { box: bboxOfTokens(right) }; }
  const below = tokens.filter(t=> t.page===lab.page && t.y > lab.y + lab.h && t.y < lab.y + lab.h + guessPx.h*2);
  if(below.length){ return { box: bboxOfTokens(below) }; }
  return null;
}

async function calibrateIfNeeded(){
  const tokens = state.tokensByPage[1] || [];
  if(tokens.length > 5 || !(state.profile?.globals||[]).length) return;
  const vp = state.pageViewports[0] || state.viewport;
  const candidates=[];
  [0.9,1,1.1].forEach(s=>{ [-1,0,1].forEach(r=>{ candidates.push({scale:s, rotation:r*Math.PI/180}); }); });
  let best={score:-Infinity, scale:1, rotation:0};
  for(const cand of candidates){
    let sum=0, count=0;
    for(const g of state.profile.globals){
      const base = toPx(vp, {x0:g.bboxPct.x0,y0:g.bboxPct.y0,x1:g.bboxPct.x1,y1:g.bboxPct.y1,page:1});
      const box = applyTransform(base, cand);
      const sample = captureRingLandmark(box, cand.rotation);
      const {score} = edgeScore(sample, g.landmark);
      if(score>-1){ sum+=score; count++; }
    }
    const avg = count?sum/count:-Infinity;
    if(avg > best.score){ best = { score:avg, scale:cand.scale, rotation:cand.rotation }; }
    if(best.score > 0.9) break;
  }
  state.pageTransform = { scale: best.scale, rotation: best.rotation };
}

function buildColumnModel(step, norm, boxPx, tokens){
  const vp = state.viewport;
  const pageWidthPx = Math.max(1, ((vp.w ?? vp.width) || 1));
  const pageHeightPx = Math.max(1, ((vp.h ?? vp.height) || 1));
  const colTokens = tokens
    .filter(t=> intersect(t, boxPx))
    .map(t => ({ ...t, cy: t.y + t.h/2 }));
  const avgH = colTokens.length ? colTokens.reduce((s,t)=>s+t.h,0)/colTokens.length : 0;
  const lineHeightPct = avgH / pageHeightPx;
  const right = boxPx.x + boxPx.w;
  const rightAligned = colTokens.filter(t => Math.abs((t.x + t.w) - right) < boxPx.w*0.1).length;
  const align = rightAligned > (colTokens.length/2) ? 'right' : 'left';
  let headerTokens = colTokens.filter(t => t.cy < boxPx.y + avgH*1.5);
  const headerLooksNumeric = headerTokens.length && headerTokens.every(tok => {
    const text = (tok.text || '').trim();
    return text && /[0-9]/.test(text) && !/[A-Za-z]/.test(text);
  });
  if(headerLooksNumeric){
    headerTokens = [];
  }
  const sortedTokens = colTokens.slice().sort((a,b)=> a.cy - b.cy || a.x - b.x || a.y - b.y);
  const earliestToken = sortedTokens[0];
  let headerBottomPx = headerTokens.length
    ? Math.max(...headerTokens.map(t=>t.y + t.h))
    : boxPx.y + Math.max(avgH || 0, 6) * 0.75;
  if(earliestToken){
    headerBottomPx = Math.min(headerBottomPx, earliestToken.y);
  }
  const dataPad = Math.max(avgH || 0, 6) * (headerTokens.length ? 0.3 : 0.18);
  let dataTokens = sortedTokens.filter(t => t.cy > headerBottomPx + dataPad);
  if(!dataTokens.length){
    dataTokens = sortedTokens;
  }
  const header = headerTokens.length ? toPct(vp, bboxOfTokens(headerTokens)) : null;
  headerBottomPx = Math.max(boxPx.y, Math.min(headerBottomPx, boxPx.y + boxPx.h));
  const anchorToken = dataTokens[0];
  const anchorSample = anchorToken ? {
    cyNorm: (anchorToken.y + anchorToken.h/2) / pageHeightPx,
    hNorm: anchorToken.h / pageHeightPx,
    text: (anchorToken.text || '').trim(),
    x0Norm: anchorToken.x / pageWidthPx,
    x1Norm: (anchorToken.x + anchorToken.w) / pageWidthPx
  } : null;
  const anchorSampleMetrics = anchorToken
    ? anchorMetricsFromBox({ x: anchorToken.x, y: anchorToken.y, w: anchorToken.w, h: anchorToken.h }, pageWidthPx, pageHeightPx, [anchorToken.h], anchorToken.h)
    : null;
  const rowSamples = dataTokens.slice(0, 8).map(t => ({
    cyNorm: (t.y + t.h/2) / pageHeightPx,
    hNorm: t.h / pageHeightPx
  }));
  const feraHeights = [];
  if(anchorSample?.hNorm){ feraHeights.push(anchorSample.hNorm * pageHeightPx); }
  rowSamples.forEach(s => { if(Number.isFinite(s.hNorm)) feraHeights.push(s.hNorm * pageHeightPx); });
  const fallbackFeraHeight = feraHeights.length ? median(feraHeights) : (Number.isFinite(boxPx.h) ? boxPx.h : 0);
  const fera = anchorMetricsFromBox(
    { x: boxPx.x, y: boxPx.y, w: boxPx.w, h: boxPx.h },
    pageWidthPx,
    pageHeightPx,
    feraHeights,
    fallbackFeraHeight || (Number.isFinite(boxPx.h) ? boxPx.h : 0)
  );
  const guardWords = ['subtotal','sub-total','total','tax','hst','gst','qst','balance','deposit','notes','amount','amountdue'];
  return {
    xband:[norm.x0, norm.x1],
    yband:[norm.y0, norm.y1],
    lineHeightPct,
    regexHint: step.regex || '',
    align,
    header: header ? [header.x0, header.y0, header.x1, header.y1] : null,
    headerBottomPct: headerBottomPx / pageHeightPx,
    anchorSample,
    anchorSampleMetrics,
    rowSamples,
    fera,
    guardWords,
    bottomGuards: guardWords
  };
}

function captureGlobalLandmarks(){
  ensureProfile();
  const vp = state.pageViewports[0] || state.viewport;
  const samples = [
    {x0:0.02,y0:0.02,x1:0.06,y1:0.06,page:1},
    {x0:0.50,y0:0.02,x1:0.54,y1:0.06,page:1},
    {x0:0.80,y0:0.90,x1:0.84,y1:0.94,page:1}
  ];
  state.profile.globals = samples.map(b=>{
    const px = toPx(vp, b);
    const lm = captureRingLandmark(px);
    return { bboxPct:{x0:b.x0,y0:b.y0,x1:b.x1,y1:b.y1}, landmark: lm };
  });
  saveProfile(state.username, state.docType, state.profile);
  if(isSkinV2){
    persistPatternBundle(state.profile);
  }
}

/* ----------------------- Field Extraction ------------------------ */
function ocrConfigFor(fieldKey){
  if(/sku/i.test(fieldKey)){
    return { psm:7, whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' };
  }
  if(/total|subtotal|tax|amount|price|balance|deposit|discount|unit|qty|quantity/i.test(fieldKey)){
    return { psm:7, whitelist:'0123456789.,-' };
  }
  return { psm:7, whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./' };
}

function preprocessCanvas(canvas){
  const ctx = canvas.getContext('2d');
  const {width,height} = canvas;
  const img = ctx.getImageData(0,0,width,height);
  const data = img.data;
  let sum=0; let count=data.length/4;
  for(let i=0;i<data.length;i+=4){
    const gray = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    data[i]=data[i+1]=data[i+2]=gray;
    sum+=gray;
  }
  const mean = sum/count;
  for(let i=0;i<data.length;i+=4){
    const v = data[i] < mean ? 0 : 255;
    data[i]=data[i+1]=data[i+2]=v;
  }
  const tmp = document.createElement('canvas');
  tmp.width=width; tmp.height=height;
  tmp.getContext('2d').putImageData(img,0,0);
  ctx.filter='blur(1px)';
  ctx.drawImage(tmp,0,0);
  ctx.filter='none';
}

function rotateCanvas(src, deg){
  if(!deg) return src;
  const rad = deg*Math.PI/180;
  const w = src.width, h = src.height;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.abs(w*Math.cos(rad)) + Math.abs(h*Math.sin(rad)));
  canvas.height = Math.ceil(Math.abs(w*Math.sin(rad)) + Math.abs(h*Math.cos(rad)));
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width/2, canvas.height/2);
  ctx.rotate(rad);
  ctx.drawImage(src,-w/2,-h/2);
  return canvas;
}

function clampRect(r, maxW, maxH){
  const x = Math.min(Math.max(r.x,0), maxW);
  const y = Math.min(Math.max(r.y,0), maxH);
  const w = Math.max(0, Math.min(r.w, maxW - x));
  const h = Math.max(0, Math.min(r.h, maxH - y));
  return { x, y, w, h, page: r.page };
}

function getPdfBitmapCanvas(pageIndex){
  const node = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!node || node.tagName !== 'CANVAS' || node === els.overlayCanvas || node.width<=0 || node.height<=0){
    return { canvas:null, error:'wrong_source_element' };
  }
  const ctx = node.getContext('2d');
  if(!ctx){
    return { canvas:null, error:'wrong_source_element' };
  }
  if(!state.isImage && (pageIndex < 0 || pageIndex >= state.pageViewports.length)){
    return { canvas:null, error:'page_mismatch' };
  }
  return { canvas: node, error:null };
}

function dataUrlToBytes(dataUrl){
  if(!dataUrl || typeof dataUrl !== 'string') return new Uint8Array();
  const base64 = dataUrl.split(',')[1] || '';
  if(typeof Buffer !== 'undefined'){
    try { return Buffer.from(base64, 'base64'); }
    catch(err){ return Buffer.from(''); }
  }
  if(typeof atob !== 'function') return new Uint8Array();
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) out[i] = binary.charCodeAt(i);
  return out;
}

function getOcrCropForSelection({docId, pageIndex, normBox}){
  const { canvas: src, error: canvasErr } = getPdfBitmapCanvas(pageIndex);
  const result = { cropBitmap: null, meta: { docId, pageIndex, errors: [], warnings: [], normBox, canvasSize:null, computedPx:null, cssBox:null, overlayPinned:isOverlayPinned() } };
  if(!result.meta.overlayPinned){ result.meta.errors.push('overlay_not_pinned'); }
  if(canvasErr){ result.meta.errors.push(canvasErr); return result; }

  const val = validateSelection(normBox);
  if(!val.ok){ result.meta.errors.push(val.reason); return result; }
  normBox = val.normBox;

  if(!state.pageRenderReady[pageIndex]){
    result.meta.errors.push('render_not_ready');
    return result;
  }

  const vp = state.pageViewports[pageIndex] || state.viewport || { width: src.width, height: src.height, scale:1 };
  const viewportScale = Number(vp.scale || 1);
  const logicalW = Math.max(1, Number(vp.width ?? vp.w ?? src.width));
  const logicalH = Math.max(1, Number(vp.height ?? vp.h ?? src.height));
  const dpr = Number(window.devicePixelRatio || 1);
  const W = Number(src.width);
  const H = Number(src.height);
  const renderScaleX = W && logicalW ? W / logicalW : 1;
  const renderScaleY = H && logicalH ? H / logicalH : 1;
  const inputs = { canvasW: W, canvasH: H, viewportScale, dpr, logicalW, logicalH, renderScaleX, renderScaleY };
  for(const [k,v] of Object.entries(inputs)){
    if(typeof v !== 'number' || !Number.isFinite(v)){
      result.meta.errors.push(`nan_or_infinity_in_math(${k})`);
      return result;
    }
    if(v <= 0){ result.meta.errors.push('render_not_ready'); return result; }
  }
  const scale = state.pageTransform?.scale || 1;
  const rotation = state.pageTransform?.rotation || 0;
  const offY = state.pageOffsets[pageIndex] || 0;
  result.meta.canvasSize = { w: W, h: H, dpr, scale: viewportScale, rotation, logicalW, logicalH, renderScaleX, renderScaleY };

  // Work entirely in logical (CSS/pdf.js) space for transforms/anchors, then
  // map to the rendered canvas with the render scale. This keeps stored/queried
  // boxes aligned with token coordinates regardless of device pixel ratio.
  let { sx, sy, sw, sh } = denormalizeBox(normBox, logicalW, logicalH);
  let box = { x:sx, y:sy, w:sw, h:sh, page: pageIndex+1 };
  if(scale !== 1 || rotation !== 0){
    box = applyTransform(box, { scale, rotation });
    sx = box.x; sy = box.y; sw = box.w; sh = box.h;
  }
  const sxPx = Math.round(sx * renderScaleX);
  const syPx = Math.round(sy * renderScaleY);
  const swPx = Math.max(1, Math.round(sw * renderScaleX));
  const shPx = Math.max(1, Math.round(sh * renderScaleY));

  let clamped = false;
  if(sxPx < 0){ swPx += sxPx; sxPx = 0; clamped = true; }
  if(syPx < 0){ shPx += syPx; syPx = 0; clamped = true; }
  if(sxPx + swPx > W){ swPx = W - sxPx; clamped = true; }
  if(syPx + shPx > H){ shPx = H - syPx; clamped = true; }

  const nums = { W, H, sx: sxPx, sy: syPx, sw: swPx, sh: shPx, dpr, scale, rotation, offY };
  for(const [k,v] of Object.entries(nums)){
    if(typeof v !== 'number' || !Number.isFinite(v)){
      result.meta.errors.push(`nan_or_infinity_in_math(${k})`);
      return result;
    }
  }
  result.meta.computedPx = { sx: sxPx, sy: syPx, sw: swPx, sh: shPx, rotation };
  if(swPx <= 2 || shPx <= 2){
    result.meta.errors.push('tiny_or_zero_crop');
    result.meta.clamped = clamped;
    return result;
  }

  const off = document.createElement('canvas');
  off.className = 'debug-crop';
  off.width = swPx; off.height = shPx;
  const octx = off.getContext('2d');
  octx.clearRect(0,0,swPx,shPx);
  try{
    octx.drawImage(src, sxPx, offY + syPx, swPx, shPx, 0, 0, swPx, shPx);
  }catch(err){
    console.error('drawImage failed', err);
    result.meta.errors.push('canvas_tainted');
    return result;
  }

  const cssSX = sx;
  const cssSY = sy;
  const cssSW = sw;
  const cssSH = sh;

  // hash for duplicate detection
  const pngBytes = dataUrlToBytes(off.toDataURL('image/png'));
  const crypto = window.crypto?.subtle ? null : (window.require && window.require('crypto'));
  let hash='';
  if(crypto){
    hash = crypto.createHash('sha1').update(pngBytes).digest('hex');
  }
  if(hash){
    const pageKey = `${docId}_${pageIndex}`;
    state.cropHashes[pageKey] = state.cropHashes[pageKey] || {};
    const prev = state.cropHashes[pageKey][hash];
    if(prev && (prev.x!==sx || prev.y!==sy || prev.w!==sw || prev.h!==sh)){
      console.error('ERROR: repeated-crop-content suspected wrong-source-or-rect', prev, {x:sx,y:sy,w:sw,h:sh,pageIndex});
      result.meta.errors.push('repeated-crop-content suspected wrong-source-or-rect');
    }
    state.cropHashes[pageKey][hash] = { x:sx, y:sy, w:sw, h:sh };
  }

  const imgData = octx.getImageData(0,0,swPx,shPx).data;
  let uniform = true;
  const r0 = imgData[0], g0 = imgData[1], b0 = imgData[2], a0 = imgData[3];
  for(let i=4;i<imgData.length;i+=4){
    if(imgData[i]!==r0 || imgData[i+1]!==g0 || imgData[i+2]!==b0 || imgData[i+3]!==a0){ uniform=false; break; }
  }
  if(uniform){ result.meta.errors.push('blank_or_uniform_crop'); }
  const rowHashes = new Set();
  for(let y=0;y<shPx;y++){
    let row='';
    for(let x=0;x<swPx;x++){
      const i=(y*swPx+x)*4; row+=imgData[i]+','+imgData[i+1]+','+imgData[i+2]+','+imgData[i+3]+';';
    }
    rowHashes.add(row);
  }
  const colHashes = new Set();
  for(let x=0;x<swPx;x++){
    let col='';
    for(let y=0;y<shPx;y++){
      const i=(y*swPx+x)*4; col+=imgData[i]+','+imgData[i+1]+','+imgData[i+2]+','+imgData[i+3]+';';
    }
    colHashes.add(col);
  }
  const bandingScore = Math.max(1 - rowHashes.size/shPx, 1 - colHashes.size/swPx);
  if(bandingScore > 0.3){ result.meta.warnings.push('banding/tiling-like artifact'); }

  const fs = window.fs || (window.require && window.require('fs'));
  if(fs){
    const pageSnapKey = `${docId}_${pageIndex}`;
    if(!state.pageSnapshots[pageSnapKey]){
      const pageDir = `debug/pages/${docId}`;
      fs.mkdirSync(pageDir,{recursive:true});
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = W; pageCanvas.height = H;
      const pctx = pageCanvas.getContext('2d');
      pctx.drawImage(src, 0, offY, W, H, 0,0,W,H);
      const pagePng = dataUrlToBytes(pageCanvas.toDataURL('image/png'));
      fs.writeFileSync(`${pageDir}/${pageIndex}.png`, pagePng);
      state.pageSnapshots[pageSnapKey] = true;
    }
  }

  result.cropBitmap = off;
  result.meta.pdfCanvas = { w: src.width, h: src.height };
  result.meta.hash = hash;
  result.meta.bandingScore = bandingScore;
  result.meta.clamped = clamped;
  state.lastOcrCropCss = { x:cssSX, y:cssSY, w:cssSW, h:cssSH, page: pageIndex+1 };
  state.lastOcrCropPx = { x:sxPx, y:syPx, w:swPx, h:shPx, page: pageIndex+1 };
  result.meta.cssBox = { sx: cssSX, sy: cssSY, sw: cssSW, sh: cssSH };
  drawOverlay();
  return result;
}

async function runOcrProbes(crop){
  const out = {};
  for(const psm of [6,7]){
    const { data } = await TesseractRef.recognize(crop,'eng',{ tessedit_pageseg_mode:psm });
    const toks=(data.words||[]).map(w=>w.text.trim()).filter(Boolean);
    const mean=toks.length? (data.words.reduce((s,w)=>s+w.confidence,0)/toks.length)/100 : 0;
    out[`psm${psm}`] = { raw:data.text, tokens:toks, tokensLength:toks.length, meanConf:mean };
  }
  return out;
}

function chooseBestProbe(probe){
  let best = { psm:'psm6', tokensLength:-1, meanConf:-1, raw:'', tokens:[] };
  for(const psmKey of ['psm6','psm7']){
    const r = probe[psmKey];
    if(!r) continue;
    if(r.tokensLength > best.tokensLength || (r.tokensLength === best.tokensLength && r.meanConf > best.meanConf)){
      best = { psm: psmKey, ...r };
    }
  }
  return best;
}

function _iou(a,b){
  const ix=Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
  const iy=Math.max(0, Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  const inter=ix*iy; if(!inter) return 0;
  return inter / (a.w*a.h + b.w*b.h - inter);
}
function _centerDist(a,b){
  const ax=a.x+a.w/2, ay=a.y+a.h/2;
  const bx=b.x+b.w/2, by=b.y+b.h/2;
  return Math.hypot(ax-bx, ay-by);
}

async function ocrBox(boxPx, fieldKey){
  const pad = 4;
  const { canvas: src } = getPdfBitmapCanvas((boxPx.page||1)-1);
  if(!src) return [];
  const offY = state.pageOffsets[boxPx.page-1] || 0;
  const scale = 3;

  const cfg = ocrConfigFor(fieldKey);
  const opts = { tessedit_pageseg_mode: cfg.psm, oem:1 };
  if(cfg.whitelist) opts.tessedit_char_whitelist = cfg.whitelist;

  async function runBox(subBox){
    const canvas = document.createElement('canvas');
    canvas.width = (subBox.w + pad*2)*scale;
    canvas.height = (subBox.h + pad*2)*scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, subBox.x - pad, offY + subBox.y - pad, subBox.w + pad*2, subBox.h + pad*2, 0, 0, canvas.width, canvas.height);
    preprocessCanvas(canvas);
    let bestTokens = [], bestAvg = -Infinity;
    for(const ang of [-3,0,3]){
      const rot = rotateCanvas(canvas, ang);
      const { data } = await TesseractRef.recognize(rot, 'eng', opts);
      const words = (data.words||[]).map(w=>{
        const raw = w.text.trim();
        if(!raw) return null;
        const { text: corrected, corrections } = applyOcrCorrections(raw, fieldKey);
        return {
          raw,
          corrected,
          text: corrected,
          correctionsApplied: corrections,
          confidence: w.confidence/100,
          x: subBox.x - pad + w.bbox.x/scale,
          y: subBox.y - pad + w.bbox.y/scale,
          w: w.bbox.width/scale,
          h: w.bbox.height/scale,
          page: subBox.page
        };
      }).filter(Boolean);
      const filtered = tokensInBox(words, subBox);
      const avg = filtered.reduce((s,t)=>s+t.confidence,0)/(filtered.length||1);
      if(avg > bestAvg){ bestAvg=avg; bestTokens = filtered; }
    }
    return { tokens: bestTokens, avg: bestAvg };
  }

  const { tokens: baseTokens, avg: baseAvg } = await runBox(boxPx);
  traceEvent(
    { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: (boxPx.page||1)-1, fieldKey },
    'ocr.raw',
    {
      tokens: baseTokens.length,
      stageLabel:'OCR raw pass',
      stepNumber:1,
      counts:{ tokens: baseTokens.length },
      bbox:{ pixel: boxPx },
      ocrConfig:{ psm: cfg.psm, whitelist: !!cfg.whitelist, scale },
      confidence:{ averageWordConfidence: baseAvg },
      inputsSnapshot:{ boxPx }
    }
  );

  const TILE=512, OVER=0.15;
  const area=boxPx.w*boxPx.h;
  const needTiles = area > TILE*TILE || baseAvg < 0.6;
  if(!needTiles) return baseTokens;

  const step=TILE*(1-OVER);
  const tiles=[];
  for(let ty=0; ty<boxPx.h; ty+=step){
    for(let tx=0; tx<boxPx.w; tx+=step){
      const tile={ x:boxPx.x+tx, y:boxPx.y+ty, w:Math.min(TILE, boxPx.w-tx), h:Math.min(TILE, boxPx.h-ty), page:boxPx.page };
      const { tokens } = await runBox(tile);
      tiles.push({ box:tile, tokens });
    }
  }

  const merged=[];
  for(const t of tiles){
    for(const tok of t.tokens){
      let m = merged.find(o => o.text===tok.text && (_iou(o,tok)>0.8 || _centerDist(o,tok)<5));
      if(m){
        const total=m.confidence+tok.confidence;
        m.x=(m.x*m.confidence + tok.x*tok.confidence)/total;
        m.y=(m.y*m.confidence + tok.y*tok.confidence)/total;
        m.w=(m.w*m.confidence + tok.w*tok.confidence)/total;
        m.h=(m.h*m.confidence + tok.h*tok.confidence)/total;
        m.confidence=Math.min(1,total/2);
      } else {
        merged.push({...tok});
      }
    }
  }

  const totalTileTokens = tiles.reduce((sum,t)=>sum + (t.tokens?.length || 0),0);
  traceEvent(
    { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: (boxPx.page||1)-1, fieldKey },
    'ocr.tiled',
    {
      tiles: tiles.map((t,i)=>({ index:i, tokens:t.tokens.length })),
      stageLabel:'OCR tiled pass',
      stepNumber:2,
      counts:{ tiles: tiles.length, tokens: totalTileTokens },
      bbox:{ pixel: boxPx },
      ocrConfig:{ psm: cfg.psm, whitelist: !!cfg.whitelist, scale },
      heuristics:{ tiled:true, overlap: OVER },
      notes:'Tiled OCR used due to size/confidence threshold'
    }
  );
  return merged;
}

async function auditCropSelfTest(question, boxPx){
  if(!boxPx){
    state.cropAudits.push({ question, reason:'no_selection', ocrProbe:{}, best:{}, thumbUrl:'', meta:{} });
    renderCropAuditPanel();
    return { errors:['no_selection'] };
  }
  const docId = (state.currentFileName || 'doc').replace(/[^a-z0-9_-]/gi,'_');
  const pageIndex = (boxPx.page||1) - 1;
  const vp = state.pageViewports[pageIndex] || state.viewport || {width:1,height:1};
  const canvasW = (vp.width ?? vp.w) || 1;
  const canvasH = (vp.height ?? vp.h) || 1;
  const normBox = normalizeBox(boxPx, canvasW, canvasH);
  const { cropBitmap, meta } = getOcrCropForSelection({ docId, pageIndex, normBox });
  meta.question = question;
  const fs = window.fs || (window.require && window.require('fs'));
  const dir = `debug/crops/${docId}/${pageIndex}`;
  const ts = Date.now();
  const baseName = `${question}__${ts}`;
  const bufFromCanvas = c => dataUrlToBytes(c.toDataURL('image/png'));
  if(fs){ fs.mkdirSync(dir,{recursive:true}); }
  if(cropBitmap && fs){ fs.writeFileSync(`${dir}/${baseName}.png`, bufFromCanvas(cropBitmap)); }
  if(cropBitmap && !fs){ console.log('OCR crop', cropBitmap.toDataURL('image/png')); }
  console.log({ question, canvasSize: meta.canvasSize, normBox: meta.normBox, computedPx: meta.computedPx });
  meta.normBox = normBox;
  if(meta.errors.length){
    meta.status='needs_review';
    meta.reason = meta.errors[0] || 'crop_geometry_error';
    if(fs) fs.writeFileSync(`${dir}/${baseName}.json`, JSON.stringify(meta,null,2));
    state.cropAudits.push({ question, reason: meta.reason, ocrProbe:{}, best:{}, thumbUrl:'', meta });
    renderCropAuditPanel();
    return meta;
  }
  let blob;
  try{
    blob = await new Promise(res => cropBitmap.toBlob(res, 'image/png'));
  }catch(e){ blob = null; }
  if(!blob){
    meta.status='needs_review';
    meta.reason='blob_or_image_failed';
    meta.errors.push('blob_or_image_failed');
    state.cropAudits.push({ question, reason: meta.reason, ocrProbe:{}, best:{}, thumbUrl:'', meta });
    renderCropAuditPanel();
    return meta;
  }
  const url = URL.createObjectURL(blob);
  const probe = await runOcrProbes(cropBitmap);
  meta.ocrProbe = probe;
  const best = chooseBestProbe(probe);
  meta.best = best;
  const labels=['subtotal','tax','total','hst'];
  if(best.tokensLength===0){
    meta.status='needs_review'; meta.reason='empty_ocr_for_box';
  } else if(best.tokens.every(t=>labels.includes(t.toLowerCase()))){
    meta.status='needs_review'; meta.reason='label_only_in_box';
  } else if(!meta.reason){
    meta.status='ok';
  }
  if(fs) fs.writeFileSync(`${dir}/${baseName}.json`, JSON.stringify(meta,null,2));
  state.cropAudits.push({
    question,
    reason: meta.reason,
    ocrProbe: probe,
    best,
    thumbUrl: url,
    meta
  });
  renderCropAuditPanel();
  return meta;
}

function labelValueHeuristic(fieldSpec, tokens){
  let value = '', usedBox = null, confidence = 0;
  const lines = groupIntoLines(tokens);
  for(const L of lines){
    const txt = L.tokens.map(t=>t.text).join(' ');
    const want = (fieldSpec.fieldKey||'').replace(/_/g,' ');
    const labelRe = new RegExp(
      fieldSpec.regex === RE.currency.source
        ? '(total|sub\\s*-?\\s*total|deposit|balance|hst|qst)'
        : want ? want.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') : '(order|invoice|no\\.?|customer|date|term|store)',
      'i'
    );
    if(labelRe.test(txt)){
      const lab = L.tokens.find(t => labelRe.test(t.text));
      const right = L.tokens.filter(t => t.x > (lab?.x ?? 0) + (lab?.w ?? 0) + 2);
      if(right.length){
        const tmpBox = bboxOfTokens(right);
        const snap = snapToLine(tokens, tmpBox);
        usedBox = snap.box;
        const txt2 = (snap.text||'').trim();
        const rx = fieldSpec.regex ? new RegExp(fieldSpec.regex,'i')
                 : /total|deposit|balance|hst|qst/i.test(want) ? RE.currency
                 : /date/i.test(want) ? RE.date
                 : /order|invoice|no/i.test(want) ? RE.orderLike
                 : null;
        const m = rx ? (txt2.match(rx)||[])[1] : txt2;
        if(m){ value = (m||txt2).toString(); confidence = rx ? 0.8 : 0.72; break; }
      }
    }
  }
  return { value, usedBox, confidence };
}

  async function extractFieldValue(fieldSpec, tokens, viewportPx){
  const ftype = fieldSpec.type || 'static';
  const spanKey = { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: (fieldSpec.page||1)-1, fieldKey: fieldSpec.fieldKey || '' };
  const runMode = isRunMode();
  const staticRun = runMode && ftype === 'static';
  const configMask = normalizeConfigMask(fieldSpec);
  const staticMinOverlap = staticRun ? 0.5 : (isConfigMode() ? 0.5 : 0.7);
  const stageUsed = { value: null };
  const fieldKeyLower = (fieldSpec.fieldKey || '').toLowerCase();
  const isCustomerNameField = fieldKeyLower === 'customer_name';
  const isCustomerAddressField = fieldKeyLower === 'customer_address';
  let hintLocked = false;
  let bestHintCandidate = null;
  let hintCenter = null;
  let hintBand = null;
  let nearHintCount = 0;
  let viewportDims = getViewportDimensions(viewportPx);
  const suppliedTokens = Array.isArray(tokens) ? tokens : [];
  tokens = suppliedTokens;
  const tokensScoped = fieldSpec.tokenScope === 'area' || fieldSpec.useSuppliedTokensOnly || fieldSpec.tokensScoped;
  const preferSuppliedTokens = staticRun && tokensScoped;
  const keywordCacheable = !preferSuppliedTokens;
  if(!viewportDims.width || !viewportDims.height){
    viewportDims = getPageViewportSize(fieldSpec.page || state.pageNum || 1);
  }
  const enforceAnchors = isRunMode() && !!fieldSpec.anchorMetrics;
  const anchorMatchesCandidate = cand => {
    if(!enforceAnchors) return { ok:true, softOk:true, status:'skip', score:1 };
    if(!cand || !cand.boxPx) return { ok:false, softOk:false, status:'fail', score:0 };
    const debugCtx = (runMode && ftype==='static' && isStaticFieldDebugTarget(fieldSpec.fieldKey))
      ? { enabled:true, fieldKey: fieldSpec.fieldKey, page: cand.boxPx.page }
      : null;
    return anchorMatchForBox(fieldSpec.anchorMetrics, cand.boxPx, cand.tokens || [], viewportDims.width, viewportDims.height, debugCtx);
  };
  const keywordRelations = (staticRun && KEYWORD_RELATION_SCOPE.has(fieldSpec.fieldKey))
    ? (fieldSpec.keywordRelations || null)
    : null;
  const computeLineDiff = (observedLineCount, expectedHint)=>{
    const expected = expectedHint ?? fieldSpec?.lineMetrics?.lineCount ?? fieldSpec?.lineCount ?? observedLineCount ?? 0;
    const observed = observedLineCount ?? 0;
    return { lineDiff: Math.abs(observed - (expected || 0)), expectedLineCount: expected || 0 };
  };
  const distanceToHint = box => {
    if(!box || !hintCenter) return Infinity;
    return Math.abs((box.y + (box.h||0)/2) - hintCenter.y);
  };
  const lineScoreForDiff = diff => {
    if(Object.prototype.hasOwnProperty.call(STATIC_LINE_DIFF_WEIGHTS, diff)){
      return STATIC_LINE_DIFF_WEIGHTS[diff];
    }
    return STATIC_LINE_DIFF_WEIGHTS.default;
  };
  if(staticRun && keywordRelations && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
    logStaticDebug(`keyword-rel load ${fieldSpec.fieldKey||''} page=${keywordRelations.page || fieldSpec.page || state.pageNum || 1}`,
      { keywordRelations });
  }
  const ensureKeywordIndexForPage = async (page)=>{
    if(!page) return [];
    const vp = state.pageViewports[(page||1)-1] || state.viewport || viewportDims;
    let pageTokens = (page === (fieldSpec.page || state.pageNum || page))
      ? tokens
      : (preferSuppliedTokens ? [] : (state.tokensByPage?.[page] || null));
    if(!preferSuppliedTokens && (pageTokens?.length || 0) === 0 && ensureTokensForPage){
      pageTokens = await ensureTokensForPage(page);
    }
    return await buildKeywordIndexForPage(page, pageTokens, vp, { cache: keywordCacheable });
  };
  const getPageSize = (page)=>{
    const vp = state.pageViewports[(page||1)-1] || viewportDims || {};
    const pageW = (vp.width ?? vp.w ?? viewportDims.width ?? 1) || 1;
    const pageH = (vp.height ?? vp.h ?? viewportDims.height ?? 1) || 1;
    return { pageW, pageH };
  };

    if(state.modes.rawData){
    let boxPx = null;
    if(isConfigMode() && state.snappedPx){
      boxPx = state.snappedPx;
      traceEvent(spanKey,'selection.captured',{
        boxPx,
        stageLabel:'Selection captured',
        stepNumber:0,
        bbox:{ pixel: boxPx },
        inputsSnapshot:{ selectionBox: boxPx }
      });
    } else if(fieldSpec.bbox){
      const raw = toPx(viewportPx,{x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
      boxPx = applyTransform(raw);
      traceEvent(spanKey,'selection.captured',{
        boxPx,
        stageLabel:'Selection captured',
        stepNumber:0,
        bbox:{ pixel: boxPx },
        inputsSnapshot:{ selectionBox: boxPx }
      });
    }
    if(!boxPx){ return { value:'', raw:'', confidence:0, boxPx:null, tokens:[], method:'raw' }; }
    const docId = state.currentFileId || state.currentFileName || 'doc';
    const pageIndex = (boxPx.page||1) - 1;
    const vp = state.pageViewports[pageIndex] || state.viewport || {width:1,height:1};
    const canvasW = (vp.width ?? vp.w) || 1;
    const canvasH = (vp.height ?? vp.h) || 1;
    const normBox = normalizeBox(boxPx, canvasW, canvasH);
    const { cropBitmap, meta } = getOcrCropForSelection({ docId, pageIndex, normBox });
    if(meta.errors.length){
      alert('OCR crop error: '+meta.errors.join(','));
      return { value:'', raw:'', confidence:0, boxPx, tokens:[], method:'raw' };
    }
    const probe = await runOcrProbes(cropBitmap);
    const best = chooseBestProbe(probe);
    const rawText = (best.raw || '').trim();
    traceEvent(spanKey,'ocr.raw',{
      mode:'raw',
      washed:false,
      cleaning:false,
      fallback:false,
      dedupe:false,
      tokens: best.tokensLength,
      crop: cropBitmap.toDataURL('image/png'),
      stageLabel:'OCR raw (probe)',
      stepNumber:1,
      counts:{ tokens: best.tokensLength },
      bbox:{ pixel: boxPx, normalized: normBox },
      ocrConfig:{ probe:true },
      inputsSnapshot:{ selectionBox: boxPx, normBox }
    });
    if(!rawText && !confirm('OCR returned empty. Keep empty value?')){
      alert('Please re-select the field.');
      return { value:'', raw:'', confidence:0, boxPx, tokens:[], method:'raw' };
    }
    const tokensOut = best.tokens.map(t=>({ text:t }));
    const result = { value: rawText, raw: rawText, corrected: rawText, code:null, shape:null, score:null, correctionsApplied:[], boxPx, confidence:1, tokens: tokensOut, method:'raw' };
    traceEvent(spanKey,'value.finalized',{
      value: result.value,
      confidence: result.confidence,
      method:'raw',
      mode:'raw',
      washed:false,
      cleaning:false,
      fallback:false,
      dedupe:false,
      stageLabel:'Value finalized',
      stepNumber:5,
      confidenceDetails:{ method:'raw', score: result.confidence },
      notes:'Raw OCR path finalized value'
    });
    return result;
  }

  const isConfigStatic = isConfigMode() && ftype === 'static';
  if(isConfigStatic){
    const selectionBox = state.selectionPx || state.snappedPx || null;
    let boxPx = selectionBox;
    if(fieldSpec.bbox && !boxPx){
      const raw = toPx(viewportPx, {x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
      boxPx = applyTransform(raw);
    }
    if(boxPx){
      traceEvent(spanKey,'selection.captured',{
        boxPx,
        stageLabel:'Selection captured',
        stepNumber:0,
        bbox:{ pixel: boxPx },
        inputsSnapshot:{ selectionBox: boxPx }
      });
    }
    if(!boxPx){
      return { value:'', raw:'', corrected:'', code:null, shape:null, score:null, correctionsApplied:[], boxPx:null, confidence:0, tokens:[], method:'config-permissive' };
    }
    const extractor = StaticFieldMode?.finalizeConfigValue || StaticFieldMode?.extractConfigStatic;
    let text = '';
    let hits = [];
    let usedBox = boxPx;
    let cleaned = null;
    if(extractor){
      const res = extractor({ tokens, selectionBox: boxPx, snappedBox: state.snappedPx, snappedText: state.snappedText, cleanFn: FieldDataEngine.clean, fieldKey: fieldSpec.fieldKey, multiline: !!fieldSpec.isMultiline });
      text = res?.text || res?.value || '';
      hits = res?.hits || [];
      usedBox = res?.box || boxPx;
      cleaned = res?.cleaned || null;
    } else {
      hits = tokensInBox(tokens, boxPx);
      const lines = groupIntoLines(hits);
      text = lines.map(L => L.tokens.map(t=>t.text).join(' ').trim()).filter(Boolean).join('\n');
    }
    if(!cleaned){
      cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', text || state.snappedText || '', state.mode, spanKey);
    }
    const cleanedValue = cleaned.value || cleaned.raw || text || state.snappedText || '';
    const rawOriginal = text || state.snappedText || cleaned.rawOriginal || cleaned.raw || '';
    if(isConfigStatic && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      const expectedCode = getDominantFingerprintCode(fieldSpec.fieldKey, spanKey?.fieldKey || fieldSpec.fieldKey);
      const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, { enabled:false, fieldKey: fieldSpec.fieldKey, cleanedValue });
      logStaticDebug(
        `field=${fieldSpec.fieldKey||''} cleaned="${cleanedValue}" code=${cleaned.code || '<none>'} expected=${expectedCode || '<none>'} -> fingerprintOk=${fingerprintOk}`,
        { field: fieldSpec.fieldKey, cleaned: cleanedValue, code: cleaned.code, expected: expectedCode, fingerprintOk, mode: state.mode }
      );
    }
    const value = cleanedValue;
    const result = {
      value,
      raw: rawOriginal,
      corrected: cleaned.corrected || value,
      code: cleaned.code,
      shape: cleaned.shape,
      score: cleaned.score,
      correctionsApplied: cleaned.correctionsApplied,
      corrections: cleaned.correctionsApplied,
      boxPx: usedBox,
      confidence: cleaned.conf ?? 1,
      tokens: hits,
      method:'config-permissive'
    };
    traceEvent(spanKey,'value.finalized',{
      value: result.value,
      confidence: result.confidence,
      method: result.method,
      mode:'CONFIG',
      stageLabel:'Value finalized',
      stepNumber:5,
      bbox:{ pixel: usedBox },
      confidenceDetails:{ mode:'CONFIG', score: result.confidence },
      notes:'Config extraction finalized value'
    });
    return result;
  }

  async function attempt(box){
    const snapOpts = { minOverlap: staticMinOverlap };
    if(ftype === 'static'){
      Object.assign(snapOpts, { minContainFraction: 0.75, boxPad: 2, skipConfigUnion: true });
    }
    const snap = snapToLine(tokens, box, 6, snapOpts);
    let searchBox = snap.box;
    const hintDistance = distanceToHint(searchBox);
    const withinHintBand = Number.isFinite(hintDistance) && Number.isFinite(hintBand)
      ? hintDistance <= hintBand
      : false;
    if(fieldSpec.fieldKey === 'customer_address'){
      searchBox = { x:snap.box.x, y:snap.box.y, w:snap.box.w, h:snap.box.h*4, page:snap.box.page };
    }
    const assembler = StaticFieldMode?.assembleTextFromBox || StaticFieldMode?.collectFullText || null;
    const assembleOpts = { tokens, box: searchBox, snappedText: '', multiline: !!fieldSpec.isMultiline, minOverlap: staticMinOverlap };
    const assembled = assembler ? assembler(assembleOpts) : null;
    const hits = assembled?.hits || tokensInBox(tokens, searchBox, { minOverlap: staticMinOverlap });
    const lines = assembled?.lines || groupIntoLines(hits);
    const observedLineCount = assembled?.lineCount ?? (assembled?.lines?.length ?? lines.length ?? 0);
    const anchorRes = anchorMatchesCandidate({ boxPx: searchBox, tokens: hits });
    const anchorOk = anchorRes.ok || anchorRes.softOk;
    const anchorFactor = anchorRes.ok ? 1 : anchorRes.softOk ? 0.85 : 0.7;
    const anchorStatus = anchorRes.status || (anchorOk ? 'ok' : 'fail');
    const anchorScore = anchorRes.score ?? anchorFactor;
    const adjustConfidenceForLines = (confidence, observed=observedLineCount)=>{
      const expected = fieldSpec?.lineMetrics?.lineCount ?? fieldSpec?.lineCount ?? observed;
      if(!expected || !observed) return { confidence, expected, factor: 1 };
      const tolerance = expected >= 3 ? 1 : 0;
      const diff = Math.abs(observed - expected);
      let factor = 1;
      let reason = 'exact';
      if(diff === 0){ factor = 1.1; reason = 'exact'; }
      else if(diff <= tolerance){ factor = 1.05; reason = 'near'; }
      else { factor = Math.max(0.6, 1 - diff * 0.15); reason = 'mismatch'; }
      const next = clamp(confidence * factor, 0, 1);
      return { confidence: next, expected, factor, reason, observed };
    };
    let multilineValue = (fieldSpec.isMultiline || (lines?.length || 0) > 1)
      ? (assembled?.text || lines.map(L => L.tokens.map(t=>t.text).join(' ').trim()).filter(Boolean).join('\n'))
      : '';
    if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      const tokenPreview = hits.slice(0,3).map(t => ({ text: t.text, box: { x:t.x, y:t.y, w:t.w, h:t.h } }));
      logStaticDebug(
        `ocr-box field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=${hits.length} box=${formatBoxForLog(searchBox)} raw="${(assembled?.text||'').replace(/\s+/g,' ').trim()}"`,
        { hits: hits.length, tokenPreview, rawText: assembled?.text || '', box: searchBox }
      );
    }
    if(!hits.length){
      if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
        logStaticDebug(
          `attempt field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=0 anchorsOk=${anchorOk} fingerprintOk=false finalText=<empty> conf=0`,
          { anchorsOk: anchorRes.status || (anchorOk ? 'ok' : 'fail'), fingerprintOk:false, text:'', confidence:0, box: searchBox }
        );
      }
      return null;
    }
    if(multilineValue){
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', multilineValue, state.mode, spanKey);
      const fpDebugCtx = (runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey))
        ? { enabled:true, fieldKey: fieldSpec.fieldKey, cleanedValue: cleaned.value || cleaned.raw }
        : null;
      let fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, fpDebugCtx);
      let cleanedOk = !!(cleaned.value || cleaned.raw);
      const labelSplit = /(sold\s*to|ship\s*to|store\s*:|salesperson\s*:)/i;
      let chosenLine = null;
      if(!fingerprintOk && lines?.length){
        const segments = [];
        for(const line of lines){
          const text = (line.tokens||[]).map(t=>t.text).join(' ').trim();
          if(!text) continue;
          const bounds = lineBounds(line);
          const dist = Number.isFinite(bounds?.cy) ? Math.abs(bounds.cy - (hintCenter?.y ?? bounds.cy)) : distanceToHint(bounds);
          const segClean = FieldDataEngine.clean(fieldSpec.fieldKey||'', text, state.mode, spanKey);
          const segFp = fingerprintMatches(fieldSpec.fieldKey||'', segClean.code, state.mode, fieldSpec.fieldKey, fpDebugCtx);
          segments.push({ text: segClean.value || segClean.raw || text, raw: text, cleaned: segClean, fpOk: segFp, dist, tokens: line.tokens, hasLabel: labelSplit.test(text) });
        }
        const ranked = segments.sort((a,b)=>{
          if(a.fpOk !== b.fpOk) return a.fpOk ? -1 : 1;
          if(a.hasLabel !== b.hasLabel) return a.hasLabel ? 1 : -1;
          if(a.dist !== b.dist) return a.dist - b.dist;
          return (b.cleaned?.conf||0) - (a.cleaned?.conf||0);
        });
        const bestSeg = ranked[0];
        if(bestSeg){
          chosenLine = bestSeg;
          fingerprintOk = bestSeg.fpOk;
          cleanedOk = !!(bestSeg.cleaned?.value || bestSeg.cleaned?.raw);
          multilineValue = bestSeg.text;
          hits.splice(0, hits.length, ...(bestSeg.tokens || hits));
        }
      }
      const baseClean = chosenLine?.cleaned || cleaned;
      const baseConf = baseClean.conf || (cleanedOk ? 1 : 0.1);
      let confidence = fingerprintOk
        ? baseConf
        : (staticRun ? Math.max(0.2, Math.min(baseConf * 0.6, 0.5)) : 0);
      const lineCountForEval = chosenLine ? 1 : observedLineCount;
      let lineAdj = null;
      if(runMode && ftype==='static'){
        lineAdj = adjustConfidenceForLines(confidence, lineCountForEval);
        confidence = lineAdj.confidence;
      }
      const lineInfo = computeLineDiff(lineCountForEval, lineAdj?.expected);
      const attemptResult = {
        value: multilineValue || cleaned.value || cleaned.raw,
        raw: multilineValue,
        corrected: baseClean.corrected,
        code: baseClean.code,
        shape: baseClean.shape,
        score: baseClean.score,
        correctionsApplied: baseClean.correctionsApplied,
        corrections: baseClean.correctionsApplied,
        boxPx: searchBox,
        confidence: clamp(confidence * anchorFactor, 0, 1),
        tokens: hits,
        cleanedOk,
        fingerprintOk,
        anchorOk,
        anchorStatus,
        anchorScore,
        hintDistance,
        withinHint: withinHintBand,
        lineCount: lineCountForEval,
        expectedLineCount: lineInfo.expectedLineCount,
        lineDiff: lineInfo.lineDiff
      };
      if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
        if(lineAdj && lineAdj.factor !== 1){
          logStaticDebug(
            `line-count field=${fieldSpec.fieldKey||''} expected=${lineAdj.expected} observed=${observedLineCount} factor=${lineAdj.factor.toFixed(2)} reason=${lineAdj.reason}`,
            { expected: lineAdj.expected, observed: observedLineCount, factor: lineAdj.factor, reason: lineAdj.reason }
          );
        }
        logStaticDebug(
          `attempt field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=${hits.length} anchors=${anchorRes.status||'n/a'} fingerprintOk=${fingerprintOk} finalText="${(attemptResult.value||'').replace(/\s+/g,' ')}" conf=${attemptResult.confidence}`,
          { anchorsOk: anchorRes, fingerprintOk, text: attemptResult.value, confidence: attemptResult.confidence, box: searchBox }
        );
      }
      return attemptResult;
    }
    const sel = selectionFirst(hits, h=>FieldDataEngine.clean(fieldSpec.fieldKey||'', h, state.mode, spanKey));
    const cleaned = sel.cleaned || {};
    const fpDebugCtx = (runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey))
      ? { enabled:true, fieldKey: fieldSpec.fieldKey, cleanedValue: cleaned.value || cleaned.raw }
      : null;
    const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, fpDebugCtx);
    const cleanedOk = staticRun ? !!sel.cleanedOk : !!sel.cleanedOk && fingerprintOk;
    const baseConf = cleaned.conf || (sel.cleanedOk ? 1 : 0.1);
    let confidence = fingerprintOk
      ? baseConf
      : (staticRun ? Math.max(0.2, Math.min(baseConf * 0.6, 0.5)) : 0);
    let lineAdj = null;
    if(runMode && ftype==='static'){
      lineAdj = adjustConfidenceForLines(confidence);
      confidence = lineAdj.confidence;
    }
    confidence = clamp(confidence * anchorFactor, 0, 1);
    const lineInfo = computeLineDiff(observedLineCount, lineAdj?.expected);
    const attemptResult = {
      value: sel.value,
      raw: sel.raw,
      corrected: cleaned.corrected,
      code: cleaned.code,
      shape: cleaned.shape,
      score: cleaned.score,
      correctionsApplied: cleaned.correctionsApplied,
      corrections: cleaned.correctionsApplied,
      boxPx: searchBox,
      confidence,
      tokens: hits,
      cleanedOk,
      fingerprintOk,
      anchorOk,
      anchorStatus,
      anchorScore,
      hintDistance,
      withinHint: withinHintBand,
      lineCount: observedLineCount,
      expectedLineCount: lineInfo.expectedLineCount,
      lineDiff: lineInfo.lineDiff
    };
    if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      if(lineAdj && lineAdj.factor !== 1){
        logStaticDebug(
          `line-count field=${fieldSpec.fieldKey||''} expected=${lineAdj.expected} observed=${observedLineCount} factor=${lineAdj.factor.toFixed(2)} reason=${lineAdj.reason}`,
          { expected: lineAdj.expected, observed: observedLineCount, factor: lineAdj.factor, reason: lineAdj.reason }
        );
      }
      logStaticDebug(
        `attempt field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=${hits.length} anchors=${anchorStatus} fingerprintOk=${fingerprintOk} finalText="${(attemptResult.value||'').replace(/\s+/g,' ')}" conf=${attemptResult.confidence}`,
        { anchorsOk: anchorStatus, fingerprintOk, text: attemptResult.value, confidence: attemptResult.confidence, box: searchBox }
      );
    }
    return attemptResult;
  }

  function scoreTriangulatedCandidates(opts){
    const { triBox, keywordPrediction, baseBox, anchorBox: anchorRefBox, existingResult, pageW, pageH, hintCenter: hc, hintBand: hb, nearHintCount: nh } = opts;
    if(!triBox) return null;
    const triCx = triBox.x + (triBox.w||0)/2;
    const triCy = triBox.y + (triBox.h||0)/2;
    const maxRadius = KeywordWeighting?.MAX_KEYWORD_RADIUS || 0.35;
    const anchorRef = anchorRefBox || baseBox;
    const baseCx = anchorRef ? anchorRef.x + (anchorRef.w||0)/2 : null;
    const baseCy = anchorRef ? anchorRef.y + (anchorRef.h||0)/2 : null;
    const hintCx = hc?.x || null;
    const hintCy = hc?.y || null;
    const hintBand = hb;
    const lines = groupIntoLines(tokens);
    const candidates = [];

    const streetRe = /\b(?:STREET|ST\.?|RD\.?|ROAD|AVE|AVENUE|BLVD|DR\.?|DRIVE|WAY|LANE|LN\.?|CRES|COURT|CT\.?|TRL|TRAIL)\b/i;
    const postalCaRe = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;
    const postalUsRe = /\b\d{5}(?:-\d{4})?\b/;
    const phoneRe = /\b\(?\d{3}\)?[\s./-]?\d{3}[\s./-]?\d{4}\b/;

    const applyFieldBias = cand => {
      if(!cand) return cand;
      const text = (cand.cleaned?.value || cand.text || '').toUpperCase();
      const hasDigit = /\d/.test(text);
      const hasPostal = postalCaRe.test(text) || postalUsRe.test(text);
      const hasStreet = streetRe.test(text);
      const hasPhone = phoneRe.test(text);
      if(isCustomerNameField){
        const addressLike = hasDigit || hasPostal || hasStreet || hasPhone;
        const nameLike = /[A-Z]{3,}\s+[A-Z]{3,}(?:\s+[A-Z]{2,})?/.test(text);
        if(addressLike){
          cand.totalScore = clamp(cand.totalScore * 0.6, 0, 2);
          cand.confidence = clamp(cand.confidence * 0.65, 0, 1);
        }
        if(nameLike && !addressLike){
          cand.totalScore = clamp(cand.totalScore * 1.15, 0, 2);
          cand.confidence = clamp(cand.confidence * 1.1, 0, 1);
        }
      } else if(isCustomerAddressField){
        const addressStrong = hasPostal || (hasDigit && hasStreet);
        const phoneOnly = hasPhone && !hasStreet && !hasPostal;
        if(addressStrong){
          cand.totalScore = clamp(cand.totalScore * 1.15, 0, 2);
          cand.confidence = clamp(cand.confidence * 1.1, 0, 1);
        }
        if(phoneOnly){
          cand.totalScore = clamp(cand.totalScore * 0.6, 0, 2);
          cand.confidence = clamp(cand.confidence * 0.65, 0, 1);
        }
      }
      return cand;
    };

    const evaluateCandidate = (candTokens, source='line')=>{
      if(!candTokens || !candTokens.length) return null;
      const box = mergeTokenBounds(candTokens);
      if(!box) return null;
      const cx = box.x + (box.w||0)/2;
      const cy = box.y + (box.h||0)/2;
      const hintDist = (hintCy === null) ? null : Math.abs(cy - hintCy);
      const farFromHint = hintBand !== null && hintDist !== null && hintDist > hintBand;
      if(farFromHint && (nh || 0) > 0){ return null; }
      const distNorm = Math.hypot((cx - triCx)/pageW, (cy - triCy)/pageH);
      const baseDistNorm = (baseCx === null || baseCy === null)
        ? null
        : Math.hypot((cx - baseCx)/pageW, (cy - baseCy)/pageH);
      const baseBias = baseDistNorm === null
        ? 1
        : Math.max(0.65, 1 - Math.min(1, baseDistNorm / maxRadius));
      const hintPenalty = farFromHint ? 0.6 : 1;
      const distanceScore = Math.max(0, 1 - (distNorm / maxRadius)) * baseBias * hintPenalty;
      const rawText = candTokens.map(t=>t.text).join(' ').trim();
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', rawText, state.mode, spanKey);
      const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, null);
      const anchorRes = anchorMatchForBox(fieldSpec.anchorMetrics, box, candTokens, viewportDims.width, viewportDims.height);
      const anchorOk = anchorRes.ok || anchorRes.softOk;
      const keywordScore = keywordPrediction && KeywordWeighting?.computeKeywordWeight
        ? KeywordWeighting.computeKeywordWeight(box, keywordPrediction, { pageW, pageH, strongAnchor: anchorOk || fingerprintOk })
        : 1;
      const anchorScore = anchorRes.score ?? (anchorOk ? 1 : 0.82);
      const fpScore = staticRun
        ? (fingerprintOk ? STATIC_FP_SCORES.ok : STATIC_FP_SCORES.fail)
        : (fingerprintOk ? 1.1 : 0.65);
      const observedLineCount = groupIntoLines(candTokens)?.length || 0;
      const lineInfo = computeLineDiff(observedLineCount);
      const lineScore = staticRun ? lineScoreForDiff(lineInfo.lineDiff) : 1;
      const baseConf = cleaned.conf || (cleaned.value || cleaned.raw ? 1 : 0.15);
      const totalScore = clamp(baseConf * keywordScore * (0.55 + distanceScore * 0.45) * anchorScore * fpScore * lineScore, 0, 2);
      const confidence = clamp((cleaned.conf || 0.6) * (fingerprintOk ? 1 : 0.75) * (anchorRes.ok ? 1 : anchorRes.softOk ? 0.85 : 0.75) * (0.55 + distanceScore * 0.45), 0, 1);
      if(staticRun && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey) && anchorRef){
        const anchorDeltas = {
          top: Math.round(box.y - anchorRef.y),
          bottom: Math.round((box.y + box.h) - (anchorRef.y + anchorRef.h)),
          left: Math.round(box.x - anchorRef.x),
          right: Math.round((box.x + box.w) - (anchorRef.x + anchorRef.w)),
          height: Math.round(box.h - anchorRef.h)
        };
        logStaticDebug(
          `field=${fieldSpec.fieldKey||''} anchors: top=${anchorDeltas.top} bottom=${anchorDeltas.bottom} left=${anchorDeltas.left} right=${anchorDeltas.right} height=${anchorDeltas.height} anchor=${formatBoxForLog(anchorRef)} cand=${formatBoxForLog(box)}`,
          { anchorBox: anchorRef, candidateBox: box, deltas: anchorDeltas, stage: 'stage-2' }
        );
      }
      return applyFieldBias({
        source,
        box,
        cx,
        cy,
        text: cleaned.value || cleaned.raw || rawText,
        rawText,
        cleaned,
        fingerprintCode: cleaned.code,
        fpOk: fingerprintOk,
        anchorOk,
        anchorScore,
        keywordScore,
        distanceScore,
        lineCount: observedLineCount,
        expectedLineCount: lineInfo.expectedLineCount,
        lineDiff: lineInfo.lineDiff,
        lineScore,
        totalScore,
        confidence,
        tokens: candTokens
      });
    };

    for(const line of lines){
      if(line.page !== triBox.page) continue;
      const bounds = lineBounds(line);
      const cx = (bounds.left + bounds.right) / 2;
      const cy = bounds.cy || ((bounds.top + bounds.bottom) / 2);
      const distNorm = Math.hypot((cx - triCx)/pageW, (cy - triCy)/pageH);
      if(distNorm > maxRadius) continue;
      const candidate = evaluateCandidate(line.tokens, 'line');
      if(candidate) candidates.push(candidate);
    }

    const currentTokens = existingResult?.tokens?.length
      ? existingResult.tokens
      : (existingResult?.boxPx ? tokensInBox(tokens, existingResult.boxPx, { minOverlap: staticMinOverlap }) : []);
    const currentCandidate = existingResult?.boxPx
      ? evaluateCandidate(currentTokens, 'current')
      : null;
    if(currentCandidate){ candidates.push(currentCandidate); }

    if(!candidates.length) return null;
    let sorted = candidates.slice().sort((a,b)=> b.totalScore - a.totalScore);
    if(staticRun && sorted.length > MAX_STATIC_CANDIDATES){
      sorted = sorted.slice(0, MAX_STATIC_CANDIDATES);
      if(currentCandidate && !sorted.includes(currentCandidate)){
        sorted.push(currentCandidate);
        sorted = sorted.sort((a,b)=> b.totalScore - a.totalScore);
      }
    }
    const best = sorted[0];
    const current = currentCandidate || existingResult;
    const currentScore = currentCandidate?.totalScore ?? 0;
    let preferBest = best && best !== currentCandidate && (
      best.totalScore > (currentScore || 0) * 1.05
      || (!currentCandidate?.fpOk && best.fpOk && best.distanceScore > (currentCandidate?.distanceScore || 0))
    );
    if(staticRun && best){
      const lineOk = (best.lineDiff ?? Infinity) <= 1 || best.fpOk;
      if(best.totalScore < MIN_STATIC_ACCEPT_SCORE || !lineOk){
        preferBest = false;
      }
    }
    return { candidates: sorted, best, current: currentCandidate, preferBest };
  }

  let result = null, method=null, score=null, comp=null, basePx=null, anchorBox=null;
  let keywordPrediction = null;
  let keywordMatch = null;
  let keywordWeight = 1;
  let triangulatedBox = null;
  let constellationContext = null;
  let constellationBox = null;
  let keywordIndex = null;
  let keywordContext = null;
  let selectionRaw = '';
  let firstAttempt = null;
  const keywordConstellation = staticRun ? (fieldSpec.keywordConstellation || null) : null;
  const recordHintCandidate = cand => {
    if(!cand || !cand.boxPx) return;
    const dist = cand.hintDistance ?? distanceToHint(cand.boxPx);
    cand.hintDistance = dist;
    if(!cand.withinHint){ cand.withinHint = Number.isFinite(dist) && Number.isFinite(hintBand) ? dist <= hintBand : false; }
    if(cand.withinHint){ nearHintCount += 1; }
    if(!bestHintCandidate){ bestHintCandidate = cand; return; }
    const bestDist = bestHintCandidate.hintDistance ?? distanceToHint(bestHintCandidate.boxPx);
    if(dist < (bestDist ?? Infinity) - 0.5 || (Math.abs(dist - (bestDist ?? Infinity)) < 0.5 && (cand.confidence||0) > (bestHintCandidate.confidence||0))){
      bestHintCandidate = cand;
    }
  };
  if(fieldSpec.bbox){
    const raw = toPx(viewportPx, {x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
    basePx = applyTransform(raw);
    if(fieldSpec.configBox){
      const cx0 = Number.isFinite(fieldSpec.configBox.x0) ? fieldSpec.configBox.x0 : fieldSpec.configBox[0];
      const cy0 = Number.isFinite(fieldSpec.configBox.y0) ? fieldSpec.configBox.y0 : fieldSpec.configBox[1];
      const cx1 = Number.isFinite(fieldSpec.configBox.x1) ? fieldSpec.configBox.x1 : fieldSpec.configBox[2];
      const cy1 = Number.isFinite(fieldSpec.configBox.y1) ? fieldSpec.configBox.y1 : fieldSpec.configBox[3];
      if([cx0, cy0, cx1, cy1].every(v => typeof v === 'number' && Number.isFinite(v))){
        const anchorRaw = toPx(viewportPx, { x0: cx0, y0: cy0, x1: cx1, y1: cy1, page: fieldSpec.page });
        anchorBox = applyTransform(anchorRaw);
      }
    }
    if(!anchorBox){
      anchorBox = { ...basePx };
    }
    hintCenter = { x: basePx.x + (basePx.w||0)/2, y: basePx.y + (basePx.h||0)/2 };
    hintBand = (basePx.h || 0) * 1.5;
    if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      logStaticDebug(
        `bbox-transform field=${fieldSpec.fieldKey||''} page=${basePx.page||''} config=${formatArrayBox(fieldSpec.bbox)} transformed=${formatBoxForLog(basePx)} viewport=${viewportDims.width}x${viewportDims.height}`,
        { field: fieldSpec.fieldKey, page: basePx.page, configBox: fieldSpec.bbox, transformed: basePx, viewport: viewportDims, rawBox: raw }
      );
      logStaticDebug(
        `field=${fieldSpec.fieldKey||''} using anchorBox from config for stage-2 proximity ${formatBoxForLog(anchorBox)}`,
        { anchorBox, stage: 'stage-2' }
      );
    }
    if(staticRun && keywordConstellation && KeywordConstellation?.matchConstellation){
      const page = basePx.page || fieldSpec.page || state.pageNum || 1;
      const { pageW, pageH } = getPageSize(page);
      let pageTokens = (page === (fieldSpec.page || state.pageNum || page))
        ? tokens
        : (preferSuppliedTokens ? [] : (state.tokensByPage?.[page] || []));
      if((pageTokens?.length || 0) === 0 && ensureTokensForPage && !preferSuppliedTokens){
        pageTokens = await ensureTokensForPage(page);
      }
      constellationContext = KeywordConstellation.matchConstellation(keywordConstellation, pageTokens || [], {
        page,
        pageW,
        pageH,
        maxResults: 3
      });
      if(constellationContext?.best?.predictedBoxPx){
        constellationBox = constellationContext.best.predictedBoxPx;
      }
    }
    if(staticRun && keywordRelations){
      keywordIndex = await ensureKeywordIndexForPage(basePx.page);
      const { pageW, pageH } = getPageSize(basePx.page);
      const extraSeeds = [];
      if(constellationBox){
        extraSeeds.push({ box: constellationBox, source: 'constellation', weight: 1.05, entry: constellationContext?.best || null });
      }
      keywordContext = KeywordWeighting?.triangulateBox
        ? KeywordWeighting.triangulateBox(keywordRelations, keywordIndex, pageW, pageH, basePx, { configWeight: 1.2, extraSeeds })
        : null;
      triangulatedBox = keywordContext?.box || keywordContext || triangulatedBox;
      if(!keywordPrediction && keywordContext?.motherPred?.predictedBox){
        keywordPrediction = keywordContext.motherPred.predictedBox;
        keywordMatch = keywordContext.motherPred.entry || keywordRelations.mother;
      }
    }
    if(staticRun && !keywordRelations && constellationBox && KeywordWeighting?.triangulateBox){
      const { pageW, pageH } = getPageSize(basePx.page);
      const extraSeeds = [{ box: constellationBox, source: 'constellation', weight: 1.05, entry: constellationContext?.best || null }];
      const blended = KeywordWeighting.triangulateBox(null, [], pageW, pageH, basePx, { configWeight: 1.2, extraSeeds });
      triangulatedBox = blended?.box || triangulatedBox || constellationBox;
      keywordContext = keywordContext || blended;
    }

    traceEvent(spanKey,'selection.captured',{
      boxPx: basePx,
      stageLabel:'Selection captured',
      stepNumber:0,
      bbox:{ pixel: basePx },
      counts:{ tokens: tokens.length },
      inputsSnapshot:{ selectionBox: basePx }
    });

    if(staticRun && anchorBox){
      const mostlyInside = (tok, box) => {
        const xOverlap = Math.max(0, Math.min(tok.x + tok.w, box.x + box.w) - Math.max(tok.x, box.x));
        const yOverlap = Math.max(0, Math.min(tok.y + tok.h, box.y + box.h) - Math.max(tok.y, box.y));
        const fracX = (tok.w || 1) > 0 ? xOverlap / (tok.w || 1) : 0;
        const fracY = (tok.h || 1) > 0 ? yOverlap / (tok.h || 1) : 0;
        return fracX >= 0.75 && fracY >= 0.75;
      };
      const boxLockedTokens = tokens.filter(t => (!t.page || !anchorBox.page || t.page === anchorBox.page) && mostlyInside(t, anchorBox));
      if(boxLockedTokens.length){
        const ordered = boxLockedTokens.slice().sort((a,b)=> (a.y - b.y) || (a.x - b.x));
        const lines = groupIntoLines(ordered);
        const textLines = lines.map(L => (L.tokens||[]).map(t=>t.text).join(' ').trim()).filter(Boolean);
        const rawText = textLines.join('\n');
        const box = mergeTokenBounds(ordered) || { ...anchorBox };
        if(box && !box.page){ box.page = anchorBox.page; }
        const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', rawText, state.mode, spanKey);
        const fpDebugCtx = staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)
          ? { enabled:true, fieldKey: fieldSpec.fieldKey, cleanedValue: cleaned.value || cleaned.raw }
          : null;
        const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, fpDebugCtx);
        const cleanedOk = !!(cleaned.value || cleaned.raw);
        const anchorResBox = anchorMatchesCandidate({ boxPx: box, tokens: ordered });
        const anchorOk = anchorResBox.ok || anchorResBox.softOk;
        const anchorFactorBox = anchorResBox.ok ? 1 : anchorResBox.softOk ? 0.85 : 0.7;
        const baseConf = cleaned.conf || (cleanedOk ? 1 : 0.1);
        let confidence = fingerprintOk ? baseConf : Math.max(0.2, Math.min(baseConf * 0.6, 0.5));
        const lineInfo = computeLineDiff(lines.length);
        const lineAdj = { confidence, expected: lineInfo.expectedLineCount, factor: 1, reason: 'boxLocked', observed: lines.length };
        confidence = clamp(confidence * (lineAdj.factor || 1), 0, 1);
        const hintDistance = distanceToHint(box);
        const withinHintBand = Number.isFinite(hintDistance) && Number.isFinite(hintBand)
          ? hintDistance <= hintBand
          : false;
        result = {
          value: cleaned.value || cleaned.raw || rawText,
          raw: rawText,
          corrected: cleaned.corrected,
          code: cleaned.code,
          shape: cleaned.shape,
          score: cleaned.score,
          correctionsApplied: cleaned.correctionsApplied,
          corrections: cleaned.correctionsApplied,
          boxPx: box,
          confidence: clamp(confidence * anchorFactorBox, 0, 1),
          tokens: ordered,
          cleanedOk,
          fingerprintOk,
          anchorOk,
          anchorStatus: anchorResBox.status || (anchorOk ? 'ok' : 'fail'),
          anchorScore: anchorResBox.score ?? anchorFactorBox,
          hintDistance,
          withinHint: withinHintBand,
          lineCount: lines.length,
          expectedLineCount: lineAdj.expected,
          lineDiff: lineInfo.lineDiff,
          method: 'box-locked'
        };
        stageUsed.value = 1;
        hintLocked = true;
        if(runMode && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
          logStaticDebug(
            `box-locked field=${fieldSpec.fieldKey||''} page=${box.page||basePx.page||''} hits=${ordered.length} box=${formatBoxForLog(box)} raw="${rawText.replace(/\s+/g,' ').trim()}"`,
            { hits: ordered.length, tokenPreview: ordered.slice(0,3).map(t=>({ text:t.text, box:{ x:t.x, y:t.y, w:t.w, h:t.h } })), box, lineAdj, anchor: anchorResBox }
          );
        }
      }
    }

    if(!result){
      traceEvent(spanKey,'selection.captured',{
        boxPx: basePx,
        stageLabel:'Selection captured',
        stepNumber:0,
        bbox:{ pixel: basePx },
        counts:{ tokens: tokens.length },
        inputsSnapshot:{ selectionBox: basePx }
      });
      const initialAttempt = await attempt(basePx);
      if(initialAttempt && initialAttempt.anchorOk === false){ initialAttempt.cleanedOk = false; }
      if(initialAttempt){
        firstAttempt = initialAttempt;
        recordHintCandidate(initialAttempt);
      }
      selectionRaw = firstAttempt?.raw || '';
      if(staticRun && firstAttempt && firstAttempt.fingerprintOk && firstAttempt.cleanedOk){
        const lineInfo = computeLineDiff(firstAttempt.lineCount, firstAttempt.expectedLineCount);
        result = firstAttempt; method='bbox'; stageUsed.value = lineInfo.lineDiff; hintLocked = true;
      }
      if(!hintLocked){
        const pads = isConfigMode() ? [4] : [4,8,12];
        for(const pad of pads){
          const search = { x: basePx.x - pad, y: basePx.y - pad, w: basePx.w + pad*2, h: basePx.h + pad*2, page: basePx.page };
          const r = await attempt(search);
          if(r){ recordHintCandidate(r); }
          if(r){
            const anchorRes = anchorMatchesCandidate(r);
            if(!(anchorRes.ok || anchorRes.softOk)){ continue; }
          }
          if(r && r.fingerprintOk && r.cleanedOk){
            result = r; method='bbox'; if(staticRun && stageUsed.value === null){ stageUsed.value = 2; } hintLocked = true; break;
          }
          if(r && r.cleanedOk){
            if(!bestHintCandidate || (r.confidence || 0) > (bestHintCandidate.confidence || 0)){
              bestHintCandidate = r;
            }
          }
        }
      }
      if(!hintLocked && staticRun){
        const verticalFactors = [0.5, 1, 1.5];
        for(const factor of verticalFactors){
          for(const dir of [-1,1]){
            const delta = basePx.h * factor * dir;
            const vy = Math.max(0, basePx.y + delta);
            const vh = basePx.h;
            const probe = { x: basePx.x - 2, y: vy, w: basePx.w + 4, h: vh, page: basePx.page };
            const r = await attempt(probe);
            if(r){ recordHintCandidate(r); }
            if(r && r.fingerprintOk && r.cleanedOk){
              result = r; method='bbox'; if(staticRun && stageUsed.value === null){ stageUsed.value = 2; } hintLocked = true; break;
            }
          }
          if(hintLocked) break;
        }
      }
    }
  }

  if(!result && ftype==='static' && fieldSpec.landmark && basePx){
    if(!runMode){
      let m = matchRingLandmark(fieldSpec.landmark, basePx);
      if(m){
        const box = { x: m.x + fieldSpec.landmark.offset.dx*basePx.w, y: m.y + fieldSpec.landmark.offset.dy*basePx.h, w: basePx.w, h: basePx.h, page: basePx.page };
        const r = await attempt(box);
        const anchorRes = r ? anchorMatchesCandidate(r) : null;
        if(r && anchorRes && (anchorRes.ok || anchorRes.softOk) && r.value){ result=r; method='ring'; score=m.score; comp=m.comparator; }
      }
      if(!result){
        const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
        if(a){
          const r = await attempt(a.box);
          const anchorRes = r ? anchorMatchesCandidate(r) : null;
          if(r && anchorRes && (anchorRes.ok || anchorRes.softOk) && r.value){ result=r; method='anchor'; comp='text_anchor'; score:null; }
        }
      }
      if(!result){
        for(const half of ['right','left']){
          m = matchRingLandmark(fieldSpec.landmark, basePx, half);
          if(m){
            const box = { x: m.x + fieldSpec.landmark.offset.dx*basePx.w, y: m.y + fieldSpec.landmark.offset.dy*basePx.h, w: basePx.w, h: basePx.h, page: basePx.page };
            const r = await attempt(box);
            const geomOk = r && (Math.abs((box.y+box.h/2)-(basePx.y+basePx.h/2)) < basePx.h || box.y >= basePx.y);
            const gramOk = r && r.value && (!fieldSpec.regex || new RegExp(fieldSpec.regex,'i').test(r.value));
            const anchorRes = r ? anchorMatchesCandidate(r) : null;
            if(r && anchorRes && (anchorRes.ok || anchorRes.softOk) && r.value && geomOk && gramOk){ result=r; method=`partial-${half}`; score=m.score; comp=m.comparator; break; }
          }
        }
      }
    } else {
      const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
      if(a){
        const r = await attempt(a.box);
        const anchorRes = r ? anchorMatchesCandidate(r) : null;
        if(r && anchorRes && (anchorRes.ok || anchorRes.softOk) && r.value){ result=r; method='anchor'; comp='text_anchor'; score:null; }
      }
    }
  }
  if(!result && staticRun && keywordRelations && keywordRelations.secondaries?.length){
    const page = basePx?.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    if(!keywordIndex){
      keywordIndex = await ensureKeywordIndexForPage(page);
    }
    keywordContext = keywordContext || (KeywordWeighting?.triangulateBox
      ? KeywordWeighting.triangulateBox(keywordRelations, keywordIndex, pageW, pageH, basePx, { configWeight: 1.2 })
      : null);
    triangulatedBox = keywordContext?.box || keywordContext || triangulatedBox;
    if(triangulatedBox){
      for(const pad of [0,3]){
        const probe = { x: triangulatedBox.x - pad, y: triangulatedBox.y - pad, w: triangulatedBox.w + pad*2, h: triangulatedBox.h + pad*2, page: triangulatedBox.page };
        const r = await attempt(probe);
        const anchorRes = r ? anchorMatchesCandidate(r) : null;
        if(r && anchorRes && (anchorRes.ok || anchorRes.softOk) && r.value){
          r.confidence = Math.min(r.confidence || 0.45, 0.45);
          result = r; method='keyword-triangulation'; comp='keyword'; score = score || null; break;
        }
      }
    }
  }
  if(!result && bestHintCandidate){
    result = bestHintCandidate; method = method || 'bbox'; if(staticRun && stageUsed.value === null){ stageUsed.value = 2; }
  }

  if(!result){
    const lv = labelValueHeuristic(fieldSpec, tokens);
      if(lv.value){
        const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', lv.value, state.mode, spanKey);
        let candidateTokens = [];
        if(lv.usedBox){ candidateTokens = tokensInBox(tokens, lv.usedBox, { minOverlap: staticMinOverlap }); }
        const anchorRes = lv.usedBox ? anchorMatchForBox(fieldSpec.anchorMetrics, lv.usedBox, candidateTokens, viewportDims.width, viewportDims.height) : null;
        const boxOk = !enforceAnchors || (anchorRes && (anchorRes.ok || anchorRes.softOk));
        if(boxOk){
        result = { value: cleaned.value || cleaned.raw, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: lv.usedBox, confidence: lv.confidence, method: method||'anchor', score:null, comparator: 'text_anchor', tokens: candidateTokens };
      }
    }
  }

  if(!result){
    traceEvent(spanKey,'fallback.search',{
      stageLabel:'Fallback search',
      stepNumber:6,
      notes:'No confident result; evaluating snapped text fallback',
      inputsSnapshot:{ selectionText: state.snappedText || null }
    });
    const fb = FieldDataEngine.clean(fieldSpec.fieldKey||'', state.snappedText, state.mode, spanKey);
    traceEvent(spanKey,'fallback.pick',{
      value: fb.value || fb.raw,
      stageLabel:'Fallback pick',
      stepNumber:7,
      bbox:{ pixel: state.snappedPx || basePx || null },
      confidence:{ score: fb.value ? 0.3 : 0 },
      notes:'Fallback value chosen after heuristics'
    });
    result = { value: fb.value || fb.raw, raw: selectionRaw || fb.raw, corrected: fb.corrected, code: fb.code, shape: fb.shape, score: fb.score, correctionsApplied: fb.correctionsApplied, corrections: fb.correctionsApplied, boxPx: state.snappedPx || basePx || null, confidence: fb.value ? 0.3 : 0, method: method||'fallback', score };
  }
  if(!result.value && selectionRaw){
    bumpDebugBlank();
    const raw = selectionRaw.trim();
    result.value = raw; result.raw = raw; result.confidence = 0.1; result.boxPx = result.boxPx || basePx || state.snappedPx || null; result.tokens = result.tokens || firstAttempt?.tokens || [];
  }
  if(staticRun && keywordRelations && result && basePx && !hintLocked){
    const page = result.boxPx?.page || basePx.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    if(!keywordIndex){
      keywordIndex = await ensureKeywordIndexForPage(page);
    }
    if(!keywordPrediction && keywordContext?.motherPred?.predictedBox){
      keywordPrediction = keywordContext.motherPred.predictedBox;
      keywordMatch = keywordContext.motherPred.entry || keywordRelations.mother;
    }
    if(!keywordPrediction && KeywordWeighting?.chooseKeywordMatch && keywordRelations.mother){
      const refBox = anchorBox || result.boxPx || basePx;
      const match = KeywordWeighting.chooseKeywordMatch(keywordRelations.mother, keywordIndex, refBox, pageW, pageH);
      if(match?.predictedBox){
        keywordMatch = match.entry;
        keywordPrediction = match.predictedBox;
      }
    }
    if(!triangulatedBox && keywordContext?.box){
      triangulatedBox = keywordContext.box;
    }
  }
  let triangulationAudit = null;
  if(staticRun && triangulatedBox && !hintLocked && (keywordRelations || constellationBox)){
    const page = triangulatedBox.page || result?.boxPx?.page || basePx?.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    const scored = scoreTriangulatedCandidates({
      triBox: triangulatedBox,
      keywordPrediction,
      baseBox: basePx,
      anchorBox,
      existingResult: result,
      pageW,
      pageH,
      hintCenter,
      hintBand,
      nearHintCount
    });
    if(scored){
      const { best, current, preferBest, candidates } = scored;
      if(preferBest && best){
        result = {
          value: best.text,
          raw: best.rawText,
          corrected: best.cleaned?.corrected,
          code: best.cleaned?.code,
          shape: best.cleaned?.shape,
          score: best.cleaned?.score,
          correctionsApplied: best.cleaned?.correctionsApplied,
          corrections: best.cleaned?.correctionsApplied,
          boxPx: best.box,
          confidence: best.confidence,
          tokens: best.tokens,
          cleanedOk: !!(best.cleaned?.value || best.cleaned?.raw),
          fingerprintOk: best.fpOk,
          lineDiff: best.lineDiff,
          lineScore: best.lineScore,
          totalScore: best.totalScore,
          method: 'keyword-triangulation',
          comparator: 'keyword'
        };
        if(staticRun && stageUsed.value === null){ stageUsed.value = 2; }
      }
      triangulationAudit = {
        field: fieldSpec.fieldKey,
        page,
        prediction: triangulatedBox,
        keywordPrediction,
        candidates: candidates.map(c => ({
          text: c.text,
          box: c.box,
          fingerprintCode: c.fingerprintCode,
          fpOk: c.fpOk,
          anchorScore: Number(c.anchorScore?.toFixed ? c.anchorScore.toFixed(3) : c.anchorScore),
          keywordScore: Number(c.keywordScore?.toFixed ? c.keywordScore.toFixed(3) : c.keywordScore),
          distanceScore: Number(c.distanceScore?.toFixed ? c.distanceScore.toFixed(3) : c.distanceScore),
          lineDiff: c.lineDiff,
          lineScore: Number(c.lineScore?.toFixed ? c.lineScore.toFixed(3) : c.lineScore),
          lineCount: c.lineCount,
          expectedLineCount: c.expectedLineCount,
          totalScore: Number(c.totalScore?.toFixed ? c.totalScore.toFixed(3) : c.totalScore),
          source: c.source
        })),
        chosen: (preferBest ? best?.text : current?.text || result?.value || ''),
        switched: !!preferBest && !!best
      };
    }
  }
  const baseConfidence = result?.confidence ?? 0;
  let landmarkBoost = null;
  if(runMode && ftype==='static' && fieldSpec.landmark && basePx && RunLandmarkOnce?.maybeBoostWithLandmark){
    landmarkBoost = RunLandmarkOnce.maybeBoostWithLandmark({
      fieldConfig: fieldSpec,
      pageTokens: tokens,
      baseConfidence,
      baseBoxPx: basePx,
      captureFn: box => captureRingLandmark(box, state.pageTransform.rotation),
      compareFn: (sample, tmpl) => edgeScore(sample, tmpl),
      resolveBox: () => basePx,
      low: 0.3,
      high: 0.8
    });
    if(landmarkBoost){
      result.confidence = landmarkBoost.confidence;
      if(landmarkBoost.landmarkScore !== null && landmarkBoost.landmarkScore !== undefined && score === null){
        score = landmarkBoost.landmarkScore;
        comp = comp || 'ring_once';
      }
    }
  }
  if(staticRun && keywordRelations){
    const page = keywordPrediction?.page || result.boxPx?.page || basePx?.page || fieldSpec.page || 1;
    const { pageW, pageH } = getPageSize(page);
    const strongAnchor = !!(result.fingerprintOk || result.method === 'anchor' || result.method?.startsWith('ring') || baseConfidence >= 0.9);
    const beforeKeyword = result.confidence;
    if(triangulationAudit && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      logStaticDebug(`[triangulation] field=${fieldSpec.fieldKey||''} page=${triangulationAudit.page || page} chosen="${triangulationAudit.chosen||''}"`, triangulationAudit);
    }
    if(keywordPrediction && KeywordWeighting?.computeKeywordWeight && result.boxPx){
      keywordWeight = KeywordWeighting.computeKeywordWeight(result.boxPx, keywordPrediction, { strongAnchor, pageW, pageH });
      if(keywordWeight && keywordWeight !== 1){
        result.confidence = clamp(result.confidence * keywordWeight, 0, 1);
      }
    }
    if(staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      logStaticDebug(
        `keyword field=${fieldSpec.fieldKey||''} hasRel=${!!keywordRelations} match=${keywordMatch?.keyword || '<none>'} weight=${(keywordWeight||1).toFixed(2)} conf=${result.confidence?.toFixed ? result.confidence.toFixed(3) : result.confidence}`,
        {
          prediction: keywordPrediction,
          candidateBox: result.boxPx,
          keywordWeight,
          beforeKeyword,
          afterKeyword: result.confidence,
          landmarkBoost: landmarkBoost?.confidence,
          triangulatedBox
        }
      );
    }
  } else if(staticRun && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
    logStaticDebug(`keyword field=${fieldSpec.fieldKey||''} hasRel=false`, { keywordRelations: false });
  }
  if(staticRun && stageUsed.value === null){ stageUsed.value = 2; }
  if(staticRun && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
    const lineInfo = computeLineDiff(result?.lineCount, result?.expectedLineCount);
    const lineScore = lineScoreForDiff(lineInfo.lineDiff);
    const totalScoreLog = result?.totalScore ?? result?.score ?? result?.confidence ?? 0;
    logStaticDebug(
      `stage-winner field=${fieldSpec.fieldKey||''} stage=${stageUsed.value} lineDiff=${lineInfo.lineDiff} lineScore=${lineScore.toFixed(2)} fpOk=${!!result?.fingerprintOk} totalScore=${Number(totalScoreLog||0).toFixed(3)}`,
      { stage: stageUsed.value, lineDiff: lineInfo.lineDiff, lineScore, fpOk: !!result?.fingerprintOk, totalScore: totalScoreLog }
    );
  }
  result.method = result.method || method || 'fallback';
  result.score = score;
  result.comparator = comp || (result.method==='anchor' ? 'text_anchor' : result.method);
  const shouldScaleConfidence = result.score && !(runMode && result.comparator === 'ring_once');
  if(shouldScaleConfidence){ result.confidence = clamp(result.confidence * result.score, 0, 1); }
  state.telemetry.push({ field: fieldSpec.fieldKey, method: result.method, comparator: result.comparator, score: result.score, confidence: result.confidence });
  if(result.boxPx && (result.method.startsWith('ring') || result.method.startsWith('partial') || result.method==='anchor')){
    state.matchPoints.push({ x: result.boxPx.x + result.boxPx.w/2, y: result.boxPx.y + result.boxPx.h/2, page: result.boxPx.page });
  }
  if(runMode && ftype==='static' && staticDebugEnabled()){
    const finalBox = result.boxPx || basePx || null;
    logStaticDebug(
      `final-box field=${fieldSpec.fieldKey||''} page=${finalBox?.page || fieldSpec.page || ''} box=${formatBoxForLog(finalBox)} mask=${(configMask||[]).join(',')}`,
      { box: finalBox, configMask }
    );
  }
  result.rawBeforeClean = selectionRaw || result.raw || '';
  traceEvent(spanKey,'value.finalized',{
    value: result.value,
    confidence: result.confidence,
    method: result.method,
    stageLabel:'Value finalized',
    stepNumber:8,
    bbox:{ pixel: result.boxPx || basePx || null },
    confidence:{ score: result.confidence, comparator: result.comparator, method: result.method },
    timing:{ stageUsed: stageUsed.value },
    notes:'Final output after extraction pipeline'
  });
  result.tokens = result.tokens || [];
  return result;
}

async function extractLineItems(profile){
  const colFields = (profile.fields||[]).filter(f=>f.type==='column' && f.column && Array.isArray(f.column.xband));
  if(!colFields.length){
    state.lineLayout = null;
    drawOverlay();
    return [];
  }

  const keyMap = COLUMN_OUT_KEYS;
  const tableHints = profile.tableHints || {};
  const anchorHintKey = tableHints.rowAnchor?.fieldKey;
  const columnPriority = ['line_number_col','product_description','sku_col','quantity_col','unit_price_col','line_total_col'];
  const guardWordsBase = new Set(['subtotal','sub-total','total','grandtotal','balance','amount','amountdue','totaldue','tax','taxamount','hst','gst','qst','notes','deposit']);
  const cleanedTokenText = str => String(str||'').replace(/[^a-z0-9]/gi,'').toLowerCase();

  function normalizeGuardList(list){
    return Array.from(new Set((list||[]).map(w=>cleanedTokenText(w)).filter(Boolean)));
  }

  function buildRowBands(anchorTokens, pageHeight){
    if(!anchorTokens.length) return [];
    const ordered = anchorTokens.slice().sort((a,b)=> a.cy - b.cy || a.y - b.y || a.x - b.x);
    const groups=[];
    let current=null;
    for(const tok of ordered){
      if(!current){
        current={ tokens:[tok], sumCy: tok.cy, count:1, cy: tok.cy, height: tok.h, text:(tok.text||'').trim() };
        continue;
      }
      const gap=Math.abs(tok.cy - current.cy);
      const threshold=Math.max(current.height, tok.h)*0.65;
      if(gap <= threshold){
        current.tokens.push(tok);
        current.sumCy += tok.cy;
        current.count += 1;
        current.cy = current.sumCy/current.count;
        current.height = Math.max(current.height, tok.h);
        current.text = current.tokens.map(t=>t.text).join(' ');
      } else {
        groups.push(current);
        current={ tokens:[tok], sumCy: tok.cy, count:1, cy: tok.cy, height: tok.h, text:(tok.text||'').trim() };
      }
    }
    if(current) groups.push(current);
    return groups.map((row,idx)=>{
      const next=groups[idx+1];
      const rowTop=Math.min(...row.tokens.map(t=>t.y));
      const rowBottom=Math.max(...row.tokens.map(t=>t.y + t.h));
      const rowHeight=Math.max(rowBottom - rowTop, row.height, 6);
      let y0=rowTop;
      let y1=rowBottom;
      const nextTop = next ? Math.min(...next.tokens.map(t=>t.y)) : Infinity;
      if(Number.isFinite(nextTop)){
        const boundary=(rowBottom + nextTop)/2;
        if(Number.isFinite(boundary)){
          y1 = Math.max(rowBottom, Math.min(boundary, nextTop));
        }
      }
      const maxY1 = Number.isFinite(nextTop) ? Math.max(rowBottom, Math.min(nextTop, pageHeight)) : pageHeight;
      const minBand=Math.max(rowHeight,8);
      if(y1 - y0 < minBand){
        y1 = Math.min(maxY1, y0 + minBand);
      }
      y0=Math.max(0, Math.min(y0, pageHeight));
      y1=Math.max(y0 + 1, Math.min(y1, pageHeight));
      if(y1 <= y0){
        y0=Math.max(0,rowTop);
        y1=Math.max(y0 + 1, Math.min(pageHeight,rowBottom || (rowTop + rowHeight)));
      }
      if(!Number.isFinite(nextTop)){
        y1 = pageHeight;
      }
      return { index:idx, y0, y1, cy:row.cy, height:rowHeight, text:row.text.trim(), tokens:row.tokens };
    });
  }

  function tokensForCell(desc, band, pageTokens){
    const headerLimit = desc.headerBottom + desc.headerPad;
    const y0 = band.y0;
    const y1 = band.y1;
    const expectedLeft = Number.isFinite(desc.expectedLeft) ? desc.expectedLeft : null;
    const expectedRight = Number.isFinite(desc.expectedRight) ? desc.expectedRight : null;
    const expectedCenter = Number.isFinite(desc.expectedCenter)
      ? desc.expectedCenter
      : (Number.isFinite(expectedLeft) && Number.isFinite(expectedRight) ? (expectedLeft + expectedRight) / 2 : null);
    const expectedWidth = Number.isFinite(desc.expectedWidth) ? desc.expectedWidth : (Number.isFinite(expectedLeft) && Number.isFinite(expectedRight) ? Math.max(0, expectedRight - expectedLeft) : null);
    const tolerance = Number.isFinite(desc.feraTolerance) ? desc.feraTolerance : null;
    const align = desc.align || 'left';
    const scored=[];
    for(const tok of pageTokens){
      if(tok.page !== desc.page) continue;
      const cx = tok.x + tok.w/2;
      if(cx < desc.x0 - 1 || cx > desc.x1 + 1) continue;
      const cy = tok.y + tok.h/2;
      if(cy <= headerLimit) continue;
      const text=(tok.text||'').trim();
      if(!text) continue;
      const top=tok.y;
      const bottom=tok.y + tok.h;
      const overlap=Math.min(bottom, y1) - Math.max(top, y0);
      const minOverlap=Math.min(tok.h, y1 - y0) * 0.35;
      if(overlap < minOverlap) continue;
      const leftEdge = tok.x;
      const rightEdge = tok.x + tok.w;
      const center = leftEdge + tok.w/2;
      let diff = 0;
      if(align === 'right' && Number.isFinite(expectedRight)){
        diff = Math.abs(rightEdge - expectedRight);
      } else if(align === 'center' && Number.isFinite(expectedCenter)){
        diff = Math.abs(center - expectedCenter);
      } else if(Number.isFinite(expectedLeft)){
        diff = Math.abs(leftEdge - expectedLeft);
      } else if(Number.isFinite(expectedRight)){
        diff = Math.abs(rightEdge - expectedRight);
      } else if(Number.isFinite(expectedCenter)){
        diff = Math.abs(center - expectedCenter);
      } else {
        diff = 0;
      }
      const tokenWithCy = { ...tok, cy };
      scored.push({ token: tokenWithCy, diff });
    }
    scored.sort((a,b)=> (a.token.x - b.token.x) || (a.token.y - b.token.y));
    let feraOk = true;
    let feraReason = null;
    let bestDiff = null;
    let tokensOut = scored.map(s => s.token);
    if(tolerance && scored.length){
      const within = scored.filter(s => s.diff <= tolerance);
      if(within.length){
        within.sort((a,b)=> a.diff - b.diff || a.token.y - b.token.y || a.token.x - b.token.x);
        bestDiff = within[0].diff;
        const closenessAllowance = Math.max(desc.typicalHeight || 0, tolerance * 0.3, 6);
        const keepThreshold = Math.min(tolerance, bestDiff + closenessAllowance);
        const keepSet = new Set(within.filter(s => s.diff <= keepThreshold).map(s => s.token));
        tokensOut = scored
          .filter(s => keepSet.has(s.token))
          .sort((a,b)=> a.token.y - b.token.y || a.token.x - b.token.x)
          .map(s => s.token);
      } else {
        feraOk = false;
        feraReason = 'fera_tolerance_fail';
        tokensOut = [];
      }
    }
    return {
      tokens: tokensOut,
      feraOk,
      feraReason,
      feraTolerance: tolerance,
      feraBestDiff: bestDiff,
      feraExpected: {
        left: expectedLeft,
        right: expectedRight,
        center: expectedCenter,
        width: expectedWidth,
        align
      }
    };
  }

  function computeTrimmedAverage(counts){
    if(!Array.isArray(counts) || !counts.length) return null;
    if(counts.length < 3){
      const sum = counts.reduce((acc, val) => acc + val, 0);
      return counts.length ? sum / counts.length : null;
    }
    const sorted = counts.slice().sort((a,b)=>a-b);
    const trimmed = sorted.slice(1, sorted.length - 1);
    if(!trimmed.length){
      const sum = counts.reduce((acc, val) => acc + val, 0);
      return counts.length ? sum / counts.length : null;
    }
    const sum = trimmed.reduce((acc, val) => acc + val, 0);
    return trimmed.length ? sum / trimmed.length : null;
  }

  function pickRowTarget(counts, fallback){
    if(!Array.isArray(counts) || !counts.length) return fallback;
    const trimmed = computeTrimmedAverage(counts);
    if(Number.isFinite(trimmed) && trimmed > 0){
      return Math.round(trimmed);
    }
    const sum = counts.reduce((acc, val) => acc + val, 0);
    const avg = counts.length ? sum / counts.length : null;
    if(Number.isFinite(avg) && avg > 0){
      return Math.round(avg);
    }
    return fallback;
  }

  function pruneRowsBySupport(rows, target){
    if(!Array.isArray(rows) || rows.length <= target) return rows;
    const buckets = new Map();
    rows.forEach((row, idx) => {
      const support = row.__columnHits || 0;
      if(!buckets.has(support)) buckets.set(support, []);
      buckets.get(support).push({ row, idx });
    });
    const toDrop = new Set();
    let remaining = rows.length;
    const supportLevels = Array.from(buckets.keys()).sort((a,b)=>a-b);
    for(const level of supportLevels){
      const entries = buckets.get(level);
      entries.sort((a,b)=>{
        const aTokens = a.row.__totalTokens || 0;
        const bTokens = b.row.__totalTokens || 0;
        if(aTokens !== bTokens) return aTokens - bTokens;
        const aAnchor = a.row.__anchorTokens || 0;
        const bAnchor = b.row.__anchorTokens || 0;
        if(aAnchor !== bAnchor) return aAnchor - bAnchor;
        return b.idx - a.idx;
      });
      for(const entry of entries){
        if(remaining <= target) break;
        toDrop.add(entry.idx);
        remaining--;
      }
      if(remaining <= target) break;
    }
    if(remaining > target){
      for(let i=rows.length-1; i>=0 && remaining>target; i--){
        if(!toDrop.has(i)){
          toDrop.add(i);
          remaining--;
        }
      }
    }
    return rows.filter((row, idx) => !toDrop.has(idx));
  }

  const results=[];
  const layout={ pages:{} };
  const configuredPages = Array.from(new Set(colFields.map(f=>f.page||1))).sort((a,b)=>a-b);
  const totalPages = state.numPages || state.pdf?.numPages || configuredPages[configuredPages.length-1] || 1;
  const pages = Array.from({ length: totalPages }, (_,i)=>i+1);
  const docId = state.currentFileId || state.currentFileName || 'doc';
  let globalRowIndex = 0;

  for(const page of pages){
    const vp = state.pageViewports[page-1];
    if(!vp){
      layout.pages[page] = { page, columns: [], rows: [], top: 0, bottom: 0 };
      continue;
    }
    const pageTokens = await ensureTokensForPage(page);
    const pageWidth = Math.max(1, ((vp.w ?? vp.width)||1));
    const pageHeight = Math.max(1, ((vp.h ?? vp.height)||1));
    const mapFieldToPage = (field, targetPage) => {
      const columnClone = field.column ? clonePlain(field.column) : null;
      return {
        ...field,
        page: targetPage,
        __sourcePage: field.page || targetPage,
        column: columnClone || null
      };
    };
    let fieldsOnPage = colFields.filter(f => (f.page||1) === page).map(f => mapFieldToPage(f, page));
    if(!fieldsOnPage.length){
      fieldsOnPage = colFields.map(f => mapFieldToPage(f, page));
    }
    if(!fieldsOnPage.length){
      layout.pages[page] = { page, columns: [], rows: [], top: 0, bottom: 0 };
      continue;
    }

    const descriptors = fieldsOnPage.map(field => {
      const bandPx = toPx(vp,{x0:field.column.xband[0], y0:0, x1:field.column.xband[1], y1:1, page});
      const headerBox = field.column.header ? toPx(vp,{x0:field.column.header[0], y0:field.column.header[1], x1:field.column.header[2], y1:field.column.header[3], page}) : null;
      const lineHeightPx = Math.max(0, (field.column.lineHeightPct || 0) * pageHeight);
      let headerBottom = typeof field.column.headerBottomPct === 'number'
        ? field.column.headerBottomPct * pageHeight
        : headerBox ? headerBox.y + headerBox.h
        : bandPx.y + Math.max(lineHeightPx*1.5, 12);
      let userTop = 0;
      let userBottom = pageHeight;
      if(Array.isArray(field.column.yband) && field.column.yband.length === 2){
        const selectionBox = toPx(vp, {
          x0: field.column.xband[0],
          y0: field.column.yband[0],
          x1: field.column.xband[1],
          y1: field.column.yband[1],
          page
        });
        userTop = selectionBox.y;
        userBottom = selectionBox.y + selectionBox.h;
      }
      const anchorSample = field.column.anchorSample ? {
        cy: field.column.anchorSample.cyNorm * pageHeight,
        h: Math.max(field.column.anchorSample.hNorm * pageHeight, 1),
        text: field.column.anchorSample.text || ''
      } : null;
      const rowSamples = Array.isArray(field.column.rowSamples) ? field.column.rowSamples.map(s => ({
        cy: s.cyNorm * pageHeight,
        h: Math.max(s.hNorm * pageHeight, 1)
      })) : [];
      const guardList = normalizeGuardList(field.column.guardWords || field.column.bottomGuards || []);
      guardList.forEach(g => guardWordsBase.add(g));
      const typicalHeight = anchorSample?.h || rowSamples[0]?.h || lineHeightPx || 12;
      const headerPad = Math.max(4, typicalHeight * (field.column.header ? 0.6 : 0.35));
      const align = field.column.align || 'left';
      const fallbackMargin = Math.max(2, typicalHeight * 0.4);
      const baseLeft = bandPx.x;
      const baseRight = bandPx.x + bandPx.w;
      const userLeft = baseLeft;
      const userRight = baseRight;
      const userWidth = Math.max(1, baseRight - baseLeft);
      const fallbackX0 = Math.max(0, baseLeft - fallbackMargin);
      const fallbackX1 = Math.min(pageWidth, baseRight + fallbackMargin);
      const anchorFera = tableHints.rowAnchor?.fieldKey === field.fieldKey ? (tableHints.rowAnchor.fera || tableHints.rowAnchor.metrics || null) : null;
      const savedFera = field.column.fera || field.anchorMetrics || anchorFera || null;
      const feraProjection = projectColumnFera(savedFera, pageWidth, pageHeight);
      let expectedLeft = Number.isFinite(feraProjection?.x0) ? feraProjection.x0 : null;
      let expectedRight = Number.isFinite(feraProjection?.x1) ? feraProjection.x1 : null;
      let expectedCenter = Number.isFinite(feraProjection?.centerX) ? feraProjection.centerX : null;
      if(!Number.isFinite(expectedCenter) && Number.isFinite(expectedLeft) && Number.isFinite(expectedRight)){
        expectedCenter = (expectedLeft + expectedRight) / 2;
      }
      let expectedWidth = Number.isFinite(feraProjection?.width) ? feraProjection.width : null;
      if(!Number.isFinite(expectedWidth) && Number.isFinite(expectedLeft) && Number.isFinite(expectedRight) && expectedRight > expectedLeft){
        expectedWidth = expectedRight - expectedLeft;
      }
      if(!Number.isFinite(expectedWidth)){
        expectedWidth = Math.max(1, baseRight - baseLeft);
      }
      const feraTolerance = savedFera
        ? Math.max(6, typicalHeight * 0.9, expectedWidth * (align === 'right' ? 0.2 : align === 'center' ? 0.25 : 0.35))
        : null;
      const searchMargin = savedFera
        ? Math.max(4, typicalHeight * 0.75, feraTolerance || 0)
        : Math.max(2, typicalHeight * 0.4);
      let searchX0 = Number.isFinite(expectedLeft) ? expectedLeft : baseLeft;
      let searchX1 = Number.isFinite(expectedRight) ? expectedRight : baseRight;
      searchX0 = Math.max(0, searchX0 - searchMargin);
      searchX1 = Math.min(pageWidth, searchX1 + searchMargin);
      if(searchX1 <= searchX0){
        searchX0 = fallbackX0;
        searchX1 = fallbackX1;
      }
      const minSearchWidth = Math.max(1, userWidth * 0.9);
      if((searchX1 - searchX0) < minSearchWidth){
        const deficit = minSearchWidth - (searchX1 - searchX0);
        const extendLeft = Math.min(deficit/2, searchX0);
        searchX0 = Math.max(0, searchX0 - extendLeft);
        searchX1 = Math.min(pageWidth, searchX1 + (deficit - extendLeft));
        if((searchX1 - searchX0) < minSearchWidth){
          searchX0 = Math.max(0, Math.min(searchX0, userLeft));
          searchX1 = Math.min(pageWidth, Math.max(searchX1, userRight));
        }
      }
      const sourcePage = field.__sourcePage || field.page || page;
      return {
        fieldKey: field.fieldKey,
        outKey: keyMap[field.fieldKey] || field.fieldKey,
        page,
        sourcePage,
        x0: searchX0,
        x1: searchX1,
        userLeft,
        userRight,
        userWidth,
        fallbackX0,
        fallbackX1,
        headerBottom,
        headerPad,
        align,
        regexHint: field.column.regexHint || '',
        anchorSample,
        anchorSampleMetrics: field.column.anchorSampleMetrics || null,
        rowSamples,
        guardWords: guardList,
        column: field.column,
        expectedLeft,
        expectedRight,
        expectedCenter,
        expectedWidth,
        feraTolerance,
        feraActive: !!savedFera,
        feraSource: savedFera || null,
        feraProjection: feraProjection || null,
        typicalHeight,
        userTop,
        userBottom
      };
    });

    const order = columnPriority.filter(k => descriptors.some(d=>d.fieldKey===k))
      .concat(descriptors.map(d=>d.fieldKey).filter(k => !columnPriority.includes(k)));
    let anchor = descriptors.find(d=>d.fieldKey===anchorHintKey) || descriptors.find(d=>d.fieldKey===order[0]) || descriptors[0];
    const guardMatch = cleaned => cleaned && guardWordsBase.has(cleaned);

    const applyAnchorGuard = (desc, tokList=[], pageNum=page) => {
      if(!isRunMode()) return { tokens: tokList, bandTokens: tokList };
      if(desc.sourcePage && desc.sourcePage !== pageNum) return { tokens: tokList, bandTokens: tokList };
      const saved = desc.anchorSampleMetrics || (tableHints.rowAnchor?.fieldKey === desc.fieldKey ? tableHints.rowAnchor.metrics : null);
      if(!saved) return { tokens: tokList, bandTokens: tokList };
      const filtered = (tokList || []).filter(tok => {
        const anchorRes = anchorMatchForBox(saved, { x: tok.x, y: tok.y, w: tok.w, h: tok.h }, [tok], pageWidth, pageHeight);
        return anchorRes.ok || anchorRes.softOk;
      });
      if(filtered.length) return { tokens: tokList, bandTokens: filtered };
      return { tokens: [], bandTokens: [] };
    };

    const tokenCache = new Map();
    const cacheKeyFor = desc => `${desc.fieldKey || ''}@${desc.page || page}`;

    const collectColumnTokens = desc => {
      const cacheKey = cacheKeyFor(desc);
      if(tokenCache.has(cacheKey)) return tokenCache.get(cacheKey);
      let headerLimit = desc.headerBottom + desc.headerPad;
      const sampleHeights=[];
      let earliestTop=Infinity;
      let earliestCenter=Infinity;
      if(desc.anchorSample){
        earliestTop = Math.min(earliestTop, desc.anchorSample.cy - desc.anchorSample.h/2);
        earliestCenter = Math.min(earliestCenter, desc.anchorSample.cy);
        sampleHeights.push(desc.anchorSample.h);
      }
      if(Array.isArray(desc.rowSamples)){
        for(const sample of desc.rowSamples){
          earliestTop = Math.min(earliestTop, sample.cy - sample.h/2);
          earliestCenter = Math.min(earliestCenter, sample.cy);
          sampleHeights.push(sample.h);
        }
      }
      if(sampleHeights.length){
        const avgSampleH = sampleHeights.reduce((s,h)=>s+h,0)/sampleHeights.length;
        if(Number.isFinite(earliestTop)){
          headerLimit = Math.min(headerLimit, earliestTop);
        }
        if(Number.isFinite(earliestCenter)){
          const margin = Math.max(avgSampleH * 0.35, 2);
          headerLimit = Math.min(headerLimit, earliestCenter - margin);
        }
      }
      headerLimit = Math.max(0, headerLimit);
      const gather = (x0, x1) => {
        const hits=[];
        for(const tok of pageTokens){
          if(tok.page !== desc.page) continue;
          const cx = tok.x + tok.w/2;
          if(cx < x0 - 1 || cx > x1 + 1) continue;
          const cy = tok.y + tok.h/2;
          if(cy <= headerLimit) continue;
          const text = (tok.text||'').trim();
          if(!text) continue;
          const cleaned = cleanedTokenText(text);
          if(cleaned && (desc.guardWords.includes(cleaned) || guardMatch(cleaned))) break;
          hits.push({ ...tok, cy, cleaned });
        }
        return hits;
      };
      let colToks = gather(desc.x0, desc.x1);
      if(!colToks.length && desc.feraActive && Number.isFinite(desc.fallbackX0) && Number.isFinite(desc.fallbackX1)){
        colToks = gather(desc.fallbackX0, desc.fallbackX1);
      }
      colToks.sort((a,b)=> a.cy - b.cy || a.x - b.x);
      tokenCache.set(cacheKey, colToks);
      return colToks;
    };

    const computeVisualColumnLayout = () => {
      if(!descriptors.length) return new Map();
      state.debugLineAnchors = [];
      const sorted = descriptors.slice().sort((a,b)=>{
        if(a.userLeft !== b.userLeft) return a.userLeft - b.userLeft;
        return a.userRight - b.userRight;
      });
      const meta = sorted.map((desc, idx) => {
        const tokens = collectColumnTokens(desc);
        let textLeft = desc.userLeft;
        let textRight = desc.userRight;
        if(tokens.length){
          let minX = Infinity;
          let maxX = -Infinity;
          for(const tok of tokens){
            minX = Math.min(minX, tok.x);
            maxX = Math.max(maxX, tok.x + tok.w);
          }
          if(Number.isFinite(minX)) textLeft = Math.min(textLeft, minX);
          if(Number.isFinite(maxX)) textRight = Math.max(textRight, maxX);
        }
        let pinkBounds = null;
        if(desc.fieldKey === 'line_number_col'){
          const blueLeft = desc.userLeft;
          const blueRight = desc.userRight;
          const blueTop = Number.isFinite(desc.userTop) ? desc.userTop : 0;
          const blueBottom = Number.isFinite(desc.userBottom) ? desc.userBottom : pageHeight;
          const blueWidth = Math.max(1, desc.userWidth);
          const widthCap = blueWidth * 1.1;
          const epsilon = 0;
          const intersectsBlue = tok => {
            const top = tok.y;
            const bottom = tok.y + tok.h;
            const left = tok.x;
            const right = tok.x + tok.w;
            return right >= blueLeft && left <= blueRight && bottom >= blueTop && top <= blueBottom;
          };
          const verticalMatch = tok => {
            const top = tok.y;
            const bottom = tok.y + tok.h;
            return bottom >= blueTop && top <= blueBottom;
          };
          const tokensInBlue = tokens.filter(intersectsBlue);
          const anchorCandidates = tokensInBlue.length ? tokensInBlue : (tokens.filter(verticalMatch));
          if(anchorCandidates.length){
            let anchorToken = null;
            let bestDy = Infinity;
            let bestDx = Infinity;
            for(const tok of anchorCandidates){
              const dy = Math.abs(tok.y - blueTop);
              const dx = Math.abs(tok.x - blueLeft);
              if(dy < bestDy || (dy === bestDy && dx < bestDx)){
                anchorToken = tok;
                bestDy = dy;
                bestDx = dx;
              }
            }
            if(anchorToken){
              const anchorRight = anchorToken.x + anchorToken.w;
              let pinkLeft = Math.max(blueLeft, anchorRight + epsilon);
              let pinkRight = Math.min(blueRight, blueLeft + widthCap);
              if(pinkRight < pinkLeft){
                pinkRight = pinkLeft;
              }
              if(pinkRight - pinkLeft > widthCap){
                pinkRight = pinkLeft + widthCap;
              }
              pinkLeft = clamp(pinkLeft, blueLeft, blueRight);
              pinkRight = clamp(pinkRight, pinkLeft, blueRight);
              const ordered = (tokensInBlue.length ? tokensInBlue : anchorCandidates).slice().sort((a,b)=> a.y - b.y || a.x - b.x);
              const lineTokens = tokensInBlue.filter(tok => {
                const cx = tok.x + tok.w/2;
                return cx >= pinkLeft && cx <= pinkRight;
              }).sort((a,b)=> a.y - b.y || a.x - b.x);
              const lastLineTok = (lineTokens.length ? lineTokens[lineTokens.length - 1] : ordered[ordered.length - 1]) || anchorToken;
              const pinkTop = clamp(anchorToken.y, blueTop, blueBottom);
              let pinkBottom = Math.min(blueBottom, lastLineTok.y + lastLineTok.h);
              if(pinkBottom < pinkTop){
                pinkBottom = pinkTop;
              }
              const pinkWidth = pinkRight - pinkLeft;
              pinkBounds = {
                left: pinkLeft,
                right: pinkRight,
                top: pinkTop,
                bottom: pinkBottom,
                tokens: lineTokens
              };
              textLeft = pinkBounds.left;
              textRight = pinkBounds.right;
              const anchorLog = {
                fieldKey: desc.fieldKey,
                page: desc.page,
                blueLeft,
                blueRight,
                anchorLeft: anchorToken.x,
                anchorRight,
                pinkLeft,
                pinkRight,
                pinkWidth
              };
              state.debugLineAnchors.push({
                page: desc.page,
                anchorRight,
                anchorTop: anchorToken.y,
                blueLeft,
                blueRight,
                pinkLeft,
                pinkRight
              });
              console.debug('[line-number snap]', anchorLog);
            }
          }
        }
        return { desc, textLeft, textRight, pinkBounds };
      });
      const boundaries = new Array(meta.length + 1);
      boundaries[0] = clamp(Math.min(meta[0].desc.userLeft, meta[0].textLeft), 0, pageWidth);
      for(let i=0; i<meta.length-1; i++){
        const leftMeta = meta[i];
        const rightMeta = meta[i+1];
        const leftEdge = Math.max(leftMeta.desc.userRight, leftMeta.textRight);
        const rightEdge = Math.min(rightMeta.desc.userLeft, rightMeta.textLeft);
        let boundary;
        if(Number.isFinite(leftEdge) && Number.isFinite(rightEdge)){
          boundary = (leftEdge + rightEdge) / 2;
        } else if(Number.isFinite(leftEdge)){
          boundary = leftEdge;
        } else if(Number.isFinite(rightEdge)){
          boundary = rightEdge;
        } else {
          boundary = boundaries[i] ?? 0;
        }
        const base = boundaries[i] ?? 0;
        boundary = clamp(boundary, base, pageWidth);
        boundaries[i+1] = boundary;
      }
      const lastMeta = meta[meta.length-1];
      const lastPrev = boundaries[meta.length-1] ?? 0;
      const lastRight = Math.max(lastMeta.desc.userRight, lastMeta.textRight);
      boundaries[meta.length] = clamp(lastRight, lastPrev, pageWidth);

      for(let i=1; i<boundaries.length; i++){
        if(!Number.isFinite(boundaries[i])){
          boundaries[i] = boundaries[i-1];
        } else if(boundaries[i] < boundaries[i-1]){
          boundaries[i] = boundaries[i-1];
        }
      }

      const result = new Map();
      for(let i=0; i<meta.length; i++){
        let left = boundaries[i];
        let right = boundaries[i+1];
        const minWidth = Math.max(1, meta[i].desc.userWidth * 0.9);
        if(right - left < minWidth){
          const deficit = minWidth - (right - left);
          const shiftLeft = Math.min(deficit/2, left);
          left -= shiftLeft;
          right += (deficit - shiftLeft);
          if(right > pageWidth){
            const overflow = right - pageWidth;
            right = pageWidth;
            left = Math.max(0, left - overflow);
          }
          if(right - left < minWidth){
            right = Math.min(pageWidth, left + minWidth);
            if(right - left < minWidth){
              left = Math.max(0, right - minWidth);
            }
          }
        }
        left = clamp(left, 0, pageWidth);
        right = clamp(right, left + 1, pageWidth);
        boundaries[i] = left;
        boundaries[i+1] = right;
        if(meta[i].pinkBounds){
          const cacheKey = cacheKeyFor(meta[i].desc);
          tokenCache.set(cacheKey, meta[i].pinkBounds.tokens);
          meta[i].desc.visualBounds = {
            left: meta[i].pinkBounds.left,
            right: meta[i].pinkBounds.right,
            top: meta[i].pinkBounds.top,
            bottom: meta[i].pinkBounds.bottom
          };
          meta[i].desc.x0 = Math.max(meta[i].desc.x0, meta[i].pinkBounds.left);
          meta[i].desc.x1 = Math.min(meta[i].desc.x1, meta[i].pinkBounds.right);
          if(meta[i].desc.x1 < meta[i].desc.x0){
            meta[i].desc.x1 = meta[i].desc.x0;
          }
          meta[i].desc.x0 = clamp(meta[i].desc.x0, 0, pageWidth);
          meta[i].desc.x1 = clamp(meta[i].desc.x1, meta[i].desc.x0, pageWidth);
          meta[i].desc.expectedLeft = meta[i].pinkBounds.left;
          meta[i].desc.expectedRight = meta[i].pinkBounds.right;
          meta[i].desc.expectedCenter = (meta[i].pinkBounds.left + meta[i].pinkBounds.right) / 2;
          meta[i].desc.expectedWidth = Math.max(1, meta[i].pinkBounds.right - meta[i].pinkBounds.left);
        }
        result.set(meta[i].desc.fieldKey, {
          x0: left,
          x1: right,
          y0: meta[i].pinkBounds?.top ?? 0,
          y1: meta[i].pinkBounds?.bottom ?? pageHeight
        });
      }
      return result;
    };

    const buildColumnLayout = () => {
      const visualColumns = computeVisualColumnLayout();
      return descriptors.map(d => {
        const visual = visualColumns.get(d.fieldKey);
        if(visual){
          return { fieldKey: d.fieldKey, x0: visual.x0, x1: visual.x1 };
        }
        return { fieldKey: d.fieldKey, x0: d.userLeft, x1: d.userRight };
      });
    };

    let anchorTokens = collectColumnTokens(anchor);
    let anchorBandTokens = anchorTokens;
    if(anchorTokens.length){
      const guarded = applyAnchorGuard(anchor, anchorTokens, page);
      anchorTokens = guarded.tokens;
      anchorBandTokens = guarded.bandTokens;
    }
    if(!anchorTokens.length){
      for(const key of order){
        const cand = descriptors.find(d=>d.fieldKey===key);
        if(!cand) continue;
        const candidateTokens = collectColumnTokens(cand);
        const guarded = applyAnchorGuard(cand, candidateTokens, page);
        if(guarded.tokens.length){ anchor = cand; anchorTokens = guarded.tokens; anchorBandTokens = guarded.bandTokens; break; }
      }
    }

    if(!anchorTokens.length){
      layout.pages[page] = { page, columns: buildColumnLayout(), rows: [], top: 0, bottom: 0 };
      continue;
    }

    const rowBands = buildRowBands(anchorBandTokens, pageHeight);
    if(!rowBands.length){
      layout.pages[page] = { page, columns: buildColumnLayout(), rows: [], top: 0, bottom: 0 };
      continue;
    }

    const columnRowCounts = new Map();
    const pageRows = [];
    for(const band of rowBands){
      const row={
        line_no: '',
        __page: page,
        __y0: band.y0,
        __y1: band.y1,
        __missing:{},
        __cells:{},
        __anchorField: anchor.fieldKey,
        __anchorText: band.text,
        __columnHits: 0,
        __totalTokens: 0,
        __anchorTokens: 0
      };

      for(const desc of descriptors){
        const cellResult = tokensForCell(desc, band, pageTokens);
        const cellTokens = cellResult.tokens;
        const raw = cellTokens.map(t=>t.text).join(' ').replace(/\s+/g,' ').trim();
        const spanKey = { docId, pageIndex: page-1, fieldKey: desc.outKey };
        let cleaned = null;
        let value = '';
        let fingerprintOk = true;
        if(cellTokens.length){
          cleaned = FieldDataEngine.clean(desc.outKey, cellTokens, state.mode, spanKey);
          const isValid = cleaned?.isValid !== false;
          value = cleaned.value || cleaned.raw || raw;
          if(!isValid){
            value = '';
          }
          fingerprintOk = isValid && fingerprintMatches(desc.outKey, cleaned.code, state.mode, desc.fieldKey);
          if(cleaned){
            cleaned.fingerprintOk = fingerprintOk;
            cleaned.isValid = isValid;
          }
          if(!isValid){
            row.__missing[desc.outKey] = true;
          }
          if(!fingerprintOk){
            value = '';
          }
          row.__totalTokens += cellTokens.length;
          if(desc.fieldKey === anchor.fieldKey){
            row.__anchorTokens += cellTokens.length;
          } else {
            row.__columnHits += 1;
          }
          const prevCount = columnRowCounts.get(desc.fieldKey) || 0;
          columnRowCounts.set(desc.fieldKey, prevCount + 1);
        }
        if(desc.fieldKey === anchor.fieldKey && !value && band.text){
          value = band.text.trim();
        }
        if(desc.outKey === 'line_no'){
          const n=parseInt(String(value).replace(/[^0-9]/g,''),10);
          if(Number.isFinite(n)) row.line_no = n; else row.__missing.line_no = true;
        } else if(desc.outKey === 'description'){
          row.description = value;
        } else if(desc.outKey === 'sku'){
          row.sku = value;
        } else if(desc.outKey === 'quantity'){
          row.quantity = value;
        } else if(desc.outKey === 'unit_price'){
          row.unit_price = value;
        } else if(desc.outKey === 'amount'){
          row.amount = value;
        } else {
          row[desc.outKey] = value;
        }
        const cellMeta = {
          raw,
          tokens: cellTokens,
          cleaned,
          fingerprintOk,
          isValid: cleaned?.isValid !== false,
          invalidReason: cleaned?.invalidReason || null,
          fera: {
            ok: cellResult.feraOk,
            reason: cellResult.feraReason || null,
            tolerance: cellResult.feraTolerance,
            bestDiff: cellResult.feraBestDiff,
            expected: cellResult.feraExpected || null
          }
        };
        row.__cells[desc.fieldKey] = cellMeta;
        let missingReason = null;
        if(!cellTokens.length){
          missingReason = cellResult.feraReason || 'no_tokens';
        } else if(!fingerprintOk){
          missingReason = 'fingerprint_mismatch';
        }
        if(missingReason){ row.__missing[desc.outKey] = missingReason; }
      }

      row.description = row.description || '';
      row.sku = row.sku || '';
      row.quantity = row.quantity || '';
      row.unit_price = row.unit_price || '';
      row.amount = row.amount || '';
      if(row.line_no === '' && !row.__missing.line_no){ row.__missing.line_no = true; }

      if(row.quantity) row.quantity = row.quantity.replace(/[^0-9.-]/g,'');
      if(row.unit_price){
        const num=parseFloat(row.unit_price.replace(/[^0-9.-]/g,''));
        row.unit_price = Number.isFinite(num) ? num.toFixed(2) : '';
      }
      if(row.amount){
        const num=parseFloat(row.amount.replace(/[^0-9.-]/g,''));
        row.amount = Number.isFinite(num) ? num.toFixed(2) : '';
      }
      if(!row.amount && row.quantity && row.unit_price){
        const q=parseFloat(row.quantity), u=parseFloat(row.unit_price);
        if(Number.isFinite(q) && Number.isFinite(u)) row.amount=(q*u).toFixed(2);
      }

      pageRows.push(row);
    }

    const allCounts = descriptors.map(d => columnRowCounts.get(d.fieldKey) || 0).filter(c => c > 0);
    const nonAnchorCounts = descriptors
      .filter(d => d.fieldKey !== anchor.fieldKey)
      .map(d => columnRowCounts.get(d.fieldKey) || 0)
      .filter(c => c > 0);
    // Prefer consensus from supporting columns; fall back to all columns (including the anchor)
    // when they're the only ones with data.
    const countsForAverage = nonAnchorCounts.length ? nonAnchorCounts : allCounts;
    let targetRowCount = pageRows.length;
    if(countsForAverage.length){
      const desired = pickRowTarget(countsForAverage, pageRows.length);
      if(Number.isFinite(desired) && desired > 0){
        targetRowCount = Math.min(pageRows.length, Math.max(1, desired));
      }
    }

    const filteredRows = targetRowCount < pageRows.length ? pruneRowsBySupport(pageRows, targetRowCount) : pageRows;
    const pageRowEntries=[];
    for(const row of filteredRows){
      row.__rowIndex = globalRowIndex;
      row.__rowNumber = globalRowIndex + 1;
      if(row.line_no === '' || row.line_no === undefined){ row.line_no = row.__rowNumber; }
      results.push(row);
      pageRowEntries.push({ index: row.__rowIndex, y0: row.__y0, y1: row.__y1 });
      globalRowIndex++;
    }

    const colLayout = buildColumnLayout();
    const top = filteredRows.length ? Math.min(...filteredRows.map(r=>r.__y0)) : Math.min(...rowBands.map(r=>r.y0));
    const bottom = filteredRows.length ? Math.max(...filteredRows.map(r=>r.__y1)) : pageHeight;
    layout.pages[page] = { page, columns: colLayout, rows: pageRowEntries, top, bottom };
  }

  state.lineLayout = Object.keys(layout.pages).length ? layout : null;
  drawOverlay();
  return results;
}

/* ---------------------- PDF/Image Loading ------------------------ */
const overlayCtx = els.overlayCanvas.getContext('2d');
const sn = v => (typeof v==='number' && Number.isFinite(v)) ? Math.round(v*100)/100 : 'err';

function sizeOverlayTo(cssW, cssH){
  if(guardInteractive('overlay.size')) return;
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  const pxW = src?.width || Math.round(cssW * (window.devicePixelRatio || 1));
  const pxH = src?.height || Math.round(cssH * (window.devicePixelRatio || 1));
  els.overlayCanvas.style.width = cssW + 'px';
  els.overlayCanvas.style.height = cssH + 'px';
  els.overlayCanvas.width = pxW;
  els.overlayCanvas.height = pxH;
  overlayCtx.setTransform(pxW/cssW, 0, 0, pxH/cssH, 0, 0);
}

function syncOverlay(){
  if(guardInteractive('overlay.sync')) return;
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!src) return;
  const isConfig = isConfigMode();
  const rect = src.getBoundingClientRect();
  const parentRect = els.viewer.getBoundingClientRect();
  const left = rect.left - parentRect.left + els.viewer.scrollLeft - (els.viewer.clientLeft || 0);
  const top = rect.top - parentRect.top + els.viewer.scrollTop - (els.viewer.clientTop || 0);
  els.overlayCanvas.style.left = left + 'px';
  els.overlayCanvas.style.top = top + 'px';
  sizeOverlayTo(rect.width, rect.height);
  const dpr = window.devicePixelRatio || 1;
  state.overlayMetrics = {
    pin: isOverlayPinned(),
    cssW: rect.width,
    cssH: rect.height,
    pxW: src.width,
    pxH: src.height,
    dpr,
    cssBox: state.snappedCss || state.selectionCss || null,
    pxBox: state.snappedPx || state.selectionPx || null,
  };
  state.overlayPinned = state.overlayMetrics.pin;
  updateOverlayHud();
  if(isConfig && state.overlayPinned && state.pendingSelection && !state.pendingSelection.active && !applyingPendingSelection){
    const pending = state.pendingSelection;
    state.pendingSelection = null;
    if(runDiagnostics){
      if(runDiagnostics.shouldThrottleModeSync('pendingSelection', 3)) return;
      runDiagnostics.noteModeSync('pendingSelection');
    }
    applyingPendingSelection = true;
    applySelectionFromCss(pending.startCss, pending.endCss, { skipDraw:true });
    applyingPendingSelection = false;
    drawOverlay();
  }
}

function isOverlayPinned(){
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  const ov = els.overlayCanvas;
  if(!src || !ov) return false;
  const srcRect = src.getBoundingClientRect();
  const ovRect = ov.getBoundingClientRect();
  const eps = 2; // css pixel tolerance
  return Math.abs(srcRect.left - ovRect.left) < eps &&
         Math.abs(srcRect.top - ovRect.top) < eps &&
         Math.abs(srcRect.width - ovRect.width) < eps &&
         Math.abs(srcRect.height - ovRect.height) < eps &&
         Math.abs(ov.width - src.width) <= 1 &&
         Math.abs(ov.height - src.height) <= 1;
}

function updateOverlayHud(){
  if(!els.overlayHud) return;
  const m = state.overlayMetrics || {};
  const boxCss = m.cssBox ? ` cssBox:[${sn(m.cssBox.x)},${sn(m.cssBox.y)},${sn(m.cssBox.w)},${sn(m.cssBox.h)}]` : '';
  const boxPx = m.pxBox ? ` pxBox:[${sn(m.pxBox.x)},${sn(m.pxBox.y)},${sn(m.pxBox.w)},${sn(m.pxBox.h)}]` : '';
  els.overlayHud.textContent = `pin:${m.pin?1:0} css:${sn(m.cssW)}×${sn(m.cssH)} px:${sn(m.pxW)}×${sn(m.pxH)} dpr:${sn(m.dpr)}${boxCss}${boxPx}`;
}

function applySelectionFromCss(startCss, endCss, opts={}){
  const { scaleX, scaleY } = getScaleFactors();
  const startPx = { x:startCss.x*scaleX, y:startCss.y*scaleY };
  const endPx = { x:endCss.x*scaleX, y:endCss.y*scaleY };
  const page = pageFromYPx(startPx.y);
  const offPx = state.pageOffsets[page-1] || 0;
  const offCss = offPx/scaleY;
  const boxCss = {
    x: Math.min(startCss.x, endCss.x),
    y: Math.min(startCss.y, endCss.y) - offCss,
    w: Math.abs(endCss.x - startCss.x),
    h: Math.abs(endCss.y - startCss.y),
    page
  };
  const boxPx = {
    x: Math.min(startPx.x, endPx.x),
    y: Math.min(startPx.y, endPx.y) - offPx,
    w: Math.abs(endPx.x - startPx.x),
    h: Math.abs(endPx.y - startPx.y),
    page
  };
  state.selectionCss = boxCss;
  state.selectionPx = boxPx;
  if(!opts.skipDraw){
    drawOverlay();
  }
  finalizeSelection();
}
function updatePageIndicator(){ els.pageIndicator.textContent = `Page ${state.pageNum}/${state.numPages}`; }

function bufferLikelyHasAcroForm(arrayBuffer){
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const sniffLen = Math.min(bytes.length, 512000);
    if (sniffLen === 0) return false;
    const snippet = new TextDecoder('latin1').decode(bytes.subarray(0, sniffLen));
    return snippet.includes('/AcroForm') && snippet.includes('/Fields');
  } catch (err) {
    console.warn('AcroForm sniff failed; skipping flatten', err);
    return false;
  }
}

async function flattenAcroFormAppearances(arrayBuffer){
  if (!(window.PDFLib && PDFLib.PDFDocument)) return arrayBuffer;
  if (!bufferLikelyHasAcroForm(arrayBuffer)) return arrayBuffer;
  try {
    const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    if (!fields.length) return arrayBuffer;
    try {
      const helvetica = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      form.updateFieldAppearances(helvetica);
    } catch (err) {
      console.warn('Field appearance update failed; continuing to flatten', err);
    }
    form.flatten();
    const flattened = await pdfDoc.save();
    console.log(`[pdf] flattened ${fields.length} form fields into page content`);
    return flattened;
  } catch (err) {
    console.warn('AcroForm flatten failed; using original PDF', err);
    return arrayBuffer;
  }
}

function toPdfData(buffer){
  if(!buffer) return null;
  if(buffer instanceof Uint8Array) return buffer;
  if(buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  return null;
}

async function debugProbePdfBuffer(label, buffer){
  if(!DEBUG_FLATTEN_COMPARE || !pdfjsLibRef?.getDocument) return;
  const data = toPdfData(buffer);
  if(!data) return;
  const prefix = `[pdf-debug][${label}]`;
  try {
    console.log(`${prefix} loading for probe`);
    const loadingTask = pdfjsLibRef.getDocument({ data });
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const sample = content.items.slice(0, 5).map(i => (i?.str || '').slice(0, 80));
    console.log(`${prefix} page1 text items=${content.items.length}`, sample);
    await loadingTask.destroy();
  } catch(err){
    console.warn(`${prefix} probe failed`, err);
  }
}

async function debugCompareFlattenOutputs(originalBuffer, flattenedBuffer){
  if(!DEBUG_FLATTEN_COMPARE) return;
  await debugProbePdfBuffer('original', originalBuffer);
  if(flattenedBuffer && flattenedBuffer !== originalBuffer){
    await debugProbePdfBuffer('flattened', flattenedBuffer);
  }
}

// ===== Open file (image or PDF), robust across browsers =====
async function openFile(file){
  if (!(file instanceof Blob)) {
    console.error('openFile called with a non-Blob:', file);
    alert('Could not open file (unexpected type). Try selecting the file again.');
    return;
  }

  cleanupDoc();
  state.pdf = null;
  state.grayCanvases = {};
  state.matchPoints = [];
  state.telemetry = [];
  renderTelemetry();
  const arrayBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  state.currentFileName = file.name || 'untitled';
  state.currentFileId = hashHex;
  fileMeta[state.currentFileId] = { fileName: state.currentFileName };
  rawStore.clear(state.currentFileId);
  const isImage = /^image\//.test(file.type || '');
  state.isImage = isImage;

  if (isImage) {
    els.imgCanvas.style.display = 'block';
    els.pdfCanvas.style.display = 'none';
    const url = URL.createObjectURL(file);
    await renderImage(url);
    state.pageNum = 1; state.numPages = 1;
    updatePageIndicator();
    if(els.pageControls) els.pageControls.style.display = 'none';
    const tokens = await ensureTokensForPage(1);
    await buildKeywordIndexForPage(1, tokens);
    if(!(state.profile?.globals||[]).length) captureGlobalLandmarks();
    else await calibrateIfNeeded();
    drawOverlay();
    return;
  }

  // PDF branch — pdf.js must be present (set in <head>)
  els.imgCanvas.style.display = 'none';
  els.pdfCanvas.style.display = 'block';
  try {
    const pdfBuffer = await flattenAcroFormAppearances(arrayBuffer);
    await debugCompareFlattenOutputs(arrayBuffer, pdfBuffer);
    const loadingTask = pdfjsLibRef.getDocument({ data: pdfBuffer });
    state.pdf = await loadingTask.promise;

    state.pageNum = 1;
    state.numPages = state.pdf.numPages;
    await renderAllPages();
    state.viewport = state.pageViewports[0] || { w: 0, h: 0, scale: 1 };
    els.viewer.scrollTop = 0;
    updatePageIndicator();
    if(els.pageControls) els.pageControls.style.display = 'none';
    await ensureTokensForPage(1);
    if(!(state.profile?.globals||[]).length) captureGlobalLandmarks();
    else await calibrateIfNeeded();
    drawOverlay();
  } catch (err) {
    console.error('Failed to load PDF:', err);
    state.pdf = null;
    if(els.pageControls) els.pageControls.style.display = 'none';
    alert('Failed to load PDF. Please try another file.');
  }
}
function cleanupDoc(){
  state.tokensByPage = [];
  state.keywordIndexByPage = {};
  state.pageViewports = [];
  state.pageOffsets = [];
  state.pageRenderPromises = [];
  state.pageRenderReady = [];
  state.lineLayout = null;
  clearCropThumbs();
  state.selectionPx = null; state.snappedPx = null; state.snappedText = '';
  overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
}

function loadRunImageFromBuffer(arrayBuffer){
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 980 / img.naturalWidth);
      const width = img.naturalWidth * scale;
      const height = img.naturalHeight * scale;
      URL.revokeObjectURL(url);
      resolve({ width, height, scale });
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

async function prepareRunDocument(file){
  if(!(file instanceof Blob)){
    console.error('prepareRunDocument called with a non-Blob:', file);
    alert('Could not open file (unexpected type). Try selecting the file again.');
    return null;
  }
  cleanupDoc();
  state.grayCanvases = {};
  state.matchPoints = [];
  state.telemetry = [];
  state.areaMatchesByPage = {};
  state.areaOccurrencesById = {};
  state.areaExtractions = {};
  state.currentLineItems = [];
  state.currentAreaRows = [];
  state.lineLayout = null;
  state.pageSnapshots = {};
  state.pageNum = 1;
  state.numPages = 0;
  state.viewport = { w:0, h:0, scale:1 };
  const arrayBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  state.currentFileName = file.name || 'untitled';
  state.currentFileId = hashHex;
  fileMeta[state.currentFileId] = { fileName: state.currentFileName };
  rawStore.clear(state.currentFileId);
  state.lastSnapshotManifestId = '';
  state.snapshotDirty = state.snapshotMode;

  const isImage = /^image\//.test(file.type || '');
  state.isImage = isImage;
  if(isImage){
    try {
      const imgMeta = await loadRunImageFromBuffer(arrayBuffer);
      state.viewport = { w: imgMeta.width, h: imgMeta.height, scale: imgMeta.scale };
      state.pageViewports[0] = { width: imgMeta.width, height: imgMeta.height, w: imgMeta.width, h: imgMeta.height, scale: imgMeta.scale };
      state.pageOffsets[0] = 0;
      const blobUrl = URL.createObjectURL(new Blob([arrayBuffer]));
      await renderImage(blobUrl);
      state.pageNum = 1; state.numPages = 1;
      if(els.pageControls) els.pageControls.style.display = 'none';
      const tokens = await ensureTokensForPage(1, null, state.pageViewports[0], els.imgCanvas);
      await buildKeywordIndexForPage(1, tokens, state.pageViewports[0]);
      if(!(state.profile?.globals||[]).length) captureGlobalLandmarks();
      else await calibrateIfNeeded();
      return { type:'image' };
    } catch(err){
      console.error('Image load failed in run mode', err);
      alert('Could not load image for extraction.');
      return null;
    }
  }

  const pdfBuffer = await flattenAcroFormAppearances(arrayBuffer);
  const loadingTask = pdfjsLibRef.getDocument({ data: pdfBuffer });
  state.pdf = await loadingTask.promise;
  const scale = BASE_PDF_SCALE;
  let totalH = 0;
  for(let i=1; i<=state.pdf.numPages; i++){
    const page = await state.pdf.getPage(i);
    const vpRaw = page.getViewport({ scale });
    const vp = { ...vpRaw, w: vpRaw.width, h: vpRaw.height, pageNumber: i };
    state.pageViewports[i-1] = vp;
    state.pageOffsets[i-1] = totalH;
    const rawTokens = await readTokensForPage(page, vp);
    // pdf.js text items may be non-extensible in some browsers; clone before annotating
    const tokens = rawTokens.map(t => ({ ...t, page: i }));
    state.tokensByPage[i] = tokens;
    await buildKeywordIndexForPage(i, tokens, vp);
    if(isRunMode()) mirrorDebugLog(`[run-mode] tokens generated for page ${i}/${state.pdf.numPages}`);
    totalH += vp.height;
  }
  state.pageRenderReady = state.pageViewports.map(()=>true);
  state.pageRenderPromises = state.pageViewports.map(()=>Promise.resolve());
  state.numPages = state.pdf.numPages;
  state.viewport = state.pageViewports[0] || { w:0, h:0, scale };
  state.overlayPinned = false;
  return { type:'pdf' };
}

async function renderImage(url){
  state.overlayPinned = false;
  const img = els.imgCanvas;
  const loadPromise = new Promise((resolve, reject) => {
    img.onload = () => {
      const scale = Math.min(1, 980 / img.naturalWidth);
      img.width = img.naturalWidth * scale;
      img.height = img.naturalHeight * scale;
      syncOverlay();
      state.overlayPinned = isOverlayPinned();
      state.viewport = { w: img.width, h: img.height, scale };
      state.pageRenderReady[0] = true;
      refreshCropAuditThumbs();
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
  state.pageRenderPromises[0] = loadPromise;
  return loadPromise;
}
// ===== Render all PDF pages vertically =====
async function renderAllPages(){
  if(!state.pdf) return;
  state.overlayPinned = false;
  const scale = BASE_PDF_SCALE;
  const ctx = els.pdfCanvas.getContext('2d', { willReadFrequently: true });
  state.pageViewports = [];
  state.pageOffsets = [];

  let maxW = 0, totalH = 0;
  const pageCanvases = [];
  for(let i=1; i<=state.pdf.numPages; i++){
    const page = await state.pdf.getPage(i);
    const vpRaw = page.getViewport({ scale });
    const vp = { ...vpRaw, w: vpRaw.width, h: vpRaw.height };
    state.pageViewports[i-1] = vp;
    state.pageOffsets[i-1] = totalH;
    maxW = Math.max(maxW, vp.width);

    const tmp = document.createElement('canvas');
    tmp.width = vp.width; tmp.height = vp.height;
    const renderTask = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
    state.pageRenderPromises[i-1] = renderTask.promise;
    state.pageRenderReady[i-1] = false;
    await renderTask.promise;
    state.pageRenderReady[i-1] = true;
    pageCanvases.push({ canvas: tmp, page, vp });
    totalH += vp.height;
  }

  const cssScale = PDF_CSS_SCALE || 1;
  const cssW = maxW * cssScale;
  const cssH = totalH * cssScale;
  els.pdfCanvas.width = maxW;
  els.pdfCanvas.height = totalH;
  els.pdfCanvas.style.width = cssW + 'px';
  els.pdfCanvas.style.height = cssH + 'px';
  sizeOverlayTo(cssW, cssH);

  let y = 0;
  for(let i=0; i<pageCanvases.length; i++){
    const p = pageCanvases[i];
    ctx.drawImage(p.canvas, 0, y);
    const tokens = await ensureTokensForPage(i+1, p.page, p.vp, p.canvas);
    await buildKeywordIndexForPage(i+1, tokens, p.vp);
    y += p.canvas.height;
  }
  await refreshCropAuditThumbs();
  syncOverlay();
  state.overlayPinned = isOverlayPinned();
}

window.addEventListener('resize', () => {
  if(guardInteractive('overlay.resize')) return;
  state.overlayPinned = false;
  const base = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!base) return;
  const rect = base.getBoundingClientRect();
  sizeOverlayTo(rect.width, rect.height);
  drawOverlay();
});

async function readTokensForPage(pageObj, vp){
  const tokens = [];
  try {
    const content = await pageObj.getTextContent();
    if(DEBUG_FLATTEN_COMPARE){
      console.log(`[pdf-debug][flattened-run] textContent page ${pageObj.pageNumber} items=${content.items.length}`);
    }
    for(const item of content.items){
      const tx = pdfjsLibRef.Util.transform(vp.transform, item.transform);
      const x = tx[4], yTop = tx[5], w = item.width, h = item.height;
      const raw = item.str;
      const { text: corrected, corrections } = applyOcrCorrections(raw);
      tokens.push({ raw, corrected, text: corrected, correctionsApplied: corrections, confidence: 1, x, y: yTop - h, w, h, page: pageObj.pageNumber });
    }
  } catch(err){
    console.warn('PDF textContent failed', err);
  }
  return tokens;
}

async function readImageTokensForPage(pageNum, canvasEl=null){
  const canvas = canvasEl || getPdfBitmapCanvas(pageNum-1)?.canvas || els.imgCanvas;
  if(!canvas){ return []; }
  const opts = { tessedit_pageseg_mode: 6, oem: 1 };
  try{
    const { data } = await TesseractRef.recognize(canvas, 'eng', opts);
    const tokens = (data.words || []).map(w => {
      const raw = w.text.trim();
      if(!raw) return null;
      const { text: corrected, corrections } = applyOcrCorrections(raw);
      return {
        raw,
        corrected,
        text: corrected,
        correctionsApplied: corrections,
        confidence: (w.confidence || 0) / 100,
        x: w.bbox?.x || 0,
        y: w.bbox?.y || 0,
        w: w.bbox?.width || 0,
        h: w.bbox?.height || 0,
        page: pageNum
      };
    }).filter(Boolean);
    logStaticDebug(`full-page-ocr page=${pageNum}`, { tokens: tokens.length, meanConf: tokens.reduce((s,t)=>s+t.confidence,0)/(tokens.length||1) });
    return tokens;
  } catch(err){
    console.warn('Full-page OCR failed', err);
    logStaticDebug(`full-page-ocr-failed page=${pageNum}`, { error: err?.message || err });
    return [];
  }
}

/* ----------------------- Text Extraction ------------------------- */
async function ensureTokensForPage(pageNum, pageObj=null, vp=null, canvasEl=null){
  if(state.tokensByPage[pageNum]) return state.tokensByPage[pageNum];
  let tokens = [];
  if(state.isImage){
    if(state.pageRenderPromises[pageNum-1]){
      try {
        await state.pageRenderPromises[pageNum-1];
      } catch(err){
        console.warn('Image render promise failed', err);
      }
    }
    tokens = await readImageTokensForPage(pageNum, canvasEl);
    state.tokensByPage[pageNum] = tokens;
    return tokens;
  }

  if(!pageObj) pageObj = await state.pdf.getPage(pageNum);
  if(!vp) vp = state.pageViewports[pageNum-1];

  tokens = await readTokensForPage(pageObj, vp);
  tokens.forEach(t => { t.page = pageNum; });
  state.tokensByPage[pageNum] = tokens;
  return tokens;
}

function areaConfigsForPage(){
  if(!state.profile || !Array.isArray(state.profile.fields)) return [];
  return state.profile.fields.filter(f => f && (f.isArea || f.fieldType === 'areabox') && f.areaFingerprint);
}

function cacheAreaOccurrencesForPage(pageNum, matches = [], options = {}){
  const { skipClearIfEmpty = false } = options || {};
  if(!matches.length && skipClearIfEmpty) return;
  if(!state.areaOccurrencesById) state.areaOccurrencesById = {};
  Object.keys(state.areaOccurrencesById).forEach(key => {
    state.areaOccurrencesById[key] = (state.areaOccurrencesById[key] || []).filter(m => m.page !== pageNum);
  });
  matches.forEach(m => {
    const key = m.areaId || m.fieldKey;
    if(!key) return;
    if(!state.areaOccurrencesById[key]) state.areaOccurrencesById[key] = [];
    state.areaOccurrencesById[key].push(m);
  });
}

function buildSavedAreaOccurrence(areaField){
  const areaBox = areaField?.areaBox;
  if(!areaBox) return null;
  const norm = areaBox.bboxPct || (areaBox.normBox ? {
    x0: areaBox.normBox.x0n,
    y0: areaBox.normBox.y0n,
    x1: areaBox.normBox.x0n + areaBox.normBox.wN,
    y1: areaBox.normBox.y0n + areaBox.normBox.hN
  } : null);
  if(!norm) return null;
  const page = areaBox.page || areaField.page || areaField.areaFingerprint?.page || 1;
  return {
    areaId: areaField.areaId || areaField.id || areaField.fieldKey,
    page,
    bboxPct: { x0: norm.x0, y0: norm.y0, x1: norm.x1, y1: norm.y1 },
    bboxNorm: { x0: norm.x0, y0: norm.y0, x1: norm.x1, y1: norm.y1 },
    bboxPx: areaBox.rawBox ? { x: areaBox.rawBox.x, y: areaBox.rawBox.y, w: areaBox.rawBox.w, h: areaBox.rawBox.h, page } : null,
    confidence: 0.01,
    source: 'config'
  };
}

async function buildKeywordIndexForPage(pageNum, tokens=null, vpOverride=null, options={}){
  const { cache=true, forceAreaScan=false } = options || {};
  const cachedKeywords = cache ? state.keywordIndexByPage[pageNum] : null;
  const catalogue = getKeywordCatalogue();
  const activeLangs = ['en'];
  const keywordEntries = [];
  for(const [category, langs] of Object.entries(catalogue)){
    for(const lang of activeLangs){
      const list = langs?.[lang] || [];
      for(const keyword of list){
        const norm = normalizeKeywordText(keyword);
        if(norm){
          keywordEntries.push({ category, keyword, norm });
        }
      }
    }
  }

  tokens = tokens || state.tokensByPage[pageNum] || await ensureTokensForPage(pageNum, null, vpOverride);
  if(!Array.isArray(tokens)) tokens = [];

  const vp = vpOverride || (state.isImage ? state.viewport : state.pageViewports[pageNum-1]) || {};
  const pageW = Math.max(1, Number(vp.width || vp.w || (state.isImage ? els.imgCanvas?.width : els.pdfCanvas?.width) || 0));
  const pageH = Math.max(1, Number(vp.height || vp.h || (state.isImage ? els.imgCanvas?.height : els.pdfCanvas?.height) || 0));

  const lines = groupIntoLines(tokens);
  const matches = cachedKeywords ? cachedKeywords.slice() : [];

  if(!cachedKeywords){
    const alreadyRecorded = (bbox, entry) => {
      return matches.some(m => m.keyword === entry.keyword && m.category === entry.category && Math.abs(m.bboxPx.x - bbox.x) < 1 && Math.abs(m.bboxPx.y - bbox.y) < 1 && Math.abs(m.bboxPx.w - bbox.w) < 1 && Math.abs(m.bboxPx.h - bbox.h) < 1);
    };

    const pushMatch = (bboxPx, entry, fontHeight=0) => {
      if(!bboxPx || !Number.isFinite(bboxPx.x) || !Number.isFinite(bboxPx.y)) return;
      if(alreadyRecorded(bboxPx, entry)) return;
      const bboxNorm = normalizeBBoxForPage(bboxPx, pageW, pageH);
      matches.push({ page: pageNum, bboxPx, bboxNorm, keyword: entry.keyword, category: entry.category, fontHeight: fontHeight || bboxPx.h });
    };

    for(const token of tokens){
      const normText = normalizeKeywordText(token.text || token.raw || '');
      if(!normText) continue;
      for(const entry of keywordEntries){
        if(normText.includes(entry.norm)){
          pushMatch({ x: token.x, y: token.y, w: token.w, h: token.h, page: token.page }, entry, token.h);
        }
      }
    }

    for(const line of lines){
      const normalizedParts = line.tokens
        .map((t, idx) => ({ part: normalizeKeywordText(t.text || t.raw || ''), idx }))
        .filter(p => p.part);
      let lineNorm = '';
      const spans = [];
      for(let i=0;i<normalizedParts.length;i++){
        const { part, idx } = normalizedParts[i];
        if(lineNorm) lineNorm += ' ';
        const actualStart = lineNorm.length;
        lineNorm += part;
        spans.push({ start: actualStart, end: lineNorm.length, idx });
      }
      if(!lineNorm) continue;
      const lineBox = lineBounds(line);

      for(const entry of keywordEntries){
        let searchFrom = 0;
        while(true){
          const idx = lineNorm.indexOf(entry.norm, searchFrom);
          if(idx === -1) break;
          const endIdx = idx + entry.norm.length;
          const startTok = spans.find(s => s.end > idx);
          const endTok = [...spans].reverse().find(s => s.start < endIdx);
          const slice = (startTok && endTok)
            ? line.tokens.slice(startTok.idx, endTok.idx + 1)
            : [];
          const bbox = slice.length ? mergeTokenBounds(slice) : { x: lineBox.left, y: lineBox.top, w: lineBox.width, h: lineBox.height, page: line.page };
          pushMatch(bbox, entry, lineBox.height);
          searchFrom = endIdx;
        }
      }
    }

    if(cache){
      state.keywordIndexByPage[pageNum] = matches;
    }
    logStaticDebug(`keyword-index page=${pageNum}`, { tokens: tokens.length, matches: matches.length });
  } else {
    logStaticDebug(`keyword-index page=${pageNum} (cached)`, { tokens: tokens.length, matches: matches.length });
  }

  const areaFields = areaConfigsForPage();
  const existingAreaMatches = state.areaMatchesByPage?.[pageNum] || null;
  const wantsAreaScan = !!(areaFields.length && (forceAreaScan || !existingAreaMatches));
  const pushFallbackOccurrences = () => {
    const fallbacks = [];
    areaFields.forEach(field => {
      const occ = buildSavedAreaOccurrence(field);
      if(occ && (occ.page || 1) === pageNum){
        const confidence = Number.isFinite(occ.confidence) ? occ.confidence : 0.05;
        fallbacks.push({ ...occ, confidence, source: occ.source || 'config-fallback' });
      }
    });
    return fallbacks;
  };
  if(wantsAreaScan && AreaFinder){
    try {
      let areaMatches = AreaFinder.findAreaOccurrencesForPage(areaFields, tokens, { pageW, pageH, page: pageNum }) || [];
      if(!areaMatches.length){
        areaMatches = pushFallbackOccurrences();
      }
      state.areaMatchesByPage[pageNum] = areaMatches;
      cacheAreaOccurrencesForPage(pageNum, areaMatches, { skipClearIfEmpty: true });
    } catch(err){
      console.warn('AREAFINDER failed', err);
      const fallbacks = pushFallbackOccurrences();
      if(fallbacks.length){
        state.areaMatchesByPage[pageNum] = fallbacks;
        cacheAreaOccurrencesForPage(pageNum, fallbacks, { skipClearIfEmpty: true });
      }
    }
  } else if(wantsAreaScan && !AreaFinder){
    const fallbacks = pushFallbackOccurrences();
    if(fallbacks.length){
      state.areaMatchesByPage[pageNum] = fallbacks;
      cacheAreaOccurrencesForPage(pageNum, fallbacks, { skipClearIfEmpty: true });
    }
  } else if(existingAreaMatches){
    cacheAreaOccurrencesForPage(pageNum, existingAreaMatches, { skipClearIfEmpty: true });
  }
  return matches;
}

async function extractAreaRows(profile){
  const fields = profile?.fields || [];
  const groups = groupFieldsByArea(fields);
  seedAreaOccurrencesFromConfig(groups);
  const totalPages = Math.max(1, state.numPages || state.pageViewports?.length || state.pdf?.numPages || 1);
  for(let page=1; page<=totalPages; page++){
    await buildKeywordIndexForPage(page, null, null, { forceAreaScan: true });
  }

  const rows = [];
  for(const [areaId, entry] of groups.entries()){
    const subs = (entry.subs || []).filter(isExplicitSubordinate);
    const occurrences = (state.areaOccurrencesById?.[areaId] || []).slice();
    if(!subs.length || !occurrences.length) continue;
    for(let i=0; i<occurrences.length; i++){
      const occ = occurrences[i];
      const areaBoxPx = resolveAreaBoxPx(occ);
      if(!areaBoxPx) continue;
      const page = areaBoxPx.page || occ.page || 1;
      const vp = state.pageViewports[(page||1)-1] || state.viewport || { width:1, height:1, w:1, h:1 };
      const pageTokens = state.tokensByPage[page] || await ensureTokensForPage(page);
      const scopedTokens = tokensWithinArea(pageTokens, areaBoxPx);
      const pageW = (vp.width ?? vp.w) || 1;
      const pageH = (vp.height ?? vp.h) || 1;
      const normArea = normalizeBox(areaBoxPx, pageW, pageH);
      const bboxNorm = { x0: normArea.x0n, y0: normArea.y0n, x1: normArea.x0n + normArea.wN, y1: normArea.y0n + normArea.hN };
      const rowFields = {};
      for(const sub of subs){
        const scoped = clonePlain(sub);
        scoped.page = page;
        scoped.tokenScope = 'area';
        scoped.useSuppliedTokensOnly = true;
        scoped.areaBoxPx = areaBoxPx;
        scoped.areaRelativeBox = sub.areaRelativeBox || null;
        const absBox = sub.areaRelativeBox ? absoluteBoxFromRelative(sub.areaRelativeBox, areaBoxPx) : null;
        if(absBox){
          const nb = normalizeBox(absBox, pageW, pageH);
          scoped.bbox = [nb.x0n, nb.y0n, nb.x0n + nb.wN, nb.y0n + nb.hN];
          scoped.configBox = { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
        }
        const res = await extractFieldValue(scoped, scopedTokens, vp);
        const normBox = res.boxPx ? normalizeBox(res.boxPx, pageW, pageH) : null;
        rowFields[sub.fieldKey] = {
          value: res.value || '',
          raw: res.raw || '',
          confidence: res.confidence || 0,
          bbox: normBox ? { x0: normBox.x0n, y0: normBox.y0n, x1: normBox.x0n + normBox.wN, y1: normBox.y0n + normBox.hN } : null,
          page,
          tokens: res.tokens || []
        };
      }
      const constellationMatch = occ.constellationMatch || (occ.matchId ? { id: occ.matchId, score: occ.confidence ?? 0 } : null);
      const matchMetrics = {
        matchedEdges: occ.matchedEdges ?? occ.validation?.matchedEdges ?? null,
        totalEdges: occ.totalEdges ?? occ.validation?.totalEdges ?? null,
        matchedSupports: occ.matchedSupports ?? occ.validation?.matchedSupports ?? occ.validation?.supportMatches?.length ?? null,
        totalSupports: occ.totalSupports ?? occ.validation?.totalSupports ?? null,
        error: occ.error ?? occ.validation?.error ?? occ.validation?.errorSum ?? null
      };
      rows.push({
        areaId,
        occurrenceIndex: i,
        page,
        bboxPx: areaBoxPx,
        bboxNorm,
        confidence: occ.confidence || 0,
        constellationMatch,
        matchMetrics,
        fields: rowFields
      });
    }
  }
  persistAreaRows(rows);
  return rows;
}

function computeKeywordRelationsForConfig(fieldKey, boxPx, normBox, page, pageW, pageH){
  if(!KEYWORD_RELATION_SCOPE.has(fieldKey)) return null;
  if(!boxPx || !normBox || !pageW || !pageH) return null;
  const candidates = (state.keywordIndexByPage?.[page] || [])
    .filter(k => k && k.category === fieldKey);

  if(!candidates.length){
    logStaticDebug(`keyword-rel ${fieldKey}: no keyword candidates`, { page });
    return null;
  }

  const valCx = boxPx.x + (boxPx.w || 0) / 2;
  const valCy = boxPx.y + (boxPx.h || 0) / 2;
  const valHeight = Math.max(1, boxPx.h || 1);

  const scored = candidates.map(c => {
    const kBox = c.bboxPx || {};
    const kCx = (kBox.x || 0) + (kBox.w || 0) / 2;
    const kCy = (kBox.y || 0) + (kBox.h || 0) / 2;
    const yOverlap = Math.min((kBox.y || 0) + (kBox.h || 0), boxPx.y + boxPx.h) - Math.max((kBox.y || 0), boxPx.y);
    const xOverlap = Math.min((kBox.x || 0) + (kBox.w || 0), boxPx.x + boxPx.w) - Math.max((kBox.x || 0), boxPx.x);
    const isLeft = (kBox.x || 0) + (kBox.w || 0) <= boxPx.x && yOverlap > 0;
    const isAbove = (kBox.y || 0) + (kBox.h || 0) <= boxPx.y && xOverlap > 0;
    const positionScore = isLeft ? 3 : (isAbove ? 2 : 1);
    const dist = Math.hypot((kCx - valCx) / pageW, (kCy - valCy) / pageH);
    if(dist > 0.35) return { ...c, score: -Infinity };
    const distanceScore = Math.max(0, 1 - (dist / 0.3));
    const heightRatio = (kBox.h || 0) / valHeight;
    const fontPenalty = (heightRatio > 1.5 || heightRatio < 0.5) ? 0.5 : 0;
    const score = positionScore + distanceScore - fontPenalty;
    return { ...c, score };
  }).filter(c => Number.isFinite(c.score));

  if(!scored.length){
    logStaticDebug(`keyword-rel ${fieldKey}: no keyword candidates`, { page });
    return null;
  }

  scored.sort((a,b) => b.score - a.score);
  const valueNorm = { x: normBox.x0n, y: normBox.y0n, w: normBox.wN, h: normBox.hN };

  const mapEntry = (entry) => {
    const nb = entry.bboxNorm || normalizeBBoxForPage(entry.bboxPx, pageW, pageH) || {};
    const norm = { x: nb.x || 0, y: nb.y || 0, w: nb.w || 0, h: nb.h || 0 };
    return {
      text: entry.keyword,
      category: entry.category,
      normBox: norm,
      offset: {
        dx: valueNorm.x - norm.x,
        dy: valueNorm.y - norm.y,
        dw: valueNorm.w - norm.w,
        dh: valueNorm.h - norm.h
      },
      score: entry.score
    };
  };

  const mother = mapEntry(scored[0]);
  const secondaries = scored.slice(1, 4).map(mapEntry);

  logStaticDebug(
    `keyword-rel ${fieldKey}: candidates=${candidates.length} page=${page}`,
    {
      valueBox: valueNorm,
      mother: { text: mother.text, score: mother.score, normBox: mother.normBox, offset: mother.offset },
      secondaries: secondaries.map(s => ({ text: s.text, score: s.score, normBox: s.normBox, offset: s.offset })),
      page
    }
  );

  return { mother, secondaries, page };
}

function pageFromYPx(yPx){
  for(let i=state.pageOffsets.length-1; i>=0; i--){
    if(yPx >= state.pageOffsets[i]) return i+1;
  }
  return 1;
}

function getScaleFactors(){
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!src) return { scaleX:1, scaleY:1 };
  const rect = src.getBoundingClientRect();
  const scaleX = src.width / rect.width;
  const scaleY = src.height / rect.height;
  return { scaleX, scaleY };
}

function paintOverlay(ctx, options = {}){
  if(!ctx || !ctx.canvas) return;
  const { scaleX = 1, scaleY = 1, pageFilter = null, offsetY = 0, includeSelections = true, flags = getOverlayFlags(), boxSource = 'profile', layoutFirst = true, fileId = state.currentFileId } = options;
  const boxesOn = !!flags.boxes;
  const ringsOn = !!flags.rings;
  const matchesOn = !!flags.matches;
  const ocrOn = !!flags.ocr;
  const targetPage = pageFilter || state.pageNum;
  const offsetForPage = (page) => ((state.pageOffsets[(page||1)-1] || 0) / scaleY) - offsetY;

  ctx.clearRect(0,0,ctx.canvas.width, ctx.canvas.height);

  const drawLayout = ()=>{
    const layoutPage = state.lineLayout?.pages?.[targetPage];
    if(layoutPage && (!pageFilter || targetPage === pageFilter)){
      const offPx = offsetForPage(targetPage);
      const xPositionsPx = Array.from(new Set((layoutPage.columns||[]).flatMap(c=>[c.x0, c.x1]))).sort((a,b)=>a-b);
      const xPositions = xPositionsPx.map(x => x / scaleX);
      const spanLeft = xPositions[0] ?? 0;
      const spanRight = xPositions[xPositions.length-1] ?? (ctx.canvas.width / scaleX);
      const topSrc = layoutPage.top ?? Math.min(...layoutPage.rows.map(r=>r.y0));
      const bottomSrc = layoutPage.bottom ?? Math.max(...layoutPage.rows.map(r=>r.y1));
      const top = topSrc/scaleY + offPx;
      const bottom = bottomSrc/scaleY + offPx;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,0,255,0.6)';
      xPositions.forEach(x => {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      });
      ctx.strokeStyle = 'rgba(255,0,255,0.6)';
      layoutPage.rows.forEach(row => {
        const y = row.y0/scaleY + offPx;
        ctx.beginPath();
        ctx.moveTo(spanLeft, y);
        ctx.lineTo(spanRight, y);
        ctx.stroke();
      });
      const lastRow = layoutPage.rows[layoutPage.rows.length-1];
      if(lastRow){
        const yEnd = lastRow.y1/scaleY + offPx;
        ctx.beginPath();
        ctx.moveTo(spanLeft, yEnd);
        ctx.lineTo(spanRight, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  if(Array.isArray(state.debugLineAnchors) && state.debugLineAnchors.length){
    const anchorPage = pageFilter || state.pageNum;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,105,180,0.9)';
    ctx.lineWidth = 1;
    const crossX = 4 / scaleX;
    const crossY = 4 / scaleY;
    for(const marker of state.debugLineAnchors){
      if(marker.page !== anchorPage) continue;
      const offPx = offsetForPage(marker.page);
      const x = marker.anchorRight / scaleX;
      const y = (marker.anchorTop / scaleY) + offPx;
      ctx.beginPath();
      ctx.moveTo(x - crossX, y);
      ctx.lineTo(x + crossX, y);
      ctx.moveTo(x, y - crossY);
      ctx.lineTo(x, y + crossY);
      ctx.stroke();
    }
    ctx.restore();
  }

  const drawBoxes = ()=>{
    if(!boxesOn) return;
    const extractionBoxes = boxSource === 'extraction';
    const stroke = extractionBoxes ? '#2ee6a6' : 'rgba(255,0,0,0.6)';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    const entries = extractionBoxes ? (rawStore.get(fileId) || []) : (state.profile?.fields || []);
    for(const f of entries){
      let targetPage = f.page || f.pageNumber || 1;
      let nbRaw = f.normBox || f.nb || (f.bboxPct ? { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 } : null) || (f.bbox ? { x0n:f.bbox.x0, y0n:f.bbox.y0, wN:f.bbox.x1 - f.bbox.x0, hN:f.bbox.y1 - f.bbox.y0 } : null);
      if(!extractionBoxes && f.type === 'static'){
        const placement = resolveStaticPlacement(f, state.pageViewports, state.numPages);
        targetPage = placement?.pageNumber || targetPage;
        nbRaw = placement?.normBox || nbRaw;
      }
      if(pageFilter && targetPage !== pageFilter) continue;
      if(!nbRaw) continue;
      const nb = { x0n: nbRaw.x0n, y0n: nbRaw.y0n, wN: nbRaw.wN, hN: nbRaw.hN };
      if([nb.x0n, nb.y0n, nb.wN, nb.hN].some(v => typeof v !== 'number' || !Number.isFinite(v))) continue;
      const vp = state.pageViewports[targetPage-1];
      if(!vp) continue;
      const W = Math.round(vp.width ?? vp.w ?? 1);
      const H = Math.round(vp.height ?? vp.h ?? 1);
      const { sx, sy, sw, sh } = denormalizeBox(nb, W, H);
      const boxPx = applyTransform({ x:sx, y:sy, w:sw, h:sh, page:targetPage });
      const box = {
        x: boxPx.x / scaleX,
        y: boxPx.y / scaleY,
        w: boxPx.w / scaleX,
        h: boxPx.h / scaleY,
        page: boxPx.page
      };
      const off = offsetForPage(box.page);
      ctx.strokeRect(box.x, box.y + off, box.w, box.h);
    }
  };

  if(layoutFirst){ drawLayout(); drawBoxes(); }
  else { drawBoxes(); drawLayout(); }

  if(ringsOn && state.profile?.fields){
    ctx.strokeStyle = 'rgba(255,105,180,0.7)';
    for(const f of state.profile.fields){
      if(f.type !== 'static') continue;
      const placement = resolveStaticPlacement(f, state.pageViewports, state.numPages);
      const ringPage = placement?.pageNumber || f.page;
      if(pageFilter && ringPage !== pageFilter) continue;
      const nb = placement?.normBox || (f.bboxPct ? { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 } : null);
      if(!nb) continue;
      const vp = state.pageViewports[ringPage-1];
      if(!vp) continue;
      const W = Math.round(vp.width ?? vp.w ?? 1);
      const H = Math.round(vp.height ?? vp.h ?? 1);
      const { sx, sy, sw, sh } = denormalizeBox(nb, W, H);
      const boxPx = applyTransform({ x:sx, y:sy, w:sw, h:sh, page:ringPage });
      const box = {
        x: boxPx.x / scaleX,
        y: boxPx.y / scaleY,
        w: boxPx.w / scaleX,
        h: boxPx.h / scaleY,
        page: boxPx.page
      };
      const off = offsetForPage(box.page);
      const cx = box.x + box.w/2;
      const cy = box.y + off + box.h/2;
      const pad = 8 / Math.max(scaleX, scaleY);
      const r = Math.max(box.w, box.h)/2 + pad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.stroke();
    }
  }

  if(matchesOn && state.matchPoints.length){
    const matchPage = pageFilter || state.pageNum;
    ctx.fillStyle = 'yellow';
    for(const mp of state.matchPoints){
      if(mp.page !== matchPage) continue;
      const offPx = offsetForPage(mp.page);
      const x = mp.x / scaleX;
      const y = (mp.y / scaleY) + offPx;
      ctx.beginPath();
      const radius = 3 / Math.max(scaleX, scaleY);
      ctx.arc(x, y, radius, 0, Math.PI*2);
      ctx.fill();
    }
  }

  if(!includeSelections) return;
  if(state.selectionCss && (!pageFilter || state.selectionCss.page === pageFilter)){
    ctx.strokeStyle = '#2ee6a6'; ctx.lineWidth = 1.5;
    const b = state.selectionCss; const off = offsetForPage(b.page);
    ctx.strokeRect(b.x, b.y + off, b.w, b.h);
  }
  if(state.snappedCss && (!pageFilter || state.snappedCss.page === pageFilter)){
    ctx.strokeStyle = '#44ccff'; ctx.lineWidth = 2;
    const s = state.snappedCss; const off2 = offsetForPage(s.page);
    ctx.strokeRect(s.x, s.y + off2, s.w, s.h);
  }
  if(ocrOn && state.lastOcrCropCss && (!pageFilter || state.lastOcrCropCss.page === pageFilter)){
    ctx.strokeStyle = 'red'; ctx.lineWidth = 2;
    const c = state.lastOcrCropCss; const off3 = offsetForPage(c.page);
    ctx.strokeRect(c.x, c.y + off3, c.w, c.h);
  }
}

/* --------------------- Overlay / Drawing Box --------------------- */
let drawing = false, start = null, startCss = null, applyingPendingSelection = false;

els.overlayCanvas.addEventListener('pointerdown', e => {
  if(guardInteractive('overlay.pointerdown')) return;
  e.preventDefault();
  syncOverlay();
  const rect = els.overlayCanvas.getBoundingClientRect();
  const css = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  if(!state.overlayPinned){
    state.pendingSelection = { startCss: css, endCss: css, active: true };
    return;
  }
  const { scaleX, scaleY } = getScaleFactors();
  startCss = css;
  start = { x: css.x*scaleX, y: css.y*scaleY };
  drawing = true;
  els.overlayCanvas.setPointerCapture?.(e.pointerId);
}, { passive: false });

els.overlayCanvas.addEventListener('pointermove', e => {
  if(guardInteractive('overlay.pointermove')) return;
  if(state.pendingSelection && state.pendingSelection.active && !state.overlayPinned){
    const rect = els.overlayCanvas.getBoundingClientRect();
    state.pendingSelection.endCss = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return;
  }
  if (!drawing) return;
  e.preventDefault();
  const rect = els.overlayCanvas.getBoundingClientRect();
  const curCss = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const { scaleX, scaleY } = getScaleFactors();
  const curPx = { x: curCss.x*scaleX, y: curCss.y*scaleY };
  const page = pageFromYPx(start.y);
  const offPx = state.pageOffsets[page - 1] || 0;
  const offCss = offPx/scaleY;
  const boxCss = {
    x: Math.min(startCss.x, curCss.x),
    y: Math.min(startCss.y, curCss.y) - offCss,
    w: Math.abs(curCss.x - startCss.x),
    h: Math.abs(curCss.y - startCss.y),
    page
  };
  const boxPx = {
    x: Math.min(start.x, curPx.x),
    y: Math.min(start.y, curPx.y) - offPx,
    w: Math.abs(curPx.x - start.x),
    h: Math.abs(curPx.y - start.y),
    page
  };
  state.selectionCss = boxCss;
  state.selectionPx = boxPx;
  drawOverlay();
}, { passive: false });

async function finalizeSelection(e) {
  if(guardInteractive('overlay.pointerup')) return;
  if(state.pendingSelection && !state.overlayPinned){
    const rect = els.overlayCanvas.getBoundingClientRect();
    state.pendingSelection.endCss = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    state.pendingSelection.active = false;
    drawing = false;
    syncOverlay();
    return;
  }
  drawing = false;
  if (!state.selectionPx) return;
  state.pageNum = state.selectionPx.page;
  state.viewport = state.pageViewports[state.pageNum - 1];
  updatePageIndicator();
  const tokens = await ensureTokensForPage(state.pageNum);
  const step = state.steps[state.stepIdx] || {};
  let snap = null;
  if(isConfigMode() && (step.type||'static') === 'static'){
    const baseSnap = snapStaticToLines(tokens, state.selectionPx, { multiline: !!step.isMultiline });
    const siblings = buildStaticOverlapEntries(state.selectionPx.page, step.fieldKey, tokens);
    if(siblings.length){
      const resolved = resolveStaticOverlap([...siblings, { fieldKey: step.fieldKey, box: { ...baseSnap.box }, lines: baseSnap.lines || [], expectedLineCount: baseSnap.lineCount }]);
      const mine = resolved.find(e => e.fieldKey === step.fieldKey);
      if(mine){ snap = { ...baseSnap, box: mine.box, lines: mine.lines || baseSnap.lines }; }
    } else {
      snap = baseSnap;
    }
  }
  if(!snap){
    snap = snapToLine(tokens, state.selectionPx);
  }
  state.snappedPx = snap.box;
  state.snappedText = snap.text;
  const snapMetrics = snap.lineMetrics || { lineCount: snap.lineCount ?? 0, lineHeights: snap.lineHeights || { min:0, max:0, median:0 } };
  state.snappedLineMetrics = snapMetrics.lineCount ? snapMetrics : null;
  const { scaleX, scaleY } = getScaleFactors();
  state.snappedCss = {
    x: state.snappedPx.x/scaleX,
    y: state.snappedPx.y/scaleY,
    w: state.snappedPx.w/scaleX,
    h: state.snappedPx.h/scaleY,
    page: state.snappedPx.page
  };
  const spanKey = { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: state.pageNum-1, fieldKey: step.fieldKey || step.prompt || '' };
  const vp = state.pageViewports[state.pageNum - 1] || { width: state.viewport.w, height: state.viewport.h };
  const nb = normalizeBox(state.snappedPx, vp.width, vp.height);
  const pinned = isOverlayPinned();
  const srcRect = (state.isImage?els.imgCanvas:els.pdfCanvas).getBoundingClientRect();
  traceEvent(spanKey,'selection.captured',{
    normBox: nb,
    pixelBox: state.snappedPx,
    cssBox: state.snappedCss,
    cssSize:{ w:srcRect.width, h:srcRect.height },
    pxSize:{ w:vp.width, h:vp.height },
    dpr: window.devicePixelRatio || 1,
    overlayPinned: pinned,
    stageLabel:'Selection captured',
    stepNumber:0,
    bbox:{ pixel: state.snappedPx, normalized: nb, css: state.snappedCss },
    inputsSnapshot:{ selectionBox: state.snappedPx, normBox: nb }
  });
  drawOverlay();
}

els.overlayCanvas.addEventListener('pointerup', e=>finalizeSelection(e), { passive: false });
els.overlayCanvas.addEventListener('pointercancel', e=>finalizeSelection(e), { passive: false });

els.viewer.addEventListener('scroll', ()=>{
  if(guardInteractive('viewer.scroll')) return;
  syncOverlay();
  const y = els.viewer.scrollTop;
  let p = 1;
  for(let i=0; i<state.pageOffsets.length; i++){
    if(y >= state.pageOffsets[i]) p = i+1;
  }
  if(p !== state.pageNum){
    state.pageNum = p;
    if(state.pageViewports[p-1]) state.viewport = state.pageViewports[p-1];
    updatePageIndicator();
  }
});
function drawOverlay(){
  if(guardInteractive('overlay.draw')) return;
  syncOverlay();
  const { scaleX = 1, scaleY = 1 } = getScaleFactors();
  paintOverlay(overlayCtx, { scaleX, scaleY, flags: getOverlayFlags(), includeSelections: true });
}

function renderCropAuditPanel(){
  if(!els.ocrCropList) return;
  els.ocrCropList.innerHTML = '';
  state.cropAudits.forEach(a => {
    const row = document.createElement('div');
    row.className = 'ocrCropRow';
    if(a.thumbUrl){
      const img = document.createElement('img');
      img.src = a.thumbUrl;
      img.alt = a.question;
      row.appendChild(img);
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge';
      if(a.reason === 'invalid_box_input') badge.classList.add('warn');
      badge.textContent = a.reason || 'no_selection';
      row.appendChild(badge);
    }
    const info = document.createElement('div');
    const probe = a.ocrProbe || {};
    const t6 = probe.psm6?.tokensLength || 0;
    const c6 = probe.psm6?.meanConf || 0;
    const t7 = probe.psm7?.tokensLength || 0;
    const c7 = probe.psm7?.meanConf || 0;
    const summary = `6:${t6}/${c6.toFixed(2)} 7:${t7}/${c7.toFixed(2)}`;
    const raw = (a.best?.raw || '').slice(0,80).replace(/\s+/g,' ');
    const guard = a.reason ? ` ${a.reason}` : '';
    info.textContent = `${a.question}: ${summary} ${raw}${guard}`;
    row.appendChild(info);
    const m = a.meta || {};
    const nb = m.normBox || {};
    const cp = m.computedPx || {};
    const cs = m.canvasSize || {};
    const geom = document.createElement('div');
    geom.className = 'ocrGeom';
    const vars = {
      canvasW: cs.w,
      canvasH: cs.h,
      x0n: nb.x0n,
      y0n: nb.y0n,
      wN: nb.wN,
      hN: nb.hN,
      sx: cp.sx,
      sy: cp.sy,
      sw: cp.sw,
      sh: cp.sh,
      rotation: cp.rotation
    };
    const bad = Object.entries(vars).find(([_,v]) => typeof v !== 'number' || !Number.isFinite(v));
    if(bad){
      geom.textContent = `nan_or_infinity_in_math(${bad[0]})`;
    } else {
      geom.textContent = `c: ${cs.w}x${cs.h}  n:[${nb.x0n.toFixed(3)},${nb.y0n.toFixed(3)},${nb.wN.toFixed(3)},${nb.hN.toFixed(3)}]  p:${cp.sx},${cp.sy},${cp.sw},${cp.sh}  r:${cp.rotation}`;
    }
    row.appendChild(geom);
    const traceBtn = document.createElement('button');
    traceBtn.className = 'btn';
    traceBtn.textContent = 'Trace this field';
    traceBtn.addEventListener('click', ()=>traceFromAudit(a));
    row.appendChild(traceBtn);
    els.ocrCropList.appendChild(row);
  });
}

function clearCropThumbs(){
  (state.cropAudits||[]).forEach(a=>{
    if(a.thumbUrl) URL.revokeObjectURL(a.thumbUrl);
  });
  state.cropAudits = [];
  if(els.ocrCropList) els.ocrCropList.innerHTML = '';
}

async function refreshCropAuditThumbs(){
  const existing = state.cropAudits.slice();
  clearCropThumbs();
  for(const a of existing){
    const meta = a.meta || {};
    if(!meta.normBox){ state.cropAudits.push(a); continue; }
    const { cropBitmap, meta: m2 } = getOcrCropForSelection({ docId: meta.docId || '', pageIndex: meta.pageIndex, normBox: meta.normBox });
    m2.question = a.question;
    if(m2.errors.length){
      state.cropAudits.push({ question:a.question, reason:m2.errors[0], ocrProbe:{}, best:{}, thumbUrl:'', meta:m2 });
      continue;
    }
    let blob; try{ blob = await new Promise(res=>cropBitmap.toBlob(res,'image/png')); }catch(e){ blob=null; }
    if(!blob){
      m2.errors.push('blob_or_image_failed');
      state.cropAudits.push({ question:a.question, reason:'blob_or_image_failed', ocrProbe:{}, best:{}, thumbUrl:'', meta:m2 });
      continue;
    }
    const url = URL.createObjectURL(blob);
    state.cropAudits.push({ ...a, thumbUrl:url, meta:{...meta, ...m2} });
  }
  renderCropAuditPanel();
}

/* ---------------------- Snapshot helpers ------------------------ */
const SNAPSHOT_MODE_KEY = 'wiz.snapshotMode';

function describeOverlayFlags(flags){
  const parts = [];
  if(flags?.boxes) parts.push('boxes');
  if(flags?.rings) parts.push('rings');
  if(flags?.matches) parts.push('match points');
  if(flags?.ocr) parts.push('OCR boxes');
  return parts.length ? parts.join(', ') : 'no overlays';
}

function syncSnapshotUi(){
  if(els.snapshotModeToggle){ els.snapshotModeToggle.checked = !!state.snapshotMode; }
  if(els.snapshotStatus){
    const selected = state.selectedRunId ? (fileMeta[state.selectedRunId]?.fileName || state.selectedRunId.slice(0,8)) : 'no run selected';
    const modeText = state.snapshotMode ? 'Snapshot mode on' : 'Snapshot mode off';
    els.snapshotStatus.textContent = `${modeText} — ${selected}`;
  }
  if(els.viewSnapshotBtn){
    els.viewSnapshotBtn.disabled = !state.snapshotMode || !state.selectedRunId;
  }
}

function setSnapshotMode(enabled){
  state.snapshotMode = !!enabled;
  localStorage.setItem(SNAPSHOT_MODE_KEY, state.snapshotMode ? '1' : '0');
  state.snapshotDirty = true;
  syncSnapshotUi();
}

function initSnapshotMode(){
  state.snapshotMode = localStorage.getItem(SNAPSHOT_MODE_KEY) === '1';
  if(els.snapshotModeToggle){ els.snapshotModeToggle.checked = state.snapshotMode; }
  syncSnapshotUi();
}

function markSnapshotsDirty(){ state.snapshotDirty = true; }

function createThumbFromCanvas(canvas, maxW = SNAPSHOT_THUMB_MAX_W){
  if(!canvas || !canvas.width || !canvas.height) return '';
  const scale = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * scale));
  c.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function getSnapshotPageBitmap(pageIdx){
  const pageNumber = pageIdx + 1;
  const ready = state.pageRenderPromises[pageIdx];
  if(ready) await ready.catch(()=>{});
  const { canvas: src } = getPdfBitmapCanvas(pageIdx);
  const viewport = state.pageViewports[pageIdx] || state.viewport || {};
  const pageOffset = state.pageOffsets[pageIdx] || 0;
  if(src && src.width && src.height){
    const combined = src === els.pdfCanvas;
    return { canvas: src, viewport, pageOffset, combined };
  }

  if(state.pdf){
    try {
      const page = await state.pdf.getPage(pageNumber);
      const vp = state.pageViewports[pageIdx] || page.getViewport({ scale: BASE_PDF_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      return { canvas, viewport: vp, pageOffset, combined: false };
    } catch(err){
      console.warn('snapshot render failed', err);
    }
  }
  return { canvas:null, viewport:null, pageOffset:0, combined:false };
}

async function capturePageSnapshot(pageNumber, overlayFlags){
  const pageIdx = (pageNumber || 1) - 1;
  const render = await getSnapshotPageBitmap(pageIdx);
  const { canvas: src, viewport: vp, pageOffset, combined } = render;
  if(!src || !vp) return null;
  const baseW = Math.max(1, Math.round((vp.width ?? vp.w) || src.width));
  const baseH = Math.max(1, Math.round((vp.height ?? vp.h) || src.height));
  let renderW = baseW;
  let renderH = baseH;
  const pixels = renderW * renderH;
  if(pixels > SNAPSHOT_PIXEL_CAP){
    const scale = Math.sqrt(SNAPSHOT_PIXEL_CAP / pixels);
    renderW = Math.max(1, Math.round(renderW * scale));
    renderH = Math.max(1, Math.round(renderH * scale));
  }
  const out = document.createElement('canvas');
  out.width = renderW; out.height = renderH;
  const ctx = out.getContext('2d');
  const srcY = combined ? pageOffset : 0;
  ctx.drawImage(src, 0, srcY, baseW, baseH, 0, 0, renderW, renderH);

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = baseW; overlayCanvas.height = baseH;
  paintOverlay(overlayCanvas.getContext('2d'), { scaleX:1, scaleY:1, pageFilter: pageNumber, offsetY: pageOffset, includeSelections:false, flags: overlayFlags, boxSource: 'extraction', layoutFirst: false, fileId: state.currentFileId });
  ctx.drawImage(overlayCanvas, 0, 0, renderW, renderH);

  const dataUrl = out.toDataURL('image/png');
  const thumbUrl = createThumbFromCanvas(out, SNAPSHOT_THUMB_MAX_W);
  return { dataUrl, thumbUrl, width: renderW, height: renderH, pageOffset, renderKey:{ width: baseW, height: baseH, pageOffset } };
}

async function buildSnapshotManifest(fileId, overlayFlags){
  if(!fileId || !state.snapshotMode) return null;
  const flags = overlayFlags || getOverlayFlags();
  const manifest = { id: `${fileId}:snap`, fileId, createdAtISO: new Date().toISOString(), overlays: flags, pages: [] };
  snapshotStore.set(fileId, manifest);
  const totalPages = Math.max(1, Math.min(state.numPages || state.pageViewports.length || 1, SNAPSHOT_MAX_PAGES));
  state.snapshotPanels.activePage = null;
  for(let i=1; i<=totalPages; i++){
    const snap = await capturePageSnapshot(i, flags);
    if(!snap) continue;
    snapshotStore.upsertPage(fileId, { pageNumber: i, dataUrl: snap.dataUrl, thumbUrl: snap.thumbUrl, width: snap.width, height: snap.height, renderKey: snap.renderKey, pageOffset: snap.pageOffset });
  }
  state.lastSnapshotManifestId = manifest.id;
  state.snapshotDirty = false;
  return snapshotStore.get(fileId) || manifest;
}

function manifestNeedsRefresh(manifest, flags){
  if(!manifest) return true;
  if(!overlayFlagsEqual(manifest.overlays || {}, flags || {})) return true;
  return !!state.snapshotDirty;
}

async function ensureSnapshotManifest(fileId, overlayFlags, opts = {}){
  const flags = overlayFlags || getOverlayFlags();
  let manifest = snapshotStore.get(fileId);
  const mustRefresh = opts.force || manifestNeedsRefresh(manifest, flags);
  if(mustRefresh && state.snapshotMode && state.currentFileId === fileId){
    manifest = await buildSnapshotManifest(fileId, flags);
  }
  return manifest;
}

async function renderSnapshotDetail(manifest, pageNumber){
  if(!els.snapshotDetail) return;
  const page = (manifest?.pages || []).find(p => p.pageNumber === pageNumber);
  if(!page){
    els.snapshotDetail.innerHTML = '<p class="snapshot-empty">No snapshot for this page.</p>';
    renderSnapshotAreaDebug(manifest, pageNumber);
    return;
  }
  let dataUrl = page.dataUrl;
  if(!dataUrl && state.snapshotMode && state.currentFileId === manifest.fileId){
    const regen = await capturePageSnapshot(page.pageNumber, manifest.overlays || getOverlayFlags());
    if(regen){
      snapshotStore.upsertPage(manifest.fileId, { pageNumber: page.pageNumber, dataUrl: regen.dataUrl, thumbUrl: page.thumbUrl || regen.thumbUrl, width: regen.width, height: regen.height, renderKey: regen.renderKey, pageOffset: regen.pageOffset });
      dataUrl = regen.dataUrl;
    }
  }
  if(!dataUrl){
    els.snapshotDetail.innerHTML = '<p class="snapshot-empty">Snapshot unavailable for this page.</p>';
    renderSnapshotAreaDebug(manifest, pageNumber);
    return;
  }
  els.snapshotDetail.innerHTML = `<img src="${dataUrl}" alt="Snapshot page ${page.pageNumber}" />`;
  renderSnapshotAreaDebug(manifest, page.pageNumber);
}

function renderSnapshotPanel(manifest){
  if(!els.snapshotPanel || !manifest){
    if(els.snapshotPanel) els.snapshotPanel.style.display = 'none';
    if(els.snapshotAreaDebug) els.snapshotAreaDebug.innerHTML = '';
    return;
  }
  els.snapshotPanel.style.display = 'block';
  els.snapshotPanel.dataset.open = '1';
  const pages = manifest.pages || [];
  if(els.snapshotMeta){
    els.snapshotMeta.textContent = `${pages.length} page(s) • ${describeOverlayFlags(manifest.overlays || {})}`;
  }
  if(!pages.length){
    if(els.snapshotList) els.snapshotList.innerHTML = '<p class="snapshot-empty">No snapshots captured.</p>';
    if(els.snapshotDetail) els.snapshotDetail.innerHTML = '';
    renderSnapshotAreaDebug(manifest, null);
    return;
  }
  if(!state.snapshotPanels.activePage || !pages.some(p => p.pageNumber === state.snapshotPanels.activePage)){
    state.snapshotPanels.activePage = pages[0].pageNumber;
  }
  if(els.snapshotList){
    els.snapshotList.innerHTML = '';
    pages.forEach(p => {
      const card = document.createElement('div');
      card.className = 'snapshot-card' + (p.pageNumber === state.snapshotPanels.activePage ? ' active' : '');
      const img = document.createElement('img');
      img.src = p.thumbUrl || p.dataUrl || '';
      img.alt = `Page ${p.pageNumber}`;
      card.appendChild(img);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `Page ${p.pageNumber}${p.tooLarge ? ' (on-demand)' : ''}`;
      card.appendChild(meta);
      card.addEventListener('click', ()=>{
        state.snapshotPanels.activePage = p.pageNumber;
        renderSnapshotPanel(manifest);
      });
      els.snapshotList.appendChild(card);
    });
  }
  renderSnapshotDetail(manifest, state.snapshotPanels.activePage);
}

async function openSnapshotPanel(force=false){
  if(!state.snapshotMode){
    alert('Enable snapshot mode to capture page images.');
    return;
  }
  if(!state.selectedRunId){
    alert('Select a run from the extracted data table.');
    return;
  }
  const flags = getOverlayFlags();
  let manifest = await ensureSnapshotManifest(state.selectedRunId, flags, { force });
  if(!manifest){
    alert('No snapshots available for this run. Drop the file again with snapshot mode enabled.');
    return;
  }
  renderSnapshotPanel(manifest);
}

function closeSnapshotPanel(){
  if(els.snapshotPanel){
    els.snapshotPanel.style.display = 'none';
    els.snapshotPanel.dataset.open = '0';
  }
  if(els.snapshotAreaDebug){
    els.snapshotAreaDebug.innerHTML = '';
  }
}

function traceFromAudit(a){
  const meta = a.meta || {};
  const docId = meta.docId || (state.currentFileName || 'doc').replace(/[^a-z0-9_-]/gi,'_');
  const pageIndex = meta.pageIndex || 0;
  const traceId = debugTraces.start({ docId, pageIndex, fieldKey: a.question });
  state.currentTraceId = traceId;
  debugTraces.add(traceId,'selection.captured',{ input:{ normBox: meta.normBox }, output:{ pixelBox: meta.computedPx, cssBox: meta.cssBox, overlayPinned: meta.overlayPinned, renderSize: meta.canvasSize, dpr: meta.canvasSize?.dpr }, warnings:[], errors:[] });
  const srcObj = getPdfBitmapCanvas(pageIndex) || {};
  let renderUrl='';
  if(srcObj.canvas){
    const src = srcObj.canvas;
    const c=document.createElement('canvas');
    const maxW=120; const scale = maxW/src.width;
    c.width=maxW; c.height=Math.round(src.height*scale);
    c.getContext('2d').drawImage(src,0,0,c.width,c.height);
    renderUrl=c.toDataURL('image/png');
  }
  const rErrors = (meta.errors||[]).includes('render_not_ready')? ['source_unavailable']:[];
  debugTraces.add(traceId,'render.ready',{ output:{ canvas: meta.canvasSize }, warnings:[], errors:rErrors, artifact:renderUrl });
  debugTraces.add(traceId,'crop.computed',{ input:{ normBox: meta.normBox }, output:{ rect: meta.computedPx, clamped: meta.clamped }, warnings: meta.warnings||[], errors: meta.errors||[] });
  if(a.thumbUrl){
    debugTraces.add(traceId,'crop.emitted',{ output:{ w: meta.computedPx?.sw, h: meta.computedPx?.sh }, warnings:[], errors:[], artifact:a.thumbUrl });
  }
  debugTraces.add(traceId,'ocr.started',{ input:{ engine:'tesseract', params:{ psm: meta.best?.psm } }, output:{}, warnings:[], errors:[] });
  const ocrWarnings = [];
  if((meta.best?.tokensLength||0)===0) ocrWarnings.push('no_tokens');
  debugTraces.add(traceId,'ocr.completed',{ output:{ charCount:(meta.best?.raw||'').length, tokenCount:meta.best?.tokensLength||0, meanConf:meta.best?.meanConf||0, sample:(meta.best?.raw||'').slice(0,120) }, warnings:ocrWarnings, errors:[] });
  const cleaned = (meta.best?.raw||'').trim();
  debugTraces.add(traceId,'cleaner.completed',{ input:{ raw:meta.best?.raw }, output:{ normalizedValue:cleaned, transforms:[] }, warnings:[], errors:[] });
  debugTraces.add(traceId,'validation.completed',{ input:{ value:cleaned }, output:{ status: meta.status || 'ok', confidence: meta.best?.meanConf || 0 }, warnings:[], errors:[] });
  debugTraces.add(traceId,'persist.upserted',{ input:{}, output:{ location:'memory', key:a.question, version:1 }, warnings:[], errors:[] });
  debugTraces.add(traceId,'ui.bound',{ input:{ value:cleaned }, output:{ component:'traceViewer', displayTextLength:cleaned.length, trunc:false }, warnings:[], errors:[] });
  displayTrace(traceId);
}

function displayTrace(traceId){
  const trace = debugTraces.get(traceId);
  if(!trace) return;
  els.traceViewer.style.display='block';
  els.traceHeader.textContent = trace.spanKey.fieldKey;
  const nb = trace.events.find(e=>e.stage==='selection.captured')?.input?.normBox || {};
  const selOut = trace.events.find(e=>e.stage==='selection.captured')?.output || {};
  const cs = trace.events.find(e=>e.stage==='render.ready')?.output?.canvas || {};
  const cp = trace.events.find(e=>e.stage==='crop.computed')?.output?.rect || {};
  const ocr = trace.events.find(e=>e.stage==='ocr.completed')?.output || {};
  const val = trace.events.find(e=>e.stage==='validation.completed')?.output || {};
  const ui = trace.events.find(e=>e.stage==='ui.bound')?.output || {};
  els.traceSummary.textContent = `sel:[${sn(nb.x0n)},${sn(nb.y0n)},${sn(nb.wN)},${sn(nb.hN)}] src:${sn(cs.w)}×${sn(cs.h)} crop:${sn(cp.sx)},${sn(cp.sy)},${sn(cp.sw)},${sn(cp.sh)} ocr:${sn(ocr.charCount)}/${sn(ocr.meanConf)} val:${val.status||'?'}/${sn(val.confidence)} pin:${selOut.overlayPinned?'1':'0'} ui:${ui.component?'bound':'unbound'}`;
  els.traceWaterfall.innerHTML='';
  let prev = trace.events[0]?.ts;
  trace.events.forEach(ev=>{
    const div=document.createElement('div');
    div.className='traceStage';
    const delta = prev ? ev.ts - prev : 0;
    div.textContent = `${ev.stage} (+${delta}ms)`;
    div.addEventListener('click',()=>{
      if(ev.artifact){
        els.traceDetail.innerHTML = `<img src="${ev.artifact}" alt="artifact" style="max-width:120px;max-height:120px;"/><pre class="code">${JSON.stringify(ev,null,2)}</pre>`;
      } else {
        els.traceDetail.textContent = JSON.stringify(ev,null,2);
      }
    });
    els.traceWaterfall.appendChild(div);
    prev = ev.ts;
  });
  if(els.traceExportBtn){ els.traceExportBtn.onclick = ()=>exportTraceFile(traceId); }
}

/* ---------------------- Results “DB” table ----------------------- */
function resolveMasterDbConfigForRecord(profile, template, recordFields){
  const activeProfile = profile || {};
  const masterConfig = buildMasterDbConfigFromProfile(activeProfile, activeProfile?.masterDbConfig, template);
  const derivedStaticFields = deriveMasterDbSchema(activeProfile.fields || []);
  const areaKeys = getAreaFieldKeys(activeProfile.fields);
  const recordFieldKeys = new Set(
    Object.keys(recordFields || {}).filter(key => !areaKeys.has(key))
  );
  const alignedDerivedStatics = derivedStaticFields.filter(f => recordFieldKeys.has(f.fieldKey));
  let staticFields = (masterConfig.staticFields || []).filter(f => recordFieldKeys.has(f.fieldKey));
  const missingStaticKeys = alignedDerivedStatics
    .filter(f => !staticFields.some(sf => sf.fieldKey === f.fieldKey))
    .map(f => f.fieldKey);
  if(!staticFields.length || missingStaticKeys.length){
    console.warn('[masterdb] masterDbConfig static fields missing or misaligned; rebuilding from profile schema', { missingStaticKeys });
    staticFields = alignedDerivedStatics;
  }
  if(!staticFields.length && recordFieldKeys.size){
    staticFields = Array.from(recordFieldKeys).map(key => ({ fieldKey: key, label: key }));
  }
  const areaFieldKeys = Array.from(new Set([
    ...(Array.isArray(masterConfig.areaFieldKeys) ? masterConfig.areaFieldKeys : []),
    ...staticFields.filter(f => f.isArea || f.isSubordinate).map(f => f.fieldKey)
  ])).filter(key => recordFieldKeys.has(key));
  const documentFieldKeys = (Array.isArray(masterConfig.documentFieldKeys) && masterConfig.documentFieldKeys.length)
    ? masterConfig.documentFieldKeys.filter(k => recordFieldKeys.has(k) && !areaFieldKeys.includes(k))
    : staticFields.filter(f => !areaFieldKeys.includes(f.fieldKey)).map(f => f.fieldKey);
  const normalizedConfig = {
    ...masterConfig,
    staticFields,
    areaFieldKeys,
    documentFieldKeys
  };
  if(activeProfile && typeof activeProfile === 'object'){
    activeProfile.masterDbConfig = normalizedConfig;
  }
  return normalizedConfig;
}

function compileDocument(fileId, lineItems){
  const raw = rawStore.get(fileId);
  const byKey = {};
  const wizardId = currentWizardId();
  const activeTemplate = wizardId === DEFAULT_WIZARD_ID ? null : normalizeTemplate(getWizardTemplateById(wizardId));
  const areaFieldKeys = getAreaFieldKeys();
  if(!state.snapshotMode){ state.lastSnapshotManifestId = ''; }
  state.selectedRunId = fileId || state.selectedRunId;
  raw.forEach(r=>{
    if(areaFieldKeys.has(r.fieldKey)) return;
    byKey[r.fieldKey] = { value: r.value, raw: r.raw, correctionsApplied: r.correctionsApplied || [], confidence: r.confidence || 0, tokens: r.tokens || [] };
  });
  getExtractableFields().forEach(f=>{
    if(!byKey[f.fieldKey]) byKey[f.fieldKey] = { value:'', raw:'', confidence:0, tokens:[] };
  });
  const cleanScalar = val => {
    if(val === undefined || val === null) return '';
    if(typeof val === 'string') return val.replace(/\s+/g,' ').trim();
    return String(val);
  };
  const sub = parseFloat(byKey['subtotal_amount']?.value);
  const tax = parseFloat(byKey['tax_amount']?.value);
  const tot = parseFloat(byKey['invoice_total']?.value);
  if(isFinite(sub) && isFinite(tax) && isFinite(tot)){
    const diff = Math.abs(sub + tax - tot);
    const adj = diff < 1 ? 0.05 : -0.2;
    ['subtotal_amount','tax_amount','invoice_total'].forEach(k=>{
      if(byKey[k]) byKey[k].confidence = clamp((byKey[k].confidence||0)+adj,0,1);
    });
  }
  const invoiceNumber = cleanScalar(byKey['invoice_number']?.value);
  const db = LS.getDb(state.username, state.docType, wizardId);
  const findExistingIndex = () => db.findIndex(r => r.fileId === fileId || (invoiceNumber && cleanScalar(r.invoice?.number) === invoiceNumber));
  const hasExplicitLineItems = arguments.length >= 2;
  let items = Array.isArray(lineItems) ? lineItems : [];
  if((!hasExplicitLineItems || !items.length) && state.currentFileId === fileId && Array.isArray(state.currentLineItems) && state.currentLineItems.length){
    items = state.currentLineItems;
  }
  let existingIdx = findExistingIndex();
  if((!items || !items.length) && existingIdx >= 0){
    const prevItems = db[existingIdx]?.lineItems;
    if(Array.isArray(prevItems) && prevItems.length){
      items = prevItems;
    }
  }
  if(!Array.isArray(items)) items = [];
  const enriched = items.map((it,i)=>{
    let amount = it.amount;
    if(!amount && it.quantity && it.unit_price){
      const q=parseFloat(it.quantity); const u=parseFloat(it.unit_price);
      if(!isNaN(q) && !isNaN(u)) amount=(q*u).toFixed(2);
    }
    return { line_no:i+1, ...it, amount };
  });
  let lineSum=0; let allHave=true;
  enriched.forEach(it=>{ if(it.amount){ lineSum+=parseFloat(it.amount); } else allHave=false; });
  const compiled = {
    fileId,
    fileHash: fileId,
    fileName: fileMeta[fileId]?.fileName || 'unnamed',
    processedAtISO: new Date().toISOString(),
    fields: byKey,
    invoice: {
      number: invoiceNumber,
      salesDateISO: cleanScalar(byKey['invoice_date']?.value),
      salesperson: cleanScalar(byKey['salesperson_rep']?.value),
      store: cleanScalar(byKey['store_name']?.value)
    },
    totals: {
      subtotal: byKey['subtotal_amount']?.value || '',
      tax: byKey['tax_amount']?.value || '',
      total: byKey['invoice_total']?.value || '',
      discount: byKey['discounts_amount']?.value || ''
    },
    masterDbConfig: resolveMasterDbConfigForRecord(state.profile, activeTemplate, byKey),
    lineItems: enriched,
    areaOccurrences: buildAreaOccurrencesPayload(),
    areaRows: (state.currentAreaRows || []).map(r => clonePlain(r)),
    templateKey: `${state.username}:${state.docType}:${wizardId}`,
    warnings: []
  };
  if(allHave && isFinite(sub) && Math.abs(lineSum - sub) > 0.02){
    compiled.warnings.push('line_totals_vs_subtotal');
    if(byKey['subtotal_amount']){
      byKey['subtotal_amount'].confidence = clamp((byKey['subtotal_amount'].confidence||0)*0.8,0,1);
    }
  }
  existingIdx = findExistingIndex();
  const invNum = compiled.invoice.number;
  const idx = existingIdx >= 0 ? existingIdx : db.findIndex(r => r.fileId === compiled.fileId || (invNum && cleanScalar(r.invoice?.number) === invNum));
  if(idx>=0) db[idx] = compiled; else db.push(compiled);
  if(state.lastSnapshotManifestId){
    compiled.snapshotManifestId = state.lastSnapshotManifestId;
  }
  if(state.mode === ModeEnum.RUN){
    const staticFieldShape = Object.fromEntries(Object.entries(compiled.fields || {}).map(([k,v])=>[k,{
      value: v?.value ?? '',
      raw: v?.raw ?? '',
      confidence: v?.confidence ?? 0,
      correctionsApplied: v?.correctionsApplied || []
    }]));
    console.info('[run-mode][diag] masterdb write payload', {
      fileId: compiled.fileId,
      fieldKeys: Object.keys(compiled.fields || {}),
      fields: staticFieldShape,
      totals: compiled.totals,
      invoice: compiled.invoice,
      lineItems: compiled.lineItems?.length || 0
    });
    console.info('[run-mode][diag] masterdb schema snapshot', {
      fileId: compiled.fileId,
      topLevelKeys: Object.keys(compiled || {}),
      totalsKeys: Object.keys(compiled.totals || {}),
      invoiceKeys: Object.keys(compiled.invoice || {}),
      areaRowCount: compiled.areaRows?.length || 0,
      templateKey: compiled.templateKey || null,
      warnings: compiled.warnings || []
    });
    if(!compiled.fields || typeof compiled.fields !== 'object'){
      console.warn('[run-mode][diag] masterdb schema mismatch: fields payload missing or invalid', { fileId: compiled.fileId });
    }
    console.info('[run-mode][diag] masterdb fields (pre-write)', {
      fileId: compiled.fileId,
      fields: normalizePayloadForLog(compiled.fields || {})
    });
  }
  LS.setDb(state.username, state.docType, db, wizardId);
  refreshMasterDbRowsStore(db, compiled);
  renderResultsTable();
  renderTelemetry();
  renderReports();
  return compiled;
}

function normalizeAreaFieldBag(fields){
  const map = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    if(!key) return;
    if(value && typeof value === 'object'){
      const val = value.value ?? value.raw ?? value.text ?? '';
      const confidence = typeof value.confidence === 'number' ? value.confidence : (typeof value.confidenceScore === 'number' ? value.confidenceScore : null);
      map[key] = { value: val, confidence };
    } else {
      map[key] = { value, confidence: null };
    }
  });
  return map;
}

function normalizeAreaOccurrencesForRecord(record){
  const rows = Array.isArray(record?.areaRows) ? record.areaRows.filter(Boolean) : [];
  const occurrences = Array.isArray(record?.areaOccurrences) ? record.areaOccurrences.filter(Boolean) : [];
  const source = occurrences.length ? occurrences : rows;
  const groups = new Map();
  const pushOccurrence = (areaId, areaName, fields, idx=null) => {
    if(!areaId) areaId = areaName || 'Area';
    if(!groups.has(areaId)) groups.set(areaId, { areaId, areaName, occurrences: [] });
    const group = groups.get(areaId);
    if(!group.areaName) group.areaName = areaName || areaId;
    const index = Number.isFinite(idx) ? idx : group.occurrences.length + 1;
    group.occurrences.push({ index, fields: fields || {} });
  };
  source.forEach(row => {
    const areaId = row?.areaId || row?.areaName || row?.name || 'Area';
    const areaName = resolveAreaLabel(areaId, row?.areaName || row?.name || null);
    const nestedRows = Array.isArray(row?.rows) ? row.rows.filter(Boolean) : [];
    if(nestedRows.length){
      nestedRows.forEach((nested, idx) => {
        const fields = normalizeAreaFieldBag(nested?.fields || nested?.values || nested?.cells || nested?.subFields || nested?.subordinates);
        pushOccurrence(areaId, areaName, fields, idx + 1);
      });
    } else {
      const fields = normalizeAreaFieldBag(row?.fields || row?.values || row?.cells || row?.subFields || row?.subordinates);
      pushOccurrence(areaId, areaName, fields);
    }
  });
  return Array.from(groups.values());
}

function resolveAreaLabel(areaId, fallback){
  const areaField = (state.profile?.fields || []).find(f => (f.isArea || f.fieldType === 'areabox') && (f.areaId === areaId || f.fieldKey === areaId));
  return areaField?.label || areaField?.name || fallback || areaId || 'Area';
}

function resolveAreaColumns(areaId, occurrences, labelMap){
  const subs = (state.profile?.fields || []).filter(f => f.areaId === areaId && !(f.isArea || f.fieldType === 'areabox'));
  const orderedKeys = subs.map(f => f.fieldKey).filter(Boolean);
  const seen = new Set(orderedKeys);
  occurrences.forEach(occ => {
    Object.keys(occ.fields || {}).forEach(key => {
      if(!key || seen.has(key)) return;
      seen.add(key);
      orderedKeys.push(key);
    });
  });
  return orderedKeys.map(key => ({ key, label: labelMap[key] || key }));
}

function renderAreaOccurrencesPanel(record, labelMap){
  const panel = document.getElementById('areaOccurrencesPanel');
  if(!panel) return;
  if(!record){
    panel.innerHTML = '<p class="sub">Select a run to view area occurrences.</p>';
    return;
  }
  const groups = normalizeAreaOccurrencesForRecord(record);
  if(!groups.length){
    panel.innerHTML = '<p class="sub">No area occurrences for this run.</p>';
    return;
  }
  const cards = groups.map(group => {
    const columns = resolveAreaColumns(group.areaId, group.occurrences, labelMap);
    const header = `<tr><th>Occurrence</th>${columns.map(col => `<th>${col.label}</th>`).join('')}</tr>`;
    const rows = group.occurrences.map(occ => {
      const cells = columns.map(col => {
        const cell = occ.fields?.[col.key] || { value:'', confidence:null };
        const warn = typeof cell.confidence === 'number' && cell.confidence < 0.8 ? '<span class="warn">⚠️</span>' : '';
        const conf = typeof cell.confidence === 'number' ? `<span class="confidence">${Math.round(cell.confidence * 100)}%</span>` : '';
        return `<td>${cell.value ?? ''}${warn}${conf}</td>`;
      }).join('');
      return `<tr><td class="occ-label">#${occ.index}</td>${cells}</tr>`;
    }).join('');
    return `
      <div class="area-card" data-area="${group.areaId}">
        <div class="area-card__header">
          <div>
            <div class="area-name">${group.areaName || group.areaId || 'Area'}</div>
            <div class="area-meta">${group.occurrences.length} occurrence${group.occurrences.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div class="area-card__body">
          <table class="line-items-table area-table">
            <thead>${header}</thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
  panel.innerHTML = cards;
}

function formatAreaBoxForDisplay(boxPx, boxNorm, page){
  if(boxPx && [boxPx.x, boxPx.y, boxPx.w, boxPx.h].every(v => Number.isFinite(v))){
    const pg = boxPx.page || page || '?';
    return `${Math.round(boxPx.x)},${Math.round(boxPx.y)} • ${Math.round(boxPx.w)}×${Math.round(boxPx.h)} (p${pg}, px)`;
  }
  const norm = boxNorm || {};
  if([norm.x0, norm.y0, norm.x1, norm.y1].every(v => typeof v === 'number' && Number.isFinite(v))){
    const pg = norm.page || page || '?';
    const w = (norm.x1 - norm.x0) * 100;
    const h = (norm.y1 - norm.y0) * 100;
    return `${(norm.x0 * 100).toFixed(1)}%,${(norm.y0 * 100).toFixed(1)}% • ${w.toFixed(1)}×${h.toFixed(1)}% (p${pg}, norm)`;
  }
  return '—';
}

function collectAreaDebugEntries(record, options = {}){
  const { page = null } = options || {};
  const occurrences = Array.isArray(record?.areaOccurrences) ? record.areaOccurrences.filter(Boolean) : [];
  const entries = occurrences
    .filter(occ => !page || ((occ.page || occ.bboxPx?.page || occ.bboxNorm?.page || occ.bboxPct?.page) === page))
    .map(occ => {
      const supportMatches = Array.isArray(occ.supportMatches) ? occ.supportMatches : (Array.isArray(occ.validation?.supportMatches) ? occ.validation.supportMatches : []);
      const supportTokens = supportMatches.map(s => s?.text || s?.token?.text || s?.token?.raw || '').filter(Boolean);
      const supportCount = Number.isFinite(occ.validation?.matchedSupports)
        ? occ.validation.matchedSupports
        : (Number.isFinite(occ.matchMetrics?.matchedSupports) ? occ.matchMetrics.matchedSupports : (supportTokens.length || null));
      const supportTotal = Number.isFinite(occ.validation?.totalSupports)
        ? occ.validation.totalSupports
        : (Number.isFinite(occ.matchMetrics?.totalSupports) ? occ.matchMetrics.totalSupports : null);
      const matchesFound = Number.isFinite(occ.matchesFound) ? occ.matchesFound : (supportTokens.length || supportCount || null);
      const pageNum = occ.page || occ.bboxPx?.page || occ.bboxNorm?.page || occ.bboxPct?.page || null;
      const idx = Number.isFinite(occ.occurrenceIndex) ? occ.occurrenceIndex + 1 : (Number.isFinite(occ.index) ? occ.index : null);
      const areaId = occ.areaId || occ.areaName || 'Area';
      const areaName = resolveAreaLabel(areaId, occ.areaName || null);
      return {
        areaId,
        areaName,
        occurrenceIndex: idx,
        page: pageNum,
        confidence: occ.confidence ?? null,
        matchesFound,
        anchorText: occ.anchor?.text || occ.validation?.anchorText || '',
        supportTokens,
        supportCount,
        supportTotal,
        boxPx: occ.bboxPx || null,
        boxNorm: occ.bboxNorm || occ.bboxPct || null
      };
    });

  if(!entries.length && Array.isArray(record?.areaRows)){
    record.areaRows.forEach((row, i) => {
      const pageNum = row?.page || row?.bboxPx?.page || null;
      if(page && pageNum && pageNum !== page) return;
      const areaId = row?.areaId || row?.areaName || 'Area';
      entries.push({
        areaId,
        areaName: resolveAreaLabel(areaId, row?.areaName || null),
        occurrenceIndex: Number.isFinite(row?.occurrenceIndex) ? row.occurrenceIndex + 1 : (i + 1),
        page: pageNum,
        confidence: row?.confidence ?? null,
        matchesFound: null,
        anchorText: '',
        supportTokens: [],
        supportCount: null,
        supportTotal: null,
        boxPx: row?.bboxPx || null,
        boxNorm: row?.bboxNorm || row?.bboxPct || null
      });
    });
  }

  return entries.sort((a, b) => {
    if(a.areaName === b.areaName){
      return (a.occurrenceIndex || 0) - (b.occurrenceIndex || 0);
    }
    return (a.areaName || '').localeCompare(b.areaName || '');
  });
}

function areaDebugCardsHtml(entries){
  return entries.map(entry => {
    const confidence = Number.isFinite(entry.confidence) ? `${Math.round(entry.confidence * 100)}%` : '—';
    const matches = Number.isFinite(entry.matchesFound)
      ? entry.matchesFound
      : (entry.matchesFound === 0 ? 0 : (entry.matchesFound || '—'));
    const supportDenom = Number.isFinite(entry.supportTotal) ? `/${entry.supportTotal}` : '';
    const supports = Number.isFinite(entry.supportCount) || entry.supportTokens.length
      ? `${Number.isFinite(entry.supportCount) ? entry.supportCount : entry.supportTokens.length}${supportDenom}`
      : `0${supportDenom}`;
    const supportTokens = entry.supportTokens.length ? ` (${entry.supportTokens.join(', ')})` : '';
    const anchor = entry.anchorText ? `"${entry.anchorText}"` : '—';
    const box = formatAreaBoxForDisplay(entry.boxPx, entry.boxNorm, entry.page);
    const occLabel = Number.isFinite(entry.occurrenceIndex) ? `#${entry.occurrenceIndex}` : '#?';
    const pageLabel = entry.page ? `Page ${entry.page}` : 'Page ?';
    return `
      <div class="area-debug-card">
        <div class="area-debug-card__header">
          <div>
            <div class="area-name">${entry.areaName || entry.areaId || 'Area'}</div>
            <div class="area-meta">${occLabel} • ${pageLabel}</div>
          </div>
          <div class="confidence-pill">${confidence}</div>
        </div>
        <div class="area-debug-card__body">
          <div><strong>Matches found:</strong> ${matches}</div>
          <div><strong>Anchor:</strong> ${anchor}</div>
          <div><strong>Support tokens:</strong> ${supports}${supportTokens}</div>
          <div><strong>Subordinate box:</strong> ${box}</div>
        </div>
      </div>`;
  }).join('');
}

function renderAreaDebugPanel(record){
  const panel = document.getElementById('areaDebugPanel');
  if(!panel) return;
  if(!record){
    panel.innerHTML = '<p class="sub">Select a run to view area detection details.</p>';
    return;
  }
  const entries = collectAreaDebugEntries(record);
  if(!entries.length){
    panel.innerHTML = '<p class="sub">No area matches were recorded for this run.</p>';
    return;
  }
  panel.innerHTML = areaDebugCardsHtml(entries);
}

function getRecordByFileId(fileId){
  if(!fileId) return null;
  const { docType: dt, wizardId } = resolveExtractedWizardContext();
  const db = LS.getDb(state.username, dt, wizardId);
  return db.find(r => r.fileId === fileId) || null;
}

function renderSnapshotAreaDebug(manifest, pageNumber){
  const panel = els.snapshotAreaDebug || document.getElementById('snapshotAreaDebug');
  if(!panel) return;
  if(!manifest){
    panel.innerHTML = '<p class="sub">No snapshot selected.</p>';
    return;
  }
  const record = getRecordByFileId(manifest.fileId || state.selectedRunId);
  if(!record){
    panel.innerHTML = '<p class="sub">No run data available for this snapshot.</p>';
    return;
  }
  const entries = collectAreaDebugEntries(record, { page: pageNumber || null });
  if(!entries.length){
    panel.innerHTML = '<p class="sub">No area matches on this page.</p>';
    return;
  }
  panel.innerHTML = areaDebugCardsHtml(entries);
}

function renderResultsTable(){
  const mount = document.getElementById('resultsMount');
  const { docType: dt, wizardId } = resolveExtractedWizardContext();
  const profileForView = (wizardId === currentWizardId() && dt === state.docType)
    ? state.profile
    : loadProfile(state.username, dt, wizardId, DEFAULT_GEOMETRY_ID);
  let db = LS.getDb(state.username, dt, wizardId);
  if(isRunMode()){
    const previewFields = db[0]?.fields || {};
    console.info('[run-mode][diag] masterdb read', {
      count: db.length,
      firstFileId: db[0]?.fileId || null,
      fieldKeys: Object.keys(previewFields || {}),
      sampleFields: normalizePayloadForLog(previewFields),
      sampleTotals: db[0]?.totals || null,
      sampleInvoice: db[0]?.invoice || null
    });
    console.info('[run-mode][diag] masterdb ui expectations', {
      fields: 'Object keyed by fieldKey -> { value, raw, confidence, correctionsApplied }',
      totals: '{ subtotal, tax, total, discount }',
      invoice: '{ number, salesDateISO, salesperson, store }',
      lineItems: 'array of line item records with normalized keys'
    });
  }
  if(!db.length){ mount.innerHTML = '<p class="sub">No extractions yet.</p>'; return; }
  db = db.sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO));

  const firstId = db[0]?.fileId || '';
  if(!state.selectedRunId || !db.some(r => r.fileId === state.selectedRunId)){
    state.selectedRunId = firstId;
  }

  const keySet = new Set();
  const areaFieldKeys = getAreaFieldKeys(profileForView?.fields);
  db.forEach(r => Object.keys(r.fields||{}).forEach(k=>{
    if(areaFieldKeys.has(k)) return;
    keySet.add(k);
  }));
  const keys = Array.from(keySet);
  const showRaw = state.modes.rawData || els.showRawToggle?.checked;
  const labelMap = getFieldLabelMap(profileForView);

  const thead = `<tr><th>file</th>${keys.map(k=>`<th>${labelMap[k] || k}</th>`).join('')}<th>line items</th></tr>`;
  const rows = db.map(r=>{
    const rowClass = r.fileId === state.selectedRunId ? 'results-selected' : '';
    const cells = keys.map(k=>{
      const f = r.fields?.[k] || { value:'', raw:'', confidence:0 };
      const warn = f.confidence < 0.8 || (f.correctionsApplied&&f.correctionsApplied.length) ? '<span class="warn">⚠️</span>' : '';
      const val = showRaw ? (f.raw || f.value || '') : (f.value || f.raw || '');
      const prop = showRaw ? 'raw' : 'value';
      return `<td><input class="editField" data-file="${r.fileId}" data-field="${k}" data-prop="${prop}" value="${val}"/>${warn}<span class="confidence">${Math.round((f.confidence||0)*100)}%</span></td>`;
    }).join('');
    const liRows = (r.lineItems||[]).map(it=>{
      const lineTotal = it.amount || (it.quantity && it.unit_price ? (parseFloat(it.quantity)*parseFloat(it.unit_price)).toFixed(2) : '');
      return `<tr><td>${it.description||''}${it.confidence<0.8?' <span class="warn">⚠️</span>':''}</td><td>${it.sku||''}</td><td>${it.quantity||''}</td><td>${it.unit_price||''}</td><td>${lineTotal}</td></tr>`;
    }).join('');
    const liTable = `<table class="line-items-table"><thead><tr><th>Item Description</th><th>Item Code (SKU)</th><th>Quantity</th><th>Unit Price</th><th>Line Total</th></tr></thead><tbody>${liRows}</tbody></table>`;
    return `<tr class="${rowClass}" data-file="${r.fileId}"><td>${r.fileName}</td>${cells}<td>${liTable}</td></tr>`;
  }).join('');

  const selectedRecord = db.find(r => r.fileId === state.selectedRunId) || db[0] || null;
  const tableHtml = `<div class="results-table-scroll"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;
  const selectedLabel = selectedRecord ? (selectedRecord.fileName || selectedRecord.fileId || 'Selected run') : 'Select a run to view details';
  mount.innerHTML = `
    <div class="results-layout">
      ${tableHtml}
      <div class="area-panel-container">
        <div class="area-panel-header">
          <div>
            <div class="area-panel-title">Area diagnostics</div>
            <div class="sub">Matches found, confidence, anchors/supports, and the area box used to scope subordinate extraction.</div>
          </div>
          <div class="sub area-selected-label">${selectedLabel}</div>
        </div>
        <div class="area-panel-grid">
          <div class="area-debug-panel">
            <div class="area-panel-title">Detection summary</div>
            <div class="sub">Per-occurrence confidence, anchors, and support tokens.</div>
            <div id="areaDebugPanel"></div>
          </div>
          <div class="area-occurrences-panel">
            <div class="area-panel-title">Area occurrences</div>
            <div class="sub">Grouped by detected instances of each area. Values align to the subordinate fields saved for that area.</div>
            <div id="areaOccurrencesPanel"></div>
          </div>
        </div>
      </div>
    </div>`;

  mount.querySelectorAll('input.editField').forEach(inp=>inp.addEventListener('change', ()=>{
    const fileId = inp.dataset.file;
    const field = inp.dataset.field;
    const prop = inp.dataset.prop || 'value';
    const db = LS.getDb(state.username, dt, wizardId);
    const rec = db.find(r=>r.fileId===fileId);
    if(rec && rec.fields?.[field]){
      rec.fields[field][prop] = inp.value;
      if(prop === 'value'){
        rec.fields[field].confidence = 1;
        if(rec.invoice[field] !== undefined) rec.invoice[field] = inp.value;
        if(rec.totals[field] !== undefined) rec.totals[field] = inp.value;
      }
      LS.setDb(state.username, dt, db, wizardId);
      renderResultsTable();
      renderReports();
      if(wizardId === currentWizardId() && dt === state.docType){
        renderSavedFieldsTable();
      }
    }
  }));
  mount.querySelectorAll('tr[data-file]').forEach(tr => tr.addEventListener('click', evt => {
    if((evt.target?.tagName||'').toLowerCase() === 'input') return;
    state.selectedRunId = tr.dataset.file || '';
    mount.querySelectorAll('tr[data-file]').forEach(row => row.classList.toggle('results-selected', row.dataset.file === state.selectedRunId));
    syncSnapshotUi();
    const nextSelected = db.find(r => r.fileId === state.selectedRunId) || null;
    renderAreaOccurrencesPanel(nextSelected, labelMap);
    renderAreaDebugPanel(nextSelected);
  }));
  renderAreaOccurrencesPanel(selectedRecord, labelMap);
  renderAreaDebugPanel(selectedRecord);
  syncSnapshotUi();
}

function syncRawModeUI(){
  const on = state.modes.rawData;
  if(els.showRawToggle){
    els.showRawToggle.checked = true;
    els.showRawToggle.disabled = on;
    if(!on) els.showRawToggle.checked = false;
  }
  if(els.rawDataBtn){
    els.rawDataBtn.classList.toggle('active', on);
  }
  renderResultsTable();
}

function renderTelemetry(){
  if(!els.telemetryPanel) return;
  els.telemetryPanel.textContent = state.telemetry.map(t=>`${t.field}: ${t.comparator} (${(t.score||0).toFixed(2)}) -> ${(t.confidence||0).toFixed(2)}`).join('\n');
}

function renderReports(){
  const { docType: dt, wizardId } = resolveExtractedWizardContext();
  let db = LS.getDb(state.username, dt, wizardId);
  const totalRevenue = db.reduce((s,r)=> s + (parseFloat(r.totals?.total)||0), 0);
  const orders = db.length;
  const taxTotal = db.reduce((s,r)=> s + (parseFloat(r.totals?.tax)||0), 0);
  const discountTotal = db.reduce((s,r)=> s + Math.abs(parseFloat(r.totals?.discount)||0), 0);
  const skuMap = {};
  db.forEach(r => (r.lineItems||[]).forEach(it=>{
    const sku = it.sku || '';
    if(!sku) return;
    const qty = parseFloat(it.quantity)||0;
    const amt = parseFloat(it.unit_price)||0 * qty;
    const cur = skuMap[sku] || { qty:0, revenue:0 };
    cur.qty += qty; cur.revenue += amt; skuMap[sku] = cur;
  }));
  const top = Object.entries(skuMap).sort((a,b)=>b[1].revenue - a[1].revenue).slice(0,5);
  const topRows = top.map(([sku,d])=>`<tr><td>${sku}</td><td>${d.qty}</td><td>${d.revenue.toFixed(2)}</td></tr>`).join('');
  els.reports.innerHTML = `<p>Total revenue: ${totalRevenue.toFixed(2)}</p><p>Orders: ${orders}</p><p>Tax total: ${taxTotal.toFixed(2)}</p><p>Discount total: ${discountTotal.toFixed(2)}</p><h4>Top SKUs</h4><table class="line-items-table"><thead><tr><th>SKU</th><th>Qty</th><th>Revenue</th></tr></thead><tbody>${topRows}</tbody></table>`;
}

/* ---------------------- Profile save / table --------------------- */
function upsertFieldInProfile(step, normBox, value, confidence, page, extras={}, raw='', corrections=[], tokens=[], rawBox=null) {
  ensureProfile();
  const prevGeomSnapshot = snapshotProfileGeometry(state.profile);
  const existing = state.profile.fields.find(f => f.fieldKey === step.fieldKey);
  const pctBox = { x0: normBox.x0n, y0: normBox.y0n, x1: normBox.x0n + normBox.wN, y1: normBox.y0n + normBox.hN };
  const parsePctBox = box => {
    if(!box) return null;
    const x0 = Number.isFinite(box.x0) ? box.x0 : (Array.isArray(box) ? box[0] : null);
    const y0 = Number.isFinite(box.y0) ? box.y0 : (Array.isArray(box) ? box[1] : null);
    const x1 = Number.isFinite(box.x1) ? box.x1 : (Array.isArray(box) ? box[2] : null);
    const y1 = Number.isFinite(box.y1) ? box.y1 : (Array.isArray(box) ? box[3] : null);
    if([x0,y0,x1,y1].every(v => typeof v === 'number' && Number.isFinite(v))) return { x0, y0, x1, y1 };
    return null;
  };
  const pctFromRawBox = sel => {
    if(!sel) return null;
    const chk = validateSelection(sel);
    if(!chk.ok || !chk.normBox) return null;
    const nb = chk.normBox;
    return { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN };
  };
  const configPctBox = pctFromRawBox(rawBox) || parsePctBox(existing?.configBox) || null;
  const getConfigPctBox = field => parsePctBox(field?.configBox) || pctFromRawBox(field?.rawBox) || null;
  const boxesOverlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
  let overlapDetails = null;
  const isAreaField = step.isArea || step.fieldType === 'areabox';
  const isSubordinateField = (step.isSubordinate === undefined ? !!existing?.isSubordinate : !!step.isSubordinate) && !isAreaField;
  const areaId = isAreaField
    ? (step.areaId || step.fieldKey || step.fieldId)
    : (isSubordinateField ? (step.areaId || existing?.areaId || null) : null);
  if(step.type === 'static' && !isAreaField && !isSubordinateField){
    const clash = (state.profile.fields||[]).find(f=>{
      if(f.fieldKey===step.fieldKey || f.type!=='static' || f.page!==page) return false;
      const mine = configPctBox || pctBox;
      const otherConfig = getConfigPctBox(f);
      const other = otherConfig || f.bboxPct;
      if(!mine || !other) return false;
      const useConfigOnly = !!configPctBox && !!otherConfig;
      const overlapping = useConfigOnly
        ? boxesOverlap(mine, other)
        : Math.min(mine.y1, other.y1) - Math.max(mine.y0, other.y0) > 0;
      if(overlapping){ overlapDetails = { mine, other, useConfigOnly, clashField: f.fieldKey }; }
      return overlapping;
    });
    if(clash){
      if(overlapDetails?.useConfigOnly){
        console.warn('[overlap-check] using original user CONFIG boxes only', { currentField: step.fieldKey, clashField: clash.fieldKey, mine: overlapDetails.mine, clash: overlapDetails.other });
      }
      console.warn('Overlapping static bboxes, adjusting', step.fieldKey, clash.fieldKey);
      const clashBox = overlapDetails?.other || clash.bboxPct;
      const shift = (clashBox.y1 - clashBox.y0) + 0.001;
      pctBox.y0 = clashBox.y1 + 0.001;
      pctBox.y1 = pctBox.y0 + shift;
      normBox.y0n = pctBox.y0;
      normBox.hN = pctBox.y1 - pctBox.y0;
    }
  }
  const entry = {
    fieldKey: step.fieldKey,
    type: step.type,
    fieldType: step.fieldType || step.type,
    areaId: areaId || undefined,
    page,
    selectorType:'bbox',
    bbox:[pctBox.x0, pctBox.y0, pctBox.x1, pctBox.y1],
    bboxPct:{x0:pctBox.x0, y0:pctBox.y0, x1:pctBox.x1, y1:pctBox.y1},
    normBox,
    configBox: configPctBox || null,
    rawBox,
    value,
    nonExtractable: isAreaField || existing?.nonExtractable || false,
    confidence,
    raw,
    correctionsApplied: corrections,
    tokens,
    magicDataType: normalizeMagicDataType(step.magicDataType || step.magicType),
    magicType: normalizeMagicDataType(step.magicDataType || step.magicType)
  };
  if(extras.lineMetrics){
    entry.lineMetrics = clonePlain(extras.lineMetrics);
    if(extras.lineMetrics.lineCount !== undefined) entry.lineCount = extras.lineMetrics.lineCount;
    if(extras.lineMetrics.lineHeights) entry.lineHeights = clonePlain(extras.lineMetrics.lineHeights);
  }
  if(step.type === 'static'){
    entry.pageRole = inferPageRole(step, page);
    entry.pageIndex = (page || 1) - 1;
    entry.verticalAnchor = inferVerticalAnchor(step);
    const geom = buildStaticGeometry(normBox, entry.verticalAnchor);
    if(geom) entry.staticGeom = geom;
  }
  const anchorMetrics = computeFieldAnchorMetrics({ normBox, rawBox, tokens, page, extras });
  if(anchorMetrics) entry.anchorMetrics = anchorMetrics;
  if(extras.keywordRelations !== undefined){
    entry.keywordRelations = extras.keywordRelations ? clonePlain(extras.keywordRelations) : null;
  }
  if(extras.landmark) entry.landmark = extras.landmark;
  if(extras.areaBox){ entry.areaBox = clonePlain(extras.areaBox); }
  if(extras.areaRelativeBox){ entry.areaRelativeBox = clonePlain(extras.areaRelativeBox); }
  if(extras.areaFingerprint){ entry.areaFingerprint = clonePlain(extras.areaFingerprint); }
  if(extras.areaConstellation !== undefined){
    entry.areaConstellation = extras.areaConstellation ? clonePlain(extras.areaConstellation) : null;
  }
  if(step.isArea || (step.fieldType === 'areabox')){
    entry.isArea = true;
  } else {
    entry.isSubordinate = !!isSubordinateField;
  }
  if(step.type === 'column' && extras.column){
    const columnExtras = clonePlain(extras.column);
    const columnFera = columnExtras.fera || anchorMetrics || null;
    if(columnFera){ columnExtras.fera = clonePlain(columnFera); }
    entry.column = columnExtras;
    state.profile.tableHints = state.profile.tableHints || { headerLandmarks: ['sku_header','description_hdr','qty_header','price_header'], rowBandHeightPx: 18, columns: {}, rowAnchor: null };
    state.profile.tableHints.columns = state.profile.tableHints.columns || {};
    state.profile.tableHints.columns[step.fieldKey] = {
      fieldKey: step.fieldKey,
      page,
      xband: extras.column.xband,
      header: extras.column.header || null,
      anchorSample: extras.column.anchorSample || null,
      anchorSampleMetrics: extras.column.anchorSampleMetrics || null,
      rowSamples: extras.column.rowSamples || [],
      fera: columnFera ? clonePlain(columnFera) : null
    };
    if(extras.column.anchorSampleMetrics){
      entry.column.anchorSampleMetrics = extras.column.anchorSampleMetrics;
    }
    if(extras.column.anchorSample){
      if(!state.profile.tableHints.rowAnchor || state.profile.tableHints.rowAnchor.fieldKey === step.fieldKey){
        state.profile.tableHints.rowAnchor = {
          fieldKey: step.fieldKey,
          page,
          sample: extras.column.anchorSample,
          metrics: extras.column.anchorSampleMetrics || null,
          fera: columnFera ? clonePlain(columnFera) : null
        };
      }
    }
  }
  const patterns = FieldDataEngine.exportPatterns();
  const nextFingerprints = (existing?.fingerprints && typeof existing.fingerprints === 'object') ? clonePlain(existing.fingerprints) : {};
  const keysToPersist = new Set();
  if(step.fieldKey) keysToPersist.add(step.fieldKey);
  const altKey = COLUMN_OUT_KEYS[step.fieldKey];
  if(altKey) keysToPersist.add(altKey);
  for(const key of keysToPersist){
    if(patterns && patterns[key]){
      nextFingerprints[key] = clonePlain(patterns[key]);
    }
  }
  if(Object.keys(nextFingerprints).length){
    entry.fingerprints = nextFingerprints;
  }
  if(existing) Object.assign(existing, entry); else state.profile.fields.push(entry);
  const wizardId = state.profile?.wizardId || currentWizardId();
  state.profile.isConfigured = true;
  const profileKey = LS.profileKey(state.username, state.docType, wizardId);
  const capturedSnapshot = snapshotProfileGeometry(state.profile);
  traceSnapshot('config.field-captured',{
    stage:'config.capture',
    mode:'config',
    username: state.username,
    docType: state.docType,
    wizardId,
    profileKey,
    profile: state.profile,
    snapshot: capturedSnapshot,
    previousSnapshot: prevGeomSnapshot,
    note: `field=${step.fieldKey || ''}`
  });
  saveProfile(state.username, state.docType, state.profile);
  if(isSkinV2){
    persistPatternBundle(state.profile);
  }
}
function ensureAnchorFor(fieldKey){
  if(!state.profile) return;
  const f = state.profile.fields.find(x => x.fieldKey === fieldKey);
  if(!f || f.anchor) return;
  const anchorMap = {
    order_number:   { landmarkKey:'sales_bill',    dx: 0.02, dy: 0.00, w: 0.10, h: 0.035 },
    subtotal_amount:{ landmarkKey:'subtotal_hdr',  dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    tax_amount:     { landmarkKey:'tax_hdr',       dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    invoice_total:  { landmarkKey:'total_hdr',     dx: 0.12, dy: 0.00, w: 0.14, h: 0.04  },
    deposit:        { landmarkKey:'deposit_hdr',   dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    balance:        { landmarkKey:'balance_hdr',   dx: 0.12, dy: 0.00, w: 0.14, h: 0.04  },
  };
  if(anchorMap[fieldKey]){
    f.anchor = anchorMap[fieldKey];
    saveProfile(state.username, state.docType, state.profile);
    if(isSkinV2){
      persistPatternBundle(state.profile);
    }
  }
}

function getFieldLabelMap(profile = state.profile){
  const map = {};
  (profile?.fields || []).forEach(f => {
    map[f.fieldKey] = f.label || f.name || f.fieldKey;
  });
  return map;
}

function getFieldLabel(key, profile){
  const map = getFieldLabelMap(profile);
  return map[key] || key;
}

function isAreaField(field){
  if(!field) return false;
  const type = (field.fieldType || field.type || '').toLowerCase();
  return !!field.isArea || type === 'areabox';
}

function isNonExtractableField(field){
  if(!field) return false;
  if(field.nonExtractable === true) return true;
  return isAreaField(field);
}

function getAreaFieldKeys(fields){
  const source = Array.isArray(fields) ? fields : (state.profile?.fields || []);
  return new Set(
    source
      .filter(f => isAreaField(f))
      .map(f => f.fieldKey)
      .filter(Boolean)
  );
}

function getExtractableFields(fields){
  const source = Array.isArray(fields) ? fields : (state.profile?.fields || []);
  return source.filter(f => !isNonExtractableField(f));
}
function renderSavedFieldsTable(){
  const wizardId = currentWizardId();
  const db = LS.getDb(state.username, state.docType, wizardId);
  const latest = db.slice().sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO))[0];
  state.savedFieldsRecord = latest || null;
  const order = getExtractableFields().map(f=>f.fieldKey);
  const labelMap = getFieldLabelMap();
  const fields = order.map(k => ({ fieldKey:k, value: latest?.fields?.[k]?.value }))
    .filter(f => f.value !== undefined && f.value !== null && String(f.value).trim() !== '');
  if(!fields.length){
    els.fieldsPreview.innerHTML = '<p class="sub">No fields yet.</p>';
  } else {
    const thead = `<tr>${fields.map(f=>`<th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">${labelMap[f.fieldKey] || f.fieldKey}</th>`).join('')}</tr>`;
    const row = `<tr>${fields.map(f=>`<td style="padding:6px;border-bottom:1px solid var(--border)">${(f.value||'').toString().replace(/</g,'&lt;')}</td>`).join('')}</tr>`;
    els.fieldsPreview.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${row}</tbody></table></div>`;
  }
  els.savedJson.textContent = serializeProfile(state.profile);
  renderConfirmedTables(latest);
}

let confirmedRenderPending = false;
function renderConfirmedTables(rec){
  if(isRunMode()){
    mirrorDebugLog('[run-mode] renderConfirmedTables invoked during RUN; skipping RAF update', null, 'warn');
    return;
  }
  if(confirmedRenderPending) return;
  confirmedRenderPending = true;
  const wizardId = currentWizardId();
  requestAnimationFrame(()=>{
    confirmedRenderPending = false;
    const latest = rec || LS.getDb(state.username, state.docType, wizardId).slice().sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO))[0];
    const fDiv = document.getElementById('confirmedFields');
    const liDiv = document.getElementById('confirmedLineItems');
    if(fDiv){
      const typeMap = {};
      (state.profile?.fields||[]).forEach(f=>{ typeMap[f.fieldKey]=f.type; });
      const labelMap = getFieldLabelMap();
      const statics = Object.entries(latest?.fields||{}).filter(([k,v])=>typeMap[k]==='static' && v.value);
      if(!statics.length){ fDiv.innerHTML = '<p class="sub">No fields yet.</p>'; }
      else {
        const rows = statics.map(([k,f])=>{
          const warn = (f.confidence||0) < 0.8 || (f.correctionsApplied&&f.correctionsApplied.length) ? '<span class="warn">⚠️</span>' : '';
          const conf = `<span class="confidence">${Math.round((f.confidence||0)*100)}%</span>`;
          const label = labelMap[k] || k;
          return `<tr><td>${label}</td><td><input class="confirmEdit" data-field="${k}" value="${f.value}"/>${warn}${conf}</td></tr>`;
        }).join('');
        fDiv.innerHTML = `<table class="line-items-table"><tbody>${rows}</tbody></table>`;
        fDiv.querySelectorAll('input.confirmEdit').forEach(inp=>inp.addEventListener('change',()=>{
          const db = LS.getDb(state.username, state.docType, wizardId);
          const rec = db.find(r=>r.fileId===latest?.fileId);
          if(rec && rec.fields?.[inp.dataset.field]){
            rec.fields[inp.dataset.field].value = inp.value;
            rec.fields[inp.dataset.field].confidence = 1;
            LS.setDb(state.username, state.docType, db, wizardId);
            renderSavedFieldsTable();
          }
        }));
      }
    }
    if(liDiv){
      const items = latest?.lineItems || [];
      if(!items.length){ liDiv.innerHTML = '<p class="sub">No line items.</p>'; }
      else {
        const rows = items.map(it=>{
          const warn = (it.confidence||0) < 0.8 ? '<span class="warn">⚠️</span>' : '';
          const lineTotal = it.amount || (it.quantity && it.unit_price ? (parseFloat(it.quantity)*parseFloat(it.unit_price)).toFixed(2) : '');
          return `<tr><td>${(it.description||'')}${warn}</td><td>${it.sku||''}</td><td>${it.quantity||''}</td><td>${it.unit_price||''}</td><td>${lineTotal}</td></tr>`;
        }).join('');
        liDiv.innerHTML = `<table class="line-items-table"><thead><tr><th>Item Description</th><th>Item Code (SKU)</th><th>Quantity</th><th>Unit Price</th><th>Line Total</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
    }
  });
}

/* --------------------------- Events ------------------------------ */
// Auth
function completeLogin(opts = {}){
  loginHydrated = true;
  const prevUser = state.username;
  const prevWizard = state.activeWizardId;
  const nameInput = opts.username ?? els.username?.value ?? 'demo';
  state.username = String(nameInput || 'demo').trim() || 'demo';
  const resolvedDocType = opts.docType || envWizardBootstrap?.docType || els.docType?.value || state.docType || 'invoice';
  state.docType = resolvedDocType;
  refreshWizardTemplates();
  const wizardId = (opts.wizardId && isSkinV2)
    ? opts.wizardId
    : (isSkinV2
      ? requireCustomWizard({ allowTemplateFallback: true, promptBuilder: false })
      : resolveWizardId());
  state.activeWizardId = wizardId || (isSkinV2 ? firstCustomWizardId() : DEFAULT_WIZARD_ID);
  if(isSkinV2 && !state.activeWizardId){
    showWizardManagerTab();
  }
  try {
    const currId = currentWizardId();
    console.info('[id-drift][completeLogin]', JSON.stringify({
      isSkinV2,
      prevUsername: prevUser,
      username: state.username,
      prevActiveWizardId: prevWizard,
      activeWizardId: state.activeWizardId,
      currentWizardId: currId
    }));
  } catch(err){ console.warn('[id-drift][completeLogin] log failed', err); }
  const targetWizardId = state.activeWizardId || (isSkinV2 ? '' : DEFAULT_WIZARD_ID);
  const existing = targetWizardId ? loadProfile(state.username, state.docType, targetWizardId, state.activeGeometryId || DEFAULT_GEOMETRY_ID) : null;
  state.profile = existing || state.profile || null;
  hydrateFingerprintsFromProfile(state.profile);
  try {
    if(window.SessionStore?.setActiveSession){
      window.SessionStore.setActiveSession({
        username: state.username,
        docType: state.docType,
        wizardId: state.activeWizardId || ''
      });
    }
  } catch(err){
    console.warn('[session] persist failed', err);
  }
  const hasWizard = !!state.activeWizardId;
  if(els.loginSection){ els.loginSection.style.display = 'none'; }
  if(els.app){ els.app.style.display = 'block'; }
  if(hasWizard){ showTab('document-dashboard'); }
  else if(isSkinV2){ showWizardManagerTab(); }
  populateModelSelect(isSkinV2 && state.activeWizardId ? `custom:${state.activeWizardId}` : undefined);
  logWizardSelection('restore', resolveSelectedWizardContext());
  renderResultsTable();
}

function showLoginUi(){
  if(els.loginSection){ els.loginSection.style.display = 'block'; }
  if(els.app){ els.app.style.display = 'none'; }
  if(els.wizardSection){ els.wizardSection.style.display = 'none'; }
}

function setLoginUiBusy(isBusy, label){
  if(!els.loginForm) return;
  const submitBtn = els.loginForm.querySelector('button[type="submit"]');
  if(submitBtn && !submitBtn.dataset.label){
    submitBtn.dataset.label = submitBtn.textContent || 'Login';
  }
  if(submitBtn){
    submitBtn.textContent = isBusy ? (label || submitBtn.dataset.label || 'Login') : (submitBtn.dataset.label || 'Login');
  }
  const controls = [els.username, els.email, els.password, els.signupBtn, submitBtn].filter(Boolean);
  controls.forEach((el)=>{ el.disabled = Boolean(isBusy); });
  els.loginForm.classList.toggle('loading', Boolean(isBusy));
}

const AUTH_GATE_PREFIX = '[auth-gate]';
function logAuthGate(event, detail){
  const payload = detail && typeof detail === 'object' ? detail : { detail };
  console.info(`${AUTH_GATE_PREFIX} ${event}`, payload);
}
function authIsRequired(){
  const api = window.firebaseApi;
  return Boolean(api?.auth);
}
async function confirmAuthenticatedUser(reason, opts = {}){
  const api = window.firebaseApi;
  const requireAuth = opts.requireAuth ?? authIsRequired();
  const timeoutMs = opts.timeoutMs || 12000;
  if(!requireAuth){
    logAuthGate('demo-mode', { reason });
    return null;
  }
  if(!api){
    logAuthGate('unavailable', { reason });
    return null;
  }
  try{
    if(api.confirmAuthUser){
      const confirmed = await api.confirmAuthUser({ reason, timeoutMs, authInstance: api.auth });
      if(confirmed?.uid){
        return confirmed;
      }
    } else if(api.requireAuthUser){
      const confirmed = await api.requireAuthUser({ reason, timeoutMs, authInstance: api.auth });
      if(confirmed?.uid){
        return confirmed;
      }
    }
    const fallback = await waitForAuthResolution(api, { requireUser: true, timeoutMs });
    if(fallback?.uid){
      return fallback;
    }
  } catch(err){
    console.warn(`${AUTH_GATE_PREFIX} confirm failed`, err);
  }
  logAuthGate('missing-user', { reason, state: { hasAuth: !!api?.auth, hasUser: !!api?.auth?.currentUser } });
  return null;
}
async function resolveUsernameForUser(user, fallbackUsername=''){
  let username = fallbackUsername || state.username || sessionBootstrap?.username || '';
  const api = window.firebaseApi;
  if(!username && user?.uid){
    try{
      const meta = await api?.fetchUserMeta?.(user.uid);
      if(meta?.usernameDisplay || meta?.usernameLower){
        username = meta.usernameDisplay || meta.usernameLower;
      }
    } catch(err){
      console.warn(`${AUTH_GATE_PREFIX} username lookup failed`, err);
    }
  }
  return username;
}
async function resolveAuthenticatedIdentity(actionName, opts = {}){
  const requireAuth = opts.requireAuth ?? authIsRequired();
  const user = await confirmAuthenticatedUser(actionName, { requireAuth, timeoutMs: opts.timeoutMs || 12000 });
  if(requireAuth && !user){
    logAuthGate('blocked', { action: actionName, reason: 'no-auth-user' });
    return { user: null, username: '' };
  }
  const username = await resolveUsernameForUser(user, opts.usernameHint || '');
  if(requireAuth && (!username || !user?.uid)){
    logAuthGate('blocked', { action: actionName, reason: 'missing-identity', state: { hasUser: !!user, username } });
    return { user: null, username: '' };
  }
  return { user: user || null, username };
}
async function enterAppWithAuth(opts = {}, options = {}){
  const reason = options.reason || 'login';
  const requireAuth = options.requireAuth ?? authIsRequired();
  const user = await confirmAuthenticatedUser(reason, { requireAuth, timeoutMs: options.timeoutMs || 12000 });
  if(requireAuth && !user){
    logAuthGate('login-blocked', { reason });
    if(!options.silent){
      alert('Could not confirm your login session. Please try again.');
    }
    showLoginUi();
    return false;
  }
  completeLogin(opts);
  return true;
}

async function handleSignupClick(e){
  e.preventDefault();
  const username = (els.username?.value || '').trim();
  if (!username) {
    alert('Please choose a username.');
    return;
  }
  const email = (els.email?.value || '').trim();
  const password = els.password?.value || '';
  const api = window.firebaseApi;
  if (!api?.createUserWithEmailAndPassword || !api?.auth) {
    console.warn('[signup] firebase not available; proceeding with local login');
    await enterAppWithAuth({ username }, { reason: 'signup-demo', requireAuth: false, silent: true });
    return;
  }
  setLoginUiBusy(true, 'Signing up...');
  try {
    const cred = await api.createUserWithEmailAndPassword(api.auth, email, password);
    try {
      const authUser = await waitForAuthResolution(api, { requireUser: true }) || cred.user || null;
      if(!authUser?.uid){
        throw new Error('Could not establish a Firebase session. Please try again.');
      }
      const claimed = await api.claimUsername?.(authUser.uid, username, email);
      const resolvedUsername = claimed?.usernameDisplay || claimed?.usernameLower || username;
      await enterAppWithAuth({ username: resolvedUsername }, { reason: 'signup' });
      return;
    } catch (err) {
      console.error('[signup] failed to persist username mapping', err);
      try { await api.signOut?.(api.auth); } catch(signOutErr){ console.warn('[signup] signOut after failure failed', signOutErr); }
      alert(err?.message || 'Username is already taken or could not be saved.');
      return;
    }
  } catch (err) {
    console.error('[signup] failed', err);
    alert(err?.message || 'Sign up failed. Please try again.');
  } finally {
    setLoginUiBusy(false);
  }
}
async function handleLogin(e){
  e.preventDefault();
  const email = (els.email?.value || '').trim();
  const password = els.password?.value || '';
  const api = window.firebaseApi;
  if (!api?.signInWithEmailAndPassword || !api?.auth) {
    console.warn('[login] firebase not available; proceeding with local login');
    const username = (els.username?.value || '').trim() || 'demo';
    await enterAppWithAuth({ username }, { reason: 'login-demo', requireAuth: false, silent: true });
    return;
  }
  setLoginUiBusy(true, 'Logging in...');
  try {
    const cred = await api.signInWithEmailAndPassword(api.auth, email, password);
    const authUser = await waitForAuthResolution(api, { requireUser: true }) || cred.user || null;
    if(!authUser?.uid){
      throw new Error('Login was created but Firebase authentication is not ready yet. Please try again.');
    }
    const meta = await api.fetchUserMeta?.(authUser.uid);
    const resolvedUsername = meta?.usernameDisplay || meta?.usernameLower;
    if (!resolvedUsername) {
      throw new Error('No username is linked to this account. Please contact support.');
    }
    await enterAppWithAuth({ username: resolvedUsername }, { reason: 'login' });
  } catch (err) {
    console.error('[login] failed', err);
    alert(err?.message || 'Login failed. Please try again.');
  } finally {
    setLoginUiBusy(false);
  }
}
els.loginForm?.addEventListener('submit', handleLogin);
els.signupBtn?.addEventListener('click', handleSignupClick);

async function backupToCloud(){
  const api = window.firebaseApi;
  const { user, username } = await resolveAuthenticatedIdentity('backup', { usernameHint: state.username });
  if(!user || !username){
    alert('Please log in before running a backup.');
    return;
  }
  try{
    const uid = user.uid;
    const payload = buildBackupPayload(username);
    const docType = state.docType || sessionBootstrap?.docType || envWizardBootstrap?.docType || 'invoice';
    const wizardId = currentWizardId?.() || state.activeWizardId || DEFAULT_WIZARD_ID;
    const safeWizardId = wizardId || DEFAULT_WIZARD_ID;
    const ref = api.doc(api.db, 'Users', uid, 'Accounts', username, 'Backups', 'manual');
    await api.setDoc(ref, { payload, updatedAt: payload.savedAt }, { merge: true });
    alert('Backup completed.');
  } catch(err){
    console.error('[backup] failed', err);
    alert(err?.message || 'Backup failed. Please try again.');
  }
}

function waitForAuthResolution(api, opts = {}){
  const { requireUser = false, timeoutMs = 10000 } = opts || {};
  if(api?.waitForAuthUser){
    return api.waitForAuthUser({ requireUser, timeoutMs });
  }
  if(!api?.onAuthStateChanged || !api?.auth) return Promise.resolve(null);
  return new Promise((resolve)=>{
    let timer = null;
    let unsubscribe = ()=>{};
    const cleanup = (value)=>{
      if(timer) clearTimeout(timer);
      try { unsubscribe?.(); } catch(err){ console.warn('[auth] unsubscribe failed', err); }
      resolve(value ?? null);
    };
    unsubscribe = api.onAuthStateChanged(api.auth, (user)=>{
      if(requireUser && !user) return;
      cleanup(user || null);
    }, (err)=>{
      console.warn('[auth] onAuthStateChanged failed', err);
      cleanup(api.auth.currentUser || null);
    });
    if(timeoutMs){
      timer = setTimeout(()=>cleanup(api.auth.currentUser || null), timeoutMs);
    }
  });
}

async function restoreFromCloud(){
  const api = window.firebaseApi;
  if(!api?.auth || !api?.db || !api?.doc || !api?.getDoc){
    alert('Firebase is not available. Please log in first.');
    return;
  }
  const { user, username } = await resolveAuthenticatedIdentity('restore', { usernameHint: state.username });
  if(!user || !username){
    alert('Please log in before restoring.');
    return;
  }
  if(!confirm('Restore from cloud? This will overwrite your local wizard data for your account.')){
    return;
  }
  try{
    const uid = user.uid;
    const docType = state.docType || sessionBootstrap?.docType || envWizardBootstrap?.docType || 'invoice';
    const wizardId = currentWizardId?.() || state.activeWizardId || DEFAULT_WIZARD_ID;
    const safeWizardId = wizardId || DEFAULT_WIZARD_ID;
    const ref = api.doc(api.db, 'Users', uid, 'Accounts', username, 'Backups', 'manual');
    const snap = await api.getDoc(ref);
    if(!snap.exists()){
      alert('No backup found for this user.');
      return;
    }
    const data = snap.data();
    const payload = data?.payload;
    if(!payload){
      alert('Backup is empty or invalid.');
      return;
    }
    applyRestorePayload(payload);
    alert('Restore completed.');
  } catch(err){
    console.error('[restore] failed', err);
    alert(err?.message || 'Restore failed. Please try again.');
  }
}

function setupAuthStateListener(){
  const api = window.firebaseApi;
  if (!api?.onAuthStateChanged || !api?.auth) return false;
  api.onAuthStateChanged(api.auth, async (user) => {
    if (user) {
      const confirmedUser = await confirmAuthenticatedUser('auth-listener', { requireAuth: true });
      if(!confirmedUser?.uid){
        logAuthGate('blocked', { action: 'auth-listener', reason: 'no-confirmed-user' });
        return;
      }
      const username = await resolveUsernameForUser(confirmedUser);
      if (!username) {
        console.warn('[auth] username mapping missing; skipping auto-login');
        return;
      }
      const docType = state.docType || sessionBootstrap?.docType || envWizardBootstrap?.docType || 'invoice';
      const wizardId = sessionBootstrap?.wizardId || envWizardBootstrap?.wizardId || state.activeWizardId || '';
      await enterAppWithAuth({ username, docType, wizardId }, { reason: 'auth-listener' });
    } else if (isSkinV2) {
      loginHydrated = false;
      showLoginUi();
    }
  });
  return true;
}
const authListenerReady = setupAuthStateListener();

if(isSkinV2){
  (async ()=>{
    const autoUser = envWizardBootstrap?.username || sessionBootstrap?.username || '';
    const autoDocType = envWizardBootstrap?.docType || sessionBootstrap?.docType || state.docType;
    const autoWizardId = sessionBootstrap?.wizardId || envWizardBootstrap?.wizardId || '';
    if(autoUser){
      await enterAppWithAuth({ username: autoUser, docType: autoDocType, wizardId: autoWizardId }, { reason: 'session-bootstrap', silent: true });
    } else if(!authListenerReady) {
      showLoginUi();
    }
  })();
}
async function waitForSignOut(api){
  if(!api?.onAuthStateChanged || !api?.auth) return;
  if(!api.auth.currentUser) return;
  await new Promise((resolve)=>{
    let timer = setTimeout(()=>cleanup(), 3000);
    let unsubscribe = ()=>{};
    const cleanup = ()=>{
      clearTimeout(timer);
      try { unsubscribe?.(); } catch(err){ console.warn('[logout] unsubscribe failed', err); }
      resolve();
    };
    unsubscribe = api.onAuthStateChanged(api.auth, (user)=>{
      if(user) return;
      cleanup();
    }, (err)=>{
      console.warn('[logout] onAuthStateChanged failed', err);
      cleanup();
    });
  });
}

function clearLoginSession(){
  loginHydrated = false;
  showLoginUi();
  state.activeWizardId = isSkinV2 ? '' : DEFAULT_WIZARD_ID;
  state.profile = null;
  try { window.SessionStore?.clearActiveSession?.(); } catch(err){ console.warn('[session] clear failed', err); }
}

els.logoutBtn?.addEventListener('click', async ()=>{
  const api = window.firebaseApi;
  if(api?.signOut && api?.auth){
    try {
      await api.signOut(api.auth);
      await waitForSignOut(api);
    } catch(err){
      console.warn('[logout] signOut failed', err);
    }
  }
  clearLoginSession();
  window.location.replace('https://wrokit.com');
});
els.resetModelBtn?.addEventListener('click', ()=>{
  const msg = 'Are you sure? This will wipe ALL wizard data (templates, models, and extracted records) site-wide. Only use if needed.';
  if(!confirm(msg)) return;
  wipeAllWizardData();
  alert('All wizard data cleared. Please create or select a wizard in Wizard Manager.');
  showWizardManagerTab();
});
els.backupCloudBtn?.addEventListener('click', backupToCloud);
els.restoreCloudBtn?.addEventListener('click', restoreFromCloud);
function openBuilderFromSelection(){
  const val = modelSelect?.value || '';
  const templateId = val.startsWith('custom:') ? val.replace('custom:','') : (isSkinV2 ? state.activeWizardId : '');
  if(templateId){ state.activeWizardId = templateId; }
  const template = templateId ? getWizardTemplateById(templateId) : null;
  openBuilder(template);
}

function openNewWizardFromDashboard(){
  if(isSkinV2){
    showWizardManagerTab();
    openBuilder(null);
    return;
  }
  configureSelectedWizard();
}

function configureSelectedWizard(){
  const selection = modelSelect?.value || DEFAULT_WIZARD_ID;
  if(selection === DEFAULT_WIZARD_ID){
    state.activeWizardId = DEFAULT_WIZARD_ID;
  } else if(selection.startsWith('custom:')){
    state.activeWizardId = selection.replace('custom:','');
  } else if(selection.startsWith('model:')){
    const loaded = loadModelById(selection.replace('model:',''));
    state.activeWizardId = loaded?.wizardId || DEFAULT_WIZARD_ID;
  }
  ensureProfile();
  activateConfigMode();
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  clearConfigResultsUi({ preserveProfileJson: true });
}

if (els.configureBtn) {
  if (isSkinV2) {
    els.configureBtn.addEventListener('click', openNewWizardFromDashboard);
  } else {
    els.configureBtn.addEventListener('click', configureSelectedWizard);
  }
}
els.demoBtn?.addEventListener('click', ()=> els.wizardFile.click());
els.staticDebugBtn?.addEventListener('click', showStaticDebugModal);
els.staticDebugClose?.addEventListener('click', hideStaticDebugModal);
els.staticDebugRefresh?.addEventListener('click', renderStaticDebugLogs);
els.staticDebugClear?.addEventListener('click', ()=>{ window.clearStaticDebugLogs?.(); renderStaticDebugLogs(); });
els.staticDebugCopy?.addEventListener('click', ()=>{
  if(!els.staticDebugText) return;
  const txt = els.staticDebugText.value || '';
  if(!txt) return;
  if(window.navigator?.clipboard?.writeText){
    window.navigator.clipboard.writeText(txt);
  } else {
    const ta=document.createElement('textarea');
    ta.value=txt; document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); }catch(err){}
    document.body.removeChild(ta);
  }
});
els.staticDebugToggle?.addEventListener('change', ()=>{
  const enabled = !!els.staticDebugToggle.checked;
  window.DEBUG_STATIC_FIELDS = enabled;
  DEBUG_STATIC_FIELDS = enabled;
  window.__DEBUG_OCRMAGIC__ = enabled;
  DEBUG_OCRMAGIC = enabled;
  persistStaticDebugPref(enabled);
});
els.staticDebugDownload?.addEventListener('click', downloadStaticDebugLogs);
syncStaticDebugToggleUI();

els.docType?.addEventListener('change', ()=>{
  state.docType = els.docType.value || 'invoice';
  refreshWizardTemplates();
  if(isSkinV2){
    state.activeWizardId = requireCustomWizard({ allowTemplateFallback: true, promptBuilder: false }) || firstCustomWizardId();
    if(!state.activeWizardId){
      showWizardManagerTab();
    }
  } else {
    state.activeWizardId = DEFAULT_WIZARD_ID;
  }
  const wizardId = state.activeWizardId || (isSkinV2 ? '' : currentWizardId());
  const existing = wizardId ? loadProfile(state.username, state.docType, wizardId, state.activeGeometryId || DEFAULT_GEOMETRY_ID) : null;
  state.profile = existing || null;
  hydrateFingerprintsFromProfile(state.profile);
  renderSavedFieldsTable();
  if(isSkinV2 && els.app){
    els.app.style.display = 'block';
  }
  populateModelSelect(isSkinV2 && state.activeWizardId ? `custom:${state.activeWizardId}` : undefined);
  logWizardSelection('docType-change', resolveSelectedWizardContext());
});

els.configureCustomBtn?.addEventListener('click', openNewWizardFromDashboard);
els.builderAddFieldBtn?.addEventListener('click', addBuilderField);
els.builderSaveBtn?.addEventListener('click', saveBuilderTemplate);
els.builderCancelBtn?.addEventListener('click', ()=>{ resetBuilderErrors(); closeBuilder(); });
els.wizardManagerNewBtn?.addEventListener('click', ()=>{ state.activeWizardId = ''; openBuilder(null); });
els.wizardManagerImportBtn?.addEventListener('click', ()=>{ els.wizardDefinitionImportInput?.click(); });
els.wizardExportDescription?.addEventListener('input', enforceWizardExportWordLimit);
els.wizardExportCancelBtn?.addEventListener('click', ()=>{ showTab('document-dashboard'); });
els.wizardExportConfirmBtn?.addEventListener('click', confirmWizardExport);
els.wizardDefinitionImportInput?.addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  if(!file) return;
  try{
    const text = await file.text();
    const json = JSON.parse(text);
    importWizardDefinition(json);
  } catch(err){
    console.error('[import] failed', err);
    alert('Failed to import wizard definition.');
  } finally {
    e.target.value = '';
  }
});

els.dataWizardSelect?.addEventListener('change', ()=>{
  const selected = els.dataWizardSelect.selectedOptions?.[0];
  const nextWizardId = els.dataWizardSelect.value || '';
  const nextDocType = selected?.dataset.docType || getWizardDocType(nextWizardId) || state.docType;
  state.extractedWizardId = nextWizardId;
  state.extractedWizardDocType = nextDocType;
  persistExtractedWizardSelection(nextWizardId, nextDocType);
  syncExtractedWizardSelector(nextWizardId);
  state.selectedRunId = '';
  renderResultsTable();
  renderReports();
});
els.showRawToggle?.addEventListener('change', ()=>{ renderResultsTable(); });
els.rawDataToggle?.addEventListener('change', ()=>{
  state.modes.rawData = !!els.rawDataToggle.checked;
  syncRawModeUI();
});
els.rawDataBtn?.addEventListener('click', ()=>{
  state.modes.rawData = !state.modes.rawData;
  if(els.rawDataToggle) els.rawDataToggle.checked = state.modes.rawData;
  syncRawModeUI();
});

const modelSelect = document.getElementById('model-select');
if(modelSelect){
  modelSelect.addEventListener('change', ()=>{
    const val = modelSelect.value;
    let selectionLogged = false;
    if(!val){
      if(isSkinV2){
        alert('Select an existing wizard to run or create one in Wizard Manager.');
        showWizardManagerTab();
        populateModelSelect(undefined);
        selectionLogged = true;
      }
    } else if(val === DEFAULT_WIZARD_ID){
      if(isSkinV2){
        alert('Please create or choose a custom wizard in Wizard Manager.');
        showWizardManagerTab();
        populateModelSelect(undefined);
      } else {
        state.activeWizardId = DEFAULT_WIZARD_ID;
        state.activeGeometryId = DEFAULT_GEOMETRY_ID;
        state.profile = loadProfile(state.username, state.docType, currentWizardId(), state.activeGeometryId);
        hydrateFingerprintsFromProfile(state.profile);
        alert('Default wizard selected.');
      }
    } else if(val.startsWith('custom:')){
      state.activeWizardId = val.replace('custom:','');
      state.activeGeometryId = DEFAULT_GEOMETRY_ID;
      state.profile = loadProfile(state.username, state.docType, currentWizardId(), state.activeGeometryId);
      hydrateFingerprintsFromProfile(state.profile);
      if(isSkinV2){
        populateModelSelect(`custom:${state.activeWizardId}`);
      }
      alert('Custom wizard selected for run. Edit in Wizard Manager.');
    } else if(val.startsWith('model:')){
      const loaded = loadModelById(val.replace('model:',''));
      if(loaded?.wizardId){
        state.activeWizardId = loaded.wizardId;
      } else if(isSkinV2){
        state.activeWizardId = requireCustomWizard({ allowTemplateFallback: true, promptBuilder: false }) || state.activeWizardId || firstCustomWizardId();
        if(!state.activeWizardId){
          showWizardManagerTab();
        }
        populateModelSelect(state.activeWizardId ? `custom:${state.activeWizardId}` : undefined);
      }
      activateRunMode({ clearDoc: true });
      renderSavedFieldsTable();
      renderConfirmedTables();
      renderResultsTable();
      alert('Model selected. Drop files to auto-extract.');
    }
    if(!selectionLogged){
      logWizardSelection('change', resolveSelectedWizardContext());
    }
  });
}

// Batch dropzone (dashboard)
// ===== File normalization for drag/drop and input =====
function toFilesList(evt) {
  const files = [];
  if (evt?.dataTransfer?.items?.length) {
    for (const it of evt.dataTransfer.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  } else if (evt?.dataTransfer?.files?.length) {
    return Array.from(evt.dataTransfer.files);
  }
  return files;
}

// Dropzone
['dragover','dragleave','drop'].forEach(evtName => {
  els.dropzone?.addEventListener(evtName, (e)=>{
    e.preventDefault();
    if (evtName==='dragover') els.dropzone.classList.add('dragover');
    if (evtName==='dragleave') els.dropzone.classList.remove('dragover');
    if (evtName==='drop') {
      els.dropzone.classList.remove('dragover');
      const files = toFilesList(e);
      if (files.length) processBatch(files);
    }
  });
});

// File input
els.fileInput?.addEventListener('change', e=>{
  const files = Array.from(e.target.files || []);
  if (files.length) processBatch(files);
});

els.showBoxesToggle?.addEventListener('change', ()=>{ markSnapshotsDirty(); drawOverlay(); });
els.showRingToggles.forEach(t => t.addEventListener('change', ()=>{ markSnapshotsDirty(); drawOverlay(); }));
els.showMatchToggles.forEach(t => t.addEventListener('change', ()=>{ markSnapshotsDirty(); drawOverlay(); }));
els.showOcrBoxesToggle?.addEventListener('change', ()=>{ markSnapshotsDirty(); drawOverlay(); });
els.snapshotModeToggle?.addEventListener('change', ()=>{ setSnapshotMode(!!els.snapshotModeToggle.checked); });
els.viewSnapshotBtn?.addEventListener('click', ()=>{ openSnapshotPanel(false); });
els.regenerateSnapshotBtn?.addEventListener('click', ()=>{ openSnapshotPanel(true); });
els.closeSnapshotBtn?.addEventListener('click', closeSnapshotPanel);

async function handleWizardFileChange(e){
  const f = e.target.files?.[0]; if(!f) return;
  if(isRunMode()){
    let runCtx;
    try{
      runCtx = resolveRunWizardContext({ profileOverride: state.profile });
    } catch(err){
      console.error('Run mode aborted: wizard selection missing', err);
      alert(err?.message || 'Select a wizard before running extraction.');
      return;
    }
    state.activeWizardId = runCtx.wizardId;
    state.profile = runCtx.profile || state.profile;
    activateRunMode({ clearDoc: true });
    els.app.style.display = 'none';
    els.wizardSection.style.display = 'block';
    ensureProfile(runCtx.wizardId);
    logWizardSelection('run.start.single', { ...runCtx, value: runCtx.selectionValue });
    await runModeExtractFileWithProfile(f, state.profile, runCtx);
    renderSavedFieldsTable();
    renderConfirmedTables();
    return;
  }
  await openFile(f);
}

// Single-file open (wizard)
els.wizardFile?.addEventListener('change', handleWizardFileChange);

// Paging
els.prevPageBtn?.addEventListener('click', ()=>{
  if(state.pageNum<=1) return;
  state.pageNum--; state.viewport = state.pageViewports[state.pageNum-1];
  updatePageIndicator();
  els.viewer?.scrollTo({ top: state.pageOffsets[state.pageNum-1], behavior: 'smooth' });
  drawOverlay();
});
els.nextPageBtn?.addEventListener('click', ()=>{
  if(state.pageNum>=state.numPages) return;
  state.pageNum++; state.viewport = state.pageViewports[state.pageNum-1];
  updatePageIndicator();
  els.viewer?.scrollTo({ top: state.pageOffsets[state.pageNum-1], behavior: 'smooth' });
  drawOverlay();
});

// Clear selection
els.clearSelectionBtn?.addEventListener('click', ()=>{
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; state.snappedLineMetrics = null; drawOverlay();
});

els.backBtn?.addEventListener('click', ()=>{
  const prevIdx = Math.max(0, state.stepIdx - 1);
  if(state.wizardComplete || state.stepIdx !== prevIdx){
    goToStep(prevIdx);
  }
});

els.skipBtn?.addEventListener('click', ()=>{
  if(state.stepIdx < state.steps.length - 1) goToStep(state.stepIdx + 1);
  else finishWizard();
});

// Confirm → extract + save + insert record, advance step
els.confirmBtn?.addEventListener('click', async ()=>{
  if(state.wizardComplete){
    saveWizardAndReturn();
    return;
  }
  if(!state.snappedPx){ alert('Draw a box first.'); return; }
  const tokens = await ensureTokensForPage(state.pageNum);
  const step = state.steps[state.stepIdx] || DEFAULT_FIELDS[state.stepIdx] || DEFAULT_FIELDS[0];

  const isAreaStep = !!step.isArea;
  const areaKey = step.areaId || (isAreaStep ? (step.fieldKey || step.fieldId) : null) || step.fieldKey;

  let value = '', boxPx = state.snappedPx;
  let confidence = 0, raw = '', corrections=[];
  let fieldTokens = [];
  if(step.kind === 'landmark'){
    value = (state.snappedText || '').trim();
    raw = value;
  } else if (step.type === 'static' && !isAreaStep){
    const res = await extractFieldValue(step, tokens, state.viewport);
    value = res.value;
    if(!value && state.snappedText){
      bumpDebugBlank();
      value = (state.snappedText || '').trim();
    }
    boxPx = res.boxPx || state.snappedPx;
    confidence = res.confidence || 0;
    raw = res.raw || (state.snappedText || '').trim();
    corrections = res.correctionsApplied || res.corrections || [];
    fieldTokens = res.tokens || [];
  } else if (step.kind === 'block' && !isAreaStep){
    value = (state.snappedText || '').trim();
    raw = value;
  } else if(!isAreaStep){
    const res = await extractFieldValue(step, tokens, state.viewport);
    value = res.value;
    if(!value && state.snappedText){
      bumpDebugBlank();
      value = (state.snappedText || '').trim();
    }
    boxPx = res.boxPx || state.snappedPx;
    confidence = res.confidence || 0;
    raw = res.raw || (state.snappedText || '').trim();
    corrections = res.correctionsApplied || res.corrections || [];
    fieldTokens = res.tokens || [];
  }

  const storedBoxPx = (isConfigMode() && step.type === 'static' && state.selectionPx)
    ? (state.selectionPx || boxPx)
    : boxPx;
  if(!isAreaStep && els.ocrToggle?.checked){
    try { await auditCropSelfTest(step.fieldKey || step.prompt || 'question', storedBoxPx || boxPx); }
    catch(err){ console.error('auditCropSelfTest failed', err); }
  }

  const vp = state.pageViewports[state.pageNum-1] || state.viewport || {width:1,height:1};
  const canvasW = (vp.width ?? vp.w) || 1;
  const canvasH = (vp.height ?? vp.h) || 1;
  const normBox = normalizeBox(storedBoxPx, canvasW, canvasH);
  const pct = { x0: normBox.x0n, y0: normBox.y0n, x1: normBox.x0n + normBox.wN, y1: normBox.y0n + normBox.hN };
  const rawBoxData = { x: storedBoxPx.x, y: storedBoxPx.y, w: storedBoxPx.w, h: storedBoxPx.h, canvasW, canvasH };
  const keywordRelations = (step.type === 'static')
    ? computeKeywordRelationsForConfig(step.fieldKey, storedBoxPx, normBox, state.pageNum, canvasW, canvasH)
    : null;
  const pageTokens = state.tokensByPage[state.pageNum] || tokens || [];
  const keywordConstellation = (step.type === 'static' && KeywordConstellation?.captureConstellation)
    ? KeywordConstellation.captureConstellation(step.fieldKey, storedBoxPx, normBox, state.pageNum, canvasW, canvasH, pageTokens, {})
    : null;
  const extras = {};
  const areaBoxForStep = isAreaStep
    ? { areaId: areaKey || step.fieldKey, bboxPct: pct, normBox, page: state.pageNum, rawBox: rawBoxData }
    : getAreaSelection(areaKey);
  if(step.type === 'static'){
    const lm = captureRingLandmark(storedBoxPx);
    lm.anchorHints = ANCHOR_HINTS[step.fieldKey] || [];
    extras.landmark = lm;
    if(state.snappedLineMetrics){
      extras.lineMetrics = clonePlain(state.snappedLineMetrics);
    }
    extras.keywordRelations = keywordRelations || null;
    extras.keywordConstellation = keywordConstellation || null;
  } else if(step.type === 'column'){
    extras.column = buildColumnModel(step, pct, boxPx, tokens);
  }
  if(isAreaStep && areaBoxForStep){
    extras.areaBox = areaBoxForStep;
    setAreaSelection(areaKey, areaBoxForStep);
  } else if(step.areaId && areaBoxForStep){
    extras.areaBox = areaBoxForStep;
    const relativeBox = computeAreaRelativeBox(areaBoxForStep.bboxPct, pct);
    if(relativeBox){ extras.areaRelativeBox = relativeBox; }
  }
  if(isAreaStep && areaBoxForStep){
    const areaFingerprint = buildAreaFingerprint(areaBoxForStep, tokens, canvasW, canvasH);
    if(areaFingerprint){
      extras.areaFingerprint = areaFingerprint;
      if(areaFingerprint.areaConstellation){
        extras.areaConstellation = clonePlain(areaFingerprint.areaConstellation);
      }
    }
  }
  upsertFieldInProfile(step, normBox, value, confidence, state.pageNum, extras, raw, corrections, fieldTokens, rawBoxData);
  ensureAnchorFor(step.fieldKey);
  state.currentLineItems = await extractLineItems(state.profile);

  const fid = state.currentFileId;
  if(fid && !isAreaStep){
    const rec = { fieldKey: step.fieldKey, raw, value, confidence, correctionsApplied: corrections, page: state.pageNum, bboxPct: pct, ts: Date.now(), tokens: fieldTokens };
    rawStore.upsert(fid, rec);
    compileDocument(fid, state.currentLineItems);
  }
  renderSavedFieldsTable();

  afterConfirmAdvance();
});

// Export JSON (profile)
els.exportBtn?.addEventListener('click', ()=>{
  ensureProfile();
  const blob = new Blob([serializeProfile(state.profile)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `invoice-schema-${state.username}-${state.docType}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

function resolveRecordForDocType(docType, preferred){
  const ctx = resolveExtractedWizardContext();
  const dt = docType || ctx.docType;
  const wizardId = ctx.wizardId;
  if(preferred) return { record: preferred, dt, wizardId };
  const db = LS.getDb(state.username, dt, wizardId);
  if(!db.length) return { record: null, dt };
  const selected = state.selectedRunId ? db.find(r => r.fileId === state.selectedRunId) : null;
  return { record: selected || db[0], dt, wizardId };
}

function downloadMasterDb(record, docType){
  const ctx = resolveExtractedWizardContext();
  const dt = docType || ctx.docType;
  const wizardId = ctx.wizardId;
  const payload = getOrHydrateMasterRows(state.username, dt, wizardId);
  if(!payload.rows.length){
    alert('No MasterDB rows available for export.');
    return;
  }
  try {
    const csv = MasterDB.toCsvRows(payload);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `masterdb-${state.username}-${dt}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(err){
    console.error('MasterDB export failed', err);
    alert(err?.message || 'Failed to export MasterDB CSV');
  }
}

function downloadMissingCells(record, docType){
  const { record: target, dt } = resolveRecordForDocType(docType, record);
  if(!target){
    alert('No extraction record available for export.');
    return;
  }
  try {
    const { missingMap } = MasterDB.flatten(target);
    const json = JSON.stringify(missingMap, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `masterdb-missing-${state.username}-${dt}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(err){
    console.error('Missing cell export failed', err);
    alert(err?.message || 'Failed to export missing-cell diagnostics');
  }
}

// Export flat Master Database CSV
els.exportMasterDbBtn?.addEventListener('click', ()=> downloadMasterDb(state.savedFieldsRecord));
els.exportMasterDbDataBtn?.addEventListener('click', ()=> downloadMasterDb());
els.exportMissingBtn?.addEventListener('click', ()=> downloadMissingCells(state.savedFieldsRecord));
els.finishWizardBtn?.addEventListener('click', ()=>{
  saveWizardAndReturn();
});

function normalizePayloadForLog(payload){
  if(payload instanceof Map){
    return Object.fromEntries(Array.from(payload.entries()).map(([k,v]) => [k, normalizePayloadForLog(v)]));
  }
  if(Array.isArray(payload)) return payload.map(normalizePayloadForLog);
  if(payload && typeof payload === 'object'){
    return Object.fromEntries(Object.entries(payload).map(([k,v]) => [k, normalizePayloadForLog(v)]));
  }
  return payload;
}

function snapshotProfileGeometry(profile){
  const fields = Array.isArray(profile?.fields) ? profile.fields : [];
  const staticFields = fields.filter(f => (f.type || f.fieldType || 'static') === 'static');
  const toNormBox = (field) => {
    if(field?.normBox){
      const nb = field.normBox;
      const x0 = Number.isFinite(nb.x0n) ? nb.x0n : Number.isFinite(nb.x0) ? nb.x0 : null;
      const y0 = Number.isFinite(nb.y0n) ? nb.y0n : Number.isFinite(nb.y0) ? nb.y0 : null;
      const w = Number.isFinite(nb.wN) ? nb.wN : Number.isFinite(nb.w) ? nb.w : null;
      const h = Number.isFinite(nb.hN) ? nb.hN : Number.isFinite(nb.h) ? nb.h : null;
      if([x0,y0,w,h].every(v => typeof v === 'number' && Number.isFinite(v))){
        return { x0, y0, x1: x0 + w, y1: y0 + h };
      }
    }
    if(field?.bboxPct){
      const { x0, y0, x1, y1 } = field.bboxPct;
      if([x0,y0,x1,y1].every(v => typeof v === 'number' && Number.isFinite(v))){
        return { x0, y0, x1, y1 };
      }
    }
    if(Array.isArray(field?.bbox) && field.bbox.length === 4){
      const [x0, y0, x1, y1] = field.bbox;
      if([x0,y0,x1,y1].every(v => typeof v === 'number' && Number.isFinite(v))){
        return { x0, y0, x1, y1 };
      }
    }
    return null;
  };
  const toPxBox = (field) => {
    if(field?.boxPx){
      const { x, y, w, h, page } = field.boxPx;
      if([x,y,w,h].every(v => typeof v === 'number' && Number.isFinite(v))){
        return { x, y, w, h, page: page ?? (field.page ?? (Number.isFinite(field.pageIndex) ? field.pageIndex + 1 : null)) };
      }
    }
    if(field?.rawBox){
      const { x, y, w, h, page } = field.rawBox;
      if([x,y,w,h].every(v => typeof v === 'number' && Number.isFinite(v))){
        return { x, y, w, h, page: page ?? (field.page ?? (Number.isFinite(field.pageIndex) ? field.pageIndex + 1 : null)) };
      }
    }
    return null;
  };
  const snapshotFields = staticFields.map(f => {
    const normBox = toNormBox(f);
    const pxBox = toPxBox(f);
    return {
      fieldKey: f.fieldKey,
      page: f.page ?? (Number.isFinite(f.pageIndex) ? f.pageIndex + 1 : null),
      hasNormBox: !!normBox,
      normBox,
      hasPxBox: !!pxBox,
      pxBox
    };
  });
  return { fieldCount: snapshotFields.length, fields: snapshotFields };
}

function countGeom(snapshot){
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  let norm = 0, px = 0;
  fields.forEach(f => {
    if(f?.hasNormBox) norm += 1;
    if(f?.hasPxBox) px += 1;
  });
  return { total: fields.length, norm, px };
}

function diffGeom(prev, next){
  const prevSnap = prev || { fields: [] };
  const nextSnap = next || { fields: [] };
  const prevCounts = countGeom(prevSnap);
  const nextCounts = countGeom(nextSnap);
  const prevMap = new Map((Array.isArray(prevSnap.fields) ? prevSnap.fields : []).map(f => [f.fieldKey, f]));
  const nextMap = new Map((Array.isArray(nextSnap.fields) ? nextSnap.fields : []).map(f => [f.fieldKey, f]));
  const lostFields = [];
  const lostNormFields = [];
  const lostPxFields = [];
  for(const [key, prevField] of prevMap.entries()){
    const nextField = nextMap.get(key);
    if(!nextField){
      lostFields.push(key);
      if(prevField?.hasNormBox) lostNormFields.push(key);
      if(prevField?.hasPxBox) lostPxFields.push(key);
      continue;
    }
    if(prevField?.hasNormBox && !nextField?.hasNormBox) lostNormFields.push(key);
    if(prevField?.hasPxBox && !nextField?.hasPxBox) lostPxFields.push(key);
  }
  return {
    prev: prevCounts,
    next: nextCounts,
    delta: {
      total: nextCounts.total - prevCounts.total,
      norm: nextCounts.norm - prevCounts.norm,
      px: nextCounts.px - prevCounts.px
    },
    lostFields,
    lostNormFields,
    lostPxFields,
    geometryDropped: (nextCounts.norm < prevCounts.norm) || (nextCounts.px < prevCounts.px)
  };
}

function traceSnapshot(tag, ctx={}){
  const wizardId = ctx.wizardId ?? currentWizardId();
  const username = ctx.username ?? state.username ?? null;
  const docType = ctx.docType ?? state.docType ?? null;
  const profileKey = ctx.profileKey ?? (LS?.profileKey ? LS.profileKey(username, docType, wizardId) : null);
  const snapshot = ctx.snapshot || snapshotProfileGeometry(ctx.profile || state.profile);
  const previousSnapshot = ctx.previousSnapshot || null;
  const payload = {
    tag,
    stage: ctx.stage || tag,
    mode: ctx.mode || (isRunMode() ? 'run' : 'config'),
    username,
    docType,
    wizardId,
    profileKey,
    note: ctx.note || undefined,
    snapshot
  };
  if(previousSnapshot){
    const diff = diffGeom(previousSnapshot, snapshot);
    payload.previousCounts = countGeom(previousSnapshot);
    payload.diff = diff;
  }
  console.info('[flight-recorder]', JSON.stringify(payload));
  if(previousSnapshot){
    const delta = payload.diff || diffGeom(previousSnapshot, snapshot);
    if(delta.geometryDropped){
      console.warn('[GEOM_DROPPED]', JSON.stringify({ tag, stage: payload.stage, wizardId, profileKey, delta }));
    }
  }
  return snapshot;
}

function hasFieldGeometry(field){
  if(!field || typeof field !== 'object') return false;
  return !!(field.normBox || field.bboxPct || field.bbox || field.boxPx || field.rawBox || field.staticGeom || field.configBox);
}

function ensureConfiguredFlag(profile){
  if(!profile || typeof profile !== 'object') return profile;
  const hasGeom = Array.isArray(profile.fields) ? profile.fields.some(hasFieldGeometry) : false;
  if(profile.isConfigured === undefined){
    profile.isConfigured = hasGeom;
  } else if(hasGeom && !profile.isConfigured){
    profile.isConfigured = true;
  }
  return profile;
}

function profileGeometrySnapshot(profile){
  const fields = Array.isArray(profile?.fields) ? profile.fields : [];
  return {
    keys: profile ? Object.keys(profile) : [],
    fieldCount: fields.length,
    fields: fields.map(f => ({
      key: f.fieldKey,
      page: f.page ?? (Number.isFinite(f.pageIndex) ? f.pageIndex + 1 : null),
      hasNormBox: !!(f.normBox || f.bboxPct),
      hasBBox: Array.isArray(f.bbox) && f.bbox.length === 4,
      hasBoxPx: !!f.boxPx,
      hasRawBox: !!f.rawBox,
      hasStaticGeom: !!f.staticGeom
    }))
  };
}

function mergeProfileGeometry(preferred, fallback){
  if(!preferred && !fallback) return null;
  if(!preferred) return fallback;
  if(!fallback) return preferred;
  const preferredFields = Array.isArray(preferred.fields) ? preferred.fields : [];
  const fallbackFields = Array.isArray(fallback.fields) ? fallback.fields : [];
  if(!preferredFields.length && fallbackFields.length){
    return { ...fallback, ...preferred, fields: fallbackFields };
  }
  const fallbackByKey = new Map(fallbackFields.map(f => [f.fieldKey, f]));
  const mergedMap = new Map();
  preferredFields.forEach(f => {
    const donor = fallbackByKey.get(f.fieldKey);
    const preferredHasGeom = hasFieldGeometry(f);
    const donorHasGeom = hasFieldGeometry(donor);
    if(!donor || preferredHasGeom){
      mergedMap.set(f.fieldKey, f);
      return;
    }
    // If the preferred field is missing geometry but the stored (donor) field has it,
    // keep the donor geometry and overlay non-geometry props from the preferred field.
    if(donorHasGeom && !preferredHasGeom){
      const merged = { ...donor, ...f };
      mergedMap.set(merged.fieldKey, merged);
      return;
    }
    const merged = { ...f };
    ['normBox','bbox','bboxPct','boxPx','rawBox','configBox','staticGeom','anchorMetrics','page','pageIndex','pageRole','verticalAnchor','anchor','configMask'].forEach(k => {
      if(merged[k] === undefined && donor[k] !== undefined) merged[k] = donor[k];
    });
    mergedMap.set(merged.fieldKey, merged);
  });
  fallbackFields.forEach(f => {
    if(!mergedMap.has(f.fieldKey)){
      mergedMap.set(f.fieldKey, f);
    }
  });
  return { ...fallback, ...preferred, fields: Array.from(mergedMap.values()) };
}

function scanWizardStorageKeys(wizardId){
  if(typeof localStorage === 'undefined' || !wizardId) return [];
  const matches = [];
  for(let i=0;i<localStorage.length;i++){
    const key = localStorage.key(i);
    if(!key || !key.includes(wizardId)) continue;
    const entry = { key, hasGeometry:false, fieldCount:null, parseError:null };
    try{
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw, jsonReviver) : null;
      const fields = Array.isArray(parsed?.fields) ? parsed.fields : null;
      entry.fieldCount = fields ? fields.length : null;
      entry.hasGeometry = !!(fields && fields.some(hasFieldGeometry));
    } catch(err){
      entry.parseError = err?.message || String(err);
    }
    matches.push(entry);
  }
  return matches;
}

function probeTypeHint(field){
  const hintRaw = (field?.magicDataType || field?.magicType || '').toLowerCase();
  const key = (field?.fieldKey || '').toLowerCase();
  if(hintRaw.includes('date') || key.includes('date')) return 'date';
  if(hintRaw.includes('currency') || hintRaw.includes('money') || /total|amount|tax|subtotal/.test(key)) return 'money';
  if(hintRaw.includes('number') || hintRaw.includes('numeric') || key.includes('qty') || key.includes('quantity')) return 'number';
  return '';
}

function pickProbeFields(profile){
  const fields = Array.isArray(profile?.fields) ? profile.fields : [];
  const globals = fields.filter(f => f.type === 'static' && !f.isArea && !f.isSubordinate);
  const typed = globals.filter(f => !!probeTypeHint(f));
  const seen = new Set();
  const ordered = [...typed, ...globals].filter(f => {
    if(!f?.fieldKey || seen.has(f.fieldKey)) return false;
    seen.add(f.fieldKey);
    return true;
  });
  return ordered.slice(0, 3);
}

function probeValuePlausibility(value, hint){
  const text = (value || '').trim();
  if(!text) return false;
  const hasDigit = /\d/.test(text);
  if(!hasDigit) return false;
  if(hint === 'date'){
    const hasSeparator = /[\/\-\s]/.test(text);
    return (hasSeparator && hasDigit) || RE.date.test(text);
  }
  if(hint === 'money'){
    return /\d[\d,\.\s-]*/.test(text) || RE.currency.test(text);
  }
  if(hint === 'number') return /[-+]?\d/.test(text);
  return true;
}

function runGeometryProbe(profile){
  const probeFields = pickProbeFields(profile);
  if(!probeFields.length) return { pass: false, results: [] };
  const results = probeFields.map(spec => {
    const placement = resolveStaticPlacement(spec, state.pageViewports, state.numPages);
    const targetPage = placement?.pageNumber ? clamp(placement.pageNumber, 1, state.numPages || 1) : 1;
    const tokens = state.tokensByPage[targetPage] || [];
    const text = placement?.boxPx ? tokensInBox(tokens, placement.boxPx, { minOverlap: 0 }).map(t => t.text).join(' ').trim() : '';
    const hint = probeTypeHint(spec);
    const plausible = probeValuePlausibility(text, hint);
    return { fieldKey: spec.fieldKey, value: text, hint, plausible };
  });
  const plausibleCount = results.filter(r => r.value && r.plausible).length;
  const needed = results.length >= 3 ? 2 : 1;
  const pass = results.length > 0 && plausibleCount >= needed;
  return { pass, results };
}

function geometrySizeDistance(targetSize, currentSize){
  const tW = targetSize?.pageWidthPx || targetSize?.width || targetSize?.w || 0;
  const tH = targetSize?.pageHeightPx || targetSize?.height || targetSize?.h || 0;
  const cW = currentSize?.pageWidthPx || currentSize?.w || currentSize?.width || 0;
  const cH = currentSize?.pageHeightPx || currentSize?.h || currentSize?.height || 0;
  if(tW && tH && cW && cH){
    return Math.abs(tW - cW) + Math.abs(tH - cH);
  }
  const tA = targetSize?.aspect;
  const cA = currentSize?.aspect || (cH ? cW / cH : null);
  if(tA && cA){
    return Math.abs(tA - cA);
  }
  return Number.POSITIVE_INFINITY;
}

function selectGeometryForRun({ wizardId, docType, geometryIds, preferredGeometryId }){
  const candidates = geometryIds.map(gid => ({
    geometryId: gid,
    profile: loadProfile(state.username, docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid)
  })).filter(c => !!c.profile);
  if(candidates.length <= 1){
    return { winner: candidates[0] || null, probePassed: true };
  }
  const currentSize = geometryPageSizeFromState();
  const ranked = candidates.map(c => ({
    ...c,
    sizeDistance: geometrySizeDistance(c.profile?.geometry?.pageSize, currentSize)
  })).sort((a,b)=> (a.sizeDistance - b.sizeDistance));
  for(const cand of ranked){
    const probe = runGeometryProbe(cand.profile);
    if(probe.pass){
      return { winner: cand, probePassed: true, probe };
    }
  }
  return { winner: ranked[0] || null, probePassed: false };
}

/* ---------------------------- Batch ------------------------------- */
async function runModeExtractFileWithProfile(file, profile, runContext = {}){
  const guardKey = runKeyForFile(file);
  const guardStarted = runLoopGuard?.start ? runLoopGuard.start(guardKey) : true;
  if(runLoopGuard && !guardStarted){
    console.warn('Duplicate run detected; skipping auto extraction for', guardKey);
    return;
  }
  if(runDiagnostics && guardStarted){
    runDiagnostics.startExtraction(guardKey);
  }
  try {
    activateRunMode({ clearDoc: true });
    const wizardId = runContext.wizardId || profile?.wizardId || currentWizardId();
    let geometryId = runContext.geometryId || profile?.geometryId || state.activeGeometryId || DEFAULT_GEOMETRY_ID;
    const selectionValue = runContext.selectionValue || runContext.value || null;
    const selectionSource = runContext.selectionSource || runContext.source || null;
    const displayName = runContext.displayName || runContext.selectionLabel || null;
    const logBatchRejection = ({ reason, wizardIdOverride = wizardId, geometryIdOverride = geometryId } = {}) => {
      const processedAtISO = new Date().toISOString();
      const batchEntry = {
        fileName: file?.name || null,
        processedAtISO,
        status: 'rejected',
        reason
      };
      if(wizardIdOverride){ batchEntry.wizardId = wizardIdOverride; }
      if(geometryIdOverride){ batchEntry.geometryId = geometryIdOverride; }
      const batchLog = LS.getBatchLog(state.username, state.docType, wizardIdOverride);
      batchLog.push(batchEntry);
      LS.setBatchLog(state.username, state.docType, batchLog.slice(-500), wizardIdOverride);
    };
    if(!wizardId){
      const payload = {
        fileName: file?.name || null,
        selectionValue,
        selectionSource,
        displayName,
        activeWizardId: state.activeWizardId,
        activeGeometryId: state.activeGeometryId,
        profileWizardId: profile?.wizardId || state.profile?.wizardId || null
      };
      console.error('[wizard-run][error]', payload);
      if(!runContext.isBatch){ notifyRunIssue('Please select a wizard before running extraction.'); }
      logBatchRejection({ reason: 'wizard_missing' });
      return;
    }
    logWizardSelection('run.resolve', { wizardId, displayName, value: selectionValue, source: selectionSource, modelId: runContext.modelId || null });
    if(state.activeWizardId !== wizardId){
      state.activeWizardId = wizardId;
    }
    state.activeGeometryId = geometryId || state.activeGeometryId || DEFAULT_GEOMETRY_ID;
    let profileStorageKey = LS.profileKey(state.username, state.docType, wizardId, geometryId === DEFAULT_GEOMETRY_ID ? null : geometryId);
    const geometryIds = collectGeometryIdsForWizard(state.username, state.docType, wizardId);
    console.info('[geom-run-selector]', { wizardId, geometryIds, requestedGeometryId: geometryId, profileKey: profileStorageKey });
    let storedProfile = loadProfile(state.username, state.docType, wizardId, geometryId);
    if(!storedProfile){
      for(const gid of geometryIds){
        const candidateProfile = loadProfile(state.username, state.docType, wizardId, gid);
        if(candidateProfile){
          storedProfile = candidateProfile;
          geometryId = gid;
          profileStorageKey = LS.profileKey(state.username, state.docType, wizardId, gid === DEFAULT_GEOMETRY_ID ? null : gid);
          break;
        }
      }
    }
    const hasGeom = Array.isArray(storedProfile?.fields) && storedProfile.fields.some(hasFieldGeometry);
    if(!storedProfile?.isConfigured || !hasGeom){
      if(!runContext.isBatch){ notifyRunIssue('Please configure this wizard before running extraction.'); }
      activateConfigMode({ clearDoc: true });
      state.profile = storedProfile || state.profile;
      state.activeWizardId = wizardId;
      logBatchRejection({ reason: 'wizard_unconfigured', wizardIdOverride: wizardId, geometryIdOverride: geometryId });
      return;
    }
    const runStartInput = {
      fileName: file?.name || null,
      boxPx: null,
      normBox: null,
      profileKey: profileStorageKey,
      wizardId,
      geometryId,
      docType: state.docType || null
    };
    try {
      const profileForLog = storedProfile || null;
      const fields = Array.isArray(profileForLog?.fields) ? profileForLog.fields : [];
      const formatBox = (box) => {
        if(!box) return null;
        if(Array.isArray(box) && box.length === 4){
          return box.map(v => (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(4)) : v);
        }
        const summaryKeys = ['x0','y0','x1','y1','w','h','wN','hN','x0n','y0n','x','y','page','pageIndex'];
        const out = {};
        summaryKeys.forEach(k => {
          if(typeof box[k] === 'number' && Number.isFinite(box[k])) out[k] = Number(box[k].toFixed(4));
        });
        return Object.keys(out).length ? out : box;
      };
      const fieldSummaries = fields.map(spec => {
        const hasNormBox = !!(spec?.normBox || spec?.bboxPct);
        const hasPixelBox = !!(spec?.boxPx || spec?.rawBox || spec?.configBox);
        const hasLegacyBox = Array.isArray(spec?.bbox) && spec.bbox.length === 4;
        const normBox = formatBox(spec?.normBox || spec?.bboxPct || null);
        const pixelBox = formatBox(spec?.boxPx || spec?.rawBox || spec?.configBox || null);
        const fingerprintKeys = (spec?.fingerprints && typeof spec.fingerprints === 'object') ? Object.keys(spec.fingerprints) : [];
        const edgeAnchorsPresent = !!(spec?.anchorMetrics || spec?.landmark || spec?.verticalAnchor || spec?.anchor);
        const missingReason = (!hasNormBox && !hasPixelBox && !hasLegacyBox)
          ? 'no normBox/bboxPct/bbox/boxPx/rawBox/configBox on field spec'
          : null;
        return {
          fieldKey: spec?.fieldKey || spec?.fieldId || '<unknown>',
          hasNormBox,
          hasPixelBox,
          hasLegacyBox,
          normBox,
          pixelBox,
          fingerprintKeys,
          hasLandmarkFingerprint: !!spec?.landmark,
          edgeAnchorsPresent,
          missingReason
        };
      });
      const missingGeom = fieldSummaries.filter(f => !!f.missingReason);
      console.groupCollapsed('[run-debug] profile hydration snapshot');
      console.log('profileKey:', profileStorageKey, 'docType:', profileForLog?.docType ?? state.docType ?? null, 'wizardId:', profileForLog?.wizardId ?? wizardId ?? null);
      console.log('profileVersion:', profileForLog?.version ?? profileForLog?.profileVersion ?? null, 'username:', profileForLog?.username ?? state.username ?? null, 'isNullProfile:', !profileForLog);
      console.log('fields:', fieldSummaries.length);
      fieldSummaries.forEach(f => {
        console.log(f.fieldKey, {
          hasNormBox: f.hasNormBox,
          hasPixelBox: f.hasPixelBox,
          hasLegacyBox: f.hasLegacyBox,
          normBox: f.normBox,
          pixelBox: f.pixelBox,
          fingerprintKeys: f.fingerprintKeys,
          hasLandmarkFingerprint: f.hasLandmarkFingerprint,
          edgeAnchorsPresent: f.edgeAnchorsPresent
        });
      });
      if(missingGeom.length){
        console.warn('[run-debug] missing geometry', missingGeom);
      }
      console.log('[run-debug] trace input bbox snapshot', { boxPx: runStartInput.boxPx ?? null, normBox: runStartInput.normBox ?? null });
      console.groupEnd();
    } catch(err){
      console.warn('[run-debug] profile hydration snapshot log failed', err);
    }
    let geomSnapshotCursor = snapshotProfileGeometry(profile);
    traceSnapshot('run.start',{
      stage:'run.start',
      mode:'run',
      username: state.username,
      docType: state.docType,
      wizardId,
      profileKey: profileStorageKey,
      displayName,
      selectionValue,
      selectionSource,
      profile,
      snapshot: geomSnapshotCursor,
      note:'incoming-profile'
    });
    try {
      const patternKey = patternStoreKey(state.docType, wizardId, geometryId === DEFAULT_GEOMETRY_ID ? null : geometryId);
      console.info('[id-drift][runModeExtractFileWithProfile]', JSON.stringify({
        isSkinV2,
        fileName: file?.name || null,
        docId: state.currentFileId || state.currentFileName || file?.name || 'doc',
        username: state.username,
        docType: state.docType,
        activeWizardId: state.activeWizardId,
        wizardId,
        geometryId,
        profileKey: profileStorageKey,
        patternKey,
        displayName,
        selectionValue,
        selectionSource
      }));
    } catch(err){ console.warn('[id-drift][runModeExtractFileWithProfile] log failed', err); }
    let incomingProfile = (profile && profile.geometryId === geometryId) ? migrateProfile(clonePlain(profile)) : null;
    let resolvedProfile = storedProfile || incomingProfile || null;
    const storedSnapshot = profileGeometrySnapshot(storedProfile);
    const wizardStorageScan = scanWizardStorageKeys(wizardId);
    const geometryKeys = wizardStorageScan.filter(entry => entry.hasGeometry).map(entry => entry.key);
    const loadedSnapshot = snapshotProfileGeometry(storedProfile);
    traceSnapshot('run.loaded',{
      stage:'run.loaded',
      mode:'run',
      username: state.username,
      docType: state.docType,
      wizardId,
      profileKey: profileStorageKey,
      profile: storedProfile,
      snapshot: loadedSnapshot,
      previousSnapshot: geomSnapshotCursor,
      note:'stored-profile'
    });
    geomSnapshotCursor = loadedSnapshot;
    const mergedSnapshot = snapshotProfileGeometry(resolvedProfile);
    traceSnapshot('run.post-merge',{
      stage:'run.post-merge',
      mode:'run',
      username: state.username,
      docType: state.docType,
      wizardId,
      profileKey: profileStorageKey,
      profile: resolvedProfile,
      snapshot: mergedSnapshot,
      previousSnapshot: geomSnapshotCursor,
      note:'post-merge'
    });
    geomSnapshotCursor = mergedSnapshot;
    const runSpanKey = { docId: state.currentFileId || state.currentFileName || file?.name || 'doc', pageIndex: 0, fieldKey: '__run__' };
    if(isRunMode()) mirrorDebugLog(`[run-mode] starting extraction for ${file?.name || 'file'}`);
    traceEvent(runSpanKey,'bbox:read',{
      stageLabel:'Run start',
      input:{
        ...runStartInput
      },
      ocrConfig: null,
      notes:'Run mode extraction started'
    });
    if(isRunMode()){
      console.info('[run-mode][diag] stored profile snapshot', {
        profileKey: profileStorageKey,
        hasProfile: !!storedProfile,
        keys: storedSnapshot.keys,
        fieldCount: storedSnapshot.fieldCount,
        fields: storedSnapshot.fields
      });
      console.info('[run-mode][diag] wizard storage scan', {
        wizardId,
        profileKey: profileStorageKey,
        matchingKeys: wizardStorageScan.map(entry => entry.key),
        geometryKeys
      });
    }
    state.profile = resolvedProfile;
    if(state.profile && !state.profile.wizardId){
      state.profile.wizardId = wizardId;
    }
    syncActiveWizardId(state.profile);
    hydrateFingerprintsFromProfile(state.profile);
    const ensuredSnapshot = snapshotProfileGeometry(state.profile);
    traceSnapshot('run.post-ensure',{
      stage:'run.post-ensure',
      mode:'run',
      username: state.username,
      docType: state.docType,
      wizardId,
      profileKey: profileStorageKey,
      profile: state.profile,
      snapshot: ensuredSnapshot,
      previousSnapshot: geomSnapshotCursor,
      note:'post-ensure'
    });
    geomSnapshotCursor = ensuredSnapshot;
    let activeProfile = state.profile || profile || { fields: [] };
    if(isRunMode()){
      const profileFieldDiagnostics = (activeProfile.fields || []).map(f => ({
        key: f.fieldKey,
        type: f.type,
        page: f.page ?? (Number.isFinite(f.pageIndex) ? f.pageIndex + 1 : null),
        pageIndex: f.pageIndex ?? null,
        hasNormBox: !!(f.normBox || f.bboxPct),
        hasBBox: Array.isArray(f.bbox) && f.bbox.length === 4,
        normBox: f.normBox || f.bboxPct || null,
        bbox: f.bbox || null,
        configBox: f.configBox || f.rawBox || null,
        configMask: f.configMask || null,
        hasBoxPx: !!f.boxPx
      }));
      console.info('[run-mode][diag] profile fields snapshot', {
        wizardId: activeProfile.wizardId || state.activeWizardId || null,
        docType: activeProfile.docType || state.docType || null,
        fieldCount: profileFieldDiagnostics.length,
        fields: profileFieldDiagnostics
      });
    }
    const prepared = await prepareRunDocument(file);
    if(!prepared){ return; }
    const tokenStats = summarizeTokenCache();
    if(!state.numPages && tokenStats.pageCount){
      state.numPages = tokenStats.pageCount;
    }
    if(isRunMode()){
      mirrorDebugLog(`[run-mode] tokens cached for ${tokenStats.pageCount || state.numPages || 0} page(s), total tokens=${tokenStats.totalTokens}`);
      if(tokenStats.perPage?.length){
        const preview = tokenStats.perPage.filter(p => p.page > 0).map(p => `p${p.page}:${p.tokens}`).join(', ');
        if(preview) mirrorDebugLog(`[run-mode] token breakdown: ${preview}`);
      }
    }
    traceEvent(runSpanKey,'tokens:rank',{
      stageLabel:'Tokens ready',
      counts:{ tokens: tokenStats.totalTokens, pages: tokenStats.pageCount || state.numPages || 0 },
      notes:'Tokens cached for run mode'
    });
    if(tokenStats.totalTokens === 0){
      const warnMsg = 'Tokenization returned zero tokens; extraction may be empty';
      console.warn('[run-mode]', warnMsg);
      mirrorDebugLog(`[run-mode][warn] ${warnMsg}`);
      traceEvent(runSpanKey,'tokens:warn',{
        stageLabel:'Tokenization warning',
        counts:{ tokens: 0, pages: tokenStats.pageCount || state.numPages || 0 },
        notes: warnMsg
      });
    }
    if(geometryIds.length > 1){
      const selection = selectGeometryForRun({ wizardId, docType: state.docType, geometryIds, preferredGeometryId: geometryId });
      if(selection?.winner && selection.probePassed){
        if(selection.winner.geometryId !== geometryId){
          geometryId = selection.winner.geometryId;
          profileStorageKey = LS.profileKey(state.username, state.docType, wizardId, geometryId === DEFAULT_GEOMETRY_ID ? null : geometryId);
          storedProfile = selection.winner.profile;
          resolvedProfile = storedProfile || null;
          state.profile = resolvedProfile;
          state.activeGeometryId = geometryId;
          syncActiveWizardId(state.profile);
          syncActiveGeometryId(state.profile);
          hydrateFingerprintsFromProfile(state.profile);
          activeProfile = state.profile;
        }
      } else if(selection && !selection.probePassed){
        if(!runContext.isBatch){ notifyRunIssue('No matching template matched this document. Please configure or select a template.'); }
        logBatchRejection({ reason: 'no_matching_template', wizardIdOverride: wizardId, geometryIdOverride: geometryId });
        return;
      }
    }
    state.activeGeometryId = geometryId;

    await extractAreaRows(activeProfile);
    traceEvent(runSpanKey,'columns:merge',{
      stageLabel:'Area rows scanned',
      counts:{ areas: (activeProfile.fields||[]).filter(f=>f.isArea || f.fieldType==='areabox').length },
      notes:'Area rows extraction complete'
    });
    if(isRunMode()){
      const iterationList = (activeProfile.fields || []).map(f => ({
        key: f.fieldKey,
        type: f.type,
        page: f.page ?? (Number.isFinite(f.pageIndex) ? f.pageIndex + 1 : null),
        isArea: f.isArea || f.fieldType === 'areabox',
        areaId: f.areaId || null,
        hasBBox: Array.isArray(f.bbox) && f.bbox.length === 4,
        hasNormBox: !!(f.normBox || f.bboxPct),
        configMask: f.configMask || null
      }));
      console.info('[run-mode][diag] static extraction iteration list', { total: iterationList.length, fields: iterationList });
      console.info('[run-mode][diag] static field order', {
        wizardId: activeProfile.wizardId || state.activeWizardId || null,
        docType: activeProfile.docType || state.docType || null,
        profileKey: profileStorageKey,
        fieldOrder: iterationList.map(f => f.key)
      });
    }

    const includeLineItems = activeProfile?.masterDbConfig?.includeLineItems !== false;
    for(const spec of (activeProfile.fields || [])){
      const isAreaField = spec.isArea || spec.fieldType === 'areabox';
      const isSubordinateField = isExplicitSubordinate(spec);
      // Only skip subordinate fields when we are actually treating them as dynamic (line-item) children.
      if(isAreaField){ continue; }
      if(isSubordinateField && includeLineItems){ continue; }
      const placement = spec.type === 'static'
        ? resolveStaticPlacement(spec, state.pageViewports, state.numPages)
        : null;
      const targetPage = placement?.pageNumber
        ? clamp(placement.pageNumber, 1, state.numPages || 1)
        : clamp(Number.isFinite(spec.page) ? spec.page : (state.pageNum || 1), 1, state.numPages || 1);
      state.pageNum = targetPage;
      state.viewport = state.pageViewports[targetPage-1] || state.viewport;
      let tokens = state.tokensByPage[targetPage] || [];
      const targetViewport = state.pageViewports[targetPage-1] || state.viewport || { width:1, height:1 };
      const configMask = placement?.configMask || normalizeConfigMask(spec);
      const bboxArr = placement?.bbox || spec.bbox;
      const keywordRelations = spec.keywordRelations ? clonePlain(spec.keywordRelations) : null;
      if(keywordRelations && keywordRelations.page && keywordRelations.page !== targetPage){
        keywordRelations.page = targetPage;
      }
      let areaScope = null;
      if(isSubordinateField && spec.areaId){
        const scopedArea = pickAreaScope(spec.areaId, targetPage, { lowConfidenceFloor: 0.2 });
        if(scopedArea && scopedArea.box){
          areaScope = { box: scopedArea.box, confidence: scopedArea.occ?.confidence ?? null, source: scopedArea.occ?.source || null };
          tokens = tokensWithinArea(tokens, scopedArea.box);
        }
      }
      const fieldSpec = {
        fieldKey: spec.fieldKey,
        regex: spec.regex,
        landmark: spec.landmark,
        bbox: bboxArr,
        page: targetPage,
        type: spec.type,
        anchorMetrics: spec.anchorMetrics || null,
        keywordRelations,
        configMask,
        tokenScope: areaScope ? 'area' : undefined,
        useSuppliedTokensOnly: !!areaScope,
        tokensScoped: !!areaScope
      };
      if(areaScope){
        fieldSpec.areaBoxPx = areaScope.box;
        fieldSpec.areaScope = areaScope;
      }
      const fieldSpanKey = {
        docId: state.currentFileId || state.currentFileName || 'doc',
        pageIndex: targetPage-1,
        fieldKey: spec.fieldKey || '',
        parentFieldKey: '__run__'
      };
      if(isRunMode() && spec.type === 'static'){
        const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const viewportMeta = {
          width: targetViewport?.width ?? targetViewport?.w ?? null,
          height: targetViewport?.height ?? targetViewport?.h ?? null,
          scale: targetViewport?.scale ?? null,
          dpr,
          rotation: state.pageTransform?.rotation ?? 0
        };
        console.info('[run-mode][diag] static search input', {
          fieldKey: spec.fieldKey,
          targetPage,
          placement: {
            bboxNorm: placement?.bbox || null,
            bboxArray: bboxArr || null,
            boxPx: placement?.boxPx || null,
            configMask,
            configBox: spec.configBox || null
          },
          viewport: viewportMeta,
          keywordRelations: !!keywordRelations,
          anchorMetrics: !!spec.anchorMetrics
        });
      }
      if(spec.type === 'static'){
        const hitTokens = placement?.boxPx ? tokensInBox(tokens, placement.boxPx, { minOverlap: 0 }) : [];
        logStaticDebug(
          `resolve ${spec.fieldKey || ''}: role=${placement?.pageRole || spec.pageRole || inferPageRole(spec, targetPage)} anchor=${placement?.anchor || spec.verticalAnchor || inferVerticalAnchor(spec)} pages=${state.numPages || 1} -> page ${targetPage} box=${formatBoxForLog(placement?.boxPx)}`,
          { tokens: hitTokens.length, preview: summarizeTokens(hitTokens) }
        );
        traceEvent(
          fieldSpanKey,
          'bbox:read',
          {
            stageLabel:'BBox read (run)',
            bbox:{ pixel: placement?.boxPx || null, normalized: placement?.bbox || null },
            counts:{ tokens: tokens.length },
            input:{ boxPx: placement?.boxPx || null, normBox: placement?.bbox || null, configMask },
            notes:`targetPage=${targetPage}`
          }
        );
      }
      state.snappedPx = null; state.snappedText = '';
      if(isRunMode() && spec.type === 'static'){
        console.info('[run-mode][diag] static extraction payload (pre-call)', {
          fieldKey: spec.fieldKey,
          targetPage,
          profileBoxes: {
            normBox: spec.normBox || spec.bboxPct || null,
            bbox: spec.bbox || null,
            boxPx: spec.boxPx || null,
            configBox: spec.configBox || null
          },
          placementBox: placement?.boxPx || null,
          placementNormBox: placement?.bbox || null
        });
      }
      if(isRunMode() && spec.type === 'static'){
        const profileBoxes = {
          normBox: spec.normBox || spec.bboxPct || null,
          bbox: spec.bbox || null,
          boxPx: spec.boxPx || null,
          configBox: spec.configBox || null
        };
        const missingBoxes = !profileBoxes.normBox && !profileBoxes.bbox && !profileBoxes.boxPx && !placement?.boxPx;
        if(missingBoxes){
          console.warn('[run-mode][diag] MISSING_BBOX', {
            fieldKey: spec.fieldKey,
            storageKey: profileStorageKey,
            docId: state.currentFileId || state.currentFileName || null,
            wizardId: currentWizardId(),
            docType: state.docType || null,
            targetPage
          });
        }
        console.info('[run-mode][diag] static bbox resolve', {
          fieldKey: spec.fieldKey,
          targetPage,
          profileBoxes,
          placementBoxes: {
            bboxNorm: placement?.bbox || null,
            bboxArray: bboxArr || null,
            boxPx: placement?.boxPx || null
          }
        });
      }
      if(isRunMode() && spec.type === 'static'){
        const extractorPath = spec.landmark ? 'static.landmark+bbox' : 'static.bbox-first';
        const preExtractPayload = {
          tag:'run.before-extract',
          stage:'run.extract.start',
          mode:'run',
          username: state.username,
          docType: state.docType,
          wizardId,
          profileKey: profileStorageKey,
          fieldKey: spec.fieldKey || null,
          page: targetPage,
          extractorPath,
          bbox:{
            placementNorm: placement?.bbox || null,
            placementPx: placement?.boxPx || null,
            profileNorm: spec.normBox || spec.bboxPct || bboxArr || null,
            profilePx: spec.boxPx || null
          }
        };
        console.info('[flight-recorder]', JSON.stringify(preExtractPayload));
        traceEvent(fieldSpanKey,'extract.start',{
          stageLabel:'Static extract start',
          bbox:{ pixel: placement?.boxPx || null, normalized: placement?.bbox || null },
          input:{
            extractorPath,
            profileNorm: spec.normBox || spec.bboxPct || bboxArr || null,
            profilePx: spec.boxPx || null,
            placementPx: placement?.boxPx || null
          },
          notes:`page=${targetPage}`
        });
      }
      const extractionResult = await extractFieldValue(fieldSpec, tokens, state.viewport);
      const normalizedExtractionPayload = normalizePayloadForLog(extractionResult);
      if(isRunMode() && spec.type === 'static'){
        console.info('[run-mode][diag] static extraction payload (post-call)', {
          fieldKey: spec.fieldKey,
          targetPage,
          payload: normalizedExtractionPayload
        });
      }
      const {
        value,
        boxPx,
        confidence,
        raw,
        corrections,
        corrected,
        method,
        fingerprintOk,
        anchorOk,
        cleanedOk
      } = extractionResult || {};
      const resultTokens = extractionResult?.tokens || [];
      const resolvedBox = boxPx || placement?.boxPx || null;
      const normalizedResolved = resolvedBox ? toPct(targetViewport, resolvedBox) : placement?.bbox || null;
      const rejectionReason = value ? null : (!extractionResult ? 'no_result' : (cleanedOk === false ? 'clean_failed_or_empty' : 'empty_value'));
      if(isRunMode()){
        console.info('[run-mode][diag] field iteration summary', {
          fieldKey: spec.fieldKey,
          type: spec.type || null,
          targetPage,
          profileBoxes: {
            normBox: spec.normBox || spec.bboxPct || null,
            bbox: spec.bbox || null,
            boxPx: spec.boxPx || null,
            configBox: spec.configBox || null
          },
          placementBox: placement?.boxPx || null,
          placementNormBox: placement?.bbox || null,
          runtimeBox: resolvedBox,
          runtimeNormBox: normalizedResolved,
          valueFlow: {
            rawText: raw || '',
            preCleanText: extractionResult?.rawBeforeClean || raw || '',
            cleanedText: corrected ?? value ?? '',
            finalValue: value || ''
          },
          rejectionReason,
          discarded: !value,
          payload: normalizedExtractionPayload
        });
      }
      if(isRunMode() && spec.type === 'static'){
        const extractorPath = method || extractionResult?.method || (spec.landmark ? 'static.landmark+bbox' : 'static.bbox-first');
        const postExtractPayload = {
          tag:'run.after-extract',
          stage:'run.extract.done',
          mode:'run',
          username: state.username,
          docType: state.docType,
          wizardId,
          profileKey: profileStorageKey,
          fieldKey: spec.fieldKey || null,
          page: targetPage,
          extractorPath,
          value: value || '',
          confidence: confidence ?? null,
          bbox:{
            normalized: normalizedResolved || placement?.bbox || null,
            pixel: resolvedBox || placement?.boxPx || null
          },
          rejectionReason
        };
        console.info('[flight-recorder]', JSON.stringify(postExtractPayload));
        traceEvent(fieldSpanKey,'extract.done',{
          stageLabel:'Static extract done',
          bbox:{ pixel: resolvedBox || placement?.boxPx || null, normalized: normalizedResolved || placement?.bbox || null },
          output:{ value: value || '', confidence: confidence ?? null, method: extractorPath },
          notes: rejectionReason ? `rejection=${rejectionReason}` : 'value extracted'
        });
      }
      if(spec.type === 'static'){
        traceEvent(
          fieldSpanKey,
          'bbox:expand',
          {
            stageLabel:'BBox expand (run)',
            bbox:{ pixel: resolvedBox, normalized: normalizedResolved },
            counts:{ tokens: tokens.length },
            notes: resolvedBox ? 'resolved search box' : 'using placement bbox only'
          }
        );
      }
      if(isRunMode() && spec.type === 'static'){
        console.info('[run-mode][diag] static extraction payload (post-processed)', {
          fieldKey: spec.fieldKey,
          targetPage,
          payload: normalizedExtractionPayload,
          rejectionReason,
          resolvedBox,
          normalizedBox: normalizedResolved
        });
        console.info('[run-mode][diag] static extraction result', {
          fieldKey: spec.fieldKey,
          targetPage,
          method: method || extractionResult?.method || null,
          rawText: raw,
          rawBeforeClean: extractionResult?.rawBeforeClean || raw || '',
          cleanedText: corrected ?? value ?? '',
          finalValue: value || '',
          confidence,
          fingerprintOk: fingerprintOk ?? null,
          anchorOk: anchorOk ?? null,
          cleanedOk: cleanedOk ?? null,
          tokens: resultTokens.length,
          boxPx: resolvedBox,
          normalizedBox: normalizedResolved,
          rejectionReason
        });
        if(!value){
          console.warn('[run-mode][diag] discarding field value', {
            fieldKey: spec.fieldKey,
            reason: rejectionReason,
            method: method || extractionResult?.method || null,
            rawText: raw,
            confidence,
            fingerprintOk: fingerprintOk ?? null,
            anchorOk: anchorOk ?? null
          });
        }
      }
      if(value){
        const vp = targetViewport || {width:1,height:1};
        const nb = boxPx ? normalizeBox(boxPx, (vp.width ?? vp.w) || 1, (vp.height ?? vp.h) || 1) : null;
        const pct = nb ? { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN } : null;
        const arr = rawStore.get(state.currentFileId) || [];
        let conf = confidence;
        const dup = arr.find(r=>r.fieldKey!==spec.fieldKey && ['subtotal_amount','tax_amount','invoice_total'].includes(spec.fieldKey) && ['subtotal_amount','tax_amount','invoice_total'].includes(r.fieldKey) && r.value===value);
        if(dup) conf *= 0.5;
        const rec = { fieldKey: spec.fieldKey, raw, value, confidence: conf, correctionsApplied: corrections, page: targetPage, bbox: pct, ts: Date.now() };
        rawStore.upsert(state.currentFileId, rec);
      }
      if(spec.type === 'static'){
        const postTokens = boxPx ? tokensInBox(tokens, boxPx, { minOverlap: 0 }) : [];
        logStaticDebug(
          `resolved ${spec.fieldKey || ''}: role=${placement?.pageRole || spec.pageRole || inferPageRole(spec, targetPage)} anchor=${placement?.anchor || spec.verticalAnchor || inferVerticalAnchor(spec)} pages=${state.numPages || 1} -> page ${targetPage} box=${formatBoxForLog(boxPx || placement?.boxPx)}`,
          { tokens: postTokens.length, preview: summarizeTokens(postTokens) }
        );
        traceEvent(
          fieldSpanKey,
          'finalize',
          {
            stageLabel:'Finalize (run)',
            output:{ value: value || '', confidence },
            bbox:{ pixel: boxPx || placement?.boxPx || null, normalized: normalizedResolved || placement?.bbox || null },
            counts:{ tokens: tokens.length },
            notes: value ? 'value extracted' : 'no value extracted'
          }
        );
      }
    }
    if(isRunMode()) mirrorDebugLog(`[run-mode] static fields extracted (${(activeProfile.fields||[]).length})`);
    const lineItems = await extractLineItems(activeProfile);
    if(isRunMode()) mirrorDebugLog(`[run-mode] dynamic line items extracted (${lineItems.length})`);
    traceEvent(runSpanKey,'columns:merge',{
      stageLabel:'Line items extracted',
      counts:{ lineItems: lineItems.length },
      notes: lineItems.length ? 'line items captured' : 'no line items found'
    });
    const compiled = compileDocument(state.currentFileId, lineItems);
    const processedAtISO = new Date().toISOString();
    const batchEntry = {
      fileName: file?.name || compiled?.fileName || null,
      processedAtISO,
      status: 'accepted'
    };
    if(wizardId){ batchEntry.wizardId = wizardId; }
    if(geometryId){ batchEntry.geometryId = geometryId; }
    const batchLog = LS.getBatchLog(state.username, state.docType, wizardId);
    batchLog.push(batchEntry);
    LS.setBatchLog(state.username, state.docType, batchLog.slice(-500), wizardId);
    if(state.snapshotMode){
      const manifest = await buildSnapshotManifest(state.currentFileId, getOverlayFlags());
      if(manifest){ compiled.snapshotManifestId = manifest.id; }
    }
    if(isRunMode()) mirrorDebugLog(`[run-mode] MasterDB written for ${compiled.fileId}`);
    traceEvent(runSpanKey,'finalize',{
      stageLabel:'Run complete',
      output:{ fileId: compiled.fileId, fields: (activeProfile.fields||[]).length, lineItems: lineItems.length },
      notes:'Run mode finished'
    });
  } catch(err){
    console.error('Run mode extraction failed', err);
    if(!runContext.isBatch){ notifyRunIssue(err?.message || 'Extraction failed. Please try again.'); }
  } finally {
    if(runDiagnostics && guardStarted){
      runDiagnostics.finishExtraction(guardKey);
    }
    if(runLoopGuard?.finish && guardStarted){
      runLoopGuard.finish(guardKey);
    }
  }
}

async function processBatch(files){
  if(!files.length) return;
  let runCtx;
  try{
    runCtx = resolveRunWizardContext({ profileOverride: state.profile });
  } catch(err){
    console.error('Batch extraction aborted: wizard selection missing', err);
    alert(err?.message || 'Select a wizard before running extraction.');
    return;
  }
  state.activeWizardId = runCtx.wizardId;
  state.profile = runCtx.profile || state.profile;
  runCtx.isBatch = true;
  activateRunMode({ clearDoc: true });
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile(runCtx.wizardId); renderSavedFieldsTable();
  logWizardSelection('run.start.batch', { ...runCtx, value: runCtx.selectionValue });

  try {
    for(const f of files){
      await runModeExtractFileWithProfile(f, state.profile, runCtx);
    }
  } catch(err){
    console.error('Batch extraction failed', err);
    alert(err?.message || 'Batch extraction failed. Please try again.');
  } finally {
    els.wizardSection.style.display = 'none';
    els.app.style.display = 'block';
    showTab('extracted-data');
  }
}

/* ------------------------ Init on load ---------------------------- */
applyEnvProfileConfig(envWizardBootstrap);
renderResultsTable();
renderReports();
syncRawModeUI();
initSnapshotMode();
syncModeUi();
syncStaticDebugToggleUI();
