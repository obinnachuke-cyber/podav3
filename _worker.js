/* ============================================================
   _worker.js — Cloudflare Worker entry point (Workers + Static Assets)

   This repo deploys as a single Cloudflare Worker with a static-assets
   binding (see wrangler.toml: `main` points to this file, copied into
   dist/_worker.js by build.js; `[assets]` binds the rest of dist/ as
   env.ASSETS). Cloudflare requires a real Worker script — not just a
   static-assets binding — before it will accept runtime variables or
   secrets, which is exactly what this file provides.

   Routing: two POST API routes are handled here; every other request
   (the whole static site) falls straight through to env.ASSETS.fetch().

   Secrets (RESEND_API_KEY, ADMIN_EMAIL) and plain vars (SUPABASE_URL,
   SUPABASE_ANON_KEY, SITE_URL) are read only from `env` — never
   hardcoded here, never logged, never sent to the browser.
   ============================================================ */

const RESEND_BATCH_LIMIT = 100;
const FROM_ADDRESS = "Poda <notes@podapodapoda.co>";
const REPLY_TO = "notes@podapodapoda.co";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/* ============================================================
   /api/notes-send
   ============================================================ */

async function verifyAdmin(request, env, action = "send Market Notes") {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in required." };

  // A missing runtime variable looks exactly like a bad login from the
  // outside, so name it. Only the variable names are reported, never values.
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "ADMIN_EMAIL"].filter(k => !env[k]);
  if (missing.length) {
    return { ok: false, status: 500, error: `The server is missing: ${missing.join(", ")}. Set them in Cloudflare.` };
  }

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });
  } catch (e) {
    return { ok: false, status: 502, error: "Could not verify your session." };
  }
  if (!res.ok) {
    // Say what Supabase answered, so "bad key" and "bad login" can be told apart.
    const why = await res.json().catch(() => ({}));
    const detail = `Supabase said ${res.status}: ${why.msg || why.message || why.error_description || why.error || "no detail"}`;
    return { ok: false, status: 401, error: "Invalid or expired session.", detail };
  }

  const user = await res.json().catch(() => null);
  const email = String((user && user.email) || "").toLowerCase();
  const adminEmail = String(env.ADMIN_EMAIL || "").toLowerCase();
  if (!email || !adminEmail || email !== adminEmail) {
    return { ok: false, status: 403, error: `This account is not authorized to ${action}.` };
  }
  return { ok: true, token, email };
}

async function supabaseSelect(env, token, table, query) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`Supabase read failed (${table}): ${res.status}`);
  return res.json();
}

async function supabaseInsert(env, token, table, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase write failed (${table}): ${res.status} ${detail}`);
  }
}

async function supabasePatch(env, token, table, query, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase update failed (${table}): ${res.status} ${detail}`);
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function plainExcerpt(note, maxLen = 220) {
  const source = note.subtitle || note.body || "";
  const text = String(source).replace(/\s+/g, " ").trim();
  if (!text) return "Read the latest from poda.";
  return text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text;
}

function noteSubject(note) {
  return note.title ? `poda Inbox: ${note.title}` : "poda Inbox";
}

