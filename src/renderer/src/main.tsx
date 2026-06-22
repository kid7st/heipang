import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "highlight.js/styles/github.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	render() {
		if (this.state.error) {
			return (
				<div style={{ padding: 40, fontFamily: "sans-serif", color: "#1d2621" }}>
					<h2 style={{ color: "#c0492f" }}>Something went wrong rendering this view.</h2>
					<p style={{ color: "#5c6b62" }}>Try switching to another conversation, or restart HEIPANG.</p>
					<pre style={{ background: "#f5f7f5", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
						{String(this.state.error?.message || this.state.error)}
					</pre>
					<button
						type="button"
						style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #2f9e63", background: "#e6f4ec", color: "#268052", cursor: "pointer" }}
						onClick={() => this.setState({ error: null })}
					>
						Dismiss
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
