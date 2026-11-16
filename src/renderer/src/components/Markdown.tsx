import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "../highlightClient";

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		highlight(code, lang).then((h) => {
			if (alive) setHtml(h);
		});
		return () => {
			alive = false;
		};
	}, [code, lang]);

	return (
		<pre className="code-block">
			<div className="code-lang">{lang || ""}</div>
			<code
				className={`hljs language-${lang || "plaintext"}`}
				// biome-ignore lint: highlighted html from trusted worker
				dangerouslySetInnerHTML={html != null ? { __html: html } : undefined}
			>
				{html == null ? code : undefined}
			</code>
		</pre>
	);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					code(props) {
						const { children, className, node, ...rest } = props as any;
						const match = /language-(\w+)/.exec(className || "");
						const raw = String(children ?? "");
						const isBlock = raw.includes("\n") || !!match;
						if (!isBlock) {
							return (
								<code className="inline-code" {...rest}>
									{children}
								</code>
							);
						}
						return <CodeBlock code={raw.replace(/\n$/, "")} lang={match?.[1]} />;
					},
					a(props) {
						return <a {...props} target="_blank" rel="noreferrer" />;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
