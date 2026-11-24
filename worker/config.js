function splitList(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

export const config = {
  // Stripe — restricted, read-only API key (Developers → API keys → Create restricted key
  // → give it "Read" access to Balance, Charges, Payouts, Balance Transactions only).
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',

  // Kingdomland Kids analytics dashboard
  kingdomlandUrl: process.env.KINGDOMLAND_URL || 'https://dashboard.kingdomlandkids.com',
  kingdomlandEmail: process.env.KINGDOMLAND_EMAIL || '',
  kingdomlandPassword: process.env.KINGDOMLAND_PASSWORD || '',

  teamPassword: process.env.TEAM_PASSWORD || 'change-me',
  allowedOrigins: splitList(process.env.ALLOWED_ORIGINS) || ['*'],

  recipients: {
    daily: {
      to: splitList(process.env.REPORT_TO) || [],
      cc: splitList(process.env.REPORT_CC) || [],
      // date arrives already formatted as MM/DD/YYYY in US Central (email.js buildSubject).
      subject: (date) => `Kingdomland Kids Customers Daily Reporting - ${date}`,
    },
  },

  from: process.env.MAIL_FROM || 'Reporting <reporting@sentrystrategy.com>',
};
