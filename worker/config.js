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
      subject: (date) => {
        const d = new Date(date);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `Kingdomland Kids Customers Daily Reporting - ${mm}/${dd}/${d.getFullYear()}`;
      },
    },
  },

  from: process.env.MAIL_FROM || 'Reporting <reporting@sentrystrategy.com>',
};
