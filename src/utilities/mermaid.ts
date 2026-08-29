import { deflateSync } from 'zlib';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

// Reuse the exact URL builder the markdown-it-kroki pipeline uses, so warmed URLs
// and rendered embed URLs are byte-identical (kroki caches by URL).
const { generateUrl } = require('@kazumatu981/markdown-it-kroki/lib/diagram-encoder');

export const DEFAULT_KROKI_URL = 'https://kroki.io';

export interface MermaidDimension {
    width?: string;
    height?: string;
}

export function normalizeKrokiUrl(url: string | undefined | null): string {
    const trimmed = (url ?? '').trim().replace(/\/+$/, '');
    return trimmed !== '' ? trimmed : DEFAULT_KROKI_URL;
}

export function buildKrokiUrl(baseUrl: string, code: string): string {
    return generateUrl(normalizeKrokiUrl(baseUrl), 'mermaid', 'svg', code);
}

export interface KrokiTestResult {
    ok: boolean;
    status?: number;
    ms: number;
    detail: string;
}

// Renders a tiny known-good diagram on the target Kroki server and reports
// reachability, HTTP status and latency. Used by the settings-tab test button.
export function testKrokiServer(baseUrl: string, timeoutMs = 10000): Promise<KrokiTestResult> {
    const url = buildKrokiUrl(baseUrl, 'graph TD\n  A-->B');
    const started = Date.now();
    const requestFn = url.startsWith('http://') ? httpRequest : httpsRequest;

    return new Promise((resolve) => {
        const finish = (result: KrokiTestResult) => resolve(result);
        const req = requestFn(url, { timeout: timeoutMs }, (res) => {
            res.on('data', () => { /* drain */ });
            res.on('end', () => finish({
                ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                status: res.statusCode,
                ms: Date.now() - started,
                detail: `HTTP ${res.statusCode} from ${normalizeKrokiUrl(baseUrl)} in ${Date.now() - started}ms`,
            }));
            res.on('error', () => finish({
                ok: false,
                ms: Date.now() - started,
                detail: `response error: ${String(res)}`,
            }));
        });
        req.on('timeout', () => {
            req.destroy();
            finish({ ok: false, ms: Date.now() - started, detail: `timeout after ${timeoutMs}ms connecting to ${normalizeKrokiUrl(baseUrl)}` });
        });
        req.on('error', (e) => finish({
            ok: false,
            ms: Date.now() - started,
            detail: e instanceof Error ? e.message : String(e),
        }));
        req.end();
    });
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
    globalHeight: string,
    baseUrl: string = DEFAULT_KROKI_URL
): { html: string; css: string } {
    const hasGlobalSizing = !!(globalWidth || globalHeight);
    const normalizedBase = normalizeKrokiUrl(baseUrl);
    // The base URL is interpolated into a regex; escape regex metacharacters so a
    // custom URL with a port or path cannot break the pattern.
    const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Marp wraps kroki embeds in <marp-auto-scaling>, a shadow-DOM custom element that
    // recalculates its own size via ResizeObserver and overrides any width/height we set
    // on the <embed> itself. Unwrap it whenever explicit sizing is requested so the CSS
    // we apply below actually controls the rendered size; diagrams with no sizing keep
    // the default auto-fit-to-slide behavior.
    if (dimensionMap.size > 0 || hasGlobalSizing) {
        html = html.replace(
            new RegExp(`<marp-auto-scaling[^>]*>(<embed(\\s[^>]*?)?src="${escapedBase}/mermaid/svg/([^"]+)")([\\s\\S]*?)</marp-auto-scaling>`, 'g'),
            (match, _embedPrefix: string, before: string, encoded: string, tail: string) => {
                const dim = dimensionMap.get(encoded);
                if (!dim && !hasGlobalSizing) return match;

                const styles: string[] = [];
                if (dim?.width) styles.push(`width:${dim.width}`);
                if (dim?.height) styles.push(`height:${dim.height}`);

                const styleAttr = styles.length > 0 ? `style="${styles.join(';')}" ` : '';
                return `<embed${before || ' '}${styleAttr}src="${normalizedBase}/mermaid/svg/${encoded}"${tail}`;
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
