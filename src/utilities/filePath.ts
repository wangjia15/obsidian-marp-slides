import { Vault, normalizePath, FileSystemAdapter, TFile, App } from 'obsidian';
import { MarpSlidesSettings } from './settings';

export class FilePath  {

    private settings : MarpSlidesSettings;

    constructor(settings: MarpSlidesSettings) {
        this.settings = settings;
    }

    private getLinkFormat(file: TFile): string {
        //console.log(`newLinkFormat: ${(file.vault as any).getConfig("newLinkFormat")}`);
        return (file.vault as any).getConfig("newLinkFormat");
    }

    private isAbsoluteLinkFormat(file: TFile): boolean {
        if(this.getLinkFormat(file) == "absolute"){
            return true;
        }
        else{
            return false;
        }
    }

    private getRootPath(file: TFile): string {
        
		let basePath = (file.vault.adapter as FileSystemAdapter).getBasePath();
        if (basePath.startsWith('/')){
            basePath = `/${normalizePath(basePath)}/`;
        }
        else
        {
            basePath = `${normalizePath(basePath)}/`;
        }

        //console.log(`Root Path: ${basePath}`);
        return basePath;
	}

	public getCompleteFileBasePath(file: TFile): string{
        let resourcePath = [""];
        if(this.isAbsoluteLinkFormat(file)){
            resourcePath = (file.vault.adapter as FileSystemAdapter).getResourcePath(normalizePath("/")).split("?");
        }
        else
        {
            if (file.parent != null){
                resourcePath = (file.vault.adapter as FileSystemAdapter).getResourcePath(normalizePath(file.parent.path)).split("?");
            }
        }
        //console.log(`Complete File Base Path: ${resourcePath}`);
        return `${resourcePath[0]}/`;
	}

    public getCompleteFilePath(file: TFile) : string{

        let basePath = `${this.getRootPath(file)}${normalizePath(file.path)}`;
        if(this.isAbsoluteLinkFormat(file)){
            basePath = `${this.getRootPath(file)}${normalizePath(file.name)}`;
        }
        //console.log(`Complete File Path: ${basePath}`);
        return basePath;
	}

    public async copyFileToRoot(file: TFile) {
        if(this.isAbsoluteLinkFormat(file)){
            await (file.vault.adapter as FileSystemAdapter).copy(file.path, file.name);
            //console.log(`copied!`);
        }
    }

    public async removeFileFromRoot(file: TFile) {
        const isFileExists = await (file.vault.adapter as FileSystemAdapter).exists(file.name);
        if(this.isAbsoluteLinkFormat(file) && isFileExists){
            await (file.vault.adapter as FileSystemAdapter).remove(file.name);
        }
    }

    public getThemePath(file: TFile): string{
        const themePath = `${this.getRootPath(file)}${normalizePath(this.settings.ThemePath)}`;
        //console.log(`Theme Path: ${themePath}`);
        if (this.settings.ThemePath != ''){
            return themePath;
        } 
        else
        {
            return '';
        }
    }

    private getPluginDirectory(vault: Vault): string {
        const fileSystem = vault.adapter as FileSystemAdapter;
        const path = `${fileSystem.getBasePath()}/${normalizePath(vault.configDir)}/plugins/marp-slides/`;
        //console.log(path);
        return path;
	}

    public getLibDirectory(vault: Vault): string {
        const pluginDirectory = this.getPluginDirectory(vault);
        const path = `${pluginDirectory}lib3/`;
        //console.log(path);
        return path;
	}

    public getMarpEngine(vault: Vault): string {
        const libDirectory = this.getLibDirectory(vault);
        const path = `${libDirectory}marp.config.js`;
        //console.log(path);
        return path;
	}

