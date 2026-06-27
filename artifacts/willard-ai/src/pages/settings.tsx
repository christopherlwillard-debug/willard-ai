import { useState, useEffect } from "react";
import { 
  useGetSettings, getGetSettingsQueryKey,
  useUpdateSettings,
  useTestImmichConnection,
  useTestNasPath,
  useGetScanStatus, getGetScanStatusQueryKey,
  useGetScanHistory, getGetScanHistoryQueryKey,
  useStartScan,
  useChangePassword,
  useListSessions, getListSessionsQueryKey,
  useRevokeSession,
  useRevokeOtherSessions,
  useGetNasDirStatus, getGetNasDirStatusQueryKey,
  useReinitNasDirs,
} from "@workspace/api-client-react";
import type { NasTestResult } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Play, CheckCircle2, XCircle, Activity, Loader2, FolderOpen, AlertCircle, Lock, Shield, Monitor, Trash2, HardDrive, RefreshCw } from "lucide-react";
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

      <SecuritySection />
      <StorageSection />
    </div>
  );
}

function SecuritySection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });

  const changePasswordMutation = useChangePassword({
    mutation: {
      onSuccess: () => {
        toast({ title: "Password changed successfully" });
        setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      },
      onError: (err: any) => toast({
        title: "Failed to change password",
        description: err?.response?.data?.error ?? "Something went wrong.",
        variant: "destructive",
      }),
    },
  });

  const { data: sessionsData, isLoading: sessionsLoading } = useListSessions({
    query: { queryKey: getListSessionsQueryKey() },
  });

  const revokeSessionMutation = useRevokeSession({
    mutation: {
      onSuccess: () => {
        toast({ title: "Session revoked" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      },
      onError: () => toast({ title: "Failed to revoke session", variant: "destructive" }),
    },
  });

  const revokeOthersMutation = useRevokeOtherSessions({
    mutation: {
      onSuccess: () => {
        toast({ title: "All other sessions revoked" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      },
      onError: () => toast({ title: "Failed to revoke sessions", variant: "destructive" }),
    },
  });

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      toast({ title: "Password too short", description: "Must be at least 6 characters.", variant: "destructive" });
      return;
    }
    changePasswordMutation.mutate({
      data: { currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword },
    });
  };

  const formatRelativeTime = (dateStr: string | null | undefined) => {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          SECURITY
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4" /> Change Password
            </CardTitle>
            <CardDescription>Update your login password</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4" id="change-password-form">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Current password</Label>
                <Input
                  type="password"
                  value={pwForm.currentPassword}
                  onChange={e => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                  className="font-mono"
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">New password</Label>
                <Input
                  type="password"
                  value={pwForm.newPassword}
                  onChange={e => setPwForm({ ...pwForm, newPassword: e.target.value })}
                  className="font-mono"
                  placeholder="Min. 6 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Confirm new password</Label>
                <Input
                  type="password"
                  value={pwForm.confirmPassword}
                  onChange={e => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                  className="font-mono"
                  autoComplete="new-password"
                />
              </div>
            </form>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              form="change-password-form"
              className="w-full font-mono font-bold"
              disabled={changePasswordMutation.isPending || !pwForm.currentPassword || !pwForm.newPassword}
            >
              {changePasswordMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Changing…</>
              ) : (
                "CHANGE_PASSWORD"
              )}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="w-4 h-4" /> Active Sessions
            </CardTitle>
            <CardDescription>Devices currently logged into this app</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessionsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              sessionsData?.sessions.map(session => (
                <div
                  key={session.sid}
                  className={`flex items-center justify-between p-3 rounded-md border text-sm ${
                    session.isCurrent ? "border-primary/40 bg-primary/5" : "border-border bg-secondary/20"
                  }`}
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 font-mono font-medium">
                      <Monitor className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{session.deviceName}</span>
                      {session.isCurrent && (
                        <span className="text-xs text-primary font-bold shrink-0">THIS DEVICE</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono pl-5">
                      {session.ip || "Unknown IP"} · Last seen {formatRelativeTime(session.lastSeenAt)}
                    </div>
                  </div>
                  {!session.isCurrent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      disabled={revokeSessionMutation.isPending}
                      onClick={() => revokeSessionMutation.mutate({ sid: session.sid })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              ))
            )}
            {!sessionsLoading && (!sessionsData?.sessions || sessionsData.sessions.length === 0) && (
              <p className="text-center text-sm text-muted-foreground font-mono py-4">No active sessions</p>
            )}
          </CardContent>
          {sessionsData && sessionsData.sessions.length > 1 && (
            <CardFooter>
              <Button
                variant="destructive"
                size="sm"
                className="w-full font-mono"
                disabled={revokeOthersMutation.isPending}
                onClick={() => revokeOthersMutation.mutate()}
              >
                {revokeOthersMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Revoking…</>
                ) : (
                  "REVOKE_ALL_OTHER_SESSIONS"
                )}
              </Button>
            </CardFooter>
          )}
        </Card>
      </div>
    </>
  );
}

function StorageSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: dirStatus, isLoading } = useGetNasDirStatus({
    query: { queryKey: getGetNasDirStatusQueryKey() },
  });

  const reinitMutation = useReinitNasDirs({
    mutation: {
      onSuccess: () => {
        toast({ title: "Directories reinitialized" });
        queryClient.invalidateQueries({ queryKey: getGetNasDirStatusQueryKey() });
      },
      onError: () => toast({ title: "Failed to reinitialize directories", variant: "destructive" }),
    },
  });

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          NAS STORAGE
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          App data stored on the NAS under <code className="bg-secondary px-1 rounded font-mono text-xs">WillardAI/</code>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="w-4 h-4" /> WillardAI Directory Status
          </CardTitle>
          <CardDescription>
            Logs, scan history, temp files, and reports are stored here on your NAS
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !dirStatus?.nasPath ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono p-3 bg-secondary/20 rounded border border-dashed">
              <AlertCircle className="w-4 h-4 shrink-0" />
              Configure a NAS path in settings above to enable NAS storage
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground px-1">
                <span className="truncate">{dirStatus.willardAiPath}</span>
                {dirStatus.allPresent ? (
                  <span className="shrink-0 text-green-500 font-bold">ALL PRESENT</span>
                ) : (
                  <span className="shrink-0 text-amber-500 font-bold">INCOMPLETE</span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {dirStatus.subdirs.map((subdir) => (
                  <div
                    key={subdir.name}
                    className={`flex items-center gap-2 px-3 py-2 rounded border text-sm font-mono ${
                      subdir.exists
                        ? "border-green-500/30 bg-green-500/5 text-green-400"
                        : "border-destructive/30 bg-destructive/5 text-destructive"
                    }`}
                  >
                    {subdir.exists ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate text-xs">{subdir.name}/</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
        {dirStatus?.nasPath && (
          <CardFooter>
            <Button
              variant="secondary"
              size="sm"
              className="font-mono"
              disabled={reinitMutation.isPending || (dirStatus?.allPresent ?? false)}
              onClick={() => reinitMutation.mutate()}
            >
              {reinitMutation.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Reinitializing…</>
              ) : (
                <><RefreshCw className="w-3.5 h-3.5 mr-2" /> REINITIALIZE_DIRS</>
              )}
            </Button>
          </CardFooter>
        )}
      </Card>
    </>
  );
}