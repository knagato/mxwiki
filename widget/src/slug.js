// Slugs may be paths: `minutes/2026-08-14`. The sidebar shows the segments
// before the last `/` as folders (a folder exists while a page is under it).
import { MAX_BODY } from "./spec.js";

export const SLUG_RE = /^(?=.{1,128}$)[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export const isValidSlug = (slug) => SLUG_RE.test(slug);
export const folderOf = (slug) => (slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "");
export const byteLength = (s) => new TextEncoder().encode(s).length;
export const bodyTooLarge = (body) => byteLength(body) > MAX_BODY;
