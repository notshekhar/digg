import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Injected at build time by build-bin.ts. Undefined when running from source.
declare const __KUBE_VERSION__: string;

const REPO_SLUG = "notshekhar/kube";
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;

export function packageRoot(): string {
    return dirname(dirname(new URL(import.meta.url).pathname));
}

export function getVersion(): string {
    if (typeof __KUBE_VERSION__ !== "undefined") {
        return __KUBE_VERSION__;
    }
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

export function runUpgrade(opts: { force?: boolean } = {}): void {
    const root = packageRoot();
    process.stdout.write(`▶ Updating kube (current v${getVersion()})…\n`);

    if (existsSync(join(root, ".git"))) {
        const pull = spawnSync("git", ["-C", root, "pull", opts.force ? "--force" : "--ff-only"], { stdio: "inherit" });
        if (pull.status !== 0) {
            process.exit(pull.status ?? 1);
        }
        const install = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
        process.exit(install.status ?? 0);
    }

    const env = { ...process.env };
    if (opts.force) {
        env.KUBE_FORCE = "1";
    }
    const result = spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], { stdio: "inherit", env });
    process.exit(result.status ?? 1);
}
