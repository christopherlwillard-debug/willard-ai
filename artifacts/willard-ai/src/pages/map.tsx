import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowUpRight,
  Compass,
  Crosshair,
  Globe2,
  Image as ImageIcon,
  Info,
  Layers3,
  MapPin,
  MapPinned,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchMediaMap, type MediaMapItem } from "@/lib/media-map";

const TILE_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 10;
const CLUSTER_RADIUS = 52;

type Coordinate = { lat: number; lon: number };
type ScreenPoint = MediaMapItem & { x: number; y: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function project({ lat, lon }: Coordinate, zoom: number) {
  const size = TILE_SIZE * 2 ** zoom;
  const safeLat = clamp(lat, -85.05112878, 85.05112878);
  const sin = Math.sin((safeLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function fitMap(items: MediaMapItem[], width: number, height: number) {
  if (items.length === 0) return { center: { lat: 20, lon: 0 }, zoom: 2 };
  if (items.length === 1) {
    return { center: { lat: items[0].latitude, lon: items[0].longitude }, zoom: 5 };
  }

  const center = items.reduce(
    (sum, item) => ({ lat: sum.lat + item.latitude, lon: sum.lon + item.longitude }),
    { lat: 0, lon: 0 },
  );
  center.lat /= items.length;
  center.lon /= items.length;

  let bestZoom = MIN_ZOOM;
  for (let zoom = MIN_ZOOM; zoom <= 7; zoom += 1) {
    const points = items.map((item) => project({ lat: item.latitude, lon: item.longitude }, zoom));
    const spanX = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    const spanY = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
    if (spanX <= width * 0.72 && spanY <= height * 0.68) bestZoom = zoom;
  }

  return { center, zoom: bestZoom };
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function MapTiles({ center, zoom, width, height }: { center: Coordinate; zoom: number; width: number; height: number }) {
  const worldSize = TILE_SIZE * 2 ** zoom;
  const centerWorld = project(center, zoom);
  const left = centerWorld.x - width / 2;
  const top = centerWorld.y - height / 2;
  const firstX = Math.floor(left / TILE_SIZE) - 1;
  const lastX = Math.ceil((left + width) / TILE_SIZE) + 1;
  const firstY = Math.max(0, Math.floor(top / TILE_SIZE) - 1);
  const lastY = Math.min(2 ** zoom - 1, Math.ceil((top + height) / TILE_SIZE) + 1);
  const tiles: { x: number; y: number; left: number; top: number }[] = [];

  for (let tileX = firstX; tileX <= lastX; tileX += 1) {
    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      tiles.push({
        x: ((tileX % 2 ** zoom) + 2 ** zoom) % 2 ** zoom,
        y: tileY,
        left: tileX * TILE_SIZE - left,
        top: tileY * TILE_SIZE - top,
      });
    }
  }

  return (
    <>
      <div className="map-grid absolute inset-0 opacity-70" />
      {tiles.map((tile, index) => (
        <img
          key={`${zoom}-${tile.x}-${tile.y}-${index}`}
          src={`https://tile.openstreetmap.org/${zoom}/${tile.x}/${tile.y}.png`}
          alt=""
          aria-hidden="true"
          className="map-tile absolute max-w-none select-none"
          style={{ width: TILE_SIZE, height: TILE_SIZE, left: tile.left, top: tile.top }}
        />
      ))}
      <div className="pointer-events-none absolute inset-0 bg-[#111a24]/35" />
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ background: "radial-gradient(circle at 50% 45%, transparent 12%, rgba(6, 12, 19, .52) 100%)" }}
      />
      <span className="absolute bottom-3 right-3 z-10 rounded-sm border border-white/15 bg-[#101923]/80 px-2 py-1 text-[9px] font-medium tracking-[0.12em] text-white/70 backdrop-blur-sm">
        © OpenStreetMap contributors
      </span>
      <span className="sr-only">{worldSize > 0 ? `Map at zoom level ${zoom}` : "Map"}</span>
    </>
  );
}

function MapMarker({
  item,
  onOpen,
  onHover,
}: {
  item: ScreenPoint;
  onOpen: (id: number) => void;
  onHover: (id: number) => void;
}) {
  return (
    <button
      type="button"
      className="map-marker absolute z-20 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#101923] bg-[#d88a4b] text-[#111820] shadow-[0_4px_14px_rgba(0,0,0,.35)] transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0b477]"
      style={{ left: item.x, top: item.y }}
      onClick={() => onOpen(item.id)}
      onMouseEnter={() => onHover(item.id)}
      onFocus={() => onHover(item.id)}
      aria-label={`Open ${item.name}${item.placeName ? ` at ${item.placeName}` : ""}`}
      data-testid={`marker-photo-${item.id}`}
    >
      <MapPin className="h-4 w-4" strokeWidth={2.5} />
    </button>
  );
}

function MapCluster({
  x,
  y,
  count,
  onZoom,
}: {
  x: number;
  y: number;
  count: number;
  onZoom: () => void;
}) {
  return (
    <button
      type="button"
      className="absolute z-30 flex h-12 min-w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#f0b477]/80 bg-[#ad633b]/95 px-2 text-sm font-bold text-[#fff0dd] shadow-[0_5px_22px_rgba(0,0,0,.4)] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0b477]"
      style={{ left: x, top: y }}
      onClick={onZoom}
      aria-label={`Zoom into ${count} photos`}
      data-testid={`cluster-${count}-${Math.round(x)}-${Math.round(y)}`}
    >
      {count}
    </button>
  );
}

export default function MapPage() {
  const [, navigate] = useLocation();
  const mapRef = useRef<HTMLDivElement>(null);
  const hasFitRef = useRef(false);
  const [viewport, setViewport] = useState({ width: 960, height: 570 });
  const [center, setCenter] = useState<Coordinate>({ lat: 20, lon: 0 });
  const [zoom, setZoom] = useState(2);
  const [popupId, setPopupId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mediaType, setMediaType] = useState("all");

  const mapQuery = useQuery({
    queryKey: ["media-map"],
    queryFn: ({ signal }) => fetchMediaMap(signal),
    staleTime: 30_000,
  });
  const items = useMemo(() => mapQuery.data?.items ?? [], [mapQuery.data]);
  const mediaTypes = useMemo(
    () => Array.from(new Set(items.map((item) => item.mediaType))).sort(),
    [items],
  );
  const filteredItems = useMemo(() => items.filter((item) => {
    const date = item.dateTaken?.slice(0, 10);
    return (
      (!dateFrom || (date != null && date >= dateFrom)) &&
      (!dateTo || (date != null && date <= dateTo)) &&
      (mediaType === "all" || item.mediaType === mediaType)
    );
  }), [dateFrom, dateTo, items, mediaType]);

  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setViewport({ width: Math.max(320, rect.width), height: Math.max(420, rect.height) });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (items.length > 0 && viewport.width > 0 && !hasFitRef.current) {
      const fitted = fitMap(items, viewport.width, viewport.height);
      setCenter(fitted.center);
      setZoom(fitted.zoom);
      hasFitRef.current = true;
    }
  }, [items, viewport]);

  useEffect(() => {
    if (popupId != null && !filteredItems.some((item) => item.id === popupId)) setPopupId(null);
  }, [filteredItems, popupId]);

  const projectedItems = useMemo(() => {
    const centerWorld = project(center, zoom);
    const worldSize = TILE_SIZE * 2 ** zoom;
    return filteredItems.map((item) => {
      const point = project({ lat: item.latitude, lon: item.longitude }, zoom);
      let dx = point.x - centerWorld.x;
      if (dx > worldSize / 2) dx -= worldSize;
      if (dx < -worldSize / 2) dx += worldSize;
      return { ...item, x: viewport.width / 2 + dx, y: viewport.height / 2 + point.y - centerWorld.y };
    });
  }, [center, filteredItems, viewport.height, viewport.width, zoom]);

  const clusters = useMemo(() => {
    const remaining = new Set(projectedItems.map((_, index) => index));
    const result: { items: ScreenPoint[]; x: number; y: number }[] = [];
    while (remaining.size > 0) {
      const firstIndex = remaining.values().next().value as number;
      remaining.delete(firstIndex);
      const group = [projectedItems[firstIndex]];
      const nearby = [...remaining].filter((index) => {
        const item = projectedItems[index];
        return Math.hypot(item.x - group[0].x, item.y - group[0].y) <= CLUSTER_RADIUS;
      });
      nearby.forEach((index) => {
        remaining.delete(index);
        group.push(projectedItems[index]);
      });
      result.push({
        items: group,
        x: group.reduce((sum, item) => sum + item.x, 0) / group.length,
        y: group.reduce((sum, item) => sum + item.y, 0) / group.length,
      });
    }
    return result;
  }, [projectedItems]);

  const selectedItem = popupId == null ? null : filteredItems.find((item) => item.id === popupId) ?? null;
  const placeCount = useMemo(() => new Set(filteredItems.map((item) => item.placeName).filter(Boolean)).size, [filteredItems]);
  const northCount = filteredItems.filter((item) => item.latitude >= 0).length;
  const southCount = filteredItems.length - northCount;
  const hasFilters = Boolean(dateFrom || dateTo || mediaType !== "all");
  const clearFilters = () => {
    setDateFrom("");
    setDateTo("");
    setMediaType("all");
  };

  const zoomIn = () => setZoom((value) => Math.min(MAX_ZOOM, value + 1));
  const zoomOut = () => setZoom((value) => Math.max(MIN_ZOOM, value - 1));
  const resetMap = () => {
    const fitted = fitMap(items, viewport.width, viewport.height);
    setCenter(fitted.center);
    setZoom(fitted.zoom);
    setPopupId(null);
  };
  const openItem = (id: number) => navigate(`/media/${id}`);
  const zoomCluster = (cluster: { items: ScreenPoint[]; x: number; y: number }) => {
    const nextZoom = Math.min(MAX_ZOOM, zoom + 2);
    const anchor = cluster.items[0];
    setCenter({ lat: anchor.latitude, lon: anchor.longitude });
    setZoom(nextZoom);
    setPopupId(null);
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground" data-testid="map-page">
      <div className="mx-auto max-w-[1680px] p-4 md:p-6 lg:p-8">
        <header className="mb-6 flex flex-col gap-5 border-b border-border/70 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[10px] font-medium tracking-[0.22em] text-primary">
              <MapPinned className="h-3.5 w-3.5" />
              LIBRARY / GEOGRAPHY
            </div>
            <h1 className="font-sans text-3xl font-extrabold tracking-[-0.04em] text-foreground md:text-4xl" data-testid="title-memory-map">
              Memory Atlas
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              A quiet index of the places your library has carried you. Select a pin to return to the moment.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-8 gap-2 border-primary/35 bg-primary/5 px-3 font-mono text-[10px] tracking-[0.12em] text-primary" data-testid="status-map-source">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              LIVE LIBRARY INDEX
            </Badge>
            <Button variant="outline" size="sm" onClick={() => mapQuery.refetch()} disabled={mapQuery.isFetching} data-testid="button-refresh-map">
              <RefreshCw className={mapQuery.isFetching ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        </header>

        {mapQuery.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <Skeleton className="h-[620px] rounded-xl" data-testid="skeleton-map" />
            <div className="space-y-4">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
            </div>
          </div>
        ) : mapQuery.isError ? (
          <Card className="border-destructive/30 bg-destructive/5" data-testid="state-map-error">
            <CardContent className="flex min-h-72 flex-col items-center justify-center gap-4 p-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-semibold">The atlas could not load</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {(mapQuery.error as Error)?.message ?? "The library map is unavailable right now."}
                </p>
              </div>
              <Button variant="outline" onClick={() => mapQuery.refetch()} data-testid="button-retry-map">
                <RefreshCw /> Try again
              </Button>
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card className="border-dashed border-primary/30 bg-primary/[0.03]" data-testid="state-map-empty">
            <CardContent className="flex min-h-96 flex-col items-center justify-center gap-4 p-8 text-center">
              <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-primary/35 bg-primary/10 text-primary">
                <Globe2 className="h-7 w-7" />
                <span className="absolute -right-1 top-0 h-2 w-2 rounded-full bg-primary" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">No mapped memories yet</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                  Photos with location data will settle here as your library is indexed. The rest of your collection remains untouched.
                </p>
              </div>
              <Button variant="outline" onClick={() => navigate("/media")} data-testid="button-browse-media">
                Browse media <ArrowUpRight />
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card data-testid="card-map-filters">
              <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-end">
                <div className="flex-1 space-y-2">
                  <Label htmlFor="map-date-from" className="text-xs text-muted-foreground">From date</Label>
                  <Input id="map-date-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} data-testid="input-map-date-from" />
                </div>
                <div className="flex-1 space-y-2">
                  <Label htmlFor="map-date-to" className="text-xs text-muted-foreground">To date</Label>
                  <Input id="map-date-to" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} data-testid="input-map-date-to" />
                </div>
                <div className="flex-1 space-y-2">
                  <Label htmlFor="map-media-type" className="text-xs text-muted-foreground">Media type</Label>
                  <Select value={mediaType} onValueChange={setMediaType}>
                    <SelectTrigger id="map-media-type" data-testid="select-map-media-type"><SelectValue placeholder="All media" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All media</SelectItem>
                      {mediaTypes.map((type) => <SelectItem key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {hasFilters && (
                  <Button type="button" variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-map-filters">
                    <X /> Clear filters
                  </Button>
                )}
              </CardContent>
            </Card>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <section className="relative overflow-hidden rounded-xl border border-border/80 bg-[#18232d] shadow-2xl shadow-black/20" data-testid="map-canvas">
              <div ref={mapRef} className="relative h-[calc(100dvh-250px)] min-h-[510px] max-h-[760px] w-full overflow-hidden">
                <MapTiles center={center} zoom={zoom} width={viewport.width} height={viewport.height} />
                <div className="absolute left-4 top-4 z-40 flex items-center gap-2 rounded-md border border-white/15 bg-[#101923]/90 px-3 py-2 text-[10px] font-medium tracking-[0.16em] text-white/80 shadow-lg backdrop-blur-sm">
                  <Crosshair className="h-3.5 w-3.5 text-[#f0b477]" />
                  WORLD VIEW <span className="text-white/35">/</span> Z{zoom}
                </div>
                <div className="absolute right-4 top-4 z-40 flex flex-col overflow-hidden rounded-md border border-white/15 bg-[#101923]/90 shadow-lg backdrop-blur-sm">
                  <button type="button" className="flex h-9 w-9 items-center justify-center text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-35" onClick={zoomIn} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" data-testid="button-zoom-in">
                    <Plus className="h-4 w-4" />
                  </button>
                  <div className="border-t border-white/10" />
                  <button type="button" className="flex h-9 w-9 items-center justify-center text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-35" onClick={zoomOut} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" data-testid="button-zoom-out">
                    <Minus className="h-4 w-4" />
                  </button>
                </div>

                {clusters.map((cluster, index) =>
                  cluster.items.length > 1 ? (
                    <MapCluster key={`cluster-${index}`} x={cluster.x} y={cluster.y} count={cluster.items.length} onZoom={() => zoomCluster(cluster)} />
                  ) : (
                    <MapMarker key={cluster.items[0].id} item={cluster.items[0]} onOpen={openItem} onHover={setPopupId} />
                  ),
                )}

                {selectedItem && (() => {
                  const marker = projectedItems.find((item) => item.id === selectedItem.id);
                  if (!marker || marker.x < -20 || marker.x > viewport.width + 20 || marker.y < -20 || marker.y > viewport.height + 20) return null;
                  return (
                    <div
                      className="absolute z-50 w-56 -translate-x-1/2 -translate-y-[calc(100%+26px)] rounded-lg border border-[#f0b477]/45 bg-[#101923]/95 p-3 text-left shadow-2xl shadow-black/40 backdrop-blur-md"
                      style={{ left: marker.x, top: marker.y }}
                      data-testid={`popup-marker-${selectedItem.id}`}
                    >
                      <button type="button" onClick={() => setPopupId(null)} className="absolute right-2 top-2 text-white/45 hover:text-white" aria-label="Close marker popup" data-testid="button-close-popup">
                        <X className="h-3.5 w-3.5" />
                      </button>
                      <p className="pr-5 text-xs font-semibold leading-snug text-white" data-testid={`text-marker-name-${selectedItem.id}`}>{selectedItem.name}</p>
                      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-[#f0b477]" data-testid={`text-marker-place-${selectedItem.id}`}>
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                        {selectedItem.placeName ?? `${selectedItem.latitude.toFixed(3)}, ${selectedItem.longitude.toFixed(3)}`}
                      </p>
                      <button type="button" onClick={() => openItem(selectedItem.id)} className="mt-3 flex items-center gap-1 text-[10px] font-semibold tracking-[0.08em] text-white/75 hover:text-white" data-testid={`button-open-marker-${selectedItem.id}`}>
                        OPEN PHOTO <ArrowUpRight className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })()}
                <div className="absolute bottom-4 left-4 z-40 flex items-center gap-1 rounded-md border border-white/15 bg-[#101923]/90 p-1 shadow-lg backdrop-blur-sm">
                  <button type="button" className="flex h-8 items-center gap-2 rounded px-2 text-[10px] font-medium tracking-[0.1em] text-white/75 transition hover:bg-white/10 hover:text-white" onClick={resetMap} data-testid="button-fit-map">
                    <Compass className="h-3.5 w-3.5 text-[#f0b477]" /> FIT LIBRARY
                  </button>
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <Card className="border-primary/20 bg-primary/[0.045]" data-testid="card-map-summary">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-[0.13em] text-muted-foreground">
                    <Layers3 className="h-4 w-4 text-primary" /> MAP INDEX
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                     <p className="font-mono text-3xl font-medium tracking-[-0.05em] text-foreground" data-testid="text-mapped-count">{formatCount(filteredItems.length)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">mapped memories</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-border/70 pt-3">
                    <div>
                      <p className="font-mono text-lg text-foreground" data-testid="text-place-count">{formatCount(placeCount)}</p>
                      <p className="text-[10px] text-muted-foreground">named places</p>
                    </div>
                    <div>
                      <p className="font-mono text-lg text-foreground" data-testid="text-cluster-count">{formatCount(clusters.length)}</p>
                      <p className="text-[10px] text-muted-foreground">visible groups</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-map-guide">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-[0.13em] text-muted-foreground">
                    <Info className="h-4 w-4 text-primary" /> READ THE ATLAS
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-xs text-muted-foreground">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#f0b477]/70 bg-[#ad633b] text-[#fff0dd]"><MapPin className="h-3 w-3" /></span>
                    <p><span className="font-medium text-foreground">A pin</span> is one mapped memory. Select it to open the original.</p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-[#f0b477]/70 bg-[#ad633b] px-1 text-[10px] font-bold text-[#fff0dd]">12</span>
                    <p><span className="font-medium text-foreground">A group</span> holds nearby photos. Select it to open the view.</p>
                  </div>
                  <div className="flex items-start gap-3 border-t border-border/70 pt-3">
                    <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <p>Only library items with location data appear here. Recycled files stay out of the index.</p>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-map-distribution">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-[0.13em] text-muted-foreground">
                    <Globe2 className="h-4 w-4 text-primary" /> LATITUDE SPLIT
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-label="Latitude distribution">
                     <span className="bg-[#7fa8bc]" style={{ width: `${filteredItems.length ? (northCount / filteredItems.length) * 100 : 0}%` }} />
                     <span className="bg-[#d88a4b]" style={{ width: `${filteredItems.length ? (southCount / filteredItems.length) * 100 : 0}%` }} />
                   </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-[10px]">
                    <div><span className="mb-1 block h-1.5 w-1.5 rounded-full bg-[#7fa8bc]" /><span className="font-mono text-foreground">{formatCount(northCount)}</span> north</div>
                    <div><span className="mb-1 block h-1.5 w-1.5 rounded-full bg-[#d88a4b]" /><span className="font-mono text-foreground">{formatCount(southCount)}</span> south</div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex items-center gap-2 px-1 text-[10px] tracking-[0.1em] text-muted-foreground">
                <Crosshair className="h-3.5 w-3.5 text-primary" />
                CENTER {center.lat.toFixed(2)}°, {center.lon.toFixed(2)}°
              </div>
            </aside>
            </div>
          </div>
        )}
    </div>
    </div>
  );
}