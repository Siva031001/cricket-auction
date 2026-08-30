/**
 * image.js — client-side image resize for upload. `ImageTool`.
 *
 * Implements CONTRACTS-PHASE1.md §1 and §4, DESIGN.md §9 (§38).
 *
 *   ImageTool.fromFile(file, {maxEdge, quality, keepPng})
 *        -> Promise<{data, mime, filename, width, height, bytes}>
 *   ImageTool.pair(file)        -> Promise<{photo, photoThumb}>  1024 + 320, ONE decode
 *   ImageTool.previewUrl(file)  -> string object URL for an <img>; CALLER REVOKES
 *
 * ===========================================================================
 * CSS CLASS NAMES EMITTED BY THIS FILE:  none.
 *
 * ImageTool never puts anything in the document. The <canvas> it uses is
 * detached, drawn into, read from, and then zeroed. There is nothing here for
 * the integration agent to style.
 * ===========================================================================
 *
 * WHY CLIENT-SIDE RESIZE IS MANDATORY (DESIGN.md §9)
 * A 4 MB phone photo becomes ~150 KB. That is the difference between a
 * 3-second submit and a 40-second one on mobile data, and deadline night is
 * all mobile data. The server re-validates every image anyway
 * (Drive.uploadImage: declared mime, decoded size, magic number) — the client
 * resize is for speed, the server check is for safety. Never rely on this file
 * for security.
 *
 * OUTPUT SHAPE
 * `data` is base64 with NO `data:` prefix, because the server feeds it
 * straight to Utilities.base64Decode. See CONTRACTS-PHASE1.md §1.
 *
 * ERRORS
 * Every rejection carries {code, message} — the same shape api.js rejects
 * with, so pages can use one error path for "your photo is not an image" and
 * "the server said DUPLICATE_MOBILE". `code` is always 'VALIDATION_FAILED'
 * (CONTRACTS.md §3): everything that can go wrong here is the file being
 * wrong, and `message` is written to be shown to a player as-is.
 */

