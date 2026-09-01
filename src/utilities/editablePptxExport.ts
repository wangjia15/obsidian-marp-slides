import { App, TFile, Notice, normalizePath, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, removeSync } from 'fs-extra';
import puppeteer, { Browser } from 'puppeteer-core';
import pptxgen from 'pptxgenjs';

import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { tryAcquireExportLock, releaseExportLock } from './exportLock';
import { createMarpInstance } from './marpInstance';
import { parseMermaidDimensions, applyMermaidStyling } from './mermaid';
import { resolveDeckConfig, injectSizeDirective, ensureSizeMeta, injectMermaidInitTheme } from './deckConfig';
import { buildCodeThemeCss } from './codeThemes';
import { transformCallouts, hasCallouts, buildCalloutCss } from './callouts';
import { rgbToHex, isTransparent, pxToIn, pxToPt } from './units';
import { InlineRun, mergeInlineRuns } from './inlineRuns';
import { MarpCLIError } from './marpExport';

interface SlideTextItem {
    type: 'text';
    id: string;
    tag: string;
    text: string;
    x: number; y: number; w: number; h: number;
    fontSize: number;
    // Used line-height in px (resolved, never the literal 'normal'). Feeds the
    // pptxgenjs `lineSpacing` so PowerPoint's default single spacing can no
    // longer inflate or deflate the text relative to the browser render.
    lineHeight: number;
    color: string;
    // Raw computed `background-color` of the element itself (not inherited), e.g.
    // a code panel's dark fill or a `<mark>` highlight. Rendered as the text box's
    // own fill so it survives even though the element is hidden — like every other
    // collected item — while the decoration layer is screenshotted (see
    // captureSlideBackgrounds): that screenshot can never show it, because hiding
    // is exactly what makes room for the editable overlay.
    backgroundColor: string;
    fontWeight: string;
    fontStyle: string;
    textAlign: string;
    fontFamily: string;
    // Inline runs carrying per-stretch formatting (see inlineRuns.ts); rendered
    // as pptxgenjs rich text instead of the flat `text`/`color` above.
    runs?: InlineRun[];
}

interface SlideImageItem {
    type: 'image';
    id: string;
    x: number; y: number; w: number; h: number;
    // When set, the image should be embedded from this source URL/path instead of a
    // DOM screenshot — used for marp background figures so they keep full resolution.
    url?: string;
}

// A <video>/<audio> element: embedded into the pptx as real PowerPoint media
// (playable) instead of a rasterized frame. `url` is the browser-resolved
// absolute source (file:/// for the deck's vault-relative assets/... paths).
interface SlideMediaItem {
    type: 'media';
    id: string;
    mediaType: 'video' | 'audio';
    url: string;
    x: number; y: number; w: number; h: number;
}

type SlideItem = SlideTextItem | SlideImageItem | SlideMediaItem;

interface SlideLayout {
    width: number;
    height: number;
    background: string;
    // Computed background-image of the slide section, when present (CSS gradients
    // on dark title/divider slides). pptxgenjs only fills solid colours, so this
    // feeds the gradientFallbackColor approximation.
    backgroundImage?: string;
    // Default text colour resolved for the slide (from `_color` / theme); used so text on
    // dark backgrounds isn't dropped when an individual leaf's computed colour is transparent.
    color?: string;
    items: SlideItem[];
}

// Marp decks commonly paint title/divider slides with a dark CSS gradient while
// their text is white. The editable export only fills solid background colours,
// which turns those slides into white pages with invisible white text. Approximate
// the gradient with its first colour stop so light text stays readable.
export function gradientFallbackColor(background: string | undefined, backgroundImage: string | undefined): string | undefined {
    if (background && !isTransparent(background)) return undefined;
    if (!backgroundImage || !backgroundImage.includes('gradient')) return undefined;

    const m = backgroundImage.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/);
    if (!m) return undefined;

    return m[0].startsWith('#')
        ? (m[0].length === 4
            ? '#' + m[0].slice(1).split('').map((ch) => ch + ch).join('')
            : m[0]).slice(1).toUpperCase()
        : rgbToHex(m[0]);
}

// Computed `font-family` is the full author-specified fallback stack (e.g.
// `"LXGW WenKai", "KaiTi", "楷体", serif`), never resolved to whichever font the
// browser actually picked. pptxgenjs's `fontFace` takes exactly one name, so use
// the first entry — quotes stripped — as the best available signal of intent.
// Falls back to undefined (pptx default font) for empty/generic-only stacks.
export function firstFontFamily(fontFamily: string | undefined): string | undefined {
    if (!fontFamily) return undefined;

    const first = fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
    return first ? first : undefined;
}

