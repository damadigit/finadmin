const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongod is booted for the whole run and shared. Workers cannot see the
// global, so the URI is handed down through the environment, which they do
// inherit. Each worker points itself at its own database - see test/helpers/db.
module.exports = async () => {
    global.__MONGOD__ = await MongoMemoryServer.create();
    process.env.MONGO_URI = global.__MONGOD__.getUri();
};