// Authentication configuration.
//
// The signing secret comes from the environment. It used to be the literal
// string 'my-secret-code', committed to the repository, which meant anyone who
// could read the source could mint a token for any user id and authenticate as
// them - including as an administrator.
//
// Rotating a signing secret invalidates every token already issued, which would
// sign every user out at once. To avoid that, verification accepts the previous
// secret for as long as it is configured, while every newly issued token is
// signed only with the current one. See LEGACY_SECRET below.
const crypto = require('crypto');

const localClient = {
  name: 'local',
  id: 'local',
  secret: 'local',
};

const facebook = {
  clientId: '',
  clientSecret: '',
  callbackUrl: 'http://localhost:3000/api/auth/facebook/callback',
};

const DEV_FALLBACK_SECRET = 'my-secret-code';

// The secret new tokens are signed with. Required in production; a development
// fallback keeps `yarn dev` working on a fresh clone without a .env file.
function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start rather than sign tokens with a ' +
      'well-known secret. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }

  return DEV_FALLBACK_SECRET;
}

const auth = {
  secret: resolveSecret(),

  // How long a newly issued token stays valid. Applied at signing only: tokens
  // already in the wild were issued without an expiry, and adding one at
  // verification time would log every signed-in user out at once.
  expiresIn: process.env.JWT_EXPIRES_IN || '12h',

  // Verification-only. Set JWT_LEGACY_SECRET to the previous signing secret to
  // keep tokens issued before the rotation working. jsonwebtoken 8 rejects an
  // array of secrets, so the fallback is applied by the JWT strategy itself,
  // which tries each candidate in turn.
  //
  // This is a transitional allowance, not a permanent second key. Once the
  // longest plausible session has passed after rotation, unset it: the old
  // secret has been in the repository's history this entire time and anyone who
  // read it can still forge a token that verifies against it.
  legacySecret: (process.env.JWT_LEGACY_SECRET || '').trim() || null,
};

auth.verificationSecrets = auth.legacySecret
  ? [auth.secret, auth.legacySecret]
  : [auth.secret];

module.exports = { localClient, facebook, auth };

// Re-exported for the one-time setup command in the README.
module.exports.generateSecret = () => crypto.randomBytes(48).toString('hex');