import { db } from './config'
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  query, where, orderBy, limit, Timestamp
} from 'firebase/firestore'
import type { Product, Category, StaffMember, Transaction, TransactionLine, DashboardStats, TrendPoint } from '@/types/database'

// Add helper functions for Firestore collections here
export const productsCol = collection(db, 'products')
export const categoriesCol = collection(db, 'categories')
export const staffCol = collection(db, 'staff')
export const transactionsCol = collection(db, 'transactions')
export const transactionLinesCol = collection(db, 'transaction_lines')
export const profilesCol = collection(db, 'profiles')
export const auditLogCol = collection(db, 'audit_log')
