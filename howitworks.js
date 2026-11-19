/* ============================================================
   howitworks.js: the seven screen click-through on /how-it-works.

   Everything stays in the page. It loads no Supabase client, calls no /api
   route and stores nothing: the category picked on screen 3 lives in a
   variable and is gone on reload. The two links on the last screen go to the
   normal application (sell.html) and sign in (seller.html) pages, so the
   usual approval step still applies.

   Without JavaScript the screens stack, so the page still reads.
   ============================================================ */
(function () {
  "use strict";

  var root = document.getElementById("hiw");
  if (!root) return;

  var screens = Array.prototype.slice.call(root.querySelectorAll("[data-screen]"));
  var choices = Array.prototype.slice.call(root.querySelectorAll("[data-choice]"));
  var lists = Array.prototype.slice.call(root.querySelectorAll("[data-cat-list]"));
  var prev = root.querySelector("[data-prev]");
  var next = root.querySelector("[data-next]");
  var tab = root.querySelector("[data-tab]");
  var count = root.querySelector("[data-count]");
  var bar = root.querySelector("[data-bar]");
  var hint = root.querySelector("[data-hint]");
  var live = root.querySelector("[data-live]");
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Screen 3 is the one that needs an answer before moving on.
  var CHOOSE = 2;
  var index = 0;
  var category = "";

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // One segment per screen, like the application form.
  bar.innerHTML = screens.map(function () { return "<i></i>"; }).join("");
  var segments = Array.prototype.slice.call(bar.children);

  // Show only the examples for the chosen category on screen 4.
  function showCategory() {
    lists.forEach(function (list) {
      list.hidden = list.getAttribute("data-cat-list") !== category;
    });
    choices.forEach(function (btn) {
      var on = btn.getAttribute("data-choice") === category;
      btn.classList.toggle("is-selected", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (hint) hint.hidden = !!category;
  }

  function render(moveFocus) {
    screens.forEach(function (screen, i) {
      var active = i === index;
      screen.hidden = !active;
      if (active) {
        screen.classList.remove("is-in");
        if (!reducedMotion) { void screen.offsetWidth; screen.classList.add("is-in"); }
      }
    });
    var title = screens[index].getAttribute("data-title");
    tab.textContent = title;
    count.textContent = pad(index + 1) + " / " + pad(screens.length);
    segments.forEach(function (seg, i) { seg.className = i <= index ? "is-done" : ""; });

    prev.hidden = index === 0;
    next.hidden = index === screens.length - 1;
    next.disabled = index === CHOOSE && !category;
    live.textContent = "Screen " + (index + 1) + " of " + screens.length + ": " + title + ".";

    if (moveFocus) {
      // Keep focus on the arrow that was pressed. Only when that arrow just
      // disappeared or locked does focus go to the new screen instead.
      var here = document.activeElement;
      var lost = !here || here === document.body || here.disabled || here.hidden || here.closest("[hidden]");
      if (lost) {
        var target = index === CHOOSE && !category
          ? screens[index].querySelector("[data-choice]")
          : screens[index].querySelector("[data-focus]");
        if (target) target.focus({ preventScroll: true });
      }
    }
  }

  function go(to) {
    if (to < 0 || to >= screens.length) return;
    if (to > index && index === CHOOSE && !category) return;
    index = to;
    render(true);
  }

  choices.forEach(function (btn) {
    btn.addEventListener("click", function () {
      category = btn.getAttribute("data-choice");
      showCategory();
      next.disabled = false;
      live.textContent = btn.querySelector("span").textContent + " selected. Continue when you are ready.";
    });
  });

  prev.addEventListener("click", function () { go(index - 1); });
  next.addEventListener("click", function () { go(index + 1); });

  root.classList.add("is-live");
  showCategory();
  render(false);
})();
