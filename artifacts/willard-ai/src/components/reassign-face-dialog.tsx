import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const API = `${import.meta.env.BASE_URL}api`;

async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

type Person = { id: number; name: string | null; faceCount: number };

export function ReassignFaceDialog({
  faceId,
  open,
  onOpenChange,
  invalidateKeys,
}: {
  faceId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invalidateKeys: (faceId: number) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [target, setTarget] = useState("");
  const [newName, setNewName] = useState("");
  const peopleQ = useQuery<{ people: Person[] }>({
    queryKey: ["faces-people"],
    queryFn: () => apiFetch("/faces/people"),
    enabled: open,
  });
  const move = useMutation({
    mutationFn: () => apiFetch(`/faces/${faceId}/reassign`, {
      method: "POST",
      body: JSON.stringify(target === "new" ? { newPersonName: newName } : { personId: Number(target) }),
    }),
    onSuccess: (result: { personId: number; previousPersonId: number | null }) => {
      qc.invalidateQueries({ queryKey: ["faces-people"] });
      if (result.previousPersonId) qc.invalidateQueries({ queryKey: ["faces-person", result.previousPersonId] });
      qc.invalidateQueries({ queryKey: ["faces-person", result.personId] });
      invalidateKeys(faceId!);
      setTarget("");
      setNewName("");
      onOpenChange(false);
      toast({ title: "Face reassigned", description: "The person counts and clusters were refreshed." });
    },
    onError: (error: Error) => toast({ title: "Couldn't reassign face", description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setTarget(""); setNewName(""); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Reassign face</DialogTitle>
          <DialogDescription>Move this face to another visible person or create a new named person.</DialogDescription>
        </DialogHeader>
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          data-testid="select-reassign-person"
        >
          <option value="">Choose a person</option>
          {(peopleQ.data?.people ?? []).map((person) => (
            <option key={person.id} value={person.id}>{person.name ?? "Unnamed person"} · {person.faceCount} faces</option>
          ))}
          <option value="new">Create a new person</option>
        </select>
        {target === "new" && (
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New person's name"
            maxLength={80}
            autoFocus
            data-testid="input-new-person-name"
          />
        )}
        {peopleQ.isLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading people…</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!faceId || !target || (target === "new" && !newName.trim()) || move.isPending}
            onClick={() => move.mutate()}
            data-testid="button-confirm-reassign"
          >
            {move.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Move face
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}