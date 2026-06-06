import { PDFDocument } from 'pdf-lib';

// Apply one or more seals to every page of the PDF.
//
// Each seal carries its own placement, expressed as percentages so it stays
// consistent across pages of varying sizes:
//   xPct / yPct  -> position of the seal's CENTER, 0–100 across page width/height.
//                   yPct is measured from the TOP of the page (intuitive for users).
//   sizePct      -> seal width as a percentage of each page's width.
//
// pdfBytes: ArrayBuffer/Uint8Array of the source PDF.
// seals: array of { blob, type, placement }.
export async function stampPdf(pdfBytes, seals) {
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Embed each seal image once, then reuse it on every page.
  const embedded = [];
  for (const seal of seals) {
    const imageBytes = new Uint8Array(await seal.blob.arrayBuffer());
    const isPng = (seal.type || '').includes('png');
    const image = isPng
      ? await pdfDoc.embedPng(imageBytes)
      : await pdfDoc.embedJpg(imageBytes);
    embedded.push({ image, placement: seal.placement });
  }

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();

    for (const { image, placement } of embedded) {
      const sealWidth = (placement.sizePct / 100) * width;
      const scale = sealWidth / image.width;
      const sealHeight = image.height * scale;

      // Convert center-based percentage coords into pdf-lib's bottom-left origin.
      const centerX = (placement.xPct / 100) * width;
      const centerYFromTop = (placement.yPct / 100) * height;
      const x = centerX - sealWidth / 2;
      const y = height - centerYFromTop - sealHeight / 2;

      page.drawImage(image, { x, y, width: sealWidth, height: sealHeight });
    }
  }

  // pdf-lib does not re-compress existing page content, so original quality
  // is retained.
  return pdfDoc.save();
}
