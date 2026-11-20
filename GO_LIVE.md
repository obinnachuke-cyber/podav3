# Go live with real payments

Everything in the code is built and tested in a Stripe sandbox. These steps
are the ones only you can do, in order. Do not skip ahead: live mode needs
Stripe to approve the account first.

Decisions behind this list: `LAUNCH_DECISIONS.md`. How checkout works:
`CHECKOUT_SETUP.md`.

## Before anything: deploy the latest code

1. Commit and push to `main`.
2. Cloudflare, Workers and Pages, `podav3`, Deployments: wait for the newest
   deploy to show success.

## Part 1. Finish testing in the sandbox

Stay in the Stripe sandbox for this part. Open the site with `?checkout_test=1`.

1. In the sandbox, Developers, Webhooks, open your endpoint, then Add events
   and tick `charge.refunded` and `charge.dispute.created`. Save.
2. Buy a piece with card `4242 4242 4242 4242`, any future date, any CVC.
3. Check the piece reads **Sold**, Admin, Supply, Orders shows it, and you got
   the **Sold:** email. If the seller has a contact email, check they got
   **Your piece sold**. Check the buyer inbox got **Your poda order**.
4. In Orders, press **Mark shipped…**, pick a carrier, type any tracking number
   and press **Mark shipped and email buyer**. Check the buyer got the email.
5. Buy a second piece and press **Refund buyer in Stripe** on it. Confirm the
   order reads Refunded, Stripe shows the refund and the buyer address gets
   **Your poda order was refunded**. You get no email for this one.
6. Buy a third piece and refund it from the Stripe dashboard instead. Within a
   few seconds the order should read Refunded, the buyer gets **Your poda order
   was refunded** and you get a **Refunded:** email.
7. Test the hold: press Buy, leave the panel open, and look at the same piece
   in a second browser. It reads **Held**. Close the panel and it frees up.
8. Test a dispute: pay with card `4000 0000 0000 0259`. After a minute Stripe
   opens a dispute and you get a **Dispute opened:** email.

Anything that fails: Stripe, Developers, Webhooks, your endpoint, Recent
deliveries shows what the site answered.

## Part 2. Decide the open items

These need your answer. Ask Claude to apply any change.

- **Shipping fee.** `SHIPPING_FLAT_CENTS` in `wrangler.toml` is still `"1500"`,
  which is $15.00.
- **Who ships.** The code assumes the seller ships and is emailed the buyer's
  address. If poda ships instead, set `NOTIFY_SELLERS = "false"`.
- **Return shipping.** Who pays when a piece is not as described.
- **Sales tax.** Ask an accountant before taxable sales. Off for now.
- **Make sure every seller has a contact email** on their record in Admin,
  Supply, Sellers. Without one they are not told their piece sold.
- **Legal pages.** Have a lawyer read `terms.html` and `privacy.html`, and add
  your business name and address to both.
- **Resend plan.** The free plan sends 100 emails a day, shared by every email
  poda sends. Move to Pro before a drop to many subscribers.

## Part 3. Switch Stripe to live

1. Stripe dashboard, leave the sandbox and open the live account. Finish
   **account activation**: business details, identity check, bank account for
   payouts. Stripe may take a day or two to approve it.
2. Settings, Public details: statement descriptor `PODA`, support email
   `twopoda@gmail.com`.
3. Settings, Branding: add the poda logo and colors.
4. Settings, Customer emails: turn on **Successful payments** and **Refunds**.
5. Developers, API keys, live mode: copy the **Secret key** `sk_live_`.
6. Cloudflare, `podav3`, Settings, Variables and Secrets: edit
   `STRIPE_SECRET_KEY`, paste the live key, save.
7. Copy the **Publishable key** `pk_live_` and tell Claude, or replace the
   `STRIPE_PUBLISHABLE_KEY` value in `wrangler.toml` yourself.
8. Developers, Webhooks, live mode, Add endpoint:
   `https://podapodapoda.co/api/stripe-webhook`. Select all five events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
9. Open the new endpoint and copy its **Signing secret** `whsec_`. In
   Cloudflare, edit `STRIPE_WEBHOOK_SECRET` and paste it. It differs from the
   sandbox one.
10. Deploy so the changes take effect.

The publishable key and the secret key must both be live. A mix of live and
sandbox keys makes the payment form fail.

## Part 4. The first real payment

1. Open the site with `?checkout_test=1` and buy your cheapest real piece with
   your own card. Check every step from Part 1, items 3 and 4.
2. In Orders, press **Refund buyer in Stripe**. Check the money returns to your
   card and the order reads Refunded.
3. In `supabase-config.js`, change `window.PODA_CHECKOUT_ENABLED` from `false`
   to `true`. Commit, push and wait for the deploy. Buy buttons now show to
   everyone.
4. To close checkout at any time, set it back to `false` and deploy.

## After launch

- Pay sellers yourself, then record it in Admin, Supply, Payouts. A seller is
  ready to pay 7 days after the piece ships.
- Each morning you get an email if a paid order is not shipped after 3 days.
- A dispute email gives you a deadline. Answer in Stripe before it.
- Keep Resend under its daily limit on drop days.