// Same threshold pptxgenjs itself has no opinion on: computed font-weight is
// either a keyword ('bold'/'normal') or a numeric string ('400', '700', ...),
// and CSS treats >= 600 (semibold and up) as visually bold.
function isBoldWeight(fontWeight: string): boolean {
    return fontWeight === 'bold' || parseInt(fontWeight, 10) >= 600;
}

// Only http(s) links become pptx hyperlinks; a vault-relative href would end
// up as a broken relationship target inside the exported file.
function isHttpUrl(href: string | undefined): href is string {
    return !!href && /^https?:\/\//i.test(href);
}

function resolveChromePath(settings: MarpSlidesSettings): string {
    if (settings.CHROME_PATH) return settings.CHROME_PATH;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    // Obsidian plugins run inside an Electron renderer whose global `process`
    // may be Electron's stub rather than Node's, so `process.platform` cannot be
    // trusted to select the right candidate list. Probe every well-known install
    // location across platforms and return the first that exists on disk. Order is
    // deliberate: the most common Windows paths first (this plugin's primary user
    // base), then macOS, then Linux.
    const candidates: string[] = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/microsoft-edge',
    ];

    const found = candidates.find(existsSync);
    if (found) return found;

    throw new MarpCLIError(
        'Could not find an installed Chrome/Edge/Chromium browser. Set the Chrome executable path in Marp Slides settings.'
    );
}

// DOM-side shape collected inside page.evaluate(); mirrored by the SlideItem types so the
// serialized return value is typed without any `any`.
interface CollectedTextItem {
    type: 'text';
    id: string;
    tag: string;
    text: string;
    x: number; y: number; w: number; h: number;
    fontSize: number;
    lineHeight: number;
    color: string;
    backgroundColor: string;
    fontWeight: string;
    fontStyle: string;
    textAlign: string;
    fontFamily: string;
    runs?: InlineRun[];
}
interface CollectedImageItem {
    type: 'image';
    id: string;
    x: number; y: number; w: number; h: number;
    url?: string;
}
interface CollectedMediaItem {
    type: 'media';
    id: string;
    mediaType: 'video' | 'audio';
    url: string;
    x: number; y: number; w: number; h: number;
}
type CollectedItem = CollectedTextItem | CollectedImageItem | CollectedMediaItem;
interface CollectedSlide {
    width: number;
    height: number;
    background: string;
    backgroundImage?: string;
    color?: string;
    items: CollectedItem[];
}

