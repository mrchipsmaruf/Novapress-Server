const express = require('express')
let cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 3000

// middleware
app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rjffgqf.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        let db = client.db('novapress_db');
        let usersCollection = db.collection("users");
        let issuesCollection = db.collection("issues");
        let assignmentsCollection = db.collection("assignments");
        let feedbackCollection = db.collection("feedback");
        let timelineCollection = db.collection("timeline");
        let paymentsCollection = db.collection("payments");



        //USERS APIS
        //CREATE USER (Signup)
        app.post('/users', async (req, res) => {
            try {
                let user = req.body;
                const existingUser = await usersCollection.findOne({ email: user.email });

                if (existingUser) {
                    return res.send({ message: "User already exists", insertedId: null });
                }

                const result = await usersCollection.insertOne(user);
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // GET USER BY EMAIL
        app.get('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });
                res.send(user);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // UPDATE USER ROLE
        app.patch('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const role = req.body.role;

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: { role } }
                );

                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ISSUES APIS
        // CREATE NEW ISSUES
        app.post('/issues', async (req, res) => {
            try {
                let issue = req.body;
                issue.status = "pending";
                issue.reportedAt = new Date();

                const result = await issuesCollection.insertOne(issue);
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // GET ALL ISSUES
        app.get('/issues', async (req, res) => {
            try {
                const result = await issuesCollection.find().sort({ priority: -1, reportedAt: -1 }).toArray();
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // GET ISSUES BY REPORTER
        app.get('/issues/user/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const result = await issuesCollection.find({ reporterEmail: email }).sort({ reportedAt: -1 }).toArray();
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // UPDATE ISSUES STATUS PATCH
        app.patch('/issues/status/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const status = req.body.status;
                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );

                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // DELETE ISSUE
        app.delete('/issues/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Issue Details API
        app.get('/issues/details/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const result = await issuesCollection.findOne({ _id: new ObjectId(id) });
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Issue Edit API
        app.patch('/issues/edit/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updatedData }
                );

                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Staff Assignment API
        app.patch('/issues/assign/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const staffEmail = req.body.staffEmail;

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { assignedStaff: staffEmail } }
                );

                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Issue Priority (Boost) API
        app.patch('/issues/priority/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { priority: "high" } }
                );

                res.send(result);

            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Upvote API
        app.patch('/issues/upvote/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const email = req.body.email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

                if (issue.upvoters && issue.upvoters.includes(email)) {
                    return res.status(400).send({ message: "Already upvoted" });
                }

                const result = await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $inc: { upvotes: 1 },
                        $addToSet: { upvoters: email }
                    }
                );

                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        // Timeline apis
        app.get('/timeline/:issueId', async (req, res) => {
            try {
                const id = req.params.issueId;

                const result = await timelineCollection
                    .find({ issueId: id })
                    .sort({ time: -1 })
                    .toArray();

                res.send(result);
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })

        
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
