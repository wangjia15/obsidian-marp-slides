import { ItemView, WorkspaceLeaf, MarkdownView, normalizePath, TFile, TAbstractFile, debounce } from 'obsidian';
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
    // Kept so a theme-file change can re-render without user interaction.
    private lastEditorView: MarkdownView | null = null;

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

    private actionsAdded = false;

    async onOpen() {
        try {
            // this.contentEl is the official ItemView content container. The old
            // `containerEl.children[1]` lookup assumed a specific DOM shape and
            // intermittently returned undefined, aborting onOpen on its very first
            // line (no browser, no export buttons, no themes — everything after it
            // silently skipped).
            const container = this.contentEl;
            container.empty();
            this.lastRenderedKey = '';

            // browser() only adds slide auto-scaling; if it ever fails (e.g. the
            // custom elements are already registered after a plugin reload),
            // degrade gracefully instead of skipping themes and the watcher below.
            try {
                this.marpBrowser = browser(container);
            } catch (e) {
                console.warn('Marp Slides: slide auto-scaling failed to initialize (non-fatal).', e);
            }

            if (this.settings.ThemePath != '') {
                const themeFiles = this.app.vault.getFiles().filter(
                    (x) => x.parent?.path == normalizePath(this.settings.ThemePath) && x.extension === 'css'
                );

                for (const file of themeFiles) {
                    try {
                        // See reloadTheme() below for why this is `read`, not
                        // `cachedRead`: a view can open right after a theme file was
                        // saved (e.g. reopening the preview to pick up an edit), and
                        // the vault cache for that file is not guaranteed fresh yet.
                        const content = await this.app.vault.read(file);
                        this.marp.themeSet.add(content);
                    } catch (e) {
                        console.warn(`Marp Slides: failed to load theme file ${file.path}; skipping.`, e);
                    }
                }
            }

            this.watchThemeFiles();
        } catch (e) {
            console.error('Marp Slides: slide preview failed to initialize.', e);
        } finally {
            // Header actions must survive any failure above — a preview without
            // export buttons looks like a broken plugin.
            this.addActions();
        }
    }

    // Hot-reload theme CSS: when a *.css file inside the theme folder changes,
    // swap the theme inside the live Marp instance and force a full re-render,
    // so tweaking the theme is visible immediately without reopening anything.
    private watchThemeFiles(): void {
        if (this.settings.ThemePath === '') return;

        const themeDir = normalizePath(this.settings.ThemePath);

        this.registerEvent(this.app.vault.on('modify', debounce((file: TAbstractFile) => {
            if (!(file instanceof TFile)) return;
            if (file.parent?.path !== themeDir || file.extension !== 'css') return;

            void this.reloadTheme(file);
        }, 400, true)));
    }

    private async reloadTheme(file: TFile): Promise<void> {
        try {
            // `cachedRead` can lag right after the very "modify" event that triggered
            // this reload — Obsidian's in-memory cache for the file isn't guaranteed
            // to be refreshed yet at that instant, so it can hand back the CSS as it
            // was *before* this edit. `read` always goes to disk, which is what a
            // hot-reload triggered by "the file just changed" needs. Theme files are
            // small and this only runs on the (debounced) edit path, not every
            // render, so the extra disk read is negligible.
            const content = await this.app.vault.read(file);
            // ThemeSet.add replaces a previously registered theme with the same
            // @theme name, so this is a true swap rather than a duplicate entry.
            this.marp.themeSet.add(content);
        } catch (e) {
            console.warn(`Marp Slides: failed to reload theme file ${file.path}; keeping previous theme.`, e);
            return;
        }

        this.lastRenderedKey = '';
        if (this.lastEditorView) {
            await this.displaySlides(this.lastEditorView);
        }
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
        // onOpen can run more than once for a view (workspace restore, plugin
        // reload); the buttons would stack up.
        if (this.actionsAdded) return;
        this.actionsAdded = true;

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
            this.lastEditorView = view;
            const filePath = new FilePath(this.settings);
            const basePath = filePath.getCompleteFileBasePath(view.file);
            const markdownText = view.data;

            // Re-rendering is expensive (full Marp render + innerHTML swap); skip when
            // nothing that affects the output has changed.
            const renderKey = `${basePath}|${this.settings.MermaidRenderMode}|${this.settings.KrokiServerUrl}|${this.settings.MermaidWidth}|${this.settings.MermaidHeight}|${markdownText}`;
            if (renderKey === this.lastRenderedKey) {
                return;
            }

            // Convert wiki-link images to standard markdown
            const processedMarkdown = filePath.convertImageWikiLinks(markdownText, view.file, this.app);

            const container = this.contentEl;
            container.empty();

            // Local mermaid mode: replace fences with pre-rendered inline SVG before
            // the Marp conversion. Failed diagrams keep their fence (visible source
            // instead of a blank area).
            let effectiveMarkdown = processedMarkdown;
            if (this.settings.MermaidRenderMode === 'local') {
                const { renderMermaidInMarkdown } = await import('../utilities/localMermaid');
                const local = await renderMermaidInMarkdown(processedMarkdown, this.settings);
                effectiveMarkdown = local.markdown;
                local.failures.forEach((f) =>
                    console.warn(`Marp Slides: local mermaid render failed: ${f.message}\n${f.source}`)
                );
            }

            const { processedMarkdown: mdSized, dimensionMap } = parseMermaidDimensions(effectiveMarkdown);
            let { html, css } = this.marp.render(mdSized);
            ({ html, css } = applyMermaidStyling(html, css, dimensionMap, this.settings.MermaidWidth, this.settings.MermaidHeight, this.settings.KrokiServerUrl));
            
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