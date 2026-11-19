# Release emails: setup and use

Four emails go to subscribers. Every one is manual except the two timed
reminders, and every one can be previewed and sent to you first.

| Email | Where you send it | Subject |
|---|---|---|
| The drop is live | Release page, Email subscribers, "Email: the drop is live" | `poda - Folder 004: Autumn Edit` |
| An Index set | Release page, Contents, "Email…" on a published set | `poda - Folder 004: Boot study` |
| Market Note | Market Notes list, Send | `poda Inbox: title` |
| Drop reminders | Release page, Email subscribers, Schedule | `poda - Folder 004: drops today at 4:12 PM EST` and `poda - Folder 004: 30 minutes` |

All of them carry the poda logo at the top left and a hidden inbox preview line.
The reminders' preview lines are:

- morning of the drop: "standby. we'll get those items to you by EOD."
- 30 minutes before: "we'll get those items over to you real quick."

The body of both says "this drop is coming out at 4:12 PM EST." under the folder name.

## One-time setup

1. Run `migrations/20261120_release_emails.sql` in the Supabase SQL editor.
2. Reminders only: the Worker needs the `SUPABASE_SERVICE_ROLE_KEY` and
   `RESEND_API_KEY` secrets (the same ones checkout uses). The cron trigger in
   `wrangler.toml` runs every five minutes and sends a reminder when its time
   comes. Deploy once after merging so Cloudflare registers the trigger.
3. Optional: `RESEND_DAILY_LIMIT` as a plain variable. It defaults to 100, the
   Resend free plan. Set it to your plan's daily figure, or `0` for no limit.

## Rules the Worker enforces

- The drop email is blocked until the drop is open, and for archived releases.
- An Index email needs a published set in a release that is open to the public.
- Broadcasts need the typed SEND and are refused a second time unless you tick
  "Send again anyway". Index sets are tracked one by one.
- A send that would pass the daily limit is refused before anything goes out.
- Reminders are skipped if the drop time moved, the drop already opened or the
  release was archived after they were scheduled. Moving the drop time means
  scheduling them again.
- A reminder due more than 45 minutes ago is skipped rather than sent late.
- Every reminder that sends, or is blocked by the limit, emails the admin.

## Things to know

- **Resend free plan: 100 emails a day.** Every send goes to every active
  subscriber. With 34 subscribers, two reminders and the drop email on the same
  day is 102 emails, so the last one is blocked. The release page warns when the
  drop-day total passes the limit. Resend Pro has no daily cap.
- **Images are linked, not attached.** Photos are loaded from where they are
  hosted, like the rest of the site. Resend's batch send cannot carry
  attachments, and attachments hurt deliverability. Formats are the ones the
  site already accepts. The preview warns when a set contains AVIF or WebP,
  because not every email app can show them.
- **The logo is inside the email, not the sender avatar.** The round picture
  beside a sender in Gmail and Apple Mail comes from BIMI, which needs a
  verified logo certificate and a strict DMARC policy on podapodapoda.co. That
  is a separate project.
- Reminder times use the drop's own timezone, falling back to New York.
