// pptx-writer.mjs [INLINE]
// 最小可用 PPTX 写入器：单页 16:9（12192000×6858000 EMU），标题写入 docProps 元数据。
// 只依赖同目录 minimal-zip。
//
// 两种 slide 来源，二选一：
//   { slideXml }        —— 原生形状（scene-pptx 出的 DrawingML），打开后每个元素都能改；
//   { png, pngW, pngH } —— 整页位图铺满一张 slide（旧口径，作为兜底保留）。
//
// 也可以给 { slides: [...] } 一次装多页，每一页各写一种来源。多页是为还原度台准备的：
// 台子要在真 PowerPoint 里取十份用例的渲染结果，一份一份地开文件、进放映、截屏、退出，
// 屏幕会被反复占用二十次；装成一份多页 PPTX 之后放映一次、翻页截完就行。

import { buildStoreZip } from './minimal-zip.mjs';

const PPTX_EMU_W = 12192000;
const PPTX_EMU_H = 6858000;

const PPTX_NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PPTX_NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const PPTX_NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PPTX_NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PPTX_REL_OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const PPTX_XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const pptxEncoder = new TextEncoder();

const pptxEscapeXml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const pptxXmlEntry = (name, xml) => ({ name, data: pptxEncoder.encode(xml) });

const pptxRelationship = (id, type, target) =>
  `<Relationship Id="${id}" Type="${PPTX_REL_OFFICE}/${type}" Target="${target}"/>`;

const pptxRelsXml = (relationships) => PPTX_XML_DECL
  + `<Relationships xmlns="${PPTX_NS_REL}">${relationships.join('')}</Relationships>\n`;

const pptxEmptySpTree = () => '<p:spTree>'
  + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
  + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree>';

const pptxContentTypesXml = (withPng, slideCount = 1) => PPTX_XML_DECL
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + (withPng ? '<Default Extension="png" ContentType="image/png"/>' : '')
  + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  + Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
  + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
  + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>\n';

const pptxRootRelsXml = () => PPTX_XML_DECL
  + `<Relationships xmlns="${PPTX_NS_REL}">`
  + pptxRelationship('rId1', 'officeDocument', 'ppt/presentation.xml')
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + pptxRelationship('rId3', 'extended-properties', 'docProps/app.xml')
  + '</Relationships>\n';

// rId 分配：rId1 = 母版，rId2..rId(n+1) = 第 1..n 页，rId(n+2) = 主题。
const pptxPresentationXml = (slideCount = 1) => PPTX_XML_DECL
  + `<p:presentation xmlns:a="${PPTX_NS_A}" xmlns:r="${PPTX_NS_R}" xmlns:p="${PPTX_NS_P}">`
  + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
  + `<p:sldIdLst>${Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>`
  + `<p:sldSz cx="${PPTX_EMU_W}" cy="${PPTX_EMU_H}"/>`
  + '<p:notesSz cx="6858000" cy="9144000"/>'
  + '</p:presentation>\n';

