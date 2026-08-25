import * as fs from "fs";

const MAX_DOC_TEXT = 6_000;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlText(xml: string): string {
  return decodeXml(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, MAX_DOC_TEXT);
}

async function readOfficeXmlParts(fullPath: string, partPattern: RegExp): Promise<string | null> {
  try {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(fullPath);
    const parts = zip.getEntries()
      .filter((entry: any) => !entry.isDirectory && partPattern.test(entry.entryName))
      .sort((a: any, b: any) => a.entryName.localeCompare(b.entryName));
    const text = parts.map((entry: any) => xmlText(entry.getData().toString("utf8"))).filter(Boolean).join("\n");
    return text ? text.slice(0, MAX_DOC_TEXT) : null;
  } catch {
    return null;
  }
}

async function extractDocxText(fullPath: string): Promise<string | null> {
  return readOfficeXmlParts(fullPath, /(^|\/)(word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml)$/i);
}

async function extractPptxText(fullPath: string): Promise<string | null> {
  return readOfficeXmlParts(fullPath, /(^|\/)ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i);
}

async function extractXlsxText(fullPath: string): Promise<string | null> {
  try {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(fullPath);
    const sharedEntry = zip.getEntry("xl/sharedStrings.xml");
    const sharedStrings = sharedEntry
      ? [...sharedEntry.getData().toString("utf8").matchAll(/<si\b[\s\S]*?<\/si>/gi)].map((match) => xmlText(match[0]))
      : [];
    const sheets = zip.getEntries()
      .filter((entry: any) => !entry.isDirectory && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName))
      .sort((a: any, b: any) => a.entryName.localeCompare(b.entryName));
    const values: string[] = [];
    for (const sheet of sheets) {
      const xml = sheet.getData().toString("utf8");
      for (const cell of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/gi)) {
        const body = cell[0];
        const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ??
          body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/i)?.[1];
        if (raw == null) continue;
        const value = /<c\b[^>]*\bt="s"/i.test(body)
          ? sharedStrings[Number(decodeXml(raw).trim())]
          : decodeXml(raw);
        if (value) values.push(value);
      }
    }
    return values.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_DOC_TEXT) || null;
  } catch {
    return null;
  }
}

function readLegacyOfficeText(fullPath: string): string | null {
  try {
    const raw = fs.readFileSync(fullPath).toString("latin1");
    const text = [...raw.matchAll(/[ -~]{4,}/g)].map((match) => match[0]).join(" ");
    return text.replace(/\s+/g, " ").trim().slice(0, MAX_DOC_TEXT) || null;
  } catch {
    return null;
  }
}

function readPlainText(fullPath: string): string | null {
  try {
    if (!/\.(txt|md|csv|log|json)$/i.test(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf8").slice(0, MAX_DOC_TEXT);
  } catch {
    return null;
  }
}

export async function extractDocumentText(fullPath: string): Promise<string | null> {
  const ext = fullPath.toLowerCase();
  if (ext.endsWith(".pdf")) {
    // PDF extraction stays in ai-enrichment because it uses the existing
    // pdfjs setup; callers should use extractPdfText for PDFs.
    return null;
  }
  if (ext.endsWith(".docx")) return extractDocxText(fullPath);
  if (ext.endsWith(".xlsx")) return extractXlsxText(fullPath);
  if (ext.endsWith(".pptx")) return extractPptxText(fullPath);
  if (/\.(doc|xls|ppt)$/.test(ext)) return readLegacyOfficeText(fullPath);
  return readPlainText(fullPath);
}