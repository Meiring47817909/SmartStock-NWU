'use client'

import { useEffect, useState } from 'react'
import { Plus, Pencil, Tag, Trash2 } from 'lucide-react'
import {
  listCategories, listProducts, createCategory, updateCategory, deleteCategory,
} from '@/lib/api/catalog'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import type { Category } from '@/types/database'

type FormData = { name: string; description: string }
const EMPTY_FORM: FormData = { name: '', description: '' }

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [productCount, setProductCount] = useState<number | null>(null)
  const [checkingDelete, setCheckingDelete] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  async function load() {
    setLoading(true)
    try {
      setCategories(await listCategories())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
    setShowModal(true)
  }

  function openEdit(c: Category) {
    setEditing(c)
    setForm({ name: c.name, description: c.description ?? '' })
    setError('')
    setShowModal(true)
  }

  // Delete — the only guard a category needs is "does any product still
  // point at it", unlike a product's own delete guard (outstanding loans +
  // pending requests), since a category itself is never lent out. Opens
  // the confirm dialog right away in a "checking" state, same as the
  // Products page's own delete flow.
  async function openDelete(c: Category) {
    setDeleting(c)
    setProductCount(null)
    setDeleteError('')
    setCheckingDelete(true)
    try {
      const all = await listProducts()
      setProductCount(all.filter(p => p.category_id === c.id).length)
    } catch {
      setDeleteError("Could not check this category's products.")
      setDeleting(null)
    } finally {
      setCheckingDelete(false)
    }
  }

  function closeDelete() {
    setDeleting(null)
    setProductCount(null)
    setDeleteError('')
  }

  async function confirmDelete() {
    if (!deleting || productCount === null || productCount > 0) return
    setDeleteBusy(true)
    try {
      await deleteCategory(deleting.id)
      closeDelete()
      load()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete this category.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
    }
    try {
      if (editing) {
        await updateCategory(editing.id, payload)
      } else {
        await createCategory(payload)
      }
      setShowModal(false)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save category')
    }
    setSaving(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Title and Add Category side by side; below sm the button moves under the title. */}
      <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Categories</h1>
          <p className="text-sm text-[#5B4F67]">{categories.length} categories</p>
        </div>
        <Button onClick={openAdd}><Plus className="size-4" /> Add Category</Button>
      </div>

      <Card className="min-h-0 flex-1 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <TableHead className="h-auto py-3.5 pl-6 text-base font-bold text-[#2D203A]">Name</TableHead>
              <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Description</TableHead>
              <TableHead className="h-auto py-3.5 pr-6"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && categories.length === 0 && <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No categories yet</TableCell></TableRow>}
            {categories.map(c => (
              <TableRow key={c.id} className="hover:bg-[#FAF7FC]">
                <TableCell className="max-w-xs py-4 pl-6 font-medium whitespace-normal">
                  <span className="inline-flex min-w-0 items-start gap-1.5">
                    <Tag className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-words">{c.name}</span>
                  </span>
                </TableCell>
                <TableCell className="max-w-xs py-4 whitespace-normal break-words text-muted-foreground">{c.description ?? '—'}</TableCell>
                <TableCell className="py-4 pr-6">
                  <div className="flex gap-1">
                    <Button variant="outline" size="icon-sm" className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900" onClick={() => openEdit(c)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline" size="icon-sm"
                      onClick={() => openDelete(c)}
                      className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      </Card>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Category' : 'Add Category'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cat-name">Name *</Label>
              <Input id="cat-name" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cat-description">Description *</Label>
              <Textarea
                id="cat-description"
                required
                rows={2}
                className="max-h-24 resize-none overflow-y-auto"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Category'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) closeDelete() }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete category?</DialogTitle>
          </DialogHeader>
          {deleting && (
            <p className="text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Tag className="size-3.5 text-muted-foreground" />
                <strong className="text-foreground">{deleting.name}</strong>
              </span>
            </p>
          )}
          {checkingDelete ? (
            <p className="text-sm text-muted-foreground">Checking how many products use this category…</p>
          ) : productCount !== null && productCount > 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {productCount} product{productCount === 1 ? '' : 's'} still {productCount === 1 ? 'uses' : 'use'} this category. Move or delete {productCount === 1 ? 'it' : 'them'} first.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              No products use this category, so this is safe. This can&apos;t be undone.
            </p>
          )}
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDelete} disabled={deleteBusy}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={checkingDelete || deleteBusy || productCount === null || productCount > 0}
              onClick={confirmDelete}
            >
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