// Notes written in the Market Note Publishing Studio (Module 3) carry a
// pre-rendered emailHtml fragment, generated from the same canonical
// Tiptap JSON as the website (src/editor/render-email.js), stored at
// save/publish time. Older notes have no emailHtml — those keep the
// original excerpt-and-link teaser exactly as before.
function buildEmail(note, siteUrl, unsubscribeUrl) {
  const noteUrl = `${siteUrl}/note.html?id=${encodeURIComponent(note.id)}`;
  const subject = (note.emailSubject && note.emailSubject.trim()) || noteSubject(note);
  const issueLabel = note.issueNumber ? `No. ${escapeHTML(String(note.issueNumber))}` : "Market Note";

  const imageBlock = note.coverImage
    ? `<tr><td style="padding:0 28px 20px;"><img src="${escapeHTML(note.coverImage)}" alt="${escapeHTML(note.coverImageAlt || "")}" width="100%" style="display:block;max-width:100%;border:1px solid #26262a;" /></td></tr>`
    : "";

  const bodyBlock = note.emailHtml
    ? `<tr><td style="padding:0 28px 28px;">${String(note.emailHtml).split("%%SITE_URL%%").join(siteUrl)}</td></tr>`
    : `
      <tr>
        <td style="padding:0 28px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333333;">${escapeHTML(plainExcerpt(note))}</td>
      </tr>
      <tr>
        <td style="padding:0 28px 32px;">
          <a href="${noteUrl}" style="display:inline-block;background:#090909;color:#ffffff;text-decoration:none;font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;padding:14px 24px;">Read the full note &rarr;</a>
        </td>
      </tr>`;

  const previewTextBlock = note.emailPreviewText
    ? `<tr><td style="padding:0 28px 20px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#666666;">${escapeHTML(note.emailPreviewText)}</td></tr>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f3;font-family:Georgia,'Times New Roman',serif;color:#090909;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #26262a;">
            <tr>
              <td style="padding:24px 28px 20px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#555555;">poda &middot; ${issueLabel}</td>
            </tr>
            ${imageBlock}
            <tr>
              <td style="padding:0 28px 12px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.1;font-weight:600;color:#090909;">${escapeHTML(note.title || "poda")}</td>
            </tr>
            ${previewTextBlock}
            ${bodyBlock}
            <tr>
              <td style="padding:20px 28px;border-top:1px solid #26262a;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.08em;color:#999790;">
                poda &mdash; selective retail / market intelligence<br />
                <a href="${unsubscribeUrl}" style="color:#999790;">Unsubscribe</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = note.emailHtml
    ? `${note.title || "poda"}\n\nRead online: ${noteUrl}\n\n—\npoda — selective retail / market intelligence\nUnsubscribe: ${unsubscribeUrl}`
    : `${note.title || "poda"}\n\n${plainExcerpt(note)}\n\nRead the full note: ${noteUrl}\n\n` +
      `—\npoda — selective retail / market intelligence\nUnsubscribe: ${unsubscribeUrl}`;

  return { subject, html, text };
}

async function sendViaResend(env, message) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(message)
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function sendBatchViaResend(env, messages) {
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(messages)
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function handleNotesSend(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  const noteId = payload && payload.noteId;
  const mode = payload && payload.mode;
  const confirm = payload && payload.confirm;
  const override = !!(payload && payload.override);

  if (!noteId || (mode !== "test" && mode !== "broadcast")) {
    return json(400, { error: "noteId and a valid mode ('test' or 'broadcast') are required." });
  }

  const auth = await verifyAdmin(request, env);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let notes;
  try {
    notes = await supabaseSelect(env, auth.token, "notes", `id=eq.${encodeURIComponent(noteId)}&select=data`);
  } catch (e) {
    return json(502, { error: "Could not load the note." });
  }
  const note = notes && notes[0] && notes[0].data;
  if (!note) return json(404, { error: "Note not found." });
  if (note.status !== "published") return json(400, { error: "Only a published note can be emailed." });

  const siteUrl = String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "");

  if (mode === "test") {
    const unsubscribeUrl = `${siteUrl}/unsubscribe.html?token=preview`;
    const { subject, html, text } = buildEmail(note, siteUrl, unsubscribeUrl);

    let result;
    try {
      result = await sendViaResend(env, {
        from: FROM_ADDRESS,
        to: [env.ADMIN_EMAIL],
        reply_to: REPLY_TO,
        subject: `[TEST] ${subject}`,
        html,
        text
      });
    } catch (e) {
      return json(502, { error: "Could not reach Resend." });
    }
    if (!result.ok) {
      return json(502, { error: "Resend rejected the test send.", detail: result.body });
    }
    return json(200, {
      ok: true,
      mode: "test",
      to: env.ADMIN_EMAIL,
      resendId: result.body && result.body.id
    });
  }

  if (confirm !== "SEND") {
    return json(400, { error: "Type SEND to confirm a broadcast." });
  }

  let priorLogs;
  try {
    priorLogs = await supabaseSelect(
      env, auth.token, "send_logs",
      `note_id=eq.${encodeURIComponent(noteId)}&type=eq.broadcast&status=eq.completed` +
      `&select=id,created_at,attempted,succeeded,failed&order=created_at.desc&limit=1`
    );
  } catch (e) {
    return json(502, { error: "Could not check prior sends." });
  }
  if (priorLogs && priorLogs.length && !override) {
    return json(409, {
      error: "This note has already been sent as a broadcast.",
      priorSend: priorLogs[0]
    });
  }

  let subscribers;
  try {
    subscribers = await supabaseSelect(env, auth.token, "subscribers", "select=id,data");
  } catch (e) {
    return json(502, { error: "Could not load subscribers." });
  }

  const active = (subscribers || []).filter(
    row => row.data && row.data.status === "ACTIVE" && String(row.data.email || "").trim()
  );
  const skipped = (subscribers || []).filter(
    row => row.data && row.data.status === "ACTIVE" && !String(row.data.email || "").trim()
  ).length;

  if (!active.length) {
    return json(400, { error: "No active subscribers to send to." });
  }

  const recipients = active.map(row => ({
    email: String(row.data.email).trim(),
    token: row.data.unsubscribeToken || null
  }));

  const subject = noteSubject(note);
  const messages = recipients.map(r => {
    const unsubscribeUrl = `${siteUrl}/unsubscribe.html?token=${encodeURIComponent(r.token || "")}`;
    const built = buildEmail(note, siteUrl, unsubscribeUrl);
    return {
      from: FROM_ADDRESS,
      to: [r.email],
      reply_to: REPLY_TO,
      subject: built.subject,
      html: built.html,
      text: built.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    };
  });

  const batches = chunk(messages, RESEND_BATCH_LIMIT);
  let succeeded = 0;
  let failed = 0;
  const resendIds = [];

  for (const batch of batches) {
    try {
      const result = await sendBatchViaResend(env, batch);
      const data = result.ok && result.body && Array.isArray(result.body.data) ? result.body.data : [];
      data.forEach(item => {
        if (item && item.id) {
          succeeded++;
          resendIds.push(item.id);
        } else {
          failed++;
        }
      });
      if (data.length < batch.length) failed += batch.length - data.length;
    } catch (e) {
      failed += batch.length;
    }
  }

  const attempted = messages.length;
  const status = failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";

  try {
    await supabaseInsert(env, auth.token, "send_logs", {
      note_id: noteId,
      subject,
      type: "broadcast",
      attempted,
      succeeded,
      failed,
      resend_ids: resendIds,
      admin_email: auth.email,
      status
    });
  } catch (e) {
    return json(200, {
      ok: true,
      mode: "broadcast",
      attempted,
      succeeded,
      failed,
      skipped,
      status,
      logWarning: "Send completed but the log entry failed to save."
    });
  }

  return json(200, { ok: true, mode: "broadcast", attempted, succeeded, failed, skipped, status });
}

/* ============================================================
   /api/unsubscribe
   ============================================================ */

async function handleUnsubscribe(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

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

/* ============================================================
   /api/submit-request — Sourcing Desk + Sell-with-poda forms.
   Public (no auth — anyone can submit a request/offer, same as
   before when this just opened a mailto draft). Sends straight to
   CONTACT_EMAIL server-side instead of relying on the visitor's
   own email client.
   ============================================================ */

// Abuse guards for the public submit endpoint. Each one costs a real person
// nothing and stops the cheapest kinds of spam from using up Resend quota.
const SUBMIT_MAX_BODY_BYTES = 20000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Browsers always send Origin on a POST. Requiring it to match this site's own
// host blocks other websites and naive scripts. It does not stop someone who
// forges the header, so the optional rate limiter below is the real brake.
function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

async function handleSubmitRequest(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (!isSameOrigin(request)) return json(403, { error: "Forbidden." });

  // Optional Cloudflare rate-limit binding (see wrangler.toml note). If it is
  // not configured the endpoint still works, just without this layer.
  if (env.SUBMIT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.SUBMIT_LIMITER.limit({ key: ip });
    if (!success) return json(429, { error: "Too many submissions. Please try again in a minute." });
  }

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > SUBMIT_MAX_BODY_BYTES) return json(413, { error: "Request too large." });
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  const clean = (value, max) => String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

  const subjectPrefix = clean(payload.subjectPrefix, 120) || "poda submission";
  const prompt = clean(payload.prompt, 120) || "Message";
  const name = clean(payload.name, 200);
  const email = clean(payload.email, 200);
  const instagram = clean(payload.instagram, 200);
  const message = String(payload.message || "").trim().slice(0, 5000);
  const photos = Array.isArray(payload.photos) ? payload.photos.slice(0, 10).map(u => String(u).trim()) : [];

  // The seller application has no free-text message: its photos stay in
  // private storage, so this email only announces it and carries a count.
  const isApplication = payload.kind === "application";
  const sellerType = clean(payload.sellerType, 60);
  const photoCount = Math.max(0, Math.min(12, parseInt(payload.photoCount, 10) || 0));

  if (!name || !email || (!message && !isApplication)) {
    return json(400, { error: "Name, email, and message are required." });
  }
  if (!EMAIL_RE.test(email)) {
    return json(400, { error: "Enter a valid email address." });
  }

  const contactEmail = env.CONTACT_EMAIL;
  if (!contactEmail) {
    return json(500, { error: "Contact email isn't configured." });
  }

  const lines = [
    `${subjectPrefix}:`, "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Instagram: ${instagram}`
  ];
  if (isApplication && sellerType) lines.push(`Type: ${sellerType}`);
  lines.push("");
  if (isApplication) {
    if (message) lines.push("Selling:", message, "");
    lines.push(`Photos: ${photoCount} (private)`);
    lines.push(`Review and decide: ${String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "")}/admin.html (Supply > Applications)`);
  } else {
    lines.push(`${prompt}:`, message);
  }
  if (!isApplication && photos.length) {
    lines.push("", "Photos:");
    photos.forEach(u => lines.push(u));
  }
  const text = lines.join("\n");
  const html = `<pre style="font-family:inherit;white-space:pre-wrap;word-wrap:break-word;">${escapeHTML(text)}</pre>`;

  let result;
  try {
    result = await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [contactEmail],
      reply_to: email,
      subject: `${subjectPrefix} — ${name}`,
      html,
      text
    });
  } catch (e) {
    return json(502, { error: "Could not reach Resend." });
  }
  if (!result.ok) {
    return json(502, { error: "Resend rejected the submission.", detail: result.body });
  }

  return json(200, { ok: true });
}

