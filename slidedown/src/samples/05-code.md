## Syntax-highlighted code

```typescript
interface Slide {
  id: string;
  title: string;
  html: string;
}

function nextSlide(index: number, total: number): number {
  return Math.min(index + 1, total - 1);
}
```

Fenced code blocks are highlighted automatically with highlight.js.

---

## Step through code

```typescript {1-4|6-8|8}
interface Slide {
  id: string;
  title: string;
}

function nextSlide(index: number, total: number): number {
  return Math.min(index + 1, total - 1);
}
```

Add line ranges to the fence — ` ```ts {1-4|6-8|8} ` — and **→** walks the
highlight groups like fragments. A single group (` {2,5} `) is a static
highlight.
