# Taking real payments: questions to answer

Answered by Claude in `LAUNCH_DECISIONS.md`. What you still have to do is in
`GO_LIVE.md`. This file stays as the original list.

How to use this: fill in every `Answer:` line, or leave it blank to accept the
default shown, then paste the whole file back to Claude in this project.
Claude then builds whatever each answer needs, tells you what only you can do
in Stripe, Cloudflare or Supabase, and lists what is left.

## Instructions for Claude

Read these first: `CHECKOUT_SETUP.md`, the checkout section of `_worker.js`
starting at "Checkout, Stripe Checkout", `folders.js` from "Buy", `finance.js`,
the Orders and Payouts parts of `admin.js`, and `policies.html`.

Current state, do not rebuild it: one piece per payment, 30 minute hold, Stripe
Embedded Checkout in a panel, webhook marks the sale, flat US shipping fee,
sandbox tested end to end, seller payouts recorded by hand, sales tax off,
`PODA_CHECKOUT_ENABLED` is false. Test purchase in the sandbox worked.

For each answer below: make the code, copy, policy and docs changes it needs,
test them with mocks the way the earlier checkout tests were done, and show what
changed before any major change. Group the work into commits the user can push.
Anything that has to happen in a dashboard goes into a short numbered list for
the user, one step at a time. Never ask for or store secret keys. Keep poda
lowercase, no parentheses in prose, no hedge words, concise.

---

## A. Stripe account and money in

**A1. Is the Stripe account activated for live payments?**
Business details, identity check and bank account all done and Stripe says
"you can accept live payments".
Default: not yet, Claude walks through activation.
Answer:

**A2. Business type on the Stripe account.**
Individual or sole proprietor, LLC, or corporation. Drives the tax form Stripe
issues and the name on card statements.
Answer:

**A3. What should appear on a buyer's card statement?**
Max 22 characters. Default: `PODA`.
Answer:

**A4. Support email and phone shown on Stripe receipts and the payment panel.**
Default: `twopoda@gmail.com`, no phone.
Answer:

**A5. Which payment methods should buyers see?**
Cards, Apple Pay and Google Pay are on by default. Add buy now pay later such as
Klarna or Afterpay? It raises conversion on high prices, costs a higher fee and
reverses on returns. Default: cards, Apple Pay and Google Pay only.
Answer:

**A6. Maximum order value you are comfortable taking with no manual review.**
Claude can hold orders over this amount for your review before you ship.
Default: no limit, rely on Stripe Radar.
Answer:

## B. Shipping

**B1. Who ships a sold piece, poda or the seller?**
`/how-it-works` tells sellers they handle shipment. Buyers are told nothing about
timing now. Whichever you pick, Claude aligns the copy, the admin order screen
and the emails to it.
Answer:

**B2. Flat US shipping fee in dollars.** It is `$15.00` now as a placeholder.
Answer:

**B3. Different fee by price or weight, or free shipping over a threshold?**
Default: one flat fee for everything.
Answer:

**B4. Ship outside the US?**
Default: US only. If yes, list countries and fees.
Answer:

**B5. Who buys the label and which carriers?**
The admin already records carrier and tracking. Claude can add a ship by
reminder in the admin for sold pieces older than N days. Pick N or none.
Answer:

**B6. Do you want to promise any shipping time to buyers?**
Default: no, nothing is promised, tracking email only.
Answer:

## C. Sales tax

**C1. Which state is the business based in, and do you have an accountant?**
Answer:

**C2. Collect sales tax at checkout?**
Options: no for now, or yes with Stripe Tax. Yes needs Stripe Tax set up in the
dashboard, your tax registrations entered, and `STRIPE_TAX_ENABLED` set to true.
Default: no for now, revisit with the accountant.
Answer:

## D. Seller payouts

**D1. How is each seller paid?**
Options: bank transfer by hand, Zelle, PayPal, or Stripe Connect for automatic
payouts. Connect needs each seller onboarded to Stripe, adds identity checks and
a rebuild of the payout flow. Default: by hand, as the admin does now.
Answer:

**D2. Payout timing.** Now: seller is owed 7 days after the piece ships.
Keep 7 days, or change it?
Answer:

**D3. Should sellers see their sales and what they are owed?**
Options: nothing yet, a simple Sales and Payouts tab in their closet, or an
email each time a piece sells. Default: an email on each sale and a read only
tab in their closet.
Answer:

**D4. Who pays Stripe's fee?** Now it comes out of poda's share, never the
seller's. Keep?
Answer:

**D5. Commission.** Each seller has their own percentage in the admin. Confirm
that is still the model, and say what a poda owned piece should do.
Answer:

