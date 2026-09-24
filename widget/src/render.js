// Markdown with [[slug]] / [[slug|label]] links. Links to pages that do not
// exist get the `missing` class (dashed); clicking one offers to create it.
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({ gfm: true, breaks: false });

export function render(src, known) {
  const withLinks = src.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, slug, label) => {
    slug = slug.trim();
    const cls = known.has(slug) ? "wikilink" : "wikilink missing";
    return `<a href="#${encodeURIComponent(slug)}" class="${cls}" data-slug="${slug}">${label || slug}</a>`;
  });
  const html = marked.parse(withLinks);
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "data-slug"] });
}

export const sanitize = (s) => DOMPurify.sanitize(s);
export const fmtTs = (iso) => (iso ? iso.replace("T", " ").replace(/:\d\dZ$/, "Z") : "");
export const short = (uid) => (uid || "").replace(/:.*/, "");
