import { useState } from "react";
import {
  useGetImmichStatus, getGetImmichStatusQueryKey,
  useGetImmichRecentPhotos, getGetImmichRecentPhotosQueryKey,
  useGetImmichAlbums, getGetImmichAlbumsQueryKey,
  useGetImmichPeople, getGetImmichPeopleQueryKey,
  useGetSettings, getGetSettingsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Image as ImageIcon, Video, Folder, Users, ExternalLink } from "lucide-react";

function immichUrl(baseUrl: string | undefined, path: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export default function Media() {
  const { data: status, isLoading: statusLoading } = useGetImmichStatus({
    query: { queryKey: getGetImmichStatusQueryKey() },
  });

  const { data: settings } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });

  const immichBase = settings?.immichBaseUrl ?? "";

  const { data: photos, isLoading: photosLoading } = useGetImmichRecentPhotos(
    { limit: 24 },
    { query: { queryKey: getGetImmichRecentPhotosQueryKey({ limit: 24 }), enabled: status?.connected === true } }
  );

  const { data: albums, isLoading: albumsLoading } = useGetImmichAlbums({
    query: { queryKey: getGetImmichAlbumsQueryKey(), enabled: status?.connected === true },
  });

  const { data: people, isLoading: peopleLoading } = useGetImmichPeople({
    query: { queryKey: getGetImmichPeopleQueryKey(), enabled: status?.connected === true },
  });

  if (statusLoading) return <Skeleton className="w-full h-96" />;

  if (!status?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center">
        <Activity className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold mb-2 font-mono">IMMICH_DISCONNECTED</h2>
        <p className="text-muted-foreground text-sm">Configure Immich URL and API key in Settings to view your media library.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold font-mono tracking-tight">MEDIA_CENTER</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center space-x-2 text-sm font-mono text-green-500">
            <Activity className="h-4 w-4" />
            <span>IMMICH CONNECTED</span>
          </div>
          {immichBase && (
            <a
              href={immichBase}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-primary transition-colors border border-border rounded px-2 py-1"
            >
              <ExternalLink className="w-3 h-3" /> Open Immich
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Photos", value: status.photoCount, icon: ImageIcon },
          { label: "Videos", value: status.videoCount, icon: Video },
          { label: "Albums", value: status.albumCount, icon: Folder },
          { label: "People", value: status.personCount, icon: Users },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <div className="p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-mono">{label.toUpperCase()}</p>
                <p className="text-2xl font-bold mt-1">{value.toLocaleString()}</p>
              </div>
              <Icon className="h-6 w-6 text-muted-foreground" />
            </div>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="recent" className="w-full">
        <TabsList>
          <TabsTrigger value="recent">Recent Media</TabsTrigger>
          <TabsTrigger value="albums">Albums</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>

        <TabsContent value="recent" className="mt-4">
          {photosLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {[...Array(12)].map((_, i) => <Skeleton key={i} className="aspect-square w-full rounded-md" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {photos?.map((asset) => {
                const link = immichUrl(immichBase, `/photos/${asset.id}`);
                const inner = (
                  <div className="relative aspect-square group overflow-hidden rounded-md bg-secondary cursor-pointer">
                    {asset.thumbUrl ? (
                      <img
                        src={asset.thumbUrl}
                        alt={asset.filename}
                        className="object-cover w-full h-full transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        {(asset as any).type === "video"
                          ? <Video className="h-8 w-8 text-muted-foreground" />
                          : <ImageIcon className="h-8 w-8 text-muted-foreground" />}
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                      <ExternalLink className="w-5 h-5 text-white" />
                    </div>
                  </div>
                );
                return link ? (
                  <a key={asset.id} href={link} target="_blank" rel="noopener noreferrer" title={`Open ${asset.filename} in Immich`}>
                    {inner}
                  </a>
                ) : (
                  <div key={asset.id}>{inner}</div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="albums" className="mt-4">
          {albumsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-48 w-full rounded-md" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {albums?.map((album) => {
                const link = immichUrl(immichBase, `/albums/${album.id}`);
                const card = (
                  <Card className="overflow-hidden hover:ring-1 hover:ring-primary transition-all cursor-pointer group">
                    <div className="aspect-[3/2] bg-secondary relative overflow-hidden">
                      {album.thumbUrl ? (
                        <img
                          src={album.thumbUrl}
                          alt={album.albumName}
                          className="object-cover w-full h-full group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Folder className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <ExternalLink className="w-3.5 h-3.5 text-white drop-shadow" />
                      </div>
                    </div>
                    <CardContent className="p-3">
                      <h3 className="font-medium truncate text-sm">{album.albumName}</h3>
                      <p className="text-xs text-muted-foreground">{album.assetCount} items</p>
                    </CardContent>
                  </Card>
                );
                return link ? (
                  <a key={album.id} href={link} target="_blank" rel="noopener noreferrer">{card}</a>
                ) : (
                  <div key={album.id}>{card}</div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="people" className="mt-4">
          {peopleLoading ? (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="aspect-square w-full rounded-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              {people?.map((person) => {
                const link = immichUrl(immichBase, `/people/${person.id}`);
                const card = (
                  <div className="flex flex-col items-center space-y-2 group cursor-pointer">
                    <div className="w-20 h-20 rounded-full overflow-hidden bg-secondary ring-2 ring-transparent group-hover:ring-primary transition-all relative">
                      {person.thumbUrl ? (
                        <img src={person.thumbUrl} alt={person.name} className="object-cover w-full h-full" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Users className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="text-center">
                      <p className="font-medium text-sm truncate w-20">{person.name}</p>
                      <p className="text-xs text-muted-foreground">{person.assetCount}</p>
                    </div>
                  </div>
                );
                return link ? (
                  <a key={person.id} href={link} target="_blank" rel="noopener noreferrer">{card}</a>
                ) : (
                  <div key={person.id}>{card}</div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
