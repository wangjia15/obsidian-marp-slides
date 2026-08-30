import marpCli, { CLIError, CLIErrorCode } from '@marp-team/marp-cli'
import { TFile, App, Notice } from 'obsidian';
import { request as httpsRequest } from 'https';
import { join } from 'path';
import { tmpdir } from 'os';
import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { tryAcquireExportLock, releaseExportLock } from './exportLock';
import { extractMermaidDiagrams, buildKrokiUrl, normalizeKrokiUrl } from './mermaid';
import { resolveDeckConfig, injectSizeDirective, ensureSizeMeta, injectMermaidInitTheme, DeckConfig } from './deckConfig';
import { buildCodeThemeCss } from './codeThemes';
import { transformCallouts, hasCallouts, buildCalloutCss, CALLOUT_HTML_ALLOWLIST } from './callouts';
import { writeFileSync, readFileSync, existsSync, copySync, removeSync, readdirSync } from 'fs-extra';

export class MarpCLIError extends Error {}

// kroki.io renders on demand and caches by content hash; a diagram it hasn't seen
// before can take well beyond marp-cli's fixed ~30s Puppeteer timeout to render,
// silently dropping it from the export. Hitting the same URL ourselves first
// (with a much longer timeout) warms kroki's cache so Puppeteer's later request
// for the identical URL resolves near-instantly.
function prewarmKrokiUrl(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const req = httpsRequest(url, { timeout: timeoutMs }, (res) => {
            res.on('data', () => { /* drain, content is discarded */ });
            res.on('end', () => resolve());
            res.on('error', () => resolve());
        });
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.on('error', () => resolve());
        req.end();
    });
}

async function prewarmMermaidDiagrams(markdown: string, baseUrl: string): Promise<void> {
    const diagrams = extractMermaidDiagrams(markdown);
    if (diagrams.length === 0) return;

    const urls = diagrams.map((code) => buildKrokiUrl(baseUrl, code));
    await Promise.all(urls.map((url) => prewarmKrokiUrl(url, 45000)));
}

// The deployed marp.config.js (lib3) registers the Markdown-It plugins. Two
// export-time concerns are synced into it here:
//   - the markdown-it-kroki entrypoint, so the export engine and the prewarm
//     URLs agree on the configured Kroki server;
//   - extra CSS (e.g. a selected code highlight theme) appended to every
//     rendered deck, which plain CLI flags cannot express.
// Only rewritten when the desired content differs from what's on disk.
interface EngineConfigSpec {
    pluginsEnabled: boolean;
    krokiUrl: string;
    extraCss: string;
    // Enable a narrow div/p/span HTML allowlist so Obsidian callouts render
    // without `--html` opting the whole deck into raw HTML. Ignored when the
    // deck is already exported with `--html` (full passthrough wins).
    calloutHtml: boolean;
}

function buildEngineConfig(spec: EngineConfigSpec): string {
    const lines: string[] = ['module.exports = ({ marp }) => {'];

    if (spec.calloutHtml) {
        lines.push(
            `  marp.markdown.set({ html: ${JSON.stringify(CALLOUT_HTML_ALLOWLIST)} });`
        );
    }

    if (spec.extraCss !== '') {
        // Hook the instance's render to append our CSS after the theme CSS, so
        // source order alone makes the overrides win.
        lines.push(
            `  const extraCss = ${JSON.stringify(spec.extraCss)};`,
            '  const originalRender = marp.render.bind(marp);',
            '  marp.render = (...args) => {',
            '    const result = originalRender(...args);',
            '    return { ...result, css: result.css + extraCss };',
            '  };'
        );
    }

    if (spec.pluginsEnabled) {
        lines.push(
            '  marp.use(require("./markdown-it/@kazumatu981/markdown-it-kroki/index"), { entrypoint: ' + JSON.stringify(normalizeKrokiUrl(spec.krokiUrl)) + ' })',
            '    .use(require("./markdown-it/markdown-it-mark/dist/markdown-it-mark.min"))',
            '    .use(require("./markdown-it/markdown-it-container/dist/markdown-it-container.min"), "container");'
        );
    }

    lines.push('  return marp;', '};', '');
    return lines.join('\n');
}