/* ============================================================
   /api/send-invite — emails a supplier their join link.
   Admin only. The browser sends just the invite token. The recipient
   address and supplier name are read from the database with the admin's
   own session, never taken from the request, so this can't be used to
   send mail to arbitrary addresses.
   ============================================================ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildInviteEmail(supplierName, joinUrl, siteUrl) {
  const name = escapeHTML(supplierName || "poda");
  const subject = `You're invited to sell with poda`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f2f1ed;font-family:Georgia,'Times New Roman',serif;color:#15151a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ed;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dcdbd6;">
            <tr>
              <td style="padding:32px 32px 8px;"><img src="${siteUrl}/logo-blue.png" alt="poda" height="30" style="display:block;height:30px;width:auto;" /></td>
            </tr>
            <tr>
              <td style="padding:0 32px 20px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8a8882;">Selective retail / market intelligence</td>
            </tr>
            <tr>
              <td style="padding:0 32px 14px;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.12;color:#15151a;">You're invited to join ${name}</td>
            </tr>
            <tr>
              <td style="padding:0 32px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a4a47;">
                Create your password to open your closet. Upload your pieces, add the details, and poda chooses what goes live.
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 30px;">
                <a href="${joinUrl}" style="display:inline-block;background:#15151a;color:#ffffff;text-decoration:none;font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;padding:15px 26px;">Create your account &rarr;</a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #dcdbd6;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.06em;line-height:1.6;color:#8a8882;">
                This link is for you only and works once. If the button does not work, paste this into your browser:<br />
                <span style="word-break:break-all;">${joinUrl}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `You're invited to join ${supplierName || "poda"}\n\n` +
    `Create your password to open your closet. Upload your pieces, add the details, and poda chooses what goes live.\n\n` +
    `Create your account: ${joinUrl}\n\n` +
    `This link is for you only and works once.\n\n— poda`;

  return { subject, html, text };
}

async function handleSendInvite(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  const token = String((payload && payload.token) || "").trim();
  if (!UUID_RE.test(token)) return json(400, { error: "A valid invite token is required." });

  const auth = await verifyAdmin(request, env, "send invites");
  if (!auth.ok) return json(auth.status, { error: auth.error, detail: auth.detail });

  let rows;
  try {
    rows = await supabaseSelect(
      env, auth.token, "supplier_invites",
      `token=eq.${encodeURIComponent(token)}&select=email,used_at,code,suppliers(name)`
    );
  } catch (e) {
    return json(502, { error: "Could not load the invite." });
  }
  const invite = rows && rows[0];
  if (!invite) return json(404, { error: "Invite not found." });
  if (invite.used_at) return json(409, { error: "This invite has already been used." });

  const siteUrl = String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "");
  const joinUrl = invite.code
    ? `${siteUrl}/join/${encodeURIComponent(invite.code)}`
    : `${siteUrl}/seller.html?invite=${encodeURIComponent(token)}`;
  const supplierName = invite.suppliers && invite.suppliers.name;
  const { subject, html, text } = buildInviteEmail(supplierName, joinUrl, siteUrl);

  let result;
  try {
    result = await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [invite.email],
      reply_to: REPLY_TO,
      subject,
      html,
      text
    });
  } catch (e) {
    return json(502, { error: "Could not reach Resend." });
  }
  if (!result.ok) {
    return json(502, { error: "Resend rejected the invite email.", detail: result.body });
  }
  return json(200, { ok: true, to: invite.email });
}


/* ============================================================
   /api/application-decision — emails an applicant that they were
   accepted or declined. Admin only. The browser sends just the
   application id: the recipient, name and decision are all read from
   the database with the admin's own session, so this cannot be used
   to mail arbitrary addresses or to send a decision that was never
   made. Once sent, `notified_status` records which decision was
   emailed, so a repeat call does not email the person twice.
   ============================================================ */

