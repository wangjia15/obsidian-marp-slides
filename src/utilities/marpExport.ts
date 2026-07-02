import marpCli, { CLIError, CLIErrorCode } from '@marp-team/marp-cli'
import { TFile, App, Notice } from 'obsidian';
import { request as httpsRequest } from 'https';
import { join } from 'path';
import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { tryAcquireExportLock, releaseExportLock } from './exportLock';
import { extractMermaidDiagrams } from './mermaid';
import { writeFileSync, readFileSync } from 'fs-extra';

const { generateUrl } = require('@kazumatu981/markdown-it-kroki/lib/diagram-encoder');

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

async function prewarmMermaidDiagrams(markdown: string): Promise<void> {
    const diagrams = extractMermaidDiagrams(markdown);
    if (diagrams.length === 0) return;

    const urls = diagrams.map((code) => generateUrl('https://kroki.io', 'mermaid', 'svg', code));
    await Promise.all(urls.map((url) => prewarmKrokiUrl(url, 45000)));
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

        // Convert wiki-link images to standard markdown before export
        if (this.app && completeFilePath != '') {
            try {
                const originalContent = readFileSync(completeFilePath, 'utf-8');
                const processedContent = filesTool.convertImageWikiLinks(originalContent, file, this.app);
                writeFileSync(completeFilePath, processedContent, 'utf-8');
            } catch (e) {
                console.error('Failed to process wiki-links for export:', e);
            }
        }

        if (completeFilePath != ''){
            //console.log(completeFilePath);

            const argv: string[] = [completeFilePath,'--allow-local-files'];
            //const argv: string[] = ['--engine', '@marp-team/marp-core', completeFilePath,'--allow-local-files'];

            if (this.settings.EnableMarkdownItPlugins){
                argv.push('--engine');
                argv.push(marpEngineConfig);
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
                    argv.push('--html');
                    argv.push('--template');
                    argv.push(this.settings.HTMLExportMode);
                    break;
                case 'preview':
                    argv.push('--html');
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

            if (this.settings.EnableMarkdownItPlugins) {
                try {
                    await prewarmMermaidDiagrams(readFileSync(completeFilePath, 'utf-8'));
                } catch (e) {
                    console.warn('Failed to prewarm Mermaid diagrams before export.', e);
                }
            }

            await this.run(argv, resourcesPath);
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
            process.env.CHROME_PATH = CHROME_PATH
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