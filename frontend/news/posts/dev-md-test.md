# Heading 1 — Markdown Test

> **DEV ONLY** — This post is injected at runtime on localhost and does not exist in `manifest.json`. It will never appear in production.

---

## Headings

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

---

## Text Formatting

Regular paragraph text. The quick brown fox jumps over the lazy dog.

**Bold text** and *italic text* and ***bold italic text***.

~~Strikethrough text~~

`Inline code` looks like this.

Here is a [hyperlink](https://example.com) in a sentence.

---

## Blockquotes

> Single-level blockquote. Used for callouts, warnings, or highlighted notes.

> Nested blockquote level one.
>
> > Nested blockquote level two.

---

## Lists

**Unordered:**

- Item one
- Item two
  - Nested item A
  - Nested item B
    - Double nested
- Item three

**Ordered:**

1. First item
2. Second item
   1. Nested ordered item
   2. Another nested item
3. Third item

---

## Code Blocks

Inline: `const x = EFTForge.state.lang;`

Fenced block (JavaScript):

```javascript
async function showPost(postId) {
    const res = await fetch('./news/posts/' + postId + '.md');
    const markdown = await res.text();
    return marked.parse(markdown);
}
```

Fenced block (no language):

```
Plain text block.
No syntax highlighting.
Useful for logs or config snippets.
```

---

## Tables

| Column A | Column B | Column C |
|----------|----------|----------|
| Row 1 A  | Row 1 B  | Row 1 C  |
| Row 2 A  | Row 2 B  | Row 2 C  |
| Row 3 A  | Row 3 B  | Row 3 C  |

---

## Horizontal Rules

Above this line.

---

Below this line.

***

Also a rule.

---

## Images

Image from `./news/images/` (will show broken icon if file doesn't exist — expected in dev):

![Test image alt text](./news/images/test.png)

Image with a title attribute:

![Alt text](./news/images/test.png "Optional title shown on hover")

---

## GIF

GIFs use the same syntax as images:

![Animated GIF test](./news/images/test.gif)

---

## HTML5 Video

Drop an `.mp4` into `./news/images/` and reference it like this:

<video controls preload="metadata" style="max-width:100%; border-radius:6px; margin:12px 0;">
  <source src="./news/images/test.mp4" type="video/mp4">
  Your browser does not support HTML5 video.
</video>

---

## Raw HTML

HTML passes through marked.js as-is. Useful for custom layouts:

<div style="background:#1a1a1a; border-left:3px solid #f5c542; padding:12px 16px; border-radius:0 6px 6px 0; margin:12px 0;">
  This is a <strong>custom HTML block</strong> rendered inside the markdown content area.
</div>

---

## Long Paragraph (Readability Check)

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

---

*End of markdown test.*
