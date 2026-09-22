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

async function verifyAdmin(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in required." };

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
  if (!res.ok) return { ok: false, status: 401, error: "Invalid or expired session." };

  const user = await res.json().catch(() => null);
  const email = String((user && user.email) || "").toLowerCase();
  const adminEmail = String(env.ADMIN_EMAIL || "").toLowerCase();
  if (!email || !adminEmail || email !== adminEmail) {
    return { ok: false, status: 403, error: "This account is not authorized to send Market Notes." };
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

function buildEmail(note, siteUrl, unsubscribeUrl) {
  const noteUrl = `${siteUrl}/note.html?id=${encodeURIComponent(note.id)}`;
  const excerpt = plainExcerpt(note);
  const subject = noteSubject(note);
  const issueLabel = note.issueNumber ? `No. ${escapeHTML(String(note.issueNumber))}` : "poda inbox";

  const imageBlock = note.coverImage
    ? `<tr><td style="padding:0 28px 20px;"><img src="${escapeHTML(note.coverImage)}" alt="" width="100%" style="display:block;max-width:100%;border:1px solid #26262a;" /></td></tr>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f3;font-family:Georgia,'Times New Roman',serif;color:#090909;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #26262a;">
            <tr>
              <td style="padding:24px 28px 0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#555555;">poda</td>
            </tr>
            <tr>
              <td style="padding:6px 28px 20px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#999790;">${issueLabel}</td>
            </tr>
            ${imageBlock}
            <tr>
              <td style="padding:0 28px 12px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.1;font-weight:600;color:#090909;">${escapeHTML(note.title || "poda")}</td>
            </tr>
            <tr>
              <td style="padding:0 28px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333333;">${escapeHTML(excerpt)}</td>
            </tr>
            <tr>
              <td style="padding:0 28px 32px;">
                <a href="${noteUrl}" style="display:inline-block;background:#090909;color:#ffffff;text-decoration:none;font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;padding:14px 24px;">Read the full note &rarr;</a>
              </td>
            </tr>
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

  const text =
    `${note.title || "poda"}\n\n${excerpt}\n\nRead the full note: ${noteUrl}\n\n` +
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

async function handleSubmitRequest(request, env) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  let payload;
  try {
    payload = await request.json();
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

  if (!name || !email || !message) {
    return json(400, { error: "Name, email, and message are required." });
  }

  const contactEmail = env.CONTACT_EMAIL;
  if (!contactEmail) {
    return json(500, { error: "Contact email isn't configured." });
  }

  const lines = [
    `${subjectPrefix}:`, "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Instagram: ${instagram}`, "",
    `${prompt}:`,
    message
  ];
  if (photos.length) {
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
   Router — API routes handled here; everything else falls through
   to the static assets binding (the existing dist/ site, unchanged).
   ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/notes-send") return handleNotesSend(request, env);
    if (url.pathname === "/api/unsubscribe") return handleUnsubscribe(request, env);
    if (url.pathname === "/api/submit-request") return handleSubmitRequest(request, env);

    return env.ASSETS.fetch(request);
  }
};
