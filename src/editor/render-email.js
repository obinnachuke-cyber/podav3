import { isSafeUrl } from "./safe-url.js";

// Email HTML is NOT derived from the website renderer — Gmail/Outlook need
// table layouts and inline styles, and multi-column sections must always
// stack. This walks the same canonical Tiptap JSON with its own purpose-
// built renderer. Every tag below is emitted by this code from structured
// data (never raw admin HTML), and all text goes through esc(), so there's
// nothing here for DOMPurify to need to catch.

const TEXT = "font-family:Georgia,'Times New Roman',serif;color:#090909;";
const MUTED = "color:#666;";
const SERIF = "font-family:Georgia,'Times New Roman',serif;";
const LABEL = "font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#999790;";

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function href(value) {
  return isSafeUrl(value) ? esc(value) : "#";
}

function renderMarks(text, marks) {
  let html = esc(text);
  (marks || []).forEach(mark => {
    if (mark.type === "bold") html = `<strong>${html}</strong>`;
    if (mark.type === "italic") html = `<em>${html}</em>`;
    if (mark.type === "link" && mark.attrs && isSafeUrl(mark.attrs.href)) {
      html = `<a href="${href(mark.attrs.href)}" style="color:#090909;text-decoration:underline;">${html}</a>`;
    }
  });
  return html;
}

function renderInline(content) {
  return (content || [])
    .map(node => {
      if (node.type === "text") return renderMarks(node.text, node.marks);
      if (node.type === "hardBreak") return "<br/>";
      return "";
    })
    .join("");
}

function renderNodes(nodes) {
  return (nodes || []).map(renderNode).join("");
}

function renderNode(node) {
  switch (node.type) {
    case "paragraph":
      return `<p style="${TEXT}font-size:15px;line-height:1.6;margin:0 0 16px;">${renderInline(node.content) || "&nbsp;"}</p>`;
    case "heading": {
      const level = (node.attrs && node.attrs.level) || 2;
      const size = level === 2 ? "22px" : "18px";
      return `<h${level} style="${SERIF}font-weight:600;font-size:${size};line-height:1.25;margin:24px 0 12px;color:#090909;">${renderInline(node.content)}</h${level}>`;
    }
    case "bulletList":
      return `<ul style="${TEXT}font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:22px;">${renderNodes(node.content)}</ul>`;
    case "orderedList":
      return `<ol style="${TEXT}font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:22px;">${renderNodes(node.content)}</ol>`;
    case "listItem":
      return `<li style="margin:0 0 6px;">${(node.content || []).map(child => child.type === "paragraph" ? renderInline(child.content) : renderNode(child)).join("")}</li>`;
    case "blockquote":
      return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #244CFF;${TEXT}font-size:15px;font-style:italic;">${renderNodes(node.content)}</blockquote>`;
    case "horizontalRule":
      return `<hr style="border:none;border-top:1px solid #26262a;margin:24px 0;" />`;
    case "podaImage":
      return renderImage(node.attrs);
    case "podaThesis":
      return renderThesis(node);
    case "podaPullQuote":
      return renderPullQuote(node.attrs);
    case "podaImageText":
      return renderImageText(node);
    case "podaProductCard":
      return renderProductCard(node.attrs);
    case "podaSources":
      return renderSources(node.attrs);
    default:
      return "";
  }
}

function renderImage(attrs) {
  const { src, alt, caption } = attrs || {};
  if (!src) return "";
  const captionRow = caption
    ? `<tr><td style="padding:8px 0 0;${LABEL}">${esc(caption)}</td></tr>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td><img src="${href(src)}" alt="${esc(alt)}" width="100%" style="display:block;width:100%;max-width:100%;border:1px solid #26262a;" /></td></tr>
      ${captionRow}
    </table>`;
}

