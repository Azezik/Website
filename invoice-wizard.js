// ===== pdf.js & tesseract bindings (must appear before any getDocument call) =====
const pdfjsLibRef = window.pdfjsLib;
const TesseractRef = window.Tesseract;

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
  uploadBtn:       document.getElementById('upload-btn'),
  resetModelBtn:   document.getElementById('reset-model-btn'),
  logoutBtn:       document.getElementById('logout-btn'),
  dropzone:        document.getElementById('dropzone'),
  fileInput:       document.getElementById('file-input'),

  // wizard
  wizardSection:   document.getElementById('wizard-section'),
  wizardFile:      document.getElementById('wizard-file'),
  viewer:          document.getElementById('viewer'),

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
  mode: 'CONFIG',
  modes: { rawData: false },
  profile: null,             // Vendor profile (landmarks + fields + tableHints)
  pdf: null,                 // pdf.js document
  isImage: false,
  pageNum: 1,
  numPages: 1,
  viewport: { w: 0, h: 0, scale: 1 },
  pageViewports: [],       // viewport per page
  pageOffsets: [],         // y-offset of each page within pdfCanvas
  tokensByPage: {},          // {page:number: Token[] in px}
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
  lastOcrCropPx: null,
  cropAudits: [],
  cropHashes: {},        // per page hash map for duplicate detection
  pageSnapshots: {},     // tracks saved full-page debug PNGs
  pageRenderPromises: [],
  pageRenderReady: [],
  currentTraceId: null,
  overlayPinned: false,
  overlayMetrics: null,
  pendingSelection: null,
  lastOcrCropCss: null,
};

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
const PROFILE_VERSION = 4;
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
  saveProfile(state.username, state.docType, state.profile);
  return m.profile;
}

/* ------------------------- Utilities ------------------------------ */
const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));

const toPx = (vp, pctBox) => {
  const dpr = window.devicePixelRatio || 1;
  const w = ((vp.w ?? vp.width) || 1) * dpr;
  const h = ((vp.h ?? vp.height) || 1) * dpr;
  const x = pctBox.x0 * w;
  const y = pctBox.y0 * h;
  const wPx = (pctBox.x1 - pctBox.x0) * w;
  const hPx = (pctBox.y1 - pctBox.y0) * h;
  return { x, y, w: wPx, h: hPx, page: pctBox.page };
};

