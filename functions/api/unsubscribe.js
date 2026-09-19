/* ============================================================
   POST /api/unsubscribe — Cloudflare Pages Function
   Public endpoint: takes the unguessable token from an email's
   unsubscribe link and flips that subscriber's status via the
   `unsubscribe_by_token` Postgres function (SECURITY DEFINER —
   see RESEND_SETUP.md). No auth required; the token IS the
   credential. Subscriber RLS itself is never touched here.
   ============================================================ */

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request." });
  }

  const token = String((payload && payload.token) || "").trim();
  if (!token) return json(400, { error: "Missing token." });

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/unsubscribe_by_token`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({ p_token: token })
    });
  } catch (e) {
    return json(502, { error: "Could not reach the server. Please try again." });
  }

  if (!res.ok) {
    return json(502, { error: "Could not process the request." });
  }

  const result = await res.json().catch(() => null);
  const outcome = typeof result === "string" ? result : "not_found";

  if (outcome === "ok") return json(200, { status: "ok", message: "You've been unsubscribed." });
  if (outcome === "already") return json(200, { status: "already", message: "You were already unsubscribed." });
  return json(200, { status: "not_found", message: "We couldn't find that subscription." });
}

export async function onRequestGet() {
  return json(405, { error: "Method not allowed." });
}
