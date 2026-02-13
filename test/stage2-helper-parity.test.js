const assert = require('assert');

const geometryBox = require('../engines/geometry/box.js');
const pageSpace = require('../engines/geometry/page-space.js');
const cleaning = require('../engines/cleaning/normalize.js');
const fieldNorm = require('../engines/cleaning/field-normalizers.js');

function legacyNormalizeBox(boxPx, canvasW, canvasH){
  return { x0n: boxPx.x / canvasW, y0n: boxPx.y / canvasH, wN: boxPx.w / canvasW, hN: boxPx.h / canvasH };
}
function legacyDenormalizeBox(normBox, W, H){
  return {
    sx: Math.round(normBox.x0n * W),
    sy: Math.round(normBox.y0n * H),
    sw: Math.max(1, Math.round(normBox.wN * W)),
    sh: Math.max(1, Math.round(normBox.hN * H))
  };
}
function legacyIntersect(a,b){ return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function legacyGetViewportDimensions(viewport){
  const width = Math.max(1, ((viewport?.width ?? viewport?.w) || 0) || 1);
  const height = Math.max(1, ((viewport?.height ?? viewport?.h) || 0) || 1);
  return { width, height };
}
function legacyApplyTransform(boxPx, transform = {}, viewport = {}){
  const { scale = 1, rotation = 0 } = transform || {};
  if(scale === 1 && rotation === 0) return { ...boxPx };
  const wPage = ((viewport.w ?? viewport.width) || 1);
  const hPage = ((viewport.h ?? viewport.height) || 1);
  const cx = wPage / 2;
  const cy = hPage / 2;
  const x = boxPx.x + boxPx.w / 2;
  const y = boxPx.y + boxPx.h / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = (x - cx) * scale;
  const dy = (y - cy) * scale;
  const x2 = dx * cos - dy * sin + cx;
  const y2 = dx * sin + dy * cos + cy;
  const w = boxPx.w * scale;
  const h = boxPx.h * scale;
  return { x: x2 - w / 2, y: y2 - h / 2, w, h, page: boxPx.page };
}
function legacyCollapseAdjacentDuplicates(str){
  if(!str) return '';
  let out = str;
  const re = /(\b[\w#&.-]+(?:\s+[\w#&.-]+)*)\s+\1\b/gi;
  let prev;
  do { prev = out; out = out.replace(re, '$1'); } while(out !== prev);
  return out;
}
function legacyNormalizeMoney(raw){
  if(!raw) return '';
  const sign = /-/.test(raw) ? '-' : '';
  const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g,'');
  const num = parseFloat(cleaned);
  if(isNaN(num)) return '';
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sign + abs;
}
function legacyNormalizeDate(raw){
  if(!raw) return '';
  const txt = raw.trim().replace(/(\d)(st|nd|rd|th)/gi, '$1');
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  let y,m,d;
  let match;
  if((match = txt.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/))){
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if((match = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))){
    const a = +match[1], b = +match[2];
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

(function run(){
  const boxIn = { x: 10, y: 20, w: 45, h: 60, page: 2 };
  assert.deepStrictEqual(geometryBox.normalizeBox(boxIn, 200, 400), legacyNormalizeBox(boxIn, 200, 400));
  const norm = { x0n: 0.2, y0n: 0.1, wN: 0.3, hN: 0.4 };
  assert.deepStrictEqual(geometryBox.denormalizeBox(norm, 1000, 500), legacyDenormalizeBox(norm, 1000, 500));
  assert.strictEqual(geometryBox.intersect({x:0,y:0,w:10,h:10},{x:9,y:9,w:5,h:5}), legacyIntersect({x:0,y:0,w:10,h:10},{x:9,y:9,w:5,h:5}));

  assert.deepStrictEqual(pageSpace.getViewportDimensions({ w: 500, h: 900 }), legacyGetViewportDimensions({ w: 500, h: 900 }));
  const transformed = pageSpace.applyTransform(boxIn, { scale: 1.2, rotation: 0.05 }, { width: 1000, height: 1500 });
  const legacyTransformed = legacyApplyTransform(boxIn, { scale: 1.2, rotation: 0.05 }, { width: 1000, height: 1500 });
  assert.deepStrictEqual(transformed, legacyTransformed);

  assert.strictEqual(cleaning.collapseAdjacentDuplicates('ADAM BEDNAREK ADAM BEDNAREK'), legacyCollapseAdjacentDuplicates('ADAM BEDNAREK ADAM BEDNAREK'));
  assert.strictEqual(fieldNorm.normalizeMoney('$1,234.5'), legacyNormalizeMoney('$1,234.5'));
  assert.strictEqual(fieldNorm.normalizeMoney('-CAD 1,234.50'), legacyNormalizeMoney('-CAD 1,234.50'));
  assert.strictEqual(fieldNorm.normalizeDate('March 3, 2024'), legacyNormalizeDate('March 3, 2024'));
  assert.strictEqual(fieldNorm.normalizeDate('03/14/2024'), legacyNormalizeDate('03/14/2024'));

  console.log('stage2 helper parity passed');
})();
