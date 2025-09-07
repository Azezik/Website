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
     #fieldsTbody, #savedJson, #exportBtn, #finishWizardBtn
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
  dashboard:       document.getElementById('dashboard'),
  docType:         document.getElementById('doc-type'),
  configureBtn:    document.getElementById('configure-btn'),
  newWizardBtn:    document.getElementById('new-wizard-btn'),
  demoBtn:         document.getElementById('demo-btn'),
  uploadBtn:       document.getElementById('upload-btn'),
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

  fieldsTbody:     document.getElementById('fieldsTbody'),
  savedJson:       document.getElementById('savedJson'),
  exportBtn:       document.getElementById('exportBtn'),
  finishWizardBtn: document.getElementById('finishWizardBtn'),
};

(function ensureResultsMount() {
  if (!document.getElementById('resultsMount')) {
    const details = document.createElement('details');
    details.className = 'panel minimal';
    details.open = true;
    details.innerHTML = `<summary>Extracted invoices (live)</summary><div id="resultsMount" style="overflow:auto;"></div>`;
    els.wizardSection?.appendChild(details);
  }
})();

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
const toPx   = (norm, vp)=> {
  const w = vp.w ?? vp.width;
  const h = vp.h ?? vp.height;
  return { x:norm.x*w, y:norm.y*h, w:norm.w*w, h:norm.h*h, page:norm.page };
};
const toNorm = (px, vp)=> {
  const w = vp.w ?? vp.width || 1;
  const h = vp.h ?? vp.height || 1;
  return { x:px.x/w, y:px.y/h, w:px.w/w, h:px.h/h, page:px.page };
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
  const bandCy = hits.map(t=>t.y+t.h/2).reduce((a,b)=>a+b,0)/hits.length;
  const line = groupIntoLines(tokens, 4).find(L => Math.abs(L.cy - bandCy) <= 4);
  const lineTokens = line ? line.tokens : hits;
  const box = bboxOfTokens(lineTokens);
  const expanded = { x:box.x - marginPx, y:box.y - marginPx, w:box.w + marginPx*2, h:box.h + marginPx*2, page:hintPx.page };
  const text = lineTokens.map(t=>t.text).join(' ').trim();
  return { box: expanded, text };
}

/* ---------------------------- Regexes ----------------------------- */
const RE = {
  currency: /([-$]?\s?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{2})?)/,
  date: /([0-3]?\d[\-\/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2})[\-\/\s]\d{2,4})/i,
  orderLike: /(?:order|invoice|no\.?|number|#)\s*[:\-]?\s*([A-Z]?\d{5,})/i,
  sku: /\b([A-Z0-9]{3,}[-_/]?[A-Z0-9]{2,})\b/,
  taxCode: /\b(?:HST|QST)\s*(?:#|no\.?|number)?\s*[:\-]?\s*([0-9A-Z\- ]{8,})\b/i,
  percent: /\b(\d{1,2}(?:\.\d{1,2})?)\s*%/,
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
    state.profile.fields = existing.fields;
  }
  LS.setProfile(state.username, state.docType, state.profile);
}

