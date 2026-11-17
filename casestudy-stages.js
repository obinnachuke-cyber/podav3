/* ============================================================
   casestudy-stages.js: walkthrough stages 1 to 3 on /build.
   Stage 1 suppliers, stage 2 inventory, stage 3 orders.
   Demo data only. See casestudy-core.js.
   ============================================================ */
(function () {
  "use strict";
  const C = window.PodaCase;
  const { money, pct, esc, $, $$, dayLabel, glyph, S } = C;

  const tag = (kind, text) => `<span class="cs-tag cs-tag--${kind}">${esc(text)}</span>`;
  const catLabel = key => C.CATEGORIES[key].label;
  const statusChip = status => `<span class="cs-chip cs-chip--${status.toLowerCase()}">${esc(status)}</span>`;

  /* ============================================================
     STAGE 1: Supplier management
     ============================================================ */
  const ONBOARD_STEPS = [
    { title: "Application", text: "The supplier answers four questions on Sell with Poda: name, email, Instagram and closet photos. Photos go to a private bucket. Applying creates no account and no product." },
    { title: "Review", text: "Poda reads the application in Admin and accepts or declines it. A decision email goes to the applicant." },
    { title: "Invite", text: "Poda creates the supplier record with a category and a commission rate, then emails an invite link tied to the supplier's email address." },
    { title: "Account", text: "The supplier signs in through the link. The database checks the invite against that email address, links the login to the supplier record and sets the role to supplier." },
    { title: "Terms and first piece", text: "The commission agreement is on file. The supplier can submit pieces. They cannot change their own rate or status." }
  ];
  const NEW_SUPPLIER_ID = "pinestreet";

  function ensureS1() {
    if (!S.ui.s1) S.ui.s1 = { sel: "alder", onboard: 0, cat: "vintage" };
    return S.ui.s1;
  }

  function supplierCounts(id) {
    const items = S.inventory.filter(i => i.sup === id);
    return {
      inventory: items.filter(i => i.st !== "declined").length,
      listings: items.filter(i => i.st === "published").length,
      byState: items.reduce((acc, i) => { acc[i.st] = (acc[i.st] || 0) + 1; return acc; }, {})
    };
  }

  function onboardingHTML(ui) {
    const step = ui.onboard;
    const chips = ONBOARD_STEPS.map((s, i) => {
      const state = step > i + 1 ? "done" : step === i + 1 ? "now" : "todo";
      return `<li class="cs-steps__item is-${state}"><span class="cs-steps__n">${i + 1}</span><span>${esc(s.title)}</span></li>`;
    }).join("");
    let body;
    if (step === 0) {
      body = `<p class="cs-note">Walk a new supplier from application to first submission. This adds a demo row to the table below.</p>
        <div class="cs-actions"><button class="cs-btn cs-btn--solid" data-act="onboard-start">Simulate a new supplier</button></div>`;
    } else {
      const s = ONBOARD_STEPS[step - 1];
      const picker = step === 3 ? `
        <label class="cs-field">Category
          <select data-act-change="onboard-cat">
            ${["closet", "boutique", "vintage"].map(k => `<option value="${k}"${ui.cat === k ? " selected" : ""}>${esc(catLabel(k))}, starts at ${pct(C.CATEGORIES[k].startBps)}</option>`).join("")}
          </select>
        </label>` : "";
      body = `<div class="cs-onboard__step"><h4>${step}. ${esc(s.title)}</h4><p>${esc(s.text)}</p>${picker}</div>
        <div class="cs-actions">
          ${step < ONBOARD_STEPS.length
            ? `<button class="cs-btn cs-btn--solid" data-act="onboard-next">Next step</button>`
            : `<button class="cs-btn" data-act="onboard-open">Open the record</button>`}
          <button class="cs-btn cs-btn--ghost" data-act="onboard-reset">Start over</button>
        </div>`;
    }
    return `<div class="cs-onboard"><div class="cs-onboard__head"><span class="cs-label">How a supplier joins</span>${tag("built", "Built")}</div>
      <ol class="cs-steps">${chips}</ol>${body}</div>`;
  }

  function supplierDetail(s) {
    const cat = C.CATEGORIES[s.cat];
    const counts = supplierCounts(s.id);
    const sample = 10000;
    const comm = C.commissionCents(sample, s.bps);
    const hist = s.history.slice().sort((a, b) => a[0] - b[0]).map(h =>
      `<li><b>${esc(dayLabel(C.daysAgo(h[0])))}</b><span>${esc(h[1])}${h[2] ? `<em>${esc(h[2])}</em>` : ""}</span></li>`).join("");
    const states = ["submitted", "approved", "published", "sold", "archived", "declined"]
      .filter(k => counts.byState[k]).map(k => `${counts.byState[k]} ${k}`).join(", ") || "No pieces yet";
    return `
      <div class="cs-detail">
        <div class="cs-detail__col">
          <h4>Commission agreement</h4>
          <p class="cs-note">Starting rate for ${esc(cat.label.toLowerCase())}: ${pct(cat.startBps)}. Agreed rate: <b>${pct(s.bps)}</b>.</p>
          <div class="cs-inline">
            <label class="cs-field">Rate, percent
              <input type="number" min="0" max="100" step="0.5" value="${(s.bps / 100)}" data-rate-input="${esc(s.id)}" />
            </label>
            <button class="cs-btn" data-act="save-rate" data-id="${esc(s.id)}">Save terms</button>
          </div>
          <p class="cs-note" data-rate-preview>On a ${money(sample)} sale, Poda keeps ${money(comm)} and the supplier receives ${money(sample - comm)}.</p>
          <p class="cs-note">A new rate applies to orders placed from now on. An order already placed keeps the rate it was placed at.</p>
        </div>
        <div class="cs-detail__col">
          <h4>Relationship history</h4>
          <ul class="cs-timeline">${hist}</ul>
          <p class="cs-note">${tag("partial", "Partial")} The system keeps the dates a supplier was invited, joined and submitted, plus each piece's activity trail. A single supplier history log is not built.</p>
        </div>
        <div class="cs-detail__col">
          <h4>This category</h4>
          <p class="cs-note">Database supplier type: ${esc(cat.dbType)}. Brands and boutiques can sell several sizes with a stock count per size. Private closets sell one of each piece.</p>
          <p class="cs-note">Pieces on file: ${esc(states)}.</p>
          <p class="cs-note">Status is set by Poda. A supplier can read its own record and cannot edit it.</p>
        </div>
      </div>`;
  }

  function renderStage1() {
    const m = $("#stage1Mount");
    if (!m) return;
    const ui = ensureS1();
    const rows = S.suppliers.map(s => {
      const c = supplierCounts(s.id);
      const open = ui.sel === s.id;
      return `
        <tr class="cs-row${open ? " is-open" : ""}" data-sup="${esc(s.id)}" tabindex="0" role="button" aria-expanded="${open}">
          <td data-label="Supplier" class="cs-strong">${esc(s.name)}</td>
          <td data-label="Category">${esc(catLabel(s.cat))}</td>
          <td data-label="Contact" class="cs-mono">${esc(s.contact)}</td>
          <td data-label="Agreement" class="cs-mono">${pct(s.bps)}</td>
          <td data-label="Inventory" class="cs-num">${c.inventory}</td>
          <td data-label="Active listings" class="cs-num">${c.listings}</td>
          <td data-label="Status">${statusChip(s.status)}</td>
          <td data-label="Joined" class="cs-mono">${esc(dayLabel(s.joined))}</td>
        </tr>
        ${open ? `<tr class="cs-detailrow"><td colspan="8">${supplierDetail(s)}</td></tr>` : ""}`;
    }).join("");
    m.innerHTML = `
      ${onboardingHTML(ui)}
      <div class="cs-tablewrap">
        <table class="cs-table cs-table--cards">
          <thead><tr><th>Supplier</th><th>Category</th><th>Contact</th><th>Agreement</th><th>Inventory</th><th>Active listings</th><th>Status</th><th>Joined</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="cs-note cs-note--foot">Names and contacts are invented. Inventory and listing counts come from the Stage 2 table, so changes there show up here. The three categories are this page's labels: in the database a supplier has a type of consignor, brand, boutique or poda, and a vintage reseller is set up as one of those with its own rate.</p>`;
  }

  function bindStage1() {
    const m = $("#stage1Mount");
    if (!m) return;
    m.addEventListener("click", e => {
      const ui = ensureS1();
      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        if (a === "onboard-start") ui.onboard = 1;
        else if (a === "onboard-next") {
          ui.onboard += 1;
          if (ui.onboard === 4) addNewSupplier(ui, "Invited");
          if (ui.onboard === 5) { const s = C.supplierById(NEW_SUPPLIER_ID); if (s) { s.status = "Active"; s.history.push([0, "Account created", "Invite redeemed. Role set to supplier."]); } }
        } else if (a === "onboard-reset") {
          S.suppliers = S.suppliers.filter(s => s.id !== NEW_SUPPLIER_ID);
          ui.onboard = 0;
        } else if (a === "onboard-open") ui.sel = NEW_SUPPLIER_ID;
        else if (a === "save-rate") {
          const s = C.supplierById(act.dataset.id);
          const input = m.querySelector("[data-rate-input]");
          const v = Math.max(0, Math.min(100, parseFloat(input.value)));
          if (s && Number.isFinite(v)) {
            s.bps = Math.round(v * 100);
            s.history.push([0, "Terms changed", `Rate set to ${pct(s.bps)}. Existing orders keep their rate.`]);
          }
        }
        C.render();
        return;
      }
      const row = e.target.closest("tr[data-sup]");
      if (row) { ui.sel = ui.sel === row.dataset.sup ? "" : row.dataset.sup; C.render(); }
    });
    m.addEventListener("keydown", e => {
      const row = e.target.closest("tr[data-sup]");
      if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
    });
    m.addEventListener("change", e => {
      const sel = e.target.closest("[data-act-change='onboard-cat']");
      if (sel) { ensureS1().cat = sel.value; }
    });
    m.addEventListener("input", e => {
      const input = e.target.closest("[data-rate-input]");
      if (!input) return;
      const v = Math.max(0, Math.min(100, parseFloat(input.value) || 0));
      const comm = C.commissionCents(10000, Math.round(v * 100));
      const p = m.querySelector("[data-rate-preview]");
      if (p) p.textContent = `On a ${money(10000)} sale, Poda keeps ${money(comm)} and the supplier receives ${money(10000 - comm)}.`;
    });
  }

  function addNewSupplier(ui, status) {
    if (C.supplierById(NEW_SUPPLIER_ID)) return;
    const cat = C.CATEGORIES[ui.cat];
    S.suppliers.push({
      id: NEW_SUPPLIER_ID, name: "Pine Street Vintage", cat: ui.cat, contact: "pinestreet@example.com", bps: cat.startBps,
      status, joined: C.TODAY,
      history: [[0, "Application received", "Photos and Instagram reviewed."], [0, "Invite sent", `Join link emailed. Category ${cat.label}, starting rate ${pct(cat.startBps)}.`]]
    });
  }

  /* ============================================================
     STAGE 2: Inventory management
     ============================================================ */
  const STATES = ["submitted", "approved", "published", "sold", "archived", "declined"];
  const STATE_NOTE = {
    submitted: "Waiting for Poda's review.",
    approved: "Accepted. Eligible for a release, not yet public.",
    published: "In a release whose drop time has passed.",
    sold: "Paid for. Quantity is now zero.",
    archived: "Its release has moved to the Archive.",
    declined: "Not accepted. The supplier sees the note."
  };

  function ensureS2() {
    if (!S.ui.s2) S.ui.s2 = { filter: "all", sel: "PD-1048" };
    return S.ui.s2;
  }

  const approvalOf = i => i.st === "submitted" ? "Pending" : i.st === "declined" ? "Declined" : "Accepted";
  const publicationOf = i => i.st === "published" ? "Published"
    : i.st === "sold" ? "Sold" : i.st === "archived" ? "Archived"
    : i.st === "approved" ? (i.rel ? "Queued" : "Not queued") : "Not published";

  function inventoryDetail(i) {
    const s = C.supplierById(i.sup);
    const rate = C.rateFor(i);
    const comm = C.commissionCents(i.price, rate);
    const ownership = s.cat === "poda" ? "Poda owns this piece. No seller share." : `${s.name} owns this piece until it sells.`;
    const events = [[i.submitted, "Submitted by supplier"]].concat(i.events.map(e => [C.TODAY - e[0] * C.DAY, e[1]]))
      .sort((a, b) => a[0] - b[0]);
    const actions = [];
    if (i.st === "submitted") actions.push(`<button class="cs-btn cs-btn--solid" data-act="accept" data-id="${i.id}">Accept</button><button class="cs-btn" data-act="decline" data-id="${i.id}">Decline</button>`);
    if (i.st === "approved" && !i.rel) actions.push(`<button class="cs-btn cs-btn--solid" data-act="assign" data-id="${i.id}">Add to Release 05</button>`);
    if (i.st === "approved" && i.rel) actions.push(`<span class="cs-note">Queued in ${esc(i.rel)}. It goes public when the release drops.</span>`);
    return `
      <div class="cs-detail">
        <div class="cs-detail__col">
          <h4>Ownership and terms</h4>
          <p class="cs-note">${esc(ownership)} The owner cannot change after submission.</p>
          <dl class="cs-dl">
            <dt>Supplier</dt><dd>${esc(s.name)}</dd>
            <dt>Rate in effect</dt><dd>${pct(rate)}, from the supplier agreement</dd>
            <dt>Piece override</dt><dd>None. The database allows one per piece.</dd>
            <dt>At list price</dt><dd>Poda ${money(comm)}, supplier ${money(i.price - comm)}</dd>
          </dl>
        </div>
        <div class="cs-detail__col">
          <h4>Activity trail</h4>
          <ul class="cs-timeline">${events.map(e => `<li><b>${esc(dayLabel(e[0]))}</b><span>${esc(e[1])}</span></li>`).join("")}</ul>
        </div>
        <div class="cs-detail__col">
          <h4>Review</h4>
          <p class="cs-note">${esc(STATE_NOTE[i.st])}</p>
          <div class="cs-actions">${actions.join("") || ""}</div>
        </div>
      </div>`;
  }

  function renderStage2() {
    const m = $("#stage2Mount");
    if (!m) return;
    const ui = ensureS2();
    const counts = STATES.reduce((acc, k) => { acc[k] = S.inventory.filter(i => i.st === k).length; return acc; }, {});
    const total = S.inventory.length;
    const queued = S.inventory.filter(i => i.st === "approved" && i.rel === "Release 05").length;
    const list = S.inventory.filter(i => ui.filter === "all" || i.st === ui.filter);

    const seg = STATES.map(k => counts[k] ? `<span class="cs-seg cs-seg--${k}" style="flex:${counts[k]}" title="${esc(k)}: ${counts[k]}"></span>` : "").join("");
    const filters = [`<button class="cs-filter${ui.filter === "all" ? " is-active" : ""}" data-act="filter" data-v="all" aria-pressed="${ui.filter === "all"}">All <b>${total}</b></button>`]
      .concat(STATES.map(k => `<button class="cs-filter${ui.filter === k ? " is-active" : ""}" data-act="filter" data-v="${k}" aria-pressed="${ui.filter === k}"><i class="cs-dot cs-dot--${k}"></i>${esc(k)} <b>${counts[k]}</b></button>`)).join("");

    const rows = list.map(i => {
      const s = C.supplierById(i.sup);
      const open = ui.sel === i.id;
      return `
        <tr class="cs-row${open ? " is-open" : ""}" data-item="${i.id}" tabindex="0" role="button" aria-expanded="${open}">
          <td data-label="Piece"><div class="cs-piece"><span class="cs-photo cs-photo--${i.st}" aria-hidden="true">${glyph(i.glyph, 34)}</span><span><b class="cs-strong">${esc(i.name)}</b><span class="cs-mono cs-faint">${i.id}</span></span></div></td>
          <td data-label="Supplier">${esc(s.name)}<span class="cs-faint">${s.cat === "poda" ? "Poda owned" : "Supplier owned"}</span></td>
          <td data-label="Price" class="cs-num">${money(i.price)}</td>
          <td data-label="Condition">${esc(i.cond)}</td>
          <td data-label="Submitted" class="cs-mono">${esc(dayLabel(i.submitted))}</td>
          <td data-label="Approval">${esc(approvalOf(i))}</td>
          <td data-label="Publication"><span class="cs-chip cs-chip--${i.st}">${esc(publicationOf(i))}</span></td>
          <td data-label="Folder" class="cs-mono">${esc(i.rel || "None")}</td>
        </tr>
        ${open ? `<tr class="cs-detailrow"><td colspan="8">${inventoryDetail(i)}</td></tr>` : ""}`;
    }).join("");

    m.innerHTML = `
      <div class="cs-pipeline">
        <div class="cs-pipeline__bar" role="img" aria-label="Pieces by state">${seg}</div>
        <div class="cs-filters" role="group" aria-label="Filter pieces by state">${filters}</div>
      </div>
      <div class="cs-releasebar">
        <span><b>Release 05</b> is a draft. ${queued} ${queued === 1 ? "piece is" : "pieces are"} queued.</span>
        <button class="cs-btn cs-btn--solid" data-act="drop"${queued ? "" : " disabled"}>Run the drop</button>
      </div>
      <div class="cs-tablewrap">
        <table class="cs-table cs-table--cards">
          <thead><tr><th>Piece</th><th>Supplier</th><th>Price</th><th>Condition</th><th>Submitted</th><th>Approval</th><th>Publication</th><th>Folder</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8" class="cs-empty">Nothing in this state.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="cs-note cs-note--foot">Placeholder images. No supplier photographs are used. Accepting a piece never publishes it: only a release whose drop time has passed does, and the database clock decides that. In the live system the Archive is a release that has been replaced by a newer drop. This demo keeps Release 04 on sale so Stage 3 has pieces to buy.</p>`;
  }

  function bindStage2() {
    const m = $("#stage2Mount");
    if (!m) return;
    m.addEventListener("click", e => {
      const ui = ensureS2();
      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        const item = C.itemById(act.dataset.id);
        if (a === "filter") ui.filter = act.dataset.v;
        else if (a === "accept" && item) { item.st = "approved"; item.events.push([0, "Accepted by Poda"]); }
        else if (a === "decline" && item) { item.st = "declined"; item.events.push([0, "Declined: note sent to the supplier"]); }
        else if (a === "assign" && item) { item.rel = "Release 05"; item.events.push([0, "Added to Release 05"]); }
        else if (a === "drop") {
          S.inventory.filter(i => i.st === "approved" && i.rel === "Release 05").forEach(i => { i.st = "published"; i.events.push([0, "Release 05 dropped"]); });
        }
        C.render();
        return;
      }
      const row = e.target.closest("tr[data-item]");
      if (row) { ui.sel = ui.sel === row.dataset.item ? "" : row.dataset.item; C.render(); }
    });
    m.addEventListener("keydown", e => {
      const row = e.target.closest("tr[data-item]");
      if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
    });
  }

  /* ============================================================
     STAGE 3: Order management
     ============================================================ */
  function ensureS3() {
    if (!S.ui.s3) S.ui.s3 = { sel: "A" };
    return S.ui.s3;
  }

  function lineInspector(line, order, sim) {
    const supplier = C.supplierById(line.supplierId);
    const item = C.itemById(line.itemId);
    const placed = sim.placed;
    const bps = order.commission_bps;
    const comm = order.commission_cents;
    const share = order.seller_payout_cents;
    const state = !placed ? "Accepted, quantity 1, published in Release 04" : item.st === "sold" ? "Accepted, quantity 0, reads Sold" : "Accepted";
    return `
      <div class="cs-cards3">
        <div class="cs-mini">
          <h4>1. Inventory record</h4>
          <dl class="cs-dl">
            <dt>Piece</dt><dd>${esc(item.id)}, ${esc(item.name)}</dd>
            <dt>Owner</dt><dd>${esc(supplier.name)}</dd>
            <dt>State</dt><dd>${esc(state)}</dd>
          </dl>
          <p class="cs-note">The sale lowers this piece's quantity and leaves the owner as it was. Another supplier's record is not touched.</p>
        </div>
        <div class="cs-mini">
          <h4>2. Financial obligation</h4>
          <dl class="cs-dl">
            <dt>Sale price</dt><dd>${money(order.price_cents)}</dd>
            <dt>Rate ${placed ? "frozen at purchase" : "in effect now"}</dt><dd>${pct(bps)}</dd>
            <dt>Poda keeps</dt><dd>${money(comm)}</dd>
            <dt>${esc(supplier.name)} is owed</dt><dd><b>${money(share)}</b></dd>
          </dl>
          <p class="cs-note">This obligation belongs to ${esc(supplier.name)} alone. It is not netted against the other supplier on the order.</p>
        </div>
        <div class="cs-mini">
          <h4>3. Fulfillment</h4>
          <dl class="cs-dl">
            <dt>Task</dt><dd>Send piece ${line.key === "A" ? "1" : "2"} of 2</dd>
            <dt>Recorded as</dt><dd>Carrier, tracking number, ship date</dd>
            <dt>Buyer</dt><dd>Receives a shipped email</dd>
          </dl>
          <p class="cs-note">Shipment is recorded per piece. One supplier's delay does not hold the other supplier's payout.</p>
        </div>
      </div>`;
  }

  function renderStage3() {
    const m = $("#stage3Mount");
    if (!m) return;
    const Sim = window.PodaCaseSim;
    const sim = Sim.get();
    const ui = ensureS3();
    const lines = Sim.lines();
    const orders = Sim.orders();
    const merch = orders.reduce((n, o) => n + o.price_cents, 0);
    const total = merch + C.SHIPPING_CENTS;
    const sel = lines.find(l => l.key === ui.sel) || lines[0];
    const selOrder = orders.find(o => o.key === sel.key);

    const lineRows = lines.map((l, idx) => {
      const o = orders[idx];
      const sup = C.supplierById(l.supplierId);
      const open = sel.key === l.key;
      return `
        <tr class="cs-row${open ? " is-open" : ""}" data-line="${l.key}" tabindex="0" role="button" aria-pressed="${open}">
          <td data-label="Record" class="cs-mono">${sim.placed ? esc(o.id) : "Not created"}</td>
          <td data-label="Piece"><div class="cs-piece"><span class="cs-photo cs-photo--published" aria-hidden="true">${glyph(l.glyph, 30)}</span><b class="cs-strong">${esc(l.title)}</b></div></td>
          <td data-label="Supplier">${esc(sup.name)}<span class="cs-faint">${esc(catLabel(sup.cat))}</span></td>
          <td data-label="Price" class="cs-num">${money(o.price_cents)}</td>
          <td data-label="Rate" class="cs-mono">${pct(o.commission_bps)}</td>
          <td data-label="Supplier share" class="cs-num">${money(o.seller_payout_cents)}</td>
          <td data-label="Status">${sim.placed ? `<span class="cs-chip cs-chip--${o.status === "paid" ? "published" : "approved"}">${o.status === "paid" ? "Paid" : o.status === "refunded" ? "Refunded" : "In checkout"}</span>` : `<span class="cs-chip cs-chip--submitted">In cart</span>`}</td>
        </tr>`;
    }).join("");

    m.innerHTML = `
      <div class="cs-checkout">
        <div class="cs-checkout__head">
          <div><span class="cs-label">Checkout</span><h4>One customer, one payment</h4></div>
          <div class="cs-checkout__total"><span class="cs-faint">Customer pays</span><b>${money(total)}</b></div>
        </div>
        <p class="cs-note">Two pieces from two suppliers: ${money(merch)} of merchandise plus ${money(C.SHIPPING_CENTS)} flat shipping. Shipping is Poda's and is not shared with suppliers.</p>
        <div class="cs-actions">
          <button class="cs-btn cs-btn--solid" data-act="place"${sim.placed ? " disabled" : ""}>${sim.placed ? "Order placed" : "Place demo order"}</button>
          ${sim.placed ? `<button class="cs-btn" data-goto-stage="4">Follow the money, Stage 4</button>` : ""}
        </div>
        <p class="cs-note cs-note--status">${tag("next", "Not built")} Public checkout takes one piece per payment today. The ledger already stores each piece as its own order with its own supplier, rate and split. Taking several pieces in one payment means changing how holds and Stripe sessions are grouped.</p>
      </div>
      <h4 class="cs-subhead">${sim.placed ? "Order records created" : "Order records that will be created"}, one per piece</h4>
      <div class="cs-tablewrap">
        <table class="cs-table cs-table--cards">
          <thead><tr><th>Record</th><th>Piece</th><th>Supplier</th><th>Price</th><th>Rate</th><th>Supplier share</th><th>Status</th></tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>
      <h4 class="cs-subhead">Inspect ${esc(sel.title)}, supplied by ${esc(C.supplierById(sel.supplierId).name)}</h4>
      ${lineInspector(sel, selOrder, sim)}`;
  }

  function bindStage3() {
    const m = $("#stage3Mount");
    if (!m) return;
    m.addEventListener("click", e => {
      const act = e.target.closest("[data-act='place']");
      if (act) { window.PodaCaseSim.place(); C.render(); return; }
      const row = e.target.closest("tr[data-line]");
      if (row) { ensureS3().sel = row.dataset.line; C.render(); }
    });
    m.addEventListener("keydown", e => {
      const row = e.target.closest("tr[data-line]");
      if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
    });
  }

  /* —— Wire up —— */
  C.register(renderStage1);
  C.register(renderStage2);
  C.register(renderStage3);
  document.addEventListener("DOMContentLoaded", () => { bindStage1(); bindStage2(); bindStage3(); });
})();
