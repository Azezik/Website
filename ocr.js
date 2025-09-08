// OCR helper utilities

function intersects(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function tokensInRect(tokens, rect) {
  const inside = tokens
    .filter(t => intersects(t, rect))
    .sort((a,b) => (a.y0 - b.y0) || (a.x0 - b.x0))
    .map(t => t.text);
  return inside.join(' ').replace(/\s+/g, ' ').trim();
}

function pctRectToPx(rect, page) {
  return {
    x0: rect.x * page.width,
    y0: rect.y * page.height,
    x1: (rect.x + rect.w) * page.width,
    y1: (rect.y + rect.h) * page.height
  };
}

function expandRect(rect, paddingPct, page) {
  const padX = page.width * paddingPct;
  const padY = page.height * paddingPct;
  return {
    x0: Math.max(0, rect.x0 - padX),
    y0: Math.max(0, rect.y0 - padY),
    x1: rect.x1 + padX,
    y1: rect.y1 + padY
  };
}

function normalizeSpace(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

const api = {
  intersects,
  tokensInRect,
  pctRectToPx,
  expandRect,
  normalizeSpace
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.OCR = api;
}
