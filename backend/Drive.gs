/**
 * Drive.gs — Drive folder layout and the untrusted image upload path.
 * Implements CONTRACTS.md §9, folder tree from DESIGN.md §3, image rules
 * from DESIGN.md §9.
 *
 * Security boundary, not a preference:
 *   public/  and everything under it is ANYONE_WITH_LINK / VIEW.
 *   private/ is never shared. Payment screenshots live there and reach a
 *            browser only through Drive.getAsDataUri, behind an admin check.
 */

/** Top-level folder that owns everything this app creates. */
const DRIVE_ROOT_FOLDER_NAME = 'CricketAuction';

/** Child folder names — DESIGN.md §3. */
const DRIVE_FOLDER_PUBLIC = 'public';
const DRIVE_FOLDER_GALLERY = 'gallery';
const DRIVE_FOLDER_PLAYERS = 'players';
const DRIVE_FOLDER_PRIVATE = 'private';
const DRIVE_FOLDER_PAYMENTS = 'payments';

/** The only two image types accepted anywhere in the system. */
const DRIVE_MIME_JPEG = 'image/jpeg';
const DRIVE_MIME_PNG = 'image/png';

/** Default thumbnail width for Drive's CDN thumbnail endpoint. */
const DRIVE_DEFAULT_THUMB_WIDTH = 320;

