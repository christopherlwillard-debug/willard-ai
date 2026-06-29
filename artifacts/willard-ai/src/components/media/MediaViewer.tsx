import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  X, ChevronLeft, ChevronRight, Info, Download, ExternalLink,
  Music, FileText, File, ImageIcon, MapPin, Camera, Calendar, Aperture,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaFile } from "@/types/media";

interface MediaViewerProps {
  files: MediaFile[];
  initialIndex: number;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function cameraLabel(make: string | null, model: string | null): string | null {
  if (!make && !model) return null;
  if (!make) return model;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}

// ── Media content area ────────────────────────────────────────────────────────

function PhotoView({ file }: { file: MediaFile }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => { setLoaded(false); setError(false); }, [file.id]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <ImageIcon className="w-16 h-16" />
        <span className="text-sm font-mono">Could not load image</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {/* Low-res thumbnail shown while full-res loads */}
      {!loaded && (
        <img
          src={`/api/media/thumbnail/${file.id}`}
          alt={file.name}
          className="max-w-full max-h-full object-contain absolute inset-0 m-auto blur-sm scale-105 opacity-60"
        />
      )}
      <img
        src={`/api/media/file/${file.id}/stream`}
        alt={file.name}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        className={cn(
          "max-w-full max-h-full object-contain transition-opacity duration-300 select-none",
          loaded ? "opacity-100" : "opacity-0",
        )}
        draggable={false}
      />
    </div>
  );
}

function VideoView({ file }: { file: MediaFile }) {
  return (
    <video
      key={file.id}
      src={`/api/media/file/${file.id}/stream`}
      controls
      autoPlay
      className="max-w-full max-h-full rounded"
      style={{ maxHeight: "100%", maxWidth: "100%" }}
    />
  );
}

function AudioView({ file }: { file: MediaFile }) {
  return (
    <div className="flex flex-col items-center gap-6 px-8 text-center">
      <div className="w-32 h-32 rounded-2xl bg-muted flex items-center justify-center">
        <Music className="w-16 h-16 text-muted-foreground" />
      </div>
      <div>
        <p className="text-white font-semibold text-lg truncate max-w-md">{file.name}</p>
        {file.durationSeconds != null && (
          <p className="text-muted-foreground text-sm font-mono mt-1">{formatDuration(file.durationSeconds)}</p>
        )}
      </div>
      <audio
        key={file.id}
        src={`/api/media/file/${file.id}/stream`}
        controls
        autoPlay
        className="w-full max-w-sm"
      />
    </div>
  );
}

function PdfView({ file }: { file: MediaFile }) {
  return (
    <iframe
      key={file.id}
      src={`/api/media/file/${file.id}/stream`}
      title={file.name}
      className="w-full h-full rounded bg-white"
      style={{ maxWidth: "90vw", maxHeight: "80vh" }}
    />
  );
}

function GenericView({ file }: { file: MediaFile }) {
  return (
    <div className="flex flex-col items-center gap-4 text-muted-foreground">
      {file.mediaType === "document"
        ? <FileText className="w-20 h-20" />
        : <File className="w-20 h-20" />}
      <p className="text-white font-mono text-sm">{file.name}</p>
      <p className="text-xs">{formatBytes(file.sizeBytes)}</p>
    </div>
  );
}

function MediaContent({ file }: { file: MediaFile }) {
  if (file.mediaType === "photo") return <PhotoView file={file} />;
  if (file.mediaType === "video") return <VideoView file={file} />;
  if (file.mediaType === "audio") return <AudioView file={file} />;
  if (file.extension === "pdf")   return <PdfView file={file} />;
  return <GenericView file={file} />;
}

