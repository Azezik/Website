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
     #boxModeBtn, #clearSelectionBtn, #backBtn, #skipBtn, #confirmBtn
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
  telemetryPanel: document.getElementById('telemetryPanel'),
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

  boxModeBtn:      document.getElementById('boxModeBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  backBtn:         document.getElementById('backBtn'),
  skipBtn:         document.getElementById('skipBtn'),
  confirmBtn:      document.getElementById('confirmBtn'),

  stepLabel:       document.getElementById('stepLabel'),
  questionText:    document.getElementById('questionText'),

  fieldsPreview:   document.getElementById('fieldsPreview'),
  savedJson:       document.getElementById('savedJson'),
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

let state = {
  username: null,
  docType: 'invoice',
  mode: 'CONFIG',
  profile: null,             // Vendor profile (landmarks + fields + tableHints)
  pdf: null,                 // pdf.js document
  isImage: false,
  pageNum: 1,
  numPages: 1,
  viewport: { w: 0, h: 0, scale: 1 },
  pageViewports: [],       // viewport per page
  pageOffsets: [],         // y-offset of each page within pdfCanvas
  tokensByPage: {},          // {page:number: Token[] in px}
  selectionPx: null,         // current user-drawn selection (px)
  snappedPx: null,           // snapped line box (px)
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
};

/* ---------------------- Storage / Persistence --------------------- */
const LS = {
  profileKey: (u, d) => `wiz.profile.${u}.${d}`,
  dbKey: () => `wiz.db.records`,
  getDb() { const raw = localStorage.getItem(this.dbKey()); return raw ? JSON.parse(raw) : []; },
  setDb(arr){ localStorage.setItem(this.dbKey(), JSON.stringify(arr)); },
  getProfile(u,d){ const raw = localStorage.getItem(this.profileKey(u,d)); return raw ? JSON.parse(raw, jsonReviver) : null; },
  setProfile(u,d,p){ localStorage.setItem(this.profileKey(u,d), serializeProfile(p)); },
  removeProfile(u,d){ localStorage.removeItem(this.profileKey(u,d)); }
};

/* ---------- Profile versioning & persistence helpers ---------- */
const PROFILE_VERSION = 3;
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
  },300);
}
function loadProfile(u, d){
  try{
    const raw = LS.getProfile(u, d);
    return migrateProfile(raw);
  }catch(e){ console.error('loadProfile', e); return null; }
}

