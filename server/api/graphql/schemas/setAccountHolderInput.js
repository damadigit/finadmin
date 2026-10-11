const { GraphQLInputObjectType } = require('graphql');

module.exports = new GraphQLInputObjectType({
    name: 'SetAccountHolderInput',
    fields: {
        id: { type: 'MongoID!' },
        // Nullable: omit it to detach the beneficiary from its account holder.
        accountHolder: { type: 'MongoID' },
    },
});