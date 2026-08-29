import { CodeTheme } from './deckConfig';

// Built-in code highlight palettes for slide code blocks.
//
// Marp core highlights code with highlight.js and emits `hljs-*` token spans
// inside `section pre code`. The colors themselves come from the active theme
// CSS (marp's built-in themes ship a GitHub-ish light palette); these palettes
// override both the `pre` panel and every token so a deck can pin a consistent
// code look regardless of its slide theme.
//
// Selectors are scoped to `section` (present in every Marp deck, in the
// in-app preview and in every marp-cli export) and are appended after the
// theme CSS, so plain source order makes them win without !important.

interface CodePalette {
    panel: string;
    tokens: Record<string, string>;
}

const c = (color: string) => `color:${color}`;

const github: CodePalette = {
    panel: 'background:#f6f8fa;color:#1f2328',
    tokens: {
        'hljs-comment, hljs-quote': c('#59636e'),
        'hljs-keyword, hljs-selector-tag, hljs-doctag, hljs-template-tag': c('#cf222e'),
        'hljs-title, hljs-title.function_': c('#8250df'),
        'hljs-attr, hljs-attribute, hljs-literal, hljs-meta, hljs-number, hljs-operator, hljs-variable, hljs-template-variable, hljs-type, hljs-selector-class, hljs-selector-attr, hljs-selector-pseudo': c('#0550ae'),
        'hljs-string, hljs-regexp, hljs-symbol, hljs-bullet': c('#0a3069'),
        'hljs-name, hljs-selector-id, hljs-tag, hljs-section': c('#116329'),
        'hljs-subst': c('#1f2328'),
        'hljs-addition': c('#116329'),
        'hljs-deletion': c('#82071e'),
        'hljs-emphasis': 'font-style:italic',
        'hljs-strong': 'font-weight:bold',
        'hljs-link': 'text-decoration:underline'
    }
};

const githubDark: CodePalette = {
    panel: 'background:#151b23;color:#f0f6fc',
    tokens: {
        'hljs-comment, hljs-quote': c('#9198a1'),
        'hljs-keyword, hljs-selector-tag, hljs-doctag, hljs-template-tag': c('#ff7b72'),
        'hljs-title, hljs-title.function_': c('#d2a8ff'),
        'hljs-attr, hljs-attribute, hljs-literal, hljs-meta, hljs-number, hljs-operator, hljs-variable, hljs-template-variable, hljs-selector-attr, hljs-selector-pseudo': c('#79c0ff'),
        'hljs-string, hljs-regexp': c('#a5d6ff'),
        'hljs-title.class_, hljs-type, hljs-selector-class': c('#ffa657'),
        'hljs-name, hljs-selector-id, hljs-tag, hljs-section, hljs-symbol, hljs-bullet': c('#7ee787'),
        'hljs-subst': c('#f0f6fc'),
        'hljs-addition': c('#aff5b4'),
        'hljs-deletion': c('#ffdcd7'),
        'hljs-emphasis': 'font-style:italic',
        'hljs-strong': 'font-weight:bold',
        'hljs-link': 'text-decoration:underline'
    }
};

const oneDark: CodePalette = {
    panel: 'background:#282c34;color:#abb2bf',
    tokens: {
        'hljs-comment, hljs-quote': `${c('#5c6370')};font-style:italic`,
        'hljs-doctag, hljs-keyword, hljs-formula': c('#c678dd'),
        'hljs-section, hljs-name, hljs-selector-tag': c('#e06c75'),
        'hljs-attr, hljs-variable, hljs-template-variable, hljs-selector-attr, hljs-selector-pseudo': c('#d19a66'),
        'hljs-literal, hljs-number': c('#d19a66'),
        'hljs-string, hljs-regexp, hljs-meta .hljs-string': c('#98c379'),
        'hljs-title, hljs-title.function_, hljs-symbol, hljs-bullet, hljs-link': c('#61afef'),
        'hljs-title.class_, hljs-type, hljs-selector-class': c('#e6c07b'),
        'hljs-attribute': c('#d19a66'),
        'hljs-meta': c('#61afef'),
        'hljs-subst': c('#abb2bf'),
        'hljs-addition': c('#98c379'),
        'hljs-deletion': c('#e06c75'),
        'hljs-emphasis': 'font-style:italic',
        'hljs-strong': 'font-weight:bold'
    }
};