// Raw and compiled stores
const rawStore = {};       // {fileId: [{fieldKey,value,page,bbox,ts}]}
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

  function clean(ftype, input, mode='RUN'){
    const arr = Array.isArray(input) ? input : [{text: String(input||'')}];
    const lineStrs = Array.isArray(input) ? groupIntoLines(arr).map(L=>L.tokens.map(t=>t.text).join(' ').trim()) : [String(input||'')];
    let raw = lineStrs.join(' ').trim();
    let joined = lineStrs.join(' ').trim();
    if(ftype==='customer_address') joined = lineStrs.join(', ').trim();
    let txt = collapseAdjacentDuplicates(joined).replace(/\s+/g,' ').trim().replace(/[#:—•]*$/, '');
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
      const value = regex ? ((txt.match(regex)||[])[1]||txt) : txt;
      learn(ftype, value);
      return { value, raw, corrected: value, conf, code: codeOf(value), shape: shapeOf(value), score: regex && value ? 1 : 0, correctionsApplied: [], digit: digitRatio(value) };
    }
    if(/customer_name|salesperson_rep|store_name|department_division/.test(ftype)){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
      if(/^[\d,]/.test(txt) || digit > 0.15 || postalRe.test(txt)){
        return { value:'', raw, corrected:txt, conf, code, shape, score:0, correctionsApplied:[], digit };
      }
    }
    if(ftype==='customer_address'){
      const postalRe = new RegExp(fieldDefs.customer_address.regex, 'i');
      if(!/\d/.test(txt) && !postalRe.test(txt)){
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
      return { value: corrected, raw, corrected, conf, code, shape, score, correctionsApplied, digit };
    }
    return { value: '', raw, corrected, conf, code, shape, score, correctionsApplied, digit };
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
    if(overlapY / t.h < 0.7) return false;
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
      headerLandmarks: ['description_hdr','qty_header','price_header','amount_header'],
      rowBandHeightPx: 18
    }
  };

  if(existing?.fields?.length){
    state.profile.fields = existing.fields.map(f => ({
      ...f,
      type: f.type || 'static',
      fieldKey: FIELD_ALIASES[f.fieldKey] || f.fieldKey
    }));
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
    prompt: 'Highlight the store or business name on the invoice header.',
    kind: 'value',
    mode: 'cell',
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'department_division',
    label: 'Department / Division',
    prompt: 'Highlight the department/division (if shown). If not present, click Skip.',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'invoice_number',
    label: 'Invoice Number',
    prompt: 'Highlight the invoice number (e.g., INV-12345).',
    kind: 'value',
    mode: 'cell',
    regex: RE.orderLike.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'invoice_date',
    label: 'Invoice Date',
    prompt: 'Highlight the invoice date (e.g., 2025-09-08 or Sept 8, 2025).',
    kind: 'value',
    mode: 'cell',
    regex: RE.date.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'salesperson_rep',
    label: 'Salesperson / Rep',
    prompt: 'Highlight the salesperson/rep name or ID (if shown). If not present, click Skip.',
    kind: 'value',
    mode: 'cell',
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'customer_name',
    label: 'Customer (Sold To)',
    prompt: 'Highlight the customer name (Sold To/Bill To).',
    kind: 'value',
    mode: 'cell',
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'customer_address',
    label: 'Customer Address (City/Province/Postal)',
    prompt: 'Highlight the customer address block (include city, province, and postal code if present).',
    kind: 'block',
    mode: 'cell',
    required: false,
    type: 'static'
  },

  // Line-Item Columns
  {
    fieldKey: 'product_description',
    label: 'Product / Service Description (Column)',
    prompt: 'Highlight the entire column containing product/service descriptions. Drag from the first row to the last row so the whole column is selected.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: '.+',
    type: 'column'
  },
  {
    fieldKey: 'sku_col',
    label: 'Product Code / SKU (Column)',
    prompt: 'Highlight the entire column of product codes/SKUs (if present). If none, click Skip.',
    kind: 'block',
    mode: 'column',
    required: false,
    regex: RE.sku.source,
    type: 'column'
  },
  {
    fieldKey: 'quantity_col',
    label: 'Quantity (Column)',
    prompt: 'Highlight the entire column of quantities.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: '[0-9]+(?:\\.[0-9]+)?',
    type: 'column'
  },
  {
    fieldKey: 'unit_price_col',
    label: 'Unit Price (Column)',
    prompt: 'Highlight the entire column of unit prices.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: RE.currency.source,
    type: 'column'
  },
  {
    fieldKey: 'amount_col',
    label: 'Amount (Column)',
    prompt: 'Highlight the entire column of line amounts.',
    kind: 'block',
    mode: 'column',
    required: true,
    regex: RE.currency.source,
    type: 'column'
  },

  // Totals & Taxes (single cell highlights)
  {
    fieldKey: 'subtotal_amount',
    label: 'Subtotal (before tax & discounts)',
    prompt: 'Highlight the Subtotal amount (before tax and discounts).',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'discounts_amount',
    label: 'Discounts (if any)',
    prompt: 'Highlight the total Discounts amount (if present). If none, click Skip.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: false,
    type: 'static'
  },
  {
    fieldKey: 'tax_amount',
    label: 'Tax (HST/GST/PST)',
    prompt: 'Highlight the total tax line (e.g., HST). If multiple taxes, highlight the combined total.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
    type: 'static'
  },
  {
    fieldKey: 'invoice_total',
    label: 'Invoice Total (Grand Total)',
    prompt: 'Highlight the final amount due (Grand Total/Total).',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true,
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

async function ocrBox(boxPx, fieldKey){
  const pad = 4;
  const src = state.isImage ? els.imgCanvas : els.pdfCanvas;
  const offY = state.pageOffsets[boxPx.page-1] || 0;
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = (boxPx.w + pad*2)*scale;
  canvas.height = (boxPx.h + pad*2)*scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, boxPx.x - pad, offY + boxPx.y - pad, boxPx.w + pad*2, boxPx.h + pad*2, 0, 0, canvas.width, canvas.height);
  preprocessCanvas(canvas);
  const cfg = ocrConfigFor(fieldKey);
  const opts = { tessedit_pageseg_mode: cfg.psm, oem:1 };
  if(cfg.whitelist) opts.tessedit_char_whitelist = cfg.whitelist;
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
        x: boxPx.x - pad + w.bbox.x/scale,
        y: boxPx.y - pad + w.bbox.y/scale,
        w: w.bbox.width/scale,
        h: w.bbox.height/scale,
        page: boxPx.page
      };
    }).filter(Boolean);
    const filtered = tokensInBox(words, boxPx);
    const avg = filtered.reduce((s,t)=>s+t.confidence,0)/(filtered.length||1);
    if(avg > bestAvg){ bestAvg=avg; bestTokens = filtered; }
  }
  return bestTokens;
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

  async function attempt(box){
    const snap = snapToLine(tokens, box);
    let searchBox = snap.box;
    if(fieldSpec.fieldKey === 'customer_address'){
      searchBox = { x:snap.box.x, y:snap.box.y, w:snap.box.w, h:snap.box.h*4, page:snap.box.page };
    }
    const hits = tokensInBox(tokens, searchBox);
    if(hits.length){
      const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', hits, state.mode);
      if(cleaned.value){
        state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
        return { value: cleaned.value, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: searchBox, confidence: cleaned.conf, tokens: hits };
      }
    }
    if(els.ocrToggle.checked){
      const oTokens = await ocrBox(searchBox, fieldSpec.fieldKey);
      if(oTokens.length){
        const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', oTokens, state.mode);
        if(cleaned.value){
          state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
          return { value: cleaned.value, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: searchBox, confidence: cleaned.conf, tokens: oTokens };
        }
      }
    }
    return null;
  }

  let result = null, method=null, score=null, comp=null, basePx=null;
  if(fieldSpec.bbox){
    const raw = toPx(viewportPx, {x0:fieldSpec.bbox[0], y0:fieldSpec.bbox[1], x1:fieldSpec.bbox[2], y1:fieldSpec.bbox[3], page:fieldSpec.page});
    basePx = applyTransform(raw);
    const pads = state.mode==='CONFIG' ? [0,4] : [0,4,8,12];
    for(const pad of pads){
      const search = { x: basePx.x - pad, y: basePx.y - pad, w: basePx.w + pad*2, h: basePx.h + pad*2, page: basePx.page };
      result = await attempt(search);
      if(result){ method='bbox'; break; }
    }
  }

  if(!result && ftype==='static' && fieldSpec.landmark && basePx){
    let m = matchRingLandmark(fieldSpec.landmark, basePx);
    if(m){
      const box = { x: m.x + fieldSpec.landmark.offset.dx*basePx.w, y: m.y + fieldSpec.landmark.offset.dy*basePx.h, w: basePx.w, h: basePx.h, page: basePx.page };
      const r = await attempt(box);
      if(r){ result=r; method='ring'; score=m.score; comp=m.comparator; }
    }
    if(!result){
      const a = anchorAssist(fieldSpec.landmark.anchorHints, tokens, basePx);
      if(a){
        const r = await attempt(a.box);
        if(r){ result=r; method='anchor'; comp='text_anchor'; score:null; }
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
          if(r && geomOk && gramOk){ result=r; method=`partial-${half}`; score=m.score; comp=m.comparator; break; }
        }
      }
    }
  }

  if(!result && state.snappedPx){
    let val = fieldSpec.regex
      ? ((state.snappedText.match(new RegExp(fieldSpec.regex, 'i')) || [])[1] || '')
      : state.snappedText;
    const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', val, state.mode);
    if(cleaned.value){
      state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
      result = { value: cleaned.value, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: state.snappedPx, confidence: cleaned.conf, method: method||'snap', score };
    }
  }

    if(!result){
      const lv = labelValueHeuristic(fieldSpec, tokens);
      if(lv.value){
        const cleaned = FieldDataEngine.clean(fieldSpec.fieldKey||'', lv.value, state.mode);
        if(cleaned.value){
          state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
          result = { value: cleaned.value, raw: cleaned.raw, corrected: cleaned.corrected, code: cleaned.code, shape: cleaned.shape, score: cleaned.score, correctionsApplied: cleaned.correctionsApplied, corrections: cleaned.correctionsApplied, boxPx: lv.usedBox, confidence: lv.confidence, method: method||'anchor', score:null, comparator: 'text_anchor' };
        }
      }
    }

    if(!result){
      const fb = FieldDataEngine.clean(fieldSpec.fieldKey||'', state.snappedText, state.mode);
      state.profile.fieldPatterns = FieldDataEngine.exportPatterns();
      result = { value: fb.value, raw: fb.raw, corrected: fb.corrected, code: fb.code, shape: fb.shape, score: fb.score, correctionsApplied: fb.correctionsApplied, corrections: fb.correctionsApplied, boxPx: state.snappedPx || null, confidence: fb.value ? 0.3 : 0, method: method||'fallback', score };
    }
  result.method = result.method || method || 'fallback';
  result.score = score;
  result.comparator = comp || (result.method==='anchor' ? 'text_anchor' : result.method);
  if(result.score){ result.confidence = clamp(result.confidence * result.score, 0, 1); }
  state.telemetry.push({ field: fieldSpec.fieldKey, method: result.method, comparator: result.comparator, score: result.score, confidence: result.confidence });
  if(result.boxPx && (result.method.startsWith('ring') || result.method.startsWith('partial') || result.method==='anchor')){
    state.matchPoints.push({ x: result.boxPx.x + result.boxPx.w/2, y: result.boxPx.y + result.boxPx.h/2, page: result.boxPx.page });
  }
  result.tokens = result.tokens || [];
  return result;
}

