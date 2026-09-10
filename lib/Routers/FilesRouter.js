"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RESERVED_DIRECTORY_SEGMENTS = exports.FilesRouter = void 0;
exports.createSizeLimitedStream = createSizeLimitedStream;
var _express = _interopRequireDefault(require("express"));
var Middlewares = _interopRequireWildcard(require("../middlewares"));
var _node = _interopRequireDefault(require("parse/node"));
var _Config = _interopRequireDefault(require("../Config"));
var _logger = _interopRequireDefault(require("../logger"));
var _stream = require("stream");
var _Error = require("../Error");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const triggers = require('../triggers');
const Utils = require('../Utils');
/**
 * Wraps a readable stream in a Readable that enforces a byte size limit.
 * Data flow is lazy: the source is not read until a consumer starts reading
 * from the returned stream (via pipe or 'data' listener). This ensures the
 * consumer's error listener is attached before any data (or error) is emitted.
 */
function createSizeLimitedStream(source, maxBytes) {
  let totalBytes = 0;
  let started = false;
  let sourceEnded = false;
  let onData, onEnd, onError;
  const output = new _stream.Readable({
    read() {
      if (!started) {
        started = true;
        onData = chunk => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            output.destroy(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, `File size exceeds maximum allowed: ${maxBytes} bytes.`));
            return;
          }
          if (!output.push(chunk)) {
            source.pause();
          }
        };
        onEnd = () => {
          sourceEnded = true;
          output.push(null);
        };
        onError = err => output.destroy(err);
        source.on('data', onData);
        source.on('end', onEnd);
        source.on('error', onError);
      }

      // Resume source in case it was paused due to backpressure
      if (!sourceEnded) {
        source.resume();
      }
    },
    destroy(err, callback) {
      if (onData) {
        source.removeListener('data', onData);
      }
      if (onEnd) {
        source.removeListener('end', onEnd);
      }
      if (onError) {
        source.removeListener('error', onError);
      }
      // Suppress errors emitted during drain (e.g. client disconnect)
      source.on('error', () => {});
      if (!sourceEnded) {
        source.resume();
      }
      callback(err);
    }
  });
  return output;
}

