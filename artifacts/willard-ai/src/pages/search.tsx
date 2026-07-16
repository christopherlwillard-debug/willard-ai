import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBytes, formatDate } from "@/lib/format";
import {
  Search as SearchIcon, Sparkles, File, Image as ImageIcon, Video, FileText,
  Archive, X, Star, History, Bookmark, BookmarkPlus, Trash2, CornerDownRight,
  Loader2, ScanSearch, ArrowRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const API = `${import.meta.env.BASE_URL}api`;

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

// ── Types (mirror the API server) ─────────────────────────────────────────────

interface SearchIntent {
  semanticQuery: string | null;
  keywords: string[];
  mediaTypes: string[];
  dateFrom: string | null;
  dateTo: string | null;
  objects: string[];
  exclude: string[];
  favoriteOnly: boolean;
  docTypes: string[];
  location: string | null;
}

interface ResultItem {
  id: number;
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  thumbnailPath: string | null;
  dateTaken: string | null;
  favorite: boolean;
  description: string | null;
  confidence: "very_likely" | "likely" | "possible";
  score: number;
  reasons: string[];
}

interface SearchResponse {
  query: string;
  refined?: boolean;
  intent: SearchIntent;
  results: ResultItem[];
  suggestions: string[];
  enrichmentPending?: number;
}

interface SearchTurn {
  query: string;
  refined: boolean;
  resultCount: number;
}

const STARTERS = [
  "Photos from last summer",
  "Videos with people in them",
  "Receipts and invoices",
  "Sunset or beach photos",
  "Documents mentioning insurance",
  "My favorite photos",
];

const MEDIA_TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "image", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "audio", label: "Audio" },
  { value: "archive", label: "Archives" },
];

