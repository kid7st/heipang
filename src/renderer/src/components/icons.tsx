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

export function CheckIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

export function PauseIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M10 4v16M16 4v16" />
		</svg>
	);
}

export function UndoIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M3 7v6h6" />
			<path d="M3 13a9 9 0 1 0 3-7" />
		</svg>
	);
}

export function TargetIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<circle cx="12" cy="12" r="8" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}

export function WarnIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
		</svg>
	);
}

export function TrashIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M16 7v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7" />
		</svg>
	);
}

export function ArrowRightIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M5 12h14M13 6l6 6-6 6" />
		</svg>
	);
}

export function FileTextIcon({ size }: P) {
	return (
		<svg {...base(size)}>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
			<path d="M14 3v5h5" />
			<path d="M9 13h6M9 17h6" />
		</svg>
	);
}
