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
