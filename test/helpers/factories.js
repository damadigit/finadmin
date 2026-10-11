const { mongoose } = require('./db');

let counter = 0;
const unique = () => `${Date.now().toString(36)}${counter++}`;

async function createUser(overrides = {}) {
    const User = mongoose.model('User');
    return User.create({
        email: overrides.email || `user-${unique()}@example.com`,
        password: overrides.password || 'test-password',
        roles: overrides.roles || ['handler'],
        ...overrides,
    });
}

async function createRecord(overrides = {}) {
    const Record = mongoose.model('Record');
    return Record.create({
        name: overrides.name || 'Test',
        fatherName: overrides.fatherName || 'Father',
        registrationId: overrides.registrationId || `ET${unique()}`,
        status: overrides.status || 'Active',
        ...overrides,
    });
}

module.exports = { createUser, createRecord };