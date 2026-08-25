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
        <div className="brand-mark text-3xl font-mono font-bold tracking-[0.18em]">WILLARD_AI</div>
        <div className="text-xs font-mono uppercase tracking-[0.28em] text-muted-foreground">Setup complete</div>
      </div>

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground font-mono">
          Save this recovery key now. It will not be shown again. If you lose your password, this is the only way to regain access.
        </p>
        <div className="space-y-3 rounded-xl border border-primary/35 bg-primary/[0.06] p-4 shadow-[inset_0_1px_0_rgba(193,244,255,.08)]">
          <div data-testid="recovery-key" className="text-center font-mono text-xl tracking-[0.3em] text-primary font-bold select-all">
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

      <div className="flex items-start space-x-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.06] p-3">
        <Checkbox
          id="ack"
          checked={acknowledged}
          onCheckedChange={(v) => setAcknowledged(!!v)}
          className="mt-0.5"
        />
        <Label htmlFor="ack" className="cursor-pointer font-mono text-sm leading-snug text-amber-200">
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
      onSuccess: async () => {
        await invalidate();
      },
      onError: (err: any) => {
        const rateLimited = err?.status === 429 || err?.response?.status === 429;
        toast({
          title: rateLimited ? "Too many login attempts" : "Login failed",
          description: rateLimited
            ? "Please wait 15 minutes before trying again."
            : err?.data?.error ?? err?.response?.data?.error ?? "Incorrect password.",
          variant: "destructive"
        });
      },
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
        description: err?.data?.error ?? err?.response?.data?.error ?? "Something went wrong.",
        variant: "destructive"
      }),
    },
  });

  const recoverMutation = useRecoverAuth({
    mutation: {
      onSuccess: async () => {
        await invalidate();
      },
      onError: (err: any) => {
        const rateLimited = err?.status === 429 || err?.response?.status === 429;
        toast({
          title: rateLimited ? "Too many recovery attempts" : "Recovery failed",
          description: rateLimited
            ? "Please wait 15 minutes before trying again."
            : err?.data?.error ?? err?.response?.data?.error ?? "Invalid recovery key.",
          variant: "destructive"
        });
      },
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
        <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background p-4 sm:p-8">
          <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
          <div className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-accent/10 blur-3xl" />
          <div className="glass-surface relative w-full max-w-md rounded-2xl p-6 shadow-2xl sm:p-8">
            <RecoveryKeyDisplay recoveryKey={generatedKey} onAcknowledge={invalidate} />
          </div>
        </div>
    );
  }

  return (
    <div className="relative flex min-h-[100dvh] overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 archive-shell" aria-hidden="true" />
      <section className="relative hidden w-[45%] max-w-2xl flex-col justify-between overflow-hidden border-r border-border/60 bg-[radial-gradient(circle_at_52%_42%,rgba(38,119,255,.2),transparent_31%),linear-gradient(145deg,#070b1d,#111039_58%,#0a0b20)] p-10 lg:flex xl:p-14">
        <div className="absolute left-1/2 top-[43%] h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/20 shadow-[0_0_80px_rgba(39,194,255,.12),inset_0_0_80px_rgba(175,78,255,.08)]" />
        <div className="absolute left-1/2 top-[43%] h-[19rem] w-[19rem] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[4rem] border border-accent/30" />
        <div className="absolute left-1/2 top-[43%] h-52 w-52 -translate-x-1/2 -translate-y-1/2 -rotate-12 rounded-[3rem] border-2 border-primary/60 bg-primary/[0.03] shadow-[0_0_32px_rgba(39,222,255,.24)]" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/50 bg-primary/10 font-mono text-lg font-bold text-primary shadow-[0_0_22px_rgba(39,222,255,.18)]">W</div>
            <div>
              <p className="font-mono text-xs tracking-[0.3em] text-primary">WILLARD / LOCAL NODE</p>
              <p className="mt-1 text-xs text-muted-foreground">Private media intelligence</p>
            </div>
          </div>
        </div>
        <div className="relative max-w-md">
          <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.35em] text-primary/75">Memory archive // 01</p>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.04em] text-foreground xl:text-5xl">Your memories,<br /><span className="brand-mark">in their orbit.</span></h1>
          <p className="mt-5 max-w-sm text-sm leading-6 text-muted-foreground">A quiet, intelligent home for the photographs, films, and documents that make a life.</p>
          <div className="mt-8 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-px w-10 bg-gradient-to-r from-primary to-accent" />
            Encrypted on your hardware
          </div>
        </div>
        <p className="relative font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/70">WILLARD AI MEDIA CENTER · EST. LOCAL</p>
      </section>

      <section className="relative flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="pointer-events-none absolute -right-20 top-10 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 left-10 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="glass-surface relative w-full max-w-md space-y-6 rounded-2xl p-6 shadow-2xl sm:p-8">
          <div className="text-center space-y-1 lg:hidden">
            <div className="brand-mark text-3xl font-mono font-bold tracking-[0.18em]">WILLARD_AI</div>
            <div className="text-xs font-mono uppercase tracking-[0.28em] text-muted-foreground">
              {mode === "setup"
                ? "First-run setup"
                : mode === "recover"
                ? "Account recovery"
                : "Authentication required"}
            </div>
          </div>
          <div className="hidden items-center justify-between lg:flex">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-primary/75">Secure access</p>
              <p className="mt-1 text-sm text-muted-foreground">Enter your local archive</p>
            </div>
            <div className="h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(39,222,255,.85)]" />
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
                   className="cyan-focus h-11 rounded-lg border-border/80 bg-background/45 pl-10 pr-10 font-mono"
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
               className="h-11 w-full rounded-lg font-mono font-bold shadow-[0_0_22px_rgba(39,222,255,.14)]"
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
               className="w-full text-center font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
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
                   className="cyan-focus h-11 rounded-lg border-border/80 bg-background/45 pl-10 pr-10 font-mono"
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
               className="h-11 w-full rounded-lg font-mono font-bold shadow-[0_0_22px_rgba(39,222,255,.14)]"
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
                   className="cyan-focus h-11 rounded-lg border-border/80 bg-background/45 pl-10 font-mono uppercase tracking-widest"
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
                   className="cyan-focus h-11 rounded-lg border-border/80 bg-background/45 pl-10 pr-10 font-mono"
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
               className="h-11 w-full rounded-lg font-mono font-bold shadow-[0_0_22px_rgba(39,222,255,.14)]"
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
               className="w-full text-center font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              ← Back to login
            </button>
          </form>
        )}
        </div>
      </section>
    </div>
  );
}
