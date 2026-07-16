import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileText, Loader2, Pencil, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";

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

interface Person {
  id: number;
  name: string | null;
  faceCount: number;
  photoCount: number;
  coverFaceId: number | null;
  createdAt: string | null;
}

interface PeopleResponse {
  people: Person[];
  status: {
    running: boolean; modelsReady: boolean; scanned: number;
    facesFound: number; failed: number; pending: number; lastRunAt: string | null;
  };
}

interface PersonItem {
  id: number; name: string; relativePath: string; mediaType: string;
  sizeBytes: number; dateTaken: string | null; favorite: boolean;
  durationSeconds: number | null; faceId: number;
}

const isVisual = (t: string) => t === "photo" || t === "image" || t === "video";

function FaceAvatar({ faceId, name, size = "h-20 w-20" }: { faceId: number | null; name: string | null; size?: string }) {
  const [failed, setFailed] = useState(false);
  if (faceId == null || failed) {
    return (
      <div className={`${size} flex items-center justify-center rounded-full bg-muted`}>
        <Users className="h-1/2 w-1/2 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={`/api/faces/${faceId}/crop`}
      alt={name ?? "Unnamed person"}
      className={`${size} rounded-full border object-cover`}
      onError={() => setFailed(true)}
    />
  );
}

function NameEditor({ person, onDone }: { person: Person; onDone: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState(person.name ?? "");
  const rename = useMutation({
    mutationFn: (name: string | null) =>
      apiFetch(`/faces/people/${person.id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["faces-people"] });
      qc.invalidateQueries({ queryKey: ["faces-person", person.id] });
      onDone();
    },
    onError: (e: Error) => toast({ title: "Couldn't save name", description: e.message, variant: "destructive" }),
  });
  return (
    <form
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        rename.mutate(draft.trim() || null);
      }}
    >
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Name this person"
        className="h-8 w-36 text-sm"
        data-testid={`input-person-name-${person.id}`}
      />
      <Button type="submit" size="icon" className="h-8 w-8" disabled={rename.isPending} data-testid={`button-save-name-${person.id}`}>
        {rename.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={onDone}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

// ── Person detail (one cluster) ───────────────────────────────────────────────

function PersonDetail({ personId }: { personId: number }) {
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState(false);

  const q = useQuery<{ person: Person; items: PersonItem[] }>({
    queryKey: ["faces-person", personId],
    queryFn: () => apiFetch(`/faces/people/${personId}/files`),
  });

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-muted-foreground">{(q.error as Error)?.message ?? "Person not found."}</p>
        <Button variant="outline" onClick={() => navigate("/people")}><ArrowLeft className="mr-2 h-4 w-4" />Back to People</Button>
      </div>
    );
  }

  const { person, items } = q.data;
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6" data-testid="person-detail-page">
      <Button variant="ghost" size="sm" onClick={() => navigate("/people")} data-testid="button-back-people">
        <ArrowLeft className="mr-1 h-4 w-4" /> All people
      </Button>
      <div className="flex items-center gap-4">
        <FaceAvatar faceId={person.coverFaceId} name={person.name} size="h-24 w-24" />
        <div className="min-w-0 space-y-1">
          {editing ? (
            <NameEditor person={person} onDone={() => setEditing(false)} />
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold" data-testid="person-name">
                {person.name ?? "Unnamed person"}
              </h1>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(true)} data-testid="button-edit-person-name">
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {person.photoCount} item{person.photoCount === 1 ? "" : "s"} · {person.faceCount} face{person.faceCount === 1 ? "" : "s"} detected
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" data-testid="person-items-grid">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => navigate(`/media/${it.id}`)}
            className="group relative aspect-square overflow-hidden rounded-md border bg-muted transition hover:ring-2 hover:ring-primary"
            title={it.name}
            data-testid={`person-item-${it.id}`}
          >
            {isVisual(it.mediaType) ? (
              <img src={`/api/media/thumbnail/${it.id}`} alt={it.name} loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-muted-foreground">
                <FileText className="h-6 w-6" />
                <span className="w-full truncate text-center text-[10px]">{it.name}</span>
              </span>
            )}
            {it.dateTaken && (
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100">
                {formatDate(it.dateTaken)}
              </span>
            )}
          </button>
        ))}
      </div>
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">No items for this person yet.</p>
      )}
    </div>
  );
}

// ── People overview (all clusters) ────────────────────────────────────────────

export default function People() {
  const [matched, params] = useRoute("/people/:id");
  const [, navigate] = useLocation();
  const [editingId, setEditingId] = useState<number | null>(null);

  const q = useQuery<PeopleResponse>({
    queryKey: ["faces-people"],
    queryFn: () => apiFetch(`/faces/people`),
    enabled: !matched,
    // Faces keep arriving while the local scanner works through the library.
    refetchInterval: (query) => ((query.state.data?.status.pending ?? 0) > 0 ? 15_000 : false),
  });

  if (matched && params?.id) {
    const pid = Number(params.id);
    if (Number.isFinite(pid) && pid > 0) return <PersonDetail personId={pid} />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6" data-testid="people-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><Users className="h-6 w-6 text-primary" /> People</h1>
          <p className="text-sm text-muted-foreground">
            Faces detected locally on your machine and grouped by person. Nothing leaves your library.
          </p>
        </div>
        {q.data && q.data.status.pending > 0 && (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Scanning {q.data.status.pending} item{q.data.status.pending === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {q.isLoading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      )}

      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      {q.data && q.data.people.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
            <Users className="h-10 w-10" />
            <p className="font-medium text-foreground">No people found yet</p>
            <p className="text-sm">
              {q.data.status.pending > 0
                ? "The local face scanner is still working through your library — people will appear here as faces are found."
                : "No faces were detected in your library's photos and videos yet."}
            </p>
          </CardContent>
        </Card>
      )}

      {q.data && q.data.people.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" data-testid="people-grid">
          {q.data.people.map((p) => (
            <Card
              key={p.id}
              className="cursor-pointer transition hover:ring-2 hover:ring-primary"
              onClick={() => navigate(`/people/${p.id}`)}
              data-testid={`person-card-${p.id}`}
            >
              <CardContent className="flex flex-col items-center gap-2 p-4">
                <FaceAvatar faceId={p.coverFaceId} name={p.name} />
                {editingId === p.id ? (
                  <NameEditor person={p} onDone={() => setEditingId(null)} />
                ) : (
                  <div className="flex max-w-full items-center gap-1">
                    <span className={`truncate text-sm font-medium ${p.name ? "" : "text-muted-foreground"}`} data-testid={`person-card-name-${p.id}`}>
                      {p.name ?? "Unnamed"}
                    </span>
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6 shrink-0"
                      onClick={(e) => { e.stopPropagation(); setEditingId(p.id); }}
                      title={p.name ? "Rename" : "Assign a name"}
                      data-testid={`button-name-person-${p.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <span className="text-xs text-muted-foreground">{p.photoCount} item{p.photoCount === 1 ? "" : "s"}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
