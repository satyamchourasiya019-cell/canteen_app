# 🔒 Security & Production Deployment Guide

## Security Features Implemented

### 1. Firebase Authentication (Admin Access)
- **Firebase Auth** with email/password for admin login
- **Server-side token verification** using Firebase Admin SDK
- **Role-based access control (RBAC)** with 3 tiers:
  - `SUPER_ADMIN` — Full access to everything + user management
  - `ADMIN` — Employee management, orders, payments, reports, menu, complaints
  - `CANTEEN_STAFF` — Orders only + limited canteen operations
- **Session management** — 4-hour max session, 30-min token auto-refresh
- **Automatic logout** on session expiry or unauthorized access
- Login page at `/auth`

### 2. Employee Data Protection
- **Soft delete / inactive status** — Employee records are never permanently deleted
- **Employee status field**: `active` / `inactive` / `archived`
- **Serial number history preservation** — When a serial is reassigned, the previous employee's data is automatically saved to `serial_history` before the new assignment
- **Audit trail** — All employee changes are logged with previous and new values
- **Employee data structure protection** — Only expected fields are allowed in write operations

### 3. Firestore Security Rules
- **Default deny model** — No access unless explicitly allowed
- **Admin collections** (entries, employees, payments, settings, serial_register, serial_history, pending_carry) — Read/write requires authenticated admin user
- **Order management** — Create is public (validated), read/update requires admin auth
- **Menu items** — Public read for available items, admin write
- **Booking settings** — Public read, admin write
- **Audit logs** — Super Admin read only, no client-side writes
- **Complaints** — Public create, admin read/reply
- **Field whitelisting** — Each collection has strict allowed-field lists

