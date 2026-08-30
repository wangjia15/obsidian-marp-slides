import { SlideRatio, CodeTheme, MermaidTheme } from './deckConfig';

export type MermaidRenderMode = 'local' | 'kroki';

export interface MarpSlidesSettings {
	CHROME_PATH: string;
	ThemePath: string;
	EnableHTML: boolean;
	MathTypesettings: string ;
	HTMLExportMode: string;
	EXPORT_PATH: string;
	EnableSyncPreview: boolean;
	EnableMarkdownItPlugins: boolean;
	MermaidRenderMode: MermaidRenderMode;
	KrokiServerUrl: string;
	MermaidWidth: string;
	MermaidHeight: string;
	MermaidFontFamily: string;
	SlideRatio: SlideRatio;
	CodeTheme: CodeTheme;
	MermaidTheme: MermaidTheme;
}

export const DEFAULT_SETTINGS: MarpSlidesSettings = {
	CHROME_PATH: '',
	ThemePath: '',
	EnableHTML: false,
	MathTypesettings: 'mathjax',
	HTMLExportMode: 'bare',
	EXPORT_PATH: '',
	EnableSyncPreview: true,
	EnableMarkdownItPlugins: false,
	// 'local' renders mermaid diagrams offline with the mermaid runtime bundled in
	// the plugin; 'kroki' keeps the upstream behaviour of delegating every diagram
	// to a Kroki server (default https://kroki.io, configurable below).
	MermaidRenderMode: 'local',
	KrokiServerUrl: 'https://kroki.io',
	MermaidWidth: '',
	MermaidHeight: '',
	// Font mermaid uses to BOTH measure and draw diagram labels. Kept to fonts
	// installed system-wide (no web font) so the measurement done while
	// pre-rendering matches the metrics the export browser later paints with —
	// a mismatch is what makes CJK labels overflow / clip their node boxes.
	MermaidFontFamily: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif',
	// Deck-level defaults; each can be overridden per note via the `marp-slides`
	// frontmatter block (see utilities/deckConfig.ts).
	SlideRatio: '16:9',
	CodeTheme: 'auto',
	MermaidTheme: 'default'
}
