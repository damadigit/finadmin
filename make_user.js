const mongoose = require('mongoose');
require('./server/models')();
const uri = "mongodb+srv://finado:finadodo1!@cluster0.oufcv.mongodb.net/finadmin?retryWrites=true&w=majority";
(async () => {
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  const User = mongoose.model('User');
  const email = 'tmp-ui-probe@example.com';
  await User.deleteOne({ email });
  await User.create({ email, password: 'probe-pass-123', roles: ['handler', 'admin', 'finance'] });
  console.log('temp user ready');
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
