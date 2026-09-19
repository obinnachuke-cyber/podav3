#!/usr/bin/env node
/* ============================================================
   build.js — Cloudflare Pages build step.

   This is a filter-and-copy step, not a bundler: it copies ONLY the
   files below into dist/, so internal planning docs, spreadsheets,
   and local sync artifacts (which all live in the repo root) never
   ship to the public site. Nothing here transforms file contents —
   home.html/index.html and every other page stay hand-authored,
   single-source files; this script never generates or duplicates
   page markup.

   Run: node build.js
   ============================================================ */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");

// Allowlist: only files listed here are ever copied to dist/. Adding a
// new public page or script means adding it here — that's intentional,
// so nothing new can leak into the deployment by accident.
const INCLUDE = [
  "index.html",
  "about.html",
  "admin.html",
  "drop.html",
  "item.html",
  "lookbook.html",
  "market-notes.html",
  "note.html",
  "sell.html",
  "source.html",
  "study.html",
  "unsubscribe.html",

  "style.css",
  "admin.css",

  "script.js",
  "home.js",
  "layout.js",
  "shell.js",
  "lookbook.js",
  "study.js",
  "submit.js",
  "subscribe.js",
  "admin.js",
  "excel-export.js",
  "db.js",
  "supabase-config.js",
  "supabase.min.js"
];

function copyFile(name) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`(skip) not found: ${name}`);
    return false;
  }
  const dest = path.join(OUT, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
INCLUDE.forEach(name => { if (copyFile(name)) copied++; });

console.log(`Build complete — ${copied}/${INCLUDE.length} file(s) copied to ${path.relative(ROOT, OUT)}/`);
