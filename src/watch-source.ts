/**
 * Which watch a kind gets, and what happens when that choice is wrong.
 *
 * The API watch (`api-watch.ts`) is better in every way that matters — it
 * resumes from a resourceVersion instead of re-listing, and it knows when its
 * own list ended — but it needs the proxy socket to be up and the kind to be in
 * discovery. When either is missing, or the API refuses the watch outright, the
 * kubectl watch (`watch.ts`) is still there and still correct.
 *
 * The fallback happens once per store and is invisible to `live.ts`: both
 * implementations speak the same handler contract, so the client sees a
 * snapshot and events either way, and only hears "permanent failure" if BOTH
 * routes have given up.
 */

import { ApiResourceWatch } from "./api-watch.ts";
import { ResourceWatch, type WatchHandlers } from "./watch.ts";

export interface WatchLike {
    start: () => void;
    stop: () => void;
    /** Nudge an empty collection into emitting its snapshot (kubectl only). */
    settleSoon: () => void;
}

export interface CreateWatchOptions {
    context: string;
    kind: string;
    namespace?: string;
    clusterScoped?: boolean;
    /** Test seam: skip the API attempt entirely. */
    kubectlOnly?: boolean;
}

export function createWatch(opts: CreateWatchOptions, handlers: WatchHandlers): WatchLike {
    let stopped = false;
    let fellBack = false;
    let current: WatchLike;

    const kubectlWatch = (): WatchLike =>
        new ResourceWatch(
            { context: opts.context, kind: opts.kind, namespace: opts.namespace, clusterScoped: opts.clusterScoped },
            handlers,
        );

    if (opts.kubectlOnly) {
        current = kubectlWatch();
    } else {
        current = new ApiResourceWatch(
            {
                context: opts.context,
                kind: opts.kind,
                namespace: opts.namespace,
                clusterScoped: opts.clusterScoped,
            },
            {
                onSnapshot: handlers.onSnapshot,
                onEvent: handlers.onEvent,
                onError: (message, permanent) => {
                    // A permanent API failure is not the client's problem yet:
                    // kubectl may well be able to watch this kind (aggregated
                    // APIs and some CRDs answer one and not the other).
                    if (permanent && !fellBack && !stopped) {
                        fellBack = true;
                        current.stop();
                        current = kubectlWatch();
                        current.start();
                        return;
                    }
                    handlers.onError(message, permanent);
                },
            },
        );
    }

    return {
        start: () => current.start(),
        stop: () => {
            stopped = true;
            current.stop();
        },
        settleSoon: () => current.settleSoon(),
    };
}
