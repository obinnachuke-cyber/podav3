/* ============================================================
   finance.js — the money rules behind Admin, Supply, Payouts.

   Pure functions: they take the orders (and payouts) the admin already
   loaded and return numbers. Nothing here reads the page, the network or the
   clock except through arguments, so every rule can be tested on its own.
   All amounts are whole cents.

   The rules, in one place:
   - A SALE is an order that is paid and not waiting for a refund. Sales are
     counted by the date they were paid.
   - Gross is the price of the pieces. Shipping and tax are collected on top.
   - Tax is a pass-through, never poda's revenue. It is whatever the order
     total holds beyond the price and shipping.
   - poda keeps the commission on a consigned piece, and the whole price on
     its own piece. Shipping collected is poda's too.
   - Stripe's fee comes out of poda's share. Sellers are never charged it.
   - Net = what poda keeps + shipping collected - Stripe fees recorded.
     Real shipping costs are not tracked, so they are not subtracted.
   - A refunded order stops being a sale. It is listed on its own line.
   - A seller is owed the seller share of each unpaid sale. It is READY to pay
     once the order shipped and the return window has passed, IN THE WINDOW
     while that wait runs, and NOT SHIPPED until it goes out.
   - A refund after the seller was paid is money to recover from them.
   ============================================================ */
