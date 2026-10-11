const Router = require("koa-router");
const passport = require("koa-passport");
const mongoose = require('mongoose');
const send = require('koa-send');
const path = require('path');
const fs = require('fs').promises;
const multer = require('@koa/multer');
const sharp = require('sharp');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {getVisitWord} = require("../../reports/visitWordReport");
const User = mongoose.model('User')
const { auth: authConfig } = require('../../auth/config');

const exists = async filePath => {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
};

const {
    authEmail,
    generateToken,
    isAuthenticated
} = require('../../auth');

// Configure multer for file uploads
const UPLOAD_ROOT = path.join(__dirname, '../../../uploads');

// The folders the application actually uploads into. The folder arrived as a URL
// segment and was joined straight onto the upload root, so a request could choose
// where on the filesystem a file landed. An explicit list means a caller cannot
// name a directory of their choosing, and it keeps the three real folders working
// without anyone having to remember which ones exist.
const ALLOWED_FOLDERS = new Set(['photos', 'post_attachments', 'documents']);

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

// Turns a client-supplied filename into something that is safe to join onto a
// directory and cannot climb out of it.
//
// `originalname` is attacker-controlled: it arrives in the multipart body and is
// not necessarily a basename. Browsers send just the name, but nothing forces a
// non-browser client to, and "../" in it escapes the upload directory. Path
// separators are therefore removed rather than sanitised around.
function safeFilename(originalName) {
    const base = path.basename(String(originalName || 'upload'));
    const cleaned = base.replace(SAFE_NAME, '_').replace(/^\.+/, '').slice(0, 120);

    return cleaned || 'upload';
}

// Validates the folder and refuses anything not on the list, before a byte of the
// upload is written.
//
// The storage callbacks receive the bare Node request, which carries neither the
// koa context nor koa-router's params, so the folder is bound into the storage
// engine as a closure per request instead of being read back off the request.
function resolveUploadFolder(ctx, next) {
    const folder = ctx.params.folder;

    if (!ALLOWED_FOLDERS.has(folder)) {
        ctx.status = 400;
        ctx.body = {
            status: 'error',
            message: `Unknown upload folder. Expected one of: ${[...ALLOWED_FOLDERS].join(', ')}.`,
        };
        return;
    }

    return uploadInto(folder)(ctx, next);
}

// Builds the multer middleware for one already-validated folder.
function uploadInto(folder) {
    const storage = multer.diskStorage({
        destination: async (req, file, cb) => {
            const uploadPath = path.join(UPLOAD_ROOT, folder);

            try {
                await fs.mkdir(uploadPath, { recursive: true });
                cb(null, uploadPath);
            } catch (err) {
                cb(err);
            }
        },
        filename: async (req, file, cb) => {
            const desired = safeFilename(file.originalname);

            try {
                // Keeping the name the user chose makes the uploads browsable, but
                // writing over an existing file would silently replace a document
                // somebody else had already stored under that name. A collision
                // therefore gets a suffix rather than overwriting.
                let candidate = desired;
                let suffix = 1;

                while (await exists(path.join(UPLOAD_ROOT, folder, candidate))) {
                    const ext = path.extname(desired);
                    const stem = desired.slice(0, desired.length - ext.length);
                    candidate = `${stem}-${suffix++}${ext}`;
                }

                cb(null, candidate);
            } catch (err) {
                cb(err);
            }
        }
    });

    return multer({
        storage,
        limits: {
            fileSize: 10 * 1024 * 1024 // 10MB limit
        }
    }).single('file');
}

// Roles are deliberately not read from the request body. Honouring them let
// anyone register as an admin; with the finance roles added, it would have let
// anyone register their way into reading beneficiary bank details. Accounts are
// created out of band and roles are assigned administratively, so a
// self-registered user always gets the least privileged role.
const SELF_REGISTERED_ROLE = 'handler';

async function register(ctx, next) {
    const { email, password } = ctx.request.body;

    if (!email || !password) {
        ctx.status = 400;
        ctx.body = { status: 'error', message: 'Invalid email or password' };
        return;
    }

    const existing = await User.findOne({ email });

    if (existing) {
        ctx.status = 400;
        ctx.body = { status: 'error', message: 'E-mail already registered' };
        return;
    }

    const user = new User({
        email,
        password,
        roles: [SELF_REGISTERED_ROLE]
    });

    // TODO handle password

    await user.save();

    ctx.state = {
        user: user._id,
        roles: user.roles
    };

    await next();
}

// Signed download URLs for stored uploads.
//
// Why this exists: the files are only served to signed-in callers, but an <img>
// tag cannot send an Authorization header. Fetching the bytes with one and
// turning them into a blob URL works, and is what this did first, but a blob URL
// is never written to the browser's HTTP cache. Every remount re-downloaded the
// file, and revoking the blob freed it again, so a gallery of photographs
// refetched all of them on every visit.
//
// A short-lived signed URL puts the credential in the URL instead of a header, so
// the browser can cache and reuse the response the ordinary way. The signature
// covers the path and an expiry, so it cannot be altered to reach another file,
// and it stops working on its own shortly after it is issued.
//
// The signature is keyed on the JWT secret, so there is no second secret to
// configure, deploy and eventually rotate.

const SIGNED_URL_TTL_SECONDS = 60 * 60; // one hour

function sign(filePath, expiresAt) {
    return crypto
        .createHmac('sha256', authConfig.secret)
        .update(`${filePath}:${expiresAt}`)
        .digest('base64url');
}