function buildDecisionEmail(name, decision, siteUrl) {
  const who = escapeHTML(name || "there");
  const accepted = decision === "accepted";
  const subject = "Your poda application";
  const headline = accepted ? "We’d like to work with you." : "Thank you for applying.";
  const body = accepted
    ? "Thanks for applying to sell with poda. We liked what you sent and would like to work with you. We’ll be in touch with next steps."
    : "Thanks for applying to sell with poda. We’re not able to take this one on right now. We appreciate you sharing it with us.";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f2f1ed;font-family:Georgia,'Times New Roman',serif;color:#15151a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ed;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dcdbd6;">
            <tr>
              <td style="padding:32px 32px 8px;"><img src="${siteUrl}/logo-blue.png" alt="poda" height="30" style="display:block;height:30px;width:auto;" /></td>
            </tr>
            <tr>
              <td style="padding:0 32px 20px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8a8882;">Selective retail / market intelligence</td>
            </tr>
            <tr>
              <td style="padding:0 32px 14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;color:#15151a;">${headline}</td>
            </tr>
            <tr>
              <td style="padding:0 32px 30px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a4a47;">
                Hi ${who},<br /><br />${body}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #dcdbd6;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.06em;line-height:1.6;color:#8a8882;">
                Reply to this email if you have a question.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `Hi ${name || "there"},\n\n${body}\n\nReply to this email if you have a question.\n\npoda`;
  return { subject, html, text };
}

