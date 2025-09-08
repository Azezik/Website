// Simple field map and UI row helpers
class FieldMap {
  constructor(){
    this.map = {};
  }

  upsert(key, entry){
    const prev = this.map[key];
    if(prev && prev.value === entry.value){
      return prev; // no duplicates when same value
    }
    this.map[key] = {
      ...prev,
      ...entry,
      lastUpdated: entry.lastUpdated || new Date().toISOString()
    };
    return this.map[key];
  }

  get(key){ return this.map[key]; }

  rows(){
    return Object.entries(this.map).map(([fieldKey, data]) => ({ fieldKey, ...data }));
  }
}

const api = { FieldMap };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.UI = api;
}
