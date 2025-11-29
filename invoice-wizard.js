// ===== pdf.js & tesseract bindings (must appear before any getDocument call) =====
const pdfjsLibRef = window.pdfjsLib;
const TesseractRef = window.Tesseract;
const StaticFieldMode = window.StaticFieldMode || null;
const KeywordWeighting = window.KeywordWeighting || null;

let DEBUG_STATIC_FIELDS = Boolean(window.DEBUG_STATIC_FIELDS ?? /static-debug/i.test(location.search));
window.DEBUG_STATIC_FIELDS = DEBUG_STATIC_FIELDS;
let staticDebugLogs = [];

const MAX_STATIC_CANDIDATES = 12;
const MIN_STATIC_ACCEPT_SCORE = 0.7;
const STATIC_LINE_DIFF_WEIGHTS = { 0: 1.0, 1: 0.75, 2: 0.35, default: 0.10 };
const STATIC_FP_SCORES = { ok: 1.3, fail: 0.5 };

function staticDebugEnabled(){ return !!window.DEBUG_STATIC_FIELDS; }
function logStaticDebug(message, details){
  if(!staticDebugEnabled()) return;
  const line = `[static-debug] ${message}`;
  staticDebugLogs.push(details ? { line, details } : line);
  if(details !== undefined){ console.log(line, details); }
  else { console.log(line); }
}
function formatBoxForLog(box){
  if(!box) return '<null>';
  const { x=0, y=0, w=0, h=0, page } = box;
  return `{x:${Math.round(x)},y:${Math.round(y)},w:${Math.round(w)},h:${Math.round(h)},page:${page||'?'}}`;
}
function formatArrayBox(boxArr){
  return Array.isArray(boxArr) ? `[${boxArr.map(v=>Math.round(v??0)).join(',')}]` : '<none>';
}

(function sanityLog(){
  console.log('[pdf.js] version:', pdfjsLibRef?.version,
              'workerSrc:', pdfjsLibRef?.GlobalWorkerOptions?.workerSrc);
})();

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
  password:        document.getElementById('password'),
  app:             document.getElementById('app'),
  tabs:            document.querySelectorAll('#dashTabs button'),
  docDashboard:    document.getElementById('document-dashboard'),
  extractedData:   document.getElementById('extracted-data'),
  reports:         document.getElementById('reports'),
  docType:         document.getElementById('doc-type'),
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
  newWizardBtn:    document.getElementById('new-wizard-btn'),
  demoBtn:         document.getElementById('demo-btn'),
  staticDebugBtn:  document.getElementById('static-debug-btn'),
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
    console.warn(`[run-mode] ${label} called during RUN mode; skipping.`);
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
  [els.docDashboard, els.extractedData, els.reports].forEach(sec => {
    if(sec) sec.style.display = sec.id === id ? 'block' : 'none';
  });
  els.tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.target === id));
}
els.tabs.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.target)));
if(els.showOcrBoxesToggle){ els.showOcrBoxesToggle.checked = /debug/i.test(location.search); }

let state = {
  username: null,
  docType: 'invoice',
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
  tokensByPage: {},          // {page:number: Token[] in px}
  keywordIndexByPage: {},   // per-page keyword bbox cache
  selectionCss: null,        // current user-drawn selection (CSS units, page-relative)
  selectionPx: null,         // current user-drawn selection (px, page-relative)
  snappedCss: null,          // snapped line box (CSS units, page-relative)
  snappedPx: null,           // snapped line box (px, page-relative)
  snappedText: '',           // snapped line text
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
};

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
window.clearStaticDebugLogs = () => { staticDebugLogs.length = 0; return []; };

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
  const logs = window.getStaticDebugLogs ? window.getStaticDebugLogs() : [];
  const lines = normalizeStaticDebugLogs(logs).join('\n');
  els.staticDebugText.value = lines;
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
  state.tokensByPage = {}; state.currentLineItems = [];
  state.currentFileId = ''; state.currentFileName = '';
  state.lineLayout = null;
  state.lastSnapshotManifestId = '';
  state.snapshotPanels = { activePage: null };
  return state;
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
  if(opts.clearDoc !== false) resetDocArtifacts();
}

function activateConfigMode(){
  clearTransientStateLocal();
  setWizardMode(ModeEnum.CONFIG);
  resetDocArtifacts();
  initStepsFromProfile();
}

window.__debugBlankAvoided = window.__debugBlankAvoided || 0;
function bumpDebugBlank(){
  window.__debugBlankAvoided = (window.__debugBlankAvoided || 0) + 1;
}

/* ---------------------- Storage / Persistence --------------------- */
const LS = {
  profileKey: (u, d) => `wiz.profile.${u}.${d}`,
  dbKey: (u, d) => `accounts.${u}.wizards.${d}.masterdb`,
  getDb(u, d) {
    const raw = localStorage.getItem(this.dbKey(u, d));
    return raw ? JSON.parse(raw) : [];
    },
  setDb(u, d, arr){ localStorage.setItem(this.dbKey(u, d), JSON.stringify(arr)); },
  getProfile(u,d){ const raw = localStorage.getItem(this.profileKey(u,d)); return raw ? JSON.parse(raw, jsonReviver) : null; },
  setProfile(u,d,p){ localStorage.setItem(this.profileKey(u,d), serializeProfile(p)); },
  removeProfile(u,d){ localStorage.removeItem(this.profileKey(u,d)); }
};

/* ---------- Profile versioning & persistence helpers ---------- */
const PROFILE_VERSION = 7;
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
  }
};

