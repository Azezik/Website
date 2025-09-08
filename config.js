const config = {
  PADDING_PCT: 0.02,
  ANCHORS: [
    'Invoice',
    'Sales Bill',
    'Salesperson',
    'Sub-Total',
    'Total',
    'Deposit',
    'Balance'
  ],
  ANCHOR_SEARCH: { right: 0.3, bottom: 0.1, left: 0, top: 0 },
  CONF_THRESHOLDS: {
    invoiceNumber: 0.8,
    date: 0.8,
    money: 0.9,
    default: 0.7
  },
  MONEY_LOCALE: 'en-US',
  ARITH_TOLERANCE: 0.02
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = config;
} else {
  window.InvoiceConfig = config;
}
