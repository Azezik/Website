/* Invoice Wizard — multipage PDF + overlay + optional OCR + robust saving */

// DOM
const loginSection = document.getElementById('login-section');
const dashboard    = document.getElementById('dashboard');
const wizardSec    = document.getElementById('wizard-section');

const loginForm    = document.getElementById('login-form');
const logoutBtn    = document.getElementById('logout-btn');

const docTypeSel   = document.getElementById('doc-type');
const dropzone     = document.getElementById('dropzone');
const fileInput    = document.getElementById('file-input');
const configureBtn = document.getElementById('configure-btn');
const newWizardBtn = document.getElementById('new-wizard-btn');
const demoBtn      = document.getElementById('demo-btn');
const uploadBtn    = document.getElementById('upload-btn');

const wizardFile   = document.getElementById('wizard-file');
const stepLabel    = document.getElementById('stepLabel');
const questionText = document.getElementById('questionText');
const viewer       = document.getElementById('viewer');
const pdfCanvas    = document.getElementById('pdfCanvas');
const imgCanvas    = document.getElementById('imgCanvas');
const overlay      = document.getElementById('overlayCanvas');

const boxModeBtn   = document.getElementById('boxModeBtn');
const clearSelectionBtn = document.getElementById('clearSelectionBtn');
const backBtn      = document.getElementById('backBtn');
const skipBtn      = document.getElementById('skipBtn');
const confirmBtn   = document.getElementById('confirmBtn');

const fieldsTbody  = document.getElementById('fieldsTbody');
const savedJsonEl  = document.getElementById('savedJson');
const exportBtn    = document.getElementById('exportBtn');
const finishWizardBtn = document.getElementById('finishWizardBtn');

const pageControls = document.getElementById('pageControls');
const prevPageBtn  = document.getElementById('prevPageBtn');
const nextPageBtn  = document.getElementById('nextPageBtn');
const pageIndicator= document.getElementById('pageIndicator');
const ocrToggle    = document.getElementById('ocrToggle');

// pdf.js worker
if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.js';
}

// Debug helper
function dbg(msg, obj){ console.log('[WIZ]', msg, obj ?? ''); }

// Session + state
let session = { username: null };
let stepIndex = 0;
let currentMap = null;

let pdfDoc = null;
let totalPages = 1;
let currentPage = 1;

let docState = {
  pageIndex: 0,
  displayWidth: 0,
  displayHeight: 0,
  drawing: false,
  start: null,
  box: null,
  isPdf: false
};

const STEPS = [
  { key: 'order_number',       prompt: 'Please highlight the order/invoice number.' },
  { key: 'customer_name',      prompt: 'Please highlight the customer/company name.' },
  { key: 'invoice_date',       prompt: 'Please highlight the invoice date.' },
  { key: 'due_date',           prompt: 'Please highlight the payment due date.' },
  { key: 'line_item.name',     prompt: 'Highlight the product/service NAME column.' },
  { key: 'line_item.quantity', prompt: 'Highlight the QUANTITY column.' },
  { key: 'line_item.unit_price', prompt: 'Highlight the UNIT PRICE column.' },
  { key: 'line_item.total',    prompt: 'Highlight the LINE TOTAL column.' },
  { key: 'subtotal',           prompt: 'Highlight the SUBTOTAL amount.' },
  { key: 'tax_total',          prompt: 'Highlight the TAX amount(s).' },
  { key: 'grand_total',        prompt: 'Highlight the GRAND TOTAL.' },
  { key: 'payment_terms',      prompt: 'Highlight PAYMENT TERMS / notes (optional).' },
  { key: 'vendor_info',        prompt: 'Highlight VENDOR NAME & ADDRESS (optional).' }
];

const storageKey = (u, dt) => `wiz:${u}:${dt}:schema`;
const getDocType = () => (docTypeSel?.value || 'invoice');

function show(el){ el.style.display=''; }
function hide(el){ el.style.display='none'; }

function loadSchema(u, dt){
  const raw = localStorage.getItem(storageKey(u, dt));
  return raw ? JSON.parse(raw) : null;
}
function saveSchema(){
  if (!currentMap) return;
  localStorage.setItem(storageKey(session.username, currentMap.docType), JSON.stringify(currentMap, null, 2));
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);
  renderFieldsTable();
}

function enterDashboard(){
  hide(loginSection); show(dashboard); hide(wizardSec);
  const exists = loadSchema(session.username, getDocType());
  if (exists?.fields?.length){ show(uploadBtn); show(newWizardBtn); hide(configureBtn); }
  else { hide(uploadBtn); hide(newWizardBtn); show(configureBtn); }
  show(demoBtn);
}
function enterWizard(startFresh=false){
  hide(loginSection); hide(dashboard); show(wizardSec);
  const dt = getDocType();
  const u  = session.username || localStorage.getItem('iwUser') || 'anon';
  currentMap = startFresh ? { username: u, docType: dt, version: 1, fields: [] }
                          : (loadSchema(u, dt) ?? { username: u, docType: dt, version: 1, fields: [] });
  stepIndex = Math.min(currentMap.fields.length, STEPS.length - 1);
  updatePrompt();
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);
  renderFieldsTable();
  clearOverlay();
  pdfCanvas.width = pdfCanvas.height = 0;
  imgCanvas.style.display = 'none';
  pageControls.style.display = 'none';
}