async function extractLineItems(profile){
  const colFields = (profile.fields||[]).filter(f=>f.type==='column' && f.column);
  if(!colFields.length) return [];
  const startPage = Math.min(...colFields.map(f=>f.page||1));
  const rows=[];
  const guardWords = Array.from(new Set(colFields.flatMap(f=>f.column.bottomGuards||[])));
  const guardRe = guardWords.length ? new RegExp(guardWords.join('|'),'i') : null;

  for(let p=startPage; p<=state.numPages; p++){
    const vp = state.pageViewports[p-1];
    if(!vp) continue;
    const tokens = await ensureTokensForPage(p);
    const bands={};
    let headerBottom=0;
    colFields.forEach(f=>{
      const band = toPx(vp,{x0:f.column.xband[0],y0:f.column.yband?f.column.yband[0]:0,x1:f.column.xband[1],y1:1,page:p});
      bands[f.fieldKey]=band;
      if(f.column.header){
        const hb=toPx(vp,{x0:f.column.header[0],y0:f.column.header[1],x1:f.column.header[2],y1:f.column.header[3],page:p});
        headerBottom=Math.max(headerBottom,hb.y+hb.h);
      }
    });
    let pageTokens=tokens.filter(t=>Object.values(bands).some(b=>t.x+t.w/2>=b.x && t.x+t.w/2<=b.x+b.w && t.y+t.h/2>=b.y));
    pageTokens = pageTokens.filter(t=>!/^(sku|qty|quantity|price|amount|description)$/i.test(t.text));
    if(headerBottom) pageTokens = pageTokens.filter(t=>t.y+t.h/2>headerBottom);
    const lineTol = Math.max(4, (colFields[0].column.lineHeightPct||0.02) * (((vp.h??vp.height)||1)*(window.devicePixelRatio||1)) * 0.5);
    const lines = groupIntoLines(pageTokens, lineTol);
    if(lines.length){
      const first = lines[0].tokens.map(t=>t.text.toLowerCase()).join(' ');
      if(/description|qty|quantity|price|amount|sku/.test(first)) lines.shift();
    }
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
        const keyMap={product_description:'description',sku_col:'sku',quantity_col:'quantity',unit_price_col:'unit_price',amount_col:'amount'};
        let val=txt;
        const baseType=keyMap[f.fieldKey];
        if(baseType) val=FieldDataEngine.clean(baseType, txt, state.mode).value;
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
  }
  return rows;
}

