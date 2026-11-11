# Checkout setup

Buy buttons use Stripe Checkout. A buyer clicks Buy, the piece is held for 30
minutes, Stripe's page takes the payment, and the sale is recorded in the
Orders tab. Do these steps in order. Test mode first, live mode last.

## 1. Database

1. In the Supabase SQL editor, run `migrations/20261111_checkout.sql`.
   It must come after `migrations/20261028_release_workspace.sql` and
   `SELLER_CARDS_APPLY.sql`. If you ever re-run `SELLER_CARDS_APPLY.sql`,
   run the checkout file again after it.
2. Run `migrations/20261111_checkout_selftest.sql`.
   It ends with a red error box on purpose. The last line should read
   `SELF-TEST RESULT: 26 passed, 0 failed.` Nothing is left behind. If any line
   says FAIL, stop and send the whole message.

3. Run `migrations/20261112_order_shipping.sql`. It adds the carrier and
   tracking columns the shipping email needs. It changes nothing else.

## 2. Stripe account

1. Create or open your Stripe account at dashboard.stripe.com. Stay in
   **Test mode** (the toggle at the top right).
2. Developers, API keys: copy the **Secret key**. It starts with `sk_test_`.
3. Settings, Customer emails: turn on **Successful payments**, so every buyer
   gets a receipt from Stripe.
4. Settings, Branding: add your logo and colors. This is what buyers see on
   Stripe's page.

## 3. Your shipping fee

Open `wrangler.toml` and set `SHIPPING_FLAT_CENTS` to your real flat US
shipping cost in cents: `"1500"` is $15.00. Set `"0"` for free shipping. It is
added to every order, it goes to poda, and it is not shared with the seller.
The file ships with 1500 as a placeholder.

## 4. Secrets in Cloudflare

Workers and Pages, this project, Settings, Variables and Secrets. Add each as
type **Secret**:

| Name | Where to get it |
|------|-----------------|
| `STRIPE_SECRET_KEY` | Stripe, Developers, API keys, the `sk_test_` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase, Project Settings, API Keys, the **Secret key** that starts with `sb_secret_`. It sits below the Publishable key on that page. The older `service_role` key also works. Keep the variable name as written. |
| `STRIPE_WEBHOOK_SECRET` | Step 5 below |

`RESEND_API_KEY` and `ADMIN_EMAIL` are already set. Checkout uses them to email
you each sale.

The `service_role` key skips all database security. It belongs only in
Cloudflare. Never paste it into a file in this repo, a page, or a chat.

## 5. The Stripe webhook

The webhook is how Stripe tells the site a payment went through.

1. Stripe, Developers, Webhooks, Add endpoint.
2. Endpoint URL: `https://podapodapoda.co/api/stripe-webhook`
3. Select these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`
4. After saving, open the endpoint and copy the **Signing secret**. It starts
   with `whsec_`. Add it to Cloudflare as `STRIPE_WEBHOOK_SECRET`.
5. Deploy the site again so the new secrets are picked up.

## 6. Test a purchase, then turn checkout on for everyone

Buy buttons ship switched off, so visitors keep seeing "Inquire". To test
privately, open the site with `?checkout_test=1` on the end of the address,
for example `https://podapodapoda.co/?checkout_test=1`. Buy buttons then show
in that browser tab only, and stay on as you move between pages and come back
from Stripe. Add `?checkout_test=0` to turn them off again.

When the test works and Stripe is in live mode, show Buy to everyone: in
`supabase-config.js`, change `window.PODA_CHECKOUT_ENABLED` from `false` to
`true` and deploy. To go back to Inquire at any time, set it to `false` and
deploy again.

1. Open the Shop with `?checkout_test=1` and click **Buy** on a piece. You should land on Stripe's page
   showing the piece, the shipping line and a US address form.
2. Pay with the test card `4242 4242 4242 4242`, any future date, any CVC,
   any US address.
3. You return to the Order confirmed page. Within a few seconds:
   - the piece reads **Sold** on the Shop
   - Admin, Supply, Orders shows the sale, the buyer and address, and the
     seller's share
   - you receive a "Sold:" email
   - the buyer's email address receives "Your poda order", poda's own
     confirmation. Use an address you can read when you test.
