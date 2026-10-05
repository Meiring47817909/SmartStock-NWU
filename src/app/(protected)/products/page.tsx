"use client";

import { useEffect, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { stockStatusLabel, genBarcode, addDaysToDateStr } from "@/lib/utils";
import { Search, Plus, Pencil, Eye, RefreshCw, X, GripVertical, Copy, Trash2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useTable, type SortingState } from "@tanstack/react-table";
import {
  SORTABLE_TABLE_FEATURES,
  sortableColumnHelper,
  SortableHead,
} from "@/components/data-table-helpers";
import { storage } from "@/lib/firebase/config";
import { ref, uploadBytes, deleteObject } from "firebase/storage";
import { storageDownloadUrl } from "@/lib/firebase/storage";
import {
  createProduct,
  deleteProduct,
  findBarcodeConflict,
  getBarcodeUnitCounts,
  getProductDeleteBlockers,
  listCategories,
  listProducts,
  newProductId,
  productDeleteBlockReason,
  updateProduct,
  type ProductDeleteBlockers,
  type BarcodeUnitCount,
} from "@/lib/api/catalog";
import { findQuantityReductionConflicts } from "@/lib/api/loanRequests";
import { isLendableNow } from "@/lib/catalogRules";
import {
  reservationStatusLabel,
  resolutionInstruction,
  LENDING_INTERVALS,
  type ReservationHolder,
} from "@/lib/loanRequestRules";
import type { LendingInterval } from "@/types/database";
import { notifyProductStockChange } from "@/lib/firebase/notifyEvent";
import { useAuth } from "@/context/AuthContext";
import { useRole } from "@/context/RoleContext";
import { Card, CardContent } from "@/components/ui/card";
import { CollapsibleFilters } from '@/components/CollapsibleFilters'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AvailabilityDatePicker } from "@/components/portal/AvailabilityDatePicker";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import MultiImageUploader, {
  type ImageUpload,
} from "@/components/products/MultiImageUploader";
import ProductPreviewDialog from "@/components/products/ProductPreviewDialog";
import type { Product, Category } from "@/types/database";

const ALL_CATEGORIES = "__all__";
const NO_CATEGORY = "__none__";
const MAX_IMAGES = 3;
const DEFAULT_LOCATION = "NWU - Potchefstroom, Building G4, Room 28";

// Normalizes a product's barcode list, falling back to the pre-multi-barcode
// singular `barcode` field for records that haven't been edited since.
const productBarcodes = (p: {
  barcodes?: string[];
  barcode?: string;
}): string[] => p.barcodes ?? (p.barcode ? [p.barcode] : []);

// todayDateStr moved to the shared @/lib/utils — Stock Out's Confirm step
// needed the same "today" floor for its lend-date pickers.

const STATUS_BADGE_CLASS = (qty: number, threshold: number) =>
  qty === 0
    ? "bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold"
    : qty <= threshold
      ? "bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold"
      : "bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold";

// Availability items keyed by string since Base UI's Select works on string
// values — mapped back to/from the boolean `available` field on save/load.
const AVAILABLE_ITEMS: Record<"true" | "false", string> = {
  true: "Available",
  false: "Unavailable",
};

const AVAILABLE_BADGE_CLASS = (available: boolean) =>
  available
    ? "bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold"
    : "bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold";

// Out of stock outranks Low stock outranks In stock, so sorting the Status
// column surfaces the most depleted products first either direction — same
// convention as the Dashboard's own Low Stock Alerts table.
const PRODUCT_STATUS_RANK: Record<string, number> = {
  "Out of stock": 0,
  "Low stock": 1,
  "In stock": 2,
};

const PRODUCTS_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor("name", { id: "name", header: "Product", sortFn: "alphanumeric" }),
  sortableColumnHelper.accessor((p: any) => productBarcodes(p)[0] ?? "", { id: "barcode", header: "Barcode", sortFn: "alphanumeric" }),
  sortableColumnHelper.accessor((p: any) => p.category_name ?? "", { id: "category_name", header: "Category", sortFn: "alphanumeric" }),
  sortableColumnHelper.accessor("quantity_on_hand", {
    id: "quantity_on_hand",
    header: "Qty",
    sortFn: (a: any, b: any) => a.original.quantity_on_hand - b.original.quantity_on_hand,
  }),
  sortableColumnHelper.accessor((p: any) => stockStatusLabel(p.quantity_on_hand, p.reorder_threshold), {
    id: "status",
    header: "Status",
    sortFn: (a: any, b: any) =>
      PRODUCT_STATUS_RANK[stockStatusLabel(a.original.quantity_on_hand, a.original.reorder_threshold)] -
      PRODUCT_STATUS_RANK[stockStatusLabel(b.original.quantity_on_hand, b.original.reorder_threshold)],
  }),
  // Available means lendable right now: switched on AND in stock (same rule as the product preview and the portal).
  sortableColumnHelper.accessor((p: any) => (isLendableNow(p) ? "Available" : "Unavailable"), {
    id: "available",
    header: "Available",
    sortFn: "alphanumeric",
  }),
]);

