import { App, TFile, Notice, normalizePath, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import { existsSync, writeFileSync, removeSync } from 'fs-extra';
import puppeteer, { Browser } from 'puppeteer-core';
import pptxgen from 'pptxgenjs';

import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { createMarpInstance } from './marpInstance';
import { parseMermaidDimensions, applyMermaidStyling } from '../views/marpPreviewView';
import { MarpCLIError } from './marpExport';

const PX_PER_INCH = 96;

interface SlideTextItem {
    type: 'text';
    tag: string;
    text: string;
    x: number; y: number; w: number; h: number;
    fontSize: number;
    color: string;
    fontWeight: string;
    fontStyle: string;
    textAlign: string;
    fontFamily: string;
}

interface SlideImageItem {
    type: 'image';
    id: string;
    x: number; y: number; w: number; h: number;
}

type SlideItem = SlideTextItem | SlideImageItem;

interface SlideLayout {
    width: number;
    height: number;
    background: string;
    items: SlideItem[];
}

function resolveChromePath(settings: MarpSlidesSettings): string {
    if (settings.CHROME_PATH) return settings.CHROME_PATH;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    const candidates: string[] = (() => {
        switch (process.platform) {
            case 'win32':
                return [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                ];
            case 'darwin':
                return [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/Applications/Chromium.app/Contents/MacOS/Chromium',
                    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                ];
            default:
                return [
                    '/usr/bin/google-chrome-stable',
                    '/usr/bin/google-chrome',
                    '/usr/bin/chromium-browser',
                    '/usr/bin/chromium',
                    '/usr/bin/microsoft-edge',
                ];
        }
    })();

    const found = candidates.find(existsSync);
    if (found) return found;

    throw new MarpCLIError(
        'Could not find an installed Chrome/Edge/Chromium browser. Set the Chrome executable path in Marp Slides settings.'
    );
}

function rgbToHex(rgb: string): string {
    const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return '000000';
    return [m[1], m[2], m[3]]
        .map((v) => Number(v).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

function isTransparent(rgb: string): boolean {
    const m = rgb.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\)/);
    return rgb === 'transparent' || (!!m && parseFloat(m[1]) === 0);
}

function pxToIn(px: number): number {
    return px / PX_PER_INCH;
}

function pxToPt(px: number): number {
    return px * 0.75;
}

// Walks each rendered slide's DOM inside the page and extracts a layout tree of
// leaf text nodes (with computed font/color/position) and leaf image nodes
// (img / kroki embed), so they can be rebuilt as real editable pptxgenjs shapes
// instead of a single flattened screenshot per slide.
async function extractSlideLayouts(browserPage: import('puppeteer-core').Page): Promise<SlideLayout[]> {
    return browserPage.evaluate(() => {
        const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'PRE']);
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE']);

        const slides: any[] = [];
        const svgs = Array.from(document.querySelectorAll('svg[data-marpit-svg]')) as unknown as SVGSVGElement[];
        let uid = 0;

        for (const svg of svgs) {
            const vb = svg.viewBox.baseVal;
            const w = vb && vb.width ? vb.width : 1280;
            const h = vb && vb.height ? vb.height : 720;

            const wrapper = (svg.closest('[data-marp-vscode-slide-wrapper]') as HTMLElement) || (svg.parentElement as HTMLElement);
            if (wrapper) {
                wrapper.style.width = `${w}px`;
                wrapper.style.height = `${h}px`;
                wrapper.style.overflow = 'hidden';
            }
            (svg as unknown as HTMLElement).style.width = `${w}px`;
            (svg as unknown as HTMLElement).style.height = `${h}px`;
            (svg as unknown as HTMLElement).style.display = 'block';

            const section = svg.querySelector('section');
            if (!section) continue;

            // Force a reflow so getBoundingClientRect() reflects the forced size above.
            void (section as HTMLElement).offsetHeight;

            const secRect = section.getBoundingClientRect();
            const background = getComputedStyle(section).backgroundColor;
            const items: any[] = [];

            const walk = (node: Element) => {
                for (const child of Array.from(node.children)) {
                    const tag = child.tagName;
                    if (SKIP_TAGS.has(tag)) continue;

                    if (tag === 'IMG' || tag === 'EMBED') {
                        const r = child.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            const id = `export-el-${uid++}`;
                            child.setAttribute('data-export-id', id);
                            items.push({
                                type: 'image',
                                id,
                                x: r.left - secRect.left,
                                y: r.top - secRect.top,
                                w: r.width,
                                h: r.height,
                            });
                        }
                        continue;
                    }

                    // Kroki wraps rendered diagrams in <p class="kroki-image-container"><embed .../></p>;
                    // since P is also a normal text tag, only treat it as a text leaf when it has no
                    // embedded media, otherwise recurse so the embed is captured as an image node.
                    if (TEXT_TAGS.has(tag) && !child.querySelector('img, embed')) {
                        const text = (child as HTMLElement).innerText || child.textContent || '';
                        if (text.trim().length > 0) {
                            const r = child.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                const cs = getComputedStyle(child);
                                items.push({
                                    type: 'text',
                                    tag,
                                    text,
                                    x: r.left - secRect.left,
                                    y: r.top - secRect.top,
                                    w: r.width,
                                    h: r.height,
                                    fontSize: parseFloat(cs.fontSize),
                                    color: cs.color,
                                    fontWeight: cs.fontWeight,
                                    fontStyle: cs.fontStyle,
                                    textAlign: cs.textAlign,
                                    fontFamily: cs.fontFamily,
                                });
                            }
                        }
                        continue;
                    }

                    walk(child);
                }
            };

            walk(section);
            slides.push({ width: w, height: h, background, items });
        }

        return slides;
    });
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
    }

    private async doExport(file: TFile): Promise<void> {
        const app = this.app as App;
        const filesTool = new FilePath(this.settings);

        const completeFilePath = filesTool.getCompleteFilePath(file);
        if (completeFilePath === '') return;

        const markdownText = await app.vault.cachedRead(file);
        const processedMarkdown = filesTool.convertImageWikiLinks(markdownText, file, app);
        const { processedMarkdown: mdSized, dimensionMap } = parseMermaidDimensions(processedMarkdown);

        const marp = createMarpInstance(this.settings);

        if (this.settings.ThemePath !== '') {
            const themeContents = await Promise.all(
                app.vault.getFiles()
                    .filter((f) => f.parent?.path === normalizePath(this.settings.ThemePath))
                    .map((f) => app.vault.cachedRead(f))
            );
            themeContents.forEach((content) => marp.themeSet.add(content));
        }

        let { html, css } = marp.render(mdSized);
        ({ html, css } = applyMermaidStyling(html, css, dimensionMap, this.settings.MermaidWidth, this.settings.MermaidHeight));

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

            const pptx = new pptxgen();
            const layoutName = `${layouts[0].width}x${layouts[0].height}`;
            pptx.defineLayout({ name: layoutName, width: pxToIn(layouts[0].width), height: pxToIn(layouts[0].height) });
            pptx.layout = layoutName;

            for (const layout of layouts) {
                const slide = pptx.addSlide();

                if (!isTransparent(layout.background)) {
                    slide.background = { color: rgbToHex(layout.background) };
                }

                for (const item of layout.items) {
                    if (item.type === 'text') {
                        slide.addText(item.text, {
                            x: pxToIn(item.x),
                            y: pxToIn(item.y),
                            w: pxToIn(item.w),
                            h: pxToIn(item.h),
                            fontSize: Math.max(1, Math.round(pxToPt(item.fontSize))),
                            color: rgbToHex(item.color),
                            bold: parseInt(item.fontWeight, 10) >= 600 || item.fontWeight === 'bold',
                            italic: item.fontStyle === 'italic',
                            align: (item.textAlign === 'start' ? 'left' : item.textAlign === 'end' ? 'right' : item.textAlign) as 'left' | 'right' | 'center' | 'justify',
                            fontFace: item.tag === 'PRE' ? 'Consolas' : undefined,
                            bullet: item.tag === 'LI' ? true : undefined,
                            valign: 'top',
                            margin: 0,
                            autoFit: false,
                        });
                    } else {
                        const el = await page.$(`[data-export-id="${item.id}"]`);
                        if (!el) continue;

                        const shot = await el.screenshot({ type: 'png' });
                        slide.addImage({
                            data: `image/png;base64,${Buffer.from(shot).toString('base64')}`,
                            x: pxToIn(item.x),
                            y: pxToIn(item.y),
                            w: pxToIn(item.w),
                            h: pxToIn(item.h),
                        });
                    }
                }
            }

            const outputPath = this.settings.EXPORT_PATH !== ''
                ? `${this.settings.EXPORT_PATH}${file.basename}-editable.pptx`
                : path.join(path.dirname(completeFilePath), `${file.basename}-editable.pptx`);

            const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
            writeFileSync(outputPath, buffer);
        } finally {
            // Cleanup failures (e.g. Windows file locks on the Chrome temp profile) must
            // never mask the real error from the try block above.
            if (browser) {
                try { await browser.close(); } catch (e) { console.warn('Failed to close Puppeteer browser.', e); }
            }
            try { removeSync(tempHtmlPath); } catch (e) { console.warn('Failed to remove temp export HTML.', e); }
        }
    }
}
