// index.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// Load firebase-admin via local helper (you created firebaseAdmin.js which requires the serviceAccount json)
let admin;
try {
    admin = require('./firebaseAdmin'); // expects firebaseAdmin.js to export initialized admin
} catch (err) {
    // If firebaseAdmin.js is not present, try to initialize with FIREBASE_SERVICE_ACCOUNT env var
    try {
        const firebaseAdmin = require('firebase-admin');
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw) {
            console.warn('Warning: firebaseAdmin not found and FIREBASE_SERVICE_ACCOUNT is not set.');
        } else {
            const svc = JSON.parse(raw);
            firebaseAdmin.initializeApp({
                credential: firebaseAdmin.credential.cert(svc),
            });
            admin = firebaseAdmin;
            console.log('firebase-admin initialized from FIREBASE_SERVICE_ACCOUNT env.');
        }
    } catch (e) {
        console.error('Failed to initialize firebase-admin:', e.message);
        // leave admin undefined - verifyToken will fail if used
    }
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// --------------------------------------------
//  MONGO DB CONNECTION
// --------------------------------------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rjffgqf.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true
    }
});

// --------------------------------------------
//  AUTH MIDDLEWARES
// --------------------------------------------

// VERIFY FIREBASE TOKEN
async function verifyToken(req, res, next) {
    // If admin not initialized, reject early
    if (!admin) {
        return res.status(500).send({ message: "Server misconfigured: auth provider missing" });
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized - No token" });
    }

    const token = header.split(" ")[1];

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = {
            email: decoded.email,
            uid: decoded.uid,
        };
        next();
    } catch (err) {
        return res.status(401).send({ message: "Invalid token", error: err.message });
    }
}

// REQUIRE ROLE
function requireRole(role) {
    return async (req, res, next) => {
        try {
            if (!req.usersCollection) {
                return res.status(500).send({ message: "Server misconfigured: usersCollection missing" });
            }
            const user = await req.usersCollection.findOne({ email: req.user.email });
            if (!user || user.role !== role) {
                return res.status(403).send({ message: "Forbidden - Role required: " + role });
            }
            req.user.role = user.role;
            next();
        } catch (err) {
            next(err);
        }
    };
}