// Walks each rendered slide's DOM inside the page and extracts a layout tree of
// leaf text nodes (with computed font/color/position) and leaf image nodes
// (img / kroki embed / marp background figure), so they can be rebuilt as real
// editable pptxgenjs shapes instead of a single flattened screenshot per slide.
//
// marp renders a background-image slide as one <svg> holding THREE <foreignObject>/<section>
// siblings: data-marpit-advanced-background="background" (a <figure> with the bg image),
// ="content" (the actual slide text), and ="pseudo". A plain slide has a single section.
// The previous walker ran `svg.querySelector('section')` which grabbed only the "background"
// section of a bg slide — empty of text, missing the <figure> — so background slides exported
// with no text and no background. We now select the content/background sections explicitly.
export async function extractSlideLayouts(browserPage: import('puppeteer-core').Page): Promise<SlideLayout[]> {
    return browserPage.evaluate(() => {
        const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'PRE']);
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE']);
        // Match a CSS url("...") value, tolerating quote/whitespace variants.
        const URL_RE = /^url\(\s*["']?(.*?)["']?\s*\)$/i;

        // One run per text node, reading getComputedStyle() on the node's
        // *immediate* parent: the browser has already resolved the CSS cascade
        // (including nested spans — highlight.js tokens, <strong>, <a>, inline
        // <code>), so each run carries its final color/weight/style/size without
        // reimplementing any CSS logic here. This generalizes the old code-only
        // collector to every text item, which is what keeps mixed inline
        // formatting (a bold word, a link) from flattening into the paragraph's
        // single box-level style. <br> becomes a '\n' run that pptxgenjs turns
        // into a line break.
        const collectInlineRuns = (node: Element): InlineRun[] => {
            const runs: InlineRun[] = [];
            const collect = (current: Element): void => {
                for (const child of Array.from(current.childNodes)) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = child.textContent ?? '';
                        if (text.length === 0) continue;
                        const parent = child.parentElement;
                        const cs = parent ? getComputedStyle(parent) : null;
                        const bg = cs ? cs.backgroundColor : '';
                        runs.push({
                            text,
                            color: cs ? cs.color : 'rgb(0, 0, 0)',
                            // A fully transparent background resolves to
                            // zero-alpha rgba() in Chrome; anything else (an
                            // inline <code> fill, <mark>) is kept as a highlight.
                            backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : undefined,
                            fontWeight: cs ? cs.fontWeight : 'normal',
                            fontStyle: cs ? cs.fontStyle : 'normal',
                            fontSize: cs ? parseFloat(cs.fontSize) || 16 : 16,
                            underline: !!cs && (cs.textDecorationLine || '').includes('underline'),
                            href: parent?.closest('a')?.getAttribute('href') || undefined,
                        });
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const el = child as Element;
                        if (el.tagName.toUpperCase() === 'BR') {
                            runs.push({ text: '\n', color: 'rgb(0, 0, 0)', fontWeight: 'normal', fontStyle: 'normal', fontSize: 16 });
                        } else {
                            collect(el);
                        }
                    }
                }
            };
            collect(node);
            return runs;
        };

        // Chrome resolves numeric/length line-heights to their used px value in
        // getComputedStyle, but `line-height: normal` stays the literal string
        // because its used value depends on font metrics. Measure a hidden
        // one-line probe with the same font: a block's single-line height *is*
        // the used line-height. `line-height: normal` must be set explicitly on
        // the probe — it is an inherited property, so the slide's own setting
        // would otherwise leak in and defeat the measurement. Cached per font
        // signature; a deck typically uses only a handful.
        const lineHeightCache = new Map<string, number>();
        const resolveLineHeight = (cs: CSSStyleDeclaration): number => {
            const px = parseFloat(cs.lineHeight);
            if (!Number.isNaN(px) && px > 0) return px;

            const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.fontStyle}`;
            const cached = lineHeightCache.get(key);
            if (cached !== undefined) return cached;

            const probe = document.createElement('span');
            probe.textContent = 'Xg';
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            probe.style.whiteSpace = 'pre';
            probe.style.lineHeight = 'normal';
            probe.style.fontFamily = cs.fontFamily;
            probe.style.fontSize = cs.fontSize;
            probe.style.fontWeight = cs.fontWeight;
            probe.style.fontStyle = cs.fontStyle;
            document.body.appendChild(probe);
            const measured = probe.getBoundingClientRect().height;
            probe.remove();

            const value = measured > 0 ? measured : parseFloat(cs.fontSize) * 1.2;
            lineHeightCache.set(key, value);
            return value;
        };

        const slides: CollectedSlide[] = [];
        const svgs = Array.from(document.querySelectorAll('svg[data-marpit-svg]')) as unknown as SVGSVGElement[];
        let uid = 0;

        for (const svg of svgs) {
            const vb = svg.viewBox.baseVal;
            const w = vb && vb.width ? vb.width : 1280;
            const h = vb && vb.height ? vb.height : 720;

            const wrapper = (svg.closest('[data-marp-vscode-slide-wrapper]') ?? svg.parentElement) as HTMLElement | null;
            if (wrapper) {
                wrapper.style.width = `${w}px`;
                wrapper.style.height = `${h}px`;
                wrapper.style.overflow = 'hidden';
            }
            svg.style.width = `${w}px`;
            svg.style.height = `${h}px`;
            svg.style.display = 'block';

            // Force a reflow so getBoundingClientRect() reflects the forced size above.
            void (svg as unknown as HTMLElement).offsetHeight;

            const sections = Array.from(svg.querySelectorAll('section'));
            // The content section holds the slide's text; on a plain slide it is the only one.
            const contentSection =
                sections.find((s) => s.getAttribute('data-marpit-advanced-background') === 'content') ??
                sections.find((s) => !s.getAttribute('data-marpit-advanced-background')) ??
                sections[0];
            if (!contentSection) continue;

            const secRect = contentSection.getBoundingClientRect();
            const contentStyle = getComputedStyle(contentSection);
            const background = contentStyle.backgroundColor;
            const backgroundImage =
                contentStyle.backgroundImage && contentStyle.backgroundImage !== 'none'
                    ? contentStyle.backgroundImage
                    : undefined;
            const color = contentStyle.color;
            const items: CollectedItem[] = [];

            // marp background image lives in a separate section as <figure style="background-image:url(...)">.
            const bgSection = sections.find((s) => s.getAttribute('data-marpit-advanced-background') === 'background');
            if (bgSection) {
                const figure = bgSection.querySelector('figure');
                if (figure) {
                    const bgUrl = URL_RE.exec(getComputedStyle(figure).backgroundImage);
                    if (bgUrl && bgUrl[1] && bgUrl[1] !== 'none') {
                        const id = `export-el-${uid++}`;
                        figure.setAttribute('data-export-id', id);
                        const r = figure.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            items.push({
                                type: 'image',
                                id,
                                url: bgUrl[1],
                                x: r.left - secRect.left,
                                y: r.top - secRect.top,
                                w: r.width,
                                h: r.height,
                            });
                        }
                    }
                }
            }

            const walk = (node: Element): void => {
                for (const child of Array.from(node.children)) {
                    // SVG elements report a *lowercase* tagName ('svg', 'text'),
                    // HTML elements an uppercase one ('IMG', 'DIV'). Normalizing to
                    // uppercase makes the SVG branch below actually match inline
                    // diagrams (locally rendered mermaid), which otherwise get
                    // walked into and shattered into loose text items.
                    const tag = child.tagName.toUpperCase();
                    if (SKIP_TAGS.has(tag)) continue;

                    if (tag === 'IMG' || tag === 'EMBED' || tag === 'SVG' || tag === 'VIDEO' || tag === 'AUDIO') {
                        const r = child.getBoundingClientRect();
                        // <audio controls> renders a ~40px control bar, but a
                        // control-less <audio> has no box at all — clamp instead of
                        // dropping, so the clip still exports as playable media.
                        const boxHeight = tag === 'AUDIO' && r.height === 0 ? 40 : r.height;
                        if (r.width > 0 && boxHeight > 0) {
                            const id = `export-el-${uid++}`;
                            child.setAttribute('data-export-id', id);
                            // <video>/<audio> with a resolvable source become real
                            // PowerPoint media rather than screenshots. The temp
                            // document's <base href> resolves the deck's relative
                            // `assets/...` paths to absolute file:/// URLs.
                            const mediaSrc = tag === 'VIDEO' || tag === 'AUDIO'
                                ? (child.getAttribute('src') ?? child.querySelector('source')?.getAttribute('src'))
                                : null;
                            let absUrl: string | null = null;
                            if (mediaSrc) {
                                try { absUrl = new URL(mediaSrc, document.baseURI).href; } catch { absUrl = null; }
                            }
                            if (absUrl) {
                                items.push({
                                    type: 'media',
                                    id,
                                    mediaType: tag === 'VIDEO' ? 'video' : 'audio',
                                    url: absUrl,
                                    x: r.left - secRect.left,
                                    y: r.top - secRect.top,
                                    w: r.width,
                                    h: boxHeight,
                                });
                            } else {
                                items.push({
                                    type: 'image',
                                    id,
                                    x: r.left - secRect.left,
                                    y: r.top - secRect.top,
                                    w: r.width,
                                    h: r.height,
                                });
                            }
                        }
                        continue;
                    }

                    // Capture text from block text elements (their full text incl. inline
                    // children) AND from leaf elements of any other tag that hold only text
                    // — e.g. custom HTML cards whose nested <div>s carry KPI numbers/labels.
                    // Container elements (those with element children) are recursed into.
                    // Kroki wraps diagrams in <p><embed/></p>; the media guard keeps those
                    // recursing so the embed is captured as an image node.
                    const isLeafText = child.children.length === 0;
                    // The media guard must include video/audio: markdown-it wraps
                    // inline raw HTML in <p>, and a <p><video/></p> whose textContent
                    // is empty would otherwise be skipped here without ever
                    // recursing into the video.
                    if ((TEXT_TAGS.has(tag) || isLeafText) && !child.querySelector('img, embed, svg, video, audio')) {
                        const text = child.textContent ?? '';
                        if (text.trim().length > 0) {
                            const r = child.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                const cs = getComputedStyle(child);
                                const textId = `export-el-${uid++}`;
                                // Text items are tagged too: the decoration-layer pass
                                // below hides every collected item before screenshotting
                                // the slide, so their text lives only in the editable
                                // overlay, never twice.
                                child.setAttribute('data-export-id', textId);
                                // Every text item carries inline runs (per-stretch
                                // formatting); code blocks walk into their <code>
                                // wrapper, where highlight.js wraps each token in
                                // its own <span class="hljs-*">.
                                const runs = collectInlineRuns(
                                    tag === 'PRE' ? (child.querySelector('code') ?? child) : child
                                );
                                items.push({
                                    type: 'text',
                                    id: textId,
                                    tag,
                                    text,
                                    x: r.left - secRect.left,
                                    y: r.top - secRect.top,
                                    w: r.width,
                                    h: r.height,
                                    fontSize: parseFloat(cs.fontSize),
                                    lineHeight: resolveLineHeight(cs),
                                    color: cs.color,
                                    backgroundColor: cs.backgroundColor,
                                    fontWeight: cs.fontWeight,
                                    fontStyle: cs.fontStyle,
                                    textAlign: cs.textAlign,
                                    fontFamily: cs.fontFamily,
                                    runs: runs.length > 0 ? runs : undefined,
                                });
                            }
                        }
                        continue;
                    }

                    walk(child);
                }
            };

            walk(contentSection);
            slides.push({ width: w, height: h, background, backgroundImage, color, items });
        }

        return slides;
    }) as Promise<SlideLayout[]>;
}

// Captures one full-slide "decoration layer" screenshot per slide with every
// collected text/image item temporarily hidden (visibility:hidden keeps layout).
// The result preserves all CSS painting the walker cannot express as pptx shapes —
// card/tile backgrounds, rounded corners, borders, accent bars, ::before step
// badges, gradients — while the editable text and diagram images are overlaid
// afterwards at their original rects.
export async function captureSlideBackgrounds(
    page: import('puppeteer-core').Page,
    layouts: SlideLayout[]
): Promise<(string | undefined)[]> {
    const svgHandles = await page.$$('svg[data-marpit-svg]');
    const shots: (string | undefined)[] = [];

    for (let i = 0; i < layouts.length && i < svgHandles.length; i++) {
        const ids = layouts[i].items
            .map((item) => item.id)
            .filter((id): id is string => typeof id === 'string');

        const setVisibility = (slideIds: string[], visibility: string) => {
            for (const id of slideIds) {
                const el = document.querySelector(`[data-export-id="${id}"]`) as HTMLElement | null;
                if (el) el.style.visibility = visibility;
            }
        };

        try {
            await page.evaluate(setVisibility, ids, 'hidden');
            const shot = await svgHandles[i].screenshot({ type: 'png' });
            shots.push(`image/png;base64,${Buffer.from(shot).toString('base64')}`);
        } catch (e) {
            console.warn(`Marp Slides: failed to capture decoration layer for slide ${i + 1}.`, e);
            shots.push(undefined);
        } finally {
            await page.evaluate(setVisibility, ids, '').catch(() => { /* best effort restore */ });
        }
    }

    return shots;
}

export class EditablePptxExport {
    private settings: MarpSlidesSettings;
    private app: App | null;
    private static readonly MAX_ATTEMPTS = 2;

    constructor(settings: MarpSlidesSettings, app: App | null = null) {
        this.settings = settings;
        this.app = app;
    }

    async export(file: TFile): Promise<void> {
        if (!this.app) return;

        if (!tryAcquireExportLock()) {
            new Notice('Marp Slides: another export is already running, please wait for it to finish.');
            return;
        }

        new Notice(`Marp Slides: exporting "${file.basename}" (editable PPTX)...`);

        try {
            let lastError: unknown;

            for (let attempt = 1; attempt <= EditablePptxExport.MAX_ATTEMPTS; attempt++) {
                try {
                    await this.doExport(file);
                    new Notice(`Marp Slides: exported editable PPTX for "${file.basename}".`);
                    return;
                } catch (e) {
                    lastError = e;
                    console.warn(`Editable PPTX export attempt ${attempt}/${EditablePptxExport.MAX_ATTEMPTS} failed.`, e);
                }
            }

            console.error(lastError);
            const message = lastError instanceof Error ? lastError.message : String(lastError);
            new Notice(`Marp Slides: editable PPTX export failed after ${EditablePptxExport.MAX_ATTEMPTS} attempts: ${message}`);
        } finally {
            releaseExportLock();
        }
    }

    private async doExport(file: TFile): Promise<void> {
        const app = this.app as App;
        const filesTool = new FilePath(this.settings);

        const completeFilePath = filesTool.getCompleteFilePath(file);
        if (completeFilePath === '') return;

        const markdownText = await app.vault.cachedRead(file);
        let processedMarkdown = filesTool.convertImages(markdownText, file, app);
        processedMarkdown = transformCallouts(processedMarkdown);

        // Deck-level tuning (ratio / code theme / mermaid theme) resolved from the
        // note's frontmatter with the plugin settings as defaults, mirroring the
        // preview and CLI export paths.
        const deckConfig = resolveDeckConfig(processedMarkdown, this.settings);
        const tunedMarkdown = injectSizeDirective(
            this.settings.MermaidRenderMode === 'kroki'
                ? injectMermaidInitTheme(processedMarkdown, deckConfig.mermaidTheme)
                : processedMarkdown,
            deckConfig
        );

        // Local mermaid mode: replace fences with pre-rendered inline SVG before
        // the Marp conversion (mirrors the preview and CLI export paths).
        let effectiveMarkdown = tunedMarkdown;
        if (this.settings.MermaidRenderMode === 'local') {
            const { renderMermaidInMarkdown } = await import('./localMermaid');
            const local = await renderMermaidInMarkdown(tunedMarkdown, this.settings);
            effectiveMarkdown = local.markdown;
            local.failures.forEach((f) =>
                console.warn(`Marp Slides: local mermaid render failed: ${f.message}\n${f.source}`)
            );
        }

        const { processedMarkdown: mdSized, dimensionMap } = parseMermaidDimensions(effectiveMarkdown);

        const marp = createMarpInstance(this.settings);

        if (this.settings.ThemePath !== '') {
            const themeFiles = app.vault.getFiles().filter(
                (f) => f.parent?.path === normalizePath(this.settings.ThemePath) && f.extension === 'css'
            );
            for (const file of themeFiles) {
                try {
                    // `read`, not `cachedRead`: this can run moments after the user
                    // last touched the theme CSS, and the vault's read cache for
                    // that file is not guaranteed to have caught up yet.
                    const content = await app.vault.read(file);
                    // Prepend missing @size metadata so custom themes honour the
                    // `size` directive (ratio setting / frontmatter) as well.
                    marp.themeSet.add(ensureSizeMeta(content));
                } catch (e) {
                    console.warn(`Marp Slides: failed to load theme file ${file.path}; skipping.`, e);
                }
            }
        }

        let { html, css, comments } = marp.render(mdSized);
        ({ html, css } = applyMermaidStyling(html, css, dimensionMap, this.settings.MermaidWidth, this.settings.MermaidHeight, this.settings.KrokiServerUrl));
        css += buildCodeThemeCss(deckConfig.codeTheme);
        if (hasCallouts(processedMarkdown)) {
            css += buildCalloutCss();
        }

        const basePath = ((file.vault.adapter as FileSystemAdapter).getBasePath
            ? `file:///${(file.vault.adapter as FileSystemAdapter).getBasePath().replace(/\\/g, '/')}/${file.parent?.path ?? ''}/`
            : './');

        html = html.replace(/(?!background-image:url\(&quot;http)background-image:url\(&quot;/g, `background-image:url(&quot;${basePath}`);

        const htmlDocument = `<!DOCTYPE html>
<html>
<head>
<base href="${basePath}">
<style>${css}</style>
</head>
<body>${html}</body>
</html>`;

        const tempHtmlPath = path.join(path.dirname(completeFilePath), `.marp-editable-export-${file.basename}-${process.pid}.html`);
        writeFileSync(tempHtmlPath, htmlDocument, 'utf-8');

        let browser: Browser | undefined;

        try {
            browser = await puppeteer.launch({
                executablePath: resolveChromePath(this.settings),
                headless: true,
                args: ['--allow-file-access-from-files', '--no-sandbox'],
            });

            const page = await browser.newPage();
            page.setDefaultTimeout(60000);

            await page.goto(`file:///${tempHtmlPath.replace(/\\/g, '/')}`, {
                waitUntil: ['domcontentloaded', 'networkidle0'],
            });

            // Kroki-rendered <embed> diagrams can report a 0x0 box for a moment after
            // networkidle0 fires, while their nested SVG document finishes laying out.
            await page.waitForFunction(
                () => Array.from(document.querySelectorAll('embed')).every((e) => e.getBoundingClientRect().width > 0),
                { timeout: 30000, polling: 100 }
            ).catch(() => { /* proceed with whatever loaded; better a missing diagram than a failed export */ });

            const layouts = await extractSlideLayouts(page);
            if (layouts.length === 0) {
                throw new Error('No slides were found while rendering the deck for editable export.');
            }

            // Full-slide decoration layer: keeps every CSS-painted visual (cards,
            // borders, gradients, step badges) under the editable text overlay.
            const decorationLayers = await captureSlideBackgrounds(page, layouts);

            const pptx = new pptxgen();
            const layoutName = `${layouts[0].width}x${layouts[0].height}`;
            pptx.defineLayout({ name: layoutName, width: pxToIn(layouts[0].width), height: pxToIn(layouts[0].height) });
            pptx.layout = layoutName;

            // Fallback for media items whose source cannot be embedded (unreadable
            // file, remote URL): rasterize the element like any other image node.
            const screenshotAsImage = async (
                slide: ReturnType<pptxgen['addSlide']>,
                imgItem: { id: string; x: number; y: number; w: number; h: number }
            ): Promise<void> => {
                const el = await page.$(`[data-export-id="${imgItem.id}"]`);
                if (!el) return;
                const shot = await el.screenshot({ type: 'png' });
                slide.addImage({
                    data: `image/png;base64,${Buffer.from(shot).toString('base64')}`,
                    x: pxToIn(imgItem.x),
                    y: pxToIn(imgItem.y),
                    w: pxToIn(imgItem.w),
                    h: pxToIn(imgItem.h),
                });
            };

            for (let slideIndex = 0; slideIndex < layouts.length; slideIndex++) {
                const layout = layouts[slideIndex];
                const slide = pptx.addSlide();

                // Marp speaker notes: HTML comments in the markdown (`<!-- ... -->`),
                // one array per slide, become PowerPoint presenter notes.
                const slideNotes = (comments[slideIndex] ?? []).join('\n\n').trim();
                if (slideNotes.length > 0) {
                    slide.addNotes(slideNotes);
                }

                if (!isTransparent(layout.background)) {
                    slide.background = { color: rgbToHex(layout.background) };
                } else {
                    // Gradient-painted slides (dark title/divider pages) keep their
                    // readability through the first colour stop of the gradient.
                    const gradient = gradientFallbackColor(layout.background, layout.backgroundImage);
                    if (gradient) {
                        slide.background = { color: gradient };
                    }
                }

                // Decoration layer goes in before any text/image item so the
                // editable overlay renders on top of it.
                if (decorationLayers[slideIndex]) {
                    slide.addImage({
                        data: decorationLayers[slideIndex],
                        x: 0,
                        y: 0,
                        w: pxToIn(layout.width),
                        h: pxToIn(layout.height),
                    });
                }

                for (const item of layout.items) {
                    if (item.type === 'text') {
                        // The element's own background (a code panel's dark fill, a
                        // <mark> highlight, ...) is otherwise lost: it paints on the very
                        // box that gets hidden for the decoration-layer screenshot (see
                        // captureSlideBackgrounds), so it can only be recovered here, as
                        // the text box's own fill.
                        const backgroundHex = !isTransparent(item.backgroundColor)
                            ? rgbToHex(item.backgroundColor)
                            : undefined;
                        const fontFace = item.tag === 'PRE' ? 'Consolas' : firstFontFamily(item.fontFamily);

                        // Text-frame options. `fit: 'shrink'` (replacing the deprecated
                        // `autoFit: false`, which wrote no autofit element at all) is the
                        // overflow safety net: if the viewer substitutes a font whose
                        // metrics run taller than the browser's, PowerPoint shrinks the
                        // text instead of spilling it over the box.
                        const boxOptions = {
                            x: pxToIn(item.x),
                            y: pxToIn(item.y),
                            w: pxToIn(item.w),
                            h: pxToIn(item.h),
                            fill: backgroundHex ? { color: backgroundHex } : undefined,
                            valign: 'top' as const,
                            margin: 0,
                            fit: 'shrink' as const,
                        };

                        // Paragraph-level options. pptxgenjs only inherits box-level
                        // options into a rich-text run when that run carries no options
                        // object of its own — and every run below does (for its color) —
                        // so these MUST be repeated on each run or they would silently
                        // drop for run-based text (all of it, now). `lineSpacing` carries
                        // the browser's used line-height (px→pt at the fixed 96 dpi slide
                        // scale) so PowerPoint's default single spacing can no longer
                        // inflate the text relative to the preview — the main source of
                        // overflowing/overlapping text boxes.
                        const paragraphOptions = {
                            align: (item.textAlign === 'start' ? 'left' : item.textAlign === 'end' ? 'right' : item.textAlign) as 'left' | 'right' | 'center' | 'justify',
                            bullet: item.tag === 'LI' ? true : undefined,
                            lineSpacing: item.lineHeight > 0 ? pxToPt(item.lineHeight) : undefined,
                        };

                        const runs = item.runs ? mergeInlineRuns(item.runs) : [];
                        if (runs.length > 0) {
                            slide.addText(
                                runs.map((run) => ({
                                    text: run.text,
                                    options: {
                                        ...paragraphOptions,
                                        color: rgbToHex(run.color),
                                        bold: isBoldWeight(run.fontWeight),
                                        italic: run.fontStyle === 'italic',
                                        // Exact fractional points (pptxgenjs stores
                                        // 1/100 pt internally) — the integer rounding
                                        // used to bias every size by up to half a point.
                                        fontSize: Math.max(1, pxToPt(run.fontSize)),
                                        fontFace,
                                        highlight: run.backgroundColor ? rgbToHex(run.backgroundColor) : undefined,
                                        underline: run.underline ? { style: 'sng' as const } : undefined,
                                        // Only web links become pptx hyperlinks; vault-relative
                                        // hrefs would produce broken rels in PowerPoint.
                                        hyperlink: isHttpUrl(run.href) ? { url: run.href } : undefined,
                                    },
                                })),
                                boxOptions
                            );
                        } else {
                            slide.addText(item.text, {
                                ...boxOptions,
                                ...paragraphOptions,
                                fontSize: Math.max(1, pxToPt(item.fontSize)),
                                fontFace,
                                color: rgbToHex(item.color),
                                bold: isBoldWeight(item.fontWeight),
                                italic: item.fontStyle === 'italic',
                            });
                        }
                    } else if (item.type === 'media') {
                        // <video>/<audio> embed as real PowerPoint media so they play
                        // inside the deck instead of being baked into the decoration
                        // layer as a static frame. Only local files can be embedded
                        // (read → base64); anything else falls back to a screenshot.
                        let embedded = false;
                        if (item.url.startsWith('file://')) {
                            try {
                                const src = fileURLToPath(item.url);
                                const ext = path.extname(src).toLowerCase().replace('.', '');
                                const mime = item.mediaType === 'video'
                                    ? (ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4')
                                    : (ext === 'mp3' ? 'audio/mp3' : ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : 'audio/wav');
                                // The video's first frame as it rendered in the browser,
                                // replacing pptxgenjs's default gray play button. Best
                                // effort — any failure just keeps the default cover.
                                let cover: string | undefined;
                                if (item.mediaType === 'video') {
                                    try {
                                        const el = await page.$(`[data-export-id="${item.id}"]`);
                                        if (el) {
                                            cover = `image/png;base64,${Buffer.from(await el.screenshot({ type: 'png' })).toString('base64')}`;
                                        }
                                    } catch (e) {
                                        console.warn('Marp Slides: failed to capture media cover frame; using the default play button.', e);
                                    }
                                }
                                slide.addMedia({
                                    type: item.mediaType,
                                    x: pxToIn(item.x),
                                    y: pxToIn(item.y),
                                    w: pxToIn(item.w),
                                    h: pxToIn(item.h),
                                    data: `${mime};base64,${readFileSync(src).toString('base64')}`,
                                    // pptxgenjs derives the zip filename extension from the
                                    // mime suffix ("quicktime", "mpeg") when extn is absent —
                                    // the real file extension is what PowerPoint expects.
                                    extn: ext || undefined,
                                    ...(cover ? { cover } : {}),
                                });
                                embedded = true;
                            } catch (e) {
                                console.warn(`Marp Slides: failed to embed media source ${item.url}; falling back to a screenshot image.`, e);
                            }
                        } else {
                            console.warn(`Marp Slides: media source ${item.url} is not a local file; falling back to a screenshot image.`);
                        }
                        if (!embedded) {
                            await screenshotAsImage(slide, item);
                        }
                    } else {
                        // Background figures carry a source URL — embed the original image
                        // (full resolution) rather than a rasterized screenshot. Other image
                        // nodes (kroki embeds, inline <svg>) have no recoverable source, so
                        // screenshot the rendered DOM element.
                        let imageData: string | undefined;
                        if (item.url) {
                            try {
                                const src = item.url.startsWith('file://') ? fileURLToPath(item.url) : item.url;
                                const buf = readFileSync(src);
                                const ext = path.extname(item.url).toLowerCase();
                                const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                                imageData = `${mime};base64,${buf.toString('base64')}`;
                            } catch (e) {
                                console.warn(`Failed to read background image source ${item.url}; falling back to screenshot.`, e);
                            }
                        }
                        if (!imageData) {
                            const el = await page.$(`[data-export-id="${item.id}"]`);
                            if (!el) continue;
                            const shot = await el.screenshot({ type: 'png' });
                            imageData = `image/png;base64,${Buffer.from(shot).toString('base64')}`;
                        }
                        slide.addImage({
                            data: imageData,
                            x: pxToIn(item.x),
                            y: pxToIn(item.y),
                            w: pxToIn(item.w),
                            h: pxToIn(item.h),
                        });
                    }
                }
            }

            const outputPath = this.settings.EXPORT_PATH !== ''
                ? path.join(this.settings.EXPORT_PATH, `${file.basename}-editable.pptx`)
                : path.join(path.dirname(completeFilePath), `${file.basename}-editable.pptx`);

            const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
            writeFileSync(outputPath, new Uint8Array(buffer));
        } finally {
            // Cleanup failures (e.g. Windows file locks on the Chrome temp profile) must
            // never mask the real error from the try block above.
            if (browser) {
                // browser.close() has no built-in timeout and can hang indefinitely
                // waiting for a Chrome process that never exits cleanly (an observed
                // flake, especially on Windows). If this await never settled, doExport()
                // would never return and the process-wide export lock (shared with the
                // marp-cli PDF/PPTX/PNG/HTML path) would stay held forever, silently
                // blocking every export until Obsidian restarts. Give up waiting after a
                // few seconds instead — a leaked Chrome process is a far smaller problem
                // than a stuck plugin.
                await Promise.race([
                    browser.close().catch((e) => console.warn('Failed to close Puppeteer browser.', e)),
                    new Promise<void>((resolve) => setTimeout(() => {
                        console.warn('Marp Slides: puppeteer browser.close() did not finish within 10s; continuing without waiting for it (its Chrome process may keep running in the background).');
                        resolve();
                    }, 10000)),
                ]);
            }
            try { removeSync(tempHtmlPath); } catch (e) { console.warn('Failed to remove temp export HTML.', e); }
        }
    }
}
