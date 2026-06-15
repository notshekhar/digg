/** First line of an error, trimmed for a status bar. */
export function errorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split("\n")[0].slice(0, 200);
}
