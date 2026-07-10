/**
 * Generates the GraphQL introspection schema used by the frontend
 * (finadmin_ui/src/helpers/schema.json).
 *
 * The frontend uses this cached schema instead of running a live
 * IntrospectionQuery on every app start (which was very slow), and the
 * server has introspection disabled in production.
 *
 * Run this whenever the GraphQL schema changes:
 *   yarn generate-schema   (from finadmin_server)
 *
 * No database connection or running server is required.
 */
const fs = require('fs');
const path = require('path');
const { graphqlSync, getIntrospectionQuery } = require('graphql');

// Model definitions must be registered before building the schema.
// server/models/index.js reads from './server/models' relative to cwd,
// so run this script from the finadmin_server directory.
require('../server/models')();

const schema = require('../server/api/graphql/schema');

const { data, errors } = graphqlSync({
    schema,
    source: getIntrospectionQuery(),
});

if (errors && errors.length) {
    console.error('Failed to introspect schema:');
    errors.forEach(e => console.error(e));
    process.exit(1);
}

const outputPath = path.resolve(
    __dirname,
    '../../finadmin_ui/src/helpers/schema.json'
);

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + '\n');

console.log(`GraphQL schema written to ${outputPath}`);
process.exit(0);