/* ------------------------ Wizard Steps --------------------------- */
const DEFAULT_FIELDS = [
  // Identifiers (one "landmark" title; the rest are value fields)
  { fieldKey: 'invoice_title',   kind:'landmark', prompt: 'Highlight the “Invoice / Sales Bill” title.', landmarkKey:'invoice_title' },
  { fieldKey: 'order_number',    kind:'value',    prompt: 'Highlight the order/invoice number.', regex: RE.orderLike.source },
  { fieldKey: 'salesperson',     kind:'value',    prompt: 'Highlight the salesperson’s name.' },
  { fieldKey: 'sales_date',      kind:'value',    prompt: 'Highlight the sales date.',           regex: RE.date.source },
  { fieldKey: 'delivery_date',   kind:'value',    prompt: 'Highlight the delivery date (if present).', regex: RE.date.source },
  { fieldKey: 'term',            kind:'value',    prompt: 'Highlight the payment term (e.g., Net 30).' },
  { fieldKey: 'customer_name',   kind:'value',    prompt: 'Highlight the customer name.' },
  { fieldKey: 'store',           kind:'value',    prompt: 'Highlight the store/location (if present).' },

  // Address / info blocks (store the box; value is the snapped text)
  { fieldKey: 'sold_to_block',   kind:'block',    prompt: 'Draw a box over the “Sold To” address block.' },
  { fieldKey: 'ship_to_block',   kind:'block',    prompt: 'Draw a box over the “Ship To” address block.' },
  { fieldKey: 'information_blk', kind:'block',    prompt: 'Highlight the “Information” block if present.' },

  // Totals (values)
  { fieldKey: 'subtotal',        kind:'value',    prompt: 'Highlight the Sub-Total amount.',     regex: RE.currency.source },
  { fieldKey: 'hst',             kind:'value',    prompt: 'Highlight the HST amount (if present).', regex: RE.currency.source },
  { fieldKey: 'hst_number',      kind:'value',    prompt: 'Highlight the HST/QST registration number, if shown.', regex: RE.taxCode.source },
  { fieldKey: 'qst',             kind:'value',    prompt: 'Highlight the QST amount (if present).', regex: RE.currency.source },
  { fieldKey: 'total',           kind:'value',    prompt: 'Highlight the grand Total.',          regex: RE.currency.source },
  { fieldKey: 'deposit',         kind:'value',    prompt: 'Highlight any Deposit recorded.',     regex: RE.currency.source },
  { fieldKey: 'balance',         kind:'value',    prompt: 'Highlight the Balance due.',          regex: RE.currency.source },
];

function initStepsFromProfile(){
  const profFields = (state.profile?.fields || []).map(f => ({...f}));
  const byKey = Object.fromEntries(profFields.map(f=>[f.fieldKey, f]));
  state.steps = DEFAULT_FIELDS.map(d => ({...byKey[d.fieldKey], fieldKey:d.fieldKey, prompt:d.prompt, regex: d.regex || byKey[d.fieldKey]?.regex || undefined, kind: d.kind }));
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
  let confidence = 0, value = '', usedBox = null;

  // 1) Use current snapped selection, if any
  if(state.snappedPx){
    usedBox = state.snappedPx;
    value = fieldSpec.regex ? ((state.snappedText.match(new RegExp(fieldSpec.regex,'i'))||[])[1] || '') : state.snappedText;
    confidence = fieldSpec.regex ? 0.85 : 0.7;
  }

  // 2) Try anchor via landmark
  if(confidence < 0.75 && fieldSpec.anchor && state.profile?.landmarks?.length){
    const lmSpec = state.profile.landmarks.find(l => l.landmarkKey === fieldSpec.anchor.landmarkKey && (l.page===fieldSpec.page || l.page===0));
    if(lmSpec){
      const lmBox = findLandmark(tokens, lmSpec, state.viewport);
      if(lmBox){
        const candidate = boxFromAnchor(lmBox, fieldSpec.anchor, state.viewport);
        const snap = snapToLine(tokens, candidate);
        usedBox = snap.box;
        const txt = snap.text || '';
        value = fieldSpec.regex ? ((txt.match(new RegExp(fieldSpec.regex,'i'))||[])[1] || '') : txt;
        confidence = fieldSpec.regex ? 0.9 : 0.8;
      }
    }
  }

  // 3) Label→Value fallback
  if(confidence < 0.7){
    const lv = labelValueHeuristic(fieldSpec, tokens);
    if(lv.value){ value = lv.value; usedBox = lv.usedBox; confidence = Math.max(confidence, lv.confidence); }
  }

  return { value: (value||'').trim(), boxPx: usedBox, confidence };
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
function insertRecord(fieldsObj){
  const db = LS.getDb();
  db.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    vendorProfileId: `${state.username}:${state.docType}`,
    createdAt: Date.now(),
    fileName: state.currentFileName || 'unnamed',
    pages: state.numPages,
    fields: fieldsObj,
    lineItems: []
  });
  LS.setDb(db);
  renderResultsTable();
}
function renderResultsTable(){
  const mount = document.getElementById('resultsMount');
  const db = LS.getDb();
  if(!db.length){ mount.innerHTML = '<p class="sub">No extractions yet.</p>'; return; }
  const cols = Array.from(db.reduce((set, r)=>{ Object.keys(r.fields||{}).forEach(k=>set.add(k)); return set; }, new Set()));
  const thead = `<tr>${['file','date', ...cols].map(h=>`<th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">${h}</th>`).join('')}</tr>`;
  const rows = db.map(r=>{
    const dt = new Date(r.createdAt).toLocaleString();
    const cells = cols.map(k=>`<td style="padding:6px;border-bottom:1px solid var(--border)">${(r.fields?.[k]??'')}</td>`).join('');
    return `<tr><td style="padding:6px;border-bottom:1px solid var(--border)">${r.fileName}</td><td style="padding:6px;border-bottom:1px solid var(--border)">${dt}</td>${cells}</tr>`;
  }).join('');
  mount.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;
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
  const rows = (state.profile?.fields||[]).map(f => {
    const bbox = f.bbox.map(n => Number(n).toFixed(4)).join(', ');
    return `<tr><td style="padding:6px;border-bottom:1px solid var(--border)">${f.fieldKey}</td>
      <td style="padding:6px;border-bottom:1px solid var(--border)">${f.page}</td>
      <td style="padding:6px;border-bottom:1px solid var(--border)">[${bbox}]</td>
      <td style="padding:6px;border-bottom:1px solid var(--border)">${(f.value||'').toString().replace(/</g,'&lt;')}</td></tr>`;
  }).join('');
  els.fieldsTbody.innerHTML = rows;
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
  els.dashboard.style.display = 'block';
  populateModelSelect();
  renderResultsTable();
});
els.logoutBtn?.addEventListener('click', ()=>{
  els.dashboard.style.display = 'none';
  els.wizardSection.style.display = 'none';
  els.loginSection.style.display = 'block';
});
els.configureBtn?.addEventListener('click', ()=>{
  els.dashboard.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile();
  initStepsFromProfile();
  renderSavedFieldsTable();
});
els.demoBtn?.addEventListener('click', ()=> els.wizardFile.click());