const monokai: CodePalette = {
    panel: 'background:#272822;color:#f8f8f2',
    tokens: {
        'hljs-comment, hljs-quote': c('#88846f'),
        'hljs-keyword, hljs-selector-tag, hljs-section, hljs-doctag, hljs-name': c('#f92672'),
        'hljs-string, hljs-title, hljs-attr': c('#e6db74'),
        'hljs-literal, hljs-number, hljs-code': c('#ae81ff'),
        'hljs-attribute, hljs-regexp': c('#fd971f'),
        'hljs-title.class_, hljs-title.function_, hljs-selector-id, hljs-selector-class': c('#a6e22e'),
        'hljs-symbol, hljs-bullet, hljs-link': c('#e6db74'),
        'hljs-operator, hljs-meta, hljs-subst, hljs-variable, hljs-template-variable, hljs-type, hljs-selector-attr, hljs-selector-pseudo': c('#f8f8f2'),
        'hljs-addition': c('#e6db74'),
        'hljs-deletion': c('#f92672'),
        'hljs-emphasis': 'font-style:italic',
        'hljs-strong': 'font-weight:bold'
    }
};

const dracula: CodePalette = {
    panel: 'background:#282a36;color:#f8f8f2',
    tokens: {
        'hljs-comment, hljs-quote': c('#6272a4'),
        'hljs-keyword, hljs-selector-tag, hljs-literal, hljs-section, hljs-doctag, hljs-name, hljs-selector-id, hljs-title.function_': c('#ff79c6'),
        'hljs-string, hljs-regexp, hljs-meta .hljs-string': c('#f1fa8c'),
        'hljs-number, hljs-symbol, hljs-bullet, hljs-link': c('#bd93f9'),
        'hljs-title, hljs-title.class_, hljs-type, hljs-selector-class, hljs-selector-attr, hljs-selector-pseudo, hljs-template-variable, hljs-variable': c('#8be9fd'),
        'hljs-attr, hljs-attribute': c('#50fa7b'),
        'hljs-operator, hljs-meta, hljs-subst': c('#f8f8f2'),
        'hljs-addition': c('#50fa7b'),
        'hljs-deletion': c('#8b080b'),
        'hljs-emphasis': 'font-style:italic',
        'hljs-strong': 'font-weight:bold'
    }
};

const PALETTES: Record<Exclude<CodeTheme, 'auto'>, CodePalette> = {
    github,
    'github-dark': githubDark,
    'one-dark': oneDark,
    monokai,
    dracula
};

// Returns the CSS overriding code block colors for the chosen theme, scoped to
// slide sections. 'auto' (the default) yields no CSS: the slide theme keeps
// deciding how code looks, exactly as before this setting existed.
export function buildCodeThemeCss(theme: CodeTheme): string {
    const palette = PALETTES[theme as Exclude<CodeTheme, 'auto'>];
    if (!palette) return '';

    const rules: string[] = [
        `section pre{${palette.panel}}`,
        'section pre code{color:inherit}'
    ];
    for (const [selectors, declarations] of Object.entries(palette.tokens)) {
        const scoped = selectors
            .split(', ')
            .map((s) => `section pre code ${s.startsWith('.') ? s : `.${s}`}`)
            .join(', ');
        rules.push(`${scoped}{${declarations}}`);
    }

    return `/* marp-slides code theme: ${theme} */\n${rules.join('\n')}\n`;
}