function renderThesis(node) {
  const eyebrow = (node.attrs && node.attrs.eyebrow) || "The poda thesis";
  const body = renderNodes(node.content);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#244CFF;">
      <tr><td style="padding:24px 24px 4px;${LABEL}color:#ffffff;">${esc(eyebrow)}</td></tr>
      <tr><td style="padding:0 24px 24px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;">${body.replace(/color:#090909;/g, "color:#ffffff;")}</td></tr>
    </table>`;
}

function renderPullQuote(attrs) {
  const { quote, attribution } = attrs || {};
  const attributionRow = attribution
    ? `<p style="margin:12px 0 0;${LABEL}text-align:center;">— ${esc(attribution)}</p>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td style="padding:20px 12px;border-top:1px solid #26262a;border-bottom:1px solid #26262a;text-align:center;">
        <p style="${SERIF}font-size:24px;line-height:1.3;font-style:italic;color:#090909;margin:0;">“${esc(quote)}”</p>
        ${attributionRow}
      </td></tr>
    </table>`;
}

// Email clients can't reliably do side-by-side columns, so image + text
// always stacks — image first, then text — regardless of the website's
// imageSide setting.
function renderImageText(node) {
  const { imageSrc, imageAlt } = node.attrs || {};
  const imageRow = imageSrc
    ? `<tr><td style="padding:0 0 12px;"><img src="${href(imageSrc)}" alt="${esc(imageAlt)}" width="100%" style="display:block;width:100%;max-width:100%;border:1px solid #26262a;" /></td></tr>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      ${imageRow}
      <tr><td>${renderNodes(node.content)}</td></tr>
    </table>`;
}

// A relative link (like the website uses) doesn't resolve in an email
// client, but this module — running client-side at save time — doesn't
// reliably know the production site origin either. So internal item links
// are emitted as a placeholder token; both _worker.js (before sending) and
// admin.js (for "Preview Email") replace %%SITE_URL%% with the real origin.
export const SITE_URL_TOKEN = "%%SITE_URL%%";

function renderProductCard(attrs) {
  const { name, brand, price, image, commentary, linkTarget, itemId, externalUrl } = attrs || {};
  const url = linkTarget === "item" && itemId
    ? `${SITE_URL_TOKEN}/item.html?id=${encodeURIComponent(itemId)}`
    : (isSafeUrl(externalUrl) ? externalUrl : "#");
  const imageCell = image
    ? `<td width="96" style="padding:0 16px 0 0;vertical-align:top;"><img src="${href(image)}" alt="${esc(name)}" width="96" style="display:block;width:96px;height:auto;border:1px solid #26262a;" /></td>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #26262a;">
      <tr><td style="padding:16px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          ${imageCell}
          <td style="vertical-align:top;">
            ${brand ? `<p style="${LABEL}margin:0 0 4px;">${esc(brand)}</p>` : ""}
            <p style="${SERIF}font-size:16px;margin:0 0 4px;color:#090909;">${esc(name || "Untitled product")}</p>
            ${price ? `<p style="${TEXT}font-size:14px;margin:0 0 8px;">$${esc(price)}</p>` : ""}
            ${commentary ? `<p style="${TEXT}font-size:13px;line-height:1.5;margin:0 0 8px;${MUTED}">${esc(commentary)}</p>` : ""}
            <a href="${esc(url)}" style="${LABEL}color:#090909;text-decoration:underline;">${linkTarget === "item" ? "Shop The Edit" : "Shop"} &rarr;</a>
          </td>
        </tr></table>
      </td></tr>
    </table>`;
}

function renderSources(attrs) {
  const entries = Array.isArray(attrs && attrs.entries) ? attrs.entries : [];
  if (!entries.length) return "";
  const rows = entries
    .filter(entry => entry && (entry.name || entry.title || entry.url))
    .map(entry => {
      const label = esc(entry.title || entry.url || "Source");
      const linked = isSafeUrl(entry.url) ? `<a href="${href(entry.url)}" style="color:#090909;">${label}</a>` : label;
      const bits = [entry.name ? esc(entry.name) : "", linked, entry.date ? esc(entry.date) : ""].filter(Boolean);
      return `<p style="${TEXT}font-size:13px;line-height:1.6;margin:0 0 6px;">${bits.join(" — ")}</p>`;
    })
    .join("");
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;padding-top:16px;border-top:1px solid #26262a;">
      <tr><td style="padding:0 0 8px;${LABEL}">Sources</td></tr>
      <tr><td>${rows}</td></tr>
    </table>`;
}

export function renderEmailHTML(json) {
  if (!json || !json.type || !Array.isArray(json.content)) return "";
  return renderNodes(json.content);
}
