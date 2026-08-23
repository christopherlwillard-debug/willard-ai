/**
 * Regression coverage for user corrections flowing through the media API into
 * AI search. The routers are real; only persistence and the local embedder are
 * replaced so this stays deterministic and does not need a running server.
 *
 * Run with:
 *   node --experimental-test-module-mocks --experimental-strip-types \
 *     src/__tests__/ai-corrections.test.ts
 */
import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const ai = {
  description: "A cat sitting beside a window",
  tags: ["cat", "summer"],
  userTags: [] as string[],
  hiddenTags: [] as string[],
  userDescription: null as string | null,
  notes: null as string | null,
};

const settings = { nasPath: "/test-library" };
const file = {
  id: 98123,
  name: "window.jpg",
  relative_path: "photos/window.jpg",
  media_type: "photo",
  size_bytes: "100",
  thumbnail_path: null,
  date_taken: null,
  favorite: false,
  gps_latitude: null,
  gps_longitude: null,
  place_name: null,
};

function currentSearchRow() {
  return {
    ...file,
    description: ai.description,
    tags: ai.tags,
    objects: [],
    ocr_text: null,
    doc_type: null,
    scene: "indoor",
    people: [],
    user_tags: ai.userTags,
    hidden_tags: ai.hiddenTags,
    user_description: ai.userDescription,
    notes: ai.notes,
    similarity: null,
  };
}

const pool = {
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (sql.includes("SELECT id FROM media_files")) return { rows: [{ id: file.id }] };
    if (sql.includes("SELECT tags, user_tags, hidden_tags")) {
      return { rows: [{
        tags: ai.tags,
        user_tags: ai.userTags,
        hidden_tags: ai.hiddenTags,
      }] };
    }
    if (sql.startsWith("INSERT INTO media_ai")) return { rows: [] };
    if (sql.startsWith("UPDATE media_ai SET")) {
      ai.userTags = JSON.parse(String(params[1]));
      ai.hiddenTags = JSON.parse(String(params[2]));
      const descriptionIndex = sql.includes("user_description") ? (sql.includes("notes") ? 3 : 3) : -1;
      const notesIndex = sql.includes("notes") ? (sql.includes("user_description") ? 4 : 3) : -1;
      if (descriptionIndex > 0) ai.userDescription = params[descriptionIndex] == null ? null : String(params[descriptionIndex]);
      if (notesIndex > 0) ai.notes = params[notesIndex] == null ? null : String(params[notesIndex]);
      return { rows: [] };
    }
    if (sql.includes("SELECT description, tags, user_tags, hidden_tags")) {
      return { rows: [{
        description: ai.description,
        tags: ai.tags,
        user_tags: ai.userTags,
        hidden_tags: ai.hiddenTags,
        user_description: ai.userDescription,
        notes: ai.notes,
      }] };
    }
    if (sql.includes("SELECT f.id, f.name, f.relative_path")) {
      return { rows: [currentSearchRow()] };
    }
    return { rows: [] };
  },
};

const db = {
  select: () => ({
    from: () => ({
      limit: async () => [settings],
    }),
  }),
};

const appSettingsTable = { nasPath: Symbol("nasPath") };
mock.module("@workspace/db", { namedExports: { db, pool, appSettingsTable } });
mock.module("../lib/ai-enrichment.ts", {
  namedExports: {
    AI_VERSION: 3,
    recomputeEmbedding: async () => {},
    embedText: async () => [],
    toVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
    getEnrichmentStatus: () => ({ running: false, analyzed: 1, failed: 0, pending: 0, lastRunAt: null }),
  },
});
mock.module("../lib/logger.ts", {
  namedExports: { logger: { error() {}, warn() {}, info() {} } },
});
mock.module("@workspace/integrations-openai-ai-server", {
  namedExports: {
    openai: {
      chat: {
        completions: {
          create: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
            const prompt = messages.at(-1)?.content ?? "";
            const query = prompt.split("New search:").at(-1)?.trim().toLowerCase() ?? "";
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    semanticQuery: null,
                    keywords: query ? [query] : [],
                    mediaTypes: [],
                    dateFrom: null,
                    dateTo: null,
                    objects: [],
                    exclude: [],
                    favoriteOnly: false,
                    docTypes: [],
                    location: null,
                  }),
                },
              }],
            };
          },
        },
      },
    },
  },
});

const [{ default: mediaDetailRouter }, { default: searchRouter }] = await Promise.all([
  import("../routes/media-detail.ts"),
  import("../routes/search.ts"),
]);

const app = express();
app.use(express.json());
app.use("/api", mediaDetailRouter);
app.use("/api", searchRouter);
const server = app.listen(0);
const baseUrl = await new Promise<string>((resolve) => {
  server.once("listening", () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  });
});

async function patch(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${baseUrl}/api/media/files/${file.id}/ai`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

before(() => {
  ai.userTags = [];
  ai.hiddenTags = [];
  ai.userDescription = null;
  ai.notes = null;
});

after(() => {
  server.close();
});

test("PATCH preserves AI tags, supports un-hiding, restores description, and updates notes", { concurrency: false }, async () => {
  const hidden = await patch({
    removeTags: ["cat"],
    description: "A corrected window scene",
    notes: "private lighthouse note",
  });
  assert.deepEqual(ai.tags, ["cat", "summer"], "hiding must not overwrite original AI tags");
  assert.deepEqual(hidden.tags, [{ tag: "summer", source: "ai" }]);
  assert.deepEqual(hidden.hiddenTags, ["cat"]);
  assert.equal(hidden.description, "A corrected window scene");
  assert.equal(hidden.notes, "private lighthouse note");

  const restoredTag = await patch({ addTags: ["cat"] });
  assert.deepEqual(restoredTag.tags, [
    { tag: "cat", source: "ai" },
    { tag: "summer", source: "ai" },
  ]);
  assert.deepEqual(restoredTag.hiddenTags, []);

  const restoredDescription = await patch({ description: null });
  assert.equal(restoredDescription.description, "A cat sitting beside a window");
  assert.equal(restoredDescription.descriptionEdited, false);
  assert.equal(restoredDescription.notes, "private lighthouse note");
});

test("a fresh note appears in AI search with a note-specific reason immediately after PATCH", { concurrency: false }, async () => {
  const note = "private lighthouse note";
  await patch({ notes: note });

  const response = await fetch(`${baseUrl}/api/search/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: note }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as {
    results: Array<{ id: number; reasons: string[] }>;
  };
  const result = body.results.find((item) => item.id === file.id);
  assert.ok(result, "the corrected file should be searchable without a re-scan");
  assert.ok(result.reasons.includes(`Your note mentions "${note}"`));
});