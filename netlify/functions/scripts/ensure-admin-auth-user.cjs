/**
 * Creates or updates the operator admin in Firebase Auth (Email/Password).
 * Run from netlify/functions:
 *   $env:FIREBASE_SERVICE_ACCOUNT_JSON = Get-Content path\to\serviceAccount.json -Raw
 *   $env:ADMIN_PASSWORD = "Matt@5494@"
 *   node scripts/ensure-admin-auth-user.cjs
 */
const path = require("path");
const admin = require(path.join(__dirname, "..", "node_modules", "firebase-admin"));

const SYNTHETIC_EMAIL = "639152444480@phone.avelon-wealth.local";
const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const password = process.env.ADMIN_PASSWORD || "Matt@5494@";

if (!raw) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw)),
});

admin
  .auth()
  .getUserByEmail(SYNTHETIC_EMAIL)
  .then(function (user) {
    return admin.auth().updateUser(user.uid, { password: password });
  })
  .then(function () {
    console.log("Updated password for", SYNTHETIC_EMAIL);
  })
  .catch(function (err) {
    if (err.code !== "auth/user-not-found") throw err;
    return admin
      .auth()
      .createUser({
        email: SYNTHETIC_EMAIL,
        password: password,
        emailVerified: false,
      })
      .then(function (u) {
        console.log("Created user", SYNTHETIC_EMAIL, u.uid);
      });
  })
  .catch(function (e) {
    console.error(e);
    process.exit(1);
  });
