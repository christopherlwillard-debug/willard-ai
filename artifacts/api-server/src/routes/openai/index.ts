import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { conversations, messages, indexedFilesTable, archivesTable, appSettingsTable } from "@workspace/db";
import { eq, desc, count, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function buildSystemPrompt(): Promise<string> {
  const [{ totalFiles }] = await db.select({ totalFiles: count() }).from(indexedFilesTable);
  const [{ archiveCount }] = await db.select({ archiveCount: count() }).from(archivesTable);
  const [{ totalSizeBytes }] = await db.select({ totalSizeBytes: sql<number>`COALESCE(SUM(${indexedFilesTable.sizeBytes}), 0)` }).from(indexedFilesTable);
  const settings = await db.select().from(appSettingsTable).limit(1);
  const typeBreakdown = await db.select({
    fileType: indexedFilesTable.fileType,
    count: count(),
  }).from(indexedFilesTable).groupBy(indexedFilesTable.fileType);

  const sizeGB = (Number(totalSizeBytes) / (1024 ** 3)).toFixed(2);
  const breakdown = typeBreakdown.map(r => `${r.fileType}: ${r.count}`).join(", ");

  return `You are Willard AI, an intelligent assistant for a WD My Cloud NAS home media server.

Current NAS statistics:
- Total indexed files: ${totalFiles}
- Total data: ${sizeGB} GB
- Archive files: ${archiveCount}
- File type breakdown: ${breakdown || "No files indexed yet"}
- NAS path: ${settings[0]?.nasPath || "Not configured"}

You help users understand their NAS contents, find files, analyze storage, identify cleanup opportunities, and manage their media collection. You are concise, precise, and helpful. When discussing files or storage, use human-readable sizes (KB, MB, GB). If no files are indexed yet, guide the user to configure the NAS path and run a scan first.`;
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

    await db.insert(messages).values({ conversationId: id, role: "user", content });

    const history = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

    const systemPrompt = await buildSystemPrompt();

    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      ...history.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
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

export default router;
