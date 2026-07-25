/**
 * The document `digg serve` returns for every GET.
 *
 * The React app is one embedded string (see bundle.ts). Two things are stamped
 * into it per request instead of fetched by the client:
 *
 *   - the theme, on <html data-theme>, because a boot fetch paints the wrong
 *     colours first and then flips them;
 *   - a small boot object, so the shell can name the version and the last
 *     context before its first round trip.
 */

import { INDEX_HTML } from "./bundle.ts";

export interface PageBoot {
    theme: "light" | "dark";
    version: string;
    /** Per-run API token; see the security note in serve.ts. */
    token: string;
    context?: string;
    namespace?: string | null;
}

export function pageHtml(boot: PageBoot): string {
    // `</` inside a <script> would close the tag early; escaping the slash keeps
    // any context or namespace name from ending the script block.
    const json = JSON.stringify(boot).replace(/</g, "\\u003c");
    const tag = `<script>window.__DIGG__=${json};</script>`;
    return INDEX_HTML.replace('data-theme="dark"', `data-theme="${boot.theme}"`).replace("</head>", `${tag}</head>`);
}
