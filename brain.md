# 🧠 Digital Canteen Book — Complete App Brain

## 📌 App Overview
Digital Canteen Book is a full-stack canteen management system for companies. It handles employee food entries, daily billing, payments, online food ordering, serial register for employees, customer feedback, and reports — all through a web dashboard accessible on laptops and phones.

---

## 🏗️ Architecture

### Two Backends
| Backend | Technology | Where it Runs |
|---|---|---|
| **Local Dev** | `server.js` + SQLite (better-sqlite3) | `localhost:3456` |
| **Production** | `api/index.js` + Firebase Firestore | Vercel Serverless |

Both serve the same `public/` HTML files. The frontend is pure HTML/CSS/JS — no React/Vue/Angular.

### Hosting
- **Vercel**: `https://canteen-app-virid.vercel.app`
- **GitHub**: `https://github.com/satyamchourasiya019-cell/canteen_app`
- **Firebase**: Firestore database + Auth + Hosting (optional)

---

## 🗂️ File Structure
```
├── server.js              # Local dev server (SQLite)
├── api/
│   ├── index.js           # Production server (Firebase/Firestore + Vercel)
│   └── db.js              # Supabase abstraction (unused currently)
├── security/
│   ├── auth.js            # Firebase Admin SDK + JWT verification + RBAC
│   ├── rateLimit.js       # Rate limiter (IP-based, sliding window)
│   ├── validation.js      # Input validation + sanitization
│   └── audit.js           # Audit logging to Firestore
├── public/
│   ├── entry.html         # Main employee entry page (admin)
│   ├── payment.html       # Payment management (admin)
│   ├── records.html       # All records / reports (admin)
│   ├── emp-records.html   # Individual employee records (admin)
│   ├── pending.html       # Pending amounts (admin)
│   ├── online-orders.html # Online orders management (admin)
│   ├── serial-register.html # Serial register (admin)
│   ├── settings.html      # Settings + QR code (admin)
│   ├── complaints.html    # Customer feedback admin (admin)
│   ├── user-ordering.html # Public food ordering page (employees scan QR)
│   ├── feedback.html      # Public feedback page (employees scan QR)
│   ├── auth.html          # Admin login page (Firebase Auth)
│   ├── developer.html     # Developer panel (manage admins)
│   ├── auth.js            # Frontend auth helper (wraps fetch with tokens)
│   ├── style.css          # Shared styles
│   ├── date-banner.js     # Date/time banner
│   ├── date-clock.js      # Clock display
│   ├── notifications.js   # Notification polling
│   ├── sw.js              # Service worker (PWA)
│   └── manifest.json      # PWA manifest
├── firestore.rules        # Firestore security rules
├── firebase.json          # Firebase Hosting config
├── .firebaserc            # Firebase project reference
├── package.json           # Dependencies
├── vercel.json            # Vercel deployment config
├── setup-admin.js         # Script to create first admin user
├── brain.md               # This file
└── SECURITY.md            # Security documentation
```

---

## 🗃️ Database Schema

### SQLite (server.js — Local Dev)
| Table | Purpose | Key Fields |
|---|---|---|
| `entries` | Daily food entries per employee | employee_number, entry_date, tea_qty, lunch_qty, etc. |
| `employees` | Employee name lookup | employee_number (PK), name |
| `settings` | Prices + password | key (PK), value |
| `payments` | Monthly payment records | employee_number, month, year, amount_paid, status |
| `pending_carry` | Unpaid amounts carried forward | employee_number, from_month, from_year, pending_amount |
| `online_orders` | Food orders from QR page | order_id, employee_name, items (JSON), status |
| `menu_items` | Menu for online ordering | name, icon, price, available |
| `serial_register` | Employee serial numbers (1-1000) | serial_no (PK), employee_name, status, phone_number |
| `serial_history` | History of employees per serial | serial_no, employee_name, joining_date, leaving_date |
| `complaints` | Customer feedback | employee_name, rating, category, subject, description |
| `booking_settings` | Booking hours config | booking_open, start_time, end_time |

### Firestore (api/index.js — Production)
Same collections as SQLite table names. Documents use auto-generated or custom IDs.

### Important: No Data Deletion
- Employee records use soft delete (status: active/inactive/archived)
- Serial history is IMMUTABLE (no update/delete allowed)
- Auto-cleanup only removes entries/payments older than 1 year
- Online orders cleaned after 6 months

---

## 🔐 Authentication & Authorization

### Admin Login Flow
1. Admin opens any admin page → `auth.js` checks Firebase Auth state
2. If not logged in → redirects to `/auth`
3. Admin enters email/password → Firebase Auth signs in
4. `auth.js` verifies UID exists in `admin_users` Firestore collection
5. Gets role from `admin_users` document
6. Stores token in localStorage → all fetch calls get Bearer token
7. Backend middleware verifies token + checks role permissions

### Roles
| Role | Permissions |
|---|---|
| **DEVELOPER** | Everything + manage admin users |
| **SUPER_ADMIN** | Everything |
| **ADMIN** | Employees, serial, menu, orders, payments, reports, complaints, settings |
| **CANTEEN_STAFF** | Orders only + menu read + complaints read |

### Public Pages (No Auth Required)
- `/user-ordering` — Employee food ordering
- `/feedback` — Employee feedback/rating
- `/auth` — Admin login

### Old Password System
Some admin pages also have a password modal (for backward compatibility). Password stored in `settings` collection/table with key `password`. Current password: `988388`.

