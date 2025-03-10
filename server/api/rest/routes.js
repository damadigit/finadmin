const Router = require("koa-router");
const passport = require("koa-passport");
const mongoose = require('mongoose');
const send = require('koa-send');
const path = require('path');
const fs = require('fs').promises;
const multer = require('@koa/multer');
const sharp = require('sharp');
const {getVisitWord} = require("../../reports/visitWordReport");
const User = mongoose.model('User')

const {
    authEmail,
    generateToken,
    isAuthenticated
} = require('../../auth');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        // Extract folder from URL path
        const urlPath = req.url.split('/');
        const folder = urlPath[urlPath.length - 1] || 'misc';
        
        const uploadPath = path.join(__dirname, '../../../uploads', folder);
        
        try {
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        // Keep original filename as requested
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

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

router.get('/files/(.*)', async (ctx) => {
    const filePath = ctx.params[0];
    try {
        await send(ctx, filePath, { 
            root: path.join(__dirname, '../../../uploads'),
            setHeaders: (res) => {
                res.setHeader('Access-Control-Allow-Origin', '*');
            }
        });
    } catch (err) {
        ctx.status = 404;
        ctx.body = { error: 'File not found' };
    }
});

router.post('/migrate-files', isAuthenticated(), async ctx => {
    try {
        // Update Applications
        const applications = await mongoose.model('Application').find({ 
            $or: [
                { photo: { $regex: 'cloudinary' } }
            ]
        });
        
        for (const app of applications) {
            if (app.photo) {
                const filename = app.photo.split('/').pop();
                app.photo = `/api/files/photos/${filename}`;
                await app.save();
            }
        }

        // Update Records
        const records = await mongoose.model('Record').find({ 
            $or: [
                { photo: { $regex: 'cloudinary' } }
            ]
        });

        for (const record of records) {
            if (record.photo) {
                const filename = record.photo.split('/').pop();
                record.photo = `/api/files/photos/${filename}`;
                await record.save();
            }
        }

        // Update Visits
        const visits = await mongoose.model('Visit').find({
            $or: [
                { photo: { $regex: 'cloudinary' } },
                { 'livingCondition.photos': { $elemMatch: { $regex: 'cloudinary' } } },
                { 'visitPhotos.filePath': { $regex: 'cloudinary' } }
            ]
        });

        for (const visit of visits) {
            // Update main photo
            if (visit.photo) {
                const filename = visit.photo.split('/').pop();
                visit.photo = `/api/files/photos/${filename}`;
            }

            // Update living condition photos
            if (visit.livingCondition && visit.livingCondition.photos) {
                visit.livingCondition.photos = visit.livingCondition.photos.map(photo => {
                    if (photo && photo.includes('cloudinary')) {
                        const filename = photo.split('/').pop();
                        return `/api/files/photos/${filename}`;
                    }
                    return photo;
                });
            }

            // Update visit photos
            if (visit.visitPhotos && visit.visitPhotos.length > 0) {
                visit.visitPhotos = visit.visitPhotos.map(photo => {
                    if (photo.filePath && photo.filePath.includes('cloudinary')) {
                        const filename = photo.filePath.split('/').pop();
                        photo.filePath = `/api/files/photos/${filename}`;
                    }
                    return photo;
                });
            }

            await visit.save();
        }

        // Update Posts - corrected to use 'files' instead of 'attachments'
        const Post = mongoose.model('Post');
        const posts = await Post.find({
            'files.filePath': { $regex: 'cloudinary' }
        });

        for (const post of posts) {
            if (post.files && post.files.length > 0) {
                post.files = post.files.map(file => {
                    if (file.filePath && file.filePath.includes('cloudinary')) {
                        const filename = file.filePath.split('/').pop();
                        file.filePath = `/api/files/post_attachments/${filename}`;
                    }
                    return file;
                });
                await post.save();
            }
        }

        ctx.body = {
            status: 'success',
            message: 'File paths updated successfully',
            stats: {
                applications: applications.length,
                records: records.length,
                visits: visits.length,
                posts: posts.length
            }
        };

    } catch (err) {
        ctx.status = 500;
        ctx.body = {
            status: 'error',
            message: err.message
        };
    }
});

// Updated compression function to directly overwrite the original file
async function compressImageIfNeeded(file) {
    // Only compress if file is larger than 1.5MB and is an image
    if (file.size > 1.5 * 1024 * 1024 && file.mimetype.startsWith('image/')) {
        await sharp(file.path)
            .resize(1920, 1080, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ 
                quality: 60,
                force: false // maintains original format if not jpg
            })
            .toBuffer()
            .then(async buffer => {
                await fs.writeFile(file.path, buffer);
                // Update file size
                const stats = await fs.stat(file.path);
                file.size = stats.size;
            });
    }
    return file;
}

router.post('/upload/:folder',  upload.single('file'), async ctx => {
    try {
        const folder = ctx.params.folder;
        const file = ctx.request.file;

        if (!file) {
            ctx.status = 400;
            ctx.body = { 
                status: 'error',
                message: 'No file uploaded'
            };
            return;
        }

        // Compress image if it's too large
        compressImageIfNeeded(file);

        ctx.body = {
            status: 'success',
            message: 'File uploaded successfully',
            filePath: `/api/files/${folder}/${file.filename}`,
            size: file.size // Added size to response
        };

    } catch (err) {
        ctx.status = 500;
        ctx.body = {
            status: 'error',
            message: err.message
        };
    }
});

module.exports = router;
