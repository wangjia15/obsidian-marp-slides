import { deflateSync } from 'zlib';

export interface MermaidDimension {
    width?: string;
    height?: string;
}

export function extractMermaidDiagrams(markdown: string): string[] {
    const fenceRegex = /^```mermaid[^\n]*\n([\s\S]*?)^```/gm;
    const diagrams: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(markdown)) !== null) {
        diagrams.push(match[1]);
    }

    return diagrams;
}

export function parseMermaidDimensions(markdown: string): {
    processedMarkdown: string;
    dimensionMap: Map<string, MermaidDimension>;
} {
    const dimensionMap = new Map<string, MermaidDimension>();
    const fenceRegex = /^```mermaid\s*\{([^}]*)\}\n([\s\S]*?)^```/gm;

    const processedMarkdown = markdown.replace(fenceRegex, (_match, attrs: string, code: string) => {
        const widthMatch = attrs.match(/width\s*=\s*([^\s}]+)/);
        const heightMatch = attrs.match(/height\s*=\s*([^\s}]+)/);

        if (widthMatch || heightMatch) {
            const encoded = deflateSync(code, { level: 9 }).toString('base64url');
            const dim: MermaidDimension = {};
            if (widthMatch) dim.width = widthMatch[1];
            if (heightMatch) dim.height = heightMatch[1];
            dimensionMap.set(encoded, dim);
        }

        return `\`\`\`mermaid\n${code}\`\`\``;
    });

    return { processedMarkdown, dimensionMap };
}

export function applyMermaidStyling(
    html: string,
    css: string,
    dimensionMap: Map<string, MermaidDimension>,
    globalWidth: string,
    globalHeight: string
): { html: string; css: string } {
    const hasGlobalSizing = !!(globalWidth || globalHeight);

    // Marp wraps kroki embeds in <marp-auto-scaling>, a shadow-DOM custom element that
    // recalculates its own size via ResizeObserver and overrides any width/height we set
    // on the <embed> itself. Unwrap it whenever explicit sizing is requested so the CSS
    // we apply below actually controls the rendered size; diagrams with no sizing keep
    // the default auto-fit-to-slide behavior.
    if (dimensionMap.size > 0 || hasGlobalSizing) {
        html = html.replace(
            /<marp-auto-scaling[^>]*>(<embed(\s[^>]*?)?src="https:\/\/kroki\.io\/mermaid\/svg\/([^"]+)")([\s\S]*?)<\/marp-auto-scaling>/g,
            (match, _embedPrefix: string, before: string, encoded: string, tail: string) => {
                const dim = dimensionMap.get(encoded);
                if (!dim && !hasGlobalSizing) return match;

                const styles: string[] = [];
                if (dim?.width) styles.push(`width:${dim.width}`);
                if (dim?.height) styles.push(`height:${dim.height}`);

                const styleAttr = styles.length > 0 ? `style="${styles.join(';')}" ` : '';
                return `<embed${before || ' '}${styleAttr}src="https://kroki.io/mermaid/svg/${encoded}"${tail}`;
            }
        );
    }

    const globalStyles: string[] = [];
    if (globalWidth) globalStyles.push(`max-width:${globalWidth}`);
    if (globalHeight) globalStyles.push(`max-height:${globalHeight}`);
    if (globalStyles.length > 0) {
        css += `\np.kroki-image-container embed,p.kroki-image-container img{${globalStyles.join(';')}}`;
    }

    return { html, css };
}
