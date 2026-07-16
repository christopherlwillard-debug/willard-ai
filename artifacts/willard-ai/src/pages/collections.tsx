import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FolderHeart,
  Heart,
  Sparkles,
  Wand2,
  Plus,
  Pencil,
  Trash2,
  Merge,
  RefreshCw,
  Loader2,
  ArrowLeft,
  CalendarDays,
  LayoutGrid,
  Image as ImageIcon,
  Play,
  ChevronLeft,
  ChevronRight,
  FolderPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MediaViewer } from "@/components/media/MediaViewer";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { MediaFile, MediaFilesResponse } from "@/types/media";
import type {
  Collection,
  CollectionsResponse,
  CollectionItemsResponse,
  SmartRule,
  TimelineResponse,
} from "@/types/collections";

const LIMIT = 60;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ── Small helpers ─────────────────────────────────────────────────────────────

function kindBadge(kind: Collection["kind"]) {
  switch (kind) {
    case "auto":   return <Badge variant="secondary" className="gap-1 text-[10px]"><Sparkles className="w-3 h-3" />Auto</Badge>;
    case "smart":  return <Badge variant="secondary" className="gap-1 text-[10px]"><Wand2 className="w-3 h-3" />Smart</Badge>;
    default:       return <Badge variant="secondary" className="gap-1 text-[10px]"><FolderHeart className="w-3 h-3" />Album</Badge>;
  }
}

