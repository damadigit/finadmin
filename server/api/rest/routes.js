const Router = require("koa-router");
const passport = require("koa-passport");
const mongoose = require('mongoose');
const {getVisitWord} = require("../../reports/visitWordReport");
const User = mongoose.model('User')

const {
    authEmail,
    generateToken,
    isAuthenticated
} = require('../../auth');



async function register(ctx, next) {
    const { email, password, roles } = ctx.request.body;

    // TODO - improve validation
    if ( email && password && roles) {
        let user = await User.findOne({ email });

        if (!user) {
            user = new User({
                email,
                password,
                roles
            });

            // TODO handle password

            await user.save();

            ctx.state = {
                user: user._id,
                roles: user.roles
            };

            await next();
        } else {
            ctx.status = 400;
            ctx.body = { status: 'error', message: 'E-mail already registered' };
        }
    } else {
        ctx.status = 400;
        ctx.body = { status: 'error', message: 'Invalid email or password' };
    }
}

const router = new Router({ prefix: '/api' });

router
    .post('/auth/email',
        authEmail(),
        generateToken());

router
    .post('/auth/register',
        register,
        generateToken(),
    );

router
    // Get user data from server using token
    .get('/user/me', isAuthenticated(), async ctx => {
        const user = await User.findById(ctx.state.user);
        if (user) ctx.body = user;
    });

router
    .get('/fixHttps', async ctx => {
        const records = await mongoose.model('Record').find({}).exec();
        for (const r of records) {

            if(r.place&&r.place.photo)
            {
                console.log(r.place.photo)
                r.place.photo = r.place.photo.replace("http","https")
              //  r.status = "Active"
                await r.save()
            }
        }
        ctx.body = records.map(r=>r.place&&r.place.photo)


        }

    );

router.get('/reports/visit/:id', async ctx => {

    const visitId = ctx.params.id;
    const visit = await mongoose.model('Visit').findById(visitId)
    console.log("age",visit.age)

    ctx.attachment('visit.docx');
    const b64string = await getVisitWord({visit})
    ctx.body = Buffer.from(b64string, 'base64');

})


module.exports = router;
