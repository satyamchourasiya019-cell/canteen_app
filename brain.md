# 🧠 Digital Canteen Book — Complete App Brain

> **Last Updated:** September 4, 2026 | **Version:** 2.0
> **Developer:** Satyam Chourasiya (sattu@developer.com / developer@2026)
> **Repo:** https://github.com/satyamchourasiya019-cell/canteen_app
> **Live:** https://canteen-app-virid.vercel.app

---

## 📌 What This App Does

A full-stack canteen management system for companies:
- **Admin (Laptop):** Manages employees, food entries, payments, orders, settings
- **Employees (Phone):** Scan QR → order food → track status → give feedback
- **Developer (sattu@developer.com):** Manages all admin users + Razorpay config

---

## 🏗️ Architecture

| Component | Technology | Location |
|---|---|---|
| Local Dev Server | `server.js` + SQLite | `localhost:3456` |
| Production Server | `api/index.js` + Firebase Firestore | Vercel Serverless |
| Frontend | Pure HTML/CSS/JS (no frameworks) | `public/` folder |
| Database (Prod) | Firebase Firestore | Cloud |
| Database (Dev) | SQLite (better-sqlite3) | `canteen.db` |
| Auth | Email+Password (custom) | `users` collection |
| Payments | Razorpay (monthly ₹4,999) | Subscription system |
| Hosting | Vercel | Auto-deploy from GitHub |

**Flow:** Push to GitHub → Vercel auto-deploys → `api/index.js` serves everything

---

## 🗂️ File Structure (Every File Explained)

### Root Files

| File | Purpose |
|---|---|
| `server.js` | LOCAL dev server — SQLite database, serves on port 3456. Full feature parity with production. Run with `node server.js` |
| `package.json` | Dependencies: express, firebase, firebase-admin, multer, xlsx. Dev: better-sqlite3 |
| `vercel.json` | Vercel config — routes all requests to `api/index.js`, includes `public/` files |
| `firebase.json` | Firebase hosting + Firestore rules + security headers |
| `firestore.rules` | Firestore database security rules (default deny, field whitelisting) |
| `brain.md` | THIS FILE — Complete app documentation |
| `SECURITY.md` | Security documentation + deployment guide |
| `setup-admin.js` | Script to create first admin user in Firebase |

### Backend: `api/index.js` (Production Server)

This is the **main production server** running on Vercel. It handles:

**Authentication:**
- `POST /api/users/register` — New user registration (creates pending account)
- `POST /api/users/login` — User login (returns user info)
- `POST /api/users/verify` — Verify stored credentials (called on page load)
- Developer account auto-created on first login (`sattu@developer.com`)

**User Management (Developer only):**
- `GET /api/users/pending` — List users awaiting approval
- `GET /api/users/all` — List all users
- `POST /api/users/approve/:email` — Approve a user
- `POST /api/users/reject/:email` — Reject a user
- `POST /api/users/pause/:email` — Pause user access
- `POST /api/users/resume/:email` — Resume user access
- `POST /api/users/delete/:email` — Delete a user
- `POST /api/users/role/:email` — Change user role

**Employee Management:**
- `GET /api/employees` — List all employees
- `GET /api/employees/:empNo` — Get employee by number
- `POST /api/employees` — Create employee
- `PUT /api/employees/:empNo` — Update employee
- `DELETE /api/employees/:empNo` — Soft-delete employee

**Food Entry Management:**
- `GET /api/entry/:empNo/:date` — Get entry for employee on date
- `PUT /api/entry/:empNo/:date` — Update entry
- `GET /api/history/:empNo/:period/:year/:month` — Entry history

**Payment Management:**
- `GET /api/payments/:empNo/:year/:month` — Get payment record
- `PUT /api/payments/:empNo/:year/:month` — Record payment
- `GET /api/payments/pending/all` — All pending payments