const toPct = (vp, pxBox) => {
  const dpr = window.devicePixelRatio || 1;
  const w = ((vp.w ?? vp.width) || 1) * dpr;
  const h = ((vp.h ?? vp.height) || 1) * dpr;
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

function applyTransform(boxPx, transform=state.pageTransform){
  const { scale=1, rotation=0 } = transform || {};
  if(scale === 1 && rotation === 0) return { ...boxPx };
  const vp = state.pageViewports[boxPx.page-1] || state.viewport;
  const dpr = window.devicePixelRatio || 1;
  const wPage = ((vp.w ?? vp.width) || 1) * dpr;
  const hPage = ((vp.h ?? vp.height) || 1) * dpr;
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
  const q1 = /[A-Za-z]/.test(str) ? '1' : '2';
  const q2 = /[0-9]/.test(str) ? '1' : '2';
  const q3 = /\s/.test(str) ? '1' : '2';
  const q4 = /[-\/()]/.test(str) ? '1' : '2';
  const q5 = /[$€£¢%]/.test(str) || /\d+\.\d{2}/.test(str) ? '1' : '2';
  return q1 + q2 + q3 + q4 + q5;
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

const FieldDataEngine = (() => {
  const patterns = {};
  const fieldDefs = {
    store_name:      { codes:['12122','11112'], regex:"^[A-Z&.'\\s-]{2,60}$" },
    department_division:{ codes:['12122','12112'], regex:"^[A-Z&.'\\s-]{2,60}$" },
    invoice_number:  { codes:['21222','11222','11212'], regex:'^[A-Z0-9-]{3,20}$' },
    invoice_date:    { codes:['21212','11122'], regex:'^(\\d{4}-\\d{2}-\\d{2}|\\d{2}[\\/\\-]\\d{2}[\\/\\-]\\d{4}|[A-Z][a-z]+\\s\\d{1,2},\\s\\d{4})$' },
    salesperson_rep: { codes:['12122','11222','11212','21222'], regex:"^[A-Z&.'\\s-]{2,60}$" },
    customer_name:   { codes:['12122'], regex:"^[A-Z&.'\\s-]{2,60}$" },
    customer_address:{ codes:['11122','11112'], regex:'(\\d{5}(?:-\\d{4})?|[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d)' },
    description:     { codes:['11122','11112'] },
    sku:             { codes:['11222','11212'], regex:'^[A-Z0-9-]{5,12}$' },
    quantity:        { codes:['21222'] },
    unit_price:      { codes:['21221'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' },
    amount:          { codes:['21221'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' },
    subtotal_amount: { codes:['21221'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' },
    invoice_total:   { codes:['21221'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' },
    discounts_amount:{ codes:['21211','21221'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' },
    tax_amount:      { codes:['21221','11121'], regex:'^-?\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})?$' }
  };

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
    const arr = Array.isArray(input) ? input : [{text: String(input||'')}];
    const lineStrs = Array.isArray(input) ? groupIntoLines(arr).map(L=>L.tokens.map(t=>t.text).join(' ').trim()) : [String(input||'')];
    let raw = lineStrs.join(' ').trim();
    if(spanKey) traceEvent(spanKey,'clean.start',{ raw });
    let joined = lineStrs.join(' ').trim();
    if(ftype==='customer_address') joined = lineStrs.join(', ').trim();
    const deduped = collapseAdjacentDuplicates(joined);
    if(spanKey && deduped!==joined) traceEvent(spanKey,'dedupe.applied',{ before:joined, after:deduped });
    let txt = deduped.replace(/\s+/g,' ').trim().replace(/[#:—•]*$/, '');
    if(/date/i.test(ftype)){ const n = normalizeDate(txt); if(n) txt = n; }
    else if(/total|subtotal|tax|amount|price|balance|deposit|discount|unit|grand|quantity|qty/.test(ftype)){
      const n = normalizeMoney(txt); if(n) txt = n;
    } else if(/sku|product_code/.test(ftype)){
      txt = txt.replace(/\s+/g,'').toUpperCase();
    }
    let conf = arr.reduce((s,t)=>s+(t.confidence||1),0)/arr.length;
    const def = fieldDefs[ftype] || {};
    const regex = def.regex ? new RegExp(def.regex, 'i') : null;
    let code = codeOf(txt);
    let shape = shapeOf(txt);
    let digit = digitRatio(txt);
    if(mode === 'CONFIG'){
      const codeOk = !def.codes || def.codes.includes(code);
      const regexOk = !regex || regex.test(txt);
      if(codeOk && regexOk) learn(ftype, txt);
      else bumpDebugBlank();
      if(spanKey) traceEvent(spanKey, codeOk && regexOk ? 'clean.success' : 'clean.fail', { value: txt, raw });
      return { value: raw, raw, corrected: regexOk && regex ? ((txt.match(regex)||[])[1]||txt) : raw, conf, code, shape, score: (codeOk && regexOk) ? 1 : 0, correctionsApplied: [], digit };
    }
    if(/customer_name|salesperson_rep|store_name|department_division/.test(ftype)){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
        if(/^[\d,]/.test(txt) || digit > 0.15 || postalRe.test(txt)){
          if(spanKey) traceEvent(spanKey,'clean.fail',{ raw, reason:'format_reject' });
          return { value:'', raw, corrected:txt, conf, code, shape, score:0, correctionsApplied:[], digit };
        }
    }
    if(ftype==='customer_address'){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
        if(!/\d/.test(txt) && !postalRe.test(txt)){
          if(spanKey) traceEvent(spanKey,'clean.fail',{ raw, reason:'address_reject' });
          return { value:'', raw, corrected:txt, conf, code, shape, score:0, correctionsApplied:[], digit };
        }
    }
    if(/customer_name|salesperson_rep|store_name|department_division/.test(ftype)){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
        if(/^[\d,]/.test(txt) || digit > 0.15 || postalRe.test(txt)){
          if(spanKey) traceEvent(spanKey,'clean.fail',{ raw, reason:'format_reject' });
          return { value:'', raw, corrected:txt, conf, code, shape, score:0, correctionsApplied:[], digit };
        }
    }
    if(ftype==='customer_address'){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
        if(!/\d/.test(txt) && !postalRe.test(txt)){
          if(spanKey) traceEvent(spanKey,'clean.fail',{ raw, reason:'address_reject' });
          return { value:'', raw, corrected:txt, conf, code, shape, score:0, correctionsApplied:[], digit };
        }
    }
    let score = 0;
    if(def.codes && def.codes.includes(code)) score += 2;
    if(regex && regex.test(txt)) score += 2;
    const dom = dominant(ftype);
    if((dom.code && dom.code===code) || (dom.shape && dom.shape===shape) || (dom.len && dom.len===txt.length)) score += 1;
    if(dom.digit && Math.abs(dom.digit - digit) < 0.01) score += 1;
    let correctionsApplied = [];
    let corrected = txt;
    if(conf < 0.8 && regex && !regex.test(txt)){
      const { text: corr, corrections } = applyOcrCorrections(txt, ftype);
      if(corrections.length){
        correctionsApplied = corrections;
        score -= 2;
      }
      if(regex.test(corr) && (!def.codes || def.codes.includes(codeOf(corr)))){
        corrected = corr;
        code = codeOf(corrected);
        shape = shapeOf(corrected);
        digit = digitRatio(corrected);
        score += 1;
      }
    }
    if(score >= 5){
      learn(ftype, corrected);
      if(spanKey) traceEvent(spanKey,'clean.success',{ value: corrected, score });
      return { value: corrected, raw, corrected, conf, code, shape, score, correctionsApplied, digit };
    }
    bumpDebugBlank();
    if(spanKey) traceEvent(spanKey,'clean.fail',{ raw, score });
    return { value: raw, raw, corrected, conf: Math.min(conf, 0.3), code, shape, score, correctionsApplied, digit };
  }

  function exportPatterns(){ return patterns; }
  function importPatterns(p){ Object.assign(patterns, p || {}); }

  return { codeOf, shapeOf, digitRatio, clean, exportPatterns, importPatterns };
})();

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
function tokensInBox(tokens, box){
  return tokens.filter(t => {
    if(t.page !== box.page) return false;
    const cx = t.x + t.w/2;
    if(cx < box.x || cx > box.x + box.w) return false;
    const overlapY = Math.min(t.y + t.h, box.y + box.h) - Math.max(t.y, box.y);
    const minOverlap = state.mode === 'CONFIG' ? 0.5 : 0.7;
    if(overlapY / t.h < minOverlap) return false;
    return true;
  }).sort((a,b)=>{
    const ay = a.y + a.h/2, by = b.y + b.h/2;
    return ay === by ? a.x - b.x : ay - by;
  });
}
function snapToLine(tokens, hintPx, marginPx=6){
  const hits = tokensInBox(tokens, hintPx);
  if(!hits.length) return { box: hintPx, text: '' };
  const bandCy = hits.map(t => t.y + t.h/2).reduce((a,b)=>a+b,0)/hits.length;
  const line = groupIntoLines(tokens, 4).find(L => Math.abs(L.cy - bandCy) <= 4);
  const lineTokens = line ? tokensInBox(line.tokens, hintPx) : hits;
  // Horizontally limit to tokens inside the hint box, but keep full line height
  const left   = Math.min(...hits.map(t => t.x));
  const right  = Math.max(...hits.map(t => t.x + t.w));
  const top    = Math.min(...lineTokens.map(t => t.y));
  const bottom = Math.max(...lineTokens.map(t => t.y + t.h));
  const box = { x:left, y:top, w:right-left, h:bottom-top, page:hintPx.page };
  const expanded = { x:box.x - marginPx, y:box.y - marginPx, w:box.w + marginPx*2, h:box.h + marginPx*2, page:hintPx.page };
  const text = lineTokens.map(t => t.text).join(' ').trim();
  return { box: expanded, text };
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
    fieldPatterns: {},
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
      rowBandHeightPx: 18
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
  state.profile.fieldPatterns = existing?.fieldPatterns || state.profile.fieldPatterns || {};
  FieldDataEngine.importPatterns(state.profile.fieldPatterns);
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
    required: false,
    type: 'static'
  },

  // Line-Item Columns
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
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; state.matchPoints=[]; drawOverlay();
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
  const dpr = window.devicePixelRatio || 1;
  const w = src.width;
  const h = Math.round(((vp.h ?? vp.height) || 1) * dpr);
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
  const dpr = window.devicePixelRatio || 1;
  const range = 0.25 * ((vp.h ?? vp.height) || 1) * dpr;
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
  const dpr = window.devicePixelRatio || 1;
  const vp = state.viewport;
  const colTokens = tokens.filter(t=> intersect(t, boxPx));
  const avgH = colTokens.length ? colTokens.reduce((s,t)=>s+t.h,0)/colTokens.length : 0;
  const lineHeightPct = avgH / (((vp.h ?? vp.height)||1) * dpr);
  const right = boxPx.x + boxPx.w;
  const rightAligned = colTokens.filter(t => Math.abs((t.x + t.w) - right) < boxPx.w*0.1).length;
  const align = rightAligned > (colTokens.length/2) ? 'right' : 'left';
  const headerTokens = colTokens.filter(t => (t.y + t.h/2) < boxPx.y + avgH*1.5);
  const header = headerTokens.length ? toPct(vp, bboxOfTokens(headerTokens)) : null;
  return {
    xband:[norm.x0, norm.x1],
    yband:[norm.y0, norm.y1],
    lineHeightPct,
    regexHint: step.regex || '',
    align,
    header: header ? [header.x0, header.y0, header.x1, header.y1] : null,
    bottomGuards:['subtotal_amount','tax_amount','notes']
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
  const dpr = Number(window.devicePixelRatio || 1);
  const W = Number(src.width);
  const H = Number(src.height);
  const inputs = { canvasW: W, canvasH: H, viewportScale, dpr };
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
  result.meta.canvasSize = { w: W, h: H, dpr, scale: viewportScale, rotation };

  let { sx, sy, sw, sh } = denormalizeBox(normBox, W, H);
  let box = { x:sx, y:sy, w:sw, h:sh, page: pageIndex+1 };
  if(scale !== 1 || rotation !== 0){
    box = applyTransform(box, { scale, rotation });
    sx = Math.round(box.x); sy = Math.round(box.y); sw = Math.round(box.w); sh = Math.round(box.h);
  }

  let clamped = false;
  if(sx < 0){ sw += sx; sx = 0; clamped = true; }
  if(sy < 0){ sh += sy; sy = 0; clamped = true; }
  if(sx + sw > W){ sw = W - sx; clamped = true; }
  if(sy + sh > H){ sh = H - sy; clamped = true; }

  const nums = { W, H, sx, sy, sw, sh, dpr, scale, rotation, offY };
  for(const [k,v] of Object.entries(nums)){
    if(typeof v !== 'number' || !Number.isFinite(v)){
      result.meta.errors.push(`nan_or_infinity_in_math(${k})`);
      return result;
    }
  }
  result.meta.computedPx = { sx, sy, sw, sh, rotation };
  if(sw <= 2 || sh <= 2){
    result.meta.errors.push('tiny_or_zero_crop');
    result.meta.clamped = clamped;
    return result;
  }

  const off = document.createElement('canvas');
  off.className = 'debug-crop';
  off.width = sw; off.height = sh;
  const octx = off.getContext('2d');
  octx.clearRect(0,0,sw,sh);
  try{
    octx.drawImage(src, sx, offY + sy, sw, sh, 0, 0, sw, sh);
  }catch(err){
    console.error('drawImage failed', err);
    result.meta.errors.push('canvas_tainted');
    return result;
  }

  const cssSX = sx / dpr;
  const cssSY = sy / dpr;
  const cssSW = sw / dpr;
  const cssSH = sh / dpr;

  // hash for duplicate detection
  const buf = Buffer.from(off.toDataURL('image/png').split(',')[1],'base64');
  const crypto = window.crypto?.subtle ? null : (window.require && window.require('crypto'));
  let hash='';
  if(crypto){
    hash = crypto.createHash('sha1').update(buf).digest('hex');
  } else if(window.crypto?.subtle){
    hash = '';
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

  const imgData = octx.getImageData(0,0,sw,sh).data;
  let uniform = true;
  const r0 = imgData[0], g0 = imgData[1], b0 = imgData[2], a0 = imgData[3];
  for(let i=4;i<imgData.length;i+=4){
    if(imgData[i]!==r0 || imgData[i+1]!==g0 || imgData[i+2]!==b0 || imgData[i+3]!==a0){ uniform=false; break; }
  }
  if(uniform){ result.meta.errors.push('blank_or_uniform_crop'); }
  const rowHashes = new Set();
  for(let y=0;y<sh;y++){
    let row='';
    for(let x=0;x<sw;x++){
      const i=(y*sw+x)*4; row+=imgData[i]+','+imgData[i+1]+','+imgData[i+2]+','+imgData[i+3]+';';
    }
    rowHashes.add(row);
  }
  const colHashes = new Set();
  for(let x=0;x<sw;x++){
    let col='';
    for(let y=0;y<sh;y++){
      const i=(y*sw+x)*4; col+=imgData[i]+','+imgData[i+1]+','+imgData[i+2]+','+imgData[i+3]+';';
    }
    colHashes.add(col);
  }
  const bandingScore = Math.max(1 - rowHashes.size/sh, 1 - colHashes.size/sw);
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
      fs.writeFileSync(`${pageDir}/${pageIndex}.png`, Buffer.from(pageCanvas.toDataURL('image/png').split(',')[1],'base64'));
      state.pageSnapshots[pageSnapKey] = true;
    }
  }

  result.cropBitmap = off;
  result.meta.pdfCanvas = { w: src.width, h: src.height };
  result.meta.hash = hash;
  result.meta.bandingScore = bandingScore;
  result.meta.clamped = clamped;
  state.lastOcrCropCss = { x:cssSX, y:cssSY, w:cssSW, h:cssSH, page: pageIndex+1 };
  state.lastOcrCropPx = { x:sx, y:sy, w:sw, h:sh, page: pageIndex+1 };
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
  const bufFromCanvas = c => Buffer.from(c.toDataURL('image/png').split(',')[1],'base64');
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

  if(state.modes.rawData){
    let boxPx = null;
    if(state.mode === 'CONFIG' && state.snappedPx){
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

  async function attempt(box){
    const snap = snapToLine(tokens, box);
    let searchBox = snap.box;
    if(fieldSpec.fieldKey === 'customer_address'){
      searchBox = { x:snap.box.x, y:snap.box.y, w:snap.box.w, h:snap.box.h*4, page:snap.box.page };
    }
    const hits = tokensInBox(tokens, searchBox);
    if(!hits.length) return null;
    const sel = selectionFirst(hits, h=>FieldDataEngine.clean(fieldSpec.fieldKey||'', h, state.mode, spanKey));
    state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
    const cleaned = sel.cleaned || {};
    return {
      value: sel.value,
      raw: sel.raw,
      corrected: cleaned.corrected,
      code: cleaned.code,
      shape: cleaned.shape,
      score: cleaned.score,
      correctionsApplied: cleaned.correctionsApplied,
      corrections: cleaned.correctionsApplied,
      boxPx: searchBox,
      confidence: cleaned.conf || (sel.cleanedOk ? 1 : 0.1),
      tokens: hits,
      cleanedOk: sel.cleanedOk
    };
  }

  let result = null, method=null, score=null, comp=null, basePx=null;
  if(state.mode === 'CONFIG' && state.snappedPx){
    traceEvent(spanKey,'selection.captured',{ boxPx: state.snappedPx });
    const hits = tokensInBox(tokens, state.snappedPx);
    const rawText = hits.length ? hits.map(t => t.text).join(' ') : (state.snappedText || '');
    const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', hits.length ? hits : rawText, state.mode, spanKey);
    state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
    const value = cleaned.value || cleaned.raw || rawText;
    result = {
      value,
      raw: cleaned.raw || rawText,
      corrected: cleaned.corrected,
      code: cleaned.code,
      shape: cleaned.shape,
      score: cleaned.score,
      correctionsApplied: cleaned.correctionsApplied,
      corrections: cleaned.correctionsApplied,
      boxPx: state.snappedPx,
      confidence: cleaned.conf ?? 1,
      tokens: hits,
      method:'snap'
    };
    return result;
  }
  let selectionRaw = '';
  let firstAttempt = null;
  if(fieldSpec.bbox){
    const raw = toPx(viewportPx, {x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
    basePx = applyTransform(raw);
    traceEvent(spanKey,'selection.captured',{ boxPx: basePx });
    firstAttempt = await attempt(basePx);
    selectionRaw = firstAttempt?.raw || '';
    if(firstAttempt && firstAttempt.cleanedOk){
      result = firstAttempt; method='bbox';
    } else {
      const pads = state.mode==='CONFIG' ? [4] : [4,8,12];
      for(const pad of pads){
        const search = { x: basePx.x - pad, y: basePx.y - pad, w: basePx.w + pad*2, h: basePx.h + pad*2, page: basePx.page };
        const r = await attempt(search);
        if(r && r.cleanedOk){ result = r; method='bbox'; break; }
      }
    }
  }

  if(!result && ftype==='static' && fieldSpec.landmark && basePx){
    let m = matchRingLandmark(fieldSpec.landmark, basePx);
    if(m){
      const box = { x: m.x + fieldSpec.landmark.offset.dx*basePx.w, y: m.y + fieldSpec.landmark.offset.dy*basePx.h, w: basePx.w, h: basePx.h, page: basePx.page };
      const r = await attempt(box);
      if(r && r.value){ result=r; method='ring'; score=m.score; comp=m.comparator; }
    }
    if(!result){
      const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
      if(a){
        const r = await attempt(a.box);
        if(r && r.value){ result=r; method='anchor'; comp='text_anchor'; score:null; }
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
          if(r && r.value && geomOk && gramOk){ result=r; method=`partial-${half}`; score=m.score; comp=m.comparator; break; }
        }
      }
    }
  }
  if(!result){
    const lv = labelValueHeuristic(fieldSpec, tokens);
    if(lv.value){
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', lv.value, state.mode, spanKey);
      state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
      result = { value: cleaned.value || cleaned.raw, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: lv.usedBox, confidence: lv.confidence, method: method||'anchor', score:null, comparator: 'text_anchor' };
    }
  }

  if(!result){
    traceEvent(spanKey,'fallback.search',{});
    const fb = FieldDataEngine.clean(fieldSpec.fieldKey||'', state.snappedText, state.mode, spanKey);
    traceEvent(spanKey,'fallback.pick',{ value: fb.value || fb.raw });
    state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
    result = { value: fb.value || fb.raw, raw: selectionRaw || fb.raw, corrected: fb.corrected, code: fb.code, shape: fb.shape, score: fb.score, correctionsApplied: fb.correctionsApplied, corrections: fb.correctionsApplied, boxPx: state.snappedPx || basePx || null, confidence: fb.value ? 0.3 : 0, method: method||'fallback', score };
  }
  if(!result.value && selectionRaw){
    bumpDebugBlank();
    const raw = selectionRaw.trim();
    result.value = raw; result.raw = raw; result.confidence = 0.1; result.boxPx = result.boxPx || basePx || state.snappedPx || null; result.tokens = result.tokens || firstAttempt?.tokens || [];
  }
  result.method = result.method || method || 'fallback';
  result.score = score;
  result.comparator = comp || (result.method==='anchor' ? 'text_anchor' : result.method);
  if(result.score){ result.confidence = clamp(result.confidence * result.score, 0, 1); }
  state.telemetry.push({ field: fieldSpec.fieldKey, method: result.method, comparator: result.comparator, score: result.score, confidence: result.confidence });
  if(result.boxPx && (result.method.startsWith('ring') || result.method.startsWith('partial') || result.method==='anchor')){
    state.matchPoints.push({ x: result.boxPx.x + result.boxPx.w/2, y: result.boxPx.y + result.boxPx.h/2, page: result.boxPx.page });
  }
  traceEvent(spanKey,'value.finalized',{ value: result.value, confidence: result.confidence, method: result.method });
  result.tokens = result.tokens || [];
  return result;
}

async function extractLineItems(profile){
  const colFields = (profile.fields||[]).filter(f=>f.type==='column' && f.column);
  if(!colFields.length) return [];
  if(state.modes.rawData){
    const rows=[];
    const keyMap={product_description:'description',sku_col:'sku',quantity_col:'quantity',unit_price_col:'unit_price'};
    for(const f of colFields){
      const pageIndex=(f.page||1)-1;
      const vp=state.pageViewports[pageIndex];
      if(!vp) continue;
      const band=toPx(vp,{x0:f.column.xband[0],y0:f.column.yband?f.column.yband[0]:0,x1:f.column.xband[1],y1:f.column.yband?f.column.yband[1]:1,page:f.page});
      const docId=state.currentFileId || state.currentFileName || 'doc';
      const canvasW=(vp.width??vp.w)||1;
      const canvasH=(vp.height??vp.h)||1;
      const normBox=normalizeBox(band, canvasW, canvasH);
      const { cropBitmap, meta } = getOcrCropForSelection({ docId, pageIndex, normBox });
      if(meta.errors.length){ alert('OCR crop error: '+meta.errors.join(',')); continue; }
      const probe=await runOcrProbes(cropBitmap);
      const best=chooseBestProbe(probe);
      traceEvent({docId,pageIndex,fieldKey:f.fieldKey},'column.raw',{ mode:'raw', washed:false, cleaning:false, fallback:false, dedupe:false, tokens: best.tokensLength });
      const raw=(best.raw||'').trim();
      const key=keyMap[f.fieldKey]||f.fieldKey;
      const row={}; row[key]=raw; row.confidence=1; rows.push(row);
    }
    return rows;
  }
  const startPage = Math.min(...colFields.map(f=>f.page||1));
  const rows=[];
  const guardWords = Array.from(new Set(colFields.flatMap(f=>f.column.bottomGuards||[])));
  const guardRe = guardWords.length ? new RegExp(guardWords.join('|'),'i') : null;

  for(let p=startPage; p<=state.numPages; p++){
    const vp = state.pageViewports[p-1];
    if(!vp) continue;
    const tokens = await ensureTokensForPage(p);
    const bands={};
    const spanKey = { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: p-1, fieldKey: 'line_items' };
    let headerBottom=0;
    const headerBoxes=[];
    colFields.forEach(f=>{
      if(f.column?.header){
        const hb=toPx(vp,{x0:f.column.header[0],y0:f.column.header[1],x1:f.column.header[2],y1:f.column.header[3],page:p});
        headerBoxes.push({ key:f.fieldKey, box:hb });
        headerBottom=Math.max(headerBottom,hb.y+hb.h);
      } else {
        const band = toPx(vp,{x0:f.column.xband[0],y0:f.column.yband?f.column.yband[0]:0,x1:f.column.xband[1],y1:1,page:p});
        bands[f.fieldKey]=band;
      }
    });
    if(headerBoxes.length){
      headerBoxes.sort((a,b)=>(a.box.x+a.box.w/2)-(b.box.x+b.box.w/2));
      const pageH = ((vp.h??vp.height)||1);
      for(let i=0;i<headerBoxes.length;i++){
        const cur=headerBoxes[i];
        const prev=headerBoxes[i-1];
        const next=headerBoxes[i+1];
        const cx=cur.box.x+cur.box.w/2;
        const left=prev ? (prev.box.x+prev.box.w/2+cx)/2 : cur.box.x;
        const right=next ? (cx+next.box.x+next.box.w/2)/2 : cur.box.x+cur.box.w;
        const pad=Math.max(4,cur.box.w*0.1);
        bands[cur.key]={x:left-pad,y:0,w:right-left+pad*2,h:pageH};
      }
    }
    traceEvent(spanKey,'column.detected',{ columns:Object.keys(bands) });
    let pageTokens=tokens.filter(t=>Object.values(bands).some(b=>t.x+t.w/2>=b.x && t.x+t.w/2<=b.x+b.w && t.y+t.h/2>=b.y));
    pageTokens = pageTokens.filter(t=>!/^(sku|qty|quantity|price|amount|description)$/i.test(t.text));
    if(headerBottom) pageTokens = pageTokens.filter(t=>t.y+t.h/2>headerBottom);
    const lineTol = Math.max(4, (colFields[0].column.lineHeightPct||0.02) * (((vp.h??vp.height)||1)*(window.devicePixelRatio||1)) * 0.75);
    const lines = groupIntoLines(pageTokens, lineTol);
    if(lines.length){
      const first = lines[0].tokens.map(t=>t.text.toLowerCase()).join(' ');
      if(/description|qty|quantity|price|amount|sku/.test(first)) lines.shift();
    }
    const before=rows.length;
    for(const L of lines){
      const lower = L.tokens.map(t=>t.text.toLowerCase()).join(' ');
      if(guardRe && guardRe.test(lower)){ p=state.numPages+1; break; }
      const row={};
      const used=new Set();
      const colConfs=[]; const yCenters=[];
      for(const f of colFields){
        const band=bands[f.fieldKey];
        const colT=L.tokens.filter(t=>t.x+t.w/2>=band.x && t.x+t.w/2<=band.x+band.w && !used.has(t));
        if(!colT.length) continue;
        const txt=colT.map(t=>t.text).join(' ').trim();
        let colConf=1;
        if(f.column.regexHint){
          const rx=new RegExp(f.column.regexHint); if(!rx.test(txt)) colConf=0.5;
        }
        const keyMap={product_description:'description',sku_col:'sku',quantity_col:'quantity',unit_price_col:'unit_price'};
        let val=txt;
        const baseType=keyMap[f.fieldKey];
        if(baseType) val=FieldDataEngine.clean(baseType, txt, state.mode, { docId: state.currentFileId || state.currentFileName || 'doc', pageIndex: p-1, fieldKey: baseType }).value;
        if(val){
          row[keyMap[f.fieldKey]]=val;
          colConfs.push(colConf);
          const yc=colT.reduce((s,t)=>s+(t.y+t.h/2),0)/colT.length;
          yCenters.push(yc);
          colT.forEach(t=>used.add(t));
        }
      }
      if(row.description && !row.quantity && rows.length){
        rows[rows.length-1].description = (rows[rows.length-1].description + ' ' + row.description).trim();
        continue;
      }
      if(Object.keys(row).length){
        const base = colConfs.length ? Math.min(...colConfs) : 0;
        const ySpread = yCenters.length ? Math.max(...yCenters) - Math.min(...yCenters) : 0;
        const mis = ySpread > lineTol ? 0.2 : 0;
        row.confidence = clamp(base - mis,0,1);
        if(row.quantity && row.unit_price && row.amount){
          const exp = parseFloat(row.quantity) * parseFloat(row.unit_price);
          const diff = Math.abs(exp - parseFloat(row.amount));
          if(!isNaN(diff) && diff > 0.02) row.confidence *= 0.8;
        }
        rows.push(row);
      }
    }
    const added=rows.length-before;
    if(added) traceEvent(spanKey,'lineitems.parsed',{ rows:added });
  }
  return rows;
}

/* ---------------------- PDF/Image Loading ------------------------ */
const overlayCtx = els.overlayCanvas.getContext('2d');
const sn = v => (typeof v==='number' && Number.isFinite(v)) ? Math.round(v*100)/100 : 'err';

function sizeOverlayTo(cssW, cssH){
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
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!src) return;
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
  if(state.overlayPinned && state.pendingSelection && !state.pendingSelection.active){
    applySelectionFromCss(state.pendingSelection.startCss, state.pendingSelection.endCss);
    state.pendingSelection = null;
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

function applySelectionFromCss(startCss, endCss){
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
  drawOverlay();
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
    await ensureTokensForPage(1);
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
  state.pageViewports = [];
  state.pageOffsets = [];
  state.pageRenderPromises = [];
  state.pageRenderReady = [];
  clearCropThumbs();
  state.selectionPx = null; state.snappedPx = null; state.snappedText = '';
  overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
}
async function renderImage(url){
  state.overlayPinned = false;
  const img = els.imgCanvas;
  img.onload = () => {
    const scale = Math.min(1, 980 / img.naturalWidth);
    img.width = img.naturalWidth * scale;
    img.height = img.naturalHeight * scale;
    syncOverlay();
    state.overlayPinned = isOverlayPinned();
    state.viewport = { w: img.width, h: img.height, scale };
    state.pageRenderReady[0] = true;
    state.pageRenderPromises[0] = Promise.resolve();
    refreshCropAuditThumbs();
    URL.revokeObjectURL(url);
  };
  img.src = url;
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
    await ensureTokensForPage(i+1, p.page, p.vp, p.canvas);
    y += p.canvas.height;
  }
  await refreshCropAuditThumbs();
  syncOverlay();
  state.overlayPinned = isOverlayPinned();
}

window.addEventListener('resize', () => {
  state.overlayPinned = false;
  const base = state.isImage ? els.imgCanvas : els.pdfCanvas;
  if(!base) return;
  const rect = base.getBoundingClientRect();
  sizeOverlayTo(rect.width, rect.height);
  drawOverlay();
});

/* ----------------------- Text Extraction ------------------------- */
async function ensureTokensForPage(pageNum, pageObj=null, vp=null, canvasEl=null){
  if(state.tokensByPage[pageNum]) return state.tokensByPage[pageNum];
  let tokens = [];
  if(state.isImage){
    state.tokensByPage[pageNum] = tokens;
    return tokens;
  }

  if(!pageObj) pageObj = await state.pdf.getPage(pageNum);
  if(!vp) vp = state.pageViewports[pageNum-1];

  try {
    const content = await pageObj.getTextContent();
    for(const item of content.items){
      const tx = pdfjsLibRef.Util.transform(vp.transform, item.transform);
      const x = tx[4], yTop = tx[5], w = item.width, h = item.height;
      const raw = item.str;
      const { text: corrected, corrections } = applyOcrCorrections(raw);
      tokens.push({ raw, corrected, text: corrected, correctionsApplied: corrections, confidence: 1, x, y: yTop - h, w, h, page: pageNum });
    }
  } catch(err){
    console.warn('PDF textContent failed', err);
  }
  state.tokensByPage[pageNum] = tokens;
  return tokens;
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

/* --------------------- Overlay / Drawing Box --------------------- */
let drawing = false, start = null, startCss = null;

els.overlayCanvas.addEventListener('pointerdown', e => {
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
  const snap = snapToLine(tokens, state.selectionPx);
  state.snappedPx = snap.box;
  state.snappedText = snap.text;
  const { scaleX, scaleY } = getScaleFactors();
  state.snappedCss = {
    x: state.snappedPx.x/scaleX,
    y: state.snappedPx.y/scaleY,
    w: state.snappedPx.w/scaleX,
    h: state.snappedPx.h/scaleY,
    page: state.snappedPx.page
  };
  const step = state.steps[state.stepIdx] || {};
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
  syncOverlay();
  overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
  const { scaleY } = getScaleFactors();
  const ringsOn = Array.from(els.showRingToggles||[]).some(t=>t.checked);
  const matchesOn = Array.from(els.showMatchToggles||[]).some(t=>t.checked);
  if(els.showBoxesToggle?.checked && state.profile?.fields){
    overlayCtx.strokeStyle = 'rgba(255,0,0,0.6)';
    overlayCtx.lineWidth = 1;
    for(const f of state.profile.fields){
      const nb = f.normBox || (f.bboxPct ? { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 } : null);
      if(!nb) continue;
      const vp = state.pageViewports[f.page-1];
      if(!vp) continue;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(vp.width * dpr);
      const H = Math.round(vp.height * dpr);
      const { sx, sy, sw, sh } = denormalizeBox(nb, W, H);
      const box = applyTransform({ x:sx, y:sy, w:sw, h:sh, page:f.page });
      const off = state.pageOffsets[box.page-1] || 0;
      overlayCtx.strokeRect(box.x, box.y + off, box.w, box.h);
    }
  }
  if(ringsOn && state.profile?.fields){
    overlayCtx.strokeStyle = 'rgba(255,105,180,0.7)';
    for(const f of state.profile.fields){
      if(f.type !== 'static') continue;
      const nb = f.normBox || (f.bboxPct ? { x0n:f.bboxPct.x0, y0n:f.bboxPct.y0, wN:f.bboxPct.x1 - f.bboxPct.x0, hN:f.bboxPct.y1 - f.bboxPct.y0 } : null);
      if(!nb) continue;
      const vp = state.pageViewports[f.page-1];
      if(!vp) continue;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(vp.width * dpr);
      const H = Math.round(vp.height * dpr);
      const { sx, sy, sw, sh } = denormalizeBox(nb, W, H);
      const box = applyTransform({ x:sx, y:sy, w:sw, h:sh, page:f.page });
      const off = state.pageOffsets[box.page-1] || 0;
      const cx = box.x + box.w/2;
      const cy = box.y + off + box.h/2;
      const r = Math.max(box.w, box.h)/2 + 8;
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, r, 0, Math.PI*2);
      overlayCtx.stroke();
    }
  }
  if(matchesOn && state.matchPoints.length){
    overlayCtx.fillStyle = 'yellow';
    for(const mp of state.matchPoints){
      if(mp.page !== state.pageNum) continue;
      const off = state.pageOffsets[mp.page-1] || 0;
      overlayCtx.beginPath();
      overlayCtx.arc(mp.x, mp.y + off, 3, 0, Math.PI*2);
      overlayCtx.fill();
    }
  }
  if(state.selectionCss){
    overlayCtx.strokeStyle = '#2ee6a6'; overlayCtx.lineWidth = 1.5;
    const b = state.selectionCss; const off = (state.pageOffsets[b.page-1] || 0)/scaleY;
    overlayCtx.strokeRect(b.x, b.y + off, b.w, b.h);
  }
  if(state.snappedCss){
    overlayCtx.strokeStyle = '#44ccff'; overlayCtx.lineWidth = 2;
    const s = state.snappedCss; const off2 = (state.pageOffsets[s.page-1] || 0)/scaleY;
    overlayCtx.strokeRect(s.x, s.y + off2, s.w, s.h);
  }
  if(els.showOcrBoxesToggle?.checked && state.lastOcrCropCss){
    overlayCtx.strokeStyle = 'red'; overlayCtx.lineWidth = 2;
    const c = state.lastOcrCropCss; const off3 = (state.pageOffsets[c.page-1] || 0)/scaleY;
    overlayCtx.strokeRect(c.x, c.y + off3, c.w, c.h);
  }
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
function compileDocument(fileId, lineItems=[]){
  const raw = rawStore.get(fileId);
  const byKey = {};
  raw.forEach(r=>{ byKey[r.fieldKey] = { value: r.value, raw: r.raw, correctionsApplied: r.correctionsApplied || [], confidence: r.confidence || 0, tokens: r.tokens || [] }; });
  (state.profile?.fields||[]).forEach(f=>{
    if(!byKey[f.fieldKey]) byKey[f.fieldKey] = { value:'', raw:'', confidence:0, tokens:[] };
  });
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
  const numbered = (lineItems||[]).map((it,i)=>({ line_no: i+1, ...it }));
  const compiled = {
    fileId,
    fileHash: fileId,
    fileName: fileMeta[fileId]?.fileName || 'unnamed',
    processedAtISO: new Date().toISOString(),
    fields: byKey,
    invoice: {
      number: byKey['invoice_number']?.value || '',
      salesDateISO: byKey['invoice_date']?.value || '',
      salesperson: byKey['salesperson_rep']?.value || '',
      store: byKey['store_name']?.value || ''
    },
    totals: {
      subtotal: byKey['subtotal_amount']?.value || '',
      tax: byKey['tax_amount']?.value || '',
      total: byKey['invoice_total']?.value || '',
      discount: byKey['discounts_amount']?.value || ''
    },
    lineItems: numbered,
    templateKey: `${state.username}:${state.docType}`
  };
  const db = LS.getDb(state.username, state.docType);
  const invNum = compiled.invoice.number;
  const idx = db.findIndex(r => r.fileId === compiled.fileId || (invNum && r.invoice?.number === invNum));
  if(idx>=0) db[idx] = compiled; else db.push(compiled);
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

  const keySet = new Set();
  db.forEach(r => Object.keys(r.fields||{}).forEach(k=>keySet.add(k)));
  const keys = Array.from(keySet);
  const showRaw = state.modes.rawData || els.showRawToggle?.checked;

  const thead = `<tr><th>file</th>${keys.map(k=>`<th>${k}</th>`).join('')}<th>line items</th></tr>`;
  const rows = db.map(r=>{
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
    return `<tr><td>${r.fileName}</td>${cells}<td>${liTable}</td></tr>`;
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
  if(extras.landmark) entry.landmark = extras.landmark;
  if(step.type === 'column' && extras.column) entry.column = extras.column;
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
  renderSavedFieldsTable();
  populateModelSelect();
  renderResultsTable();
  alert('Model and records reset.');
});
els.configureBtn?.addEventListener('click', ()=>{
  state.mode = 'CONFIG';
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile();
  initStepsFromProfile();
  renderSavedFieldsTable();
});
els.demoBtn?.addEventListener('click', ()=> els.wizardFile.click());

els.docType?.addEventListener('change', ()=>{
  state.docType = els.docType.value || 'invoice';
  const existing = loadProfile(state.username, state.docType);
  state.profile = existing || null;
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

els.showBoxesToggle?.addEventListener('change', ()=>{ drawOverlay(); });
els.showRingToggles.forEach(t => t.addEventListener('change', ()=>{ drawOverlay(); }));
els.showMatchToggles.forEach(t => t.addEventListener('change', ()=>{ drawOverlay(); }));
els.showOcrBoxesToggle?.addEventListener('change', ()=>{ drawOverlay(); });

// Single-file open (wizard)
els.wizardFile?.addEventListener('change', async e=>{
  const f = e.target.files?.[0]; if(!f) return;
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
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; drawOverlay();
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
  const extras = {};
  if(step.type === 'static'){
    const lm = captureRingLandmark(boxPx);
    lm.anchorHints = ANCHOR_HINTS[step.fieldKey] || [];
    extras.landmark = lm;
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

// Export flat Master Database CSV
els.exportMasterDbBtn?.addEventListener('click', ()=>{
  const dt = els.dataDocType?.value || state.docType;
  const db = LS.getDb(state.username, dt);
  const csv = MasterDB.toCsv(db);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `masterdb-${state.username}-${dt}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});
els.finishWizardBtn?.addEventListener('click', ()=>{
  saveCurrentProfileAsModel();
  compileDocument(state.currentFileId);
  els.wizardSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('extracted-data');
  populateModelSelect();
});

/* ---------------------------- Batch ------------------------------- */
async function autoExtractFileWithProfile(file, profile){
  state.mode = 'RUN';
  state.profile = profile;
  FieldDataEngine.importPatterns(profile.fieldPatterns || {});
  await openFile(file);
  for(const spec of (profile.fields || [])){
    if(typeof spec.page === 'number' && spec.page+1 !== state.pageNum && !state.isImage && state.pdf){
      state.pageNum = clamp(spec.page+1, 1, state.numPages);
      state.viewport = state.pageViewports[state.pageNum-1];
      updatePageIndicator();
      els.viewer?.scrollTo(0, state.pageOffsets[state.pageNum-1] || 0);
    }
    const tokens = await ensureTokensForPage(state.pageNum);
    const fieldSpec = { fieldKey: spec.fieldKey, regex: spec.regex, anchor: spec.anchor, bbox: spec.bbox, page: spec.page };
    state.snappedPx = null; state.snappedText = '';
    const { value, boxPx, confidence, raw, corrections } = await extractFieldValue(fieldSpec, tokens, state.viewport);
    if(value){
      const vp = state.pageViewports[state.pageNum-1] || state.viewport || {width:1,height:1};
      const nb = boxPx ? normalizeBox(boxPx, (vp.width ?? vp.w) || 1, (vp.height ?? vp.h) || 1) : null;
      const pct = nb ? { x0: nb.x0n, y0: nb.y0n, x1: nb.x0n + nb.wN, y1: nb.y0n + nb.hN } : null;
      const arr = rawStore.get(state.currentFileId);
      let conf = confidence;
      const dup = arr.find(r=>r.fieldKey!==spec.fieldKey && ['subtotal_amount','tax_amount','invoice_total'].includes(spec.fieldKey) && ['subtotal_amount','tax_amount','invoice_total'].includes(r.fieldKey) && r.value===value);
      if(dup) conf *= 0.5;
      const rec = { fieldKey: spec.fieldKey, raw, value, confidence: conf, correctionsApplied: corrections, page: state.pageNum, bbox: pct, ts: Date.now() };
      rawStore.upsert(state.currentFileId, rec);
    }
    if(boxPx){ state.snappedPx = { ...boxPx, page: state.pageNum }; drawOverlay(); }
  }
  await ensureTokensForPage(state.pageNum);
  const lineItems = await extractLineItems(profile);
  compileDocument(state.currentFileId, lineItems);
}

async function processBatch(files){
  if(!files.length) return;
  state.mode = 'RUN';
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile(); initStepsFromProfile(); renderSavedFieldsTable();
  const modelId = document.getElementById('model-select')?.value || '';
  const model = modelId ? getModels().find(m => m.id === modelId) : null;

  for(const f of files){
    if(model){ await autoExtractFileWithProfile(f, model.profile); }
    else { await openFile(f); }
  }
  els.wizardSection.style.display = 'none';
  els.app.style.display = 'block';
  showTab('extracted-data');
}

/* ------------------------ Init on load ---------------------------- */
renderResultsTable();
renderReports();
syncRawModeUI();