function CoverImage({ fileId, className }: { fileId: number | null; className?: string }) {
  const [error, setError] = useState(false);
  if (fileId == null || error) {
    return (
      <div className={cn("flex items-center justify-center bg-muted", className)}>
        <ImageIcon className="w-8 h-8 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={`/api/media/thumbnail/${fileId}`}
      alt=""
      className={cn("object-cover", className)}
      onError={() => setError(true)}
    />
  );
}

// ── File grid (shared by album detail, favorites, timeline month) ────────────

function FileGrid({
  files,
  onOpen,
  onToggleFavorite,
}: {
  files: MediaFile[];
  onOpen: (index: number) => void;
  onToggleFavorite: (file: MediaFile) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
      {files.map((file, i) => (
        <div key={file.id} className="group relative">
          <button
            onClick={() => onOpen(i)}
            className="w-full flex flex-col rounded-lg border border-border overflow-hidden text-left bg-card hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary transition-all"
          >
            <div className="relative w-full aspect-square bg-muted flex items-center justify-center overflow-hidden">
              <CoverImage fileId={file.id} className="w-full h-full" />
              {file.mediaType === "video" && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="bg-black/50 rounded-full p-2">
                    <Play className="w-4 h-4 text-white fill-white" />
                  </div>
                </div>
              )}
            </div>
            <div className="p-2">
              <p className="text-xs font-mono truncate leading-tight" title={file.name}>{file.name}</p>
            </div>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(file); }}
            title={file.favorite ? "Remove from favorites" : "Add to favorites"}
            className={cn(
              "absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/50 transition-opacity",
              file.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <Heart className={cn("w-3.5 h-3.5", file.favorite ? "text-red-400 fill-red-400" : "text-white")} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 py-4">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <span className="text-xs font-mono text-muted-foreground">Page {page} / {totalPages}</span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        <ChevronRight className="w-4 h-4" />
      </Button>
    </div>
  );
}

// ── Smart folder rule editor ──────────────────────────────────────────────────

const MEDIA_TYPE_OPTIONS = ["photo", "video", "audio", "document", "other"];

function SmartRuleEditor({ rule, onChange }: { rule: SmartRule; onChange: (r: SmartRule) => void }) {
  const toggleType = (t: string) => {
    const current = rule.mediaTypes ?? [];
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    onChange({ ...rule, mediaTypes: next.length ? next : undefined });
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-mono text-muted-foreground uppercase mb-2">File types</p>
        <div className="flex flex-wrap gap-3">
          {MEDIA_TYPE_OPTIONS.map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-sm capitalize cursor-pointer">
              <Checkbox checked={(rule.mediaTypes ?? []).includes(t)} onCheckedChange={() => toggleType(t)} />
              {t}
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-mono text-muted-foreground uppercase mb-2">Name contains</p>
        <Input
          value={rule.nameContains ?? ""}
          onChange={(e) => onChange({ ...rule, nameContains: e.target.value || undefined })}
          placeholder="e.g. vacation"
          className="h-8 text-sm"
        />
      </div>
      <div>
        <p className="text-xs font-mono text-muted-foreground uppercase mb-2">Extensions (comma-separated)</p>
        <Input
          value={(rule.extensions ?? []).join(", ")}
          onChange={(e) => {
            const exts = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            onChange({ ...rule, extensions: exts.length ? exts : undefined });
          }}
          placeholder="e.g. jpg, png, mp4"
          className="h-8 text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs font-mono text-muted-foreground uppercase mb-2">From date</p>
          <Input
            type="date"
            value={rule.dateFrom ?? ""}
            onChange={(e) => onChange({ ...rule, dateFrom: e.target.value || undefined })}
            className="h-8 text-sm"
          />
        </div>
        <div>
          <p className="text-xs font-mono text-muted-foreground uppercase mb-2">To date</p>
          <Input
            type="date"
            value={rule.dateTo ?? ""}
            onChange={(e) => onChange({ ...rule, dateTo: e.target.value || undefined })}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs font-mono text-muted-foreground uppercase mb-2">Min size (MB)</p>
          <Input
            type="number"
            min={0}
            value={rule.minSizeBytes != null ? String(rule.minSizeBytes / (1024 * 1024)) : ""}
            onChange={(e) => onChange({ ...rule, minSizeBytes: e.target.value ? Number(e.target.value) * 1024 * 1024 : undefined })}
            className="h-8 text-sm"
          />
        </div>
        <div>
          <p className="text-xs font-mono text-muted-foreground uppercase mb-2">Max size (MB)</p>
          <Input
            type="number"
            min={0}
            value={rule.maxSizeBytes != null ? String(rule.maxSizeBytes / (1024 * 1024)) : ""}
            onChange={(e) => onChange({ ...rule, maxSizeBytes: e.target.value ? Number(e.target.value) * 1024 * 1024 : undefined })}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <Checkbox
          checked={rule.favoritesOnly ?? false}
          onCheckedChange={(v) => onChange({ ...rule, favoritesOnly: v === true ? true : undefined })}
        />
        Favorites only
      </label>
    </div>
  );
}

// ── Album detail view ─────────────────────────────────────────────────────────

function CollectionDetail({
  collection,
  onBack,
  onToggleFavorite,
}: {
  collection: Collection;
  onBack: () => void;
  onToggleFavorite: (file: MediaFile) => void;
}) {
  const [page, setPage] = useState(1);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["collection-items", collection.id, page],
    queryFn: async () => {
      const r = await fetch(`/api/collections/${collection.id}/items?page=${page}&limit=${LIMIT}`);
      if (!r.ok) throw new Error("Failed to load collection items");
      return r.json() as Promise<CollectionItemsResponse>;
    },
  });

  const files = itemsQuery.data?.files ?? [];
  const total = itemsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 font-mono">
          <ArrowLeft className="w-4 h-4" />Back
        </Button>
        <h3 className="text-base font-semibold font-mono">{collection.name}</h3>
        {kindBadge(collection.kind)}
        <span className="text-xs text-muted-foreground font-mono">{total} items</span>
      </div>
      {collection.description && (
        <p className="text-sm text-muted-foreground -mt-2">{collection.description}</p>
      )}
      {itemsQuery.isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground py-16 text-center">This collection is empty.</p>
      ) : (
        <>
          <FileGrid files={files} onOpen={setViewerIndex} onToggleFavorite={onToggleFavorite} />
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
      {viewerIndex !== null && files.length > 0 && (
        <MediaViewer files={files} initialIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </div>
  );
}

// ── Favorites view ────────────────────────────────────────────────────────────

function FavoritesDetail({
  onBack,
  onToggleFavorite,
}: {
  onBack: () => void;
  onToggleFavorite: (file: MediaFile) => void;
}) {
  const [page, setPage] = useState(1);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const favQuery = useQuery({
    queryKey: ["favorite-files", page],
    queryFn: async () => {
      const r = await fetch(`/api/media/files?favorites=true&page=${page}&limit=${LIMIT}`);
      if (!r.ok) throw new Error("Failed to load favorites");
      return r.json() as Promise<MediaFilesResponse>;
    },
  });

  const files = favQuery.data?.files ?? [];
  const total = favQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 font-mono">
          <ArrowLeft className="w-4 h-4" />Back
        </Button>
        <Heart className="w-4 h-4 text-red-400 fill-red-400" />
        <h3 className="text-base font-semibold font-mono">Favorites</h3>
        <span className="text-xs text-muted-foreground font-mono">{total} items</span>
      </div>
      {favQuery.isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : files.length === 0 ? (
        <div className="text-center py-16">
          <Heart className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No favorites yet. Tap the heart on any file to add it here.</p>
        </div>
      ) : (
        <>
          <FileGrid files={files} onOpen={setViewerIndex} onToggleFavorite={onToggleFavorite} />
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
      {viewerIndex !== null && files.length > 0 && (
        <MediaViewer files={files} initialIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </div>
  );
}

// ── Timeline view ─────────────────────────────────────────────────────────────

function TimelineView({ onToggleFavorite }: { onToggleFavorite: (file: MediaFile) => void }) {
  const [selected, setSelected] = useState<{ year: number; month: number } | "undated" | null>(null);
  const [page, setPage] = useState(1);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const timelineQuery = useQuery({
    queryKey: ["media-timeline"],
    queryFn: async () => {
      const r = await fetch("/api/media/timeline");
      if (!r.ok) throw new Error("Failed to load timeline");
      return r.json() as Promise<TimelineResponse>;
    },
  });

  useEffect(() => { setPage(1); }, [selected]);

  const itemsQuery = useQuery({
    queryKey: ["timeline-items", selected, page],
    enabled: selected !== null,
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (selected !== null && selected !== "undated") {
        params.set("year", String(selected.year));
        params.set("month", String(selected.month));
      }
      const r = await fetch(`/api/media/timeline/items?${params}`);
      if (!r.ok) throw new Error("Failed to load timeline items");
      return r.json() as Promise<MediaFilesResponse>;
    },
  });

  const buckets = timelineQuery.data?.buckets ?? [];
  const undatedCount = timelineQuery.data?.undatedCount ?? 0;

  if (selected !== null) {
    const files = itemsQuery.data?.files ?? [];
    const total = itemsQuery.data?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const title = selected === "undated"
      ? "No date information"
      : `${MONTH_NAMES[selected.month - 1]} ${selected.year}`;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="gap-1 font-mono">
            <ArrowLeft className="w-4 h-4" />Timeline
          </Button>
          <h3 className="text-base font-semibold font-mono">{title}</h3>
          <span className="text-xs text-muted-foreground font-mono">{total} items</span>
        </div>
        {itemsQuery.isLoading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <FileGrid files={files} onOpen={setViewerIndex} onToggleFavorite={onToggleFavorite} />
            <Pager page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
        {viewerIndex !== null && files.length > 0 && (
          <MediaViewer files={files} initialIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
        )}
      </div>
    );
  }

  if (timelineQuery.isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  if (buckets.length === 0 && undatedCount === 0) {
    return (
      <div className="text-center py-16">
        <CalendarDays className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No photos or videos indexed yet.</p>
      </div>
    );
  }

  const years = [...new Set(buckets.map((b) => b.year))].sort((a, b) => b - a);

  return (
    <div className="flex flex-col gap-8">
      {years.map((year) => (
        <div key={year}>
          <h3 className="text-lg font-semibold font-mono mb-3">{year}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {buckets.filter((b) => b.year === year).map((b) => (
              <button
                key={`${b.year}-${b.month}`}
                onClick={() => setSelected({ year: b.year, month: b.month })}
                className="group flex flex-col rounded-lg border border-border overflow-hidden text-left bg-card hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary transition-all"
              >
                <CoverImage fileId={b.coverFileId} className="w-full aspect-video" />
                <div className="p-2.5">
                  <p className="text-sm font-mono font-medium">{MONTH_NAMES[b.month - 1]}</p>
                  <p className="text-[11px] text-muted-foreground">{b.count} items</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
      {undatedCount > 0 && (
        <div>
          <h3 className="text-lg font-semibold font-mono mb-3">Undated</h3>
          <button
            onClick={() => setSelected("undated")}
            className="flex items-center gap-3 rounded-lg border border-border bg-card hover:bg-accent px-4 py-3 transition-all"
          >
            <CalendarDays className="w-5 h-5 text-muted-foreground" />
            <div className="text-left">
              <p className="text-sm font-mono">No date information</p>
              <p className="text-[11px] text-muted-foreground">{undatedCount} items</p>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = "collections" | "timeline";
type View = { kind: "list" } | { kind: "favorites" } | { kind: "detail"; collection: Collection };

export default function Collections() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>("collections");
  const [view, setView] = useState<View>({ kind: "list" });

  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Collection | null>(null);
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  const [smartOpen, setSmartOpen] = useState(false);
  const [smartEditTarget, setSmartEditTarget] = useState<Collection | null>(null);
  const [smartName, setSmartName] = useState("");
  const [smartRule, setSmartRule] = useState<SmartRule>({});

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const r = await fetch("/api/collections");
      if (!r.ok) throw new Error("Failed to load collections");
      return r.json() as Promise<CollectionsResponse>;
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["collections"] });
    queryClient.invalidateQueries({ queryKey: ["collection-items"] });
    queryClient.invalidateQueries({ queryKey: ["favorite-files"] });
  };

  const favoriteMutation = useMutation({
    mutationFn: async ({ id, favorite }: { id: number; favorite: boolean }) => {
      const r = await fetch(`/api/media/files/${id}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite }),
      });
      if (!r.ok) throw new Error("Failed to update favorite");
      return r.json();
    },
    onSuccess: () => {
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ["timeline-items"] });
      queryClient.invalidateQueries({ queryKey: ["media-files"] });
    },
  });

  const toggleFavorite = (file: MediaFile) => {
    favoriteMutation.mutate({ id: file.id, favorite: !file.favorite });
  };

  const rebuildMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/collections/rebuild", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Rebuild failed" }));
        throw new Error((body as any).error ?? "Rebuild failed");
      }
      return r.json() as Promise<{ collections: number; items: number }>;
    },
    onSuccess: (data) => {
      invalidateAll();
      toast({ title: "Albums refreshed", description: `${data.collections} automatic albums are up to date.` });
    },
    onError: (err: Error) => toast({ title: "Refresh failed", description: err.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const r = await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error("Rename failed");
      return r.json();
    },
    onSuccess: () => {
      invalidateAll();
      setRenameTarget(null);
      toast({ title: "Renamed" });
    },
    onError: (err: Error) => toast({ title: "Rename failed", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/collections/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
      return r.json();
    },
    onSuccess: () => {
      invalidateAll();
      setDeleteTarget(null);
      setView({ kind: "list" });
      toast({ title: "Collection removed", description: "Your files were not touched — only the album was removed." });
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ targetId, sourceIds }: { targetId: number; sourceIds: number[] }) => {
      const r = await fetch(`/api/collections/${targetId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIds }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Merge failed" }));
        throw new Error((body as any).error ?? "Merge failed");
      }
      return r.json();
    },
    onSuccess: () => {
      invalidateAll();
      setMergeTarget(null);
      setMergeSelection([]);
      toast({ title: "Albums merged" });
    },
    onError: (err: Error) => toast({ title: "Merge failed", description: err.message, variant: "destructive" }),
  });

  const smartSaveMutation = useMutation({
    mutationFn: async () => {
      if (smartEditTarget) {
        const r = await fetch(`/api/collections/${smartEditTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: smartName, ruleJson: smartRule }),
        });
        if (!r.ok) throw new Error("Failed to update smart folder");
        return r.json();
      }
      const r = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: smartName, kind: "smart", ruleJson: smartRule }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Failed to create smart folder" }));
        throw new Error((body as any).error ?? "Failed to create smart folder");
      }
      return r.json();
    },
    onSuccess: () => {
      invalidateAll();
      setSmartOpen(false);
      setSmartEditTarget(null);
      toast({ title: smartEditTarget ? "Smart folder updated" : "Smart folder created" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const collections = collectionsQuery.data?.collections ?? [];
  const favoritesCount = collectionsQuery.data?.favoritesCount ?? 0;
  const autoCollections = collections.filter((c) => c.kind === "auto");
  const smartCollections = collections.filter((c) => c.kind === "smart");
  const manualCollections = collections.filter((c) => c.kind === "manual");
  const mergeCandidates = collections.filter((c) => c.kind !== "smart" && c.id !== mergeTarget?.id);

  const openSmartCreate = () => {
    setSmartEditTarget(null);
    setSmartName("");
    setSmartRule({});
    setSmartOpen(true);
  };
  const openSmartEdit = (c: Collection) => {
    setSmartEditTarget(c);
    setSmartName(c.name);
    setSmartRule(c.ruleJson ?? {});
    setSmartOpen(true);
  };

  const CollectionCard = ({ c }: { c: Collection }) => (
    <div className="group relative">
      <button
        onClick={() => setView({ kind: "detail", collection: c })}
        className="w-full flex flex-col rounded-lg border border-border overflow-hidden text-left bg-card hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary transition-all"
      >
        <CoverImage fileId={c.coverFileId} className="w-full aspect-video" />
        <div className="p-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-mono font-medium truncate flex-1" title={c.name}>{c.name}</p>
            {kindBadge(c.kind)}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">{c.itemCount} items</p>
        </div>
      </button>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          title="Rename"
          onClick={() => { setRenameTarget(c); setRenameValue(c.name); }}
          className="p-1.5 rounded bg-black/60 text-white hover:bg-black/80"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        {c.kind === "smart" && (
          <button
            title="Edit rules"
            onClick={() => openSmartEdit(c)}
            className="p-1.5 rounded bg-black/60 text-white hover:bg-black/80"
          >
            <Wand2 className="w-3.5 h-3.5" />
          </button>
        )}
        {c.kind !== "smart" && (
          <button
            title="Merge other albums into this one"
            onClick={() => { setMergeTarget(c); setMergeSelection([]); }}
            className="p-1.5 rounded bg-black/60 text-white hover:bg-black/80"
          >
            <Merge className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          title="Remove"
          onClick={() => setDeleteTarget(c)}
          className="p-1.5 rounded bg-black/60 text-white hover:bg-red-600"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  const Section = ({ title, icon: Icon, items }: { title: string; icon: React.ComponentType<{ className?: string }>; items: Collection[] }) =>
    items.length === 0 ? null : (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-mono font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {items.map((c) => <CollectionCard key={c.id} c={c} />)}
        </div>
      </div>
    );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 flex-wrap">
        <h2 className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">Collections</h2>
        <div className="flex items-center rounded-md border border-border overflow-hidden ml-2">
          <button
            onClick={() => setTab("collections")}
            className={cn("px-3 py-1.5 text-xs font-mono flex items-center gap-1.5", tab === "collections" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            <LayoutGrid className="w-3.5 h-3.5" />Albums
          </button>
          <button
            onClick={() => setTab("timeline")}
            className={cn("px-3 py-1.5 text-xs font-mono flex items-center gap-1.5", tab === "timeline" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            <CalendarDays className="w-3.5 h-3.5" />Timeline
          </button>
        </div>
        <div className="flex-1" />
        {tab === "collections" && (
          <>
            <Button variant="outline" size="sm" onClick={openSmartCreate} className="gap-1.5 font-mono text-xs">
              <FolderPlus className="w-3.5 h-3.5" />New Smart Folder
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => rebuildMutation.mutate()}
              disabled={rebuildMutation.isPending}
              className="gap-1.5 font-mono text-xs"
            >
              {rebuildMutation.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh Auto Albums
            </Button>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "timeline" ? (
          <TimelineView onToggleFavorite={toggleFavorite} />
        ) : view.kind === "favorites" ? (
          <FavoritesDetail onBack={() => setView({ kind: "list" })} onToggleFavorite={toggleFavorite} />
        ) : view.kind === "detail" ? (
          <CollectionDetail
            collection={view.collection}
            onBack={() => setView({ kind: "list" })}
            onToggleFavorite={toggleFavorite}
          />
        ) : collectionsQuery.isLoading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-8">
            {/* Favorites card — always available */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Heart className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-mono font-semibold uppercase tracking-widest text-muted-foreground">Favorites</h3>
              </div>
              <button
                onClick={() => setView({ kind: "favorites" })}
                className="flex items-center gap-3 rounded-lg border border-border bg-card hover:bg-accent px-4 py-3 transition-all"
              >
                <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                  <Heart className="w-5 h-5 text-red-400 fill-red-400" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-mono font-medium">Favorites</p>
                  <p className="text-[11px] text-muted-foreground">{favoritesCount} items</p>
                </div>
              </button>
            </div>

            <Section title="Automatic Albums" icon={Sparkles} items={autoCollections} />
            <Section title="Smart Folders" icon={Wand2} items={smartCollections} />
            <Section title="My Albums" icon={FolderHeart} items={manualCollections} />

            {collections.length === 0 && (
              <div className="text-center py-12">
                <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  No albums yet. Automatic albums appear after your library is scanned — or create a
                  smart folder to group files by your own rules.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 gap-1.5 font-mono text-xs"
                  onClick={() => rebuildMutation.mutate()}
                  disabled={rebuildMutation.isPending}
                >
                  {rebuildMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Build Automatic Albums
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rename dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename collection</DialogTitle>
            <DialogDescription>Renamed automatic albums keep their name even when albums refresh.</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} placeholder="Album name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button
              disabled={!renameValue.trim() || renameMutation.isPending}
              onClick={() => renameTarget && renameMutation.mutate({ id: renameTarget.id, name: renameValue.trim() })}
            >
              {renameMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>
              Your files stay exactly where they are — only the album is removed.
              {deleteTarget?.kind === "auto" && " This automatic album will not come back when albums refresh."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge dialog */}
      <Dialog open={mergeTarget !== null} onOpenChange={(open) => { if (!open) { setMergeTarget(null); setMergeSelection([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge into "{mergeTarget?.name}"</DialogTitle>
            <DialogDescription>
              Pick albums to combine into this one. The merged album becomes a regular album you manage yourself.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {mergeCandidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No other albums available to merge.</p>
            )}
            {mergeCandidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={mergeSelection.includes(c.id)}
                  onCheckedChange={(v) =>
                    setMergeSelection((prev) => v === true ? [...prev, c.id] : prev.filter((x) => x !== c.id))
                  }
                />
                <span className="font-mono">{c.name}</span>
                <span className="text-[11px] text-muted-foreground">({c.itemCount} items)</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMergeTarget(null); setMergeSelection([]); }}>Cancel</Button>
            <Button
              disabled={mergeSelection.length === 0 || mergeMutation.isPending}
              onClick={() => mergeTarget && mergeMutation.mutate({ targetId: mergeTarget.id, sourceIds: mergeSelection })}
            >
              {mergeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : `Merge ${mergeSelection.length || ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Smart folder create/edit dialog */}
      <Dialog open={smartOpen} onOpenChange={(open) => { if (!open) { setSmartOpen(false); setSmartEditTarget(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{smartEditTarget ? "Edit smart folder" : "New smart folder"}</DialogTitle>
            <DialogDescription>
              Smart folders update themselves — any file matching the rules appears automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-xs font-mono text-muted-foreground uppercase mb-2">Name</p>
              <Input value={smartName} onChange={(e) => setSmartName(e.target.value)} placeholder="e.g. Long videos" className="h-8 text-sm" />
            </div>
            <SmartRuleEditor rule={smartRule} onChange={setSmartRule} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSmartOpen(false); setSmartEditTarget(null); }}>Cancel</Button>
            <Button
              disabled={!smartName.trim() || smartSaveMutation.isPending}
              onClick={() => smartSaveMutation.mutate()}
            >
              {smartSaveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : smartEditTarget ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
