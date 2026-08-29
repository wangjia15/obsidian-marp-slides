// Structural on purpose (instead of importing MarpSlidesSettings): keeps this
// module free of the settings.ts import cycle and trivially unit-testable.
interface DeckConfigSettings {
    SlideRatio?: SlideRatio;
    CodeTheme?: CodeTheme;
    MermaidTheme?: MermaidTheme;
}

// Deck-level tuning: slide ratio, code highlight theme and mermaid theme.
//
// Every knob has three layers, later wins:
//   1. plugin settings (global default)
//   2. native Marp frontmatter directives (`size`)
//   3. the `marp-slides:` frontmatter block (this plugin's namespace)
//
// The `marp-slides` block is a plain YAML mapping so it can sit next to the
// regular Marp directives:
//
//   ---
//   marp-slides:
//     ratio: 4:3
//     code-theme: one-dark
//     mermaid-theme: dark
//   ---

export type SlideRatio = '16:9' | '4:3';
export type CodeTheme = 'auto' | 'github' | 'github-dark' | 'one-dark' | 'monokai' | 'dracula';
export type MermaidTheme = 'default' | 'neutral' | 'dark' | 'forest' | 'base';

export const SLIDE_RATIOS: SlideRatio[] = ['16:9', '4:3'];
export const CODE_THEMES: CodeTheme[] = ['auto', 'github', 'github-dark', 'one-dark', 'monokai', 'dracula'];
export const MERMAID_THEMES: MermaidTheme[] = ['default', 'neutral', 'dark', 'forest', 'base'];

// Pixel size each named Marp `size` maps to. Themes get these injected as
// `@size` metadata so the native `size` directive works even for custom theme
// CSS that never declared sizes of its own.
const SIZE_META: Record<SlideRatio, { width: string; height: string }> = {
    '16:9': { width: '1280px', height: '720px' },
    '4:3': { width: '960px', height: '720px' }
};

export interface DeckConfig {
    ratio: SlideRatio;
    codeTheme: CodeTheme;
    mermaidTheme: MermaidTheme;
    // True when the deck itself pins a `size` directive (frontmatter or
    // `<!-- size: ... -->` comment); the plugin must not override it.
    sizeExplicit: boolean;
}

interface FrontmatterOverrides {
    size?: string;
    ratio?: string;
    codeTheme?: string;
    mermaidTheme?: string;
}

// Extracts the topmost YAML frontmatter block. Deliberately tolerant: it only
// needs the few scalars we care about, so a light line-based scan beats pulling
// in a full YAML dependency.
function extractFrontmatter(markdown: string): string | null {
    if (!markdown.startsWith('---')) return null;

    const end = markdown.indexOf('\n---', 3);
    if (end === -1) return null;

    return markdown.slice(4, end);
}

