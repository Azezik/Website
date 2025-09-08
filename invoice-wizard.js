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
  steps: [],                 // wizard steps
  stepIdx: 0,
  currentFileName: '',
  currentFileId: '',        // unique id per opened file
};

/* ---------------------- Storage / Persistence --------------------- */
const LS = {
  profileKey: (u, d) => `wiz.profile.${u}.${d}`,
  dbKey: () => `wiz.db.records`,
  getProfile(u, d) { const raw = localStorage.getItem(this.profileKey(u,d)); return raw ? JSON.parse(raw) : null; },
  setProfile(u, d, p) { localStorage.setItem(this.profileKey(u,d), JSON.stringify(p, null, 2)); },
  getDb() { const raw = localStorage.getItem(this.dbKey()); return raw ? JSON.parse(raw) : []; },
  setDb(arr){ localStorage.setItem(this.dbKey(), JSON.stringify(arr)); },
};

// Raw and compiled stores
const rawStore = {};       // {fileId: [{fieldKey,value,page,bbox,ts}]}
const fileMeta = {};       // {fileId: {fileName}}

const MODELS_KEY = 'wiz.models';
function getModels(){ try{ return JSON.parse(localStorage.getItem(MODELS_KEY) || '[]'); } catch{ return []; } }
function setModels(m){ localStorage.setItem(MODELS_KEY, JSON.stringify(m)); }

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
  state.profile = m.profile;
  LS.setProfile(state.username, state.docType, state.profile);
  return m.profile;
}

/* ------------------------- Utilities ------------------------------ */
const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));

const toPx = (norm, vp) => {
  const w = (vp.w ?? vp.width) || 1;
  const h = (vp.h ?? vp.height) || 1;
  return { x: norm.x * w, y: norm.y * h, w: norm.w * w, h: norm.h * h, page: norm.page };
};

const toNorm = (px, vp) => {
  const w = (vp.w ?? vp.width) || 1;
  const h = (vp.h ?? vp.height) || 1;
  return { x: px.x / w, y: px.y / h, w: px.w / w, h: px.h / h, page: px.page };
};

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

