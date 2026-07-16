import {
  useState, useEffect, useCallback, useRef, useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import {
  X, ChevronLeft, ChevronRight, Info, Download, ExternalLink,
  Music, FileText, File, ImageIcon, MapPin, Camera, Calendar, Aperture,
  ZoomIn, ZoomOut, RotateCw, Heart, Maximize2, Minimize2, Trash2,
  PencilLine, FolderOpen, ChevronDown, ChevronUp, Play, Pause, Loader2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaFile } from "@/types/media";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}
function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function fmtDur(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function camLabel(make: string | null, model: string | null) {
  if (!make && !model) return null;
  if (!make) return model!;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ─── API ─────────────────────────────────────────────────────────────────────

const API = `${import.meta.env.BASE_URL}api`;

async function toggleFav(id: number, fav: boolean) {
  const r = await fetch(`${API}/media/files/${id}/favorite`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite: fav }),
  });
  if (!r.ok) throw new Error("Favorite failed");
  return r.json();
}
async function softDelete(id: number) {
  const r = await fetch(`${API}/media/files/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error("Delete failed");
  return r.json();
}
async function rename(id: number, name: string) {
  const r = await fetch(`${API}/media/files/${id}/rename`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any)?.error ?? "Rename failed"); }
  return r.json();
}

// ─── Photo view ──────────────────────────────────────────────────────────────

interface PhotoState { zoom: number; ox: number; oy: number; rot: number; }
const FIT: PhotoState = { zoom: 1, ox: 0, oy: 0, rot: 0 };
const ZOOM_MIN = 0.5, ZOOM_MAX = 8;

function PhotoView({
  file, onPrevNext,
}: { file: MediaFile; onPrevNext: (d: -1 | 1) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);
  const [ps, setPs]         = useState<PhotoState>(FIT);
  const [fitZoom, setFitZoom] = useState(1);
  const imgRef  = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Drag state
  const dragging = useRef(false);
  const lastPos  = useRef({ x: 0, y: 0 });

  // Touch state
  const touches     = useRef<{ x: number; y: number }[]>([]);
  const lastPinchD  = useRef<number | null>(null);
  const swipeStartX = useRef<number | null>(null);

  useEffect(() => { setLoaded(false); setError(false); setPs(FIT); }, [file.id]);

  // Compute true "fit" zoom when image loads (respect container)
  const onImgLoad = useCallback(() => {
    setLoaded(true);
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const scaleW = wrap.clientWidth  / img.naturalWidth;
    const scaleH = wrap.clientHeight / img.naturalHeight;
    const fit = Math.min(scaleW, scaleH, 1);
    setFitZoom(fit);
    setPs({ ...FIT, zoom: fit });
  }, []);

  const applyZoom = useCallback((delta: number, cx?: number, cy?: number) => {
    setPs((prev) => {
      const wrap = wrapRef.current;
      const rect = wrap?.getBoundingClientRect();
      const newZoom = clamp(prev.zoom * delta, ZOOM_MIN, ZOOM_MAX);
      if (!rect || (cx == null)) return { ...prev, zoom: newZoom };
      // Zoom toward cursor
      const px = cx - rect.left - rect.width  / 2;
      const py = cy! - rect.top  - rect.height / 2;
      const scale = newZoom / prev.zoom;
      return { ...prev, zoom: newZoom, ox: prev.ox * scale + px * (1 - scale), oy: prev.oy * scale + py * (1 - scale) };
    });
  }, []);

  const dblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPs((prev) => {
      if (Math.abs(prev.zoom - fitZoom) < 0.05) {
        return { ...prev, zoom: 1, ox: 0, oy: 0 };
      }
      return { ...FIT, zoom: fitZoom };
    });
  }, [fitZoom]);

  // Wheel zoom
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    applyZoom(delta, e.clientX, e.clientY);
  }, [applyZoom]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Mouse drag
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (ps.zoom <= fitZoom + 0.05) return;
    e.preventDefault();
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, [ps.zoom, fitZoom]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      setPs((prev) => ({ ...prev, ox: prev.ox + dx, oy: prev.oy + dy }));
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Touch events: swipe (when not zoomed), pinch (to zoom)
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const pts = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    touches.current = pts;
    if (pts.length === 1) {
      swipeStartX.current = pts[0].x;
      lastPinchD.current  = null;
    } else if (pts.length === 2) {
      swipeStartX.current = null;
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      lastPinchD.current = Math.sqrt(dx * dx + dy * dy);
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const pts = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    if (pts.length === 2 && lastPinchD.current != null) {
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      applyZoom(d / lastPinchD.current, cx, cy);
      lastPinchD.current = d;
    } else if (pts.length === 1 && ps.zoom > fitZoom + 0.05) {
      // Pan when zoomed
      const prev = touches.current[0];
      if (prev) {
        const dx = pts[0].x - prev.x, dy = pts[0].y - prev.y;
        setPs((p) => ({ ...p, ox: p.ox + dx, oy: p.oy + dy }));
      }
    }
    touches.current = pts;
  }, [applyZoom, ps.zoom, fitZoom]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && swipeStartX.current != null && ps.zoom <= fitZoom + 0.05) {
      const dx = e.changedTouches[0].clientX - swipeStartX.current;
      if (Math.abs(dx) > 60) onPrevNext(dx < 0 ? 1 : -1);
    }
    if (e.touches.length < 2) lastPinchD.current = null;
    swipeStartX.current = null;
  }, [onPrevNext, ps.zoom, fitZoom]);

  if (error) return (
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <ImageIcon className="w-16 h-16" />
      <span className="text-sm font-mono">Could not load image</span>
    </div>
  );

  const cursor = ps.zoom > fitZoom + 0.05 ? (dragging.current ? "grabbing" : "grab") : "default";

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden"
      style={{ cursor }}
      onMouseDown={onMouseDown}
      onDoubleClick={dblClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {!loaded && (
        <img
          src={`${API}/media/thumbnail/${file.id}`}
          alt={file.name}
          className="max-w-full max-h-full object-contain absolute inset-0 m-auto blur-sm scale-105 opacity-60 pointer-events-none"
        />
      )}
      <img
        ref={imgRef}
        src={`${API}/media/file/${file.id}/stream`}
        alt={file.name}
        onLoad={onImgLoad}
        onError={() => setError(true)}
        style={{
          transform: `scale(${ps.zoom}) translate(${ps.ox / ps.zoom}px, ${ps.oy / ps.zoom}px) rotate(${ps.rot}deg)`,
          transition: dragging.current ? "none" : "transform 0.12s ease-out",
          maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
          opacity: loaded ? 1 : 0,
          transformOrigin: "center center",
          userSelect: "none",
        }}
        draggable={false}
      />
      {/* zoom/rotate mini-bar — always visible over photo */}
      {loaded && (
        <div
          className="absolute bottom-3 right-3 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded-full px-2 py-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => applyZoom(1 / 1.3)} className="p-1 text-white/80 hover:text-white" title="Zoom out (-)">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] font-mono text-white/60 w-10 text-center">{Math.round(ps.zoom * 100)}%</span>
          <button onClick={() => applyZoom(1.3)} className="p-1 text-white/80 hover:text-white" title="Zoom in (+)">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setPs((p) => ({ ...p, rot: (p.rot + 90) % 360 }))}
            className="p-1 text-white/80 hover:text-white ml-1"
            title="Rotate"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          {ps.zoom !== fitZoom && (
            <button
              onClick={() => setPs({ ...FIT, zoom: fitZoom })}
              className="p-1 text-white/80 hover:text-white ml-1"
              title="Reset"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Video view ───────────────────────────────────────────────────────────────

function VideoView({ file, videoRef }: { file: MediaFile; videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [showSpeed, setShowSpeed] = useState(false);
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 relative">
      <video
        ref={videoRef}
        key={file.id}
        src={`${API}/media/file/${file.id}/stream`}
        controls
        autoPlay
        style={{ maxWidth: "100%", maxHeight: "calc(100% - 40px)" }}
        className="rounded shadow-lg"
      />
      {/* Playback speed overlay */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <button
          onClick={() => setShowSpeed((v) => !v)}
          className="text-xs font-mono px-2 py-1 bg-black/60 text-white rounded hover:bg-black/80"
        >
          {videoRef.current?.playbackRate ?? 1}×
        </button>
        {showSpeed && (
          <div className="absolute top-8 right-0 bg-black/90 rounded shadow-lg p-1 flex flex-col gap-0.5 z-10">
            {speeds.map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (videoRef.current) videoRef.current.playbackRate = s;
                  setShowSpeed(false);
                }}
                className="text-xs font-mono px-3 py-1 text-white hover:bg-white/10 rounded text-left"
              >
                {s}×
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Audio view ───────────────────────────────────────────────────────────────

function AudioView({ file }: { file: MediaFile }) {
  return (
    <div className="flex flex-col items-center gap-6 px-8 text-center">
      <div className="w-32 h-32 rounded-2xl bg-muted flex items-center justify-center">
        <Music className="w-16 h-16 text-muted-foreground" />
      </div>
      <div>
        <p className="text-white font-semibold text-lg truncate max-w-md">{file.name}</p>
        {file.durationSeconds != null && (
          <p className="text-muted-foreground text-sm font-mono mt-1">{fmtDur(file.durationSeconds)}</p>
        )}
      </div>
      <audio key={file.id} src={`${API}/media/file/${file.id}/stream`} controls autoPlay className="w-full max-w-sm" />
    </div>
  );
}

// ─── PDF view ─────────────────────────────────────────────────────────────────

function PdfView({ file }: { file: MediaFile }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2">
      <iframe
        key={file.id}
        src={`${API}/media/file/${file.id}/stream`}
        title={file.name}
        className="w-full rounded bg-white"
        style={{ height: "calc(100vh - 200px)", maxWidth: "min(800px,95vw)" }}
      />
    </div>
  );
}

function GenericView({ file }: { file: MediaFile }) {
  return (
    <div className="flex flex-col items-center gap-4 text-muted-foreground">
      {file.mediaType === "document" ? <FileText className="w-20 h-20" /> : <File className="w-20 h-20" />}
      <p className="text-white font-mono text-sm">{file.name}</p>
      <p className="text-xs">{fmt(file.sizeBytes)}</p>
      <a
        href={`${API}/media/file/${file.id}/stream`}
        download={file.name}
        className="flex items-center gap-2 mt-2 px-4 py-2 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90"
      >
        <Download className="w-4 h-4" /> Download
      </a>
    </div>
  );
}

// ─── Image preloader ──────────────────────────────────────────────────────────

function Preloader({ files, currentIndex }: { files: MediaFile[]; currentIndex: number }) {
  const ids = new Set<number>();
  if (currentIndex > 0) ids.add(files[currentIndex - 1].id);
  if (currentIndex < files.length - 1) ids.add(files[currentIndex + 1].id);
  return (
    <div className="hidden" aria-hidden>
      {[...ids].map((id) => (
        <img key={id} src={`${API}/media/file/${id}/stream`} alt="" />
      ))}
    </div>
  );
}

// ─── Info panel ───────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">{label}</dt>
      <dd className="text-xs text-foreground">{children}</dd>
    </div>
  );
}
function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h3 className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest border-b border-border pb-1">{title}</h3>
      {children}
    </div>
  );
}

function InfoPanel({ file }: { file: MediaFile }) {
  const camera = camLabel(file.cameraMake, file.cameraModel);
  const hasGps = file.gpsLatitude != null && file.gpsLongitude != null;
  const mapsUrl = hasGps ? `https://www.google.com/maps?q=${file.gpsLatitude},${file.gpsLongitude}` : null;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5 text-sm">
      <InfoSection title="File">
        <InfoRow label="Name"><span className="break-all">{file.name}</span></InfoRow>
        <InfoRow label="Path"><span className="text-muted-foreground font-mono text-[11px] break-all">{file.relativePath}</span></InfoRow>
        <div className="grid grid-cols-2 gap-2.5">
          <InfoRow label="Size">{fmt(file.sizeBytes)}</InfoRow>
          <InfoRow label="Format"><span className="font-mono uppercase">.{file.extension || "—"}</span></InfoRow>
        </div>
      </InfoSection>

      {file.mediaType === "photo" && (
        <InfoSection title="Photo">
          <div className="grid grid-cols-2 gap-2.5">
            {file.width != null && file.height != null && <InfoRow label="Resolution">{`${file.width} × ${file.height}`}</InfoRow>}
            {file.dateTaken && (
              <InfoRow label="Date Taken">
                <span className="flex items-center gap-1"><Calendar className="w-3 h-3 shrink-0" />{fmtDate(file.dateTaken)}</span>
              </InfoRow>
            )}
            {file.iso != null && <InfoRow label="ISO">{`ISO ${file.iso}`}</InfoRow>}
            {file.aperture != null && (
              <InfoRow label="Aperture">
                <span className="flex items-center gap-1"><Aperture className="w-3 h-3 shrink-0" />{`ƒ/${file.aperture % 1 === 0 ? file.aperture : file.aperture.toFixed(1)}`}</span>
              </InfoRow>
            )}
            {file.exposure && <InfoRow label="Exposure">{file.exposure}</InfoRow>}
            {file.focalLength != null && <InfoRow label="Focal">{`${file.focalLength}mm`}</InfoRow>}
            {file.flash && <InfoRow label="Flash">{file.flash}</InfoRow>}
          </div>
          {camera && <InfoRow label="Camera"><span className="flex items-center gap-1"><Camera className="w-3 h-3 shrink-0" />{camera}</span></InfoRow>}
          {file.lens && <InfoRow label="Lens">{file.lens}</InfoRow>}
          {file.colorProfile && <InfoRow label="Color">{file.colorProfile}</InfoRow>}
          {hasGps && (
            <InfoRow label="Location">
              {(file as any).placeName && <p className="font-medium text-foreground mb-0.5">{(file as any).placeName}</p>}
              <a href={mapsUrl!} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-primary hover:underline text-[11px]">
                <MapPin className="w-3 h-3 shrink-0" />
                {file.gpsLatitude!.toFixed(5)}, {file.gpsLongitude!.toFixed(5)}
              </a>
            </InfoRow>
          )}
        </InfoSection>
      )}

      {file.mediaType === "video" && (
        <InfoSection title="Video">
          <div className="grid grid-cols-2 gap-2.5">
            {file.width != null && file.height != null && <InfoRow label="Resolution">{`${file.width} × ${file.height}`}</InfoRow>}
            {file.durationSeconds != null && <InfoRow label="Duration">{fmtDur(file.durationSeconds)}</InfoRow>}
            {file.fps != null && <InfoRow label="FPS">{`${file.fps} fps`}</InfoRow>}
            {file.videoCodec && <InfoRow label="Video"><span className="font-mono uppercase">{file.videoCodec}</span></InfoRow>}
            {file.audioCodec && <InfoRow label="Audio"><span className="font-mono uppercase">{file.audioCodec}</span></InfoRow>}
            {file.videoBitrate != null && <InfoRow label="Bitrate">{`${file.videoBitrate} kbps`}</InfoRow>}
          </div>
        </InfoSection>
      )}

      {file.mediaType === "audio" && file.durationSeconds != null && (
        <InfoSection title="Audio"><InfoRow label="Duration">{fmtDur(file.durationSeconds)}</InfoRow></InfoSection>
      )}

      {file.extension === "pdf" && (
        <InfoSection title="Document">
          <div className="grid grid-cols-2 gap-2.5">
            {file.pageCount != null && <InfoRow label="Pages">{`${file.pageCount}`}</InfoRow>}
            {file.modifiedAt && <InfoRow label="Modified">{fmtDate(file.modifiedAt)}</InfoRow>}
          </div>
          {file.pdfTitle   && <InfoRow label="Title">{file.pdfTitle}</InfoRow>}
          {file.pdfAuthor  && <InfoRow label="Author">{file.pdfAuthor}</InfoRow>}
          {file.pdfSubject && <InfoRow label="Subject">{file.pdfSubject}</InfoRow>}
        </InfoSection>
      )}

      <InfoSection title="Indexed"><InfoRow label="Date">{fmtDate(file.indexedAt)}</InfoRow></InfoSection>
    </div>
  );
}

