const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');

const EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Builds middleware that saves one uploaded file from `field` into the app's upload dir.
// On failure it calls onError(req, res, message) instead of continuing.
function singleUpload({ field, mimeTypes, typeError, onError }) {
  return (req, res, next) => {
    const { uploadDir, maxUploadBytes } = req.app.locals;
    fs.mkdirSync(uploadDir, { recursive: true });
    const upload = multer({
      storage: multer.diskStorage({
        destination: uploadDir,
        filename: (_req, file, cb) => cb(null, crypto.randomUUID() + EXTENSIONS[file.mimetype]),
      }),
      limits: { fileSize: maxUploadBytes, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (mimeTypes.includes(file.mimetype)) return cb(null, true);
        const err = new Error(typeError);
        err.code = 'BAD_FILE_TYPE';
        cb(err);
      },
    }).single(field);

    upload(req, res, (err) => {
      if (!err) return next();
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large (max ${Math.round(maxUploadBytes / 1024 / 1024)} MB).`
          : err.code === 'BAD_FILE_TYPE'
            ? err.message
            : 'Upload failed. Please try again.';
      onError(req, res, message);
    });
  };
}

module.exports = { singleUpload };
