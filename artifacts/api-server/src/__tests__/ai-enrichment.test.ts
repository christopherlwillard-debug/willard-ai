import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { extractDocumentText } from "../lib/document-text.ts";

function fixture(name: string, entries: Record<string, string>): string {
  const filePath = path.join(os.tmpdir(), `willard-${name}-${process.pid}.${name}`);
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(entries)) zip.addFile(entry, Buffer.from(content));
  zip.writeZip(filePath);
  return filePath;
}

test("extracts text from DOCX document and header parts", async () => {
  const filePath = fixture("docx", {
    "word/document.xml": "<w:document><w:t>Contract mentions deposit</w:t></w:document>",
    "word/header1.xml": "<w:hdr><w:t>Northwind Agreement</w:t></w:hdr>",
  });
  try {
    assert.equal(await extractDocumentText(filePath), "Contract mentions deposit\nNorthwind Agreement");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("extracts shared and inline cell text from XLSX worksheets", async () => {
  const filePath = fixture("xlsx", {
    "xl/sharedStrings.xml": "<sst><si><t>Insurance</t></si><si><t>Policy renewal</t></si></sst>",
    "xl/worksheets/sheet1.xml": [
      "<worksheet><sheetData>",
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>2026</t></is></c></row>',
      '<row><c r="A2" t="s"><v>1</v></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  });
  try {
    assert.equal(await extractDocumentText(filePath), "Insurance 2026 Policy renewal");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("extracts text from PPTX slides", async () => {
  const filePath = fixture("pptx", {
    "ppt/slides/slide1.xml": "<p:sld><a:t>Whiteboard notes</a:t></p:sld>",
    "ppt/slides/slide2.xml": "<p:sld><a:t>Follow up Friday</a:t></p:sld>",
  });
  try {
    assert.equal(await extractDocumentText(filePath), "Whiteboard notes\nFollow up Friday");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});