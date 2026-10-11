// globalSetup and globalTeardown both run in jest's main process, so the
// instance it started is still here.
module.exports = async () => {
    if (global.__MONGOD__) {
        await global.__MONGOD__.stop();
    }
};