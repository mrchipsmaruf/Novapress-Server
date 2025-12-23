const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("./firebaseAdmin");

const app = express();
const port = process.env.PORT;

app.use(express.json());
app.use(cors());

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rjffgqf.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true
    }
});

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "🚀 NovaPress API is running on Vercel"
    });
});


async function verifyToken(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized" });
    }

    const token = header.split(" ")[1];

    try {
        const decoded = await admin.auth().verifyIdToken(token);

        let dbUser = await req.usersCollection.findOne({
            email: decoded.email
        });

        if (!dbUser) {
            const newUser = {
                email: decoded.email,
                name: decoded.name || "",
                image: decoded.picture || "",
                role: "citizen",
                premium: false,
                isBlocked: false,
                hasPassword: false,
                createdAt: new Date()
            };

            await req.usersCollection.insertOne(newUser);
            dbUser = newUser;
        }

        req.user = {
            email: decoded.email,
            uid: decoded.uid,
            role: dbUser.role,
            isBlocked: dbUser.isBlocked || false,
            isPremium: dbUser.premium || false
        };

        next();
    } catch (err) {
        return res.status(401).send({ message: "Invalid token" });
    }
}


// role requirement helper
function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) {
            return res.status(403).send({ message: "Forbidden - Role required: " + role });
        }
        next();
    };
}

// Prevent blocked users from performing certain actions
function checkBlocked(req, res, next) {
    if (req.user.isBlocked) {
        return res.status(403).send({ message: "Your account is blocked" });
    }
    next();
}

// Allowed status transitions (staff must follow; admin may bypass)
const VALID_STATUS_FLOW = {
    pending: ["in-progress"],
    "in-progress": ["resolved"],
    resolved: ["closed"]
};


