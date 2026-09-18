const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.static(__dirname));  // 🔥 serves index.html
// In-memory order store (survives while server is up; upgrade to DB later)
const orders = new Map();
const deliveredProducts = new Map();

// ========== WAYL CONFIG ==========
const WAYL_API_KEY = process.env.WAYL_API_KEY;
const WAYL_API_URL = process.env.WAYL_API_URL || 'https://api.wayl.io/v1';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mboostt-backend.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend-url.com';

// ========== HEALTH CHECK (for UptimeRobot) ==========
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'MBOOSTT Backend',
    time: new Date().toISOString() 
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ========== CREATE CHECKOUT SESSION ==========
// This creates a Wayl checkout and returns the redirect URL
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { productId, title, price, waylLink, hiddenLink } = req.body;

    if (!productId || !title) {
      return res.status(400).json({ success: false, error: 'Missing product data' });
    }

    // Generate unique order ID
    const orderId = 'ORD_' + crypto.randomBytes(8).toString('hex');
    
    // Store the order with hidden link
    orders.set(orderId, {
      orderId,
      productId,
      title,
      price,
      hiddenLink,
      waylLink,
      createdAt: Date.now(),
      paid: false
    });

    console.log(`📦 Order created: ${orderId} for "${title}" (${price})`);

    // ========== OPTION A: Direct Wayl Payment Link ==========
    // If you're using static Wayl payment links, append tracking param
    if (waylLink && waylLink.startsWith('http')) {
      const trackingUrl = new URL(waylLink);
      trackingUrl.searchParams.set('ref', orderId);
      trackingUrl.searchParams.set('redirect', `${BACKEND_URL}/api/payment-success?order=${orderId}`);
      
      return res.json({
        success: true,
        orderId,
        checkoutUrl: trackingUrl.toString(),
        method: 'direct_link'
      });
    }

    // ========== OPTION B: Wayl API Session (if they support it) ==========
    // Uncomment if Wayl provides a sessions API
    /*
    const waylResponse = await fetch(`${WAYL_API_URL}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WAYL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: parseFloat(price.replace(/[^0-9.]/g, '')) * 100,
        currency: 'USD',
        reference: orderId,
        success_url: `${BACKEND_URL}/api/payment-success?order=${orderId}`,
        cancel_url: `${FRONTEND_URL}?canceled=1`,
        metadata: { productId, title }
      })
    });
    const session = await waylResponse.json();
    return res.json({ success: true, orderId, checkoutUrl: session.url });
    */

    // Fallback: no Wayl link set
    return res.status(400).json({ 
      success: false, 
      error: 'No Wayl checkout URL configured for this product' 
    });

  } catch (err) {
    console.error('❌ Checkout error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== WAYL WEBHOOK ==========
// Set this URL in Wayl dashboard: https://mboostt-backend.onrender.com/api/wayl-webhook
app.post('/api/wayl-webhook', (req, res) => {
  try {
    const body = req.body;
    console.log('🔔 Wayl webhook received:', JSON.stringify(body, null, 2));

    // Verify signature if Wayl provides one
    // const signature = req.headers['x-wayl-signature'];
    // const expected = crypto.createHmac('sha256', process.env.WAYL_WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex');
    // if (signature !== expected) return res.status(401).send('Invalid signature');

    const orderId = body.reference || body.metadata?.orderId || body.order_id;
    const status = body.status || body.event;
    
    if (orderId && orders.has(orderId)) {
      const order = orders.get(orderId);
      
      if (status === 'paid' || status === 'completed' || status === 'success' || status === 'payment.success') {
        order.paid = true;
        order.paidAt = Date.now();
        
        // Store the delivery for user pickup
        deliveredProducts.set(orderId, {
          hiddenLink: order.hiddenLink,
          title: order.title,
          deliveredAt: Date.now()
        });
        
        console.log(`✅ Payment confirmed for ${orderId} — delivering: ${order.hiddenLink}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== PAYMENT SUCCESS REDIRECT ==========
// Wayl redirects here after successful payment
app.get('/api/payment-success', (req, res) => {
  const orderId = req.query.order;
  const order = orders.get(orderId);
  
  if (!order) {
    return res.send(`
      <html><body style="background:#1c0808;color:#f5e9dc;font-family:sans-serif;text-align:center;padding:50px;">
        <h1>⚠️ Order not found</h1>
        <p>Order ID: ${orderId || 'missing'}</p>
        <a href="${FRONTEND_URL}" style="color:#e9b384;">← Back to store</a>
      </body></html>
    `);
  }

  // If payment already confirmed by webhook, show link immediately
  const delivery = deliveredProducts.get(orderId);
  const isPaid = order.paid || !!delivery;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MBOOSTT · Payment ${isPaid ? 'Confirmed' : 'Processing'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          background: #1c0808;
          background-image: radial-gradient(circle at 15% 20%, #4a1a1a 0%, #1a0505 85%);
          color: #f5e9dc; font-family: 'Inter', sans-serif;
          min-height: 100vh; display: flex; align-items: center; justify-content: center;
          padding: 20px; margin: 0;
        }
        .box {
          background: rgba(28,10,10,0.85); border: 2px solid #9b5e3c;
          border-radius: 28px; padding: 2.5rem; max-width: 500px;
          text-align: center; box-shadow: 0 30px 60px black;
        }
        h1 { font-family: Georgia, serif; color: #e9b384; font-size: 2rem; margin-bottom: 1rem; }
        .price { font-size: 2.5rem; color: #fae3c8; font-weight: 800; margin: 1rem 0; }
        .link-box {
          background: #2f1212; border: 1px solid #b27650; border-radius: 16px;
          padding: 1.2rem; margin: 1.5rem 0; word-break: break-all;
          color: #ffd9aa; font-size: 0.95rem;
        }
        a.btn {
          display: inline-block; background: linear-gradient(145deg, #a54f2e, #6e2f1c);
          color: #ffeedd; padding: 1rem 2rem; border-radius: 50px;
          text-decoration: none; font-weight: 800; text-transform: uppercase;
          letter-spacing: 2px; margin-top: 1rem;
          box-shadow: 0 12px 18px -5px #00000080;
        }
        .status { color: ${isPaid ? '#8ee08e' : '#e0c98e'}; font-weight: 700; margin-bottom: 1rem; }
        .spinner { display: ${isPaid ? 'none' : 'inline-block'}; width: 20px; height: 20px;
          border: 3px solid #b27650; border-top-color: transparent;
          border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      ${!isPaid ? '<meta http-equiv="refresh" content="5">' : ''}
    </head>
    <body>
      <div class="box">
        <h1>${isPaid ? '✨ ACCESS GRANTED' : '⏳ Verifying Payment'}</h1>
        <div class="status">
          ${isPaid ? '✓ Payment confirmed' : '<div class="spinner"></div> Waiting for Wayl confirmation...'}
        </div>
        <p>${order.title}</p>
        <div class="price">${order.price}</div>
        ${isPaid ? `
          <p style="color:#bda38b;">Your product access:</p>
          <div class="link-box">🔓 ${order.hiddenLink}</div>
          <a href="${order.hiddenLink}" class="btn" target="_blank">Open Product</a>
        ` : `
          <p style="color:#bda38b;font-size:0.85rem;">
            This page auto-refreshes. If payment was successful, your link will appear shortly.
          </p>
        `}
        <p style="margin-top:2rem;font-size:0.8rem;color:#8a6a4e;">
          Order: ${orderId}
        </p>
      </div>
    </body>
    </html>
  `);
});

// ========== CHECK ORDER STATUS (API) ==========
app.get('/api/order-status/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ success: false, error: 'Not found' });
  
  res.json({
    success: true,
    paid: order.paid,
    title: order.title,
    price: order.price,
    hiddenLink: order.paid ? order.hiddenLink : null
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 MBOOSTT backend running on port ${PORT}`);
  console.log(`📍 Health check: ${BACKEND_URL}/health`);
  console.log(`📦 Webhook: ${BACKEND_URL}/api/wayl-webhook`);
});