function cleanScalarValue(raw, fieldKey=''){
  let txt = (raw || '').replace(/[#:—•]*$/, '').trim();
  const label = fieldKey.replace(/_/g,' ');
  if(label){
    const labelRe = new RegExp(`^${label}\\s*[:#-]?\\s*`, 'i');
    txt = txt.replace(labelRe, '').trim();
    if(txt.toLowerCase() === label.toLowerCase()) txt = '';
  }
  txt = collapseAdjacentDuplicates(txt).replace(/\s+/g,' ').trim();

  if(/date/i.test(fieldKey)){
    const norm = normalizeDate(txt);
    if(norm) txt = norm;
  } else if(/total|subtotal|tax|amount|price|balance|deposit|discount|unit|grand/i.test(fieldKey)){
    const norm = normalizeMoney(txt);
    if(norm) txt = norm;
  } else if(/sku|product_code/i.test(fieldKey)){
    txt = txt.replace(/\s+/g,'').toUpperCase();
  }

  return txt;
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
function snapToLine(tokens, hintPx, marginPx=6){
  const hits = tokens.filter(t => intersect(hintPx, t));
  if(!hits.length) return { box: hintPx, text: '' };
  const bandCy = hits.map(t => t.y + t.h/2).reduce((a,b)=>a+b,0)/hits.length;
  const line = groupIntoLines(tokens, 4).find(L => Math.abs(L.cy - bandCy) <= 4);
  const lineTokens = line ? line.tokens : hits;
  // Horizontally limit to tokens inside the hint box, but keep full line height
  const left   = Math.min(...hits.map(t => t.x));
  const right  = Math.max(...hits.map(t => t.x + t.w));
  const top    = Math.min(...lineTokens.map(t => t.y));
  const bottom = Math.max(...lineTokens.map(t => t.y + t.h));
  const box = { x:left, y:top, w:right-left, h:bottom-top, page:hintPx.page };
  const expanded = { x:box.x - marginPx, y:box.y - marginPx, w:box.w + marginPx*2, h:box.h + marginPx*2, page:hintPx.page };
  const text = hits.map(t => t.text).join(' ').trim();
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
  subtotal: 'subtotal',
  hst: 'tax',
  qst: 'tax',
  total: 'invoice_total'
};

/* --------------------------- Landmarks ---------------------------- */
function ensureProfile(){
  if(state.profile) return;

  state.profile = {
    username: state.username,
    docType: state.docType,
    version: 2,
    fields: [],
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
      { landmarkKey:'total_hdr',      page:0, type:'text', text:'Total',       strategy:'exact' },
      { landmarkKey:'deposit_hdr',    page:0, type:'text', text:'Deposit',     strategy:'fuzzy', threshold:0.86 },
      { landmarkKey:'balance_hdr',    page:0, type:'text', text:'Balance',     strategy:'fuzzy', threshold:0.86 },
    ],
    tableHints: {
      headerLandmarks: ['description_hdr','qty_header','price_header','amount_header'],
      rowBandHeightPx: 18
    }
  };

  // Seed from any existing saved schema (same shape you uploaded earlier)
  const existing = LS.getProfile(state.username, state.docType);
  if (existing?.fields?.length) {
    state.profile.fields = existing.fields.map(f => ({
      ...f,
      fieldKey: FIELD_ALIASES[f.fieldKey] || f.fieldKey
    }));
  }
  LS.setProfile(state.username, state.docType, state.profile);
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
    required: true
  },
  {
    fieldKey: 'department_division',
    label: 'Department / Division',
    prompt: 'Highlight the department/division (if shown). If not present, click Skip.',
    kind: 'value',
    mode: 'cell',
    required: false
  },
  {
    fieldKey: 'invoice_number',
    label: 'Invoice Number',
    prompt: 'Highlight the invoice number (e.g., INV-12345).',
    kind: 'value',
    mode: 'cell',
    regex: RE.orderLike.source,
    required: true
  },
  {
    fieldKey: 'invoice_date',
    label: 'Invoice Date',
    prompt: 'Highlight the invoice date (e.g., 2025-09-08 or Sept 8, 2025).',
    kind: 'value',
    mode: 'cell',
    regex: RE.date.source,
    required: true
  },
  {
    fieldKey: 'salesperson_rep',
    label: 'Salesperson / Rep',
    prompt: 'Highlight the salesperson/rep name or ID (if shown). If not present, click Skip.',
    kind: 'value',
    mode: 'cell',
    required: false
  },
  {
    fieldKey: 'customer_name',
    label: 'Customer (Sold To)',
    prompt: 'Highlight the customer name (Sold To/Bill To).',
    kind: 'value',
    mode: 'cell',
    required: true
  },
  {
    fieldKey: 'customer_address',
    label: 'Customer Address (City/Province/Postal)',
    prompt: 'Highlight the customer address block (include city, province, and postal code if present).',
    kind: 'block',
    mode: 'cell',
    required: false
  },

  // Line-Item Columns
  {
    fieldKey: 'description_col',
    label: 'Product / Service Description (Column)',
    prompt: 'Highlight the entire column containing product/service descriptions. Drag from the first row to the last row so the whole column is selected.',
    kind: 'block',
    mode: 'column',
    required: true
  },
  {
    fieldKey: 'sku_col',
    label: 'Product Code / SKU (Column)',
    prompt: 'Highlight the entire column of product codes/SKUs (if present). If none, click Skip.',
    kind: 'block',
    mode: 'column',
    required: false
  },
  {
    fieldKey: 'quantity_col',
    label: 'Quantity (Column)',
    prompt: 'Highlight the entire column of quantities.',
    kind: 'block',
    mode: 'column',
    required: true
  },
  {
    fieldKey: 'unit_price_col',
    label: 'Unit Price (Column)',
    prompt: 'Highlight the entire column of unit prices.',
    kind: 'block',
    mode: 'column',
    required: true
  },

  // Totals & Taxes (single cell highlights)
  {
    fieldKey: 'subtotal',
    label: 'Subtotal (before tax & discounts)',
    prompt: 'Highlight the Subtotal amount (before tax and discounts).',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true
  },
  {
    fieldKey: 'discounts',
    label: 'Discounts (if any)',
    prompt: 'Highlight the total Discounts amount (if present). If none, click Skip.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: false
  },
  {
    fieldKey: 'tax',
    label: 'Tax (HST/GST/PST)',
    prompt: 'Highlight the total tax line (e.g., HST). If multiple taxes, highlight the combined total.',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true
  },
  {
    fieldKey: 'invoice_total',
    label: 'Invoice Total (Grand Total)',
    prompt: 'Highlight the final amount due (Grand Total/Total).',
    kind: 'value',
    mode: 'cell',
    regex: RE.currency.source,
    required: true
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
    required: d.required
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
  state.selectionPx = null; state.snappedPx = null; state.snappedText = ''; drawOverlay();
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
    ? lines.filter(L => L.tokens.some(t => intersect(toPx({x:spec.bbox[0],y:spec.bbox[1],w:spec.bbox[2],h:spec.bbox[3],page:spec.page}, viewportPx), t)))
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

/* ----------------------- Field Extraction ------------------------ */
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

function extractFieldValue(fieldSpec, tokens, viewportPx){
  const candidates = [];
  const label = (fieldSpec.fieldKey||'').replace(/_/g,' ');

  // 1) Current snapped selection
  if(state.snappedPx){
    let val = fieldSpec.regex
      ? ((state.snappedText.match(new RegExp(fieldSpec.regex, 'i')) || [])[1] || '')
      : state.snappedText;
    val = cleanScalarValue(val, label);
    if(val){
      candidates.push({ value: val, boxPx: state.snappedPx, confidence: fieldSpec.regex ? 0.85 : 0.8 });
    }
  }

  // 2) Saved bbox from profile
  if(fieldSpec.bbox){
    const basePx = toPx({ x: fieldSpec.bbox[0], y: fieldSpec.bbox[1], w: fieldSpec.bbox[2], h: fieldSpec.bbox[3], page: fieldSpec.page }, viewportPx);
    const pads = [0,4,8,12];
    let fallbackText = '';
    for(const pad of pads){
      const search = { x: basePx.x - pad, y: basePx.y - pad, w: basePx.w + pad*2, h: basePx.h + pad*2, page: basePx.page };
      const hits = tokens.filter(t => t.page === search.page && intersect(search, t));
      if(!hits.length) continue;
      hits.sort((a,b)=>a.x-b.x);
      const text = hits.map(t=>t.text).join(' ').trim();
      if(text) fallbackText = fallbackText || text;
      let val = fieldSpec.regex ? ((text.match(new RegExp(fieldSpec.regex, 'i'))||[])[1] || '') : text;
      val = cleanScalarValue(val, label);
      if(val){
        candidates.push({ value: val, boxPx: search, confidence: fieldSpec.regex ? 0.95 : 0.85 });
        break;
      }
    }
    if(!candidates.length && fallbackText){
      candidates.push({ value: cleanScalarValue(fallbackText, label), boxPx: basePx, confidence: 0.3 });
    }
  }

  // 3) Anchor via landmark
  if(fieldSpec.anchor && state.profile?.landmarks?.length){
    const lmSpec = state.profile.landmarks.find(
      l => l.landmarkKey === fieldSpec.anchor.landmarkKey && (l.page === fieldSpec.page || l.page === 0)
    );
    if(lmSpec){
      const lmBox = findLandmark(tokens, lmSpec, state.viewport);
      if(lmBox){
        const candidate = boxFromAnchor(lmBox, fieldSpec.anchor, state.viewport);
        const snap = snapToLine(tokens, candidate);
        const txt = snap.text || '';
        if(txt.trim()){
          let val = fieldSpec.regex
            ? ((txt.match(new RegExp(fieldSpec.regex, 'i')) || [])[1] || '')
            : txt;
          val = cleanScalarValue(val, label);
          if(val){
            candidates.push({ value: val, boxPx: snap.box, confidence: fieldSpec.regex ? 0.9 : 0.8 });
          }
        }
      }
    }
  }

  // 4) Label→Value heuristic
  const lv = labelValueHeuristic(fieldSpec, tokens);
  if(lv.value){
    const val = cleanScalarValue(lv.value, label);
    if(val){ candidates.push({ value: val, boxPx: lv.usedBox, confidence: lv.confidence }); }
  }

  // Near-duplicate collapse
  const unique = [];
  for(const c of candidates){
    const dup = unique.find(u => cosine3Gram(u.value, c.value) >= 0.9);
    if(dup){
      if(c.value.length < dup.value.length){
        dup.value = c.value; dup.boxPx = c.boxPx;
      }
      dup.confidence = Math.max(dup.confidence, c.confidence);
    } else {
      unique.push({ ...c });
    }
  }

  if(unique.length){
    const score = c => {
      let s = c.confidence || 0;
      const v = c.value;
      if(fieldSpec.regex){
        s += new RegExp(fieldSpec.regex,'i').test(v) ? 0.1 : -0.1;
      } else if(/date/i.test(fieldSpec.fieldKey)){
        s += RE.date.test(v) ? 0.1 : 0;
      } else if(/total|subtotal|tax|discount/i.test(fieldSpec.fieldKey)){
        s += RE.currency.test(v) ? 0.1 : 0;
      } else if(/invoice|order|number|no/i.test(fieldSpec.fieldKey)){
        s += RE.orderLike.test(v) ? 0.1 : 0;
      }
      return s - v.length * 0.001; // cleanliness
    };
    unique.sort((a,b)=> score(b) - score(a));
    const best = unique[0];
    return { value: best.value.trim(), boxPx: best.boxPx, confidence: score(best) };
  }

  const fb = cleanScalarValue(state.snappedText, label);
  return { value: fb, boxPx: state.snappedPx || null, confidence: fb ? 0.3 : 0 };
}

/* ---------------------- PDF/Image Loading ------------------------ */
const overlayCtx = els.overlayCanvas.getContext('2d');

function sizeOverlayTo(w,h){
  els.overlayCanvas.width = w;
  els.overlayCanvas.height = h;
  els.overlayCanvas.style.width = w+'px';
  els.overlayCanvas.style.height = h+'px';
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

/* ----------------------- Text Extraction ------------------------- */
async function ensureTokensForPage(pageNum, pageObj=null, vp=null, canvasEl=null){
  if(state.tokensByPage[pageNum]) return state.tokensByPage[pageNum];
  let tokens = [];
  if(state.isImage){
    const { data: { words } } = await TesseractRef.recognize(els.imgCanvas, 'eng');
    tokens = (words||[]).map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1-w.bbox.x0, h: w.bbox.y1-w.bbox.y0, page: pageNum }));
    state.tokensByPage[pageNum] = tokens;
    return tokens;
  }

  if(!pageObj) pageObj = await state.pdf.getPage(pageNum);
  if(!vp) vp = state.pageViewports[pageNum-1];

  // Always attempt to use embedded PDF text first
  try {
    const content = await pageObj.getTextContent();
    for(const item of content.items){
      const tx = pdfjsLibRef.Util.transform(vp.transform, item.transform);
      const x = tx[4], yTop = tx[5], w = item.width, h = item.height;
      tokens.push({ text: item.str, x, y: yTop - h, w, h, page: pageNum });
    }
    if(tokens.length && !els.ocrToggle.checked){
      state.tokensByPage[pageNum] = tokens;
      return tokens;
    }
  } catch(err){
    console.warn('PDF textContent failed, falling back to OCR', err);
  }

  // OCR fallback or supplement
  let pageCanvas = canvasEl;
  if(!pageCanvas){
    pageCanvas = document.createElement('canvas');
    pageCanvas.width = vp.width; pageCanvas.height = vp.height;
    const cctx = pageCanvas.getContext('2d');
    cctx.drawImage(els.pdfCanvas, 0, state.pageOffsets[pageNum-1], vp.width, vp.height, 0, 0, vp.width, vp.height);
  }
  const { data: { words } } = await TesseractRef.recognize(pageCanvas, 'eng');
  const ocrTokens = (words||[]).map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1-w.bbox.x0, h: w.bbox.y1-w.bbox.y0, page: pageNum }));
  tokens = tokens.length ? tokens.concat(ocrTokens) : ocrTokens;
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

