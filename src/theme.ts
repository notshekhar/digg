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
    footer: (text: string) => chalk.gray(text),
};

export function getSelectListTheme(): SelectListTheme {
    return {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => chalk.gray(text),
        scrollInfo: (text) => chalk.gray(text),
        noMatch: (text) => chalk.gray(text),
    };
}
