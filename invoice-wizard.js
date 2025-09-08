const { tokensInRect, pctRectToPx, expandRect, normalizeSpace } = require('./ocr');
const config = require('./config');
const { FieldMap } = require('./ui');

function findAnchorToken(tokens, anchor){
  const lower = anchor.toLowerCase();
  return tokens.find(t => t.text.toLowerCase().includes(lower));
}

function anchorWindow(anchorTok, page, offsets){
  const w = anchorTok.x1 - anchorTok.x0;
  const h = anchorTok.y1 - anchorTok.y0;
  return {
    x0: anchorTok.x1 + w * offsets.left,
    y0: Math.max(0, anchorTok.y0 - h * offsets.top),
    x1: Math.min(page.width, anchorTok.x1 + page.width * offsets.right),
    y1: Math.min(page.height, anchorTok.y1 + page.height * offsets.bottom)
  };
}

function validateInvoiceNumber(text){
  const cleaned = normalizeSpace(text);
  const ok = /^[A-Za-z0-9-]{3,}$/.test(cleaned);
  return { value: cleaned, confidence: ok ? 1 : 0 };
}

function parseDate(text){
  const cleaned = normalizeSpace(text);
  let m;
  if((m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))){
    return `${m[1].padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  }
  if((m = cleaned.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))){
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}

function validateDate(text){
  const iso = parseDate(text);
  return { value: iso, confidence: iso ? 1 : 0 };
}

function parseMoney(text){
  const cleaned = normalizeSpace(text).replace(/[^0-9.,-]/g,'');
  const normalized = cleaned.replace(/,/g,'');
  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function validateMoney(text){
  const num = parseMoney(text);
  return { value: num, confidence: num !== null ? 1 : 0 };
}

function patternSearch(type, tokens){
  const tests = {
    invoiceNumber: t => validateInvoiceNumber(t.text).confidence === 1,
    date: t => validateDate(t.text).confidence === 1,
    money: t => validateMoney(t.text).confidence === 1
  };
  const test = tests[type] || (()=>false);
  for(const t of tokens){
    if(test(t)) return { value: t.text, rect: t };
  }
  return null;
}

function reconcileTotals(fields, cfg=config){
  const sub = fields.get('subtotal')?.value;
  const tax = fields.get('tax')?.value;
  const total = fields.get('total')?.value;
  if(sub!=null && tax!=null && total!=null){
    if(Math.abs((sub + tax) - total) > cfg.ARITH_TOLERANCE){
      const t = fields.get('total');
      if(t){ t.status = 'validation-error'; t.reason = 'subtotal+tax!=total'; }
    }
  }
  const dep = fields.get('deposit')?.value;
  const bal = fields.get('balance')?.value;
  if(total!=null && dep!=null && bal!=null){
    if(Math.abs((total - dep) - bal) > cfg.ARITH_TOLERANCE){
      const b = fields.get('balance');
      if(b){ b.status = 'validation-error'; b.reason = 'total-deposit!=balance'; }
    }
  }
}

function mergeLineItems(items){
  if(!Array.isArray(items)) return [];
  const sorted = items.slice().sort((a,b)=>a.y-b.y);
  const merged=[]; let cur=null;
  for(const it of sorted){
    if(cur && Math.abs(it.y - cur.y2) <= it.h * 0.5){
      cur.description.push(it.desc);
      cur.y2 = it.y + it.h;
    } else {
      if(cur) merged.push(cur);
      cur = {description:[it.desc], qty:it.qty, price:it.price, amount:it.amount, y2:it.y+it.h, confidence:it.confidence||1};
    }
  }
  if(cur) merged.push(cur);
  const cleaned = merged.map(m => ({
    description: m.description.join(' ').replace(/\s+/g,' ').trim(),
    qty: m.qty, price: m.price, amount: m.amount, confidence:m.confidence
  }));
  const dedup=new Map();
  for(const row of cleaned){
    const key = `${row.description}|${row.qty}|${row.amount}`;
    if(!dedup.has(key) || dedup.get(key).confidence < row.confidence){
      dedup.set(key, row);
    }
  }
  return Array.from(dedup.values());
}

class TemplateStore {
  constructor(cfg=config){
    this.cfg = cfg;
    this.families = [];
  }
  fingerprint(doc){
    const anchors=[];
    doc.pages.forEach(p=>{
      for(const t of p.tokens){
        if(this.cfg.ANCHORS.map(a=>a.toLowerCase()).includes(t.text.toLowerCase())) anchors.push(t.text.toLowerCase());
      }
    });
    anchors.sort();
    return `${doc.pages.length}|${anchors.join(',')}`;
  }
  match(fp){
    const fam = this.families.find(f=>f.fingerprint===fp);
    return fam ? fam.profile : null;
  }
  register(fp, profile){
    this.families.push({fingerprint:fp, profile});
  }
}

class DocumentExtractor {
  constructor(cfg=config, store=new TemplateStore(cfg)){
    this.cfg = cfg; this.store = store;
    this.fields = new FieldMap();
    this.audit = {}; this.profile={zones:{}};
  }
  loadProfile(p){ this.profile = p || {zones:{}}; }
  getProfile(){ return this.profile; }

  extractField(spec, page, pageIdx=0){
    const key = spec.fieldKey;
    const threshold = this.cfg.CONF_THRESHOLDS[spec.type] || this.cfg.CONF_THRESHOLDS.default;

    // Strategy 1: known zone
    if(this.profile.zones[key]){
      const rectPx = pctRectToPx(this.profile.zones[key].rect, page);
      const padded = expandRect(rectPx, this.cfg.PADDING_PCT, page);
      const text = tokensInRect(page.tokens, padded);
      const val = this.validate(spec.type, text);
      if(val.confidence >= threshold){
        this.saveField(key, val.value, padded, 'zone', pageIdx);
        return this.fields.get(key);
      }
    }

    // Strategy 2: anchor search
    const anchors = spec.anchors || [];
    for(const a of anchors){
      const tok = findAnchorToken(page.tokens, a);
      if(tok){
        const win = anchorWindow(tok, page, this.cfg.ANCHOR_SEARCH);
        const text = tokensInRect(page.tokens, win);
        const val = this.validate(spec.type, text);
        if(val.confidence >= threshold){
          this.saveField(key, val.value, win, 'anchor', pageIdx, a);
          this.learnZone(key, win, page, pageIdx);
          return this.fields.get(key);
        }
      }
    }

    // Strategy 3: pattern fallback
    const pat = patternSearch(spec.type, page.tokens);
    if(pat){
      const val = this.validate(spec.type, pat.value);
      if(val.confidence >= threshold){
        this.saveField(key, val.value, pat.rect, 'pattern', pageIdx);
        this.learnZone(key, pat.rect, page, pageIdx);
        return this.fields.get(key);
      }
    }

    this.fields.upsert(key, { value:null, confidence:0, status:'unresolved', reason:'no confident match' });
    this.audit[key] = { page: pageIdx, rect:null, strategy:'unresolved' };
    return this.fields.get(key);
  }

  validate(type, text){
    if(type==='invoiceNumber') return validateInvoiceNumber(text);
    if(type==='date') return validateDate(text);
    if(type==='money') return validateMoney(text);
    return { value: normalizeSpace(text), confidence: text ? 0.7 : 0 };
  }

  saveField(key, value, rect, strategy, pageIdx, anchor){
    this.fields.upsert(key, { value, sourceRect:rect, confidence:1, strategy });
    this.audit[key] = { page: pageIdx, rect, strategy, anchor };
  }

  learnZone(key, rectPx, page, pageIdx){
    if(!rectPx) return;
    const rect = {
      x: rectPx.x0 / page.width,
      y: rectPx.y0 / page.height,
      w: (rectPx.x1 - rectPx.x0) / page.width,
      h: (rectPx.y1 - rectPx.y0) / page.height
    };
    this.profile.zones[key] = { page: pageIdx, rect };
  }
}

module.exports = {
  DocumentExtractor,
  TemplateStore,
  mergeLineItems,
  reconcileTotals,
  validateInvoiceNumber,
  validateDate,
  validateMoney,
  findAnchorToken,
  anchorWindow,
  patternSearch
};