**Online Orders:**
- `POST /api/orders` — Place order (PUBLIC, rate limited 10/hr)
- `GET /api/orders` — List orders (Admin)
- `GET /api/orders/stats` — Order statistics
- `PUT /api/orders/:id/status` — Update order status (Admin)
- `GET /api/orders/track/:orderId` — Track single order (PUBLIC)
- `GET /api/orders/history/:phone` — Order history by phone (PUBLIC)
- `GET /api/orders/stream` — SSE real-time order updates

**Settings & Config:**
- `GET /api/prices` — Get food prices
- `POST /api/prices` — Update prices (Admin)
- `GET /api/menu` — All menu items
- `GET /api/menu/available` — Available items only (PUBLIC)
- `POST /api/menu` — Add menu item (Admin)
- `GET /api/booking-settings` — Booking hours
- `POST /api/booking-settings` — Update booking hours (Admin)

**Serial Register:**
- `GET /api/serial-register` — All serial slots
- `GET /api/serial-register/lookup/:serialNo` — Lookup serial (PUBLIC)
- `POST /api/serial-register` — Assign employee to serial
- `PUT /api/serial-register/:serialNo` — Update serial record
- `POST /api/serial-register/:serialNo/leave` — Mark employee as left

**Complaints/Feedback:**
- `GET /api/complaints` — List complaints
- `POST /api/complaints` — Submit complaint (PUBLIC)
- `PUT /api/complaints/:id` — Update complaint status

**Password:**
- `GET /api/password` — Returns masked value (never actual password)
- `POST /api/password` — Change password (requires current password)
- `POST /api/password/verify` — Verify password (rate limited)
- `POST /api/password/reset` — Reset password (requires auth)

**Subscription:**
- `GET /api/subscription/check` — Check subscription status
- `POST /api/subscription/create-order` — Create Razorpay order
- `POST /api/subscription/verify` — Verify payment + activate

**Razorpay:**
- `GET /api/razorpay/config` — Get Razorpay Key ID
- `POST /api/razorpay/config` — Save Razorpay config (Developer only)

### Backend: `server.js` (Local Dev Server)

Identical API routes as `api/index.js` but uses **SQLite database** instead of Firestore. Used for local development and testing. Runs on `localhost:3456`.

### Security Modules: `security/`

| File | Purpose |
|---|---|
| `security/auth.js` | Firebase Admin SDK initialization, `requireAuth` middleware, role definitions, RBAC |
| `security/rateLimit.js` | IP-based rate limiter: `orderLimiter` (10/hr), `apiLimiter` (60/min), `authLimiter` (10/15min), `publicReadLimiter` (30/min) |
| `security/validation.js` | Input validators: `validateEntry`, `validateOrder`, `validateSerialRegister`, `validatePayment`, `validateMenu`, `validateComplaint`. Sanitizers: `sanitizeString`, `sanitizePhone`, `sanitizeEmail` |
| `security/audit.js` | Audit logging system. Logs all admin actions with before/after values to `audit_logs` collection |

### Frontend Pages: `public/`

#### Admin Pages (Require Login)

| Page | File | URL | What It Does |
|---|---|---|---|
| Employee Entry | `entry.html` | `/` | Main page. Add/edit daily food entries. Preview → edit with password → save. Custom food items. 2-column grid layout. |
| Payment | `payment.html` | `/payment` | Record monthly payments. Auto-carry-forward unpaid amounts. Status: paid/unpaid/partial |
| All Records | `records.html` | `/records` | Monthly/yearly gross records. Excel export. |
| Employee Records | `emp-records.html` | `/emp-records` | Individual employee breakdown with history |
| Pending | `pending.html` | `/pending` | All employees with unpaid balances |
| Online Orders | `online-orders.html` | `/online-orders` | Manage QR orders. Real-time SSE. Status updates. **NEW: Order count badge on nav tab.** |
| Serial Register | `serial-register.html` | `/serial-register` | 1000 serial slots. Assign/leave/reassign. History IMMUTABLE. |
| Settings | `settings.html` | `/settings` | Prices, password, menu items, booking hours, QR codes, logout |
| Complaints | `complaints.html` | `/complaints` | View/reply to customer feedback with star ratings |
| Subscription | `subscription.html` | `/subscription` | Razorpay payment integration. Monthly ₹4,999 plan. |
| Developer | `developer.html` | `/developer` | User management, Razorpay config. Only sattu@developer.com can access. |

