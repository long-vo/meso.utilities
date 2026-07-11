import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ProtoSlide } from '../types';

// pdf.js runs its parser in a Web Worker; point it at the bundled worker asset.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Render pages at roughly this width (CSS px) for crisp text on the 1280px stage.
const TARGET_WIDTH = 1600;
const MAX_SCALE = 2;

/** Render every page of a PDF file into an image slide (one slide per page). */
export async function slidesFromPdf(file: File): Promise<ProtoSlide[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const slides: ProtoSlide[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_SCALE, TARGET_WIDTH / unscaled.width);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get a 2D canvas context to render the PDF.');

      // PDFs may be transparent; paint white so pages match the slide surface.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      slides.push({
        title: `${file.name} — page ${n}`,
        filename: file.name,
        kind: 'image',
        html: '',
        src: canvas.toDataURL('image/png'),
        fragmentCount: 1,
      });

      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return slides;
}