async function run() {
    try {
        await client.connect();
        const db = client.db('novapress_db');
        const usersCollection = db.collection("users");
        const issuesCollection = db.collection("issues");
        const timelineCollection = db.collection("timeline");
        const paymentsCollection = db.collection("payments");
        const commentsCollection = db.collection("comments");

        // make available on req for middlewares that run after this
        app.use((req, res, next) => {
            req.usersCollection = usersCollection;
            req.issuesCollection = issuesCollection;
            req.timelineCollection = timelineCollection;
            req.paymentsCollection = paymentsCollection;
            req.commentsCollection = commentsCollection;
            next();
        });


        // -----------------------
        // USER ROUTES
        // -----------------------

        // Create or upsert user (used after client registers/logins)
        app.post("/users", async (req, res) => {
            try {
                const { email, name, image, hasPassword = false } = req.body;

                if (!email) {
                    return res.status(400).send({ message: "Email required" });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $setOnInsert: {
                            email,
                            name: name || "",
                            image: image || "",
                            role: "citizen",
                            premium: false,
                            isBlocked: false,
                            hasPassword,
                            createdAt: new Date()
                        }
                    },
                    { upsert: true }
                );

                res.send({ success: true, result });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        app.patch("/users/password-set", verifyToken, async (req, res) => {
            try {
                await req.usersCollection.updateOne(
                    { email: req.user.email },
                    { $set: { hasPassword: true } }
                );

                res.send({ success: true });
            } catch (err) {
                res.status(500).send({ message: "Failed to update password flag" });
            }
        });


        // =========================
        // USER PROFILE (FINAL, REQUIRED)
        // =========================

        // GET own profile (ALL ROLES)
        app.get("/users/profile", verifyToken, async (req, res) => {
            try {
                const email = req.user.email;

                const user = await req.usersCollection.findOne(
                    { email },
                    {
                        projection: {
                            _id: 0,
                            name: 1,
                            email: 1,
                            image: 1,
                            role: 1,
                            isBlocked: 1,
                            premium: 1,
                            createdAt: 1
                        }
                    }
                );

                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send({
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    role: user.role,
                    isBlocked: user.isBlocked,
                    isPremium: user.premium,
                    createdAt: user.createdAt
                });

            } catch (err) {
                res.status(500).send({ message: "Failed to load profile" });
            }
        });

        app.patch("/users/profile", verifyToken, async (req, res) => {
            try {
                const email = req.user.email;
                const { name, image } = req.body;

                const updateDoc = {
                    updatedAt: new Date()
                };

                if (name) updateDoc.name = name;
                if (image) updateDoc.image = image;

                const result = await req.usersCollection.updateOne(
                    { email },
                    { $set: updateDoc }
                );

                res.send({ success: true, result });
            } catch (err) {
                res.status(500).send({ message: "Profile update failed" });
            }
        });


        // GET user by email (private — returns own user)
        app.get('/users/:email', verifyToken, async (req, res) => {
            try {
                const target = req.params.email;
                if (req.user.email !== target) return res.status(403).send({ message: "Forbidden" });
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

        // promote to admin / staff / block / premium (admin-only for role changes except premium)
        app.patch('/users/make-admin/:email', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const email = req.params.email;
                const result = await usersCollection.updateOne({ email }, { $set: { role: "admin" } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        app.patch('/users/make-staff/:email', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const email = req.params.email;
                const result = await usersCollection.updateOne({ email }, { $set: { role: "staff" } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

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

        // Make premium (user self)
        app.patch('/users/premium/:email', verifyToken, async (req, res) => {
            try {
                if (req.user.email !== req.params.email) return res.status(403).send({ message: "Cannot modify other users" });
                const result = await usersCollection.updateOne({ email: req.params.email }, { $set: { premium: true } });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // Get role (used by client hooks)
        app.get("/users/role/:email", verifyToken, async (req, res) => {
            // If user tries to access someone else's role → downgrade
            if (req.user.email !== req.params.email) {
                return res.send({ role: "citizen" });
            }

            const user = await usersCollection.findOne({ email: req.params.email });

            // Always return a role
            res.send({ role: user?.role || "citizen" });
        });

        // --------------------------------------------
        // UPDATE USER ROLE (ADMIN ONLY)
        // --------------------------------------------
        app.patch("/users/role/:email", verifyToken, async (req, res) => {
            try {
                // 🔒 only admin can update role
                const requesterEmail = req.user.email;

                const adminUser = await usersCollection.findOne({ email: requesterEmail });
                if (!adminUser || adminUser.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden access" });
                }

                const targetEmail = req.params.email;
                const { role } = req.body;

                if (!["citizen", "staff", "admin"].includes(role)) {
                    return res.status(400).send({ message: "Invalid role" });
                }

                const result = await usersCollection.updateOne(
                    { email: targetEmail },
                    { $set: { role } }
                );

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Role update failed", error });
            }
        });



        // -----------------------
        // ISSUE ROUTES
        // -----------------------

        // CREATE ISSUE (private)
        app.post('/issues', verifyToken, checkBlocked, async (req, res) => {
            try {
                const issue = req.body || {};
                issue.reporterEmail = req.user.email;
                issue.userEmail = req.user.email;

                const user = await usersCollection.findOne({ email: req.user.email });
                const issueCount = await issuesCollection.countDocuments({ reporterEmail: req.user.email });

                if (!user?.premium && issueCount >= 3) {
                    return res.status(403).send({ message: "Free user limit reached. Upgrade to premium." });
                }

                issue.status = issue.status || "pending";
                issue.priority = issue.priority || "normal";
                issue.reportedAt = new Date();
                issue.upvotes = issue.upvotes || 0;
                issue.upvoters = issue.upvoters || [];
                issue.isHidden = false;

                const result = await issuesCollection.insertOne(issue);

                await timelineCollection.insertOne({
                    issueId: result.insertedId.toString(),
                    status: issue.status,
                    message: "Issue reported",
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({ acknowledged: true, insertedId: result.insertedId });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        app.patch("/issues/assign/:id", verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const { id } = req.params;
                const { staffEmail } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid issue ID" });
                }

                if (!staffEmail) {
                    return res.status(400).send({ message: "Staff email required" });
                }

                // ✅ verify staff
                const staff = await req.usersCollection.findOne({
                    email: staffEmail,
                    role: "staff"
                });

                if (!staff) {
                    return res.status(404).send({ message: "Staff not found" });
                }

                // ✅ verify issue
                const issue = await req.issuesCollection.findOne({
                    _id: new ObjectId(id)
                });

                if (!issue) {
                    return res.status(404).send({ message: "Issue not found" });
                }

                // ✅ assign issue
                const result = await req.issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            assignedStaff: staffEmail,     // ✅ STRING
                            status: "in-progress",         // ✅ REQUIRED
                            assignedAt: new Date()
                        }
                    }
                );

                // ✅ timeline log
                await req.timelineCollection.insertOne({
                    issueId: id,
                    status: "in-progress",
                    message: `Assigned to staff ${staffEmail}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({
                    success: true,
                    modifiedCount: result.modifiedCount
                });

            } catch (err) {
                console.error("Assign issue error:", err);
                res.status(500).send({ message: "Failed to assign issue" });
            }
        });

        app.get('/issues/my/:email', verifyToken, async (req, res) => {
            if (req.user.email !== req.params.email) {
                return res.status(403).send({ message: "Forbidden" });
            }

            const issues = await req.issuesCollection
                .find({ reporterEmail: req.user.email })
                .sort({ reportedAt: -1 })
                .toArray();

            res.send(issues);
        });

        app.get('/issues', async (req, res) => {
            try {
                const { page, limit, search, status, priority, category } = req.query;

                const filter = {
                    isHidden: false
                };

                if (status && status !== "All") filter.status = status;
                if (priority && priority !== "All") filter.priority = priority;
                if (category && category !== "All") filter.category = category;

                if (search) {
                    const s = search.trim();
                    filter.$or = [
                        { title: { $regex: s, $options: "i" } },
                        { description: { $regex: s, $options: "i" } },
                        { location: { $regex: s, $options: "i" } }
                    ];
                }

                const sortSpec = { priority: -1, reportedAt: -1 };

                if (page || limit) {
                    const p = parseInt(page || 1, 10);
                    const l = parseInt(limit || 12, 10);
                    const total = await issuesCollection.countDocuments(filter);
                    const items = await issuesCollection
                        .find(filter)
                        .sort(sortSpec)
                        .skip((p - 1) * l)
                        .limit(l)
                        .toArray();

                    return res.send({ total, items });
                }

                const items = await issuesCollection.find(filter).sort(sortSpec).toArray();
                res.send(items);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // UPVOTE ISSUE
        app.patch('/issues/upvote/:id', verifyToken, async (req, res) => {
            try {
                const issueId = req.params.id;
                const userEmail = req.user.email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

                if (!issue) {
                    return res.status(404).send({ message: "Issue not found" });
                }

                if (issue.reporterEmail === userEmail) {
                    return res.status(403).send({ message: "You cannot upvote your own issue" });
                }

                if (issue.upvoters?.includes(userEmail)) {
                    return res.status(400).send({ message: "You already upvoted this issue" });
                }

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(issueId) },
                    {
                        $inc: { upvotes: 1 },
                        $push: { upvoters: userEmail }
                    }
                );

                res.send({ success: true, modifiedCount: result.modifiedCount });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET SINGLE ISSUE (private; enforce access by role)
        app.get('/issues/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });

                const user = await usersCollection.findOne({ email: req.user.email });

                if (!user) return res.status(403).send({ message: "Forbidden" });

                if (user.role === "citizen" || user.role === "user") {
                    if (issue.reporterEmail !== req.user.email) return res.status(403).send({ message: "Forbidden: Not your issue" });
                } else if (user.role === "staff") {
                    if (issue.assignedStaff !== req.user.email) return res.status(403).send({ message: "Forbidden: Not assigned to you" });
                }
                // admin allowed

                res.send(issue);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        // UPDATE ISSUE STATUS (staff assigned OR admin). Admin may bypass flow; staff must follow VALID_STATUS_FLOW.
        app.patch('/issues/:id/status', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const { status, note } = req.body;
                if (!status) return res.status(400).send({ message: "Status is required" });

                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });

                const user = await usersCollection.findOne({ email: req.user.email });
                if (!user) return res.status(403).send({ message: "Forbidden" });

                // citizens cannot update status
                if (user.role === "citizen" || user.role === "user") {
                    return res.status(403).send({ message: "Forbidden: Citizens cannot update status" });
                }

                // staff can only update issues assigned to them
                if (user.role === "staff" && issue.assignedStaff !== req.user.email) {
                    return res.status(403).send({ message: "Forbidden: Not assigned to you" });
                }

                // validate flow (staff must follow allowed transitions)
                if (user.role === "staff") {
                    const allowed = VALID_STATUS_FLOW[issue.status] || [];
                    if (!allowed.includes(status)) {
                        return res.status(400).send({ message: `Invalid status update. Allowed: ${issue.status} → ${allowed.join(', ') || 'none'}` });
                    }
                }
                // admin may set any valid status

                // perform update
                const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

                await timelineCollection.insertOne({
                    issueId: id,
                    status,
                    message: note || `Status changed to ${status}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({ success: true, result });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // BOOST ISSUE (payment-based priority boost)
        app.post('/issues/:id/boost', verifyToken, checkBlocked, async (req, res) => {
            try {
                const id = req.params.id;
                const { paymentId, amount } = req.body;

                if (!paymentId || !amount) {
                    return res.status(400).send({ message: "paymentId and amount required" });
                }

                const issue = await req.issuesCollection.findOne({ _id: new ObjectId(id) });

                if (!issue) {
                    return res.status(404).send({ message: "Issue not found" });
                }

                // prevent double boost
                if (issue.isBoosted || issue.priority === "high") {
                    return res.status(400).send({ message: "Issue already boosted" });
                }

                // 1️⃣ save payment
                await req.paymentsCollection.insertOne({
                    issueId: id,
                    userEmail: req.user.email,
                    paymentId,
                    amount,
                    purpose: "issue_boost",
                    date: new Date()
                });

                // 2️⃣ update issue
                const updateResult = await req.issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            priority: "high",
                            isBoosted: true
                        }
                    }
                );

                // 3️⃣ timeline log (ONLY in timelineCollection)
                await req.timelineCollection.insertOne({
                    issueId: id,
                    status: "boosted",
                    message: "Priority boosted via payment",
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({ success: true, updateResult });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        // =========================
        // PREMIUM PAYMENT ROUTES
        // =========================

        // Create Stripe payment intent for frontend PaymentPage
        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            try {
                const { amount, purpose = "premium", issueId } = req.body;

                if (!amount || typeof amount !== "number") {
                    return res.status(400).send({ message: "Invalid amount" });
                }

                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                    metadata: {
                        email: req.user.email,
                        purpose,
                        issueId: issueId || "N/A"
                    }
                });

                res.send({ clientSecret: paymentIntent.client_secret });

            } catch (err) {
                console.error("🔥 STRIPE PAYMENT INTENT ERROR 🔥");
                console.error(err);

                res.status(500).send({
                    message: "Stripe payment intent failed",
                    error: err.message
                });
            }
        });

        // Verify payment + mark user as premium
        app.post('/payment/premium/verify', verifyToken, async (req, res) => {
            try {
                const { transactionId, amount } = req.body;

                if (!transactionId || !amount) {
                    return res.status(400).send({ message: "Missing transactionId or amount" });
                }

                // Save payment record
                await req.paymentsCollection.insertOne({
                    type: "premium",
                    email: req.user.email,
                    amount,
                    transactionId,
                    date: new Date()
                });

                // Activate premium
                await req.usersCollection.updateOne(
                    { email: req.user.email },
                    { $set: { premium: true } }
                );

                res.send({ success: true, message: "Premium Activated!" });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // GET membership status
        app.get('/users/membership/:email', verifyToken, async (req, res) => {
            const email = req.params.email;

            if (req.user.email !== email) {
                return res.status(403).send({ message: "Unauthorized" });
            }

            const user = await req.usersCollection.findOne({ email });

            res.send({ status: user?.premium ? "premium" : "free" });
        });

        // UPDATE membership after payment
        app.patch('/users/membership/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const { status } = req.body;

            if (!status) {
                return res.status(400).send({ message: "Missing status" });
            }

            if (req.user.email !== email) {
                return res.status(403).send({ message: "Unauthorized" });
            }

            const isPremium = status === "premium";

            const result = await req.usersCollection.updateOne(
                { email },
                { $set: { premium: isPremium } }
            );

            res.send({ success: true, result });
        });



        // EDIT ISSUE (reporter only)
        app.patch('/issues/edit/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Not found" });

                if (issue.reporterEmail !== req.user.email) return res.status(403).send({ message: "Not your issue" });

                const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: req.body });
                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        app.delete('/issues/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Not found" });

                const user = await usersCollection.findOne({ email: req.user.email });
                if (!user) return res.status(403).send({ message: "Forbidden" });

                if (req.user.email === issue.reporterEmail) {
                    // reporter: allowed only if pending
                    if (issue.status !== "pending") return res.status(400).send({ message: "Only pending issues can be deleted by reporter" });
                } else if (user.role !== "admin") {
                    // not reporter and not admin
                    return res.status(403).send({ message: "Unauthorized" });
                }

                const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });

                await timelineCollection.insertOne({
                    issueId: id,
                    status: "deleted",
                    message: `Issue deleted by ${req.user.email}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // -----------------------
        // COMMENT ROUTES
        // -----------------------

        // GET comments for an issue (public)
        app.get('/comments/:issueId', async (req, res) => {
            try {
                const issueId = req.params.issueId;
                const comments = await commentsCollection
                    .find({ issueId })
                    .sort({ time: 1 })
                    .toArray();

                res.send(comments);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // POST new comment (private + blocked check)
        app.post('/comments', verifyToken, checkBlocked, async (req, res) => {
            try {
                const { issueId, text } = req.body;
                if (!issueId || !text) {
                    return res.status(400).send({ message: "issueId and text required" });
                }

                const newComment = {
                    issueId,
                    text,
                    userEmail: req.user.email,
                    time: new Date()
                };

                const result = await commentsCollection.insertOne(newComment);

                // add to timeline
                await req.timelineCollection.insertOne({
                    issueId,
                    status: "comment",
                    message: `Comment added: ${text}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // DELETE comment (admin or the comment owner)
        app.delete('/comments/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;

                const comment = await commentsCollection.findOne({ _id: new ObjectId(id) });
                if (!comment) return res.status(404).send({ message: "Comment not found" });

                const user = await req.usersCollection.findOne({ email: req.user.email });

                // allow admin OR owner
                if (comment.userEmail !== req.user.email && user.role !== "admin") {
                    return res.status(403).send({ message: "Not allowed" });
                }

                const result = await commentsCollection.deleteOne({ _id: new ObjectId(id) });

                // timeline log (optional)
                await req.timelineCollection.insertOne({
                    issueId: comment.issueId,
                    status: "comment-delete",
                    message: `Comment deleted`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send(result);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        // TIMELINE retrieval (public)
        app.get('/timeline/:issueId', async (req, res) => {
            try {
                const data = await timelineCollection.find({ issueId: req.params.issueId }).sort({ time: -1 }).toArray();
                res.send(data);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // STAFF list (admin)
        app.get('/staff', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const staff = await usersCollection.find({ role: "staff" }).toArray();
                res.send(staff);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        app.get('/issues/staff/:email', verifyToken, async (req, res) => {
            try {
                const email = req.params.email;

                const requester = await req.usersCollection.findOne({
                    email: req.user.email
                });

                if (!requester) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                if (requester.role !== "admin" && requester.email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const items = await req.issuesCollection.find({
                    assignedStaff: email,
                    isHidden: false,
                    status: { $ne: "closed" }
                })
                    .sort({ reportedAt: -1 })
                    .toArray();

                res.send({ items });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // STAFF DASHBOARD STATS
        app.get('/issues/staff/stats/:email', verifyToken, async (req, res) => {
            try {
                const email = req.params.email;

                const requester = await usersCollection.findOne({ email: req.user.email });
                if (!requester) return res.status(403).send({ message: "Forbidden" });

                if (requester.role !== "admin" && requester.email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const assigned = await issuesCollection.countDocuments({
                    assignedStaff: email
                });

                const inProgress = await issuesCollection.countDocuments({
                    assignedStaff: email,
                    status: "in-progress"
                });

                const resolved = await issuesCollection.countDocuments({
                    assignedStaff: email,
                    status: "resolved"
                });

                const recent = await issuesCollection
                    .find({ assignedStaff: email })
                    .sort({ reportedAt: -1 })
                    .limit(5)
                    .toArray();

                res.send({
                    assigned,
                    inProgress,
                    resolved,
                    recent
                });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // CITIZEN DASHBOARD STATS
        app.get('/issues/citizen/stats/:email', verifyToken, async (req, res) => {
            try {
                const email = req.params.email;

                const requester = await req.usersCollection.findOne({ email: req.user.email });
                if (!requester) return res.status(403).send({ message: "Forbidden" });

                if (requester.role !== "admin" && requester.email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const total = await req.issuesCollection.countDocuments({ reporterEmail: email });

                const pending = await req.issuesCollection.countDocuments({
                    reporterEmail: email,
                    status: "pending"
                });

                const inProgress = await req.issuesCollection.countDocuments({
                    reporterEmail: email,
                    status: { $in: ["in-progress"] }
                });

                const resolved = await req.issuesCollection.countDocuments({
                    reporterEmail: email,
                    status: "resolved"
                });

                const closed = await req.issuesCollection.countDocuments({
                    reporterEmail: email,
                    status: "closed"
                });

                const recent = await req.issuesCollection
                    .find({ reporterEmail: email })
                    .sort({ reportedAt: -1 })
                    .limit(5)
                    .toArray();

                res.send({
                    total,
                    pending,
                    inProgress,
                    resolved,
                    closed,
                    recent
                });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        // DASHBOARD stats endpoints (citizen & admin)


        app.get('/dashboard/admin/stats', verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const totalUsers = await usersCollection.countDocuments();
                const premiumUsers = await usersCollection.countDocuments({ premium: true });
                const totalStaff = await usersCollection.countDocuments({ role: "staff" });
                const totalCitizens = await usersCollection.countDocuments({ role: "citizen" });

                const totalIssues = await issuesCollection.countDocuments();
                const pending = await issuesCollection.countDocuments({ status: "pending" });
                const inProgress = await issuesCollection.countDocuments({ status: "in-progress" });
                const resolved = await issuesCollection.countDocuments({ status: "resolved" });
                const closed = await issuesCollection.countDocuments({ status: "closed" });

                const highPriority = await issuesCollection.countDocuments({ priority: "high" });
                const normalPriority = await issuesCollection.countDocuments({ $or: [{ priority: "normal" }, { priority: { $exists: false } }] });

                const boosted = await paymentsCollection.countDocuments();
                const revenueAgg = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
                const totalRevenue = revenueAgg[0]?.total || 0;

                const staffPerformance = await timelineCollection.aggregate([
                    { $match: { status: "resolved" } },
                    {
                        $group: {
                            _id: "$updatedBy",
                            resolvedCount: { $sum: 1 }
                        }
                    },
                    { $sort: { resolvedCount: -1 } },
                    { $limit: 10 }
                ]).toArray();


                const activeCitizens = await issuesCollection.aggregate([
                    { $group: { _id: "$reporterEmail", count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 10 }
                ]).toArray();

                const latestResolved = await issuesCollection.find({ status: "resolved" }).sort({ priority: -1, reportedAt: -1 }).limit(6).toArray();

                res.send({
                    users: { totalUsers, totalCitizens, totalStaff, totalPremium: premiumUsers },
                    issues: { totalIssues, pending, inProgress, resolved, closed, priority: { highPriority, normalPriority } },
                    payments: { totalBoostPayments: boosted, totalRevenue },
                    staffPerformance, activeCitizens, latestResolved
                });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        app.patch("/issues/priority/:id", verifyToken, requireRole("admin"), async (req, res) => {
            try {
                const { id } = req.params;
                const { priority } = req.body;

                if (!["low", "normal", "high"].includes(priority)) {
                    return res.status(400).send({ message: "Invalid priority" });
                }

                // 1️⃣ Update issue priority
                const result = await req.issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { priority } }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Issue not found or unchanged" });
                }

                // 2️⃣ Add timeline entry (SEPARATE operation)
                await req.timelineCollection.insertOne({
                    issueId: id,
                    status: "priority-updated",
                    message: `Priority set to ${priority}`,
                    updatedBy: req.user.email,
                    time: new Date()
                });

                res.send({ success: true, result });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        console.log('Connected to MongoDB and routes are set.');
    } finally {

    }
}

run().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});

module.exports = app;