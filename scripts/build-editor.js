#!/usr/bin/env node
/* ============================================================
   build-editor.js — dev-only bundler for the Market Note Studio.

   Bundles src/editor/index.js (Tiptap core + Poda's custom node
   extensions + the website/email HTML renderers) into ONE plain
   <script>-loadable file, poda-editor.bundle.js, committed at the
   repo root next to supabase.min.js.

   This does NOT run as part of the site's deploy (Cloudflare's
   build command stays `node build.js`) — run it locally with
   `npm run build:editor` whenever src/editor/** changes, then
   commit the regenerated bundle.
   ============================================================ */
const esbuild = require("esbuild");
const path = require("path");

const ROOT = path.join(__dirname, "..");

esbuild.build({
  entryPoints: [path.join(ROOT, "src/editor/index.js")],
  outfile: path.join(ROOT, "poda-editor.bundle.js"),
  bundle: true,
  format: "iife",
  target: ["es2019"],
  minify: true,
  sourcemap: false,
  logLevel: "info",
  banner: {
    js: "/* poda-editor.bundle.js — built from src/editor/** via `npm run build:editor`. Do not hand-edit. */"
  }
}).catch(() => process.exit(1));
