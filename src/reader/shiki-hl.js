// Syntax highlighting for body payloads, via Shiki loaded from a CDN.
// Shiki lazy-loads the grammar + theme on first use of each language, so we
// only pay for what we render. Everything here is best-effort: on any failure
// (offline, unknown language, CDN hiccup) callers fall back to plain text.
//
// Exposes a single global: window.highlightCode(code, lang) -> Promise<string|null>
// where the resolved string is Shiki's <pre class="shiki">...</pre> HTML.
import { codeToHtml } from "https://esm.sh/shiki@1";

const THEME = "github-light";

window.highlightCode = async function highlightCode(code, lang) {
  if (!code || !lang) return null;
  try {
    return await codeToHtml(code, { lang, theme: THEME });
  } catch {
    return null;
  }
};
