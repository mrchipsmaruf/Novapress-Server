const admin = require("firebase-admin");

if (!process.env.FIREBASE_ADMIN_KEY) {
    throw new Error("❌ FIREBASE_ADMIN_KEY is missing in environment variables");
}

let serviceAccount;

try {
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch (err) {
    throw new Error("❌ FIREBASE_ADMIN_KEY must be valid JSON");
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

console.log("🔥 Firebase Admin Initialized");

module.exports = admin;
