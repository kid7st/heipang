import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function patchAnthropic() {
	const file = join(process.cwd(), "node_modules", "@mariozechner", "pi-ai", "dist", "providers", "anthropic.js");
	if (!existsSync(file)) {
		console.warn(`[patch-pi-pdf] skipped Anthropic: ${file} not found`);
		return;
	}
	let src = readFileSync(file, "utf8");
	if (src.includes("function convertAttachmentBlock(block)")) {
		console.log("[patch-pi-pdf] Anthropic already patched");
		return;
	}

	const oldConvertContentBlocks = `/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content) {
    // If only text blocks, return as concatenated string for simplicity
    const hasImages = content.some((c) => c.type === "image");
    if (!hasImages) {
        return sanitizeSurrogates(content.map((c) => c.text).join("\\n"));
    }
    // If we have images, convert to content block array
    const blocks = content.map((block) => {
        if (block.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(block.text),
            };
        }
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: block.mimeType,
                data: block.data,
            },
        };
    });
    // If only images (no text), add placeholder text block
    const hasText = blocks.some((b) => b.type === "text");
    if (!hasText) {
        blocks.unshift({
            type: "text",
            text: "(see attached image)",
        });
    }
    return blocks;
}
`;

	const newConvertContentBlocks = `/**
 * Convert image/PDF attachment blocks to Anthropic API format.
 * pi currently carries attachments through the ImageContent shape; PDF blocks
 * are identified by mimeType and must be sent to Anthropic as document blocks.
 */
function convertAttachmentBlock(block) {
    if (block.mimeType === "application/pdf") {
        return {
            type: "document",
            source: {
                type: "base64",
                media_type: "application/pdf",
                data: block.data,
            },
        };
    }
    return {
        type: "image",
        source: {
            type: "base64",
            media_type: block.mimeType,
            data: block.data,
        },
    };
}
/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content) {
    // If only text blocks, return as concatenated string for simplicity
    const hasAttachments = content.some((c) => c.type === "image");
    if (!hasAttachments) {
        return sanitizeSurrogates(content.map((c) => c.text).join("\\n"));
    }
    // If we have attachments, convert to content block array
    const blocks = content.map((block) => {
        if (block.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(block.text),
            };
        }
        return convertAttachmentBlock(block);
    });
    // If only attachments (no text), add placeholder text block
    const hasText = blocks.some((b) => b.type === "text");
    if (!hasText) {
        blocks.unshift({
            type: "text",
            text: "(see attached file)",
        });
    }
    return blocks;
}
`;

	if (!src.includes(oldConvertContentBlocks)) {
		throw new Error("[patch-pi-pdf] expected Anthropic convertContentBlocks block not found; pi-ai may have changed");
	}
	src = src.replace(oldConvertContentBlocks, newConvertContentBlocks);

	const oldUserMessageAttachment = `                    else {
                        return {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
`;
	const newUserMessageAttachment = `                    else {
                        return convertAttachmentBlock(item);
                    }
`;
	if (!src.includes(oldUserMessageAttachment)) {
		throw new Error("[patch-pi-pdf] expected Anthropic user attachment conversion block not found; pi-ai may have changed");
	}
	src = src.replace(oldUserMessageAttachment, newUserMessageAttachment);

	const oldCacheControl = `(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")`;
	const newCacheControl = `(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "document" || lastBlock.type === "tool_result")`;
	if (!src.includes(oldCacheControl)) {
		throw new Error("[patch-pi-pdf] expected Anthropic cache_control type guard not found; pi-ai may have changed");
	}
	src = src.replace(oldCacheControl, newCacheControl);

	writeFileSync(file, src);
	console.log("[patch-pi-pdf] patched Anthropic PDF document support");
}

