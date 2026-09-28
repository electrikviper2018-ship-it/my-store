import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';

const {
  PRINTIFY_TOKEN, PRINTIFY_SHOP_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  SITE_URL = 'http://localhost:3000', SHIP_COUNTRIES = 'US', PORT = 3000,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

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
  return res.json();
}

// Simple in-memory cache so every page view doesn't hit Printify.
let cache = { at: 0, data: [] };
async function getProducts() {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const { data } = await printify(`/shops/${PRINTIFY_SHOP_ID}/products.json?limit=50`);
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
          .map((v) => ({ id: v.id, title: v.title, price: v.price })), // price in cents
      })),
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

      await printify(`/shops/${PRINTIFY_SHOP_ID}/orders.json`, {
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
app.use(express.static('public'));

app.get('/api/products', async (_req, res) => {
  try {
    res.json(await getProducts());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not load products.' });
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
      // Stripe metadata is limited to 500 characters per value, which fits small carts.
      metadata: { cart: JSON.stringify(cart.map((i) => ({ p: i.productId, v: i.variantId, q: i.quantity }))) },
      success_url: `${SITE_URL}/?order=success`,
      cancel_url: `${SITE_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Store running at ${SITE_URL}`));