    // Extensions recognised as embeddable images.
    private static readonly IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)(?:$|[?#])/i;

    // Marp's own image keywords (resize / background / filters). When any of
    // these already appear in the alt text we leave it untouched instead of
    // trying to reinterpret it as an Obsidian size hint.
    private static readonly MARP_KEYWORDS =
        /(^|\s)(bg|fit|left|right|vertical|horizontal|auto|w:|h:|width:|height:|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia)/i;

    /**
     * Translate an Obsidian image size hint into Marp resize keywords.
     * Obsidian accepts a bare width ("300") or "WIDTHxHEIGHT" ("300x200") both
     * in the wiki-embed pipe (`![[img|300]]`) and in the alt text of a standard
     * Markdown embed (`![300](img.png)`). Marp instead wants `w:300 h:200`.
     * Returns null when the text is not a size hint.
     */
    public static parseSizeHint(text: string): string | null {
        const match = /^\s*(\d+)(?:\s*[x×]\s*(\d+))?\s*$/i.exec(text);
        if (!match) {
            return null;
        }
        const keywords = [`w:${match[1]}`];
        if (match[2]) {
            keywords.push(`h:${match[2]}`);
        }
        return keywords.join(' ');
    }

    /**
     * Normalise every image embed in a deck to a form Marp / marp-cli render
     * correctly:
     *   - Obsidian wiki embeds      `![[img.png|...]]`      -> `![...](resolved/path)`
     *   - Obsidian Markdown embeds  `![alt](img.png)`       -> `![alt](resolved/path)`
     *   - Obsidian size hints (`|300`, `|300x200`, `![300](...)`) -> `w:300 h:200`
     * Remote URLs and already-resolvable paths keep their target (only the size
     * hint is rewritten); alt text that already carries Marp keywords is left
     * as-is.
     */
    public convertImages(markdown: string, sourceFile: TFile, app: App): string {
        const withWiki = this.convertImageWikiLinks(markdown, sourceFile, app);
        return this.convertMarkdownImageLinks(withWiki, sourceFile, app);
    }

    /**
     * Convert Obsidian wiki-link image syntax to standard Markdown.
     * Transforms `![[image.png]]` to `![image.png](path/to/image.png)` and
     * `![[image.png|300x200]]` to `![w:300 h:200](path/to/image.png)`.
     */
    public convertImageWikiLinks(markdown: string, sourceFile: TFile, app: App): string {
        // ![[filename]] or ![[filename|param|param...]]
        const wikiLinkRegex = /!\[\[([^\]|\n]+?)((?:\|[^\]\n]*)*)\]\]/g;

        return markdown.replace(wikiLinkRegex, (match, filename, rawParams) => {
            if (!FilePath.IMAGE_EXTENSIONS.test(filename)) {
                return match;
            }

            const params: string[] = rawParams
                ? String(rawParams).split('|').slice(1)
                : [];

            const sizeKeywords: string[] = [];
            const altParts: string[] = [];
            for (const param of params) {
                const size = FilePath.parseSizeHint(param);
                if (size) {
                    sizeKeywords.length = 0;
                    sizeKeywords.push(size);
                } else if (param.trim() !== '') {
                    altParts.push(param.trim());
                }
            }

            const target = this.resolveImageTarget(filename, sourceFile, app);
            if (target === null) {
                // File not found - return original so the user can spot the typo.
                return match;
            }

            const alt = [...altParts, ...sizeKeywords].join(' ') || filename;
            return `![${alt}](${this.encodeImagePath(target)})`;
        });
    }

    /**
     * Fix up standard Markdown image embeds so they survive the export:
     *   - resolve Obsidian-style targets (bare filename, vault-absolute `/x.png`,
     *     `./x.png`, URL-encoded spaces) to a path relative to the deck;
     *   - turn an Obsidian size hint in the alt text into Marp keywords.
     * Remote URLs (http/https/data/app/file) keep their target untouched.
     */
    public convertMarkdownImageLinks(markdown: string, sourceFile: TFile, app: App): string {
        // ![alt](target "optional title")  -- target optionally wrapped in <>
        const mdImageRegex = /!\[([^\]\n]*)\]\(\s*<?([^)<>\s]+)>?(\s+["'][^"'\n]*["'])?\s*\)/g;

        return markdown.replace(mdImageRegex, (_match, altText, target, title) => {
            const alt = this.rewriteAlt(String(altText));
            const trimmedTitle = title ? String(title) : '';

            if (/^(https?:|data:|app:|file:|mailto:)/i.test(target)) {
                return `![${alt}](${target}${trimmedTitle})`;
            }

            let clean = target;
            try {
                clean = decodeURIComponent(target);
            } catch {
                // Leave a malformed escape sequence as typed.
            }
            clean = clean.replace(/^\.\//, '').replace(/^\//, '');

            if (!FilePath.IMAGE_EXTENSIONS.test(clean)) {
                // Not an image (could be a video/pdf embed) - only fix the alt.
                return `![${alt}](${target}${trimmedTitle})`;
            }

            const resolved = this.resolveImageTarget(clean, sourceFile, app);
            if (resolved === null) {
                // Keep the author's target; it may already be correct on disk.
                return `![${alt}](${target}${trimmedTitle})`;
            }

            return `![${alt}](${this.encodeImagePath(resolved)}${trimmedTitle})`;
        });
    }

    // Convert an Obsidian size hint sitting in the alt text ("300", "300x200")
    // into Marp keywords, unless the alt already carries Marp keywords or real
    // prose (then it is returned unchanged).
    private rewriteAlt(alt: string): string {
        if (FilePath.MARP_KEYWORDS.test(alt)) {
            return alt;
        }
        return FilePath.parseSizeHint(alt) ?? alt;
    }

    // Resolve a link target to a deck-relative (or vault-root-relative, for the
    // "absolute" new-link-format) path via Obsidian's own resolver. Returns null
    // when nothing in the vault matches.
    private resolveImageTarget(linkpath: string, sourceFile: TFile, app: App): string | null {
        const linkedFile = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
        if (!linkedFile) {
            return null;
        }
        if (this.isAbsoluteLinkFormat(sourceFile)) {
            return linkedFile.path;
        }
        return this.getRelativePathFromFile(sourceFile, linkedFile);
    }

    // Percent-encode spaces (and other URL-unsafe chars) in a path so it stays a
    // single Markdown link token; forward slashes and the drive colon are kept.
    private encodeImagePath(path: string): string {
        return path
            .split('/')
            .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
            .join('/');
    }

    /**
     * Calculate relative path from source file to target file.
     */
    private getRelativePathFromFile(sourceFile: TFile, targetFile: TFile): string {
        const sourceParts = sourceFile.parent?.path.split('/').filter(p => p) || [];
        const targetParts = targetFile.path.split('/').filter(p => p);

        // Find common prefix length
        let commonLength = 0;
        while (commonLength < sourceParts.length &&
               commonLength < targetParts.length - 1 &&
               sourceParts[commonLength] === targetParts[commonLength]) {
            commonLength++;
        }

        // Build relative path
        const upCount = sourceParts.length - commonLength;
        const relativeParts = [...Array(upCount).fill('..'), ...targetParts.slice(commonLength)];

        return relativeParts.join('/');
    }
}