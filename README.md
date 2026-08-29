# Marp Slides for Obsidian

[![Version](https://img.shields.io/github/manifest-json/v/samuele-cozzi/obsidian-marp-slides?color=blue)](https://github.com/samuele-cozzi/obsidian-marp-slides/releases/latest)![Downloads](https://img.shields.io/github/downloads/samuele-cozzi/obsidian-marp-slides/total)[![CodeFactor](https://www.codefactor.io/repository/github/samuele-cozzi/obsidian-marp-slides/badge)](https://www.codefactor.io/repository/github/samuele-cozzi/obsidian-marp-slides)[![Maintainability](https://api.codeclimate.com/v1/badges/78932986b29ffe273e56/maintainability)](https://codeclimate.com/github/samuele-cozzi/obsidian-marp-slides/maintainability)[![Test Coverage](https://api.codeclimate.com/v1/badges/78932986b29ffe273e56/test_coverage)](https://codeclimate.com/github/samuele-cozzi/obsidian-marp-slides/test_coverage)[![LICENSE](https://img.shields.io/github/license/samuele-cozzi/obsidian-marp-slides)](https://github.com/samuele-cozzi/obsidian-marp-slides/blob/main/LICENSE)
<!-- ![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22better-word-count%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=for-the-badge) -->

Marp Slides is very simple & powerful slide deck extension for [Obsidian](href="https://obsidian.md") based on [Marp](https://marp.app/). View the **[DOCS](https://samuele-cozzi.github.io/obsidian-marp-slides/)** for [getting started](https://samuele-cozzi.github.io/obsidian-marp-slides/10.GettingStarted.html)

![Alt text](docs/pictures/CreateSlides.gif)

See the documentation of [Marpit Markdown](https://marpit.marp.app/markdown) and [the features of Marp Core](https://github.com/marp-team/marp-core#features) about how to write.
Marp have powerful tools for Markdown Slides: [Marpit Framework](https://marpit.marp.app/), [CLI tool](https://github.com/marp-team/marp-cli), [Web interface](https://web.marp.app/) and so on.

## Getting Started

- [Read Documentation](https://samuele-cozzi.github.io/obsidian-marp-slides/)
- [View the demo Presentation](https://samuele-cozzi.github.io/obsidian-marp-slides/pictures/Sample%20Pro%201.html)

## Features

- [Preview Slides](https://samuele-cozzi.github.io/obsidian-marp-slides/21.SlidesPreview.html)
- [Export slide deck (html, pdf, pptx, img)](https://samuele-cozzi.github.io/obsidian-marp-slides/22.SlidesExport.html) using Marp cli API
- [Use custom theme CSS](https://samuele-cozzi.github.io/obsidian-marp-slides/23.SlidesCustomTheme.html)
- [Presenting](https://samuele-cozzi.github.io/obsidian-marp-slides/24.Presenting.html)
- Slide ratio (16:9 / 4:3), code highlight theme and mermaid theme — configurable
  globally in settings and per deck in frontmatter

## Deck tuning: ratio, code theme, mermaid theme

Set global defaults in the plugin settings (*Slide ratio*, *Code highlight theme*,
*Mermaid theme*), then override per deck in the note's frontmatter:

```yaml
---
marp-slides:
  ratio: 4:3          # or 16:9 (a native `size: 4:3` directive works too)
  code-theme: one-dark  # auto | github | github-dark | one-dark | monokai | dracula
  mermaid-theme: dark   # default | neutral | dark | forest | base
---
```

- **ratio** — applied as Marp's `size` directive for the preview and every export
  (PDF page size, PPTX slide size, PNG snapshots). Custom theme CSS without
  `@size` metadata is patched automatically so the directive is honoured.
- **code-theme** — `auto` keeps the slide theme's own code colors; the rest pin a
  highlight.js palette for code blocks in preview and all exports.
- **mermaid-theme** — used by the bundled offline mermaid renderer (local mode) and
  injected as an `%%{init}%%` directive for Kroki rendering.

![Alt text](docs/pictures/ThemeSlides.gif)

## Bundled themes (Chinese-friendly)

Two additional themes ship in [`vault/themes/`](vault/themes/). Copy the ones you want into
your vault's theme folder (set in the plugin's *Theme path* setting) and reference them by
name in the slide frontmatter:

- **`orderflow`** — business-blue course deck: gradient paper, blue accent titles,
  card / KPI / steps / VS layout helpers, `lead` & `divider` section classes, kai (楷体) body text.
- **`notes`** — notebook style: cream paper with ruled lines and a red margin, sticky-note
  quotes, highlighter `strong`, pencil-dashed code blocks, plus `.font-kai / .font-hei /
  .font-song / .font-title` font-utility classes.

Layout helpers (`cards`, `cols`, `steps`, `kpis`, `grid2`, `vs`, `quote`, `lead`, `divider`)
work in both themes — wrap each card as `<div class="card">` inside `<div class="cards">`.

### Chinese fonts

Both themes load CJK web fonts (LXGW WenKai for body text, plus optional Smiley Sans /
HarmonyOS Sans / Source Han families) via `@font-face` from `vault/themes/fonts/`.
The font binaries are **not** committed (≈155 MB) — download links and licensing notes
are in [`vault/themes/fonts/README.md`](vault/themes/fonts/README.md). If the fonts are
installed on your system, `local()` picks them up automatically and no download is needed;
otherwise the themes fall back to system kai/hei/song fonts.

> Note for PPTX export: PowerPoint only *references* font names — the viewer's machine
> must have the font installed for identical rendering.

> ⚠️ Export except HTML requires to install any one of [Google Chrome](https://www.google.com/chrome/), [Chromium](https://www.chromium.org/), or [Microsoft Edge](https://www.microsoft.com/edge). You may also specify the custom path for Chrome / Chromium-based browser by preference `CHEROME_PATH`.

## Not supported

- Wiki Link
- Mobile App Plugin is in Alpha Version

## Many Thanks 👏

- [plugin obsidian development docs](https://marcus.se.net/obsidian-plugin-docs/)
- [marp vs code](https://github.com/marp-team/marp-vscode)
- [obsidian api](https://github.com/obsidianmd/obsidian-api)
