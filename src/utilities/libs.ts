import { App, Notice, requestUrl } from 'obsidian';
import { FilePath } from './filePath';
import { MarpSlidesSettings } from './settings';
import { existsSync, outputFileSync } from 'fs-extra';
import JSZip from 'jszip';

const LIB_DOWNLOAD_URL = 'https://github.com/samuele-cozzi/obsidian-marp-slides/releases/download/lib-v3/lib.zip';

export class Libs {

    private settings : MarpSlidesSettings;

    constructor(settings: MarpSlidesSettings) {
        this.settings = settings;
    }

    async loadLibs(app: App): Promise<void> {
        const libPathUtility = new FilePath(this.settings);
        const libPath = libPathUtility.getLibDirectory(app.vault);

        if (existsSync(libPath)) {
            return;
        }

        try {
            const response = await requestUrl({ url: LIB_DOWNLOAD_URL });
            const zip = await JSZip.loadAsync(response.arrayBuffer);

            const entries = Object.values(zip.files).filter((entry) => !entry.dir);
            await Promise.all(entries.map(async (entry) => {
                const content = await entry.async('nodebuffer');
                outputFileSync(`${libPath}${entry.name}`, content);
            }));
        } catch (error) {
            console.error('Marp Slides: failed to download export libraries.', error);
            new Notice('Marp Slides: failed to download export libraries (needed for the Markdown-It plugins engine). Check your network connection and restart Obsidian to retry.');
        }
    }
}
