import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { cutout } from './cutout.js';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const {
  PRINTIFY_TOKEN, PRINTIFY_SHOP_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  SITE_URL = 'http://localhost:3000', SHIP_COUNTRIES = 'US', PORT = 3000,
} = process.env;

let shopId = PRINTIFY_SHOP_ID;
// If no shop ID is set, use the first store on the Printify account.
async function getShopId() {
  if (!shopId) shopId = (await printify('/shops.json'))[0]?.id;
  return shopId;
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();
app.set('trust proxy', 1);

const pub = fileURLToPath(new URL('./public/', import.meta.url));
// Public site address: SITE_URL if set, otherwise whatever address the visitor used.
const base = (req) =>
  SITE_URL && !SITE_URL.includes('localhost') ? SITE_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
const page = async (file, req) => (await fs.readFile(pub + file, 'utf8')).replaceAll('{{SITE_URL}}', base(req));
const LEGAL = ['privacy', 'terms', 'refunds', 'cookies'];

// Printify helper: the token stays on the server and is never sent to the browser.
async function printify(path, options = {}) {
  const res = await fetch(`https://api.printify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PRINTIFY_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Printify ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Tell Printify a product is live on this site. Without this, Printify leaves
// the product on "Publishing" forever.
async function markPublished(productId, siteUrl) {
  await printify(`/shops/${await getShopId()}/products/${productId}/publishing_succeeded.json`, {
    method: 'POST',
    body: JSON.stringify({ external: { id: productId, handle: `${siteUrl}/` } }),
  });
}

// On startup: make sure Printify sends us publish notices, and finish any product already stuck.
async function setupPrintify() {
  const siteUrl = (SITE_URL && !SITE_URL.includes('localhost') ? SITE_URL : process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!siteUrl || !PRINTIFY_TOKEN) return;
  const shop = await getShopId();
  const hookUrl = `${siteUrl}/printify-webhook`;
  const hooks = await printify(`/shops/${shop}/webhooks.json`);
  const list = Array.isArray(hooks) ? hooks : hooks.data || [];
  if (!list.some((h) => h.topic === 'product:publish:started' && h.url === hookUrl)) {
    await printify(`/shops/${shop}/webhooks.json`, {
      method: 'POST',
      body: JSON.stringify({ topic: 'product:publish:started', url: hookUrl }),
    });
    console.log('Registered Printify publish webhook:', hookUrl);
  }
  const { data = [] } = await printify(`/shops/${shop}/products.json?limit=50`);
  for (const p of data.filter((x) => x.is_locked)) {
    await markPublished(p.id, siteUrl);
    console.log('Marked published:', p.id);
  }
}

// Simple in-memory cache so every page view doesn't hit Printify.
let cache = { at: 0, data: [] };
async function getProducts() {
  if (Date.now() - cache.at < 2 * 60 * 1000) return cache.data;
  const { data } = await printify(`/shops/${await getShopId()}/products.json?limit=50`);
  cache = {
    at: Date.now(),
    data: data
      .filter((p) => p.visible)
      .map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        image: (p.images.find((i) => i.is_default) || p.images[0])?.src,
        variants: p.variants
          .filter((v) => v.is_enabled)
          .map((v) => ({ id: v.id, title: v.title, price: v.price, available: v.is_available !== false })), // price in cents
      }))
      .filter((p) => p.variants.length),
  };
  return cache.data;
}

// Stripe webhook: needs the raw body, so it goes before express.json().
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    try {
      const session = event.data.object;
      const ship = session.collected_information?.shipping_details || session.shipping_details;
      const [first, ...rest] = (ship.name || '').split(' ');
      const items = JSON.parse(session.metadata.cart);

      await printify(`/shops/${await getShopId()}/orders.json`, {
        method: 'POST',
        body: JSON.stringify({
          external_id: session.id,
          label: session.id.slice(-10),
          line_items: items.map((i) => ({ product_id: i.p, variant_id: i.v, quantity: i.q })),
          shipping_method: 1, // 1 = standard
          send_shipping_notification: true,
          address_to: {
            first_name: first || 'Customer',
            last_name: rest.join(' ') || '-',
            email: session.customer_details.email,
            phone: session.customer_details.phone || '',
            country: ship.address.country,
            region: ship.address.state || '',
            address1: ship.address.line1,
            address2: ship.address.line2 || '',
            city: ship.address.city,
            zip: ship.address.postal_code,
          },
        }),
      });
    } catch (err) {
      // Return 500 so Stripe retries the webhook.
      console.error('Order failed:', err);
      return res.status(500).end();
    }
  }
  res.json({ received: true });
});

app.use(express.json());
// Printify calls this when you press Publish. We confirm the product exists in our shop, then reply "published".
app.post('/printify-webhook', (req, res) => {
  res.json({ received: true });
  const id = req.body?.resource?.id;
  if (req.body?.type !== 'product:publish:started' || !/^[a-f0-9]{24}$/i.test(id || '')) return;
  (async () => {
    await printify(`/shops/${await getShopId()}/products/${id}.json`); // throws if it isn't ours
    await markPublished(id, base(req));
    cache.at = 0; // show the product right away
  })().catch((err) => console.error('Publish confirmation failed:', err.message));
});

const send = (file) => async (req, res, next) => {
  try { res.type('html').send(await page(file(req), req)); } catch (err) { next(err); }
};
app.get(['/', '/index.html'], send(() => 'index.html'));
app.get(/^\/(privacy|terms|refunds|cookies)\.html$/, send((req) => `${req.params[0]}.html`));

app.get('/sitemap.xml', (req, res) => {
  const urls = ['/', ...LEGAL.map((p) => `/${p}.html`)];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${base(req)}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
});
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${base(req)}/sitemap.xml\n`));
app.get('/llms.txt', (req, res) => {
  const b = base(req);
  res.type('text/plain').send(`# FERMO

> FERMO sells phone cases that are printed to order and shipped to the customer's door.

## Pages
- [Store](${b}/): browse phone cases, choose a model and check out securely
- [Refund Policy](${b}/refunds.html): what happens with damaged, defective or late orders
- [Terms and Conditions](${b}/terms.html)
- [Privacy Policy](${b}/privacy.html)
- [Cookie Policy](${b}/cookies.html)

## Contact
- Email: fermocases.shop@gmail.com
`);
});

app.use(express.static('public'));

app.get('/api/products', async (_req, res) => {
  try {
    res.json(await getProducts());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not load products.' });
  }
});

// Serves a product photo with its white background removed (falls back to the original in the browser if this fails).
const cutCache = new Map();
app.get('/api/cutout', async (req, res) => {
  try {
    const u = new URL(String(req.query.u || ''));
    if (u.protocol !== 'https:' || !/(^|\.)printify\.com$/.test(u.hostname)) return res.status(400).end();
    let png = cutCache.get(u.href);
    if (!png) {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`Image ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 10e6) throw new Error('Image too large');
      png = cutout(buf);
      if (cutCache.size >= 80) cutCache.delete(cutCache.keys().next().value);
      cutCache.set(u.href, png);
    }
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(png);
  } catch {
    res.status(502).end();
  }
});

// Prices are looked up server-side, so customers can't change them in the browser.
app.post('/api/checkout', async (req, res) => {
  try {
    const cart = req.body.cart || [];
    if (!cart.length) return res.status(400).json({ error: 'Your cart is empty.' });
    const products = await getProducts();

    const lineItems = cart.map(({ productId, variantId, quantity }) => {
      const product = products.find((p) => p.id === productId);
      const variant = product?.variants.find((v) => v.id === variantId);
      if (!variant) throw new Error('An item in your cart is no longer available.');
      if (!variant.available) throw new Error(`${product.title} (${variant.title}) is out of stock. Remove it from your cart to continue.`);
      return {
        quantity: Math.min(Math.max(parseInt(quantity) || 1, 1), 10),
        price_data: {
          currency: 'usd',
          unit_amount: variant.price,
          product_data: { name: `${product.title} (${variant.title})`, images: product.image ? [product.image] : [] },
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: SHIP_COUNTRIES.split(',') },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Free standard shipping' },
      }],
      // Stripe metadata is limited to 500 characters per value, which fits small carts.
      metadata: { cart: JSON.stringify(cart.map((i) => ({ p: i.productId, v: i.variantId, q: i.quantity }))) },
      success_url: `${base(req)}/?order=success`,
      cancel_url: `${base(req)}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.use(async (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  try { res.status(404).type('html').send(await page('404.html', req)); } catch { res.status(404).send('Page not found'); }
});
app.use((err, _req, res, _next) => { console.error(err); res.status(500).send('Something went wrong. Please try again.'); });

app.listen(PORT, () => {
  console.log(`Store running at ${SITE_URL}`);
  setupPrintify().catch((err) => console.error('Printify setup failed:', err.message));
});