function unquote(value: string): string {
    // \r tolerance: staged export copies can carry CRLF line endings.
    const trimmed = value.trim().replace(/\r$/, '');
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

export function parseFrontmatterOverrides(markdown: string): FrontmatterOverrides {
    const fm = extractFrontmatter(markdown);
    if (!fm) return {};

    const overrides: FrontmatterOverrides = {};
    let inPluginBlock = false;

    // CRLF-aware split: staged export copies can carry Windows line endings.
    for (const rawLine of fm.split(/\r?\n/)) {
        // Strip full-line and trailing comments (naive but fine for scalars).
        const line = rawLine.replace(/(^|\s)#.*$/, '');

        if (/^marp-slides:\s*$/.test(line)) {
            inPluginBlock = true;
            continue;
        }
        if (inPluginBlock && /^\S/.test(line)) {
            inPluginBlock = false;
        }

        const key = line.match(/^\s*(\S+?)\s*:\s*(.*)$/);
        if (!key) continue;
        const [, name, rawValue] = key;

        if (inPluginBlock && /^\s+/.test(rawLine)) {
            if (name === 'ratio') overrides.ratio = unquote(rawValue);
            else if (name === 'code-theme' || name === 'codeTheme') overrides.codeTheme = unquote(rawValue);
            else if (name === 'mermaid-theme' || name === 'mermaidTheme') overrides.mermaidTheme = unquote(rawValue);
        } else if (!inPluginBlock) {
            if (name === 'size') overrides.size = unquote(rawValue);
        }
    }

    return overrides;
}

function firstValid<T extends string>(value: string | undefined, valid: readonly T[]): T | undefined {
    return valid.includes(value as T) ? (value as T) : undefined;
}

// Resolves the effective per-deck configuration from frontmatter + settings.
export function resolveDeckConfig(markdown: string, settings: DeckConfigSettings): DeckConfig {
    const overrides = parseFrontmatterOverrides(markdown);

    const size = overrides.size?.trim();
    // An explicit native `size` directive wins: it is what Marp itself will
    // render, and injectSizeDirective won't run for such decks anyway.
    const ratio =
        (size !== undefined && SLIDE_RATIOS.includes(size as SlideRatio) ? (size as SlideRatio) : undefined) ??
        firstValid(overrides.ratio, SLIDE_RATIOS) ??
        (settings.SlideRatio as SlideRatio) ??
        '16:9';

    return {
        ratio,
        codeTheme: firstValid(overrides.codeTheme, CODE_THEMES) ?? settings.CodeTheme ?? 'auto',
        mermaidTheme: firstValid(overrides.mermaidTheme, MERMAID_THEMES) ?? settings.MermaidTheme ?? 'default',
        sizeExplicit: size !== undefined && size !== ''
    };
}

// Injects the resolved ratio as a Marp `size` global directive unless the deck
// already pins one (frontmatter or a `<!-- size: ... -->` comment). Applies to
// the markdown handed to Marp for rendering — never written back to the note.
export function injectSizeDirective(markdown: string, config: DeckConfig): string {
    if (config.sizeExplicit || /<!--\s*size:[^>]+-->/.test(markdown)) return markdown;

    const fm = extractFrontmatter(markdown);
    if (fm === null) {
        return `---\nsize: ${config.ratio}\n---\n\n${markdown}`;
    }

    // Frontmatter exists: add `size` right after the opening delimiter,
    // preserving the file's line-ending style.
    return markdown.replace(/^---(\r?\n)/, `---$1size: ${config.ratio}$1`);
}

// Marp only honours the `size` directive when the active theme declares the
// matching `@size` metadata. Custom theme CSS usually doesn't, so prepend the
// built-in sizes that are missing; sizes the theme already defines are left
// untouched (never fight the theme author).
export function ensureSizeMeta(themeCss: string): string {
    const metas: string[] = [];
    for (const ratio of SLIDE_RATIOS) {
        const { width, height } = SIZE_META[ratio];
        if (!new RegExp(`@size\\s+${ratio}\\s`).test(themeCss)) {
            metas.push(`/* @size ${ratio} ${width} ${height} */`);
        }
    }
    if (metas.length === 0) return themeCss;

    return `${metas.join('\n')}\n${themeCss}`;
}

// Kroki renders mermaid with its own defaults; the theme is chosen per-diagram
// via a `%%{init}%%` directive on the first line of the source. Prepend one
// when the user picked a non-default theme and the diagram doesn't set its own.
// Fence attributes (`​```mermaid {width=700px}`) stay on the fence line, so the
// directive lands on the first code line where mermaid/kroki expect it.
export function injectMermaidInitTheme(markdown: string, theme: MermaidTheme): string {
    if (theme === 'default') return markdown;

    return markdown.replace(/(^```mermaid[^\n]*\n)(%%\{init:[^\n]*\n)?/gm, (match, fence: string) =>
        match.includes('%%{init:') ? match : `${fence}%%{init: {"theme": "${theme}"}}%%\n`
    );
}
