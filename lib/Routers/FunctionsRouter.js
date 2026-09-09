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
const traceSecretKey = /authorization|cookie|password|passphrase|secret|token|masterkey|privatekey|api[-_]?key/i;
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
      const cleanInput = JSON.stringify(redactBuffers(params));
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUHJvbWlzZVJvdXRlciIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX21pZGRsZXdhcmVzIiwiX1N0YXR1c0hhbmRsZXIiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9FcnJvciIsIl9idXNib3kiLCJfVXRpbHMiLCJfYXBpIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUGFyc2UiLCJ0cmlnZ2VycyIsInRyYWNlU2VjcmV0S2V5IiwiaW5jb21pbmdSZXF1ZXN0U3BhbiIsIlN5bWJvbCIsImZvciIsInJlZGFjdEJ1ZmZlcnMiLCJvYmoiLCJCdWZmZXIiLCJpc0J1ZmZlciIsImxlbmd0aCIsIlV0aWxzIiwiaXNEYXRlIiwidG9JU09TdHJpbmciLCJpc1JlZ0V4cCIsInRvU3RyaW5nIiwidG9IZXhTdHJpbmciLCJBcnJheSIsImlzQXJyYXkiLCJtYXAiLCJyZXN1bHQiLCJrZXkiLCJPYmplY3QiLCJrZXlzIiwic2FuaXRpemVUcmFjZVBhcmFtcyIsImRlcHRoIiwic2VlbiIsIldlYWtTZXQiLCJ0ZXN0IiwiaGFzIiwiYWRkIiwidmFsdWVzIiwic2xpY2UiLCJpdGVtIiwidW5kZWZpbmVkIiwicHVzaCIsInByb3BlcnRpZXMiLCJwcm9wZXJ0eSIsIl9fdHJ1bmNhdGVkIiwic3Vic3RyaW5nIiwic2VyaWFsaXplVHJhY2VQYXJhbXMiLCJwYXJhbXMiLCJzZXJpYWxpemVkIiwiSlNPTiIsInN0cmluZ2lmeSIsInBhcnNlT2JqZWN0IiwiY29uZmlnIiwiX190eXBlIiwiYXNzaWduIiwiRGF0ZSIsImlzbyIsInVybCIsInZhbGlkYXRlRmlsZVVybCIsIkZpbGUiLCJmcm9tSlNPTiIsImNsYXNzTmFtZSIsIm9iamVjdElkIiwicGFyc2VQYXJhbXMiLCJfIiwibWFwVmFsdWVzIiwiRnVuY3Rpb25zUm91dGVyIiwiUHJvbWlzZVJvdXRlciIsIm1vdW50Um91dGVzIiwicm91dGUiLCJwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kiLCJtdWx0aXBhcnRNaWRkbGV3YXJlIiwiaGFuZGxlQ2xvdWRGdW5jdGlvbiIsInByb21pc2VFbmZvcmNlTWFzdGVyS2V5QWNjZXNzIiwicmVxIiwiaGFuZGxlQ2xvdWRKb2IiLCJhdXRoIiwiaXNSZWFkT25seSIsImNyZWF0ZVNhbml0aXplZEVycm9yIiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiam9iTmFtZSIsImJvZHkiLCJhcHBsaWNhdGlvbklkIiwiam9iSGFuZGxlciIsImpvYlN0YXR1c0hhbmRsZXIiLCJqb2JGdW5jdGlvbiIsImdldEpvYiIsIlNDUklQVF9GQUlMRUQiLCJxdWVyeSIsInJlcXVlc3QiLCJsb2ciLCJsb2dnZXJDb250cm9sbGVyIiwiaGVhZGVycyIsImlwIiwibWVzc2FnZSIsInNldE1lc3NhZ2UiLCJiaW5kIiwic2V0UnVubmluZyIsInRoZW4iLCJqb2JTdGF0dXMiLCJqb2JJZCIsInByb2Nlc3MiLCJuZXh0VGljayIsIlByb21pc2UiLCJyZXNvbHZlIiwic2V0U3VjY2VlZGVkIiwiZXJyb3IiLCJzZXRGYWlsZWQiLCJyZXNwb25zZSIsImNyZWF0ZVJlc3BvbnNlT2JqZWN0IiwicmVqZWN0Iiwic3RhdHVzQ29kZSIsImh0dHBTdGF0dXNDb2RlIiwiY3VzdG9tSGVhZGVycyIsInJlc3BvbnNlU2VudCIsInJlc3BvbnNlT2JqZWN0Iiwic3VjY2VzcyIsIl9lbmNvZGUiLCJzdGF0dXMiLCJjb2RlIiwiaXNOYXRpdmVFcnJvciIsImlzT2JqZWN0IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiaGVhZGVyIiwidmFsdWUiLCJfaXNSZXNwb25zZVNlbnQiLCJpcyIsIm1heEJ5dGVzIiwicGFyc2VTaXplVG9CeXRlcyIsIm1heFVwbG9hZFNpemUiLCJmaWVsZHMiLCJjcmVhdGUiLCJ0b3RhbEJ5dGVzIiwic2V0dGxlZCIsImJ1c2JveSIsIkJ1c2JveSIsImxpbWl0cyIsImZpZWxkU2l6ZSIsImVyciIsIklOVkFMSURfSlNPTiIsInNhZmVSZWplY3QiLCJkZXN0cm95Iiwib24iLCJuYW1lIiwiZmllbGRuYW1lVHJ1bmNhdGVkIiwidmFsdWVUcnVuY2F0ZWQiLCJPQkpFQ1RfVE9PX0xBUkdFIiwiYnl0ZUxlbmd0aCIsInN0cmVhbSIsImZpbGVuYW1lIiwidHJhbnNmZXJFbmNvZGluZyIsIm1pbWVUeXBlIiwiY2h1bmtzIiwiY2h1bmsiLCJjb250ZW50VHlwZSIsImRhdGEiLCJjb25jYXQiLCJwaXBlIiwiZnVuY3Rpb25OYW1lIiwidGhlRnVuY3Rpb24iLCJnZXRGdW5jdGlvbiIsIm1hc3RlciIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiaW5mbyIsImNvbnRleHQiLCJhY3RpdmVTcGFuIiwidHJhY2UiLCJnZXRBY3RpdmVTcGFuIiwiaWQiLCJzZXRBdHRyaWJ1dGUiLCJ1c2VyU3RyaW5nIiwiY2xlYW5JbnB1dCIsImxvZ0xldmVscyIsImNsb3VkRnVuY3Rpb25TdWNjZXNzIiwiY2xlYW5SZXN1bHQiLCJsb2dnZXIiLCJ0cnVuY2F0ZUxvZ01lc3NhZ2UiLCJyZWNvcmRFeGNlcHRpb24iLCJzZXRTdGF0dXMiLCJTcGFuU3RhdHVzQ29kZSIsIkVSUk9SIiwiY2xvdWRGdW5jdGlvbkVycm9yIiwibWF5YmVSdW5WYWxpZGF0b3IiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL1JvdXRlcnMvRnVuY3Rpb25zUm91dGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIEZ1bmN0aW9uc1JvdXRlci5qc1xuXG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJykuUGFyc2UsXG4gIHRyaWdnZXJzID0gcmVxdWlyZSgnLi4vdHJpZ2dlcnMnKTtcblxuaW1wb3J0IFByb21pc2VSb3V0ZXIgZnJvbSAnLi4vUHJvbWlzZVJvdXRlcic7XG5pbXBvcnQgeyBwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcywgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5IH0gZnJvbSAnLi4vbWlkZGxld2FyZXMnO1xuaW1wb3J0IHsgam9iU3RhdHVzSGFuZGxlciB9IGZyb20gJy4uL1N0YXR1c0hhbmRsZXInO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgeyBjcmVhdGVTYW5pdGl6ZWRFcnJvciB9IGZyb20gJy4uL0Vycm9yJztcbmltcG9ydCBCdXNib3kgZnJvbSAnQGZhc3RpZnkvYnVzYm95JztcbmltcG9ydCBVdGlscyBmcm9tICcuLi9VdGlscyc7XG5pbXBvcnQgeyBTcGFuU3RhdHVzQ29kZSwgdHJhY2UgfSBmcm9tICdAb3BlbnRlbGVtZXRyeS9hcGknO1xuXG5jb25zdCB0cmFjZVNlY3JldEtleSA9IC9hdXRob3JpemF0aW9ufGNvb2tpZXxwYXNzd29yZHxwYXNzcGhyYXNlfHNlY3JldHx0b2tlbnxtYXN0ZXJrZXl8cHJpdmF0ZWtleXxhcGlbLV9dP2tleS9pO1xuY29uc3QgaW5jb21pbmdSZXF1ZXN0U3BhbiA9IFN5bWJvbC5mb3IoJ21hcHN0ci50ZWxlbWV0cnkuaW5jb21pbmctcmVxdWVzdC1zcGFuJyk7XG5cbmZ1bmN0aW9uIHJlZGFjdEJ1ZmZlcnMob2JqKSB7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqKSkge1xuICAgIHJldHVybiBgW0J1ZmZlcjogJHtvYmoubGVuZ3RofSBieXRlc11gO1xuICB9XG4gIGlmIChVdGlscy5pc0RhdGUob2JqKSkge1xuICAgIHJldHVybiBvYmoudG9JU09TdHJpbmcoKTtcbiAgfVxuICBpZiAoVXRpbHMuaXNSZWdFeHAob2JqKSkge1xuICAgIHJldHVybiBvYmoudG9TdHJpbmcoKTtcbiAgfVxuICBpZiAob2JqICYmIHR5cGVvZiBvYmoudG9IZXhTdHJpbmcgPT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gb2JqLnRvSGV4U3RyaW5nKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiBvYmogPT09ICdiaWdpbnQnKSB7XG4gICAgcmV0dXJuIG9iai50b1N0cmluZygpO1xuICB9XG4gIGlmIChBcnJheS5pc0FycmF5KG9iaikpIHtcbiAgICByZXR1cm4gb2JqLm1hcChyZWRhY3RCdWZmZXJzKTtcbiAgfVxuICBpZiAob2JqICYmIHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMob2JqKSkge1xuICAgICAgcmVzdWx0W2tleV0gPSByZWRhY3RCdWZmZXJzKG9ialtrZXldKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICByZXR1cm4gb2JqO1xufVxuXG5mdW5jdGlvbiBzYW5pdGl6ZVRyYWNlUGFyYW1zKG9iaiwga2V5LCBkZXB0aCA9IDAsIHNlZW4gPSBuZXcgV2Vha1NldCgpKSB7XG4gIGlmIChrZXkgJiYgdHJhY2VTZWNyZXRLZXkudGVzdChrZXkpKSB7XG4gICAgcmV0dXJuICdbUkVEQUNURURdJztcbiAgfVxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKG9iaikpIHtcbiAgICByZXR1cm4gYFtCdWZmZXI6ICR7b2JqLmxlbmd0aH0gYnl0ZXNdYDtcbiAgfVxuICBpZiAoQXJyYXkuaXNBcnJheShvYmopKSB7XG4gICAgaWYgKGRlcHRoID49IDEwIHx8IHNlZW4uaGFzKG9iaikpIHtcbiAgICAgIHJldHVybiAnW1RSVU5DQVRFRF0nO1xuICAgIH1cbiAgICBzZWVuLmFkZChvYmopO1xuICAgIGNvbnN0IHZhbHVlcyA9IG9iai5zbGljZSgwLCAyMCkubWFwKGl0ZW0gPT4gc2FuaXRpemVUcmFjZVBhcmFtcyhpdGVtLCB1bmRlZmluZWQsIGRlcHRoICsgMSwgc2VlbikpO1xuICAgIGlmIChvYmoubGVuZ3RoID4gdmFsdWVzLmxlbmd0aCkge1xuICAgICAgdmFsdWVzLnB1c2goYFske29iai5sZW5ndGggLSB2YWx1ZXMubGVuZ3RofSBtb3JlIHZhbHVlc11gKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlcztcbiAgfVxuICBpZiAob2JqICYmIHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgaWYgKGRlcHRoID49IDEwIHx8IHNlZW4uaGFzKG9iaikpIHtcbiAgICAgIHJldHVybiAnW1RSVU5DQVRFRF0nO1xuICAgIH1cbiAgICBzZWVuLmFkZChvYmopO1xuICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSBPYmplY3Qua2V5cyhvYmopLnNsaWNlKDAsIDEwMCk7XG4gICAgZm9yIChjb25zdCBwcm9wZXJ0eSBvZiBwcm9wZXJ0aWVzKSB7XG4gICAgICByZXN1bHRbcHJvcGVydHldID0gc2FuaXRpemVUcmFjZVBhcmFtcyhvYmpbcHJvcGVydHldLCBwcm9wZXJ0eSwgZGVwdGggKyAxLCBzZWVuKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKG9iaikubGVuZ3RoID4gcHJvcGVydGllcy5sZW5ndGgpIHtcbiAgICAgIHJlc3VsdC5fX3RydW5jYXRlZCA9IGAke09iamVjdC5rZXlzKG9iaikubGVuZ3RoIC0gcHJvcGVydGllcy5sZW5ndGh9IG1vcmUga2V5c2A7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgaWYgKHR5cGVvZiBvYmogPT09ICdzdHJpbmcnICYmIG9iai5sZW5ndGggPiA1MDApIHtcbiAgICByZXR1cm4gYCR7b2JqLnN1YnN0cmluZygwLCA1MDApfS4uLiAodHJ1bmNhdGVkKWA7XG4gIH1cbiAgcmV0dXJuIG9iajtcbn1cblxuZnVuY3Rpb24gc2VyaWFsaXplVHJhY2VQYXJhbXMocGFyYW1zKSB7XG4gIGNvbnN0IHNlcmlhbGl6ZWQgPSBKU09OLnN0cmluZ2lmeShzYW5pdGl6ZVRyYWNlUGFyYW1zKHBhcmFtcykpO1xuICByZXR1cm4gc2VyaWFsaXplZC5sZW5ndGggPiAxMDAwMCA/IGAke3NlcmlhbGl6ZWQuc3Vic3RyaW5nKDAsIDEwMDAwKX0uLi4gKHRydW5jYXRlZClgIDogc2VyaWFsaXplZDtcbn1cblxuZnVuY3Rpb24gcGFyc2VPYmplY3Qob2JqLCBjb25maWcpIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgIHJldHVybiBvYmoubWFwKGl0ZW0gPT4ge1xuICAgICAgcmV0dXJuIHBhcnNlT2JqZWN0KGl0ZW0sIGNvbmZpZyk7XG4gICAgfSk7XG4gIH0gZWxzZSBpZiAob2JqICYmIG9iai5fX3R5cGUgPT0gJ0RhdGUnKSB7XG4gICAgcmV0dXJuIE9iamVjdC5hc3NpZ24obmV3IERhdGUob2JqLmlzbyksIG9iaik7XG4gIH0gZWxzZSBpZiAob2JqICYmIG9iai5fX3R5cGUgPT0gJ0ZpbGUnKSB7XG4gICAgaWYgKG9iai51cmwpIHtcbiAgICAgIGNvbnN0IHsgdmFsaWRhdGVGaWxlVXJsIH0gPSByZXF1aXJlKCcuLi9GaWxlVXJsVmFsaWRhdG9yJyk7XG4gICAgICB2YWxpZGF0ZUZpbGVVcmwob2JqLnVybCwgY29uZmlnKTtcbiAgICB9XG4gICAgcmV0dXJuIFBhcnNlLkZpbGUuZnJvbUpTT04ob2JqKTtcbiAgfSBlbHNlIGlmIChvYmogJiYgb2JqLl9fdHlwZSA9PSAnUG9pbnRlcicpIHtcbiAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiBvYmouY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IG9iai5vYmplY3RJZCxcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqKSkge1xuICAgIHJldHVybiBvYmo7XG4gIH0gZWxzZSBpZiAob2JqICYmIHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIHBhcnNlUGFyYW1zKG9iaiwgY29uZmlnKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gb2JqO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFyYW1zKHBhcmFtcywgY29uZmlnKSB7XG4gIHJldHVybiBfLm1hcFZhbHVlcyhwYXJhbXMsIGl0ZW0gPT4gcGFyc2VPYmplY3QoaXRlbSwgY29uZmlnKSk7XG59XG5cbmV4cG9ydCBjbGFzcyBGdW5jdGlvbnNSb3V0ZXIgZXh0ZW5kcyBQcm9taXNlUm91dGVyIHtcbiAgbW91bnRSb3V0ZXMoKSB7XG4gICAgdGhpcy5yb3V0ZShcbiAgICAgICdQT1NUJyxcbiAgICAgICcvZnVuY3Rpb25zLzpmdW5jdGlvbk5hbWUnLFxuICAgICAgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5LFxuICAgICAgRnVuY3Rpb25zUm91dGVyLm11bHRpcGFydE1pZGRsZXdhcmUsXG4gICAgICBGdW5jdGlvbnNSb3V0ZXIuaGFuZGxlQ2xvdWRGdW5jdGlvblxuICAgICk7XG4gICAgdGhpcy5yb3V0ZShcbiAgICAgICdQT1NUJyxcbiAgICAgICcvam9icy86am9iTmFtZScsXG4gICAgICBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksXG4gICAgICBwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcyxcbiAgICAgIGZ1bmN0aW9uIChyZXEpIHtcbiAgICAgICAgcmV0dXJuIEZ1bmN0aW9uc1JvdXRlci5oYW5kbGVDbG91ZEpvYihyZXEpO1xuICAgICAgfVxuICAgICk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvam9icycsIHByb21pc2VFbmZvcmNlTWFzdGVyS2V5QWNjZXNzLCBmdW5jdGlvbiAocmVxKSB7XG4gICAgICByZXR1cm4gRnVuY3Rpb25zUm91dGVyLmhhbmRsZUNsb3VkSm9iKHJlcSk7XG4gICAgfSk7XG4gIH1cblxuICBzdGF0aWMgaGFuZGxlQ2xvdWRKb2IocmVxKSB7XG4gICAgaWYgKHJlcS5hdXRoLmlzUmVhZE9ubHkpIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICBcInJlYWQtb25seSBtYXN0ZXJLZXkgaXNuJ3QgYWxsb3dlZCB0byBydW4gYSBqb2IuXCIsXG4gICAgICAgIHJlcS5jb25maWdcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGpvYk5hbWUgPSByZXEucGFyYW1zLmpvYk5hbWUgfHwgcmVxLmJvZHk/LmpvYk5hbWU7XG4gICAgY29uc3QgYXBwbGljYXRpb25JZCA9IHJlcS5jb25maWcuYXBwbGljYXRpb25JZDtcbiAgICBjb25zdCBqb2JIYW5kbGVyID0gam9iU3RhdHVzSGFuZGxlcihyZXEuY29uZmlnKTtcbiAgICBjb25zdCBqb2JGdW5jdGlvbiA9IHRyaWdnZXJzLmdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIWpvYkZ1bmN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCwgJ0ludmFsaWQgam9iLicpO1xuICAgIH1cbiAgICBsZXQgcGFyYW1zID0gT2JqZWN0LmFzc2lnbih7fSwgcmVxLmJvZHksIHJlcS5xdWVyeSk7XG4gICAgcGFyYW1zID0gcGFyc2VQYXJhbXMocGFyYW1zLCByZXEuY29uZmlnKTtcbiAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgcGFyYW1zOiBwYXJhbXMsXG4gICAgICBsb2c6IHJlcS5jb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICAgIGhlYWRlcnM6IHJlcS5jb25maWcuaGVhZGVycyxcbiAgICAgIGlwOiByZXEuY29uZmlnLmlwLFxuICAgICAgam9iTmFtZSxcbiAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgIG1lc3NhZ2U6IGpvYkhhbmRsZXIuc2V0TWVzc2FnZS5iaW5kKGpvYkhhbmRsZXIpLFxuICAgIH07XG5cbiAgICByZXR1cm4gam9iSGFuZGxlci5zZXRSdW5uaW5nKGpvYk5hbWUpLnRoZW4oam9iU3RhdHVzID0+IHtcbiAgICAgIHJlcXVlc3Quam9iSWQgPSBqb2JTdGF0dXMub2JqZWN0SWQ7XG4gICAgICAvLyBydW4gdGhlIGZ1bmN0aW9uIGFzeW5jXG4gICAgICBwcm9jZXNzLm5leHRUaWNrKCgpID0+IHtcbiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gam9iRnVuY3Rpb24ocmVxdWVzdCk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihcbiAgICAgICAgICAgIHJlc3VsdCA9PiB7XG4gICAgICAgICAgICAgIGpvYkhhbmRsZXIuc2V0U3VjY2VlZGVkKHJlc3VsdCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZXJyb3IgPT4ge1xuICAgICAgICAgICAgICBqb2JIYW5kbGVyLnNldEZhaWxlZChlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdYLVBhcnNlLUpvYi1TdGF0dXMtSWQnOiBqb2JTdGF0dXMub2JqZWN0SWQsXG4gICAgICAgIH0sXG4gICAgICAgIHJlc3BvbnNlOiB7fSxcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICBzdGF0aWMgY3JlYXRlUmVzcG9uc2VPYmplY3QocmVzb2x2ZSwgcmVqZWN0LCBzdGF0dXNDb2RlID0gbnVsbCkge1xuICAgIGxldCBodHRwU3RhdHVzQ29kZSA9IHN0YXR1c0NvZGU7XG4gICAgY29uc3QgY3VzdG9tSGVhZGVycyA9IHt9O1xuICAgIGxldCByZXNwb25zZVNlbnQgPSBmYWxzZTtcbiAgICBjb25zdCByZXNwb25zZU9iamVjdCA9IHtcbiAgICAgIHN1Y2Nlc3M6IGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlU2VudCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGNhbGwgc3VjY2VzcygpIGFmdGVyIHJlc3BvbnNlIGhhcyBhbHJlYWR5IGJlZW4gc2VudC4gTWFrZSBzdXJlIHRvIGNhbGwgc3VjY2VzcygpIG9yIGVycm9yKCkgb25seSBvbmNlIHBlciBjbG91ZCBmdW5jdGlvbiBleGVjdXRpb24uJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2VTZW50ID0gdHJ1ZTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7XG4gICAgICAgICAgcmVzcG9uc2U6IHtcbiAgICAgICAgICAgIHJlc3VsdDogUGFyc2UuX2VuY29kZShyZXN1bHQpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICAgIGlmIChodHRwU3RhdHVzQ29kZSAhPT0gbnVsbCkge1xuICAgICAgICAgIHJlc3BvbnNlLnN0YXR1cyA9IGh0dHBTdGF0dXNDb2RlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhjdXN0b21IZWFkZXJzKS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcmVzcG9uc2UuaGVhZGVycyA9IGN1c3RvbUhlYWRlcnM7XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9LFxuICAgICAgZXJyb3I6IGZ1bmN0aW9uIChtZXNzYWdlKSB7XG4gICAgICAgIGlmIChyZXNwb25zZVNlbnQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBjYWxsIGVycm9yKCkgYWZ0ZXIgcmVzcG9uc2UgaGFzIGFscmVhZHkgYmVlbiBzZW50LiBNYWtlIHN1cmUgdG8gY2FsbCBzdWNjZXNzKCkgb3IgZXJyb3IoKSBvbmx5IG9uY2UgcGVyIGNsb3VkIGZ1bmN0aW9uIGV4ZWN1dGlvbi4nKTtcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZVNlbnQgPSB0cnVlO1xuICAgICAgICBsZXQgZXJyb3I7XG4gICAgICAgIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICAgICAgICBlcnJvciA9IG1lc3NhZ2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbGV0IGNvZGUgPSBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVEO1xuICAgICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGVycm9yID0gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoVXRpbHMuaXNOYXRpdmVFcnJvcihtZXNzYWdlKSkge1xuICAgICAgICAgICAgICBtZXNzYWdlID0gbWVzc2FnZS5tZXNzYWdlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBVdGlscy5pc09iamVjdChtZXNzYWdlKSAmJlxuICAgICAgICAgICAgICBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobWVzc2FnZSwgJ2NvZGUnKSAmJlxuICAgICAgICAgICAgICBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobWVzc2FnZSwgJ21lc3NhZ2UnKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIGNvZGUgPSBtZXNzYWdlLmNvZGU7XG4gICAgICAgICAgICAgIG1lc3NhZ2UgPSBtZXNzYWdlLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoVXRpbHMuaXNPYmplY3QobWVzc2FnZSkpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBtZXNzYWdlID0gSlNPTi5zdHJpbmdpZnkobWVzc2FnZSk7XG4gICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIC8vIElnbm9yZSBzZXJpYWxpemF0aW9uIGVycm9ycy5cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIElmIGEgY3VzdG9tIHN0YXR1cyBjb2RlIHdhcyBzZXQsIGF0dGFjaCBpdCB0byB0aGUgZXJyb3JcbiAgICAgICAgaWYgKGh0dHBTdGF0dXNDb2RlICE9PSBudWxsKSB7XG4gICAgICAgICAgZXJyb3Iuc3RhdHVzID0gaHR0cFN0YXR1c0NvZGU7XG4gICAgICAgIH1cbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0sXG4gICAgICBzdGF0dXM6IGZ1bmN0aW9uIChjb2RlKSB7XG4gICAgICAgIGh0dHBTdGF0dXNDb2RlID0gY29kZTtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlT2JqZWN0O1xuICAgICAgfSxcbiAgICAgIGhlYWRlcjogZnVuY3Rpb24gKGtleSwgdmFsdWUpIHtcbiAgICAgICAgY3VzdG9tSGVhZGVyc1trZXldID0gdmFsdWU7XG4gICAgICAgIHJldHVybiByZXNwb25zZU9iamVjdDtcbiAgICAgIH0sXG4gICAgICBfaXNSZXNwb25zZVNlbnQ6ICgpID0+IHJlc3BvbnNlU2VudCxcbiAgICB9O1xuICAgIHJldHVybiByZXNwb25zZU9iamVjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXJzZXMgbXVsdGlwYXJ0L2Zvcm0tZGF0YSByZXF1ZXN0cyBmb3IgQ2xvdWQgRnVuY3Rpb24gaW52b2NhdGlvbi5cbiAgICogRm9yIG5vbi1tdWx0aXBhcnQgcmVxdWVzdHMsIHRoaXMgaXMgYSBuby1vcC5cbiAgICpcbiAgICogVGV4dCBmaWVsZHMgYXJlIHNldCBhcyBzdHJpbmdzIGluIGByZXEuYm9keWAuIEZpbGUgZmllbGRzIGFyZSBzZXQgYXNcbiAgICogb2JqZWN0cyB3aXRoIHRoZSBzaGFwZSBgeyBmaWxlbmFtZTogc3RyaW5nLCBjb250ZW50VHlwZTogc3RyaW5nLCBkYXRhOiBCdWZmZXIgfWAuXG4gICAqIEFsbCBmaWVsZHMgYXJlIG1lcmdlZCBmbGF0IGludG8gYHJlcS5ib2R5YDsgdGhlIGNhbGxlciBpcyByZXNwb25zaWJsZSBmb3JcbiAgICogYXZvaWRpbmcgbmFtZSBjb2xsaXNpb25zIGJldHdlZW4gdGV4dCBhbmQgZmlsZSBmaWVsZHMuXG4gICAqXG4gICAqIFRoZSB0b3RhbCByZXF1ZXN0IHNpemUgaXMgbGltaXRlZCBieSB0aGUgc2VydmVyJ3MgYG1heFVwbG9hZFNpemVgIG9wdGlvbi5cbiAgICovXG4gIHN0YXRpYyBtdWx0aXBhcnRNaWRkbGV3YXJlKHJlcSkge1xuICAgIGlmICghcmVxLmlzIHx8ICFyZXEuaXMoJ211bHRpcGFydC9mb3JtLWRhdGEnKSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCBtYXhCeXRlcyA9IFV0aWxzLnBhcnNlU2l6ZVRvQnl0ZXMocmVxLmNvbmZpZy5tYXhVcGxvYWRTaXplKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgICAgIGxldCB0b3RhbEJ5dGVzID0gMDtcbiAgICAgIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gICAgICBsZXQgYnVzYm95O1xuICAgICAgdHJ5IHtcbiAgICAgICAgYnVzYm95ID0gQnVzYm95KHsgaGVhZGVyczogcmVxLmhlYWRlcnMsIGxpbWl0czogeyBmaWVsZFNpemU6IG1heEJ5dGVzIH0gfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHJlamVjdChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgSW52YWxpZCBtdWx0aXBhcnQgcmVxdWVzdDogJHtlcnIubWVzc2FnZX1gKVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3Qgc2FmZVJlamVjdCA9IChlcnIpID0+IHtcbiAgICAgICAgaWYgKHNldHRsZWQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgIGJ1c2JveS5kZXN0cm95KCk7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfTtcbiAgICAgIGJ1c2JveS5vbignZmllbGQnLCAobmFtZSwgdmFsdWUsIGZpZWxkbmFtZVRydW5jYXRlZCwgdmFsdWVUcnVuY2F0ZWQpID0+IHtcbiAgICAgICAgaWYgKHZhbHVlVHJ1bmNhdGVkKSB7XG4gICAgICAgICAgcmV0dXJuIHNhZmVSZWplY3QoXG4gICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9UT09fTEFSR0UsXG4gICAgICAgICAgICAgICdNdWx0aXBhcnQgcmVxdWVzdCBleGNlZWRzIG1heGltdW0gdXBsb2FkIHNpemUuJ1xuICAgICAgICAgICAgKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdG90YWxCeXRlcyArPSBCdWZmZXIuYnl0ZUxlbmd0aCh2YWx1ZSk7XG4gICAgICAgIGlmICh0b3RhbEJ5dGVzID4gbWF4Qnl0ZXMpIHtcbiAgICAgICAgICByZXR1cm4gc2FmZVJlamVjdChcbiAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX1RPT19MQVJHRSxcbiAgICAgICAgICAgICAgJ011bHRpcGFydCByZXF1ZXN0IGV4Y2VlZHMgbWF4aW11bSB1cGxvYWQgc2l6ZS4nXG4gICAgICAgICAgICApXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBmaWVsZHNbbmFtZV0gPSB2YWx1ZTtcbiAgICAgIH0pO1xuICAgICAgYnVzYm95Lm9uKCdmaWxlJywgKG5hbWUsIHN0cmVhbSwgZmlsZW5hbWUsIHRyYW5zZmVyRW5jb2RpbmcsIG1pbWVUeXBlKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rcyA9IFtdO1xuICAgICAgICBzdHJlYW0ub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICAgICAgdG90YWxCeXRlcyArPSBjaHVuay5sZW5ndGg7XG4gICAgICAgICAgaWYgKHRvdGFsQnl0ZXMgPiBtYXhCeXRlcykge1xuICAgICAgICAgICAgc3RyZWFtLmRlc3Ryb3koKTtcbiAgICAgICAgICAgIHJldHVybiBzYWZlUmVqZWN0KFxuICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX1RPT19MQVJHRSxcbiAgICAgICAgICAgICAgICAnTXVsdGlwYXJ0IHJlcXVlc3QgZXhjZWVkcyBtYXhpbXVtIHVwbG9hZCBzaXplLidcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgICAgICB9KTtcbiAgICAgICAgc3RyZWFtLm9uKCdlbmQnLCAoKSA9PiB7XG4gICAgICAgICAgaWYgKHNldHRsZWQpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgZmllbGRzW25hbWVdID0ge1xuICAgICAgICAgICAgZmlsZW5hbWUsXG4gICAgICAgICAgICBjb250ZW50VHlwZTogbWltZVR5cGUgfHwgJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScsXG4gICAgICAgICAgICBkYXRhOiBCdWZmZXIuY29uY2F0KGNodW5rcyksXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICAgIGJ1c2JveS5vbignZmluaXNoJywgKCkgPT4ge1xuICAgICAgICBpZiAoc2V0dGxlZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgcmVxLmJvZHkgPSBmaWVsZHM7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgICAgYnVzYm95Lm9uKCdlcnJvcicsIGVyciA9PiB7XG4gICAgICAgIHNhZmVSZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYEludmFsaWQgbXVsdGlwYXJ0IHJlcXVlc3Q6ICR7ZXJyLm1lc3NhZ2V9YClcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgICAgcmVxLnBpcGUoYnVzYm95KTtcbiAgICB9KTtcbiAgfVxuXG4gIHN0YXRpYyBoYW5kbGVDbG91ZEZ1bmN0aW9uKHJlcSkge1xuICAgIGNvbnN0IGZ1bmN0aW9uTmFtZSA9IHJlcS5wYXJhbXMuZnVuY3Rpb25OYW1lO1xuICAgIGNvbnN0IGFwcGxpY2F0aW9uSWQgPSByZXEuY29uZmlnLmFwcGxpY2F0aW9uSWQ7XG4gICAgY29uc3QgdGhlRnVuY3Rpb24gPSB0cmlnZ2Vycy5nZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuXG4gICAgaWYgKCF0aGVGdW5jdGlvbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsIGBJbnZhbGlkIGZ1bmN0aW9uOiBcIiR7ZnVuY3Rpb25OYW1lfVwiYCk7XG4gICAgfVxuICAgIGxldCBwYXJhbXMgPSBPYmplY3QuYXNzaWduKHt9LCByZXEuYm9keSwgcmVxLnF1ZXJ5KTtcbiAgICBwYXJhbXMgPSBwYXJzZVBhcmFtcyhwYXJhbXMsIHJlcS5jb25maWcpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBwYXJhbXM6IHBhcmFtcyxcbiAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgIG1hc3RlcjogcmVxLmF1dGggJiYgcmVxLmF1dGguaXNNYXN0ZXIsXG4gICAgICBpc1JlYWRPbmx5OiAhIShyZXEuYXV0aCAmJiByZXEuYXV0aC5pc1JlYWRPbmx5KSxcbiAgICAgIHVzZXI6IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBsb2c6IHJlcS5jb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICAgIGhlYWRlcnM6IHJlcS5jb25maWcuaGVhZGVycyxcbiAgICAgIGlwOiByZXEuY29uZmlnLmlwLFxuICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgY29udGV4dDogcmVxLmluZm8uY29udGV4dCxcbiAgICB9O1xuXG4gICAgbGV0IGFjdGl2ZVNwYW47XG4gICAgdHJ5IHtcbiAgICAgIGFjdGl2ZVNwYW4gPSByZXFbaW5jb21pbmdSZXF1ZXN0U3Bhbl0gfHwgdHJhY2UuZ2V0QWN0aXZlU3BhbigpO1xuICAgICAgaWYgKGFjdGl2ZVNwYW4pIHtcbiAgICAgICAgaWYgKHJlcXVlc3QudXNlciAmJiByZXF1ZXN0LnVzZXIuaWQpIHtcbiAgICAgICAgICBhY3RpdmVTcGFuLnNldEF0dHJpYnV0ZSgnZW5kdXNlci5pZCcsIHJlcXVlc3QudXNlci5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgYWN0aXZlU3Bhbi5zZXRBdHRyaWJ1dGUoJ3BhcnNlLmZ1bmN0aW9uLm5hbWUnLCBmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhY3RpdmVTcGFuLnNldEF0dHJpYnV0ZSgncGFyc2UuZnVuY3Rpb24ucGFyYW1zJywgc2VyaWFsaXplVHJhY2VQYXJhbXMocGFyYW1zKSk7XG4gICAgICAgIGFjdGl2ZVNwYW4uc2V0QXR0cmlidXRlKCdhd3MueHJheS5hbm5vdGF0aW9ucycsIFsncGFyc2UuZnVuY3Rpb24ubmFtZSddKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElnbm9yZSB0cmFjaW5nIGVycm9ycy5cbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgY29uc3QgdXNlclN0cmluZyA9IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIgPyByZXEuYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KHJlZGFjdEJ1ZmZlcnMocGFyYW1zKSk7XG4gICAgICBjb25zdCByZXNwb25zZU9iamVjdCA9IEZ1bmN0aW9uc1JvdXRlci5jcmVhdGVSZXNwb25zZU9iamVjdChcbiAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHJlcS5jb25maWcubG9nTGV2ZWxzLmNsb3VkRnVuY3Rpb25TdWNjZXNzICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0LnJlc3BvbnNlLnJlc3VsdCkpO1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvblN1Y2Nlc3NdKFxuICAgICAgICAgICAgICAgIGBSYW4gY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmVqZWN0KGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgZXJyb3IgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoYWN0aXZlU3Bhbikge1xuICAgICAgICAgICAgICBhY3RpdmVTcGFuLnJlY29yZEV4Y2VwdGlvbihlcnJvcik7XG4gICAgICAgICAgICAgIGFjdGl2ZVNwYW4uc2V0U3RhdHVzKHsgY29kZTogU3BhblN0YXR1c0NvZGUuRVJST1IsIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yXShcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHJ1bm5pbmcgY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZXJyb3IpLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJlamVjdChlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSByZXNwb25zZU9iamVjdDtcblxuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgZnVuY3Rpb25OYW1lLCByZXEuYXV0aCk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAvLyBDaGVjayBpZiBmdW5jdGlvbiBleHBlY3RzIDIgcGFyYW1ldGVycyAocmVxLCByZXMpIC0gRXhwcmVzcyBzdHlsZVxuICAgICAgICAgIGlmICh0aGVGdW5jdGlvbi5sZW5ndGggPj0gMikge1xuICAgICAgICAgICAgcmV0dXJuIHRoZUZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlT2JqZWN0KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVHJhZGl0aW9uYWwgc3R5bGUgLSBzaW5nbGUgcGFyYW1ldGVyXG4gICAgICAgICAgICByZXR1cm4gdGhlRnVuY3Rpb24ocmVxdWVzdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgIC8vIEZvciBFeHByZXNzLXN0eWxlIGZ1bmN0aW9ucywgb25seSBzZW5kIHJlc3BvbnNlIGlmIG5vdCBhbHJlYWR5IHNlbnRcbiAgICAgICAgICBpZiAodGhlRnVuY3Rpb24ubGVuZ3RoID49IDIpIHtcbiAgICAgICAgICAgIGlmICghcmVzcG9uc2VPYmplY3QuX2lzUmVzcG9uc2VTZW50KCkpIHtcbiAgICAgICAgICAgICAgLy8gSWYgRXhwcmVzcy1zdHlsZSBmdW5jdGlvbiByZXR1cm5zIGEgdmFsdWUgd2l0aG91dCBjYWxsaW5nIHJlcy5zdWNjZXNzL2Vycm9yXG4gICAgICAgICAgICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHN1Y2Nlc3MocmVzdWx0KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyBJZiBubyByZXNwb25zZSBzZW50IGFuZCBubyB2YWx1ZSByZXR1cm5lZCwgdGhpcyBpcyBhbiBlcnJvciBpbiB1c2VyIGNvZGVcbiAgICAgICAgICAgICAgLy8gYnV0IHdlIGRvbid0IGhhbmRsZSBpdCBoZXJlIHRvIG1haW50YWluIGJhY2t3YXJkIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gRm9yIHRyYWRpdGlvbmFsIGZ1bmN0aW9ucywgYWx3YXlzIGNhbGwgc3VjY2VzcyB3aXRoIHRoZSByZXN1bHQgKGV2ZW4gaWYgdW5kZWZpbmVkKVxuICAgICAgICAgICAgc3VjY2VzcyhyZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgZXJyb3IpO1xuICAgIH0pO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUtBLElBQUFB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