4. Test the hold: click Buy on a piece and leave the Stripe page open. In a
   second browser the same piece reads **Held**.
5. Test cancel: click Buy, then the back arrow on Stripe's page. You land on
   the site with "Checkout cancelled" and the piece is available again.

To see what Stripe sent, use Stripe, Developers, Webhooks, your endpoint,
Recent deliveries. A red delivery means the site returned an error, and Stripe
retries it for up to three days.

## 7. Going live

1. In Stripe, finish account activation and switch off Test mode.
2. Copy the live `sk_live_` secret key into `STRIPE_SECRET_KEY`.
3. Create the same webhook endpoint again in live mode. It has its own signing
   secret. Put it in `STRIPE_WEBHOOK_SECRET`.
4. Deploy, then buy one real piece yourself and refund it from Stripe.

## How it works

- **Hold.** Buy takes a 30-minute hold. Other visitors see the piece as Held.
  The hold ends when the buyer pays, backs out, or the Stripe page expires.
- **Sale.** When Stripe confirms payment, the order is marked paid and the
  piece's quantity drops by one. It then reads Sold everywhere.
- **Split.** The price, poda's commission and the seller's share are frozen on
  the order when Buy is clicked. The commission comes from the piece's
  override, or the seller's rate. poda's own pieces have no seller share.
- **Paying sellers.** You pay sellers yourself. In Orders, use **Mark seller
  paid** after you send the money. Shipping is not part of the seller's share.
- **Late payment.** If someone pays just after their hold ran out and another
  buyer already took the piece, the order shows **Refund needed**. Refund the
  buyer in Stripe, then press **Mark refunded**.
- **Shipping.** Only US addresses are collected. When an order goes out, open
  it in Orders, choose **Mark shipped**, pick the carrier, type the tracking
  number, and press **Mark shipped and email buyer**. The buyer gets an email
  with a tracking link. **Mark shipped, no email** records it without
  emailing. If the email fails, nothing is marked shipped and you see why.
  **Email buyer again** resends it.

## Buyer emails

poda sends the buyer two emails itself, from the same address as the Market
Notes, with replies going to your contact email:

1. **Order confirmation**, the moment payment is confirmed: the piece, price,
   shipping, tax if any, the total, where it ships, and when to expect it.
2. **Shipped**, when you press the button in Orders: the carrier, the tracking
   number and a tracking link.

If either email cannot be sent, you get an alert email so you can write to the
buyer yourself. Stripe's own receipt is separate: turn on Settings, Customer
emails, Successful payments in live mode if you also want that.

## What buyers are told

- **On Stripe's page**, beside the Pay button: final sale unless not as
  described, and ships within 5 business days.
- **On each piece**, in the detail view: the same line, with a link.
- **`policies.html`**, linked in the footer: shipping, returns, authenticity,
  how consignment works, payments and contact. These pages state what poda
  promises buyers. **Read them before launch** and change anything that is not
  true for your business. The 5 business days appears in `_worker.js`,
  `folders.js` and `policies.html`, and the 7-day window for a piece that is
  not as described is in `policies.html`. Change each place together.

## Sales tax

Checkout adds no tax today. The switch is `STRIPE_TAX_ENABLED` in
`wrangler.toml`, `"false"` by default. Whether you must collect tax depends on
where you are and where you sell, so ask an accountant first. To turn it on:

1. In Stripe, go to Settings, Tax. Add your business address and the places
   where you are registered to collect.
2. Change `STRIPE_TAX_ENABLED` to `"true"` in `wrangler.toml` and deploy.
3. Test with a purchase. The tax shows on Stripe's page, in the buyer's
   confirmation, and on the order in Orders. It never changes the seller's
   share, which is based on the price alone.

## Photos and details sellers should fill in

The detail view shows condition, measurements, condition notes, material,
color and a description, but only what the seller typed on the back of their
card. Pieces with only a size look thin to a buyer paying hundreds of dollars.
Ask sellers to fill these in before you accept a piece.

## Optional: slow down abuse

Buy takes holds, so a script could hold every piece. In Cloudflare, Security,
WAF, Rate limiting rules, add a rule for the path `/api/checkout` that allows 5
requests per minute per IP and blocks the rest.
