/* ============================================================
   pickboard.js — the admin's biweekly picking tools.

   1. The pick board: one page with a photo grid of every accepted piece,
      who uploaded it, filters, and a tray that adds a whole selection to a
      release in one go. It replaces the old text-only "Select products"
      pop-up.
   2. The needs-you strip: what is waiting on the admin, shown above the
      Current Release and Supply views.

   Loaded after release.js and before admin.js. It only touches admin.js
   globals (adminMain, escapeHTML, setView, state) when a function runs,
   after admin.js has loaded.
   ============================================================ */
(function () {
  "use strict";

  const A = () => window.PodaMarketplace;
  const esc = v => escapeHTML(v);

  // poda's own pieces get no type tag: "poda" next to "poda" says nothing.
  const TYPE_LABEL = { consignor: "Consignor", brand: "Brand", boutique: "Boutique", poda: "" };

  function usd(cents) {
    if (cents === null || cents === undefined) return "—";
    return "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
  }

  function folderName(edit) {
    return edit.number == null ? (edit.title || "a release") : `Folder ${String(edit.number).padStart(3, "0")}`;
  }

  function sortedImages(p) {
    return (p.product_images || []).slice().sort((a, b) => a.position - b.position);
  }

  /* ============================================================
     Pick board
     ============================================================ */
  const defaults = () => ({
    q: "", seller: "", brand: "", category: "",
    min: "", max: "", show: "all", group: "none", sold: false
  });

  const P = {
    active: false,
    bound: false,
    release: null,
    onClose: null,
    items: [],
    inRelease: new Set(),
    selected: new Set(),
    lastDropAt: 0,
    f: defaults()
  };

  // When a release actually dropped: the manual launch time, or its schedule
  // once that moment has passed.
  function dropTime(edit, now) {
    if (edit.launched_at) return Date.parse(edit.launched_at);
    if (edit.publish_at && Date.parse(edit.publish_at) <= now) return Date.parse(edit.publish_at);
    return NaN;
  }

  async function open(release, opts = {}) {
    P.release = release;
    P.onClose = opts.onClose || null;
    P.selected = new Set();
    P.f = defaults();
    P.active = true;
    bind();

    adminMain.innerHTML = `<p class="admin-empty">Loading the pick board…</p>`;

    let candidates, history, current, edits;
    try {
      [candidates, history, current, edits] = await Promise.all([
        A().getPickCandidates(),
        A().getPlacementHistory(),
        A().getPlacementsFull(release.id),
        A().getEdits()
      ]);
    } catch (e) {
      adminMain.innerHTML = `
        <button type="button" class="btn" data-pb="back">← Back</button>
        <p class="admin-empty" style="margin-top:14px;">Could not load the pick board: ${esc(e.message || e)}</p>`;
      return;
    }

    const now = Date.now();
    P.inRelease = new Set(current.map(pl => pl.product_id));
    P.lastDropAt = edits
      .filter(e => e.id !== release.id)
      .reduce((latest, e) => {
        const t = dropTime(e, now);
        return Number.isFinite(t) && t > latest ? t : latest;
      }, 0);

    // Earlier drops each piece has been in, newest first, not counting this one.
    const earlier = new Map();
    history.forEach(h => {
      if (h.edit_id === release.id || !h.edits) return;
      if (!earlier.has(h.product_id)) earlier.set(h.product_id, []);
      earlier.get(h.product_id).push(h.edits);
    });
    earlier.forEach(list => list.sort((a, b) => (b.number || 0) - (a.number || 0)));

    P.items = candidates.map(p => {
      const acceptedAt = Date.parse(p.reviewed_at || p.updated_at || p.created_at);
      const dropped = earlier.get(p.id) || [];
      return {
        ...p,
        _history: dropped,
        // New: never dropped, and accepted after the last drop (or nothing has dropped yet).
        _isNew: dropped.length === 0 && (P.lastDropAt === 0 || acceptedAt > P.lastDropAt)
      };
    });

    drawShell();
    drawGrid();
    drawTray();
  }

  function close(count) {
    P.active = false;
    if (P.onClose) P.onClose(count || 0);
  }

  /* —— Page shell: built once so typing in a filter never loses focus —— */
  function optionList(entries, current, allLabel) {
    return `<option value="">${esc(allLabel)}</option>` + entries.map(e =>
      `<option value="${esc(e.value)}"${e.value === current ? " selected" : ""}>${esc(e.label)}</option>`).join("");
  }

  function drawShell() {
    const sellers = new Map();
    P.items.forEach(p => {
      const s = p.suppliers || {};
      const entry = sellers.get(p.supplier_id) || { value: p.supplier_id, name: s.name || "Unknown", type: s.type, n: 0 };
      entry.n += 1;
      sellers.set(p.supplier_id, entry);
    });
    const sellerEntries = [...sellers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => ({ value: s.value, label: `${s.name}: ${s.n}` }));
    const uniq = key => [...new Set(P.items.map(p => (p[key] || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)).map(v => ({ value: v, label: v }));

    const r = P.release;
    adminMain.innerHTML = `
      <div class="pb">
        <div class="pb-head">
          <button type="button" class="btn" data-pb="back">← Back to ${esc(folderName(r))}</button>
          <div>
            <span class="section-bar__label">Pick board</span>
            <h2 class="pb-title">${esc(folderName(r))}${r.title ? `: ${esc(r.title)}` : ""}</h2>
          </div>
        </div>
        <p class="rel-note">Accepted pieces that are not hidden by their seller. Click a card to pick it. Picking does not publish anything: the drop time does.</p>

        <div class="pb-filters" role="search">
          <input type="search" class="pb-search" data-pb-f="q" placeholder="Search brand, title, seller, size…" aria-label="Search pieces" />
          <select data-pb-f="seller" aria-label="Seller">${optionList(sellerEntries, "", "All sellers")}</select>
          <select data-pb-f="brand" aria-label="Brand">${optionList(uniq("brand"), "", "All brands")}</select>
          <select data-pb-f="category" aria-label="Category">${optionList(uniq("category"), "", "All categories")}</select>
          <span class="pb-price">
            <input type="number" min="0" step="1" inputmode="numeric" data-pb-f="min" placeholder="Min $" aria-label="Minimum price" />
            <input type="number" min="0" step="1" inputmode="numeric" data-pb-f="max" placeholder="Max $" aria-label="Maximum price" />
          </span>
          <select data-pb-f="show" aria-label="Drop history">
            <option value="all">All pieces</option>
            <option value="new">New since the last drop</option>
            <option value="never">Never dropped</option>
            <option value="before">Dropped before</option>
          </select>
          <select data-pb-f="group" aria-label="Group by">
            <option value="none">No grouping</option>
            <option value="seller">Group by seller</option>
          </select>
          <label class="pb-check-label"><input type="checkbox" data-pb-f="sold" /> Show sold out</label>
        </div>

        <div class="pb-summary" id="pbSummary"></div>
        <div id="pbGrid"></div>
        <div class="pb-tray" id="pbTray" role="region" aria-label="Picked pieces"></div>
      </div>`;
  }

  /* —— Filtering —— */
  function visible() {
    const f = P.f;
    const q = f.q.trim().toLowerCase();
    const min = f.min === "" ? null : Math.round(Number(f.min) * 100);
    const max = f.max === "" ? null : Math.round(Number(f.max) * 100);
    return P.items.filter(p => {
      if (!f.sold && Number(p.quantity) === 0) return false;
      if (f.seller && p.supplier_id !== f.seller) return false;
      if (f.brand && (p.brand || "").trim() !== f.brand) return false;
      if (f.category && (p.category || "").trim() !== f.category) return false;
      if (min !== null && (p.price_cents === null || p.price_cents < min)) return false;
      if (max !== null && (p.price_cents === null || p.price_cents > max)) return false;
      if (f.show === "new" && !p._isNew) return false;
      if (f.show === "never" && p._history.length) return false;
      if (f.show === "before" && !p._history.length) return false;
      if (q) {
        const hay = [p.title, p.brand, p.category, p.color, p.material, p.size, (p.suppliers || {}).name]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* —— Cards —— */
  function badgesHTML(p, inRel) {
    const out = [];
    if (inRel) out.push(`<span class="pb-badge pb-badge--in">In this release</span>`);
    if (p._isNew && P.lastDropAt > 0) out.push(`<span class="pb-badge pb-badge--new">New</span>`);
    if (p._history.length) {
      out.push(`<span class="pb-badge pb-badge--seen">${p._history.length === 1
        ? `In ${esc(folderName(p._history[0]))}` : `In ${p._history.length} drops`}</span>`);
    }
    if (p.is_available === false) out.push(`<span class="pb-badge pb-badge--hold">On hold</span>`);
    if (Number(p.quantity) === 0) out.push(`<span class="pb-badge pb-badge--hold">Sold out</span>`);
    return out.join("");
  }

  function cardHTML(p) {
    const inRel = P.inRelease.has(p.id);
    const sel = P.selected.has(p.id);
    const img = sortedImages(p)[0];
    const s = p.suppliers || {};
    const qty = Number(p.quantity);
    return `
      <button type="button" class="pb-card${sel ? " is-selected" : ""}${inRel ? " is-in" : ""}"
              data-pb="toggle" data-id="${esc(p.id)}" aria-pressed="${sel}"${inRel ? " disabled" : ""}>
        <span class="pb-photo">
          ${img ? `<img src="${esc(A().productImageUrl(img.path))}" alt="" loading="lazy" />`
                : `<span class="pb-nophoto">No photo</span>`}
          <span class="pb-tick" aria-hidden="true">✓</span>
          <span class="pb-badges">${badgesHTML(p, inRel)}</span>
        </span>
        <span class="pb-meta">
          <span class="pb-brand">${esc(p.brand || "No brand")}</span>
          <span class="pb-name">${esc(p.title || "Untitled")}</span>
          <span class="pb-line">${p.size ? `${esc(p.size)} · ` : ""}${usd(p.price_cents)}${qty > 1 ? ` · qty ${qty}` : ""}</span>
          <span class="pb-seller">${esc(s.name || "Unknown seller")}<i>${esc(TYPE_LABEL[s.type] || "")}</i></span>
        </span>
      </button>`;
  }

  function drawGrid() {
    const host = document.getElementById("pbGrid");
    if (!host) return;
    const list = visible();

    const summary = document.getElementById("pbSummary");
    if (summary) {
      const pickable = list.filter(p => !P.inRelease.has(p.id));
      summary.innerHTML = `
        <span>${list.length} of ${P.items.length} pieces shown</span>
        <span class="pb-summary__actions">
          ${pickable.length ? `<button type="button" class="pb-link" data-pb="pick-shown">Pick all ${pickable.length} shown</button>` : ""}
          ${list.some(p => P.selected.has(p.id)) ? `<button type="button" class="pb-link" data-pb="clear-shown">Clear shown</button>` : ""}
        </span>`;
    }

    if (!P.items.length) {
      host.innerHTML = `<p class="admin-empty">Nothing is accepted yet. Accept pieces in Supply, Review Queue first.</p>`;
      return;
    }
    if (!list.length) {
      host.innerHTML = `<p class="admin-empty">No pieces match these filters.</p>`;
      return;
    }

    if (P.f.group === "seller") {
      const groups = new Map();
      list.forEach(p => {
        const key = p.supplier_id;
        if (!groups.has(key)) groups.set(key, { s: p.suppliers || {}, items: [] });
        groups.get(key).items.push(p);
      });
      host.innerHTML = [...groups.values()]
        .sort((a, b) => String(a.s.name || "").localeCompare(String(b.s.name || "")))
        .map(g => `
          <section class="pb-group">
            <h3 class="pb-group__title">${esc(g.s.name || "Unknown seller")}
              <i>${esc(TYPE_LABEL[g.s.type] || "")}</i><b>${g.items.length}</b></h3>
            <div class="pb-grid">${g.items.map(cardHTML).join("")}</div>
          </section>`).join("");
    } else {
      host.innerHTML = `<div class="pb-grid">${list.map(cardHTML).join("")}</div>`;
    }
  }

  /* —— Tray: what is picked, and who it is from —— */
  function drawTray(message, isError) {
    const tray = document.getElementById("pbTray");
    if (!tray) return;
    const picked = P.items.filter(p => P.selected.has(p.id));
    const bySeller = new Map();
    picked.forEach(p => {
      const name = (p.suppliers || {}).name || "Unknown";
      bySeller.set(name, (bySeller.get(name) || 0) + 1);
    });
    const held = picked.filter(p => p.is_available === false).length;
    const name = folderName(P.release);

    tray.innerHTML = `
      <div class="pb-tray__main">
        <strong class="pb-tray__count">${picked.length} picked for ${esc(name)}</strong>
        <span class="pb-tray__sellers">${[...bySeller].map(([n, c]) => `${esc(n)} ${c}`).join(" · ") || "Nothing picked yet."}</span>
        ${P.inRelease.size ? `<span class="pb-tray__note">${P.inRelease.size} already in this release.</span>` : ""}
        ${held ? `<span class="pb-tray__note pb-tray__note--warn">${held} on hold, so unavailable until cleared.</span>` : ""}
        ${message ? `<span class="pb-tray__note${isError ? " pb-tray__note--warn" : ""}">${esc(message)}</span>` : ""}
      </div>
      <div class="pb-tray__actions">
        <button type="button" class="btn" data-pb="clear"${picked.length ? "" : " disabled"}>Clear</button>
        <button type="button" class="btn btn--primary" data-pb="confirm"${picked.length ? "" : " disabled"}>Add ${picked.length || ""} to ${esc(name)}</button>
      </div>`;
  }

  /* —— Events —— */
  function bind() {
    if (P.bound) return;
    P.bound = true;
    adminMain.addEventListener("click", onClick);
    adminMain.addEventListener("input", onFilter);
    adminMain.addEventListener("change", onFilter);
  }

  function onFilter(e) {
    const el = e.target.closest("[data-pb-f]");
    if (!el || !P.active) return;
    const key = el.dataset.pbF;
    P.f[key] = el.type === "checkbox" ? el.checked : el.value;
    drawGrid();
  }

  async function onClick(e) {
    const el = e.target.closest("[data-pb]");
    if (!el || !P.active) return;
    switch (el.dataset.pb) {
      case "back": close(0); break;
      case "toggle": {
        const id = el.dataset.id;
        if (P.inRelease.has(id)) break;
        if (P.selected.has(id)) P.selected.delete(id); else P.selected.add(id);
        // Update the one card in place so the page does not jump.
        const on = P.selected.has(id);
        el.classList.toggle("is-selected", on);
        el.setAttribute("aria-pressed", String(on));
        drawTray();
        drawSummaryOnly();
        break;
      }
      case "pick-shown": visible().forEach(p => { if (!P.inRelease.has(p.id)) P.selected.add(p.id); }); drawGrid(); drawTray(); break;
      case "clear-shown": visible().forEach(p => P.selected.delete(p.id)); drawGrid(); drawTray(); break;
      case "clear": P.selected.clear(); drawGrid(); drawTray(); break;
      case "confirm": await confirmPicks(el); break;
      default: break;
    }
  }

  // Only the "pick all / clear" links depend on the selection.
  function drawSummaryOnly() {
    const summary = document.getElementById("pbSummary");
    if (!summary) return;
    const list = visible();
    const pickable = list.filter(p => !P.inRelease.has(p.id));
    summary.innerHTML = `
      <span>${list.length} of ${P.items.length} pieces shown</span>
      <span class="pb-summary__actions">
        ${pickable.length ? `<button type="button" class="pb-link" data-pb="pick-shown">Pick all ${pickable.length} shown</button>` : ""}
        ${list.some(p => P.selected.has(p.id)) ? `<button type="button" class="pb-link" data-pb="clear-shown">Clear shown</button>` : ""}
      </span>`;
  }

  async function confirmPicks(button) {
    const ids = [...P.selected];
    if (!ids.length) return;
    button.disabled = true;
    button.textContent = "Adding…";

    let added = 0;
    const failed = [];
    for (const id of ids) {
      try {
        await A().addPlacement(P.release.id, id);
        P.inRelease.add(id);
        P.selected.delete(id);
        added += 1;
        try { await A().addReleaseEvent(P.release.id, "product_added", { product: id }); }
        catch (e) { /* the activity log is best effort */ }
      } catch (err) {
        failed.push(id);
      }
    }

    if (!failed.length) { close(added); return; }
    // Some failed: stay on the board with those still picked.
    drawGrid();
    drawTray(`${added} added, ${failed.length} could not be added. Try those again.`, true);
  }

  /* ============================================================
     Needs-you strip
     ============================================================ */
  let nyToken = 0;

  function daysAgo(iso) {
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  async function mountNeedsYou() {
    if (!A() || typeof adminMain === "undefined") return;
    const token = ++nyToken;
    const view = state.view;

    let products, members, invites, suppliers;
    try {
      [products, members, invites, suppliers] = await Promise.all([
        A().getProductSummaries(), A().getSupplierMembers(), A().getOpenInvites(), A().getSuppliers()
      ]);
    } catch (e) { return; }
    // A newer render, or another view, took over while this loaded.
    if (token !== nyToken || state.view !== view || P.activeBoardOpen()) return;

    // Keep only the newest unused invite per supplier and email: repeat
    // clicks on + Invite leave older rows behind, and they are the same ask.
    const newest = new Map();
    invites.forEach(i => {
      const key = `${i.supplier_id}|${String(i.email).toLowerCase()}`;
      const seen = newest.get(key);
      if (!seen || Date.parse(i.created_at) > Date.parse(seen.created_at)) newest.set(key, i);
    });
    invites = [...newest.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

    const review = products.filter(p => p.state === "submitted").length;
    const holds = products.filter(p => p.state === "accepted" && p.is_available === false && !p.is_hidden).length;
    const prices = products.filter(p => p.proposed_price_cents !== null && p.proposed_price_cents !== undefined).length;

    const name = id => (suppliers.find(s => s.id === id) || {}).name || "a supplier";
    const memberIds = new Set(members.map(m => m.supplier_id));
    const withProducts = new Set(products.map(p => p.supplier_id));
    const quiet = suppliers.filter(s => s.type !== "poda" && memberIds.has(s.id) && !withProducts.has(s.id));

    const chips = [];
    if (review) chips.push({ go: "review", label: `${plural(review, "piece", "pieces")} awaiting review`, hot: true });
    if (holds) chips.push({ go: "inventory", label: `${plural(holds, "piece", "pieces")} on hold after a seller edit`, hot: true });
    if (prices) chips.push({ go: "inventory", label: `${plural(prices, "price change", "price changes")} to approve`, hot: true });
    if (invites.length) chips.push({ go: "suppliers", label: `${plural(invites.length, "invite", "invites")} not accepted yet` });
    if (quiet.length) chips.push({ go: "suppliers", label: `${plural(quiet.length, "seller", "sellers")} joined but uploaded nothing` });

    const old = document.getElementById("needsYou");
    if (old) old.remove();
    if (!chips.length) return;

    const detail = [
      ...invites.map(i => `${esc(i.email)} for ${esc(name(i.supplier_id))}, invited ${esc(daysAgo(i.created_at))} <button type="button" class="ny-revoke" data-revoke-supplier="${esc(i.supplier_id)}" data-revoke-email="${esc(i.email)}">Revoke</button>`),
      ...quiet.map(s => `${esc(s.name)} has joined and has not uploaded anything`)
    ];

    adminMain.insertAdjacentHTML("afterbegin", `
      <section class="ny" id="needsYou" aria-label="Needs you">
        <span class="ny-label">Needs you</span>
        <div class="ny-chips">
          ${chips.map(c => `<button type="button" class="ny-chip${c.hot ? " ny-chip--hot" : ""}" data-ny="${c.go}">${esc(c.label)} →</button>`).join("")}
        </div>
        ${detail.length ? `<ul class="ny-detail">${detail.map(d => `<li>${d}</li>`).join("")}</ul>` : ""}
      </section>`);

    document.getElementById("needsYou").addEventListener("click", async e => {
      const revoke = e.target.closest("[data-revoke-email]");
      if (revoke) {
        const email = revoke.dataset.revokeEmail;
        if (!confirm(`Revoke the invite for ${email}? Their link will stop working.`)) return;
        revoke.disabled = true;
        try {
          await A().revokeInvites(revoke.dataset.revokeSupplier, email);
        } catch (err) {
          revoke.disabled = false;
          alert(err && err.message ? err.message : "Could not revoke the invite.");
          return;
        }
        mountNeedsYou();
        return;
      }
      const btn = e.target.closest("[data-ny]");
      if (!btn) return;
      window.PodaRelease.showSupply(btn.dataset.ny);
    });
  }

  // True while the pick board owns the page, so the strip stays off it.
  P.activeBoardOpen = () => P.active && !!document.getElementById("pbGrid");

  window.PodaPickBoard = { open, mountNeedsYou };
})();
