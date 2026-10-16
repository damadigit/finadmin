
const Koa = require('koa');
const mongoose = require('mongoose');
const passport = require("koa-passport");
const logger = require('koa-logger')
const { ApolloServer, gql } = require('apollo-server-koa');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');

// The database URI comes from the environment.
//
// It used to be a literal connection string with a live password committed to
// the repository, which meant anyone who could read the source could connect to
// the production database directly. That password is still in the repository
// history and has to be rotated there, not just removed here.
//
// There is deliberately no fallback and no default. A missing URI stops the
// process rather than quietly connecting somewhere unintended: the container in
// docker-compose-prod.yml sets DATABASE_URL, which this code never read, so the
// deployed service was in fact running against the Atlas URI embedded in the
// source. Honouring either variable now without someone choosing deliberately
// would be the same class of surprise, pointed at a different database.
//
// Set MONGOLAB_URI to the database this instance is meant to serve.
const MONGO_URI = process.env.MONGOLAB_URI;

if (!MONGO_URI) {
  console.error(
    'MONGOLAB_URI is not set. Refusing to start rather than guess a database.\n' +
    'Set it to the connection string for this environment, for example:\n' +
    '  MONGOLAB_URI="mongodb://user:password@host:27017/finadmin"\n' +
    'Note: docker-compose-prod.yml sets DATABASE_URL, which is not read. ' +
    'Either set MONGOLAB_URI or rename the variable there.'
  );
  process.exit(1);
}

mongoose.connect(MONGO_URI,
 {useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('DB Connected'))
  .catch(err => console.error(err));

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
        schema, introspection: false,
        playground: false,
        context: a => a


    });

    const app = new Koa();
    app.use(cors());
    app.use(auth.auth());
    app.use(logger())
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

    // await server.installSubscriptionHandlers(listener);
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
