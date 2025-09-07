/* Invoice Wizard - Updated with Back/Skip, Finish, Model saving/selection, Auto-extraction */

const els = {
  loginSection: document.getElementById('login-section'),
  loginForm: document.getElementById('login-form'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  dashboard: document.getElementById('dashboard'),
  docType: document.getElementById('doc-type'),
  configureBtn: document.getElementById('configure-btn'),
  demoBtn: document.getElementById('demo-btn'),
  uploadBtn: document.getElementById('upload-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  modelSelect: document.getElementById('model-select'),

  wizardSection: document.getElementById('wizard-section'),
  wizardFile: document.getElementById('wizard-file'),

  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  pageIndicator: document.getElementById('pageIndicator'),
  ocrToggle: document.getElementById('ocrToggle'),

  pdfCanvas: document.getElementById('pdfCanvas'),
  imgCanvas: document.getElementById('imgCanvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),

  boxModeBtn: document.getElementById('boxModeBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  backBtn: document.getElementById('backBtn'),
  skipBtn: document.getElementById('skipBtn'),
  confirmBtn: document.getElementById('confirmBtn'),
  finishWizardBtn: document.getElementById('finishWizardBtn'),

  stepLabel: document.getElementById('stepLabel'),
  questionText: document.getElementById('questionText'),

  fieldsTbody: document.getElementById('fieldsTbody'),
  savedJson: document.getElementById('savedJson'),
  exportBtn: document.getElementById('exportBtn'),
};

const pdfjsLibRef = window['pdfjs-dist/build/pdf'] || window['pdfjsLib'];
const TesseractRef = window.Tesseract;

let state = {
  username: null,
  docType: 'invoice',
  profile: null,
  pdf: null,
  fileBlobUrl: null,
  isImage: false,
  pageNum: 1,
  numPages: 1,
  viewport: { w: 0, h: 0, scale: 1 },
  tokensByPage: {},
  selectionPx: null,
  snappedPx: null,
  snappedText: '',
  steps: [],
  stepIdx: 0,
  currentFileName: '',
};

const MODELS_KEY = 'wiz.models';
function getModels(){ try{ return JSON.parse(localStorage.getItem(MODELS_KEY) || '[]'); } catch{ return []; } }
function setModels(m){ localStorage.setItem(MODELS_KEY, JSON.stringify(m)); }

function saveCurrentProfileAsModel(){
  const id = `${state.username}:${state.docType}:${Date.now()}`;
  const models = getModels();
  models.push({ id, username: state.username, docType: state.docType, profile: state.profile });
  setModels(models);
  populateModelSelect();
  alert('Wizard model saved.');
}
function populateModelSelect(){
  const sel = els.modelSelect;
  if(!sel) return;
  const models = getModels().filter(m => m.username === state.username && m.docType === state.docType);
  sel.innerHTML = `<option value="">— Select a saved model —</option>` +
    models.map(m => `<option value="${m.id}">${new Date(parseInt(m.id.split(':').pop(),10)).toLocaleString()}</option>`).join('');
}
function loadModelById(id){
  const m = getModels().find(x => x.id === id);
  if(!m) return null;
  state.profile = m.profile;
  return m.profile;
}

// Simplified profile + steps (full landmarks omitted here for brevity)
function ensureProfile(){ if(!state.profile) state.profile = { username:state.username, docType:state.docType, fields:[] }; }
const DEFAULT_FIELDS = [
  { fieldKey:'invoice_title', kind:'landmark', prompt:'Highlight the “Invoice / Sales Bill” title.' },
  { fieldKey:'order_number',  kind:'value', prompt:'Highlight the order/invoice number.' },
  { fieldKey:'customer_name', kind:'value', prompt:'Highlight the customer name.' },
  { fieldKey:'total',         kind:'value', prompt:'Highlight the total amount.' },
];
function initStepsFromProfile(){
  state.steps = DEFAULT_FIELDS.map(f=>({...f}));
  state.stepIdx = 0;
  updatePrompt();
}
function updatePrompt(){
  const step = state.steps[state.stepIdx];
  els.stepLabel.textContent = `Step ${state.stepIdx+1}/${state.steps.length}`;
  els.questionText.textContent = step?.prompt || '';
}
function goToStep(idx){
  state.stepIdx = Math.max(0, Math.min(idx, state.steps.length-1));
  updatePrompt();
  state.selectionPx = null; state.snappedPx = null; state.snappedText = '';
}
function finishWizard(){
  els.confirmBtn.disabled = true;
  els.skipBtn.disabled = true;
  els.backBtn.disabled = false;
  els.stepLabel.textContent = 'Wizard complete';
  els.questionText.textContent = 'Click “Save & Return” or export JSON.';
}

// Confirm / Back / Skip
els.confirmBtn.addEventListener('click', ()=>{
  const step = state.steps[state.stepIdx];
  if(step){ state.profile.fields.push({ fieldKey: step.fieldKey, value: state.snappedText || '' }); }
  if(state.stepIdx < state.steps.length-1){ goToStep(state.stepIdx+1); } else finishWizard();
});
els.backBtn.addEventListener('click', ()=>{ if(state.stepIdx>0) goToStep(state.stepIdx-1); });
els.skipBtn.addEventListener('click', ()=>{ if(state.stepIdx<state.steps.length-1) goToStep(state.stepIdx+1); else finishWizard(); });
els.finishWizardBtn.addEventListener('click', ()=>{
  ensureProfile(); saveCurrentProfileAsModel();
  els.wizardSection.style.display='none'; els.dashboard.style.display='block';
  populateModelSelect();
});

// Auto-extraction
async function autoExtractFileWithProfile(file, profile){
  await openFile(file);
  const fieldsObj = {};
  for(const f of (profile.fields||[])) fieldsObj[f.fieldKey] = f.value;
  insertRecord(fieldsObj);
}
async function processBatch(files){
  const modelId = els.modelSelect?.value;
  const model = modelId ? getModels().find(m => m.id===modelId) : null;
  for(const f of files){ if(model) await autoExtractFileWithProfile(f, model.profile); else await openFile(f); }
}

// Auth
els.loginForm.addEventListener('submit', e=>{
  e.preventDefault();
  state.username = els.username.value.trim()||'demo';
  state.docType = els.docType.value||'invoice';
  ensureProfile();
  els.loginSection.style.display='none';
  els.dashboard.style.display='block';
  populateModelSelect();
});
els.logoutBtn.addEventListener('click', ()=>{ els.dashboard.style.display='none'; els.wizardSection.style.display='none'; els.loginSection.style.display='block'; });
els.configureBtn.addEventListener('click', ()=>{ els.dashboard.style.display='none'; els.wizardSection.style.display='block'; ensureProfile(); initStepsFromProfile(); });

// Dropzone
;['dragover','dragleave','drop'].forEach(evt=>els.dropzone.addEventListener(evt,e=>{
  e.preventDefault(); if(evt==='dragover') els.dropzone.classList.add('dragover');
  if(evt==='dragleave') els.dropzone.classList.remove('dragover');
  if(evt==='drop'){ els.dropzone.classList.remove('dragover'); processBatch(Array.from(e.dataTransfer.files||[])); }
}));
els.fileInput.addEventListener('change', e=> processBatch(Array.from(e.target.files||[])));
