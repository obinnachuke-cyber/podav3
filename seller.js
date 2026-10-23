/* ============================================================
   seller.js — Seller portal: invite redemption, sign-in, shell.
   Inventory/upload/submission-status/withdraw build out inside
   #sellerMain next — this pass is the auth gate they all sit behind.
   ============================================================ */
"use strict";

const sellerLoading = document.getElementById("sellerLoading");
const inviteGate     = document.getElementById("inviteGate");
const loginGate      = document.getElementById("loginGate");
const sellerApp      = document.getElementById("sellerApp");

function showOnly(el) {
  [sellerLoading, inviteGate, loginGate, sellerApp].forEach(e => { e.hidden = e !== el; });
}

function inviteTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("invite");
}

async function startSellerApp() {
  let supplier = null;
  try { supplier = await window.PodaMarketplace.mySupplier(); }
  catch (e) { /* fall through — shown as "not linked" below */ }

  document.getElementById("sellerSupplierName").textContent = supplier
    ? supplier.name
    : "Not linked to a supplier yet";

  if (!supplier) {
    document.getElementById("sellerMain").innerHTML =
      `<p class="admin-empty">Your account isn't linked to a supplier yet. If you followed an invite link, try it again — otherwise, contact poda.</p>`;
  }

  showOnly(sellerApp);
}

async function init() {
  if (!window.PodaDB || !window.PodaDB.isConfigured) {
    sellerLoading.querySelector(".login-sub").textContent =
      "The database is not configured yet. See SUPABASE_SETUP.md.";
    return;
  }

  const token = inviteTokenFromUrl();

  if (token) {
    let invite = null;
    try { invite = await window.PodaMarketplace.getInviteByToken(token); } catch (e) { /* treated as invalid below */ }

    if (!invite) {
      showOnly(loginGate);
      document.getElementById("loginError").hidden = false;
      document.getElementById("loginError").textContent = "That invite link is invalid or has already been used.";
      return;
    }

    const session = await window.PodaDB.getSession();
    if (session) {
      // Already signed in (e.g. re-clicked their own invite link) — just
      // redeem it against the session they already have.
      try {
        await window.PodaMarketplace.redeemSupplierInvite(token);
      } catch (e) { /* already used by this same account is fine; ignore */ }
      await startSellerApp();
      return;
    }

    document.getElementById("inviteSupplierName").textContent =
      `You've been invited to join ${invite.suppliers ? invite.suppliers.name : "poda"}`;
    document.getElementById("inviteEmail").value = invite.email;
    showOnly(inviteGate);
    return;
  }

  const session = await window.PodaDB.getSession();
  if (session) {
    await startSellerApp();
  } else {
    showOnly(loginGate);
  }
}

document.getElementById("inviteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorBox = document.getElementById("inviteError");
  errorBox.hidden = true;
  const email = document.getElementById("inviteEmail").value;
  const password = document.getElementById("invitePassword").value;
  const token = inviteTokenFromUrl();

  try {
    await window.PodaDB.signUp(email, password);
    await window.PodaMarketplace.redeemSupplierInvite(token);
  } catch (e) {
    errorBox.textContent = e && e.message ? e.message : "Could not create your account.";
    errorBox.hidden = false;
    return;
  }

  await startSellerApp();
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorBox = document.getElementById("loginError");
  errorBox.hidden = true;
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  try {
    await window.PodaDB.signIn(email, password);
  } catch (e) {
    errorBox.textContent = e && e.message ? e.message : "Sign in failed. Check your email and password.";
    errorBox.hidden = false;
    return;
  }

  await startSellerApp();
});

document.getElementById("sellerLogoutBtn").addEventListener("click", async () => {
  await window.PodaDB.signOut();
  window.location.href = "seller.html";
});

init();
