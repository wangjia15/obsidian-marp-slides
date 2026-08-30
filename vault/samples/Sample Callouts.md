---
marp: true
theme: default
---

# Obsidian Callouts

Write callouts exactly as you do in a note — the plugin styles them for the deck.

---

## The common types

> [!note] Note
> A plain remark. **Markdown** works inside: lists, `code`, [links](https://marp.app).

> [!tip] Tip
> - first idea
> - second idea

> [!warning] Watch out
> Something needs attention before you continue.

---

## More types

> [!success] Done
> The build passed.

> [!danger] Danger
> This action cannot be undone.

> [!quote]
> No title given — the type name is used.

---

## Titles, folding, nesting

> [!info] Custom title text
> The text after `[!info]` becomes the heading.

> [!question]- Folded in Obsidian
> The fold marker (`-` / `+`) is ignored on slides; the content always shows.

> [!example] Nested
> > [!note] Inner
> > Callouts can contain callouts.