#### Public Pages (No Login Required)

| Page | File | URL | What It Does |
|---|---|---|---|
| Food Ordering | `user-ordering.html` | `/user-ordering` | 3-step flow: Menu → Details → Confirm. Cart. Live status tracker. PWA installable. |
| Order History | `order-history.html` | `/order-history` | Enter phone → see orders (last 2 days). Live status. Auto-refresh every 5s. |
| Feedback | `feedback.html` | `/feedback` | 3-step: Details → Rating → Category+Description. Star rating 1-5. |
| Login | `auth.html` | `/auth` | Email+password login. Create account. Developer account setup link. |
| Approval Pending | `approval-pending.html` | `/approval-pending` | Shown after registration. Auto-checks every 5s. |
| QR Links | `qr-links.html` | `/qr-links` | All page links + downloadable QR codes |

#### Shared JS Files

| File | Purpose |
|---|---|
| `auth.js` | Frontend auth helper. Wraps fetch() with credentials. Auto-verify on page load. Public pages bypass auth. |
| `style.css` | Shared CSS. Responsive design. Food grid: 2-column CSS Grid. |
| `notifications.js` | SSE notification system for admin pages. Real-time new order alerts. |
| `date-banner.js` | Date/time banner for admin pages |
| `date-clock.js` | Clock display |
| `sw.js` | Service worker for PWA support |
| `manifest.json` | PWA manifest (app name, icons, theme color) |

---

## 📊 Data Flows

### 1. Daily Food Entry Flow
```
Admin opens / (entry.html)
  → Enters employee number
  → System loads existing entry for today (if any)
  → Admin adds food items: ☕ Tea, 🥪 Breakfast, 🍛 Lunch, 🍲 Dinner, 🍪 Snacks
  → Can add custom items with name + amount
  → Clicks Save
  → Entry saved with daily total (auto-calculated from prices)
  → Monthly total auto-calculated
  → If unpaid → carry-forward to next month
```

### 2. Online Order Flow (Phone → Laptop)
```
Employee scans QR code → opens /user-ordering
  → Step 1 (MENU): Selects food items from menu grid
     → Quantity +/- controls
     → Cart shows selected items + total
  → Step 2 (DETAILS): Fills name, phone, department
  → Step 3 (CONFIRM): Reviews order summary
  → Clicks "Place Order"
  → POST /api/orders → Server validates:
     - Booking hours (server checks current time)
     - Duplicate check (1 order per employee per day)
     - Menu items + prices (server-side calculation)
  → Order saved with status "pending"
  → SSE pushes notification to admin's /online-orders page
  → Admin sees order with 🔔 notification bar
  → Admin changes status: pending → accepted → preparing → ready → completed
  → SSE pushes status update to phone in real-time
  → Phone shows animated status tracker
```

### 3. Order Status Tracking (Phone)
```
After placing order → status section shows
  → Polls GET /api/orders/track/:orderId every 3 seconds
  → When admin changes status → phone sees update
  → Animated status steps: 🟡 Pending → 🔵 Accepted → 🟠 Preparing → 🟢 Ready → ⚪ Done
  → User can click "View My Orders" → /order-history
```

### 4. Serial Register Flow
```
Admin opens /serial-register
  → Sees all 1000 serial slots (1-1000)
  → Clicks "Assign" on vacant slot
  → Fills: employee name, phone, department, joining date
  → Status changes to "Active"
  → When employee leaves: clicks "Leave"
  → Record saved to serial_history (IMMUTABLE — never deleted)
  → Serial becomes "Vacant" → can be reassigned
  → Previous employee's history ALWAYS preserved
```

### 5. Payment Flow
```
Admin opens /payment
  → Enters employee number + month/year
  → System calculates:
     - Current month bill (from entries)
     - Carry-forward from previous unpaid months
  → Admin records payment amount
  → Status: paid / unpaid / partial
  → Carry-forward auto-calculated for next month
```

