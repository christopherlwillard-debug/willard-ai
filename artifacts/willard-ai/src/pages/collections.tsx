import { FolderHeart } from "lucide-react";

export default function Collections() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <div className="p-4 rounded-full bg-muted">
          <FolderHeart className="w-10 h-10 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold font-mono tracking-tight">Collections</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Collections coming soon — virtual albums that group your files any way you like,
            without ever moving them on disk.
          </p>
        </div>
      </div>
    </div>
  );
}