// A bulk-toggle pair for a checkbox dropdown, same helper the Reports page
// defines for its own Stock Status / Category filters — this page duplicates
// it locally rather than reaching into that page's module, matching the
// existing convention (every report tab on that page also has its own copy).
function SelectAllMenuItems({
  onSelectAll,
  onUnselectAll,
}: {
  onSelectAll: () => void;
  onUnselectAll: () => void;
}) {
  return (
    <>
      <DropdownMenuItem closeOnClick={false} onClick={onSelectAll}>
        Select all
      </DropdownMenuItem>
      <DropdownMenuItem closeOnClick={false} onClick={onUnselectAll}>
        Unselect all
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

// Same three labels stockStatusLabel() returns and the Status column
// already badges — filtering on this, not the Reports page's own ALL-CAPS
// STOCK_STATUS_VALUES, keeps the dropdown's wording identical to what's on
// screen in the table.
const PRODUCT_STATUS_VALUES = ["Out of stock", "Low stock", "In stock"] as const;
const PRODUCT_STATUS_DOT: Record<string, string> = {
  "Out of stock": "bg-red-500",
  "Low stock": "bg-amber-500",
  "In stock": "bg-emerald-500",
};

function statusFilterLabel(selected: Set<string>): string {
  if (selected.size === 0) return "No statuses";
  if (selected.size === PRODUCT_STATUS_VALUES.length) return "All statuses";
  if (selected.size === 1) return [...selected][0];
  return "Custom";
}

function StatusFilter({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  function toggle(value: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(value);
    else next.delete(value);
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="w-40 justify-between font-normal" />}
      >
        <span className="truncate">{statusFilterLabel(selected)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(PRODUCT_STATUS_VALUES))}
          onUnselectAll={() => onChange(new Set())}
        />
        {PRODUCT_STATUS_VALUES.map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.has(value)}
            onCheckedChange={(checked) => toggle(value, checked)}
          >
            <span className={`size-2 rounded-full ${PRODUCT_STATUS_DOT[value]}`} />
            {value}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Same idea for Available — just the two values the Available column
// already badges (a product with no `available` field yet defaults to
// Available, same as everywhere else this field is read).
const AVAILABLE_VALUES = ["Available", "Unavailable"] as const;
const AVAILABLE_DOT: Record<string, string> = {
  Available: "bg-emerald-500",
  Unavailable: "bg-red-500",
};

function availableFilterLabel(selected: Set<string>): string {
  if (selected.size === 0) return "No availability";
  if (selected.size === AVAILABLE_VALUES.length) return "All";
  return [...selected][0];
}

function AvailableFilter({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  function toggle(value: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(value);
    else next.delete(value);
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="w-36 justify-between font-normal" />}
      >
        <span className="truncate">{availableFilterLabel(selected)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(AVAILABLE_VALUES))}
          onUnselectAll={() => onChange(new Set())}
        />
        {AVAILABLE_VALUES.map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.has(value)}
            onCheckedChange={(checked) => toggle(value, checked)}
          >
            <span className={`size-2 rounded-full ${AVAILABLE_DOT[value]}`} />
            {value}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type FormData = {
  name: string;
  barcodes: string[];
  category_id: string;
  description: string;
  quantity_on_hand: string;
  reorder_threshold: string;
  available: boolean;
  location: string;
  lend_from: string;
  lend_to: string;
  lending_interval: LendingInterval;
  images: ImageUpload[];
  // Transient — never written to the product doc itself, only into the
  // audit log's `after` snapshot for the one update where it applies.
  quantity_reason: string;
};

const EMPTY_FORM: FormData = {
  name: "",
  barcodes: [],
  category_id: "",
  description: "",
  quantity_on_hand: "0",
  reorder_threshold: "5",
  available: false,
  location: DEFAULT_LOCATION,
  lend_from: "",
  lend_to: "",
  lending_interval: "week_1",
  images: [],
  quantity_reason: "",
};

// Whether editing a product's form still matches what openEdit loaded it
// with — drives disabling Save Changes until an actual edit is made (see
// isUnchanged below). images carries File objects on a newly-added photo,
// which aren't meaningfully comparable (and JSON.stringify drops them to
// "{}" anyway), so images are compared by id/url only — a new upload,
// removal or drag-reorder still changes that id/url sequence, which is all
// that's needed to detect it.
function formsEqual(a: FormData, b: FormData): boolean {
  const strip = (f: FormData) =>
    JSON.stringify({ ...f, images: f.images.map((i) => ({ id: i.id, url: i.url })) });
  return strip(a) === strip(b);
}

export default function ProductsPage() {
  const { user } = useAuth();
  const { isAdmin } = useRole();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(PRODUCT_STATUS_VALUES));
  const [availableFilter, setAvailableFilter] = useState<Set<string>>(new Set(AVAILABLE_VALUES));
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  // Snapshot openEdit loaded the form from — null in Add mode, where
  // there's nothing to be "unchanged" against. See formsEqual/isUnchanged.
  const [initialForm, setInitialForm] = useState<FormData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [deleteBlockers, setDeleteBlockers] = useState<ProductDeleteBlockers | null>(null);
  const [checkingDelete, setCheckingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  // Transient text for the "type/paste a barcode" input in the Add/Edit
  // dialog — not part of form state since it's cleared on every add.
  const [barcodeInput, setBarcodeInput] = useState("");
  // Units per barcode for the product being edited (null until loaded, or in
  // Add mode, where nothing has been issued against a new product yet).
  const [barcodeUnits, setBarcodeUnits] = useState<Record<string, BarcodeUnitCount> | null>(null);
  // A saved barcode the admin clicked x on and hasn't confirmed removing yet.
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  // Builds the same "who's affected, what to do about it" message Stock
  // Out's own conflict alert uses, as a plain string for this form's single
  // bottom error slot. Checked on Save, same as every other validation on
  // this form (barcode conflict, lend-date ordering) — editing
  // quantity_on_hand down bypasses Stock Out entirely, so it had no
  // protection against silently dropping stock below what an active loan
  // request (pending/countered/accepted) already has a claim on. Only
  // relevant in edit mode — a brand-new product can't have any requests
  // against it yet.
  function formatQuantityConflictError(holders: ReservationHolder[]): string {
    const names = holders
      .map((h) => `${h.staffName}'s ${reservationStatusLabel(h.status)} (${h.quantity} unit(s))`)
      .join(', ')
    return `This quantity would leave ${names} short. Resolve ${holders.length > 1 ? 'these' : 'this'} first — ${resolutionInstruction(holders)} — before saving.`
  }

  async function load() {
    setLoading(true);
    try {
      // We fetch all products and filter client-side (search matches name and any barcode).
      let data: Product[] = await listProducts();
      if (catFilter) {
        data = data.filter((p) => p.category_id === catFilter);
      }

      // Map category names and do client-side search for ilike
      const s = search.toLowerCase();
      if (s) {
        data = data.filter(
          (p) =>
            (p.name && p.name.toLowerCase().includes(s)) ||
            productBarcodes(p).some((b) => b.toLowerCase().includes(s)),
        );
      }

      // Sort by name
      data.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      setProducts(data);
    } finally {
      setLoading(false);
    }
  }

  async function loadCats() {
    setCategories(await listCategories());
  }

  useEffect(() => {
    load();
    loadCats();
  }, []);
  useEffect(() => {
    load();
  }, [search, catFilter]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setInitialForm(null);
    setBarcodeUnits(null);
    setPendingRemoval(null);
    setBarcodeInput("");
    setError("");
    setShowModal(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    const next: FormData = {
      name: p.name,
      barcodes: productBarcodes(p),
      category_id: p.category_id ?? "",
      description: p.description ?? "",
      quantity_on_hand: String(p.quantity_on_hand),
      reorder_threshold: String(p.reorder_threshold),
      available: p.available ?? true,
      location: p.location ?? DEFAULT_LOCATION,
      lend_from: p.lend_from ?? "",
      lend_to: p.lend_to ?? "",
      lending_interval: p.lending_interval ?? "week_1",
      quantity_reason: "",
      // Existing images are Storage paths — no File attached, so the
      // uploader/urlFormatter knows to resolve them via storageDownloadUrl
      // instead of an in-memory object URL.
      images: (p.images ?? []).map((path) => ({ id: path, url: path })),
    };
    setForm(next);
    // Same object Save Changes stays disabled against until form diverges
    // from it — see formsEqual/isUnchanged.
    setInitialForm(next);
    setBarcodeInput("");
    setBarcodeUnits(null);
    setPendingRemoval(null);
    // Unit counts per barcode load in behind the dialog (bubbles appear when
    // they land); removal re-fetches if they haven't.
    getBarcodeUnitCounts(p.id.toString()).then(setBarcodeUnits).catch(() => setBarcodeUnits(null));
    setError("");
    setShowModal(true);
  }

  function addBarcode(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setForm((f) =>
      // Appended, not prepended — new barcodes shouldn't silently jump to
      // primary and undo whatever order was set by dragging. The first
      // barcode ever added still lands at index 0, which is why existing
      // products keep their current primary untouched.
      f.barcodes.includes(trimmed) ? f : { ...f, barcodes: [...f.barcodes, trimmed] },
    );
    setBarcodeInput("");
  }

  function removeBarcode(code: string) {
    setForm((f) => ({ ...f, barcodes: f.barcodes.filter((b) => b !== code) }));
  }

  const outstandingBlockMessage = (code: string, n: number) =>
    `Can't remove "${code}": ${n} unit${n === 1 ? "" : "s"} issued under this barcode still need${n === 1 ? "s" : ""} to be returned. Process the return${n === 1 ? "" : "s"} first.`;

  // x on a barcode chip. A barcode added in this same edit hasn't been saved,
  // so no unit can carry it yet and it just comes off. A saved barcode may
  // have units issued under it: if any still need returning it is refused
  // outright (the Returns screen matches a scan against the barcode the item
  // left with, so it would become unreturnable); otherwise the admin gets a
  // warning with the unit count to confirm first.
  async function requestRemoveBarcode(code: string) {
    const saved = editing ? productBarcodes(editing) : [];
    if (!saved.includes(code)) {
      removeBarcode(code);
      return;
    }
    let counts = barcodeUnits;
    if (!counts) {
      try {
        counts = await getBarcodeUnitCounts(editing!.id.toString());
        setBarcodeUnits(counts);
      } catch {
        setError("Couldn't check where this barcode is in use. Try again.");
        return;
      }
    }
    const n = counts[code]?.outstanding ?? 0;
    if (n > 0) {
      setError(outstandingBlockMessage(code, n));
      return;
    }
    setError("");
    setPendingRemoval(code);
  }

  async function copyBarcode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`Copied "${code}"`);
    } catch {
      toast.error("Couldn't copy — clipboard access was blocked.");
    }
  }

  // Delete — gated on the same two checks the quantity-reduction guard
  // above already runs individually (findQuantityReductionConflicts covers
  // active reservations; deleting also needs the Dashboard's own
  // outstanding-OUT-balance ledger, scoped to this one product). Opens the
  // confirm dialog right away in a "checking" state rather than blocking
  // the click on the fetch, same as any other confirm-dialog flow in this
  // app.
  async function openDelete(p: Product) {
    setDeleting(p);
    setDeleteBlockers(null);
    setCheckingDelete(true);
    try {
      setDeleteBlockers(await getProductDeleteBlockers(p.id.toString()));
    } catch {
      toast.error("Could not check this product's lending status.");
      setDeleting(null);
    } finally {
      setCheckingDelete(false);
    }
  }

  function closeDelete() {
    setDeleting(null);
    setDeleteBlockers(null);
  }

  async function confirmDelete() {
    if (!deleting || !deleteBlockers || productDeleteBlockReason(deleteBlockers)) return;
    setDeleteBusy(true);
    try {
      // The server refuses (409) to delete a product that has stock history or is
      // still out / reserved, so it goes first; the photos are only removed once the
      // product is really gone. Best-effort — a photo that fails to delete shouldn't
      // fail a delete that already succeeded, same tolerance handleSave gives
      // removed-image cleanup on a plain edit.
      await deleteProduct(deleting.id.toString());
      await Promise.all(
        (deleting.images ?? []).map((path) =>
          deleteObject(ref(storage, path)).catch(() => {}),
        ),
      );
      toast.success(`${deleting.name} deleted.`);
      closeDelete();
      load();
    } catch (err: any) {
      toast.error("Could not delete this product. " + (err?.message ?? ""));
    } finally {
      setDeleteBusy(false);
    }
  }

  // The first barcode in the array is the primary one (see productBarcodes()
  // and every "primary barcode" display across the app) — dragging a chip to
  // the top makes it primary instead of relying on insertion order.
  function handleBarcodeDragEnd(result: DropResult) {
    if (!result.destination) return;
    setForm((f) => {
      const items = Array.from(f.barcodes);
      const [reordered] = items.splice(result.source.index, 1);
      items.splice(result.destination!.index, 0, reordered);
      return { ...f, barcodes: items };
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (form.barcodes.length === 0) {
      setError("Add at least one barcode.");
      return;
    }
    // Re-check on submit too, not just via the live effect — a fast
    // double-click on Save could otherwise slip through before the
    // debounced check has resolved.
    if (editing) {
      // Re-checked against fresh data (not the counts loaded when the dialog
      // opened): a barcode with units still to be returned can't come off.
      const removed = productBarcodes(editing).filter((b) => !form.barcodes.includes(b));
      if (removed.length > 0) {
        try {
          const counts = await getBarcodeUnitCounts(editing.id.toString());
          const blocked = removed.find((b) => (counts[b]?.outstanding ?? 0) > 0);
          if (blocked) {
            setError(outstandingBlockMessage(blocked, counts[blocked].outstanding));
            return;
          }
        } catch {
          setError("Couldn't check whether the removed barcodes still have units to return. Try again.");
          return;
        }
      }
      let offenders: ReservationHolder[];
      try {
        offenders = await findQuantityReductionConflicts(editing.id.toString(), Number(form.quantity_on_hand));
      } catch (err) {
        // The server's own message (e.g. a Qty On Hand that isn't a whole number).
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (offenders.length > 0) {
        setError(formatQuantityConflictError(offenders));
        return;
      }
      if (
        Number(form.quantity_on_hand) !== (editing.quantity_on_hand ?? 0) &&
        !form.quantity_reason.trim()
      ) {
        setError("Enter a reason for the Qty On Hand change.");
        return;
      }
    }
    // Available From may be in the past; Available To only has to come after it.
    if (form.lend_from && form.lend_to && form.lend_to <= form.lend_from) {
      setError("Available To date must be after the Available From date.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const conflict = await findBarcodeConflict(
        form.barcodes,
        editing?.id.toString(),
      );
      if (conflict) {
        setError(`Barcode "${conflict}" is already used by another product.`);
        setSaving(false);
        return;
      }

      const basePayload = {
        name: form.name,
        barcodes: form.barcodes,
        category_id: form.category_id || null,
        description: form.description,
        quantity_on_hand: Number(form.quantity_on_hand),
        reorder_threshold: Number(form.reorder_threshold),
        available: form.available,
        location: form.location,
        lend_from: form.lend_from || null,
        lend_to: form.lend_to || null,
        lending_interval: form.lending_interval,
      };

      const discardUploads = (paths: string[]) =>
        Promise.all(paths.map((p) => deleteObject(ref(storage, p)).catch(() => {})));

      // Upload any newly-picked files under products/<productId>/, keep existing
      // paths as-is. If the save below fails, the files uploaded here are removed
      // again (best-effort) so a rejected save doesn't leave orphans in Storage.
      const uploadImages = async (productId: string): Promise<{ images: string[]; uploaded: string[] }> => {
        const images: string[] = [];
        const uploaded: string[] = [];
        try {
          for (let i = 0; i < form.images.length; i++) {
            const img = form.images[i];
            if (img.file) {
              const path = `products/${productId}/${Date.now()}-${i}-${img.file.name}`;
              await uploadBytes(ref(storage, path), img.file);
              uploaded.push(path);
              images.push(path);
            } else {
              images.push(img.url);
            }
          }
        } catch (err) {
          await discardUploads(uploaded);
          throw err;
        }
        return { images, uploaded };
      };

      if (editing) {
        const productId = editing.id.toString();
        const { images, uploaded } = await uploadImages(productId);

        let saved: Product;
        try {
          // The server writes the audit entry (the change reason rides along for it).
          saved = await updateProduct(productId, {
            ...basePayload,
            images,
            ...(form.quantity_reason.trim() ? { quantity_reason: form.quantity_reason.trim() } : {}),
          });
        } catch (err) {
          await discardUploads(uploaded);
          throw err;
        }

        // Remove any images the admin dropped from the list — only now that the
        // product is saved without them.
        const keptPaths = new Set(
          form.images.filter((img) => !img.file).map((img) => img.url),
        );
        await discardUploads(
          (editing.images ?? []).filter((p) => !keptPaths.has(p)),
        );

        // Low stock email: only when this edit left the product at or below
        // its reorder threshold after it was above it (the server re-checks).
        // Background and best-effort; the edit is already saved.
        if (
          Number(basePayload.quantity_on_hand) <= Number(basePayload.reorder_threshold) &&
          (editing.quantity_on_hand ?? 0) > (editing.reorder_threshold ?? 0)
        ) {
          notifyProductStockChange(user, {
            productId: saved.id.toString(),
            previousQuantity: editing.quantity_on_hand ?? 0,
            previousThreshold: editing.reorder_threshold ?? 0,
          });
        }
      } else {
        // Photos upload under the final id first, so the product is created once
        // (the server writes the audit entry).
        const productId = newProductId();
        const { images, uploaded } = await uploadImages(productId);
        try {
          await createProduct({ ...basePayload, id: productId, images });
        } catch (err) {
          await discardUploads(uploaded);
          throw err;
        }
      }

      setShowModal(false);
      setForm(EMPTY_FORM);
      setEditing(null);
      load();
    } catch (err: any) {
      setError(err.message);
    }
    setSaving(false);
  }

  // Same shared columnHelper/SortableHead as Reports, the Audit Log and the
  // Dashboard's three widgets — sorting only, no pagination or CSV export
  // here (this table already shows every matching product, filtered by the
  // search box / category Select above rather than paginated).
  const filteredProducts = products.filter(
    (p) =>
      statusFilter.has(stockStatusLabel(p.quantity_on_hand, p.reorder_threshold)) &&
      availableFilter.has(isLendableNow(p) ? "Available" : "Unavailable"),
  );

  const table = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: PRODUCTS_COLUMNS,
    data: filteredProducts,
    state: { sorting },
    onSortingChange: setSorting,
  });
  const sortedProducts = table.getSortedRowModel().rows.map((r) => r.original as Product);

  // Only meaningful in edit mode — a brand-new product has no "unchanged"
  // baseline to compare against (initialForm is null in Add mode).
  const isUnchanged = editing !== null && initialForm !== null && formsEqual(form, initialForm);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Products</h1>
          <p className="text-sm text-[#5B4F67]">
            {products.length} items
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="size-4" /> Add Product
        </Button>
      </div>

      {/* Filters */}
      <Card className="mb-4 rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
        <CardContent>
        <CollapsibleFilters
          className="flex-wrap items-end gap-3"
          summary={`${filteredProducts.length} ${filteredProducts.length === 1 ? 'product' : 'products'}`}
          active={!!search.trim() || !!catFilter || statusFilter.size < PRODUCT_STATUS_VALUES.length || availableFilter.size < AVAILABLE_VALUES.length}
        >
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Categories</span>
          <Select
            items={{
              [ALL_CATEGORIES]: "All categories",
              ...Object.fromEntries(categories.map((c) => [c.id, c.name])),
            }}
            value={catFilter || ALL_CATEGORIES}
            onValueChange={(v) =>
              setCatFilter(v && v !== ALL_CATEGORIES ? v : "")
            }
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Status</span>
          <StatusFilter selected={statusFilter} onChange={setStatusFilter} />
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Availability</span>
          <AvailableFilter selected={availableFilter} onChange={setAvailableFilter} />
        </div>
        <div className="relative min-w-40 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search name, barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        </CollapsibleFilters>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="min-h-0 flex-1 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <SortableHead column={table.getColumn("name")!} className="h-auto py-3.5 pl-6 text-base font-bold text-[#2D203A]">Product</SortableHead>
              <SortableHead column={table.getColumn("barcode")!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Barcode</SortableHead>
              <SortableHead column={table.getColumn("category_name")!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Category</SortableHead>
              <SortableHead column={table.getColumn("quantity_on_hand")!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Qty</SortableHead>
              <SortableHead column={table.getColumn("status")!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
              <SortableHead column={table.getColumn("available")!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Available</SortableHead>
              <TableHead className="h-auto py-3.5 pr-6"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!loading && sortedProducts.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-muted-foreground"
                >
                  {statusFilter.size === 0
                    ? "No statuses selected"
                    : availableFilter.size === 0
                      ? "No availability selected"
                      : search
                        ? `No products match "${search}"`
                        : "No products found"}
                </TableCell>
              </TableRow>
            )}
            {sortedProducts.map((p) => (
              <TableRow key={p.id} className="hover:bg-[#FAF7FC]">
                {/* TableCell is whitespace-nowrap by default (see
                    components/ui/table.tsx) — fine for the short columns
                    that follow, but a long product description would
                    otherwise render as one unbroken line and stretch the
                    whole table past the viewport instead of wrapping. Wrap
                    plus break-words (an unbroken token, not just spaces,
                    shouldn't be able to push it wide either), capped at a
                    fixed width so it wraps THERE instead of growing to fit
                    the longest description in the list. */}
                <TableCell className="max-w-xs py-4 pl-6 whitespace-normal break-words">
                  <div className="font-medium text-foreground">{p.name}</div>
                  {p.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                </TableCell>
                {/* Same overflow problem as the Product cell above, plus two
                    extra wrinkles a barcode has and a description doesn't.
                    (1) It sits inside an inline-flex row with the copy
                    button, and a flex item's default min-width is `auto`,
                    not 0 -- min-w-0 overrides that so the text is actually
                    allowed to shrink below its own content width.
                    (2) It's one long unbroken token with no spaces at all --
                    and per the CSS Text spec, `overflow-wrap: break-word`
                    (Tailwind's break-words, used on the Product cell above)
                    is explicitly excluded from min-content sizing: browsers
                    are told to compute intrinsic size as if it were
                    `normal`. That's harmless for the Product cell, which is
                    a plain block of text -- once max-w-xs pins the column's
                    rendered width, break-words wraps fine within it. But
                    inside a flex row, the browser has to know how far this
                    item is ALLOWED to shrink before it can even get to that
                    resolved width, and break-words' min-content is "however
                    long the whole barcode is" -- so the row never shrinks,
                    and nothing ever wraps. `word-break: break-all`
                    (Tailwind's break-all) doesn't have that spec carve-out,
                    so it genuinely participates in the sizing and actually
                    forces the break once the column's width is reached. */}
                <TableCell className="max-w-xs py-4 font-mono text-xs whitespace-normal text-muted-foreground">
                  {productBarcodes(p)[0] ? (
                    <span className="inline-flex min-w-0 items-start gap-1">
                      <span className="min-w-0 break-all">
                        {productBarcodes(p)[0]}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyBarcode(productBarcodes(p)[0])}
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                        title="Copy barcode"
                      >
                        <Copy className="size-3" />
                      </button>
                    </span>
                  ) : (
                    "—"
                  )}
                  {productBarcodes(p).length > 1 && (
                    <span className="ml-1 text-muted-foreground/70">
                      +{productBarcodes(p).length - 1} more
                    </span>
                  )}
                </TableCell>
                <TableCell className="py-4 text-muted-foreground">
                  {p.category_name ?? "—"}
                </TableCell>
                <TableCell className="py-4 font-semibold">
                  {p.quantity_on_hand}
                </TableCell>
                <TableCell className="py-4">
                  <Badge
                    className={STATUS_BADGE_CLASS(
                      p.quantity_on_hand,
                      p.reorder_threshold,
                    )}
                  >
                    {stockStatusLabel(p.quantity_on_hand, p.reorder_threshold)}
                  </Badge>
                </TableCell>
                <TableCell className="py-4">
                  <Badge className={AVAILABLE_BADGE_CLASS(isLendableNow(p))}>
                    {isLendableNow(p) ? "Available" : "Unavailable"}
                  </Badge>
                </TableCell>
                <TableCell className="py-4 pr-6">
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                      onClick={() => openEdit(p)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                      onClick={() => setPreviewProduct(p)}
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => openDelete(p)}
                        className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      </Card>

      {/* Add / Edit product modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[820px]">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Product" : "Add Product"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
              {/* Left column: Product details */}
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  Product details
                </h3>
                <div className="grid gap-1.5">
                  <Label htmlFor="p-name">Name *</Label>
                  <Input
                    id="p-name"
                    required
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Category</Label>
                  <Select
                    items={{
                      [NO_CATEGORY]: "— none —",
                      ...Object.fromEntries(
                        categories.map((c) => [c.id, c.name]),
                      ),
                    }}
                    value={form.category_id || NO_CATEGORY}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        category_id: v && v !== NO_CATEGORY ? v : "",
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>— none —</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="p-qty">
                      {editing ? "Qty On Hand" : "Initial Qty"}
                    </Label>
                    <Input
                      id="p-qty"
                      type="number"
                      min="0"
                      value={form.quantity_on_hand}
                      onChange={(e) => {
                        const nextQty = e.target.value
                        setForm((f) => ({
                          ...f,
                          quantity_on_hand: nextQty,
                          // A product with zero stock can't be Available — force
                          // it back to Unavailable right here rather than just
                          // disabling the dropdown below, so this holds even if
                          // qty is edited after Availability was already set.
                          available: Number(nextQty) > 0 ? f.available : false,
                        }))
                      }}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="p-threshold">Reorder Threshold</Label>
                    <Input
                      id="p-threshold"
                      type="number"
                      min="0"
                      value={form.reorder_threshold}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          reorder_threshold: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                {/* On wide screens the left column is stretched to the height of
                    the right one (Availability + Photos), and the Description
                    takes up all the spare height so its bottom edge lines up
                    with the bottom of the photo list. */}
                <div className="grid gap-1.5 md:flex-1 md:grid-rows-[auto_minmax(0,1fr)]">
                  <Label htmlFor="p-description">Description</Label>
                  <Textarea
                    id="p-description"
                    rows={2}
                    className="max-h-24 resize-none overflow-y-auto md:field-sizing-fixed md:h-full md:max-h-none md:min-h-24"
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="p-location">Location</Label>
                  <Textarea
                    id="p-location"
                    rows={2}
                    className="max-h-24 resize-none overflow-y-auto"
                    value={form.location}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, location: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* Right column: Product availability */}
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  Product availability
                </h3>
                <div className="grid grid-cols-2 items-start gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="p-lend-from">Available From</Label>
                    <AvailabilityDatePicker
                      id="p-lend-from"
                      className="w-full"
                      value={form.lend_from}
                      onChange={(nextLendFrom) => {
                        setForm((f) => ({
                          ...f,
                          lend_from: nextLendFrom,
                          // Clearing Lend From can't leave a Lend To dangling
                          // with nothing to be "after" — and a product with no
                          // Lend From can't stay Available (see Availability's
                          // onChange/disabled logic above, same pattern).
                          // A Lend To that is no longer after the new Lend From is dropped too.
                          lend_to: nextLendFrom && f.lend_to > nextLendFrom ? f.lend_to : "",
                          available: nextLendFrom ? f.available : false,
                        }))
                      }}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="p-lend-to">Available To</Label>
                    <AvailabilityDatePicker
                      id="p-lend-to"
                      className="w-full"
                      min={form.lend_from ? addDaysToDateStr(form.lend_from, 1) : undefined}
                      value={form.lend_to}
                      disabled={!form.lend_from}
                      onChange={(next) =>
                        setForm((f) => ({ ...f, lend_to: next }))
                      }
                    />
                    {!form.lend_from && (
                      <p className="text-xs text-muted-foreground">
                        Set an Available From date first.
                      </p>
                    )}
                    {form.lend_from && form.lend_to && (
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          Clear if always available
                        </p>
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, lend_to: "" }))}
                          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="p-lending-interval">Lending Interval</Label>
                  <div className="px-1 pt-1">
                    <input
                      id="p-lending-interval"
                      type="range"
                      min={0}
                      max={LENDING_INTERVALS.length - 1}
                      step={1}
                      value={LENDING_INTERVALS.findIndex((i) => i.value === form.lending_interval)}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          lending_interval: LENDING_INTERVALS[Number(e.target.value)].value,
                        }))
                      }
                      className="w-full accent-primary"
                    />
                    <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                      {LENDING_INTERVALS.map((interval) => (
                        <span
                          key={interval.value}
                          className={interval.value === form.lending_interval ? "font-semibold text-foreground" : undefined}
                        >
                          {interval.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {form.lending_interval === "indefinite"
                      ? "Staff won't be required to set a return date for this item on the portal — same convenience as leaving \"Lend To\" blank on Stock Out."
                      : `The longest a single portal loan of this item can run for — currently ${LENDING_INTERVALS.find((i) => i.value === form.lending_interval)?.label.toLowerCase()}.`}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Availability</Label>
                  <Select
                    items={AVAILABLE_ITEMS}
                    value={form.available ? "true" : "false"}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        // Belt-and-braces alongside the disabled SelectItem
                        // below — can't be set to Available at zero stock or
                        // with no Lend From date set.
                        available: v !== "false" && Number(f.quantity_on_hand) > 0 && !!f.lend_from,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        value="true"
                        disabled={!(Number(form.quantity_on_hand) > 0) || !form.lend_from}
                      >
                        Available
                      </SelectItem>
                      <SelectItem value="false">Unavailable</SelectItem>
                    </SelectContent>
                  </Select>
                  {(() => {
                    const qtyBlocks = !(Number(form.quantity_on_hand) > 0)
                    const lendFromBlocks = !form.lend_from
                    if (!qtyBlocks && !lendFromBlocks) return null
                    const reason =
                      qtyBlocks && lendFromBlocks
                        ? "Qty On Hand is 0 and no Available From date is set"
                        : qtyBlocks
                          ? "Qty On Hand is 0"
                          : "No Available From date is set"
                    return (
                      <p className="text-xs text-muted-foreground">
                        {reason} — must stay Unavailable.
                      </p>
                    )
                  })()}
                </div>
                <div className="grid gap-1.5">
                  <h3 className="text-sm font-semibold text-muted-foreground">
                    Photos
                  </h3>
                  <MultiImageUploader
                    images={form.images}
                    max={MAX_IMAGES}
                    disabled={!isAdmin}
                    onImagesChange={(images) => setForm((f) => ({ ...f, images }))}
                    urlFormatter={(image) =>
                      image.file ? image.url : storageDownloadUrl(image.url)
                    }
                  />
                </div>
              </div>
            </div>
            <h3 className="text-sm font-semibold text-muted-foreground">
              Barcodes
            </h3>
            {/* Its own top-level section, spanning the full card width --
                not nested in either column -- per Occusoft's request.
                min-w-0 here (and on the flex/grid descendants below: the
                chip list, each chip row, and the chip's own text wrapper)
                breaks the chain of "automatic minimum size" defaults that
                flex/grid items get unless told otherwise -- without it at
                EVERY level between here and the actual scrollable chip
                below, a long barcode's content bubbles all the way up and
                stretches this whole section (and, before the Dialog-level
                fix, the dialog itself) no matter what overflow handling is
                set on the chip. */}
            <div className="grid min-w-0 gap-1.5">
              {form.barcodes.length > 0 && (
                <DragDropContext onDragEnd={handleBarcodeDragEnd}>
                  <Droppable droppableId="product-barcodes" direction="vertical">
                    {(provided) => (
                      <div
                        {...provided.droppableProps}
                        ref={provided.innerRef}
                        className="flex min-w-0 flex-col gap-1.5"
                      >
                        {form.barcodes.map((code, i) => (
                          <Draggable key={code} draggableId={code} index={i}>
                            {(provided, snapshot) => (
                              <div
                                {...provided.draggableProps}
                                ref={provided.innerRef}
                                className={`flex min-w-0 items-center gap-2 rounded-md border bg-muted px-2 py-1.5 font-mono text-xs ${snapshot.isDragging ? "bg-accent shadow-md" : ""}`}
                              >
                                <div
                                  {...provided.dragHandleProps}
                                  className="cursor-grab text-muted-foreground active:cursor-grabbing"
                                  title="Drag to reorder"
                                >
                                  <GripVertical className="size-3.5" />
                                </div>
                                {/* min-w-0 so this flex item can actually
                                    shrink below the barcode's own width (see
                                    the Products-table barcode cell for the
                                    full explanation), then overflow-x-auto
                                    instead of truncating -- a long code gets
                                    its own tiny scrollbar so it stays fully
                                    readable, instead of either an ellipsis or
                                    the whole dialog gaining a scrollbar. */}
                                <div className="min-w-0 flex-1 overflow-x-auto">
                                  <span className="whitespace-nowrap">{code}</span>
                                </div>
                                {i === 0 && form.barcodes.length > 1 && (
                                  <Badge className="bg-emerald-100 text-[10px] text-emerald-800">
                                    Primary
                                  </Badge>
                                )}
                                {/* How many units carry this barcode, counted
                                    from the barcodes scanned at Stock In / Out /
                                    Return. Saved barcodes only -- one added in
                                    this edit can't be on a unit yet. */}
                                {editing && barcodeUnits && productBarcodes(editing).includes(code) && (
                                  <>
                                    <Badge
                                      className="bg-sky-100 text-[10px] text-sky-800"
                                      title={`${barcodeUnits[code]?.total ?? 0} unit(s) carry this barcode: ${barcodeUnits[code]?.inStock ?? 0} in stock, ${barcodeUnits[code]?.outstanding ?? 0} issued and not yet returned. Counted from recorded scans only.`}
                                    >
                                      {barcodeUnits[code]?.total ?? 0} {(barcodeUnits[code]?.total ?? 0) === 1 ? "unit" : "units"}
                                    </Badge>
                                    {(barcodeUnits[code]?.outstanding ?? 0) > 0 && (
                                      <Badge className="bg-amber-100 text-[10px] text-amber-800">
                                        {barcodeUnits[code].outstanding} out
                                      </Badge>
                                    )}
                                  </>
                                )}
                                <button
                                  type="button"
                                  onClick={() => requestRemoveBarcode(code)}
                                  className={`text-muted-foreground hover:text-red-600 ${editing && (barcodeUnits?.[code]?.outstanding ?? 0) > 0 && productBarcodes(editing).includes(code) ? "cursor-not-allowed opacity-40 hover:text-muted-foreground" : ""}`}
                                  title={
                                    editing && (barcodeUnits?.[code]?.outstanding ?? 0) > 0 && productBarcodes(editing).includes(code)
                                      ? `${barcodeUnits![code].outstanding} unit(s) issued under this barcode still need to be returned — it can't be removed`
                                      : "Remove barcode"
                                  }
                                >
                                  <X className="size-3" />
                                </button>
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
              )}
              <div className="flex gap-1">
                <Input
                  id="p-barcode"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addBarcode(barcodeInput);
                    }
                  }}
                  placeholder="Scan or type a barcode, then Enter"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addBarcode(barcodeInput)}
                  disabled={!barcodeInput.trim()}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Generate a new NWU barcode"
                  onClick={() => addBarcode(genBarcode())}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Keep the manufacturer's original barcode/QR code and add your
                own — either will scan to this product.
              </p>
            </div>
            {editing &&
              Number(form.quantity_on_hand) !== (editing.quantity_on_hand ?? 0) && (
                <div className="grid gap-1.5">
                  <Label htmlFor="p-qty-reason">
                    Reason for Qty On Hand change *
                  </Label>
                  <Textarea
                    id="p-qty-reason"
                    required
                    rows={2}
                    value={form.quantity_reason}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, quantity_reason: e.target.value }))
                    }
                    placeholder="e.g. Stock count correction, damaged units written off, new delivery..."
                  />
                </div>
              )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || isUnchanged}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Product"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Delete product?</DialogTitle>
          </DialogHeader>
          {deleting && (
            <p className="text-sm">
              <strong className="text-foreground">{deleting.name}</strong>
            </p>
          )}
          {checkingDelete ? (
            <p className="text-sm text-muted-foreground">
              Checking for outstanding loans and pending requests…
            </p>
          ) : deleteBlockers && productDeleteBlockReason(deleteBlockers) ? (
            <Alert variant="destructive">
              <AlertDescription>
                {productDeleteBlockReason(deleteBlockers)}
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              It has no outstanding loans or pending requests, so this is
              safe. This permanently removes the product and its photos and
              can&apos;t be undone.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDelete}
              disabled={deleteBusy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                checkingDelete ||
                deleteBusy ||
                !deleteBlockers ||
                !!(deleteBlockers && productDeleteBlockReason(deleteBlockers))
              }
              onClick={confirmDelete}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm removing a SAVED barcode (one with nothing left to return --
          if units are still out, requestRemoveBarcode refuses before this). */}
      <Dialog open={pendingRemoval !== null} onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Remove barcode?</DialogTitle>
          </DialogHeader>
          {pendingRemoval && (() => {
            const c = barcodeUnits?.[pendingRemoval];
            const n = c?.total ?? 0;
            return (
              <div className="grid gap-3 text-sm">
                <p className="break-all font-mono text-xs">{pendingRemoval}</p>
                <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                  <AlertDescription>
                    {n > 0 ? (
                      <>
                        <strong>{n} unit{n === 1 ? "" : "s"}</strong> of this product currently carry this barcode
                        {c ? ` (${c.inStock} in stock, ${c.outstanding} issued)` : ""}. Replace the label on
                        {n === 1 ? " that unit" : <> all <strong>{n}</strong> units</>} with another barcode of this
                        product. Once it is removed, anything still labelled with it will no longer scan.
                      </>
                    ) : (
                      <>
                        No units are recorded under this barcode, but stock received before barcodes were captured
                        isn&apos;t counted. Make sure no unit still carries this label — once removed it will no
                        longer scan.
                      </>
                    )}
                  </AlertDescription>
                </Alert>
                <p className="text-xs text-muted-foreground">The barcode is only removed once you save the product.</p>
              </div>
            );
          })()}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingRemoval(null)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => { if (pendingRemoval) removeBarcode(pendingRemoval); setPendingRemoval(null); }}
            >
              Remove barcode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProductPreviewDialog
        product={previewProduct}
        onClose={() => setPreviewProduct(null)}
      />
    </div>
  );
}
