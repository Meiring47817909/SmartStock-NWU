# SmartStock-NWU: Firebase Migration Handout
**Date:** August 9, 2026
**Time:** 00:28 (SAST)

## Overview
This document details the complete migration of the NWU BICS (Basic Inventory Control System) application from Supabase to Firebase. The new application, named **SmartStock-NWU**, retains the original modern design aesthetics while being fully backed by Google Firebase for authentication and database services.

## Technical Details & Accomplishments

### 1. Project Initialization & Architecture
* **Framework:** Initialized a brand new Next.js 15 application utilizing the App Router.
* **Styling & UI:** Installed and configured Tailwind CSS along with `lucide-react` icons. All global styles, custom utility classes, and components (such as the Sidebar) were successfully ported over to match the exact premium visual design of the original system.
* **Firebase Integration:** Initialized the Firebase SDK. Set up the core configuration in `src/lib/firebase/config.ts` utilizing the `smartstock-nwu` Firebase project credentials.

### 2. Authentication Migration
* **Client-Side Auth:** Transitioned from Supabase's Server-Side Rendering (SSR) session management to Firebase Client-Side Authentication.
* **Auth Context:** Created a React `AuthContext` to manage the user's session globally. It securely listens to Firebase's `onAuthStateChanged` to supply the currently logged-in user to the application.
* **Route Protection:** Reconfigured the `(protected)` layout routing to properly guard pages. Unauthenticated users are strictly redirected to the `(auth)/login` page.
* **Login Flow:** Switched the login page out to use Firebase's `signInWithEmailAndPassword`.

### 3. Database Schema Re-architecture (PostgreSQL → NoSQL)
* **NoSQL Adaptation:** Transitioned from a highly relational PostgreSQL schema to a document-oriented Firestore NoSQL schema. 
* **Data Denormalization:** Addressed the "N+1 query problem" typical in NoSQL migrations by denormalizing related data. For example, instead of using cross-table joins, `staff_name`, `product_name`, and `product_sku` are now saved directly on the `transaction` documents when they are created. 
* **Embedded Arrays:** Moved away from linking separate `transaction_lines` tables. Transaction line items are now directly embedded as an array inside their parent `transaction` document, allowing the application to fetch entire records atomically in a single query.
* **TypeScript Types:** Thoroughly updated `src/types/database.ts` to reflect the new document structures and resolve casting errors.

### 4. Page & Feature Migrations
Every page in the application was refactored to interface strictly with Firebase Firestore:
* **Dashboard:** Modified to fetch total stock levels, transaction counts, and low stock items by pulling data directly from the `products` and `transactions` collections.
* **Products & Staff:** Refactored standard CRUD tables and forms. Replaced Supabase's PostgREST `ilike` filters with efficient client-side filtering on fetched Firestore collections for robust searching.
* **Stock In / Stock Out:** Fully rebuilt the logic for handling stock movements. These workflows now successfully process cart payloads, decrement/increment the `quantity_on_hand` in the `products` collection via `updateDoc`, and write permanent `transaction` records.
* **Returns:** Rebuilt the highly complex Returns mapping logic. It correctly fetches outstanding "OUT" transactions for specific staff members and subtracts quantities from their linked "RETURN" transactions natively on the client to calculate the correct returnable thresholds.
* **Reports:** Re-wrote all 5 multi-dimensional sub-reports (`StockLevelsReport`, `LowStockReport`, `IssuedPerStaffReport`, `ReturnsReport`, and `TransactionHistoryReport`) using Firebase queries and aggregation.

### 5. Seeding & Cleanup
* **Supabase Eradication:** Systematically scoured the codebase to uninstall and delete all residual Supabase dependencies, types, server routes, and helper configurations. The codebase is strictly Firebase-only.
* **Security Rules:** Supplied basic `firestore.rules` to lock down read and write operations to authenticated users only.
* **User Seeding:** Deployed a local automation script using Firebase Auth and Firestore to instantly create and configure the default users:
  * `admin@nwu.ac.za` -> Assigned **Admin** Role
  * `staff@nwu.ac.za` -> Assigned **Staff** Role