const pptxPresentationRelsXml = (slideCount = 1) => pptxRelsXml([
  pptxRelationship('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
  ...Array.from({ length: slideCount }, (_, i) => pptxRelationship(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`)),
  pptxRelationship(`rId${slideCount + 2}`, 'theme', 'theme/theme1.xml'),
]);

const pptxPictureSlideXml = (title, imageRelId = 'rId1') => PPTX_XML_DECL
  + `<p:sld xmlns:a="${PPTX_NS_A}" xmlns:r="${PPTX_NS_R}" xmlns:p="${PPTX_NS_P}">`
  + '<p:cSld><p:spTree>'
  + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
  + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '<p:pic>'
  + `<p:nvPicPr><p:cNvPr id="2" name="架构图快照" descr="${pptxEscapeXml(title)}"/>`
  + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
  + `<p:blipFill><a:blip r:embed="${imageRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
  + `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PPTX_EMU_W}" cy="${PPTX_EMU_H}"/></a:xfrm>`
  + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
  + '</p:pic>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
  + '</p:sld>\n';

// 媒体文件按页码命名（image1.png / image2.png …），所以 Target 必须带上页码；
// rId 本身是每页各自的命名空间，页数再多也固定 rId1 = 图片、rId2 = 版式。
const pptxSlideRelsXml = (withPng, slideNo = 1) => pptxRelsXml(
  (withPng ? [pptxRelationship('rId1', 'image', `../media/image${slideNo}.png`)] : [])
    .concat([pptxRelationship('rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml')]),
);

const pptxSlideLayoutXml = () => PPTX_XML_DECL
  + `<p:sldLayout xmlns:a="${PPTX_NS_A}" xmlns:r="${PPTX_NS_R}" xmlns:p="${PPTX_NS_P}" type="blank" preserve="1">`
  + `<p:cSld name="Blank">${pptxEmptySpTree()}</p:cSld>`
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
  + '</p:sldLayout>\n';

const pptxSlideLayoutRelsXml = () => pptxRelsXml([
  pptxRelationship('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'),
]);

const pptxSlideMasterXml = (bg) => PPTX_XML_DECL
  + `<p:sldMaster xmlns:a="${PPTX_NS_A}" xmlns:r="${PPTX_NS_R}" xmlns:p="${PPTX_NS_P}">`
  + `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${pptxHex6(bg) || 'FFFFFF'}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
  + pptxEmptySpTree()
  + '</p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
  + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '</p:sldMaster>\n';

const pptxSlideMasterRelsXml = () => pptxRelsXml([
  pptxRelationship('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
  pptxRelationship('rId2', 'theme', '../theme/theme1.xml'),
]);

const pptxThemeXml = () => {
  const phFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const phLine = (w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return PPTX_XML_DECL
    + `<a:theme xmlns:a="${PPTX_NS_A}" name="架构图主题">`
    + '<a:themeElements>'
    + '<a:clrScheme name="架构图">'
    + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    + '<a:dk2><a:srgbClr val="151E2B"/></a:dk2><a:lt2><a:srgbClr val="F3F6FA"/></a:lt2>'
    + '<a:accent1><a:srgbClr val="5AC8FA"/></a:accent1><a:accent2><a:srgbClr val="78DCB4"/></a:accent2>'
    + '<a:accent3><a:srgbClr val="A7B0C0"/></a:accent3><a:accent4><a:srgbClr val="727D90"/></a:accent4>'
    + '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>'
    + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    + '</a:clrScheme>'
    + '<a:fontScheme name="架构图">'
    + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:minorFont>'
    + '</a:fontScheme>'
    + '<a:fmtScheme name="架构图">'
    + `<a:fillStyleLst>${phFill}${phFill}${phFill}</a:fillStyleLst>`
    + `<a:lnStyleLst>${phLine(9525)}${phLine(19050)}${phLine(28575)}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${phFill}${phFill}${phFill}</a:bgFillStyleLst>`
    + '</a:fmtScheme>'
    + '</a:themeElements>'
    + '</a:theme>\n';
};

const pptxCoreXml = (title) => PPTX_XML_DECL
  + '<cp:coreProperties'
  + ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
  + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
  + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + `<dc:title>${pptxEscapeXml(title)}</dc:title>`
  + '<dc:creator>architecture-diagram-ppt</dc:creator>'
  + '<cp:lastModifiedBy>architecture-diagram-ppt</cp:lastModifiedBy>'
  + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>'
  + '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified>'
  + '</cp:coreProperties>\n';

const pptxAppXml = (slideCount, title) => PPTX_XML_DECL
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
  + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
  + '<Application>architecture-diagram-ppt</Application>'
  + '<PresentationFormat>宽屏</PresentationFormat>'
  + `<Slides>${slideCount}</Slides>`
  + '<HeadingPairs><vt:vector size="2" baseType="variant">'
  + '<vt:variant><vt:lpstr>幻灯片标题</vt:lpstr></vt:variant>'
  + `<vt:variant><vt:i4>${slideCount}</vt:i4></vt:variant>`
  + '</vt:vector></HeadingPairs>'
  + `<TitlesOfParts><vt:vector size="${slideCount}" baseType="lpstr">`
  + `${Array.from({ length: slideCount }, () => `<vt:lpstr>${pptxEscapeXml(title)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts>`
  + '</Properties>\n';

// #rrggbb / #rgb → 'RRGGBB'；认不出来返回 null（调用方回落到白）
const pptxHex6 = (css) => {
  const m = String(css == null ? '' : css).trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  const h = m[1];
  return (h.length === 3 ? h.split('').map((c) => c + c).join('') : h).toUpperCase();
};

// 单页写法（{ slideXml } 或 { png, pngW, pngH }）与多页写法（{ slides: [...] }）
// 归一成同一个数组，后面只按数组走。
const pptxNormalizeSlides = (o) => {
  const list = Array.isArray(o.slides) && o.slides.length ? o.slides : [o];
  return list.map((raw, i) => {
    const s = raw || {};
    const xml = typeof s.slideXml === 'string' && s.slideXml ? s.slideXml : null;
    if (xml) return { slideXml: xml };
    const png = s.png;
    if (!(png instanceof Uint8Array) || png.length === 0) {
      throw new Error(`buildPptxEntries: 第 ${i + 1} 页需要 slideXml，或非空 Uint8Array 的 png`);
    }
    if (!(Number(s.pngW) > 0) || !(Number(s.pngH) > 0)) {
      throw new Error(`buildPptxEntries: 第 ${i + 1} 页的 pngW / pngH 必须为正数`);
    }
    return { png };
  });
};

export function buildPptxEntries(options) {
  const o = options || {};
  const title = String(o.title ?? '') || '架构图';
  const slides = pptxNormalizeSlides(o);
  const anyPng = slides.some((s) => s.png);

  const entries = [
    pptxXmlEntry('[Content_Types].xml', pptxContentTypesXml(anyPng, slides.length)),
    pptxXmlEntry('_rels/.rels', pptxRootRelsXml()),
    pptxXmlEntry('ppt/presentation.xml', pptxPresentationXml(slides.length)),
    pptxXmlEntry('ppt/_rels/presentation.xml.rels', pptxPresentationRelsXml(slides.length)),
  ];
  // 每一页的 rels 是各自独立的，所以图片一律叫 rId1、版式一律叫 rId2，
  // 页数再多也不会串号；媒体文件按页码命名。
  slides.forEach((s, i) => {
    const n = i + 1;
    entries.push(pptxXmlEntry(`ppt/slides/slide${n}.xml`, s.slideXml || pptxPictureSlideXml(title)));
    entries.push(pptxXmlEntry(`ppt/slides/_rels/slide${n}.xml.rels`, pptxSlideRelsXml(!!s.png, n)));
    if (s.png) entries.push({ name: `ppt/media/image${n}.png`, data: s.png });
  });
  entries.push(
    pptxXmlEntry('ppt/slideLayouts/slideLayout1.xml', pptxSlideLayoutXml()),
    pptxXmlEntry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', pptxSlideLayoutRelsXml()),
    pptxXmlEntry('ppt/slideMasters/slideMaster1.xml', pptxSlideMasterXml(o.background)),
    pptxXmlEntry('ppt/slideMasters/_rels/slideMaster1.xml.rels', pptxSlideMasterRelsXml()),
    pptxXmlEntry('ppt/theme/theme1.xml', pptxThemeXml()),
    pptxXmlEntry('docProps/core.xml', pptxCoreXml(title)),
    pptxXmlEntry('docProps/app.xml', pptxAppXml(slides.length, title)),
  );
  return entries;
}

export function buildPptx(options) {
  return buildStoreZip(buildPptxEntries(options));
}