/* ---------------------- PDF/Image Loading ------------------------ */
const overlayCtx = els.overlayCanvas.getContext('2d');

function sizeOverlayTo(w, h){
  const dpr = window.devicePixelRatio || 1;
  els.overlayCanvas.style.width = w + 'px';
  els.overlayCanvas.style.height = h + 'px';
  els.overlayCanvas.width = Math.round(w * dpr);
  els.overlayCanvas.height = Math.round(h * dpr);
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  state.currentFileName = file.name || 'untitled';
  state.currentFileId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  fileMeta[state.currentFileId] = { fileName: state.currentFileName };
  rawStore[state.currentFileId] = rawStore[state.currentFileId] || [];
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
    const arrayBuffer = await file.arrayBuffer();
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
  state.selectionPx = null; state.snappedPx = null; state.snappedText = '';
  overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
}
async function renderImage(url){
  const img = els.imgCanvas;
  img.onload = () => {
    const scale = Math.min(1, 980 / img.naturalWidth);
    img.width = img.naturalWidth * scale;
    img.height = img.naturalHeight * scale;
    sizeOverlayTo(img.width, img.height);
    state.viewport = { w: img.width, h: img.height, scale };
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
// ===== Render all PDF pages vertically =====
async function renderAllPages(){
  if(!state.pdf) return;
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
    await page.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
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
}

window.addEventListener('resize', () => {
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

function pageFromY(y){
  for(let i=state.pageOffsets.length-1; i>=0; i--){
    if(y >= state.pageOffsets[i]) return i+1;
  }
  return 1;
}

/* --------------------- Overlay / Drawing Box --------------------- */
let drawing = false, start = null;

els.overlayCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  drawing = true;
  const rect = els.overlayCanvas.getBoundingClientRect();
  start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  els.overlayCanvas.setPointerCapture?.(e.pointerId);
}, { passive: false });

els.overlayCanvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  e.preventDefault();
  const rect = els.overlayCanvas.getBoundingClientRect();
  const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const page = pageFromY(start.y);
  const offset = state.pageOffsets[page - 1] || 0;
  const box = {
    x: Math.min(start.x, cur.x),
    y: Math.min(start.y, cur.y) - offset,
    w: Math.abs(cur.x - start.x),
    h: Math.abs(cur.y - start.y),
    page
  };
  state.selectionPx = box;
  drawOverlay();
}, { passive: false });