// Segments that conflict with sub-routes under GET /files/:appId/*. If a file
// directory starts with one of these, its URL would match the wrong route
// handler. Update this list when adding new sub-routes to expressRouter().
const RESERVED_DIRECTORY_SEGMENTS = exports.RESERVED_DIRECTORY_SEGMENTS = ['metadata'];
class FilesRouter {
  expressRouter({
    maxUploadSize = '20Mb'
  } = {}) {
    var router = _express.default.Router();
    // Lightweight info initializer so handleParseSession can resolve session tokens.
    // Unlike POST/DELETE routes, GET file routes skip handleParseHeaders (which
    // normally sets req.info) because those requests may not carry Parse headers.
    const initInfo = (req, res, next) => {
      if (!req.info) {
        const sessionToken = req.get('X-Parse-Session-Token');
        req.info = {
          sessionToken,
          installationId: req.get('X-Parse-Installation-Id')
        };
        // If no session token and no auth yet (public access), set a minimal
        // auth object so handleParseSession skips session resolution.
        if (!sessionToken && !req.auth) {
          req.auth = {
            isMaster: false
          };
        }
      }
      next();
    };
    // Metadata route must come before the catch-all GET route
    router.get('/files/:appId/metadata/*filepath', initInfo, Middlewares.handleParseSession, this.metadataHandler);
    router.get('/files/:appId/*filepath', initInfo, Middlewares.handleParseSession, this.getHandler);
    router.post('/files', function (req, res, next) {
      next(new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Filename not provided.'));
    });
    router.post('/files/:filename', this._earlyHeadersMiddleware(), this._bodyParsingMiddleware(maxUploadSize), Middlewares.handleParseHeaders, Middlewares.handleParseSession, this.createHandler.bind(this));
    router.delete('/files/*filepath', Middlewares.handleParseHeaders, Middlewares.handleParseSession, Middlewares.enforceMasterKeyAccess, this.deleteHandler);
    return router;
  }
  static _getFilenameFromParams(req) {
    const parts = req.params.filepath;
    return Array.isArray(parts) ? parts.join('/') : parts;
  }
  static validateDirectory(directory) {
    if (typeof directory !== 'string') {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory must be a string.');
    }
    if (directory.length === 0) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory must not be empty.');
    }
    if (directory.length > 256) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory path is too long.');
    }
    if (directory.includes('..')) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory must not contain "..".');
    }
    if (directory.startsWith('/') || directory.endsWith('/')) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory must not start or end with "/".');
    }
    if (directory.includes('//')) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory must not contain consecutive slashes.');
    }
    const firstSegment = directory.split('/')[0];
    if (RESERVED_DIRECTORY_SEGMENTS.includes(firstSegment)) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, `Directory must not start with reserved segment "${firstSegment}".`);
    }
    const dirRegex = /^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/;
    if (!dirRegex.test(directory)) {
      return new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Directory contains invalid characters.');
    }
    return null;
  }
  static _validateFileDownload(req, config) {
    const isMaster = req.auth?.isMaster;
    const isMaintenance = req.auth?.isMaintenance;
    if (isMaster || isMaintenance) {
      return;
    }
    const user = req.auth?.user;
    const isLinked = user && _node.default.AnonymousUtils.isLinked(user);
    if (!config.fileDownload.enableForAnonymousUser && isLinked) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'File download by anonymous user is disabled.');
    }
    if (!config.fileDownload.enableForAuthenticatedUser && !isLinked && user) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'File download by authenticated user is disabled.');
    }
    if (!config.fileDownload.enableForPublic && !user) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'File download by public is disabled.');
    }
  }
  async getHandler(req, res) {
    const config = _Config.default.get(req.params.appId);
    if (!config) {
      const error = (0, _Error.createSanitizedHttpError)(403, 'Invalid application ID.', config);
      res.status(error.status);
      res.json({
        error: error.message
      });
      return;
    }
    FilesRouter._validateFileDownload(req, config);
    let filename = FilesRouter._getFilenameFromParams(req);
    try {
      const filesController = config.filesController;
      const mime = (await import('mime')).default;
      let contentType = mime.getType(filename);
      let file = new _node.default.File(filename, {
        base64: ''
      }, contentType);
      const fileAuth = req.auth;
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeFind, {
        file
      }, config, fileAuth);
      if (triggerResult?.file?._name) {
        filename = triggerResult?.file?._name;
        contentType = mime.getType(filename);
      }
      const defaultResponseHeaders = {
        'X-Content-Type-Options': 'nosniff'
      };
      if (isFileStreamable(req, filesController)) {
        const afterFind = await triggers.maybeRunFileTrigger(triggers.Types.afterFind, {
          file,
          forceDownload: false,
          responseHeaders: {
            ...defaultResponseHeaders
          }
        }, config, fileAuth);
        if (afterFind?.forceDownload) {
          res.set('Content-Disposition', `attachment;filename=${afterFind.file?._name || filename}`);
        }
        for (const [key, value] of Object.entries(afterFind?.responseHeaders ?? defaultResponseHeaders)) {
          res.set(key, value);
        }
        filesController.handleFileStream(config, filename, req, res, contentType).catch(() => {
          res.status(404);
          res.set('Content-Type', 'text/plain');
          res.end('File not found.');
        });
        return;
      }
      let data = await filesController.getFileData(config, filename).catch(() => {
        res.status(404);
        res.set('Content-Type', 'text/plain');
        res.end('File not found.');
      });
      if (!data) {
        return;
      }
      file = new _node.default.File(filename, {
        base64: data.toString('base64')
      }, contentType);
      const afterFind = await triggers.maybeRunFileTrigger(triggers.Types.afterFind, {
        file,
        forceDownload: false,
        responseHeaders: {
          ...defaultResponseHeaders
        }
      }, config, fileAuth);
      if (afterFind?.file) {
        contentType = mime.getType(afterFind.file._name);
        data = Buffer.from(afterFind.file._data, 'base64');
      }
      res.status(200);
      res.set('Content-Type', contentType);
      res.set('Content-Length', data.length);
      if (afterFind.forceDownload) {
        res.set('Content-Disposition', `attachment;filename=${afterFind.file._name}`);
      }
      if (afterFind.responseHeaders) {
        for (const [key, value] of Object.entries(afterFind.responseHeaders)) {
          res.set(key, value);
        }
      }
      res.end(data);
    } catch (e) {
      const err = triggers.resolveError(e, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: `Could not find file: ${filename}.`
      });
      res.status(403);
      res.json({
        code: err.code,
        error: err.message
      });
    }
  }

  /**
   * Middleware that runs before body parsing to handle headers that must be
   * resolved before the request body is consumed. Currently supports:
   *
   * - `X-Parse-File-Max-Upload-Size`: Overrides the server-wide `maxUploadSize`
   *   for this request. Requires the master key. The value uses the same format
   *   as the server option (e.g. `'50mb'`, `'1gb'`). Sets `req._maxUploadSizeOverride`
   *   (in bytes) for `_bodyParsingMiddleware` to use.
   */
  _earlyHeadersMiddleware() {
    return async (req, res, next) => {
      const maxUploadSizeOverride = req.get('X-Parse-File-Max-Upload-Size');
      if (!maxUploadSizeOverride) {
        return next();
      }
      const appId = req.get('X-Parse-Application-Id');
      const config = _Config.default.get(appId);
      if (!config) {
        const error = (0, _Error.createSanitizedHttpError)(403, 'Invalid application ID.', undefined);
        res.status(error.status);
        res.json({
          error: error.message
        });
        return;
      }
      const masterKey = await config.loadMasterKey();
      if (req.get('X-Parse-Master-Key') !== masterKey) {
        const error = (0, _Error.createSanitizedHttpError)(403, 'unauthorized: master key is required', config);
        res.status(error.status);
        res.json({
          error: error.message
        });
        return;
      }
      if (config.masterKeyIps?.length && !Middlewares.checkIp(req.ip, config.masterKeyIps, config.masterKeyIpsStore)) {
        const error = (0, _Error.createSanitizedHttpError)(403, 'unauthorized: master key is required', config);
        res.status(error.status);
        res.json({
          error: error.message
        });
        return;
      }
      let parsedBytes;
      try {
        parsedBytes = Utils.parseSizeToBytes(maxUploadSizeOverride);
      } catch {
        return next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, `Invalid maxUploadSize override value: ${maxUploadSizeOverride}`));
      }
      req._maxUploadSizeOverride = parsedBytes;
      next();
    };
  }
  _bodyParsingMiddleware(maxUploadSize) {
    const defaultMaxBytes = Utils.parseSizeToBytes(maxUploadSize);
    return (req, res, next) => {
      if (req.get('X-Parse-Upload-Mode') === 'stream') {
        req._maxUploadSizeBytes = req._maxUploadSizeOverride ?? defaultMaxBytes;
        return next();
      }
      const limit = req._maxUploadSizeOverride ?? maxUploadSize;
      return _express.default.raw({
        type: () => true,
        limit
      })(req, res, next);
    };
  }
  async createHandler(req, res, next) {
    if (req.auth.isReadOnly) {
      const error = (0, _Error.createSanitizedHttpError)(403, "read-only masterKey isn't allowed to create a file.", req.config);
      res.status(error.status);
      res.end(`{"error":"${error.message}"}`);
      return;
    }
    const config = req.config;
    const isMaster = req.auth.isMaster;
    const isMaintenance = req.auth.isMaintenance;
    if (!isMaster && !isMaintenance) {
      const user = req.auth.user;
      const isLinked = user && _node.default.AnonymousUtils.isLinked(user);
      if (!config.fileUpload.enableForAnonymousUser && isLinked) {
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by anonymous user is disabled.'));
        return;
      }
      if (!config.fileUpload.enableForAuthenticatedUser && !isLinked && user) {
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by authenticated user is disabled.'));
        return;
      }
      if (!config.fileUpload.enableForPublic && !user) {
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by public is disabled.'));
        return;
      }
    }
    const filesController = config.filesController;
    const {
      filename
    } = req.params;
    const contentType = req.get('Content-type');
    const error = filesController.validateFilename(filename);
    if (error) {
      next(error);
      return;
    }
    const fileExtensions = config.fileUpload?.fileExtensions;
    if (!isMaster && fileExtensions) {
      const mime = (await import('mime')).default;
      const isValidExtension = extension => {
        return fileExtensions.some(ext => {
          if (ext === '*') {
            return true;
          }
          const regex = new RegExp(ext);
          if (regex.test(extension)) {
            return true;
          }
        });
      };
      const rejectExtension = ext => {
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, `File upload of extension ${ext} is disabled.`));
      };

      // Parse the filename extension token, stripping MIME parameters and whitespace.
      let extension = Utils.getFileExtension(filename);
      extension = extension?.split(';')[0]?.replace(/\s+/g, '');
      const isExtensionRecognized = extension && mime.getType(filename);
      if (extension && !isValidExtension(extension)) {
        rejectExtension(extension);
        return;
      }

      // When the filename extension is not recognized by `mime`,
      // `FilesController.createFile` cannot derive a Content-Type from the
      // filename and preserves the client-supplied Content-Type verbatim, so the
      // type the file is actually served as must be validated. Skip this when
      // extension filtering is disabled (`*`).
      const allowsAllExtensions = fileExtensions.includes('*');
      if (!isExtensionRecognized && contentType && !allowsAllExtensions) {
        const slashIndex = contentType.indexOf('/');
        const type = slashIndex > 0 ? contentType.slice(0, slashIndex).trim() : '';
        const subtype = slashIndex > 0 ? contentType.slice(slashIndex + 1).split(';')[0].trim() : '';
        // A valid media type is `type/subtype` where both are non-empty `token`s
        // (RFC 9110 §5.6.2). Reject anything else.
        const token = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;
        if (!token.test(type) || !token.test(subtype)) {
          // A Content-Type that does not parse as `type/subtype` with valid,
          // non-empty type AND subtype tokens is malformed: there is no valid MIME
          // type without a subtype (RFC 9110 §8.3.1), and malformed tokens such as
          // `image//svg+xml` or `text/plain,text/html` are equally unparseable.
          // Browsers cannot parse such values and fall back to MIME-sniffing the
          // file body, which can render HTML/script markers as active content on
          // storage adapters that serve the stored Content-Type (e.g. `image`,
          // `image/`). Surface the precise blocklist message when the bare token
          // names a blocked extension (e.g. a no-slash `svg`), otherwise reject the
          // unparseable Content-Type.
          const bareToken = (slashIndex < 0 ? contentType.split(';')[0] : type).replace(/\s+/g, '');
          if (bareToken && !isValidExtension(bareToken)) {
            rejectExtension(bareToken);
            return;
          }
          next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'Invalid Content-Type.'));
          return;
        }
        // Validate the well-formed Content-Type subtype against the blocklist, e.g.
        // "image/svg+xml" -> "svg+xml", "image/svg+xml;charset=utf-8" -> "svg+xml".
        // Valid custom/vendor types (e.g. "application/vnd.api+json") parse and are
        // allowed; only blocked subtypes are rejected.
        const contentTypeExtension = subtype.replace(/\s+/g, '');
        if (!isValidExtension(contentTypeExtension)) {
          rejectExtension(contentTypeExtension);
          return;
        }
      }
    }

    // For streaming uploads, read file data from headers since the body is the raw stream
    if (req.get('X-Parse-Upload-Mode') === 'stream') {
      req.fileData = {};
      if (req.get('X-Parse-File-Directory')) {
        req.fileData.directory = req.get('X-Parse-File-Directory');
      }
      if (req.get('X-Parse-File-Metadata')) {
        try {
          const parsed = JSON.parse(req.get('X-Parse-File-Metadata'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error();
          }
          req.fileData.metadata = parsed;
        } catch {
          next(new _node.default.Error(_node.default.Error.INVALID_JSON, 'Invalid JSON in X-Parse-File-Metadata header.'));
          return;
        }
      }
      if (req.get('X-Parse-File-Tags')) {
        try {
          const parsed = JSON.parse(req.get('X-Parse-File-Tags'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error();
          }
          req.fileData.tags = parsed;
        } catch {
          next(new _node.default.Error(_node.default.Error.INVALID_JSON, 'Invalid JSON in X-Parse-File-Tags header.'));
          return;
        }
      }
    }

    // Validate directory option (requires master key)
    const directory = req.fileData?.directory;
    if (directory !== undefined) {
      if (!isMaster) {
        next(new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'Directory can only be set using the Master Key.'));
        return;
      }
      const directoryError = FilesRouter.validateDirectory(directory);
      if (directoryError) {
        next(directoryError);
        return;
      }
    }

    // Dispatch to the appropriate handler based on whether the body was buffered
    if (Buffer.isBuffer(req.body)) {
      return this._handleBufferedUpload(req, res, next);
    }
    return this._handleStreamUpload(req, res, next);
  }
  async _handleBufferedUpload(req, res, next) {
    const config = req.config;
    const filesController = config.filesController;
    const {
      filename
    } = req.params;
    const contentType = req.get('Content-type');
    if (!req.body || !req.body.length) {
      next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'Invalid file upload.'));
      return;
    }
    const base64 = req.body.toString('base64');
    const file = new _node.default.File(filename, {
      base64
    }, contentType);
    const {
      metadata = {},
      tags = {},
      directory
    } = req.fileData || {};
    try {
      // Scan request data for denied keywords
      Utils.checkProhibitedKeywords(config, metadata);
      Utils.checkProhibitedKeywords(config, tags);
    } catch (error) {
      next(new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, error));
      return;
    }
    file.setTags(tags);
    file.setMetadata(metadata);
    if (directory) {
      file.setDirectory(directory);
    }
    const fileSize = Buffer.byteLength(req.body);
    const fileObject = {
      file,
      fileSize
    };
    try {
      // run beforeSaveFile trigger
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeSave, fileObject, config, req.auth);
      let saveResult;
      // if a new ParseFile is returned check if it's an already saved file
      if (triggerResult instanceof _node.default.File) {
        fileObject.file = triggerResult;
        if (triggerResult.url()) {
          // set fileSize to null because we wont know how big it is here
          fileObject.fileSize = null;
          saveResult = {
            url: triggerResult.url(),
            name: triggerResult._name
          };
        }
      }
      // if the file returned by the trigger has already been saved skip saving anything
      if (!saveResult) {
        // update fileSize
        let bufferData;
        if (fileObject.file._source?.format === 'buffer') {
          bufferData = fileObject.file._source.buffer;
        } else {
          bufferData = Buffer.from(fileObject.file._data, 'base64');
        }
        fileObject.fileSize = Buffer.byteLength(bufferData);
        // prepare file options
        const fileOptions = {
          metadata: fileObject.file._metadata
        };
        // some s3-compatible providers (DigitalOcean, Linode) do not accept tags
        // so we do not include the tags option if it is empty.
        const fileTags = Object.keys(fileObject.file._tags).length > 0 ? {
          tags: fileObject.file._tags
        } : {};
        Object.assign(fileOptions, fileTags);
        // include directory if set (from client request or beforeSaveFile trigger)
        if (fileObject.file._directory) {
          fileOptions.directory = fileObject.file._directory;
        }
        // save file
        const createFileResult = await filesController.createFile(config, fileObject.file._name, bufferData, fileObject.file._source.type, fileOptions);
        // update file with new data
        fileObject.file._name = createFileResult.name;
        fileObject.file._url = createFileResult.url;
        fileObject.file._requestTask = null;
        fileObject.file._previousSave = Promise.resolve(fileObject.file);
        saveResult = {
          url: createFileResult.url,
          name: createFileResult.name
        };
      }
      // run afterSaveFile trigger
      await triggers.maybeRunFileTrigger(triggers.Types.afterSave, fileObject, config, req.auth);
      res.status(201);
      res.set('Location', saveResult.url);
      res.json(saveResult);
    } catch (e) {
      _logger.default.error('Error creating a file: ', e);
      const error = triggers.resolveError(e, {
        code: _node.default.Error.FILE_SAVE_ERROR,
        message: `Could not store file: ${fileObject.file._name}.`
      });
      next(error);
    }
  }
  async _handleStreamUpload(req, res, next) {
    const config = req.config;
    const filesController = config.filesController;
    const {
      filename
    } = req.params;
    let contentType = req.get('Content-Type');
    const maxBytes = req._maxUploadSizeBytes;
    let stream;
    try {
      // Early rejection via Content-Length header
      const contentLength = req.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > maxBytes) {
        req.resume();
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, `File size exceeds maximum allowed: ${maxBytes} bytes.`));
        return;
      }
      const mime = (await import('mime')).default;

      // Infer content type from extension or add extension from content type
      const hasExtension = filename && filename.includes('.');
      if (hasExtension && !contentType) {
        contentType = mime.getType(filename);
      } else if (!hasExtension && contentType) {
        // extension will be added by filesController.createFile
      }

      // Create size-limited stream wrapping the request
      stream = createSizeLimitedStream(req, maxBytes);

      // Build a Parse.File with no _data (streaming mode)
      const file = new _node.default.File(filename, {
        base64: ''
      }, contentType);
      const {
        metadata = {},
        tags = {},
        directory
      } = req.fileData || {};

      // Validate metadata and tags for prohibited keywords
      try {
        Utils.checkProhibitedKeywords(config, metadata);
        Utils.checkProhibitedKeywords(config, tags);
      } catch (error) {
        stream.destroy();
        next(new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, error));
        return;
      }
      file.setTags(tags);
      file.setMetadata(metadata);
      if (directory) {
        file.setDirectory(directory);
      }
      const fileSize = req.get('Content-Length') ? parseInt(req.get('Content-Length'), 10) : null;
      const fileObject = {
        file,
        fileSize,
        stream: true
      };

      // Run beforeSaveFile trigger
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeSave, fileObject, config, req.auth);
      let saveResult;
      // If a new ParseFile is returned, check if it's an already saved file
      if (triggerResult instanceof _node.default.File) {
        fileObject.file = triggerResult;
        if (triggerResult.url()) {
          fileObject.fileSize = null;
          saveResult = {
            url: triggerResult.url(),
            name: triggerResult._name
          };
          // Destroy stream to remove listeners and drain request
          stream.destroy();
        }
      }

      // If the file returned by the trigger has already been saved, skip saving
      if (!saveResult) {
        // Prepare file options
        const fileOptions = {
          metadata: fileObject.file._metadata
        };
        const fileTags = Object.keys(fileObject.file._tags).length > 0 ? {
          tags: fileObject.file._tags
        } : {};
        Object.assign(fileOptions, fileTags);
        // include directory if set (from client request or beforeSaveFile trigger)
        if (fileObject.file._directory) {
          fileOptions.directory = fileObject.file._directory;
        }

        // Pass stream directly to filesController — it will buffer if adapter doesn't support streaming
        const sourceType = fileObject.file._source?.type || contentType;
        const createFileResult = await filesController.createFile(config, fileObject.file._name, stream, sourceType, fileOptions);

        // Update file with new data
        fileObject.file._name = createFileResult.name;
        fileObject.file._url = createFileResult.url;
        fileObject.file._requestTask = null;
        fileObject.file._previousSave = Promise.resolve(fileObject.file);
        saveResult = {
          url: createFileResult.url,
          name: createFileResult.name
        };
      }

      // Run afterSaveFile trigger
      await triggers.maybeRunFileTrigger(triggers.Types.afterSave, fileObject, config, req.auth);
      res.status(201);
      res.set('Location', saveResult.url);
      res.json(saveResult);
    } catch (e) {
      // Destroy stream to remove listeners and drain request, or resume directly
      if (stream) {
        stream.destroy();
      } else {
        req.resume();
      }
      _logger.default.error('Error creating a file: ', e);
      const error = triggers.resolveError(e, {
        code: _node.default.Error.FILE_SAVE_ERROR,
        message: `Could not store file: ${filename}.`
      });
      next(error);
    }
  }
  async deleteHandler(req, res, next) {
    if (req.auth.isReadOnly) {
      const error = (0, _Error.createSanitizedHttpError)(403, "read-only masterKey isn't allowed to delete a file.", req.config);
      res.status(error.status);
      res.end(`{"error":"${error.message}"}`);
      return;
    }
    try {
      const {
        filesController
      } = req.config;
      const filename = FilesRouter._getFilenameFromParams(req);
      // run beforeDeleteFile trigger
      const file = new _node.default.File(filename);
      file._url = await filesController.adapter.getFileLocation(req.config, filename);
      const fileObject = {
        file,
        fileSize: null
      };
      await triggers.maybeRunFileTrigger(triggers.Types.beforeDelete, fileObject, req.config, req.auth);
      // delete file
      await filesController.deleteFile(req.config, filename);
      // run afterDeleteFile trigger
      await triggers.maybeRunFileTrigger(triggers.Types.afterDelete, fileObject, req.config, req.auth);
      res.status(200);
      // TODO: return useful JSON here?
      res.end();
    } catch (e) {
      _logger.default.error('Error deleting a file: ', e);
      const error = triggers.resolveError(e, {
        code: _node.default.Error.FILE_DELETE_ERROR,
        message: 'Could not delete file.'
      });
      next(error);
    }
  }
  async metadataHandler(req, res) {
    try {
      const config = _Config.default.get(req.params.appId);
      if (!config) {
        res.status(200);
        res.json({});
        return;
      }
      FilesRouter._validateFileDownload(req, config);
      const {
        filesController
      } = config;
      let filename = FilesRouter._getFilenameFromParams(req);
      const file = new _node.default.File(filename, {
        base64: ''
      });
      const fileAuth = req.auth;
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeFind, {
        file
      }, config, fileAuth);
      if (triggerResult?.file?._name) {
        filename = triggerResult.file._name;
      }
      const data = await filesController.getMetadata(filename).catch(() => {
        res.status(200);
        res.json({});
      });
      if (!data) {
        return;
      }
      await triggers.maybeRunFileTrigger(triggers.Types.afterFind, {
        file
      }, config, fileAuth);
      res.status(200);
      res.json(data);
    } catch (e) {
      const err = triggers.resolveError(e, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: 'Could not get file metadata.'
      });
      res.status(403);
      res.json({
        code: err.code,
        error: err.message
      });
    }
  }
}
exports.FilesRouter = FilesRouter;
function isFileStreamable(req, filesController) {
  const range = (req.get('Range') || '/-/').split('-');
  const start = Number(range[0]);
  const end = Number(range[1]);
  return (!isNaN(start) || !isNaN(end)) && typeof filesController.adapter.handleFileStream === 'function';
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZXhwcmVzcyIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiTWlkZGxld2FyZXMiLCJfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCIsIl9ub2RlIiwiX0NvbmZpZyIsIl9sb2dnZXIiLCJfc3RyZWFtIiwiX0Vycm9yIiwiZSIsInQiLCJXZWFrTWFwIiwiciIsIm4iLCJfX2VzTW9kdWxlIiwibyIsImkiLCJmIiwiX19wcm90b19fIiwiZGVmYXVsdCIsImhhcyIsImdldCIsInNldCIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk9iamVjdCIsImRlZmluZVByb3BlcnR5IiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yIiwidHJpZ2dlcnMiLCJVdGlscyIsImNyZWF0ZVNpemVMaW1pdGVkU3RyZWFtIiwic291cmNlIiwibWF4Qnl0ZXMiLCJ0b3RhbEJ5dGVzIiwic3RhcnRlZCIsInNvdXJjZUVuZGVkIiwib25EYXRhIiwib25FbmQiLCJvbkVycm9yIiwib3V0cHV0IiwiUmVhZGFibGUiLCJyZWFkIiwiY2h1bmsiLCJsZW5ndGgiLCJkZXN0cm95IiwiUGFyc2UiLCJFcnJvciIsIkZJTEVfU0FWRV9FUlJPUiIsInB1c2giLCJwYXVzZSIsImVyciIsIm9uIiwicmVzdW1lIiwiY2FsbGJhY2siLCJyZW1vdmVMaXN0ZW5lciIsIlJFU0VSVkVEX0RJUkVDVE9SWV9TRUdNRU5UUyIsImV4cG9ydHMiLCJGaWxlc1JvdXRlciIsImV4cHJlc3NSb3V0ZXIiLCJtYXhVcGxvYWRTaXplIiwicm91dGVyIiwiZXhwcmVzcyIsIlJvdXRlciIsImluaXRJbmZvIiwicmVxIiwicmVzIiwibmV4dCIsImluZm8iLCJzZXNzaW9uVG9rZW4iLCJpbnN0YWxsYXRpb25JZCIsImF1dGgiLCJpc01hc3RlciIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsIm1ldGFkYXRhSGFuZGxlciIsImdldEhhbmRsZXIiLCJwb3N0IiwiSU5WQUxJRF9GSUxFX05BTUUiLCJfZWFybHlIZWFkZXJzTWlkZGxld2FyZSIsIl9ib2R5UGFyc2luZ01pZGRsZXdhcmUiLCJoYW5kbGVQYXJzZUhlYWRlcnMiLCJjcmVhdGVIYW5kbGVyIiwiYmluZCIsImRlbGV0ZSIsImVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MiLCJkZWxldGVIYW5kbGVyIiwiX2dldEZpbGVuYW1lRnJvbVBhcmFtcyIsInBhcnRzIiwicGFyYW1zIiwiZmlsZXBhdGgiLCJBcnJheSIsImlzQXJyYXkiLCJqb2luIiwidmFsaWRhdGVEaXJlY3RvcnkiLCJkaXJlY3RvcnkiLCJpbmNsdWRlcyIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsImZpcnN0U2VnbWVudCIsInNwbGl0IiwiZGlyUmVnZXgiLCJ0ZXN0IiwiX3ZhbGlkYXRlRmlsZURvd25sb2FkIiwiY29uZmlnIiwiaXNNYWludGVuYW5jZSIsInVzZXIiLCJpc0xpbmtlZCIsIkFub255bW91c1V0aWxzIiwiZmlsZURvd25sb2FkIiwiZW5hYmxlRm9yQW5vbnltb3VzVXNlciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJlbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciIsImVuYWJsZUZvclB1YmxpYyIsIkNvbmZpZyIsImFwcElkIiwiZXJyb3IiLCJjcmVhdGVTYW5pdGl6ZWRIdHRwRXJyb3IiLCJzdGF0dXMiLCJqc29uIiwibWVzc2FnZSIsImZpbGVuYW1lIiwiZmlsZXNDb250cm9sbGVyIiwibWltZSIsImNvbnRlbnRUeXBlIiwiZ2V0VHlwZSIsImZpbGUiLCJGaWxlIiwiYmFzZTY0IiwiZmlsZUF1dGgiLCJ0cmlnZ2VyUmVzdWx0IiwibWF5YmVSdW5GaWxlVHJpZ2dlciIsIlR5cGVzIiwiYmVmb3JlRmluZCIsIl9uYW1lIiwiZGVmYXVsdFJlc3BvbnNlSGVhZGVycyIsImlzRmlsZVN0cmVhbWFibGUiLCJhZnRlckZpbmQiLCJmb3JjZURvd25sb2FkIiwicmVzcG9uc2VIZWFkZXJzIiwia2V5IiwidmFsdWUiLCJlbnRyaWVzIiwiaGFuZGxlRmlsZVN0cmVhbSIsImNhdGNoIiwiZW5kIiwiZGF0YSIsImdldEZpbGVEYXRhIiwidG9TdHJpbmciLCJCdWZmZXIiLCJmcm9tIiwiX2RhdGEiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiU0NSSVBUX0ZBSUxFRCIsIm1heFVwbG9hZFNpemVPdmVycmlkZSIsInVuZGVmaW5lZCIsIm1hc3RlcktleSIsImxvYWRNYXN0ZXJLZXkiLCJtYXN0ZXJLZXlJcHMiLCJjaGVja0lwIiwiaXAiLCJtYXN0ZXJLZXlJcHNTdG9yZSIsInBhcnNlZEJ5dGVzIiwicGFyc2VTaXplVG9CeXRlcyIsIl9tYXhVcGxvYWRTaXplT3ZlcnJpZGUiLCJkZWZhdWx0TWF4Qnl0ZXMiLCJfbWF4VXBsb2FkU2l6ZUJ5dGVzIiwibGltaXQiLCJyYXciLCJ0eXBlIiwiaXNSZWFkT25seSIsImZpbGVVcGxvYWQiLCJ2YWxpZGF0ZUZpbGVuYW1lIiwiZmlsZUV4dGVuc2lvbnMiLCJpc1ZhbGlkRXh0ZW5zaW9uIiwiZXh0ZW5zaW9uIiwic29tZSIsImV4dCIsInJlZ2V4IiwiUmVnRXhwIiwicmVqZWN0RXh0ZW5zaW9uIiwiZ2V0RmlsZUV4dGVuc2lvbiIsInJlcGxhY2UiLCJpc0V4dGVuc2lvblJlY29nbml6ZWQiLCJhbGxvd3NBbGxFeHRlbnNpb25zIiwic2xhc2hJbmRleCIsImluZGV4T2YiLCJzbGljZSIsInRyaW0iLCJzdWJ0eXBlIiwidG9rZW4iLCJiYXJlVG9rZW4iLCJjb250ZW50VHlwZUV4dGVuc2lvbiIsImZpbGVEYXRhIiwicGFyc2VkIiwiSlNPTiIsInBhcnNlIiwibWV0YWRhdGEiLCJJTlZBTElEX0pTT04iLCJ0YWdzIiwiZGlyZWN0b3J5RXJyb3IiLCJpc0J1ZmZlciIsImJvZHkiLCJfaGFuZGxlQnVmZmVyZWRVcGxvYWQiLCJfaGFuZGxlU3RyZWFtVXBsb2FkIiwiY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMiLCJJTlZBTElEX0tFWV9OQU1FIiwic2V0VGFncyIsInNldE1ldGFkYXRhIiwic2V0RGlyZWN0b3J5IiwiZmlsZVNpemUiLCJieXRlTGVuZ3RoIiwiZmlsZU9iamVjdCIsImJlZm9yZVNhdmUiLCJzYXZlUmVzdWx0IiwidXJsIiwibmFtZSIsImJ1ZmZlckRhdGEiLCJfc291cmNlIiwiZm9ybWF0IiwiYnVmZmVyIiwiZmlsZU9wdGlvbnMiLCJfbWV0YWRhdGEiLCJmaWxlVGFncyIsImtleXMiLCJfdGFncyIsImFzc2lnbiIsIl9kaXJlY3RvcnkiLCJjcmVhdGVGaWxlUmVzdWx0IiwiY3JlYXRlRmlsZSIsIl91cmwiLCJfcmVxdWVzdFRhc2siLCJfcHJldmlvdXNTYXZlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJhZnRlclNhdmUiLCJsb2dnZXIiLCJzdHJlYW0iLCJjb250ZW50TGVuZ3RoIiwicGFyc2VJbnQiLCJoYXNFeHRlbnNpb24iLCJzb3VyY2VUeXBlIiwiYWRhcHRlciIsImdldEZpbGVMb2NhdGlvbiIsImJlZm9yZURlbGV0ZSIsImRlbGV0ZUZpbGUiLCJhZnRlckRlbGV0ZSIsIkZJTEVfREVMRVRFX0VSUk9SIiwiZ2V0TWV0YWRhdGEiLCJyYW5nZSIsInN0YXJ0IiwiTnVtYmVyIiwiaXNOYU4iXSwic291cmNlcyI6WyIuLi8uLi9zcmMvUm91dGVycy9GaWxlc1JvdXRlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZXhwcmVzcyBmcm9tICdleHByZXNzJztcbmltcG9ydCAqIGFzIE1pZGRsZXdhcmVzIGZyb20gJy4uL21pZGRsZXdhcmVzJztcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCBDb25maWcgZnJvbSAnLi4vQ29uZmlnJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmNvbnN0IHRyaWdnZXJzID0gcmVxdWlyZSgnLi4vdHJpZ2dlcnMnKTtcbmNvbnN0IFV0aWxzID0gcmVxdWlyZSgnLi4vVXRpbHMnKTtcbmltcG9ydCB7IFJlYWRhYmxlIH0gZnJvbSAnc3RyZWFtJztcbmltcG9ydCB7IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvciB9IGZyb20gJy4uL0Vycm9yJztcblxuLyoqXG4gKiBXcmFwcyBhIHJlYWRhYmxlIHN0cmVhbSBpbiBhIFJlYWRhYmxlIHRoYXQgZW5mb3JjZXMgYSBieXRlIHNpemUgbGltaXQuXG4gKiBEYXRhIGZsb3cgaXMgbGF6eTogdGhlIHNvdXJjZSBpcyBub3QgcmVhZCB1bnRpbCBhIGNvbnN1bWVyIHN0YXJ0cyByZWFkaW5nXG4gKiBmcm9tIHRoZSByZXR1cm5lZCBzdHJlYW0gKHZpYSBwaXBlIG9yICdkYXRhJyBsaXN0ZW5lcikuIFRoaXMgZW5zdXJlcyB0aGVcbiAqIGNvbnN1bWVyJ3MgZXJyb3IgbGlzdGVuZXIgaXMgYXR0YWNoZWQgYmVmb3JlIGFueSBkYXRhIChvciBlcnJvcikgaXMgZW1pdHRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNpemVMaW1pdGVkU3RyZWFtKHNvdXJjZSwgbWF4Qnl0ZXMpIHtcbiAgbGV0IHRvdGFsQnl0ZXMgPSAwO1xuICBsZXQgc3RhcnRlZCA9IGZhbHNlO1xuICBsZXQgc291cmNlRW5kZWQgPSBmYWxzZTtcbiAgbGV0IG9uRGF0YSwgb25FbmQsIG9uRXJyb3I7XG5cbiAgY29uc3Qgb3V0cHV0ID0gbmV3IFJlYWRhYmxlKHtcbiAgICByZWFkKCkge1xuICAgICAgaWYgKCFzdGFydGVkKSB7XG4gICAgICAgIHN0YXJ0ZWQgPSB0cnVlO1xuXG4gICAgICAgIG9uRGF0YSA9IChjaHVuaykgPT4ge1xuICAgICAgICAgIHRvdGFsQnl0ZXMgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgIGlmICh0b3RhbEJ5dGVzID4gbWF4Qnl0ZXMpIHtcbiAgICAgICAgICAgIG91dHB1dC5kZXN0cm95KFxuICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLFxuICAgICAgICAgICAgICAgIGBGaWxlIHNpemUgZXhjZWVkcyBtYXhpbXVtIGFsbG93ZWQ6ICR7bWF4Qnl0ZXN9IGJ5dGVzLmBcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCFvdXRwdXQucHVzaChjaHVuaykpIHtcbiAgICAgICAgICAgIHNvdXJjZS5wYXVzZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBvbkVuZCA9ICgpID0+IHtcbiAgICAgICAgICBzb3VyY2VFbmRlZCA9IHRydWU7XG4gICAgICAgICAgb3V0cHV0LnB1c2gobnVsbCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgb25FcnJvciA9IChlcnIpID0+IG91dHB1dC5kZXN0cm95KGVycik7XG5cbiAgICAgICAgc291cmNlLm9uKCdkYXRhJywgb25EYXRhKTtcbiAgICAgICAgc291cmNlLm9uKCdlbmQnLCBvbkVuZCk7XG4gICAgICAgIHNvdXJjZS5vbignZXJyb3InLCBvbkVycm9yKTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVzdW1lIHNvdXJjZSBpbiBjYXNlIGl0IHdhcyBwYXVzZWQgZHVlIHRvIGJhY2twcmVzc3VyZVxuICAgICAgaWYgKCFzb3VyY2VFbmRlZCkge1xuICAgICAgICBzb3VyY2UucmVzdW1lKCk7XG4gICAgICB9XG4gICAgfSxcbiAgICBkZXN0cm95KGVyciwgY2FsbGJhY2spIHtcbiAgICAgIGlmIChvbkRhdGEpIHtcbiAgICAgICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdkYXRhJywgb25EYXRhKTtcbiAgICAgIH1cbiAgICAgIGlmIChvbkVuZCkge1xuICAgICAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2VuZCcsIG9uRW5kKTtcbiAgICAgIH1cbiAgICAgIGlmIChvbkVycm9yKSB7XG4gICAgICAgIHNvdXJjZS5yZW1vdmVMaXN0ZW5lcignZXJyb3InLCBvbkVycm9yKTtcbiAgICAgIH1cbiAgICAgIC8vIFN1cHByZXNzIGVycm9ycyBlbWl0dGVkIGR1cmluZyBkcmFpbiAoZS5nLiBjbGllbnQgZGlzY29ubmVjdClcbiAgICAgIHNvdXJjZS5vbignZXJyb3InLCAoKSA9PiB7fSk7XG4gICAgICBpZiAoIXNvdXJjZUVuZGVkKSB7XG4gICAgICAgIHNvdXJjZS5yZXN1bWUoKTtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gb3V0cHV0O1xufVxuXG4vLyBTZWdtZW50cyB0aGF0IGNvbmZsaWN0IHdpdGggc3ViLXJvdXRlcyB1bmRlciBHRVQgL2ZpbGVzLzphcHBJZC8qLiBJZiBhIGZpbGVcbi8vIGRpcmVjdG9yeSBzdGFydHMgd2l0aCBvbmUgb2YgdGhlc2UsIGl0cyBVUkwgd291bGQgbWF0Y2ggdGhlIHdyb25nIHJvdXRlXG4vLyBoYW5kbGVyLiBVcGRhdGUgdGhpcyBsaXN0IHdoZW4gYWRkaW5nIG5ldyBzdWItcm91dGVzIHRvIGV4cHJlc3NSb3V0ZXIoKS5cbmV4cG9ydCBjb25zdCBSRVNFUlZFRF9ESVJFQ1RPUllfU0VHTUVOVFMgPSBbJ21ldGFkYXRhJ107XG5cbmV4cG9ydCBjbGFzcyBGaWxlc1JvdXRlciB7XG4gIGV4cHJlc3NSb3V0ZXIoeyBtYXhVcGxvYWRTaXplID0gJzIwTWInIH0gPSB7fSkge1xuICAgIHZhciByb3V0ZXIgPSBleHByZXNzLlJvdXRlcigpO1xuICAgIC8vIExpZ2h0d2VpZ2h0IGluZm8gaW5pdGlhbGl6ZXIgc28gaGFuZGxlUGFyc2VTZXNzaW9uIGNhbiByZXNvbHZlIHNlc3Npb24gdG9rZW5zLlxuICAgIC8vIFVubGlrZSBQT1NUL0RFTEVURSByb3V0ZXMsIEdFVCBmaWxlIHJvdXRlcyBza2lwIGhhbmRsZVBhcnNlSGVhZGVycyAod2hpY2hcbiAgICAvLyBub3JtYWxseSBzZXRzIHJlcS5pbmZvKSBiZWNhdXNlIHRob3NlIHJlcXVlc3RzIG1heSBub3QgY2FycnkgUGFyc2UgaGVhZGVycy5cbiAgICBjb25zdCBpbml0SW5mbyA9IChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgaWYgKCFyZXEuaW5mbykge1xuICAgICAgICBjb25zdCBzZXNzaW9uVG9rZW4gPSByZXEuZ2V0KCdYLVBhcnNlLVNlc3Npb24tVG9rZW4nKTtcbiAgICAgICAgcmVxLmluZm8gPSB7XG4gICAgICAgICAgc2Vzc2lvblRva2VuLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuZ2V0KCdYLVBhcnNlLUluc3RhbGxhdGlvbi1JZCcpLFxuICAgICAgICB9O1xuICAgICAgICAvLyBJZiBubyBzZXNzaW9uIHRva2VuIGFuZCBubyBhdXRoIHlldCAocHVibGljIGFjY2VzcyksIHNldCBhIG1pbmltYWxcbiAgICAgICAgLy8gYXV0aCBvYmplY3Qgc28gaGFuZGxlUGFyc2VTZXNzaW9uIHNraXBzIHNlc3Npb24gcmVzb2x1dGlvbi5cbiAgICAgICAgaWYgKCFzZXNzaW9uVG9rZW4gJiYgIXJlcS5hdXRoKSB7XG4gICAgICAgICAgcmVxLmF1dGggPSB7IGlzTWFzdGVyOiBmYWxzZSB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgICAvLyBNZXRhZGF0YSByb3V0ZSBtdXN0IGNvbWUgYmVmb3JlIHRoZSBjYXRjaC1hbGwgR0VUIHJvdXRlXG4gICAgcm91dGVyLmdldCgnL2ZpbGVzLzphcHBJZC9tZXRhZGF0YS8qZmlsZXBhdGgnLCBpbml0SW5mbywgTWlkZGxld2FyZXMuaGFuZGxlUGFyc2VTZXNzaW9uLCB0aGlzLm1ldGFkYXRhSGFuZGxlcik7XG4gICAgcm91dGVyLmdldCgnL2ZpbGVzLzphcHBJZC8qZmlsZXBhdGgnLCBpbml0SW5mbywgTWlkZGxld2FyZXMuaGFuZGxlUGFyc2VTZXNzaW9uLCB0aGlzLmdldEhhbmRsZXIpO1xuXG4gICAgcm91dGVyLnBvc3QoJy9maWxlcycsIGZ1bmN0aW9uIChyZXEsIHJlcywgbmV4dCkge1xuICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9GSUxFX05BTUUsICdGaWxlbmFtZSBub3QgcHJvdmlkZWQuJykpO1xuICAgIH0pO1xuXG4gICAgcm91dGVyLnBvc3QoXG4gICAgICAnL2ZpbGVzLzpmaWxlbmFtZScsXG4gICAgICB0aGlzLl9lYXJseUhlYWRlcnNNaWRkbGV3YXJlKCksXG4gICAgICB0aGlzLl9ib2R5UGFyc2luZ01pZGRsZXdhcmUobWF4VXBsb2FkU2l6ZSksXG4gICAgICBNaWRkbGV3YXJlcy5oYW5kbGVQYXJzZUhlYWRlcnMsXG4gICAgICBNaWRkbGV3YXJlcy5oYW5kbGVQYXJzZVNlc3Npb24sXG4gICAgICB0aGlzLmNyZWF0ZUhhbmRsZXIuYmluZCh0aGlzKVxuICAgICk7XG5cbiAgICByb3V0ZXIuZGVsZXRlKFxuICAgICAgJy9maWxlcy8qZmlsZXBhdGgnLFxuICAgICAgTWlkZGxld2FyZXMuaGFuZGxlUGFyc2VIZWFkZXJzLFxuICAgICAgTWlkZGxld2FyZXMuaGFuZGxlUGFyc2VTZXNzaW9uLFxuICAgICAgTWlkZGxld2FyZXMuZW5mb3JjZU1hc3RlcktleUFjY2VzcyxcbiAgICAgIHRoaXMuZGVsZXRlSGFuZGxlclxuICAgICk7XG4gICAgcmV0dXJuIHJvdXRlcjtcbiAgfVxuXG4gIHN0YXRpYyBfZ2V0RmlsZW5hbWVGcm9tUGFyYW1zKHJlcSkge1xuICAgIGNvbnN0IHBhcnRzID0gcmVxLnBhcmFtcy5maWxlcGF0aDtcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShwYXJ0cykgPyBwYXJ0cy5qb2luKCcvJykgOiBwYXJ0cztcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZURpcmVjdG9yeShkaXJlY3RvcnkpIHtcbiAgICBpZiAodHlwZW9mIGRpcmVjdG9yeSAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9GSUxFX05BTUUsICdEaXJlY3RvcnkgbXVzdCBiZSBhIHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKGRpcmVjdG9yeS5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9GSUxFX05BTUUsICdEaXJlY3RvcnkgbXVzdCBub3QgYmUgZW1wdHkuJyk7XG4gICAgfVxuICAgIGlmIChkaXJlY3RvcnkubGVuZ3RoID4gMjU2KSB7XG4gICAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfRklMRV9OQU1FLCAnRGlyZWN0b3J5IHBhdGggaXMgdG9vIGxvbmcuJyk7XG4gICAgfVxuICAgIGlmIChkaXJlY3RvcnkuaW5jbHVkZXMoJy4uJykpIHtcbiAgICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9GSUxFX05BTUUsICdEaXJlY3RvcnkgbXVzdCBub3QgY29udGFpbiBcIi4uXCIuJyk7XG4gICAgfVxuICAgIGlmIChkaXJlY3Rvcnkuc3RhcnRzV2l0aCgnLycpIHx8IGRpcmVjdG9yeS5lbmRzV2l0aCgnLycpKSB7XG4gICAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0ZJTEVfTkFNRSxcbiAgICAgICAgJ0RpcmVjdG9yeSBtdXN0IG5vdCBzdGFydCBvciBlbmQgd2l0aCBcIi9cIi4nXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoZGlyZWN0b3J5LmluY2x1ZGVzKCcvLycpKSB7XG4gICAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0ZJTEVfTkFNRSxcbiAgICAgICAgJ0RpcmVjdG9yeSBtdXN0IG5vdCBjb250YWluIGNvbnNlY3V0aXZlIHNsYXNoZXMuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZmlyc3RTZWdtZW50ID0gZGlyZWN0b3J5LnNwbGl0KCcvJylbMF07XG4gICAgaWYgKFJFU0VSVkVEX0RJUkVDVE9SWV9TRUdNRU5UUy5pbmNsdWRlcyhmaXJzdFNlZ21lbnQpKSB7XG4gICAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0ZJTEVfTkFNRSxcbiAgICAgICAgYERpcmVjdG9yeSBtdXN0IG5vdCBzdGFydCB3aXRoIHJlc2VydmVkIHNlZ21lbnQgXCIke2ZpcnN0U2VnbWVudH1cIi5gXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBkaXJSZWdleCA9IC9eW2EtekEtWjAtOV1bYS16QS1aMC05X1xcLS9dKiQvO1xuICAgIGlmICghZGlyUmVnZXgudGVzdChkaXJlY3RvcnkpKSB7XG4gICAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0ZJTEVfTkFNRSxcbiAgICAgICAgJ0RpcmVjdG9yeSBjb250YWlucyBpbnZhbGlkIGNoYXJhY3RlcnMuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBzdGF0aWMgX3ZhbGlkYXRlRmlsZURvd25sb2FkKHJlcSwgY29uZmlnKSB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSByZXEuYXV0aD8uaXNNYXN0ZXI7XG4gICAgY29uc3QgaXNNYWludGVuYW5jZSA9IHJlcS5hdXRoPy5pc01haW50ZW5hbmNlO1xuICAgIGlmIChpc01hc3RlciB8fCBpc01haW50ZW5hbmNlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHVzZXIgPSByZXEuYXV0aD8udXNlcjtcbiAgICBjb25zdCBpc0xpbmtlZCA9IHVzZXIgJiYgUGFyc2UuQW5vbnltb3VzVXRpbHMuaXNMaW5rZWQodXNlcik7XG4gICAgaWYgKCFjb25maWcuZmlsZURvd25sb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgJiYgaXNMaW5rZWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgJ0ZpbGUgZG93bmxvYWQgYnkgYW5vbnltb3VzIHVzZXIgaXMgZGlzYWJsZWQuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFjb25maWcuZmlsZURvd25sb2FkLmVuYWJsZUZvckF1dGhlbnRpY2F0ZWRVc2VyICYmICFpc0xpbmtlZCAmJiB1c2VyKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICdGaWxlIGRvd25sb2FkIGJ5IGF1dGhlbnRpY2F0ZWQgdXNlciBpcyBkaXNhYmxlZC4nXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIWNvbmZpZy5maWxlRG93bmxvYWQuZW5hYmxlRm9yUHVibGljICYmICF1c2VyKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICdGaWxlIGRvd25sb2FkIGJ5IHB1YmxpYyBpcyBkaXNhYmxlZC4nXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGdldEhhbmRsZXIocmVxLCByZXMpIHtcbiAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KHJlcS5wYXJhbXMuYXBwSWQpO1xuICAgIGlmICghY29uZmlnKSB7XG4gICAgICBjb25zdCBlcnJvciA9IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICdJbnZhbGlkIGFwcGxpY2F0aW9uIElELicsIGNvbmZpZyk7XG4gICAgICByZXMuc3RhdHVzKGVycm9yLnN0YXR1cyk7XG4gICAgICByZXMuanNvbih7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIEZpbGVzUm91dGVyLl92YWxpZGF0ZUZpbGVEb3dubG9hZChyZXEsIGNvbmZpZyk7XG5cbiAgICBsZXQgZmlsZW5hbWUgPSBGaWxlc1JvdXRlci5fZ2V0RmlsZW5hbWVGcm9tUGFyYW1zKHJlcSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGVzQ29udHJvbGxlciA9IGNvbmZpZy5maWxlc0NvbnRyb2xsZXI7XG4gICAgICBjb25zdCBtaW1lID0gKGF3YWl0IGltcG9ydCgnbWltZScpKS5kZWZhdWx0O1xuICAgICAgbGV0IGNvbnRlbnRUeXBlID0gbWltZS5nZXRUeXBlKGZpbGVuYW1lKTtcbiAgICAgIGxldCBmaWxlID0gbmV3IFBhcnNlLkZpbGUoZmlsZW5hbWUsIHsgYmFzZTY0OiAnJyB9LCBjb250ZW50VHlwZSk7XG4gICAgICBjb25zdCBmaWxlQXV0aCA9IHJlcS5hdXRoO1xuICAgICAgY29uc3QgdHJpZ2dlclJlc3VsdCA9IGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUZpbmQsXG4gICAgICAgIHsgZmlsZSB9LFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGZpbGVBdXRoXG4gICAgICApO1xuICAgICAgaWYgKHRyaWdnZXJSZXN1bHQ/LmZpbGU/Ll9uYW1lKSB7XG4gICAgICAgIGZpbGVuYW1lID0gdHJpZ2dlclJlc3VsdD8uZmlsZT8uX25hbWU7XG4gICAgICAgIGNvbnRlbnRUeXBlID0gbWltZS5nZXRUeXBlKGZpbGVuYW1lKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGVmYXVsdFJlc3BvbnNlSGVhZGVycyA9IHsgJ1gtQ29udGVudC1UeXBlLU9wdGlvbnMnOiAnbm9zbmlmZicgfTtcblxuICAgICAgaWYgKGlzRmlsZVN0cmVhbWFibGUocmVxLCBmaWxlc0NvbnRyb2xsZXIpKSB7XG4gICAgICAgIGNvbnN0IGFmdGVyRmluZCA9IGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgICAgICAgIHsgZmlsZSwgZm9yY2VEb3dubG9hZDogZmFsc2UsIHJlc3BvbnNlSGVhZGVyczogeyAuLi5kZWZhdWx0UmVzcG9uc2VIZWFkZXJzIH0gfSxcbiAgICAgICAgICBjb25maWcsXG4gICAgICAgICAgZmlsZUF1dGhcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGFmdGVyRmluZD8uZm9yY2VEb3dubG9hZCkge1xuICAgICAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtRGlzcG9zaXRpb24nLCBgYXR0YWNobWVudDtmaWxlbmFtZT0ke2FmdGVyRmluZC5maWxlPy5fbmFtZSB8fCBmaWxlbmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhhZnRlckZpbmQ/LnJlc3BvbnNlSGVhZGVycyA/PyBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzKSkge1xuICAgICAgICAgIHJlcy5zZXQoa2V5LCB2YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgZmlsZXNDb250cm9sbGVyLmhhbmRsZUZpbGVTdHJlYW0oY29uZmlnLCBmaWxlbmFtZSwgcmVxLCByZXMsIGNvbnRlbnRUeXBlKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgcmVzLnN0YXR1cyg0MDQpO1xuICAgICAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtVHlwZScsICd0ZXh0L3BsYWluJyk7XG4gICAgICAgICAgcmVzLmVuZCgnRmlsZSBub3QgZm91bmQuJyk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGxldCBkYXRhID0gYXdhaXQgZmlsZXNDb250cm9sbGVyLmdldEZpbGVEYXRhKGNvbmZpZywgZmlsZW5hbWUpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgcmVzLnN0YXR1cyg0MDQpO1xuICAgICAgICByZXMuc2V0KCdDb250ZW50LVR5cGUnLCAndGV4dC9wbGFpbicpO1xuICAgICAgICByZXMuZW5kKCdGaWxlIG5vdCBmb3VuZC4nKTtcbiAgICAgIH0pO1xuICAgICAgaWYgKCFkYXRhKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGZpbGUgPSBuZXcgUGFyc2UuRmlsZShmaWxlbmFtZSwgeyBiYXNlNjQ6IGRhdGEudG9TdHJpbmcoJ2Jhc2U2NCcpIH0sIGNvbnRlbnRUeXBlKTtcbiAgICAgIGNvbnN0IGFmdGVyRmluZCA9IGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCxcbiAgICAgICAgeyBmaWxlLCBmb3JjZURvd25sb2FkOiBmYWxzZSwgcmVzcG9uc2VIZWFkZXJzOiB7IC4uLmRlZmF1bHRSZXNwb25zZUhlYWRlcnMgfSB9LFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGZpbGVBdXRoXG4gICAgICApO1xuXG4gICAgICBpZiAoYWZ0ZXJGaW5kPy5maWxlKSB7XG4gICAgICAgIGNvbnRlbnRUeXBlID0gbWltZS5nZXRUeXBlKGFmdGVyRmluZC5maWxlLl9uYW1lKTtcbiAgICAgICAgZGF0YSA9IEJ1ZmZlci5mcm9tKGFmdGVyRmluZC5maWxlLl9kYXRhLCAnYmFzZTY0Jyk7XG4gICAgICB9XG5cbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtVHlwZScsIGNvbnRlbnRUeXBlKTtcbiAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtTGVuZ3RoJywgZGF0YS5sZW5ndGgpO1xuICAgICAgaWYgKGFmdGVyRmluZC5mb3JjZURvd25sb2FkKSB7XG4gICAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtRGlzcG9zaXRpb24nLCBgYXR0YWNobWVudDtmaWxlbmFtZT0ke2FmdGVyRmluZC5maWxlLl9uYW1lfWApO1xuICAgICAgfVxuICAgICAgaWYgKGFmdGVyRmluZC5yZXNwb25zZUhlYWRlcnMpIHtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoYWZ0ZXJGaW5kLnJlc3BvbnNlSGVhZGVycykpIHtcbiAgICAgICAgICByZXMuc2V0KGtleSwgdmFsdWUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXMuZW5kKGRhdGEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IHRyaWdnZXJzLnJlc29sdmVFcnJvcihlLCB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgIG1lc3NhZ2U6IGBDb3VsZCBub3QgZmluZCBmaWxlOiAke2ZpbGVuYW1lfS5gLFxuICAgICAgfSk7XG4gICAgICByZXMuc3RhdHVzKDQwMyk7XG4gICAgICByZXMuanNvbih7IGNvZGU6IGVyci5jb2RlLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIE1pZGRsZXdhcmUgdGhhdCBydW5zIGJlZm9yZSBib2R5IHBhcnNpbmcgdG8gaGFuZGxlIGhlYWRlcnMgdGhhdCBtdXN0IGJlXG4gICAqIHJlc29sdmVkIGJlZm9yZSB0aGUgcmVxdWVzdCBib2R5IGlzIGNvbnN1bWVkLiBDdXJyZW50bHkgc3VwcG9ydHM6XG4gICAqXG4gICAqIC0gYFgtUGFyc2UtRmlsZS1NYXgtVXBsb2FkLVNpemVgOiBPdmVycmlkZXMgdGhlIHNlcnZlci13aWRlIGBtYXhVcGxvYWRTaXplYFxuICAgKiAgIGZvciB0aGlzIHJlcXVlc3QuIFJlcXVpcmVzIHRoZSBtYXN0ZXIga2V5LiBUaGUgdmFsdWUgdXNlcyB0aGUgc2FtZSBmb3JtYXRcbiAgICogICBhcyB0aGUgc2VydmVyIG9wdGlvbiAoZS5nLiBgJzUwbWInYCwgYCcxZ2InYCkuIFNldHMgYHJlcS5fbWF4VXBsb2FkU2l6ZU92ZXJyaWRlYFxuICAgKiAgIChpbiBieXRlcykgZm9yIGBfYm9keVBhcnNpbmdNaWRkbGV3YXJlYCB0byB1c2UuXG4gICAqL1xuICBfZWFybHlIZWFkZXJzTWlkZGxld2FyZSgpIHtcbiAgICByZXR1cm4gYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICBjb25zdCBtYXhVcGxvYWRTaXplT3ZlcnJpZGUgPSByZXEuZ2V0KCdYLVBhcnNlLUZpbGUtTWF4LVVwbG9hZC1TaXplJyk7XG4gICAgICBpZiAoIW1heFVwbG9hZFNpemVPdmVycmlkZSkge1xuICAgICAgICByZXR1cm4gbmV4dCgpO1xuICAgICAgfVxuICAgICAgY29uc3QgYXBwSWQgPSByZXEuZ2V0KCdYLVBhcnNlLUFwcGxpY2F0aW9uLUlkJyk7XG4gICAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGFwcElkKTtcbiAgICAgIGlmICghY29uZmlnKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gY3JlYXRlU2FuaXRpemVkSHR0cEVycm9yKDQwMywgJ0ludmFsaWQgYXBwbGljYXRpb24gSUQuJywgdW5kZWZpbmVkKTtcbiAgICAgICAgcmVzLnN0YXR1cyhlcnJvci5zdGF0dXMpO1xuICAgICAgICByZXMuanNvbih7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCBtYXN0ZXJLZXkgPSBhd2FpdCBjb25maWcubG9hZE1hc3RlcktleSgpO1xuICAgICAgaWYgKHJlcS5nZXQoJ1gtUGFyc2UtTWFzdGVyLUtleScpICE9PSBtYXN0ZXJLZXkpIHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSBjcmVhdGVTYW5pdGl6ZWRIdHRwRXJyb3IoNDAzLCAndW5hdXRob3JpemVkOiBtYXN0ZXIga2V5IGlzIHJlcXVpcmVkJywgY29uZmlnKTtcbiAgICAgICAgcmVzLnN0YXR1cyhlcnJvci5zdGF0dXMpO1xuICAgICAgICByZXMuanNvbih7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAoY29uZmlnLm1hc3RlcktleUlwcz8ubGVuZ3RoICYmICFNaWRkbGV3YXJlcy5jaGVja0lwKHJlcS5pcCwgY29uZmlnLm1hc3RlcktleUlwcywgY29uZmlnLm1hc3RlcktleUlwc1N0b3JlKSkge1xuICAgICAgICBjb25zdCBlcnJvciA9IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICd1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWQnLCBjb25maWcpO1xuICAgICAgICByZXMuc3RhdHVzKGVycm9yLnN0YXR1cyk7XG4gICAgICAgIHJlcy5qc29uKHsgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGxldCBwYXJzZWRCeXRlcztcbiAgICAgIHRyeSB7XG4gICAgICAgIHBhcnNlZEJ5dGVzID0gVXRpbHMucGFyc2VTaXplVG9CeXRlcyhtYXhVcGxvYWRTaXplT3ZlcnJpZGUpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBuZXh0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkZJTEVfU0FWRV9FUlJPUixcbiAgICAgICAgICAgIGBJbnZhbGlkIG1heFVwbG9hZFNpemUgb3ZlcnJpZGUgdmFsdWU6ICR7bWF4VXBsb2FkU2l6ZU92ZXJyaWRlfWBcbiAgICAgICAgICApXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXEuX21heFVwbG9hZFNpemVPdmVycmlkZSA9IHBhcnNlZEJ5dGVzO1xuICAgICAgbmV4dCgpO1xuICAgIH07XG4gIH1cblxuICBfYm9keVBhcnNpbmdNaWRkbGV3YXJlKG1heFVwbG9hZFNpemUpIHtcbiAgICBjb25zdCBkZWZhdWx0TWF4Qnl0ZXMgPSBVdGlscy5wYXJzZVNpemVUb0J5dGVzKG1heFVwbG9hZFNpemUpO1xuICAgIHJldHVybiAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgICAgIGlmIChyZXEuZ2V0KCdYLVBhcnNlLVVwbG9hZC1Nb2RlJykgPT09ICdzdHJlYW0nKSB7XG4gICAgICAgIHJlcS5fbWF4VXBsb2FkU2l6ZUJ5dGVzID0gcmVxLl9tYXhVcGxvYWRTaXplT3ZlcnJpZGUgPz8gZGVmYXVsdE1heEJ5dGVzO1xuICAgICAgICByZXR1cm4gbmV4dCgpO1xuICAgICAgfVxuICAgICAgY29uc3QgbGltaXQgPSByZXEuX21heFVwbG9hZFNpemVPdmVycmlkZSA/PyBtYXhVcGxvYWRTaXplO1xuICAgICAgcmV0dXJuIGV4cHJlc3MucmF3KHsgdHlwZTogKCkgPT4gdHJ1ZSwgbGltaXQgfSkocmVxLCByZXMsIG5leHQpO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBjcmVhdGVIYW5kbGVyKHJlcSwgcmVzLCBuZXh0KSB7XG4gICAgaWYgKHJlcS5hdXRoLmlzUmVhZE9ubHkpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gY3JlYXRlU2FuaXRpemVkSHR0cEVycm9yKDQwMywgXCJyZWFkLW9ubHkgbWFzdGVyS2V5IGlzbid0IGFsbG93ZWQgdG8gY3JlYXRlIGEgZmlsZS5cIiwgcmVxLmNvbmZpZyk7XG4gICAgICByZXMuc3RhdHVzKGVycm9yLnN0YXR1cyk7XG4gICAgICByZXMuZW5kKGB7XCJlcnJvclwiOlwiJHtlcnJvci5tZXNzYWdlfVwifWApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjb25maWcgPSByZXEuY29uZmlnO1xuICAgIGNvbnN0IGlzTWFzdGVyID0gcmVxLmF1dGguaXNNYXN0ZXI7XG4gICAgY29uc3QgaXNNYWludGVuYW5jZSA9IHJlcS5hdXRoLmlzTWFpbnRlbmFuY2U7XG4gICAgaWYgKCFpc01hc3RlciAmJiAhaXNNYWludGVuYW5jZSkge1xuICAgICAgY29uc3QgdXNlciA9IHJlcS5hdXRoLnVzZXI7XG4gICAgICBjb25zdCBpc0xpbmtlZCA9IHVzZXIgJiYgUGFyc2UuQW5vbnltb3VzVXRpbHMuaXNMaW5rZWQodXNlcik7XG4gICAgICBpZiAoIWNvbmZpZy5maWxlVXBsb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgJiYgaXNMaW5rZWQpIHtcbiAgICAgICAgbmV4dChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCAnRmlsZSB1cGxvYWQgYnkgYW5vbnltb3VzIHVzZXIgaXMgZGlzYWJsZWQuJylcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKCFjb25maWcuZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciAmJiAhaXNMaW5rZWQgJiYgdXNlcikge1xuICAgICAgICBuZXh0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkZJTEVfU0FWRV9FUlJPUixcbiAgICAgICAgICAgICdGaWxlIHVwbG9hZCBieSBhdXRoZW50aWNhdGVkIHVzZXIgaXMgZGlzYWJsZWQuJ1xuICAgICAgICAgIClcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKCFjb25maWcuZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgJiYgIXVzZXIpIHtcbiAgICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCAnRmlsZSB1cGxvYWQgYnkgcHVibGljIGlzIGRpc2FibGVkLicpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBmaWxlc0NvbnRyb2xsZXIgPSBjb25maWcuZmlsZXNDb250cm9sbGVyO1xuICAgIGNvbnN0IHsgZmlsZW5hbWUgfSA9IHJlcS5wYXJhbXM7XG4gICAgY29uc3QgY29udGVudFR5cGUgPSByZXEuZ2V0KCdDb250ZW50LXR5cGUnKTtcblxuICAgIGNvbnN0IGVycm9yID0gZmlsZXNDb250cm9sbGVyLnZhbGlkYXRlRmlsZW5hbWUoZmlsZW5hbWUpO1xuICAgIGlmIChlcnJvcikge1xuICAgICAgbmV4dChlcnJvcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmlsZUV4dGVuc2lvbnMgPSBjb25maWcuZmlsZVVwbG9hZD8uZmlsZUV4dGVuc2lvbnM7XG4gICAgaWYgKCFpc01hc3RlciAmJiBmaWxlRXh0ZW5zaW9ucykge1xuICAgICAgY29uc3QgbWltZSA9IChhd2FpdCBpbXBvcnQoJ21pbWUnKSkuZGVmYXVsdDtcbiAgICAgIGNvbnN0IGlzVmFsaWRFeHRlbnNpb24gPSBleHRlbnNpb24gPT4ge1xuICAgICAgICByZXR1cm4gZmlsZUV4dGVuc2lvbnMuc29tZShleHQgPT4ge1xuICAgICAgICAgIGlmIChleHQgPT09ICcqJykge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHJlZ2V4ID0gbmV3IFJlZ0V4cChleHQpO1xuICAgICAgICAgIGlmIChyZWdleC50ZXN0KGV4dGVuc2lvbikpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9O1xuICAgICAgY29uc3QgcmVqZWN0RXh0ZW5zaW9uID0gZXh0ID0+IHtcbiAgICAgICAgbmV4dChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5GSUxFX1NBVkVfRVJST1IsXG4gICAgICAgICAgICBgRmlsZSB1cGxvYWQgb2YgZXh0ZW5zaW9uICR7ZXh0fSBpcyBkaXNhYmxlZC5gXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgfTtcblxuICAgICAgLy8gUGFyc2UgdGhlIGZpbGVuYW1lIGV4dGVuc2lvbiB0b2tlbiwgc3RyaXBwaW5nIE1JTUUgcGFyYW1ldGVycyBhbmQgd2hpdGVzcGFjZS5cbiAgICAgIGxldCBleHRlbnNpb24gPSBVdGlscy5nZXRGaWxlRXh0ZW5zaW9uKGZpbGVuYW1lKTtcbiAgICAgIGV4dGVuc2lvbiA9IGV4dGVuc2lvbj8uc3BsaXQoJzsnKVswXT8ucmVwbGFjZSgvXFxzKy9nLCAnJyk7XG5cbiAgICAgIGNvbnN0IGlzRXh0ZW5zaW9uUmVjb2duaXplZCA9IGV4dGVuc2lvbiAmJiBtaW1lLmdldFR5cGUoZmlsZW5hbWUpO1xuICAgICAgaWYgKGV4dGVuc2lvbiAmJiAhaXNWYWxpZEV4dGVuc2lvbihleHRlbnNpb24pKSB7XG4gICAgICAgIHJlamVjdEV4dGVuc2lvbihleHRlbnNpb24pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIFdoZW4gdGhlIGZpbGVuYW1lIGV4dGVuc2lvbiBpcyBub3QgcmVjb2duaXplZCBieSBgbWltZWAsXG4gICAgICAvLyBgRmlsZXNDb250cm9sbGVyLmNyZWF0ZUZpbGVgIGNhbm5vdCBkZXJpdmUgYSBDb250ZW50LVR5cGUgZnJvbSB0aGVcbiAgICAgIC8vIGZpbGVuYW1lIGFuZCBwcmVzZXJ2ZXMgdGhlIGNsaWVudC1zdXBwbGllZCBDb250ZW50LVR5cGUgdmVyYmF0aW0sIHNvIHRoZVxuICAgICAgLy8gdHlwZSB0aGUgZmlsZSBpcyBhY3R1YWxseSBzZXJ2ZWQgYXMgbXVzdCBiZSB2YWxpZGF0ZWQuIFNraXAgdGhpcyB3aGVuXG4gICAgICAvLyBleHRlbnNpb24gZmlsdGVyaW5nIGlzIGRpc2FibGVkIChgKmApLlxuICAgICAgY29uc3QgYWxsb3dzQWxsRXh0ZW5zaW9ucyA9IGZpbGVFeHRlbnNpb25zLmluY2x1ZGVzKCcqJyk7XG4gICAgICBpZiAoIWlzRXh0ZW5zaW9uUmVjb2duaXplZCAmJiBjb250ZW50VHlwZSAmJiAhYWxsb3dzQWxsRXh0ZW5zaW9ucykge1xuICAgICAgICBjb25zdCBzbGFzaEluZGV4ID0gY29udGVudFR5cGUuaW5kZXhPZignLycpO1xuICAgICAgICBjb25zdCB0eXBlID0gc2xhc2hJbmRleCA+IDAgPyBjb250ZW50VHlwZS5zbGljZSgwLCBzbGFzaEluZGV4KS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3Qgc3VidHlwZSA9XG4gICAgICAgICAgc2xhc2hJbmRleCA+IDAgPyBjb250ZW50VHlwZS5zbGljZShzbGFzaEluZGV4ICsgMSkuc3BsaXQoJzsnKVswXS50cmltKCkgOiAnJztcbiAgICAgICAgLy8gQSB2YWxpZCBtZWRpYSB0eXBlIGlzIGB0eXBlL3N1YnR5cGVgIHdoZXJlIGJvdGggYXJlIG5vbi1lbXB0eSBgdG9rZW5gc1xuICAgICAgICAvLyAoUkZDIDkxMTAgwqc1LjYuMikuIFJlamVjdCBhbnl0aGluZyBlbHNlLlxuICAgICAgICBjb25zdCB0b2tlbiA9IC9eWyEjJCUmJyorXFwtLl5fYHx+QS1aYS16MC05XSskLztcbiAgICAgICAgaWYgKCF0b2tlbi50ZXN0KHR5cGUpIHx8ICF0b2tlbi50ZXN0KHN1YnR5cGUpKSB7XG4gICAgICAgICAgLy8gQSBDb250ZW50LVR5cGUgdGhhdCBkb2VzIG5vdCBwYXJzZSBhcyBgdHlwZS9zdWJ0eXBlYCB3aXRoIHZhbGlkLFxuICAgICAgICAgIC8vIG5vbi1lbXB0eSB0eXBlIEFORCBzdWJ0eXBlIHRva2VucyBpcyBtYWxmb3JtZWQ6IHRoZXJlIGlzIG5vIHZhbGlkIE1JTUVcbiAgICAgICAgICAvLyB0eXBlIHdpdGhvdXQgYSBzdWJ0eXBlIChSRkMgOTExMCDCpzguMy4xKSwgYW5kIG1hbGZvcm1lZCB0b2tlbnMgc3VjaCBhc1xuICAgICAgICAgIC8vIGBpbWFnZS8vc3ZnK3htbGAgb3IgYHRleHQvcGxhaW4sdGV4dC9odG1sYCBhcmUgZXF1YWxseSB1bnBhcnNlYWJsZS5cbiAgICAgICAgICAvLyBCcm93c2VycyBjYW5ub3QgcGFyc2Ugc3VjaCB2YWx1ZXMgYW5kIGZhbGwgYmFjayB0byBNSU1FLXNuaWZmaW5nIHRoZVxuICAgICAgICAgIC8vIGZpbGUgYm9keSwgd2hpY2ggY2FuIHJlbmRlciBIVE1ML3NjcmlwdCBtYXJrZXJzIGFzIGFjdGl2ZSBjb250ZW50IG9uXG4gICAgICAgICAgLy8gc3RvcmFnZSBhZGFwdGVycyB0aGF0IHNlcnZlIHRoZSBzdG9yZWQgQ29udGVudC1UeXBlIChlLmcuIGBpbWFnZWAsXG4gICAgICAgICAgLy8gYGltYWdlL2ApLiBTdXJmYWNlIHRoZSBwcmVjaXNlIGJsb2NrbGlzdCBtZXNzYWdlIHdoZW4gdGhlIGJhcmUgdG9rZW5cbiAgICAgICAgICAvLyBuYW1lcyBhIGJsb2NrZWQgZXh0ZW5zaW9uIChlLmcuIGEgbm8tc2xhc2ggYHN2Z2ApLCBvdGhlcndpc2UgcmVqZWN0IHRoZVxuICAgICAgICAgIC8vIHVucGFyc2VhYmxlIENvbnRlbnQtVHlwZS5cbiAgICAgICAgICBjb25zdCBiYXJlVG9rZW4gPSAoc2xhc2hJbmRleCA8IDAgPyBjb250ZW50VHlwZS5zcGxpdCgnOycpWzBdIDogdHlwZSkucmVwbGFjZShcbiAgICAgICAgICAgIC9cXHMrL2csXG4gICAgICAgICAgICAnJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKGJhcmVUb2tlbiAmJiAhaXNWYWxpZEV4dGVuc2lvbihiYXJlVG9rZW4pKSB7XG4gICAgICAgICAgICByZWplY3RFeHRlbnNpb24oYmFyZVRva2VuKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCAnSW52YWxpZCBDb250ZW50LVR5cGUuJykpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyBWYWxpZGF0ZSB0aGUgd2VsbC1mb3JtZWQgQ29udGVudC1UeXBlIHN1YnR5cGUgYWdhaW5zdCB0aGUgYmxvY2tsaXN0LCBlLmcuXG4gICAgICAgIC8vIFwiaW1hZ2Uvc3ZnK3htbFwiIC0+IFwic3ZnK3htbFwiLCBcImltYWdlL3N2Zyt4bWw7Y2hhcnNldD11dGYtOFwiIC0+IFwic3ZnK3htbFwiLlxuICAgICAgICAvLyBWYWxpZCBjdXN0b20vdmVuZG9yIHR5cGVzIChlLmcuIFwiYXBwbGljYXRpb24vdm5kLmFwaStqc29uXCIpIHBhcnNlIGFuZCBhcmVcbiAgICAgICAgLy8gYWxsb3dlZDsgb25seSBibG9ja2VkIHN1YnR5cGVzIGFyZSByZWplY3RlZC5cbiAgICAgICAgY29uc3QgY29udGVudFR5cGVFeHRlbnNpb24gPSBzdWJ0eXBlLnJlcGxhY2UoL1xccysvZywgJycpO1xuICAgICAgICBpZiAoIWlzVmFsaWRFeHRlbnNpb24oY29udGVudFR5cGVFeHRlbnNpb24pKSB7XG4gICAgICAgICAgcmVqZWN0RXh0ZW5zaW9uKGNvbnRlbnRUeXBlRXh0ZW5zaW9uKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGb3Igc3RyZWFtaW5nIHVwbG9hZHMsIHJlYWQgZmlsZSBkYXRhIGZyb20gaGVhZGVycyBzaW5jZSB0aGUgYm9keSBpcyB0aGUgcmF3IHN0cmVhbVxuICAgIGlmIChyZXEuZ2V0KCdYLVBhcnNlLVVwbG9hZC1Nb2RlJykgPT09ICdzdHJlYW0nKSB7XG4gICAgICByZXEuZmlsZURhdGEgPSB7fTtcbiAgICAgIGlmIChyZXEuZ2V0KCdYLVBhcnNlLUZpbGUtRGlyZWN0b3J5JykpIHtcbiAgICAgICAgcmVxLmZpbGVEYXRhLmRpcmVjdG9yeSA9IHJlcS5nZXQoJ1gtUGFyc2UtRmlsZS1EaXJlY3RvcnknKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuZ2V0KCdYLVBhcnNlLUZpbGUtTWV0YWRhdGEnKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVxLmdldCgnWC1QYXJzZS1GaWxlLU1ldGFkYXRhJykpO1xuICAgICAgICAgIGlmICghcGFyc2VkIHx8IHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlcS5maWxlRGF0YS5tZXRhZGF0YSA9IHBhcnNlZDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnSW52YWxpZCBKU09OIGluIFgtUGFyc2UtRmlsZS1NZXRhZGF0YSBoZWFkZXIuJykpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5nZXQoJ1gtUGFyc2UtRmlsZS1UYWdzJykpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJlcS5nZXQoJ1gtUGFyc2UtRmlsZS1UYWdzJykpO1xuICAgICAgICAgIGlmICghcGFyc2VkIHx8IHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlcS5maWxlRGF0YS50YWdzID0gcGFyc2VkO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBuZXh0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdJbnZhbGlkIEpTT04gaW4gWC1QYXJzZS1GaWxlLVRhZ3MgaGVhZGVyLicpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSBkaXJlY3Rvcnkgb3B0aW9uIChyZXF1aXJlcyBtYXN0ZXIga2V5KVxuICAgIGNvbnN0IGRpcmVjdG9yeSA9IHJlcS5maWxlRGF0YT8uZGlyZWN0b3J5O1xuICAgIGlmIChkaXJlY3RvcnkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICBuZXh0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnRGlyZWN0b3J5IGNhbiBvbmx5IGJlIHNldCB1c2luZyB0aGUgTWFzdGVyIEtleS4nXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCBkaXJlY3RvcnlFcnJvciA9IEZpbGVzUm91dGVyLnZhbGlkYXRlRGlyZWN0b3J5KGRpcmVjdG9yeSk7XG4gICAgICBpZiAoZGlyZWN0b3J5RXJyb3IpIHtcbiAgICAgICAgbmV4dChkaXJlY3RvcnlFcnJvcik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBEaXNwYXRjaCB0byB0aGUgYXBwcm9wcmlhdGUgaGFuZGxlciBiYXNlZCBvbiB3aGV0aGVyIHRoZSBib2R5IHdhcyBidWZmZXJlZFxuICAgIGlmIChCdWZmZXIuaXNCdWZmZXIocmVxLmJvZHkpKSB7XG4gICAgICByZXR1cm4gdGhpcy5faGFuZGxlQnVmZmVyZWRVcGxvYWQocmVxLCByZXMsIG5leHQpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5faGFuZGxlU3RyZWFtVXBsb2FkKHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIGFzeW5jIF9oYW5kbGVCdWZmZXJlZFVwbG9hZChyZXEsIHJlcywgbmV4dCkge1xuICAgIGNvbnN0IGNvbmZpZyA9IHJlcS5jb25maWc7XG4gICAgY29uc3QgZmlsZXNDb250cm9sbGVyID0gY29uZmlnLmZpbGVzQ29udHJvbGxlcjtcbiAgICBjb25zdCB7IGZpbGVuYW1lIH0gPSByZXEucGFyYW1zO1xuICAgIGNvbnN0IGNvbnRlbnRUeXBlID0gcmVxLmdldCgnQ29udGVudC10eXBlJyk7XG5cbiAgICBpZiAoIXJlcS5ib2R5IHx8ICFyZXEuYm9keS5sZW5ndGgpIHtcbiAgICAgIG5leHQobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkZJTEVfU0FWRV9FUlJPUiwgJ0ludmFsaWQgZmlsZSB1cGxvYWQuJykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2U2NCA9IHJlcS5ib2R5LnRvU3RyaW5nKCdiYXNlNjQnKTtcbiAgICBjb25zdCBmaWxlID0gbmV3IFBhcnNlLkZpbGUoZmlsZW5hbWUsIHsgYmFzZTY0IH0sIGNvbnRlbnRUeXBlKTtcbiAgICBjb25zdCB7IG1ldGFkYXRhID0ge30sIHRhZ3MgPSB7fSwgZGlyZWN0b3J5IH0gPSByZXEuZmlsZURhdGEgfHwge307XG4gICAgdHJ5IHtcbiAgICAgIC8vIFNjYW4gcmVxdWVzdCBkYXRhIGZvciBkZW5pZWQga2V5d29yZHNcbiAgICAgIFV0aWxzLmNoZWNrUHJvaGliaXRlZEtleXdvcmRzKGNvbmZpZywgbWV0YWRhdGEpO1xuICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMoY29uZmlnLCB0YWdzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgZXJyb3IpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZmlsZS5zZXRUYWdzKHRhZ3MpO1xuICAgIGZpbGUuc2V0TWV0YWRhdGEobWV0YWRhdGEpO1xuICAgIGlmIChkaXJlY3RvcnkpIHtcbiAgICAgIGZpbGUuc2V0RGlyZWN0b3J5KGRpcmVjdG9yeSk7XG4gICAgfVxuICAgIGNvbnN0IGZpbGVTaXplID0gQnVmZmVyLmJ5dGVMZW5ndGgocmVxLmJvZHkpO1xuICAgIGNvbnN0IGZpbGVPYmplY3QgPSB7IGZpbGUsIGZpbGVTaXplIH07XG4gICAgdHJ5IHtcbiAgICAgIC8vIHJ1biBiZWZvcmVTYXZlRmlsZSB0cmlnZ2VyXG4gICAgICBjb25zdCB0cmlnZ2VyUmVzdWx0ID0gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgZmlsZU9iamVjdCxcbiAgICAgICAgY29uZmlnLFxuICAgICAgICByZXEuYXV0aFxuICAgICAgKTtcbiAgICAgIGxldCBzYXZlUmVzdWx0O1xuICAgICAgLy8gaWYgYSBuZXcgUGFyc2VGaWxlIGlzIHJldHVybmVkIGNoZWNrIGlmIGl0J3MgYW4gYWxyZWFkeSBzYXZlZCBmaWxlXG4gICAgICBpZiAodHJpZ2dlclJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLkZpbGUpIHtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlID0gdHJpZ2dlclJlc3VsdDtcbiAgICAgICAgaWYgKHRyaWdnZXJSZXN1bHQudXJsKCkpIHtcbiAgICAgICAgICAvLyBzZXQgZmlsZVNpemUgdG8gbnVsbCBiZWNhdXNlIHdlIHdvbnQga25vdyBob3cgYmlnIGl0IGlzIGhlcmVcbiAgICAgICAgICBmaWxlT2JqZWN0LmZpbGVTaXplID0gbnVsbDtcbiAgICAgICAgICBzYXZlUmVzdWx0ID0ge1xuICAgICAgICAgICAgdXJsOiB0cmlnZ2VyUmVzdWx0LnVybCgpLFxuICAgICAgICAgICAgbmFtZTogdHJpZ2dlclJlc3VsdC5fbmFtZSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBpZiB0aGUgZmlsZSByZXR1cm5lZCBieSB0aGUgdHJpZ2dlciBoYXMgYWxyZWFkeSBiZWVuIHNhdmVkIHNraXAgc2F2aW5nIGFueXRoaW5nXG4gICAgICBpZiAoIXNhdmVSZXN1bHQpIHtcbiAgICAgICAgLy8gdXBkYXRlIGZpbGVTaXplXG4gICAgICAgIGxldCBidWZmZXJEYXRhO1xuICAgICAgICBpZiAoZmlsZU9iamVjdC5maWxlLl9zb3VyY2U/LmZvcm1hdCA9PT0gJ2J1ZmZlcicpIHtcbiAgICAgICAgICBidWZmZXJEYXRhID0gZmlsZU9iamVjdC5maWxlLl9zb3VyY2UuYnVmZmVyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGJ1ZmZlckRhdGEgPSBCdWZmZXIuZnJvbShmaWxlT2JqZWN0LmZpbGUuX2RhdGEsICdiYXNlNjQnKTtcbiAgICAgICAgfVxuICAgICAgICBmaWxlT2JqZWN0LmZpbGVTaXplID0gQnVmZmVyLmJ5dGVMZW5ndGgoYnVmZmVyRGF0YSk7XG4gICAgICAgIC8vIHByZXBhcmUgZmlsZSBvcHRpb25zXG4gICAgICAgIGNvbnN0IGZpbGVPcHRpb25zID0ge1xuICAgICAgICAgIG1ldGFkYXRhOiBmaWxlT2JqZWN0LmZpbGUuX21ldGFkYXRhLFxuICAgICAgICB9O1xuICAgICAgICAvLyBzb21lIHMzLWNvbXBhdGlibGUgcHJvdmlkZXJzIChEaWdpdGFsT2NlYW4sIExpbm9kZSkgZG8gbm90IGFjY2VwdCB0YWdzXG4gICAgICAgIC8vIHNvIHdlIGRvIG5vdCBpbmNsdWRlIHRoZSB0YWdzIG9wdGlvbiBpZiBpdCBpcyBlbXB0eS5cbiAgICAgICAgY29uc3QgZmlsZVRhZ3MgPVxuICAgICAgICAgIE9iamVjdC5rZXlzKGZpbGVPYmplY3QuZmlsZS5fdGFncykubGVuZ3RoID4gMCA/IHsgdGFnczogZmlsZU9iamVjdC5maWxlLl90YWdzIH0gOiB7fTtcbiAgICAgICAgT2JqZWN0LmFzc2lnbihmaWxlT3B0aW9ucywgZmlsZVRhZ3MpO1xuICAgICAgICAvLyBpbmNsdWRlIGRpcmVjdG9yeSBpZiBzZXQgKGZyb20gY2xpZW50IHJlcXVlc3Qgb3IgYmVmb3JlU2F2ZUZpbGUgdHJpZ2dlcilcbiAgICAgICAgaWYgKGZpbGVPYmplY3QuZmlsZS5fZGlyZWN0b3J5KSB7XG4gICAgICAgICAgZmlsZU9wdGlvbnMuZGlyZWN0b3J5ID0gZmlsZU9iamVjdC5maWxlLl9kaXJlY3Rvcnk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gc2F2ZSBmaWxlXG4gICAgICAgIGNvbnN0IGNyZWF0ZUZpbGVSZXN1bHQgPSBhd2FpdCBmaWxlc0NvbnRyb2xsZXIuY3JlYXRlRmlsZShcbiAgICAgICAgICBjb25maWcsXG4gICAgICAgICAgZmlsZU9iamVjdC5maWxlLl9uYW1lLFxuICAgICAgICAgIGJ1ZmZlckRhdGEsXG4gICAgICAgICAgZmlsZU9iamVjdC5maWxlLl9zb3VyY2UudHlwZSxcbiAgICAgICAgICBmaWxlT3B0aW9uc1xuICAgICAgICApO1xuICAgICAgICAvLyB1cGRhdGUgZmlsZSB3aXRoIG5ldyBkYXRhXG4gICAgICAgIGZpbGVPYmplY3QuZmlsZS5fbmFtZSA9IGNyZWF0ZUZpbGVSZXN1bHQubmFtZTtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl91cmwgPSBjcmVhdGVGaWxlUmVzdWx0LnVybDtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl9yZXF1ZXN0VGFzayA9IG51bGw7XG4gICAgICAgIGZpbGVPYmplY3QuZmlsZS5fcHJldmlvdXNTYXZlID0gUHJvbWlzZS5yZXNvbHZlKGZpbGVPYmplY3QuZmlsZSk7XG4gICAgICAgIHNhdmVSZXN1bHQgPSB7XG4gICAgICAgICAgdXJsOiBjcmVhdGVGaWxlUmVzdWx0LnVybCxcbiAgICAgICAgICBuYW1lOiBjcmVhdGVGaWxlUmVzdWx0Lm5hbWUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICAvLyBydW4gYWZ0ZXJTYXZlRmlsZSB0cmlnZ2VyXG4gICAgICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1bkZpbGVUcmlnZ2VyKHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSwgZmlsZU9iamVjdCwgY29uZmlnLCByZXEuYXV0aCk7XG4gICAgICByZXMuc3RhdHVzKDIwMSk7XG4gICAgICByZXMuc2V0KCdMb2NhdGlvbicsIHNhdmVSZXN1bHQudXJsKTtcbiAgICAgIHJlcy5qc29uKHNhdmVSZXN1bHQpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgY3JlYXRpbmcgYSBmaWxlOiAnLCBlKTtcbiAgICAgIGNvbnN0IGVycm9yID0gdHJpZ2dlcnMucmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLFxuICAgICAgICBtZXNzYWdlOiBgQ291bGQgbm90IHN0b3JlIGZpbGU6ICR7ZmlsZU9iamVjdC5maWxlLl9uYW1lfS5gLFxuICAgICAgfSk7XG4gICAgICBuZXh0KGVycm9yKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBfaGFuZGxlU3RyZWFtVXBsb2FkKHJlcSwgcmVzLCBuZXh0KSB7XG4gICAgY29uc3QgY29uZmlnID0gcmVxLmNvbmZpZztcbiAgICBjb25zdCBmaWxlc0NvbnRyb2xsZXIgPSBjb25maWcuZmlsZXNDb250cm9sbGVyO1xuICAgIGNvbnN0IHsgZmlsZW5hbWUgfSA9IHJlcS5wYXJhbXM7XG4gICAgbGV0IGNvbnRlbnRUeXBlID0gcmVxLmdldCgnQ29udGVudC1UeXBlJyk7XG4gICAgY29uc3QgbWF4Qnl0ZXMgPSByZXEuX21heFVwbG9hZFNpemVCeXRlcztcbiAgICBsZXQgc3RyZWFtO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIEVhcmx5IHJlamVjdGlvbiB2aWEgQ29udGVudC1MZW5ndGggaGVhZGVyXG4gICAgICBjb25zdCBjb250ZW50TGVuZ3RoID0gcmVxLmdldCgnQ29udGVudC1MZW5ndGgnKTtcbiAgICAgIGlmIChjb250ZW50TGVuZ3RoICYmIHBhcnNlSW50KGNvbnRlbnRMZW5ndGgsIDEwKSA+IG1heEJ5dGVzKSB7XG4gICAgICAgIHJlcS5yZXN1bWUoKTtcbiAgICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLFxuICAgICAgICAgIGBGaWxlIHNpemUgZXhjZWVkcyBtYXhpbXVtIGFsbG93ZWQ6ICR7bWF4Qnl0ZXN9IGJ5dGVzLmBcbiAgICAgICAgKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWltZSA9IChhd2FpdCBpbXBvcnQoJ21pbWUnKSkuZGVmYXVsdDtcblxuICAgICAgLy8gSW5mZXIgY29udGVudCB0eXBlIGZyb20gZXh0ZW5zaW9uIG9yIGFkZCBleHRlbnNpb24gZnJvbSBjb250ZW50IHR5cGVcbiAgICAgIGNvbnN0IGhhc0V4dGVuc2lvbiA9IGZpbGVuYW1lICYmIGZpbGVuYW1lLmluY2x1ZGVzKCcuJyk7XG4gICAgICBpZiAoaGFzRXh0ZW5zaW9uICYmICFjb250ZW50VHlwZSkge1xuICAgICAgICBjb250ZW50VHlwZSA9IG1pbWUuZ2V0VHlwZShmaWxlbmFtZSk7XG4gICAgICB9IGVsc2UgaWYgKCFoYXNFeHRlbnNpb24gJiYgY29udGVudFR5cGUpIHtcbiAgICAgICAgLy8gZXh0ZW5zaW9uIHdpbGwgYmUgYWRkZWQgYnkgZmlsZXNDb250cm9sbGVyLmNyZWF0ZUZpbGVcbiAgICAgIH1cblxuICAgICAgLy8gQ3JlYXRlIHNpemUtbGltaXRlZCBzdHJlYW0gd3JhcHBpbmcgdGhlIHJlcXVlc3RcbiAgICAgIHN0cmVhbSA9IGNyZWF0ZVNpemVMaW1pdGVkU3RyZWFtKHJlcSwgbWF4Qnl0ZXMpO1xuXG4gICAgICAvLyBCdWlsZCBhIFBhcnNlLkZpbGUgd2l0aCBubyBfZGF0YSAoc3RyZWFtaW5nIG1vZGUpXG4gICAgICBjb25zdCBmaWxlID0gbmV3IFBhcnNlLkZpbGUoZmlsZW5hbWUsIHsgYmFzZTY0OiAnJyB9LCBjb250ZW50VHlwZSk7XG4gICAgICBjb25zdCB7IG1ldGFkYXRhID0ge30sIHRhZ3MgPSB7fSwgZGlyZWN0b3J5IH0gPSByZXEuZmlsZURhdGEgfHwge307XG5cbiAgICAgIC8vIFZhbGlkYXRlIG1ldGFkYXRhIGFuZCB0YWdzIGZvciBwcm9oaWJpdGVkIGtleXdvcmRzXG4gICAgICB0cnkge1xuICAgICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyhjb25maWcsIG1ldGFkYXRhKTtcbiAgICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMoY29uZmlnLCB0YWdzKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHN0cmVhbS5kZXN0cm95KCk7XG4gICAgICAgIG5leHQobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGVycm9yKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgZmlsZS5zZXRUYWdzKHRhZ3MpO1xuICAgICAgZmlsZS5zZXRNZXRhZGF0YShtZXRhZGF0YSk7XG4gICAgICBpZiAoZGlyZWN0b3J5KSB7XG4gICAgICAgIGZpbGUuc2V0RGlyZWN0b3J5KGRpcmVjdG9yeSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGZpbGVTaXplID0gcmVxLmdldCgnQ29udGVudC1MZW5ndGgnKVxuICAgICAgICA/IHBhcnNlSW50KHJlcS5nZXQoJ0NvbnRlbnQtTGVuZ3RoJyksIDEwKVxuICAgICAgICA6IG51bGw7XG4gICAgICBjb25zdCBmaWxlT2JqZWN0ID0geyBmaWxlLCBmaWxlU2l6ZSwgc3RyZWFtOiB0cnVlIH07XG5cbiAgICAgIC8vIFJ1biBiZWZvcmVTYXZlRmlsZSB0cmlnZ2VyXG4gICAgICBjb25zdCB0cmlnZ2VyUmVzdWx0ID0gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgZmlsZU9iamVjdCxcbiAgICAgICAgY29uZmlnLFxuICAgICAgICByZXEuYXV0aFxuICAgICAgKTtcblxuICAgICAgbGV0IHNhdmVSZXN1bHQ7XG4gICAgICAvLyBJZiBhIG5ldyBQYXJzZUZpbGUgaXMgcmV0dXJuZWQsIGNoZWNrIGlmIGl0J3MgYW4gYWxyZWFkeSBzYXZlZCBmaWxlXG4gICAgICBpZiAodHJpZ2dlclJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLkZpbGUpIHtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlID0gdHJpZ2dlclJlc3VsdDtcbiAgICAgICAgaWYgKHRyaWdnZXJSZXN1bHQudXJsKCkpIHtcbiAgICAgICAgICBmaWxlT2JqZWN0LmZpbGVTaXplID0gbnVsbDtcbiAgICAgICAgICBzYXZlUmVzdWx0ID0ge1xuICAgICAgICAgICAgdXJsOiB0cmlnZ2VyUmVzdWx0LnVybCgpLFxuICAgICAgICAgICAgbmFtZTogdHJpZ2dlclJlc3VsdC5fbmFtZSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIC8vIERlc3Ryb3kgc3RyZWFtIHRvIHJlbW92ZSBsaXN0ZW5lcnMgYW5kIGRyYWluIHJlcXVlc3RcbiAgICAgICAgICBzdHJlYW0uZGVzdHJveSgpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHRoZSBmaWxlIHJldHVybmVkIGJ5IHRoZSB0cmlnZ2VyIGhhcyBhbHJlYWR5IGJlZW4gc2F2ZWQsIHNraXAgc2F2aW5nXG4gICAgICBpZiAoIXNhdmVSZXN1bHQpIHtcbiAgICAgICAgLy8gUHJlcGFyZSBmaWxlIG9wdGlvbnNcbiAgICAgICAgY29uc3QgZmlsZU9wdGlvbnMgPSB7XG4gICAgICAgICAgbWV0YWRhdGE6IGZpbGVPYmplY3QuZmlsZS5fbWV0YWRhdGEsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGZpbGVUYWdzID1cbiAgICAgICAgICBPYmplY3Qua2V5cyhmaWxlT2JqZWN0LmZpbGUuX3RhZ3MpLmxlbmd0aCA+IDAgPyB7IHRhZ3M6IGZpbGVPYmplY3QuZmlsZS5fdGFncyB9IDoge307XG4gICAgICAgIE9iamVjdC5hc3NpZ24oZmlsZU9wdGlvbnMsIGZpbGVUYWdzKTtcbiAgICAgICAgLy8gaW5jbHVkZSBkaXJlY3RvcnkgaWYgc2V0IChmcm9tIGNsaWVudCByZXF1ZXN0IG9yIGJlZm9yZVNhdmVGaWxlIHRyaWdnZXIpXG4gICAgICAgIGlmIChmaWxlT2JqZWN0LmZpbGUuX2RpcmVjdG9yeSkge1xuICAgICAgICAgIGZpbGVPcHRpb25zLmRpcmVjdG9yeSA9IGZpbGVPYmplY3QuZmlsZS5fZGlyZWN0b3J5O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFzcyBzdHJlYW0gZGlyZWN0bHkgdG8gZmlsZXNDb250cm9sbGVyIOKAlCBpdCB3aWxsIGJ1ZmZlciBpZiBhZGFwdGVyIGRvZXNuJ3Qgc3VwcG9ydCBzdHJlYW1pbmdcbiAgICAgICAgY29uc3Qgc291cmNlVHlwZSA9IGZpbGVPYmplY3QuZmlsZS5fc291cmNlPy50eXBlIHx8IGNvbnRlbnRUeXBlO1xuICAgICAgICBjb25zdCBjcmVhdGVGaWxlUmVzdWx0ID0gYXdhaXQgZmlsZXNDb250cm9sbGVyLmNyZWF0ZUZpbGUoXG4gICAgICAgICAgY29uZmlnLFxuICAgICAgICAgIGZpbGVPYmplY3QuZmlsZS5fbmFtZSxcbiAgICAgICAgICBzdHJlYW0sXG4gICAgICAgICAgc291cmNlVHlwZSxcbiAgICAgICAgICBmaWxlT3B0aW9uc1xuICAgICAgICApO1xuXG4gICAgICAgIC8vIFVwZGF0ZSBmaWxlIHdpdGggbmV3IGRhdGFcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl9uYW1lID0gY3JlYXRlRmlsZVJlc3VsdC5uYW1lO1xuICAgICAgICBmaWxlT2JqZWN0LmZpbGUuX3VybCA9IGNyZWF0ZUZpbGVSZXN1bHQudXJsO1xuICAgICAgICBmaWxlT2JqZWN0LmZpbGUuX3JlcXVlc3RUYXNrID0gbnVsbDtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl9wcmV2aW91c1NhdmUgPSBQcm9taXNlLnJlc29sdmUoZmlsZU9iamVjdC5maWxlKTtcbiAgICAgICAgc2F2ZVJlc3VsdCA9IHtcbiAgICAgICAgICB1cmw6IGNyZWF0ZUZpbGVSZXN1bHQudXJsLFxuICAgICAgICAgIG5hbWU6IGNyZWF0ZUZpbGVSZXN1bHQubmFtZSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gUnVuIGFmdGVyU2F2ZUZpbGUgdHJpZ2dlclxuICAgICAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcih0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsIGZpbGVPYmplY3QsIGNvbmZpZywgcmVxLmF1dGgpO1xuICAgICAgcmVzLnN0YXR1cygyMDEpO1xuICAgICAgcmVzLnNldCgnTG9jYXRpb24nLCBzYXZlUmVzdWx0LnVybCk7XG4gICAgICByZXMuanNvbihzYXZlUmVzdWx0KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBEZXN0cm95IHN0cmVhbSB0byByZW1vdmUgbGlzdGVuZXJzIGFuZCBkcmFpbiByZXF1ZXN0LCBvciByZXN1bWUgZGlyZWN0bHlcbiAgICAgIGlmIChzdHJlYW0pIHtcbiAgICAgICAgc3RyZWFtLmRlc3Ryb3koKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlcS5yZXN1bWUoKTtcbiAgICAgIH1cbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgY3JlYXRpbmcgYSBmaWxlOiAnLCBlKTtcbiAgICAgIGNvbnN0IGVycm9yID0gdHJpZ2dlcnMucmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLFxuICAgICAgICBtZXNzYWdlOiBgQ291bGQgbm90IHN0b3JlIGZpbGU6ICR7ZmlsZW5hbWV9LmAsXG4gICAgICB9KTtcbiAgICAgIG5leHQoZXJyb3IpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGRlbGV0ZUhhbmRsZXIocmVxLCByZXMsIG5leHQpIHtcbiAgICBpZiAocmVxLmF1dGguaXNSZWFkT25seSkge1xuICAgICAgY29uc3QgZXJyb3IgPSBjcmVhdGVTYW5pdGl6ZWRIdHRwRXJyb3IoNDAzLCBcInJlYWQtb25seSBtYXN0ZXJLZXkgaXNuJ3QgYWxsb3dlZCB0byBkZWxldGUgYSBmaWxlLlwiLCByZXEuY29uZmlnKTtcbiAgICAgIHJlcy5zdGF0dXMoZXJyb3Iuc3RhdHVzKTtcbiAgICAgIHJlcy5lbmQoYHtcImVycm9yXCI6XCIke2Vycm9yLm1lc3NhZ2V9XCJ9YCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGZpbGVzQ29udHJvbGxlciB9ID0gcmVxLmNvbmZpZztcbiAgICAgIGNvbnN0IGZpbGVuYW1lID0gRmlsZXNSb3V0ZXIuX2dldEZpbGVuYW1lRnJvbVBhcmFtcyhyZXEpO1xuICAgICAgLy8gcnVuIGJlZm9yZURlbGV0ZUZpbGUgdHJpZ2dlclxuICAgICAgY29uc3QgZmlsZSA9IG5ldyBQYXJzZS5GaWxlKGZpbGVuYW1lKTtcbiAgICAgIGZpbGUuX3VybCA9IGF3YWl0IGZpbGVzQ29udHJvbGxlci5hZGFwdGVyLmdldEZpbGVMb2NhdGlvbihyZXEuY29uZmlnLCBmaWxlbmFtZSk7XG4gICAgICBjb25zdCBmaWxlT2JqZWN0ID0geyBmaWxlLCBmaWxlU2l6ZTogbnVsbCB9O1xuICAgICAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlRGVsZXRlLFxuICAgICAgICBmaWxlT2JqZWN0LFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICByZXEuYXV0aFxuICAgICAgKTtcbiAgICAgIC8vIGRlbGV0ZSBmaWxlXG4gICAgICBhd2FpdCBmaWxlc0NvbnRyb2xsZXIuZGVsZXRlRmlsZShyZXEuY29uZmlnLCBmaWxlbmFtZSk7XG4gICAgICAvLyBydW4gYWZ0ZXJEZWxldGVGaWxlIHRyaWdnZXJcbiAgICAgIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRGVsZXRlLFxuICAgICAgICBmaWxlT2JqZWN0LFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICByZXEuYXV0aFxuICAgICAgKTtcbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIC8vIFRPRE86IHJldHVybiB1c2VmdWwgSlNPTiBoZXJlP1xuICAgICAgcmVzLmVuZCgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgZGVsZXRpbmcgYSBmaWxlOiAnLCBlKTtcbiAgICAgIGNvbnN0IGVycm9yID0gdHJpZ2dlcnMucmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuRklMRV9ERUxFVEVfRVJST1IsXG4gICAgICAgIG1lc3NhZ2U6ICdDb3VsZCBub3QgZGVsZXRlIGZpbGUuJyxcbiAgICAgIH0pO1xuICAgICAgbmV4dChlcnJvcik7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgbWV0YWRhdGFIYW5kbGVyKHJlcSwgcmVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IENvbmZpZy5nZXQocmVxLnBhcmFtcy5hcHBJZCk7XG4gICAgICBpZiAoIWNvbmZpZykge1xuICAgICAgICByZXMuc3RhdHVzKDIwMCk7XG4gICAgICAgIHJlcy5qc29uKHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgRmlsZXNSb3V0ZXIuX3ZhbGlkYXRlRmlsZURvd25sb2FkKHJlcSwgY29uZmlnKTtcbiAgICAgIGNvbnN0IHsgZmlsZXNDb250cm9sbGVyIH0gPSBjb25maWc7XG4gICAgICBsZXQgZmlsZW5hbWUgPSBGaWxlc1JvdXRlci5fZ2V0RmlsZW5hbWVGcm9tUGFyYW1zKHJlcSk7XG4gICAgICBjb25zdCBmaWxlID0gbmV3IFBhcnNlLkZpbGUoZmlsZW5hbWUsIHsgYmFzZTY0OiAnJyB9KTtcbiAgICAgIGNvbnN0IGZpbGVBdXRoID0gcmVxLmF1dGg7XG4gICAgICBjb25zdCB0cmlnZ2VyUmVzdWx0ID0gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlRmluZCxcbiAgICAgICAgeyBmaWxlIH0sXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZmlsZUF1dGhcbiAgICAgICk7XG4gICAgICBpZiAodHJpZ2dlclJlc3VsdD8uZmlsZT8uX25hbWUpIHtcbiAgICAgICAgZmlsZW5hbWUgPSB0cmlnZ2VyUmVzdWx0LmZpbGUuX25hbWU7XG4gICAgICB9XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmlsZXNDb250cm9sbGVyLmdldE1ldGFkYXRhKGZpbGVuYW1lKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgICAgcmVzLmpzb24oe30pO1xuICAgICAgfSk7XG4gICAgICBpZiAoIWRhdGEpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgICAgICB7IGZpbGUgfSxcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBmaWxlQXV0aFxuICAgICAgKTtcbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIHJlcy5qc29uKGRhdGEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IHRyaWdnZXJzLnJlc29sdmVFcnJvcihlLCB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgIG1lc3NhZ2U6ICdDb3VsZCBub3QgZ2V0IGZpbGUgbWV0YWRhdGEuJyxcbiAgICAgIH0pO1xuICAgICAgcmVzLnN0YXR1cyg0MDMpO1xuICAgICAgcmVzLmpzb24oeyBjb2RlOiBlcnIuY29kZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBpc0ZpbGVTdHJlYW1hYmxlKHJlcSwgZmlsZXNDb250cm9sbGVyKSB7XG4gIGNvbnN0IHJhbmdlID0gKHJlcS5nZXQoJ1JhbmdlJykgfHwgJy8tLycpLnNwbGl0KCctJyk7XG4gIGNvbnN0IHN0YXJ0ID0gTnVtYmVyKHJhbmdlWzBdKTtcbiAgY29uc3QgZW5kID0gTnVtYmVyKHJhbmdlWzFdKTtcbiAgcmV0dXJuIChcbiAgICAoIWlzTmFOKHN0YXJ0KSB8fCAhaXNOYU4oZW5kKSkgJiYgdHlwZW9mIGZpbGVzQ29udHJvbGxlci5hZGFwdGVyLmhhbmRsZUZpbGVTdHJlYW0gPT09ICdmdW5jdGlvbidcbiAgKTtcbn1cbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBLElBQUFBLFFBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLFdBQUEsR0FBQUMsdUJBQUEsQ0FBQUYsT0FBQTtBQUNBLElBQUFHLEtBQUEsR0FBQUosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFJLE9BQUEsR0FBQUwsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFLLE9BQUEsR0FBQU4sc0JBQUEsQ0FBQUMsT0FBQTtBQUdBLElBQUFNLE9BQUEsR0FBQU4sT0FBQTtBQUNBLElBQUFPLE1BQUEsR0FBQVAsT0FBQTtBQUFvRCxTQUFBRSx3QkFBQU0sQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQVIsdUJBQUEsWUFBQUEsQ0FBQU0sQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FBQSxT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