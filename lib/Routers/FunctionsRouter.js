"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.FunctionsRouter = void 0;
var _PromiseRouter = _interopRequireDefault(require("../PromiseRouter"));
var _middlewares = require("../middlewares");
var _StatusHandler = require("../StatusHandler");
var _lodash = _interopRequireDefault(require("lodash"));
var _logger = require("../logger");
var _Error = require("../Error");
var _busboy = _interopRequireDefault(require("@fastify/busboy"));
var _Utils = _interopRequireDefault(require("../Utils"));
var _api = require("@opentelemetry/api");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// FunctionsRouter.js

var Parse = require('parse/node').Parse,
  triggers = require('../triggers');
const traceSecretKey = /authorization|cookie|password|passphrase|secret|token|masterkey|privatekey|api[-_]?key|receipt|signed(?:payload|transaction)/i;
const incomingRequestSpan = Symbol.for('mapstr.telemetry.incoming-request-span');
function redactBuffers(obj) {
  if (Buffer.isBuffer(obj)) {
    return `[Buffer: ${obj.length} bytes]`;
  }
  if (_Utils.default.isDate(obj) && !Number.isNaN(obj.getTime())) {
    return obj.toISOString();
  }
  if (_Utils.default.isRegExp(obj)) {
    return obj.toString();
  }
  if (obj && typeof obj.toHexString === 'function') {
    return obj.toHexString();
  }
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(redactBuffers);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = redactBuffers(obj[key]);
    }
    return result;
  }
  return obj;
}
function sanitizeTraceParams(obj, key, depth = 0, seen = new WeakSet()) {
  if (key && traceSecretKey.test(key)) {
    return '[REDACTED]';
  }
  if (Buffer.isBuffer(obj)) {
    return `[Buffer: ${obj.length} bytes]`;
  }
  if (_Utils.default.isDate(obj)) {
    return Number.isNaN(obj.getTime()) ? obj.toString() : obj.toISOString();
  }
  if (_Utils.default.isRegExp(obj)) {
    return obj.toString();
  }
  if (obj && typeof obj.toHexString === 'function') {
    return obj.toHexString();
  }
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    if (depth >= 10 || seen.has(obj)) {
      return '[TRUNCATED]';
    }
    seen.add(obj);
    const values = obj.slice(0, 20).map(item => sanitizeTraceParams(item, undefined, depth + 1, seen));
    if (obj.length > values.length) {
      values.push(`[${obj.length - values.length} more values]`);
    }
    return values;
  }
  if (obj && typeof obj === 'object') {
    if (depth >= 10 || seen.has(obj)) {
      return '[TRUNCATED]';
    }
    seen.add(obj);
    const result = {};
    const properties = Object.keys(obj).slice(0, 100);
    for (const property of properties) {
      result[property] = sanitizeTraceParams(obj[property], property, depth + 1, seen);
    }
    if (Object.keys(obj).length > properties.length) {
      result.__truncated = `${Object.keys(obj).length - properties.length} more keys`;
    }
    return result;
  }
  if (typeof obj === 'string' && obj.length > 500) {
    return `${obj.substring(0, 500)}... (truncated)`;
  }
  return obj;
}
function serializeTraceParams(params) {
  const serialized = JSON.stringify(sanitizeTraceParams(params));
  return serialized.length > 10000 ? `${serialized.substring(0, 10000)}... (truncated)` : serialized;
}
function parseObject(obj, config) {
  if (Array.isArray(obj)) {
    return obj.map(item => {
      return parseObject(item, config);
    });
  } else if (obj && obj.__type == 'Date') {
    return Object.assign(new Date(obj.iso), obj);
  } else if (obj && obj.__type == 'File') {
    if (obj.url) {
      const {
        validateFileUrl
      } = require('../FileUrlValidator');
      validateFileUrl(obj.url, config);
    }
    return Parse.File.fromJSON(obj);
  } else if (obj && obj.__type == 'Pointer') {
    return Parse.Object.fromJSON({
      __type: 'Pointer',
      className: obj.className,
      objectId: obj.objectId
    });
  } else if (Buffer.isBuffer(obj)) {
    return obj;
  } else if (obj && typeof obj === 'object') {
    return parseParams(obj, config);
  } else {
    return obj;
  }
}
function parseParams(params, config) {
  return _lodash.default.mapValues(params, item => parseObject(item, config));
}
class FunctionsRouter extends _PromiseRouter.default {
  mountRoutes() {
    this.route('POST', '/functions/:functionName', _middlewares.promiseEnsureIdempotency, FunctionsRouter.multipartMiddleware, FunctionsRouter.handleCloudFunction);
    this.route('POST', '/jobs/:jobName', _middlewares.promiseEnsureIdempotency, _middlewares.promiseEnforceMasterKeyAccess, function (req) {
      return FunctionsRouter.handleCloudJob(req);
    });
    this.route('POST', '/jobs', _middlewares.promiseEnforceMasterKeyAccess, function (req) {
      return FunctionsRouter.handleCloudJob(req);
    });
  }
  static handleCloudJob(req) {
    if (req.auth.isReadOnly) {
      throw (0, _Error.createSanitizedError)(Parse.Error.OPERATION_FORBIDDEN, "read-only masterKey isn't allowed to run a job.", req.config);
    }
    const jobName = req.params.jobName || req.body?.jobName;
    const applicationId = req.config.applicationId;
    const jobHandler = (0, _StatusHandler.jobStatusHandler)(req.config);
    const jobFunction = triggers.getJob(jobName, applicationId);
    if (!jobFunction) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Invalid job.');
    }
    let params = Object.assign({}, req.body, req.query);
    params = parseParams(params, req.config);
    const request = {
      params: params,
      log: req.config.loggerController,
      headers: req.config.headers,
      ip: req.config.ip,
      jobName,
      config: req.config,
      message: jobHandler.setMessage.bind(jobHandler)
    };
    return jobHandler.setRunning(jobName).then(jobStatus => {
      request.jobId = jobStatus.objectId;
      // run the function async
      process.nextTick(() => {
        Promise.resolve().then(() => {
          return jobFunction(request);
        }).then(result => {
          jobHandler.setSucceeded(result);
        }, error => {
          jobHandler.setFailed(error);
        });
      });
      return {
        headers: {
          'X-Parse-Job-Status-Id': jobStatus.objectId
        },
        response: {}
      };
    });
  }
  static createResponseObject(resolve, reject, statusCode = null) {
    let httpStatusCode = statusCode;
    const customHeaders = {};
    let responseSent = false;
    const responseObject = {
      success: function (result) {
        if (responseSent) {
          throw new Error('Cannot call success() after response has already been sent. Make sure to call success() or error() only once per cloud function execution.');
        }
        responseSent = true;
        const response = {
          response: {
            result: Parse._encode(result)
          }
        };
        if (httpStatusCode !== null) {
          response.status = httpStatusCode;
        }
        if (Object.keys(customHeaders).length > 0) {
          response.headers = customHeaders;
        }
        resolve(response);
      },
      error: function (message) {
        if (responseSent) {
          throw new Error('Cannot call error() after response has already been sent. Make sure to call success() or error() only once per cloud function execution.');
        }
        responseSent = true;
        let error;
        if (message instanceof Parse.Error) {
          error = message;
        } else {
          let code = Parse.Error.SCRIPT_FAILED;
          if (typeof message === 'string') {
            error = new Parse.Error(code, message);
          } else {
            if (_Utils.default.isNativeError(message)) {
              message = message.message;
            }
            if (_Utils.default.isObject(message) && Object.prototype.hasOwnProperty.call(message, 'code') && Object.prototype.hasOwnProperty.call(message, 'message')) {
              code = message.code;
              message = message.message;
            }
            if (_Utils.default.isObject(message)) {
              try {
                message = JSON.stringify(message);
              } catch {
                // Ignore serialization errors.
              }
            }
            error = new Parse.Error(code, message);
          }
        }
        // If a custom status code was set, attach it to the error
        if (httpStatusCode !== null) {
          error.status = httpStatusCode;
        }
        reject(error);
      },
      status: function (code) {
        httpStatusCode = code;
        return responseObject;
      },
      header: function (key, value) {
        customHeaders[key] = value;
        return responseObject;
      },
      _isResponseSent: () => responseSent
    };
    return responseObject;
  }

  /**
   * Parses multipart/form-data requests for Cloud Function invocation.
   * For non-multipart requests, this is a no-op.
   *
   * Text fields are set as strings in `req.body`. File fields are set as
   * objects with the shape `{ filename: string, contentType: string, data: Buffer }`.
   * All fields are merged flat into `req.body`; the caller is responsible for
   * avoiding name collisions between text and file fields.
   *
   * The total request size is limited by the server's `maxUploadSize` option.
   */
  static multipartMiddleware(req) {
    if (!req.is || !req.is('multipart/form-data')) {
      return Promise.resolve();
    }
    const maxBytes = _Utils.default.parseSizeToBytes(req.config.maxUploadSize);
    // Reject early when the declared request size already exceeds the limit.
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return Promise.reject(new Parse.Error(Parse.Error.OBJECT_TOO_LARGE, 'Multipart request exceeds maximum upload size.'));
    }
    return new Promise((resolve, reject) => {
      const fields = Object.create(null);
      let totalBytes = 0;
      let settled = false;
      let busboy;
      try {
        busboy = (0, _busboy.default)({
          headers: req.headers,
          limits: {
            fieldSize: maxBytes
          }
        });
      } catch (err) {
        return reject(new Parse.Error(Parse.Error.INVALID_JSON, `Invalid multipart request: ${err.message}`));
      }
      const safeReject = err => {
        if (settled) {
          return;
        }
        settled = true;
        req.unpipe(busboy);
        busboy.destroy();
        reject(err);
      };
      busboy.on('field', (name, value, fieldnameTruncated, valueTruncated) => {
        if (valueTruncated) {
          return safeReject(new Parse.Error(Parse.Error.OBJECT_TOO_LARGE, 'Multipart request exceeds maximum upload size.'));
        }
        totalBytes += Buffer.byteLength(value);
        if (totalBytes > maxBytes) {
          return safeReject(new Parse.Error(Parse.Error.OBJECT_TOO_LARGE, 'Multipart request exceeds maximum upload size.'));
        }
        fields[name] = value;
      });
      busboy.on('file', (name, stream, filename, transferEncoding, mimeType) => {
        const chunks = [];
        stream.on('data', chunk => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            stream.destroy();
            return safeReject(new Parse.Error(Parse.Error.OBJECT_TOO_LARGE, 'Multipart request exceeds maximum upload size.'));
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          if (settled) {
            return;
          }
          fields[name] = {
            filename,
            contentType: mimeType || 'application/octet-stream',
            data: Buffer.concat(chunks)
          };
        });
      });
      busboy.on('finish', () => {
        if (settled) {
          return;
        }
        settled = true;
        req.body = fields;
        resolve();
      });
      busboy.on('error', err => {
        safeReject(new Parse.Error(Parse.Error.INVALID_JSON, `Invalid multipart request: ${err.message}`));
      });
      // Enforce `maxUploadSize` against the raw request bytes (multipart
      // boundaries, part headers, field names and part count included), not only
      // the parsed field values and file contents. This mirrors how
      // `express.json` bounds non-multipart bodies and stops a request composed
      // of many empty parts from exceeding the limit on the wire.
      let rawBytes = 0;
      req.on('data', chunk => {
        rawBytes += chunk.length;
        if (rawBytes > maxBytes) {
          safeReject(new Parse.Error(Parse.Error.OBJECT_TOO_LARGE, 'Multipart request exceeds maximum upload size.'));
        }
      });
      req.pipe(busboy);
    });
  }
  static handleCloudFunction(req) {
    const functionName = req.params.functionName;
    const applicationId = req.config.applicationId;
    const theFunction = triggers.getFunction(functionName, applicationId);
    if (!theFunction) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, `Invalid function: "${functionName}"`);
    }
    let params = Object.assign({}, req.body, req.query);
    params = parseParams(params, req.config);
    const request = {
      params: params,
      config: req.config,
      master: req.auth && req.auth.isMaster,
      isReadOnly: !!(req.auth && req.auth.isReadOnly),
      user: req.auth && req.auth.user,
      installationId: req.info.installationId,
      log: req.config.loggerController,
      headers: req.config.headers,
      ip: req.config.ip,
      functionName,
      context: req.info.context
    };
    let activeSpan;
    try {
      activeSpan = req[incomingRequestSpan] || _api.trace.getActiveSpan();
      if (activeSpan?.isRecording()) {
        if (request.user && request.user.id) {
          activeSpan.setAttribute('enduser.id', request.user.id);
        }
        activeSpan.setAttribute('parse.function.name', functionName);
        activeSpan.setAttribute('parse.function.params', serializeTraceParams(params));
        activeSpan.setAttribute('aws.xray.annotations', ['parse.function.name']);
      }
    } catch {
      // Ignore tracing errors.
    }
    return new Promise(function (resolve, reject) {
      const userString = req.auth && req.auth.user ? req.auth.user.id : undefined;
      const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(redactBuffers(params)));
      const responseObject = FunctionsRouter.createResponseObject(result => {
        try {
          if (req.config.logLevels.cloudFunctionSuccess !== 'silent') {
            const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result.response.result));
            _logger.logger[req.config.logLevels.cloudFunctionSuccess](`Ran cloud function ${functionName} for user ${userString} with: Input: ${cleanInput} Result: ${cleanResult}`, {
              functionName,
              params,
              user: userString
            });
          }
          resolve(result);
        } catch (e) {
          reject(e);
        }
      }, error => {
        try {
          if (activeSpan) {
            activeSpan.recordException(error);
            activeSpan.setStatus({
              code: _api.SpanStatusCode.ERROR,
              message: error.message
            });
          }
          if (req.config.logLevels.cloudFunctionError !== 'silent') {
            _logger.logger[req.config.logLevels.cloudFunctionError](`Failed running cloud function ${functionName} for user ${userString} with: Input: ${cleanInput} Error: ` + JSON.stringify(error), {
              functionName,
              error,
              params,
              user: userString
            });
          }
          reject(error);
        } catch (e) {
          reject(e);
        }
      });
      const {
        success,
        error
      } = responseObject;
      return Promise.resolve().then(() => {
        return triggers.maybeRunValidator(request, functionName, req.auth);
      }).then(() => {
        // Check if function expects 2 parameters (req, res) - Express style
        if (theFunction.length >= 2) {
          return theFunction(request, responseObject);
        } else {
          // Traditional style - single parameter
          return theFunction(request);
        }
      }).then(result => {
        // For Express-style functions, only send response if not already sent
        if (theFunction.length >= 2) {
          if (!responseObject._isResponseSent()) {
            // If Express-style function returns a value without calling res.success/error
            if (result !== undefined) {
              success(result);
            }
            // If no response sent and no value returned, this is an error in user code
            // but we don't handle it here to maintain backward compatibility
          }
        } else {
          // For traditional functions, always call success with the result (even if undefined)
          success(result);
        }
      }, error);
    });
  }
}
exports.FunctionsRouter = FunctionsRouter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUHJvbWlzZVJvdXRlciIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX21pZGRsZXdhcmVzIiwiX1N0YXR1c0hhbmRsZXIiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9FcnJvciIsIl9idXNib3kiLCJfVXRpbHMiLCJfYXBpIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUGFyc2UiLCJ0cmlnZ2VycyIsInRyYWNlU2VjcmV0S2V5IiwiaW5jb21pbmdSZXF1ZXN0U3BhbiIsIlN5bWJvbCIsImZvciIsInJlZGFjdEJ1ZmZlcnMiLCJvYmoiLCJCdWZmZXIiLCJpc0J1ZmZlciIsImxlbmd0aCIsIlV0aWxzIiwiaXNEYXRlIiwiTnVtYmVyIiwiaXNOYU4iLCJnZXRUaW1lIiwidG9JU09TdHJpbmciLCJpc1JlZ0V4cCIsInRvU3RyaW5nIiwidG9IZXhTdHJpbmciLCJBcnJheSIsImlzQXJyYXkiLCJtYXAiLCJyZXN1bHQiLCJrZXkiLCJPYmplY3QiLCJrZXlzIiwic2FuaXRpemVUcmFjZVBhcmFtcyIsImRlcHRoIiwic2VlbiIsIldlYWtTZXQiLCJ0ZXN0IiwiaGFzIiwiYWRkIiwidmFsdWVzIiwic2xpY2UiLCJpdGVtIiwidW5kZWZpbmVkIiwicHVzaCIsInByb3BlcnRpZXMiLCJwcm9wZXJ0eSIsIl9fdHJ1bmNhdGVkIiwic3Vic3RyaW5nIiwic2VyaWFsaXplVHJhY2VQYXJhbXMiLCJwYXJhbXMiLCJzZXJpYWxpemVkIiwiSlNPTiIsInN0cmluZ2lmeSIsInBhcnNlT2JqZWN0IiwiY29uZmlnIiwiX190eXBlIiwiYXNzaWduIiwiRGF0ZSIsImlzbyIsInVybCIsInZhbGlkYXRlRmlsZVVybCIsIkZpbGUiLCJmcm9tSlNPTiIsImNsYXNzTmFtZSIsIm9iamVjdElkIiwicGFyc2VQYXJhbXMiLCJfIiwibWFwVmFsdWVzIiwiRnVuY3Rpb25zUm91dGVyIiwiUHJvbWlzZVJvdXRlciIsIm1vdW50Um91dGVzIiwicm91dGUiLCJwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kiLCJtdWx0aXBhcnRNaWRkbGV3YXJlIiwiaGFuZGxlQ2xvdWRGdW5jdGlvbiIsInByb21pc2VFbmZvcmNlTWFzdGVyS2V5QWNjZXNzIiwicmVxIiwiaGFuZGxlQ2xvdWRKb2IiLCJhdXRoIiwiaXNSZWFkT25seSIsImNyZWF0ZVNhbml0aXplZEVycm9yIiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiam9iTmFtZSIsImJvZHkiLCJhcHBsaWNhdGlvbklkIiwiam9iSGFuZGxlciIsImpvYlN0YXR1c0hhbmRsZXIiLCJqb2JGdW5jdGlvbiIsImdldEpvYiIsIlNDUklQVF9GQUlMRUQiLCJxdWVyeSIsInJlcXVlc3QiLCJsb2ciLCJsb2dnZXJDb250cm9sbGVyIiwiaGVhZGVycyIsImlwIiwibWVzc2FnZSIsInNldE1lc3NhZ2UiLCJiaW5kIiwic2V0UnVubmluZyIsInRoZW4iLCJqb2JTdGF0dXMiLCJqb2JJZCIsInByb2Nlc3MiLCJuZXh0VGljayIsIlByb21pc2UiLCJyZXNvbHZlIiwic2V0U3VjY2VlZGVkIiwiZXJyb3IiLCJzZXRGYWlsZWQiLCJyZXNwb25zZSIsImNyZWF0ZVJlc3BvbnNlT2JqZWN0IiwicmVqZWN0Iiwic3RhdHVzQ29kZSIsImh0dHBTdGF0dXNDb2RlIiwiY3VzdG9tSGVhZGVycyIsInJlc3BvbnNlU2VudCIsInJlc3BvbnNlT2JqZWN0Iiwic3VjY2VzcyIsIl9lbmNvZGUiLCJzdGF0dXMiLCJjb2RlIiwiaXNOYXRpdmVFcnJvciIsImlzT2JqZWN0IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiaGVhZGVyIiwidmFsdWUiLCJfaXNSZXNwb25zZVNlbnQiLCJpcyIsIm1heEJ5dGVzIiwicGFyc2VTaXplVG9CeXRlcyIsIm1heFVwbG9hZFNpemUiLCJjb250ZW50TGVuZ3RoIiwiaXNGaW5pdGUiLCJPQkpFQ1RfVE9PX0xBUkdFIiwiZmllbGRzIiwiY3JlYXRlIiwidG90YWxCeXRlcyIsInNldHRsZWQiLCJidXNib3kiLCJCdXNib3kiLCJsaW1pdHMiLCJmaWVsZFNpemUiLCJlcnIiLCJJTlZBTElEX0pTT04iLCJzYWZlUmVqZWN0IiwidW5waXBlIiwiZGVzdHJveSIsIm9uIiwibmFtZSIsImZpZWxkbmFtZVRydW5jYXRlZCIsInZhbHVlVHJ1bmNhdGVkIiwiYnl0ZUxlbmd0aCIsInN0cmVhbSIsImZpbGVuYW1lIiwidHJhbnNmZXJFbmNvZGluZyIsIm1pbWVUeXBlIiwiY2h1bmtzIiwiY2h1bmsiLCJjb250ZW50VHlwZSIsImRhdGEiLCJjb25jYXQiLCJyYXdCeXRlcyIsInBpcGUiLCJmdW5jdGlvbk5hbWUiLCJ0aGVGdW5jdGlvbiIsImdldEZ1bmN0aW9uIiwibWFzdGVyIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJpbmZvIiwiY29udGV4dCIsImFjdGl2ZVNwYW4iLCJ0cmFjZSIsImdldEFjdGl2ZVNwYW4iLCJpc1JlY29yZGluZyIsImlkIiwic2V0QXR0cmlidXRlIiwidXNlclN0cmluZyIsImNsZWFuSW5wdXQiLCJsb2dnZXIiLCJ0cnVuY2F0ZUxvZ01lc3NhZ2UiLCJsb2dMZXZlbHMiLCJjbG91ZEZ1bmN0aW9uU3VjY2VzcyIsImNsZWFuUmVzdWx0IiwicmVjb3JkRXhjZXB0aW9uIiwic2V0U3RhdHVzIiwiU3BhblN0YXR1c0NvZGUiLCJFUlJPUiIsImNsb3VkRnVuY3Rpb25FcnJvciIsIm1heWJlUnVuVmFsaWRhdG9yIiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL0Z1bmN0aW9uc1JvdXRlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBGdW5jdGlvbnNSb3V0ZXIuanNcblxudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlLFxuICB0cmlnZ2VycyA9IHJlcXVpcmUoJy4uL3RyaWdnZXJzJyk7XG5cbmltcG9ydCBQcm9taXNlUm91dGVyIGZyb20gJy4uL1Byb21pc2VSb3V0ZXInO1xuaW1wb3J0IHsgcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MsIHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSB9IGZyb20gJy4uL21pZGRsZXdhcmVzJztcbmltcG9ydCB7IGpvYlN0YXR1c0hhbmRsZXIgfSBmcm9tICcuLi9TdGF0dXNIYW5kbGVyJztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuLi9FcnJvcic7XG5pbXBvcnQgQnVzYm95IGZyb20gJ0BmYXN0aWZ5L2J1c2JveSc7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi4vVXRpbHMnO1xuaW1wb3J0IHsgU3BhblN0YXR1c0NvZGUsIHRyYWNlIH0gZnJvbSAnQG9wZW50ZWxlbWV0cnkvYXBpJztcblxuY29uc3QgdHJhY2VTZWNyZXRLZXkgPSAvYXV0aG9yaXphdGlvbnxjb29raWV8cGFzc3dvcmR8cGFzc3BocmFzZXxzZWNyZXR8dG9rZW58bWFzdGVya2V5fHByaXZhdGVrZXl8YXBpWy1fXT9rZXl8cmVjZWlwdHxzaWduZWQoPzpwYXlsb2FkfHRyYW5zYWN0aW9uKS9pO1xuY29uc3QgaW5jb21pbmdSZXF1ZXN0U3BhbiA9IFN5bWJvbC5mb3IoJ21hcHN0ci50ZWxlbWV0cnkuaW5jb21pbmctcmVxdWVzdC1zcGFuJyk7XG5cbmZ1bmN0aW9uIHJlZGFjdEJ1ZmZlcnMob2JqKSB7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqKSkge1xuICAgIHJldHVybiBgW0J1ZmZlcjogJHtvYmoubGVuZ3RofSBieXRlc11gO1xuICB9XG4gIGlmIChVdGlscy5pc0RhdGUob2JqKSAmJiAhTnVtYmVyLmlzTmFOKG9iai5nZXRUaW1lKCkpKSB7XG4gICAgcmV0dXJuIG9iai50b0lTT1N0cmluZygpO1xuICB9XG4gIGlmIChVdGlscy5pc1JlZ0V4cChvYmopKSB7XG4gICAgcmV0dXJuIG9iai50b1N0cmluZygpO1xuICB9XG4gIGlmIChvYmogJiYgdHlwZW9mIG9iai50b0hleFN0cmluZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBvYmoudG9IZXhTdHJpbmcoKTtcbiAgfVxuICBpZiAodHlwZW9mIG9iaiA9PT0gJ2JpZ2ludCcpIHtcbiAgICByZXR1cm4gb2JqLnRvU3RyaW5nKCk7XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgIHJldHVybiBvYmoubWFwKHJlZGFjdEJ1ZmZlcnMpO1xuICB9XG4gIGlmIChvYmogJiYgdHlwZW9mIG9iaiA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhvYmopKSB7XG4gICAgICByZXN1bHRba2V5XSA9IHJlZGFjdEJ1ZmZlcnMob2JqW2tleV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIHJldHVybiBvYmo7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplVHJhY2VQYXJhbXMob2JqLCBrZXksIGRlcHRoID0gMCwgc2VlbiA9IG5ldyBXZWFrU2V0KCkpIHtcbiAgaWYgKGtleSAmJiB0cmFjZVNlY3JldEtleS50ZXN0KGtleSkpIHtcbiAgICByZXR1cm4gJ1tSRURBQ1RFRF0nO1xuICB9XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqKSkge1xuICAgIHJldHVybiBgW0J1ZmZlcjogJHtvYmoubGVuZ3RofSBieXRlc11gO1xuICB9XG4gIGlmIChVdGlscy5pc0RhdGUob2JqKSkge1xuICAgIHJldHVybiBOdW1iZXIuaXNOYU4ob2JqLmdldFRpbWUoKSkgPyBvYmoudG9TdHJpbmcoKSA6IG9iai50b0lTT1N0cmluZygpO1xuICB9XG4gIGlmIChVdGlscy5pc1JlZ0V4cChvYmopKSB7XG4gICAgcmV0dXJuIG9iai50b1N0cmluZygpO1xuICB9XG4gIGlmIChvYmogJiYgdHlwZW9mIG9iai50b0hleFN0cmluZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBvYmoudG9IZXhTdHJpbmcoKTtcbiAgfVxuICBpZiAodHlwZW9mIG9iaiA9PT0gJ2JpZ2ludCcpIHtcbiAgICByZXR1cm4gb2JqLnRvU3RyaW5nKCk7XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgIGlmIChkZXB0aCA+PSAxMCB8fCBzZWVuLmhhcyhvYmopKSB7XG4gICAgICByZXR1cm4gJ1tUUlVOQ0FURURdJztcbiAgICB9XG4gICAgc2Vlbi5hZGQob2JqKTtcbiAgICBjb25zdCB2YWx1ZXMgPSBvYmouc2xpY2UoMCwgMjApLm1hcChpdGVtID0+IHNhbml0aXplVHJhY2VQYXJhbXMoaXRlbSwgdW5kZWZpbmVkLCBkZXB0aCArIDEsIHNlZW4pKTtcbiAgICBpZiAob2JqLmxlbmd0aCA+IHZhbHVlcy5sZW5ndGgpIHtcbiAgICAgIHZhbHVlcy5wdXNoKGBbJHtvYmoubGVuZ3RoIC0gdmFsdWVzLmxlbmd0aH0gbW9yZSB2YWx1ZXNdYCk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZXM7XG4gIH1cbiAgaWYgKG9iaiAmJiB0eXBlb2Ygb2JqID09PSAnb2JqZWN0Jykge1xuICAgIGlmIChkZXB0aCA+PSAxMCB8fCBzZWVuLmhhcyhvYmopKSB7XG4gICAgICByZXR1cm4gJ1tUUlVOQ0FURURdJztcbiAgICB9XG4gICAgc2Vlbi5hZGQob2JqKTtcbiAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICBjb25zdCBwcm9wZXJ0aWVzID0gT2JqZWN0LmtleXMob2JqKS5zbGljZSgwLCAxMDApO1xuICAgIGZvciAoY29uc3QgcHJvcGVydHkgb2YgcHJvcGVydGllcykge1xuICAgICAgcmVzdWx0W3Byb3BlcnR5XSA9IHNhbml0aXplVHJhY2VQYXJhbXMob2JqW3Byb3BlcnR5XSwgcHJvcGVydHksIGRlcHRoICsgMSwgc2Vlbik7XG4gICAgfVxuICAgIGlmIChPYmplY3Qua2V5cyhvYmopLmxlbmd0aCA+IHByb3BlcnRpZXMubGVuZ3RoKSB7XG4gICAgICByZXN1bHQuX190cnVuY2F0ZWQgPSBgJHtPYmplY3Qua2V5cyhvYmopLmxlbmd0aCAtIHByb3BlcnRpZXMubGVuZ3RofSBtb3JlIGtleXNgO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIGlmICh0eXBlb2Ygb2JqID09PSAnc3RyaW5nJyAmJiBvYmoubGVuZ3RoID4gNTAwKSB7XG4gICAgcmV0dXJuIGAke29iai5zdWJzdHJpbmcoMCwgNTAwKX0uLi4gKHRydW5jYXRlZClgO1xuICB9XG4gIHJldHVybiBvYmo7XG59XG5cbmZ1bmN0aW9uIHNlcmlhbGl6ZVRyYWNlUGFyYW1zKHBhcmFtcykge1xuICBjb25zdCBzZXJpYWxpemVkID0gSlNPTi5zdHJpbmdpZnkoc2FuaXRpemVUcmFjZVBhcmFtcyhwYXJhbXMpKTtcbiAgcmV0dXJuIHNlcmlhbGl6ZWQubGVuZ3RoID4gMTAwMDAgPyBgJHtzZXJpYWxpemVkLnN1YnN0cmluZygwLCAxMDAwMCl9Li4uICh0cnVuY2F0ZWQpYCA6IHNlcmlhbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHBhcnNlT2JqZWN0KG9iaiwgY29uZmlnKSB7XG4gIGlmIChBcnJheS5pc0FycmF5KG9iaikpIHtcbiAgICByZXR1cm4gb2JqLm1hcChpdGVtID0+IHtcbiAgICAgIHJldHVybiBwYXJzZU9iamVjdChpdGVtLCBjb25maWcpO1xuICAgIH0pO1xuICB9IGVsc2UgaWYgKG9iaiAmJiBvYmouX190eXBlID09ICdEYXRlJykge1xuICAgIHJldHVybiBPYmplY3QuYXNzaWduKG5ldyBEYXRlKG9iai5pc28pLCBvYmopO1xuICB9IGVsc2UgaWYgKG9iaiAmJiBvYmouX190eXBlID09ICdGaWxlJykge1xuICAgIGlmIChvYmoudXJsKSB7XG4gICAgICBjb25zdCB7IHZhbGlkYXRlRmlsZVVybCB9ID0gcmVxdWlyZSgnLi4vRmlsZVVybFZhbGlkYXRvcicpO1xuICAgICAgdmFsaWRhdGVGaWxlVXJsKG9iai51cmwsIGNvbmZpZyk7XG4gICAgfVxuICAgIHJldHVybiBQYXJzZS5GaWxlLmZyb21KU09OKG9iaik7XG4gIH0gZWxzZSBpZiAob2JqICYmIG9iai5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgcmV0dXJuIFBhcnNlLk9iamVjdC5mcm9tSlNPTih7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogb2JqLmNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiBvYmoub2JqZWN0SWQsXG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoQnVmZmVyLmlzQnVmZmVyKG9iaikpIHtcbiAgICByZXR1cm4gb2JqO1xuICB9IGVsc2UgaWYgKG9iaiAmJiB0eXBlb2Ygb2JqID09PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiBwYXJzZVBhcmFtcyhvYmosIGNvbmZpZyk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIG9iajtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVBhcmFtcyhwYXJhbXMsIGNvbmZpZykge1xuICByZXR1cm4gXy5tYXBWYWx1ZXMocGFyYW1zLCBpdGVtID0+IHBhcnNlT2JqZWN0KGl0ZW0sIGNvbmZpZykpO1xufVxuXG5leHBvcnQgY2xhc3MgRnVuY3Rpb25zUm91dGVyIGV4dGVuZHMgUHJvbWlzZVJvdXRlciB7XG4gIG1vdW50Um91dGVzKCkge1xuICAgIHRoaXMucm91dGUoXG4gICAgICAnUE9TVCcsXG4gICAgICAnL2Z1bmN0aW9ucy86ZnVuY3Rpb25OYW1lJyxcbiAgICAgIHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSxcbiAgICAgIEZ1bmN0aW9uc1JvdXRlci5tdWx0aXBhcnRNaWRkbGV3YXJlLFxuICAgICAgRnVuY3Rpb25zUm91dGVyLmhhbmRsZUNsb3VkRnVuY3Rpb25cbiAgICApO1xuICAgIHRoaXMucm91dGUoXG4gICAgICAnUE9TVCcsXG4gICAgICAnL2pvYnMvOmpvYk5hbWUnLFxuICAgICAgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5LFxuICAgICAgcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MsXG4gICAgICBmdW5jdGlvbiAocmVxKSB7XG4gICAgICAgIHJldHVybiBGdW5jdGlvbnNSb3V0ZXIuaGFuZGxlQ2xvdWRKb2IocmVxKTtcbiAgICAgIH1cbiAgICApO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL2pvYnMnLCBwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcywgZnVuY3Rpb24gKHJlcSkge1xuICAgICAgcmV0dXJuIEZ1bmN0aW9uc1JvdXRlci5oYW5kbGVDbG91ZEpvYihyZXEpO1xuICAgIH0pO1xuICB9XG5cbiAgc3RhdGljIGhhbmRsZUNsb3VkSm9iKHJlcSkge1xuICAgIGlmIChyZXEuYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgXCJyZWFkLW9ubHkgbWFzdGVyS2V5IGlzbid0IGFsbG93ZWQgdG8gcnVuIGEgam9iLlwiLFxuICAgICAgICByZXEuY29uZmlnXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBqb2JOYW1lID0gcmVxLnBhcmFtcy5qb2JOYW1lIHx8IHJlcS5ib2R5Py5qb2JOYW1lO1xuICAgIGNvbnN0IGFwcGxpY2F0aW9uSWQgPSByZXEuY29uZmlnLmFwcGxpY2F0aW9uSWQ7XG4gICAgY29uc3Qgam9iSGFuZGxlciA9IGpvYlN0YXR1c0hhbmRsZXIocmVxLmNvbmZpZyk7XG4gICAgY29uc3Qgam9iRnVuY3Rpb24gPSB0cmlnZ2Vycy5nZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG4gICAgaWYgKCFqb2JGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsICdJbnZhbGlkIGpvYi4nKTtcbiAgICB9XG4gICAgbGV0IHBhcmFtcyA9IE9iamVjdC5hc3NpZ24oe30sIHJlcS5ib2R5LCByZXEucXVlcnkpO1xuICAgIHBhcmFtcyA9IHBhcnNlUGFyYW1zKHBhcmFtcywgcmVxLmNvbmZpZyk7XG4gICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgIHBhcmFtczogcGFyYW1zLFxuICAgICAgbG9nOiByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgICBoZWFkZXJzOiByZXEuY29uZmlnLmhlYWRlcnMsXG4gICAgICBpcDogcmVxLmNvbmZpZy5pcCxcbiAgICAgIGpvYk5hbWUsXG4gICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICBtZXNzYWdlOiBqb2JIYW5kbGVyLnNldE1lc3NhZ2UuYmluZChqb2JIYW5kbGVyKSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIGpvYkhhbmRsZXIuc2V0UnVubmluZyhqb2JOYW1lKS50aGVuKGpvYlN0YXR1cyA9PiB7XG4gICAgICByZXF1ZXN0LmpvYklkID0gam9iU3RhdHVzLm9iamVjdElkO1xuICAgICAgLy8gcnVuIHRoZSBmdW5jdGlvbiBhc3luY1xuICAgICAgcHJvY2Vzcy5uZXh0VGljaygoKSA9PiB7XG4gICAgICAgIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGpvYkZ1bmN0aW9uKHJlcXVlc3QpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4oXG4gICAgICAgICAgICByZXN1bHQgPT4ge1xuICAgICAgICAgICAgICBqb2JIYW5kbGVyLnNldFN1Y2NlZWRlZChyZXN1bHQpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGVycm9yID0+IHtcbiAgICAgICAgICAgICAgam9iSGFuZGxlci5zZXRGYWlsZWQoZXJyb3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnWC1QYXJzZS1Kb2ItU3RhdHVzLUlkJzogam9iU3RhdHVzLm9iamVjdElkLFxuICAgICAgICB9LFxuICAgICAgICByZXNwb25zZToge30sXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZVJlc3BvbnNlT2JqZWN0KHJlc29sdmUsIHJlamVjdCwgc3RhdHVzQ29kZSA9IG51bGwpIHtcbiAgICBsZXQgaHR0cFN0YXR1c0NvZGUgPSBzdGF0dXNDb2RlO1xuICAgIGNvbnN0IGN1c3RvbUhlYWRlcnMgPSB7fTtcbiAgICBsZXQgcmVzcG9uc2VTZW50ID0gZmFsc2U7XG4gICAgY29uc3QgcmVzcG9uc2VPYmplY3QgPSB7XG4gICAgICBzdWNjZXNzOiBmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgICAgIGlmIChyZXNwb25zZVNlbnQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBjYWxsIHN1Y2Nlc3MoKSBhZnRlciByZXNwb25zZSBoYXMgYWxyZWFkeSBiZWVuIHNlbnQuIE1ha2Ugc3VyZSB0byBjYWxsIHN1Y2Nlc3MoKSBvciBlcnJvcigpIG9ubHkgb25jZSBwZXIgY2xvdWQgZnVuY3Rpb24gZXhlY3V0aW9uLicpO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlU2VudCA9IHRydWU7XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0ge1xuICAgICAgICAgIHJlc3BvbnNlOiB7XG4gICAgICAgICAgICByZXN1bHQ6IFBhcnNlLl9lbmNvZGUocmVzdWx0KSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgICBpZiAoaHR0cFN0YXR1c0NvZGUgIT09IG51bGwpIHtcbiAgICAgICAgICByZXNwb25zZS5zdGF0dXMgPSBodHRwU3RhdHVzQ29kZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoT2JqZWN0LmtleXMoY3VzdG9tSGVhZGVycykubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHJlc3BvbnNlLmhlYWRlcnMgPSBjdXN0b21IZWFkZXJzO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfSxcbiAgICAgIGVycm9yOiBmdW5jdGlvbiAobWVzc2FnZSkge1xuICAgICAgICBpZiAocmVzcG9uc2VTZW50KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgY2FsbCBlcnJvcigpIGFmdGVyIHJlc3BvbnNlIGhhcyBhbHJlYWR5IGJlZW4gc2VudC4gTWFrZSBzdXJlIHRvIGNhbGwgc3VjY2VzcygpIG9yIGVycm9yKCkgb25seSBvbmNlIHBlciBjbG91ZCBmdW5jdGlvbiBleGVjdXRpb24uJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2VTZW50ID0gdHJ1ZTtcbiAgICAgICAgbGV0IGVycm9yO1xuICAgICAgICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICAgICAgZXJyb3IgPSBtZXNzYWdlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxldCBjb2RlID0gUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRDtcbiAgICAgICAgICBpZiAodHlwZW9mIG1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICBlcnJvciA9IG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKFV0aWxzLmlzTmF0aXZlRXJyb3IobWVzc2FnZSkpIHtcbiAgICAgICAgICAgICAgbWVzc2FnZSA9IG1lc3NhZ2UubWVzc2FnZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgVXRpbHMuaXNPYmplY3QobWVzc2FnZSkgJiZcbiAgICAgICAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG1lc3NhZ2UsICdjb2RlJykgJiZcbiAgICAgICAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG1lc3NhZ2UsICdtZXNzYWdlJylcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICBjb2RlID0gbWVzc2FnZS5jb2RlO1xuICAgICAgICAgICAgICBtZXNzYWdlID0gbWVzc2FnZS5tZXNzYWdlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFV0aWxzLmlzT2JqZWN0KG1lc3NhZ2UpKSB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgbWVzc2FnZSA9IEpTT04uc3RyaW5naWZ5KG1lc3NhZ2UpO1xuICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvLyBJZ25vcmUgc2VyaWFsaXphdGlvbiBlcnJvcnMuXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGVycm9yID0gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyBJZiBhIGN1c3RvbSBzdGF0dXMgY29kZSB3YXMgc2V0LCBhdHRhY2ggaXQgdG8gdGhlIGVycm9yXG4gICAgICAgIGlmIChodHRwU3RhdHVzQ29kZSAhPT0gbnVsbCkge1xuICAgICAgICAgIGVycm9yLnN0YXR1cyA9IGh0dHBTdGF0dXNDb2RlO1xuICAgICAgICB9XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9LFxuICAgICAgc3RhdHVzOiBmdW5jdGlvbiAoY29kZSkge1xuICAgICAgICBodHRwU3RhdHVzQ29kZSA9IGNvZGU7XG4gICAgICAgIHJldHVybiByZXNwb25zZU9iamVjdDtcbiAgICAgIH0sXG4gICAgICBoZWFkZXI6IGZ1bmN0aW9uIChrZXksIHZhbHVlKSB7XG4gICAgICAgIGN1c3RvbUhlYWRlcnNba2V5XSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gcmVzcG9uc2VPYmplY3Q7XG4gICAgICB9LFxuICAgICAgX2lzUmVzcG9uc2VTZW50OiAoKSA9PiByZXNwb25zZVNlbnQsXG4gICAgfTtcbiAgICByZXR1cm4gcmVzcG9uc2VPYmplY3Q7XG4gIH1cblxuICAvKipcbiAgICogUGFyc2VzIG11bHRpcGFydC9mb3JtLWRhdGEgcmVxdWVzdHMgZm9yIENsb3VkIEZ1bmN0aW9uIGludm9jYXRpb24uXG4gICAqIEZvciBub24tbXVsdGlwYXJ0IHJlcXVlc3RzLCB0aGlzIGlzIGEgbm8tb3AuXG4gICAqXG4gICAqIFRleHQgZmllbGRzIGFyZSBzZXQgYXMgc3RyaW5ncyBpbiBgcmVxLmJvZHlgLiBGaWxlIGZpZWxkcyBhcmUgc2V0IGFzXG4gICAqIG9iamVjdHMgd2l0aCB0aGUgc2hhcGUgYHsgZmlsZW5hbWU6IHN0cmluZywgY29udGVudFR5cGU6IHN0cmluZywgZGF0YTogQnVmZmVyIH1gLlxuICAgKiBBbGwgZmllbGRzIGFyZSBtZXJnZWQgZmxhdCBpbnRvIGByZXEuYm9keWA7IHRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yXG4gICAqIGF2b2lkaW5nIG5hbWUgY29sbGlzaW9ucyBiZXR3ZWVuIHRleHQgYW5kIGZpbGUgZmllbGRzLlxuICAgKlxuICAgKiBUaGUgdG90YWwgcmVxdWVzdCBzaXplIGlzIGxpbWl0ZWQgYnkgdGhlIHNlcnZlcidzIGBtYXhVcGxvYWRTaXplYCBvcHRpb24uXG4gICAqL1xuICBzdGF0aWMgbXVsdGlwYXJ0TWlkZGxld2FyZShyZXEpIHtcbiAgICBpZiAoIXJlcS5pcyB8fCAhcmVxLmlzKCdtdWx0aXBhcnQvZm9ybS1kYXRhJykpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgbWF4Qnl0ZXMgPSBVdGlscy5wYXJzZVNpemVUb0J5dGVzKHJlcS5jb25maWcubWF4VXBsb2FkU2l6ZSk7XG4gICAgLy8gUmVqZWN0IGVhcmx5IHdoZW4gdGhlIGRlY2xhcmVkIHJlcXVlc3Qgc2l6ZSBhbHJlYWR5IGV4Y2VlZHMgdGhlIGxpbWl0LlxuICAgIGNvbnN0IGNvbnRlbnRMZW5ndGggPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2NvbnRlbnQtbGVuZ3RoJ10pO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoY29udGVudExlbmd0aCkgJiYgY29udGVudExlbmd0aCA+IG1heEJ5dGVzKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfVE9PX0xBUkdFLFxuICAgICAgICAgICdNdWx0aXBhcnQgcmVxdWVzdCBleGNlZWRzIG1heGltdW0gdXBsb2FkIHNpemUuJ1xuICAgICAgICApXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgICAgIGxldCB0b3RhbEJ5dGVzID0gMDtcbiAgICAgIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gICAgICBsZXQgYnVzYm95O1xuICAgICAgdHJ5IHtcbiAgICAgICAgYnVzYm95ID0gQnVzYm95KHsgaGVhZGVyczogcmVxLmhlYWRlcnMsIGxpbWl0czogeyBmaWVsZFNpemU6IG1heEJ5dGVzIH0gfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHJlamVjdChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgSW52YWxpZCBtdWx0aXBhcnQgcmVxdWVzdDogJHtlcnIubWVzc2FnZX1gKVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3Qgc2FmZVJlamVjdCA9IGVyciA9PiB7XG4gICAgICAgIGlmIChzZXR0bGVkKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICByZXEudW5waXBlKGJ1c2JveSk7XG4gICAgICAgIGJ1c2JveS5kZXN0cm95KCk7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfTtcbiAgICAgIGJ1c2JveS5vbignZmllbGQnLCAobmFtZSwgdmFsdWUsIGZpZWxkbmFtZVRydW5jYXRlZCwgdmFsdWVUcnVuY2F0ZWQpID0+IHtcbiAgICAgICAgaWYgKHZhbHVlVHJ1bmNhdGVkKSB7XG4gICAgICAgICAgcmV0dXJuIHNhZmVSZWplY3QoXG4gICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9UT09fTEFSR0UsXG4gICAgICAgICAgICAgICdNdWx0aXBhcnQgcmVxdWVzdCBleGNlZWRzIG1heGltdW0gdXBsb2FkIHNpemUuJ1xuICAgICAgICAgICAgKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdG90YWxCeXRlcyArPSBCdWZmZXIuYnl0ZUxlbmd0aCh2YWx1ZSk7XG4gICAgICAgIGlmICh0b3RhbEJ5dGVzID4gbWF4Qnl0ZXMpIHtcbiAgICAgICAgICByZXR1cm4gc2FmZVJlamVjdChcbiAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX1RPT19MQVJHRSxcbiAgICAgICAgICAgICAgJ011bHRpcGFydCByZXF1ZXN0IGV4Y2VlZHMgbWF4aW11bSB1cGxvYWQgc2l6ZS4nXG4gICAgICAgICAgICApXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBmaWVsZHNbbmFtZV0gPSB2YWx1ZTtcbiAgICAgIH0pO1xuICAgICAgYnVzYm95Lm9uKCdmaWxlJywgKG5hbWUsIHN0cmVhbSwgZmlsZW5hbWUsIHRyYW5zZmVyRW5jb2RpbmcsIG1pbWVUeXBlKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rcyA9IFtdO1xuICAgICAgICBzdHJlYW0ub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICAgICAgdG90YWxCeXRlcyArPSBjaHVuay5sZW5ndGg7XG4gICAgICAgICAgaWYgKHRvdGFsQnl0ZXMgPiBtYXhCeXRlcykge1xuICAgICAgICAgICAgc3RyZWFtLmRlc3Ryb3koKTtcbiAgICAgICAgICAgIHJldHVybiBzYWZlUmVqZWN0KFxuICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX1RPT19MQVJHRSxcbiAgICAgICAgICAgICAgICAnTXVsdGlwYXJ0IHJlcXVlc3QgZXhjZWVkcyBtYXhpbXVtIHVwbG9hZCBzaXplLidcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgICAgICB9KTtcbiAgICAgICAgc3RyZWFtLm9uKCdlbmQnLCAoKSA9PiB7XG4gICAgICAgICAgaWYgKHNldHRsZWQpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgZmllbGRzW25hbWVdID0ge1xuICAgICAgICAgICAgZmlsZW5hbWUsXG4gICAgICAgICAgICBjb250ZW50VHlwZTogbWltZVR5cGUgfHwgJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScsXG4gICAgICAgICAgICBkYXRhOiBCdWZmZXIuY29uY2F0KGNodW5rcyksXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICAgIGJ1c2JveS5vbignZmluaXNoJywgKCkgPT4ge1xuICAgICAgICBpZiAoc2V0dGxlZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgcmVxLmJvZHkgPSBmaWVsZHM7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgICAgYnVzYm95Lm9uKCdlcnJvcicsIGVyciA9PiB7XG4gICAgICAgIHNhZmVSZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYEludmFsaWQgbXVsdGlwYXJ0IHJlcXVlc3Q6ICR7ZXJyLm1lc3NhZ2V9YClcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgICAgLy8gRW5mb3JjZSBgbWF4VXBsb2FkU2l6ZWAgYWdhaW5zdCB0aGUgcmF3IHJlcXVlc3QgYnl0ZXMgKG11bHRpcGFydFxuICAgICAgLy8gYm91bmRhcmllcywgcGFydCBoZWFkZXJzLCBmaWVsZCBuYW1lcyBhbmQgcGFydCBjb3VudCBpbmNsdWRlZCksIG5vdCBvbmx5XG4gICAgICAvLyB0aGUgcGFyc2VkIGZpZWxkIHZhbHVlcyBhbmQgZmlsZSBjb250ZW50cy4gVGhpcyBtaXJyb3JzIGhvd1xuICAgICAgLy8gYGV4cHJlc3MuanNvbmAgYm91bmRzIG5vbi1tdWx0aXBhcnQgYm9kaWVzIGFuZCBzdG9wcyBhIHJlcXVlc3QgY29tcG9zZWRcbiAgICAgIC8vIG9mIG1hbnkgZW1wdHkgcGFydHMgZnJvbSBleGNlZWRpbmcgdGhlIGxpbWl0IG9uIHRoZSB3aXJlLlxuICAgICAgbGV0IHJhd0J5dGVzID0gMDtcbiAgICAgIHJlcS5vbignZGF0YScsIGNodW5rID0+IHtcbiAgICAgICAgcmF3Qnl0ZXMgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICBpZiAocmF3Qnl0ZXMgPiBtYXhCeXRlcykge1xuICAgICAgICAgIHNhZmVSZWplY3QoXG4gICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9UT09fTEFSR0UsXG4gICAgICAgICAgICAgICdNdWx0aXBhcnQgcmVxdWVzdCBleGNlZWRzIG1heGltdW0gdXBsb2FkIHNpemUuJ1xuICAgICAgICAgICAgKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgcmVxLnBpcGUoYnVzYm95KTtcbiAgICB9KTtcbiAgfVxuXG4gIHN0YXRpYyBoYW5kbGVDbG91ZEZ1bmN0aW9uKHJlcSkge1xuICAgIGNvbnN0IGZ1bmN0aW9uTmFtZSA9IHJlcS5wYXJhbXMuZnVuY3Rpb25OYW1lO1xuICAgIGNvbnN0IGFwcGxpY2F0aW9uSWQgPSByZXEuY29uZmlnLmFwcGxpY2F0aW9uSWQ7XG4gICAgY29uc3QgdGhlRnVuY3Rpb24gPSB0cmlnZ2Vycy5nZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuXG4gICAgaWYgKCF0aGVGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsIGBJbnZhbGlkIGZ1bmN0aW9uOiBcIiR7ZnVuY3Rpb25OYW1lfVwiYCk7XG4gICAgfVxuICAgIGxldCBwYXJhbXMgPSBPYmplY3QuYXNzaWduKHt9LCByZXEuYm9keSwgcmVxLnF1ZXJ5KTtcbiAgICBwYXJhbXMgPSBwYXJzZVBhcmFtcyhwYXJhbXMsIHJlcS5jb25maWcpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBwYXJhbXM6IHBhcmFtcyxcbiAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgIG1hc3RlcjogcmVxLmF1dGggJiYgcmVxLmF1dGguaXNNYXN0ZXIsXG4gICAgICBpc1JlYWRPbmx5OiAhIShyZXEuYXV0aCAmJiByZXEuYXV0aC5pc1JlYWRPbmx5KSxcbiAgICAgIHVzZXI6IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBsb2c6IHJlcS5jb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICAgIGhlYWRlcnM6IHJlcS5jb25maWcuaGVhZGVycyxcbiAgICAgIGlwOiByZXEuY29uZmlnLmlwLFxuICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgY29udGV4dDogcmVxLmluZm8uY29udGV4dCxcbiAgICB9O1xuXG4gICAgbGV0IGFjdGl2ZVNwYW47XG4gICAgdHJ5IHtcbiAgICAgIGFjdGl2ZVNwYW4gPSByZXFbaW5jb21pbmdSZXF1ZXN0U3Bhbl0gfHwgdHJhY2UuZ2V0QWN0aXZlU3BhbigpO1xuICAgICAgaWYgKGFjdGl2ZVNwYW4/LmlzUmVjb3JkaW5nKCkpIHtcbiAgICAgICAgaWYgKHJlcXVlc3QudXNlciAmJiByZXF1ZXN0LnVzZXIuaWQpIHtcbiAgICAgICAgICBhY3RpdmVTcGFuLnNldEF0dHJpYnV0ZSgnZW5kdXNlci5pZCcsIHJlcXVlc3QudXNlci5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgYWN0aXZlU3Bhbi5zZXRBdHRyaWJ1dGUoJ3BhcnNlLmZ1bmN0aW9uLm5hbWUnLCBmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhY3RpdmVTcGFuLnNldEF0dHJpYnV0ZSgncGFyc2UuZnVuY3Rpb24ucGFyYW1zJywgc2VyaWFsaXplVHJhY2VQYXJhbXMocGFyYW1zKSk7XG4gICAgICAgIGFjdGl2ZVNwYW4uc2V0QXR0cmlidXRlKCdhd3MueHJheS5hbm5vdGF0aW9ucycsIFsncGFyc2UuZnVuY3Rpb24ubmFtZSddKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElnbm9yZSB0cmFjaW5nIGVycm9ycy5cbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgY29uc3QgdXNlclN0cmluZyA9IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIgPyByZXEuYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVkYWN0QnVmZmVycyhwYXJhbXMpKSk7XG4gICAgICBjb25zdCByZXNwb25zZU9iamVjdCA9IEZ1bmN0aW9uc1JvdXRlci5jcmVhdGVSZXNwb25zZU9iamVjdChcbiAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHJlcS5jb25maWcubG9nTGV2ZWxzLmNsb3VkRnVuY3Rpb25TdWNjZXNzICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0LnJlc3BvbnNlLnJlc3VsdCkpO1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvblN1Y2Nlc3NdKFxuICAgICAgICAgICAgICAgIGBSYW4gY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmVqZWN0KGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgZXJyb3IgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoYWN0aXZlU3Bhbikge1xuICAgICAgICAgICAgICBhY3RpdmVTcGFuLnJlY29yZEV4Y2VwdGlvbihlcnJvcik7XG4gICAgICAgICAgICAgIGFjdGl2ZVNwYW4uc2V0U3RhdHVzKHsgY29kZTogU3BhblN0YXR1c0NvZGUuRVJST1IsIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yXShcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHJ1bm5pbmcgY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZXJyb3IpLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJlamVjdChlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSByZXNwb25zZU9iamVjdDtcblxuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgZnVuY3Rpb25OYW1lLCByZXEuYXV0aCk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAvLyBDaGVjayBpZiBmdW5jdGlvbiBleHBlY3RzIDIgcGFyYW1ldGVycyAocmVxLCByZXMpIC0gRXhwcmVzcyBzdHlsZVxuICAgICAgICAgIGlmICh0aGVGdW5jdGlvbi5sZW5ndGggPj0gMikge1xuICAgICAgICAgICAgcmV0dXJuIHRoZUZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlT2JqZWN0KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVHJhZGl0aW9uYWwgc3R5bGUgLSBzaW5nbGUgcGFyYW1ldGVyXG4gICAgICAgICAgICByZXR1cm4gdGhlRnVuY3Rpb24ocmVxdWVzdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgIC8vIEZvciBFeHByZXNzLXN0eWxlIGZ1bmN0aW9ucywgb25seSBzZW5kIHJlc3BvbnNlIGlmIG5vdCBhbHJlYWR5IHNlbnRcbiAgICAgICAgICBpZiAodGhlRnVuY3Rpb24ubGVuZ3RoID49IDIpIHtcbiAgICAgICAgICAgIGlmICghcmVzcG9uc2VPYmplY3QuX2lzUmVzcG9uc2VTZW50KCkpIHtcbiAgICAgICAgICAgICAgLy8gSWYgRXhwcmVzcy1zdHlsZSBmdW5jdGlvbiByZXR1cm5zIGEgdmFsdWUgd2l0aG91dCBjYWxsaW5nIHJlcy5zdWNjZXNzL2Vycm9yXG4gICAgICAgICAgICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHN1Y2Nlc3MocmVzdWx0KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyBJZiBubyByZXNwb25zZSBzZW50IGFuZCBubyB2YWx1ZSByZXR1cm5lZCwgdGhpcyBpcyBhbiBlcnJvciBpbiB1c2VyIGNvZGVcbiAgICAgICAgICAgICAgLy8gYnV0IHdlIGRvbid0IGhhbmRsZSBpdCBoZXJlIHRvIG1haW50YWluIGJhY2t3YXJkIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gRm9yIHRyYWRpdGlvbmFsIGZ1bmN0aW9ucywgYWx3YXlzIGNhbGwgc3VjY2VzcyB3aXRoIHRoZSByZXN1bHQgKGV2ZW4gaWYgdW5kZWZpbmVkKVxuICAgICAgICAgICAgc3VjY2VzcyhyZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgZXJyb3IpO1xuICAgIH0pO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUtBLElBQUFBLGNBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLFlBQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLGNBQUEsR0FBQUYsT0FBQTtBQUNBLElBQUFHLE9BQUEsR0FBQUosc0JBQUEsQ0FBQUMsT0FB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