import { ItemView, WorkspaceLeaf, MarkdownView, normalizePath, TFile } from 'obsidian';
import { Marp } from '@marp-team/marp-core'
import { browser, type MarpCoreBrowser } from '@marp-team/marp-core/browser'
import { deflateSync } from 'zlib';

import { MarpSlidesSettings } from '../utilities/settings'
import { MarpExport } from '../utilities/marpExport';
import { EditablePptxExport } from '../utilities/editablePptxExport';
import { FilePath } from '../utilities/filePath'
import { createMarpInstance } from '../utilities/marpInstance';

interface MermaidDimension {
    width?: string;
    height?: string;
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

export const MARP_PREVIEW_VIEW = 'marp-preview-view';

export class MarpPreviewView extends ItemView  {
    private marp: Marp;

    private marpBrowser: MarpCoreBrowser | undefined;
    private settings : MarpSlidesSettings;

    private file : TFile;

    constructor(settings: MarpSlidesSettings, leaf: WorkspaceLeaf) {
        super(leaf);

        this.settings = settings;
        this.marp = createMarpInstance(settings);
    }

    getViewType() {
        return MARP_PREVIEW_VIEW;
    }

    getDisplayText() {
        return "Deck Preview";
    }

    async onOpen() {
        // console.log("marp slide onopen");

        const container = this.containerEl.children[1];
        container.empty();
        this.marpBrowser = browser(container);

        if (this.settings.ThemePath != '') {        
            const fileContents: string[] = await Promise.all(
                this.app.vault.getFiles()
                    .filter(x => x.parent?.path == normalizePath(this.settings.ThemePath))
                    .map((file) => this.app.vault.cachedRead(file))
            );

            fileContents.forEach((content) => {
                this.marp.themeSet.add(content);
            });
        }

        this.addActions();
    }

    async onClose() {
        // Nothing to clean up.
        // console.log("marp slide onclose");
    }

    async onChange(view : MarkdownView) {
        this.displaySlides(view);
    }

    async onLineChanged(line: number) {
        try {
		    this.containerEl.children[1].children[2].children[line].scrollIntoView();
        } catch {
            console.log("Preview slide not found!")
        }
	}

    async addActions() {
        const marpCli = new MarpExport(this.settings, this.app);
        const editablePptxExport = new EditablePptxExport(this.settings, this.app);

        this.addAction('image', 'Export as PNG', () => {
            if (this.file) {
                marpCli.export(this.file, 'png');
            }
        });

        this.addAction('code-glyph', 'Export as HTML', () => {
            if (this.file) {
                marpCli.export(this.file, 'html');
            }
        });

        this.addAction('slides-marp-export-pdf', 'Export as PDF', () => {
            if (this.file) {
                marpCli.export(this.file, 'pdf');
            }
        });

        this.addAction('slides-marp-export-pptx', 'Export as PPTX', () => {
            if (this.file) {
                marpCli.export(this.file, 'pptx');
            }
        });

        this.addAction('pencil', 'Export as Editable PPTX (text is editable, diagrams stay as images)', () => {
            if (this.file) {
                editablePptxExport.export(this.file);
            }
        });

        this.addAction('slides-marp-slide-present', 'Preview Slides', () => {
            if (this.file) {
                marpCli.export(this.file, 'preview');
            }
        });
      }
    
    async displaySlides(view : MarkdownView) {

        if (view.file != null) {
            this.file = view.file;
            const filePath = new FilePath(this.settings);
            const basePath = filePath.getCompleteFileBasePath(view.file);
            const markdownText = view.data;

            // Convert wiki-link images to standard markdown
            const processedMarkdown = filePath.convertImageWikiLinks(markdownText, view.file, this.app);

            const container = this.containerEl.children[1];
            container.empty();

            const { processedMarkdown: mdSized, dimensionMap } = parseMermaidDimensions(processedMarkdown);
            let { html, css } = this.marp.render(mdSized);
            ({ html, css } = applyMermaidStyling(html, css, dimensionMap, this.settings.MermaidWidth, this.settings.MermaidHeight));
            
            // Replace Backgorund Url for images
            html = html.replace(/(?!background-image:url\(&quot;http)background-image:url\(&quot;/g, `background-image:url(&quot;${basePath}`);

            const htmlFile = `
                <!DOCTYPE html>
                <html>
                <head>
                <base href="${basePath}"></base>
                <style id="__marp-vscode-style">${css}</style>
                </head>
                <body>${html}</body>
                </html>
                `;

            container.innerHTML = htmlFile;
            this.marpBrowser?.update();
        }
        else
        {
            console.log("Errore: view.file is null")
        }
	}
}