// ── Info panel ────────────────────────────────────────────────────────────────

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
  const camera  = cameraLabel(file.cameraMake, file.cameraModel);
  const hasGps  = file.gpsLatitude != null && file.gpsLongitude != null;
  const mapsUrl = hasGps ? `https://www.google.com/maps?q=${file.gpsLatitude},${file.gpsLongitude}` : null;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5 text-sm">

      <InfoSection title="File">
        <InfoRow label="Name"><span className="break-all">{file.name}</span></InfoRow>
        <InfoRow label="Path"><span className="text-muted-foreground font-mono text-[11px] break-all">{file.relativePath}</span></InfoRow>
        <div className="grid grid-cols-2 gap-2.5">
          <InfoRow label="Size">{formatBytes(file.sizeBytes)}</InfoRow>
          <InfoRow label="Format"><span className="font-mono uppercase">.{file.extension || "—"}</span></InfoRow>
        </div>
      </InfoSection>

      {file.mediaType === "photo" && (
        <InfoSection title="Photo">
          <div className="grid grid-cols-2 gap-2.5">
            {file.width != null && file.height != null && (
              <InfoRow label="Resolution">{`${file.width} × ${file.height}`}</InfoRow>
            )}
            {file.dateTaken && (
              <InfoRow label="Date Taken">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-muted-foreground shrink-0" />
                  {formatDate(file.dateTaken)}
                </span>
              </InfoRow>
            )}
            {file.iso != null && <InfoRow label="ISO">{`ISO ${file.iso}`}</InfoRow>}
            {file.aperture != null && (
              <InfoRow label="Aperture">
                <span className="flex items-center gap-1">
                  <Aperture className="w-3 h-3 text-muted-foreground shrink-0" />
                  {`ƒ/${file.aperture % 1 === 0 ? file.aperture : file.aperture.toFixed(1)}`}
                </span>
              </InfoRow>
            )}
            {file.exposure && <InfoRow label="Exposure">{file.exposure}</InfoRow>}
            {file.focalLength != null && <InfoRow label="Focal Length">{`${file.focalLength}mm`}</InfoRow>}
            {file.flash && <InfoRow label="Flash">{file.flash}</InfoRow>}
          </div>
          {camera && (
            <InfoRow label="Camera">
              <span className="flex items-center gap-1">
                <Camera className="w-3 h-3 text-muted-foreground shrink-0" />
                {camera}
              </span>
            </InfoRow>
          )}
          {file.lens && <InfoRow label="Lens">{file.lens}</InfoRow>}
          {file.colorProfile && <InfoRow label="Color">{file.colorProfile}</InfoRow>}
          {hasGps && (
            <InfoRow label="Location">
              <a href={mapsUrl!} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-primary hover:underline">
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
            {file.durationSeconds != null && <InfoRow label="Duration">{formatDuration(file.durationSeconds)}</InfoRow>}
            {file.fps != null && <InfoRow label="FPS">{`${file.fps} fps`}</InfoRow>}
            {file.videoCodec && <InfoRow label="Video"><span className="font-mono uppercase">{file.videoCodec}</span></InfoRow>}
            {file.audioCodec && <InfoRow label="Audio"><span className="font-mono uppercase">{file.audioCodec}</span></InfoRow>}
            {file.videoBitrate != null && <InfoRow label="Bitrate">{`${file.videoBitrate} kbps`}</InfoRow>}
          </div>
        </InfoSection>
      )}

      {file.mediaType === "audio" && file.durationSeconds != null && (
        <InfoSection title="Audio">
          <InfoRow label="Duration">{formatDuration(file.durationSeconds)}</InfoRow>
        </InfoSection>
      )}

      {file.extension === "pdf" && (
        <InfoSection title="Document">
          <div className="grid grid-cols-2 gap-2.5">
            {file.pageCount != null && <InfoRow label="Pages">{`${file.pageCount}`}</InfoRow>}
            {file.modifiedAt && <InfoRow label="Modified">{formatDate(file.modifiedAt)}</InfoRow>}
          </div>
          {file.pdfTitle   && <InfoRow label="Title">{file.pdfTitle}</InfoRow>}
          {file.pdfAuthor  && <InfoRow label="Author">{file.pdfAuthor}</InfoRow>}
          {file.pdfSubject && <InfoRow label="Subject">{file.pdfSubject}</InfoRow>}
        </InfoSection>
      )}

      <InfoSection title="Indexed">
        <InfoRow label="Date">{formatDate(file.indexedAt)}</InfoRow>
      </InfoSection>
    </div>
  );
}

// ── Filmstrip ─────────────────────────────────────────────────────────────────

