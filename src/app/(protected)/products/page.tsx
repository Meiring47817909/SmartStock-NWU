"use client";

import { useEffect, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { stockStatusLabel, genBarcode, formatDateOnly, todayDateStr } from "@/lib/utils";
import { Search, Plus, Pencil, Eye, RefreshCw, ImageOff, X, GripVertical, Copy } from "lucide-react";
import { toast } from "sonner";
import { db, storage } from "@/lib/firebase/config";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  orderBy,
} from "firebase/firestore";
import { ref, uploadBytes, deleteObject } from "firebase/storage";
import { storageDownloadUrl } from "@/lib/firebase/storage";
import { findBarcodeConflict } from "@/lib/firebase/products";
import { logAudit } from "@/lib/firebase/audit";
import { useAuth } from "@/context/AuthContext";
import { useRole } from "@/context/RoleContext";
import { Card } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import MultiImageUploader, {
  type ImageUpload,
} from "@/components/products/MultiImageUploader";
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
// formatLendDate moved to the shared formatDateOnly() in @/lib/utils — the
// Audit Log's friendly transaction/product diff view needed the same
// date-only-safe formatting, so it's no longer specific to this page.
const formatLendDate = formatDateOnly;

const STATUS_BADGE_CLASS = (qty: number, threshold: number) =>
  qty === 0
    ? "bg-red-100 text-red-800"
    : qty <= threshold
      ? "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";

// Availability items keyed by string since Base UI's Select works on string
// values — mapped back to/from the boolean `available` field on save/load.
const AVAILABLE_ITEMS: Record<"true" | "false", string> = {
  true: "Available",
  false: "Unavailable",
};

const AVAILABLE_BADGE_CLASS = (available: boolean) =>
  available ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800";

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
  images: ImageUpload[];
};

const EMPTY_FORM: FormData = {
  name: "",
  barcodes: [],
  category_id: "",
  description: "",
  quantity_on_hand: "0",
  reorder_threshold: "5",
  available: true,
  location: DEFAULT_LOCATION,
  lend_from: "",
  lend_to: "",
  images: [],
};