### 4. Public Order Page Security
- **Rate limiting** — 10 orders per hour per IP address
- **Server-side booking time validation** — Cannot order outside business hours
- **Duplicate order prevention** — One order per employee per day (server-enforced)
- **Menu item validation** — Items validated against actual menu on server
- **Server-side price calculation** — Prices fetched from server, not trusted from client
- **Input sanitization** — All fields sanitized (string lengths, phone format, etc.)
- **Order tracking** — New public endpoint `/api/orders/track/:orderId` returns only safe fields (no other employees' data)

### 5. Rate Limiting
- Order creation: 10/hour per IP
- Public reads (menu, booking): 30/minute per IP
- General API: 60/minute per IP
- Auth attempts: 10 per 15 minutes

### 6. Input Validation & Data Integrity
- Employee numbers validated (1-300)
- Serial numbers validated (1-500)
- Date formats validated (YYYY-MM-DD)
- Quantities bounded (0-100)
- Prices bounded (0-9999)
- Phone numbers sanitized (digits, +, -, spaces only)
- String lengths enforced
- Unknown fields silently stripped from sensitive operations

### 7. Audit Logging
All important admin actions are logged to `audit_logs` collection:
- Employee created/updated/deleted
- Serial number assigned/left/reassigned
- Menu item created/updated/deleted
- Payment recorded/updated
- Order status changed/cancelled
- Prices updated
- Password changed
- Booking settings changed
- Complaint created/replied
- Admin login

Each log includes: user ID, email, name, action, resource, previous value, new value, IP address, user agent, timestamp.

### 8. Security Headers
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Cache-Control: no-store, no-cache` on API routes

---

## Collections Protected

| Collection | Read | Write | Notes |
|---|---|---|---|
| `admin_users` | Own profile | Super Admin only | User management |
| `employees` | Admin+ | Admin+ | Employee data |
| `entries` | Admin+ | Admin+ | Daily food entries |
| `settings` | Admin+ | Admin+ | Prices, passwords |
| `payments` | Admin+ | Admin+ | Financial data |
| `pending_carry` | Admin+ | Admin+ | Carry-forward data |
| `online_orders` | Admin+ | Public create, Admin update | Orders |
| `menu_items` | Public (available only) | Admin+ | Menu management |
| `serial_register` | Admin+ | Admin+ | Employee serial records |
| `serial_history` | Admin+ | Create only (immutable) | Employee history |
| `complaints` | Admin+ | Public create, Admin update | Complaints |
| `booking_settings` | Public | Admin+ | Booking hours |
| `audit_logs` | Super Admin only | Backend only (no client writes) | Audit trail |

---

## Deployment Steps

### Prerequisites
1. Firebase project with Authentication enabled
2. Firebase Hosting enabled
3. Firestore database created
4. Service account for Firebase Admin SDK

### Step 1: Create Firebase Auth Admin Users

1. Go to Firebase Console → Authentication → Users
2. Create email/password accounts for each admin
3. For each user, create an `admin_users` document:

```bash
# Using Firebase Console or gcloud CLI
# Document ID = Firebase Auth UID
# Example for Super Admin:
{
  "email": "admin@company.com",
  "name": "Admin Name",
  "role": "SUPER_ADMIN",
  "active": true,
  "created_at": "2026-09-03 10:00:00"
}
```

Roles:
- `SUPER_ADMIN` — Full access
- `ADMIN` — Management access
- `CANTEEN_STAFF` — Orders only

### Step 2: Generate Firebase Service Account Key

1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Save the JSON file securely

### Step 3: Set Environment Variables

For Vercel deployment:
```bash
# Vercel environment variables (Settings → Environment Variables)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"canteen-app-bbaf5",...}
FIREBASE_PROJECT_ID=canteen-app-bbaf5
FIREBASE_API_KEY=AIzaSyCqiJDd9mijLa3AV3S7JgyLlkkoCODFlJk
FIREBASE_AUTH_DOMAIN=canteen-app-bbaf5.firebaseapp.com
```

### Step 4: Deploy Firestore Security Rules

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Deploy rules
firebase deploy --only firestore:rules
```

### Step 5: Deploy to Firebase Hosting

```bash
# Build (if needed)
npm install

# Deploy hosting + functions
firebase deploy
```

Or deploy to Vercel (existing setup still works):
```bash
vercel --prod
```

### Step 6: Verify Deployment

1. Open the deployed URL
2. Navigate to `/auth` — should see login page
3. Log in with admin credentials
4. Verify dashboard access works
5. Open `/user-ordering` in incognito — should work without auth
6. Test order placement
7. Verify `/api/employees` returns 401 without auth token
8. Verify `/api/settings` returns 401 without auth token

---

## Architecture Summary

```
ADMIN LAPTOPS                    PUBLIC EMPLOYEE QR CODE
       │                                  │
       ▼                                  ▼
  Firebase Auth                    Public Order Page
  (email/password)                (/user-ordering)
       │                                  │
       ▼                                  ▼
  JWT Token + Bearer              Rate Limiting
  (in Authorization header)       + Input Validation
       │                                  │
       ▼                                  ▼
  ┌─────────────────────────────────────────────┐
  │            Backend API (Express)             │
  │  • Token verification (Firebase Admin)      │
  │  • Role-based access control                │
  │  • Audit logging                            │
  │  • Duplicate order prevention               │
  │  • Server-side validation                   │
  │  • Security headers                         │
  └─────────────────────────────────────────────┘
       │                                  │
       ▼                                  ▼
  ┌─────────────────────────────────────────────┐
  │            Firestore Database                │
  │  • Security rules (default deny)            │
  │  • Field whitelisting                       │
  │  • Audit log collection                     │
  │  • Employee history preservation            │
  │  • Immutable serial_history                 │
  └─────────────────────────────────────────────┘
```

---

## File Structure (Security additions)

```
├── api/
│   ├── index.js          (Modified: auth middleware, validation, audit, rate limiting)
│   └── db.js             (Existing: Supabase abstraction)
├── security/
│   ├── auth.js           (NEW: Firebase Admin + RBAC middleware)
│   ├── rateLimit.js      (NEW: Rate limiting)
│   ├── validation.js     (NEW: Input validation)
│   └── audit.js          (NEW: Audit logging)
├── public/
│   ├── auth.html         (NEW: Admin login page)
│   ├── auth.js           (NEW: Frontend auth helper)
│   └── *.html            (Modified: auth.js script tag added)
├── firestore.rules       (NEW: Firestore security rules)
├── firestore.indexes.json (NEW: Firestore indexes)
├── firebase.json         (NEW: Firebase Hosting config)
├── .firebaserc           (NEW: Firebase project reference)
├── package.json          (Modified: firebase-admin dependency)
└── SECURITY.md           (This file)
```

---

## What's Protected Against

| Attack Vector | Protection |
|---|---|
| Direct Firestore access from browser | Security rules (default deny) |
| Unauthorized admin access | Firebase Auth + JWT verification |
| Public user accessing admin dashboard | Role-based access control |
| Spam/bot order submissions | Rate limiting |
| Duplicate orders | Server-side duplicate check |
| Manipulated order prices | Server-side price validation |
| Invalid employee/serial numbers | Input validation + bounds checking |
| Mass assignment attacks | Field whitelisting |
| Session hijacking | Token refresh + session timeout |
| Data leakage through order tracking | Public endpoint returns only safe fields |
| Permanent data loss | Soft delete + history preservation |
| Unauthorized price changes | Auth required + audit logging |
| XSS attacks | Security headers + input sanitization |
| Clickjacking | X-Frame-Options: DENY |

---

## Backup & Recovery

### Recommended Backup Strategy
1. **Firebase Console** → Firestore → Export/Import
2. **Automated backups** via Google Cloud Scheduler + Firestore Export
3. **Employee history** is preserved in `serial_history` (immutable)
4. **Audit logs** provide complete change history in `audit_logs`
5. **No permanent deletions** — all critical data uses soft delete

### Restore Process
1. Firebase Console → Firestore → Import
2. Or use `gcloud firestore import` with a backup path