function updatePrompt(){
  stepLabel.textContent = `Step ${Math.min(stepIndex+1, STEPS.length)}/${STEPS.length}`;
  questionText.textContent = stepIndex >= STEPS.length ? 'Wizard complete. Export or finish.' : STEPS[stepIndex].prompt;
}

// Login
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  if (!u || !p){ alert('Please enter username and password.'); return; }
  session.username = u;
  localStorage.setItem('iwUser', u);
  enterDashboard();
});
logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('iwUser');
  session.username = null;
  show(loginSection); hide(dashboard); hide(wizardSec);
});

// Dashboard actions
configureBtn?.addEventListener('click', () => enterWizard(false));
newWizardBtn?.addEventListener('click', () => {
  const key = storageKey(session.username || localStorage.getItem('iwUser') || 'anon', getDocType());
  localStorage.removeItem(key);
  enterWizard(true);
});
demoBtn?.addEventListener('click', () => { enterWizard(false); alert('Load a PDF/JPG/PNG and start highlighting.'); });
uploadBtn?.addEventListener('click', () => alert('Upload/extraction will use your saved schema later.'));
docTypeSel?.addEventListener('change', () => { if (session.username) enterDashboard(); });

['dragover','dragleave','drop'].forEach(evt => {
  dropzone?.addEventListener(evt, e => {
    e.preventDefault();
    if (evt==='dragover') dropzone.classList.add('dragover');
    if (evt==='dragleave') dropzone.classList.remove('dragover');
    if (evt==='drop'){ dropzone.classList.remove('dragover'); alert('Use “Configure Wizard” to load a file and map fields.'); }
  });
});

// File load
wizardFile?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  await renderDocument(file);
  docState.box = null; clearOverlay();
});

async function renderDocument(file){
  viewer.style.position = 'relative';
  viewer.style.width = '100%';
  if (!viewer.style.minHeight) viewer.style.minHeight = '320px';

  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  docState.isPdf = isPdf;

  pdfCanvas.style.display = isPdf ? '' : 'none';
  imgCanvas.style.display = isPdf ? 'none' : '';

  if (isPdf){
    const buf = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    totalPages = pdfDoc.numPages || 1;
    currentPage = 1;
    pageControls.style.display = totalPages > 1 ? '' : '';
    await renderPdfPage(currentPage);
  } else {
    pdfDoc = null; totalPages = 1; currentPage = 1;
    pageControls.style.display = 'none';
    await new Promise(r => { imgCanvas.onload = r; imgCanvas.src = URL.createObjectURL(file); });
    imgCanvas.style.maxWidth = '100%';
    imgCanvas.style.height = 'auto';
    requestAnimationFrame(() => syncOverlaySize(imgCanvas));
  }
}
async function renderPdfPage(n){
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(n);
  const vw = Math.max(viewer.clientWidth, 640);
  const v1 = page.getViewport({ scale: 1 });
  const scale = vw / v1.width;
  const vp = page.getViewport({ scale });

  const ctx = pdfCanvas.getContext('2d', { alpha:false });
  pdfCanvas.width  = Math.round(vp.width);
  pdfCanvas.height = Math.round(vp.height);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,pdfCanvas.width,pdfCanvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  docState.pageIndex = n - 1;
  pageIndicator.textContent = `Page ${n}/${totalPages}`;
  requestAnimationFrame(() => syncOverlaySize(pdfCanvas));
}
prevPageBtn?.addEventListener('click', async () => { if (!pdfDoc) return; currentPage = Math.max(1, currentPage-1); await renderPdfPage(currentPage); });
nextPageBtn?.addEventListener('click', async () => { if (!pdfDoc) return; currentPage = Math.min(totalPages, currentPage+1); await renderPdfPage(currentPage); });

function syncOverlaySize(baseEl){
  const rect = baseEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  overlay.width = w; overlay.height = h;
  overlay.style.position = 'absolute';
  overlay.style.left = baseEl.offsetLeft + 'px';
  overlay.style.top  = baseEl.offsetTop  + 'px';
  viewer.style.position = 'relative';
  docState.displayWidth = w; docState.displayHeight = h;
  clearOverlay();
}

// Overlay drawing
const octx = overlay.getContext('2d');
overlay.addEventListener('mousedown', (e) => {
  const p = rel(e); docState.drawing = true; docState.start = p; docState.box = null; drawBox();
});
overlay.addEventListener('mousemove', (e) => {
  if (!docState.drawing) return;
  const p = rel(e);
  docState.box = normBox(docState.start.x, docState.start.y, p.x - docState.start.x, p.y - docState.start.y);
  drawBox();
});
overlay.addEventListener('mouseup', () => { docState.drawing = false; });

