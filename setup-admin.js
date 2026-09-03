// ═══════════════════════════════════════════════════════════════════
//  SETUP SCRIPT: Creates the first DEVELOPER admin user
//  Run once: node setup-admin.js
//
//  Prerequisites:
//  1. Set FIREBASE_SERVICE_ACCOUNT env var (JSON string of service account)
//     OR place serviceAccountKey.json in project root
//  2. npm install
// ═══════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const readline = require('readline');

// ─── Initialize Firebase Admin ──────────────────────────────────
function initAdmin() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || 'canteen-app-bbaf5',
    });
  } else {
    try {
      const serviceAccount = require('./serviceAccountKey.json');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || 'canteen-app-bbaf5',
      });
    } catch (e) {
      console.error('\n❌ No service account found!');
      console.error('   Option 1: Set FIREBASE_SERVICE_ACCOUNT env var (JSON string)');
      console.error('   Option 2: Place serviceAccountKey.json in project root');
      console.error('\n   Get it from: Firebase Console → Project Settings → Service Accounts → Generate New Private Key\n');
      process.exit(1);
    }
  }
}

// ─── Interactive prompts ────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal = '') {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

// ─── Main setup ─────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  🍽️  Digital Canteen Book - Admin Setup                 ║');
  console.log('║  Creates the first DEVELOPER admin user                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Initialize Firebase Admin
  console.log('🔧 Initializing Firebase Admin SDK...');
  initAdmin();
  console.log('✅ Firebase Admin SDK initialized\n');

  // Get user details
  const email = await ask('📧 Enter admin email: ');
  if (!email || !email.includes('@')) {
    console.error('❌ Invalid email address');
    process.exit(1);
  }

  const password = await ask('🔑 Enter password (min 6 characters): ');
  if (!password || password.length < 6) {
    console.error('❌ Password must be at least 6 characters');
    process.exit(1);
  }

  const name = await ask('👤 Enter full name: ', 'Admin');
  const role = await ask('🎭 Enter role (DEVELOPER/SUPER_ADMIN/ADMIN/CANTEEN_STAFF): ', 'DEVELOPER');

  const validRoles = ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'CANTEEN_STAFF'];
  if (!validRoles.includes(role)) {
    console.error(`❌ Invalid role. Must be one of: ${validRoles.join(', ')}`);
    process.exit(1);
  }

  console.log('\n⏳ Creating Firebase Auth user...');

  let userRecord;
  try {
    // Check if user already exists
    try {
      userRecord = await admin.auth().getUserByEmail(email);
      console.log(`ℹ️  User already exists (UID: ${userRecord.uid}). Updating...`);
    } catch (e) {
      // User doesn't exist, create new
      userRecord = await admin.auth().createUser({
        email: email,
        password: password,
        displayName: name,
        emailVerified: true,
      });
      console.log(`✅ Firebase Auth user created (UID: ${userRecord.uid})`);
    }

    console.log('⏳ Creating admin_users Firestore document...');

    // Create/update admin_users document in Firestore
    const db = admin.firestore();
    await db.collection('admin_users').doc(userRecord.uid).set({
      email: email,
      name: name,
      role: role,
      active: true,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
      updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
    });

    console.log('✅ Admin user document created in Firestore\n');

    // Print summary
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  ✅ Setup Complete!                                     ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Email:    ${email.padEnd(43)}║`);
    console.log(`║  Name:     ${name.padEnd(43)}║`);
    console.log(`║  Role:     ${role.padEnd(43)}║`);
    console.log(`║  UID:      ${userRecord.uid.substring(0, 43).padEnd(43)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Login at: /auth                                       ║');
    console.log('║  Developer Panel: /developer                            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.code === 'auth/email-already-exists') {
      console.error('   This email is already registered. Try a different email.');
    } else if (err.code === 'auth/invalid-email') {
      console.error('   Invalid email format.');
    } else if (err.code === 'auth/weak-password') {
      console.error('   Password is too weak. Use at least 6 characters.');
    } else if (err.message.includes('permission') || err.message.includes('PERMISSION_DENIED')) {
      console.error('   Firestore permission denied. Make sure your service account has');
      console.error('   Firebase Auth Admin + Firestore Read/Write permissions.');
      console.error('   Go to: Firebase Console → Project Settings → Service Accounts');
      console.error('   → Click "Generate new private key" and use that file.');
    }
  }

  rl.close();
  process.exit(0);
}

main();
