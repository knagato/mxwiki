// Wire-format constants (docs/SPEC.md, Profile S). These names are stable API:
// changing any of them is a major version. spec/vectors.json pins them in tests.
export const PAGE_TYPE = "com.knatrix.mxwiki.page";
export const WIDGET_ID = "com.knatrix.mxwiki"; // state_key of the im.vector.modular.widgets event
export const MAX_BODY = 48 * 1024; // bytes; a whole event is capped at 64 KiB
