import { useState } from "react";
import { 
  useGetImmichStatus, getGetImmichStatusQueryKey,
  useGetImmichRecentPhotos, getGetImmichRecentPhotosQueryKey,
  useGetImmichAlbums, getGetImmichAlbumsQueryKey,
  useGetImmichPeople, getGetImmichPeopleQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, ImageIcon, Video, Folder, Users } from "lucide-react";
import { formatDate } from "@/lib/format";

export default function Media() {
  const { data: status, isLoading: statusLoading } = useGetImmichStatus({
    query: { queryKey: getGetImmichStatusQueryKey() }
  });
  
  const { data: photos, isLoading: photosLoading } = useGetImmichRecentPhotos(
    { limit: 24 },
    { query: { queryKey: getGetImmichRecentPhotosQueryKey({ limit: 24 }) } }
  );

  const { data: albums, isLoading: albumsLoading } = useGetImmichAlbums({
    query: { queryKey: getGetImmichAlbumsQueryKey() }
  });

  const { data: people, isLoading: peopleLoading } = useGetImmichPeople({
    query: { queryKey: getGetImmichPeopleQueryKey() }
  });

  if (statusLoading) return <Skeleton className="w-full h-96" />;

  if (!status?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center">
        <Activity className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold mb-2">Immich Disconnected</h2>
        <p className="text-muted-foreground">Configure Immich in settings to view your media.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold font-mono tracking-tight">MEDIA_CENTER</h1>
        <div className="flex items-center space-x-2 text-sm font-mono text-green-500">
          <Activity className="h-4 w-4" />
          <span>IMMICH CONNECTED</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Photos</CardTitle>
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.photoCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Videos</CardTitle>
            <Video className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.videoCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Albums</CardTitle>
            <Folder className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.albumCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">People</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.personCount.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="recent" className="w-full">
        <TabsList>
          <TabsTrigger value="recent">Recent Media</TabsTrigger>
          <TabsTrigger value="albums">Albums</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>
        <TabsContent value="recent" className="mt-4">
          {photosLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {[...Array(12)].map((_, i) => <Skeleton key={i} className="aspect-square w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {photos?.map(asset => (
                <div key={asset.id} className="relative aspect-square group overflow-hidden rounded-md bg-secondary">
                  {asset.thumbUrl ? (
                    <img src={asset.thumbUrl} alt={asset.filename} className="object-cover w-full h-full transition-transform group-hover:scale-105" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {asset.type === 'VIDEO' ? <Video className="h-8 w-8 text-muted-foreground" /> : <ImageIcon className="h-8 w-8 text-muted-foreground" />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="albums" className="mt-4">
          {albumsLoading ? (
             <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
               {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-48 w-full" />)}
             </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {albums?.map(album => (
                <Card key={album.id} className="overflow-hidden">
                  <div className="aspect-[3/2] bg-secondary relative">
                    {album.thumbUrl ? (
                      <img src={album.thumbUrl} alt={album.albumName} className="object-cover w-full h-full" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Folder className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <CardContent className="p-3">
                    <h3 className="font-medium truncate">{album.albumName}</h3>
                    <p className="text-xs text-muted-foreground">{album.assetCount} items</p>
                  </CardContent>
                </Card>
              ))}
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
              {people?.map(person => (
                <div key={person.id} className="flex flex-col items-center space-y-2">
                  <div className="w-24 h-24 rounded-full overflow-hidden bg-secondary">
                    {person.thumbUrl ? (
                      <img src={person.thumbUrl} alt={person.name} className="object-cover w-full h-full" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Users className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-sm truncate w-24">{person.name}</p>
                    <p className="text-xs text-muted-foreground">{person.assetCount}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}