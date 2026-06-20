import chalk from "chalk";
import type { SelectListTheme } from "@earendil-works/pi-tui";

export const ui = {
    headerBar: (text: string) => chalk.bgCyan.black.bold(text),
    headerKey: (text: string) => chalk.gray(text),
    headerVal: (text: string) => chalk.cyan(text),
    rule: (text: string) => chalk.dim.gray(text),
    columnHeader: (text: string) => chalk.bold.gray(text),
    selectedRow: (text: string) => chalk.bgBlue.white(text),
    dim: (text: string) => chalk.gray(text),
    accent: (text: string) => chalk.cyan(text),
    danger: (text: string) => chalk.red(text),
    warn: (text: string) => chalk.yellow(text),
    footer: (text: string) => chalk.gray(text),
};

/**
 * Detect a log line's severity and return a colorizer, or null for plain.
 * Handles common keywords, JSON `"level":"…"`, and klog (`E0615 …`) prefixes.
 */
export function logLevelColor(line: string): ((text: string) => string) | null {
    // klog/glog: first char E/W/I/F + 4-digit date (kube components use this).
    const klog = /^([EWIF])\d{4}\s/.exec(line);
    if (klog) {
        const c = klog[1];
        if (c === "E" || c === "F") return chalk.red;
        if (c === "W") return chalk.yellow;
        return chalk.cyan;
    }
    const lower = line.toLowerCase();
    if (/\b(error|err|fatal|panic|exception|crit(ical)?)\b/.test(lower) || /"level":\s*"(error|fatal|critical)"/.test(lower)) {
        return chalk.red;
    }
    if (/\b(warn|warning)\b/.test(lower) || /"level":\s*"warn(ing)?"/.test(lower)) {
        return chalk.yellow;
    }
    if (/\b(info|notice)\b/.test(lower) || /"level":\s*"info"/.test(lower)) {
        return chalk.cyan;
    }
    if (/\b(debug|trace)\b/.test(lower) || /"level":\s*"(debug|trace)"/.test(lower)) {
        return chalk.gray;
    }
    return null;
}

export function getSelectListTheme(): SelectListTheme {
    return {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => chalk.gray(text),
        scrollInfo: (text) => chalk.gray(text),
        noMatch: (text) => chalk.gray(text),
    };
}
