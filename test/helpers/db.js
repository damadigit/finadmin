const path = require('path');
const mongoose = require('mongoose');

// The model loader reads the models directory relative to the process working
// directory, so pin it to the server root before anything requires it.
process.chdir(path.join(__dirname, '..', '..'));

let connected = false;

// Each jest worker gets its own database so that files running in parallel
// cannot see each other's data. Workers share one mongod, started in globalSetup.
const databaseName = `test_worker_${process.env.JEST_WORKER_ID || '1'}`;

async function connect() {
    if (connected) return;
    const uri = process.env.MONGO_URI;
    if (!uri) {
        throw new Error('MONGO_URI is not set. Tests must run through jest so that globalSetup boots a database.');
    }
    await mongoose.connect(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        dbName: databaseName,
    });
    connected = true;
}

async function disconnect() {
    if (!connected) return;
    await mongoose.disconnect();
    connected = false;
}

async function clearDatabase() {
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
        await collection.deleteMany({});
    }
}

// Models have to be registered before the schema is composed from them, which is
// the same ordering the schema generation script uses.
function loadModels() {
    require('../../server/models')();
}

function getSchema() {
    return require('../../server/api/graphql/schema');
}

module.exports = { connect, disconnect, clearDatabase, loadModels, getSchema, mongoose };