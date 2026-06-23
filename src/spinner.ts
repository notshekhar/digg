/**
 * A single shared spinner animation for the whole app.
 *
 * kubectl calls block for anywhere from tens of milliseconds to a few seconds
 * (slow auth plugins, big clusters, `logs -f` waiting for its first line). The
 * 2s app tick is far too slow to animate a spinner, and a blocking `await`
 * produces no renders on its own — so this module owns a fast, ref-counted
 * ticker: callers `begin()` before an async wait and `end()` after, and while
 * any wait is in flight the ticker advances the frame and asks for a repaint.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 90;

let frame = 0;

/** The current spinner glyph. Advances while any loading is in flight. */
export function spinnerFrame(): string {
    return FRAMES[frame % FRAMES.length];
}

class Animator {
    private timer?: ReturnType<typeof setInterval>;
    private refs = 0;
    private onTick?: () => void;

    /** Wire the repaint callback once at startup (the app's requestRender). */
    setRenderer(onTick: () => void): void {
        this.onTick = onTick;
    }

    /** Mark one loading operation as started; starts the ticker if idle. */
    begin(): void {
        this.refs++;
        if (!this.timer) {
            this.timer = setInterval(() => {
                frame = (frame + 1) % FRAMES.length;
                this.onTick?.();
            }, INTERVAL_MS);
        }
    }

    /** Mark one loading operation as finished; stops the ticker when none remain. */
    end(): void {
        this.refs = Math.max(0, this.refs - 1);
        if (this.refs === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}

export const animator = new Animator();
