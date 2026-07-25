/**
 * The document `digg serve` returns for every GET.
 *
 * The React app is one embedded string (see bundle.ts). Two things are stamped
 * into it per request instead of fetched by the client:
 *
 *   - the theme, on <html data-theme>, because a boot fetch paints the wrong
 *     colours first and then flips them;
 *   - a small boot object, so the shell can name the version, the last context
 *     and the saved UI state before its first round trip. The UI state is
 *     stamped for the same reason as the theme: fetching it would render the
 *     default layout first and rearrange it a moment later.
 */

import { INDEX_HTML } from "./bundle.ts";

export interface PageBoot {
    theme: "light" | "dark";
    version: string;
    /** Per-run API token; see the security note in serve.ts. */
    token: string;
    context?: string;
    namespace?: string | null;
    /** Saved UI state (settings.ts), so the shell opens at its last shape. */
    ui?: Record<string, unknown>;
}

export function pageHtml(boot: PageBoot): string {
    // `</` inside a <script> would close the tag early; escaping the slash keeps
    // any context or namespace name from ending the script block.
    const json = JSON.stringify(boot).replace(/</g, "\\u003c");
    const tag = `<script>window.__DIGG__=${json};</script>`;
    return INDEX_HTML.replace('data-theme="dark"', `data-theme="${boot.theme}"`).replace("</head>", `${tag}</head>`);
}
