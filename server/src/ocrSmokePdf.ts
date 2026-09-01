const IMAGE_WIDTH = 1_400;
const IMAGE_HEIGHT = 300;
// One-bit, 1,400 × 300 grayscale raster, compressed once for the PDF image
// stream. It contains the visible marker "BOREALIS OCR" rendered as pixels;
// there is deliberately no character data in the PDF object graph.
const COMPRESSED_MONOCHROME_RASTER =
  "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";

/**
 * Build the packaged OCR fixture as a PDF containing only one grayscale image.
 * The page has no font resource, character codes, or PDF text-showing operator;
 * the visible marker is painted into raster pixels by the bounded bitmap font.
 */
export function buildRasterOnlyOcrSmokePdf(): Buffer {
  const pixels = Buffer.from(COMPRESSED_MONOCHROME_RASTER, "base64");
  const pageContent = Buffer.from("q\n680 0 0 146 20 67 cm\n/Im0 Do\nQ\n", "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 280] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
      "ascii"
    ),
    pdfStream(
      `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${pixels.length} >>`,
      pixels
    ),
    pdfStream(`<< /Length ${pageContent.length} >>`, pageContent),
  ];
  return assemblePdf(objects);
}

function pdfStream(dictionary: string, contents: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, "ascii"),
    contents,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

function assemblePdf(objects: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary")];
  const offsets = [0];
  let length = chunks[0]!.length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const suffix = Buffer.from("\nendobj\n", "ascii");
    chunks.push(prefix, objects[index]!, suffix);
    length += prefix.length + objects[index]!.length + suffix.length;
  }
  const xrefOffset = length;
  chunks.push(
    Buffer.from(
      [
        `xref\n0 ${objects.length + 1}\n`,
        "0000000000 65535 f \n",
        ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ].join(""),
      "ascii"
    )
  );
  return Buffer.concat(chunks);
}
