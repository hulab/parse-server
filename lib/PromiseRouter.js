'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _express = require('express');

var _express2 = _interopRequireDefault(_express);

var _logger = require('./logger');

var _logger2 = _interopRequireDefault(_logger);

var _util = require('util');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A router that is based on promises rather than req/res/next.
// This is intended to replace the use of express.Router to handle
// subsections of the API surface.
// This will make it easier to have methods like 'batch' that
// themselves use our routing information, without disturbing express
// components that external developers may be modifying.

const Layer = require('express/lib/router/layer');

function validateParameter(key, value) {
  if (key == 'className') {
    if (value.match(/_?[A-Za-z][A-Za-z_0-9]*/)) {
      return value;
    }
  } else if (key == 'objectId') {
    if (value.match(/[A-Za-z0-9]+/)) {
      return value;
    }
  } else {
    return value;
  }
}

class PromiseRouter {
  // Each entry should be an object with:
  // path: the path to route, in express format
  // method: the HTTP method that this route handles.
  //   Must be one of: POST, GET, PUT, DELETE
  // handler: a function that takes request, and returns a promise.
  //   Successful handlers should resolve to an object with fields:
  //     status: optional. the http status code. defaults to 200
  //     response: a json object with the content of the response
  //     location: optional. a location header
  constructor(routes = [], appId) {
    this.routes = routes;
    this.appId = appId;
    this.mountRoutes();
  }

  // Leave the opportunity to
  // subclasses to mount their routes by overriding
  mountRoutes() {}

  // Merge the routes into this one
  merge(router) {
    for (var route of router.routes) {
      this.routes.push(route);
    }
  }

  route(method, path, ...handlers) {
    switch (method) {
      case 'POST':
      case 'GET':
      case 'PUT':
      case 'DELETE':
        break;
      default:
        throw 'cannot route method: ' + method;
    }

    let handler = handlers[0];

    if (handlers.length > 1) {
      handler = function (req) {
        return handlers.reduce((promise, handler) => {
          return promise.then(() => {
            return handler(req);
          });
        }, Promise.resolve());
      };
    }

    this.routes.push({
      path: path,
      method: method,
      handler: handler,
      layer: new Layer(path, null, handler)
    });
  }

  // Returns an object with:
  //   handler: the handler that should deal with this request
  //   params: any :-params that got parsed from the path
  // Returns undefined if there is no match.
  match(method, path) {
    for (var route of this.routes) {
      if (route.method != method) {
        continue;
      }
      const layer = route.layer || new Layer(route.path, null, route.handler);
      const match = layer.match(path);
      if (match) {
        const params = layer.params;
        Object.keys(params).forEach(key => {
          params[key] = validateParameter(key, params[key]);
        });
        return { params: params, handler: route.handler };
      }
    }
  }

  // Mount the routes on this router onto an express app (or express router)
  mountOnto(expressApp) {
    this.routes.forEach(route => {
      const method = route.method.toLowerCase();
      const handler = makeExpressHandler(this.appId, route.handler);
      expressApp[method].call(expressApp, route.path, handler);
    });
    return expressApp;
  }

  expressRouter() {
    return this.mountOnto(_express2.default.Router());
  }

  tryRouteRequest(method, path, request) {
    var match = this.match(method, path);
    if (!match) {
      throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'cannot route ' + method + ' ' + path);
    }
    request.params = match.params;
    return new Promise((resolve, reject) => {
      match.handler(request).then(resolve, reject);
    });
  }
}

exports.default = PromiseRouter; // A helper function to make an express handler out of a a promise
// handler.
// Express handlers should never throw; if a promise handler throws we
// just treat it like it resolved to an error.

