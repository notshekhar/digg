/**
 * Hand-drawn 16px icons on a 16-unit grid.
 *
 * No icon font, no library: an icon set is part of a product's voice, and these
 * are cut square-cornered and 1.5px-stroked to match a UI with no rounded
 * corners anywhere. Every glyph inherits currentColor.
 */

interface Props {
    size?: number;
    className?: string;
}

function Svg({ size = 15, className, children }: Props & { children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
            className={className}
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export const Icon = {
    Grid: (p: Props) => (
        <Svg {...p}>
            <rect x="2" y="2" width="5" height="5" />
            <rect x="9" y="2" width="5" height="5" />
            <rect x="2" y="9" width="5" height="5" />
            <rect x="9" y="9" width="5" height="5" />
        </Svg>
    ),
    Box: (p: Props) => (
        <Svg {...p}>
            <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" />
            <path d="M2 5l6 3.5L14 5M8 8.5V14" />
        </Svg>
    ),
    Layers: (p: Props) => (
        <Svg {...p}>
            <path d="M8 2 14.5 5.5 8 9 1.5 5.5z" />
            <path d="M2 8.5 8 11.8l6-3.3M2 11.2 8 14.5l6-3.3" />
        </Svg>
    ),
    Sliders: (p: Props) => (
        <Svg {...p}>
            <path d="M2 4.5h8M12.5 4.5H14M2 11.5h2M6.5 11.5H14" />
            <rect x="10" y="2.5" width="2.5" height="4" />
            <rect x="4" y="9.5" width="2.5" height="4" />
        </Svg>
    ),
    Network: (p: Props) => (
        <Svg {...p}>
            <rect x="6" y="1.5" width="4" height="4" />
            <rect x="1.5" y="10.5" width="4" height="4" />
            <rect x="10.5" y="10.5" width="4" height="4" />
            <path d="M8 5.5v3M3.5 10.5V8.5h9v2" />
        </Svg>
    ),
    Disk: (p: Props) => (
        <Svg {...p}>
            <ellipse cx="8" cy="4" rx="5.5" ry="2.2" />
            <path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" />
            <path d="M2.5 8.2c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
        </Svg>
    ),
    Shield: (p: Props) => (
        <Svg {...p}>
            <path d="M8 1.5 13.5 3.5v5c0 3-2.5 5.3-5.5 6.2C5 13.8 2.5 11.5 2.5 8.5v-5z" />
            <path d="M5.8 8.2 7.3 9.8l3-3.4" />
        </Svg>
    ),
    Code: (p: Props) => (
        <Svg {...p}>
            <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />
        </Svg>
    ),
    Terminal: (p: Props) => (
        <Svg {...p}>
            <rect x="1.5" y="2.5" width="13" height="11" />
            <path d="M4 6l2.5 2L4 10M8.5 10.5h4" />
        </Svg>
    ),
    Search: (p: Props) => (
        <Svg {...p}>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
        </Svg>
    ),
    Refresh: (p: Props) => (
        <Svg {...p}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 1.5v3.2h-3.2" />
        </Svg>
    ),
    Play: (p: Props) => (
        <Svg {...p}>
            <path d="M4 2.5 13 8l-9 5.5z" />
        </Svg>
    ),
    Pause: (p: Props) => (
        <Svg {...p}>
            <rect x="4" y="3" width="2.5" height="10" />
            <rect x="9.5" y="3" width="2.5" height="10" />
        </Svg>
    ),
    Sun: (p: Props) => (
        <Svg {...p}>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
        </Svg>
    ),
    Moon: (p: Props) => (
        <Svg {...p}>
            <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" />
        </Svg>
    ),
    Close: (p: Props) => (
        <Svg {...p}>
            <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
        </Svg>
    ),
    Chevron: (p: Props) => (
        <Svg {...p}>
            <path d="M6 3.5 10.5 8 6 12.5" />
        </Svg>
    ),
    ChevronDown: (p: Props) => (
        <Svg {...p}>
            <path d="M3.5 6 8 10.5 12.5 6" />
        </Svg>
    ),
    Trash: (p: Props) => (
        <Svg {...p}>
            <path d="M2.5 4h11M6 4V2h4v2M4 4l.7 10h6.6L12 4M6.7 6.5v5M9.3 6.5v5" />
        </Svg>
    ),
    Scale: (p: Props) => (
        <Svg {...p}>
            <path d="M8 2v12M4 5.5 8 2l4 3.5M4 10.5 8 14l4-3.5" />
        </Svg>
    ),
    Restart: (p: Props) => (
        <Svg {...p}>
            <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
            <path d="M12 1.5v3.2H8.8M4 14.5v-3.2h3.2" />
        </Svg>
    ),
    Forward: (p: Props) => (
        <Svg {...p}>
            <path d="M1.5 5.5h9M8 3l2.5 2.5L8 8M14.5 10.5h-9M8 8l-2.5 2.5L8 13" />
        </Svg>
    ),
    Doc: (p: Props) => (
        <Svg {...p}>
            <path d="M3.5 1.5h6L12.5 5v9.5h-9z" />
            <path d="M9.5 1.5V5h3M5.5 8h5M5.5 11h5" />
        </Svg>
    ),
    Logs: (p: Props) => (
        <Svg {...p}>
            <path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h6" />
        </Svg>
    ),
    Warn: (p: Props) => (
        <Svg {...p}>
            <path d="M8 1.8 15 14H1z" />
            <path d="M8 6v4M8 11.6v.8" />
        </Svg>
    ),
    Info: (p: Props) => (
        <Svg {...p}>
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7.2v4M8 4.6v.8" />
        </Svg>
    ),
    Check: (p: Props) => (
        <Svg {...p}>
            <path d="M3 8.5 6.5 12 13 4.5" />
        </Svg>
    ),
    Node: (p: Props) => (
        <Svg {...p}>
            <rect x="1.5" y="3" width="13" height="4" />
            <rect x="1.5" y="9" width="13" height="4" />
            <path d="M4 5h.01M4 11h.01" />
        </Svg>
    ),
    Cluster: (p: Props) => (
        <Svg {...p}>
            <circle cx="8" cy="8" r="2" />
            <circle cx="8" cy="2.5" r="1.4" />
            <circle cx="8" cy="13.5" r="1.4" />
            <circle cx="2.5" cy="8" r="1.4" />
            <circle cx="13.5" cy="8" r="1.4" />
        </Svg>
    ),
    Copy: (p: Props) => (
        <Svg {...p}>
            <rect x="5.5" y="5.5" width="9" height="9" />
            <path d="M10.5 5.5v-4h-9v9h4" />
        </Svg>
    ),
    Download: (p: Props) => (
        <Svg {...p}>
            <path d="M8 1.5v9M4.5 7.5 8 11l3.5-3.5M2 13.5h12" />
        </Svg>
    ),
    Filter: (p: Props) => (
        <Svg {...p}>
            <path d="M1.5 3h13l-5 5.5v5l-3 1.5v-6.5z" />
        </Svg>
    ),
    Columns: (p: Props) => (
        <Svg {...p}>
            <rect x="1.5" y="2.5" width="13" height="11" />
            <path d="M6 2.5v11M10 2.5v11" />
        </Svg>
    ),
    Edit: (p: Props) => (
        <Svg {...p}>
            <path d="M11 1.9 14.1 5 5.6 13.5 1.5 14.5l1-4.1z" />
            <path d="M9.4 3.5 12.5 6.6" />
        </Svg>
    ),
    Plus: (p: Props) => (
        <Svg {...p}>
            <path d="M8 2.5v11M2.5 8h11" />
        </Svg>
    ),
    Expand: (p: Props) => (
        <Svg {...p}>
            <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
        </Svg>
    ),
    Collapse: (p: Props) => (
        <Svg {...p}>
            <path d="M13 3 8.5 7.5M8.5 3.5v4h4M3 13l4.5-4.5M7.5 12.5v-4h-4" />
        </Svg>
    ),
    Bolt: (p: Props) => (
        <Svg {...p}>
            <path d="M9 1.5 3.5 9h4l-.5 5.5L12.5 7h-4z" />
        </Svg>
    ),
};

export type IconName = keyof typeof Icon;
