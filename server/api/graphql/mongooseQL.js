const passport = require("koa-passport");
const mongoose = require('mongoose');
const { composeWithMongoose } = require('graphql-compose-mongoose');
const _ = require("lodash")
const pluralize = require('pluralize')
const ListMetadataTC = require('./schemas/listMetaData')
// const {isAuthenticated} = require("../../auth");
module.exports = function(name,schemaComposer ) {

    const flattenKeys = (obj, path = []) =>
        !_.isObject(obj)
            ? { [path.join('.')]: obj }
            : _.reduce(obj, (cum, next, key) => _.merge(cum, flattenKeys(next, [...path, key])), {});


const authMiddleware = async (resolve, root, args, context, info) => {
     const {ctx}  = context;
     const op = (info.operation && info.operation.name && info.operation.name.value) || ''
   // console.log(passport.authenticate('jwt')(ctx,next))
          // const result =

    if(args.record) {
        if(op.includes('update'))
        { args.record.modifiedBy = ctx.state.user._id

        }
        if(op.includes('create')) {
            args.record.createdBy = ctx.state.user._id
        }


    }
        return await resolve(root, args, context, info)
    }


    const Model = mongoose.model(name);
   const ModelTC= composeWithMongoose(Model);



    //const name = model;

    ModelTC.addResolver({
        name: `allMeta`,
        kind: 'query',
        type: ListMetadataTC,
        args: ModelTC.getResolver('findMany').getArgs(),
        resolve: async ({ source, args, context, info }) => {
            // const user = await User.findOne(args.record).exec();
            // if (!user) user = await User.create(args.record);
            // console.log(args)


            return {

                count: await Model.countDocuments(flattenKeys(args.filter))
            }
        },
    });

    ModelTC.addFields( {
        id:
            { // set `id` name for new field
        type: 'MongoID', // set type MongoID
        resolve: (source) => source._id, // write resolve method, which returns _id value for the current field
        projection: { _id: true }, // add information, that need to reques _id field from database, when you request `id` field
    }
    }
    );

    schemaComposer.Query.addFields({
        [name]: ModelTC.getResolver('findById'),
        [`byIds${name}`]: ModelTC.getResolver('findByIds'),
        [`one${name}`]: ModelTC.getResolver('findOne'),
        [`all${pluralize(name)}`]: ModelTC.getResolver('findMany'),
        [`_all${pluralize(name)}Meta`]: ModelTC.getResolver('allMeta'),
        [`count${name}`]: ModelTC.getResolver('count'),
        [`connection${name}`]: ModelTC.getResolver('connection'),
        [`pagination${name}`]: ModelTC.getResolver('pagination'),
    });





    schemaComposer.Mutation.addFields({
        [`create${name}`]: ModelTC.getResolver('createOne',[authMiddleware]),
        [`createMany${name}`]: ModelTC.getResolver('createMany',[authMiddleware]),
        [`update${name}`]: ModelTC.getResolver('updateById',[authMiddleware]),
        [`updateOne${name}`]: ModelTC.getResolver('updateOne',[authMiddleware]),
        [`updateMany${name}`]: ModelTC.getResolver('updateMany',[authMiddleware]),
        [`delete${name}`]: ModelTC.getResolver('removeById',[authMiddleware]),
        [`deleteOne${name}`]: ModelTC.getResolver('removeOne',[authMiddleware]),
        [`deleteMany${name}`]: ModelTC.getResolver('removeMany',[authMiddleware]),
    });






    return {schemaComposer, Model, ModelTC};

};
















// const {gql } = require('apollo-server-hapi');
//
//
// module.exports = gql`
// type Item {
//   id: String
//   name: String
// }
//
// type Item {
//   name: String
// }
//
// type Query {
//   items: [Item]
//   item(id: String): Item
// }
// `;





// const graphql = require('graphql')
// const {GraphQLObjectType, GraphQLString, GraphQLSchema} = graphql;
// const ItemType = require('./ItemType');
// const mongoose = require('mongoose');
//
// const RootQuery = new GraphQLObjectType (
//     {
//         name: 'RootQueryType',
//         fields: {
//             item: {
//                 type: ItemType,
//                 args: {id: {type: GraphQLString}},
//                 resolve(parent, args) {
//
//                     return  mongoose.model('Item').findById(args.id)
//
//                 }
//             }
//         }
//     }
// )
//
// module.exports = new GraphQLSchema({
//     query: RootQuery
// });
