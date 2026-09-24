// Pins the widget's wire-format constants and slug / size rules to
// spec/vectors.json (the CLI tests load the same file).
//   node --test test/unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE_TYPE, WIDGET_ID, MAX_BODY } from "../src/spec.js";
import { isValidSlug, folderOf, bodyTooLarge } from "../src/slug.js";

const V = JSON.parse(readFileSync(new URL("../../spec/vectors.json", import.meta.url), "utf8"));

test("wire-format constants match SPEC", () => {
  assert.equal(PAGE_TYPE, V.page_type);
  assert.equal(WIDGET_ID, V.widget_state_key);
  assert.equal(MAX_BODY, V.max_body_bytes);
});

test("valid slugs are accepted", () => {
  for (const s of V.slug_valid) assert.ok(isValidSlug(s), s);
});

test("invalid slugs are rejected", () => {
  for (const s of V.slug_invalid) assert.ok(!isValidSlug(s), s);
});

test("body limit counts UTF-8 bytes", () => {
  assert.ok(!bodyTooLarge("x".repeat(V.max_body_bytes)));
  assert.ok(bodyTooLarge("x".repeat(V.max_body_bytes + 1)));
  // 3 bytes per character: 16384 fit, 16385 do not.
  assert.ok(!bodyTooLarge("あ".repeat(V.max_body_bytes / 3)));
  assert.ok(bodyTooLarge("あ".repeat(V.max_body_bytes / 3 + 1)));
});

test("folderOf", () => {
  assert.equal(folderOf("home"), "");
  assert.equal(folderOf("minutes/2026-09-14"), "minutes");
  assert.equal(folderOf("a/b/c"), "a/b");
});