function makeExpressHandler(appId, promiseHandler) {
  return function (req, res, next) {
    try {
      const url = maskSensitiveUrl(req);
      const body = Object.assign({}, req.body);
      const method = req.method;
      const headers = req.headers;
      _logger2.default.logRequest({
        method,
        url,
        headers,
        body
      });
      promiseHandler(req).then(result => {
        if (!result.response && !result.location && !result.text) {
          _logger2.default.error('the handler did not include a "response" or a "location" field');
          throw 'control should not get here';
        }

        _logger2.default.logResponse({ method, url, result });

        var status = result.status || 200;
        res.status(status);

        if (result.text) {
          res.send(result.text);
          return;
        }

        if (result.location) {
          res.set('Location', result.location);
          // Override the default expressjs response
          // as it double encodes %encoded chars in URL
          if (!result.response) {
            res.send('Found. Redirecting to ' + result.location);
            return;
          }
        }
        if (result.headers) {
          Object.keys(result.headers).forEach(header => {
            res.set(header, result.headers[header]);
          });
        }
        res.json(result.response);
      }, error => next(error)).catch(e => {
        _logger2.default.error(`Error generating response. ${(0, _util.inspect)(e)}`, { error: e });
        next(e);
      });
    } catch (e) {
      _logger2.default.error(`Error handling request: ${(0, _util.inspect)(e)}`, { error: e });
      next(e);
    }
  };
}

