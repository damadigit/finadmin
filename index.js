
const Koa = require('koa');
const mongoose = require('mongoose');
const passport = require("koa-passport");
const { ApolloServer, gql } = require('apollo-server-koa');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
//console.log(process.env.MONGOLAB_URI)
mongoose.connect( process.env.MONGOLAB_URI || 'mongodb+srv://finado:finadodo1!@cluster0.oufcv.mongodb.net/finadmin?retryWrites=true&w=majority', //'mongodb://127.0.0.1:27017/finadmin_db',
    { useNewUrlParser: true } );

mongoose.connection.once('open', () => {
    console.log('connected to database');

});
require('./server/models')();
const auth  = require("./server/auth");
const mainRoutes = require("./server/api/rest/routes");
const port =  process.env.PORT || 40012;
const schema = require('./server/api/graphql/schema');
const {isAuthenticated} = require("./server/auth");
async function StartServer() {
    const server = new ApolloServer({
        schema, introspection: true,
        playground: true,
        context: a => a


    });

    const app = new Koa();
    app.use(cors());
    app.use(auth.auth());

    app.use(bodyParser());
   // app.use(passport.initialize());
    app.use(mainRoutes.routes());

    // await server.applyMiddleware({
    //     app,
    // });
    app.use(isAuthenticated());
    app.use(server.getMiddleware());
    // app.use(ctx => ctx.status = 404);
    //await server.installSubscriptionHandlers(app.listener);

    //require('./server/api/routes')(app);
   const listener =  app.listen({ port: port}, () =>
        console.log(`🚀 Server ready at http://localhost:${port}${server.graphqlPath}`),
    );

    await server.installSubscriptionHandlers(listener);
}

StartServer().catch(error => console.log(error));

// mutation {
//     itemCreateOne(record: { name: "Pasta" }) {
//         record {
//             name,
//                 _id
//         }
//     }
// }