// ─── Filmstrip ────────────────────────────────────────────────────────────────

function Filmstrip({ files, currentIndex, onSelect }: {
  files: MediaFile[]; currentIndex: number; onSelect: (i: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current?.children[currentIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIndex]);

  return (
    <div ref={stripRef} className="flex gap-1.5 overflow-x-auto px-4 py-2" style={{ scrollbarWidth: "none" }}>
      {files.map((f, i) => (
        <button key={f.id} onClick={() => onSelect(i)}
          className={cn(
            "shrink-0 w-12 h-12 rounded overflow-hidden border-2 transition-all",
            i === currentIndex ? "border-primary scale-110" : "border-transparent opacity-50 hover:opacity-80",
          )}
        >
          {(f.mediaType === "photo" || f.mediaType === "video" || f.extension === "pdf") ? (
            <img src={`${API}/media/thumbnail/${f.id}`} alt={f.name} className="w-full h-full object-cover" draggable={false} />
          ) : (
            <div className="w-full h-full bg-muted flex items-center justify-center">
              {f.mediaType === "audio" ? <Music className="w-4 h-4 text-muted-foreground" />
               : f.mediaType === "document" ? <FileText className="w-4 h-4 text-muted-foreground" />
               : <File className="w-4 h-4 text-muted-foreground" />}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Rename dialog ────────────────────────────────────────────────────────────

function RenameDialog({ file, onDone, onCancel }: {
  file: MediaFile;
  onDone: (newName: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(file.name);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => { inp.current?.select(); }, []);

  const submit = async () => {
    const name = val.trim();
    if (!name) { setErr("Name cannot be empty"); return; }
    setBusy(true);
    try {
      await rename(file.id, name);
      onDone(name);
    } catch (e: any) {
      setErr(e.message ?? "Rename failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-card border border-border rounded-lg shadow-xl p-5 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold">Rename file</p>
        <input
          ref={inp}
          value={val}
          onChange={(e) => { setVal(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
          className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          disabled={busy}
        />
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-muted" disabled={busy}>Cancel</button>
          <button onClick={submit} disabled={busy || !val.trim()} className="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1">
            {busy && <Loader2 className="w-3 h-3 animate-spin" />} Rename
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete confirm ───────────────────────────────────────────────────────────

function DeleteConfirm({ file, onConfirm, onCancel }: {
  file: MediaFile; onConfirm: () => void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { await softDelete(file.id); onConfirm(); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-card border border-border rounded-lg shadow-xl p-5 w-72 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <p className="text-sm font-semibold">Remove from library?</p>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{file.name}</span> will be hidden from Willard. The file on your NAS is not deleted.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-muted" disabled={busy}>Cancel</button>
          <button onClick={confirm} disabled={busy} className="px-3 py-1.5 rounded text-sm bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 flex items-center gap-1">
            {busy && <Loader2 className="w-3 h-3 animate-spin" />} Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main viewer ──────────────────────────────────────────────────────────────

export interface MediaViewerProps {
  files: MediaFile[];
  initialIndex: number;
  onClose: () => void;
  onFavoriteChange?: (id: number, fav: boolean) => void;
  onDelete?: (id: number) => void;
}

export function MediaViewer({ files, initialIndex, onClose, onFavoriteChange, onDelete }: MediaViewerProps) {
  const [idx,          setIdx]          = useState(() => clamp(initialIndex, 0, files.length - 1));
  const [showInfo,     setShowInfo]     = useState(false);
  const [showFilm,     setShowFilm]     = useState(files.length > 1);
  const [controlsVis,  setControlsVis]  = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [favPending,   setFavPending]   = useState(false);
  const [showRename,   setShowRename]   = useState(false);
  const [showDelete,   setShowDelete]   = useState(false);
  const [entered,      setEntered]      = useState(false);

  const videoRef      = useRef<HTMLVideoElement>(null);
  const hideTimer     = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef  = useRef<HTMLDivElement>(null);

  const file    = files[idx];
  const hasPrev = idx > 0;
  const hasNext = idx < files.length - 1;

  // Fade-in
  useEffect(() => { requestAnimationFrame(() => setEntered(true)); }, []);

  // Controls auto-hide (photos only)
  const isPhoto = file?.mediaType === "photo";

  const showControls = useCallback(() => {
    setControlsVis(true);
    clearTimeout(hideTimer.current);
    if (isPhoto) {
      hideTimer.current = setTimeout(() => setControlsVis(false), 3000);
    }
  }, [isPhoto]);

  useEffect(() => {
    if (!isPhoto) { setControlsVis(true); clearTimeout(hideTimer.current); }
    else showControls();
    return () => clearTimeout(hideTimer.current);
  }, [isPhoto, showControls]);

  const goPrev = useCallback(() => { if (hasPrev) setIdx((i) => i - 1); }, [hasPrev]);
  const goNext = useCallback(() => { if (hasNext) setIdx((i) => i + 1); }, [hasNext]);

  const handlePrevNext = useCallback((d: -1 | 1) => {
    if (d === -1) goPrev(); else goNext();
  }, [goPrev, goNext]);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showRename || showDelete) return;
      showControls();
      switch (e.key) {
        case "Escape":     e.preventDefault(); onClose(); break;
        case "ArrowLeft":  e.preventDefault(); goPrev(); break;
        case "ArrowRight": e.preventDefault(); goNext(); break;
        case "Home":       e.preventDefault(); setIdx(0); break;
        case "End":        e.preventDefault(); setIdx(files.length - 1); break;
        case " ":
          e.preventDefault();
          if (videoRef.current) { videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause(); }
          break;
        case "f": case "F":
          e.preventDefault();
          if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
          else document.exitFullscreen();
          break;
        case "i": case "I": setShowInfo((v) => !v); break;
        case "+": case "=": break; // handled inside PhotoView via wheel
        case "-": break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, onClose, files.length, showControls, showRename, showDelete]);

  // Fullscreen change
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleFavorite = async () => {
    if (favPending || !file) return;
    setFavPending(true);
    try {
      const newFav = !file.favorite;
      await toggleFav(file.id, newFav);
      onFavoriteChange?.(file.id, newFav);
      // Optimistic update in local files array
      (file as any).favorite = newFav;
    } finally {
      setFavPending(false);
    }
  };

  const handleDeleteDone = () => {
    setShowDelete(false);
    onDelete?.(file.id);
    if (files.length <= 1) { onClose(); return; }
    if (hasNext) goNext(); else goPrev();
  };

  const handleRenameDone = (newName: string) => {
    setShowRename(false);
    (file as any).name = newName;
  };

  if (!file) return null;

  const ctrlClass = cn(
    "transition-opacity duration-300",
    controlsVis ? "opacity-100" : "opacity-0 pointer-events-none",
  );

  return createPortal(
    <>
      <div
        ref={containerRef}
        className={cn(
          "fixed inset-0 z-50 flex flex-col bg-black/97 transition-opacity duration-200",
          entered ? "opacity-100" : "opacity-0",
        )}
        role="dialog"
        aria-modal
        aria-label={`Viewing ${file.name}`}
        onMouseMove={showControls}
        onPointerDown={showControls}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* ── Top bar ── */}
        <div className={cn("flex items-center gap-2 px-3 py-2.5 bg-black/70 backdrop-blur-sm shrink-0", ctrlClass)}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-mono text-white truncate">{file.name}</p>
            <p className="text-[10px] text-white/40 font-mono truncate">{file.relativePath}</p>
          </div>

          <span className="text-xs text-white/40 font-mono shrink-0 hidden sm:block">
            {idx + 1} / {files.length}
          </span>

          <div className="flex items-center gap-0.5 shrink-0">
            {/* Favorite */}
            <button
              onClick={handleFavorite}
              disabled={favPending}
              title={file.favorite ? "Remove favorite" : "Add favorite"}
              className="p-2 rounded transition-colors hover:bg-white/10"
            >
              <Heart className={cn("w-4 h-4 transition-colors", file.favorite ? "text-red-400 fill-red-400" : "text-white/60 hover:text-white")} />
            </button>
            {/* Detail page */}
            <Link href={`/media/${file.id}`} onClick={onClose}>
              <button title="Open detail page" className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors">
                <Maximize2 className="w-4 h-4" />
              </button>
            </Link>
            {/* Map */}
            {file.gpsLatitude != null && (
              <a
                href={`https://www.google.com/maps?q=${file.gpsLatitude},${file.gpsLongitude}`}
                target="_blank" rel="noopener noreferrer"
                title="Show on map"
                className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <MapPin className="w-4 h-4" />
              </a>
            )}
            {/* Download */}
            <a
              href={`${API}/media/file/${file.id}/stream`}
              download={file.name}
              title="Download"
              className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Download className="w-4 h-4" />
            </a>
            {/* Rename */}
            <button
              onClick={() => setShowRename(true)}
              title="Rename"
              className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              <PencilLine className="w-4 h-4" />
            </button>
            {/* Delete */}
            <button
              onClick={() => setShowDelete(true)}
              title="Remove from library"
              className="p-2 rounded text-white/60 hover:text-red-400 hover:bg-white/10 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            {/* Open original */}
            <a
              href={`${API}/media/file/${file.id}/stream`}
              target="_blank" rel="noopener noreferrer"
              title="Open original"
              className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors hidden sm:flex"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            {/* Fullscreen */}
            <button
              onClick={() => {
                if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
                else document.exitFullscreen();
              }}
              title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
              className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors hidden sm:flex"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            {/* Info */}
            <button
              onClick={() => setShowInfo((v) => !v)}
              title="Info (I)"
              className={cn("p-2 rounded transition-colors", showInfo ? "bg-primary/20 text-primary" : "text-white/60 hover:text-white hover:bg-white/10")}
            >
              <Info className="w-4 h-4" />
            </button>
            {/* Close */}
            <button onClick={onClose} title="Close (Esc)" className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors ml-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Content area ── */}
        <div className="flex flex-1 overflow-hidden relative">
          {/* Left arrow */}
          <button
            onClick={goPrev}
            disabled={!hasPrev}
            className={cn(
              "absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 backdrop-blur-sm transition-all",
              hasPrev ? "text-white hover:bg-black/80 hover:scale-110" : "text-white/20 cursor-not-allowed",
              ctrlClass,
            )}
            aria-label="Previous"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          {/* Media */}
          <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
            {file.mediaType === "photo"                ? <PhotoView file={file} onPrevNext={handlePrevNext} /> :
             file.mediaType === "video"                ? <VideoView file={file} videoRef={videoRef} /> :
             file.mediaType === "audio"                ? <AudioView file={file} /> :
             file.extension?.toLowerCase() === "pdf"   ? <PdfView file={file} /> :
                                                         <GenericView file={file} />}
          </div>

          {/* Right arrow */}
          <button
            onClick={goNext}
            disabled={!hasNext}
            className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 backdrop-blur-sm transition-all",
              hasNext ? "text-white hover:bg-black/80 hover:scale-110" : "text-white/20 cursor-not-allowed",
              showInfo ? "right-[290px]" : "right-2",
              ctrlClass,
            )}
            aria-label="Next"
          >
            <ChevronRight className="w-6 h-6" />
          </button>

          {/* Info panel */}
          {showInfo && (
            <div className="w-72 shrink-0 border-l border-border bg-card/95 backdrop-blur-sm overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest">Info</span>
                <button onClick={() => setShowInfo(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <InfoPanel file={file} />
            </div>
          )}
        </div>

        {/* ── Bottom bar: filename + filmstrip toggle ── */}
        <div className={cn("shrink-0 bg-black/70 backdrop-blur-sm border-t border-white/10", ctrlClass)}>
          <div className="flex items-center gap-3 px-4 py-1.5">
            <div className="flex-1 min-w-0">
              {file.dateTaken && (
                <p className="text-[10px] text-white/40 font-mono truncate flex items-center gap-1">
                  <Calendar className="w-3 h-3" />{fmtDate(file.dateTaken)}
                  {file.cameraMake && <><span className="mx-1">·</span><Camera className="w-3 h-3" />{camLabel(file.cameraMake, file.cameraModel)}</>}
                  {file.gpsLatitude != null && (
                    <>
                      <span className="mx-1">·</span>
                      <MapPin className="w-3 h-3" />
                      {(file as any).placeName ?? `${file.gpsLatitude.toFixed(3)}, ${file.gpsLongitude!.toFixed(3)}`}
                    </>
                  )}
                </p>
              )}
            </div>
            {files.length > 1 && (
              <button
                onClick={() => setShowFilm((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/60 font-mono transition-colors shrink-0"
              >
                <FolderOpen className="w-3 h-3" />
                {showFilm ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              </button>
            )}
          </div>

          {/* Filmstrip */}
          {showFilm && files.length > 1 && (
            <Filmstrip files={files} currentIndex={idx} onSelect={setIdx} />
          )}
        </div>

        {/* Preload adjacent */}
        <Preloader files={files} currentIndex={idx} />
      </div>

      {/* Rename/Delete overlays */}
      {showRename && <RenameDialog file={file} onDone={handleRenameDone} onCancel={() => setShowRename(false)} />}
      {showDelete && <DeleteConfirm file={file} onConfirm={handleDeleteDone} onCancel={() => setShowDelete(false)} />}
    </>,
    document.body,
  );
}
