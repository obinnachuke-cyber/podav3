# poda

A static HTML/CSS/vanilla-JS storefront backed by Supabase (Postgres + Auth +
Storage). No framework, no bundler — every page is a real `.html` file that
loads shared scripts directly.

## Local development

Serve the repo root with any static file server and open `index.html`:

```
python -m http.server 8090
```

Then visit `http://localhost:8090/index.html`.

Supabase connection settings (project URL, anon key) live in
`supabase-config.js` — that file is committed and public-safe (the anon key
is designed to be exposed client-side; real protection comes from Supabase
Row Level Security policies). See `OVERHAUL_SETUP.md`, `NOTES_SETUP.md`, and
`SUBSCRIBERS_SETUP.md` for the SQL/RLS each content type needs.

## Deploying to Cloudflare Pages

**Build command:** `node build.js`
**Build output directory:** `dist`
**Entry point:** `index.html` (served automatically at the site root)

`build.js` does not bundle or transform anything — it copies an explicit
allowlist of public/admin files into `dist/`, so internal planning docs
(`OVERHAUL_SETUP.md`, `NOTES_SETUP.md`, `SEED.md`,
`poda_full_website_overhaul_brief.txt`, `podanew.txt`), local spreadsheets,
OneDrive sync artifacts (`*.crswap`), and anything else not explicitly
listed in `build.js`'s `INCLUDE` array never reach the deployed site. Adding
a new page or script means adding its filename to that list.

### Cloudflare Pages project settings

| Setting | Value |
|---|---|
| Build command | `node build.js` |
| Build output directory | `dist` |
| Root directory | `/` (repo root) |

No environment variables are required for the build itself — `supabase-config.js`
already contains the public anon key and ships as-is.

### Testing a deployment before/after it goes live

Locally, you can produce the exact same output Cloudflare will deploy:

```
node build.js
cd dist
python -m http.server 8090
```

Then click through: homepage (`/`), nav links, Market Notes index → an
individual note, Lookbook → an individual study, The Edit → an individual
product, the Source and Sell forms, About, and `admin.html` (login gated by
Supabase Auth). Confirm the mobile nav toggle works at a narrow width, and
that pages with no data yet (e.g. an empty drop, no published notes) show
their empty-state messaging instead of erroring.

Once deployed, re-run the same checklist against the live Cloudflare Pages
URL — particularly the query-parameter detail pages
(`note.html?id=...`, `item.html?id=...`, `study.html?id=...`), since those
depend on the client successfully reaching your Supabase project from a new
origin.

## Security notes

- The Supabase **anon** key in `supabase-config.js` is meant to be public —
  it only works within whatever Row Level Security policies each table
  defines (see the `*_SETUP.md` files).
- The Supabase **service role** key must never appear in any file in this
  repo or in browser-accessible JavaScript. It isn't used anywhere in this
  codebase today.
- `admin.html`/`admin.js` are gated by real Supabase email/password auth —
  they ship in the deployed site (so the admin can log in from anywhere),
  but no admin action succeeds without a valid authenticated session.