### 6. Feedback Flow
```
Employee scans QR → opens /feedback
  → Step 1 (DETAILS): Name, phone, department
  → Step 2 (RATING): Rate 1-5 stars ⭐⭐⭐⭐⭐
  → Step 3 (FEEDBACK): Select category + write description
     Categories: Behaviour / Food / Service / Cleanliness / Pricing / Other
  → Submit → saved to complaints collection
  → Admin sees it in /complaints with star rating
  → Admin can reply and update status
```

### 7. User Registration & Approval Flow
```
New user opens /auth → clicks "Create Account"
  → Fills: Name + Email + Password
  → Submit → POST /api/users/register
  → Server creates user with status: "pending"
  → User redirected to /approval-pending
  → Page auto-checks every 5 seconds
  → Developer opens /developer → sees pending user
  → Developer clicks "Approve" → status = "approved"
  → User's auto-check succeeds → redirected to dashboard
```

### 8. Subscription Payment Flow
```
Admin opens /subscription
  → If not configured: Shows Razorpay setup form (Developer fills)
  → If configured: Shows subscription status + "Renew Now" button
  → Clicks "Renew Now" → POST /api/subscription/create-order
  → Server creates Razorpay order (₹4,999)
  → Razorpay checkout opens → user pays
  → Payment verified server-side (HMAC SHA-256)
  → Subscription becomes ACTIVE for 30 days
  → After 30 days: expired → "Renew Now" again
```

---

## 🔐 Security System

### Authentication
- **Email + Password** stored in `users` collection/SQLite table
- Passwords hashed with SHA-256 (with plain text fallback for migration)
- Credentials stored in browser `localStorage`
- Sent as HTTP headers (`X-Admin-Email`, `X-Admin-Password`) on every request
- Server verifies on every API call via `dualAuth` middleware
- **No hardcoded bypass** — only stored password accepted
- Session timeout: 4 hours

### Authorization (RBAC)
| Role | Can Do |
|---|---|
| DEVELOPER | Everything + manage users + Razorpay config |
| SUPER_ADMIN | Everything except user management |
| ADMIN | Employees, orders, payments, reports, menu, settings |
| CANTEN_STAFF | Orders only + menu read |

### Rate Limiting
| Endpoint | Limit |
|---|---|
| Order creation | 10 per hour per IP |
| Login/Register/Verify | 10 per 15 minutes per IP |
| General API | 60 per minute per IP |
| Public reads (menu, booking) | 30 per minute per IP |

### Input Validation
- Employee numbers: 1-1000
- Serial numbers: 1-1000
- Dates: YYYY-MM-DD format
- Quantities: 0-100
- Prices: 0-9999
- Phone: digits, +, -, spaces only
- Strings: sanitized + length limited
- Unknown fields silently stripped

