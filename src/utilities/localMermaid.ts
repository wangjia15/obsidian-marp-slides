import { MarpSlidesSettings } from './settings';
import { MermaidTheme, resolveDeckConfig } from './deckConfig';


// Local mermaid rendering.
//
// The upstream pipeline delegates every ```mermaid fence to a Kroki server via
// markdown-it-kroki, which means diagrams silently vanish whenever the server is
// unreachable. This module renders fences offline with the mermaid runtime that is
// bundled into the plugin: each fence is replaced, before the Marp conversion, by a
// raw-HTML block holding the pre-rendered inline SVG. Because the replacement
// happens at the markdown level, the same code path serves the in-app preview, the
// marp-cli based exports and the editable PPTX export.
//
// The mermaid runtime is imported lazily (and only when MermaidRenderMode is
// 'local') so plugin startup stays untouched.

type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | undefined;
let initializedKey = '';

// mermaid.initialize() is global and survives across calls, so re-running it is
// the only way to switch config once the runtime is loaded. It's cheap, but
// skip it when nothing that affects the output changed.
function mermaidConfig(theme: MermaidTheme, fontFamily: string) {
    const font = fontFamily.trim();
    return {
        startOnLoad: false,
        securityLevel: 'loose' as const,
        theme,
        // Measure and paint labels with the same explicitly named font. Left to
        // its default ("trebuchet ms", verdana, arial), mermaid measures CJK
        // labels in a Latin font — every glyph then falls back to a wider system
        // font at paint time and overflows / clips its node box.
        ...(font ? { fontFamily: font, themeVariables: { fontFamily: font } } : {}),
        // htmlLabels wrap each label in a <foreignObject> sized to the measured
        // width; any measurement drift (or a rasteriser that renders
        // foreignObject poorly) then clips the text. Plain SVG <text> is sized
        // from getBBox() (exact) and, being SVG text, is never clipped by its
        // node box even if a little drift remains. Set at the root level as
        // mermaid 11 wants; the per-diagram flag is deprecated but still honoured.
        htmlLabels: false,
        // padding kept at mermaid's default (15) plus a small margin, so a hair
        // of cross-environment metric drift still lands inside the box.
        flowchart: { htmlLabels: false, padding: 18, useMaxWidth: true },
    };
}

function getMermaid(theme: MermaidTheme, fontFamily: string): Promise<MermaidModule> {
    const key = `${theme}|${fontFamily}`;
    if (!mermaidPromise) {
        mermaidPromise = import('mermaid').then((m) => {
            const mermaid = m.default;
            mermaid.initialize(mermaidConfig(theme, fontFamily));
            initializedKey = key;
            return mermaid;
        });
    }
    return mermaidPromise.then((mermaid) => {
        if (initializedKey !== key) {
            mermaid.initialize(mermaidConfig(theme, fontFamily));
            initializedKey = key;
        }
        return mermaid;
    });
}

let renderCounter = 0;