/* eslint-disable no-unused-vars */
const ImageTool = {

  /* ------------------------------------------------------------------ *
   * Tunables. The defaults are the contract (CONTRACTS-PHASE1.md §1).
   * ------------------------------------------------------------------ */

  /** Longest side, in px, for a full-size upload. */
  MAX_EDGE: 1024,

  /** Longest side, in px, for a thumbnail. */
  THUMB_EDGE: 320,

  /** JPEG quality. 0.8 is the contract's "100-200 KB from a 4 MB photo". */
  QUALITY: 0.8,

  /**
   * Hard input ceiling, checked BEFORE any decode.
   *
   * 25 MB is well above any phone camera JPEG (a 108 MP shot is ~12 MB) and
   * well below the point where decoding kills a mid-range phone. Rejecting on
   * the byte count costs nothing; decoding a 200 MB TIFF someone picked by
   * mistake would freeze the tab.
   */
  MAX_INPUT_BYTES: 25 * 1024 * 1024,

  /** How much of the head of the file to read when hunting for EXIF. */
  _HEADER_BYTES: 128 * 1024,

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  /**
   * Resize one file and return it in the image-transport shape.
   *
   * @param {File|Blob} file  what the user picked from <input type="file">
   * @param {Object} [opts]
   * @param {number} [opts.maxEdge=1024]  longest side of the result, in px.
   *        NEVER upscales: a 300 px photo stays 300 px, because blowing it up
   *        adds bytes and no detail.
   * @param {number} [opts.quality=0.8]   JPEG quality, 0..1. Ignored for PNG.
   * @param {boolean} [opts.keepPng=false]
   *        Keep a PNG input as PNG instead of re-encoding it to JPEG.
   *
   *        THE UPI QR CODE MUST USE THIS (CONTRACTS-PHASE1.md §1). A QR code
   *        is hard black-and-white edges, which is the exact worst case for
   *        JPEG's chroma subsampling: the ringing artefacts it introduces
   *        around each module can make the code unscannable, and the player
   *        then cannot pay. PNG is lossless, so the code survives.
   *
   *        A non-PNG input is still encoded as JPEG even with keepPng:true —
   *        turning a JPEG into a PNG would multiply its size for no gain.
   * @param {string} [opts.filename]  override the output filename.
   * @return {Promise<{data: string, mime: string, filename: string,
   *                   width: number, height: number, bytes: number}>}
   *         `data` is base64 with no `data:` prefix.
   *         `bytes` is the size of the encoded image the base64 decodes to,
   *         so a page can tell the player "4.1 MB became 148 KB".
   *         Rejects with {code, message}.
   */
  fromFile: function (file, opts) {
    const options = opts || {};

    return ImageTool._guard(file)
      .then(function () {
        return ImageTool._decode(file);
      })
      .then(function (decoded) {
        try {
          return ImageTool._encodeOne(decoded, file, options);
        } finally {
          decoded.release();
        }
      });
  },

  /**
   * Produce the 1024 px `photo` and the 320 px `photoThumb` from ONE decode.
   *
   * Calling fromFile twice would decode the same 4 MB JPEG twice. On a
   * mid-range Android that is several seconds of frozen UI per extra decode,
   * which reads as "the app has hung" and makes people re-tap. One decode,
   * two draws.
   *
   * @param {File|Blob} file
   * @param {Object} [opts]  same options as fromFile; maxEdge is ignored
   *        because the two sizes are fixed by the contract.
   * @return {Promise<{photo: Object, photoThumb: Object}>}
   *         Both entries are fromFile-shaped. Rejects with {code, message}.
   */
  pair: function (file, opts) {
    const options = opts || {};

    return ImageTool._guard(file)
      .then(function () {
        return ImageTool._decode(file);
      })
      .then(function (decoded) {
        try {
          const base = ImageTool._baseName(options.filename || decoded.name);

          const photo = ImageTool._encodeOne(decoded, file, {
            maxEdge: ImageTool.MAX_EDGE,
            quality: options.quality,
            keepPng: options.keepPng,
            filename: base
          });

          const photoThumb = ImageTool._encodeOne(decoded, file, {
            maxEdge: ImageTool.THUMB_EDGE,
            quality: options.quality,
            keepPng: options.keepPng,
            filename: base + '_thumb'
          });

          return { photo: photo, photoThumb: photoThumb };
        } finally {
          decoded.release();
        }
      });
  },

  /**
   * Object URL for an instant <img> preview, before any resizing happens.
   *
   * THE CALLER MUST REVOKE IT with URL.revokeObjectURL once the <img> has
   * loaded or been replaced. An object URL pins the whole original file in
   * memory until the document is discarded, so a player who re-picks their
   * photo five times would otherwise be holding 20 MB of dead Blobs on a
   * phone. The usual shape is:
   *
   *     const url = ImageTool.previewUrl(file);
   *     img.onload = function () { URL.revokeObjectURL(url); };
   *     img.src = url;
   *
   * Synchronous, so it throws (it does not reject) when the file is not an
   * image. The thrown value is still {code, message}.
   *
   * @param {File|Blob} file
   * @return {string} object URL
   * @throws {{code: string, message: string}}
   */
  previewUrl: function (file) {
    const problem = ImageTool._checkFile(file);
    if (problem) throw problem;
    return URL.createObjectURL(file);
  },

  /**
   * Human-readable byte count, for "4.1 MB became 148 KB" messages.
   * @param {number} n
   * @return {string}
   */
  formatBytes: function (n) {
    const num = Number(n) || 0;
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(0) + ' KB';
    return (num / (1024 * 1024)).toFixed(1) + ' MB';
  },

  /* ------------------------------------------------------------------ *
   * Guards — run BEFORE any decode
   * ------------------------------------------------------------------ */

  /**
   * Synchronous validation of the picked file.
   * @param {*} file
   * @return {?{code: string, message: string}} null when the file is fine.
   */
  _checkFile: function (file) {
    if (!file || typeof file !== 'object' || typeof file.size !== 'number') {
      return ImageTool._err('Please choose a file.');
    }

    if (file.size === 0) {
      return ImageTool._err(
        'That file is empty. Please choose the photo again.');
    }

    if (file.size > ImageTool.MAX_INPUT_BYTES) {
      return ImageTool._err(
        'That image is ' + ImageTool.formatBytes(file.size) + ', which is too ' +
        'large to process. Please choose a photo under ' +
        ImageTool.formatBytes(ImageTool.MAX_INPUT_BYTES) + '.');
    }

    // Some Android pickers hand over a File with type ''. Fall back to the
    // extension rather than rejecting a photo that is perfectly fine.
    const type = String(file.type || '').toLowerCase();
    if (type) {
      if (type.indexOf('image/') !== 0) {
        return ImageTool._err(
          'That file is not an image. Please choose a JPG or PNG photo.');
      }
    } else if (!/\.(jpe?g|png|gif|bmp|webp|heic|heif|avif)$/i.test(String(file.name || ''))) {
      return ImageTool._err(
        'That file is not an image. Please choose a JPG or PNG photo.');
    }

    return null;
  },

  /**
   * Promise wrapper around _checkFile.
   * @param {*} file
   * @return {Promise<void>}
   */
  _guard: function (file) {
    const problem = ImageTool._checkFile(file);
    return problem ? Promise.reject(problem) : Promise.resolve();
  },

  /**
   * Build the {code, message} rejection value.
   * @param {string} message  shown to a player verbatim
   * @return {{code: string, message: string}}
   */
  _err: function (message) {
    // VALIDATION_FAILED, from the CONTRACTS.md §3 table, so pages can handle
    // a bad local file with the same branch as a server field error.
    return { code: 'VALIDATION_FAILED', message: message };
  },

  /* ------------------------------------------------------------------ *
   * Decode
   * ------------------------------------------------------------------ */

  /**
   * Decode the file once and work out what still has to be done about EXIF.
   *
   * =====================================================================
   * EXIF ORIENTATION. READ THIS BEFORE CHANGING ANYTHING BELOW.
   *
   * An iPhone held in portrait does not rotate the pixels it stores. It
   * stores a landscape frame plus an EXIF "Orientation" tag saying which way
   * up it goes. Ignore the tag and every portrait photo is sideways — on the
   * projector, in front of the whole room. That is the failure this code
   * exists to prevent.
   *
   * The awkward part is that browsers disagree about who applies the tag:
   *
   *   createImageBitmap(file, {imageOrientation:'from-image'})
   *     applies it   — Chrome 79+, Edge 79+, Firefox 77+, Safari 15+
   *     IGNORES the option (silently, no throw) — Chrome 50-78, which had
   *                    createImageBitmap long before it had this option
   *     not available at all — Safari 14 and earlier (iOS 14), old Edge
   *                    -> those take the <img> fallback below
   *
   *   <img> + drawImage
   *     applies it   — Safari (always has), Firefox 77+, Chrome 81+
   *                    (this is the CSS `image-orientation: from-image`
   *                    default, which also governs drawImage)
   *     does not     — Chrome 80 and earlier
   *
   * So "which path did I take" does not tell us whether the rotation was
   * done. Feature-detecting the option is not reliable either, because the
   * browsers that ignore it accept the dictionary without complaint.
   *
   * THE FIX: ask the file, not the browser. We parse the JPEG ourselves for
   * two things — the Orientation tag, and the SOF marker's stored width and
   * height (the raw pixel grid, before any rotation). Then:
   *
   *   tag says a quarter turn (5..8) AND decoded size came back SWAPPED
   *       -> the browser already rotated it. Do nothing more.
   *   tag says a quarter turn AND decoded size matches the stored size
   *       -> the browser did not. Apply the transform on the canvas.
   *
   * That is a measurement, not a guess, and it covers the quarter turns —
   * which are the only orientations a phone camera actually produces (1, 6
   * and 8; 3 shows up when the phone is held upside down).
   *
   * Orientations 2, 4, 5 and 7 are mirrored. They cannot be told apart by
   * size, and no camera writes them — they come from editing software. For
   * those we trust the browser, because every browser that is still in use
   * and can reach this code applies them.
   * =====================================================================
   *
   * @param {File|Blob} file
   * @return {Promise<{source: (ImageBitmap|HTMLImageElement), width: number,
   *                   height: number, orientation: number, name: string,
   *                   type: string, release: function(): void}>}
   *         `orientation` is the transform still OUTSTANDING, i.e. 1 when the
   *         browser already handled it.
   */
  _decode: function (file) {
    return ImageTool._readHeader(file).then(function (meta) {
      const useBitmap = (typeof createImageBitmap === 'function');
      const load = useBitmap
        ? ImageTool._decodeBitmap(file)
        : ImageTool._decodeImgElement(file);

      return load.then(function (decoded) {
        const dW = decoded.width;
        const dH = decoded.height;

        // What is LEFT to do after whatever the browser did or did not do.
        let outstanding = 1;

        if (meta.orientation >= 5 && meta.orientation <= 8) {
          // A quarter turn: measurable. meta.rawWidth is 0 when the file is
          // not a JPEG or the header could not be parsed, in which case we
          // cannot measure and fall back to trusting the browser.
          if (meta.rawWidth && dW === meta.rawWidth && dH === meta.rawHeight) {
            outstanding = meta.orientation;   // browser left it alone
          }
          // else: dimensions came back swapped -> already rotated -> 1
        }
        // Orientations 2/3/4 keep the same dimensions, so there is nothing to
        // measure. See the block comment: trust the browser.

        return {
          source: decoded.source,
          width: dW,
          height: dH,
          orientation: outstanding,
          name: String(file.name || ''),
          type: String(file.type || '').toLowerCase(),
          release: decoded.release
        };
      });
    });
  },

  /**
   * Preferred decode path. Off the main thread in most browsers, so a 4 MB
   * JPEG does not lock up the form while it decodes.
   * @param {File|Blob} file
   * @return {Promise<{source: ImageBitmap, width: number, height: number,
   *                   release: function(): void}>}
   */
  _decodeBitmap: function (file) {
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .then(function (bitmap) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: function () {
            // Frees the decoded pixel buffer immediately instead of waiting
            // for GC. A 4000x3000 bitmap is ~48 MB of RGBA.
            if (typeof bitmap.close === 'function') bitmap.close();
          }
        };
      })
      .catch(function () {
        // Some builds cannot decode certain formats (notably HEIC outside
        // Safari) through createImageBitmap but manage fine through <img>.
        return ImageTool._decodeImgElement(file);
      });
  },

  /**
   * Fallback decode path.
   *
   * Needed by Safari 14 and earlier (iOS 14 and earlier), which has no
   * createImageBitmap at all, and by any browser whose createImageBitmap
   * refused the file's format. Costs an object URL and a main-thread decode.
   *
   * @param {File|Blob} file
   * @return {Promise<{source: HTMLImageElement, width: number,
   *                   height: number, release: function(): void}>}
   */
  _decodeImgElement: function (file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      let settled = false;

      const release = function () {
        // Revoked as soon as the pixels are ours. Leaving these alive is the
        // classic way a photo picker leaks a phone's memory.
        URL.revokeObjectURL(url);
        img.src = '';
      };

      img.onload = function () {
        if (settled) return;
        settled = true;
        resolve({
          source: img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          release: release
        });
      };

      img.onerror = function () {
        if (settled) return;
        settled = true;
        release();
        reject(ImageTool._err(
          'That image could not be opened. Please try a different photo.'));
      };

      // Ask for the EXIF rotation explicitly. Harmless where it is already
      // the default, and it is what _decode's dimension cross-check measures.
      try { img.style.imageOrientation = 'from-image'; } catch (e) { /* older UA */ }

      img.src = url;
    });
  },

  /* ------------------------------------------------------------------ *
   * Encode
   * ------------------------------------------------------------------ */

  /**
   * Draw one decoded source into a canvas at the requested size and read it
   * back as base64. Synchronous, so pair() can call it twice off one decode.
   *
   * @param {Object} decoded  from _decode
   * @param {File|Blob} file  the original, for name and type
   * @param {Object} options  {maxEdge, quality, keepPng, filename}
   * @return {{data: string, mime: string, filename: string, width: number,
   *           height: number, bytes: number}}
   */
  _encodeOne: function (decoded, file, options) {
    const maxEdge = ImageTool._positive(options.maxEdge, ImageTool.MAX_EDGE);
    const quality = ImageTool._quality(options.quality);
    const orientation = decoded.orientation;
    const swap = (orientation >= 5 && orientation <= 8);

    // Dimensions as the picture should APPEAR, i.e. after the outstanding
    // rotation. A portrait phone photo with an outstanding 6 is stored
    // 4000x3000 but must be measured as 3000x4000.
    const shownW = swap ? decoded.height : decoded.width;
    const shownH = swap ? decoded.width : decoded.height;

    if (!shownW || !shownH) {
      throw ImageTool._err(
        'That image could not be read. Please try a different photo.');
    }

    // NEVER UPSCALE. min(..., 1) is the whole rule: a 300 px avatar stays
    // 300 px. Blowing it up to 1024 adds ~10x the bytes and not one pixel of
    // real detail, and on the projector it just looks blurrier.
    const scale = Math.min(maxEdge / Math.max(shownW, shownH), 1);
    const outW = Math.max(1, Math.round(shownW * scale));
    const outH = Math.max(1, Math.round(shownH * scale));

    const wantPng = !!options.keepPng && decoded.type === 'image/png';
    const askMime = wantPng ? 'image/png' : 'image/jpeg';

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      ImageTool._freeCanvas(canvas);
      throw ImageTool._err(
        'This browser could not process the image. Please try another browser.');
    }

    try {
      if (!wantPng) {
        // JPEG has no alpha. Without this, every transparent pixel of a PNG
        // logo comes out BLACK, which is how a club crest ends up as a black
        // box on the projector. Paint white first.
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, outW, outH);
      }

      // Browsers only offer bilinear here, and downscaling a 4000 px photo
      // straight to 320 px with bilinear aliases badly. 'high' asks for the
      // better filter where one exists; it is ignored where it does not.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      ImageTool._applyOrientation(ctx, orientation, outW, outH);

      // In the rotated frame the drawing box is the output box turned back
      // the other way.
      ctx.drawImage(decoded.source, 0, 0, swap ? outH : outW, swap ? outW : outH);

      // toDataURL over toBlob: it is synchronous, which is what lets pair()
      // reuse one decode for both sizes without a second async hop, and we
      // need base64 in the end anyway (CONTRACTS-PHASE1.md §1) so toBlob
      // would only add a FileReader round trip.
      const url = canvas.toDataURL(askMime, quality);
      const split = ImageTool._splitDataUrl(url);

      if (!split.data) {
        throw ImageTool._err(
          'That image could not be prepared for upload. Please try another photo.');
      }

      return {
        data: split.data,                       // base64, NO `data:` prefix
        mime: split.mime,                       // what the canvas ACTUALLY gave us
        filename: ImageTool._outName(
          options.filename || decoded.name || file.name, split.mime),
        width: outW,
        height: outH,
        bytes: ImageTool._base64Bytes(split.data)
      };
    } finally {
      ImageTool._freeCanvas(canvas);
    }
  },

  /**
   * Set the canvas transform for one EXIF orientation.
   *
   * The matrix is expressed in terms of the OUTPUT dimensions, i.e. the size
   * the picture has once it is the right way up.
   *
   *   1  as stored          5  transpose
   *   2  mirrored across    6  quarter turn clockwise
   *   3  half turn          7  transverse
   *   4  mirrored down      8  quarter turn anticlockwise
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} orientation  1..8
   * @param {number} w  output width
   * @param {number} h  output height
   * @return {void}
   */
  _applyOrientation: function (ctx, orientation, w, h) {
    switch (orientation) {
      case 2: ctx.setTransform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.setTransform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.setTransform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.setTransform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.setTransform(0, 1, -1, 0, w, 0); break;
      case 7: ctx.setTransform(0, -1, -1, 0, w, h); break;
      case 8: ctx.setTransform(0, -1, 1, 0, 0, h); break;
      default: ctx.setTransform(1, 0, 0, 1, 0, 0); break;
    }
  },

  /**
   * Drop a canvas's backing store now rather than at the next GC.
   *
   * Setting the dimensions to zero is the only portable way to make a browser
   * release canvas memory. iOS Safari in particular has a total canvas budget
   * for the tab, and a player re-picking a photo five times allocates five
   * full-size canvases. Without this the sixth pick fails with a blank image
   * and no error.
   *
   * @param {HTMLCanvasElement} canvas
   * @return {void}
   */
  _freeCanvas: function (canvas) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) { /* nothing useful to do */ }
  },

  /* ------------------------------------------------------------------ *
   * JPEG header parsing — EXIF orientation and the stored pixel size
   * ------------------------------------------------------------------ */

  /**
   * Read the head of the file and pull out the orientation tag and the
   * stored width/height.
   *
   * Only the first _HEADER_BYTES are read. EXIF lives in the APP1 segment
   * right at the front, and the SOF marker comes before the scan data, so
   * there is never a reason to pull a 4 MB file into an ArrayBuffer.
   *
   * @param {File|Blob} file
   * @return {Promise<{orientation: number, rawWidth: number, rawHeight: number}>}
   *         All zeros/1 when the file is not a parseable JPEG — the callers
   *         treat that as "cannot measure, trust the browser".
   */
  _readHeader: function (file) {
    const none = { orientation: 1, rawWidth: 0, rawHeight: 0 };

    // A PNG cannot carry the EXIF we care about here, so skip the read.
    if (String(file.type || '').toLowerCase() === 'image/png') {
      return Promise.resolve(none);
    }

    const head = (typeof file.slice === 'function')
      ? file.slice(0, ImageTool._HEADER_BYTES)
      : file;

    let read;
    if (typeof head.arrayBuffer === 'function') {
      read = head.arrayBuffer();
    } else if (typeof FileReader === 'function') {
      // Safari 13 and earlier: Blob.arrayBuffer does not exist.
      read = new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsArrayBuffer(head);
      });
    } else {
      return Promise.resolve(none);
    }

    return read
      .then(function (buffer) { return ImageTool.parseJpegHeader(buffer); })
      .catch(function () {
        // A header we cannot read is not a reason to refuse the upload. The
        // dimension cross-check simply falls back to trusting the browser.
        return none;
      });
  },

  /**
   * Pure JPEG header parser. Exposed (not underscored) because it is the one
   * genuinely tricky piece of byte handling here and it is worth testing on
   * its own, in Node, against hand-built buffers.
   *
   * @param {ArrayBuffer} buffer  the first bytes of the file
   * @return {{orientation: number, rawWidth: number, rawHeight: number}}
   *         orientation defaults to 1; rawWidth/rawHeight default to 0 meaning
   *         "not found".
   */
  parseJpegHeader: function (buffer) {
    const result = { orientation: 1, rawWidth: 0, rawHeight: 0 };
    if (!buffer || !buffer.byteLength || buffer.byteLength < 4) return result;

    const view = new DataView(buffer);
    const len = view.byteLength;

    // SOI. Anything else is not a JPEG.
    if (view.getUint16(0, false) !== 0xFFD8) return result;

    let offset = 2;

    while (offset + 4 <= len) {
      // Segments are 0xFF then the marker. Fill bytes (0xFF 0xFF) are legal
      // padding between segments; step over them one at a time.
      if (view.getUint8(offset) !== 0xFF) return result;

      const marker = view.getUint8(offset + 1);

      if (marker === 0xFF) { offset += 1; continue; }

      // Standalone markers carry no length field.
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
        offset += 2;
        continue;
      }

      // Start of scan: image data from here on, nothing left to parse.
      if (marker === 0xDA) return result;

      const size = view.getUint16(offset + 2, false);
      if (size < 2 || offset + 2 + size > len) return result;

      if (marker === 0xE1) {
        // APP1. Ours only if it starts with "Exif\0\0".
        if (offset + 10 <= len &&
            view.getUint32(offset + 4, false) === 0x45786966 &&   // 'Exif'
            view.getUint16(offset + 8, false) === 0x0000) {
          const found = ImageTool._readTiffOrientation(
            view, offset + 10, offset + 2 + size);
          if (found) result.orientation = found;
        }

      } else if (ImageTool._isSofMarker(marker) && offset + 9 <= len) {
        // SOF payload: length(2) precision(1) height(2) width(2) ...
        // These are the STORED dimensions, before any EXIF rotation, which is
        // exactly what _decode cross-checks the decoded size against.
        result.rawHeight = view.getUint16(offset + 5, false);
        result.rawWidth = view.getUint16(offset + 7, false);
        // Orientation always precedes SOF, so both are known now.
        if (result.orientation !== 1) return result;
      }

      offset += 2 + size;
    }

    return result;
  },

  /**
   * True for a Start-Of-Frame marker.
   *
   * 0xC0..0xCF is the SOF block, minus three squatters that share the range:
   * 0xC4 DHT (Huffman table), 0xC8 JPG (reserved), 0xCC DAC (arithmetic
   * coding table). Reading a DHT as a frame header yields garbage dimensions.
   *
   * @param {number} marker
   * @return {boolean}
   */
  _isSofMarker: function (marker) {
    return marker >= 0xC0 && marker <= 0xCF &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
  },

  /**
   * Walk IFD0 of the TIFF block inside an APP1 segment for tag 0x0112.
   *
   * @param {DataView} view
   * @param {number} tiffStart  offset of the TIFF byte-order mark
   * @param {number} limit      one past the last byte of the APP1 segment
   * @return {number} 1..8, or 0 when the tag is absent or unusable
   */
  _readTiffOrientation: function (view, tiffStart, limit) {
    const end = Math.min(limit, view.byteLength);
    if (tiffStart + 8 > end) return 0;

    // 'II' little-endian (Intel) or 'MM' big-endian (Motorola).
    const bom = view.getUint16(tiffStart, false);
    let little;
    if (bom === 0x4949) little = true;
    else if (bom === 0x4D4D) little = false;
    else return 0;

    // The answer to life, the universe, and "is this really TIFF".
    if (view.getUint16(tiffStart + 2, little) !== 42) return 0;

    const ifd0 = view.getUint32(tiffStart + 4, little);
    const dirStart = tiffStart + ifd0;
    if (dirStart + 2 > end) return 0;

    const count = view.getUint16(dirStart, little);
    // A plausible IFD is a few dozen entries. A huge count means we are
    // reading noise, and 12 bytes per entry would walk us off the buffer.
    if (count > 512) return 0;

    for (let i = 0; i < count; i++) {
      const entry = dirStart + 2 + (i * 12);
      if (entry + 12 > end) return 0;

      if (view.getUint16(entry, little) === 0x0112) {
        // SHORT, so the value sits in the first 2 bytes of the value field.
        const value = view.getUint16(entry + 8, little);
        return (value >= 1 && value <= 8) ? value : 0;
      }
    }

    return 0;
  },

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  /**
   * Split "data:image/jpeg;base64,AAAA" into its parts.
   *
   * We take the mime from the string rather than assuming we got what we
   * asked for: a browser that cannot encode the requested type silently
   * returns PNG instead. The server checks the declared mime against the
   * decoded magic number, so declaring image/jpeg over PNG bytes would be
   * rejected on upload.
   *
   * @param {string} url
   * @return {{mime: string, data: string}}  data is '' when unparseable.
   */
  _splitDataUrl: function (url) {
    const s = String(url || '');
    const comma = s.indexOf(',');
    if (s.indexOf('data:') !== 0 || comma === -1) return { mime: '', data: '' };

    const header = s.slice(5, comma);              // "image/jpeg;base64"
    const semi = header.indexOf(';');
    const mime = (semi === -1 ? header : header.slice(0, semi)) || 'image/jpeg';

    // Everything after the comma, and NOTHING before it. The server calls
    // Utilities.base64Decode on this directly (CONTRACTS-PHASE1.md §1), and
    // a leading "data:image/jpeg;base64," would make that throw.
    return { mime: mime, data: s.slice(comma + 1) };
  },

  /**
   * Bytes a base64 string decodes to. 4 characters carry 3 bytes, less the
   * padding. Cheaper and less memory-hungry than actually decoding it.
   * @param {string} b64
   * @return {number}
   */
  _base64Bytes: function (b64) {
    const s = String(b64 || '');
    if (!s.length) return 0;
    let pad = 0;
    if (s.charAt(s.length - 1) === '=') pad++;
    if (s.charAt(s.length - 2) === '=') pad++;
    return Math.max(0, Math.floor(s.length / 4) * 3 - pad);
  },

  /**
   * Strip the extension and anything a filesystem would object to.
   *
   * The name ends up as a Drive filename, so path separators and control
   * characters have to go, and the length has to be sane.
   *
   * @param {string} name
   * @return {string} never empty
   */
  _baseName: function (name) {
    const raw = String(name || '').split(/[\\/]/).pop();
    const stem = raw.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+/, '')
      .replace(/[._-]+$/, '')
      .slice(0, 60)
      .replace(/[._-]+$/, '');
    return safe || 'image';
  },

  /**
   * Final filename with the extension that matches the real output mime.
   * @param {string} name
   * @param {string} mime
   * @return {string}
   */
  _outName: function (name, mime) {
    const ext = (mime === 'image/png') ? '.png'
      : (mime === 'image/webp') ? '.webp'
        : '.jpg';
    return ImageTool._baseName(name) + ext;
  },

  /**
   * @param {*} n
   * @param {number} fallback
   * @return {number} a positive finite number
   */
  _positive: function (n, fallback) {
    const v = Number(n);
    return (isFinite(v) && v > 0) ? v : fallback;
  },

  /**
   * @param {*} q
   * @return {number} 0..1
   */
  _quality: function (q) {
    const v = Number(q);
    if (!isFinite(v) || v <= 0 || v > 1) return ImageTool.QUALITY;
    return v;
  }
};