async function handleApplicationDecision(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  const id = String((payload && payload.id) || "").trim();
  if (!UUID_RE.test(id)) return json(400, { error: "A valid application id is required." });

  const auth = await verifyAdmin(request, env, "email applicants");
  if (!auth.ok) return json(auth.status, { error: auth.error, detail: auth.detail });

  let rows;
  try {
    rows = await supabaseSelect(
      env, auth.token, "seller_applications",
      `id=eq.${encodeURIComponent(id)}&select=name,email,status,notified_status`
    );
  } catch (e) {
    return json(502, { error: "Could not load the application." });
  }
  const app = rows && rows[0];
  if (!app) return json(404, { error: "Application not found." });
  if (app.status !== "accepted" && app.status !== "declined") {
    return json(409, { error: "Accept or decline the application first." });
  }
  if (app.notified_status === app.status) {
    return json(200, { ok: true, already: true, to: app.email });
  }

  const siteUrl = String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "");
  const { subject, html, text } = buildDecisionEmail(app.name, app.status, siteUrl);

  let result;
  try {
    result = await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [app.email],
      reply_to: REPLY_TO,
      subject,
      html,
      text
    });
  } catch (e) {
    return json(502, { error: "Could not reach Resend." });
  }
  if (!result.ok) {
    return json(502, { error: "Resend rejected the email.", detail: result.body });
  }

  // Remember which decision was emailed. The email is already out, so a
  // failure here is reported but does not undo it.
  const mark = await fetch(`${env.SUPABASE_URL}/rest/v1/seller_applications?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ notified_status: app.status })
  }).catch(() => null);

  return json(200, { ok: true, to: app.email, recorded: !!(mark && mark.ok) });
}

/* ============================================================
   Checkout — Stripe Checkout, one piece at a time.

   /api/checkout          POST { product_id }  -> { url }  (the Stripe page)
   /api/checkout-cancel   POST { order_id }    releases the hold early
   /api/stripe-webhook    POST from Stripe     marks the sale, frees expired holds

   The Worker talks to Supabase with the service role key, so only this file
   can take a hold or record a sale (see migrations/20261111_checkout.sql).
   Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY.
   Var: SHIPPING_FLAT_CENTS. Nothing here is ever sent to the browser.
   ============================================================ */

// Stripe will not create a session shorter than 30 minutes. The database hold
// (32 minutes) is a little longer, so the piece is never free while a
// Stripe page can still take payment.
const STRIPE_SESSION_SECONDS = 31 * 60;

// How long poda takes to ship after a sale. Used in the Stripe page, the
// confirmation email and policies.html, so change all three together.
const POLICY_SHIP_DAYS = 5;

// Names only, never values. A 503 reports which setting is missing so a
// mistake in the Cloudflare dashboard is quick to find.
function checkoutMissing(env) {
  return ["STRIPE_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SITE_URL"].filter(name => !env[name]);
}

function checkoutConfigured(env) {
  return checkoutMissing(env).length === 0;
}

function notReady(env, extra) {
  return json(503, { error: "not_ready", missing: checkoutMissing(env).concat(extra || []) });
}

// Stripe takes form bodies with bracket keys: a[b][0][c]=value.
function stripeForm(obj, prefix, out) {
  const pairs = out || [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") stripeForm(item, `${name}[${i}]`, pairs);
        else pairs.push([`${name}[${i}]`, String(item)]);
      });
    } else if (typeof value === "object") {
      stripeForm(value, name, pairs);
    } else {
      pairs.push([name, String(value)]);
    }
  }
  return pairs;
}

async function stripeApi(env, path, params, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded"
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(stripeForm(params || {})).toString()
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Supabase has two kinds of server key. The legacy service_role key is a JWT
// (it starts with "eyJ") and goes in both headers. The newer sb_secret_ key is
// not a JWT and goes in the apikey header only; Supabase rejects it as a Bearer
// token. Either works here, whichever is stored as SUPABASE_SERVICE_ROLE_KEY.
function serviceHeaders(env) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function sbRpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify(args || {})
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// The buyer clicked Buy. Take a hold on the piece, open a Stripe page for it.
async function handleCheckout(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (!isSameOrigin(request)) return json(403, { error: "Forbidden." });
  if (!checkoutConfigured(env)) return notReady(env);

  if (env.CHECKOUT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.CHECKOUT_LIMITER.limit({ key: ip });
    if (!success) return json(429, { error: "slow_down" });
  }

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return json(413, { error: "bad_request" });
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "bad_request" });
  }
  const productId = String((payload && payload.product_id) || "");
  if (!UUID_RE.test(productId)) return json(400, { error: "bad_request" });

  const hold = await sbRpc(env, "create_order_hold", { p_product: productId });
  if (!hold.ok) {
    const msg = String((hold.body && hold.body.message) || "");
    if (msg.includes("poda_held")) return json(409, { error: "held" });
    if (msg.includes("poda_sold")) return json(409, { error: "sold" });
    if (msg.includes("poda_unavailable")) return json(409, { error: "unavailable" });
    console.error("create_order_hold failed:", hold.status, msg);
    return json(502, { error: "checkout_failed" });
  }
  const order = hold.body;

  const site = String(env.SITE_URL).replace(/\/$/, "");
  const currency = String(order.currency || "USD").toLowerCase();
  const shipping = parseInt(env.SHIPPING_FLAT_CENTS, 10);
  const params = {
    mode: "payment",
    client_reference_id: order.order_id,
    success_url: `${site}/thanks.html`,
    cancel_url: `${site}/index.html?checkout=cancelled&order=${order.order_id}`,
    expires_at: Math.floor(Date.now() / 1000) + STRIPE_SESSION_SECONDS,
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: order.price_cents,
        product_data: { name: [order.brand, order.title].filter(Boolean).join(" — ").slice(0, 240) }
      }
    }],
    shipping_address_collection: { allowed_countries: ["US"] },
    metadata: { order_id: order.order_id },
    payment_intent_data: { metadata: { order_id: order.order_id } },
    // Shown beside the Pay button, so the terms are in front of the buyer.
    custom_text: {
      submit: {
        message: `Final sale unless a piece is not as described. Ships within ${POLICY_SHIP_DAYS} business days. Full policies: ${site}/policies.html`
      }
    }
  };
  // One flat rate. Left out (free shipping) if no valid amount is set.
  if (Number.isInteger(shipping) && shipping > 0) {
    params.shipping_options = [{
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: "Shipping",
        fixed_amount: { amount: shipping, currency }
      }
    }];
  }
  // Sales tax stays off until STRIPE_TAX_ENABLED is "true" and Stripe Tax is set
  // up in the Stripe dashboard. Tax is added on top of the price and shipping.
  if (String(env.STRIPE_TAX_ENABLED || "").toLowerCase() === "true") {
    params.automatic_tax = { enabled: true };
    params.line_items[0].price_data.tax_behavior = "exclusive";
    if (params.shipping_options) params.shipping_options[0].shipping_rate_data.tax_behavior = "exclusive";
  }

  let session;
  try {
    session = await stripeApi(env, "/v1/checkout/sessions", params, `checkout-${order.order_id}`);
  } catch (e) {
    session = { ok: false, status: 0, body: {} };
  }
  if (!session.ok || !session.body.url) {
    // No payment page, so no hold: free the piece straight away.
    try { await sbRpc(env, "release_order", { p_order: order.order_id }); } catch (e) { /* the hold lapses by itself */ }
    const why = session.body && session.body.error && session.body.error.message;
    console.error("Stripe session failed:", session.status, why || "");
    return json(502, { error: "payment_unavailable" });
  }

  // Remember the session so a cancel can expire it. Not fatal if it fails.
  try { await sbRpc(env, "attach_order_session", { p_order: order.order_id, p_session: session.body.id }); } catch (e) { /* ignore */ }
  return json(200, { url: session.body.url, order_id: order.order_id });
}

// The buyer came back from Stripe without paying: free the piece now instead
// of making everyone wait for the hold to run out.
async function handleCheckoutCancel(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (!isSameOrigin(request)) return json(403, { error: "Forbidden." });
  if (!checkoutConfigured(env)) return notReady(env);

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return json(413, { error: "bad_request" });
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "bad_request" });
  }
  const orderId = String((payload && payload.order_id) || "");
  if (!UUID_RE.test(orderId)) return json(400, { error: "bad_request" });

  // Only a still-pending order has a session to expire. A paid order, an
  // expired one and an unknown one all answer null, and nothing happens.
  const found = await sbRpc(env, "order_session", { p_order: orderId });
  const sessionId = found.ok && typeof found.body === "string" ? found.body : null;
  if (sessionId) {
    const expired = await stripeApi(env, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
    if (expired.ok) await sbRpc(env, "release_order", { p_order: orderId });
  }
  return json(200, { ok: true });
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe signs each webhook: header "t=<time>,v1=<hmac of 't.body'>". Nothing is
// trusted until this passes, and a signature older than five minutes is refused.
async function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
  return signatures.some(s => timingSafeEqualHex(s, expected));
}

function addressLine(address) {
  if (!address) return "No address collected";
  const cityLine = [address.city, [address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line1, address.line2, cityLine, address.country].filter(Boolean).join(", ") || "No address collected";
}

// A plain email to the admin for something that needs a human right now.
async function alertAdmin(env, subject, lines) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  const text = lines.join("\n");
  try {
    await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [env.ADMIN_EMAIL],
      subject,
      html: `<pre style="font-family:inherit;white-space:pre-wrap;word-wrap:break-word;">${escapeHTML(text)}</pre>`,
      text
    });
  } catch (e) {
    console.error("Alert email failed:", e && e.message);
  }
}

// Tells the admin a piece sold, with who to ship to and what the seller is owed.
async function notifyAdminOfSale(env, sale, buyer) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  const money = cents => new Intl.NumberFormat("en-US", {
    style: "currency", currency: sale.currency || "USD"
  }).format((cents || 0) / 100);
  const subject = sale.conflict
    ? `Refund needed: ${sale.title}`
    : `Sold: ${sale.title}, ${money(sale.price_cents)}`;
  const lines = [
    sale.conflict
      ? "This payment arrived after the hold ran out and the piece was already sold. Refund the buyer in Stripe."
      : "A piece just sold.",
    "",
    `Piece: ${[sale.brand, sale.title].filter(Boolean).join(" ")}`,
    `Price: ${money(sale.price_cents)}`,
    `Shipping paid: ${money(sale.shipping_cents)}`,
    `Seller: ${sale.supplier_name || "unknown"}`,
    sale.payout_status === "none"
      ? "Seller share: none, this is a poda piece"
      : `Seller share: ${money(sale.seller_payout_cents)} (poda keeps ${money(sale.commission_cents)})`,
    "",
    `Buyer: ${buyer.name || "no name"} <${buyer.email || "no email"}>`,
    `Ship to: ${addressLine(buyer.address)}`,
    "",
    `Record it and mark the seller paid: ${String(env.SITE_URL || "").replace(/\/$/, "")}/admin.html (Supply, Orders)`
  ];
  const text = lines.join("\n");
  try {
    await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [env.ADMIN_EMAIL],
      subject,
      html: `<pre style="font-family:inherit;white-space:pre-wrap;word-wrap:break-word;">${escapeHTML(text)}</pre>`,
      text
    });
  } catch (e) {
    console.error("Sale email failed:", e && e.message);
  }
}

/* ---- Emails to the buyer ---- */

function moneyText(cents, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format((cents || 0) / 100);
}

// Tracking pages for the carriers poda uses. "Other" has no link: the number
// is shown as text.
const CARRIERS = {
  USPS: n => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  UPS: n => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  FedEx: n => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  DHL: n => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  Other: null
};

// One look for every email poda sends a buyer. Everything that came from a
// person or a seller is escaped before it reaches this function's callers.
function buyerEmailShell(siteUrl, heading, innerHTML) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f2f1ed;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ed;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #d9d8d2;">
          <tr><td style="padding:22px 28px 0 28px;"><a href="${siteUrl}" style="font-family:Impact,'Arial Narrow Bold',Arial,sans-serif;font-style:italic;font-size:30px;color:#244CFF;text-decoration:none;">poda</a></td></tr>
          <tr><td style="padding:18px 28px 6px 28px;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.15;color:#15151A;">${escapeHTML(heading)}</td></tr>
          <tr><td style="padding:6px 28px 26px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#15151A;">${innerHTML}</td></tr>
          <tr><td style="padding:16px 28px;border-top:1px solid #e6e5df;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8882;">poda, selective retail<br>Questions? Reply to this email.<br><a href="${siteUrl}/policies.html" style="color:#8a8882;">Shipping and returns</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function emailRows(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border-top:1px solid #e6e5df;">${
    rows.map(([label, value, bold]) =>
      `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e5df;color:#5a5a56;">${escapeHTML(label)}</td>` +
      `<td align="right" style="padding:8px 0;border-bottom:1px solid #e6e5df;${bold ? "font-weight:bold;" : ""}">${escapeHTML(value)}</td></tr>`
    ).join("")}</table>`;
}

function oneLine(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").trim();
}

function buildConfirmationEmail(siteUrl, sale, buyer, totalCents) {
  const piece = oneLine([sale.brand, sale.title].filter(Boolean).join(" "));
  const first = oneLine(buyer.name).split(/\s+/)[0];
  const shipping = sale.shipping_cents || 0;
  const tax = (totalCents || 0) - sale.price_cents - shipping;
  const rows = [[piece, moneyText(sale.price_cents, sale.currency)]];
  if (shipping > 0) rows.push(["Shipping", moneyText(shipping, sale.currency)]);
  if (tax > 0) rows.push(["Tax", moneyText(tax, sale.currency)]);
  rows.push(["Total", moneyText(totalCents || sale.price_cents + shipping, sale.currency), true]);

  const address = addressLine(buyer.address);
  const html = buyerEmailShell(siteUrl, "Your order is confirmed", `
    <p style="margin:0 0 8px 0;">${first ? `Thank you, ${escapeHTML(first)}.` : "Thank you."} Your payment went through and the piece is yours.</p>
    ${emailRows(rows)}
    <p style="margin:0 0 6px 0;"><strong>Shipping to</strong><br>${escapeHTML(address)}</p>
    <p style="margin:14px 0 0 0;"><strong>What happens next</strong><br>
      We ship within ${POLICY_SHIP_DAYS} business days and email you tracking the moment it goes out.
      Every piece is final sale unless it arrives not as described. The details are in
      <a href="${siteUrl}/policies.html" style="color:#244CFF;">Shipping and returns</a>.</p>`);

  const text = [
    first ? `Thank you, ${first}.` : "Thank you.",
    "Your payment went through and the piece is yours.",
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    `Shipping to: ${address}`,
    "",
    `We ship within ${POLICY_SHIP_DAYS} business days and email you tracking when it goes out.`,
    `Every piece is final sale unless it arrives not as described: ${siteUrl}/policies.html`,
    "",
    "poda, selective retail. Questions? Reply to this email."
  ].join("\n");

  return { subject: `Your poda order: ${piece}`, html, text };
}

function buildShippedEmail(siteUrl, order, carrier, tracking) {
  const piece = oneLine([order.brand, order.title].filter(Boolean).join(" "));
  const link = tracking && CARRIERS[carrier] ? CARRIERS[carrier](tracking) : null;
  const trackingLine = tracking
    ? `${carrier && carrier !== "Other" ? `${carrier} ` : ""}tracking number ${tracking}`
    : "";
  const address = addressLine(order.shipping_address);

  const html = buyerEmailShell(siteUrl, "Your order has shipped", `
    <p style="margin:0 0 8px 0;">${escapeHTML(piece)} is on its way.</p>
    ${tracking ? `<p style="margin:14px 0;"><strong>Tracking</strong><br>${escapeHTML(trackingLine)}${
      link ? `<br><a href="${escapeHTML(link)}" style="color:#244CFF;">Track your package</a>` : ""}</p>` : ""}
    <p style="margin:14px 0 0 0;"><strong>Shipping to</strong><br>${escapeHTML(address)}</p>
    <p style="margin:14px 0 0 0;">Delivery times depend on the carrier. If anything looks wrong when it arrives, reply to this email.
      See <a href="${siteUrl}/policies.html" style="color:#244CFF;">Shipping and returns</a>.</p>`);

  const text = [
    `${piece} is on its way.`,
    "",
    ...(tracking ? [trackingLine, ...(link ? [`Track your package: ${link}`] : []), ""] : []),
    `Shipping to: ${address}`,
    "",
    "Delivery times depend on the carrier. If anything looks wrong when it arrives, reply to this email.",
    `Shipping and returns: ${siteUrl}/policies.html`
  ].join("\n");

  return { subject: `Your poda order has shipped: ${piece}`, html, text };
}

async function emailBuyerConfirmation(env, sale, buyer, totalCents) {
  if (!env.RESEND_API_KEY) return;
  const siteUrl = String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "");
  const piece = [sale.brand, sale.title].filter(Boolean).join(" ");
  if (!buyer.email) {
    await alertAdmin(env, "An order has no buyer email", [
      `Order ${sale.order_id} for ${piece} was paid, but Stripe sent no email address.`,
      "Contact the buyer from the Stripe payment, and ship to the address in the Orders tab."
    ]);
    return;
  }
  const { subject, html, text } = buildConfirmationEmail(siteUrl, sale, buyer, totalCents);
  let result;
  try {
    result = await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [buyer.email],
      reply_to: env.CONTACT_EMAIL || REPLY_TO,
      subject, html, text
    });
  } catch (e) {
    result = { ok: false, status: 0, body: {} };
  }
  if (!result.ok) {
    await alertAdmin(env, "The buyer's confirmation email did not send", [
      `Order ${sale.order_id} for ${piece} was recorded, but the confirmation to ${buyer.email} failed (status ${result.status}).`,
      "Email the buyer yourself so they know the order went through."
    ]);
  }
}

// Stripe's processing fee on a payment. It comes out of poda's share, so the
// Payouts dashboard needs it to show what poda really keeps. This is best
// effort and can never fail a sale: if Stripe has no fee yet or a call fails,
// the order simply has no fee recorded and the dashboard says so.
async function recordStripeFee(env, sessionId, orderId) {
  try {
    const query = new URLSearchParams({ "expand[]": "payment_intent.latest_charge.balance_transaction" });
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?${query}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    if (!res.ok) return;
    const body = await res.json().catch(() => null);
    const charge = body && body.payment_intent && body.payment_intent.latest_charge;
    const fee = charge && charge.balance_transaction && charge.balance_transaction.fee;
    if (!Number.isInteger(fee) || fee < 0) return;
    await sbRpc(env, "record_order_fee", { p_order: orderId, p_fee: fee });
  } catch (e) {
    console.error("Could not record the Stripe fee:", e && e.message);
  }
}

// Stripe tells us what happened. Returning 500 makes Stripe try again, so a
// failure to record a payment is never silent.
async function handleStripeWebhook(request, env, ctx) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (!env.STRIPE_WEBHOOK_SECRET || !checkoutConfigured(env)) {
    return notReady(env, env.STRIPE_WEBHOOK_SECRET ? [] : ["STRIPE_WEBHOOK_SECRET"]);
  }

  const raw = await request.text();
  const valid = await verifyStripeSignature(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json(400, { error: "bad_signature" });

  let event;
  try { event = JSON.parse(raw); } catch (e) { return json(400, { error: "bad_body" }); }
  const session = event && event.data && event.data.object;
  const orderId = session && session.metadata && session.metadata.order_id;
  // Not a checkout this site started: acknowledge and ignore.
  if (!orderId || !UUID_RE.test(orderId)) return json(200, { received: true });

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    // A payment method that settles later completes the session unpaid first.
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return json(200, { received: true });
    }
    const customer = session.customer_details || {};
    const ship = (session.collected_information && session.collected_information.shipping_details)
      || session.shipping_details || session.shipping || null;
    const buyer = {
      email: customer.email || session.customer_email || null,
      name: (ship && ship.name) || customer.name || null,
      address: (ship && ship.address) || customer.address || null
    };
    const done = await sbRpc(env, "complete_order", {
      p_order: orderId,
      p_session: session.id,
      p_email: buyer.email,
      p_name: buyer.name,
      p_address: buyer.address,
      p_shipping_cents: (session.total_details && session.total_details.amount_shipping) || 0,
      p_amount_total: session.amount_total ?? null
    });
    if (!done.ok) {
      const why = (done.body && done.body.message) || "no detail";
      console.error("complete_order failed:", done.status, why);
      // The money is taken but the sale is not recorded. Say so loudly. Stripe
      // keeps retrying this webhook, so it also fixes itself once the cause does.
      await alertAdmin(env, "Payment received but NOT recorded", [
        "Stripe took a payment, but the site could not record the sale. Stripe will keep retrying.",
        "",
        `Stripe session: ${session.id}`,
        `Order id: ${orderId}`,
        `Amount: ${((session.amount_total || 0) / 100).toFixed(2)} ${String(session.currency || "").toUpperCase()}`,
        `Buyer: ${buyer.email || "unknown"}`,
        "",
        `The database said: ${done.status} ${why}`,
        "",
        "Run migrations/20261111_checkout_selftest.sql in Supabase to see what is wrong. A common cause is re-running SELLER_CARDS_APPLY.sql without running migrations/20261111_checkout.sql after it."
      ]);
      return json(500, { error: "complete_failed" });
    }
    // Tell the admin and the buyer once. Stripe may send the same event twice.
    // A conflict payment is going to be refunded, so the buyer is not told
    // the order is confirmed.
    if (done.body && done.body.newly_paid) {
      const task = (async () => {
        await notifyAdminOfSale(env, done.body, buyer);
        if (!done.body.conflict) await emailBuyerConfirmation(env, done.body, buyer, session.amount_total);
        await recordStripeFee(env, session.id, orderId);
      })();
      if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
    }
    return json(200, { received: true });
  }

  if (event.type === "checkout.session.expired") {
    const released = await sbRpc(env, "release_order", { p_order: orderId });
    if (!released.ok) return json(500, { error: "release_failed" });
  }
  return json(200, { received: true });
}

/* ============================================================
   /api/order-shipped — emails the buyer that their order shipped, with
   tracking, and records it on the order. Admin only. The buyer's address
   and the piece are read from the database with the admin's own session,
   never taken from the request, so this cannot be used to email anyone else.
   ============================================================ */
const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{2,59}$/;

async function handleOrderShipped(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return json(413, { error: "Request too large." });
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  const orderId = String((payload && payload.order_id) || "");
  if (!UUID_RE.test(orderId)) return json(400, { error: "A valid order is required." });
  let carrier = String((payload && payload.carrier) || "").trim();
  const tracking = String((payload && payload.tracking_number) || "").trim();
  if (carrier && !(carrier in CARRIERS)) return json(400, { error: "Choose USPS, UPS, FedEx, DHL or Other." });
  if (tracking && !TRACKING_RE.test(tracking)) return json(400, { error: "The tracking number can use letters, numbers, spaces and hyphens only." });
  if (tracking && !carrier) carrier = "Other";

  const auth = await verifyAdmin(request, env, "send shipping emails");
  if (!auth.ok) return json(auth.status, { error: auth.error, detail: auth.detail });

  let rows;
  try {
    rows = await supabaseSelect(env, auth.token, "orders", `id=eq.${encodeURIComponent(orderId)}&select=*`);
  } catch (e) {
    return json(502, { error: "Could not load the order." });
  }
  const order = rows && rows[0];
  if (!order) return json(404, { error: "Order not found." });
  if (!("tracking_number" in order)) {
    return json(409, { error: "Run migrations/20261112_order_shipping.sql in Supabase first." });
  }
  if (order.status !== "paid" || order.conflict) {
    return json(409, { error: "Only a paid order that is not waiting for a refund can be shipped." });
  }
  if (!order.buyer_email) {
    return json(422, { error: "This order has no buyer email. Mark it shipped without an email." });
  }

  const siteUrl = String(env.SITE_URL || "https://podapodapoda.co").replace(/\/$/, "");
  const { subject, html, text } = buildShippedEmail(siteUrl, order, carrier, tracking);
  let sent;
  try {
    sent = await sendViaResend(env, {
      from: FROM_ADDRESS,
      to: [order.buyer_email],
      reply_to: env.CONTACT_EMAIL || REPLY_TO,
      subject, html, text
    });
  } catch (e) {
    sent = { ok: false, status: 0, body: {} };
  }
  if (!sent.ok) return json(502, { error: "The email did not send, so the order was not changed." });

  const now = new Date().toISOString();
  try {
    await supabasePatch(env, auth.token, "orders", `id=eq.${encodeURIComponent(orderId)}`, {
      shipped_at: order.shipped_at || now,
      carrier: carrier || null,
      tracking_number: tracking || null,
      shipped_email_sent_at: now
    });
  } catch (e) {
    return json(502, { error: "The email was sent, but saving the order failed. Mark it shipped by hand.", emailed: true });
  }
  return json(200, { ok: true, emailed: true, shipped_at: order.shipped_at || now });
}

/* ============================================================
   Router — API routes handled here; everything else falls through
   to the static assets binding (the existing dist/ site, unchanged).
   ============================================================ */
async function serveSellerPage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Method not allowed." });
  let res = await env.ASSETS.fetch(new Request(new URL("/seller.html", url.origin), request));
  // The assets binding may answer seller.html with a redirect to /seller.
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    res = await env.ASSETS.fetch(new Request(new URL(res.headers.get("location"), url.origin), request));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/notes-send") return handleNotesSend(request, env);
    if (url.pathname === "/api/unsubscribe") return handleUnsubscribe(request, env);
    if (url.pathname === "/api/submit-request") return handleSubmitRequest(request, env);
    if (url.pathname === "/api/send-invite") return handleSendInvite(request, env);
    if (url.pathname === "/api/application-decision") return handleApplicationDecision(request, env);
    if (url.pathname === "/api/checkout") return handleCheckout(request, env);
    if (url.pathname === "/api/checkout-cancel") return handleCheckoutCancel(request, env);
    if (url.pathname === "/api/stripe-webhook") return handleStripeWebhook(request, env, ctx);
    if (url.pathname === "/api/order-shipped") return handleOrderShipped(request, env);

    // /join/<code> is the short invite link. The URL stays as typed; the
    // seller page reads the code from the path.
    if (url.pathname.startsWith("/join/")) return serveSellerPage(request, env, url);

    return env.ASSETS.fetch(request);
  }
};
