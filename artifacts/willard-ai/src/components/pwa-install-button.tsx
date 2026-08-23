import { Download, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";

export function PwaInstallButton() {
  const { canInstall, isInstalled, install } = usePwaInstall();

  if (isInstalled) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs font-mono text-muted-foreground" title="Willard Media Center is installed">
        <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        Installed app
      </div>
    );
  }

  if (!canInstall) return null;

  return (
    <Button
      variant="secondary"
      size="sm"
      className="w-full justify-start font-mono"
      onClick={() => void install()}
      title="Install the web app. The local launcher still starts the Media Center service."
    >
      <Download className="mr-2 h-4 w-4" aria-hidden="true" />
      Install Media Center
    </Button>
  );
}