const CONFIDENCE_META: Record<ResultItem["confidence"], { label: string; className: string }> = {
  very_likely: { label: "Very likely", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  likely: { label: "Likely", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  possible: { label: "Possible", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

const isVisualMediaType = (type: string) => type === "image" || type === "photo" || type === "video";

function mediaIcon(type: string) {
  switch (type) {
    case "image":
    case "photo": return <ImageIcon className="h-4 w-4 text-blue-400" />;
    case "video": return <Video className="h-4 w-4 text-purple-400" />;
    case "document": return <FileText className="h-4 w-4 text-amber-400" />;
    case "archive": return <Archive className="h-4 w-4 text-orange-400" />;
    default: return <File className="h-4 w-4 text-muted-foreground" />;
  }
}

function intentChips(intent: SearchIntent): string[] {
  const chips: string[] = [];
  for (const t of intent.mediaTypes ?? []) chips.push(t === "image" ? "Photos" : t === "video" ? "Videos" : t.charAt(0).toUpperCase() + t.slice(1) + "s");
  if (intent.dateFrom || intent.dateTo) chips.push([intent.dateFrom, intent.dateTo].filter(Boolean).join(" → "));
  for (const o of intent.objects ?? []) chips.push(`with ${o}`);
  for (const e of intent.exclude ?? []) chips.push(`no ${e}`);
  for (const d of intent.docTypes ?? []) chips.push(d);
  if (intent.location) chips.push(`near ${intent.location}`);
  if (intent.favoriteOnly) chips.push("favorites");
  return chips;
}

// ── Result card ───────────────────────────────────────────────────────────────

function ResultCard({ item, onOpen, onSimilar }: {
  item: ResultItem;
  onOpen: (item: ResultItem) => void;
  onSimilar: (item: ResultItem) => void;
}) {
  const conf = CONFIDENCE_META[item.confidence];
  const [thumbError, setThumbError] = useState(false);
  const showThumb = isVisualMediaType(item.mediaType) && !thumbError;
  return (
    <div
      className="group rounded-lg border bg-card overflow-hidden hover:border-primary/50 transition-colors cursor-pointer"
      onClick={() => onOpen(item)}
      data-testid={`card-result-${item.id}`}
    >
      <div className="relative aspect-video bg-secondary/40 flex items-center justify-center">
        {showThumb ? (
          <img
            src={`${API}/media/thumbnail/${item.id}`}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="scale-[2]">{mediaIcon(item.mediaType)}</div>
        )}
        <Badge variant="outline" className={`absolute top-2 left-2 text-[10px] bg-background/80 backdrop-blur ${conf.className}`}>
          {conf.label}
        </Badge>
        {item.favorite && <Star className="absolute top-2 right-2 h-4 w-4 fill-yellow-400 text-yellow-400" />}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              className="absolute bottom-2 right-2 h-7 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => { e.stopPropagation(); onSimilar(item); }}
              data-testid={`button-similar-${item.id}`}
            >
              <ScanSearch className="h-3.5 w-3.5 mr-1" /> Similar
            </Button>
          </TooltipTrigger>
          <TooltipContent>Find visually / semantically similar files</TooltipContent>
        </Tooltip>
      </div>
      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {mediaIcon(item.mediaType)}
          <p className="text-sm font-medium truncate">{item.name}</p>
        </div>
        {item.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.reasons.slice(0, 3).map((r) => (
              <span key={r} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{r}</span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {formatBytes(item.sizeBytes)}{item.dateTaken ? ` · ${formatDate(item.dateTaken)}` : ""}
        </p>
      </div>
    </div>
  );
}

// ── Detail sheet ──────────────────────────────────────────────────────────────

function DetailSheet({ item, onClose, onSimilar }: {
  item: ResultItem; onClose: () => void; onSimilar: (item: ResultItem) => void;
}) {
  const conf = CONFIDENCE_META[item.confidence];
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm break-all pr-6">{item.name}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4 px-4 pb-6">
          {isVisualMediaType(item.mediaType) && (
            <img src={`${API}/media/thumbnail/${item.id}`} alt={item.name} className="w-full rounded-lg" />
          )}
          <Link href={`/media/${item.id}`}>
            <Button variant="default" size="sm" className="w-full gap-2 text-xs" data-testid="button-open-detail">
              <Sparkles className="h-3.5 w-3.5" />
              Open Detail Page
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={conf.className}>{conf.label} match</Badge>
            {item.favorite && <Badge variant="outline" className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30">Favorite</Badge>}
          </div>
          {item.reasons.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-mono uppercase">Why it matched</p>
              <ul className="space-y-1">
                {item.reasons.map((r) => (
                  <li key={r} className="text-sm flex items-start gap-1.5">
                    <CornerDownRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />{r}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {item.description && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-mono uppercase">AI description</p>
              <p className="text-sm">{item.description}</p>
            </div>
          )}
          <div className="space-y-3">
            {[
              { label: "Path", value: item.relativePath },
              { label: "Type", value: item.mediaType },
              { label: "Size", value: formatBytes(item.sizeBytes) },
              { label: "Taken", value: item.dateTaken ? formatDate(item.dateTaken) : "Unknown" },
            ].map(({ label, value }) => (
              <div key={label} className="space-y-0.5">
                <p className="text-xs text-muted-foreground font-mono uppercase">{label}</p>
                <p className="text-sm break-all">{value}</p>
              </div>
            ))}
          </div>
          <Button variant="secondary" className="w-full" onClick={() => onSimilar(item)} data-testid="button-sheet-similar">
            <ScanSearch className="h-4 w-4 mr-2" /> Find similar files
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [trail, setTrail] = useState<SearchTurn[]>([]);
  const [similarOf, setSimilarOf] = useState<ResultItem | null>(null);
  const [selected, setSelected] = useState<ResultItem | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const status = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => apiFetch("/search/ai-status"),
    refetchInterval: (q) => ((q.state.data as any)?.pending > 0 ? 10000 : false),
  });

  const historyQ = useQuery({
    queryKey: ["search-history"],
    queryFn: () => apiFetch("/search/history"),
  });
  const savedQ = useQuery({
    queryKey: ["saved-searches"],
    queryFn: () => apiFetch("/search/saved"),
  });

  const buildFilters = useCallback(() => {
    const f: Record<string, unknown> = {};
    if (typeFilter !== "all") f.mediaTypes = [typeFilter];
    if (favoriteOnly) f.favoriteOnly = true;
    return Object.keys(f).length ? f : undefined;
  }, [typeFilter, favoriteOnly]);

  const search = useMutation({
    mutationFn: async ({ query, refine, previousIntent }: { query: string; refine: boolean; previousIntent: SearchIntent | null }) => {
      const body: Record<string, unknown> = { query, filters: buildFilters() };
      if (refine && previousIntent) {
        body.refine = true;
        body.previousIntent = previousIntent;
      }
      const data: SearchResponse = await apiFetch("/search/ai", { method: "POST", body: JSON.stringify(body) });
      return { data, refine };
    },
    onSuccess: ({ data, refine }) => {
      setResponse(data);
      setSimilarOf(null);
      setTrail((t) => refine
        ? [...t, { query: data.query, refined: true, resultCount: data.results.length }]
        : [{ query: data.query, refined: false, resultCount: data.results.length }]);
      setInput("");
      qc.invalidateQueries({ queryKey: ["search-history"] });
    },
  });

  const similar = useMutation({
    mutationFn: (item: ResultItem) => apiFetch(`/search/similar/${item.id}`),
    onSuccess: (data: { results: ResultItem[] }, item) => {
      setSelected(null);
      setSimilarOf(item);
      setResponse((prev) => ({
        query: `Similar to ${item.name}`,
        intent: prev?.intent ?? ({} as SearchIntent),
        results: data.results,
        suggestions: [],
      }));
      setTrail([]);
    },
  });

  const runSaved = useMutation({
    mutationFn: (id: number) => apiFetch(`/search/saved/${id}/run`, { method: "POST" }),
    onSuccess: (data: SearchResponse) => {
      setResponse(data);
      setSimilarOf(null);
      setTrail([{ query: data.query, refined: false, resultCount: data.results.length }]);
      qc.invalidateQueries({ queryKey: ["saved-searches"] });
    },
  });

  const saveSearch = useMutation({
    mutationFn: () => apiFetch("/search/saved", {
      method: "POST",
      body: JSON.stringify({ name: saveName, query: response?.query, intent: response?.intent }),
    }),
    onSuccess: () => {
      setSaveOpen(false);
      setSaveName("");
      qc.invalidateQueries({ queryKey: ["saved-searches"] });
    },
  });

  const deleteSaved = useMutation({
    mutationFn: (id: number) => apiFetch(`/search/saved/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-searches"] }),
  });

  const clearHistory = useMutation({
    mutationFn: () => apiFetch("/search/history", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["search-history"] }),
  });

  const hasSession = response !== null && !similarOf;

  const submit = useCallback((raw?: string, forceNew = false) => {
    const q = (raw ?? input).trim();
    if (!q || search.isPending) return;
    const refine = hasSession && !forceNew;
    search.mutate({ query: q, refine, previousIntent: refine ? response?.intent ?? null : null });
  }, [input, search, hasSession, response]);

  const startOver = () => {
    setResponse(null);
    setTrail([]);
    setSimilarOf(null);
    setInput("");
    inputRef.current?.focus();
  };

  useEffect(() => { inputRef.current?.focus(); }, []);

  const pending = (status.data as any)?.pending ?? 0;
  const analyzedCount = (status.data as any)?.analyzedCount ?? 0;
  const totalCount = (status.data as any)?.totalCount ?? 0;
  const history: { id: number; query: string; resultCount: number }[] = (historyQ.data as any)?.history ?? [];
  const saved: { id: number; name: string; query: string }[] = (savedQ.data as any)?.saved ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> AI Search
          </h1>
          <p className="text-sm text-muted-foreground">
            Ask in plain English — names, dates, places, objects, text inside documents.
          </p>
        </div>
        {totalCount > 0 && (
          <Badge variant="outline" className="text-xs" data-testid="badge-ai-coverage">
            {pending > 0 ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            {analyzedCount}/{totalCount} files AI-analyzed
          </Badge>
        )}
      </div>

      {/* Search bar */}
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex gap-2 flex-wrap"
      >
        <div className="relative flex-1 min-w-64">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={hasSession ? 'Refine — e.g. "only the ones with waterfalls"' : 'e.g. "photos of my truck from last summer"'}
            className="pl-9"
            data-testid="input-search"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-36" data-testid="select-type-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MEDIA_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={favoriteOnly ? "default" : "outline"}
          size="icon"
          onClick={() => setFavoriteOnly((v) => !v)}
          title="Favorites only"
          data-testid="button-favorite-filter"
        >
          <Star className={`h-4 w-4 ${favoriteOnly ? "fill-current" : ""}`} />
        </Button>
        <Button type="submit" disabled={search.isPending || !input.trim()} data-testid="button-search">
          {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : hasSession ? "Refine" : "Search"}
        </Button>
        {(hasSession || similarOf) && (
          <Button type="button" variant="ghost" onClick={startOver} data-testid="button-start-over">
            <X className="h-4 w-4 mr-1" /> New search
          </Button>
        )}
      </form>

      {search.isError && (
        <p className="text-sm text-destructive" data-testid="text-search-error">{(search.error as Error).message}</p>
      )}

      {/* Refinement trail */}
      {trail.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-sm" data-testid="trail-refinements">
          {trail.map((t, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
              <Badge variant={i === trail.length - 1 ? "default" : "secondary"} className="font-normal">
                {t.query} <span className="ml-1 opacity-70">({t.resultCount})</span>
              </Badge>
            </span>
          ))}
        </div>
      )}

      {/* Understood-as chips */}
      {response && !similarOf && intentChips(response.intent).length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">Understood as:</span>
          {intentChips(response.intent).map((c) => (
            <Badge key={c} variant="outline" className="text-xs font-normal">{c}</Badge>
          ))}
          {response.results.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-xs ml-auto" onClick={() => setSaveOpen(true)} data-testid="button-save-search">
              <BookmarkPlus className="h-3.5 w-3.5 mr-1" /> Save this search
            </Button>
          )}
        </div>
      )}

      {similarOf && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ScanSearch className="h-4 w-4" /> Files similar to <span className="font-medium text-foreground">{similarOf.name}</span>
        </div>
      )}

      {/* Loading */}
      {(search.isPending || similar.isPending || runSaved.isPending) && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[4/3] rounded-lg" />)}
        </div>
      )}

      {/* Results */}
      {response && !search.isPending && !similar.isPending && !runSaved.isPending && (
        response.results.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="grid-results">
            {response.results.map((r) => (
              <ResultCard key={r.id} item={r} onOpen={setSelected} onSimilar={(it) => similar.mutate(it)} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 space-y-4" data-testid="empty-results">
            <p className="text-muted-foreground">
              No matches found{(response.enrichmentPending ?? 0) > 0 ? " — some files are still being analyzed, try again shortly" : ""}.
            </p>
            {response.suggestions.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Try instead:</p>
                <div className="flex justify-center gap-2 flex-wrap">
                  {response.suggestions.map((s) => (
                    <Button key={s} variant="outline" size="sm" onClick={() => submit(s, true)} data-testid="button-suggestion">
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      )}

      {/* Idle state: starters, saved, history */}
      {!response && !search.isPending && !runSaved.isPending && (
        <div className="space-y-8">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Try asking</p>
            <div className="flex gap-2 flex-wrap">
              {STARTERS.map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => submit(s, true)} data-testid="button-starter">
                  <Sparkles className="h-3.5 w-3.5 mr-1.5 text-primary" /> {s}
                </Button>
              ))}
            </div>
          </div>

          {saved.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Bookmark className="h-4 w-4" /> Saved searches
              </p>
              <div className="flex gap-2 flex-wrap">
                {saved.map((s) => (
                  <div key={s.id} className="flex items-center rounded-md border bg-card">
                    <button
                      className="px-3 py-1.5 text-sm hover:text-primary transition-colors"
                      onClick={() => runSaved.mutate(s.id)}
                      data-testid={`button-saved-${s.id}`}
                    >
                      {s.name}
                    </button>
                    <button
                      className="px-2 py-1.5 text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => deleteSaved.mutate(s.id)}
                      data-testid={`button-delete-saved-${s.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                  <History className="h-4 w-4" /> Recent searches
                </p>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => clearHistory.mutate()} data-testid="button-clear-history">
                  Clear
                </Button>
              </div>
              <div className="flex gap-2 flex-wrap">
                {history.map((h) => (
                  <Button key={h.id} variant="secondary" size="sm" onClick={() => submit(h.query, true)} data-testid={`button-history-${h.id}`}>
                    {h.query} <span className="ml-1.5 text-muted-foreground">({h.resultCount})</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Save dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Save this search</DialogTitle></DialogHeader>
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="e.g. Summer truck photos"
            onKeyDown={(e) => e.key === "Enter" && saveName.trim() && saveSearch.mutate()}
            data-testid="input-save-name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={() => saveSearch.mutate()} disabled={!saveName.trim() || saveSearch.isPending} data-testid="button-confirm-save">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected && (
        <DetailSheet item={selected} onClose={() => setSelected(null)} onSimilar={(it) => similar.mutate(it)} />
      )}
    </div>
  );
}
