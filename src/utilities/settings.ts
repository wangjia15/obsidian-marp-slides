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
	MermaidHeight: ''
}
