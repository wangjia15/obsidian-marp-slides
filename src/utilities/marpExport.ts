import marpCli, { CLIError, CLIErrorCode } from '@marp-team/marp-cli'
import { TFile, App, Notice } from 'obsidian';
import { request as httpsRequest } from 'https';
import { join } from 'path';
import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { tryAcquireExportLock, releaseExportLock } from './exportLock';
import { extractMermaidDiagrams, buildKrokiUrl, normalizeKrokiUrl } from './mermaid';
import { writeFileSync, readFileSync, existsSync } from 'fs-extra';

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

// The deployed marp.config.js (lib3) registers markdown-it-kroki with its default
// entrypoint. When the user has configured a custom Kroki server, rewrite the
// config so the export engine and the prewarm URLs agree on it.
function syncKrokiEntrypointInEngine(engineConfigPath: string, baseUrl: string): void {
    const normalized = normalizeKrokiUrl(baseUrl);
    if (normalized === 'https://kroki.io') return;

    const config = `module.exports = ({ marp }) =>\n` +
        `  marp.use(require("./markdown-it/@kazumatu981/markdown-it-kroki/index"), { entrypoint: "${normalized}" })\n` +
        `  .use(require("./markdown-it/markdown-it-mark/dist/markdown-it-mark.min"))\n` +
        `  .use(require("./markdown-it/markdown-it-container/dist/markdown-it-container.min"), "container");\n`;

    try {
        const current = readFileSync(engineConfigPath, 'utf-8');
        if (current !== config) {
            writeFileSync(engineConfigPath, config, 'utf-8');
        }
    } catch (e) {
        console.warn('Marp Slides: failed to sync Kroki entrypoint into the export engine config.', e);
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
                    const processedContent = filesTool.convertImageWikiLinks(originalOnDisk ?? '', file, this.app);
                    writeFileSync(completeFilePath, processedContent, 'utf-8');
                } catch (e) {
                    console.error('Failed to process wiki-links for export:', e);
                }
            }

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
            // If it is missing (offline install, blocked download), fall back to the
            // default engine instead of aborting the whole export with
            // "The specified engine has not resolved".
            if (this.settings.EnableMarkdownItPlugins && existsSync(marpEngineConfig)){
                argv.push('--engine');
                argv.push(marpEngineConfig);
            } else if (this.settings.EnableMarkdownItPlugins) {
                console.warn(`Marp Slides: engine config not found at ${marpEngineConfig}; exporting with the default engine (Markdown-It plugins disabled).`);
            }

            if (themePath != ''){
                argv.push('--theme-set');
                argv.push(themePath);
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
                    syncKrokiEntrypointInEngine(marpEngineConfig, this.settings.KrokiServerUrl);
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