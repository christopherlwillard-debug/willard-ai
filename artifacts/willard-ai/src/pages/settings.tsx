import { useState, useEffect } from "react";
import { 
  useGetSettings, getGetSettingsQueryKey,
  useUpdateSettings,
  useTestImmichConnection,
  useTestNasPath,
  useGetScanStatus, getGetScanStatusQueryKey,
  useGetScanHistory, getGetScanHistoryQueryKey,
  useStartScan
} from "@workspace/api-client-react";
import type { NasTestResult } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Play, CheckCircle2, XCircle, Activity, Loader2, FolderOpen, AlertCircle } from "lucide-react";
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

  const [nasTestResult, setNasTestResult] = useState<NasTestResult | null>(null);

  const testNasMutation = useTestNasPath({
    mutation: {
      onSuccess: (data) => setNasTestResult(data),
      onError: () => setNasTestResult(null),
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
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>NAS Root Path</Label>
                  <Input 
                    value={form.nasPath} 
                    onChange={e => { setForm({...form, nasPath: e.target.value}); setNasTestResult(null); }} 
                    placeholder="/mnt/nas  or  /Volumes/Public"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mount your NAS share first, then enter the mount path here. e.g. <code className="bg-secondary px-1 rounded">/mnt/nas</code> or <code className="bg-secondary px-1 rounded">/Volumes/Public</code>
                  </p>
                </div>
                {nasTestResult && (
                  <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                    nasTestResult.accessible
                      ? "border-green-500/40 bg-green-500/10 text-green-400"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}>
                    {nasTestResult.accessible
                      ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                      : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span className="font-mono text-xs">{nasTestResult.message}</span>
                  </div>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-mono"
                  disabled={testNasMutation.isPending || !form.nasPath}
                  onClick={() => testNasMutation.mutate({ data: { path: form.nasPath } })}
                >
                  {testNasMutation.isPending
                    ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Testing…</>
                    : <><FolderOpen className="w-3.5 h-3.5 mr-2" /> Test NAS Path</>}
                </Button>
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
                <div key={job.id} className="p-3 text-sm bg-secondary/20 rounded border space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      {job.status === 'completed' ? <CheckCircle2 className="text-green-500 w-4 h-4 shrink-0" /> : 
                       job.status === 'failed' ? <XCircle className="text-destructive w-4 h-4 shrink-0" /> : 
                       <Activity className="text-primary w-4 h-4 shrink-0" />}
                      <span className="font-mono">{formatDate(job.startedAt)}</span>
                    </div>
                    <div className="flex items-center space-x-4 font-mono text-muted-foreground">
                      <span>{job.filesScanned} files</span>
                      <span className={`uppercase text-xs font-bold ${job.status === 'failed' ? 'text-destructive' : job.status === 'completed' ? 'text-green-500' : ''}`}>{job.status}</span>
                    </div>
                  </div>
                  {job.status === 'failed' && job.error && (
                    <div className="flex items-start gap-1.5 ml-7 text-xs text-destructive/80 font-mono">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{job.error}</span>
                    </div>
                  )}
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