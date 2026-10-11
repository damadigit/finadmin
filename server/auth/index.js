const passport = require("koa-passport");
const compose =  require('koa-compose');
const jwt =  require('jsonwebtoken');
const mongoose = require('mongoose');
const User = mongoose.model('User')
const { auth :config} = require('./config');

// Strategies
const jwtStrategy = require('./strategies/jwt');
const emailStrategy = require('./strategies/email');

passport.use('jwt', jwtStrategy);
passport.use('email', emailStrategy);

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser((id, done) => {
  (async () => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  })();
});

function auth() {
  return compose([
    passport.initialize(),
  ]);
}

// Identifies the caller from the bearer token, or null.
//
// The same secrets the JWT strategy accepts are tried in turn, so a token issued
// before the signing secret rotated still identifies its owner.
async function identify(ctx) {
  const header = ctx.get('authorization') || '';
  const [scheme, value] = header.split(/\s+/);

  // The interface sends "bearer", the upload helper sends "Bearer", so the
  // scheme is compared without regard to case.
  if (!value || String(scheme).toLowerCase() !== 'bearer') {
    return null;
  }

  for (const secret of config.verificationSecrets) {
    try {
      const payload = jwt.verify(value, secret);
      const user = await User.findById(payload.id);
      if (user) return user;
    } catch (e) {
      // Not signed with this one; try the next.
    }
  }

  return null;
}

// Rejects anonymous callers with a JSON body.
//
// This used to be passport.authenticate('jwt'), which ends the response with the
// bare text "Unauthorized". The GraphQL client parses every response as JSON, so
// it failed on that text and surfaced "Unexpected token 'U', "Unauthorized" is
// not valid JSON" to the user instead of anything about their session having
// expired. A JSON body keeps the failure legible, and gives the client something
// it can recognise and act on by signing the user out.
function isAuthenticated() {
  return async (ctx, next) => {
    const user = await identify(ctx);

    if (!user) {
      ctx.status = 401;
      ctx.body = { errors: [{ message: 'Unauthorized' }] };
      return;
    }

    ctx.state.user = user;
    return next();
  };
}

// Identifies the caller when a token is present without refusing anonymous
// requests. Used where a credential may arrive some other way - a signed URL, for
// instance - and the route itself decides whether that is enough.
function tryAuthenticated() {
  return async (ctx, next) => {
    ctx.state.user = await identify(ctx);
    return next();
  };
}

 function authEmail() {
  return passport.authenticate('email');
}

// After autentication using one of the strategies, generate a JWT token
function generateToken() {
  return async ctx => {
    const { user, roles } = ctx.state;
    if (user === false) {
      ctx.status = 401;
    } else {
      // Signed with the current secret only, and given an expiry. Tokens issued
      // before the secret rotated stay valid through the legacy verification
      // path in the JWT strategy; they are simply never minted again.
      const jwtToken = jwt.sign({ id: user, roles }, config.secret, {
        expiresIn: config.expiresIn,
      });
      const token =  jwtToken//`JWT ${jwtToken}`;

      const currentUser = await User.findOne({ _id: user });

      ctx.status = 200;
      ctx.body = {
        token,
        user: currentUser,
      };
    }
  };
}

// Web Facebook Authentication
 function isFacebookAuthenticated() {
  return passport.authenticate('facebook', {
    scope: ['email'],
  });
}

 function isFacebookAuthenticatedCallback() {
  return passport.authenticate('facebook', {
    failureRedirect: '/login',
  });
}

module.exports = {auth,isAuthenticated,tryAuthenticated,authEmail,generateToken,isFacebookAuthenticated,isFacebookAuthenticatedCallback}
