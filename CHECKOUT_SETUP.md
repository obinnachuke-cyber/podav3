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

## 6. Turn checkout on, then test a purchase

Buy buttons ship switched off, so the site keeps showing "Inquire" until you
are ready. In `supabase-config.js`, change `window.PODA_CHECKOUT_ENABLED` from
`false` to `true`, then deploy. To go back to Inquire at any time, set it to
`false` and deploy again.

1. On the live Shop, click **Buy** on a piece. You should land on Stripe's page
   showing the piece, the shipping line and a US address form.
2. Pay with the test card `4242 4242 4242 4242`, any future date, any CVC,
   any US address.
3. You return to the Order confirmed page. Within a few seconds:
   - the piece reads **Sold** on the Shop
   - Admin, Supply, Orders shows the sale, the buyer and address, and the
     seller's share
   - you receive a "Sold:" email
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
- **Shipping.** Only US addresses are collected. Use **Mark shipped** when it
  goes out.

## Optional: slow down abuse

Buy takes holds, so a script could hold every piece. In Cloudflare, Security,
WAF, Rate limiting rules, add a rule for the path `/api/checkout` that allows 5
requests per minute per IP and blocks the rest.