function syncEngineConfig(engineConfigPath: string, spec: EngineConfigSpec): void {
    const config = buildEngineConfig(spec);

    try {
        const current = readFileSync(engineConfigPath, 'utf-8');
        if (current !== config) {
            writeFileSync(engineConfigPath, config, 'utf-8');
        }
    } catch (e) {
        console.warn('Marp Slides: failed to sync the export engine config.', e);
    }
}

// marp-cli reads the theme folder straight from disk, so the in-memory @size
// patch used by the preview cannot apply here. Instead, stage a patched copy of
// the theme folder in the system temp dir — every CSS file gets the built-in
// `@size` metadata prepended (files that already declare sizes keep theirs) —
// and hand that copy to `--theme-set`. Theme assets ride along in the copy, so
// relative url() references inside theme CSS keep resolving.
const PATCHED_THEME_DIR = join(tmpdir(), 'marp-slides-theme-patch');

function stagePatchedThemes(themePath: string): string | null {
    if (themePath === '' || !existsSync(themePath)) return null;

    try {
        removeSync(PATCHED_THEME_DIR);
        copySync(themePath, PATCHED_THEME_DIR);

        for (const entry of readdirSync(PATCHED_THEME_DIR, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.css')) continue;

            const file = join(PATCHED_THEME_DIR, entry.name);
            writeFileSync(file, ensureSizeMeta(readFileSync(file, 'utf-8')), 'utf-8');
        }

        return PATCHED_THEME_DIR;
    } catch (e) {
        console.warn('Marp Slides: failed to stage patched theme CSS; exporting with the original theme folder.', e);
        return null;
    }
}

export class MarpExport {

    private settings : MarpSlidesSettings;
    private app : App | null;

    constructor(settings: MarpSlidesSettings, app: App | null = null) {
        this.settings = settings;
        this.app = app;
    }

    async export(file: TFile, type: string){
        // Preview mode keeps a watcher process alive until its window is closed,
        // so it must not hold the export lock.
        const needsLock = type !== 'preview';

        if (needsLock) {
            if (!tryAcquireExportLock()) {
                new Notice('Marp Slides: another export is already running, please wait for it to finish.');
                return;
            }
            new Notice(`Marp Slides: exporting "${file.basename}" (${type})...`);
        }

        try {
            await this.doExport(file, type);

            if (needsLock) {
                new Notice(`Marp Slides: export of "${file.basename}" (${type}) completed.`);
            }
        } finally {
            if (needsLock) {
                releaseExportLock();
            }
        }
    }

    private async doExport(file: TFile, type: string){
        const filesTool = new FilePath(this.settings);
        await filesTool.removeFileFromRoot(file);
        await filesTool.copyFileToRoot(file);
        const completeFilePath = filesTool.getCompleteFilePath(file);
        const themePath = filesTool.getThemePath(file);
        const resourcesPath = filesTool.getLibDirectory(file.vault);
        const marpEngineConfig = filesTool.getMarpEngine(file.vault);

        if (completeFilePath == '') return;

        // marp-cli is a CLI: it needs the deck on disk and reads it itself, so the
        // wiki-link conversion and (when MermaidRenderMode is 'local') the mermaid
        // pre-render below both mutate `completeFilePath` in place before invoking
        // it. `getCompleteFilePath` only returns a throwaway root copy when the vault
        // uses the rare "absolute" new-link-format setting (see FilePath.
        // copyFileToRoot) — for every default-configured vault it is the path of the
        // ORIGINAL note. Snapshot its pristine bytes now and restore them in
        // `finally`, so a crash mid-export can't leave the transformed content
        // (expanded <img> links, or a source-losing mermaid-fence -> inline-SVG
        // rewrite) permanently overwriting the user's actual note.
        const originalOnDisk = existsSync(completeFilePath)
            ? readFileSync(completeFilePath, 'utf-8')
            : undefined;

        try {
            // Convert wiki-link images to standard markdown before export
            if (this.app) {
                try {
                    const processedContent = filesTool.convertImages(originalOnDisk ?? '', file, this.app);
                    writeFileSync(completeFilePath, processedContent, 'utf-8');
                } catch (e) {
                    console.error('Failed to process wiki-links for export:', e);
                }
            }

            // Deck-level tuning (ratio / code theme / mermaid theme) resolved from
            // the note's frontmatter with the plugin settings as defaults.
            let deckConfig: DeckConfig;
            try {
                deckConfig = resolveDeckConfig(readFileSync(completeFilePath, 'utf-8'), this.settings);
            } catch (e) {
                console.warn('Marp Slides: failed to read the deck for config resolution; using plugin defaults.', e);
                deckConfig = resolveDeckConfig('', this.settings);
            }

            // Ratio: stage the resolved size as a Marp directive (no-op when the
            // deck already pins `size`), and carry the mermaid theme into kroki
            // fence sources so server-side renders match the local ones.
            let stagedMarkdown = injectSizeDirective(readFileSync(completeFilePath, 'utf-8'), deckConfig);
            if (this.settings.MermaidRenderMode === 'kroki') {
                stagedMarkdown = injectMermaidInitTheme(stagedMarkdown, deckConfig.mermaidTheme);
            }
            // Rewrite Obsidian callouts (`> [!note]`) into styled HTML blocks.
            const deckHasCallouts = hasCallouts(stagedMarkdown);
            if (deckHasCallouts) {
                stagedMarkdown = transformCallouts(stagedMarkdown);
            }
            if (stagedMarkdown !== originalOnDisk) {
                writeFileSync(completeFilePath, stagedMarkdown, 'utf-8');
            }

            // Code highlight theme has no CLI flag; it rides along through the
            // engine config, which appends the CSS to every rendered deck. The
            // callout CSS goes the same way when the deck uses callouts.
            const extraCss = buildCodeThemeCss(deckConfig.codeTheme) +
                (deckHasCallouts ? buildCalloutCss() : '');

            const argv: string[] = [completeFilePath,'--allow-local-files'];
            //const argv: string[] = ['--engine', '@marp-team/marp-core', completeFilePath,'--allow-local-files'];

            // Local mermaid mode replaces fences with raw-HTML inline SVG before the
            // CLI conversion, so HTML passthrough must be enabled for every export
            // type (pptx/pdf/png would otherwise escape the SVG as plain text).
            const localMermaid = this.settings.MermaidRenderMode === 'local';
            if (this.settings.EnableHTML || localMermaid) {
                argv.push('--html');
            }

            // The engine config lives in lib3/, downloaded from GitHub on first run.
            // It is used for the Markdown-It plugins and for appending the code
            // theme CSS; when only the latter is needed, plugins stay off. If the
            // config is missing (offline install, blocked download), fall back to
            // the default engine instead of aborting the whole export with
            // "The specified engine has not resolved".
            // `--html` (full passthrough) makes the callout allowlist redundant.
            const calloutHtml = deckHasCallouts && !this.settings.EnableHTML && !localMermaid;
            const needsEngine = this.settings.EnableMarkdownItPlugins || extraCss !== '' || calloutHtml;
            if (needsEngine && existsSync(marpEngineConfig)){
                syncEngineConfig(marpEngineConfig, {
                    pluginsEnabled: this.settings.EnableMarkdownItPlugins,
                    krokiUrl: this.settings.KrokiServerUrl,
                    extraCss,
                    calloutHtml
                });
                argv.push('--engine');
                argv.push(marpEngineConfig);
            } else if (needsEngine) {
                console.warn(`Marp Slides: engine config not found at ${marpEngineConfig}; exporting with the default engine (${this.settings.EnableMarkdownItPlugins ? 'Markdown-It plugins' : 'code highlight theme / callouts'} disabled).`);
                // No engine available: fall back to full `--html` so at least the
                // callout markup is not escaped into visible tags.
                if (calloutHtml && !argv.includes('--html')) {
                    argv.push('--html');
                }
            }

            // Themes are passed as a patched copy in temp storage: custom theme
            // CSS rarely declares `@size` metadata, without which the size
            // directive (ratio setting / frontmatter) is silently ignored.
            const patchedThemeDir = stagePatchedThemes(themePath);
            const effectiveThemePath = patchedThemeDir ?? themePath;
            if (effectiveThemePath != ''){
                argv.push('--theme-set');
                argv.push(effectiveThemePath);
            }

            switch (type) {
                case 'pdf':
                    argv.push('--pdf');
                    if (this.settings.EXPORT_PATH != ''){
                        argv.push('-o');
                        argv.push(join(this.settings.EXPORT_PATH, `${file.basename}.pdf`));
                    }
                    break;
                case 'pdf-with-notes':
                    argv.push('--pdf');
                    argv.push('--pdf-notes');
                    argv.push('--pdf-outlines');
                    if (this.settings.EXPORT_PATH != ''){
                        argv.push('-o');
                        argv.push(join(this.settings.EXPORT_PATH, `${file.basename}.pdf`));
                    }
                    break;
                case 'pptx':
                    argv.push('--pptx');
                    if (this.settings.EXPORT_PATH != ''){
                        argv.push('-o');
                        argv.push(join(this.settings.EXPORT_PATH, `${file.basename}.pptx`));
                    }
                    break;
                case 'png':
                    argv.push('--images');
                    argv.push('--png');
                    if (this.settings.EXPORT_PATH != ''){
                        argv.push('-o');
                        argv.push(join(this.settings.EXPORT_PATH, `${file.basename}.png`));
                    }
                    break;
                case 'html':
                    argv.push('--template');
                    argv.push(this.settings.HTMLExportMode);
                    break;
                case 'preview':
                    argv.push('--preview');
                    break;
                default:
                    //argv.push('--template');
                    //argv.push('bare');
                    //argv.push('bespoke');
                    //argv.push('--engine');
                    //argv.push('@marp-team/marpit');
                    //argv.remove(completeFilePath);
                    //process.env.PORT = "5001";
                    //argv.push('PORT=5001');
                    //argv.push('--server');

                    //argv.push('--watch');
            }

            if (localMermaid) {
                // Render every mermaid fence offline into inline SVG inside the
                // staged copy of the deck; the pristine original is restored in
                // `finally` below regardless of how this turns out.
                try {
                    const staged = readFileSync(completeFilePath, 'utf-8');
                    const { renderMermaidInMarkdown } = await import('./localMermaid');
                    const result = await renderMermaidInMarkdown(staged, this.settings);
                    if (result.renderedCount > 0) {
                        writeFileSync(completeFilePath, result.markdown, 'utf-8');
                    }
                    result.failures.forEach((f) =>
                        console.warn(`Marp Slides: local mermaid render failed: ${f.message}\n${f.source}`)
                    );
                    if (result.failures.length > 0) {
                        new Notice(`Marp Slides: ${result.failures.length} mermaid diagram(s) failed to render locally and were left as code blocks.`);
                    }
                } catch (e) {
                    console.error('Marp Slides: local mermaid pre-render failed before export.', e);
                }
            } else if (this.settings.EnableMarkdownItPlugins) {
                try {
                    await prewarmMermaidDiagrams(readFileSync(completeFilePath, 'utf-8'), normalizeKrokiUrl(this.settings.KrokiServerUrl));
                } catch (e) {
                    console.warn('Failed to prewarm Mermaid diagrams before export.', e);
                }
            }

            await this.run(argv, resourcesPath);
        } finally {
            if (originalOnDisk !== undefined) {
                try {
                    writeFileSync(completeFilePath, originalOnDisk, 'utf-8');
                } catch (e) {
                    console.error('Marp Slides: failed to restore the original note after export; it may still contain export-time transformations (converted wiki-links / rendered mermaid SVG). Please check the file.', e);
                    new Notice(`Marp Slides: could not restore "${file.basename}" after export — please check it wasn't left modified.`);
                }
            }
        }
    }

    //async exportPdf(argv: string[], opts?: MarpCLIAPIOptions | undefined){
    // Export depends on kroki.io to render Mermaid/PlantUML diagrams, and marp-cli
    // launches a fresh Puppeteer browser for every export. That first network round-trip
    // is occasionally very slow (observed 60s+ against a ~30s internal timeout), which
    // silently produces a slide deck missing its diagrams. A single retry is cheap and,
    // per observed behaviour, near-always succeeds fast on the second attempt.
    private static readonly MAX_ATTEMPTS = 2;

    private async run(argv: string[], resourcesPath: string){
        const { CHROME_PATH } = process.env;

        // marp-cli 4.x resolves the conversion engine via ESM `import()` when
        // `isESMAvailable()` holds (`!('pkg' in process)`). The bundled plugin
        // runs inside Obsidian's Electron renderer, where dynamic `import()` of a
        // `file:` URL silently fails, so every `--engine` resolution (including
        // the bundled marp.config.js) returns null and marp-cli aborts with
        // "The specified engine has not resolved". `isStandaloneBinary()` is the
        // designed gate: defining `process.pkg` flips it true and forces marp-cli
        // onto its CommonJS `_silentRequire` path, which works here. It is the
        // only consumer of the flag in marp-cli 4.x (engine.ts only).
        const hadPkg = Reflect.has(process, 'pkg');
        const savedPkg = Reflect.get(process, 'pkg');
        Reflect.set(process, 'pkg', true);

        try {
            process.env.CHROME_PATH = this.settings.CHROME_PATH || CHROME_PATH;

            let lastError: unknown;

            for (let attempt = 1; attempt <= MarpExport.MAX_ATTEMPTS; attempt++) {
                try {
                    await this.runMarpCli(argv, resourcesPath);
                    return;
                } catch (e) {
                    lastError = e;

                    if (e instanceof CLIError && e.errorCode === CLIErrorCode.NOT_FOUND_BROWSER) {
                        break;
                    }

                    console.warn(`Marp CLI export attempt ${attempt}/${MarpExport.MAX_ATTEMPTS} failed.`, e);
                }
            }

            throw lastError;
        } catch (e) {
            console.error(e)

            if (
                e instanceof CLIError &&
                e.errorCode === CLIErrorCode.NOT_FOUND_BROWSER
            ) {
                const browsers = ['[Google Chrome](https://www.google.com/chrome/)']

                if (process.platform === 'linux')
                    browsers.push('[Chromium](https://www.chromium.org/)')

                browsers.push('[Microsoft Edge](https://www.microsoft.com/edge)')

                const message = `It requires to install ${browsers
                    .join(', ')
                    .replace(/, ([^,]*)$/, ' or $1')} for exporting.`

                new Notice(`Marp Slides export failed: ${message}`);
                throw new MarpCLIError(message)
            }

            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Marp Slides export failed after ${MarpExport.MAX_ATTEMPTS} attempts: ${message}`);

            throw e
        } finally {
            process.env.CHROME_PATH = CHROME_PATH;
            if (hadPkg) Reflect.set(process, 'pkg', savedPkg);
            else Reflect.deleteProperty(process, 'pkg');
        }
    }

    private async runMarpCli(argv: string[], resourcesPath: string) {
        console.info(`Execute Marp CLI [${argv.join(' ')}]`);
        let temp__dirname = __dirname;

        try {
            __dirname = resourcesPath;
            const exitCode = await marpCli(argv, {});

            if (exitCode > 0) {
                throw new Error(`Marp CLI exited with status ${exitCode}`);
            }
        } finally {
            __dirname = temp__dirname;
        }
    }
}