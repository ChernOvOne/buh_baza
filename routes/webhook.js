const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../database/db');

// Verify HMAC signature
function verifySignature(secret, payload, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
  catch { return false; }
}

// POST /api/webhook/payment?key=SECRET
router.post('/payment', express.raw({ type: '*/*' }), (req, res) => {
  const key = req.query.key || req.headers['x-webhook-key'];
  if (!key) return res.status(401).json({ error: 'Missing key' });

  const wk = db.prepare('SELECT * FROM webhook_keys WHERE secret=? AND active=1').get(key);
  if (!wk) return res.status(401).json({ error: 'Invalid key' });

  // Optional signature check
  const sig = req.headers['x-signature'] || req.headers['x-baza-signature'];
  const rawBody = req.body?.toString('utf8') || '';
  if (sig && !verifySignature(key, rawBody, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let data;
  try { data = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const {
    payment_id, amount, currency = 'RUB', status = 'success',
    customer_id, customer_email, customer_name,
    product, product_id, date
  } = data;

  if (!amount || isNaN(+amount)) return res.status(400).json({ error: 'amount required' });

  // Update stats: count request
  db.prepare('UPDATE webhook_keys SET requests=requests+1, last_used=datetime("now") WHERE id=?').run(wk.id);

  // Insert payment
  try {
    db.prepare(`INSERT OR IGNORE INTO payments
      (payment_id,amount,currency,status,customer_id,customer_email,customer_name,product,product_id,raw_payload,mode,source_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      payment_id || `auto_${Date.now()}`, +amount, currency, status,
      customer_id || null, customer_email || null, customer_name || null,
      product || null, product_id || null,
      JSON.stringify(data), wk.mode, key
    );
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.json({ ok: true, duplicate: true });
    return res.status(500).json({ error: e.message });
  }

  // If status=success and mode=live → add to daily revenue
  if (status === 'success' && wk.mode === 'live') {
    const entryDate = date ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note)
      VALUES (?,?,0,'Webhook')
      ON CONFLICT(date) DO UPDATE SET revenue=revenue+excluded.revenue`
    ).run(entryDate, +amount);

    // TG notification
    try {
      const { getSetting } = require('../database/db');
      const notifyPayments = getSetting('notify_new_payment', false);
      if (notifyPayments) {
        const { notifyNewPayment } = require('../services/bot');
        notifyNewPayment({ amount: +amount, customer_name, customer_email, product, payment_id, mode: wk.mode });
      }
    } catch(e) {}
  }

  return res.json({ ok: true, mode: wk.mode, recorded: status === 'success' && wk.mode === 'live' });
});

// GET /api/webhook/payment — docs
router.get('/payment', (req, res) => {
  res.json({
    endpoint: '/api/webhook/payment',
    method: 'POST',
    auth: 'Query param: ?key=YOUR_SECRET or header X-Webhook-Key',
    signature: 'Optional: X-Signature: HMAC-SHA256(secret, body)',
    body: {
      payment_id: 'string (unique, optional)',
      amount: 'number (required)',
      currency: 'string (default: RUB)',
      status: 'success | refund | pending (default: success)',
      customer_id: 'string (optional)',
      customer_email: 'string (optional)',
      customer_name: 'string (optional)',
      product: 'string (optional)',
      product_id: 'string (optional)',
      date: 'YYYY-MM-DD (optional, default: today)'
    },
    response: { ok: true, mode: 'live|test', recorded: true }
  });
});

module.exports = router;
