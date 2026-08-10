'use client'

import { useEffect, useState } from 'react'
import { Search, Plus, Pencil, CreditCard } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, getDocs, addDoc, updateDoc, doc, orderBy } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { useAuth } from '@/context/AuthContext'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import type { StaffMember } from '@/types/database'

type FormData = {
  name: string; surname: string; email: string
  department: string; card_uid: string
}

const EMPTY_FORM: FormData = { name: '', surname: '', email: '', department: '', card_uid: '' }

export default function StaffPage() {
  const { user, profile } = useAuth()
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    const staffRef = collection(db, 'staff')
    const snap = await getDocs(query(staffRef, orderBy('full_name')))

    let data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[]

    const s = search.toLowerCase()
    if (s) {
      data = data.filter(st =>
        (st.full_name && st.full_name.toLowerCase().includes(s)) ||
        (st.department && st.department.toLowerCase().includes(s))
      )
    }

    setStaff(data as StaffMember[])
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search])

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
    setShowModal(true)
  }

  function openEdit(s: StaffMember) {
    setEditing(s)
    setForm({
      name: s.name,
      surname: s.surname,
      email: s.email ?? '',
      department: s.department ?? '',
      card_uid: s.card_uid ?? '',
    })
    setError('')
    setShowModal(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const name = form.name.trim()
    const surname = form.surname.trim()
    const payload = {
      name,
      surname,
      full_name: `${name} ${surname}`.trim(),
      email: form.email.trim() || null,
      department: form.department.trim() || null,
      card_uid: form.card_uid.trim() || null,
    }

    try {
      if (editing) {
        const updated = { ...payload, updated_at: new Date().toISOString() }
        await updateDoc(doc(db, 'staff', editing.id.toString()), updated)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'update', entityType: 'staff', entityId: editing.id.toString(),
          before: {
            name: editing.name, surname: editing.surname, full_name: editing.full_name,
            email: editing.email, department: editing.department, card_uid: editing.card_uid,
          },
          after: updated,
        })
      } else {
        const created = {
          ...payload,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
        const staffRef = await addDoc(collection(db, 'staff'), created)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'create', entityType: 'staff', entityId: staffRef.id,
          before: null, after: created,
        })
      }
      setShowModal(false)
      load()
    } catch (err: any) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function toggleActive(s: StaffMember) {
    try {
      const nextActive = !s.is_active
      await updateDoc(doc(db, 'staff', s.id.toString()), {
        is_active: nextActive,
        updated_at: new Date().toISOString()
      })
      logAudit({
        userId: user?.uid, userName: profile?.full_name ?? user?.email,
        action: nextActive ? 'activate' : 'deactivate', entityType: 'staff', entityId: s.id.toString(),
        before: { is_active: s.is_active }, after: { is_active: nextActive },
      })
      load()
    } catch (e) {
      console.error(e)
    }
  }

  const f = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }))

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Staff</h1>
          <p className="mt-1 text-sm text-muted-foreground">{staff.filter(s => s.is_active).length} active members</p>
        </div>
        <Button onClick={openAdd}><Plus className="size-4" /> Add Staff</Button>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-80">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Search name, department…"
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Table */}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Card UID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && staff.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No staff found</TableCell></TableRow>}
            {staff.map(s => (
              <TableRow key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                <TableCell>
                  <div className="font-medium">{s.full_name}</div>
                  {s.email && <div className="text-xs text-muted-foreground">{s.email}</div>}
                </TableCell>
                <TableCell className="text-muted-foreground">{s.department ?? '—'}</TableCell>
                <TableCell>
                  {s.card_uid
                    ? <span className="flex items-center gap-1 font-mono text-xs text-emerald-600">
                        <CreditCard className="size-3" /> {s.card_uid}
                      </span>
                    : <span className="text-xs text-muted-foreground">Not linked</span>}
                </TableCell>
                <TableCell>
                  <Badge className={s.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>
                    {s.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className={s.is_active ? 'text-red-600 hover:text-red-700' : 'text-emerald-600 hover:text-emerald-700'}
                      onClick={() => toggleActive(s)}
                    >
                      {s.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Add / Edit modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Staff Member' : 'Add Staff Member'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="s-name">Name *</Label>
                <Input id="s-name" required value={form.name} onChange={f('name')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="s-surname">Surname *</Label>
                <Input id="s-surname" required value={form.surname} onChange={f('surname')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="s-email">Email *</Label>
                <Input id="s-email" type="email" required value={form.email} onChange={f('email')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="s-department">Department *</Label>
                <Input id="s-department" required value={form.department} onChange={f('department')} placeholder="e.g. Engineering" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="s-card">
                Card UID <span className="font-normal text-muted-foreground">(tap card)</span>
              </Label>
              <Input id="s-card" className="bg-muted" value={form.card_uid} onChange={f('card_uid')}
                placeholder="e.g. A1B2C3D4E5 — leave blank to link later" />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Staff'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
