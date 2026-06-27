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
import { MessageSquare, Plus, Send, Terminal, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

type UIMessage = {
  id: string | number;
  role: string;
  content: string;
};

export default function Chat() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [streamedContent, setStreamedContent] = useState("");
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

  // Auto-scroll to bottom
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

    // Optimistically add user message to cache
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
              if (data.done) {
                // finished
              } else if (data.content) {
                fullText += data.content;
                setStreamedContent(fullText);
              }
            } catch(e) {
              // ignore parse errors for partial chunks
            }
          }
        }
      }
      
      // refetch to get the actual persisted messages with real IDs
      queryClient.invalidateQueries({ queryKey });

    } catch (err) {
      console.error("Stream error:", err);
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
    }
  };

  // set initial active chat if none
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
          <Button onClick={handleNew} disabled={createMutation.isPending} className="w-full font-mono bg-primary/20 text-primary hover:bg-primary/30 border border-primary/50">
            <Plus className="w-4 h-4 mr-2" /> NEW_SESSION
          </Button>
        </div>
        <ScrollArea className="flex-1">
          {convosLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {convos?.map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-3 py-2 rounded text-sm font-mono truncate transition-colors ${activeId === c.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-background/50">
        {!activeId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono">
            <Terminal className="w-6 h-6 mr-2 opacity-50" /> SELECT OR CREATE A SESSION
          </div>
        ) : (
          <>
            <div className="p-4 border-b bg-card/50 flex items-center">
              <Terminal className="w-5 h-5 mr-2 text-primary" />
              <h2 className="font-mono font-bold tracking-tight">TERMINAL_LINK_ESTABLISHED</h2>
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
                    <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                      <span className="text-[10px] font-mono text-muted-foreground mb-1 ml-1 uppercase">{m.role}</span>
                      <div className={`px-4 py-3 rounded-lg max-w-[80%] font-mono text-sm ${m.role === 'user' ? 'bg-primary text-primary-foreground rounded-tr-none' : 'bg-secondary text-secondary-foreground border border-border rounded-tl-none'}`}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {isStreaming && streamedContent && (
                    <div className="flex flex-col items-start">
                      <span className="text-[10px] font-mono text-muted-foreground mb-1 ml-1 uppercase">assistant (streaming)</span>
                      <div className="px-4 py-3 rounded-lg max-w-[80%] font-mono text-sm bg-secondary text-secondary-foreground border border-primary/50 rounded-tl-none">
                        {streamedContent}<span className="inline-block w-2 h-4 bg-primary ml-1 animate-pulse align-middle"></span>
                      </div>
                    </div>
                  )}
                  {isStreaming && !streamedContent && (
                    <div className="flex items-center text-muted-foreground font-mono text-xs">
                      <Loader2 className="w-3 h-3 mr-2 animate-spin text-primary" /> PROCESSING_QUERY...
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 bg-card border-t">
              <form 
                onSubmit={e => { e.preventDefault(); handleSend(); }}
                className="flex items-center space-x-2"
              >
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary font-mono font-bold text-lg">{'>'}</span>
                  <Input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder="Query NAS contents, request cleanup advice..."
                    className="flex-1 bg-background border-primary/20 focus-visible:ring-primary pl-8 font-mono h-12"
                    disabled={isStreaming}
                  />
                </div>
                <Button type="submit" disabled={isStreaming || !input.trim()} size="icon" className="h-12 w-12 shrink-0">
                  <Send className="w-5 h-5" />
                </Button>
              </form>
            </div>
          </>
        )}
      </div>

    </div>
  );
}