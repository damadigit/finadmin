module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.test.js'],
    globalSetup: '<rootDir>/test/globalSetup.js',
    globalTeardown: '<rootDir>/test/globalTeardown.js',
    testTimeout: 30000,
    // The build output and generated schema live alongside the tests; keep jest
    // from treating them as suites.
    testPathIgnorePatterns: ['/node_modules/', '/uploads/'],
};