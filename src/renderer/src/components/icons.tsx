// Flat line icons (stroke = currentColor) so the UI never depends on font glyphs
// like ☰ ⟳ ⟩ ⋯ that can render as missing-character boxes on some systems.

type P = { size?: number };
const base = (size = 15) => ({
	width: size,
	height: size,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
	"aria-hidden": true,
});

export function ListIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<line x1="4" y1="7" x2="20" y2="7" />
			<line x1="4" y1="12" x2="20" y2="12" />
			<line x1="4" y1="17" x2="20" y2="17" />
		</svg>
	);
}

export function RefreshIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
			<path d="M21 4v4h-4" />
			<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
			<path d="M3 20v-4h4" />
		</svg>
	);
}

export function ChevronRightIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<polyline points="9 6 15 12 9 18" />
		</svg>
	);
}

export function ChevronDownIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

export function DotsIcon({ size }: P) {
	return (
		<svg {...base(size)} strokeWidth={2.5}>
			<circle cx="5" cy="12" r="0.6" />
			<circle cx="12" cy="12" r="0.6" />
			<circle cx="19" cy="12" r="0.6" />
		</svg>
	);
}

export function CloseIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<line x1="6" y1="6" x2="18" y2="18" />
			<line x1="18" y1="6" x2="6" y2="18" />
		</svg>
	);
}