els.overlayCanvas.addEventListener('mousedown', e=>{
  drawing = true;
  const rect = els.overlayCanvas.getBoundingClientRect();
  start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});
els.overlayCanvas.addEventListener('mousemove', e=>{
  if(!drawing) return;
  const rect = els.overlayCanvas.getBoundingClientRect();
  const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const page = pageFromY(start.y);
  const offset = state.pageOffsets[page-1] || 0;
  const box = { x: Math.min(start.x,cur.x), y: Math.min(start.y,cur.y) - offset, w: Math.abs(cur.x-start.x), h: Math.abs(cur.y-start.y), page };
  state.selectionPx = box; drawOverlay();
});
els.overlayCanvas.addEventListener('mouseup', async ()=>{
  drawing = false;
  if(!state.selectionPx) return;
  state.pageNum = state.selectionPx.page;
  state.viewport = state.pageViewports[state.pageNum-1];
  updatePageIndicator();
  const tokens = await ensureTokensForPage(state.pageNum);
  const snap = snapToLine(tokens, state.selectionPx);
  state.snappedPx = snap.box; state.snappedText = snap.text;
  drawOverlay();
});

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
function compileDocument(fileId){
  const raw = rawStore[fileId] || [];
  if(!raw.length) return null;
  const byKey = {};
  raw.forEach(r=>{ byKey[r.fieldKey] = r; });
  const compiled = {
    fileId,
    fileName: fileMeta[fileId]?.fileName || 'unnamed',
    processedAtISO: new Date().toISOString(),
    customer: {
      name: byKey['customer_name']?.value || '',
      phone: '',
      email: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      province: '',
      postalCode: ''
    },
    invoice: {
      number: byKey['invoice_number']?.value || '',
      salesDateISO: byKey['invoice_date']?.value || '',
      deliveryDateISO: '',
      salesperson: byKey['salesperson_rep']?.value || '',
      store: byKey['store_name']?.value || '',
      terms: '',
      customerId: ''
    },
    totals: {
      subtotal: byKey['subtotal']?.value || '',
      hst: byKey['tax']?.value || '',
      qst: '',
      total: byKey['invoice_total']?.value || '',
      deposit: byKey['deposit']?.value || '',
      balance: byKey['balance']?.value || ''
    },
    lineItems: [],
    notes: [],
    templateKey: `${state.username}:${state.docType}`
  };
  const db = LS.getDb();
  const idx = db.findIndex(r => r.fileId === fileId);
  if(idx>=0) db[idx] = compiled; else db.push(compiled);
  LS.setDb(db);
  renderResultsTable();
  return compiled;
}