els.docType?.addEventListener('change', ()=>{
  state.docType = els.docType.value || 'invoice';
  populateModelSelect();
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

  const fieldsObj = {};
  for(const f of (state.profile.fields || [])){
    if(f.value !== undefined && f.value !== null && String(f.value).trim() !== ''){
      fieldsObj[f.fieldKey] = f.value;
    }
  }
  insertRecord(fieldsObj);

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
  els.wizardSection.style.display = 'none';
  els.dashboard.style.display = 'block';
  populateModelSelect();
});

/* ---------------------------- Batch ------------------------------- */
async function autoExtractFileWithProfile(file, profile){
  await openFile(file);
  const fieldsObj = {};
  for(const spec of (profile.fields || [])){
    if(typeof spec.page === 'number' && spec.page+1 !== state.pageNum && !state.isImage && state.pdf){
      state.pageNum = clamp(spec.page+1, 1, state.numPages);
      state.viewport = state.pageViewports[state.pageNum-1];
      updatePageIndicator();
      els.viewer?.scrollTo(0, state.pageOffsets[state.pageNum-1] || 0);
    }
    const tokens = await ensureTokensForPage(state.pageNum);
    const fieldSpec = { fieldKey: spec.fieldKey, regex: spec.regex, anchor: spec.anchor, page: spec.page };
    state.snappedPx = null; state.snappedText = '';
    const { value, boxPx } = extractFieldValue(fieldSpec, tokens, state.viewport);
    if(value){ fieldsObj[spec.fieldKey] = value; }
    if(boxPx){ state.snappedPx = { ...boxPx, page: state.pageNum }; drawOverlay(); }
  }
  insertRecord(fieldsObj);
}

async function processBatch(files){
  if(!files.length) return;
  els.dashboard.style.display = 'none';
  els.wizardSection.style.display = 'block';
  ensureProfile(); initStepsFromProfile(); renderSavedFieldsTable();
  const modelId = document.getElementById('model-select')?.value || '';
  const model = modelId ? getModels().find(m => m.id === modelId) : null;

  for(const f of files){
    if(model){ await autoExtractFileWithProfile(f, model.profile); }
    else { await openFile(f); }
  }
}

/* ------------------------ Init on load ---------------------------- */
renderResultsTable();
