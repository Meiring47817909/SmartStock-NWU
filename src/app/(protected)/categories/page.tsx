'use client'

import { useEffect, useState } from 'react'
import { Plus, Pencil, Tag } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, orderBy, getDocs, addDoc, updateDoc, doc } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { useAuth } from '@/context/AuthContext'
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
  const { user, profile } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    const snap = await getDocs(query(collection(db, 'categories'), orderBy('name')))
    setCategories(snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as Category[])
    setLoading(false)
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
    }
    try {
      if (editing) {
        await updateDoc(doc(db, 'categories', editing.id), payload)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'update', entityType: 'category', entityId: editing.id,
          before: { name: editing.name, description: editing.description },
          after: payload,
        })
      } else {
        const created = { ...payload, created_at: new Date().toISOString() }
        const catRef = await addDoc(collection(db, 'categories'), created)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'create', entityType: 'category', entityId: catRef.id,
          before: null, after: created,
        })
      }
      setShowModal(false)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save category')
    }
    setSaving(false)
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Categories</h1>
          <p className="mt-1 text-sm text-muted-foreground">{categories.length} categories</p>
        </div>
        <Button onClick={openAdd}><Plus className="size-4" /> Add Category</Button>
      </div>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && categories.length === 0 && <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No categories yet</TableCell></TableRow>}
            {categories.map(c => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <Tag className="size-3.5 text-muted-foreground" /> {c.name}
                  </span>
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{c.description ?? '—'}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)}>
                    <Pencil className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    </div>
  )
}