---

## 📱 Pages & Features

### Admin Dashboard Pages
| Page | URL | Purpose |
|---|---|---|
| Employee Entry | `/` | Add/edit daily food entries for employees |
| Payment | `/payment` | Record monthly payments, carry-forward |
| All Records | `/records` | Monthly/yearly gross records + Excel export |
| Employee Records | `/records/:empNo` | Individual employee breakdown |
| Pending | `/pending` | All employees with pending amounts |
| Online Orders | `/online-orders` | Manage orders, update status (SSE real-time) |
| Serial Register | `/serial-register` | Employee serial numbers (1-1000), assign/leave/history |
| Settings | `/settings` | Prices, password, menu items, booking hours, QR code |
| Customer Feedback | `/complaints` | View/manage feedback with star ratings |
| Developer | `/developer` | Manage admin users, view audit logs |

### Public Pages
| Page | URL | Purpose |
|---|---|---|
| Food Ordering | `/user-ordering` | Employees scan QR → select items → place order |
| Customer Feedback | `/feedback` | Employees scan QR → rate 1-5 stars → submit feedback |
| Admin Login | `/auth` | Firebase Auth login |

---

## 📊 Data Flow

### Daily Entry Flow
```
Admin opens / → enters emp number → system loads existing entry for today
→ admin adds food items (tea, lunch, etc.) → saves → entry stored with daily total
→ monthly total auto-calculated → carry-forward to next month if unpaid
```

### Online Order Flow
```
Employee scans QR → /user-ordering opens
→ selects food items from menu → fills name, phone, department
→ places order → POST /api/orders
→ Server validates: booking hours, duplicate check, menu items, prices
→ Order saved to Firestore with status "pending"
→ SSE pushes notification to admin's /online-orders page
→ Admin changes status: pending → accepted → preparing → ready → completed
→ SSE pushes status update to all connected admin devices
```

### Serial Register Flow
```
Admin opens /serial-register → sees all 1000 serial slots
→ Assigns employee to serial: name, phone, department, joining date
→ Status changes to "Active"
→ When employee leaves: clicks "Leave" → saves to serial_history (IMMUTABLE)
→ Serial becomes "Vacant" → can be reassigned to new employee
→ Previous employee's history ALWAYS preserved in serial_history
```

### Payment Flow
```
Admin opens /payment → enters emp number + month/year
→ System calculates: monthly bill + carry-forward from previous months
→ Admin records payment amount → status: paid/unpaid/partial
→ Carry-forward auto-calculated for next month
```

### Customer Feedback Flow
```
Employee scans QR → /feedback opens
→ Step 1: Fill details (emp ID, name, phone, department)
→ Step 2: Rate 1-5 stars
→ Step 3: Select category (Behaviour/Food/Service/Cleanliness/Pricing/Other)
→ Step 4: Write description → submit
→ Feedback saved with rating + category
→ Admin sees it in /complaints with star rating display
```

---

## 🔒 Security Features

### Backend Protection
- Firebase Admin SDK verifies JWT tokens on all admin API routes
- Role-based access control (DEVELOPER/SUPER_ADMIN/ADMIN/CANTEEN_STAFF)
- Rate limiting: 10 orders/hour, 60 API calls/min per IP
- Input validation on all endpoints (employee numbers, dates, strings)
- Field whitelisting prevents mass assignment attacks
- Duplicate order prevention (1 per employee per day)
- Server-side price calculation (client prices not trusted)
- Booking time validation (server checks business hours)

### Firestore Security Rules
- Default deny — no access unless explicitly allowed
- Admin collections require authenticated admin user
- Public endpoints: menu available, booking open, order creation, feedback creation
- Audit logs: Super Admin read only, no client writes
- Field whitelisting on every collection

### Audit Logging
Every important action logged: employee created/updated, serial assigned/left, menu changed, payment recorded, order status changed, prices updated, password changed, complaints submitted.

---

## 🚀 Deployment

### Vercel (Production)
```bash
vercel --prod --yes
```
URL: https://canteen-app-virid.vercel.app

### Firebase Hosting (Alternative)
```bash
firebase deploy
```

### Local Development
```bash
npm install
node server.js
# Opens at http://localhost:3456
```

### Environment Variables (Vercel)
| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON (for Admin SDK) |
| `FIREBASE_PROJECT_ID` | `canteen-app-bbaf5` |

---

## 🔧 Key Configuration

### Current Prices (in settings)
- Tea: ₹6
- Breakfast: ₹15
- Lunch: ₹50
- Dinner: ₹50
- Snacks: ₹15

### Password
- Current: `988388`
- Stored in: `settings` collection (key: `password`)
- Used for: page-level password modals on admin pages

### Serial Register
- Range: 1-1000
- Statuses: Vacant, Active, Left Company
- History: Immutable (saved in serial_history, never deleted)

### Booking Hours
- Default: 08:00 - 20:00
- Configurable from Settings page

---

## 📝 Important Notes

1. **NEVER delete employee data** — Use soft delete (status change)
2. **Serial history is IMMUTABLE** — Once saved, cannot be modified
3. **Old password system still works** — Password modals on admin pages
4. **Two databases** — SQLite (local) and Firestore (production/Vercel)
5. **Auto-cleanup** — Only removes data older than 1 year
6. **SSE for real-time** — Online orders update live on admin page
7. **QR codes** — Generated on Settings page for feedback + ordering
8. **Developer role** — Can manage all admin users from /developer panel
