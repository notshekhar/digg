/**
 * Every write the browser can perform, behind one dispatcher.
 *
 * One endpoint instead of a dozen is deliberate: mutations are the part of this
 * product that can page someone at 3am, so they get exactly one door with the
 * confirmation contract stated in one place. The client sends a discriminated
 * union; anything not in this switch cannot happen.
 *
 * Nothing here decides whether an action is safe — the UI is responsible for
 * asking. What this file guarantees is that a mistyped kind or a missing
 * namespace turns into a 400 rather than a delete against the wrong object.
 */

import {
    type ResourceRef,
    applyManifest,
    patchResource,
    deleteResourceWith,
    drainNode,
    rolloutRestart,
    rolloutUndo,
    scaleResource,
    setNodeSchedulable,
    setSuspend,
    triggerCronJob,
} from "../kubectl.ts";

export interface ActionResult {
    ok: boolean;
    message: string;
    /** Per-target outcome, for bulk deletes where some succeed and some don't. */
    results?: { target: string; ok: boolean; message: string }[];
}

type RefInput = { kind?: string; name?: string; ns?: string | null; namespace?: string | null };

function toRef(context: string, input: RefInput | undefined): ResourceRef | null {
    if (!input?.kind || !input?.name) return null;
    const ns = input.ns ?? input.namespace ?? undefined;
    return { context, kind: input.kind, name: input.name, namespace: ns || undefined };
}

function label(ref: ResourceRef): string {
    return ref.namespace ? `${ref.namespace}/${ref.kind}/${ref.name}` : `${ref.kind}/${ref.name}`;
}

export async function runAction(body: Record<string, unknown>): Promise<ActionResult> {
    const action = String(body.action ?? "");
    const context = String(body.context ?? "");
    if (!context) return { ok: false, message: "context required" };

    switch (action) {
        case "apply": {
            const yaml = String(body.yaml ?? "");
            if (!yaml.trim()) return { ok: false, message: "empty manifest" };
            const out = await applyManifest(yaml, context);
            return { ok: true, message: out || "applied" };
        }

        case "delete": {
            const raw = Array.isArray(body.refs) ? (body.refs as RefInput[]) : [body.ref as RefInput];
            const refs = raw.map((r) => toRef(context, r)).filter((r): r is ResourceRef => r !== null);
            if (!refs.length) return { ok: false, message: "no valid targets" };
            const force = Boolean(body.force);
            const gracePeriod = typeof body.gracePeriod === "number" ? body.gracePeriod : undefined;
            const results: NonNullable<ActionResult["results"]> = [];
            for (const ref of refs) {
                try {
                    await deleteResourceWith(ref, { force, gracePeriod });
                    results.push({ target: label(ref), ok: true, message: "deleted" });
                } catch (err) {
                    results.push({
                        target: label(ref),
                        ok: false,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            const failed = results.filter((r) => !r.ok).length;
            return {
                ok: failed === 0,
                message:
                    failed === 0
                        ? `deleted ${results.length} object${results.length === 1 ? "" : "s"}`
                        : `${failed} of ${results.length} failed`,
                results,
            };
        }

        case "scale": {
            const ref = toRef(context, body.ref as RefInput);
            const replicas = Number(body.replicas);
            if (!ref) return { ok: false, message: "ref required" };
            if (!Number.isInteger(replicas) || replicas < 0) return { ok: false, message: "replicas must be >= 0" };
            await scaleResource(ref, replicas);
            return { ok: true, message: `scaled ${label(ref)} to ${replicas}` };
        }

        case "restart": {
            const ref = toRef(context, body.ref as RefInput);
            if (!ref) return { ok: false, message: "ref required" };
            await rolloutRestart(ref);
            return { ok: true, message: `restart triggered for ${label(ref)}` };
        }

        case "rollback": {
            const ref = toRef(context, body.ref as RefInput);
            if (!ref) return { ok: false, message: "ref required" };
            const revision = body.revision === undefined ? undefined : String(body.revision);
            await rolloutUndo(ref, revision);
            return { ok: true, message: `rolled back ${label(ref)}${revision ? ` to revision ${revision}` : ""}` };
        }

        case "cordon":
        case "uncordon": {
            const node = String(body.node ?? "");
            if (!node) return { ok: false, message: "node required" };
            await setNodeSchedulable(context, node, action === "uncordon");
            return { ok: true, message: `${node} ${action === "cordon" ? "cordoned" : "uncordoned"}` };
        }

        case "drain": {
            const node = String(body.node ?? "");
            if (!node) return { ok: false, message: "node required" };
            const out = await drainNode(context, node);
            return { ok: true, message: out.trim() || `${node} drained` };
        }

        case "suspend":
        case "resume": {
            const ref = toRef(context, body.ref as RefInput);
            if (!ref) return { ok: false, message: "ref required" };
            await setSuspend(ref, action === "suspend");
            return { ok: true, message: `${label(ref)} ${action === "suspend" ? "suspended" : "resumed"}` };
        }

        case "trigger": {
            const ref = toRef(context, body.ref as RefInput);
            if (!ref) return { ok: false, message: "ref required" };
            const out = await triggerCronJob(ref);
            return { ok: true, message: out.trim() || `triggered ${label(ref)}` };
        }

        case "setData": {
            const ref = toRef(context, body.ref as RefInput);
            if (!ref) return { ok: false, message: "ref required" };
            const set = (body.set ?? {}) as Record<string, string>;
            const remove = Array.isArray(body.remove) ? (body.remove as string[]) : [];
            if (!Object.keys(set).length && !remove.length) return { ok: false, message: "nothing to change" };

            // The API server rejects bad keys with a wall of validation text;
            // saying it here means the editor can point at the offending key.
            for (const key of [...Object.keys(set), ...remove]) {
                if (!/^[-._a-zA-Z0-9]+$/.test(key)) {
                    return { ok: false, message: `invalid key "${key}" — use letters, digits, - . _` };
                }
            }

            /*
             * Secrets are written through `stringData`, so the API server does
             * the base64 for us. Encoding here would mean trusting the browser
             * to get padding and UTF-8 right on every value, and a wrong
             * encoding is a secret that silently no longer works.
             *
             * Deletion is a null in `data` for both kinds — a JSON merge patch
             * removes exactly the named keys and leaves the rest alone.
             */
            const isSecret = ref.kind === "secrets" || ref.kind === "secret";
            const patch: Record<string, Record<string, string | null>> = {};
            if (Object.keys(set).length) {
                patch[isSecret ? "stringData" : "data"] = set;
            }
            if (remove.length) {
                patch.data = { ...(patch.data ?? {}), ...Object.fromEntries(remove.map((k) => [k, null])) };
            }
            await patchResource(ref, patch);

            const changed = Object.keys(set).length;
            const parts: string[] = [];
            if (changed) parts.push(`${changed} key${changed === 1 ? "" : "s"} saved`);
            if (remove.length) parts.push(`${remove.length} removed`);
            return { ok: true, message: `${label(ref)}: ${parts.join(", ")}` };
        }

        default:
            return { ok: false, message: `unknown action: ${action || "(none)"}` };
    }
}
