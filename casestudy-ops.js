/* ============================================================
   casestudy-ops.js: Stage 5 operations dashboard, the architecture
   chain and the status board on /build.

   The dashboard runs on its own invented dataset and on finance.js, the
   file the admin Payouts view uses. It reads nothing from Poda.
   ============================================================ */
(function () {
  "use strict";
  const C = window.PodaCase;
  const { money, pct, esc, $, $$, dayLabel, S, DAY, HOLD_DAYS } = C;
  const F = window.PodaFinance;
  const tag = (kind, text) => `<span class="cs-tag cs-tag--${kind}">${esc(text)}</span>`;

  /* ============================================================
     Stage 5: operations dashboard
     ============================================================ */
  const DSUP = [
    { id: "alder", name: "Alder Closet", status: "Active" },
    { id: "northline", name: "Northline Vintage", status: "Active" },
    { id: "fenwick", name: "Fenwick & Row", status: "Active" },
    { id: "marisol", name: "Marisol's Closet", status: "Active" },
    { id: "harbor", name: "Harbor Lane", status: "Active" },
    { id: "secondskin", name: "Second Skin Archive", status: "Invited" }
  ];
  const supName = id => (DSUP.find(s => s.id === id) || {}).name || "";

  // supplier, piece, price in dollars, rate in bps, paid days ago, shipped days ago, payout days ago, refunded days ago, still in checkout
  const ORDER_ROWS = [
    ["alder",     "Leather jacket",     400, 2000, 21, 19, 14, null],
    ["alder",     "Wool coat",          320, 2000, 12, 10, null, null],
    ["alder",     "Camel blazer",       280, 2000,  8,  6, null, null],
    ["northline", "Vintage knitwear",   250, 1500,  9,  8, null, null],
    ["northline", "Denim jacket",       180, 1500,  5,  3, null, null],
    ["northline", "Striped rugby shirt",110, 1500, 11,  9, null, 6],
    ["fenwick",   "Tailored trousers",  210, 1500,  4, null, null, null],
    ["fenwick",   "Linen shirt",         95, 1500, 26, 24, 17, null],
    ["fenwick",   "Leather belt",        85, 1500, 23, 21, 14, 3],
    ["marisol",   "Silk slip dress",    140, 2500,  6,  4, null, null],
    ["marisol",   "Suede boots",        220, 2500, 15, 13, null, null],
    ["harbor",    "Cashmere scarf",     120, 1800,  2, null, null, null],
    ["harbor",    "Pleated skirt",      165, 1800, 30, 28, 21, null],
    ["marisol",   "Trench coat",        310, 2500, null, null, null, null, true]
  ];
  const ago = d => new Date(Date.now() - d * DAY).toISOString();
  const ORDERS = ORDER_ROWS.map((r, i) => {
    const [sup, title, dollars, bps, paid, ship, pay, ref, checkout] = r;
    const price = dollars * 100, comm = C.commissionCents(price, bps);
    return {
      id: `ORD-${1001 + i}`, supplier_id: sup, suppliers: { name: supName(sup) }, title, brand: null,
      price_cents: price, commission_bps: bps, commission_cents: comm, seller_payout_cents: price - comm,
      status: checkout ? "pending" : ref != null ? "refunded" : "paid", conflict: false,
      shipping_cents: 1500, amount_total_cents: checkout ? null : price + 1500,
      paid_at: paid != null ? ago(paid) : null, shipped_at: ship != null ? ago(ship) : null,
      refunded_at: ref != null ? ago(ref) : null,
      payout_status: pay != null ? "paid" : "unpaid", payout_paid_at: pay != null ? ago(pay) : null,
      hold_expires_at: checkout ? new Date(Date.now() + 20 * 60000).toISOString() : null
    };
  });
  const orderStatus = o => o.status === "pending" ? "checkout" : o.status === "refunded" ? "refunded" : o.shipped_at ? "shipped" : "awaiting";
  const STATUS_LABEL = { checkout: "In checkout", awaiting: "Awaiting shipment", shipped: "Shipped", refunded: "Refunded" };

  // Pieces still in the pipeline. Sold pieces come from the orders above.
  const PIPELINE = [
    ["fenwick", "Wool overcoat", "submitted"], ["marisol", "Pleated midi skirt", "submitted"], ["northline", "Band tee, 1990s", "submitted"], ["harbor", "Silk scarf", "submitted"],
    ["fenwick", "Wide leg trousers", "approved"], ["harbor", "Cashmere cardigan", "approved"], ["alder", "Shearling vest", "approved"],
    ["alder", "Suede bomber", "published"], ["alder", "Printed silk shirt", "published"], ["northline", "Cable knit cardigan", "published"],
    ["northline", "Washed denim jacket", "published"], ["marisol", "Satin midi dress", "published"], ["fenwick", "Pinstripe blazer", "published"],
    ["harbor", "Linen trousers", "published"], ["marisol", "Trench coat", "published"],
    ["alder", "Corduroy trousers", "archived"], ["harbor", "Wool scarf", "archived"]
  ];
  const PRODUCTS = PIPELINE.map(p => ({ sup: p[0], name: p[1], st: p[2] }))
    .concat(ORDERS.filter(o => o.status !== "pending").map(o => ({ sup: o.supplier_id, name: o.title, st: "sold" })));
  const PSTATES = ["submitted", "approved", "published", "sold", "archived"];

  function ensureDash() {
    if (!S.ui.dash) S.ui.dash = { sup: "all", ord: "all", prod: "all" };
    return S.ui.dash;
  }

  function dashData(ui) {
    const orders = ORDERS.filter(o => (ui.sup === "all" || o.supplier_id === ui.sup) && (ui.ord === "all" || orderStatus(o) === ui.ord));
    const products = PRODUCTS.filter(p => (ui.sup === "all" || p.sup === ui.sup) && (ui.prod === "all" || p.st === ui.prod));
    const forCount = PRODUCTS.filter(p => ui.sup === "all" || p.sup === ui.sup);
    const sum = F.summarize(orders, {});
    const bal = F.balances(orders, { holdDays: HOLD_DAYS, now: Date.now() });
    const owed = F.totalsOwed(bal);
    const suppliers = DSUP.filter(s => ui.sup === "all" || s.id === ui.sup);
    const count = k => forCount.filter(p => p.st === k).length;
    return {
      orders, products, sum, bal, owed,
      active: suppliers.filter(s => s.status === "Active").length,
      invited: suppliers.filter(s => s.status === "Invited").length,
      submitted: count("submitted"), approved: count("approved"), published: count("published")
    };
  }

  function metric(label, value, sub, cls) {
    return `<div class="cs-metric${cls ? " " + cls : ""}"><span class="cs-metric__label">${esc(label)}</span><b>${esc(value)}</b>${sub ? `<span class="cs-metric__sub">${esc(sub)}</span>` : ""}</div>`;
  }

  function payoutLabel(o) {
    if (o.status === "refunded") return o.payout_status === "paid" ? "To recover" : "None";
    if (o.status === "pending") return "Awaiting payment";
    if (o.payout_status === "paid") return "Paid";
    const st = F.payoutState(o, HOLD_DAYS, Date.now());
    return st ? { ready: "Ready", window: "In return window", not_shipped: "Not shipped" }[st.state] : "None";
  }

  function renderStage5() {
    const m = $("#stage5Mount");
    if (!m) return;
    const ui = ensureDash();
    const d = dashData(ui);
    const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;
    const supOpts = opt("all", "All suppliers", ui.sup) + DSUP.map(s => opt(s.id, s.name, ui.sup)).join("");
    const ordOpts = opt("all", "All orders", ui.ord) + Object.keys(STATUS_LABEL).map(k => opt(k, STATUS_LABEL[k], ui.ord)).join("");
    const prodOpts = opt("all", "All products", ui.prod) + PSTATES.map(k => opt(k, k[0].toUpperCase() + k.slice(1), ui.prod)).join("");
    const outstanding = d.owed.ready + d.owed.window + d.owed.notShipped;

    const orderRows = d.orders.map(o => `
      <tr>
        <td data-label="Order" class="cs-mono">${esc(o.id)}</td>
        <td data-label="Supplier">${esc(o.suppliers.name)}</td>
        <td data-label="Piece">${esc(o.title)}</td>
        <td data-label="Price" class="cs-num">${money(o.price_cents)}</td>
        <td data-label="Rate" class="cs-mono">${pct(o.commission_bps)}</td>
        <td data-label="Supplier share" class="cs-num">${money(o.seller_payout_cents)}</td>
        <td data-label="Order status"><span class="cs-chip cs-chip--${orderStatus(o) === "shipped" ? "published" : orderStatus(o) === "refunded" ? "declined" : orderStatus(o) === "checkout" ? "submitted" : "approved"}">${esc(STATUS_LABEL[orderStatus(o)])}</span></td>
        <td data-label="Payout">${esc(payoutLabel(o))}</td>
      </tr>`).join("");

    const balRows = d.bal.map(r => `
      <tr><td data-label="Supplier" class="cs-strong">${esc(r.name)}</td>
        <td data-label="Ready" class="cs-num">${money(r.ready.cents)}</td><td data-label="Return window" class="cs-num">${money(r.window.cents)}</td>
        <td data-label="Not shipped" class="cs-num">${money(r.notShipped.cents)}</td><td data-label="Paid" class="cs-num">${money(r.paid)}</td>
        <td data-label="To recover" class="cs-num${r.clawback.cents ? " cs-neg" : ""}">${money(r.clawback.cents)}</td></tr>`).join("");

    const prodRows = d.products.map(p => `<tr><td data-label="Piece">${esc(p.name)}</td><td data-label="Supplier">${esc(supName(p.sup))}</td><td data-label="State"><span class="cs-chip cs-chip--${p.st}">${esc(p.st)}</span></td></tr>`).join("");

    m.innerHTML = `
      <div class="cs-filterbar">
        <label class="cs-field">Supplier<select data-dash="sup">${supOpts}</select></label>
        <label class="cs-field">Order status<select data-dash="ord">${ordOpts}</select></label>
        <label class="cs-field">Product status<select data-dash="prod">${prodOpts}</select></label>
        <button class="cs-btn cs-btn--ghost" data-dash-reset>Clear filters</button>
      </div>
      <div class="cs-metrics">
        <div class="cs-metricgroup"><span class="cs-label">Supply</span>
          ${metric("Active suppliers", String(d.active), d.invited ? `${d.invited} invited, not yet active` : "")}
          ${metric("Pending submissions", String(d.submitted), "Waiting for review")}
          ${metric("Approved inventory", String(d.approved), "Accepted, not yet published")}
          ${metric("Published products", String(d.published), "In a release that has dropped")}
        </div>
        <div class="cs-metricgroup"><span class="cs-label">Sales</span>
          ${metric("Orders", String(d.orders.length), "Matching the filters")}
          ${metric("Gross merchandise value", money(d.sum.gross), `${d.sum.sales} completed sales`)}
          ${d.sum.refundedCount ? metric("Refunded", money(d.sum.refundedCents), `${d.sum.refundedCount} ${d.sum.refundedCount === 1 ? "order" : "orders"}, excluded from sales`) : ""}
        </div>
        <div class="cs-metricgroup"><span class="cs-label">Money</span>
          ${metric("Platform commissions", money(d.sum.kept), "Poda's share of completed sales", "is-accent")}
          ${metric("Supplier earnings", money(d.sum.sellerShare), "Supplier share of completed sales")}
          ${metric("Outstanding payout obligations", money(outstanding), `Ready ${money(d.owed.ready)}, window ${money(d.owed.window)}, not shipped ${money(d.owed.notShipped)}`, "is-strong")}
          ${d.owed.clawback ? metric("To recover from suppliers", money(d.owed.clawback), "Paid out, then refunded", "is-warn") : ""}
        </div>
      </div>
      <h4 class="cs-subhead">Orders</h4>
      <div class="cs-tablewrap cs-scroll"><table class="cs-table cs-table--cards">
        <thead><tr><th>Order</th><th>Supplier</th><th>Piece</th><th>Price</th><th>Rate</th><th>Supplier share</th><th>Order status</th><th>Payout</th></tr></thead>
        <tbody>${orderRows || `<tr><td colspan="8" class="cs-empty">No orders match these filters.</td></tr>`}</tbody>
      </table></div>
      <div class="cs-two">
        <div>
          <h4 class="cs-subhead">What each supplier is owed</h4>
          <div class="cs-tablewrap"><table class="cs-table cs-table--cards">
            <thead><tr><th>Supplier</th><th>Ready</th><th>Return window</th><th>Not shipped</th><th>Paid</th><th>To recover</th></tr></thead>
            <tbody>${balRows || `<tr><td colspan="6" class="cs-empty">Nothing owed under these filters.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div>
          <h4 class="cs-subhead">Products</h4>
          <div class="cs-tablewrap cs-scroll cs-scroll--short"><table class="cs-table cs-table--cards">
            <thead><tr><th>Piece</th><th>Supplier</th><th>State</th></tr></thead>
            <tbody>${prodRows || `<tr><td colspan="3" class="cs-empty">No products match.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>
      <p class="cs-note cs-note--foot">All figures are invented. Dates are relative to today so the payout states stay realistic. The live admin splits this across Supply, with Review Queue, Inventory, Suppliers, Orders and Payouts as separate views. This single screen shows what running the business involves.</p>`;
  }

  function bindStage5() {
    const m = $("#stage5Mount");
    if (!m) return;
    m.addEventListener("change", e => {
      const sel = e.target.closest("[data-dash]");
      if (!sel) return;
      ensureDash()[sel.dataset.dash] = sel.value;
      C.render();
    });
    m.addEventListener("click", e => {
      if (e.target.closest("[data-dash-reset]")) { S.ui.dash = { sup: "all", ord: "all", prod: "all" }; C.render(); }
    });
  }

  /* ============================================================
     Architecture chain
     ============================================================ */
  const ARCH = [
    { n: "Supplier account", st: "built", where: "Supabase Auth, profiles, suppliers, supplier_users",
      text: "A supplier signs in through an emailed invite. The database checks the invite against the email address it was sent to, links the login to a supplier record and sets the role. A supplier can read its own record and cannot edit its rate or status." },
    { n: "Inventory submission", st: "built", where: "products, product_images, product_variants, Supabase Storage",
      text: "The supplier builds a piece with photos, price, condition and measurements, then submits it. Brands and boutiques can add sizes with stock. A database trigger limits what a supplier can change, including the owner and the commission." },
    { n: "Poda review", st: "built", where: "Admin, Supply, Review Queue",
      text: "Poda accepts or declines each submission, one by one or in bulk, and leaves a note. After acceptance a supplier's price change waits for approval, and an edit to what the piece is takes it off availability until reviewed." },
    { n: "Approved inventory", st: "built", where: "products.state = accepted, the pick board",
      text: "Accepted pieces become eligible. The pick board filters them by seller, brand, category, price and drop history, and flags pieces that are new, repeated, on hold or sold out." },
    { n: "Curated storefront", st: "built", where: "edits, edit_placements, the public_products view",
      text: "A release is a dated edition. Its products become public only when its drop time has passed on the database clock, so a browser clock or a retry cannot publish early." },
    { n: "Customer order", st: "partial", where: "Cloudflare Worker, Stripe Checkout, create_order_hold(), complete_order()",
      text: "Buy holds the piece for 30 minutes and opens Stripe Checkout. The Stripe webhook marks the order paid and lowers the quantity. A payment that arrives after the piece was taken is recorded and flagged for refund. Built for one piece per payment, and the Buy button is switched off in the committed config." },
    { n: "Supplier attribution", st: "built", where: "orders.supplier_id, frozen when the hold is taken",
      text: "Each order row carries the supplier that owns the piece, the title, the price and the split, all copied at purchase. Later edits to the product or the supplier do not rewrite a sale." },
    { n: "Commission calculation", st: "built", where: "create_order_hold(), basis points",
      text: "The rate is the piece's override if it has one, otherwise the supplier's rate. Commission is round(price times rate in basis points over 10,000), kept in whole cents. The seller share is price minus commission." },
    { n: "Financial ledger", st: "built", where: "orders table, finance.js",
      text: "finance.js holds the rules as pure functions: what counts as a sale, what Poda keeps, what each supplier is owed, tax as a pass-through, Stripe's fee out of Poda's share, and a refund removing the sale from every total." },
    { n: "Payout reconciliation", st: "built", where: "payouts, create_payout(), void_payout(), CSV exports",
      text: "A supplier becomes payable 7 days after shipment. Poda sends the money outside the system, then records one payout covering a batch of orders. A mistake is voided, never deleted. Money sent is not automated, and suppliers have no statement view yet." }
  ];
  const ARCH_STATUS = { built: ["built", "Built"], partial: ["partial", "Built, switched off"], next: ["next", "Not built"] };

  function renderArch() {
    const m = $("#archMount");
    if (!m) return;
    if (!S.ui.arch) S.ui.arch = { sel: 0 };
    const sel = S.ui.arch.sel;
    const detail = n => `<div class="cs-arch__detail"><div class="cs-arch__meta">${tag(ARCH_STATUS[n.st][0], ARCH_STATUS[n.st][1])}<span class="cs-mono cs-faint">${esc(n.where)}</span></div><p>${esc(n.text)}</p></div>`;
    m.innerHTML = `
      <div class="cs-arch">
        <ol class="cs-chain">
          ${ARCH.map((n, i) => `
            <li class="cs-chain__item${i === sel ? " is-open" : ""}">
              <button type="button" class="cs-chain__btn" data-arch="${i}" aria-expanded="${i === sel}">
                <span class="cs-chain__n">${String(i + 1).padStart(2, "0")}</span><span class="cs-chain__name">${esc(n.n)}</span>${tag(ARCH_STATUS[n.st][0], ARCH_STATUS[n.st][1])}
              </button>
              ${i === sel ? `<div class="cs-chain__inline">${detail(n)}</div>` : ""}
            </li>`).join("")}
        </ol>
        <aside class="cs-arch__panel" aria-live="polite"><span class="cs-label">${String(sel + 1).padStart(2, "0")} ${esc(ARCH[sel].n)}</span>${detail(ARCH[sel])}</aside>
      </div>`;
  }

  function bindArch() {
    const m = $("#archMount");
    if (!m) return;
    m.addEventListener("click", e => {
      const b = e.target.closest("[data-arch]");
      if (!b) return;
      S.ui.arch = { sel: parseInt(b.dataset.arch, 10) };
      renderArch();
    });
  }

  /* ============================================================
     Rendering hooks
     ============================================================ */
  C.register(renderStage5);
  C.register(renderArch);
  document.addEventListener("DOMContentLoaded", () => { bindStage5(); bindArch(); });
})();