function maskSensitiveUrl(req) {
  let maskUrl = req.originalUrl.toString();
  const shouldMaskUrl = req.method === 'GET' && req.originalUrl.includes('/login') && !req.originalUrl.includes('classes');
  if (shouldMaskUrl) {
    maskUrl = _logger2.default.maskSensitiveUrl(maskUrl);
  }
  return maskUrl;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9Qcm9taXNlUm91dGVyLmpzIl0sIm5hbWVzIjpbIkxheWVyIiwicmVxdWlyZSIsInZhbGlkYXRlUGFyYW1ldGVyIiwia2V5IiwidmFsdWUiLCJtYXRjaCIsIlByb21pc2VSb3V0ZXIiLCJjb25zdHJ1Y3RvciIsInJvdXRlcyIsImFwcElkIiwibW91bnRSb3V0ZXMiLCJtZXJnZSIsInJvdXRlciIsInJvdXRlIiwicHVzaCIsIm1ldGhvZCIsInBhdGgiLCJoYW5kbGVycyIsImhhbmRsZXIiLCJsZW5ndGgiLCJyZXEiLCJyZWR1Y2UiLCJwcm9taXNlIiwidGhlbiIsIlByb21pc2UiLCJyZXNvbHZlIiwibGF5ZXIiLCJwYXJhbXMiLCJPYmplY3QiLCJrZXlzIiwiZm9yRWFjaCIsIm1vdW50T250byIsImV4cHJlc3NBcHAiLCJ0b0xvd2VyQ2FzZSIsIm1ha2VFeHByZXNzSGFuZGxlciIsImNhbGwiLCJleHByZXNzUm91dGVyIiwiZXhwcmVzcyIsIlJvdXRlciIsInRyeVJvdXRlUmVxdWVzdCIsInJlcXVlc3QiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9KU09OIiwicmVqZWN0IiwicHJvbWlzZUhhbmRsZXIiLCJyZXMiLCJuZXh0IiwidXJsIiwibWFza1NlbnNpdGl2ZVVybCIsImJvZHkiLCJhc3NpZ24iLCJoZWFkZXJzIiwibG9nIiwibG9nUmVxdWVzdCIsInJlc3VsdCIsInJlc3BvbnNlIiwibG9jYXRpb24iLCJ0ZXh0IiwiZXJyb3IiLCJsb2dSZXNwb25zZSIsInN0YXR1cyIsInNlbmQiLCJzZXQiLCJoZWFkZXIiLCJqc29uIiwiY2F0Y2giLCJlIiwibWFza1VybCIsIm9yaWdpbmFsVXJsIiwidG9TdHJpbmciLCJzaG91bGRNYXNrVXJsIiwiaW5jbHVkZXMiXSwibWFwcGluZ3MiOiI7Ozs7OztBQU9BOzs7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7O0FBVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQU1BLE1BQU1BLFFBQVFDLFFBQVEs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IjoiUHJvbWlzZVJvdXRlci5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8vIEEgcm91dGVyIHRoYXQgaXMgYmFzZWQgb24gcHJvbWlzZXMgcmF0aGVyIHRoYW4gcmVxL3Jlcy9uZXh0LlxuLy8gVGhpcyBpcyBpbnRlbmRlZCB0byByZXBsYWNlIHRoZSB1c2Ugb2YgZXhwcmVzcy5Sb3V0ZXIgdG8gaGFuZGxlXG4vLyBzdWJzZWN0aW9ucyBvZiB0aGUgQVBJIHN1cmZhY2UuXG4vLyBUaGlzIHdpbGwgbWFrZSBpdCBlYXNpZXIgdG8gaGF2ZSBtZXRob2RzIGxpa2UgJ2JhdGNoJyB0aGF0XG4vLyB0aGVtc2VsdmVzIHVzZSBvdXIgcm91dGluZyBpbmZvcm1hdGlvbiwgd2l0aG91dCBkaXN0dXJiaW5nIGV4cHJlc3Ncbi8vIGNvbXBvbmVudHMgdGhhdCBleHRlcm5hbCBkZXZlbG9wZXJzIG1heSBiZSBtb2RpZnlpbmcuXG5cbmltcG9ydCBQYXJzZSAgICAgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgZXhwcmVzcyAgIGZyb20gJ2V4cHJlc3MnO1xuaW1wb3J0IGxvZyAgICAgICBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQge2luc3BlY3R9IGZyb20gJ3V0aWwnO1xuY29uc3QgTGF5ZXIgPSByZXF1aXJlKCdleHByZXNzL2xpYi9yb3V0ZXIvbGF5ZXInKTtcblxuZnVuY3Rpb24gdmFsaWRhdGVQYXJhbWV0ZXIoa2V5LCB2YWx1ZSkge1xuICBpZiAoa2V5ID09ICdjbGFzc05hbWUnKSB7XG4gICAgaWYgKHZhbHVlLm1hdGNoKC9fP1tBLVphLXpdW0EtWmEtel8wLTldKi8pKSB7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuICB9IGVsc2UgaWYgKGtleSA9PSAnb2JqZWN0SWQnKSB7XG4gICAgaWYgKHZhbHVlLm1hdGNoKC9bQS1aYS16MC05XSsvKSkge1xuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBQcm9taXNlUm91dGVyIHtcbiAgLy8gRWFjaCBlbnRyeSBzaG91bGQgYmUgYW4gb2JqZWN0IHdpdGg6XG4gIC8vIHBhdGg6IHRoZSBwYXRoIHRvIHJvdXRlLCBpbiBleHByZXNzIGZvcm1hdFxuICAvLyBtZXRob2Q6IHRoZSBIVFRQIG1ldGhvZCB0aGF0IHRoaXMgcm91dGUgaGFuZGxlcy5cbiAgLy8gICBNdXN0IGJlIG9uZSBvZjogUE9TVCwgR0VULCBQVVQsIERFTEVURVxuICAvLyBoYW5kbGVyOiBhIGZ1bmN0aW9uIHRoYXQgdGFrZXMgcmVxdWVzdCwgYW5kIHJldHVybnMgYSBwcm9taXNlLlxuICAvLyAgIFN1Y2Nlc3NmdWwgaGFuZGxlcnMgc2hvdWxkIHJlc29sdmUgdG8gYW4gb2JqZWN0IHdpdGggZmllbGRzOlxuICAvLyAgICAgc3RhdHVzOiBvcHRpb25hbC4gdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGRlZmF1bHRzIHRvIDIwMFxuICAvLyAgICAgcmVzcG9uc2U6IGEganNvbiBvYmplY3Qgd2l0aCB0aGUgY29udGVudCBvZiB0aGUgcmVzcG9uc2VcbiAgLy8gICAgIGxvY2F0aW9uOiBvcHRpb25hbC4gYSBsb2NhdGlvbiBoZWFkZXJcbiAgY29uc3RydWN0b3Iocm91dGVzID0gW10sIGFwcElkKSB7XG4gICAgdGhpcy5yb3V0ZXMgPSByb3V0ZXM7XG4gICAgdGhpcy5hcHBJZCA9IGFwcElkO1xuICAgIHRoaXMubW91bnRSb3V0ZXMoKTtcbiAgfVxuXG4gIC8vIExlYXZlIHRoZSBvcHBvcnR1bml0eSB0b1xuICAvLyBzdWJjbGFzc2VzIHRvIG1vdW50IHRoZWlyIHJvdXRlcyBieSBvdmVycmlkaW5nXG4gIG1vdW50Um91dGVzKCkge31cblxuICAvLyBNZXJnZSB0aGUgcm91dGVzIGludG8gdGhpcyBvbmVcbiAgbWVyZ2Uocm91dGVyKSB7XG4gICAgZm9yICh2YXIgcm91dGUgb2Ygcm91dGVyLnJvdXRlcykge1xuICAgICAgdGhpcy5yb3V0ZXMucHVzaChyb3V0ZSk7XG4gICAgfVxuICB9XG5cbiAgcm91dGUobWV0aG9kLCBwYXRoLCAuLi5oYW5kbGVycykge1xuICAgIHN3aXRjaChtZXRob2QpIHtcbiAgICBjYXNlICdQT1NUJzpcbiAgICBjYXNlICdHRVQnOlxuICAgIGNhc2UgJ1BVVCc6XG4gICAgY2FzZSAnREVMRVRFJzpcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyAnY2Fubm90IHJvdXRlIG1ldGhvZDogJyArIG1ldGhvZDtcbiAgICB9XG5cbiAgICBsZXQgaGFuZGxlciA9IGhhbmRsZXJzWzBdO1xuXG4gICAgaWYgKGhhbmRsZXJzLmxlbmd0aCA+IDEpIHtcbiAgICAgIGhhbmRsZXIgPSBmdW5jdGlvbihyZXEpIHtcbiAgICAgICAgcmV0dXJuIGhhbmRsZXJzLnJlZHVjZSgocHJvbWlzZSwgaGFuZGxlcikgPT4ge1xuICAgICAgICAgIHJldHVybiBwcm9taXNlLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXIocmVxKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgUHJvbWlzZS5yZXNvbHZlKCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMucm91dGVzLnB1c2goe1xuICAgICAgcGF0aDogcGF0aCxcbiAgICAgIG1ldGhvZDogbWV0aG9kLFxuICAgICAgaGFuZGxlcjogaGFuZGxlcixcbiAgICAgIGxheWVyOiBuZXcgTGF5ZXIocGF0aCwgbnVsbCwgaGFuZGxlcilcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYW4gb2JqZWN0IHdpdGg6XG4gIC8vICAgaGFuZGxlcjogdGhlIGhhbmRsZXIgdGhhdCBzaG91bGQgZGVhbCB3aXRoIHRoaXMgcmVxdWVzdFxuICAvLyAgIHBhcmFtczogYW55IDotcGFyYW1zIHRoYXQgZ290IHBhcnNlZCBmcm9tIHRoZSBwYXRoXG4gIC8vIFJldHVybnMgdW5kZWZpbmVkIGlmIHRoZXJlIGlzIG5vIG1hdGNoLlxuICBtYXRjaChtZXRob2QsIHBhdGgpIHtcbiAgICBmb3IgKHZhciByb3V0ZSBvZiB0aGlzLnJvdXRlcykge1xuICAgICAgaWYgKHJvdXRlLm1ldGhvZCAhPSBtZXRob2QpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBsYXllciA9IHJvdXRlLmxheWVyIHx8IG5ldyBMYXllcihyb3V0ZS5wYXRoLCBudWxsLCByb3V0ZS5oYW5kbGVyKTtcbiAgICAgIGNvbnN0IG1hdGNoID0gbGF5ZXIubWF0Y2gocGF0aCk7XG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgY29uc3QgcGFyYW1zID0gbGF5ZXIucGFyYW1zO1xuICAgICAgICBPYmplY3Qua2V5cyhwYXJhbXMpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsaWRhdGVQYXJhbWV0ZXIoa2V5LCBwYXJhbXNba2V5XSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4ge3BhcmFtczogcGFyYW1zLCBoYW5kbGVyOiByb3V0ZS5oYW5kbGVyfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBNb3VudCB0aGUgcm91dGVzIG9uIHRoaXMgcm91dGVyIG9udG8gYW4gZXhwcmVzcyBhcHAgKG9yIGV4cHJlc3Mgcm91dGVyKVxuICBtb3VudE9udG8oZXhwcmVzc0FwcCkge1xuICAgIHRoaXMucm91dGVzLmZvckVhY2goKHJvdXRlKSA9PiB7XG4gICAgICBjb25zdCBtZXRob2QgPSByb3V0ZS5tZXRob2QudG9Mb3dlckNhc2UoKTtcbiAgICAgIGNvbnN0IGhhbmRsZXIgPSBtYWtlRXhwcmVzc0hhbmRsZXIodGhpcy5hcHBJZCwgcm91dGUuaGFuZGxlcik7XG4gICAgICBleHByZXNzQXBwW21ldGhvZF0uY2FsbChleHByZXNzQXBwLCByb3V0ZS5wYXRoLCBoYW5kbGVyKTtcbiAgICB9KTtcbiAgICByZXR1cm4gZXhwcmVzc0FwcDtcbiAgfVxuXG4gIGV4cHJlc3NSb3V0ZXIoKSB7XG4gICAgcmV0dXJuIHRoaXMubW91bnRPbnRvKGV4cHJlc3MuUm91dGVyKCkpO1xuICB9XG5cbiAgdHJ5Um91dGVSZXF1ZXN0KG1ldGhvZCwgcGF0aCwgcmVxdWVzdCkge1xuICAgIHZhciBtYXRjaCA9IHRoaXMubWF0Y2gobWV0aG9kLCBwYXRoKTtcbiAgICBpZiAoIW1hdGNoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgJ2Nhbm5vdCByb3V0ZSAnICsgbWV0aG9kICsgJyAnICsgcGF0aCk7XG4gICAgfVxuICAgIHJlcXVlc3QucGFyYW1zID0gbWF0Y2gucGFyYW1zO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBtYXRjaC5oYW5kbGVyKHJlcXVlc3QpLnRoZW4ocmVzb2x2ZSwgcmVqZWN0KTtcbiAgICB9KTtcbiAgfVxufVxuXG4vLyBBIGhlbHBlciBmdW5jdGlvbiB0byBtYWtlIGFuIGV4cHJlc3MgaGFuZGxlciBvdXQgb2YgYSBhIHByb21pc2Vcbi8vIGhhbmRsZXIuXG4vLyBFeHByZXNzIGhhbmRsZXJzIHNob3VsZCBuZXZlciB0aHJvdzsgaWYgYSBwcm9taXNlIGhhbmRsZXIgdGhyb3dzIHdlXG4vLyBqdXN0IHRyZWF0IGl0IGxpa2UgaXQgcmVzb2x2ZWQgdG8gYW4gZXJyb3IuXG5mdW5jdGlvbiBtYWtlRXhwcmVzc0hhbmRsZXIoYXBwSWQsIHByb21pc2VIYW5kbGVyKSB7XG4gIHJldHVybiBmdW5jdGlvbihyZXEsIHJlcywgbmV4dCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB1cmwgPSBtYXNrU2Vuc2l0aXZlVXJsKHJlcSk7XG4gICAgICBjb25zdCBib2R5ID0gT2JqZWN0LmFzc2lnbih7fSwgcmVxLmJvZHkpO1xuICAgICAgY29uc3QgbWV0aG9kID0gcmVxLm1ldGhvZDtcbiAgICAgIGNvbnN0IGhlYWRlcnMgPSByZXEuaGVhZGVycztcbiAgICAgIGxvZy5sb2dSZXF1ZXN0KHtcbiAgICAgICAgbWV0aG9kLFxuICAgICAgICB1cmwsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHlcbiAgICAgIH0pO1xuICAgICAgcHJvbWlzZUhhbmRsZXIocmVxKS50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgaWYgKCFyZXN1bHQucmVzcG9uc2UgJiYgIXJlc3VsdC5sb2NhdGlvbiAmJiAhcmVzdWx0LnRleHQpIHtcbiAgICAgICAgICBsb2cuZXJyb3IoJ3RoZSBoYW5kbGVyIGRpZCBub3QgaW5jbHVkZSBhIFwicmVzcG9uc2VcIiBvciBhIFwibG9jYXRpb25cIiBmaWVsZCcpO1xuICAgICAgICAgIHRocm93ICdjb250cm9sIHNob3VsZCBub3QgZ2V0IGhlcmUnO1xuICAgICAgICB9XG5cbiAgICAgICAgbG9nLmxvZ1Jlc3BvbnNlKHsgbWV0aG9kLCB1cmwsIHJlc3VsdCB9KTtcblxuICAgICAgICB2YXIgc3RhdHVzID0gcmVzdWx0LnN0YXR1cyB8fCAyMDA7XG4gICAgICAgIHJlcy5zdGF0dXMoc3RhdHVzKTtcblxuICAgICAgICBpZiAocmVzdWx0LnRleHQpIHtcbiAgICAgICAgICByZXMuc2VuZChyZXN1bHQudGV4dCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlc3VsdC5sb2NhdGlvbikge1xuICAgICAgICAgIHJlcy5zZXQoJ0xvY2F0aW9uJywgcmVzdWx0LmxvY2F0aW9uKTtcbiAgICAgICAgICAvLyBPdmVycmlkZSB0aGUgZGVmYXVsdCBleHByZXNzanMgcmVzcG9uc2VcbiAgICAgICAgICAvLyBhcyBpdCBkb3VibGUgZW5jb2RlcyAlZW5jb2RlZCBjaGFycyBpbiBVUkxcbiAgICAgICAgICBpZiAoIXJlc3VsdC5yZXNwb25zZSkge1xuICAgICAgICAgICAgcmVzLnNlbmQoJ0ZvdW5kLiBSZWRpcmVjdGluZyB0byAnICsgcmVzdWx0LmxvY2F0aW9uKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5oZWFkZXJzKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMocmVzdWx0LmhlYWRlcnMpLmZvckVhY2goKGhlYWRlcikgPT4ge1xuICAgICAgICAgICAgcmVzLnNldChoZWFkZXIsIHJlc3VsdC5oZWFkZXJzW2hlYWRlcl0pO1xuICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICAgICAgcmVzLmpzb24ocmVzdWx0LnJlc3BvbnNlKTtcbiAgICAgIH0sIChlcnJvcikgPT4gbmV4dChlcnJvcikpLmNhdGNoKChlKSA9PiB7XG4gICAgICAgIGxvZy5lcnJvcihgRXJyb3IgZ2VuZXJhdGluZyByZXNwb25zZS4gJHtpbnNwZWN0KGUpfWAsIHtlcnJvcjogZX0pO1xuICAgICAgICBuZXh0KGUpO1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nLmVycm9yKGBFcnJvciBoYW5kbGluZyByZXF1ZXN0OiAke2luc3BlY3QoZSl9YCwge2Vycm9yOiBlfSk7XG4gICAgICBuZXh0KGUpO1xuICAgIH1cbiAgfVxufVxuXG5cbmZ1bmN0aW9uIG1hc2tTZW5zaXRpdmVVcmwocmVxKSB7XG4gIGxldCBtYXNrVXJsID0gcmVxLm9yaWdpbmFsVXJsLnRvU3RyaW5nKCk7XG4gIGNvbnN0IHNob3VsZE1hc2tVcmwgPSByZXEubWV0aG9kID09PSAnR0VUJyAmJiByZXEub3JpZ2luYWxVcmwuaW5jbHVkZXMoJy9sb2dpbicpXG4gICAgICAgICAgICAgICAgICAgICAgJiYgIXJlcS5vcmlnaW5hbFVybC5pbmNsdWRlcygnY2xhc3NlcycpO1xuICBpZiAoc2hvdWxkTWFza1VybCkge1xuICAgIG1hc2tVcmwgPSBsb2cubWFza1NlbnNpdGl2ZVVybChtYXNrVXJsKTtcbiAgfVxuICByZXR1cm4gbWFza1VybDtcbn1cbiJdfQ==