const Drive = {

  // ------------------------------------------------------------------ folders

  /**
   * Find or create the top-level "CricketAuction" folder.
   * Idempotent: searches by name before creating, so re-running `setup()` never
   * produces a second root. Drive happily allows duplicate folder names, so the
   * name search is the only thing preventing that.
   * @return {string} folder id of the root folder
   */
  ensureRootFolder() {
    const rootOfDrive = DriveApp.getRootFolder();
    const it = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
    let firstAnywhere = null;

    while (it.hasNext()) {
      const folder = it.next();
      if (firstAnywhere === null) firstAnywhere = folder;
      const parents = folder.getParents();
      if (parents.hasNext() && parents.next().getId() === rootOfDrive.getId()) {
        return folder.getId();
      }
    }

    // A folder with the right name exists but somebody moved it out of My Drive.
    // Reuse it: adopting the existing tree is safer than creating a second one
    // and leaving half the tournament's files behind in the old copy.
    if (firstAnywhere !== null) return firstAnywhere.getId();

    return DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME).getId();
  },

  /**
   * Find or create a child folder by name inside a parent.
   * @param {GoogleAppsScript.Drive.Folder} parent parent folder
   * @param {string} name child folder name
   * @return {GoogleAppsScript.Drive.Folder} the existing or newly created child
   */
  _ensureChild(parent, name) {
    const it = parent.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return parent.createFolder(name);
  },

  /**
   * Build (or re-find) the whole folder tree for one tournament.
   *
   *   <root>/<tournamentId> - <slug>/
   *       public/           shared ANYONE_WITH_LINK / VIEW
   *           gallery/
   *           players/
   *       private/          never shared
   *           payments/
   *
   * Idempotent at every level, so it is safe to call on every tournament update.
   * `private/` is left untouched rather than force-set to PRIVATE — it is created
   * unshared and nothing here ever shares it, and forcing sharing would also
   * strip any deliberate collaborator the account owner added.
   *
   * @param {string} tournamentId tournament id, e.g. "TRN_ab12cd34ef56"
   * @param {string} slug url slug, e.g. "chennai-premier-league"
   * @return {{rootId:string, publicId:string, playersId:string, galleryId:string, privateId:string, paymentsId:string}}
   */
  ensureTournamentFolders(tournamentId, slug) {
    const parent = DriveApp.getFolderById(this.ensureRootFolder());

    // Re-slugify defensively: this string becomes a folder name and the caller
    // may hand us whatever the organiser typed.
    const safeSlug = Util.slugify(String(slug || ''));
    const folderName = safeSlug ? `${tournamentId} - ${safeSlug}` : String(tournamentId);

    const tournamentFolder = this._ensureChild(parent, folderName);
    const publicFolder = this._ensureChild(tournamentFolder, DRIVE_FOLDER_PUBLIC);
    const galleryFolder = this._ensureChild(publicFolder, DRIVE_FOLDER_GALLERY);
    const playersFolder = this._ensureChild(publicFolder, DRIVE_FOLDER_PLAYERS);
    const privateFolder = this._ensureChild(tournamentFolder, DRIVE_FOLDER_PRIVATE);
    const paymentsFolder = this._ensureChild(privateFolder, DRIVE_FOLDER_PAYMENTS);

    // Set sharing on each public folder explicitly. Children do inherit, but a
    // folder created by an earlier run may pre-date the sharing call, and
    // setSharing is idempotent.
    this.setPublicRead(publicFolder.getId());
    this.setPublicRead(galleryFolder.getId());
    this.setPublicRead(playersFolder.getId());

    return {
      rootId: tournamentFolder.getId(),
      publicId: publicFolder.getId(),
      playersId: playersFolder.getId(),
      galleryId: galleryFolder.getId(),
      privateId: privateFolder.getId(),
      paymentsId: paymentsFolder.getId()
    };
  },

  /**
   * Share a file or a folder as "anyone with the link can view".
   * Accepts either kind of id — Drive has no single lookup for both, so we try
   * folder first and fall back to file.
   * @param {string} fileOrFolderId Drive id of a file or folder
   * @return {void}
   */
  setPublicRead(fileOrFolderId) {
    let target;
    try {
      target = DriveApp.getFolderById(fileOrFolderId);
    } catch (e) {
      target = DriveApp.getFileById(fileOrFolderId);
    }
    target.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  },

  // ------------------------------------------------------------------- upload

  /**
   * Read a signed Apps Script byte as an unsigned 0-255 value.
   * Apps Script byte arrays are signed (-128..127), so 0xFF arrives as -1 and
   * 0x89 as -119. Comparing raw would never match and the magic number check
   * would silently pass everything.
   * @param {number} b signed byte
   * @return {number} unsigned byte value 0-255
   */
  _u8(b) {
    return (b + 256) % 256;
  },

  /**
   * Detect the real image type from the leading bytes.
   * The client's declared mime type is attacker-controlled — anyone can POST
   * `image/png` with an HTML or SVG payload and get a stored file that a browser
   * will happily execute. The magic number is the only trustworthy signal, so
   * this result, not the declared type, decides whether the upload is accepted.
   * @param {number[]} bytes decoded bytes
   * @return {string|null} DRIVE_MIME_JPEG, DRIVE_MIME_PNG, or null when unknown
   */
  _sniffImageMime(bytes) {
    if (bytes.length >= 3 &&
        this._u8(bytes[0]) === 0xFF && this._u8(bytes[1]) === 0xD8 && this._u8(bytes[2]) === 0xFF) {
      return DRIVE_MIME_JPEG;
    }
    if (bytes.length >= 4 &&
        this._u8(bytes[0]) === 0x89 && this._u8(bytes[1]) === 0x50 &&
        this._u8(bytes[2]) === 0x4E && this._u8(bytes[3]) === 0x47) {
      return DRIVE_MIME_PNG;
    }
    return null;
  },

  /**
   * Validate and store an uploaded image. This is the only untrusted binary
   * path in the system, so every check here is load-bearing.
   *
   * @param {string} folderId destination folder id
   * @param {string} base64Data base64 payload, with or without a data: URI prefix
   * @param {string} mimeType declared type, must be image/jpeg or image/png
   * @param {string} filename file name to store
   * @return {string} the new Drive file id
   * @throws {Error} VALIDATION_FAILED on any mime, size or content check failure
   */
  uploadImage(folderId, base64Data, mimeType, filename) {
    const maxBytes = DEFAULTS.max_image_bytes;

    // Declared type first: rejecting here costs nothing, whereas decoding a
    // multi-megabyte payload we are going to throw away does.
    if (mimeType !== DRIVE_MIME_JPEG && mimeType !== DRIVE_MIME_PNG) {
      throw Util.AppError(
        ERR.VALIDATION_FAILED,
        `Only JPG and PNG images are accepted. This file is "${mimeType}".`
      );
    }

    if (typeof base64Data !== 'string' || base64Data.length === 0) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'No image data was received. Please pick the photo again.');
    }

    // 1. Strip a "data:image/jpeg;base64," prefix if the browser sent the whole URI.
    const clean = base64Data.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');

    // Cheap outer guard before decoding: base64 is 4 characters per 3 bytes, so
    // the decoded size is about 3/4 of the string length. Set at twice the limit
    // so anything merely over the limit still reaches the exact check below and
    // gets a precise message; this only catches a deliberately huge payload,
    // which we must not spend the 6-minute runtime decoding.
    const approxBytes = Math.floor(clean.length * 3 / 4);
    if (approxBytes > maxBytes * 2) {
      throw Util.AppError(
        ERR.VALIDATION_FAILED,
        `Image is about ${(approxBytes / (1024 * 1024)).toFixed(1)} MB. ` +
        `The limit is ${(maxBytes / (1024 * 1024)).toFixed(0)} MB — please pick a smaller photo.`
      );
    }

    // 2. Decode.
    let bytes;
    try {
      bytes = Utilities.base64Decode(clean);
    } catch (e) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The image could not be read. Please try uploading it again.');
    }

    // 5. Empty payload.
    if (!bytes || bytes.length === 0) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'The image file is empty. Please pick the photo again.');
    }

    // 4. Real decoded size.
    if (bytes.length > maxBytes) {
      const actualMb = (bytes.length / (1024 * 1024)).toFixed(1);
      const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
      throw Util.AppError(
        ERR.VALIDATION_FAILED,
        `Image is ${actualMb} MB. The limit is ${limitMb} MB — please pick a smaller photo.`
      );
    }

    // 6. Magic number, and it must agree with what the client claimed.
    const actualMime = this._sniffImageMime(bytes);
    if (actualMime === null) {
      throw Util.AppError(ERR.VALIDATION_FAILED, 'This file is not a valid JPG or PNG image.');
    }
    if (actualMime !== mimeType) {
      throw Util.AppError(
        ERR.VALIDATION_FAILED,
        `The file says it is "${mimeType}" but its contents are "${actualMime}". Please upload a real JPG or PNG.`
      );
    }

    // 7. Store. Strip path separators so a crafted filename cannot look like a path.
    const safeName = String(filename || '').replace(/[\/\\]/g, '_').trim() || `upload-${Util.uid('IMG')}`;
    const blob = Utilities.newBlob(bytes, actualMime, safeName);
    return DriveApp.getFolderById(folderId).createFile(blob).getId();
  },

  // ------------------------------------------------------------------ serving

  /**
   * Public CDN thumbnail URL for a Drive image. Only works for files shared
   * ANYONE_WITH_LINK, i.e. anything under public/.
   * @param {string} fileId Drive file id
   * @param {number} [width=320] pixel width
   * @return {string} thumbnail URL
   */
  thumbUrl(fileId, width) {
    const w = Math.floor(Number(width));
    const px = isFinite(w) && w > 0 ? w : DRIVE_DEFAULT_THUMB_WIDTH;
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${px}`;
  },

  /**
   * Read a Drive file and return it as an inline data: URI.
   *
   * SECURITY: this is the ONLY way a payment screenshot may reach a browser.
   * Files under private/ are unshared, so no Drive link works for them — that is
   * deliberate, because a Drive link is unauthenticated and payment proofs must
   * not be guessable (DESIGN.md §3). Every caller must have already verified an
   * admin token before calling this; there is no permission check inside here.
   *
   * @param {string} fileId Drive file id
   * @return {string} "data:image/jpeg;base64,..."
   */
  getAsDataUri(fileId) {
    const blob = DriveApp.getFileById(fileId).getBlob();
    return `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`;
  },

  /**
   * Move a file to the Drive trash.
   * Trashed, not hard deleted: a wrong click on "reject payment" or "remove
   * photo" stays recoverable from the trash for 30 days. Nothing in this app
   * ever deletes a file permanently.
   * @param {string} fileId Drive file id
   * @return {void}
   * @throws {Error} NOT_FOUND when the file does not exist or is not accessible
   */
  deleteFile(fileId) {
    let file;
    try {
      file = DriveApp.getFileById(fileId);
    } catch (e) {
      throw Util.AppError(ERR.NOT_FOUND, `File ${fileId} was not found.`);
    }
    file.setTrashed(true);
  }
};