function rel(e){ const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function normBox(x,y,w,h){ if(w<0){x+=w;w=-w;} if(h<0){y+=h;h=-h;} x=Math.max(0,Math.min(x,overlay.width)); y=Math.max(0,Math.min(y,overlay.height)); w=Math.max(0,Math.min(w,overlay.width-x)); h=Math.max(0,Math.min(h,overlay.height-y)); return {x,y,w,h}; }
function drawBox(){ octx.clearRect(0,0,overlay.width,overlay.height); if(!docState.box) return; octx.save(); octx.globalAlpha=.2; octx.fillStyle='#00ff00'; octx.fillRect(docState.box.x,docState.box.y,docState.box.w,docState.box.h); octx.globalAlpha=1; octx.lineWidth=2; octx.strokeStyle='#00ff00'; octx.strokeRect(docState.box.x,docState.box.y,docState.box.w,docState.box.h); octx.restore(); }
function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }

clearSelectionBtn?.addEventListener('click', () => { docState.box = null; drawBox(); });
backBtn?.addEventListener('click', () => {
  if (!currentMap?.fields?.length) return;
  currentMap.fields.pop(); stepIndex = Math.max(0, stepIndex-1); saveSchema(); updatePrompt();
});
skipBtn?.addEventListener('click', () => { stepIndex++; updatePrompt(); docState.box = null; drawBox(); });

// Confirm save (with optional OCR)
confirmBtn?.addEventListener('click', async () => {
  dbg('Confirm clicked', { stepIndex, box: docState.box });
  if (stepIndex >= STEPS.length){ alert('Wizard complete — use New Wizard to start over.'); return; }
  if (!docState.box){ alert('Draw a box first.'); return; }

  const bbox = norm(docState.box);
  const rec = { fieldKey: STEPS[stepIndex].key, page: docState.pageIndex, selectorType: 'bbox', bbox, value: null };

  // Optional OCR
  try {
    if (ocrToggle?.checked && typeof Tesseract !== 'undefined'){
      const crop = cropCurrentBoxToCanvas(); if (crop){
        const { data:{ text } } = await Tesseract.recognize(crop, 'eng');
        rec.value = (text || '').trim().replace(/\s+/g,' ');
      }
    }
  } catch(e){ dbg('OCR error', e); }

  currentMap.fields.push(rec);
  saveSchema();
  toast('Saved ✓');

  stepIndex = Math.min(stepIndex+1, STEPS.length);
  updatePrompt();
  docState.box = null; drawBox();
});

function cropCurrentBoxToCanvas(){
  if (!docState.box) return null;
  const px = { x:Math.round(docState.box.x), y:Math.round(docState.box.y), w:Math.round(docState.box.w), h:Math.round(docState.box.h) };
  if (px.w < 2 || px.h < 2) return null;

  let srcCanvas;
  if (docState.isPdf){ srcCanvas = pdfCanvas; }
  else {
    const tmp = document.createElement('canvas');
    tmp.width = imgCanvas.clientWidth; tmp.height = imgCanvas.clientHeight;
    const tctx = tmp.getContext('2d'); tctx.drawImage(imgCanvas,0,0,tmp.width,tmp.height);
    srcCanvas = tmp;
  }

  const out = document.createElement('canvas');
  out.width = px.w; out.height = px.h;
  out.getContext('2d').drawImage(srcCanvas, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);
  return out;
}

function renderFieldsTable(){
  if (!fieldsTbody) return;
  fieldsTbody.innerHTML = '';
  (currentMap?.fields || []).forEach(f => {
    const tr = document.createElement('tr');
    const td = v => { const el = document.createElement('td'); el.style.padding='6px'; el.style.borderBottom='1px solid var(--border)'; el.textContent=v; return el; };
    tr.appendChild(td(f.fieldKey));
    tr.appendChild(td(String((f.page ?? 0)+1)));
    tr.appendChild(td(`[${f.bbox.map(n=>Number(n.toFixed(6))).join(', ')}]`));
    tr.appendChild(td(f.value ?? '—'));
    fieldsTbody.appendChild(tr);
  });
}

exportBtn?.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentMap, null, 2)], { type:'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `invoice-schema-${session.username}-${currentMap.docType}.json`; a.click();
});
finishWizardBtn?.addEventListener('click', () => enterDashboard());

// Toast
function toast(msg){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);'+
    'background:#2ee6a6;color:#081412;padding:8px 12px;border-radius:8px;'+
    'font:12px/1.2 "IBM Plex Mono",monospace;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.35)';
  document.body.appendChild(t); setTimeout(()=>t.remove(), 1200);
}

// Init
(function init(){
  const u = localStorage.getItem('iwUser');
  if (u){ session.username = u; enterDashboard(); } else { show(loginSection); hide(dashboard); hide(wizardSec); }
})();