export default function ProductsPage() {
  const { user, profile } = useAuth();
  const { isAdmin } = useRole();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null);
  const [activeImage, setActiveImage] = useState(0);
  // Transient text for the "type/paste a barcode" input in the Add/Edit
  // dialog — not part of form state since it's cleared on every add.
  const [barcodeInput, setBarcodeInput] = useState("");

  // Reset to the first photo whenever a different product is previewed.
  useEffect(() => {
    setActiveImage(0);
  }, [previewProduct?.id]);

  // Auto-cycle through photos every 5s, only while there's more than one.
  useEffect(() => {
    const images = previewProduct?.images;
    if (!images || images.length <= 1) return;
    const timer = setInterval(() => {
      setActiveImage((i) => (i + 1) % images.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [previewProduct?.id, previewProduct?.images]);

  async function load() {
    setLoading(true);
    const productsRef = collection(db, "products");

    // We fetch all products (Firestore queries are limited for client-side search)
    let q = query(productsRef);
    if (catFilter) {
      q = query(productsRef, where("category_id", "==", catFilter));
    }

    const snap = await getDocs(q);
    let data = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as any[];

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

    setProducts(data as Product[]);
    setLoading(false);
  }

  async function loadCats() {
    const snap = await getDocs(
      query(collection(db, "categories"), orderBy("name")),
    );
    setCategories(
      snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as any[],
    );
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
    setBarcodeInput("");
    setError("");
    setShowModal(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm({
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
      // Existing images are Storage paths — no File attached, so the
      // uploader/urlFormatter knows to resolve them via storageDownloadUrl
      // instead of an in-memory object URL.
      images: (p.images ?? []).map((path) => ({ id: path, url: path })),
    });
    setBarcodeInput("");
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

  async function copyBarcode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`Copied "${code}"`);
    } catch {
      toast.error("Couldn't copy — clipboard access was blocked.");
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
    if (form.lend_from && form.lend_from < todayDateStr()) {
      setError("Lend From date can't be in the past.");
      return;
    }
    if (form.lend_from && form.lend_to && form.lend_to < form.lend_from) {
      setError("Lend To date can't be before Lend From date.");
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

      const catName =
        categories.find((c) => c.id === form.category_id)?.name || null;
      const basePayload = {
        name: form.name,
        barcodes: form.barcodes,
        category_id: form.category_id || null,
        category_name: catName, // Denormalized for easier rendering
        description: form.description,
        quantity_on_hand: Number(form.quantity_on_hand),
        reorder_threshold: Number(form.reorder_threshold),
        available: form.available,
        location: form.location,
        lend_from: form.lend_from || null,
        lend_to: form.lend_to || null,
        updated_at: new Date().toISOString(),
      };

      if (editing) {
        const productId = editing.id.toString();

        // Remove any images the admin dropped from the list.
        const keptPaths = new Set(
          form.images.filter((img) => !img.file).map((img) => img.url),
        );
        const removedPaths = (editing.images ?? []).filter(
          (p) => !keptPaths.has(p),
        );
        await Promise.all(
          removedPaths.map((p) =>
            deleteObject(ref(storage, p)).catch(() => {}),
          ),
        );

        // Upload any newly-picked files, keep existing paths as-is.
        const images: string[] = [];
        for (let i = 0; i < form.images.length; i++) {
          const img = form.images[i];
          if (img.file) {
            const path = `products/${productId}/${Date.now()}-${i}-${img.file.name}`;
            await uploadBytes(ref(storage, path), img.file);
            images.push(path);
          } else {
            images.push(img.url);
          }
        }

        const payload = { ...basePayload, images };
        await updateDoc(doc(db, "products", productId), payload);
        logAudit({
          userId: user?.uid,
          userName: profile?.full_name ?? user?.email,
          action: "update",
          entityType: "product",
          entityId: productId,
          before: {
            name: editing.name,
            barcodes: productBarcodes(editing),
            category_id: editing.category_id ?? null,
            description: editing.description ?? "",
            quantity_on_hand: editing.quantity_on_hand ?? 0,
            reorder_threshold: editing.reorder_threshold ?? 0,
            available: editing.available ?? true,
            location: editing.location ?? DEFAULT_LOCATION,
            lend_from: editing.lend_from ?? null,
            lend_to: editing.lend_to ?? null,
            images: editing.images ?? [],
          },
          after: payload,
        });
      } else {
        const createPayload = {
          ...basePayload,
          created_at: new Date().toISOString(),
          images: [] as string[],
        };
        const productRef = await addDoc(
          collection(db, "products"),
          createPayload,
        );

        // Images are uploaded under products/<id>/... so we need the doc ID
        // first — upload happens after create, then a follow-up update
        // attaches the resulting storage paths.
        const images: string[] = [];
        for (let i = 0; i < form.images.length; i++) {
          const img = form.images[i];
          if (img.file) {
            const path = `products/${productRef.id}/${Date.now()}-${i}-${img.file.name}`;
            await uploadBytes(ref(storage, path), img.file);
            images.push(path);
          }
        }
        if (images.length) await updateDoc(productRef, { images });

        logAudit({
          userId: user?.uid,
          userName: profile?.full_name ?? user?.email,
          action: "create",
          entityType: "product",
          entityId: productRef.id,
          before: null,
          after: { ...createPayload, images },
        });
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

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {products.length} active items
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="size-4" /> Add Product
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <div className="relative max-w-80 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search name, barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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

      {/* Table */}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Barcode</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Available</TableHead>
              <TableHead></TableHead>
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
            {!loading && products.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-muted-foreground"
                >
                  No products found
                </TableCell>
              </TableRow>
            )}
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div className="font-medium text-foreground">{p.name}</div>
                  {p.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {productBarcodes(p)[0] ? (
                    <span className="inline-flex items-center gap-1">
                      {productBarcodes(p)[0]}
                      <button
                        type="button"
                        onClick={() => copyBarcode(productBarcodes(p)[0])}
                        className="text-muted-foreground hover:text-foreground"
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
                <TableCell className="text-muted-foreground">
                  {p.category_name ?? "—"}
                </TableCell>
                <TableCell className="font-semibold">
                  {p.quantity_on_hand}
                </TableCell>
                <TableCell>
                  <Badge
                    className={STATUS_BADGE_CLASS(
                      p.quantity_on_hand,
                      p.reorder_threshold,
                    )}
                  >
                    {stockStatusLabel(p.quantity_on_hand, p.reorder_threshold)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge className={AVAILABLE_BADGE_CLASS(p.available ?? true)}>
                    {p.available ?? true ? "Available" : "Unavailable"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openEdit(p)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPreviewProduct(p)}
                    >
                      <Eye className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Add / Edit product modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Product" : "Add Product"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
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
              <div className="grid gap-1.5">
                <Label htmlFor="p-qty">
                  {editing ? "Qty On Hand" : "Initial Qty"}
                </Label>
                <Input
                  id="p-qty"
                  type="number"
                  min="0"
                  value={form.quantity_on_hand}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, quantity_on_hand: e.target.value }))
                  }
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
              <div className="grid gap-1.5">
                <Label>Availability</Label>
                <Select
                  items={AVAILABLE_ITEMS}
                  value={form.available ? "true" : "false"}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      available: v !== "false",
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Available</SelectItem>
                    <SelectItem value="false">Unavailable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="p-lend-from">Lend From</Label>
                <Input
                  id="p-lend-from"
                  type="date"
                  min={todayDateStr()}
                  value={form.lend_from}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, lend_from: e.target.value }))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="p-lend-to">Lend To</Label>
                <Input
                  id="p-lend-to"
                  type="date"
                  min={form.lend_from || todayDateStr()}
                  value={form.lend_to}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, lend_to: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="p-barcode">Barcodes *</Label>
              {form.barcodes.length > 0 && (
                <DragDropContext onDragEnd={handleBarcodeDragEnd}>
                  <Droppable droppableId="product-barcodes" direction="vertical">
                    {(provided) => (
                      <div
                        {...provided.droppableProps}
                        ref={provided.innerRef}
                        className="flex flex-col gap-1.5"
                      >
                        {form.barcodes.map((code, i) => (
                          <Draggable key={code} draggableId={code} index={i}>
                            {(provided, snapshot) => (
                              <div
                                {...provided.draggableProps}
                                ref={provided.innerRef}
                                className={`flex items-center gap-2 rounded-md border bg-muted px-2 py-1.5 font-mono text-xs ${snapshot.isDragging ? "bg-accent shadow-md" : ""}`}
                              >
                                <div
                                  {...provided.dragHandleProps}
                                  className="cursor-grab text-muted-foreground active:cursor-grabbing"
                                  title="Drag to reorder"
                                >
                                  <GripVertical className="size-3.5" />
                                </div>
                                <span className="flex-1 truncate">{code}</span>
                                {i === 0 && form.barcodes.length > 1 && (
                                  <Badge className="bg-emerald-100 text-[10px] text-emerald-800">
                                    Primary
                                  </Badge>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeBarcode(code)}
                                  className="text-muted-foreground hover:text-red-600"
                                  title="Remove barcode"
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
            <div className="grid gap-1.5">
              <Label htmlFor="p-description">Description</Label>
              <Textarea
                id="p-description"
                rows={2}
                className="max-h-24 resize-none overflow-y-auto"
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
            <div className="grid gap-1.5">
              <Label>Photos</Label>
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
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Product"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Preview modal */}
      <Dialog
        open={!!previewProduct}
        onOpenChange={(open) => !open && setPreviewProduct(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[700px]">
          {previewProduct && (
            <>
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  {previewProduct.images && previewProduct.images.length > 0 ? (
                    <>
                      {/* Main photo — a plain <img>, not the Carousel itself. Which
                          photo shows is driven by activeImage, set either by the
                          auto-cycle timer or by clicking a thumbnail below. */}
                      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={storageDownloadUrl(
                            previewProduct.images[activeImage] ??
                              previewProduct.images[0],
                          )}
                          alt=""
                          className="size-full object-cover"
                        />
                      </div>

                      {/* Thumbnail strip — only shown for 2-3 photos. Clicking a
                          thumbnail jumps the main photo to it. */}
                      {previewProduct.images.length > 1 && (
                        <Carousel className="mt-2 w-full">
                          {/* py-1: CarouselContent's own wrapper div clips with
                              overflow-hidden sized exactly to this row's height —
                              without vertical padding here, the active thumbnail's
                              ring gets clipped flush at the top/bottom edge.
                              justify-center: keeps the thumbnail cluster centered
                              in the row regardless of whether there are 2 or 3. */}
                          <CarouselContent className="-ml-2 justify-evenly py-1">
                            {previewProduct.images.map((path, i) => (
                              <CarouselItem
                                key={path}
                                className="basis-auto pl-2"
                              >
                                <button
                                  type="button"
                                  onClick={() => setActiveImage(i)}
                                  className={`block size-20 shrink-0 overflow-hidden rounded-md ring-2 transition-colors ${
                                    i === activeImage
                                      ? "ring-primary"
                                      : "ring-transparent hover:ring-border"
                                  }`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={storageDownloadUrl(path)}
                                    alt=""
                                    className="size-full object-cover"
                                  />
                                </button>
                              </CarouselItem>
                            ))}
                          </CarouselContent>
                        </Carousel>
                      )}
                    </>
                  ) : (
                    <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
                      <ImageOff className="size-8" />
                      <span className="text-sm">No photos</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <DialogTitle className="font-heading text-2xl font-bold">
                    {previewProduct.name}
                  </DialogTitle>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {previewProduct.category_name && (
                      <Badge className="bg-accent text-accent-foreground">
                        {previewProduct.category_name}
                      </Badge>
                    )}
                    <Badge
                      className={AVAILABLE_BADGE_CLASS(
                        previewProduct.available ?? true,
                      )}
                    >
                      {previewProduct.available ?? true
                        ? "Available"
                        : "Unavailable"}
                    </Badge>
                  </div>

                  <div className="border-t" />

                  {previewProduct.location && (
                    <div>
                      <div className="mb-1 text-sm font-semibold">
                        Location:
                      </div>
                      <p className="text-sm">{previewProduct.location}</p>
                    </div>
                  )}

                  {(previewProduct.lend_from || previewProduct.lend_to) && (
                    <div>
                      <div className="mb-1 text-sm font-semibold">
                        Lendable:
                      </div>
                      <p className="text-sm">
                        {formatLendDate(previewProduct.lend_from)} –{" "}
                        {formatLendDate(previewProduct.lend_to)}
                      </p>
                    </div>
                  )}

                  {previewProduct.description && (
                    <div>
                      <div className="mb-1 text-sm font-semibold">
                        Description:
                      </div>
                      <p className="text-sm">{previewProduct.description}</p>
                    </div>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPreviewProduct(null)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