function migrateProfile(p){
  if(!p) return p;
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

let saveTimer=null;
function saveProfile(u, d, p){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try{ LS.setProfile(u, d, p); }
    catch(e){ console.error('saveProfile', e); alert('Failed to save profile'); }
    try{ traceEvent({ docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: 0, fieldKey: 'profile' }, 'save.persisted', { docType:d }); }catch{}
  },300);
}
function loadProfile(u, d){
  try{
    const raw = LS.getProfile(u, d);
    return migrateProfile(raw);
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
  ensureProfile();
  const id = `${state.username}:${state.docType}:${Date.now()}`;
  const models = getModels();
  models.push({ id, username: state.username, docType: state.docType, profile: state.profile });
  setModels(models);
  populateModelSelect();
  alert('Wizard model saved.');
}

function populateModelSelect(){
  const sel = document.getElementById('model-select');
  if(!sel) return;
  const models = getModels().filter(m => m.username === state.username && m.docType === state.docType);
  const current = sel.value;
  sel.innerHTML = `<option value="">— Select a saved model —</option>` +
    models.map(m => `<option value="${m.id}">${new Date(parseInt(m.id.split(':').pop(),10)).toLocaleString()}</option>`).join('');
  if(current) sel.value = current;
}

function loadModelById(id){
  const m = getModels().find(x => x.id === id);
  if(!m) return null;
  state.profile = migrateProfile(m.profile);
  hydrateFingerprintsFromProfile(state.profile);
  saveProfile(state.username, state.docType, state.profile);
  return m.profile;
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
  if(!saved || !candidate) return { ok: true, matches: 0, textMatch: false, tolerance: 0 };
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
  let toleranceBase = Number.isFinite(expectedText) ? expectedText : candidate.textHeightPx;
  if(!Number.isFinite(toleranceBase) || toleranceBase <= 0){
    toleranceBase = Math.min(targetHeight || 0, targetWidth || 0) * 0.02;
  }
  if(!Number.isFinite(toleranceBase) || toleranceBase <= 0){ toleranceBase = 4; }
  const tolerance = Math.max(4, toleranceBase * 1.35);
  const matches = available.filter(d => Math.abs(d.actual - d.expected) <= tolerance).length;
  const textMatch = Number.isFinite(expectedText) && Number.isFinite(candidate.textHeightPx)
    ? Math.abs(candidate.textHeightPx - expectedText) <= tolerance
    : false;
  if(!available.length){
    const ok = !Number.isFinite(expectedText) || textMatch;
    return { ok, matches: 0, textMatch, tolerance };
  }
  const required = Math.min(2, available.length);
  let ok = matches >= required;
  if(!ok){
    if(required === 1){
      ok = matches === 1 || (matches === 0 && textMatch);
    } else if(matches === required - 1 && textMatch){
      ok = true;
    }
  }
  if(staticDebugEnabled() && debugCtx?.enabled){
    const annotated = distances.map(d => {
      const ready = Number.isFinite(d.expected) && Number.isFinite(d.actual);
      const delta = ready ? Math.round(d.actual - d.expected) : null;
      const edgeOk = ready ? Math.abs(d.actual - d.expected) <= tolerance : null;
      return `${d.label}=${ready ? (edgeOk ? 'OK' : 'FAIL') + ` (${delta >= 0 ? '+' : ''}${delta}px)` : 'n/a'}`;
    }).join(', ');
    const heightStatus = Number.isFinite(expectedText) && Number.isFinite(candidate.textHeightPx)
      ? `${Math.abs(candidate.textHeightPx - expectedText) <= tolerance ? 'OK' : 'FAIL'} (${Math.round(candidate.textHeightPx - expectedText)}px)`
      : 'n/a';
    logStaticDebug(
      `field=${debugCtx.fieldKey||''} page=${debugCtx.page||''} anchors: ${annotated}, height=${heightStatus} tol=${Math.round(tolerance)} viewport=${Math.round(targetWidth)}x${Math.round(targetHeight)} -> match=${ok}`
    );
  }
  return { ok, matches, textMatch, tolerance };
}

function anchorMatchForBox(savedMetrics, box, tokens, viewportW, viewportH, debugCtx=null){
  if(!savedMetrics) return true;
  if(!box || !Number.isFinite(viewportW) || !Number.isFinite(viewportH) || viewportW <= 0 || viewportH <= 0){
    return false;
  }
  const heights = (tokens || []).map(t => Number.isFinite(t?.h) ? t.h : null).filter(v => Number.isFinite(v) && v > 0);
  const fallbackHeight = heights.length ? median(heights) : (Number.isFinite(box.h) ? box.h : 0);
  const metrics = anchorMetricsFromBox(box, viewportW, viewportH, heights, fallbackHeight);
  if(!metrics) return false;
  return anchorMetricsSatisfied(savedMetrics, metrics, debugCtx).ok;
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
  store_name: { en: ['store', 'vendor', 'seller', 'company'] },
  department_division: { en: ['department', 'division'] },
  invoice_number: { en: ['invoice number', 'invoice no', 'invoice #', 'inv #', 'inv no'] },
  invoice_date: { en: ['invoice date', 'date of issue', 'issued date'] },
  salesperson_rep: { en: ['salesperson', 'sales rep', 'representative'] },
  customer_name: { en: ['customer', 'client', 'bill to', 'sold to'] },
  customer_address: { en: ['address', 'billing address', 'bill to address', 'customer address'] },
  subtotal_amount: { en: ['subtotal', 'sub total'] },
  discounts_amount: { en: ['discount', 'discounts'] },
  tax_amount: { en: ['tax', 'hst', 'gst', 'qst', 'vat'] },
  invoice_total: { en: ['total', 'grand total', 'amount due', 'balance due'] },
  payment_method: { en: ['payment method', 'paid with'] },
  payment_status: { en: ['payment status', 'status'] }
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

  function learn(ftype, value){
    if(!value) return;
    const p = patterns[ftype] || (patterns[ftype] = {code:{}, shape:{}, len:{}, digit:{}});
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
    const p = patterns[ftype];
    if(!p) return {};
    const maxKey = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1])[0]?.[0];
    return { code: maxKey(p.code), shape: maxKey(p.shape), len: +maxKey(p.len), digit: parseFloat(maxKey(p.digit)) };
  }

  function clean(ftype, input, mode='RUN', spanKey){
    const arr = Array.isArray(input) ? input : [{text:String(input||'')}];
    const lineStrs = Array.isArray(input) ? groupIntoLines(arr).map(L=>L.tokens.map(t=>t.text).join(' ').trim()) : [String(input||'')];
    const raw = lineStrs.join(' ').trim();
    if(spanKey) traceEvent(spanKey,'clean.start',{ raw });
    let txt = raw.replace(/\s+/g,' ').trim().replace(/[#:—•]*$/, '');
    let isValid = true;
    let invalidReason = null;
    if(/date/i.test(ftype)){ const n=normalizeDate(txt); if(n) txt=n; }
    else if(/total|subtotal|tax|amount|price|balance|deposit|discount|unit|grand|quantity|qty/.test(ftype)){
      const n=txt.replace(/[^0-9.-]/g,''); const num=parseFloat(n); if(!isNaN(num)) txt=num.toFixed(/unit|price|amount|total|tax|subtotal|grand/.test(ftype)?2:0);
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
        isValid = false;
        invalidReason = 'looks_like_date';
      }
      txt = isValid ? sanitized : '';
    }
    const conf = arr.reduce((s,t)=>s+(t.confidence||1),0)/arr.length;
    const code = codeOf(txt);
    const shape = shapeOf(txt);
    const digit = digitRatio(txt);
    const before = dominant(ftype);
    const fingerprintMatch = isValid && (!before.code || before.code === code);
    const shouldLearn = isValid && (mode === 'CONFIG' || fingerprintMatch);
    if(shouldLearn) learn(ftype, txt);
    const dom = shouldLearn ? dominant(ftype) : before;
    let score=0;
    if(isValid && dom.code && dom.code===code) score++;
    if(isValid && dom.shape && dom.shape===shape) score++;
    if(isValid && dom.len && dom.len===txt.length) score++;
    if(isValid && dom.digit && Math.abs(dom.digit-digit)<0.01) score++;
    if(spanKey) traceEvent(spanKey,'clean.success',{ value:txt, score, isValid, invalidReason });
    if(state.mode === ModeEnum.RUN && staticDebugEnabled() && isStaticFieldDebugTarget(spanKey?.fieldKey || ftype)){
      const expectedCode = getDominantFingerprintCode(ftype, spanKey?.fieldKey || ftype);
      const fingerprintOk = fingerprintMatches(ftype, code, mode, spanKey?.fieldKey, { enabled:false, fieldKey: spanKey?.fieldKey || ftype, cleanedValue: txt });
      logStaticDebug(
        `field=${spanKey?.fieldKey || ftype || ''} cleaned="${txt}" code=${code || '<none>'} expected=${expectedCode || '<none>'} -> fingerprintOk=${fingerprintOk}`,
        { field: spanKey?.fieldKey || ftype, cleaned: txt, code, expected: expectedCode, fingerprintOk }
      );
    }
    return { value:txt, raw: isValid ? raw : '', rawOriginal: raw, corrected:txt, conf, code, shape, score, correctionsApplied:[], digit, fingerprintMatch, isValid, invalidReason };
  }

  function exportPatterns(){ return patterns; }
  function importPatterns(p){
    Object.keys(patterns).forEach(k => delete patterns[k]);
    if(!p || typeof p !== 'object') return;
    for(const [key, data] of Object.entries(p)){
      if(data && typeof data === 'object'){
        patterns[key] = clonePlain(data);
      }
    }
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
  const tallies = collectPersistedFingerprints(profile);
  FieldDataEngine.importPatterns(tallies);
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
  const { minOverlap } = opts || {};
  return tokens.filter(t => {
    if(t.page !== box.page) return false;
    const cx = t.x + t.w/2;
    if(cx < box.x || cx > box.x + box.w) return false;
    const overlapY = Math.min(t.y + t.h, box.y + box.h) - Math.max(t.y, box.y);
    const needOverlap = typeof minOverlap === 'number'
      ? minOverlap
      : (isConfigMode() ? 0.5 : 0.7);
    if(overlapY / t.h < needOverlap) return false;
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
  const horizontalOverlap = (L)=> Math.max(0, Math.min(L.right, hintPx.x + hintPx.w) - Math.max(L.left, hintPx.x));
  const overlapThreshold = (L)=> Math.max(L.width, hintPx.w) * 0.15;
  const verticalPad = 2;
  const candidates = lines
    .filter(L => L.page === hintPx.page)
    .filter(L => horizontalOverlap(L) >= overlapThreshold(L))
    .filter(L => (L.bottom > hintPx.y - verticalPad) && (L.top < hintPx.y + hintPx.h + verticalPad))
    .sort((a,b)=> a.top - b.top || a.left - b.left);
  if(!candidates.length) return [];
  if(!multiline){
    const cy = hintPx.y + hintPx.h/2;
    let best = candidates[0];
    let bestScore = Infinity;
    for(const L of candidates){
      const overlap = horizontalOverlap(L) / Math.max(1, Math.max(L.width, hintPx.w));
      const dy = Math.abs(((L.top + L.bottom)/2) - cy);
      const score = dy + (1 - overlap) * 20;
      if(score < bestScore){ bestScore = score; best = L; }
    }
    return best ? [best] : [];
  }
  const anchorLine = candidates.find(L => L.cy >= hintPx.y - verticalPad && L.cy <= hintPx.y + hintPx.h + verticalPad) || candidates[0];
  const ordered = candidates.filter(L => L.top >= anchorLine.top);
  const maxGap = Math.max(4, Math.min(anchorLine.height * 0.6, 12));
  const selected = [anchorLine];
  let prev = anchorLine;
  for(const L of ordered){
    if(L === anchorLine) continue;
    if(L.top - prev.bottom <= maxGap){ selected.push(L); prev = L; }
  }
  return selected.sort((a,b)=> a.top - b.top || a.left - b.left);
}
function snapStaticToLines(tokens, hintPx, opts={}){
  const { multiline=false, marginPx=4 } = opts || {};
  const lines = groupIntoLines(tokens, 4).map(lineBounds);
  const selected = selectLinesForStatic(lines, hintPx, { multiline });
  if(!selected.length){
    const fallback = snapToLine(tokens, hintPx, marginPx, opts);
    const metrics = summarizeLineMetrics([]);
    return { ...fallback, lines: [], lineCount: metrics.lineCount, lineHeights: metrics.lineHeights, lineMetrics: metrics };
  }
  const overlapsHint = (t)=>{
    if(!hintPx) return true;
    const overlap = Math.max(0, Math.min(t.x + t.w, hintPx.x + hintPx.w) - Math.max(t.x, hintPx.x));
    const threshold = Math.min(t.w, hintPx.w) * 0.15;
    return overlap >= threshold;
  };
  const selectedTokens = selected.flatMap(L => L.tokens);
  const inHintTokens = selectedTokens.filter(overlapsHint);
  const tokensForBox = inHintTokens.length ? inHintTokens : selectedTokens;
  const left = Math.min(...tokensForBox.map(t=>t.x));
  const right = Math.max(...tokensForBox.map(t=>t.x + t.w));
  const top = Math.min(...selected.map(L => L.top));
  const bottom = Math.max(...selected.map(L => L.bottom));
  let box = { x:left, y:top, w:right-left, h:bottom-top, page:hintPx.page };
  const expanded = { x: box.x - marginPx, y: box.y - marginPx, w: box.w + marginPx*2, h: box.h + marginPx*2, page: hintPx.page };
  let finalBox = expanded;
  if(hintPx && hintPx.w > 0){
    const widthCap = hintPx.w * 1.1;
    const tokensForWidth = inHintTokens.length ? inHintTokens : tokensForBox;
    const minTokenX = Math.min(...tokensForWidth.map(t => t.x));
    const tokensWidth = Math.max(1, Math.max(...tokensForWidth.map(t => (t.x + t.w) - minTokenX)));
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
  const lineTexts = selected.map(L => {
    const lt = (L.tokens||[]).filter(overlapsHint);
    const toks = lt.length ? lt : L.tokens || [];
    return toks.map(t=>t.text).join(' ').trim();
  }).filter(Boolean);
  const text = multiline ? lineTexts.join('\n') : (lineTexts[0] || '');
  const metrics = summarizeLineMetrics(selected);
  return { box: finalBox, text, lines: selected, lineCount: metrics.lineCount, lineHeights: metrics.lineHeights, lineMetrics: metrics };
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
  if(isConfigMode() && hintPx){
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
function ensureProfile(){
  if(state.profile) return;

  const existing = loadProfile(state.username, state.docType);

  state.profile = existing || {
    username: state.username,
    docType: state.docType,
    version: PROFILE_VERSION,
    fields: [],
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
  hydrateFingerprintsFromProfile(state.profile);
  saveProfile(state.username, state.docType, state.profile);
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
function updatePrompt(){
  const step = state.steps[state.stepIdx];
  els.stepLabel.textContent = `Step ${state.stepIdx+1}/${state.steps.length}`;
  els.questionText.textContent = step?.prompt || 'Highlight field';
}

function goToStep(idx){
  const max = state.steps.length - 1;
  state.stepIdx = Math.max(0, Math.min(idx, max));
  els.confirmBtn.disabled = false;
  els.skipBtn.disabled = false;
  updatePrompt();
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; state.snappedLineMetrics = null; state.matchPoints=[]; drawOverlay();
}

function finishWizard(){
  els.confirmBtn.disabled = true;
  els.skipBtn.disabled = true;
  els.backBtn.disabled = false;
  document.getElementById('promptBar').innerHTML =
    `<span id="stepLabel">Wizard complete</span>
     <strong id="questionText">Click “Save & Return” or export JSON.</strong>`;
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
  traceEvent({ docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: (boxPx.page||1)-1, fieldKey }, 'ocr.raw', { tokens: baseTokens.length });

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

  traceEvent({ docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: (boxPx.page||1)-1, fieldKey }, 'ocr.tiled', { tiles: tiles.map((t,i)=>({ index:i, tokens:t.tokens.length })) });
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
  let viewportDims = getViewportDimensions(viewportPx);
  if(!viewportDims.width || !viewportDims.height){
    viewportDims = getPageViewportSize(fieldSpec.page || state.pageNum || 1);
  }
  const enforceAnchors = isRunMode() && !!fieldSpec.anchorMetrics;
  const anchorMatchesCandidate = cand => {
    if(!enforceAnchors) return true;
    if(!cand || !cand.boxPx) return false;
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
    const pageTokens = (page === (fieldSpec.page || state.pageNum || page))
      ? tokens
      : (state.tokensByPage?.[page] || null);
    return await buildKeywordIndexForPage(page, pageTokens, vp);
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
      traceEvent(spanKey,'selection.captured',{ boxPx });
    } else if(fieldSpec.bbox){
      const raw = toPx(viewportPx,{x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
      boxPx = applyTransform(raw);
      traceEvent(spanKey,'selection.captured',{ boxPx });
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
    traceEvent(spanKey,'ocr.raw',{ mode:'raw', washed:false, cleaning:false, fallback:false, dedupe:false, tokens: best.tokensLength, crop: cropBitmap.toDataURL('image/png') });
    if(!rawText && !confirm('OCR returned empty. Keep empty value?')){
      alert('Please re-select the field.');
      return { value:'', raw:'', confidence:0, boxPx, tokens:[], method:'raw' };
    }
    const tokensOut = best.tokens.map(t=>({ text:t }));
    const result = { value: rawText, raw: rawText, corrected: rawText, code:null, shape:null, score:null, correctionsApplied:[], boxPx, confidence:1, tokens: tokensOut, method:'raw' };
    traceEvent(spanKey,'value.finalized',{ value: result.value, confidence: result.confidence, method:'raw', mode:'raw', washed:false, cleaning:false, fallback:false, dedupe:false });
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
    if(boxPx){ traceEvent(spanKey,'selection.captured',{ boxPx }); }
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
    const value = text || state.snappedText || cleaned.value || cleaned.raw || '';
    const result = {
      value,
      raw: text || state.snappedText || '',
      corrected: value,
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
    traceEvent(spanKey,'value.finalized',{ value: result.value, confidence: result.confidence, method: result.method, mode:'CONFIG' });
    return result;
  }

  async function attempt(box){
    const snap = snapToLine(tokens, box, 6, { minOverlap: staticMinOverlap });
    let searchBox = snap.box;
    if(fieldSpec.fieldKey === 'customer_address'){
      searchBox = { x:snap.box.x, y:snap.box.y, w:snap.box.w, h:snap.box.h*4, page:snap.box.page };
    }
    const assembler = StaticFieldMode?.assembleTextFromBox || StaticFieldMode?.collectFullText || null;
    const assembleOpts = { tokens, box: searchBox, snappedText: '', multiline: !!fieldSpec.isMultiline, minOverlap: staticMinOverlap };
    const assembled = assembler ? assembler(assembleOpts) : null;
    const hits = assembled?.hits || tokensInBox(tokens, searchBox, { minOverlap: staticMinOverlap });
    const lines = assembled?.lines || groupIntoLines(hits);
    const observedLineCount = assembled?.lineCount ?? (assembled?.lines?.length ?? lines.length ?? 0);
    const anchorOk = anchorMatchesCandidate({ boxPx: searchBox, tokens: hits });
    const adjustConfidenceForLines = (confidence)=>{
      const expected = fieldSpec?.lineMetrics?.lineCount ?? fieldSpec?.lineCount ?? observedLineCount;
      if(!expected || !observedLineCount) return { confidence, expected, factor: 1 };
      const tolerance = expected >= 3 ? 1 : 0;
      const diff = Math.abs(observedLineCount - expected);
      let factor = 1;
      let reason = 'exact';
      if(diff === 0){ factor = 1.1; reason = 'exact'; }
      else if(diff <= tolerance){ factor = 1.05; reason = 'near'; }
      else { factor = Math.max(0.6, 1 - diff * 0.15); reason = 'mismatch'; }
      const next = clamp(confidence * factor, 0, 1);
      return { confidence: next, expected, factor, reason };
    };
    const multilineValue = (fieldSpec.isMultiline || (lines?.length || 0) > 1)
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
          { anchorsOk: anchorOk, fingerprintOk:false, text:'', confidence:0, box: searchBox }
        );
      }
      return null;
    }
    if(multilineValue){
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', multilineValue, state.mode, spanKey);
      const fpDebugCtx = (runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey))
        ? { enabled:true, fieldKey: fieldSpec.fieldKey, cleanedValue: cleaned.value || cleaned.raw }
        : null;
      const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, fpDebugCtx);
      const cleanedOk = !!(cleaned.value || cleaned.raw);
      const baseConf = cleaned.conf || (cleanedOk ? 1 : 0.1);
      let confidence = fingerprintOk
        ? baseConf
        : (staticRun ? Math.max(0.2, Math.min(baseConf * 0.6, 0.5)) : 0);
      let lineAdj = null;
      if(runMode && ftype==='static'){
        lineAdj = adjustConfidenceForLines(confidence);
        confidence = lineAdj.confidence;
      }
      const lineInfo = computeLineDiff(observedLineCount, lineAdj?.expected);
      const attemptResult = {
        value: multilineValue || cleaned.value || cleaned.raw,
        raw: multilineValue,
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
          `attempt field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=${hits.length} anchorsOk=${anchorOk} fingerprintOk=${fingerprintOk} finalText="${(attemptResult.value||'').replace(/\s+/g,' ')}" conf=${attemptResult.confidence}`,
          { anchorsOk: anchorOk, fingerprintOk, text: attemptResult.value, confidence: attemptResult.confidence, box: searchBox }
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
        `attempt field=${fieldSpec.fieldKey||''} page=${searchBox.page||''} hits=${hits.length} anchorsOk=${anchorOk} fingerprintOk=${fingerprintOk} finalText="${(attemptResult.value||'').replace(/\s+/g,' ')}" conf=${attemptResult.confidence}`,
        { anchorsOk: anchorOk, fingerprintOk, text: attemptResult.value, confidence: attemptResult.confidence, box: searchBox }
      );
    }
    return attemptResult;
  }

  function scoreTriangulatedCandidates(opts){
    const { triBox, keywordPrediction, baseBox, existingResult, pageW, pageH } = opts;
    if(!triBox) return null;
    const triCx = triBox.x + (triBox.w||0)/2;
    const triCy = triBox.y + (triBox.h||0)/2;
    const maxRadius = KeywordWeighting?.MAX_KEYWORD_RADIUS || 0.35;
    const baseCx = baseBox ? baseBox.x + (baseBox.w||0)/2 : null;
    const baseCy = baseBox ? baseBox.y + (baseBox.h||0)/2 : null;
    const lines = groupIntoLines(tokens);
    const candidates = [];

    const evaluateCandidate = (candTokens, source='line')=>{
      if(!candTokens || !candTokens.length) return null;
      const box = mergeTokenBounds(candTokens);
      if(!box) return null;
      const cx = box.x + (box.w||0)/2;
      const cy = box.y + (box.h||0)/2;
      const distNorm = Math.hypot((cx - triCx)/pageW, (cy - triCy)/pageH);
      const baseDistNorm = (baseCx === null || baseCy === null)
        ? null
        : Math.hypot((cx - baseCx)/pageW, (cy - baseCy)/pageH);
      const baseBias = baseDistNorm === null
        ? 1
        : Math.max(0.65, 1 - Math.min(1, baseDistNorm / maxRadius));
      const distanceScore = Math.max(0, 1 - (distNorm / maxRadius)) * baseBias;
      const rawText = candTokens.map(t=>t.text).join(' ').trim();
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', rawText, state.mode, spanKey);
      const fingerprintOk = fingerprintMatches(fieldSpec.fieldKey||'', cleaned.code, state.mode, fieldSpec.fieldKey, null);
      const anchorOk = anchorMatchForBox(fieldSpec.anchorMetrics, box, candTokens, viewportDims.width, viewportDims.height);
      const keywordScore = keywordPrediction && KeywordWeighting?.computeKeywordWeight
        ? KeywordWeighting.computeKeywordWeight(box, keywordPrediction, { pageW, pageH, strongAnchor: anchorOk || fingerprintOk })
        : 1;
      const anchorScore = anchorOk ? 1 : 0.82;
      const fpScore = staticRun
        ? (fingerprintOk ? STATIC_FP_SCORES.ok : STATIC_FP_SCORES.fail)
        : (fingerprintOk ? 1.1 : 0.65);
      const observedLineCount = groupIntoLines(candTokens)?.length || 0;
      const lineInfo = computeLineDiff(observedLineCount);
      const lineScore = staticRun ? lineScoreForDiff(lineInfo.lineDiff) : 1;
      const baseConf = cleaned.conf || (cleaned.value || cleaned.raw ? 1 : 0.15);
      const totalScore = clamp(baseConf * keywordScore * (0.55 + distanceScore * 0.45) * anchorScore * fpScore * lineScore, 0, 2);
      const confidence = clamp((cleaned.conf || 0.6) * (fingerprintOk ? 1 : 0.75) * (anchorOk ? 1 : 0.85) * (0.55 + distanceScore * 0.45), 0, 1);
      return {
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
      };
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

  let result = null, method=null, score=null, comp=null, basePx=null;
  let keywordPrediction = null;
  let keywordMatch = null;
  let keywordWeight = 1;
  let triangulatedBox = null;
  let keywordIndex = null;
  let keywordContext = null;
  let selectionRaw = '';
  let firstAttempt = null;
  if(fieldSpec.bbox){
    const raw = toPx(viewportPx, {x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
    basePx = applyTransform(raw);
    if(runMode && ftype==='static' && staticDebugEnabled() && isStaticFieldDebugTarget(fieldSpec.fieldKey)){
      logStaticDebug(
        `bbox-transform field=${fieldSpec.fieldKey||''} page=${basePx.page||''} config=${formatArrayBox(fieldSpec.bbox)} transformed=${formatBoxForLog(basePx)} viewport=${viewportDims.width}x${viewportDims.height}`,
        { field: fieldSpec.fieldKey, page: basePx.page, configBox: fieldSpec.bbox, transformed: basePx, viewport: viewportDims, rawBox: raw }
      );
    }
    if(staticRun && keywordRelations){
      await ensureKeywordIndexForPage(basePx.page);
      keywordIndex = state.keywordIndexByPage?.[basePx.page] || [];
      const { pageW, pageH } = getPageSize(basePx.page);
      keywordContext = KeywordWeighting?.triangulateBox
        ? KeywordWeighting.triangulateBox(keywordRelations, keywordIndex, pageW, pageH, basePx, { configWeight: 1.2 })
        : null;
      triangulatedBox = keywordContext?.box || keywordContext || triangulatedBox;
      if(!keywordPrediction && keywordContext?.motherPred?.predictedBox){
        keywordPrediction = keywordContext.motherPred.predictedBox;
        keywordMatch = keywordContext.motherPred.entry || keywordRelations.mother;
      }
    }
    traceEvent(spanKey,'selection.captured',{ boxPx: basePx });
    const initialAttempt = await attempt(basePx);
    if(initialAttempt && initialAttempt.anchorOk === false){ initialAttempt.cleanedOk = false; }
    if(initialAttempt && initialAttempt.cleanedOk){
      firstAttempt = initialAttempt;
    } else if(initialAttempt && anchorMatchesCandidate(initialAttempt)){
      firstAttempt = initialAttempt;
    }
    selectionRaw = firstAttempt?.raw || '';
    if(staticRun && firstAttempt){
      const lineInfo = computeLineDiff(firstAttempt.lineCount, firstAttempt.expectedLineCount);
      const hasAnchor = firstAttempt.anchorOk !== false;
      if(hasAnchor && firstAttempt.fingerprintOk && lineInfo.lineDiff === 0){
        result = firstAttempt; method='bbox'; stageUsed.value = 0;
      } else if(hasAnchor && firstAttempt.fingerprintOk && firstAttempt.cleanedOk && lineInfo.lineDiff === 1){
        result = firstAttempt; method='bbox'; stageUsed.value = 1;
      }
    }
    if(!result && firstAttempt && firstAttempt.cleanedOk){
      result = firstAttempt; method='bbox';
    } else if(!result){
      const pads = isConfigMode() ? [4] : [4,8,12];
      for(const pad of pads){
        const search = { x: basePx.x - pad, y: basePx.y - pad, w: basePx.w + pad*2, h: basePx.h + pad*2, page: basePx.page };
        const r = await attempt(search);
        if(r && !anchorMatchesCandidate(r)){ continue; }
        if(r && r.cleanedOk){ result = r; method='bbox'; if(staticRun && stageUsed.value === null){ stageUsed.value = 2; } break; }
      }
    }
  }

  if(!result && ftype==='static' && fieldSpec.landmark && basePx){
    if(!runMode){
      let m = matchRingLandmark(fieldSpec.landmark, basePx);
      if(m){
        const box = { x: m.x + fieldSpec.landmark.offset.dx*basePx.w, y: m.y + fieldSpec.landmark.offset.dy*basePx.h, w: basePx.w, h: basePx.h, page: basePx.page };
        const r = await attempt(box);
        if(r && anchorMatchesCandidate(r) && r.value){ result=r; method='ring'; score=m.score; comp=m.comparator; }
      }
      if(!result){
        const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
        if(a){
          const r = await attempt(a.box);
          if(r && anchorMatchesCandidate(r) && r.value){ result=r; method='anchor'; comp='text_anchor'; score:null; }
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
            if(r && anchorMatchesCandidate(r) && r.value && geomOk && gramOk){ result=r; method=`partial-${half}`; score=m.score; comp=m.comparator; break; }
          }
        }
      }
    } else {
      const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
      if(a){
        const r = await attempt(a.box);
        if(r && anchorMatchesCandidate(r) && r.value){ result=r; method='anchor'; comp='text_anchor'; score:null; }
      }
    }
  }
  if(!result && staticRun && keywordRelations && keywordRelations.secondaries?.length){
    const page = basePx?.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    if(!state.keywordIndexByPage?.[page]){
      await ensureKeywordIndexForPage(page);
    }
    keywordIndex = keywordIndex || state.keywordIndexByPage?.[page] || [];
    keywordContext = keywordContext || (KeywordWeighting?.triangulateBox
      ? KeywordWeighting.triangulateBox(keywordRelations, keywordIndex, pageW, pageH, basePx, { configWeight: 1.2 })
      : null);
    triangulatedBox = keywordContext?.box || keywordContext || triangulatedBox;
    if(triangulatedBox){
      for(const pad of [0,3]){
        const probe = { x: triangulatedBox.x - pad, y: triangulatedBox.y - pad, w: triangulatedBox.w + pad*2, h: triangulatedBox.h + pad*2, page: triangulatedBox.page };
        const r = await attempt(probe);
        if(r && anchorMatchesCandidate(r) && r.value){
          r.confidence = Math.min(r.confidence || 0.45, 0.45);
          result = r; method='keyword-triangulation'; comp='keyword'; score = score || null; break;
        }
      }
    }
  }
  if(!result){
    const lv = labelValueHeuristic(fieldSpec, tokens);
    if(lv.value){
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', lv.value, state.mode, spanKey);
      let candidateTokens = [];
      if(lv.usedBox){ candidateTokens = tokensInBox(tokens, lv.usedBox, { minOverlap: staticMinOverlap }); }
      const boxOk = !enforceAnchors || (lv.usedBox && anchorMatchForBox(fieldSpec.anchorMetrics, lv.usedBox, candidateTokens, viewportDims.width, viewportDims.height));
      if(boxOk){
        result = { value: cleaned.value || cleaned.raw, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: lv.usedBox, confidence: lv.confidence, method: method||'anchor', score:null, comparator: 'text_anchor', tokens: candidateTokens };
      }
    }
  }

  if(!result){
    traceEvent(spanKey,'fallback.search',{});
    const fb = FieldDataEngine.clean(fieldSpec.fieldKey||'', state.snappedText, state.mode, spanKey);
    traceEvent(spanKey,'fallback.pick',{ value: fb.value || fb.raw });
    result = { value: fb.value || fb.raw, raw: selectionRaw || fb.raw, corrected: fb.corrected, code: fb.code, shape: fb.shape, score: fb.score, correctionsApplied: fb.correctionsApplied, corrections: fb.correctionsApplied, boxPx: state.snappedPx || basePx || null, confidence: fb.value ? 0.3 : 0, method: method||'fallback', score };
  }
  if(!result.value && selectionRaw){
    bumpDebugBlank();
    const raw = selectionRaw.trim();
    result.value = raw; result.raw = raw; result.confidence = 0.1; result.boxPx = result.boxPx || basePx || state.snappedPx || null; result.tokens = result.tokens || firstAttempt?.tokens || [];
  }
  if(staticRun && keywordRelations && result && basePx){
    const page = result.boxPx?.page || basePx.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    if(!state.keywordIndexByPage?.[page]){
      await ensureKeywordIndexForPage(page);
    }
    keywordIndex = keywordIndex || state.keywordIndexByPage?.[page] || [];
    if(!keywordPrediction && keywordContext?.motherPred?.predictedBox){
      keywordPrediction = keywordContext.motherPred.predictedBox;
      keywordMatch = keywordContext.motherPred.entry || keywordRelations.mother;
    }
    if(!keywordPrediction && KeywordWeighting?.chooseKeywordMatch && keywordRelations.mother){
      const refBox = result.boxPx || basePx;
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
  if(staticRun && keywordRelations && triangulatedBox){
    const page = triangulatedBox.page || result?.boxPx?.page || basePx?.page || fieldSpec.page || state.pageNum || 1;
    const { pageW, pageH } = getPageSize(page);
    const scored = scoreTriangulatedCandidates({
      triBox: triangulatedBox,
      keywordPrediction,
      baseBox: basePx,
      existingResult: result,
      pageW,
      pageH
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
  traceEvent(spanKey,'value.finalized',{ value: result.value, confidence: result.confidence, method: result.method });
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
      const filtered = (tokList || []).filter(tok => anchorMatchForBox(saved, { x: tok.x, y: tok.y, w: tok.w, h: tok.h }, [tok], pageWidth, pageHeight));
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
  const left = rect.left - parentRect.left + els.viewer.scrollLeft;
  const top = rect.top - parentRect.top + els.viewer.scrollTop;
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
    const loadingTask = pdfjsLibRef.getDocument({ data: arrayBuffer });
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
  state.tokensByPage = {};
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
  state.currentLineItems = [];
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
      state.pageRenderReady[0] = true;
      state.pageRenderPromises[0] = Promise.resolve();
      state.tokensByPage[1] = [];
      state.numPages = 1;
      return { type:'image' };
    } catch(err){
      console.error('Image load failed in run mode', err);
      alert('Could not load image for extraction.');
      return null;
    }
  }

  const loadingTask = pdfjsLibRef.getDocument({ data: arrayBuffer });
  state.pdf = await loadingTask.promise;
  const scale = 1.5;
  let totalH = 0;
  for(let i=1; i<=state.pdf.numPages; i++){
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale });
    vp.w = vp.width; vp.h = vp.height; vp.pageNumber = i;
    state.pageViewports[i-1] = vp;
    state.pageOffsets[i-1] = totalH;
    const tokens = await readTokensForPage(page, vp);
    tokens.forEach(t => { t.page = i; });
    state.tokensByPage[i] = tokens;
    if(isRunMode()) console.log(`[run-mode] tokens generated for page ${i}/${state.pdf.numPages}`);
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
  const scale = 1.5;
  const ctx = els.pdfCanvas.getContext('2d', { willReadFrequently: true });
  state.pageViewports = [];
  state.pageOffsets = [];

  let maxW = 0, totalH = 0;
  const pageCanvases = [];
  for(let i=1; i<=state.pdf.numPages; i++){
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale });
    vp.w = vp.width; // ensure width/height aliases for downstream calcs
    vp.h = vp.height;
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

  els.pdfCanvas.width = maxW;
  els.pdfCanvas.height = totalH;
  els.pdfCanvas.style.width = maxW + 'px';
  els.pdfCanvas.style.height = totalH + 'px';
  sizeOverlayTo(maxW, totalH);

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

async function buildKeywordIndexForPage(pageNum, tokens=null, vpOverride=null){
  if(state.keywordIndexByPage[pageNum]) return state.keywordIndexByPage[pageNum];
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
  const matches = [];

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

  state.keywordIndexByPage[pageNum] = matches;
  logStaticDebug(`keyword-index page=${pageNum}`, { tokens: tokens.length, matches: matches.length });
  return matches;
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
  traceEvent(spanKey,'selection.captured',{ normBox: nb, pixelBox: state.snappedPx, cssBox: state.snappedCss, cssSize:{ w:srcRect.width, h:srcRect.height }, pxSize:{ w:vp.width, h:vp.height }, dpr: window.devicePixelRatio || 1, overlayPinned: pinned });
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
      const vp = state.pageViewports[pageIdx] || page.getViewport({ scale: 1.5 });
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
    return;
  }
  els.snapshotDetail.innerHTML = `<img src="${dataUrl}" alt="Snapshot page ${page.pageNumber}" />`;
}

function renderSnapshotPanel(manifest){
  if(!els.snapshotPanel || !manifest){
    if(els.snapshotPanel) els.snapshotPanel.style.display = 'none';
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
function compileDocument(fileId, lineItems){
  const raw = rawStore.get(fileId);
  const byKey = {};
  if(!state.snapshotMode){ state.lastSnapshotManifestId = ''; }
  state.selectedRunId = fileId || state.selectedRunId;
  raw.forEach(r=>{ byKey[r.fieldKey] = { value: r.value, raw: r.raw, correctionsApplied: r.correctionsApplied || [], confidence: r.confidence || 0, tokens: r.tokens || [] }; });
  (state.profile?.fields||[]).forEach(f=>{
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
  const db = LS.getDb(state.username, state.docType);
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
    lineItems: enriched,
    templateKey: `${state.username}:${state.docType}`,
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
  LS.setDb(state.username, state.docType, db);
  renderResultsTable();
  renderTelemetry();
  renderReports();
  return compiled;
}

function renderResultsTable(){
  const mount = document.getElementById('resultsMount');
  const dt = els.dataDocType?.value || state.docType;
  let db = LS.getDb(state.username, dt);
  if(!db.length){ mount.innerHTML = '<p class="sub">No extractions yet.</p>'; return; }
  db = db.sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO));

  const firstId = db[0]?.fileId || '';
  if(!state.selectedRunId || !db.some(r => r.fileId === state.selectedRunId)){
    state.selectedRunId = firstId;
  }

  const keySet = new Set();
  db.forEach(r => Object.keys(r.fields||{}).forEach(k=>keySet.add(k)));
  const keys = Array.from(keySet);
  const showRaw = state.modes.rawData || els.showRawToggle?.checked;

  const thead = `<tr><th>file</th>${keys.map(k=>`<th>${k}</th>`).join('')}<th>line items</th></tr>`;
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

  mount.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;

  mount.querySelectorAll('input.editField').forEach(inp=>inp.addEventListener('change', ()=>{
    const fileId = inp.dataset.file;
    const field = inp.dataset.field;
    const prop = inp.dataset.prop || 'value';
    const dt = els.dataDocType?.value || state.docType;
    const db = LS.getDb(state.username, dt);
    const rec = db.find(r=>r.fileId===fileId);
    if(rec && rec.fields?.[field]){
      rec.fields[field][prop] = inp.value;
      if(prop === 'value'){
        rec.fields[field].confidence = 1;
        if(rec.invoice[field] !== undefined) rec.invoice[field] = inp.value;
      if(rec.totals[field] !== undefined) rec.totals[field] = inp.value;
    }
    LS.setDb(state.username, dt, db);
    renderResultsTable();
    renderReports();
    renderSavedFieldsTable();
  }
  }));
  mount.querySelectorAll('tr[data-file]').forEach(tr => tr.addEventListener('click', evt => {
    if((evt.target?.tagName||'').toLowerCase() === 'input') return;
    state.selectedRunId = tr.dataset.file || '';
    mount.querySelectorAll('tr[data-file]').forEach(row => row.classList.toggle('results-selected', row.dataset.file === state.selectedRunId));
    syncSnapshotUi();
  }));
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
  const dt = els.dataDocType?.value || state.docType;
  let db = LS.getDb(state.username, dt);
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
  const existing = state.profile.fields.find(f => f.fieldKey === step.fieldKey);
  const pctBox = { x0: normBox.x0n, y0: normBox.y0n, x1: normBox.x0n + normBox.wN, y1: normBox.y0n + normBox.hN };
  if(step.type === 'static'){
    const clash = (state.profile.fields||[]).find(f=>f.fieldKey!==step.fieldKey && f.type==='static' && f.page===page && Math.min(pctBox.y1,f.bboxPct.y1) - Math.max(pctBox.y0,f.bboxPct.y0) > 0);
    if(clash){
      console.warn('Overlapping static bboxes, adjusting', step.fieldKey, clash.fieldKey);
      const shift = (clash.bboxPct.y1 - clash.bboxPct.y0) + 0.001;
      pctBox.y0 = clash.bboxPct.y1 + 0.001;
      pctBox.y1 = pctBox.y0 + shift;
      normBox.y0n = pctBox.y0;
      normBox.hN = pctBox.y1 - pctBox.y0;
    }
  }
  const entry = {
    fieldKey: step.fieldKey,
    type: step.type,
    page,
    selectorType:'bbox',
    bbox:[pctBox.x0, pctBox.y0, pctBox.x1, pctBox.y1],
    bboxPct:{x0:pctBox.x0, y0:pctBox.y0, x1:pctBox.x1, y1:pctBox.y1},
    normBox,
    rawBox,
    value,
    confidence,
    raw,
    correctionsApplied: corrections,
    tokens
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
  saveProfile(state.username, state.docType, state.profile);
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
  }
}
function renderSavedFieldsTable(){
  const db = LS.getDb(state.username, state.docType);
  const latest = db.slice().sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO))[0];
  state.savedFieldsRecord = latest || null;
  const order = (state.profile?.fields||[]).map(f=>f.fieldKey);
  const fields = order.map(k => ({ fieldKey:k, value: latest?.fields?.[k]?.value }))
    .filter(f => f.value !== undefined && f.value !== null && String(f.value).trim() !== '');
  if(!fields.length){
    els.fieldsPreview.innerHTML = '<p class="sub">No fields yet.</p>';
  } else {
    const thead = `<tr>${fields.map(f=>`<th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">${f.fieldKey}</th>`).join('')}</tr>`;
    const row = `<tr>${fields.map(f=>`<td style="padding:6px;border-bottom:1px solid var(--border)">${(f.value||'').toString().replace(/</g,'&lt;')}</td>`).join('')}</tr>`;
    els.fieldsPreview.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${row}</tbody></table></div>`;
  }
  els.savedJson.textContent = serializeProfile(state.profile);
  renderConfirmedTables(latest);
}

let confirmedRenderPending = false;
function renderConfirmedTables(rec){
  if(isRunMode()){
    console.warn('[run-mode] renderConfirmedTables invoked during RUN; skipping RAF update');
    return;
  }
  if(confirmedRenderPending) return;
  confirmedRenderPending = true;
  requestAnimationFrame(()=>{
    confirmedRenderPending = false;
    const latest = rec || LS.getDb(state.username, state.docType).slice().sort((a,b)=> new Date(b.processedAtISO) - new Date(a.processedAtISO))[0];
    const fDiv = document.getElementById('confirmedFields');
    const liDiv = document.getElementById('confirmedLineItems');
    if(fDiv){
      const typeMap = {};
      (state.profile?.fields||[]).forEach(f=>{ typeMap[f.fieldKey]=f.type; });
      const statics = Object.entries(latest?.fields||{}).filter(([k,v])=>typeMap[k]==='static' && v.value);
      if(!statics.length){ fDiv.innerHTML = '<p class="sub">No fields yet.</p>'; }
      else {
        const rows = statics.map(([k,f])=>{
          const warn = (f.confidence||0) < 0.8 || (f.correctionsApplied&&f.correctionsApplied.length) ? '<span class="warn">⚠️</span>' : '';
          const conf = `<span class="confidence">${Math.round((f.confidence||0)*100)}%</span>`;
          return `<tr><td>${k}</td><td><input class="confirmEdit" data-field="${k}" value="${f.value}"/>${warn}${conf}</td></tr>`;
        }).join('');
        fDiv.innerHTML = `<table class="line-items-table"><tbody>${rows}</tbody></table>`;
        fDiv.querySelectorAll('input.confirmEdit').forEach(inp=>inp.addEventListener('change',()=>{
          const db = LS.getDb(state.username, state.docType);
          const rec = db.find(r=>r.fileId===latest?.fileId);
          if(rec && rec.fields?.[inp.dataset.field]){
            rec.fields[inp.dataset.field].value = inp.value;
            rec.fields[inp.dataset.field].confidence = 1;
            LS.setDb(state.username, state.docType, db);
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
els.loginForm?.addEventListener('submit', (e)=>{
  e.preventDefault();
  state.username = (els.username?.value || 'demo').trim();
  state.docType = els.docType?.value || 'invoice';
  const existing = loadProfile(state.username, state.docType);
  state.profile = existing || null;
  hydrateFingerprintsFromProfile(state.profile);
  els.loginSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('document-dashboard');
  populateModelSelect();
  renderResultsTable();
});
els.logoutBtn?.addEventListener('click', ()=>{
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'none';
  els.loginSection.style.display = 'block';
});
els.resetModelBtn?.addEventListener('click', ()=>{
  if(!state.username) return;
  if(!confirm('Clear saved model and extracted records?')) return;
  LS.removeProfile(state.username, state.docType);
  const models = getModels().filter(m => !(m.username === state.username && m.docType === state.docType));
  setModels(models);
  localStorage.removeItem(LS.dbKey(state.username, state.docType));
  state.profile = null;
  hydrateFingerprintsFromProfile(null);
  renderSavedFieldsTable();
  populateModelSelect();
  renderResultsTable();
  alert('Model and records reset.');
});
els.configureBtn?.addEventListener('click', ()=>{
  ensureProfile();
  activateConfigMode();
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  renderSavedFieldsTable();
});
els.demoBtn?.addEventListener('click', ()=> els.wizardFile.click());
els.staticDebugBtn?.addEventListener('click', showStaticDebugModal);
els.staticDebugClose?.addEventListener('click', hideStaticDebugModal);
els.staticDebugRefresh?.addEventListener('click', renderStaticDebugLogs);
els.staticDebugClear?.addEventListener('click', ()=>{ window.clearStaticDebugLogs?.(); renderStaticDebugLogs(); });
els.staticDebugToggle?.addEventListener('change', ()=>{
  const enabled = !!els.staticDebugToggle.checked;
  window.DEBUG_STATIC_FIELDS = enabled;
  DEBUG_STATIC_FIELDS = enabled;
});

els.docType?.addEventListener('change', ()=>{
  state.docType = els.docType.value || 'invoice';
  const existing = loadProfile(state.username, state.docType);
  state.profile = existing || null;
  hydrateFingerprintsFromProfile(state.profile);
  renderSavedFieldsTable();
  populateModelSelect();
});

els.dataDocType?.addEventListener('change', ()=>{ renderResultsTable(); renderReports(); });
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
    const id = modelSelect.value;
    if(!id) return;
    loadModelById(id);
    activateRunMode({ clearDoc: true });
    renderSavedFieldsTable();
    renderConfirmedTables();
    renderResultsTable();
    alert('Model selected. Drop files to auto-extract.');
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

// Single-file open (wizard)
els.wizardFile?.addEventListener('change', async e=>{
  const f = e.target.files?.[0]; if(!f) return;
  if(isRunMode()){
    activateRunMode({ clearDoc: true });
    els.app.style.display = 'none';
    els.wizardSection.style.display = 'block';
    ensureProfile();
    await runModeExtractFileWithProfile(f, state.profile);
    renderSavedFieldsTable();
    renderConfirmedTables();
    return;
  }
  await openFile(f);
});

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
  if(state.stepIdx > 0) goToStep(state.stepIdx - 1);
});

els.skipBtn?.addEventListener('click', ()=>{
  if(state.stepIdx < state.steps.length - 1) goToStep(state.stepIdx + 1);
  else finishWizard();
});

// Confirm → extract + save + insert record, advance step
els.confirmBtn?.addEventListener('click', async ()=>{
  if(!state.snappedPx){ alert('Draw a box first.'); return; }
  const tokens = await ensureTokensForPage(state.pageNum);
  const step = state.steps[state.stepIdx] || DEFAULT_FIELDS[state.stepIdx] || DEFAULT_FIELDS[0];

  let value = '', boxPx = state.snappedPx;
  let confidence = 0, raw = '', corrections=[];
  let fieldTokens = [];
  if(step.kind === 'landmark'){
    value = (state.snappedText || '').trim();
    raw = value;
  } else if (step.type === 'static'){
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
  } else if (step.kind === 'block'){
    value = (state.snappedText || '').trim();
    raw = value;
  } else {
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

  if(els.ocrToggle?.checked){
    try { await auditCropSelfTest(step.fieldKey || step.prompt || 'question', boxPx); }
    catch(err){ console.error('auditCropSelfTest failed', err); }
  }

  const vp = state.pageViewports[state.pageNum-1] || state.viewport || {width:1,height:1};
  const canvasW = (vp.width ?? vp.w) || 1;
  const canvasH = (vp.height ?? vp.h) || 1;
  const normBox = normalizeBox(boxPx, canvasW, canvasH);
  const pct = { x0: normBox.x0n, y0: normBox.y0n, x1: normBox.x0n + normBox.wN, y1: normBox.y0n + normBox.hN };
  const rawBoxData = { x: boxPx.x, y: boxPx.y, w: boxPx.w, h: boxPx.h, canvasW, canvasH };
  const keywordRelations = (step.type === 'static')
    ? computeKeywordRelationsForConfig(step.fieldKey, boxPx, normBox, state.pageNum, canvasW, canvasH)
    : null;
  const extras = {};
  if(step.type === 'static'){
    const lm = captureRingLandmark(boxPx);
    lm.anchorHints = ANCHOR_HINTS[step.fieldKey] || [];
    extras.landmark = lm;
    if(state.snappedLineMetrics){
      extras.lineMetrics = clonePlain(state.snappedLineMetrics);
    }
    extras.keywordRelations = keywordRelations || null;
  } else if(step.type === 'column'){
    extras.column = buildColumnModel(step, pct, boxPx, tokens);
  }
  upsertFieldInProfile(step, normBox, value, confidence, state.pageNum, extras, raw, corrections, fieldTokens, rawBoxData);
  ensureAnchorFor(step.fieldKey);
  state.currentLineItems = await extractLineItems(state.profile);

  const fid = state.currentFileId;
  if(fid){
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
  const dt = docType || els.dataDocType?.value || state.docType;
  if(preferred) return { record: preferred, dt };
  const db = LS.getDb(state.username, dt);
  if(!db.length) return { record: null, dt };
  const selected = state.selectedRunId ? db.find(r => r.fileId === state.selectedRunId) : null;
  return { record: selected || db[0], dt };
}

function downloadMasterDb(record, docType){
  const { record: target, dt } = resolveRecordForDocType(docType, record);
  if(!target){
    alert('No extraction record available for export.');
    return;
  }
  try {
    const csv = MasterDB.toCsv(target);
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
  saveCurrentProfileAsModel();
  compileDocument(state.currentFileId);
  activateRunMode({ clearDoc: true });
  els.wizardSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('extracted-data');
  populateModelSelect();
});

/* ---------------------------- Batch ------------------------------- */
async function runModeExtractFileWithProfile(file, profile){
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
    if(isRunMode()) console.log(`[run-mode] starting extraction for ${file?.name || 'file'}`);
    state.profile = profile ? migrateProfile(clonePlain(profile)) : profile;
    hydrateFingerprintsFromProfile(state.profile);
    const activeProfile = state.profile || profile || { fields: [] };
    const prepared = await prepareRunDocument(file);
    if(!prepared){ return; }
    if(isRunMode()) console.log(`[run-mode] tokens cached for ${state.numPages} page(s)`);

    for(const spec of (activeProfile.fields || [])){
      const placement = spec.type === 'static'
        ? resolveStaticPlacement(spec, state.pageViewports, state.numPages)
        : null;
      const targetPage = placement?.pageNumber
        ? clamp(placement.pageNumber, 1, state.numPages || 1)
        : clamp(Number.isFinite(spec.page) ? spec.page : (state.pageNum || 1), 1, state.numPages || 1);
      state.pageNum = targetPage;
      state.viewport = state.pageViewports[targetPage-1] || state.viewport;
      const tokens = state.tokensByPage[targetPage] || [];
      const configMask = placement?.configMask || normalizeConfigMask(spec);
      const bboxArr = placement?.bbox || spec.bbox;
      const keywordRelations = spec.keywordRelations ? clonePlain(spec.keywordRelations) : null;
      if(keywordRelations && keywordRelations.page && keywordRelations.page !== targetPage){
        keywordRelations.page = targetPage;
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
        configMask
      };
      if(spec.type === 'static'){
        const hitTokens = placement?.boxPx ? tokensInBox(tokens, placement.boxPx, { minOverlap: 0 }) : [];
        logStaticDebug(
          `resolve ${spec.fieldKey || ''}: role=${placement?.pageRole || spec.pageRole || inferPageRole(spec, targetPage)} anchor=${placement?.anchor || spec.verticalAnchor || inferVerticalAnchor(spec)} pages=${state.numPages || 1} -> page ${targetPage} box=${formatBoxForLog(placement?.boxPx)}`,
          { tokens: hitTokens.length, preview: summarizeTokens(hitTokens) }
        );
      }
      state.snappedPx = null; state.snappedText = '';
      const { value, boxPx, confidence, raw, corrections } = await extractFieldValue(fieldSpec, tokens, state.viewport);
      if(value){
        const vp = state.pageViewports[targetPage-1] || state.viewport || {width:1,height:1};
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
      }
    }
    if(isRunMode()) console.log(`[run-mode] static fields extracted (${(activeProfile.fields||[]).length})`);
    const lineItems = await extractLineItems(activeProfile);
    if(isRunMode()) console.log(`[run-mode] dynamic line items extracted (${lineItems.length})`);
    const compiled = compileDocument(state.currentFileId, lineItems);
    if(state.snapshotMode){
      const manifest = await buildSnapshotManifest(state.currentFileId, getOverlayFlags());
      if(manifest){ compiled.snapshotManifestId = manifest.id; }
    }
    if(isRunMode()) console.log(`[run-mode] MasterDB written for ${compiled.fileId}`);
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
  activateRunMode({ clearDoc: true });
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile(); renderSavedFieldsTable();
  const modelId = document.getElementById('model-select')?.value || '';
  const model = modelId ? getModels().find(m => m.id === modelId) : null;
  const profile = model ? model.profile : state.profile;

  for(const f of files){
    await runModeExtractFileWithProfile(f, profile);
  }
  els.wizardSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('extracted-data');
}

/* ------------------------ Init on load ---------------------------- */
renderResultsTable();
renderReports();
syncRawModeUI();
initSnapshotMode();
syncModeUi();
syncStaticDebugToggleUI();
