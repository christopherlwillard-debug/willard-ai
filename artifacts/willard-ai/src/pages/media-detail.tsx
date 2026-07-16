import { useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBytes, formatDate } from "@/lib/format";
import {
  ArrowLeft, Camera, ChevronDown, ChevronLeft, ChevronRight, Clock,
  FileText, Image as ImageIcon, Loader2, MapPin, Music, Pencil,
  Sparkles, StickyNote, Tag, Users, Video, X, Check, Star, ScanSearch,
  FolderOpen, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";

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

interface TagChip { tag: string; source: "ai" | "user" }

interface RelatedItem {
  id: number; name: string; relativePath: string; mediaType: string;
  sizeBytes: number; dateTaken: string | null; favorite: boolean;
  durationSeconds: number | null;
}

interface DetailResponse {
  file: {
    id: number; name: string; relativePath: string; extension: string | null;
    mimeType: string | null; mediaType: string; sizeBytes: number;
    modifiedAt: string | null; dateCreated: string | null; favorite: boolean;
    width: number | null; height: number | null; orientation: number | null;
    durationSeconds: number | null; dateTaken: string | null; folder: string;
    exif: {
      cameraMake: string | null; cameraModel: string | null; lens: string | null;
      iso: number | null; aperture: string | null; exposure: string | null;
      focalLength: string | null; flash: string | null;
    };
    gps: { latitude: number; longitude: number; placeName: string | null } | null;
    video: { videoCodec: string | null; videoBitrate: number | null; fps: number | null; audioCodec: string | null } | null;
    pdf: { pageCount: number | null; author: string | null; title: string | null; subject: string | null; keywords: string | null } | null;
  };
  ai: {
    analyzed: boolean; analyzedAt?: string; description?: string | null;
    descriptionEdited?: boolean; tags?: TagChip[]; originalDescription?: string | null;
    hiddenTags?: string[]; objects?: string[]; people?: string[];
    scene?: string | null; docType?: string | null; ocrText?: string | null;
    confidence?: "high" | "medium";
  };
  notes: string | null;
  collections: { id: number; name: string; kind: string; autoKey: string | null; itemCount: number }[];
  timeline: { prev: RelatedItem | null; next: RelatedItem | null };
}

interface RelatedResponse {
  sameEvent: { collectionId: number; name: string; items: RelatedItem[] }[];
  sameDay: RelatedItem[];
  sameLocation: RelatedItem[];
  samePeople: RelatedItem[];
  similar: { id: number; name: string; relativePath: string; mediaType: string; sizeBytes: number; dateTaken: string | null; favorite: boolean }[];
  sameCollection: { collectionId: number; name: string; kind: string; items: RelatedItem[] }[];
}

const isVisual = (t: string) => t === "photo" || t === "image" || t === "video";

// ── Small building blocks ─────────────────────────────────────────────────────

function MediaThumb({ item, size = "h-24 w-24" }: { item: { id: number; name: string; mediaType: string }; size?: string }) {
  const [, navigate] = useLocation();
  return (
    <button
      onClick={() => navigate(`/media/${item.id}`)}
      className={`${size} shrink-0 overflow-hidden rounded-md border bg-muted transition hover:ring-2 hover:ring-primary`}
      title={item.name}
      data-testid={`related-item-${item.id}`}
    >
      {isVisual(item.mediaType) ? (
        <img src={`/api/media/thumbnail/${item.id}`} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-muted-foreground">
          <FileText className="h-6 w-6" />
          <span className="w-full truncate text-center text-[10px]">{item.name}</span>
        </span>
      )}
    </button>
  );
}

function ThumbRow({ items }: { items: { id: number; name: string; mediaType: string }[] }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {items.map((it) => <MediaThumb key={it.id} item={it} />)}
    </div>
  );
}

