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
var _hulabXraySdk = require("hulab-xray-sdk");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// FunctionsRouter.js

var Parse = require('parse/node').Parse,
  triggers = require('../triggers');
function redactBuffers(obj) {
  if (Buffer.isBuffer(obj)) {
    return `[Buffer: ${obj.length} bytes]`;
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
    try {
      const xraySegment = (0, _hulabXraySdk.getSegment)();
      if (xraySegment) {
        if (request.user && request.user.id) {
          xraySegment.setUser(request.user.id);
        }
        xraySegment.addAnnotation('input', _logger.logger.truncateLogMessage(JSON.stringify(redactBuffers(params))));
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
          const xraySegment = (0, _hulabXraySdk.getSegment)();
          if (xraySegment) {
            xraySegment.close(error);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUHJvbWlzZVJvdXRlciIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX21pZGRsZXdhcmVzIiwiX1N0YXR1c0hhbmRsZXIiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9FcnJvciIsIl9idXNib3kiLCJfVXRpbHMiLCJfaHVsYWJYcmF5U2RrIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUGFyc2UiLCJ0cmlnZ2VycyIsInJlZGFjdEJ1ZmZlcnMiLCJvYmoiLCJCdWZmZXIiLCJpc0J1ZmZlciIsImxlbmd0aCIsIkFycmF5IiwiaXNBcnJheSIsIm1hcCIsInJlc3VsdCIsImtleSIsIk9iamVjdCIsImtleXMiLCJwYXJzZU9iamVjdCIsImNvbmZpZyIsIml0ZW0iLCJfX3R5cGUiLCJhc3NpZ24iLCJEYXRlIiwiaXNvIiwidXJsIiwidmFsaWRhdGVGaWxlVXJsIiwiRmlsZSIsImZyb21KU09OIiwiY2xhc3NOYW1lIiwib2JqZWN0SWQiLCJwYXJzZVBhcmFtcyIsInBhcmFtcyIsIl8iLCJtYXBWYWx1ZXMiLCJGdW5jdGlvbnNSb3V0ZXIiLCJQcm9taXNlUm91dGVyIiwibW91bnRSb3V0ZXMiLCJyb3V0ZSIsInByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSIsIm11bHRpcGFydE1pZGRsZXdhcmUiLCJoYW5kbGVDbG91ZEZ1bmN0aW9uIiwicHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MiLCJyZXEiLCJoYW5kbGVDbG91ZEpvYiIsImF1dGgiLCJpc1JlYWRPbmx5IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJFcnJvciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJqb2JOYW1lIiwiYm9keSIsImFwcGxpY2F0aW9uSWQiLCJqb2JIYW5kbGVyIiwiam9iU3RhdHVzSGFuZGxlciIsImpvYkZ1bmN0aW9uIiwiZ2V0Sm9iIiwiU0NSSVBUX0ZBSUxFRCIsInF1ZXJ5IiwicmVxdWVzdCIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJtZXNzYWdlIiwic2V0TWVzc2FnZSIsImJpbmQiLCJzZXRSdW5uaW5nIiwidGhlbiIsImpvYlN0YXR1cyIsImpvYklkIiwicHJvY2VzcyIsIm5leHRUaWNrIiwiUHJvbWlzZSIsInJlc29sdmUiLCJzZXRTdWNjZWVkZWQiLCJlcnJvciIsInNldEZhaWxlZCIsInJlc3BvbnNlIiwiY3JlYXRlUmVzcG9uc2VPYmplY3QiLCJyZWplY3QiLCJzdGF0dXNDb2RlIiwiaHR0cFN0YXR1c0NvZGUiLCJjdXN0b21IZWFkZXJzIiwicmVzcG9uc2VTZW50IiwicmVzcG9uc2VPYmplY3QiLCJzdWNjZXNzIiwiX2VuY29kZSIsInN0YXR1cyIsImNvZGUiLCJVdGlscyIsImlzTmF0aXZlRXJyb3IiLCJpc09iamVjdCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIkpTT04iLCJzdHJpbmdpZnkiLCJoZWFkZXIiLCJ2YWx1ZSIsIl9pc1Jlc3BvbnNlU2VudCIsImlzIiwibWF4Qnl0ZXMiLCJwYXJzZVNpemVUb0J5dGVzIiwibWF4VXBsb2FkU2l6ZSIsImZpZWxkcyIsImNyZWF0ZSIsInRvdGFsQnl0ZXMiLCJzZXR0bGVkIiwiYnVzYm95IiwiQnVzYm95IiwibGltaXRzIiwiZmllbGRTaXplIiwiZXJyIiwiSU5WQUxJRF9KU09OIiwic2FmZVJlamVjdCIsImRlc3Ryb3kiLCJvbiIsIm5hbWUiLCJmaWVsZG5hbWVUcnVuY2F0ZWQiLCJ2YWx1ZVRydW5jYXRlZCIsIk9CSkVDVF9UT09fTEFSR0UiLCJieXRlTGVuZ3RoIiwic3RyZWFtIiwiZmlsZW5hbWUiLCJ0cmFuc2ZlckVuY29kaW5nIiwibWltZVR5cGUiLCJjaHVua3MiLCJjaHVuayIsInB1c2giLCJjb250ZW50VHlwZSIsImRhdGEiLCJjb25jYXQiLCJwaXBlIiwiZnVuY3Rpb25OYW1lIiwidGhlRnVuY3Rpb24iLCJnZXRGdW5jdGlvbiIsIm1hc3RlciIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiaW5mbyIsImNvbnRleHQiLCJ4cmF5U2VnbWVudCIsImdldFNlZ21lbnQiLCJpZCIsInNldFVzZXIiLCJhZGRBbm5vdGF0aW9uIiwibG9nZ2VyIiwidHJ1bmNhdGVMb2dNZXNzYWdlIiwidXNlclN0cmluZyIsInVuZGVmaW5lZCIsImNsZWFuSW5wdXQiLCJsb2dMZXZlbHMiLCJjbG91ZEZ1bmN0aW9uU3VjY2VzcyIsImNsZWFuUmVzdWx0IiwiY2xvc2UiLCJjbG91ZEZ1bmN0aW9uRXJyb3IiLCJtYXliZVJ1blZhbGlkYXRvciIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvUm91dGVycy9GdW5jdGlvbnNSb3V0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gRnVuY3Rpb25zUm91dGVyLmpzXG5cbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZSxcbiAgdHJpZ2dlcnMgPSByZXF1aXJlKCcuLi90cmlnZ2VycycpO1xuXG5pbXBvcnQgUHJvbWlzZVJvdXRlciBmcm9tICcuLi9Qcm9taXNlUm91dGVyJztcbmltcG9ydCB7IHByb21pc2VFbmZvcmNlTWFzdGVyS2V5QWNjZXNzLCBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kgfSBmcm9tICcuLi9taWRkbGV3YXJlcyc7XG5pbXBvcnQgeyBqb2JTdGF0dXNIYW5kbGVyIH0gZnJvbSAnLi4vU3RhdHVzSGFuZGxlcic7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCB7IGNyZWF0ZVNhbml0aXplZEVycm9yIH0gZnJvbSAnLi4vRXJyb3InO1xuaW1wb3J0IEJ1c2JveSBmcm9tICdAZmFzdGlmeS9idXNib3knO1xuaW1wb3J0IFV0aWxzIGZyb20gJy4uL1V0aWxzJztcbmltcG9ydCB7IGdldFNlZ21lbnQgfSBmcm9tICdodWxhYi14cmF5LXNkayc7XG5cbmZ1bmN0aW9uIHJlZGFjdEJ1ZmZlcnMob2JqKSB7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqKSkge1xuICAgIHJldHVybiBgW0J1ZmZlcjogJHtvYmoubGVuZ3RofSBieXRlc11gO1xuICB9XG4gIGlmIChBcnJheS5pc0FycmF5KG9iaikpIHtcbiAgICByZXR1cm4gb2JqLm1hcChyZWRhY3RCdWZmZXJzKTtcbiAgfVxuICBpZiAob2JqICYmIHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMob2JqKSkge1xuICAgICAgcmVzdWx0W2tleV0gPSByZWRhY3RCdWZmZXJzKG9ialtrZXldKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICByZXR1cm4gb2JqO1xufVxuXG5mdW5jdGlvbiBwYXJzZU9iamVjdChvYmosIGNvbmZpZykge1xuICBpZiAoQXJyYXkuaXNBcnJheShvYmopKSB7XG4gICAgcmV0dXJuIG9iai5tYXAoaXRlbSA9PiB7XG4gICAgICByZXR1cm4gcGFyc2VPYmplY3QoaXRlbSwgY29uZmlnKTtcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChvYmogJiYgb2JqLl9fdHlwZSA9PSAnRGF0ZScpIHtcbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbihuZXcgRGF0ZShvYmouaXNvKSwgb2JqKTtcbiAgfSBlbHNlIGlmIChvYmogJiYgb2JqLl9fdHlwZSA9PSAnRmlsZScpIHtcbiAgICBpZiAob2JqLnVybCkge1xuICAgICAgY29uc3QgeyB2YWxpZGF0ZUZpbGVVcmwgfSA9IHJlcXVpcmUoJy4uL0ZpbGVVcmxWYWxpZGF0b3InKTtcbiAgICAgIHZhbGlkYXRlRmlsZVVybChvYmoudXJsLCBjb25maWcpO1xuICAgIH1cbiAgICByZXR1cm4gUGFyc2UuRmlsZS5mcm9tSlNPTihvYmopO1xuICB9IGVsc2UgaWYgKG9iaiAmJiBvYmouX190eXBlID09ICdQb2ludGVyJykge1xuICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IG9iai5jbGFzc05hbWUsXG4gICAgICBvYmplY3RJZDogb2JqLm9iamVjdElkLFxuICAgIH0pO1xuICB9IGVsc2UgaWYgKEJ1ZmZlci5pc0J1ZmZlcihvYmopKSB7XG4gICAgcmV0dXJuIG9iajtcbiAgfSBlbHNlIGlmIChvYmogJiYgdHlwZW9mIG9iaiA9PT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gcGFyc2VQYXJhbXMob2JqLCBjb25maWcpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBvYmo7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VQYXJhbXMocGFyYW1zLCBjb25maWcpIHtcbiAgcmV0dXJuIF8ubWFwVmFsdWVzKHBhcmFtcywgaXRlbSA9PiBwYXJzZU9iamVjdChpdGVtLCBjb25maWcpKTtcbn1cblxuZXhwb3J0IGNsYXNzIEZ1bmN0aW9uc1JvdXRlciBleHRlbmRzIFByb21pc2VSb3V0ZXIge1xuICBtb3VudFJvdXRlcygpIHtcbiAgICB0aGlzLnJvdXRlKFxuICAgICAgJ1BPU1QnLFxuICAgICAgJy9mdW5jdGlvbnMvOmZ1bmN0aW9uTmFtZScsXG4gICAgICBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksXG4gICAgICBGdW5jdGlvbnNSb3V0ZXIubXVsdGlwYXJ0TWlkZGxld2FyZSxcbiAgICAgIEZ1bmN0aW9uc1JvdXRlci5oYW5kbGVDbG91ZEZ1bmN0aW9uXG4gICAgKTtcbiAgICB0aGlzLnJvdXRlKFxuICAgICAgJ1BPU1QnLFxuICAgICAgJy9qb2JzLzpqb2JOYW1lJyxcbiAgICAgIHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSxcbiAgICAgIHByb21pc2VFbmZvcmNlTWFzdGVyS2V5QWNjZXNzLFxuICAgICAgZnVuY3Rpb24gKHJlcSkge1xuICAgICAgICByZXR1cm4gRnVuY3Rpb25zUm91dGVyLmhhbmRsZUNsb3VkSm9iKHJlcSk7XG4gICAgICB9XG4gICAgKTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9qb2JzJywgcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MsIGZ1bmN0aW9uIChyZXEpIHtcbiAgICAgIHJldHVybiBGdW5jdGlvbnNSb3V0ZXIuaGFuZGxlQ2xvdWRKb2IocmVxKTtcbiAgICB9KTtcbiAgfVxuXG4gIHN0YXRpYyBoYW5kbGVDbG91ZEpvYihyZXEpIHtcbiAgICBpZiAocmVxLmF1dGguaXNSZWFkT25seSkge1xuICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgIFwicmVhZC1vbmx5IG1hc3RlcktleSBpc24ndCBhbGxvd2VkIHRvIHJ1biBhIGpvYi5cIixcbiAgICAgICAgcmVxLmNvbmZpZ1xuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3Qgam9iTmFtZSA9IHJlcS5wYXJhbXMuam9iTmFtZSB8fCByZXEuYm9keT8uam9iTmFtZTtcbiAgICBjb25zdCBhcHBsaWNhdGlvbklkID0gcmVxLmNvbmZpZy5hcHBsaWNhdGlvbklkO1xuICAgIGNvbnN0IGpvYkhhbmRsZXIgPSBqb2JTdGF0dXNIYW5kbGVyKHJlcS5jb25maWcpO1xuICAgIGNvbnN0IGpvYkZ1bmN0aW9uID0gdHJpZ2dlcnMuZ2V0Sm9iKGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICgham9iRnVuY3Rpb24pIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCAnSW52YWxpZCBqb2IuJyk7XG4gICAgfVxuICAgIGxldCBwYXJhbXMgPSBPYmplY3QuYXNzaWduKHt9LCByZXEuYm9keSwgcmVxLnF1ZXJ5KTtcbiAgICBwYXJhbXMgPSBwYXJzZVBhcmFtcyhwYXJhbXMsIHJlcS5jb25maWcpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBwYXJhbXM6IHBhcmFtcyxcbiAgICAgIGxvZzogcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgICAgaGVhZGVyczogcmVxLmNvbmZpZy5oZWFkZXJzLFxuICAgICAgaXA6IHJlcS5jb25maWcuaXAsXG4gICAgICBqb2JOYW1lLFxuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgbWVzc2FnZTogam9iSGFuZGxlci5zZXRNZXNzYWdlLmJpbmQoam9iSGFuZGxlciksXG4gICAgfTtcblxuICAgIHJldHVybiBqb2JIYW5kbGVyLnNldFJ1bm5pbmcoam9iTmFtZSkudGhlbihqb2JTdGF0dXMgPT4ge1xuICAgICAgcmVxdWVzdC5qb2JJZCA9IGpvYlN0YXR1cy5vYmplY3RJZDtcbiAgICAgIC8vIHJ1biB0aGUgZnVuY3Rpb24gYXN5bmNcbiAgICAgIHByb2Nlc3MubmV4dFRpY2soKCkgPT4ge1xuICAgICAgICBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBqb2JGdW5jdGlvbihyZXF1ZXN0KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKFxuICAgICAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICAgICAgam9iSGFuZGxlci5zZXRTdWNjZWVkZWQocmVzdWx0KTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBlcnJvciA9PiB7XG4gICAgICAgICAgICAgIGpvYkhhbmRsZXIuc2V0RmFpbGVkKGVycm9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICApO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ1gtUGFyc2UtSm9iLVN0YXR1cy1JZCc6IGpvYlN0YXR1cy5vYmplY3RJZCxcbiAgICAgICAgfSxcbiAgICAgICAgcmVzcG9uc2U6IHt9LFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGVSZXNwb25zZU9iamVjdChyZXNvbHZlLCByZWplY3QsIHN0YXR1c0NvZGUgPSBudWxsKSB7XG4gICAgbGV0IGh0dHBTdGF0dXNDb2RlID0gc3RhdHVzQ29kZTtcbiAgICBjb25zdCBjdXN0b21IZWFkZXJzID0ge307XG4gICAgbGV0IHJlc3BvbnNlU2VudCA9IGZhbHNlO1xuICAgIGNvbnN0IHJlc3BvbnNlT2JqZWN0ID0ge1xuICAgICAgc3VjY2VzczogZnVuY3Rpb24gKHJlc3VsdCkge1xuICAgICAgICBpZiAocmVzcG9uc2VTZW50KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgY2FsbCBzdWNjZXNzKCkgYWZ0ZXIgcmVzcG9uc2UgaGFzIGFscmVhZHkgYmVlbiBzZW50LiBNYWtlIHN1cmUgdG8gY2FsbCBzdWNjZXNzKCkgb3IgZXJyb3IoKSBvbmx5IG9uY2UgcGVyIGNsb3VkIGZ1bmN0aW9uIGV4ZWN1dGlvbi4nKTtcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZVNlbnQgPSB0cnVlO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgICAgcmVzdWx0OiBQYXJzZS5fZW5jb2RlKHJlc3VsdCksXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGh0dHBTdGF0dXNDb2RlICE9PSBudWxsKSB7XG4gICAgICAgICAgcmVzcG9uc2Uuc3RhdHVzID0gaHR0cFN0YXR1c0NvZGU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1c3RvbUhlYWRlcnMpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICByZXNwb25zZS5oZWFkZXJzID0gY3VzdG9tSGVhZGVycztcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH0sXG4gICAgICBlcnJvcjogZnVuY3Rpb24gKG1lc3NhZ2UpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlU2VudCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IGNhbGwgZXJyb3IoKSBhZnRlciByZXNwb25zZSBoYXMgYWxyZWFkeSBiZWVuIHNlbnQuIE1ha2Ugc3VyZSB0byBjYWxsIHN1Y2Nlc3MoKSBvciBlcnJvcigpIG9ubHkgb25jZSBwZXIgY2xvdWQgZnVuY3Rpb24gZXhlY3V0aW9uLicpO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlU2VudCA9IHRydWU7XG4gICAgICAgIGxldCBlcnJvcjtcbiAgICAgICAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgICAgICAgIGVycm9yID0gbWVzc2FnZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsZXQgY29kZSA9IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQ7XG4gICAgICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChVdGlscy5pc05hdGl2ZUVycm9yKG1lc3NhZ2UpKSB7XG4gICAgICAgICAgICAgIG1lc3NhZ2UgPSBtZXNzYWdlLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIFV0aWxzLmlzT2JqZWN0KG1lc3NhZ2UpICYmXG4gICAgICAgICAgICAgIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChtZXNzYWdlLCAnY29kZScpICYmXG4gICAgICAgICAgICAgIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChtZXNzYWdlLCAnbWVzc2FnZScpXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgY29kZSA9IG1lc3NhZ2UuY29kZTtcbiAgICAgICAgICAgICAgbWVzc2FnZSA9IG1lc3NhZ2UubWVzc2FnZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChVdGlscy5pc09iamVjdChtZXNzYWdlKSkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG1lc3NhZ2UgPSBKU09OLnN0cmluZ2lmeShtZXNzYWdlKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgLy8gSWdub3JlIHNlcmlhbGl6YXRpb24gZXJyb3JzLlxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlcnJvciA9IG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gSWYgYSBjdXN0b20gc3RhdHVzIGNvZGUgd2FzIHNldCwgYXR0YWNoIGl0IHRvIHRoZSBlcnJvclxuICAgICAgICBpZiAoaHR0cFN0YXR1c0NvZGUgIT09IG51bGwpIHtcbiAgICAgICAgICBlcnJvci5zdGF0dXMgPSBodHRwU3RhdHVzQ29kZTtcbiAgICAgICAgfVxuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfSxcbiAgICAgIHN0YXR1czogZnVuY3Rpb24gKGNvZGUpIHtcbiAgICAgICAgaHR0cFN0YXR1c0NvZGUgPSBjb2RlO1xuICAgICAgICByZXR1cm4gcmVzcG9uc2VPYmplY3Q7XG4gICAgICB9LFxuICAgICAgaGVhZGVyOiBmdW5jdGlvbiAoa2V5LCB2YWx1ZSkge1xuICAgICAgICBjdXN0b21IZWFkZXJzW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlT2JqZWN0O1xuICAgICAgfSxcbiAgICAgIF9pc1Jlc3BvbnNlU2VudDogKCkgPT4gcmVzcG9uc2VTZW50LFxuICAgIH07XG4gICAgcmV0dXJuIHJlc3BvbnNlT2JqZWN0O1xuICB9XG5cbiAgLyoqXG4gICAqIFBhcnNlcyBtdWx0aXBhcnQvZm9ybS1kYXRhIHJlcXVlc3RzIGZvciBDbG91ZCBGdW5jdGlvbiBpbnZvY2F0aW9uLlxuICAgKiBGb3Igbm9uLW11bHRpcGFydCByZXF1ZXN0cywgdGhpcyBpcyBhIG5vLW9wLlxuICAgKlxuICAgKiBUZXh0IGZpZWxkcyBhcmUgc2V0IGFzIHN0cmluZ3MgaW4gYHJlcS5ib2R5YC4gRmlsZSBmaWVsZHMgYXJlIHNldCBhc1xuICAgKiBvYmplY3RzIHdpdGggdGhlIHNoYXBlIGB7IGZpbGVuYW1lOiBzdHJpbmcsIGNvbnRlbnRUeXBlOiBzdHJpbmcsIGRhdGE6IEJ1ZmZlciB9YC5cbiAgICogQWxsIGZpZWxkcyBhcmUgbWVyZ2VkIGZsYXQgaW50byBgcmVxLmJvZHlgOyB0aGUgY2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvclxuICAgKiBhdm9pZGluZyBuYW1lIGNvbGxpc2lvbnMgYmV0d2VlbiB0ZXh0IGFuZCBmaWxlIGZpZWxkcy5cbiAgICpcbiAgICogVGhlIHRvdGFsIHJlcXVlc3Qgc2l6ZSBpcyBsaW1pdGVkIGJ5IHRoZSBzZXJ2ZXIncyBgbWF4VXBsb2FkU2l6ZWAgb3B0aW9uLlxuICAgKi9cbiAgc3RhdGljIG11bHRpcGFydE1pZGRsZXdhcmUocmVxKSB7XG4gICAgaWYgKCFyZXEuaXMgfHwgIXJlcS5pcygnbXVsdGlwYXJ0L2Zvcm0tZGF0YScpKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgfVxuICAgIGNvbnN0IG1heEJ5dGVzID0gVXRpbHMucGFyc2VTaXplVG9CeXRlcyhyZXEuY29uZmlnLm1heFVwbG9hZFNpemUpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgICAgbGV0IHRvdGFsQnl0ZXMgPSAwO1xuICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgIGxldCBidXNib3k7XG4gICAgICB0cnkge1xuICAgICAgICBidXNib3kgPSBCdXNib3koeyBoZWFkZXJzOiByZXEuaGVhZGVycywgbGltaXRzOiB7IGZpZWxkU2l6ZTogbWF4Qnl0ZXMgfSB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gcmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBJbnZhbGlkIG11bHRpcGFydCByZXF1ZXN0OiAke2Vyci5tZXNzYWdlfWApXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBzYWZlUmVqZWN0ID0gKGVycikgPT4ge1xuICAgICAgICBpZiAoc2V0dGxlZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgYnVzYm95LmRlc3Ryb3koKTtcbiAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICB9O1xuICAgICAgYnVzYm95Lm9uKCdmaWVsZCcsIChuYW1lLCB2YWx1ZSwgZmllbGRuYW1lVHJ1bmNhdGVkLCB2YWx1ZVRydW5jYXRlZCkgPT4ge1xuICAgICAgICBpZiAodmFsdWVUcnVuY2F0ZWQpIHtcbiAgICAgICAgICByZXR1cm4gc2FmZVJlamVjdChcbiAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX1RPT19MQVJHRSxcbiAgICAgICAgICAgICAgJ011bHRpcGFydCByZXF1ZXN0IGV4Y2VlZHMgbWF4aW11bSB1cGxvYWQgc2l6ZS4nXG4gICAgICAgICAgICApXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0b3RhbEJ5dGVzICs9IEJ1ZmZlci5ieXRlTGVuZ3RoKHZhbHVlKTtcbiAgICAgICAgaWYgKHRvdGFsQnl0ZXMgPiBtYXhCeXRlcykge1xuICAgICAgICAgIHJldHVybiBzYWZlUmVqZWN0KFxuICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfVE9PX0xBUkdFLFxuICAgICAgICAgICAgICAnTXVsdGlwYXJ0IHJlcXVlc3QgZXhjZWVkcyBtYXhpbXVtIHVwbG9hZCBzaXplLidcbiAgICAgICAgICAgIClcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGZpZWxkc1tuYW1lXSA9IHZhbHVlO1xuICAgICAgfSk7XG4gICAgICBidXNib3kub24oJ2ZpbGUnLCAobmFtZSwgc3RyZWFtLCBmaWxlbmFtZSwgdHJhbnNmZXJFbmNvZGluZywgbWltZVR5cGUpID0+IHtcbiAgICAgICAgY29uc3QgY2h1bmtzID0gW107XG4gICAgICAgIHN0cmVhbS5vbignZGF0YScsIGNodW5rID0+IHtcbiAgICAgICAgICB0b3RhbEJ5dGVzICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICBpZiAodG90YWxCeXRlcyA+IG1heEJ5dGVzKSB7XG4gICAgICAgICAgICBzdHJlYW0uZGVzdHJveSgpO1xuICAgICAgICAgICAgcmV0dXJuIHNhZmVSZWplY3QoXG4gICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfVE9PX0xBUkdFLFxuICAgICAgICAgICAgICAgICdNdWx0aXBhcnQgcmVxdWVzdCBleGNlZWRzIG1heGltdW0gdXBsb2FkIHNpemUuJ1xuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjaHVua3MucHVzaChjaHVuayk7XG4gICAgICAgIH0pO1xuICAgICAgICBzdHJlYW0ub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgICBpZiAoc2V0dGxlZCkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBmaWVsZHNbbmFtZV0gPSB7XG4gICAgICAgICAgICBmaWxlbmFtZSxcbiAgICAgICAgICAgIGNvbnRlbnRUeXBlOiBtaW1lVHlwZSB8fCAnYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtJyxcbiAgICAgICAgICAgIGRhdGE6IEJ1ZmZlci5jb25jYXQoY2h1bmtzKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgYnVzYm95Lm9uKCdmaW5pc2gnLCAoKSA9PiB7XG4gICAgICAgIGlmIChzZXR0bGVkKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICByZXEuYm9keSA9IGZpZWxkcztcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgICBidXNib3kub24oJ2Vycm9yJywgZXJyID0+IHtcbiAgICAgICAgc2FmZVJlamVjdChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgSW52YWxpZCBtdWx0aXBhcnQgcmVxdWVzdDogJHtlcnIubWVzc2FnZX1gKVxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgICByZXEucGlwZShidXNib3kpO1xuICAgIH0pO1xuICB9XG5cbiAgc3RhdGljIGhhbmRsZUNsb3VkRnVuY3Rpb24ocmVxKSB7XG4gICAgY29uc3QgZnVuY3Rpb25OYW1lID0gcmVxLnBhcmFtcy5mdW5jdGlvbk5hbWU7XG4gICAgY29uc3QgYXBwbGljYXRpb25JZCA9IHJlcS5jb25maWcuYXBwbGljYXRpb25JZDtcbiAgICBjb25zdCB0aGVGdW5jdGlvbiA9IHRyaWdnZXJzLmdldEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG5cbiAgICBpZiAoIXRoZUZ1bmN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCwgYEludmFsaWQgZnVuY3Rpb246IFwiJHtmdW5jdGlvbk5hbWV9XCJgKTtcbiAgICB9XG4gICAgbGV0IHBhcmFtcyA9IE9iamVjdC5hc3NpZ24oe30sIHJlcS5ib2R5LCByZXEucXVlcnkpO1xuICAgIHBhcmFtcyA9IHBhcnNlUGFyYW1zKHBhcmFtcywgcmVxLmNvbmZpZyk7XG4gICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgIHBhcmFtczogcGFyYW1zLFxuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgbWFzdGVyOiByZXEuYXV0aCAmJiByZXEuYXV0aC5pc01hc3RlcixcbiAgICAgIGlzUmVhZE9ubHk6ICEhKHJlcS5hdXRoICYmIHJlcS5hdXRoLmlzUmVhZE9ubHkpLFxuICAgICAgdXNlcjogcmVxLmF1dGggJiYgcmVxLmF1dGgudXNlcixcbiAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGxvZzogcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgICAgaGVhZGVyczogcmVxLmNvbmZpZy5oZWFkZXJzLFxuICAgICAgaXA6IHJlcS5jb25maWcuaXAsXG4gICAgICBmdW5jdGlvbk5hbWUsXG4gICAgICBjb250ZXh0OiByZXEuaW5mby5jb250ZXh0LFxuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgeHJheVNlZ21lbnQgPSBnZXRTZWdtZW50KCk7XG4gICAgICBpZiAoeHJheVNlZ21lbnQpIHtcbiAgICAgICAgaWYgKHJlcXVlc3QudXNlciAmJiByZXF1ZXN0LnVzZXIuaWQpIHtcbiAgICAgICAgICB4cmF5U2VnbWVudC5zZXRVc2VyKHJlcXVlc3QudXNlci5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgeHJheVNlZ21lbnQuYWRkQW5ub3RhdGlvbihcbiAgICAgICAgICAnaW5wdXQnLFxuICAgICAgICAgIGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVkYWN0QnVmZmVycyhwYXJhbXMpKSlcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElnbm9yZSB0cmFjaW5nIGVycm9ycy5cbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgY29uc3QgdXNlclN0cmluZyA9IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIgPyByZXEuYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KHJlZGFjdEJ1ZmZlcnMocGFyYW1zKSk7XG4gICAgICBjb25zdCByZXNwb25zZU9iamVjdCA9IEZ1bmN0aW9uc1JvdXRlci5jcmVhdGVSZXNwb25zZU9iamVjdChcbiAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKHJlcS5jb25maWcubG9nTGV2ZWxzLmNsb3VkRnVuY3Rpb25TdWNjZXNzICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0LnJlc3BvbnNlLnJlc3VsdCkpO1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvblN1Y2Nlc3NdKFxuICAgICAgICAgICAgICAgIGBSYW4gY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmVqZWN0KGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgZXJyb3IgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB4cmF5U2VnbWVudCA9IGdldFNlZ21lbnQoKTtcbiAgICAgICAgICAgIGlmICh4cmF5U2VnbWVudCkge1xuICAgICAgICAgICAgICB4cmF5U2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yICE9PSAnc2lsZW50Jykge1xuICAgICAgICAgICAgICBsb2dnZXJbcmVxLmNvbmZpZy5sb2dMZXZlbHMuY2xvdWRGdW5jdGlvbkVycm9yXShcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHJ1bm5pbmcgY2xvdWQgZnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aDogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZXJyb3IpLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yLFxuICAgICAgICAgICAgICAgICAgcGFyYW1zLFxuICAgICAgICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJlamVjdChlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSByZXNwb25zZU9iamVjdDtcblxuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgZnVuY3Rpb25OYW1lLCByZXEuYXV0aCk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAvLyBDaGVjayBpZiBmdW5jdGlvbiBleHBlY3RzIDIgcGFyYW1ldGVycyAocmVxLCByZXMpIC0gRXhwcmVzcyBzdHlsZVxuICAgICAgICAgIGlmICh0aGVGdW5jdGlvbi5sZW5ndGggPj0gMikge1xuICAgICAgICAgICAgcmV0dXJuIHRoZUZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlT2JqZWN0KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVHJhZGl0aW9uYWwgc3R5bGUgLSBzaW5nbGUgcGFyYW1ldGVyXG4gICAgICAgICAgICByZXR1cm4gdGhlRnVuY3Rpb24ocmVxdWVzdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgIC8vIEZvciBFeHByZXNzLXN0eWxlIGZ1bmN0aW9ucywgb25seSBzZW5kIHJlc3BvbnNlIGlmIG5vdCBhbHJlYWR5IHNlbnRcbiAgICAgICAgICBpZiAodGhlRnVuY3Rpb24ubGVuZ3RoID49IDIpIHtcbiAgICAgICAgICAgIGlmICghcmVzcG9uc2VPYmplY3QuX2lzUmVzcG9uc2VTZW50KCkpIHtcbiAgICAgICAgICAgICAgLy8gSWYgRXhwcmVzcy1zdHlsZSBmdW5jdGlvbiByZXR1cm5zIGEgdmFsdWUgd2l0aG91dCBjYWxsaW5nIHJlcy5zdWNjZXNzL2Vycm9yXG4gICAgICAgICAgICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHN1Y2Nlc3MocmVzdWx0KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyBJZiBubyByZXNwb25zZSBzZW50IGFuZCBubyB2YWx1ZSByZXR1cm5lZCwgdGhpcyBpcyBhbiBlcnJvciBpbiB1c2VyIGNvZGVcbiAgICAgICAgICAgICAgLy8gYnV0IHdlIGRvbid0IGhhbmRsZSBpdCBoZXJlIHRvIG1haW50YWluIGJhY2t3YXJkIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gRm9yIHRyYWRpdGlvbmFsIGZ1bmN0aW9ucywgYWx3YXlzIGNhbGwgc3VjY2VzcyB3aXRoIHRoZSByZXN1bHQgKGV2ZW4gaWYgdW5kZWZpbmVkKVxuICAgICAgICAgICAgc3VjY2VzcyhyZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgZXJyb3IpO1xuICAgIH0pO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUtBLElBQUFBLGNBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLFlBQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLGNBQUEsR0FBQUYsT0FBQTtBQUNBLElBQUFHLE9BQUEsR0FBQUosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFJLE9BQUEsR0FBQUosT0FBQTtBQUNBLElBQUFLLE1BQUEsR0FBQUwsT0FBQTtBQUNBLElBQUFNLE9BQUEsR0FBQVAsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFPLE1BQUEsR0FBQVIsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFRLGFBQUEsR0FBQVIsT0FBQTtBQUE0QyxTQUFBRCx1QkFBQVUsQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQWI1Qzs7QUFFQSxJQUFJRyxLQUFLLEdBQUdaLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQ1ksS0FBSztFQUNyQ0MsUUFBUSxHQUFHYixPQUFPLENBQUMsYUFBYSxDQUFDO0FBWW5DLFNBQVNjLGFBQWFBLENBQUNDLEdBQUcsRUFBRTtFQUMxQixJQUFJQyxNQUFNLENBQUNDLFFBQVEsQ0FBQ0YsR0FBRyxDQUFDLEVBQUU7SUFDeEIsT0FBTyxZQUFZQSxHQUFHLENBQUNHLE1BQU0sU0FBUztFQUN4QztFQUNBLElBQUlDLEtBQUssQ0FBQ0MsT0FBTyxDQUFDTCxHQUFHLENBQUMsRUFBRTtJQUN0QixPQUFPQSxHQUFHLENBQUNNLEdBQUcsQ0FBQ1AsYUFBYSxDQUFDO0VBQy9CO0VBQ0EsSUFBSUMsR0FBRyxJQUFJLE9BQU9BLEdBQUcsS0FBSyxRQUFRLEVBQUU7SUFDbEMsTUFBTU8sTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNqQixLQUFLLE1BQU1DLEdBQUcsSUFBSUMsTUFBTSxDQUFDQyxJQUFJLENBQUNWLEdBQUcsQ0FBQyxFQUFFO01BQ2xDTyxNQUFNLENBQUNDLEdBQUcsQ0FBQyxHQUFHVCxhQUFhLENBQUNDLEdBQUcsQ0FBQ1EsR0FBRyxDQUFDLENBQUM7SUFDdkM7SUFDQSxPQUFPRCxNQUFNO0VBQ2Y7RUFDQSxPQUFPUCxHQUFHO0FBQ1o7QUFFQSxTQUFTVyxXQUFXQSxDQUFDWCxHQUFHLEVBQUVZLE1BQU0sRUFBRTtFQUNoQyxJQUFJUixLQUFLLENBQUNDLE9BQU8sQ0FBQ0wsR0FBRyxDQUFDLEVBQUU7SUFDdEIsT0FBT0EsR0FBRyxDQUFDTSxHQUFHLENBQUNPLElBQUksSUFBSTtNQUNyQixPQUFPRixXQUFXLENBQUNFLElBQUksRUFBRUQsTUFBTSxDQUFDO0lBQ2xDLENBQUMsQ0FBQztFQUNKLENBQUMsTUFBTSxJQUFJWixHQUFHLElBQUlBLEdBQUcsQ0FBQ2MsTUFBTSxJQUFJLE1BQU0sRUFBRTtJQUN0QyxPQUFPTCxNQUFNLENBQUNNLE1BQU0sQ0FBQyxJQUFJQyxJQUFJLENBQUNoQixHQUFHLENBQUNpQixHQUFHLENBQUMsRUFBRWpCLEdBQUcsQ0FBQztFQUM5QyxDQUFDLE1BQU0sSUFBSUEsR0FBRyxJQUFJQSxHQUFHLENBQUNjLE1BQU0sSUFBSSxNQUFNLEVBQUU7SUFDdEMsSUFBSWQsR0FBRyxDQUFDa0IsR0FBRyxFQUFFO01BQ1gsTUFBTTtRQUFFQztNQUFnQixDQUFDLEdBQUdsQyxPQUFPLENBQUMscUJBQXFCLENBQUM7TUFDMURrQyxlQUFlLENBQUNuQixHQUFHLENBQUNrQixHQUFHLEVBQUVOLE1BQU0sQ0FBQztJQUNsQztJQUNBLE9BQU9mLEtBQUssQ0FBQ3VCLElBQUksQ0FBQ0MsUUFBUSxDQUFDckIsR0FBRyxDQUFDO0VBQ2pDLENBQUMsTUFBTSxJQUFJQSxHQUFHLElBQUlBLEdBQUcsQ0FBQ2MsTUFBTSxJQUFJLFNBQVMsRUFBRTtJQUN6QyxPQUFPakIsS0FBSyxDQUFDWSxNQUFNLENBQUNZLFFBQVEsQ0FBQztNQUMzQlAsTUFBTSxFQUFFLFNBQVM7TUFDakJRLFNBQVMsRUFBRXRCLEdBQUcsQ0FBQ3NCLFNBQVM7TUFDeEJDLFFBQVEsRUFBRXZCLEdBQUcsQ0FBQ3VCO0lBQ2hCLENBQUMsQ0FBQztFQUNKLENBQUMsTUFBTSxJQUFJdEIsTUFBTSxDQUFDQyxRQUFRLENBQUNGLEdBQUcsQ0FBQyxFQUFFO0lBQy9CLE9BQU9BLEdBQUc7RUFDWixDQUFDLE1BQU0sSUFBSUEsR0FBRyxJQUFJLE9BQU9BLEdBQUcsS0FBSyxRQUFRLEVBQUU7SUFDekMsT0FBT3dCLFdBQVcsQ0FBQ3hCLEdBQUcsRUFBRVksTUFBTSxDQUFDO0VBQ2pDLENBQUMsTUFBTTtJQUNMLE9BQU9aLEdBQUc7RUFDWjtBQUNGO0FBRUEsU0FBU3dCLFdBQVdBLENBQUNDLE1BQU0sRUFBRWIsTUFBTSxFQUFFO0VBQ25DLE9BQU9jLGVBQUMsQ0FBQ0MsU0FBUyxDQUFDRixNQUFNLEVBQUVaLElBQUksSUFBSUYsV0FBVyxDQUFDRSxJQUFJLEVBQUVELE1BQU0sQ0FBQyxDQUFDO0FBQy9EO0FBRU8sTUFBTWdCLGVBQWUsU0FBU0Msc0JBQWEsQ0FBQztFQUNqREMsV0FBV0EsQ0FBQSxFQUFHO0lBQ1osSUFBSSxDQUFDQyxLQUFLLENBQ1IsTUFBTSxFQUNOLDBCQUEwQixFQUMxQkMscUNBQXdCLEVBQ3hCSixlQUFlLENBQUNLLG1CQUFtQixFQUNuQ0wsZUFBZSxDQUFDTSxtQkFDbEIsQ0FBQztJQUNELElBQUksQ0FBQ0gsS0FBSyxDQUNSLE1BQU0sRUFDTixnQkFBZ0IsRUFDaEJDLHFDQUF3QixFQUN4QkcsMENBQTZCLEVBQzdCLFVBQVVDLEdBQUcsRUFBRTtNQUNiLE9BQU9SLGVBQWUsQ0FBQ1MsY0FBYyxDQUFDRCxHQUFHLENBQUM7SUFDNUMsQ0FDRixDQUFDO0lBQ0QsSUFBSSxDQUFDTCxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRUksMENBQTZCLEVBQUUsVUFBVUMsR0FBRyxFQUFFO01BQ3hFLE9BQU9SLGVBQWUsQ0FBQ1MsY0FBYyxDQUFDRCxHQUFHLENBQUM7SUFDNUMsQ0FBQyxDQUFDO0VBQ0o7RUFFQSxPQUFPQyxjQUFjQSxDQUFDRCxHQUFHLEVBQUU7SUFDekIsSUFBSUEsR0FBRyxDQUFDRSxJQUFJLENBQUNDLFVBQVUsRUFBRTtNQUN2QixNQUFNLElBQUFDLDJCQUFvQixFQUN4QjNDLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ0MsbUJBQW1CLEVBQy9CLGlEQUFpRCxFQUNqRE4sR0FBRyxDQUFDeEIsTUFDTixDQUFDO0lBQ0g7SUFDQSxNQUFNK0IsT0FBTyxHQUFHUCxHQUFHLENBQUNYLE1BQU0sQ0FBQ2tCLE9BQU8sSUFBSVAsR0FBRyxDQUFDUSxJQUFJLEVBQUVELE9BQU87SUFDdkQsTUFBTUUsYUFBYSxHQUFHVCxHQUFHLENBQUN4QixNQUFNLENBQUNpQyxhQUFhO0lBQzlDLE1BQU1DLFVBQVUsR0FBRyxJQUFBQywrQkFBZ0IsRUFBQ1gsR0FBRyxDQUFDeEIsTUFBTSxDQUFDO0lBQy9DLE1BQU1vQyxXQUFXLEdBQUdsRCxRQUFRLENBQUNtRCxNQUFNLENBQUNOLE9BQU8sRUFBRUUsYUFBYSxDQUFDO0lBQzNELElBQUksQ0FBQ0csV0FBVyxFQUFFO01BQ2hCLE1BQU0sSUFBSW5ELEtBQUssQ0FBQzRDLEtBQUssQ0FBQzVDLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ1MsYUFBYSxFQUFFLGNBQWMsQ0FBQztJQUNsRTtJQUNBLElBQUl6QixNQUFNLEdBQUdoQixNQUFNLENBQUNNLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRXFCLEdBQUcsQ0FBQ1EsSUFBSSxFQUFFUixHQUFHLENBQUNlLEtBQUssQ0FBQztJQUNuRDFCLE1BQU0sR0FBR0QsV0FBVyxDQUFDQyxNQUFNLEVBQUVXLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQztJQUN4QyxNQUFNd0MsT0FBTyxHQUFHO01BQ2QzQixNQUFNLEVBQUVBLE1BQU07TUFDZDRCLEdBQUcsRUFBRWpCLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQzBDLGdCQUFnQjtNQUNoQ0MsT0FBTyxFQUFFbkIsR0FBRyxDQUFDeEIsTUFBTSxDQUFDMkMsT0FBTztNQUMzQkMsRUFBRSxFQUFFcEIsR0FBRyxDQUFDeEIsTUFBTSxDQUFDNEMsRUFBRTtNQUNqQmIsT0FBTztNQUNQL0IsTUFBTSxFQUFFd0IsR0FBRyxDQUFDeEIsTUFBTTtNQUNsQjZDLE9BQU8sRUFBRVgsVUFBVSxDQUFDWSxVQUFVLENBQUNDLElBQUksQ0FBQ2IsVUFBVTtJQUNoRCxDQUFDO0lBRUQsT0FBT0EsVUFBVSxDQUFDYyxVQUFVLENBQUNqQixPQUFPLENBQUMsQ0FBQ2tCLElBQUksQ0FBQ0MsU0FBUyxJQUFJO01BQ3REVixPQUFPLENBQUNXLEtBQUssR0FBR0QsU0FBUyxDQUFDdkMsUUFBUTtNQUNsQztNQUNBeUMsT0FBTyxDQUFDQyxRQUFRLENBQUMsTUFBTTtRQUNyQkMsT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUNkTixJQUFJLENBQUMsTUFBTTtVQUNWLE9BQU9iLFdBQVcsQ0FBQ0ksT0FBTyxDQUFDO1FBQzdCLENBQUMsQ0FBQyxDQUNEUyxJQUFJLENBQ0h0RCxNQUFNLElBQUk7VUFDUnVDLFVBQVUsQ0FBQ3NCLFlBQVksQ0FBQzdELE1BQU0sQ0FBQztRQUNqQyxDQUFDLEVBQ0Q4RCxLQUFLLElBQUk7VUFDUHZCLFVBQVUsQ0FBQ3dCLFNBQVMsQ0FBQ0QsS0FBSyxDQUFDO1FBQzdCLENBQ0YsQ0FBQztNQUNMLENBQUMsQ0FBQztNQUNGLE9BQU87UUFDTGQsT0FBTyxFQUFFO1VBQ1AsdUJBQXVCLEVBQUVPLFNBQVMsQ0FBQ3ZDO1FBQ3JDLENBQUM7UUFDRGdELFFBQVEsRUFBRSxDQUFDO01BQ2IsQ0FBQztJQUNILENBQUMsQ0FBQztFQUNKO0VBRUEsT0FBT0Msb0JBQW9CQSxDQUFDTCxPQUFPLEVBQUVNLE1BQU0sRUFBRUMsVUFBVSxHQUFHLElBQUksRUFBRTtJQUM5RCxJQUFJQyxjQUFjLEdBQUdELFVBQVU7SUFDL0IsTUFBTUUsYUFBYSxHQUFHLENBQUMsQ0FBQztJQUN4QixJQUFJQyxZQUFZLEdBQUcsS0FBSztJQUN4QixNQUFNQyxjQUFjLEdBQUc7TUFDckJDLE9BQU8sRUFBRSxTQUFBQSxDQUFVeEUsTUFBTSxFQUFFO1FBQ3pCLElBQUlzRSxZQUFZLEVBQUU7VUFDaEIsTUFBTSxJQUFJcEMsS0FBSyxDQUFDLDRJQUE0SSxDQUFDO1FBQy9KO1FBQ0FvQyxZQUFZLEdBQUcsSUFBSTtRQUNuQixNQUFNTixRQUFRLEdBQUc7VUFDZkEsUUFBUSxFQUFFO1lBQ1JoRSxNQUFNLEVBQUVWLEtBQUssQ0FBQ21GLE9BQU8sQ0FBQ3pFLE1BQU07VUFDOUI7UUFDRixDQUFDO1FBQ0QsSUFBSW9FLGNBQWMsS0FBSyxJQUFJLEVBQUU7VUFDM0JKLFFBQVEsQ0FBQ1UsTUFBTSxHQUFHTixjQUFjO1FBQ2xDO1FBQ0EsSUFBSWxFLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDa0UsYUFBYSxDQUFDLENBQUN6RSxNQUFNLEdBQUcsQ0FBQyxFQUFFO1VBQ3pDb0UsUUFBUSxDQUFDaEIsT0FBTyxHQUFHcUIsYUFBYTtRQUNsQztRQUNBVCxPQUFPLENBQUNJLFFBQVEsQ0FBQztNQUNuQixDQUFDO01BQ0RGLEtBQUssRUFBRSxTQUFBQSxDQUFVWixPQUFPLEVBQUU7UUFDeEIsSUFBSW9CLFlBQVksRUFBRTtVQUNoQixNQUFNLElBQUlwQyxLQUFLLENBQUMsMElBQTBJLENBQUM7UUFDN0o7UUFDQW9DLFlBQVksR0FBRyxJQUFJO1FBQ25CLElBQUlSLEtBQUs7UUFDVCxJQUFJWixPQUFPLFlBQVk1RCxLQUFLLENBQUM0QyxLQUFLLEVBQUU7VUFDbEM0QixLQUFLLEdBQUdaLE9BQU87UUFDakIsQ0FBQyxNQUFNO1VBQ0wsSUFBSXlCLElBQUksR0FBR3JGLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ1MsYUFBYTtVQUNwQyxJQUFJLE9BQU9PLE9BQU8sS0FBSyxRQUFRLEVBQUU7WUFDL0JZLEtBQUssR0FBRyxJQUFJeEUsS0FBSyxDQUFDNEMsS0FBSyxDQUFDeUMsSUFBSSxFQUFFekIsT0FBTyxDQUFDO1VBQ3hDLENBQUMsTUFBTTtZQUNMLElBQUkwQixjQUFLLENBQUNDLGFBQWEsQ0FBQzNCLE9BQU8sQ0FBQyxFQUFFO2NBQ2hDQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQ0EsT0FBTztZQUMzQjtZQUNBLElBQ0UwQixjQUFLLENBQUNFLFFBQVEsQ0FBQzVCLE9BQU8sQ0FBQyxJQUN2QmhELE1BQU0sQ0FBQzZFLFNBQVMsQ0FBQ0MsY0FBYyxDQUFDQyxJQUFJLENBQUMvQixPQUFPLEVBQUUsTUFBTSxDQUFDLElBQ3JEaEQsTUFBTSxDQUFDNkUsU0FBUyxDQUFDQyxjQUFjLENBQUNDLElBQUksQ0FBQy9CLE9BQU8sRUFBRSxTQUFTLENBQUMsRUFDeEQ7Y0FDQXlCLElBQUksR0FBR3pCLE9BQU8sQ0FBQ3lCLElBQUk7Y0FDbkJ6QixPQUFPLEdBQUdBLE9BQU8sQ0FBQ0EsT0FBTztZQUMzQjtZQUNBLElBQUkwQixjQUFLLENBQUNFLFFBQVEsQ0FBQzVCLE9BQU8sQ0FBQyxFQUFFO2NBQzNCLElBQUk7Z0JBQ0ZBLE9BQU8sR0FBR2dDLElBQUksQ0FBQ0MsU0FBUyxDQUFDakMsT0FBTyxDQUFDO2NBQ25DLENBQUMsQ0FBQyxNQUFNO2dCQUNOO2NBQUE7WUFFSjtZQUNBWSxLQUFLLEdBQUcsSUFBSXhFLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ3lDLElBQUksRUFBRXpCLE9BQU8sQ0FBQztVQUN4QztRQUNGO1FBQ0E7UUFDQSxJQUFJa0IsY0FBYyxLQUFLLElBQUksRUFBRTtVQUMzQk4sS0FBSyxDQUFDWSxNQUFNLEdBQUdOLGNBQWM7UUFDL0I7UUFDQUYsTUFBTSxDQUFDSixLQUFLLENBQUM7TUFDZixDQUFDO01BQ0RZLE1BQU0sRUFBRSxTQUFBQSxDQUFVQyxJQUFJLEVBQUU7UUFDdEJQLGNBQWMsR0FBR08sSUFBSTtRQUNyQixPQUFPSixjQUFjO01BQ3ZCLENBQUM7TUFDRGEsTUFBTSxFQUFFLFNBQUFBLENBQVVuRixHQUFHLEVBQUVvRixLQUFLLEVBQUU7UUFDNUJoQixhQUFhLENBQUNwRSxHQUFHLENBQUMsR0FBR29GLEtBQUs7UUFDMUIsT0FBT2QsY0FBYztNQUN2QixDQUFDO01BQ0RlLGVBQWUsRUFBRUEsQ0FBQSxLQUFNaEI7SUFDekIsQ0FBQztJQUNELE9BQU9DLGNBQWM7RUFDdkI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU83QyxtQkFBbUJBLENBQUNHLEdBQUcsRUFBRTtJQUM5QixJQUFJLENBQUNBLEdBQUcsQ0FBQzBELEVBQUUsSUFBSSxDQUFDMUQsR0FBRyxDQUFDMEQsRUFBRSxDQUFDLHFCQUFxQixDQUFDLEVBQUU7TUFDN0MsT0FBTzVCLE9BQU8sQ0FBQ0MsT0FBTyxDQUFDLENBQUM7SUFDMUI7SUFDQSxNQUFNNEIsUUFBUSxHQUFHWixjQUFLLENBQUNhLGdCQUFnQixDQUFDNUQsR0FBRyxDQUFDeEIsTUFBTSxDQUFDcUYsYUFBYSxDQUFDO0lBQ2pFLE9BQU8sSUFBSS9CLE9BQU8sQ0FBQyxDQUFDQyxPQUFPLEVBQUVNLE1BQU0sS0FBSztNQUN0QyxNQUFNeUIsTUFBTSxHQUFHekYsTUFBTSxDQUFDMEYsTUFBTSxDQUFDLElBQUksQ0FBQztNQUNsQyxJQUFJQyxVQUFVLEdBQUcsQ0FBQztNQUNsQixJQUFJQyxPQUFPLEdBQUcsS0FBSztNQUNuQixJQUFJQyxNQUFNO01BQ1YsSUFBSTtRQUNGQSxNQUFNLEdBQUcsSUFBQUMsZUFBTSxFQUFDO1VBQUVoRCxPQUFPLEVBQUVuQixHQUFHLENBQUNtQixPQUFPO1VBQUVpRCxNQUFNLEVBQUU7WUFBRUMsU0FBUyxFQUFFVjtVQUFTO1FBQUUsQ0FBQyxDQUFDO01BQzVFLENBQUMsQ0FBQyxPQUFPVyxHQUFHLEVBQUU7UUFDWixPQUFPakMsTUFBTSxDQUNYLElBQUk1RSxLQUFLLENBQUM0QyxLQUFLLENBQUM1QyxLQUFLLENBQUM0QyxLQUFLLENBQUNrRSxZQUFZLEVBQUUsOEJBQThCRCxHQUFHLENBQUNqRCxPQUFPLEVBQUUsQ0FDdkYsQ0FBQztNQUNIO01BQ0EsTUFBTW1ELFVBQVUsR0FBSUYsR0FBRyxJQUFLO1FBQzFCLElBQUlMLE9BQU8sRUFBRTtVQUNYO1FBQ0Y7UUFDQUEsT0FBTyxHQUFHLElBQUk7UUFDZEMsTUFBTSxDQUFDTyxPQUFPLENBQUMsQ0FBQztRQUNoQnBDLE1BQU0sQ0FBQ2lDLEdBQUcsQ0FBQztNQUNiLENBQUM7TUFDREosTUFBTSxDQUFDUSxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUNDLElBQUksRUFBRW5CLEtBQUssRUFBRW9CLGtCQUFrQixFQUFFQyxjQUFjLEtBQUs7UUFDdEUsSUFBSUEsY0FBYyxFQUFFO1VBQ2xCLE9BQU9MLFVBQVUsQ0FDZixJQUFJL0csS0FBSyxDQUFDNEMsS0FBSyxDQUNiNUMsS0FBSyxDQUFDNEMsS0FBSyxDQUFDeUUsZ0JBQWdCLEVBQzVCLGdEQUNGLENBQ0YsQ0FBQztRQUNIO1FBQ0FkLFVBQVUsSUFBSW5HLE1BQU0sQ0FBQ2tILFVBQVUsQ0FBQ3ZCLEtBQUssQ0FBQztRQUN0QyxJQUFJUSxVQUFVLEdBQUdMLFFBQVEsRUFBRTtVQUN6QixPQUFPYSxVQUFVLENBQ2YsSUFBSS9HLEtBQUssQ0FBQzRDLEtBQUssQ0FDYjVDLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ3lFLGdCQUFnQixFQUM1QixnREFDRixDQUNGLENBQUM7UUFDSDtRQUNBaEIsTUFBTSxDQUFDYSxJQUFJLENBQUMsR0FBR25CLEtBQUs7TUFDdEIsQ0FBQyxDQUFDO01BQ0ZVLE1BQU0sQ0FBQ1EsRUFBRSxDQUFDLE1BQU0sRUFBRSxDQUFDQyxJQUFJLEVBQUVLLE1BQU0sRUFBRUMsUUFBUSxFQUFFQyxnQkFBZ0IsRUFBRUMsUUFBUSxLQUFLO1FBQ3hFLE1BQU1DLE1BQU0sR0FBRyxFQUFFO1FBQ2pCSixNQUFNLENBQUNOLEVBQUUsQ0FBQyxNQUFNLEVBQUVXLEtBQUssSUFBSTtVQUN6QnJCLFVBQVUsSUFBSXFCLEtBQUssQ0FBQ3RILE1BQU07VUFDMUIsSUFBSWlHLFVBQVUsR0FBR0wsUUFBUSxFQUFFO1lBQ3pCcUIsTUFBTSxDQUFDUCxPQUFPLENBQUMsQ0FBQztZQUNoQixPQUFPRCxVQUFVLENBQ2YsSUFBSS9HLEtBQUssQ0FBQzRDLEtBQUssQ0FDYjVDLEtBQUssQ0FBQzRDLEtBQUssQ0FBQ3lFLGdCQUFnQixFQUM1QixnREFDRixDQUNGLENBQUM7VUFDSDtVQUNBTSxNQUFNLENBQUNFLElBQUksQ0FBQ0QsS0FBSyxDQUFDO1FBQ3BCLENBQUMsQ0FBQztRQUNGTCxNQUFNLENBQUNOLEVBQUUsQ0FBQyxLQUFLLEVBQUUsTUFBTTtVQUNyQixJQUFJVCxPQUFPLEVBQUU7WUFDWDtVQUNGO1VBQ0FILE1BQU0sQ0FBQ2EsSUFBSSxDQUFDLEdBQUc7WUFDYk0sUUFBUTtZQUNSTSxXQUFXLEVBQUVKLFFBQVEsSUFBSSwwQkFBMEI7WUFDbkRLLElBQUksRUFBRTNILE1BQU0sQ0FBQzRILE1BQU0sQ0FBQ0wsTUFBTTtVQUM1QixDQUFDO1FBQ0gsQ0FBQyxDQUFDO01BQ0osQ0FBQyxDQUFDO01BQ0ZsQixNQUFNLENBQUNRLEVBQUUsQ0FBQyxRQUFRLEVBQUUsTUFBTTtRQUN4QixJQUFJVCxPQUFPLEVBQUU7VUFDWDtRQUNGO1FBQ0FBLE9BQU8sR0FBRyxJQUFJO1FBQ2RqRSxHQUFHLENBQUNRLElBQUksR0FBR3NELE1BQU07UUFDakIvQixPQUFPLENBQUMsQ0FBQztNQUNYLENBQUMsQ0FBQztNQUNGbUMsTUFBTSxDQUFDUSxFQUFFLENBQUMsT0FBTyxFQUFFSixHQUFHLElBQUk7UUFDeEJFLFVBQVUsQ0FDUixJQUFJL0csS0FBSyxDQUFDNEMsS0FBSyxDQUFDNUMsS0FBSyxDQUFDNEMsS0FBSyxDQUFDa0UsWUFBWSxFQUFFLDhCQUE4QkQsR0FBRyxDQUFDakQsT0FBTyxFQUFFLENBQ3ZGLENBQUM7TUFDSCxDQUFDLENBQUM7TUFDRnJCLEdBQUcsQ0FBQzBGLElBQUksQ0FBQ3hCLE1BQU0sQ0FBQztJQUNsQixDQUFDLENBQUM7RUFDSjtFQUVBLE9BQU9wRSxtQkFBbUJBLENBQUNFLEdBQUcsRUFBRTtJQUM5QixNQUFNMkYsWUFBWSxHQUFHM0YsR0FBRyxDQUFDWCxNQUFNLENBQUNzRyxZQUFZO0lBQzVDLE1BQU1sRixhQUFhLEdBQUdULEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQ2lDLGFBQWE7SUFDOUMsTUFBTW1GLFdBQVcsR0FBR2xJLFFBQVEsQ0FBQ21JLFdBQVcsQ0FBQ0YsWUFBWSxFQUFFbEYsYUFBYSxDQUFDO0lBRXJFLElBQUksQ0FBQ21GLFdBQVcsRUFBRTtNQUNoQixNQUFNLElBQUluSSxLQUFLLENBQUM0QyxLQUFLLENBQUM1QyxLQUFLLENBQUM0QyxLQUFLLENBQUNTLGFBQWEsRUFBRSxzQkFBc0I2RSxZQUFZLEdBQUcsQ0FBQztJQUN6RjtJQUNBLElBQUl0RyxNQUFNLEdBQUdoQixNQUFNLENBQUNNLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRXFCLEdBQUcsQ0FBQ1EsSUFBSSxFQUFFUixHQUFHLENBQUNlLEtBQUssQ0FBQztJQUNuRDFCLE1BQU0sR0FBR0QsV0FBVyxDQUFDQyxNQUFNLEVBQUVXLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQztJQUN4QyxNQUFNd0MsT0FBTyxHQUFHO01BQ2QzQixNQUFNLEVBQUVBLE1BQU07TUFDZGIsTUFBTSxFQUFFd0IsR0FBRyxDQUFDeEIsTUFBTTtNQUNsQnNILE1BQU0sRUFBRTlGLEdBQUcsQ0FBQ0UsSUFBSSxJQUFJRixHQUFHLENBQUNFLElBQUksQ0FBQzZGLFFBQVE7TUFDckM1RixVQUFVLEVBQUUsQ0FBQyxFQUFFSCxHQUFHLENBQUNFLElBQUksSUFBSUYsR0FBRyxDQUFDRSxJQUFJLENBQUNDLFVBQVUsQ0FBQztNQUMvQzZGLElBQUksRUFBRWhHLEdBQUcsQ0FBQ0UsSUFBSSxJQUFJRixHQUFHLENBQUNFLElBQUksQ0FBQzhGLElBQUk7TUFDL0JDLGNBQWMsRUFBRWpHLEdBQUcsQ0FBQ2tHLElBQUksQ0FBQ0QsY0FBYztNQUN2Q2hGLEdBQUcsRUFBRWpCLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQzBDLGdCQUFnQjtNQUNoQ0MsT0FBTyxFQUFFbkIsR0FBRyxDQUFDeEIsTUFBTSxDQUFDMkMsT0FBTztNQUMzQkMsRUFBRSxFQUFFcEIsR0FBRyxDQUFDeEIsTUFBTSxDQUFDNEMsRUFBRTtNQUNqQnVFLFlBQVk7TUFDWlEsT0FBTyxFQUFFbkcsR0FBRyxDQUFDa0csSUFBSSxDQUFDQztJQUNwQixDQUFDO0lBRUQsSUFBSTtNQUNGLE1BQU1DLFdBQVcsR0FBRyxJQUFBQyx3QkFBVSxFQUFDLENBQUM7TUFDaEMsSUFBSUQsV0FBVyxFQUFFO1FBQ2YsSUFBSXBGLE9BQU8sQ0FBQ2dGLElBQUksSUFBSWhGLE9BQU8sQ0FBQ2dGLElBQUksQ0FBQ00sRUFBRSxFQUFFO1VBQ25DRixXQUFXLENBQUNHLE9BQU8sQ0FBQ3ZGLE9BQU8sQ0FBQ2dGLElBQUksQ0FBQ00sRUFBRSxDQUFDO1FBQ3RDO1FBQ0FGLFdBQVcsQ0FBQ0ksYUFBYSxDQUN2QixPQUFPLEVBQ1BDLGNBQU0sQ0FBQ0Msa0JBQWtCLENBQUNyRCxJQUFJLENBQUNDLFNBQVMsQ0FBQzNGLGFBQWEsQ0FBQzBCLE1BQU0sQ0FBQyxDQUFDLENBQ2pFLENBQUM7TUFDSDtJQUNGLENBQUMsQ0FBQyxNQUFNO01BQ047SUFBQTtJQUdGLE9BQU8sSUFBSXlDLE9BQU8sQ0FBQyxVQUFVQyxPQUFPLEVBQUVNLE1BQU0sRUFBRTtNQUM1QyxNQUFNc0UsVUFBVSxHQUFHM0csR0FBRyxDQUFDRSxJQUFJLElBQUlGLEdBQUcsQ0FBQ0UsSUFBSSxDQUFDOEYsSUFBSSxHQUFHaEcsR0FBRyxDQUFDRSxJQUFJLENBQUM4RixJQUFJLENBQUNNLEVBQUUsR0FBR00sU0FBUztNQUMzRSxNQUFNQyxVQUFVLEdBQUd4RCxJQUFJLENBQUNDLFNBQVMsQ0FBQzNGLGFBQWEsQ0FBQzBCLE1BQU0sQ0FBQyxDQUFDO01BQ3hELE1BQU1xRCxjQUFjLEdBQUdsRCxlQUFlLENBQUM0QyxvQkFBb0IsQ0FDekRqRSxNQUFNLElBQUk7UUFDUixJQUFJO1VBQ0YsSUFBSTZCLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQ3NJLFNBQVMsQ0FBQ0Msb0JBQW9CLEtBQUssUUFBUSxFQUFFO1lBQzFELE1BQU1DLFdBQVcsR0FBR1AsY0FBTSxDQUFDQyxrQkFBa0IsQ0FBQ3JELElBQUksQ0FBQ0MsU0FBUyxDQUFDbkYsTUFBTSxDQUFDZ0UsUUFBUSxDQUFDaEUsTUFBTSxDQUFDLENBQUM7WUFDckZzSSxjQUFNLENBQUN6RyxHQUFHLENBQUN4QixNQUFNLENBQUNzSSxTQUFTLENBQUNDLG9CQUFvQixDQUFDLENBQy9DLHNCQUFzQnBCLFlBQVksYUFBYWdCLFVBQVUsaUJBQWlCRSxVQUFVLFlBQVlHLFdBQVcsRUFBRSxFQUM3RztjQUNFckIsWUFBWTtjQUNadEcsTUFBTTtjQUNOMkcsSUFBSSxFQUFFVztZQUNSLENBQ0YsQ0FBQztVQUNIO1VBQ0E1RSxPQUFPLENBQUM1RCxNQUFNLENBQUM7UUFDakIsQ0FBQyxDQUFDLE9BQU9iLENBQUMsRUFBRTtVQUNWK0UsTUFBTSxDQUFDL0UsQ0FBQyxDQUFDO1FBQ1g7TUFDRixDQUFDLEVBQ0QyRSxLQUFLLElBQUk7UUFDUCxJQUFJO1VBQ0YsTUFBTW1FLFdBQVcsR0FBRyxJQUFBQyx3QkFBVSxFQUFDLENBQUM7VUFDaEMsSUFBSUQsV0FBVyxFQUFFO1lBQ2ZBLFdBQVcsQ0FBQ2EsS0FBSyxDQUFDaEYsS0FBSyxDQUFDO1VBQzFCO1VBQ0EsSUFBSWpDLEdBQUcsQ0FBQ3hCLE1BQU0sQ0FBQ3NJLFNBQVMsQ0FBQ0ksa0JBQWtCLEtBQUssUUFBUSxFQUFFO1lBQ3hEVCxjQUFNLENBQUN6RyxHQUFHLENBQUN4QixNQUFNLENBQUNzSSxTQUFTLENBQUNJLGtCQUFrQixDQUFDLENBQzdDLGlDQUFpQ3ZCLFlBQVksYUFBYWdCLFVBQVUsaUJBQWlCRSxVQUFVLFVBQVUsR0FDdkd4RCxJQUFJLENBQUNDLFNBQVMsQ0FBQ3JCLEtBQUssQ0FBQyxFQUN2QjtjQUNFMEQsWUFBWTtjQUNaMUQsS0FBSztjQUNMNUMsTUFBTTtjQUNOMkcsSUFBSSxFQUFFVztZQUNSLENBQ0YsQ0FBQztVQUNIO1VBQ0F0RSxNQUFNLENBQUNKLEtBQUssQ0FBQztRQUNmLENBQUMsQ0FBQyxPQUFPM0UsQ0FBQyxFQUFFO1VBQ1YrRSxNQUFNLENBQUMvRSxDQUFDLENBQUM7UUFDWDtNQUNGLENBQ0YsQ0FBQztNQUNELE1BQU07UUFBRXFGLE9BQU87UUFBRVY7TUFBTSxDQUFDLEdBQUdTLGNBQWM7TUFFekMsT0FBT1osT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUNyQk4sSUFBSSxDQUFDLE1BQU07UUFDVixPQUFPL0QsUUFBUSxDQUFDeUosaUJBQWlCLENBQUNuRyxPQUFPLEVBQUUyRSxZQUFZLEVBQUUzRixHQUFHLENBQUNFLElBQUksQ0FBQztNQUNwRSxDQUFDLENBQUMsQ0FDRHVCLElBQUksQ0FBQyxNQUFNO1FBQ1Y7UUFDQSxJQUFJbUUsV0FBVyxDQUFDN0gsTUFBTSxJQUFJLENBQUMsRUFBRTtVQUMzQixPQUFPNkgsV0FBVyxDQUFDNUUsT0FBTyxFQUFFMEIsY0FBYyxDQUFDO1FBQzdDLENBQUMsTUFBTTtVQUNMO1VBQ0EsT0FBT2tELFdBQVcsQ0FBQzVFLE9BQU8sQ0FBQztRQUM3QjtNQUNGLENBQUMsQ0FBQyxDQUNEUyxJQUFJLENBQUN0RCxNQUFNLElBQUk7UUFDZDtRQUNBLElBQUl5SCxXQUFXLENBQUM3SCxNQUFNLElBQUksQ0FBQyxFQUFFO1VBQzNCLElBQUksQ0FBQzJFLGNBQWMsQ0FBQ2UsZUFBZSxDQUFDLENBQUMsRUFBRTtZQUNyQztZQUNBLElBQUl0RixNQUFNLEtBQUt5SSxTQUFTLEVBQUU7Y0FDeEJqRSxPQUFPLENBQUN4RSxNQUFNLENBQUM7WUFDakI7WUFDQTtZQUNBO1VBQ0Y7UUFDRixDQUFDLE1BQU07VUFDTDtVQUNBd0UsT0FBTyxDQUFDeEUsTUFBTSxDQUFDO1FBQ2pCO01BQ0YsQ0FBQyxFQUFFOEQsS0FBSyxDQUFDO0lBQ2IsQ0FBQyxDQUFDO0VBQ0o7QUFDRjtBQUFDbUYsT0FBQSxDQUFBNUgsZUFBQSxHQUFBQSxlQUFBIiwiaWdub3JlTGlzdCI6W119