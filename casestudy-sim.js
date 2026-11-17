/* ============================================================
   casestudy-sim.js: the commission and payout simulator (Stage 4).

   Demo state only. Nothing here talks to Stripe, Supabase or the Worker,
   and no figure on this page is a Poda result.

   What is real here:
   - commission is round(price * rate / 10000), the rule in
     create_order_hold() in migrations/20261111_checkout.sql;
   - the rate and the split are frozen on the order when it is placed;
   - eligibility, supplier balances and money to recover come from
     finance.js, the same file the admin Payouts view runs.
   What is illustrative: the "payout pending" step, which the live system
   does not store, and the multi-item checkout, which is not built yet.
   ============================================================ */
(function () {
  "use strict";
  const C = window.PodaCase;
  const { money, pct, esc, $, $$, dayLabel, glyph, S, DAY, HOLD_DAYS } = C;
  const F = window.PodaFinance;

  const LINES = [
    { key: "A", itemId: "PD-1042", supplierId: "alder",     title: "Leather Jacket",   glyph: "jacket", price: 40000 },
    { key: "B", itemId: "PD-1043", supplierId: "northline", title: "Vintage Knitwear", glyph: "knit",   price: 25000 }
  ];
  const FEE_PCT = 0.029, FEE_FIXED = 30;   // assumption for the optional fee view
  const STEPS = [
    { name: "Order placed",       tag: "built",   text: "The buyer clicks Buy. The piece is held for 30 minutes and the rate is frozen on the order." },
    { name: "Payment confirmed",  tag: "built",   text: "Stripe confirms the payment. The webhook marks the order paid and lowers the piece's quantity." },
    { name: "Order fulfilled",    tag: "built",   text: "Poda records the shipment with carrier and tracking. The buyer is emailed." },
    { name: "Settlement eligible", tag: "built",  text: "Seven days after shipment, the same window a buyer has to report a piece not as described. Computed from the ship date, not stored." },
    { name: "Payout pending",     tag: "demo",    text: "A payout is prepared. The live admin has no stored pending state: a payout is recorded once the money has been sent." },
    { name: "Payout completed",   tag: "built",   text: "Poda sends the money outside the system, then records the payout with method and reference. The orders it covers become paid." }
  ];

  let sim;
  function reset() {
    sim = { placed: false, orders: [], prices: { A: LINES[0].price, B: LINES[1].price }, clockDays: 0, payouts: [], fee: false, flow: "", notice: "" };
  }
  const get = () => sim;
  const simNow = () => C.TODAY + sim.clockDays * DAY;
  const iso = ms => new Date(ms).toISOString();

  const lines = () => LINES.map(l => Object.assign({}, l, { price: sim.prices[l.key] }));

  // An order in the same shape as a row of public.orders, so finance.js can read it.
  function buildOrder(l, bps) {
    const commission = C.commissionCents(l.price, bps);
    const sup = C.supplierById(l.supplierId);
    return {
      id: `ORD-2041-${l.key}`, key: l.key, supplier_id: l.supplierId, suppliers: { name: sup.name },
      title: l.title, brand: null, price_cents: l.price, currency: "USD",
      commission_bps: bps, commission_cents: commission, seller_payout_cents: l.price - commission,
      status: "draft", conflict: false, shipping_cents: 0, amount_total_cents: null,
      payout_status: "unpaid", payout_paid_at: null, payout_id: null,
      paid_at: null, shipped_at: null, refunded_at: null, prepared: false, early: false
    };
  }
  const draftOrders = () => lines().map(l => buildOrder(l, C.supplierById(l.supplierId).bps));
  const orders = () => (sim.placed ? sim.orders : draftOrders());

  /* —— Actions —— */
  function place() {
    if (sim.placed) return;
    sim.orders = draftOrders().map(o => Object.assign(o, { status: "pending" }));
    sim.placed = true;
  }
  function confirmPayment() {
    sim.orders.filter(o => o.status === "pending").forEach(o => {
      o.status = "paid"; o.paid_at = iso(simNow()); o.amount_total_cents = o.price_cents;
      const item = C.itemById(LINES.find(l => l.key === o.key).itemId);
      if (item) { item.st = "sold"; item.events.push([0, "Sold"]); }
    });
  }
  const orderOf = key => sim.orders.find(o => o.key === key);
  function ship(key) { const o = orderOf(key); if (o && o.status === "paid" && !o.shipped_at) o.shipped_at = iso(simNow()); }
  function skipToEligible(key) {
    const o = orderOf(key);
    if (!o || !o.shipped_at) return;
    const target = Math.ceil((Date.parse(o.shipped_at) + HOLD_DAYS * DAY - C.TODAY) / DAY);
    sim.clockDays = Math.max(sim.clockDays, target);
  }
  function prepare(key) {
    const o = orderOf(key);
    if (!o) return;
    const st = F.payoutState(o, HOLD_DAYS, simNow());
    o.prepared = true;
    o.early = !!(st && st.state !== "ready");
  }
  // Mirrors create_payout(): every order must be this supplier's, paid, not
  // refunded and not already paid out. One payout covers the whole batch.
  function recordPayout(supplierId) {
    const batch = sim.orders.filter(o => o.supplier_id === supplierId && o.prepared && F.isSale(o) && o.payout_status === "unpaid");
    if (!batch.length) return;
    const amount = batch.reduce((n, o) => n + o.seller_payout_cents, 0);
    const p = {
      id: `PAY-${String(sim.payouts.length + 1).padStart(3, "0")}`, supplier_id: supplierId, supplier: C.supplierById(supplierId).name,
      amount_cents: amount, method: "Bank transfer, demo", reference: `DEMO-${(1000 + sim.payouts.length * 37)}`,
      paid_at: iso(simNow()), voided_at: null, orders: batch.map(o => o.id)
    };
    sim.payouts.push(p);
    batch.forEach(o => { o.payout_status = "paid"; o.payout_paid_at = p.paid_at; o.payout_id = p.id; o.prepared = false; });
  }
  // Mirrors void_payout(): the orders go back to unpaid, the record stays.
  function voidPayout(id) {
    const p = sim.payouts.find(x => x.id === id);
    if (!p || p.voided_at) return;
    p.voided_at = iso(simNow());
    sim.orders.filter(o => o.payout_id === id).forEach(o => { o.payout_status = "unpaid"; o.payout_paid_at = null; o.payout_id = null; });
  }
  // Mirrors "Record refund" in admin: status refunded, date set. Nothing else moves.
  function refund(key) {
    const o = orderOf(key);
    if (!o || o.status !== "paid") return;
    o.status = "refunded"; o.refunded_at = iso(simNow()); o.prepared = false;
  }
  function runScenario(kind) {
    C.reset();
    place(); confirmPayment(); ship("A");
    if (kind === "after") { skipToEligible("A"); prepare("A"); recordPayout("alder"); }
    sim.clockDays += 1;
    refund("A");
    sim.notice = kind === "after"
      ? "Alder Closet was paid before the refund, so the payout is now money to recover."
      : "The jacket was refunded before any payout, so nothing is owed to Alder Closet.";
    C.render();
    const t = $("#simExceptions"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* —— Derived values —— */
  function stageOf(o) {
    if (o.status === "draft") return -1;
    if (o.status === "refunded") return "refunded";
    if (o.status === "pending") return 0;
    if (o.payout_status === "paid") return 5;
    if (o.prepared) return 4;
    if (!o.shipped_at) return 1;
    const st = F.payoutState(o, HOLD_DAYS, simNow());
    return st && st.state === "ready" ? 3 : 2;
  }

  function eligibility(o) {
    if (o.status === "draft") return "Not placed";
    if (o.status === "pending") return "Awaiting payment";
    if (o.status === "refunded") return o.payout_status === "paid" ? `Recover ${money(o.seller_payout_cents)}` : "None, refunded";
    if (o.payout_status === "paid") return "Settled";
    const st = F.payoutState(o, HOLD_DAYS, simNow());
    if (!st) return "None";
    if (st.state === "not_shipped") return "Not shipped";
    if (st.state === "window") return `Return window to ${dayLabel(st.eligibleAt)}`;
    return "Ready";
  }
  function payoutStatus(o) {
    if (o.status === "draft" || o.status === "pending") return "Unpaid";
    if (o.status === "refunded") return o.payout_status === "paid" ? "To recover" : "None";
    if (o.payout_status === "paid") return "Paid";
    return o.prepared ? "Prepared, demo state" : "Unpaid";
  }

  function totals() {
    const all = orders();
    const live = all.filter(o => o.status !== "refunded");
    const sum = (list, k) => list.reduce((n, o) => n + o[k], 0);
    const merchAll = sum(all, "price_cents");
    const merch = sum(live, "price_cents");
    const comm = sum(live, "commission_cents");
    const share = sum(live, "seller_payout_cents");
    const refunded = merchAll - merch;
    const shipping = C.SHIPPING_CENTS;
    const fee = Math.round((merchAll + shipping) * FEE_PCT) + FEE_FIXED;
    const net = comm + shipping - (sim.fee ? fee : 0);
    return { all, live, merchAll, merch, comm, share, refunded, shipping, fee, net, paid: merchAll + shipping };
  }

  /* ============================================================
     Rendering
     ============================================================ */
  const tag = (kind, text) => `<span class="cs-tag cs-tag--${kind}">${esc(text)}</span>`;

  function controlsHTML() {
    return lines().map(l => {
      const sup = C.supplierById(l.supplierId);
      const bps = sup.bps;
      const locked = sim.placed;
      return `
        <div class="cs-term">
          <div class="cs-term__head">
            <span class="cs-term__key">Supplier ${l.key}</span>
            <span class="cs-term__cat">${esc(C.CATEGORIES[sup.cat].label)}</span>
          </div>
          <h4>${esc(sup.name)}</h4>
          <p class="cs-note">${esc(l.title)}</p>
          <label class="cs-field">Sale price
            <span class="cs-money-input"><i>$</i><input type="number" min="1" step="5" value="${l.price / 100}" data-sim-price="${l.key}"${locked ? " disabled" : ""} /></span>
          </label>
          <label class="cs-field">Commission rate: <b data-sim-ratelabel="${l.key}">${pct(bps)}</b>
            <input type="range" min="0" max="5000" step="50" value="${Math.min(bps, 5000)}" data-sim-rate="${l.key}" aria-label="Commission rate for ${esc(sup.name)}" />
          </label>
          <div class="cs-ticks"><span>0%</span><span>25%</span><span>50%</span></div>
        </div>`;
    }).join("");
  }

  function statsHTML(t) {
    const blended = t.merch ? (t.comm / t.merch) * 100 : 0;
    return `
      <div class="cs-stats">
        <div class="cs-stat"><span class="cs-stat__label">Total merchandise value</span><b>${money(t.merch)}</b><span class="cs-stat__sub">${t.live.length} of ${t.all.length} pieces${t.refunded ? `, ${money(t.refunded)} refunded` : ""}</span></div>
        <div class="cs-stat cs-stat--accent"><span class="cs-stat__label">Total Poda commission</span><b>${money(t.comm)}</b><span class="cs-stat__sub">Blended rate ${blended.toFixed(1)}%</span></div>
        <div class="cs-stat"><span class="cs-stat__label">Total supplier earnings</span><b>${money(t.share)}</b><span class="cs-stat__sub">Owed to ${(n => `${n} ${n === 1 ? "supplier" : "suppliers"}`)(new Set(t.live.map(o => o.supplier_id)).size)}</span></div>
      </div>
      <div class="cs-recon">
        <span class="cs-recon__ok" aria-hidden="true">✓</span>
        <span>Reconciles: customer paid ${money(t.paid)}${t.refunded ? `, less ${money(t.refunded)} refunded` : ""}. That equals suppliers ${money(t.share)} plus Poda commission ${money(t.comm)} plus shipping ${money(t.shipping)}.</span>
      </div>
      <label class="cs-check"><input type="checkbox" data-sim-fee${sim.fee ? " checked" : ""} /> Include the card processing fee. Assumed at 2.9% plus $0.30 on one payment: ${money(t.fee)}. Poda bears it, suppliers do not.</label>
      <p class="cs-note">Poda net, commission plus shipping${sim.fee ? " less the fee" : ""}: <b>${money(t.net)}</b>.</p>`;
  }

  /* —— Flow diagram: payment in, allocation out —— */
  function flowHTML(t) {
    const live = t.live;
    if (!live.length) return `<p class="cs-empty">Every piece is refunded, so nothing is allocated.</p>`;
    const box = $("#simFlowHost");
    const W = Math.max(300, Math.floor(box ? box.clientWidth : 720));
    const narrow = W < 560;
    const labelW = narrow ? 84 : 170, nodeW = 10;
    const H = narrow ? 190 : 230, gap = 14;
    const x0 = labelW, x1 = W - labelW - nodeW;
    const left = live.map(o => ({ id: o.key, v: o.price_cents, o })).concat([{ id: "S", v: t.shipping }]).filter(n => n.v > 0);
    const rightIds = live.map(o => ({ id: "s" + o.key, v: o.seller_payout_cents, o })).filter(n => n.v > 0);
    const poda = { id: "P", v: t.comm + t.shipping };
    const right = rightIds.concat(poda.v > 0 ? [poda] : []);
    const total = left.reduce((n, x) => n + x.v, 0);
    const k = (H - gap * (left.length - 1)) / total;
    const kR = (H - gap * (right.length - 1)) / total;
    let y = 0; left.forEach(n => { n.y = y; n.h = n.v * k; y += n.h + gap; });
    y = 0; right.forEach(n => { n.y = y; n.h = n.v * kR; y += n.h + gap; });
    const find = (arr, id) => arr.find(n => n.id === id);
    const out = {}, inn = {};
    const ribbons = [];
    const add = (fromId, toId, v, cls, flowKey, text) => {
      if (v <= 0) return;
      const a = find(left, fromId), b = find(right, toId);
      const ya = a.y + (out[fromId] || 0) * k, yb = b.y + (inn[toId] || 0) * kR;
      out[fromId] = (out[fromId] || 0) + v; inn[toId] = (inn[toId] || 0) + v;
      const ha = v * k, hb = v * kR, xm = (x0 + nodeW + x1) / 2;
      const d = `M${x0 + nodeW} ${ya} C${xm} ${ya},${xm} ${yb},${x1} ${yb} L${x1} ${yb + hb} C${xm} ${yb + hb},${xm} ${ya + ha},${x0 + nodeW} ${ya + ha} Z`;
      ribbons.push(`<path class="cs-ribbon ${cls}" d="${d}" data-flow="${esc(text)}" data-flowkey="${flowKey}" tabindex="0" role="button" aria-label="${esc(text)}" />`);
    };
    live.forEach(o => {
      const supCls = o.key === "A" ? "cs-ribbon--a" : "cs-ribbon--b";
      add(o.key, "s" + o.key, o.seller_payout_cents, supCls, o.key + "s",
        `${o.suppliers.name} receives ${money(o.seller_payout_cents)}: the ${money(o.price_cents)} sale price minus a ${pct(o.commission_bps)} commission of ${money(o.commission_cents)}.`);
    });
    live.forEach(o => add(o.key, "P", o.commission_cents, "cs-ribbon--poda", o.key + "c",
      `Poda keeps ${money(o.commission_cents)} from ${esc(o.title)}: ${pct(o.commission_bps)} of ${money(o.price_cents)}.`));
    add("S", "P", t.shipping, "cs-ribbon--poda", "ship", `Shipping of ${money(t.shipping)} is Poda's. It is collected from the customer and not shared with suppliers.`);

    // A name is split over several lines when the diagram is narrow, so a
    // phone never clips it.
    const wrap = (text, max) => {
      const lines = [];
      let cur = "";
      text.split(" ").forEach(w => {
        if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
        else cur = cur ? cur + " " + w : w;
      });
      if (cur) lines.push(cur);
      return lines;
    };
    const lab = (n, side) => {
      const name = side === "l" ? (n.id === "S" ? "Shipping" : n.o.title) : (n.id === "P" ? "Poda" : n.o.suppliers.name);
      const lines = wrap(name, narrow ? 12 : 30);
      const lh = 13, x = side === "l" ? x0 - 8 : x1 + nodeW + 8;
      const startY = n.y + n.h / 2 - ((lines.length + 1) * lh) / 2 + lh * 0.8;
      const anchor = side === "l" ? "end" : "start";
      const spans = lines.map((l, i) => `<tspan x="${x}" y="${startY + i * lh}">${esc(l)}</tspan>`).join("")
        + `<tspan class="cs-flow__amt" x="${x}" y="${startY + lines.length * lh}">${money(n.v)}</tspan>`;
      return `<text class="cs-flow__label" text-anchor="${anchor}">${spans}</text>`;
    };
    // Room above and below so the first and last labels are not clipped.
    return `<svg class="cs-flow" viewBox="0 0 ${W} ${H + 36}" width="${W}" height="${H + 36}" role="group" aria-label="Allocation of the customer payment">
      <g transform="translate(0,12)">
      ${ribbons.join("")}
      ${left.map(n => `<rect class="cs-flow__node" x="${x0}" y="${n.y}" width="${nodeW}" height="${n.h}" />`).join("")}
      ${right.map(n => `<rect class="cs-flow__node${n.id === "P" ? " cs-flow__node--poda" : ""}" x="${x1}" y="${n.y}" width="${nodeW}" height="${n.h}" />`).join("")}
      ${left.map(n => lab(n, "l")).join("")}${right.map(n => lab(n, "r")).join("")}
      </g>
    </svg>`;
  }

  function attributionHTML(t) {
    return `<div class="cs-attr">${t.all.map(o => {
      const share = o.price_cents ? (o.commission_cents / o.price_cents) * 100 : 0;
      const sup = C.supplierById(o.supplier_id);
      const gone = o.status === "refunded";
      return `
        <div class="cs-attr__card${gone ? " is-refunded" : ""}">
          <div class="cs-attr__head"><b>${esc(o.suppliers.name)}</b><span class="cs-faint">${esc(C.CATEGORIES[sup.cat].label)}</span></div>
          <p class="cs-note">${esc(o.title)}, sold at ${money(o.price_cents)}</p>
          <div class="cs-bar" role="img" aria-label="Poda ${share.toFixed(1)} percent, supplier ${(100 - share).toFixed(1)} percent"><span class="cs-bar__poda" style="width:${share}%"></span><span class="cs-bar__sup" style="width:${100 - share}%"></span></div>
          <div class="cs-attr__nums">
            <span><span><i class="cs-dot cs-dot--poda"></i>Poda at ${pct(o.commission_bps)}</span><b>${money(o.commission_cents)}</b></span>
            <span><span><i class="cs-dot cs-dot--sup"></i>${esc(o.suppliers.name)}</span><b>${money(o.seller_payout_cents)}</b></span>
          </div>
          ${gone ? `<p class="cs-note">Refunded. No longer counted.</p>` : ""}
        </div>`;
    }).join("")}</div>`;
  }

  function whatIfHTML() {
    if (!sim.placed) return `<p class="cs-note">Rates are still open. They are read when the buyer clicks Buy and then frozen on the order. Drag a slider and watch every figure below move.</p>`;
    const drafts = draftOrders();
    const rows = drafts.map(d => {
      const o = sim.orders.find(x => x.key === d.key);
      const diff = d.commission_cents - o.commission_cents;
      return `<li>${esc(d.suppliers.name)}: ${pct(d.commission_bps)} would give Poda ${money(d.commission_cents)}, ${diff === 0 ? "the same as this order" : `${diff > 0 ? "up" : "down"} ${money(Math.abs(diff))}`}.</li>`;
    }).join("");
    return `<div class="cs-lock"><b>This order is frozen.</b> It keeps the rates it was placed at. A rate changed now applies to the next order.<ul>${rows}</ul>
      <button class="cs-btn" data-reset-demo>Start over with open rates</button></div>`;
  }

  function ledgerHTML(t) {
    const rows = t.all.map(o => {
      const gone = o.status === "refunded";
      return `
        <tr class="${gone ? "is-refunded" : ""}">
          <td data-label="Order ID" class="cs-mono">${esc(o.id)}</td>
          <td data-label="Supplier">${esc(o.suppliers.name)}</td>
          <td data-label="Product">${esc(o.title)}</td>
          <td data-label="Sale amount" class="cs-num">${money(o.price_cents)}</td>
          <td data-label="Commission rate" class="cs-mono">${pct(o.commission_bps)}</td>
          <td data-label="Platform commission" class="cs-num">${gone ? money(0) : money(o.commission_cents)}</td>
          <td data-label="Supplier earnings" class="cs-num">${gone ? money(0) : money(o.seller_payout_cents)}</td>
          <td data-label="Payout eligibility">${esc(eligibility(o))}</td>
          <td data-label="Payout status"><span class="cs-chip cs-chip--${payoutStatus(o).startsWith("Paid") ? "published" : payoutStatus(o) === "To recover" ? "declined" : payoutStatus(o).startsWith("Prepared") ? "approved" : "submitted"}">${esc(payoutStatus(o))}</span></td>
        </tr>`;
    }).join("");
    return `
      <div class="cs-tablewrap"><table class="cs-table cs-table--cards cs-ledger">
        <thead><tr><th>Order ID</th><th>Supplier</th><th>Product</th><th>Sale amount</th><th>Commission rate</th><th>Platform commission</th><th>Supplier earnings</th><th>Payout eligibility</th><th>Payout status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">Totals</td><td class="cs-num">${money(t.merch)}</td><td></td><td class="cs-num">${money(t.comm)}</td><td class="cs-num">${money(t.share)}</td><td colspan="2"></td></tr></tfoot>
      </table></div>`;
  }

  function lifecycleHTML() {
    if (!sim.placed) {
      return `<div class="cs-callout"><p>The order has not been placed. Placing it freezes the rates and starts the lifecycle.</p>
        <button class="cs-btn cs-btn--solid" data-sim="place">Place the demo order</button></div>`;
    }
    const day = `<div class="cs-clock"><span class="cs-label">Simulated date</span><b>${esc(dayLabel(simNow()))}</b><span class="cs-faint">Day ${sim.clockDays}</span>
      <button class="cs-btn" data-sim="day1">+1 day</button><button class="cs-btn" data-sim="day7">+7 days</button></div>`;
    const pendingAll = sim.orders.every(o => o.status === "pending");
    const group = pendingAll ? `<div class="cs-callout"><p>One customer payment covers both pieces. Confirming it moves both orders to paid at once, and each piece then follows its own path.</p>
      <button class="cs-btn cs-btn--solid" data-sim="pay">Confirm the payment, ${money(totals().paid)}</button></div>` : "";
    const tracks = sim.orders.map(o => {
      const st = stageOf(o);
      const items = STEPS.map((s, i) => {
        let state = "todo";
        if (st === "refunded") state = o.paid_at && i <= 1 ? "done" : "todo";
        else if (i < st) state = "done"; else if (i === st) state = "now";
        return `<li class="cs-track__step is-${state}"><span class="cs-track__dot"></span><b>${esc(s.name)}</b>${s.tag === "demo" ? tag("demo", "Illustrative") : ""}</li>`;
      }).join("");
      let action = "";
      if (st === 1) action = `<button class="cs-btn cs-btn--solid" data-sim="ship" data-key="${o.key}">Mark shipped</button>`;
      if (st === 2) action = `<button class="cs-btn cs-btn--solid" data-sim="eligible" data-key="${o.key}">Skip to the end of the window</button><button class="cs-btn" data-sim="prepare" data-key="${o.key}">Prepare payout early</button>`;
      if (st === 3) action = `<button class="cs-btn cs-btn--solid" data-sim="prepare" data-key="${o.key}">Prepare payout</button>`;
      if (st === 4) action = `<button class="cs-btn cs-btn--solid" data-sim="payout" data-sup="${esc(o.supplier_id)}">Record payout as sent</button>`;
      const refundBtn = (typeof st === "number" && st >= 1) ? `<button class="cs-btn cs-btn--danger" data-sim="refund" data-key="${o.key}">Refund this piece</button>` : "";
      const caption = st === "refunded" ? "Refunded. The order stopped counting as a sale." : st === 0 ? "Waiting for the payment." : STEPS[st].text;
      const early = o.prepared && o.early ? `<p class="cs-warn">Prepared before the return window ended. If this piece is refunded later, the payout becomes money to recover from the supplier.</p>` : "";
      return `
        <div class="cs-track">
          <div class="cs-track__head"><b>${esc(o.suppliers.name)}</b><span class="cs-faint">${esc(o.title)}, ${esc(o.id)}</span></div>
          <ol class="cs-track__steps">${items}</ol>
          <p class="cs-note">${esc(caption)}</p>${early}
          <div class="cs-actions">${action}${refundBtn}</div>
        </div>`;
    }).join("");
    return day + group + tracks;
  }

  function balancesHTML() {
    if (!sim.placed) return `<p class="cs-note">Balances appear once the order is paid.</p>`;
    const list = F.balances(sim.orders, { holdDays: HOLD_DAYS, now: simNow() });
    const byId = new Map(list.map(r => [r.supplierId, r]));
    const names = LINES.map(l => l.supplierId);
    const rows = names.map(id => {
      const r = byId.get(id);
      const sup = C.supplierById(id);
      const v = r || { ready: { cents: 0 }, window: { cents: 0 }, notShipped: { cents: 0 }, paid: 0, clawback: { cents: 0 } };
      return `<tr>
        <td data-label="Supplier" class="cs-strong">${esc(sup.name)}</td>
        <td data-label="Ready to pay" class="cs-num">${money(v.ready.cents)}</td>
        <td data-label="In return window" class="cs-num">${money(v.window.cents)}</td>
        <td data-label="Not shipped" class="cs-num">${money(v.notShipped.cents)}</td>
        <td data-label="Paid" class="cs-num">${money(v.paid)}</td>
        <td data-label="To recover" class="cs-num${v.clawback.cents ? " cs-neg" : ""}">${money(v.clawback.cents)}</td></tr>`;
    }).join("");
    const pays = sim.payouts.map(p => `<li class="${p.voided_at ? "is-void" : ""}"><b>${esc(p.id)}</b> ${esc(p.supplier)}, ${money(p.amount_cents)}, ${esc(p.method)}, ref ${esc(p.reference)}, ${esc(dayLabel(Date.parse(p.paid_at)))}${p.voided_at ? ", voided" : `<button class="cs-btn cs-btn--ghost" data-sim="void" data-id="${esc(p.id)}">Void</button>`}</li>`).join("");
    return `
      <div class="cs-tablewrap"><table class="cs-table cs-table--cards">
        <thead><tr><th>Supplier</th><th>Ready to pay</th><th>In return window</th><th>Not shipped</th><th>Paid</th><th>To recover</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <h4 class="cs-subhead">Payout history</h4>
      ${pays ? `<ul class="cs-paylist">${pays}</ul>` : `<p class="cs-note">No payouts recorded yet. A recorded payout is an entry on this page only. No money moves.</p>`}`;
  }

  function exceptionsHTML(t) {
    const refunded = sim.orders.filter(o => o.status === "refunded");
    let effects = "";
    if (refunded.length) {
      effects = refunded.map(o => {
        const paidOut = o.payout_status === "paid";
        return `<div class="cs-effect">
          <h4>${esc(o.title)} refunded, ${esc(o.id)}</h4>
          <table class="cs-mini-table"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>
            <tr><td>Merchandise counted</td><td>${money(t.merch + o.price_cents)}</td><td>${money(t.merch)}</td></tr>
            <tr><td>Poda commission</td><td>${money(t.comm + o.commission_cents)}</td><td>${money(t.comm)}</td></tr>
            <tr><td>Supplier earnings</td><td>${money(t.share + o.seller_payout_cents)}</td><td>${money(t.share)}</td></tr>
            <tr><td>${esc(o.suppliers.name)} position</td><td>${paidOut ? "Paid " + money(o.seller_payout_cents) : "Owed " + money(o.seller_payout_cents)}</td><td>${paidOut ? `<b class="cs-neg">Recover ${money(o.seller_payout_cents)}</b>` : "Owed nothing"}</td></tr>
          </tbody></table>
          <p class="cs-note">${paidOut ? "The supplier was already paid, so Poda has to get that money back. The system lists it as to recover. It does not collect it: that happens outside the system." : "Nothing had been paid out, so the supplier simply stops being owed this amount."}</p>
        </div>`;
      }).join("");
    }
    return `
      <p class="cs-note">${sim.notice ? `<b>${esc(sim.notice)}</b> ` : ""}Poda refunds the buyer in Stripe by hand, then records the refund in Admin. The order stops counting as a sale and the totals and balances recompute.</p>
      <div class="cs-actions">
        <button class="cs-btn" data-sim="scenario-before">Show a refund before payout</button>
        <button class="cs-btn" data-sim="scenario-after">Show a refund after payout</button>
      </div>
      ${effects}
      <p class="cs-note">${tag("next", "Not built")} Automated refunds, automatic restocking and automatic recovery from a supplier. Today the piece is not returned to sale when an order is refunded.</p>`;
  }

  /* —— Region renderers —— */
  function renderOutputs() {
    const t = totals();
    const set = (id, html) => { const el = $("#" + id); if (el) el.innerHTML = html; };
    set("simStats", statsHTML(t));
    const host = $("#simFlowHost");
    if (host) { host.innerHTML = flowHTML(t); }
    set("simAttr", attributionHTML(t));
    set("simWhatIf", whatIfHTML());
    set("simLedger", ledgerHTML(t));
    set("simLifecycle", lifecycleHTML());
    set("simBalances", balancesHTML());
    set("simExceptions", exceptionsHTML(t));
    const cap = $("#simFlowCaption");
    if (cap && !cap.dataset.keep) cap.textContent = sim.flow || "Select a ribbon to see where that money goes.";
  }
  function renderControls() { const el = $("#simControls"); if (el) el.innerHTML = controlsHTML(); }
  function renderAll() { if (!$("#simControls")) return; renderControls(); renderOutputs(); }

  /* —— Events —— */
  function bind() {
    const root = $("#stage4Mount");
    if (!root) return;

    root.addEventListener("input", e => {
      const rate = e.target.closest("[data-sim-rate]");
      const price = e.target.closest("[data-sim-price]");
      if (rate) {
        const key = rate.dataset.simRate;
        const sup = C.supplierById(LINES.find(l => l.key === key).supplierId);
        sup.bps = parseInt(rate.value, 10);
        const label = $(`[data-sim-ratelabel="${key}"]`); if (label) label.textContent = pct(sup.bps);
        renderOutputs();
      } else if (price) {
        const v = Math.round(parseFloat(price.value) * 100);
        if (Number.isFinite(v) && v > 0) { sim.prices[price.dataset.simPrice] = v; renderOutputs(); }
      }
    });
    root.addEventListener("change", e => {
      const fee = e.target.closest("[data-sim-fee]");
      if (fee) { sim.fee = fee.checked; renderOutputs(); }
    });
    root.addEventListener("click", e => {
      const flow = e.target.closest("[data-flow]");
      if (flow) {
        sim.flow = flow.dataset.flow;
        $$(".cs-ribbon", root).forEach(r => r.classList.toggle("is-on", r === flow));
        const cap = $("#simFlowCaption"); if (cap) cap.textContent = sim.flow;
        return;
      }
      const btn = e.target.closest("[data-sim]");
      if (!btn) return;
      const a = btn.dataset.sim, key = btn.dataset.key;
      if (a === "place") place();
      else if (a === "pay") confirmPayment();
      else if (a === "ship") ship(key);
      else if (a === "eligible") skipToEligible(key);
      else if (a === "prepare") prepare(key);
      else if (a === "payout") recordPayout(btn.dataset.sup);
      else if (a === "void") voidPayout(btn.dataset.id);
      else if (a === "refund") refund(key);
      else if (a === "day1") sim.clockDays += 1;
      else if (a === "day7") sim.clockDays += 7;
      else if (a === "scenario-before") { runScenario("before"); return; }
      else if (a === "scenario-after") { runScenario("after"); return; }
      sim.notice = "";
      C.render();
    });
    root.addEventListener("keydown", e => {
      const flow = e.target.closest("[data-flow]");
      if (flow && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); flow.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
    });

    // The flow diagram is drawn at the width it has, so redraw when that changes.
    let last = 0;
    window.addEventListener("resize", () => {
      const host = $("#simFlowHost"); if (!host) return;
      if (Math.abs(host.clientWidth - last) > 8) { last = host.clientWidth; renderOutputs(); }
    });
  }

  reset();
  C.register(renderAll);
  document.addEventListener("DOMContentLoaded", bind);

  window.PodaCaseSim = { reset, get, lines, orders, place, totals, stageOf };
})();