async function renderMermaidToSvg(code: string, theme: MermaidTheme, fontFamily: string): Promise<string> {
    const mermaid = await getMermaid(theme, fontFamily);
    // Label boxes are sized from measured text: if a webfont is still loading
    // when we render, the fallback metrics get baked into the SVG. Wait for
    // fonts to settle first (best-effort; not every host exposes the API).
    try {
        const fonts = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document?.fonts;
        if (fonts?.ready) await fonts.ready;
    } catch { /* no font API available - proceed */ }
    const id = `marp-slides-mermaid-${Date.now()}-${renderCounter++}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
}

// Rewrites the opening <svg> tag so the diagram scales inside the slide instead of
// overflowing it: fixed width/height attributes are dropped (the viewBox keeps the
// aspect ratio) and a max-width/max-height style is applied. Deck-level CSS can
// still override this since the wrapper keeps the `mermaid` class.
export function styleMermaidSvg(svg: string, maxWidth: string, maxHeight: string): string {
    const openTagMatch = svg.match(/<svg\b[^>]*>/);
    if (!openTagMatch) return svg;

    const openTag = openTagMatch[0];
    const hasViewBox = /viewBox\s*=/.test(openTag);

    let attrs = openTag.slice(4, -1);
    if (hasViewBox) {
        // Without a viewBox the intrinsic width/height must survive, or the svg
        // collapses to 0x0; with one they are redundant and just fight the caps.
        attrs = attrs.replace(/\s(?:width|height)\s*=\s*"[^"]*"/g, '');
    }
    // Drop mermaid's own style (usually `max-width: <n>px`) so ours wins.
    attrs = attrs.replace(/\sstyle\s*=\s*"[^"]*"/g, '');

    const style = `max-width:${maxWidth};max-height:${maxHeight}`;
    return svg.replace(openTag, `<svg${attrs} style="${style}">`);
}

export interface LocalMermaidFailure {
    message: string;
    source: string;
}

export interface LocalMermaidResult {
    markdown: string;
    renderedCount: number;
    failures: LocalMermaidFailure[];
}

interface FenceMatch {
    full: string;
    attrs: string;
    code: string;
    index: number;
}

// Matches the same fence shapes the upstream regexes accept: plain ```mermaid
// fences and fences carrying an attribute block such as {width=700px height=50%}.
const FENCE_REGEX = /^```mermaid([^\n]*)\n([\s\S]*?)^```[^\n]*$/gm;

export async function renderMermaidInMarkdown(
    markdown: string,
    settings: MarpSlidesSettings
): Promise<LocalMermaidResult> {
    const matches: FenceMatch[] = [];
    let match: RegExpExecArray | null;
    FENCE_REGEX.lastIndex = 0;
    while ((match = FENCE_REGEX.exec(markdown)) !== null) {
        matches.push({ full: match[0], attrs: match[1], code: match[2], index: match.index });
    }

    if (matches.length === 0) {
        return { markdown, renderedCount: 0, failures: [] };
    }

    // Diagrams embed no frontmatter of their own, so the deck-level mermaid
    // theme is resolved from the surrounding markdown (marp-slides block)
    // falling back to the plugin setting.
    const { mermaidTheme } = resolveDeckConfig(markdown, settings);

    const rendered = await Promise.all(matches.map(async (m) => {
        try {
            const svg = await renderMermaidToSvg(m.code.trimEnd(), mermaidTheme, settings.MermaidFontFamily || '');
            const width =
                m.attrs.match(/width\s*=\s*([^\s}]+)/)?.[1] || settings.MermaidWidth || '100%';
            // '%' resolves against the `.mermaid` wrapper's own box (a shrinkable flex
            // item per the shipped themes), so the diagram is capped by whatever room
            // is actually left in the slide. A 'vh' unit resolves against the browser
            // viewport instead — unrelated to the slide's fixed 720px box — so on a
            // large window/monitor the cap computes far bigger than the slide and the
            // diagram overflows its section.
            const height =
                m.attrs.match(/height\s*=\s*([^\s}]+)/)?.[1] || settings.MermaidHeight || '100%';
            const styled = styleMermaidSvg(svg, width, height);
            const block =
                `<div class="mermaid" style="display:flex;justify-content:center;align-items:center">\n` +
                `${styled}\n` +
                `</div>`;
            return { ok: true as const, block };
        } catch (e) {
            return {
                ok: false as const,
                message: e instanceof Error ? e.message : String(e),
                source: m.code.trim(),
            };
        }
    }));

    let out = '';
    let last = 0;
    let renderedCount = 0;
    const failures: LocalMermaidFailure[] = [];

    matches.forEach((m, i) => {
        const r = rendered[i];
        out += markdown.slice(last, m.index);
        if (r.ok) {
            out += r.block;
            renderedCount++;
        } else {
            // Keep the original fence so at least the diagram source stays visible
            // in the deck instead of a blank area.
            out += m.full;
            failures.push({ message: r.message, source: r.source });
        }
        last = m.index + m.full.length;
    });
    out += markdown.slice(last);

    return { markdown: out, renderedCount, failures };
}
