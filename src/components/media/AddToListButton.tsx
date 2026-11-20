import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ListPlus, Plus, Search } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { img } from "@/lib/tmdb";
import {
  listLists, addToList, removeFromList, getListsContainingItem, createList,
} from "@/lib/lists.functions";

type Props = {
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string | null;
  variant?: "pill" | "icon";
};

export function AddToListButton(props: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchLists = useServerFn(listLists);
  const fetchIn = useServerFn(getListsContainingItem);
  const fetchAdd = useServerFn(addToList);
  const fetchRemove = useServerFn(removeFromList);
  const fetchCreate = useServerFn(createList);

  const { data: lists } = useQuery({
    queryKey: ["lists", user?.id],
    queryFn: () => fetchLists(),
    enabled: !!user && open,
  });
  const { data: containing } = useQuery({
    queryKey: ["lists-containing", props.mediaType, props.tmdbId, user?.id],
    queryFn: () => fetchIn({ data: { mediaType: props.mediaType, tmdbId: props.tmdbId } }),
    // Not only while the picker is open: the button itself is coloured when the title is on a list.
    enabled: !!user,
  });
  const inSet = new Set(containing ?? []);
  const onAList = inSet.size > 0;

  const toggle = useMutation({
    mutationFn: ({ listId, isIn }: { listId: string; isIn: boolean }) =>
      isIn
        ? fetchRemove({ data: { listId, mediaType: props.mediaType, tmdbId: props.tmdbId } })
        : fetchAdd({
            data: {
              listId,
              mediaType: props.mediaType,
              tmdbId: props.tmdbId,
              title: props.title,
              posterPath: props.posterPath ?? null,
              backdropPath: props.backdropPath ?? null,
              releaseDate: props.releaseDate ?? null,
            },
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lists-containing", props.mediaType, props.tmdbId] });
      qc.invalidateQueries({ queryKey: ["lists"] });
      qc.invalidateQueries({ queryKey: ["list"] });
    },
  });

  const createAndAdd = useMutation({
    mutationFn: async () => {
      const created = await fetchCreate({ data: { name: newName.trim() } });
      await fetchAdd({
        data: {
          listId: created.id,
          mediaType: props.mediaType,
          tmdbId: props.tmdbId,
          title: props.title,
          posterPath: props.posterPath ?? null,
          backdropPath: props.backdropPath ?? null,
          releaseDate: props.releaseDate ?? null,
        },
      });
    },
    onSuccess: () => {
      setNewName("");
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["lists-containing", props.mediaType, props.tmdbId] });
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
  });

  if (!user) return null;

  const year = props.releaseDate ? props.releaseDate.slice(0, 4) : null;
  const q = search.trim().toLowerCase();
  const visible = (lists ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  const poster = img(props.posterPath, "w185");

  return (
    <>
      {props.variant === "icon" ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Add to list"
          title={onAList ? "On a list" : "Add to list"}
          className={[
            "aspect-square w-full max-w-14 grid place-items-center rounded-full border transition",
            // Coloured like the other "active" circles (favourite, rating) when the title is already on a list.
            onAList
              ? "bg-primary/20 border-primary/50 text-primary"
              : "bg-surface border-border text-muted-foreground hover:text-foreground hover:border-primary/40",
          ].join(" ")}
        >
          <ListPlus className="size-5" />
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className={[
            "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
            onAList
              ? "bg-primary/20 border-primary/50 text-primary"
              : "bg-surface border-border hover:border-primary/60",
          ].join(" ")}
        >
          <ListPlus className="size-4" /> Add to list
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="left-3 right-3 top-auto bottom-3 w-auto max-w-none translate-x-0 translate-y-0 p-0 gap-0 overflow-hidden max-h-[85vh] flex flex-col sm:left-[50%] sm:right-auto sm:top-[50%] sm:bottom-auto sm:w-full sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%]"
        >
          <div className="sm:hidden pt-2 pb-1 flex justify-center">
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>

          <DialogHeader className="p-4 pb-3 border-b border-border">
            <div className="flex items-center gap-3 text-left">
              <div className="w-14 shrink-0 aspect-[2/3] rounded-md overflow-hidden bg-surface">
                {poster && <img src={poster} alt={props.title} className="w-full h-full object-cover" />}
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-base leading-tight truncate">{props.title}</DialogTitle>
                {year && <p className="text-sm text-muted-foreground mt-0.5">{year}</p>}
              </div>
            </div>
          </DialogHeader>

          <div className="p-4 space-y-3 overflow-y-auto">
            <div className="relative">
              <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your lists..."
                className="w-full bg-surface border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </div>

            <p className="text-sm text-muted-foreground">Your Lists</p>

            <div className="max-h-72 overflow-y-auto -mx-1 px-1 divide-y divide-border/60">
              {visible.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No lists found.</p>
              ) : (
                visible.map((l) => {
                  const isIn = inSet.has(l.id);
                  const previews = (l.preview_posters ?? []).slice(0, 3);
                  return (
                    <div key={l.id} className="flex items-center gap-3 py-3">
                      <div className="flex shrink-0 w-14 aspect-[2/3] rounded-md overflow-hidden bg-surface">
                        {previews.length === 0 ? (
                          <div className="w-full h-full bg-surface" />
                        ) : (
                          previews.map((p, i) => {
                            const src = img(p.poster_path, "w185");
                            return (
                              <div key={i} className="flex-1 h-full overflow-hidden">
                                {src && <img src={src} alt="" className="w-full h-full object-cover" />}
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{l.name}</p>
                        <p className="text-xs text-muted-foreground">{l.item_count} items</p>
                      </div>
                      <Switch
                        checked={isIn}
                        onCheckedChange={() => toggle.mutate({ listId: l.id, isIn })}
                        aria-label={`Toggle ${l.name}`}
                      />
                    </div>
                  );
                })
              )}
            </div>

            {creating ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New list name"
                  maxLength={120}
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) createAndAdd.mutate();
                  }}
                />
                <button
                  onClick={() => newName.trim() && createAndAdd.mutate()}
                  disabled={!newName.trim() || createAndAdd.isPending}
                  className="rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-border py-3 text-sm hover:bg-surface transition"
              >
                <Plus className="size-4" /> Create New List
              </button>
            )}

            <button
              onClick={() => { setOpen(false); navigate({ to: "/lists" }); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground text-center pt-1"
            >
              Manage all lists →
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}