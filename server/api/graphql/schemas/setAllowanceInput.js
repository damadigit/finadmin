const { GraphQLInputObjectType, GraphQLInt, GraphQLString } = require('graphql');

module.exports = new GraphQLInputObjectType({
    name: 'SetMonthlyAllowanceInput',
    fields: {
        id: { type: 'MongoID!' },
        // Nullable on purpose: clearing an allowance is a real decision, and
        // "set it to nothing" should not be spelled the same as "forget it".
        amount: { type: GraphQLInt },
        note: { type: GraphQLString },
    },
});