import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Calendar, CalendarClock, Hash, ListPlus, ListChecks, Trash2, Film, Type } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SESSION_QUERY_KEY, useAuth, type AuthUser } from "@/hooks/use-auth";
import { listLists, createList, deleteList } from "@/lib/lists.functions";
import { img } from "@/lib/tmdb";

export const Route = createFileRoute("/lists/")({
  head: () => ({ meta: [{ title: "My Lists — Popcornhour" }] }),
  // Starts fetching the lists as soon as a finger touches the Lists tab (the router preloads on touch), so the page
  // usually opens with them instead of "Loading…". It does not wait for them: the page changes on the tap either way.
  loader: ({ context }) => {
    const userId = context.queryClient.getQueryData<{ user: AuthUser | null }>(SESSION_QUERY_KEY)?.user?.id;
    if (userId) void context.queryClient.prefetchQuery({ queryKey: ["lists", userId], queryFn: () => listLists() });
  },
  component: ListsPage,
});

// The Sort menu. Picking an option starts it the natural way round (Name A–Z, the others newest / most first); the
// last item flips it. Default: Last updated, newest first. Remembered on this device.
type ListSortKey = "updated" | "name" | "created" | "count";
type ListSort = { key: ListSortKey; dir: "asc" | "desc" };
const LIST_SORTS: { value: ListSortKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "name", label: "Name", icon: Type },
  { value: "updated", label: "Last updated", icon: CalendarClock },
  { value: "created", label: "Date created", icon: Calendar },
  { value: "count", label: "Item count", icon: Hash },
];
const DEFAULT_LIST_SORT: ListSort = { key: "updated", dir: "desc" };
const LIST_SORT_KEY = "cx:lists-sort";
function readListSort(): ListSort {
  try {
    const p = JSON.parse(localStorage.getItem(LIST_SORT_KEY) ?? "null");
    if (p && LIST_SORTS.some((s) => s.value === p.key) && (p.dir === "asc" || p.dir === "desc")) return p;
  } catch {
    /* nothing saved, or no storage */
  }
  return DEFAULT_LIST_SORT;
}

function ListsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchLists = useServerFn(listLists);
  const fetchCreate = useServerFn(createList);
  const fetchDelete = useServerFn(deleteList);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  const { data: lists, isLoading } = useQuery({
    queryKey: ["lists", user?.id],
    queryFn: () => fetchLists(),
    enabled: !!user,
  });

  const create = useMutation({
    mutationFn: () =>
      fetchCreate({ data: { name: name.trim(), description: description.trim() || null } }),
    onSuccess: () => {
      setName("");
      setDescription("");
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
  });

  const [sort, setSortState] = useState<ListSort>(DEFAULT_LIST_SORT);
  useEffect(() => setSortState(readListSort()), []); // read after mount so the server and first browser render agree
  const setSort = (next: ListSort) => {
    setSortState(next);
    try {
      localStorage.setItem(LIST_SORT_KEY, JSON.stringify(next));
    } catch {
      /* no storage: still works for this visit */
    }
  };
  const activeSort = LIST_SORTS.find((s) => s.value === sort.key)!;

  const sortedLists = useMemo(() => {
    if (!lists) return lists;
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    const out = [...lists].sort((a, b) => {
      let c = 0;
      if (sort.key === "name") c = byName(a, b);
      else if (sort.key === "updated") c = a.updated_at.localeCompare(b.updated_at);
      else if (sort.key === "created") c = a.created_at.localeCompare(b.created_at);
      else c = a.item_count - b.item_count;
      if (sort.dir === "desc") c = -c;
      return c || byName(a, b); // ties: A–Z
    });
    return out;
  }, [lists, sort]);

  const remove = useMutation({
    mutationFn: (id: string) => fetchDelete({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });

  return (
    <>
      <div className="px-4 md:px-10 pt-[max(1rem,env(safe-area-inset-top))] pb-8 md:pt-8 max-w-6xl">
        <div className="flex items-center justify-between gap-4 mb-6">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <ListChecks className="size-7 text-primary" />
            My Lists
          </h1>
          <button
            onClick={() => setCreating((v) => !v)}
            // shrink-0 / nowrap: on a phone the description beside it was squeezing the label onto two lines.
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            <ListPlus className="size-4" /> New list
          </button>
        </div>

        {creating && (
          <div className="mb-8 rounded-2xl border border-border bg-surface p-4 space-y-3">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="List name (e.g. Comfort rewatches)"
              maxLength={120}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              maxLength={2000}
              rows={2}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCreating(false)}
                className="rounded-full px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => name.trim() && create.mutate()}
                disabled={!name.trim() || create.isPending}
                className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {create.isPending ? "Creating…" : "Create list"}
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !lists || lists.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center">
            <ListChecks className="size-10 mx-auto text-muted-foreground mb-3" />
            <h2 className="text-lg font-semibold">No lists yet</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Create your first list to start curating collections.
            </p>
          </div>
        ) : (
          <>
          {/* How many lists on the left, Sort on the right (as on the Filter / Sort line inside a list). */}
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {lists.length} {lists.length === 1 ? "list" : "lists"}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ml-auto inline-flex items-center gap-2 rounded-full bg-surface border border-border px-3 py-1.5 text-xs hover:border-primary/50">
                  <activeSort.icon className="size-3.5" />
                  {activeSort.label}
                  {sort.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {LIST_SORTS.map((s) => (
                  <DropdownMenuItem
                    key={s.value}
                    onClick={() => setSort({ key: s.value, dir: s.value === "name" ? "asc" : "desc" })}
                    className={sort.key === s.value ? "bg-primary/15 text-primary" : ""}
                  >
                    <s.icon className="size-4" />
                    {s.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}>
                  {sort.dir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
                  {sort.dir === "asc" ? "Ascending" : "Descending"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Two across on a phone, as on a tablet; three on a wide screen. */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {(sortedLists ?? lists).map((l) => (
              <ListCard
                key={l.id}
                list={l}
                onDelete={() => {
                  if (confirm(`Delete "${l.name}"? This can't be undone.`)) {
                    remove.mutate(l.id);
                  }
                }}
              />
            ))}
          </div>
          </>
        )}
      </div>
    </>
  );
}

function ListCard({
  list,
  onDelete,
}: {
  list: {
    id: string;
    name: string;
    description: string | null;
    item_count: number;
    preview_posters: { poster_path: string | null }[];
  };
  onDelete: () => void;
}) {
  return (
    <div className="group relative rounded-2xl border border-border bg-surface overflow-hidden hover:border-primary/50 transition-colors">
      <Link to="/lists/$listId" params={{ listId: list.id }} className="block">
        {/* The four posters: a 2×2 square on a phone (four in a row would be too small at half width), a row of four
            on a bigger screen. */}
        <div className="grid grid-cols-2 aspect-square sm:grid-cols-4 sm:aspect-[16/9] gap-px bg-background">
          {Array.from({ length: 4 }).map((_, i) => {
            const p = list.preview_posters[i];
            const src = p?.poster_path ? img(p.poster_path, "w342") : null;
            return (
              <div key={i} className="bg-background overflow-hidden">
                {src ? (
                  <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full grid place-items-center text-muted-foreground/40">
                    <Film className="size-5" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="p-3 sm:p-4">
          <h3 className="font-semibold line-clamp-1">{list.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {list.item_count} {list.item_count === 1 ? "item" : "items"}
          </p>
          {list.description && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{list.description}</p>
          )}
        </div>
      </Link>
      {/* No backdrop blur: it is repeated on every card (see the smoothness rules). */}
      <button
        onClick={onDelete}
        title="Delete list"
        className="absolute top-2 right-2 size-8 grid place-items-center rounded-full bg-background/90 border border-border text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}