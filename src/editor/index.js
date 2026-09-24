import { mount, EMPTY_DOC } from "./studio.js";
import { renderWebsiteHTML } from "./render-website.js";
import { renderEmailHTML, SITE_URL_TOKEN } from "./render-email.js";
import { validateImageFile, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "./validate-upload.js";
import { isSafeUrl } from "./safe-url.js";

function extractPlainText(json, maxLen) {
  if (!json || !Array.isArray(json.content)) return "";
  const parts = [];
  function walk(nodes) {
    (nodes || []).forEach(node => {
      if (node.type === "text") parts.push(node.text);
      if (node.type === "podaPullQuote" && node.attrs && node.attrs.quote) parts.push(node.attrs.quote);
      if (Array.isArray(node.content)) walk(node.content);
    });
  }
  walk(json.content);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  const limit = maxLen || 200;
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

window.PodaEditor = {
  mount,
  EMPTY_DOC,
  renderWebsiteHTML,
  renderEmailHTML,
  SITE_URL_TOKEN,
  extractPlainText,
  validateImageFile,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  isSafeUrl,
};