(function (root) {
  "use strict";

  const DAY_MS = 86400000;
  const cents = value => Math.round(Number(value) || 0);
  const time = iso => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : NaN; };

  const isSale = o => o.status === "paid" && !o.conflict;
  const isOwnPiece = o => o.payout_status === "none";   // poda's own piece: no seller to pay

  function inRange(iso, from, to) {
    const t = time(iso);
    if (!Number.isFinite(t)) return false;
    return (from == null || t >= from) && (to == null || t < to);
  }

  // What the buyer paid beyond the price and shipping.
  function taxCents(o) {
    if (!isSale(o) || o.amount_total_cents == null) return 0;
    return Math.max(0, cents(o.amount_total_cents) - cents(o.price_cents) - cents(o.shipping_cents));
  }

  // What poda keeps from the price.
  function keptCents(o) {
    return isOwnPiece(o) ? cents(o.price_cents) : cents(o.commission_cents);
  }

  // Totals for the sales paid inside [from, to). Pass null to leave an end open.
  function summarize(orders, range) {
    const { from = null, to = null } = range || {};
    const s = {
      sales: 0, gross: 0, shipping: 0, tax: 0, kept: 0, sellerShare: 0,
      fees: 0, feesRecorded: 0, net: 0,
      refundedCount: 0, refundedCents: 0, awaitingRefund: 0, paidOut: 0
    };
    for (const o of orders) {
      if (isSale(o) && inRange(o.paid_at, from, to)) {
        s.sales++;
        s.gross += cents(o.price_cents);
        s.shipping += cents(o.shipping_cents);
        s.tax += taxCents(o);
        s.kept += keptCents(o);
        if (!isOwnPiece(o)) s.sellerShare += cents(o.seller_payout_cents);
        if (o.stripe_fee_cents != null) { s.fees += cents(o.stripe_fee_cents); s.feesRecorded++; }
      }
      if (o.status === "refunded" && inRange(o.refunded_at || o.paid_at, from, to)) {
        s.refundedCount++;
        s.refundedCents += cents(o.price_cents) + cents(o.shipping_cents);
      }
      if (o.status === "paid" && o.conflict && inRange(o.paid_at, from, to)) s.awaitingRefund++;
      // Money sent to sellers inside the range, however it was recorded.
      if (!isOwnPiece(o) && o.payout_status === "paid" && (o.status === "paid" || o.status === "refunded")
          && inRange(o.payout_paid_at, from, to)) {
        s.paidOut += cents(o.seller_payout_cents);
      }
    }
    s.net = s.kept + s.shipping - s.fees;
    return s;
  }

  // Where an unpaid sale stands: ready, in the return window, or not shipped.
  // Returns null for anything that is not an unpaid sale owed to a seller.
  function payoutState(o, holdDays, now) {
    if (!isSale(o) || o.payout_status !== "unpaid") return null;
    if (!o.shipped_at) return { state: "not_shipped", eligibleAt: null };
    const eligibleAt = time(o.shipped_at) + (Number(holdDays) || 0) * DAY_MS;
    return { state: now >= eligibleAt ? "ready" : "window", eligibleAt };
  }

  const emptyBucket = () => ({ cents: 0, orders: [] });

  // One entry per seller: what is owed in each state, what has been paid, and
  // anything refunded after they were paid.
  function balances(orders, options) {
    const { holdDays = 7, now = Date.now() } = options || {};
    const bySeller = new Map();
    const row = o => {
      const id = o.supplier_id;
      if (!bySeller.has(id)) {
        bySeller.set(id, {
          supplierId: id,
          name: (o.suppliers && o.suppliers.name) || "Unknown seller",
          sales: 0, gross: 0, kept: 0,
          ready: emptyBucket(), window: emptyBucket(), notShipped: emptyBucket(),
          paid: 0, clawback: emptyBucket()
        });
      }
      return bySeller.get(id);
    };

    for (const o of orders) {
      if (isOwnPiece(o)) continue;                       // nothing is owed on poda's own pieces
      if (isSale(o)) {
        const r = row(o);
        r.sales++;
        r.gross += cents(o.price_cents);
        r.kept += cents(o.commission_cents);
        if (o.payout_status === "paid") r.paid += cents(o.seller_payout_cents);
        const st = payoutState(o, holdDays, now);
        if (st) {
          const bucket = st.state === "ready" ? r.ready : st.state === "window" ? r.window : r.notShipped;
          bucket.cents += cents(o.seller_payout_cents);
          bucket.orders.push(o);
        }
      } else if (o.status === "refunded" && o.payout_status === "paid") {
        const r = row(o);
        r.clawback.cents += cents(o.seller_payout_cents);
        r.clawback.orders.push(o);
      }
    }
    return Array.from(bySeller.values()).sort((a, b) =>
      (b.ready.cents - a.ready.cents) || a.name.localeCompare(b.name));
  }

  // Everyone's totals, for the cards at the top.
  function totalsOwed(list) {
    const t = { ready: 0, window: 0, notShipped: 0, clawback: 0, paid: 0 };
    for (const r of list) {
      t.ready += r.ready.cents; t.window += r.window.cents; t.notShipped += r.notShipped.cents;
      t.clawback += r.clawback.cents; t.paid += r.paid;
    }
    return t;
  }

  // The window of time a named range covers, in the browser's own timezone.
  function rangeFor(key, now) {
    const d = new Date(now);
    const monthStart = (y, m) => new Date(y, m, 1).getTime();
    switch (key) {
      case "month": return { from: monthStart(d.getFullYear(), d.getMonth()), to: monthStart(d.getFullYear(), d.getMonth() + 1) };
      case "lastMonth": return { from: monthStart(d.getFullYear(), d.getMonth() - 1), to: monthStart(d.getFullYear(), d.getMonth()) };
      case "last30": return { from: now - 30 * DAY_MS, to: now + 1 };
      default: return { from: null, to: null };
    }
  }

  // Money as a plain number with two decimals, for spreadsheets.
  const dollars = value => (cents(value) / 100).toFixed(2);

  // A spreadsheet will run a cell that starts with = + - or @ as a formula, so
  // text that starts that way is made harmless before it is exported.
  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(header, rows) {
    return [header].concat(rows).map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  const day = iso => (Number.isFinite(time(iso)) ? new Date(time(iso)).toISOString().slice(0, 10) : "");

  function salesCsv(orders) {
    const header = ["Paid", "Order", "Piece", "Seller", "Price", "Shipping", "Tax", "Total paid", "poda keeps",
      "Seller share", "Stripe fee", "Status", "Shipped", "Payout", "Payout date"];
    const rows = orders
      .filter(o => o.status === "paid" || o.status === "refunded")
      .sort((a, b) => (time(a.paid_at) || 0) - (time(b.paid_at) || 0))
      .map(o => [
        day(o.paid_at), o.id, [o.brand, o.title].filter(Boolean).join(" "), (o.suppliers && o.suppliers.name) || "",
        dollars(o.price_cents), dollars(o.shipping_cents), dollars(isSale(o) ? taxCents(o) : 0),
        o.amount_total_cents == null ? "" : dollars(o.amount_total_cents),
        dollars(keptCents(o)), isOwnPiece(o) ? "" : dollars(o.seller_payout_cents),
        o.stripe_fee_cents == null ? "" : dollars(o.stripe_fee_cents),
        o.status === "paid" && o.conflict ? "refund needed" : o.status,
        day(o.shipped_at), o.payout_status, day(o.payout_paid_at)
      ]);
    return toCsv(header, rows);
  }

  function payoutsCsv(payouts, nameOf) {
    const header = ["Date", "Payout", "Seller", "Amount", "Method", "Reference", "Note", "Voided"];
    const rows = payouts
      .slice().sort((a, b) => (time(a.paid_at) || 0) - (time(b.paid_at) || 0))
      .map(p => [day(p.paid_at), p.id, nameOf(p.supplier_id), dollars(p.amount_cents), p.method || "", p.reference || "", p.note || "", day(p.voided_at)]);
    return toCsv(header, rows);
  }

  const api = {
    DAY_MS, isSale, isOwnPiece, inRange, taxCents, keptCents, summarize, payoutState, balances, totalsOwed,
    rangeFor, dollars, csvCell, toCsv, salesCsv, payoutsCsv
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PodaFinance = api;
})(typeof window !== "undefined" ? window : globalThis);
