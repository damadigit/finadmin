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

// TODO - add a real secret key
 const auth = {
  secret: 'my-secret-code',
};

 module.exports = {localClient,facebook,auth}