function Filmstrip({ files, currentIndex, onSelect }: {
  files: MediaFile[];
  currentIndex: number;
  onSelect: (i: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current?.children[currentIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIndex]);

  return (
    <div
      ref={stripRef}
      className="flex gap-1.5 overflow-x-auto px-4 py-2 scrollbar-hide"
      style={{ scrollbarWidth: "none" }}
    >
      {files.map((f, i) => (
        <button
          key={f.id}
          onClick={() => onSelect(i)}
          className={cn(
            "shrink-0 w-12 h-12 rounded overflow-hidden border-2 transition-all",
            i === currentIndex
              ? "border-primary scale-110"
              : "border-transparent opacity-50 hover:opacity-80",
          )}
        >
          {(f.mediaType === "photo" || f.mediaType === "video" || f.extension === "pdf") ? (
            <img
              src={`/api/media/thumbnail/${f.id}`}
              alt={f.name}
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full bg-muted flex items-center justify-center">
              {f.mediaType === "audio"    ? <Music    className="w-4 h-4 text-muted-foreground" /> :
               f.mediaType === "document" ? <FileText className="w-4 h-4 text-muted-foreground" /> :
               <File className="w-4 h-4 text-muted-foreground" />}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main viewer ───────────────────────────────────────────────────────────────

export function MediaViewer({ files, initialIndex, onClose }: MediaViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(() => Math.max(0, Math.min(initialIndex, files.length - 1)));
  const [showInfo,     setShowInfo]     = useState(false);

  const file = files[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1;

  const goPrev = useCallback(() => setCurrentIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setCurrentIndex((i) => Math.min(files.length - 1, i + 1)), [files.length]);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape")      { e.preventDefault(); onClose(); }
      if (e.key === "ArrowLeft")   { e.preventDefault(); goPrev(); }
      if (e.key === "ArrowRight")  { e.preventDefault(); goNext(); }
      if (e.key === "i" || e.key === "I") { setShowInfo((v) => !v); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, onClose]);

  // Trap scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!file) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${file.name}`}
    >
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-black/60 backdrop-blur-sm shrink-0">
        {/* Filename + counter */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-mono text-white truncate">{file.name}</p>
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">{file.relativePath}</p>
        </div>

        <span className="text-xs text-muted-foreground font-mono shrink-0">
          {currentIndex + 1} / {files.length}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowInfo((v) => !v)}
            title="Toggle info (I)"
            className={cn(
              "p-2 rounded transition-colors",
              showInfo ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-white",
            )}
          >
            <Info className="w-4 h-4" />
          </button>
          <a
            href={`/api/media/file/${file.id}/stream`}
            download={file.name}
            title="Download"
            className="p-2 rounded text-muted-foreground hover:text-white transition-colors"
          >
            <Download className="w-4 h-4" />
          </a>
          <a
            href={`/api/media/file/${file.id}/stream`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open original"
            className="p-2 rounded text-muted-foreground hover:text-white transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-2 rounded text-muted-foreground hover:text-white transition-colors ml-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Content area ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left nav arrow */}
        <button
          onClick={goPrev}
          disabled={!hasPrev}
          className={cn(
            "absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 backdrop-blur-sm transition-all",
            hasPrev
              ? "text-white hover:bg-black/80 hover:scale-110"
              : "text-muted-foreground/30 cursor-not-allowed",
          )}
          aria-label="Previous"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>

        {/* Media */}
        <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
          <MediaContent file={file} />
        </div>

        {/* Right nav arrow */}
        <button
          onClick={goNext}
          disabled={!hasNext}
          className={cn(
            "absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 backdrop-blur-sm transition-all",
            hasNext
              ? "text-white hover:bg-black/80 hover:scale-110"
              : "text-muted-foreground/30 cursor-not-allowed",
            showInfo && "right-[288px]",
          )}
          aria-label="Next"
        >
          <ChevronRight className="w-6 h-6" />
        </button>

        {/* Info panel */}
        {showInfo && (
          <div className="w-72 shrink-0 border-l border-border bg-card/90 backdrop-blur-sm overflow-hidden flex flex-col">
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

      {/* ── Filmstrip ── */}
      {files.length > 1 && (
        <div className="shrink-0 bg-black/60 backdrop-blur-sm border-t border-white/10">
          <Filmstrip files={files} currentIndex={currentIndex} onSelect={setCurrentIndex} />
        </div>
      )}
    </div>,
    document.body,
  );
}
