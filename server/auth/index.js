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

function isAuthenticated() {
  return passport.authenticate('jwt');
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
      const jwtToken = jwt.sign({ id: user, roles }, config.secret);
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

module.exports = {auth,isAuthenticated,authEmail,generateToken,isFacebookAuthenticated,isFacebookAuthenticatedCallback}