function renderResultsTable(){
  const mount = document.getElementById('resultsMount');
  let db = LS.getDb().filter(r => r.templateKey.startsWith(`${state.username}:`));
  const filter = els.dataDocType?.value;
  if(filter){ db = db.filter(r => r.templateKey.endsWith(':'+filter)); }
  if(!db.length){ mount.innerHTML = '<p class="sub">No extractions yet.</p>'; return; }
  const thead = `<tr>`+
    ['file','processedAt','customer','address','total','items','actions'].map(h=>`<th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">${h}</th>`).join('')+
    `</tr>`;
  const rows = db.map(r=>{
    const addr = [r.customer?.addressLine1, r.customer?.city, r.customer?.province].filter(Boolean).join(', ');
    const rawCount = (rawStore[r.fileId]||[]).length;
    return `<tr data-id="${r.fileId}">`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${r.fileName}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${r.processedAtISO}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${r.customer?.name||''}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${addr}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${r.totals?.total||''}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">${r.lineItems?.length||0}</td>`+
      `<td style="padding:6px;border-bottom:1px solid var(--border)">`+
        `<button class="btn recompile" data-id="${r.fileId}">Recompile</button>`+
        `<button class="btn viewRaw" data-id="${r.fileId}">Raw (${rawCount})</button>`+
        `<button class="btn exportJson" data-id="${r.fileId}">Export JSON</button>`+
      `</td>`+
      `</tr>`+
      `<tr class="rawRow" data-id="${r.fileId}" style="display:none"><td colspan="7"><pre class="code">${(rawStore[r.fileId]||[]).length?JSON.stringify(rawStore[r.fileId],null,2):'[]'}</pre></td></tr>`;
  }).join('');
  mount.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;

  mount.querySelectorAll('button.recompile').forEach(btn=>btn.addEventListener('click', ()=>{
    compileDocument(btn.dataset.id);
  }));
  mount.querySelectorAll('button.viewRaw').forEach(btn=>btn.addEventListener('click', ()=>{
    const row = mount.querySelector(`tr.rawRow[data-id="${btn.dataset.id}"]`);
    if(row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  }));
  mount.querySelectorAll('button.exportJson').forEach(btn=>btn.addEventListener('click', ()=>{
    const db = LS.getDb();
    const rec = db.find(r=>r.fileId===btn.dataset.id);
    if(!rec) return;
    const blob = new Blob([JSON.stringify(rec, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${rec.fileName||'record'}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }));
}

/* ---------------------- Profile save / table --------------------- */
function upsertFieldInProfile(fieldKey, normBox, value, page){
  ensureProfile();
  const existing = state.profile.fields.find(f => f.fieldKey === fieldKey);
  const entry = { fieldKey, page, selectorType:'bbox', bbox:[normBox.x, normBox.y, normBox.w, normBox.h], value };
  if(existing) Object.assign(existing, entry);
  else state.profile.fields.push(entry);
  LS.setProfile(state.username, state.docType, state.profile);
  renderSavedFieldsTable();
}
function ensureAnchorFor(fieldKey){
  if(!state.profile) return;
  const f = state.profile.fields.find(x => x.fieldKey === fieldKey);
  if(!f || f.anchor) return;
  const anchorMap = {
    order_number:   { landmarkKey:'sales_bill',    dx: 0.02, dy: 0.00, w: 0.10, h: 0.035 },
    subtotal:       { landmarkKey:'subtotal_hdr',  dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    hst:            { landmarkKey:'hst_hdr',       dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    qst:            { landmarkKey:'qst_hdr',       dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    total:          { landmarkKey:'total_hdr',     dx: 0.12, dy: 0.00, w: 0.14, h: 0.04  },
    deposit:        { landmarkKey:'deposit_hdr',   dx: 0.12, dy: 0.00, w: 0.12, h: 0.035 },
    balance:        { landmarkKey:'balance_hdr',   dx: 0.12, dy: 0.00, w: 0.14, h: 0.04  },
  };
  if(anchorMap[fieldKey]){
    f.anchor = anchorMap[fieldKey];
    LS.setProfile(state.username, state.docType, state.profile);
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
  els.savedJson.textContent = JSON.stringify(state.profile, null, 2);
}

/* --------------------------- Events ------------------------------ */
// Auth
els.loginForm?.addEventListener('submit', (e)=>{
  e.preventDefault();
  state.username = (els.username?.value || 'demo').trim();
  state.docType = els.docType?.value || 'invoice';
  state.profile = LS.getProfile(state.username, state.docType) || null;
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
localStorage.removeItem(LS.profileKey(state.username, state.docType));
const models = getModels().filter(m => !(m.username === state.username && m.docType === state.docType));
setModels(models);
localStorage.removeItem(LS.dbKey());
state.profile = null;
renderSavedFieldsTable();
populateModelSelect();
renderResultsTable();
alert('Model and records reset.');

});
els.dataDocType?.addEventListener('change', renderResultsTable);
els.configureBtn?.addEventListener('click', ()=>{
  els.app.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile();
  initStepsFromProfile();
  renderSavedFieldsTable();
});
els.demoBtn?.addEventListener('click', ()=> els.wizardFile.click());

els.docType?.addEventListener('change', ()=>{
  state.docType = els.docType.value || 'invoice';
  state.profile = LS.getProfile(state.username, state.docType) || null;
  renderSavedFieldsTable();
  populateModelSelect();
});

els.dataDocType?.addEventListener('change', renderResultsTable);

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
  els.dropzone.addEventListener(evtName, (e)=>{
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
els.fileInput.addEventListener('change', e=>{
  const files = Array.from(e.target.files || []);
  if (files.length) processBatch(files);
});

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
  if(step.kind === 'landmark'){
    value = (state.snappedText || '').trim();
  } else if (step.kind === 'block'){
    value = (state.snappedText || '').trim();
  } else {
    const res = extractFieldValue(step, tokens, state.viewport);
    value = res.value || (state.snappedText || '').trim();
    boxPx = res.boxPx || state.snappedPx;
  }

  const norm = toNorm(boxPx, state.viewport);
  upsertFieldInProfile(step.fieldKey, norm, value, state.pageNum);
  ensureAnchorFor(step.fieldKey);

  const fid = state.currentFileId;
  if(fid){
    rawStore[fid] = rawStore[fid] || [];
    rawStore[fid].push({ fieldKey: step.fieldKey, value, page: state.pageNum, bbox: norm, ts: Date.now() });
  }

  afterConfirmAdvance();
});

// Export JSON (profile)
els.exportBtn?.addEventListener('click', ()=>{
  ensureProfile();
  const blob = new Blob([JSON.stringify(state.profile, null, 2)], {type:'application/json'});
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
    const { value, boxPx } = extractFieldValue(fieldSpec, tokens, state.viewport);
    if(value){
      const norm = boxPx ? toNorm({ ...boxPx, page: state.pageNum }, state.viewport) : null;
      rawStore[state.currentFileId].push({ fieldKey: spec.fieldKey, value, page: state.pageNum, bbox: norm, ts: Date.now() });
    }
    if(boxPx){ state.snappedPx = { ...boxPx, page: state.pageNum }; drawOverlay(); }
  }
  compileDocument(state.currentFileId);
}

async function processBatch(files){
  if(!files.length) return;
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
