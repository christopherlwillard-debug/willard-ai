import { useState, useEffect, useRef } from "react";
import {
  useListOpenaiConversations, getListOpenaiConversationsQueryKey,
  useCreateOpenaiConversation,
  useListOpenaiMessages, getListOpenaiMessagesQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Send, Terminal, Loader2, File, Image as ImageIcon, Video, FolderOpen } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes } from "@/lib/format";

interface MatchedFile {
  filename: string;
  path: string;
  fileType: string;
  sizeBytes: number;
  folder: string;
  source: "local" | "immich";
}

function fileIcon(fileType: string, source: string) {
  if (source === "immich") return <ImageIcon className="w-3 h-3 text-purple-400 flex-shrink-0" />;
  switch (fileType) {
    case "image": return <ImageIcon className="w-3 h-3 text-blue-400 flex-shrink-0" />;
    case "video": return <Video className="w-3 h-3 text-purple-400 flex-shrink-0" />;
    default: return <File className="w-3 h-3 text-muted-foreground flex-shrink-0" />;
  }
}

function MatchedFilesCard({ files }: { files: MatchedFile[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? files : files.slice(0, 4);
  return (
    <div className="border border-primary/20 rounded-lg bg-primary/5 p-3 w-full">
      <div className="flex items-center gap-2 mb-2">
        <FolderOpen className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-mono text-primary uppercase tracking-wider">
          Matched Files ({files.length})
        </span>
      </div>
      <div className="space-y-1">
        {shown.map((f, i) => (
          <div key={i} className="flex items-start gap-2 text-xs py-1 border-b border-border/30 last:border-0">
            {fileIcon(f.fileType, f.source)}
            <div className="min-w-0 flex-1">
              <span className="font-mono text-foreground/90 truncate block">{f.filename}</span>
              <span className="text-muted-foreground truncate block text-[10px] font-mono">{f.path}</span>
            </div>
            <div className="text-right flex-shrink-0 space-y-0.5">
              <span className={`block text-[10px] font-mono ${f.source === "immich" ? "text-purple-400" : "text-blue-400"}`}>
                {f.source}
              </span>
              {f.sizeBytes > 0 && (
                <span className="block text-[10px] text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {files.length > 4 && (
        <button
          className="mt-2 text-[10px] font-mono text-primary hover:underline w-full text-center"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? "Show less" : `Show ${files.length - 4} more…`}
        </button>
      )}
    </div>
  );
}

export default function Chat() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [streamedContent, setStreamedContent] = useState("");
  const [streamedMatchedFiles, setStreamedMatchedFiles] = useState<MatchedFile[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: convos, isLoading: convosLoading } = useListOpenaiConversations({
    query: { queryKey: getListOpenaiConversationsQueryKey() }
  });

  const { data: messagesData, isLoading: msgsLoading } = useListOpenaiMessages(
    activeId!,
    { query: { queryKey: getListOpenaiMessagesQueryKey(activeId!), enabled: !!activeId } }
  );

  const createMutation = useCreateOpenaiConversation({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        setActiveId(data.id);
      }
    }
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messagesData, streamedContent]);

  const handleNew = () => {
    createMutation.mutate({ data: { title: "New Conversation" } });
  };

  const handleSend = async () => {
    if (!input.trim() || !activeId || isStreaming) return;

    const userMessage = input.trim();
    setInput("");
    setIsStreaming(true);
    setStreamedContent("");
    setStreamedMatchedFiles([]);

    const queryKey = getListOpenaiMessagesQueryKey(activeId);
    queryClient.setQueryData(queryKey, (old: any) => {
      const msgs = Array.isArray(old) ? old : [];
      return [...msgs, { id: `temp-${Date.now()}`, role: "user", content: userMessage, conversationId: activeId }];
    });

    try {
      const res = await fetch(`/api/openai/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userMessage })
      });

      if (!res.ok) throw new Error("Failed to send");
      if (!res.body) throw new Error("No body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.substring(6);
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.matchedFiles) {
                setStreamedMatchedFiles(data.matchedFiles);
              } else if (data.content) {
                fullText += data.content;
                setStreamedContent(fullText);
              }
            } catch { /* ignore partial chunks */ }
          }
        }
      }

      queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      console.error("Stream error:", err);
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
      setStreamedMatchedFiles([]);
    }
  };

  useEffect(() => {
    if (convos && convos.length > 0 && !activeId) {
      setActiveId(convos[0].id);
    }
  }, [convos, activeId]);

  return (
    <div className="flex h-[calc(100vh-6rem)] border rounded-xl overflow-hidden bg-card">
      {/* Sidebar */}
      <div className="w-64 border-r bg-sidebar flex flex-col">
        <div className="p-4 border-b">
          <Button
            onClick={handleNew}
            disabled={createMutation.isPending}
            className="w-full font-mono bg-primary/20 text-primary hover:bg-primary/30 border border-primary/50"
          >
            <Plus className="w-4 h-4 mr-2" /> NEW_SESSION
          </Button>
        </div>
        <ScrollArea className="flex-1">
          {convosLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {convos?.map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-3 py-2 rounded text-sm font-mono truncate transition-colors ${activeId === c.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"}`}
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col bg-background/50">
        {!activeId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono">
            <Terminal className="w-6 h-6 mr-2 opacity-50" /> SELECT OR CREATE A SESSION
          </div>
        ) : (
          <>
            <div className="p-4 border-b bg-card/50 flex items-center gap-3">
              <Terminal className="w-5 h-5 text-primary" />
              <h2 className="font-mono font-bold tracking-tight">WILLARD_AI_ASSISTANT</h2>
              <span className="text-xs text-muted-foreground font-mono ml-auto">Queries NAS data in real-time</span>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6">
              {msgsLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-16 w-3/4 ml-auto" />
                  <Skeleton className="h-24 w-3/4" />
                </div>
              ) : (
                <>
                  {messagesData?.map((m: any) => (
                    <div key={m.id} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
                      <span className="text-[10px] font-mono text-muted-foreground mb-1 ml-1 uppercase">{m.role}</span>
                      <div className={`px-4 py-3 rounded-lg max-w-[80%] font-mono text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-primary text-primary-foreground rounded-tr-none" : "bg-secondary text-secondary-foreground border border-border rounded-tl-none"}`}>
                        {m.content}
                      </div>
                    </div>
                  ))}

                  {isStreaming && (
                    <div className="flex flex-col items-start gap-2 max-w-[80%]">
                      <span className="text-[10px] font-mono text-muted-foreground uppercase">assistant</span>
                      {streamedMatchedFiles.length > 0 && (
                        <MatchedFilesCard files={streamedMatchedFiles} />
                      )}
                      {streamedContent ? (
                        <div className="px-4 py-3 rounded-lg font-mono text-sm bg-secondary text-secondary-foreground border border-primary/50 rounded-tl-none whitespace-pre-wrap w-full">
                          {streamedContent}
                          <span className="inline-block w-2 h-4 bg-primary ml-1 animate-pulse align-middle" />
                        </div>
                      ) : (
                        <div className="flex items-center text-muted-foreground font-mono text-xs">
                          <Loader2 className="w-3 h-3 mr-2 animate-spin text-primary" /> PROCESSING_QUERY…
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 bg-card border-t">
              <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex items-center space-x-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary font-mono font-bold text-lg">{">"}</span>
                  <Input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder="Find files, query storage, request cleanup advice..."
                    className="flex-1 bg-background border-primary/20 focus-visible:ring-primary pl-8 font-mono h-12"
                    disabled={isStreaming}
                  />
                </div>
                <Button type="submit" disabled={isStreaming || !input.trim()} size="icon" className="h-12 w-12 shrink-0">
                  <Send className="w-5 h-5" />
                </Button>
              </form>
              <p className="text-[10px] text-muted-foreground font-mono mt-1.5 ml-1">
                Try: "find backup files" · "show storage breakdown" · "list large archives"
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
