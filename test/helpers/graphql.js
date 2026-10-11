const { graphql } = require('graphql');

// Production passes the Koa context straight through as the GraphQL context, and
// resolvers reach for `context.ctx.state.user`. Tests build the same shape so that
// no test double is needed anywhere in the resolver chain.
function buildContext(user) {
    return {
        ctx: {
            state: { user: user || null },
        },
    };
}

async function runQuery(schema, source, variables = {}, user = null) {
    return graphql({
        schema,
        source,
        variableValues: variables,
        contextValue: buildContext(user),
    });
}

// Every test should go through this: a GraphQL error is a test failure, not
// something to assert on by hand.
async function run(schema, source, { variables = {}, user = null } = {}) {
    const result = await runQuery(schema, source, variables, user);
    if (result.errors && result.errors.length) {
        throw new Error(result.errors.map(e => e.message).join('\n'));
    }
    return result.data;
}

module.exports = { run, runQuery, buildContext };