/* ============================================================
   casestudy.js: the four step walkthrough on /build.
   Everything here is simulated in the page. It loads no Supabase client,
   calls no /api route and starts no Stripe session, so no real account,
   upload, order, payment or payout can happen from these pages.

   Buttons marked data-advance finish their step and move to the next one.
   On the last step they finish the demo and offer a restart. The /build
   page uses named actions (submit, approve, buy) for the same thing.
   ============================================================ */
(function () {
  "use strict";

  var root = document.getElementById("demo");
  if (!root) return;

  // The example sale: a $200 jacket at an illustrative 20% commission.
  var PRICE_CENTS = 20000;
  var RATE_BPS = 2000;
  // Same rule the real order logic uses: round(price * rate in basis points / 10000).
  var COMMISSION_CENTS = Math.round(PRICE_CENTS * RATE_BPS / 10000);
  var SELLER_CENTS = PRICE_CENTS - COMMISSION_CENTS;

  var panels = Array.prototype.slice.call(root.querySelectorAll("[data-panel]"));
  var steps = Array.prototype.slice.call(root.querySelectorAll("[data-step]"));
  var live = root.querySelector("[data-live]");
  var declineNote = root.querySelector("[data-decline-note]");
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // How long a finished action stays visible before the next step appears.
  var PAUSE_MS = reducedMotion ? 350 : 800;

  var current = 0;
  var busy = false;

  function usd(cents) {
    var whole = cents % 100 === 0;
    return "$" + (cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  // Fill the split from the numbers above so the page and the math cannot disagree.
  function fill() {
    var text = {
      price: usd(PRICE_CENTS),
      commission: usd(COMMISSION_CENTS),
      seller: usd(SELLER_CENTS),
      rate: (RATE_BPS / 100) + "%"
    };
    Object.keys(text).forEach(function (key) {
      Array.prototype.forEach.call(root.querySelectorAll('[data-fill="' + key + '"]'), function (el) {
        el.textContent = text[key];
      });
    });
    var sellerShare = (SELLER_CENTS / PRICE_CENTS) * 100;
    var seller = root.querySelector('[data-fill-width="seller"]');
    var poda = root.querySelector('[data-fill-width="commission"]');
    if (seller) seller.style.width = sellerShare + "%";
    if (poda) poda.style.width = (100 - sellerShare) + "%";
    root.style.setProperty("--seller-pct", sellerShare + "%");
    var split = root.querySelector("[data-split]");
    if (split) {
      split.setAttribute("aria-label", "The " + text.price + " sale splits into " + text.seller + " for the seller and " + text.commission + " for Poda.");
    }
  }

  function setLocked(panel, locked, selector) {
    Array.prototype.forEach.call(panel.querySelectorAll(selector || "button"), function (btn) {
      if (locked) btn.setAttribute("disabled", "");
      else btn.removeAttribute("disabled");
    });
  }

  // Show one step. When the visitor caused the change, move focus to its button.
  function go(index, moveFocus) {
    current = index;
    panels.forEach(function (panel, i) {
      var active = i === index;
      panel.classList.toggle("is-active", active);
      if (active) panel.removeAttribute("inert");
      else panel.setAttribute("inert", "");
    });
    steps.forEach(function (step, i) {
      step.classList.toggle("is-done", i < index);
      step.classList.toggle("is-current", i === index);
      if (i === index) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    live.textContent = "Step " + (index + 1) + " of " + panels.length + ": " + panels[index].getAttribute("data-title") + ".";
    if (moveFocus) {
      var target = panels[index].querySelector("[data-primary]");
      if (target) target.focus({ preventScroll: true });
    }
  }

  // Mark the current step finished, hold for a moment, then move on.
  function finish(panel, next) {
    busy = true;
    var last = next >= panels.length;
    panel.setAttribute("data-state", "done");
    // On the last step only the action locks, so the restart button stays usable.
    setLocked(panel, true, last ? "[data-advance]" : null);
    var card = panel.querySelector("[data-card]");
    // The item leaves the view it was in: always from step one on /build, and
    // from any step whose card is marked data-sends.
    if (card && !last && (next === 1 || card.hasAttribute("data-sends"))) card.classList.add("is-sent");
    window.setTimeout(function () {
      busy = false;
      if (last) {
        live.textContent = "Demo complete. Restart to run it again.";
        var again = panel.querySelector('[data-action="restart"]');
        if (again) again.focus({ preventScroll: true });
        return;
      }
      go(next, true);
    }, PAUSE_MS);
  }

  function restart() {
    panels.forEach(function (panel) {
      panel.setAttribute("data-state", "idle");
      setLocked(panel, false);
      var card = panel.querySelector("[data-card]");
      if (card) card.classList.remove("is-sent");
    });
    if (declineNote) declineNote.hidden = true;
    go(0, true);
    var box = root.getBoundingClientRect();
    if (box.top < 0) root.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }

  root.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action], [data-advance]");
    if (!button || busy) return;
    var panel = button.closest("[data-panel]");
    if (button.hasAttribute("data-advance")) {
      finish(panel, panels.indexOf(panel) + 1);
      return;
    }
    switch (button.getAttribute("data-action")) {
      case "submit": finish(panel, 1); break;
      case "approve": finish(panel, 2); break;
      case "buy": finish(panel, 3); break;
      case "decline": if (declineNote) declineNote.hidden = false; break;
      case "restart": restart(); break;
    }
  });

  fill();
  go(0, false);
})();
