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
Row Level Security policies). See `OVERHAUL_SETUP.md`, `NOTES_SETUP.md`,
`SUBSCRIBERS_SETUP.md`, and `MARKET_NOTES_STUDIO_SETUP.md` for the SQL/RLS
each content type needs.

### Releases, Shop and the timed drop

Each biweekly edition is a **release** (a folder) — an `edits` row. The
homepage (`index.html`) shows one of two views, chosen by `folders.js`:
**when a release is in Shop, the homepage is the Shop** (the release plus a
quiet "next drop" notice). **When nothing is in Shop, it is the folder
homepage**: a 3D row of six tabbed folders, each named on its tab, that lift and fan
out on hover, with a red card stack behind a folder that has new material.
The folders are **Shop**, **Inbox** (Market Notes and release updates),
**Lookbook**, **Archive** (past releases), **Sell with poda** and **Source**.
An index row under the scene is the real navigation (keyboard, screen
readers, phones); hovering either one highlights both. The scene is CSS 3D
(`.fscene` in `style.css`), with no images. The folder homepage reloads itself at a scheduled drop time, so a
waiting visitor lands on the Shop. `index.html?view=shop` always shows the
Shop, and the nav's Shop link uses it. `index.html?view=home` always shows the
folders, even while a release is live. If the data can't load, the folder
homepage is shown, since its links are static. `folder.html?id=<id>` shows any
one release. Old URLs redirect: `/shop`, `/drop` and `/item` go to
`/index.html?view=shop`, and `/home` goes to `/`.

**The drop is decided by the database clock, not the browser.** A release's
products are returned by the `public_products` view only once
`edits.publish_at <= now()` (or after a manual launch, `launched_at`). No cron
job or secret is involved, so retries and duplicate runs cannot matter. An open
Shop page re-asks at the drop moment using the server's time, and again when a
background tab becomes visible. Times are stored in UTC and entered/shown in
the release's own timezone (`tz.js`, `edits.drop_timezone`).

- **Admin → Current Release** is the workspace for the release being prepared
  (`edits.is_working`, explicit and separate from what's in Shop): Contents
  (notes, lookbook sets, updates, products), Settings (details, visibility,
  drop schedule, readiness), Preview (private, and "what's public now"),
  Activity. Other admin areas: All Releases, Supply (Review Queue / Inventory /
  Suppliers), Subscribers (plus Notes & email), Settings.
- **Opening a release** (draft → scheduled) makes its page public so items you
  publish can appear; it never publishes products or sends email.
- **Shop shows** the most recent release whose drop has happened and which is
  not archived; a newer drop replaces an older one, which moves to the Archive.
- **Published notes keep a private working revision** (`note_revisions`);
  nothing reaches the live note until "Publish changes".
- **Red dot** on Shop / Inbox = new since that visitor last opened it (kept in
  the visitor's own `localStorage`).
- The folder art is the unmodified SVG set in `assets/folders/`.

#### Database migrations

Apply, in order, in the Supabase SQL editor: the base schema
(`SUPABASE_FOUNDATION.sql`, `MARKETPLACE_APPLY_PART1.sql`,
`MARKETPLACE_APPLY_PART2_ADMIN.sql` — only if not already applied), then
**`migrations/20261028_release_workspace.sql` last**. It is repeatable and
deletes nothing; it adds the release columns, the timed-drop views, private note
revisions and the access fixes. Re-running a base script afterwards replaces
`public_products` with the older ungated view, so re-run the migration after it.
Then run **`SELLER_CARDS_APPLY.sql`**: it adds `products.size` and
`products.is_hidden`, lets sellers delete their own never-live pieces, and
re-creates `public_products` so a hidden piece counts as unavailable. Re-run it
after any re-run of the release migration. Then run **`SELLER_INVITES_APPLY.sql`**,
which locks down the supplier invite list and powers emailed invites; see
MARKETPLACE_SETUP.md Step 10.
`FOLDERS_PUBLIC_SETUP.sql` is superseded and refuses to run.

### Market Note Publishing Studio (admin editor)

`admin.html`'s Market Note editor is built on [Tiptap](https://tiptap.dev)
core (no React — this is still a plain-script site). Its source lives in
`src/editor/**`; the deployed site loads the **committed, built output**,
`poda-editor.bundle.js`, exactly the way `supabase.min.js` is vendored —
`build.js` and Cloudflare's build command (`node build.js`) never run npm.

If you change anything under `src/editor/`, rebuild the bundle before
committing:

```
npm install        # one-time, dev-only — see package.json devDependencies
npm run build:editor
```

This regenerates `poda-editor.bundle.js` from source via esbuild. Commit
the regenerated file alongside your source changes.

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

Then click through: homepage (`/`, one folder per edition) → a folder, nav
links, Market Notes index → an individual note, a study opened from inside a
folder, The Edit → an individual
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
- The `note-media` Storage bucket (Market Note Studio images) is public to
  **read** but restricted to the authenticated admin for **upload/delete** —
  stricter than `item-images`, which allows any authenticated user. See
  `MARKET_NOTES_STUDIO_SETUP.md`.
