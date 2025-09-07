/* Invoice Wizard — client-side MVP */

const loginSection = document.getElementById('login-section');
const dashboard    = document.getElementById('dashboard');
const wizardSec    = document.getElementById('wizard-section');

// login
const loginForm    = document.getElementById('login-form');
const logoutBtn    = document.getElementById('logout-btn');

// dashboard
const docTypeSel   = document.getElementById('doc-type');
const dropzone     = document.getElementById('dropzone');
const fileInput    = document.getElementById('file-input');
const configureBtn = document.getElementById('configure-btn');
const newWizardBtn = document.getElementById('new-wizard-btn');
const demoBtn      = document.getElementById('demo-btn');
const uploadBtn    = document.getElementById('upload-btn');

// wizard
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
const savedJsonEl  = document.getElementById('savedJson');
const exportBtn    = document.getElementById('exportBtn');
const finishWizardBtn = document.getElementById('finishWizardBtn');


// pdf.js worker (required for rendering)
if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.js';
}



let session = { username: null };
let stepIndex = 0;
let currentMap = null;

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

// doc render state
let docState = {
  pageIndex: 0,
  displayWidth: 0,
  displayHeight: 0,
  drawing: false,
  start: null,
  box: null
};

const storageKey = (u, dt) => `wiz:${u}:${dt}:schema`;
const getDocType = () => (docTypeSel?.value || 'invoice');

function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

function loadSchema(username, docType) {
  const raw = localStorage.getItem(storageKey(username, docType));
  return raw ? JSON.parse(raw) : null;
}

function saveSchema() {
  if (!currentMap) return;
  localStorage.setItem(storageKey(session.username, currentMap.docType), JSON.stringify(currentMap, null, 2));
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);
}

function enterDashboard() {
  hide(loginSection); show(dashboard); hide(wizardSec);
  const exists = loadSchema(session.username, getDocType());
  if (exists?.fields?.length) { show(uploadBtn); show(newWizardBtn); hide(configureBtn); }
  else { hide(uploadBtn); hide(newWizardBtn); show(configureBtn); }
  show(demoBtn);
}

function enterWizard(startFresh = false) {
  hide(loginSection); hide(dashboard); show(wizardSec);
  const dt = getDocType();
  currentMap = startFresh ? null : loadSchema(session.username, dt);
  currentMap = currentMap ?? { username: session.username, docType: dt, version: 1, fields: [] };
  stepIndex = Math.min(currentMap.fields.length, STEPS.length - 1);
  updatePrompt();
  savedJsonEl.textContent = JSON.stringify(currentMap, null, 2);
  clearOverlay();
  pdfCanvas.width = pdfCanvas.height = 0;
  imgCanvas.style.display = 'none';
}

function updatePrompt() {
  stepLabel.textContent = `Step ${Math.min(stepIndex+1, STEPS.length)}/${STEPS.length}`;
  questionText.textContent = stepIndex >= STEPS.length ? 'Wizard complete. Export or finish.' : STEPS[stepIndex].prompt;
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  if (!u || !p) { alert('Please enter username and password.'); return; }
  session.username = u;
  localStorage.setItem('iwUser', u);
  enterDashboard();
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('iwUser');
  session.username = null;
  show(loginSection); hide(dashboard); hide(wizardSec);
});

configureBtn.addEventListener('click', () => enterWizard(false));
newWizardBtn.addEventListener('click', () => enterWizard(true));
demoBtn.addEventListener('click', () => { enterWizard(false); alert('Load a PDF/JPG/PNG and start highlighting.'); });
uploadBtn.addEventListener('click', () => alert('Upload/extraction will use your saved schema in a later iteration.'));

docTypeSel?.addEventListener('change', () => { if (session.username) enterDashboard(); });

['dragover','dragleave','drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragover') dropzone.classList.add('dragover');
    if (evt === 'dragleave') dropzone.classList.remove('dragover');
    if (evt === 'drop') {
      dropzone.classList.remove('dragover');
      alert('Use “Configure Wizard” to load a file and map fields.');
    }
  });
});

wizardFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  await renderDocument(file);
  docState.box = null; clearOverlay();
});

