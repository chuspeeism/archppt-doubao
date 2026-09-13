// minimal-pdf.mjs [INLINE]
// 单页 PDF 1.4 写入器：Catalog / Pages / Page / XObject(Image, DCTDecode) / Contents，
// 全页铺满一张 baseline JPEG，xref 偏移逐字节精确。零依赖，浏览器 / Node 通用。

const pdfEncoder = new TextEncoder();

const pdfAscii = (text) => pdfEncoder.encode(text);

const pdfConcat = (chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
};

const pdfNum = (value) => {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};

const pdfPad10 = (value) => String(value).padStart(10, '0');

// 扫描 JPEG 标记段，取 SOF 里的分量数（1=灰度 3=YCbCr/RGB 4=CMYK）与像素尺寸。
const pdfJpegInfo = (jpeg) => {
  if (!(jpeg instanceof Uint8Array) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('buildJpegPdf: jpeg 必须是以 SOI(FFD8) 开头的 baseline JPEG 字节');
  }
  let i = 2;
  while (i + 3 < jpeg.length) {
    if (jpeg[i] !== 0xff) { i += 1; continue; }
    const marker = jpeg[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    // 无长度的独立标记：TEM / RSTn / SOI / EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const size = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        components: jpeg[i + 9],
        height: (jpeg[i + 5] << 8) | jpeg[i + 6],
        width: (jpeg[i + 7] << 8) | jpeg[i + 8],
      };
    }
    if (marker === 0xda) break; // SOS 之后是熵编码数据，不再扫描
    i += 2 + size;
  }
  return { components: 3, height: 0, width: 0 };
};

export function buildJpegPdf(options) {
  const { pageW, pageH, jpeg } = options ?? {};
  if (!(Number(pageW) > 0) || !(Number(pageH) > 0)) {
    throw new Error('buildJpegPdf: pageW / pageH 必须为正数（单位 pt）');
  }
  const info = pdfJpegInfo(jpeg);
  const imgW = Math.max(1, Math.round(Number(options?.imgW) > 0 ? Number(options.imgW) : info.width));
  const imgH = Math.max(1, Math.round(Number(options?.imgH) > 0 ? Number(options.imgH) : info.height));
  const colorSpace = info.components === 1
    ? '/DeviceGray'
    : (info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB');

  // 内容流：把单位正方形图片空间缩放到整页并绘制
  const contentText = `q\n${pdfNum(pageW)} 0 0 ${pdfNum(pageH)} 0 0 cm\n/Im1 Do\nQ\n`;
  const contentBytes = pdfAscii(contentText);

  const header = pdfConcat([
    pdfAscii('%PDF-1.4\n%'),
    new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), // 二进制注释行，标记文件含 8-bit 数据
    pdfAscii('\n'),
  ]);

  const objects = [
    pdfAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    pdfAscii('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    pdfAscii(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(pageW)} ${pdfNum(pageH)}] `
      + '/Resources << /XObject << /Im1 4 0 R >> /ProcSet [/PDF /ImageC] >> '
      + '/Contents 5 0 R >>\nendobj\n'),
    pdfConcat([
      pdfAscii(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} `
        + `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode `
        + `/Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      pdfAscii('\nendstream\nendobj\n'),
    ]),
    pdfConcat([
      pdfAscii(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      pdfAscii('endstream\nendobj\n'),
    ]),
  ];

  const offsets = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xrefOffset = cursor;

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const objOffset of offsets) xref += `${pdfPad10(objOffset)} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return pdfConcat([header, ...objects, pdfAscii(xref), pdfAscii(trailer)]);
}
