import { ItemView, WorkspaceLeaf, MarkdownView, normalizePath, TFile } from 'obsidian';
import { Marp } from '@marp-team/marp-core'
import { browser, type MarpCoreBrowser } from '@marp-team/marp-core/browser'

import { MarpSlidesSettings } from '../utilities/settings'
import { MarpExport } from '../utilities/marpExport';
import { EditablePptxExport } from '../utilities/editablePptxExport';
import { FilePath } from '../utilities/filePath'
import { createMarpInstance } from '../utilities/marpInstance';
import { parseMermaidDimensions, applyMermaidStyling } from '../utilities/mermaid';

export const MARP_PREVIEW_VIEW = 'marp-preview-view';

export class MarpPreviewView extends ItemView  {
    private marp: Marp;

    private marpBrowser: MarpCoreBrowser | undefined;
    private settings : MarpSlidesSettings;

    private file : TFile;
    private lastRenderedKey = '';

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
        this.lastRenderedKey = '';
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
        const slides = this.containerEl.querySelectorAll('[data-marp-vscode-slide-wrapper]');
        if (slides.length === 0) {
            return;
        }
        slides[Math.max(0, Math.min(line, slides.length - 1))].scrollIntoView();
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

            // Re-rendering is expensive (full Marp render + innerHTML swap); skip when
            // nothing that affects the output has changed.
            const renderKey = `${basePath}|${this.settings.MermaidWidth}|${this.settings.MermaidHeight}|${markdownText}`;
            if (renderKey === this.lastRenderedKey) {
                return;
            }

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
            this.lastRenderedKey = renderKey;
        }
        else
        {
            console.log("Errore: view.file is null")
        }
	}
}