// --------------------------------------------
//  MAIN SERVER LOGIC
// --------------------------------------------
async function run() {
    try {
        await client.connect();

        const db = client.db('novapress_db');
        const usersCollection = db.collection("users");
        const issuesCollection = db.collection("issues");
        const timelineCollection = db.collection("timeline");
        const paymentsCollection = db.collection("payments");

        // Make collections available in middleware for requireRole etc.
        app.use((req, res, next) => {
            req.usersCollection = usersCollection;
            next();
        });

        // ----------------
        // USER ROUTES
        // ----------------

        // Create user (no token required when saving first time from registration)
        app.post('/users', async (req, res) => {
            try {
                const user = req.body;
                if (!user || !user.email) {
                    return res.status(400).send({ message: "Invalid user payload" });
                }

                const exists = await usersCollection.findOne({ email: user.email });
                if (exists) return res.send({ message: "User already exists" });

                user.role = user.role || "citizen";
                user.premium = user.premium || false;
                user.isBlocked = user.isBlocked || false;

                const result = await usersCollection.insertOne(user);
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET user by email (requires token and only returns self)
        app.get('/users/:email', verifyToken, async (req, res) => {
            try {
                const target = req.params.email;
                if (req.user.email !== target) {
                    return res.status(403).send({ message: "Forbidden" });
                }
                const user = await usersCollection.findOne({ email: target });
                res.send(user || {});
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET all users (admin only)
        app.get('/users', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.send(users);
            } catch (err) {
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        // Make admin (admin only)
        app.patch('/users/make-admin/:email', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const email = req.params.email;
                const result = await usersCollection.updateOne({ email }, { $set: { role: "admin" } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // Make staff (admin only)
        app.patch('/users/make-staff/:email', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const email = req.params.email;
                const result = await usersCollection.updateOne({ email }, { $set: { role: "staff" } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // Block/unblock user (admin only)
        app.patch('/users/block/:email', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const email = req.params.email;
                const { isBlocked } = req.body;
                const result = await usersCollection.updateOne({ email }, { $set: { isBlocked: !!isBlocked } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // Promote to premium (user must be same as requester)
        app.patch('/users/premium/:email', verifyToken, async (req, res) => {
            try {
                if (req.user.email !== req.params.email) {
                    return res.status(403).send({ message: "Cannot modify other users" });
                }
                const result = await usersCollection.updateOne({ email: req.params.email }, { $set: { premium: true } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET user role (used by frontend hooks). Admin can fetch any user's role; user can fetch own.
        app.get('/users/role/:email', verifyToken, async (req, res) => {
            try {
                const targetEmail = req.params.email;
                const requesterEmail = req.user.email;
                const requester = await usersCollection.findOne({ email: requesterEmail });

                if (requesterEmail !== targetEmail && requester?.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const user = await usersCollection.findOne({ email: targetEmail });
                res.send({ role: user?.role || "citizen" });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ----------------
        // ISSUE ROUTES
        // ----------------

        // CREATE ISSUE
        app.post('/issues', verifyToken, async (req, res) => {
            try {
                const issue = req.body || {};
                issue.reporterEmail = req.user.email;
                issue.userEmail = req.user.email; // duplicate field for front-end compatibility

                const user = await usersCollection.findOne({ email: req.user.email });

                // Limit free users
                const issueCount = await issuesCollection.countDocuments({ reporterEmail: req.user.email });

                if (!user?.premium && issueCount >= 3) {
                    return res.status(403).send({ message: "Free user limit reached. Upgrade to premium." });
                }

                issue.status = issue.status || "pending";
                issue.priority = issue.priority || "normal";
                issue.reportedAt = new Date();
                issue.upvotes = issue.upvotes || 0;
                issue.upvoters = issue.upvoters || [];

                const result = await issuesCollection.insertOne(issue);

                // insert initial timeline
                await timelineCollection.insertOne({
                    issueId: result.insertedId.toString(),
                    status: issue.status,
                    message: "Issue reported",
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({ acknowledged: true, insertedId: result.insertedId, ...issue });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET ALL ISSUES
        // By default returns an array (frontend expects array). If pagination query params provided, returns { total, items }.
        app.get('/issues', async (req, res) => {
            try {
                const { page, limit, search, status, priority } = req.query;

                // Build filter
                const filter = {};
                if (status && status !== "All") filter.status = status;
                if (priority && priority !== "All") filter.priority = priority;

                if (search) {
                    const s = search.trim();
                    filter.$or = [
                        { title: { $regex: s, $options: "i" } },
                        { description: { $regex: s, $options: "i" } },
                        { location: { $regex: s, $options: "i" } }
                    ];
                }

                // If page or limit provided -> server-side pagination
                if (page || limit) {
                    const p = parseInt(page || 1, 10);
                    const l = parseInt(limit || 12, 10);
                    const total = await issuesCollection.countDocuments(filter);
                    const items = await issuesCollection.find(filter)
                        .sort({ reportedAt: -1 })
                        .skip((p - 1) * l)
                        .limit(l)
                        .toArray();

                    return res.send({ total, items });
                }

                // Default: return array of all matching issues (no pagination)
                const items = await issuesCollection.find(filter).sort({ reportedAt: -1 }).toArray();
                return res.send(items);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET ISSUES BY USER
        app.get('/issues/user/:email', verifyToken, async (req, res) => {
            try {
                if (req.user.email !== req.params.email) {
                    return res.status(403).send({ message: "Unauthorized" });
                }
                const issues = await issuesCollection.find({ reporterEmail: req.params.email }).sort({ reportedAt: -1 }).toArray();
                res.send(issues);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // UPDATE ISSUE STATUS (staff or admin)
        app.patch('/issues/status/:id', verifyToken, async (req, res) => {
            try {
                const user = await usersCollection.findOne({ email: req.user.email });
                if (!["admin", "staff"].includes(user?.role)) {
                    return res.status(403).send({ message: "Only staff or admin may update status" });
                }

                const id = req.params.id;
                const { status, note } = req.body;
                if (!status) return res.status(400).send({ message: "Status is required" });

                const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
                await timelineCollection.insertOne({
                    issueId: id,
                    status,
                    message: note || `Status changed to ${status}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // DELETE ISSUE (reporter or admin)
        app.delete('/issues/:id', verifyToken, async (req, res) => {
            try {
                const issue = await issuesCollection.findOne({ _id: new ObjectId(req.params.id) });
                if (!issue) return res.status(404).send({ message: "Not found" });

                const user = await usersCollection.findOne({ email: req.user.email });

                if (req.user.email !== issue.reporterEmail && user.role !== "admin") {
                    return res.status(403).send({ message: "Unauthorized" });
                }

                if (user.role !== "admin" && issue.status !== "pending") {
                    return res.status(400).send({ message: "Only pending issues can be deleted" });
                }

                const result = await issuesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ASSIGN STAFF (admin)
        app.patch('/issues/assign/:id', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const id = req.params.id;
                const { staffEmail } = req.body;
                if (!staffEmail) return res.status(400).send({ message: "staffEmail required" });

                const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: { assignedStaff: staffEmail, status: "assigned" } });

                await timelineCollection.insertOne({
                    issueId: id,
                    status: "assigned",
                    message: `Assigned to staff ${staffEmail}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // UPVOTE
        app.patch('/issues/upvote/:id', verifyToken, async (req, res) => {
            try {
                const email = req.user.email;
                const id = req.params.id;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });

                // ensure upvoters array exists
                const upvoters = issue.upvoters || [];
                if (upvoters.includes(email)) {
                    return res.status(400).send({ message: "Already upvoted" });
                }

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $inc: { upvotes: 1 }, $addToSet: { upvoters: email } }
                );

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // BOOST (payment)
        app.post('/issues/:id/boost', verifyToken, async (req, res) => {
            try {
                const { paymentId, amount } = req.body;
                const id = req.params.id;

                await paymentsCollection.insertOne({
                    issueId: id,
                    user: req.user.email,
                    paymentId,
                    amount,
                    date: new Date()
                });

                await timelineCollection.insertOne({
                    issueId: id,
                    status: "boosted",
                    message: `Priority boosted via payment ${paymentId}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                const updateRes = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: { priority: "high" } });

                res.send(updateRes);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // EDIT ISSUE (reporter only)
        app.patch('/issues/edit/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Not found" });

                if (issue.reporterEmail !== req.user.email) {
                    return res.status(403).send({ message: "Not your issue" });
                }

                const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: req.body });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET timeline for an issue
        app.get('/timeline/:issueId', async (req, res) => {
            try {
                const data = await timelineCollection.find({ issueId: req.params.issueId }).sort({ time: -1 }).toArray();
                res.send(data);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET staff list (admin)
        app.get('/staff', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const staff = await usersCollection.find({ role: "staff" }).toArray();
                res.send(staff);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET issues assigned to a staff member (admin or the staff themself)
        app.get('/issues/staff/:email', verifyToken, async (req, res) => {
            try {
                const email = req.params.email;
                const requesterEmail = req.user.email;

                const requester = await usersCollection.findOne({ email: requesterEmail });
                if (requesterEmail !== email && requester?.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const items = await issuesCollection.find({ assignedStaff: email }).sort({ reportedAt: -1 }).toArray();
                res.send({ items });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // DASHBOARD STATS (citizen)
        app.get('/dashboard/citizen/:email/stats', verifyToken, async (req, res) => {
            try {
                if (req.user.email !== req.params.email) {
                    return res.status(403).send({ message: "Unauthorized" });
                }
                const email = req.params.email;

                const total = await issuesCollection.countDocuments({ reporterEmail: email });
                const pending = await issuesCollection.countDocuments({ reporterEmail: email, status: "pending" });
                // note: 'inProgress' vs 'in-progress' issue: we count both occurrences conservatively
                const inProgress = await issuesCollection.countDocuments({
                    reporterEmail: email,
                    $or: [{ status: "inProgress" }, { status: "in-progress" }]
                });
                const resolved = await issuesCollection.countDocuments({ reporterEmail: email, status: "resolved" });
                const payments = await paymentsCollection.countDocuments({ user: email });

                res.send({ total, pending, inProgress, resolved, payments });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ADMIN dashboard stats (admin)
        app.get('/dashboard/admin/stats', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const totalUsers = await usersCollection.countDocuments();
                const premiumUsers = await usersCollection.countDocuments({ premium: true });
                const totalStaff = await usersCollection.countDocuments({ role: "staff" });
                const totalCitizens = await usersCollection.countDocuments({ role: "citizen" });

                const totalIssues = await issuesCollection.countDocuments();
                const pending = await issuesCollection.countDocuments({ status: "pending" });
                const inProgress = await issuesCollection.countDocuments({ $or: [{ status: "inProgress" }, { status: "in-progress" }] });
                const resolved = await issuesCollection.countDocuments({ status: "resolved" });
                const closed = await issuesCollection.countDocuments({ status: "closed" });

                const highPriority = await issuesCollection.countDocuments({ priority: "high" });
                const normalPriority = await issuesCollection.countDocuments({ $or: [{ priority: "normal" }, { priority: { $exists: false } }] });

                const boosted = await paymentsCollection.countDocuments();
                const revenueAgg = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
                const totalRevenue = revenueAgg[0]?.total || 0;

                const staffPerformance = await timelineCollection.aggregate([
                    { $match: { status: "resolved" } },
                    { $group: { _id: "$updatedBy", resolvedCount: { $sum: 1 } } },
                    { $sort: { resolvedCount: -1 } },
                    { $limit: 10 }
                ]).toArray();

                const activeCitizens = await issuesCollection.aggregate([
                    { $group: { _id: "$reporterEmail", count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 10 }
                ]).toArray();

                const latestResolved = await issuesCollection.find({ status: "resolved" }).sort({ reportedAt: -1 }).limit(6).toArray();

                res.send({
                    users: {
                        totalUsers,
                        totalCitizens,
                        totalStaff,
                        totalPremium: premiumUsers
                    },
                    issues: {
                        totalIssues,
                        pending,
                        inProgress,
                        resolved,
                        closed,
                        priority: {
                            highPriority,
                            normalPriority
                        }
                    },
                    payments: {
                        totalBoostPayments: boosted,
                        totalRevenue
                    },
                    staffPerformance,
                    activeCitizens,
                    latestResolved
                });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ROOT
        app.get('/', (req, res) => {
            res.send('NovaPress API is running');
        });

        console.log('Connected to MongoDB and routes are set.');
    } finally {
        // nothing to close here; app stays running
    }
}

run().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