function patchFrontmatterParser() {
	const file = join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "dist", "utils", "frontmatter.js");
	if (!existsSync(file)) {
		console.warn(`[patch-pi-pdf] skipped frontmatter: ${file} not found`);
		return;
	}
	let src = readFileSync(file, "utf8");
	if (src.includes("function parseLenientFrontmatter")) {
		console.log("[patch-pi-pdf] frontmatter already patched");
		return;
	}

	const oldParseFrontmatter = `export const parseFrontmatter = (content) => {
    const { yamlString, body } = extractFrontmatter(content);
    if (!yamlString) {
        return { frontmatter: {}, body };
    }
    const parsed = parse(yamlString);
    return { frontmatter: (parsed ?? {}), body };
};
`;
	const newParseFrontmatter = `function unquoteFrontmatterValue(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function parseLenientFrontmatter(yamlString) {
    try {
        return parse(yamlString) ?? {};
    }
    catch (error) {
        const out = { __piFrontmatterWarning: error instanceof Error ? error.message : String(error) };
        const lines = yamlString.split("\\n");
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^([A-Za-z0-9_-]+):(?:\\s*)(.*)$/);
            if (!m)
                continue;
            const key = m[1];
            let value = m[2] ?? "";
            if (/^[>|]/.test(value.trim())) {
                const block = [];
                for (i++; i < lines.length; i++) {
                    const line = lines[i];
                    if (/^[A-Za-z0-9_-]+:/.test(line)) {
                        i--;
                        break;
                    }
                    block.push(line.replace(/^ {1,2}/, ""));
                }
                out[key] = block.join(value.trim().startsWith(">") ? " " : "\\n").trim();
            }
            else {
                out[key] = unquoteFrontmatterValue(value);
            }
        }
        return out;
    }
}
export const parseFrontmatter = (content) => {
    const { yamlString, body } = extractFrontmatter(content);
    if (!yamlString) {
        return { frontmatter: {}, body };
    }
    const parsed = parseLenientFrontmatter(yamlString);
    return { frontmatter: (parsed ?? {}), body };
};
`;
	if (!src.includes(oldParseFrontmatter)) {
		throw new Error("[patch-pi-pdf] expected frontmatter parser block not found; pi-coding-agent may have changed");
	}
	src = src.replace(oldParseFrontmatter, newParseFrontmatter);

	const skillsFile = join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "dist", "core", "skills.js");
	if (existsSync(skillsFile)) {
		let skills = readFileSync(skillsFile, "utf8");
		if (!skills.includes("frontmatter.__piFrontmatterWarning")) {
			const anchor = `        const skillDir = dirname(filePath);
        const parentDirName = basename(skillDir);
`;
			const replacement = `        const skillDir = dirname(filePath);
        const parentDirName = basename(skillDir);
        if (frontmatter.__piFrontmatterWarning) {
            diagnostics.push({ type: "warning", message: ` + "`Invalid YAML frontmatter was loaded leniently: ${frontmatter.__piFrontmatterWarning}`" + `, path: filePath });
        }
`;
			if (!skills.includes(anchor)) {
				throw new Error("[patch-pi-pdf] expected skills diagnostics anchor not found; pi-coding-agent may have changed");
			}
			skills = skills.replace(anchor, replacement);
			writeFileSync(skillsFile, skills);
		}
	}

	writeFileSync(file, src);
	console.log("[patch-pi-pdf] patched lenient skill frontmatter parsing");
}

function patchOpenAIResponses() {
	const file = join(process.cwd(), "node_modules", "@mariozechner", "pi-ai", "dist", "providers", "openai-responses-shared.js");
	if (!existsSync(file)) {
		console.warn(`[patch-pi-pdf] skipped OpenAI Responses: ${file} not found`);
		return;
	}
	let src = readFileSync(file, "utf8");
	if (src.includes("function convertResponsesAttachmentBlock(item)")) {
		console.log("[patch-pi-pdf] OpenAI Responses already patched");
		return;
	}

	const anchor = `// =============================================================================
// Message conversion
// =============================================================================
export function convertResponsesMessages`;
	const helper = `// =============================================================================
// Message conversion
// =============================================================================
function convertResponsesAttachmentBlock(item) {
    if (item.mimeType === "application/pdf") {
        return {
            type: "input_file",
            filename: item.name || "document.pdf",
            file_data: ` + "`data:${item.mimeType};base64,${item.data}`" + `,
        };
    }
    return {
        type: "input_image",
        detail: "auto",
        image_url: ` + "`data:${item.mimeType};base64,${item.data}`" + `,
    };
}
export function convertResponsesMessages`;
	if (!src.includes(anchor)) {
		throw new Error("[patch-pi-pdf] expected OpenAI Responses message conversion anchor not found; pi-ai may have changed");
	}
	src = src.replace(anchor, helper);

	const imageBlock = `                    return {
                        type: "input_image",
                        detail: "auto",
                        image_url: ` + "`data:${item.mimeType};base64,${item.data}`" + `,
                    };
`;
	const attachmentBlock = `                    return convertResponsesAttachmentBlock(item);
`;
	if (!src.includes(imageBlock)) {
		throw new Error("[patch-pi-pdf] expected OpenAI user image conversion block not found; pi-ai may have changed");
	}
	src = src.replace(imageBlock, attachmentBlock);

	const toolImageBlock = `                        contentParts.push({
                            type: "input_image",
                            detail: "auto",
                            image_url: ` + "`data:${block.mimeType};base64,${block.data}`" + `,
                        });
`;
	const toolAttachmentBlock = `                        contentParts.push(convertResponsesAttachmentBlock(block));
`;
	if (src.includes(toolImageBlock)) {
		src = src.replace(toolImageBlock, toolAttachmentBlock);
	}

	writeFileSync(file, src);
	console.log("[patch-pi-pdf] patched OpenAI Responses PDF file support");
}

patchAnthropic();
patchOpenAIResponses();
patchFrontmatterParser();