async function renderDocument(file) {
  // Ensure viewer is measurable
  viewer.style.position = 'relative';
  viewer.style.width = '100%';
  if (!viewer.style.minHeight) viewer.style.minHeight = '320px';

  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  pdfCanvas.style.display = isPdf ? '' : 'none';
  imgCanvas.style.display = isPdf ? 'none' : '';

  if (isPdf) {
    try {
      const arrayBuf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
      const page = await pdf.getPage(1);

      // Fit page to viewer width (fallback if clientWidth is 0)
      const vw = Math.max(viewer.clientWidth, 640);
      const v1 = page.getViewport({ scale: 1 });
      const scale = vw / v1.width;
      const vp = page.getViewport({ scale });

      const ctx = pdfCanvas.getContext('2d');
      pdfCanvas.width  = Math.round(vp.width);
      pdfCanvas.height = Math.round(vp.height);

      // Force a white background so transparent PDFs show on dark theme
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
      ctx.restore();

      await page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' }).promise;

      // Size the overlay after layout settles
      requestAnimationFrame(() => syncOverlaySize(pdfCanvas));
    } catch (err) {
      console.error('PDF render error:', err);
      alert('Could not render PDF. Try a JPG/PNG to confirm the viewer works.');
    }
  } else {
    await new Promise((res) => { imgCanvas.onload = res; imgCanvas.src = URL.createObjectURL(file); });
    imgCanvas.style.maxWidth = '100%';
    imgCanvas.style.height = 'auto';
    requestAnimationFrame(() => syncOverlaySize(imgCanvas));
  }
}

function syncOverlaySize(baseEl) {
  const rect = baseEl.getBoundingClientRect();

  // Match overlay pixel buffer to the displayed size
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  overlay.width  = w;
  overlay.height = h;

  // Position overlay directly above the base element
  overlay.style.position = 'absolute';
  overlay.style.left = baseEl.offsetLeft + 'px';
  overlay.style.top  = baseEl.offsetTop  + 'px';

  // Ensure stacking context
  viewer.style.position = 'relative';

  // Record display size for normalization
  docState.displayWidth  = w;
  docState.displayHeight = h;

  // Clear any stale drawing
  clearOverlay();
}

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

clearSelectionBtn.addEventListener('click', () => { docState.box = null; drawBox(); });
backBtn.addEventListener('click', () => {
  if (!currentMap?.fields?.length) return;
  currentMap.fields.pop(); stepIndex = Math.max(0, stepIndex - 1); saveSchema(); updatePrompt();
  const last = currentMap.fields[currentMap.fields.length - 1];
  if (last?.bbox){ const b = denorm(last.bbox); docState.box = b; drawBox(); } else { docState.box = null; drawBox(); }
});
skipBtn.addEventListener('click', () => { stepIndex++; updatePrompt(); docState.box = null; drawBox(); });
confirmBtn.addEventListener('click', () => {
  if (stepIndex >= STEPS.length) return;
  if (!docState.box) { alert('Draw a box first.'); return; }
  const bbox = norm(docState.box);
  currentMap.fields.push({ fieldKey: STEPS[stepIndex].key, page: docState.pageIndex, selectorType: 'bbox', bbox });
  saveSchema();
  stepIndex++; updatePrompt(); docState.box = null; drawBox();
});

exportBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentMap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `invoice-schema-${session.username}-${currentMap.docType}.json`; a.click();
});
finishWizardBtn.addEventListener('click', () => enterDashboard());
boxModeBtn.addEventListener('click', () => alert('Box mode active: click and drag to draw a rectangle.'));

function norm(b){ return [b.x/docState.displayWidth,b.y/docState.displayHeight,b.w/docState.displayWidth,b.h/docState.displayHeight]; }
function denorm(a){ return {x:a[0]*docState.displayWidth,y:a[1]*docState.displayHeight,w:a[2]*docState.displayWidth,h:a[3]*docState.displayHeight}; }

(function init(){
  const u = localStorage.getItem('iwUser');
  if (u){ session.username = u; enterDashboard(); }
  else { show(loginSection); hide(dashboard); hide(wizardSec); }
})();