function verifySignedPath(filePath, expiresAt, signature) {
    if (!expiresAt || !signature) return false;

    const expiry = Number(expiresAt);
    if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return false;

    const expected = sign(filePath, expiresAt);

    // Both are base64url of a fixed-length digest, so a plain comparison is safe
    // here, but timingSafeEqual is used regardless so a forged signature cannot
    // be discovered one byte at a time.
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
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

// A one-off maintenance script that rewrites every record's photo URL. It writes
// to the database, so it is a POST: as a GET, a crawler, a link preview or a
// browser prefetch would be enough to trigger it. It is also guarded, since it
// rewrites every record in the collection.
router
    .post('/fixHttps', isAuthenticated(), async ctx => {
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

// The report is generated for a named visit and returned as a file download, so
// it is guarded rather than open. An unauthenticated caller could otherwise
// enumerate visit ids and pull a document per beneficiary.
router.get('/reports/visit/:id', isAuthenticated(), async ctx => {

    const visitId = ctx.params.id;
    const visit = await mongoose.model('Visit').findById(visitId)
    if (!visit) {
        ctx.status = 404;
        ctx.body = { error: 'No such visit' };
        return;
    }
    console.log("age",visit.age)

    ctx.attachment('visit.docx');
    const b64string = await getVisitWord({visit})
    ctx.body = Buffer.from(b64string, 'base64');

})

// Stored uploads are served to signed-in users only.
//
// These are beneficiary photographs and scanned letters held in the upload
// directory, and the route was reachable with no token, so the URLs were the only
// thing protecting them. Guessing a name, or picking one up from a URL shared in
// a chat, was enough to read them.
//
// Two ways in: the Authorization header, for API callers, and a signature in the
// query string, for <img> tags and links. The signed form is what lets the
// browser cache these properly; see the signing helpers above.
//
// The wildcard CORS header that used to be set here is gone as well: it let any
// site on the internet read these responses from a visitor's browser.
//
// A cached response must never be served to somebody who is not the caller, so
// the cache is private and varies on the credential: the browser may reuse it for
// this user, and no shared cache may store it at all.
async function sendStoredFile(ctx) {
    const filePath = ctx.params[0];

    const signed = ctx.query.exp && ctx.query.sig;
    if (!signed && !ctx.state.user) {
        ctx.throw(401, 'Authentication required.');
    }

    if (signed && !verifySignedPath(filePath, ctx.query.exp, ctx.query.sig)) {
        ctx.throw(401, 'This link has expired or is not valid.');
    }

    try {
        await send(ctx, filePath, {
            root: UPLOAD_ROOT,
            maxage: SIGNED_URL_TTL_SECONDS * 1000,
            setHeaders: res => {
                // private: this is a beneficiary's document. no-store would stop
                // the browser caching it, which is the problem this route exists
                // to solve, so the header below is what keeps it correct instead.
                res.setHeader('Cache-Control', `private, max-age=${SIGNED_URL_TTL_SECONDS}`);
                res.setHeader('Vary', 'Authorization');
            },
        });
    } catch (err) {
        if (err.status && err.status !== 404) throw err;
        ctx.status = 404;
        ctx.body = { error: 'File not found' };
    }
}

// Identifies the caller when a token is present, without insisting on one.
//
// A signed URL carries its own credential in the query string, so requiring the
// header here would reject exactly the requests it exists to serve. Passport's
// own middleware answers 401 itself when it cannot authenticate, which would
// overwrite a perfectly good file response.
//
// It also halts the middleware chain when the strategy fails, which stops the
// request before the handler can decide that a signature was good enough. The
// token is therefore verified here directly, and sendStoredFile decides what is
// acceptable: a valid signature is, and no credential at all is not.
//
// A token that does not verify is treated as no token rather than as an error.
// Both lead to the same refusal, and the file route reports that refusal itself.
const tryAuthenticated = async (ctx, next) => {
    ctx.state.user = null;

    const header = ctx.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (token) {
        try {
            // Verified against the same secrets the strategy accepts, so a token
            // issued before the signing secret rotated still works here.
            for (const secret of authConfig.verificationSecrets) {
                try {
                    const payload = jwt.verify(token, secret);
                    const user = await mongoose.model('User').findById(payload.id);
                    if (user) {
                        ctx.state.user = user;
                    }
                    break;
                } catch (e) {
                    // Not signed with this one; try the next.
                }
            }
        } catch (e) {
            // Malformed token: treated as absent.
        }
    }

    return next();
};

router.get('/files/(.*)', tryAuthenticated, sendStoredFile);

// Signs a stored path for a short time. The caller must be signed in; the
// signature is what makes the resulting URL usable by a tag that cannot send a
// token. Expiry is returned alongside so the client can ask for a fresh one
// before it lapses.
router.get('/files-sign', isAuthenticated(), ctx => {
    const filePath = String(ctx.query.path || '');

    // The path has to be inside a known folder and nowhere else. A prefix test
    // alone is not enough: "photos/../../etc/passwd" starts with "photos/" and
    // would be signed, turning a signing endpoint into a way to read anything on
    // the filesystem. So the folder is checked and the remainder checked again.
    const parts = filePath.split('/');

    if (
        parts.length !== 2 ||
        !ALLOWED_FOLDERS.has(parts[0]) ||
        !parts[1] ||
        parts[1] === '.' ||
        parts[1] === '..' ||
        parts[1].includes('\\')
    ) {
        ctx.throw(400, 'Unknown file path.');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;

    ctx.body = {
        path: filePath,
        expiresAt,
        signature: sign(filePath, expiresAt),
        ttlSeconds: SIGNED_URL_TTL_SECONDS,
    };
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

// Uploading writes a file onto the server, so it needs a signed-in caller. The
// client already sends its bearer token for this call.
router.post('/upload/:folder', isAuthenticated(), resolveUploadFolder, async ctx => {
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

        // Compress image if it's too large. Awaited so the response reports the
        // stored size rather than the size of the file that was just replaced.
        await compressImageIfNeeded(file);

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