async function finalizeSelection() {
  drawing = false;
  if (!state.selectionPx) return;
  state.pageNum = state.selectionPx.page;
  state.viewport = state.pageViewports[state.pageNum - 1];
  updatePageIndicator();
  const tokens = await ensureTokensForPage(state.pageNum);
  const snap = snapToLine(tokens, state.selectionPx);
  state.snappedPx = snap.box;
  state.snappedText = snap.text;
  drawOverlay();
}

els.overlayCanvas.addEventListener('pointerup', finalizeSelection, { passive: false });
els.overlayCanvas.addEventListener('pointercancel', finalizeSelection, { passive: false });

els.viewer.addEventListener('scroll', ()=>{
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
  overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
  const ringsOn = Array.from(els.showRingToggles||[]).some(t=>t.checked);
  const matchesOn = Array.from(els.showMatchToggles||[]).some(t=>t.checked);
  if(els.showBoxesToggle?.checked && state.profile?.fields){
    overlayCtx.strokeStyle = 'rgba(255,0,0,0.6)';
    overlayCtx.lineWidth = 1;
    for(const f of state.profile.fields){
      if(!f.bbox) continue;
      const vp = state.pageViewports[f.page-1];
      if(!vp) continue;
      const pct = f.bboxPct || {x0:f.bbox[0],y0:f.bbox[1],x1:f.bbox[2],y1:f.bbox[3]};
      const box = applyTransform(toPx(vp, { ...pct, page:f.page }));
      const off = state.pageOffsets[box.page-1] || 0;
      overlayCtx.strokeRect(box.x, box.y + off, box.w, box.h);
    }
  }
  if(ringsOn && state.profile?.fields){
    overlayCtx.strokeStyle = 'rgba(255,105,180,0.7)';
    for(const f of state.profile.fields){
      if(f.type !== 'static' || !f.bbox) continue;
      const vp = state.pageViewports[f.page-1];
      if(!vp) continue;
      const pct = f.bboxPct || {x0:f.bbox[0],y0:f.bbox[1],x1:f.bbox[2],y1:f.bbox[3]};
      const box = applyTransform(toPx(vp, { ...pct, page:f.page }));
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
  if(state.selectionPx){
    overlayCtx.strokeStyle = '#2ee6a6'; overlayCtx.lineWidth = 1.5;
    const b = state.selectionPx; const off = state.pageOffsets[b.page-1] || 0;
    overlayCtx.strokeRect(b.x, b.y + off, b.w, b.h);
  }
  if(state.snappedPx){
    overlayCtx.strokeStyle = '#44ccff'; overlayCtx.lineWidth = 2;
    const s = state.snappedPx; const off2 = state.pageOffsets[s.page-1] || 0;
    overlayCtx.strokeRect(s.x, s.y + off2, s.w, s.h);
  }
}

/* ---------------------- Results “DB” table ----------------------- */
function compileDocument(fileId, lineItems=[]){
  const raw = rawStore[fileId] || [];
  const byKey = {};
  raw.forEach(r=>{ byKey[r.fieldKey] = { value: r.value, raw: r.raw, correctionsApplied: r.correctionsApplied || [], confidence: r.confidence || 0, tokens: r.tokens || [] }; });
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
  const compiled = {
    fileId,
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
    lineItems,
    templateKey: `${state.username}:${state.docType}`
  };
  const db = LS.getDb();
  const idx = db.findIndex(r => r.fileId === fileId);
  if(idx>=0) db[idx] = compiled; else db.push(compiled);
  LS.setDb(db);
  renderResultsTable();
  renderTelemetry();
  renderReports();
  return compiled;
}

function renderResultsTable(){
  const mount = document.getElementById('resultsMount');
  let db = LS.getDb().filter(r => r.templateKey.startsWith(`${state.username}:`));
  const filter = els.dataDocType?.value;
  if(filter){ db = db.filter(r => r.templateKey.endsWith(':'+filter)); }
  if(!db.length){ mount.innerHTML = '<p class="sub">No extractions yet.</p>'; return; }

  const keySet = new Set();
  db.forEach(r => Object.keys(r.fields||{}).forEach(k=>keySet.add(k)));
  const keys = Array.from(keySet);

  const thead = `<tr><th>file</th>${keys.map(k=>`<th>${k}</th>`).join('')}<th>line items</th></tr>`;
  const rows = db.map(r=>{
    const cells = keys.map(k=>{
      const f = r.fields?.[k] || { value:'', confidence:0 };
      const warn = f.confidence < 0.8 || (f.correctionsApplied&&f.correctionsApplied.length) ? '<span class="warn">⚠️</span>' : '';
      return `<td><input class="editField" data-file="${r.fileId}" data-field="${k}" value="${f.value}"/>${warn}<span class="confidence">${Math.round((f.confidence||0)*100)}%</span></td>`;
    }).join('');
    const liRows = (r.lineItems||[]).map(it=>`<tr><td>${it.description||''}${it.confidence<0.8?' <span class="warn">⚠️</span>':''}</td><td>${it.sku||''}</td><td>${it.quantity||''}</td><td>${it.unit_price||''}</td></tr>`).join('');
    const liTable = `<table class="line-items-table"><thead><tr><th>Desc</th><th>SKU</th><th>Qty</th><th>Unit</th></tr></thead><tbody>${liRows}</tbody></table>`;
    return `<tr><td>${r.fileName}</td>${cells}<td>${liTable}</td></tr>`;
  }).join('');

  mount.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;

  mount.querySelectorAll('input.editField').forEach(inp=>inp.addEventListener('change', ()=>{
    const fileId = inp.dataset.file;
    const field = inp.dataset.field;
    const db = LS.getDb();
    const rec = db.find(r=>r.fileId===fileId);
    if(rec && rec.fields?.[field]){
      rec.fields[field].value = inp.value;
      rec.fields[field].confidence = 1;
      if(rec.invoice[field] !== undefined) rec.invoice[field] = inp.value;
      if(rec.totals[field] !== undefined) rec.totals[field] = inp.value;
      LS.setDb(db);
      renderResultsTable();
      renderReports();
    }
  }));
}

function renderTelemetry(){
  if(!els.telemetryPanel) return;
  els.telemetryPanel.textContent = state.telemetry.map(t=>`${t.field}: ${t.comparator} (${(t.score||0).toFixed(2)}) -> ${(t.confidence||0).toFixed(2)}`).join('\n');
}

function renderReports(){
  let db = LS.getDb().filter(r => r.templateKey.startsWith(`${state.username}:`));
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
function upsertFieldInProfile(step, normBox, value, confidence, page, extras={}, raw='', corrections=[], tokens=[]) {
  ensureProfile();
  const existing = state.profile.fields.find(f => f.fieldKey === step.fieldKey);
  if(step.type === 'static'){
    const clash = (state.profile.fields||[]).find(f=>f.fieldKey!==step.fieldKey && f.type==='static' && f.page===page && Math.min(normBox.y1,f.bboxPct.y1) - Math.max(normBox.y0,f.bboxPct.y0) > 0);
    if(clash){
      console.warn('Overlapping static bboxes, adjusting', step.fieldKey, clash.fieldKey);
      const shift = (clash.bboxPct.y1 - clash.bboxPct.y0) + 0.001;
      normBox.y0 = clash.bboxPct.y1 + 0.001;
      normBox.y1 = normBox.y0 + shift;
    }
  }
  const entry = {
    fieldKey: step.fieldKey,
    type: step.type,
    page,
    selectorType:'bbox',
    bbox:[normBox.x0, normBox.y0, normBox.x1, normBox.y1],
    bboxPct:{x0:normBox.x0, y0:normBox.y0, x1:normBox.x1, y1:normBox.y1},
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
  const fields = (state.profile?.fields||[]).filter(f => f.value !== undefined && f.value !== null && String(f.value).trim() !== '');
  if(!fields.length){
    els.fieldsPreview.innerHTML = '<p class="sub">No fields yet.</p>';
  } else {
    const thead = `<tr>${fields.map(f=>`<th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">${f.fieldKey}</th>`).join('')}</tr>`;
    const row = `<tr>${fields.map(f=>`<td style="padding:6px;border-bottom:1px solid var(--border)">${(f.value||'').toString().replace(/</g,'&lt;')}</td>`).join('')}</tr>`;
    els.fieldsPreview.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead>${thead}</thead><tbody>${row}</tbody></table></div>`;
  }
  els.savedJson.textContent = serializeProfile(state.profile);
  renderConfirmedTables();
}

let confirmedRenderPending = false;
function renderConfirmedTables(){
  if(confirmedRenderPending) return;
  confirmedRenderPending = true;
  requestAnimationFrame(()=>{
    confirmedRenderPending = false;
    const fDiv = document.getElementById('confirmedFields');
    const liDiv = document.getElementById('confirmedLineItems');
    if(fDiv){
      const statics = (state.profile?.fields||[]).filter(f=>f.type==='static' && f.value);
      if(!statics.length){ fDiv.innerHTML = '<p class="sub">No fields yet.</p>'; }
      else {
        const rows = statics.map(f=>{
          const warn = (f.confidence||0) < 0.8 || (f.correctionsApplied&&f.correctionsApplied.length)
            ? '<span class="warn">⚠️</span>' : '';
          const conf = `<span class="confidence">${Math.round((f.confidence||0)*100)}%</span>`;
          return `<tr><td>${f.fieldKey}</td><td><input class="confirmEdit" data-field="${f.fieldKey}" value="${f.value}"/>${warn}${conf}</td></tr>`;
        }).join('');
        fDiv.innerHTML = `<table class="line-items-table"><tbody>${rows}</tbody></table>`;
        fDiv.querySelectorAll('input.confirmEdit').forEach(inp=>inp.addEventListener('change',()=>{
          const fld = state.profile.fields.find(x=>x.fieldKey===inp.dataset.field);
          if(fld){ fld.value = inp.value; fld.confidence = 1; saveProfile(state.username, state.docType, state.profile); renderConfirmedTables(); }
        }));
      }
    }
    if(liDiv){
      const items = state.currentLineItems || [];
      if(!items.length){ liDiv.innerHTML = '<p class="sub">No line items.</p>'; }
      else {
        const rows = items.map(it=>{
          const warn = (it.confidence||0) < 0.8 ? '<span class="warn">⚠️</span>' : '';
          return `<tr><td>${(it.description||'')}${warn}</td><td>${it.sku||''}</td><td>${it.quantity||''}</td><td>${it.unit_price||''}</td><td>${it.amount||''}</td></tr>`;
        }).join('');
        liDiv.innerHTML = `<table class="line-items-table"><thead><tr><th>Description</th><th>SKU</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  localStorage.removeItem(LS.dbKey());
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
    value = res.value || (state.snappedText || '').trim();
    boxPx = res.boxPx || state.snappedPx;
    confidence = res.confidence || 0;
    raw = res.raw || (state.snappedText || '').trim();
    corrections = res.correctionsApplied || res.corrections || [];
    fieldTokens = res.tokens || [];
  }

  const norm = toPct(state.viewport, boxPx);
  const extras = {};
  if(step.type === 'static'){
    const lm = captureRingLandmark(boxPx);
    lm.anchorHints = ANCHOR_HINTS[step.fieldKey] || [];
    extras.landmark = lm;
  } else if(step.type === 'column'){
    extras.column = buildColumnModel(step, norm, boxPx, tokens);
  }
  upsertFieldInProfile(step, norm, value, confidence, state.pageNum, extras, raw, corrections, fieldTokens);
  ensureAnchorFor(step.fieldKey);
  state.currentLineItems = await extractLineItems(state.profile);
  renderSavedFieldsTable();

  const fid = state.currentFileId;
  if(fid){
    rawStore[fid] = rawStore[fid] || [];
    const arr = rawStore[fid];
    const idx = arr.findIndex(r=>r.fieldKey===step.fieldKey);
    const rec = { fieldKey: step.fieldKey, raw, value, confidence, correctionsApplied: corrections, page: state.pageNum, bboxPct: norm, ts: Date.now(), tokens: fieldTokens };
    if(idx>=0) arr[idx]=rec; else arr.push(rec);
  }

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
      const norm = boxPx ? toPct(state.viewport, { ...boxPx, page: state.pageNum }) : null;
      const arr = rawStore[state.currentFileId];
      let conf = confidence;
      const dup = arr.find(r=>r.fieldKey!==spec.fieldKey && ['subtotal_amount','tax_amount','invoice_total'].includes(spec.fieldKey) && ['subtotal_amount','tax_amount','invoice_total'].includes(r.fieldKey) && r.value===value);
      if(dup) conf *= 0.5;
      const idx = arr.findIndex(r=>r.fieldKey===spec.fieldKey);
      const rec = { fieldKey: spec.fieldKey, raw, value, confidence: conf, correctionsApplied: corrections, page: state.pageNum, bbox: norm, ts: Date.now() };
      if(idx>=0) arr[idx]=rec; else arr.push(rec);
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
