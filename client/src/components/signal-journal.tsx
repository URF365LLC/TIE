import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Star, NotebookPen, Tags } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface SignalJournalProps {
  signalId: number;
  initialNotes?: string | null;
  initialConfidence?: number | null;
  initialTags?: string[] | null;
}

export function SignalJournal({ signalId, initialNotes, initialConfidence, initialTags }: SignalJournalProps) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [confidence, setConfidence] = useState<number | null>(initialConfidence ?? null);
  const [tagsInput, setTagsInput] = useState((initialTags ?? []).join(", "));

  useEffect(() => { setNotes(initialNotes ?? ""); }, [initialNotes, signalId]);
  useEffect(() => { setConfidence(initialConfidence ?? null); }, [initialConfidence, signalId]);
  useEffect(() => { setTagsInput((initialTags ?? []).join(", ")); }, [initialTags, signalId]);

  const mutation = useMutation({
    mutationFn: async (payload: { notes?: string | null; confidence?: number | null; tags?: string[] | null }) => {
      await apiRequest("PATCH", `/api/signals/${signalId}/journal`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/signals"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const saveNotes = () => {
    if ((notes ?? "") === (initialNotes ?? "")) return;
    mutation.mutate({ notes: notes.trim() ? notes : null });
  };

  const saveConfidence = (val: number | null) => {
    setConfidence(val);
    mutation.mutate({ confidence: val });
  };

  const saveTags = () => {
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const original = (initialTags ?? []).join(",");
    if (tags.join(",") === original) return;
    mutation.mutate({ tags: tags.length ? tags : null });
  };

  return (
    <div className="space-y-3 pt-3 border-t" data-testid={`journal-${signalId}`}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <NotebookPen className="w-3 h-3" /> Journal
      </p>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">Confidence</label>
          <div className="flex items-center gap-1" data-testid={`confidence-stars-${signalId}`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={(e) => { e.stopPropagation(); saveConfidence(confidence === n ? null : n); }}
                className="p-0.5 hover-elevate rounded"
                data-testid={`star-${n}-${signalId}`}
                aria-label={`Confidence ${n}`}
              >
                <Star className={`w-4 h-4 ${confidence != null && n <= confidence ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
              </button>
            ))}
            {confidence != null && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); saveConfidence(null); }}
                className="text-[11px] text-muted-foreground ml-2 hover:underline"
                data-testid={`button-clear-confidence-${signalId}`}
              >
                clear
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground flex items-center gap-1"><Tags className="w-3 h-3" /> Tags (comma separated)</label>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            onBlur={saveTags}
            onClick={(e) => e.stopPropagation()}
            placeholder="news, retest, manual-override"
            className="h-8 text-xs"
            data-testid={`input-tags-${signalId}`}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">Notes</label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          onClick={(e) => e.stopPropagation()}
          placeholder="Why did you take or skip this trade? What did you observe?"
          className="text-xs min-h-[60px]"
          data-testid={`textarea-notes-${signalId}`}
        />
        {mutation.isPending && <span className="text-[10px] text-muted-foreground">Saving...</span>}
      </div>
    </div>
  );
}

export function SummaryLine({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p className="text-xs text-foreground/80 mt-1.5 leading-snug" data-testid="text-signal-summary">
      {text}
    </p>
  );
}

export function DeepDiveButton({ signalId, size = "sm", variant = "outline" }: { signalId: number; size?: "sm" | "default"; variant?: "outline" | "ghost" | "default" | "secondary" }) {
  return (
    <Button
      asChild
      size={size}
      variant={variant}
      onClick={(e) => e.stopPropagation()}
      data-testid={`button-deep-dive-${signalId}`}
    >
      <a href={`/advisor?signalId=${signalId}`}>
        <NotebookPen className="w-3 h-3 mr-1" /> Deep Dive
      </a>
    </Button>
  );
}
