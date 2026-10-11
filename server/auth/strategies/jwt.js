const { Strategy: JWTStrategy, ExtractJwt } = require('passport-jwt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = mongoose.model('User')
const { auth } = require('../config');

const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
};

// jsonwebtoken 8 throws if handed an array of secrets, so the fallback cannot be
// expressed as `secretOrKey: [a, b]`. The strategy hands us the raw token, so we
// verify against each configured secret ourselves and pass the winner through as
// a single value.
//
// This is what lets the signing secret rotate without signing everybody out:
// a token minted under the old secret still verifies, while every new token is
// signed only with the current one.
opts.secretOrKeyProvider = (req, rawJwtToken, done) => {
  const secrets = auth.verificationSecrets;

  // Report the failure from the current signing secret rather than the last one
  // tried, so the message the caller sees ("jwt expired", "invalid signature")
  // is the meaningful one rather than an artefact of the fallback order.
  const fail = () => jwt.verify(rawJwtToken, auth.secret, opts, err => done(err));

  const attempt = index => {
    if (index >= secrets.length) return fail();

    jwt.verify(rawJwtToken, secrets[index], opts, (err, payload) => {
      if (err) return attempt(index + 1);
      done(null, secrets[index], payload);
    });
  };

  attempt(0);
};

module.exports = new JWTStrategy(opts, async (jwtPayload, done) => {
  // The user is read from the database on every request rather than trusted from
  // the token, so a role change takes effect immediately and a deleted account
  // cannot keep using a token that is still cryptographically valid.
  const user = await User.findById(jwtPayload.id);
  if (user) {
    done(null, user);
  } else {
    done(null, false);
  }
});