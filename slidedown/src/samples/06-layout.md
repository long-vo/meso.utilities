@columns

## Two columns

`@columns` on the first line splits the slide at a `|||` line.

- Left half is regular Markdown
- Bullets, tables, diagrams — all fine

|||

### The other half

```js {2}
const layout = 'two columns';
const divider = '|||';
```

Also available: `@image-left <url>` / `@image-right <url>` for a media half,
and `@background <colour | gradient | image url>`.

---

@background linear-gradient(135deg, #24314e 0%, #101522 100%)

## Slide backgrounds

This slide carries `@background linear-gradient(…)` on its first line.

Colours, gradients and image URLs all work — thumbnails, speaker view and the
PDF export pick them up too.

???
Layout directives sit on their own lines at the very top of a slide chunk.
