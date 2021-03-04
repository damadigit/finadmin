const  { Strategy: CustomStrategy } =  require('passport-custom');
const mongoose = require('mongoose');
const User = mongoose.model('User')

module.exports =  new CustomStrategy(async (ctx, done) => {
  //console.log('Email Strategy: ', ctx.body);

  try {
    // Test whether is a login using email and password
    if (ctx.body.email && ctx.body.password) {
      const user = await User.findOne({ email: ctx.body.email.toLowerCase() }).select('+password');

      if(!user){
        return done(null, false, {error: 'Login failed. Please try again.'});
      }

      user.comparePassword(ctx.body.password, function(err, isMatch){

        if(err){
          return done(err);
        }

        if(!isMatch){
          return done(null, false, {error: 'Login failed. Please try again.'});
        }

        return done(null, user);

      });
    } else {
      done(null, false);
    }
  } catch (error) {
    done(error);
  }
});
