import { useState } from "react";
import { useLogin, useRecoverAuth, useSetupAuth } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Lock, Key, Copy, CheckCircle2, Loader2, Shield, Eye, EyeOff } from "lucide-react";

type Mode = "login" | "recover" | "setup" | "setup-recovery-key";

interface RecoveryKeyDisplayProps {
  recoveryKey: string;
  onAcknowledge: () => void;
}

function RecoveryKeyDisplay({ recoveryKey, onAcknowledge }: RecoveryKeyDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    toast({ title: "Recovery key copied to clipboard" });
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <div className="text-3xl font-mono font-bold tracking-widest text-primary">WILLARD_AI</div>
        <div className="text-xs text-muted-foreground font-mono uppercase tracking-widest">Setup complete</div>
      </div>

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground font-mono">
          Save this recovery key now. It will not be shown again. If you lose your password, this is the only way to regain access.
        </p>
        <div className="bg-secondary/80 border border-primary/40 rounded-lg p-4 space-y-3">
          <div className="text-center font-mono text-xl tracking-[0.3em] text-primary font-bold select-all">
            {recoveryKey}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="w-full font-mono"
            onClick={handleCopy}
          >
            {copied ? (
              <><CheckCircle2 className="w-4 h-4 mr-2 text-green-500" /> Copied</>
            ) : (
              <><Copy className="w-4 h-4 mr-2" /> Copy recovery key</>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground font-mono text-center">
          Store it in a password manager or a safe place offline.
        </p>
      </div>

      <div className="flex items-start space-x-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <Checkbox
          id="ack"
          checked={acknowledged}
          onCheckedChange={(v) => setAcknowledged(!!v)}
          className="mt-0.5"
        />
        <Label htmlFor="ack" className="text-sm font-mono text-amber-400 leading-snug cursor-pointer">
          I have saved my recovery key in a safe place and understand it cannot be recovered if lost.
        </Label>
      </div>

      <Button
        className="w-full font-mono font-bold"
        disabled={!acknowledged}
        onClick={onAcknowledge}
      >
        <Shield className="w-4 h-4 mr-2" />
        ENTER_APP
      </Button>
    </div>
  );
}

export default function LoginPage() {
  const { toast } = useToast();
  const { invalidate, setup } = useAuth();
  const [mode, setMode] = useState<Mode>(setup ? "setup" : "login");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const loginMutation = useLogin({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err: any) => toast({
        title: "Login failed",
        description: err?.response?.data?.error ?? "Incorrect password.",
        variant: "destructive"
      }),
    },
  });

  const setupMutation = useSetupAuth({
    mutation: {
      onSuccess: (data) => {
        setGeneratedKey(data.recoveryKey);
        setMode("setup-recovery-key");
      },
      onError: (err: any) => toast({
        title: "Setup failed",
        description: err?.response?.data?.error ?? "Something went wrong.",
        variant: "destructive"
      }),
    },
  });

  const recoverMutation = useRecoverAuth({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err: any) => toast({
        title: "Recovery failed",
        description: err?.response?.data?.error ?? "Invalid recovery key.",
        variant: "destructive"
      }),
    },
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    loginMutation.mutate({ data: { password } });
  };

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || password.length < 6) {
      toast({ title: "Password too short", description: "Must be at least 6 characters.", variant: "destructive" });
      return;
    }
    setupMutation.mutate({ data: { password } });
  };

  const handleRecover = (e: React.FormEvent) => {
    e.preventDefault();
    if (!recoveryKey || !newPassword) return;
    recoverMutation.mutate({ data: { recoveryKey, newPassword } });
  };

  if (mode === "setup-recovery-key" && generatedKey) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-0 bg-card border border-border rounded-xl p-8 shadow-2xl">
          <RecoveryKeyDisplay recoveryKey={generatedKey} onAcknowledge={invalidate} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-1">
          <div className="text-3xl font-mono font-bold tracking-widest text-primary">WILLARD_AI</div>
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
            {mode === "setup"
              ? "First-run setup"
              : mode === "recover"
              ? "Account recovery"
              : "Authentication required"}
          </div>
        </div>

        {mode === "login" && (
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="pl-10 pr-10 font-mono"
                  placeholder="Enter password"
                  autoFocus
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full font-mono font-bold"
              disabled={loginMutation.isPending || !password}
            >
              {loginMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Authenticating…</>
              ) : (
                <><Lock className="w-4 h-4 mr-2" /> AUTHENTICATE</>
              )}
            </Button>

            <button
              type="button"
              onClick={() => setMode("recover")}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground font-mono transition-colors"
            >
              Forgot password? Use recovery key →
            </button>
          </form>
        )}

        {mode === "setup" && (
          <form onSubmit={handleSetup} className="space-y-5">
            <p className="text-sm text-muted-foreground font-mono">
              This is your first time running Willard AI. Create a password to secure access.
            </p>
            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Create password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="pl-10 pr-10 font-mono"
                  placeholder="Min. 6 characters"
                  autoFocus
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground font-mono">
                A one-time recovery key will be generated. Save it — you'll need it if you forget your password.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full font-mono font-bold"
              disabled={setupMutation.isPending || password.length < 6}
            >
              {setupMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…</>
              ) : (
                <><Shield className="w-4 h-4 mr-2" /> CREATE_PASSWORD</>
              )}
            </Button>
          </form>
        )}

        {mode === "recover" && (
          <form onSubmit={handleRecover} className="space-y-5">
            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Recovery key</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="text"
                  value={recoveryKey}
                  onChange={e => setRecoveryKey(e.target.value)}
                  className="pl-10 font-mono uppercase tracking-widest"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoFocus
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">New password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="pl-10 pr-10 font-mono"
                  placeholder="Min. 6 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full font-mono font-bold"
              disabled={recoverMutation.isPending || !recoveryKey || newPassword.length < 6}
            >
              {recoverMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Recovering…</>
              ) : (
                <><Key className="w-4 h-4 mr-2" /> RESET_PASSWORD</>
              )}
            </Button>

            <button
              type="button"
              onClick={() => setMode("login")}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground font-mono transition-colors"
            >
              ← Back to login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
