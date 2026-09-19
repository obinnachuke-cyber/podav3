/* ============================================================
   POST /api/notes-send — Cloudflare Pages Function
   Sends a Market Note by email: a single test send to the admin,
   or a broadcast to every ACTIVE subscriber via Resend's batch API.

   RESEND_API_KEY is read only from `env` here — it never reaches
   the browser. The caller's Supabase access token is verified
   server-side against Supabase itself before anything else runs.
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

/* —— Verify the caller is really the signed-in admin —— */
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

/* —— Thin Supabase REST helpers (acting as the verified admin's own session) —— */
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

/* —— Email content —— */
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

/* —— Resend —— */
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

export async function onRequestPost({ request, env }) {
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

  /* —— Test send: just the admin, no logging/guard needed —— */
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

  /* —— Broadcast: requires the typed confirmation, duplicate-guard, batching —— */
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

export async function onRequestGet() {
  return json(405, { error: "Method not allowed." });
}
