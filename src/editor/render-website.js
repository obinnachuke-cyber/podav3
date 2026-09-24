import { generateHTML } from "@tiptap/html";
import { extensions } from "./studio.js";
import { EMPTY_DOC } from "./studio.js";

// Website HTML is generated straight from the Tiptap schema's renderHTML()
// methods (see nodes/*.js) — the exact same node definitions used for
// editing, minus their interactive node views. That keeps "what the admin
// wrote" and "what the website shows" a single source of truth. DOMPurify
// (vendored separately, window.DOMPurify) is a defense-in-depth sanitize
// pass before this ever gets stored or shown.
const STATIC_EXTENSIONS = extensions({
  uploadImage: () => Promise.reject(new Error("not available outside the editor")),
  getProducts: () => [],
});

export function renderWebsiteHTML(json) {
  if (!json || !json.type) return "";
  let html;
  try {
    html = generateHTML(json, STATIC_EXTENSIONS);
  } catch (e) {
    console.error("renderWebsiteHTML failed:", e);
    return "";
  }
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ["loading", "target", "rel"] });
  }
  console.error("DOMPurify is not loaded — website HTML was not sanitized.");
  return "";
}

export { EMPTY_DOC };
