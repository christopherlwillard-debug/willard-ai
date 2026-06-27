import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { conversations, messages, indexedFilesTable, archivesTable, appSettingsTable } from "@workspace/db";
import { eq, desc, count, sql, ilike, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Query the local index for files matching a keyword, return summary. */
async function searchLocalFiles(keyword: string): Promise<string> {
  try {
    const files = await db.select({
      filename: indexedFilesTable.filename,
      fileType: indexedFilesTable.fileType,
      sizeBytes: indexedFilesTable.sizeBytes,
      folder: indexedFilesTable.folder,
      modifiedAt: indexedFilesTable.modifiedAt,
    })
      .from(indexedFilesTable)
      .where(ilike(indexedFilesTable.filename, `%${keyword}%`))
      .orderBy(desc(indexedFilesTable.sizeBytes))
      .limit(10);

    if (files.length === 0) return `No local files found matching "${keyword}".`;

    const lines = files.map(f =>
      `  • ${f.filename} (${f.fileType}, ${Math.round((f.sizeBytes ?? 0) / 1024)}KB) in ${f.folder ?? "/"}`
    );
    return `Found ${files.length} local files matching "${keyword}":\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/** Query Immich for assets matching a keyword. */
async function searchImmich(keyword: string, settings: any): Promise<string> {
  const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "");
  const apiKey = settings?.immichApiKey;
  if (!baseUrl || !apiKey) return "";
  try {
    const r = await fetch(`${baseUrl}/api/search/metadata`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: keyword, size: 5 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return "";
    const data = await r.json() as any;
    const assets: any[] = data?.assets?.items ?? [];
    if (assets.length === 0) return `No Immich media found matching "${keyword}".`;
    const lines = assets.map((a: any) => `  • ${a.originalFileName ?? a.id} (${a.type?.toLowerCase() ?? "asset"})`);
    return `Found ${assets.length} Immich assets matching "${keyword}":\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/** Query storage breakdown for context. */
async function getStorageContext(): Promise<string> {
  const breakdown = await db.select({
    fileType: indexedFilesTable.fileType,
    fileCount: count(),
    totalBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)`,
  }).from(indexedFilesTable).groupBy(indexedFilesTable.fileType).orderBy(desc(sql`SUM(${indexedFilesTable.sizeBytes})`));

  if (breakdown.length === 0) return "";
  return "Storage by type:\n" + breakdown.map(r =>
    `  ${r.fileType}: ${r.fileCount} files, ${(Number(r.totalBytes) / (1024 ** 3)).toFixed(2)} GB`
  ).join("\n");
}

/** Query top large files. */
async function getLargeFilesContext(): Promise<string> {
  const large = await db.select({
    filename: indexedFilesTable.filename,
    sizeBytes: indexedFilesTable.sizeBytes,
    folder: indexedFilesTable.folder,
  }).from(indexedFilesTable).orderBy(desc(indexedFilesTable.sizeBytes)).limit(5);

  if (large.length === 0) return "";
  return "Top 5 largest files:\n" + large.map(f =>
    `  • ${f.filename}: ${(Number(f.sizeBytes) / (1024 ** 3)).toFixed(2)} GB in ${f.folder ?? "/"}`
  ).join("\n");
}

/** Query archives context. */
async function getArchivesContext(): Promise<string> {
  const [{ archiveCount }] = await db.select({ archiveCount: count() }).from(archivesTable);
  const categories = await db.execute(sql`
    SELECT category, COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as total_bytes
    FROM ${archivesTable} GROUP BY category ORDER BY total_bytes DESC
  `);
  if (archiveCount === 0) return "No archives indexed.";
  const catLines = (categories.rows as any[]).map(r =>
    `  ${r.category}: ${r.cnt} archives`
  ).join("\n");
  return `${archiveCount} archives by category:\n${catLines}`;
}

/**
 * Detect query intent from the user message and return relevant NAS context.
 * This runs structured queries against local index and Immich before
 * passing results to the language model.
 */
async function buildQueryContext(userMessage: string, settings: any): Promise<string> {
  const msg = userMessage.toLowerCase();
  const parts: string[] = [];

  // File search intent
  const searchMatch = msg.match(/(?:find|search|look for|where is|show me|list)\s+(?:files?\s+(?:named?|called?|with)?\s+)?["']?([a-z0-9\s._-]{2,30})["']?/i);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    if (keyword.length >= 2) {
      const [localResult, immichResult] = await Promise.all([
        searchLocalFiles(keyword),
        searchImmich(keyword, settings),
      ]);
      if (localResult) parts.push(localResult);
      if (immichResult) parts.push(immichResult);
    }
  }

  // Storage / breakdown intent
  if (msg.includes("storage") || msg.includes("breakdown") || msg.includes("how much") || msg.includes("space")) {
    const [storageCtx, largeCtx] = await Promise.all([getStorageContext(), getLargeFilesContext()]);
    if (storageCtx) parts.push(storageCtx);
    if (largeCtx) parts.push(largeCtx);
  }

  // Archive / ZIP intent
  if (msg.includes("archive") || msg.includes("zip") || msg.includes("rar") || msg.includes("compressed")) {
    const archCtx = await getArchivesContext();
    if (archCtx) parts.push(archCtx);
  }

  // Duplicate / cleanup intent
  if (msg.includes("duplicate") || msg.includes("cleanup") || msg.includes("wast") || msg.includes("redundant")) {
    const dupResult = await db.execute(sql`
      SELECT COUNT(*) as groups FROM (
        SELECT content_hash FROM ${indexedFilesTable} WHERE content_hash IS NOT NULL
        GROUP BY content_hash HAVING COUNT(*) > 1
      ) t
    `);
    const groups = (dupResult.rows[0] as any)?.groups ?? 0;
    if (Number(groups) > 0) {
      parts.push(`Duplicate file groups found: ${groups} (run hash scan for full analysis)`);
    } else {
      parts.push("No duplicate files detected yet (content hash scan not yet complete).");
    }
  }

  return parts.length > 0 ? "\n\n--- Live NAS Data ---\n" + parts.join("\n\n") : "";
}

async function buildSystemPrompt(settings: any): Promise<string> {
  const [{ totalFiles }] = await db.select({ totalFiles: count() }).from(indexedFilesTable);
  const [{ archiveCount }] = await db.select({ archiveCount: count() }).from(archivesTable);
  const [{ totalSizeBytes }] = await db.select({ totalSizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable);
  const typeBreakdown = await db.select({
    fileType: indexedFilesTable.fileType,
    fileCount: count(),
  }).from(indexedFilesTable).groupBy(indexedFilesTable.fileType);

  const sizeGB = (Number(totalSizeBytes) / (1024 ** 3)).toFixed(2);
  const breakdown = typeBreakdown.map(r => `${r.fileType}: ${r.fileCount}`).join(", ");
  const immichConfigured = !!(settings?.immichBaseUrl && settings?.immichApiKey);

  return `You are Willard AI, an intelligent assistant for a WD My Cloud NAS home media server.

Current NAS statistics:
- Total indexed files: ${totalFiles}
- Total data: ${sizeGB} GB
- Archive files: ${archiveCount}
- File type breakdown: ${breakdown || "No files indexed yet"}
- NAS path: ${settings?.nasPath || "Not configured"}
- Immich integration: ${immichConfigured ? "Connected" : "Not configured"}

You help users understand their NAS contents, find files, analyze storage, identify cleanup opportunities, and manage their media collection. You are concise, precise, and helpful. When discussing files or storage, use human-readable sizes (KB, MB, GB).

When the user asks to find a specific file or media item, live query results will be appended to their message — reference those results in your answer. If no files are indexed yet, guide the user to configure the NAS path in Settings and run a scan first.`;
}

router.get("/openai/conversations", async (_req, res) => {
  try {
    const convList = await db.select().from(conversations).orderBy(desc(conversations.createdAt));
    res.json(convList);
  } catch {
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.post("/openai/conversations", async (req, res) => {
  try {
    const { title } = CreateOpenaiConversationBody.parse(req.body);
    const [conv] = await db.insert(conversations).values({ title }).returning();
    res.status(201).json(conv);
  } catch {
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/openai/conversations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
    res.json({ ...conv, messages: msgs });
  } catch {
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

router.delete("/openai/conversations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

router.get("/openai/conversations/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
    res.json(msgs);
  } catch {
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/openai/conversations/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

    const { content } = SendOpenaiMessageBody.parse(req.body);

    // Run structured query against NAS data before calling the LLM
    const settingsRows = await db.select().from(appSettingsTable).limit(1);
    const settings = settingsRows[0];
    const queryContext = await buildQueryContext(content, settings);

    // Store user message (original, without the injected context)
    await db.insert(messages).values({ conversationId: id, role: "user", content });

    const history = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

    const systemPrompt = await buildSystemPrompt(settings);

    // Inject live query results into the last user message for LLM context
    const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(0, -1).map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: content + queryContext },
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";
    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const chunkContent = chunk.choices[0]?.delta?.content;
      if (chunkContent) {
        fullResponse += chunkContent;
        res.write(`data: ${JSON.stringify({ content: chunkContent })}\n\n`);
      }
    }

    await db.insert(messages).values({ conversationId: id, role: "assistant", content: fullResponse });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send message" });
    } else {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  }
});

// Suppress unused import (used implicitly via schema)
void and;

export default router;
