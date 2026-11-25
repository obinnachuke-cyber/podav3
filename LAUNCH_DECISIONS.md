# Launch decisions

The answers to `LAUNCH_QUESTIONS.md`. Claude picked each one from what the
site already does and the safest default. Change any answer by editing it here
and asking Claude to apply it. Rows marked **You** cannot be decided from the
code: only you know them.

## A. Stripe account and money in

| # | Decision | Status |
|---|---|---|
| A1 | Account activation is still to do. Steps are in `GO_LIVE.md`. | You |
| A2 | Business type. Stripe asks during activation. Pick what matches your tax filing. | You |
| A3 | Card statement name `PODA`, set in Stripe, Settings, Public details. | You, in Stripe |
| A4 | Receipt contact is `twopoda@gmail.com`, set in the same place. | You, in Stripe |
| A5 | Cards, Apple Pay and Google Pay only. No buy now pay later. | Decided |
| A6 | No order value limit. Stripe Radar screens payments. | Decided |

## B. Shipping

| # | Decision | Status |
|---|---|---|
| B1 | Sellers ship directly to buyers within 3 business days and send tracking. poda holds no inventory. `NOTIFY_SELLERS = "true"`. | Decided, built |
| B2 | Flat $7.00 per order for now. Per-seller shipping comes later, with carts. | Decided |
| B3 | One flat fee for everything. | Decided |
| B4 | US only. | Decided |
| B5 | The seller replies with tracking, you enter it in Orders, the buyer is emailed. A daily email lists orders not shipped after 3 days. | Built |
| B6 | No shipping time is promised anywhere. | Built |

## C. Sales tax

| # | Decision | Status |
|---|---|---|
| C1 | Your state and accountant. | You |
| C2 | Tax stays off. First find where poda must register and collect, with an accountant, then set up Stripe Tax for those states only and set `STRIPE_TAX_ENABLED = "true"`. The code is ready. Flag for accountant review before launch. | You |

## D. Seller payouts

| # | Decision | Status |
|---|---|---|
| D1 | Target: Stripe Connect, separate charges and transfers, with a manual approval step before each transfer. Not built. Until then payouts stay manual: you send the money, then record it in Supply, Payouts. | Decided, not built |
| D2 | A seller is ready to pay 3 days after delivery, with no issue raised. You press Mark delivered in Orders. Sellers are told this in their sale email. | Built |
| D3 | Sellers get an email on each sale with their share. A sales tab in the closet is not built. | Built, tab not built |
| D4 | Stripe's fee comes out of poda's share, never the seller's. | Decided |
| D5 | Commission stays per seller in the admin. poda's own pieces have no seller share. | Decided |

## E. Returns, refunds and disputes

| # | Decision | Status |
|---|---|---|
| E1 | Final sale, except a piece materially not as described, damaged by poor packaging or the wrong piece, reported within 7 days of delivery. No buyer's remorse returns, subject to applicable law. | Built |
| E2 | The seller pays return shipping on an accepted return. poda manages the refund. | Built |
| E3 | **Refund buyer in Stripe** button on every paid order. Full refund, order marked, seller share reversed in Payouts. | Built |
| E4 | A dispute emails you the deadline, amount, order and a Stripe link. | Built |
| E5 | A refunded piece stays off the shop. Restock it by hand in the admin if it comes back. | Decided |

## F. Buyer experience

| # | Decision | Status |
|---|---|---|
| F1 | Target: multi-item, multi-seller carts in one checkout, with orders from several sellers flagged for manual shipping review. Not built: one piece per payment today. | Decided, not built |
| F2 | Guest checkout only. | Decided |
| F3 | No promo codes. | Decided |
| F4 | No phone number collected. | Decided |
| F5 | Emails keep their wording, minus the shipping time. | Done |
| F6 | The thank you page stays as is. It already says to expect the confirmation and tracking emails. | Decided |

## G. Pieces and inventory

| # | Decision | Status |
|---|---|---|
| G1 | Every piece is one of a kind, quantity one. | Decided |
| G2 | The hold stays at 30 minutes, Stripe's minimum. | Decided |
| G3 | Buy shows on the pieces the Shop lists. Turning checkout on makes them buyable at once. | Decided |

## H. Launch

| # | Decision | Status |
|---|---|---|
| H1 | Launch date and what it is for. | You |
| H2 | You buy one real piece with your own card, then refund it, before anyone else. Steps in `GO_LIVE.md`. | You |
| H3 | One switch, `PODA_CHECKOUT_ENABLED`, for all Buy buttons. Buy shows on any piece still marked available, so a piece left unsold in an archived folder stays buyable. Mark pieces unavailable or archive the release to close them. Tying Buy to the live folder only is not built. | Decided, tell Claude if you want it |
| H4 | The drop email stays manual. | Decided |
| H5 | The free Resend plan sends 100 emails a day. Orders, seller emails, alerts and the drop email all share it. Move to Pro before a big drop. | You |

## I. Legal and trust

| # | Decision | Status |
|---|---|---|
| I1 | `terms.html` and `privacy.html` are drafts, linked in the footer. Have a lawyer read them before launch. | Drafted, you review |
| I2 | Your business name and address are missing from both pages. poda has not invented them. Send them and Claude adds them. | You |
| I3 | Detail view now says payments are by Stripe and poda never sees the card. | Done |

## J. Alerts and records

| # | Decision | Status |
|---|---|---|
| J1 | Email alerts only, to `ADMIN_EMAIL`. | Decided |
| J2 | The Payouts tab already exports a CSV for any period. | Done |
| J3 | Nothing else. | Decided |