## E. Returns, refunds and disputes

**E1. Confirm the policy in `policies.html`.**
All sales final, except a piece not as described, reported within 7 days of
delivery, refunded in full with original shipping. Change anything.
Answer:

**E2. Who pays return shipping when a piece is not as described?**
Answer:

**E3. Refunds today are two steps: refund in Stripe, then mark refunded in the
admin. Want a Refund button in the admin that does both?**
It would call Stripe from the worker and also reverse the seller's share.
Default: yes.
Answer:

**E4. If a buyer disputes a charge with their bank, who handles it and where
should you be alerted?**
Claude can email you on `charge.dispute.created` with the order and seller.
Default: email `ADMIN_EMAIL`.
Answer:

**E5. Seller returns.** If a refunded piece comes back, does it go back for
sale as the same piece, back to the seller, or stay out of the shop?
Answer:

## F. Buyer experience

**F1. One piece per purchase is built. Do you need a cart for several pieces in
one payment?** A cart means one shipping fee per order, holds on every piece and
more webhook logic. Default: no, keep one piece at a time.
Answer:

**F2. Guest checkout only, or should buyers have accounts to see past orders?**
Default: guest only, plus an order lookup link inside the confirmation email.
Answer:

**F3. Promo or discount codes?** Default: none.
Answer:

**F4. Collect a phone number at checkout for the carrier?** Default: no.
Answer:

**F5. Order confirmation and shipped email wording.**
Paste any lines you want changed. Default: keep them, no shipping time promised.
Answer:

**F6. Should the thank you page do anything more?**
Examples: show the order summary, ask them to subscribe, link back to the Shop.
Default: show a short summary and a Shop link.
Answer:

## G. Pieces and inventory

**G1. Are all pieces one of a kind?**
The hold and sale logic assume quantity one. If a piece can have stock above one,
say so, because that is a different build.
Answer:

**G2. Is a 30 minute hold right?** Stripe will not go shorter than 30.
Default: keep 30.
Answer:

**G3. What happens to pieces already inside a live release when Buy turns on?**
Default: they become buyable immediately.
Answer:

## H. Launch

**H1. Target date to take the first real payment, and what is it for?**
A drop, a soft launch to subscribers, or a private first sale.
Answer:

**H2. Who is the first real buyer?** Claude suggests you buy one real piece with
your own card, then refund it, before anyone else. OK?
Answer:

**H3. Show Buy to everyone, or only while a release is live?**
Today one switch controls all Buy buttons. Claude can tie Buy to a live release
so it turns off between drops. Default: tie it to a live release.
Answer:

**H4. Email subscribers when Buy turns on?**
The drop email exists. Default: send the drop email manually as planned.
Answer:

**H5. Resend plan.** The free plan allows 100 emails a day, shared by drop
emails, order emails and alerts. What plan are you on, and how many
subscribers?
Answer:

## I. Legal and trust

**I1. Terms of service and privacy policy.**
`policies.html` covers shipping, returns and payments. Do you have terms and a
privacy policy written, or should Claude draft pages for you to have a lawyer
check? Default: Claude drafts, you have them reviewed.
Answer:

**I2. Business name and address to show in the footer and on receipts.**
Answer:

**I3. Do you want a short payments note near Buy?**
Example: "Payments by Stripe. poda never sees your card number." Default: yes.
Answer:

## J. Alerts and records

**J1. How should you be told about a sale?**
Now: an email to `ADMIN_EMAIL`. Add a text or push alert? Default: email only.
Answer:

**J2. Accounting.** Want a monthly export of orders, fees, refunds and payouts
as a spreadsheet for your accountant? The Payouts tab already exports a CSV.
Default: use that, add a date range filter.
Answer:

**J3. Any other payment worry or feature not listed here?**
Answer:

---

## What Claude builds from these answers

| Answer | Builds |
|---|---|
| B1 to B6 | shipping fee, ship by reminders, copy and email changes, fee table |
| C2 yes | tax setup steps, `STRIPE_TAX_ENABLED`, tax line in receipts |
| D1 Connect | seller onboarding and automatic payouts, a large separate build |
| D3 | sale emails to sellers, a Sales tab in their closet |
| E3 yes | Refund button, Stripe refund call, reversal of the seller share |
| E4 | dispute webhook and alert |
| F1 yes | cart, multi piece holds, one order for several pieces |
| H3 | Buy enabled only while a release is live |
| I1 | draft terms and privacy pages |

After the build Claude lists the dashboard steps for you: Stripe activation,
live keys, live webhook, then the final real test purchase and refund.