function SectionCard({ icon: Icon, title, children, action, testId }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium" title={typeof value === "string" ? value : undefined}>{value}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MediaDetail() {
  const [, params] = useRoute("/media/:id");
  const id = Number(params?.id);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const relatedRef = useRef<HTMLDivElement>(null);

  const detailQ = useQuery<DetailResponse>({
    queryKey: ["media-detail", id],
    queryFn: () => apiFetch(`/media/files/${id}/detail`),
    enabled: Number.isFinite(id) && id > 0,
    // AI sections fill in as enrichment completes.
    refetchInterval: (q) => (q.state.data && !q.state.data.ai.analyzed ? 10_000 : false),
  });

  const relatedQ = useQuery<RelatedResponse>({
    queryKey: ["media-related", id],
    queryFn: () => apiFetch(`/media/files/${id}/related`),
    enabled: detailQ.isSuccess, // progressive: basics first, related after
  });

  const patchAi = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/media/files/${id}/ai`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["media-detail", id] });
    },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  // Local edit state
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");

  if (!Number.isFinite(id) || id <= 0) return <div className="p-6">Invalid media item.</div>;

  if (detailQ.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="aspect-video w-full rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" /><Skeleton className="h-40" />
        </div>
      </div>
    );
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-muted-foreground">{(detailQ.error as Error)?.message ?? "This item could not be found."}</p>
        <Button variant="outline" onClick={() => navigate("/media")}><ArrowLeft className="mr-2 h-4 w-4" />Back to Media</Button>
      </div>
    );
  }

  const { file, ai, notes, collections, timeline } = detailQ.data;
  const rel = relatedQ.data;
  const streamUrl = `/api/media/file/${file.id}/stream`;
  const mediaIcon = file.mediaType === "video" ? Video : file.mediaType === "audio" ? Music : isVisual(file.mediaType) ? ImageIcon : FileText;
  const MediaIcon = mediaIcon;
  const event = collections.find((c) => c.kind === "auto" && c.autoKey?.startsWith("event:"));
  const place = collections.find((c) => c.kind === "auto" && c.autoKey?.startsWith("place:"));

  const scrollToRelated = () => relatedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6" data-testid="media-detail-page">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => window.history.length > 1 ? window.history.back() : navigate("/media")} data-testid="button-back">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <MediaIcon className="h-5 w-5 text-primary" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" title={file.name} data-testid="detail-title">{file.name}</h1>
        {file.favorite && <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />}
        <div className="flex items-center gap-1">
          {timeline.prev && (
            <Button variant="outline" size="icon" className="h-8 w-8" title={`Previous: ${timeline.prev.name}`} onClick={() => navigate(`/media/${timeline.prev!.id}`)} data-testid="button-prev">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          {timeline.next && (
            <Button variant="outline" size="icon" className="h-8 w-8" title={`Next: ${timeline.next.name}`} onClick={() => navigate(`/media/${timeline.next!.id}`)} data-testid="button-next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Preview */}
      <Card className="overflow-hidden" data-testid="card-preview">
        <div className="flex max-h-[60vh] items-center justify-center bg-black/90">
          {file.mediaType === "video" ? (
            <video src={streamUrl} controls preload="metadata" className="max-h-[60vh] w-full" />
          ) : file.mediaType === "audio" ? (
            <div className="w-full p-8"><audio src={streamUrl} controls className="w-full" /></div>
          ) : isVisual(file.mediaType) ? (
            <img src={streamUrl} alt={file.name} className="max-h-[60vh] object-contain" />
          ) : file.mimeType === "application/pdf" || file.extension === "pdf" ? (
            <img src={`/api/media/thumbnail/${file.id}`} alt={`First page of ${file.name}`} className="max-h-[60vh] bg-white object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 p-12 text-white/70">
              <FileText className="h-16 w-16" />
              <span className="text-sm">{file.extension?.toUpperCase() ?? "FILE"} · {formatBytes(file.sizeBytes)}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Contextual AI actions */}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={scrollToRelated} data-testid="action-find-similar"><ScanSearch className="mr-1 h-4 w-4" />Find Similar</Button>
        {event && <Button variant="secondary" size="sm" onClick={() => navigate(`/collections?open=${event.id}`)} data-testid="action-same-event"><CalendarDays className="mr-1 h-4 w-4" />Show Same Event</Button>}
        {place && <Button variant="secondary" size="sm" onClick={() => navigate(`/collections?open=${place.id}`)} data-testid="action-same-location"><MapPin className="mr-1 h-4 w-4" />Show Same Location</Button>}
        {(ai.people?.length ?? 0) > 0 && <Button variant="secondary" size="sm" onClick={scrollToRelated} data-testid="action-same-person"><Users className="mr-1 h-4 w-4" />Show Same Person</Button>}
        <Button variant="secondary" size="sm" onClick={() => navigate("/media?view=timeline")} data-testid="action-timeline"><Clock className="mr-1 h-4 w-4" />View Timeline</Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        {/* Left/main column */}
        <div className="space-y-4 lg:col-span-2">
          {/* AI Description */}
          {!ai.analyzed ? (
            <SectionCard icon={Sparkles} title="AI understanding" testId="card-ai-pending">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                AI is still analyzing this item — description and tags will appear here automatically.
              </div>
            </SectionCard>
          ) : (
            <>
              {(ai.description || editingDesc) && (
                <SectionCard
                  icon={Sparkles}
                  title="Description"
                  testId="card-description"
                  action={
                    <div className="flex items-center gap-2">
                      {ai.confidence && <Badge variant="outline" className="text-xs">Confidence: {ai.confidence === "high" ? "High" : "Medium"}</Badge>}
                      {ai.descriptionEdited && <Badge variant="secondary" className="text-xs">Edited</Badge>}
                      {!editingDesc && (
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setDescDraft(ai.description ?? ""); setEditingDesc(true); }} data-testid="button-edit-description">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  }
                >
                  {editingDesc ? (
                    <div className="space-y-2">
                      <Textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={3} data-testid="input-description" />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={patchAi.isPending} onClick={() => patchAi.mutate({ description: descDraft.trim() || null }, { onSuccess: () => setEditingDesc(false) })} data-testid="button-save-description">
                          {patchAi.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}Save
                        </Button>
                        {ai.descriptionEdited && (
                          <Button size="sm" variant="outline" disabled={patchAi.isPending} onClick={() => patchAi.mutate({ description: null }, { onSuccess: () => setEditingDesc(false) })} data-testid="button-restore-description">
                            Restore AI original
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>Cancel</Button>
                      </div>
                      {ai.descriptionEdited && ai.originalDescription && (
                        <p className="text-xs text-muted-foreground">AI original: “{ai.originalDescription}”</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm leading-relaxed" data-testid="text-description">{ai.description}</p>
                  )}
                </SectionCard>
              )}

              {/* Tags */}
              {((ai.tags?.length ?? 0) > 0 || addingTag) && (
                <SectionCard
                  icon={Tag}
                  title="Tags"
                  testId="card-tags"
                  action={
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => setAddingTag(true)} data-testid="button-add-tag">+ Add tag</Button>
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(ai.tags ?? []).map((t) => (
                      <Badge key={`${t.source}-${t.tag}`} variant={t.source === "user" ? "default" : "secondary"} className="group gap-1 pr-1" data-testid={`tag-${t.tag}`}>
                        {t.tag}
                        <button
                          className="rounded-full p-0.5 opacity-50 transition hover:bg-black/20 hover:opacity-100"
                          title="Remove tag (AI original is kept underneath)"
                          onClick={() => patchAi.mutate({ removeTags: [t.tag] })}
                          data-testid={`remove-tag-${t.tag}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {addingTag && (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const v = tagDraft.trim();
                          if (v) patchAi.mutate({ addTags: [v] }, { onSuccess: () => { setTagDraft(""); setAddingTag(false); } });
                        }}
                      >
                        <Input autoFocus value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} placeholder="new tag" className="h-7 w-32 text-xs" data-testid="input-new-tag" />
                        <Button type="submit" size="icon" className="h-7 w-7" disabled={patchAi.isPending}><Check className="h-3.5 w-3.5" /></Button>
                        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddingTag(false)}><X className="h-3.5 w-3.5" /></Button>
                      </form>
                    )}
                  </div>
                  {(ai.hiddenTags?.length ?? 0) > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Removed AI tags (preserved): {ai.hiddenTags!.join(", ")} —{" "}
                      <button className="underline" onClick={() => patchAi.mutate({ addTags: ai.hiddenTags })} data-testid="button-restore-tags">restore</button>
                    </p>
                  )}
                </SectionCard>
              )}

              {/* People */}
              {(ai.people?.length ?? 0) > 0 && (
                <SectionCard icon={Users} title="People" testId="card-people">
                  <div className="flex flex-wrap gap-1.5">
                    {ai.people!.map((p) => <Badge key={p} variant="outline">{p}</Badge>)}
                  </div>
                  {rel && rel.samePeople.length > 0 && (
                    <div className="mt-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">Also featuring the same people</p>
                      <ThumbRow items={rel.samePeople} />
                    </div>
                  )}
                </SectionCard>
              )}
            </>
          )}

          {/* Related */}
          <div ref={relatedRef} className="scroll-mt-4 space-y-4">
            {relatedQ.isLoading && (
              <SectionCard icon={ScanSearch} title="Related" testId="card-related-loading">
                <div className="flex gap-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 w-24 rounded-md" />)}</div>
              </SectionCard>
            )}
            {rel && rel.sameEvent.map((ev) => (
              <SectionCard key={ev.collectionId} icon={CalendarDays} title={`Same event — ${ev.name}`} testId="card-same-event"
                action={<Link href={`/collections?open=${ev.collectionId}`} className="text-xs text-primary underline">Open event</Link>}>
                <ThumbRow items={ev.items} />
              </SectionCard>
            ))}
            {rel && rel.sameDay.length > 0 && (
              <SectionCard icon={Clock} title="Same day" testId="card-same-day"><ThumbRow items={rel.sameDay} /></SectionCard>
            )}
            {rel && rel.sameLocation.length > 0 && (
              <SectionCard icon={MapPin} title="Same location" testId="card-same-location"><ThumbRow items={rel.sameLocation} /></SectionCard>
            )}
            {rel && rel.similar.length > 0 && (
              <SectionCard icon={ScanSearch} title={file.mediaType === "document" ? "Similar documents" : "Similar items"} testId="card-similar">
                <ThumbRow items={rel.similar} />
              </SectionCard>
            )}
            {rel && rel.sameCollection.map((c) => (
              <SectionCard key={c.collectionId} icon={FolderOpen} title={`From “${c.name}”`} testId="card-same-collection"
                action={<Link href={`/collections?open=${c.collectionId}`} className="text-xs text-primary underline">Open collection</Link>}>
                <ThumbRow items={c.items} />
              </SectionCard>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Notes */}
          <SectionCard
            icon={StickyNote}
            title="Notes"
            testId="card-notes"
            action={!editingNotes ? (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setNotesDraft(notes ?? ""); setEditingNotes(true); }} data-testid="button-edit-notes">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            ) : undefined}
          >
            {editingNotes ? (
              <div className="space-y-2">
                <Textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={4} placeholder="e.g. This was our Arizona vacation" data-testid="input-notes" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={patchAi.isPending} onClick={() => patchAi.mutate({ notes: notesDraft.trim() || null }, { onSuccess: () => setEditingNotes(false) })} data-testid="button-save-notes">
                    {patchAi.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingNotes(false)}>Cancel</Button>
                </div>
              </div>
            ) : notes ? (
              <p className="whitespace-pre-wrap text-sm" data-testid="text-notes">{notes}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Add a note — notes are searchable.</p>
            )}
          </SectionCard>

          {/* Map */}
          {file.gps && (
            <SectionCard icon={MapPin} title="Location" testId="card-map">
              <iframe
                title="Location map"
                className="h-44 w-full rounded-md border"
                loading="lazy"
                src={`https://www.openstreetmap.org/export/embed.html?bbox=${file.gps.longitude - 0.02}%2C${file.gps.latitude - 0.012}%2C${file.gps.longitude + 0.02}%2C${file.gps.latitude + 0.012}&layer=mapnik&marker=${file.gps.latitude}%2C${file.gps.longitude}`}
              />
              {file.gps.placeName && (
                <p className="mt-2 text-sm font-medium" data-testid="text-place-name">{file.gps.placeName}</p>
              )}
              <p className={file.gps.placeName ? "text-xs text-muted-foreground" : "mt-2 text-xs text-muted-foreground"}>
                {file.gps.latitude.toFixed(5)}, {file.gps.longitude.toFixed(5)}
                {place && <> · <Link href={`/collections?open=${place.id}`} className="text-primary underline">More from {place.name}</Link></>}
              </p>
            </SectionCard>
          )}

          {/* Timeline */}
          {(timeline.prev || timeline.next) && (
            <SectionCard icon={Clock} title="Timeline" testId="card-timeline">
              <div className="space-y-2 text-sm">
                {file.dateTaken && <p className="text-muted-foreground">Taken {formatDate(file.dateTaken)}</p>}
                <div className="flex gap-2">
                  {timeline.prev && <MediaThumb item={timeline.prev} size="h-20 w-20" />}
                  {timeline.next && <MediaThumb item={timeline.next} size="h-20 w-20" />}
                </div>
                <p className="text-xs text-muted-foreground">Nearby moments — click to navigate.</p>
              </div>
            </SectionCard>
          )}

          {/* File info */}
          <Card data-testid="card-file-info">
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="flex w-full items-center justify-between p-4 pb-3 text-sm font-semibold" data-testid="toggle-file-info">
                <span className="flex items-center gap-2"><FileText className="h-4 w-4 text-primary" />File Information</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <InfoRow label="Name" value={file.name} />
                  <InfoRow label="Folder" value={file.folder} />
                  <InfoRow label="Type" value={`${file.mediaType}${file.extension ? ` (${file.extension})` : ""}`} />
                  <InfoRow label="Size" value={formatBytes(file.sizeBytes)} />
                  <InfoRow label="Resolution" value={file.width && file.height ? `${file.width} × ${file.height}` : null} />
                  <InfoRow label="Duration" value={file.durationSeconds != null ? `${Math.round(file.durationSeconds)}s` : null} />
                  <InfoRow label="Taken" value={file.dateTaken ? formatDate(file.dateTaken) : null} />
                  <InfoRow label="Created" value={file.dateCreated ? formatDate(file.dateCreated) : null} />
                  <InfoRow label="Modified" value={file.modifiedAt ? formatDate(file.modifiedAt) : null} />
                  <InfoRow label="Camera" value={[file.exif.cameraMake, file.exif.cameraModel].filter(Boolean).join(" ") || null} />
                  {file.video && (
                    <>
                      <InfoRow label="Video codec" value={file.video.videoCodec} />
                      <InfoRow label="FPS" value={file.video.fps} />
                      <InfoRow label="Audio codec" value={file.video.audioCodec} />
                    </>
                  )}
                  {file.pdf && (
                    <>
                      <InfoRow label="Pages" value={file.pdf.pageCount} />
                      <InfoRow label="Author" value={file.pdf.author} />
                      <InfoRow label="Title" value={file.pdf.title} />
                    </>
                  )}
                  {(file.exif.lens || file.exif.iso || file.exif.aperture || file.exif.exposure || file.exif.focalLength) && (
                    <Collapsible>
                      <CollapsibleTrigger className="mt-2 flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-xs font-medium" data-testid="toggle-exif">
                        <span className="flex items-center gap-2"><Camera className="h-3.5 w-3.5" />EXIF details</span>
                        <ChevronDown className="h-3.5 w-3.5" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-1 pt-1">
                        <InfoRow label="Lens" value={file.exif.lens} />
                        <InfoRow label="ISO" value={file.exif.iso} />
                        <InfoRow label="Aperture" value={file.exif.aperture} />
                        <InfoRow label="Exposure" value={file.exif.exposure} />
                        <InfoRow label="Focal length" value={file.exif.focalLength} />
                        <InfoRow label="Flash" value={file.exif.flash} />
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        </div>
      </div>
    </div>
  );
}
