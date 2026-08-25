import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { extractDocumentText } from "../lib/document-text.ts";
import { setVectorAvailable } from "../lib/vector-capability.ts";

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

const enrichmentQueries: Array<{ sql: string; params: unknown[] }> = [];

mock.module("@workspace/db", {
  namedExports: {
    db: {},
    pool: {
      async query(sql: string, params: unknown[] = []) {
        enrichmentQueries.push({ sql, params });
        return { rows: [] };
      },
    },
    appSettingsTable: {},
  },
});
mock.module("../lib/document-text.ts", {
  namedExports: {
    extractDocumentText: async () => "Warranty for a kitchen appliance",
  },
});
mock.module("../lib/nas-storage.ts", {
  namedExports: {
    checkNasReachableAsync: async (nasPath: string) => ({ online: true, path: nasPath }),
    getWillardAIDir: (nasPath: string) => nasPath,
    resolveLibraryPath: (nasPath: string, relativePath: string) => path.join(nasPath, relativePath),
    resolveWithinRoot: (candidate: string) => candidate,
  },
});
mock.module("../lib/logger.ts", {
  namedExports: { logger: { warn() {}, info() {}, error() {} } },
});
mock.module("@workspace/integrations-openai-ai-server", {
  namedExports: {
    openai: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  description: "A warranty for a kitchen appliance",
                  tags: ["warranty", "appliance"],
                  doc_type: "manual",
                }),
              },
            }],
          }),
        },
      },
    },
  },
});
mock.module("@huggingface/transformers", {
  namedExports: {
    pipeline: async () => async () => ({ data: new Float32Array([0.1, 0.2, 0.3]) }),
  },
});

test("saves descriptions, tags, OCR, and document metadata without pgvector", async () => {
  const { enrichOne } = await import("../lib/ai-enrichment.ts");
  const sourcePath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-enrichment-"));
  fs.writeFileSync(path.join(sourcePath, "warranty.txt"), "source");
  enrichmentQueries.length = 0;
  setVectorAvailable(false);

  try {
    await enrichOne({
      id: 42,
      name: "warranty.txt",
      relativePath: "warranty.txt",
      mediaType: "document",
      thumbnailPath: null,
      fullPath: path.join(sourcePath, "warranty.txt"),
      cameraMake: null,
      cameraModel: null,
      dateTaken: null,
      userTags: null,
      userDescription: null,
      notes: null,
    });
    const insert = enrichmentQueries[0];
    assert.ok(insert);
    assert.match(insert.sql, /INSERT INTO media_ai/);
    assert.doesNotMatch(insert.sql, /embedding|::vector/i);
    assert.deepEqual(insert.params.slice(0, 8), [
      42,
      "A warranty for a kitchen appliance",
      JSON.stringify(["warranty", "appliance"]),
      JSON.stringify([]),
      "Warranty for a kitchen appliance",
      "manual",
      "document",
      JSON.stringify([]),
    ]);
    assert.equal(insert.params[8], 3);
  } finally {
    fs.rmSync(sourcePath, { recursive: true, force: true });
    setVectorAvailable(false);
  }
});

test("preserves embedding writes when pgvector is available", async () => {
  const { enrichOne } = await import("../lib/ai-enrichment.ts");
  const sourcePath = fs.mkdtempSync(path.join(os.tmpdir(), "willard-enrichment-"));
  fs.writeFileSync(path.join(sourcePath, "warranty.txt"), "source");
  enrichmentQueries.length = 0;
  setVectorAvailable(true);

  try {
    await enrichOne({
      id: 43,
      name: "warranty.txt",
      relativePath: "warranty.txt",
      mediaType: "document",
      thumbnailPath: null,
      fullPath: path.join(sourcePath, "warranty.txt"),
      cameraMake: null,
      cameraModel: null,
      dateTaken: null,
      userTags: null,
      userDescription: null,
      notes: null,
    });
    const insert = enrichmentQueries[0];
    assert.ok(insert);
    assert.match(insert.sql, /embedding/);
    assert.deepEqual(insert.params.slice(0, 8), [
      43,
      "A warranty for a kitchen appliance",
      JSON.stringify(["warranty", "appliance"]),
      JSON.stringify([]),
      "Warranty for a kitchen appliance",
      "manual",
      "document",
      JSON.stringify([]),
    ]);
    assert.deepEqual(JSON.parse(String(insert.params[8])), [0.1, 0.2, 0.3].map((value) => new Float32Array([value])[0]));
    assert.equal(insert.params[9], 3);
  } finally {
    fs.rmSync(sourcePath, { recursive: true, force: true });
    setVectorAvailable(false);
  }
});