### Security Headers
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Strict-Transport-Security: max-age=31536000`
- `Cache-Control: no-store` on password/user endpoints

### XSS Protection
- User input sanitized before innerHTML rendering
- `escHtml()` function in online-orders page
- HTML entity escaping in settings and user-ordering pages
- Security headers prevent XSS in modern browsers

### Password Security
- `GET /api/password` returns masked `•••••` (never actual password)
- `POST /api/password` requires current password to change
- `GET /api/password/default` returns `********` (never actual)
- No hardcoded fallback passwords in DB-unavailable scenarios
- Password length: 4-128 characters

### Audit Logging
All admin actions logged to `audit_logs` collection:
- Employee created/updated/deleted
- Serial assigned/left/reassigned
- Menu items changed
- Payments recorded
- Order status changed
- Password changed
- Settings updated
- Each log: user ID, email, action, previous value, new value, IP, timestamp

---

## 📱 All Page Links

### Admin Pages
| Page | URL |
|---|---|
| Employee Entry | `/` |
| Payment | `/payment` |
| All Records | `/records` |
| Pending | `/pending` |
| Online Orders | `/online-orders` |
| Serial Register | `/serial-register` |
| Settings | `/settings` |
| Complaints | `/complaints` |
| Subscription | `/subscription` |
| Developer | `/developer` |

### Public Pages
| Page | URL |
|---|---|
| Food Ordering | `/user-ordering` |
| Order History | `/order-history` |
| Feedback | `/feedback` |
| Login | `/auth` |
| Approval Pending | `/approval-pending` |
| QR Links | `/qr-links` |

---

## 🔧 Configuration

### Default Prices (in settings)
- ☕ Tea: ₹10
- 🥪 Breakfast: ₹30
- 🍛 Lunch: ₹80
- 🍲 Dinner: ₹80
- 🍪 Snacks: ₹20
- (Custom items: user-defined)

### Developer Account
- **Email:** sattu@developer.com
- **Password:** developer@2026
- **Role:** DEVELOPER (highest level)
- Auto-created on first login if doesn't exist

### Booking Hours
- Default: 08:00 - 20:00
- Configurable from Settings page
- Online ordering validates against these hours

### Serial Register
- Range: 1-1000
- Statuses: Vacant → Active → Left Company
- History: IMMUTABLE (never deleted or modified)

### Subscription Plan
- Name: Canteen Management Monthly
- Amount: ₹4,999/month
- Validity: 30 days
- Payment: Razorpay (test key: rzp_test_TXuUAyubCkgSGS)

---

## 🚀 Deployment

### Local Development
```bash
npm install
node server.js
# Opens at http://localhost:3456
```

### Production (Vercel)
```bash
git add .
git commit -m "Your changes"
git push origin master
# Vercel auto-deploys in 1-2 minutes
```

### Firebase (Alternative)
```bash
firebase deploy
```

### Environment Variables (Vercel)
| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON |
| `FIREBASE_PROJECT_ID` | canteen-app-bbaf5 |
| `RAZORPAY_KEY_ID` | rzp_test_TXuUAyubCkgSGS (configured) |
| `RAZORPAY_KEY_SECRET` | Set via Developer page (stored in Firestore) |

---

## 📝 Important Rules

1. **NEVER delete employee data** — Use soft delete (status change)
2. **Serial history is IMMUTABLE** — Once saved, cannot be modified
3. **Two databases** — SQLite (local) and Firestore (production)
4. **Auto-cleanup** — Removes data older than 1 year
5. **SSE for real-time** — Online orders update live
6. **QR codes** — Generated on Settings page
7. **Developer role** — Can manage all users from /developer
8. **Order badge** — Shows count on Online Orders nav tab when new orders arrive
9. **Password modals** — Some admin pages have legacy password modals for backward compatibility
10. **PWA** — Online ordering page is installable as Progressive Web App on phones

---

## 🐛 Known Issues & Fixes History

| Issue | Fix | Date |
|---|---|---|
| Employee entry page items not in sequence | Changed from flex to 2-column CSS Grid | Sep 2026 |
| Custom food items not in sequence | Changed to append directly to `.food-grid` | Sep 2026 |
| Login/logout loop | Fixed verify endpoint to accept email+password headers | Sep 2026 |
| Online orders showing "Loading data" | Added missing API endpoints to server.js | Sep 2026 |
| Serial register not showing names | Fixed employee lookup in serial register | Sep 2026 |
| Payment page not working | Fixed payment API endpoints | Sep 2026 |
| QR feedback not showing on laptop | Fixed complaints endpoint | Sep 2026 |
| 404 on all pages on Vercel | Added `includeFiles: ["../public/**"]` to vercel.json | Sep 2026 |
| Order status not showing on phone | Added `/api/orders/track/:orderId` to server.js | Sep 2026 |
| Order history not working | Added `/api/orders/history/:phone` to server.js | Sep 2026 |
| Password exposed in API | Returns masked value, requires current password to change | Sep 2026 |
| User management endpoints public | Protected with dualAuth middleware | Sep 2026 |
| Hardcoded developer bypass | Removed from login/verify endpoints | Sep 2026 |
| XSS in user input rendering | Added HTML entity escaping | Sep 2026 |
