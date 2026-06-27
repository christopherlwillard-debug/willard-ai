import { useState, useEffect, useRef } from "react";
import { 
  useGetSettings, getGetSettingsQueryKey,
  useUpdateSettings,
  useTestImmichConnection,
  useGetScanStatus, getGetScanStatusQueryKey,
  useGetScanHistory, getGetScanHistoryQueryKey,
  useStartScan
} from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Play, CheckCircle2, XCircle, Activity, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: settings, isLoading: settingsLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() }
  });

  const { data: scanStatus } = useGetScanStatus({
    query: { 
      queryKey: getGetScanStatusQueryKey(),
      refetchInterval: 3000 // poll every 3s
    }
  });

  const { data: scanHistory, isLoading: historyLoading } = useGetScanHistory({
    query: { queryKey: getGetScanHistoryQueryKey() }
  });

  const updateMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Settings updated successfully" });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      },
      onError: (err: any) => toast({ title: "Failed to update", description: err.message, variant: "destructive" })
    }
  });

  const testImmichMutation = useTestImmichConnection({
    mutation: {
      onSuccess: (data) => {
        if (data.connected) {
          toast({ title: "Connected to Immich", description: `Found ${data.photoCount} photos` });
        } else {
          toast({ title: "Connection failed", description: data.message, variant: "destructive" });
        }
      }
    }
  });

  const startScanMutation = useStartScan({
    mutation: {
      onSuccess: () => {
        toast({ title: "Scan started" });
        queryClient.invalidateQueries({ queryKey: getGetScanStatusQueryKey() });
      }
    }
  });

  const [form, setForm] = useState({
    nasPath: "",
    immichBaseUrl: "",
    immichApiKey: ""
  });

  useEffect(() => {
    if (settings) {
      setForm({
        nasPath: settings.nasPath,
        immichBaseUrl: settings.immichBaseUrl,
        immichApiKey: settings.immichApiKey
      });
    }
  }, [settings]);

  const handleSave = () => {
    updateMutation.mutate({ data: form });
  };

  const handleTestImmich = () => {
    testImmichMutation.mutate({ 
      data: { baseUrl: form.immichBaseUrl, apiKey: form.immichApiKey } 
    });
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">SYSTEM_CONFIGURATION</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center"><Settings2 className="w-5 h-5 mr-2"/> NAS Configuration</CardTitle>
            <CardDescription>Path to your mounted WD My Cloud</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settingsLoading ? <Skeleton className="h-10 w-full" /> : (
              <div className="space-y-2">
                <Label>NAS Root Path</Label>
                <Input 
                  value={form.nasPath} 
                  onChange={e => setForm({...form, nasPath: e.target.value})} 
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">e.g., /Volumes/Public or Z:\</p>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button onClick={handleSave} disabled={updateMutation.isPending || settingsLoading} className="w-full font-mono font-bold">
              {updateMutation.isPending ? "SAVING..." : "SAVE_CONFIG"}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Immich Integration</CardTitle>
            <CardDescription>Connect to your Immich server instance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
             {settingsLoading ? <div className="space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : (
              <>
                <div className="space-y-2">
                  <Label>Server URL</Label>
                  <Input 
                    value={form.immichBaseUrl} 
                    onChange={e => setForm({...form, immichBaseUrl: e.target.value})} 
                    placeholder="http://192.168.1.100:2283"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label>API Key</Label>
                  <Input 
                    type="password"
                    value={form.immichApiKey} 
                    onChange={e => setForm({...form, immichApiKey: e.target.value})} 
                    className="font-mono"
                  />
                </div>
              </>
            )}
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button variant="secondary" onClick={handleTestImmich} disabled={testImmichMutation.isPending} className="flex-1">
              Test Connection
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending} className="flex-1">
              Save
            </Button>
          </CardFooter>
        </Card>
      </div>

      <Card className="border-primary/50">
        <CardHeader>
          <CardTitle className="flex items-center text-primary">
            <Activity className="w-5 h-5 mr-2" /> Scanner Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg border border-primary/20">
            <div>
              <h3 className="font-mono font-bold text-lg">
                {scanStatus?.isRunning ? "SCAN_IN_PROGRESS" : "SYSTEM_IDLE"}
              </h3>
              {scanStatus?.isRunning && scanStatus.current ? (
                <p className="text-sm text-muted-foreground mt-1 font-mono">
                  Stage: {scanStatus.current.stage} | Files: {scanStatus.current.filesScanned}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1 font-mono">
                  Total indexed: {settings?.totalFilesIndexed.toLocaleString()} files
                </p>
              )}
            </div>
            <Button 
              size="lg"
              disabled={scanStatus?.isRunning || startScanMutation.isPending}
              onClick={() => startScanMutation.mutate()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono font-bold"
            >
              {scanStatus?.isRunning ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> SCANNING</>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> START_INDEX_SCAN</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scan History</CardTitle>
        </CardHeader>
        <CardContent>
          {historyLoading ? <Skeleton className="h-32 w-full" /> : (
            <div className="space-y-2">
              {scanHistory?.map(job => (
                <div key={job.id} className="flex items-center justify-between p-3 text-sm bg-secondary/20 rounded border">
                  <div className="flex items-center space-x-3">
                    {job.status === 'completed' ? <CheckCircle2 className="text-green-500 w-4 h-4" /> : 
                     job.status === 'failed' ? <XCircle className="text-destructive w-4 h-4" /> : 
                     <Activity className="text-primary w-4 h-4" />}
                    <span className="font-mono">{formatDate(job.startedAt)}</span>
                  </div>
                  <div className="flex items-center space-x-4 font-mono text-muted-foreground">
                    <span>{job.filesScanned} files</span>
                    <span className="uppercase text-xs">{job.status}</span>
                  </div>
                </div>
              ))}
              {scanHistory?.length === 0 && <p className="text-muted-foreground text-center py-4">No scan history available</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}