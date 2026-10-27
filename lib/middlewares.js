"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addRateLimit = exports.DEFAULT_ALLOWED_HEADERS = void 0;
exports.allowCrossDomain = allowCrossDomain;
exports.allowDoubleForwardSlash = allowDoubleForwardSlash;
exports.allowMethodOverride = allowMethodOverride;
exports.checkIp = void 0;
exports.enforceMasterKeyAccess = enforceMasterKeyAccess;
exports.enforceRouteAllowList = enforceRouteAllowList;
exports.getRateLimitStorePrefix = void 0;
exports.handleParseAuth = handleParseAuth;
exports.handleParseErrors = handleParseErrors;
exports.handleParseHeaders = handleParseHeaders;
exports.handleParseHealth = handleParseHealth;
exports.handleParseSession = void 0;
exports.isRouteAllowed = isRouteAllowed;
exports.matchesExactRoute = matchesExactRoute;
exports.promiseEnforceMasterKeyAccess = promiseEnforceMasterKeyAccess;
exports.promiseEnsureIdempotency = promiseEnsureIdempotency;
var _cache = _interopRequireDefault(require("./cache"));
var _Utils = _interopRequireDefault(require("./Utils"));
var _node = _interopRequireDefault(require("parse/node"));
var _Auth = _interopRequireDefault(require("./Auth"));
var _Config = _interopRequireDefault(require("./Config"));
var _logger = _interopRequireDefault(require("./logger"));
var _rest = _interopRequireDefault(require("./rest"));
var _MongoStorageAdapter = _interopRequireDefault(require("./Adapters/Storage/Mongo/MongoStorageAdapter"));
var _PostgresStorageAdapter = _interopRequireDefault(require("./Adapters/Storage/Postgres/PostgresStorageAdapter"));
var _expressRateLimit = _interopRequireDefault(require("express-rate-limit"));
var _Definitions = require("./Options/Definitions");
var _pathToRegexp = require("path-to-regexp");
var _rateLimitRedis = _interopRequireDefault(require("rate-limit-redis"));
var _redis = require("redis");
var _net = require("net");
var _crypto = require("crypto");
var _Error = require("./Error");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const DEFAULT_ALLOWED_HEADERS = exports.DEFAULT_ALLOWED_HEADERS = 'X-Parse-Master-Key, X-Parse-REST-API-Key, X-Parse-Javascript-Key, X-Parse-Application-Id, X-Parse-Client-Version, X-Parse-Session-Token, X-Requested-With, X-Parse-Revocable-Session, X-Parse-Request-Id, Content-Type, Pragma, Cache-Control';
const getMountForRequest = function (req) {
  const mountPathLength = req.originalUrl.length - req.url.length;
  const mountPath = req.originalUrl.slice(0, mountPathLength);
  return req.protocol + '://' + req.get('host') + mountPath;
};
const getBlockList = (ipRangeList, store) => {
  if (store.get('blockList')) {
    return store.get('blockList');
  }
  const blockList = new _net.BlockList();
  ipRangeList.forEach(fullIp => {
    if (fullIp === '::/0' || fullIp === '::' || fullIp === '::0') {
      store.set('allowAllIpv6', true);
      return;
    }
    if (fullIp === '0.0.0.0/0' || fullIp === '0.0.0.0') {
      store.set('allowAllIpv4', true);
      return;
    }
    const [ip, mask] = fullIp.split('/');
    if (!mask) {
      blockList.addAddress(ip, (0, _net.isIPv4)(ip) ? 'ipv4' : 'ipv6');
    } else {
      blockList.addSubnet(ip, Number(mask), (0, _net.isIPv4)(ip) ? 'ipv4' : 'ipv6');
    }
  });
  store.set('blockList', blockList);
  return blockList;
};
const checkIp = (ip, ipRangeList, store) => {
  const incomingIpIsV4 = (0, _net.isIPv4)(ip);
  const blockList = getBlockList(ipRangeList, store);
  if (store.get(ip)) {
    return true;
  }
  if (store.get('allowAllIpv4') && incomingIpIsV4) {
    return true;
  }
  if (store.get('allowAllIpv6') && !incomingIpIsV4) {
    return true;
  }
  const result = blockList.check(ip, incomingIpIsV4 ? 'ipv4' : 'ipv6');

  // If the ip is in the list, we store the result in the store
  // so we have a optimized path for the next request
  if (ipRangeList.includes(ip) && result) {
    store.set(ip, result);
  }
  return result;
};

// Checks that the request is authorized for this app and checks user
// auth too.
// The bodyparser should run before this middleware.
// Adds info to the request:
// req.config - the Config for this app
// req.auth - the Auth for this request
exports.checkIp = checkIp;
async function handleParseHeaders(req, res, next) {
  var mount = getMountForRequest(req);
  let context = {};
  if (req.get('X-Parse-Cloud-Context') != null) {
    try {
      context = JSON.parse(req.get('X-Parse-Cloud-Context'));
      if (Object.prototype.toString.call(context) !== '[object Object]') {
        throw 'Context is not an object';
      }
    } catch {
      return malformedContext(req, res);
    }
  }
  var info = {
    appId: req.get('X-Parse-Application-Id'),
    sessionToken: req.get('X-Parse-Session-Token'),
    masterKey: req.get('X-Parse-Master-Key'),
    maintenanceKey: req.get('X-Parse-Maintenance-Key'),
    installationId: req.get('X-Parse-Installation-Id'),
    clientKey: req.get('X-Parse-Client-Key'),
    javascriptKey: req.get('X-Parse-Javascript-Key'),
    dotNetKey: req.get('X-Parse-Windows-Key'),
    restAPIKey: req.get('X-Parse-REST-API-Key'),
    context: context
  };
  var basicAuth = httpAuth(req);
  if (basicAuth) {
    var basicAuthAppId = basicAuth.appId;
    if (_cache.default.get(basicAuthAppId)) {
      info.appId = basicAuthAppId;
      info.masterKey = basicAuth.masterKey || info.masterKey;
      info.javascriptKey = basicAuth.javascriptKey || info.javascriptKey;
    }
  }
  if (req.body) {
    // Unity SDK sends a _noBody key which needs to be removed.
    // Unclear at this point if action needs to be taken.
    delete req.body._noBody;
  }
  var fileViaJSON = false;
  if (!info.appId || !_cache.default.get(info.appId)) {
    // See if we can find the app id on the body.
    if (Buffer.isBuffer(req.body)) {
      // The only chance to find the app id is if this is a file
      // upload that actually is a JSON body. So try to parse it.
      // https://github.com/parse-community/parse-server/issues/6589
      // It is also possible that the client is trying to upload a file but forgot
      // to provide x-parse-app-id in header and parse a binary file will fail
      try {
        req.body = JSON.parse(req.body);
      } catch {
        return invalidRequest(req, res);
      }
      fileViaJSON = true;
    }
    if (req.body) {
      delete req.body._RevocableSession;
    }
    if (req.body && req.body._ApplicationId && _cache.default.get(req.body._ApplicationId) && (!info.masterKey || _cache.default.get(req.body._ApplicationId).masterKey === info.masterKey)) {
      info.appId = req.body._ApplicationId;
      info.javascriptKey = req.body._JavaScriptKey || '';
      delete req.body._ApplicationId;
      delete req.body._JavaScriptKey;
      // TODO: test that the REST API formats generated by the other
      // SDKs are handled ok
      delete req.body._ClientVersion;
      if (req.body._InstallationId) {
        if (typeof req.body._InstallationId !== 'string') {
          return invalidRequest(req, res);
        }
        info.installationId = req.body._InstallationId;
        delete req.body._InstallationId;
      }
      if (req.body._SessionToken) {
        if (typeof req.body._SessionToken !== 'string') {
          return invalidRequest(req, res);
        }
        info.sessionToken = req.body._SessionToken;
        delete req.body._SessionToken;
      }
      if (req.body._MasterKey) {
        if (typeof req.body._MasterKey !== 'string') {
          return invalidRequest(req, res);
        }
        info.masterKey = req.body._MasterKey;
        delete req.body._MasterKey;
      }
      if (req.body._context) {
        if (_Utils.default.isObject(req.body._context)) {
          info.context = req.body._context;
        } else {
          try {
            info.context = JSON.parse(req.body._context);
            if (Object.prototype.toString.call(info.context) !== '[object Object]') {
              throw 'Context is not an object';
            }
          } catch {
            return malformedContext(req, res);
          }
        }
        delete req.body._context;
      } else if (req.body._context === null) {
        // null context is equivalent to no context
        delete req.body._context;
      }
      if (req.body._ContentType) {
        if (typeof req.body._ContentType !== 'string') {
          return invalidRequest(req, res);
        }
        req.headers['content-type'] = req.body._ContentType;
        delete req.body._ContentType;
      }
    } else {
      return invalidRequest(req, res);
    }
  }
  if (info.sessionToken && typeof info.sessionToken !== 'string') {
    return invalidRequest(req, res);
  }
  if (fileViaJSON && req.body) {
    if (req.body.base64 && typeof req.body.base64 !== 'string') {
      return invalidRequest(req, res);
    }
    req.fileData = req.body.fileData;
    // We need to repopulate req.body with a buffer
    var base64 = req.body.base64;
    req.body = Buffer.from(base64, 'base64');
  }
  const clientIp = getClientIp(req);
  const config = req.config || _Config.default.get(info.appId, mount);
  if (config.state && config.state !== 'ok') {
    res.status(500);
    res.json({
      code: _node.default.Error.INTERNAL_SERVER_ERROR,
      error: `Invalid server state: ${config.state}`
    });
    return;
  }
  if (!req.config) {
    await config.loadKeys();
  }
  info.app = _cache.default.get(info.appId);
  req.config = config;
  req.config.headers = req.headers || {};
  req.config.ip = clientIp;
  req.info = info;

  // Skip key detection if already resolved by handleParseAuth (header-based).
  // Only resolve here for body-based _MasterKey (info.masterKey may come from body).
  if (!req.auth || !req.auth.isMaster && !req.auth.isMaintenance) {
    const resolved = await resolveKeyAuth({
      config: req.config,
      keyValue: info.masterKey,
      maintenanceKeyValue: info.maintenanceKey,
      installationId: info.installationId,
      clientIp
    });
    if (resolved) {
      req.auth = resolved;
    }
  }
  if (req.auth && (req.auth.isMaster || req.auth.isMaintenance)) {
    return handleRateLimit(req, res, next);
  }

  // Client keys are not required in parse-server, but if any have been configured in the server, validate them
  //  to preserve original behavior.
  const keys = ['clientKey', 'javascriptKey', 'dotNetKey', 'restAPIKey'];
  const oneKeyConfigured = keys.some(function (key) {
    return req.config[key] !== undefined;
  });
  const oneKeyMatches = keys.some(function (key) {
    return req.config[key] !== undefined && info[key] === req.config[key];
  });
  if (oneKeyConfigured && !oneKeyMatches) {
    return invalidRequest(req, res);
  }
  if (matchesExactRoute(req.path, '/login')) {
    delete info.sessionToken;
  }
  if (req.userFromJWT) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: false,
      user: req.userFromJWT
    });
    return handleRateLimit(req, res, next);
  }
  if (!info.sessionToken) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: false
    });
  }
  handleRateLimit(req, res, next);
}
const handleRateLimit = async (req, res, next) => {
  const rateLimits = req.config.rateLimits || [];
  try {
    await Promise.all(rateLimits.map(async limit => {
      const pathExp = limit.path.regexp || limit.path;
      if (pathExp.test(req.path) || req._graphQLPath && pathExp.test(req._graphQLPath)) {
        await limit.handler(req, res, err => {
          if (err) {
            if (err.code === _node.default.Error.CONNECTION_FAILED) {
              throw err;
            }
            req.config.loggerController.error('An unknown error occured when attempting to apply the rate limiter: ', err);
          }
        });
      }
    }));
  } catch (error) {
    res.status(429);
    res.json({
      code: _node.default.Error.CONNECTION_FAILED,
      error: error.message
    });
    return;
  }
  next();
};
const handleParseSession = async (req, res, next) => {
  try {
    const info = req.info;
    if (req.auth || matchesExactRoute(req.path, '/sessions/me') && req.method === 'GET') {
      next();
      return;
    }
    let requestAuth = null;
    if (info.sessionToken && matchesExactRoute(req.path, '/upgradeToRevocableSession') && info.sessionToken.indexOf('r:') != 0) {
      requestAuth = await _Auth.default.getAuthForLegacySessionToken({
        config: req.config,
        installationId: info.installationId,
        sessionToken: info.sessionToken
      });
    } else {
      requestAuth = await _Auth.default.getAuthForSessionToken({
        config: req.config,
        installationId: info.installationId,
        sessionToken: info.sessionToken
      });
    }
    req.auth = requestAuth;
    next();
  } catch (error) {
    if (error instanceof _node.default.Error) {
      next(error);
      return;
    }
    // Log full error details internally, but don't expose to client
    req.config.loggerController.error('error getting auth for sessionToken', error);
    next(new _node.default.Error(_node.default.Error.UNKNOWN_ERROR, 'Unknown error'));
  }
};
exports.handleParseSession = handleParseSession;
function getClientIp(req) {
  return req.ip;
}
function httpAuth(req) {
  if (!(req.req || req).headers.authorization) {
    return;
  }
  var header = (req.req || req).headers.authorization;
  var appId, masterKey, javascriptKey;

  // parse header
  var authPrefix = 'basic ';
  var match = header.toLowerCase().indexOf(authPrefix);
  if (match == 0) {
    var encodedAuth = header.substring(authPrefix.length, header.length);
    var credentials = decodeBase64(encodedAuth).split(':');
    if (credentials.length == 2) {
      appId = credentials[0];
      var key = credentials[1];
      var jsKeyPrefix = 'javascript-key=';
      var matchKey = key.indexOf(jsKeyPrefix);
      if (matchKey == 0) {
        javascriptKey = key.substring(jsKeyPrefix.length, key.length);
      } else {
        masterKey = key;
      }
    }
  }
  return {
    appId: appId,
    masterKey: masterKey,
    javascriptKey: javascriptKey
  };
}
function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString();
}
function allowCrossDomain(appId) {
  return (req, res, next) => {
    const config = _Config.default.get(appId, getMountForRequest(req));
    let allowHeaders = DEFAULT_ALLOWED_HEADERS;
    if (config && config.allowHeaders) {
      allowHeaders += `, ${config.allowHeaders.join(', ')}`;
    }
    const baseOrigins = typeof config?.allowOrigin === 'string' ? [config.allowOrigin] : config?.allowOrigin ?? ['*'];
    const requestOrigin = req.headers.origin;
    const allowOrigins = requestOrigin && baseOrigins.includes(requestOrigin) ? requestOrigin : baseOrigins[0];
    res.header('Access-Control-Allow-Origin', allowOrigins);
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', allowHeaders);
    res.header('Access-Control-Expose-Headers', 'X-Parse-Job-Status-Id, X-Parse-Push-Status-Id');
    // intercept OPTIONS method
    if ('OPTIONS' == req.method) {
      res.sendStatus(200);
    } else {
      next();
    }
  };
}
function allowMethodOverride(req, res, next) {
  if (req.method === 'POST' && req.body?._method) {
    if (typeof req.body._method === 'string') {
      req.originalMethod = req.method;
      req.method = req.body._method.toUpperCase();
    }
    delete req.body._method;
  }
  next();
}
async function resolveKeyAuth({
  config,
  keyValue,
  maintenanceKeyValue,
  installationId,
  clientIp
}) {
  if (maintenanceKeyValue && maintenanceKeyValue === config.maintenanceKey) {
    if (checkIp(clientIp, config.maintenanceKeyIps || [], config.maintenanceKeyIpsStore)) {
      return new _Auth.default.Auth({
        config,
        installationId,
        isMaintenance: true
      });
    }
    const log = config.loggerController || _logger.default;
    log.error(`Request using maintenance key rejected as the request IP address '${clientIp}' is not set in Parse Server option 'maintenanceKeyIps'.`);
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized';
    throw error;
  }
  const masterKey = await config.loadMasterKey();
  if (keyValue === masterKey) {
    if (checkIp(clientIp, config.masterKeyIps || [], config.masterKeyIpsStore)) {
      return new _Auth.default.Auth({
        config,
        installationId,
        isMaster: true
      });
    }
    const log = config.loggerController || _logger.default;
    log.error(`Request using master key rejected as the request IP address '${clientIp}' is not set in Parse Server option 'masterKeyIps'.`);
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized';
    throw error;
  }
  if (keyValue && typeof config.readOnlyMasterKey !== 'undefined' && config.readOnlyMasterKey && keyValue === config.readOnlyMasterKey) {
    if (checkIp(clientIp, config.readOnlyMasterKeyIps || [], config.readOnlyMasterKeyIpsStore)) {
      return new _Auth.default.Auth({
        config,
        installationId,
        isMaster: true,
        isReadOnly: true
      });
    }
    const log = config.loggerController || _logger.default;
    log.error(`Request using read-only master key rejected as the request IP address '${clientIp}' is not set in Parse Server option 'readOnlyMasterKeyIps'.`);
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized';
    throw error;
  }
  return null;
}
function handleParseAuth(appId) {
  return async (req, res, next) => {
    const mount = getMountForRequest(req);
    const config = _Config.default.get(appId, mount);
    if (!config) {
      return next();
    }
    req.config = config;
    const clientIp = getClientIp(req);
    req.config.ip = clientIp;
    await config.loadKeys();
    const resolved = await resolveKeyAuth({
      config,
      keyValue: req.get('X-Parse-Master-Key') || null,
      maintenanceKeyValue: req.get('X-Parse-Maintenance-Key') || null,
      installationId: req.get('X-Parse-Installation-Id') || 'cloud',
      clientIp
    });
    if (resolved) {
      req.auth = resolved;
    }
    return next();
  };
}
function handleParseHealth(options) {
  return (req, res) => {
    res.status(options.state === 'ok' ? 200 : 503);
    if (options.state === 'starting') {
      res.set('Retry-After', 1);
    }
    res.json({
      status: options.state
    });
  };
}
function normalizeRouteAllowListPath(path, mount) {
  let normalized = path;
  if (mount) {
    const mountPath = new URL(mount).pathname;
    if (normalized.startsWith(mountPath)) {
      normalized = normalized.substring(mountPath.length);
    }
  }
  if (normalized.startsWith('/')) {
    normalized = normalized.substring(1);
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  const queryIndex = normalized.indexOf('?');
  if (queryIndex !== -1) {
    normalized = normalized.substring(0, queryIndex);
  }
  return normalized;
}

// Cache of compiled exact-route matchers, keyed by route. Mirrors how `addRateLimit` compiles a
// route's `pathToRegexp` once and reuses it, avoiding recompilation on every request.
const exactRouteRegexpCache = Object.create(null);

/**
 * Returns true if `path` resolves to the given exact static `route`, using the same
 * `path-to-regexp` matching that the Express router and the rate limiter use (case-insensitive
 * and trailing-slash-tolerant by default). Path-literal checks — such as detecting `/login` to
 * drop the inbound session token — must use this so they stay consistent with how the router
 * actually dispatches the request, instead of re-deriving the matching rules by hand.
 * @param {string} path The request path (e.g. `req.path` or a batch sub-request routable path).
 * @param {string} route The exact static route to match (e.g. `/login`).
 * @returns {boolean}
 */
function matchesExactRoute(path, route) {
  if (typeof path !== 'string') {
    return false;
  }
  if (!exactRouteRegexpCache[route]) {
    exactRouteRegexpCache[route] = (0, _pathToRegexp.pathToRegexp)(route).regexp;
  }
  return exactRouteRegexpCache[route].test(path);
}
function isRouteAllowed(path, config, auth) {
  if (!config || config.routeAllowList === undefined || config.routeAllowList === null) {
    return true;
  }
  if (auth && (auth.isMaster || auth.isMaintenance)) {
    return true;
  }
  const normalized = normalizeRouteAllowListPath(path, config.mount);
  const regexes = config._routeAllowListRegex || [];
  for (const regex of regexes) {
    if (regex.test(normalized)) {
      return true;
    }
  }
  return false;
}
function enforceRouteAllowList(req, res, next) {
  if (isRouteAllowed(req.originalUrl, req.config, req.auth)) {
    return next();
  }
  const path = normalizeRouteAllowListPath(req.originalUrl, req.config?.mount);
  throw (0, _Error.createSanitizedError)(_node.default.Error.OPERATION_FORBIDDEN, `Route not allowed by routeAllowList: ${req.method} ${path}`, req.config);
}
function handleParseErrors(err, req, res, next) {
  const log = req.config && req.config.loggerController || _logger.default;
  if (err instanceof _node.default.Error) {
    if (req.config && req.config.enableExpressErrorHandler) {
      return next(err);
    }
    const signupUsernameTakenLevel = req.config?.logLevels?.signupUsernameTaken || 'info';
    let httpStatus;
    // TODO: fill out this mapping
    switch (err.code) {
      case _node.default.Error.INTERNAL_SERVER_ERROR:
        httpStatus = 500;
        break;
      case _node.default.Error.OBJECT_NOT_FOUND:
        httpStatus = 404;
        break;
      default:
        httpStatus = 400;
    }
    res.status(httpStatus);
    res.json({
      code: err.code,
      error: err.message
    });
    if (err.code === _node.default.Error.USERNAME_TAKEN) {
      if (signupUsernameTakenLevel !== 'silent') {
        const loggerMethod = typeof log[signupUsernameTakenLevel] === 'function' ? log[signupUsernameTakenLevel].bind(log) : log.error.bind(log);
        loggerMethod('Parse error: ', err);
      }
    } else {
      log.error('Parse error: ', err);
    }
  } else if (err.status && err.message) {
    res.status(err.status);
    res.json({
      error: err.message
    });
    if (!(process && process.env.TESTING)) {
      next(err);
    }
  } else {
    log.error('Uncaught internal server error.', err, err.stack);
    res.status(500);
    res.json({
      code: _node.default.Error.INTERNAL_SERVER_ERROR,
      message: 'Internal server error.'
    });
    if (!(process && process.env.TESTING)) {
      next(err);
    }
  }
}
function enforceMasterKeyAccess(req, res, next) {
  if (!req.auth.isMaster) {
    const error = (0, _Error.createSanitizedHttpError)(403, 'unauthorized: master key is required', req.config);
    res.status(error.status);
    res.end(`{"error":"${error.message}"}`);
    return;
  }
  next();
}
function promiseEnforceMasterKeyAccess(request) {
  if (!request.auth.isMaster) {
    throw (0, _Error.createSanitizedHttpError)(403, 'unauthorized: master key is required', request.config);
  }
  return Promise.resolve();
}
const getRateLimitStorePrefix = route => {
  const requestMethods = Array.isArray(route.requestMethods) ? route.requestMethods.map(String).sort() : route.requestMethods ? [String(route.requestMethods)] : [];
  const rule = JSON.stringify({
    requestPath: route.requestPath,
    requestMethods,
    zone: route.zone || 'ip',
    requestTimeWindow: route.requestTimeWindow,
    requestCount: route.requestCount,
    includeMasterKey: !!route.includeMasterKey,
    includeInternalRequests: !!route.includeInternalRequests
  });
  const hash = (0, _crypto.createHash)('sha256').update(rule).digest('hex').slice(0, 16);
  return `parse-server:rate-limit:${hash}:`;
};

/**
 * Determines whether a request is an internal request, i.e. one that originates from the same host
 * without passing through a proxy, such as a Cloud Code request that is routed via HTTP when the
 * Parse Server option `directAccess` is `false`. Only the raw socket peer address is consulted,
 * never `request.ip`: under a permissive `trustProxy` setting Express resolves `request.ip` from
 * the client-supplied `X-Forwarded-For` header, so a remote client could otherwise pose as an
 * internal request. A request that carries an `X-Forwarded-For` header, even an empty one, has been
 * forwarded by a proxy or crafted by a client and is therefore never internal, even if it arrives
 * over a loopback socket.
 * @param {Object} request The request to evaluate.
 * @returns {Boolean} Whether the request is internal.
 */
exports.getRateLimitStorePrefix = getRateLimitStorePrefix;
const isInternalRequest = request => request.socket?.remoteAddress === '127.0.0.1' && request.headers?.['x-forwarded-for'] === undefined;
const addRateLimit = (route, config, cloud) => {
  if (typeof config === 'string') {
    config = _Config.default.get(config);
  }
  for (const key in route) {
    if (!_Definitions.RateLimitOptions[key]) {
      throw `Invalid rate limit option "${key}"`;
    }
  }
  if (!config.rateLimits) {
    config.rateLimits = [];
  }
  const redisStore = {
    connectionPromise: Promise.resolve(),
    store: null
  };
  if (route.redisUrl) {
    const log = config?.loggerController || _logger.default;
    const client = (0, _redis.createClient)({
      url: route.redisUrl
    });
    client.on('error', err => {
      log.error('Middlewares addRateLimit Redis client error', {
        error: err
      });
    });
    client.on('connect', () => {});
    client.on('reconnecting', () => {});
    client.on('ready', () => {});
    redisStore.connectionPromise = async () => {
      if (client.isOpen) {
        return;
      }
      try {
        await client.connect();
      } catch (e) {
        log.error(`Could not connect to redisURL in rate limit: ${e}`);
      }
    };
    redisStore.connectionPromise();
    redisStore.store = new _rateLimitRedis.default({
      prefix: getRateLimitStorePrefix(route),
      sendCommand: async (...args) => {
        await redisStore.connectionPromise();
        return client.sendCommand(args);
      }
    });
  }
  config.rateLimits.push({
    path: (0, _pathToRegexp.pathToRegexp)(route.requestPath),
    requestCount: route.requestCount,
    requestMethods: route.requestMethods,
    includeMasterKey: route.includeMasterKey,
    includeInternalRequests: route.includeInternalRequests,
    errorResponseMessage: route.errorResponseMessage || _Definitions.RateLimitOptions.errorResponseMessage.default,
    handler: (0, _expressRateLimit.default)({
      windowMs: route.requestTimeWindow,
      max: route.requestCount,
      message: route.errorResponseMessage || _Definitions.RateLimitOptions.errorResponseMessage.default,
      handler: (request, response, next, options) => {
        throw {
          code: _node.default.Error.CONNECTION_FAILED,
          message: options.message
        };
      },
      skip: request => {
        if (!route.includeInternalRequests && isInternalRequest(request)) {
          return true;
        }
        if (route.includeMasterKey) {
          return false;
        }
        if (route.requestMethods) {
          const methodsToCheck = new Set([request.method]);
          if (request._batchOriginalMethod) {
            methodsToCheck.add(request._batchOriginalMethod);
          }
          if (Array.isArray(route.requestMethods)) {
            if (!route.requestMethods.some(m => methodsToCheck.has(m))) {
              return true;
            }
          } else {
            const regExp = new RegExp(route.requestMethods);
            if (![...methodsToCheck].some(m => regExp.test(m))) {
              return true;
            }
          }
        }
        return request.auth?.isMaster;
      },
      keyGenerator: async request => {
        if (route.zone === _node.default.Server.RateLimitZone.global) {
          return request.config.appId;
        }
        const token = request.info.sessionToken;
        if (route.zone === _node.default.Server.RateLimitZone.session && token) {
          return token;
        }
        if (route.zone === _node.default.Server.RateLimitZone.user && token) {
          if (!request.auth) {
            await new Promise(resolve => handleParseSession(request, null, resolve));
          }
          if (request.auth?.user?.id && route.zone === 'user') {
            return request.auth.user.id;
          }
        }
        return request.config.ip;
      },
      store: redisStore.store
    }),
    cloud
  });
  _Config.default.put(config);
};

/**
 * Deduplicates a request to ensure idempotency. Duplicates are determined by the request ID
 * in the request header. If a request has no request ID, it is executed anyway.
 * @param {*} req The request to evaluate.
 * @returns Promise<{}>
 */
exports.addRateLimit = addRateLimit;
function promiseEnsureIdempotency(req) {
  // Enable feature only for MongoDB
  if (!(req.config.database.adapter instanceof _MongoStorageAdapter.default || req.config.database.adapter instanceof _PostgresStorageAdapter.default)) {
    return Promise.resolve();
  }
  // Get parameters
  const config = req.config;
  const requestId = ((req || {}).headers || {})['x-parse-request-id'];
  const {
    paths,
    ttl
  } = config.idempotencyOptions;
  if (!requestId || !config.idempotencyOptions) {
    return Promise.resolve();
  }
  // Request path may contain trailing slashes, depending on the original request, so remove
  // leading and trailing slashes to make it easier to specify paths in the configuration
  const reqPath = req.path.replace(/^\/|\/$/, '');
  // Determine whether idempotency is enabled for current request path
  let match = false;
  for (const path of paths) {
    // Assume one wants a path to always match from the beginning to prevent any mistakes
    const regex = new RegExp(path.charAt(0) === '^' ? path : '^' + path);
    if (reqPath.match(regex)) {
      match = true;
      break;
    }
  }
  if (!match) {
    return Promise.resolve();
  }
  // Try to store request
  const expiryDate = new Date(new Date().setSeconds(new Date().getSeconds() + ttl));
  return _rest.default.create(config, _Auth.default.master(config), '_Idempotency', {
    reqId: requestId,
    expire: _node.default._encode(expiryDate)
  }).catch(e => {
    if (e.code == _node.default.Error.DUPLICATE_VALUE) {
      throw new _node.default.Error(_node.default.Error.DUPLICATE_REQUEST, 'Duplicate request');
    }
    throw e;
  });
}
function invalidRequest(req, res) {
  res.status(403);
  res.end('{"error":"unauthorized"}');
}
function malformedContext(req, res) {
  res.status(400);
  res.json({
    code: _node.default.Error.INVALID_JSON,
    error: 'Invalid object for context.'
  });
}

/**
 * Express 4 allowed a double forward slash between a route and router. Although
 * this should be considered an anti-pattern, we need to support it for backwards
 * compatibility.
 *
 * Technically valid URL with double foroward slash:
 * http://localhost:1337/parse//functions/testFunction
 */
function allowDoubleForwardSlash(req, res, next) {
  req.url = req.url.startsWith('//') ? req.url.substring(1) : req.url;
  next();
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfY2FjaGUiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9VdGlscyIsIl9ub2RlIiwiX0F1dGgiLCJfQ29uZmlnIiwiX2xvZ2dlciIsIl9yZXN0IiwiX01vbmdvU3RvcmFnZUFkYXB0ZXIiLCJfUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsIl9leHByZXNzUmF0ZUxpbWl0IiwiX0RlZmluaXRpb25zIiwiX3BhdGhUb1JlZ2V4cCIsIl9yYXRlTGltaXRSZWRpcyIsIl9yZWRpcyIsIl9uZXQiLCJfY3J5cHRvIiwiX0Vycm9yIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiREVGQVVMVF9BTExPV0VEX0hFQURFUlMiLCJleHBvcnRzIiwiZ2V0TW91bnRGb3JSZXF1ZXN0IiwicmVxIiwibW91bnRQYXRoTGVuZ3RoIiwib3JpZ2luYWxVcmwiLCJsZW5ndGgiLCJ1cmwiLCJtb3VudFBhdGgiLCJzbGljZSIsInByb3RvY29sIiwiZ2V0IiwiZ2V0QmxvY2tMaXN0IiwiaXBSYW5nZUxpc3QiLCJzdG9yZSIsImJsb2NrTGlzdCIsIkJsb2NrTGlzdCIsImZvckVhY2giLCJmdWxsSXAiLCJzZXQiLCJpcCIsIm1hc2siLCJzcGxpdCIsImFkZEFkZHJlc3MiLCJpc0lQdjQiLCJhZGRTdWJuZXQiLCJOdW1iZXIiLCJjaGVja0lwIiwiaW5jb21pbmdJcElzVjQiLCJyZXN1bHQiLCJjaGVjayIsImluY2x1ZGVzIiwiaGFuZGxlUGFyc2VIZWFkZXJzIiwicmVzIiwibmV4dCIsIm1vdW50IiwiY29udGV4dCIsIkpTT04iLCJwYXJzZSIsIk9iamVjdCIsInByb3RvdHlwZSIsInRvU3RyaW5nIiwiY2FsbCIsIm1hbGZvcm1lZENvbnRleHQiLCJpbmZvIiwiYXBwSWQiLCJzZXNzaW9uVG9rZW4iLCJtYXN0ZXJLZXkiLCJtYWludGVuYW5jZUtleSIsImluc3RhbGxhdGlvbklkIiwiY2xpZW50S2V5IiwiamF2YXNjcmlwdEtleSIsImRvdE5ldEtleSIsInJlc3RBUElLZXkiLCJiYXNpY0F1dGgiLCJodHRwQXV0aCIsImJhc2ljQXV0aEFwcElkIiwiQXBwQ2FjaGUiLCJib2R5IiwiX25vQm9keSIsImZpbGVWaWFKU09OIiwiQnVmZmVyIiwiaXNCdWZmZXIiLCJpbnZhbGlkUmVxdWVzdCIsIl9SZXZvY2FibGVTZXNzaW9uIiwiX0FwcGxpY2F0aW9uSWQiLCJfSmF2YVNjcmlwdEtleSIsIl9DbGllbnRWZXJzaW9uIiwiX0luc3RhbGxhdGlvbklkIiwiX1Nlc3Npb25Ub2tlbiIsIl9NYXN0ZXJLZXkiLCJfY29udGV4dCIsIlV0aWxzIiwiaXNPYmplY3QiLCJfQ29udGVudFR5cGUiLCJoZWFkZXJzIiwiYmFzZTY0IiwiZmlsZURhdGEiLCJmcm9tIiwiY2xpZW50SXAiLCJnZXRDbGllbnRJcCIsImNvbmZpZyIsIkNvbmZpZyIsInN0YXRlIiwic3RhdHVzIiwianNvbiIsImNvZGUiLCJQYXJzZSIsIkVycm9yIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwiZXJyb3IiLCJsb2FkS2V5cyIsImFwcCIsImF1dGgiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJyZXNvbHZlZCIsInJlc29sdmVLZXlBdXRoIiwia2V5VmFsdWUiLCJtYWludGVuYW5jZUtleVZhbHVlIiwiaGFuZGxlUmF0ZUxpbWl0Iiwia2V5cyIsIm9uZUtleUNvbmZpZ3VyZWQiLCJzb21lIiwia2V5IiwidW5kZWZpbmVkIiwib25lS2V5TWF0Y2hlcyIsIm1hdGNoZXNFeGFjdFJvdXRlIiwicGF0aCIsInVzZXJGcm9tSldUIiwiQXV0aCIsInVzZXIiLCJyYXRlTGltaXRzIiwiUHJvbWlzZSIsImFsbCIsIm1hcCIsImxpbWl0IiwicGF0aEV4cCIsInJlZ2V4cCIsInRlc3QiLCJfZ3JhcGhRTFBhdGgiLCJoYW5kbGVyIiwiZXJyIiwiQ09OTkVDVElPTl9GQUlMRUQiLCJsb2dnZXJDb250cm9sbGVyIiwibWVzc2FnZSIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsIm1ldGhvZCIsInJlcXVlc3RBdXRoIiwiaW5kZXhPZiIsImdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4iLCJnZXRBdXRoRm9yU2Vzc2lvblRva2VuIiwiVU5LTk9XTl9FUlJPUiIsImF1dGhvcml6YXRpb24iLCJoZWFkZXIiLCJhdXRoUHJlZml4IiwibWF0Y2giLCJ0b0xvd2VyQ2FzZSIsImVuY29kZWRBdXRoIiwic3Vic3RyaW5nIiwiY3JlZGVudGlhbHMiLCJkZWNvZGVCYXNlNjQiLCJqc0tleVByZWZpeCIsIm1hdGNoS2V5Iiwic3RyIiwiYWxsb3dDcm9zc0RvbWFpbiIsImFsbG93SGVhZGVycyIsImpvaW4iLCJiYXNlT3JpZ2lucyIsImFsbG93T3JpZ2luIiwicmVxdWVzdE9yaWdpbiIsIm9yaWdpbiIsImFsbG93T3JpZ2lucyIsInNlbmRTdGF0dXMiLCJhbGxvd01ldGhvZE92ZXJyaWRlIiwiX21ldGhvZCIsIm9yaWdpbmFsTWV0aG9kIiwidG9VcHBlckNhc2UiLCJtYWludGVuYW5jZUtleUlwcyIsIm1haW50ZW5hbmNlS2V5SXBzU3RvcmUiLCJsb2ciLCJkZWZhdWx0TG9nZ2VyIiwibG9hZE1hc3RlcktleSIsIm1hc3RlcktleUlwcyIsIm1hc3RlcktleUlwc1N0b3JlIiwicmVhZE9ubHlNYXN0ZXJLZXkiLCJyZWFkT25seU1hc3RlcktleUlwcyIsInJlYWRPbmx5TWFzdGVyS2V5SXBzU3RvcmUiLCJpc1JlYWRPbmx5IiwiaGFuZGxlUGFyc2VBdXRoIiwiaGFuZGxlUGFyc2VIZWFsdGgiLCJvcHRpb25zIiwibm9ybWFsaXplUm91dGVBbGxvd0xpc3RQYXRoIiwibm9ybWFsaXplZCIsIlVSTCIsInBhdGhuYW1lIiwic3RhcnRzV2l0aCIsImVuZHNXaXRoIiwicXVlcnlJbmRleCIsImV4YWN0Um91dGVSZWdleHBDYWNoZSIsImNyZWF0ZSIsInJvdXRlIiwicGF0aFRvUmVnZXhwIiwiaXNSb3V0ZUFsbG93ZWQiLCJyb3V0ZUFsbG93TGlzdCIsInJlZ2V4ZXMiLCJfcm91dGVBbGxvd0xpc3RSZWdleCIsInJlZ2V4IiwiZW5mb3JjZVJvdXRlQWxsb3dMaXN0IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiaGFuZGxlUGFyc2VFcnJvcnMiLCJlbmFibGVFeHByZXNzRXJyb3JIYW5kbGVyIiwic2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsIiwibG9nTGV2ZWxzIiwic2lnbnVwVXNlcm5hbWVUYWtlbiIsImh0dHBTdGF0dXMiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiVVNFUk5BTUVfVEFLRU4iLCJsb2dnZXJNZXRob2QiLCJiaW5kIiwicHJvY2VzcyIsImVudiIsIlRFU1RJTkciLCJzdGFjayIsImVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MiLCJjcmVhdGVTYW5pdGl6ZWRIdHRwRXJyb3IiLCJlbmQiLCJwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcyIsInJlcXVlc3QiLCJyZXNvbHZlIiwiZ2V0UmF0ZUxpbWl0U3RvcmVQcmVmaXgiLCJyZXF1ZXN0TWV0aG9kcyIsIkFycmF5IiwiaXNBcnJheSIsIlN0cmluZyIsInNvcnQiLCJydWxlIiwic3RyaW5naWZ5IiwicmVxdWVzdFBhdGgiLCJ6b25lIiwicmVxdWVzdFRpbWVXaW5kb3ciLCJyZXF1ZXN0Q291bnQiLCJpbmNsdWRlTWFzdGVyS2V5IiwiaW5jbHVkZUludGVybmFsUmVxdWVzdHMiLCJoYXNoIiwiY3JlYXRlSGFzaCIsInVwZGF0ZSIsImRpZ2VzdCIsImlzSW50ZXJuYWxSZXF1ZXN0Iiwic29ja2V0IiwicmVtb3RlQWRkcmVzcyIsImFkZFJhdGVMaW1pdCIsImNsb3VkIiwiUmF0ZUxpbWl0T3B0aW9ucyIsInJlZGlzU3RvcmUiLCJjb25uZWN0aW9uUHJvbWlzZSIsInJlZGlzVXJsIiwiY2xpZW50IiwiY3JlYXRlQ2xpZW50Iiwib24iLCJpc09wZW4iLCJjb25uZWN0IiwiUmVkaXNTdG9yZSIsInByZWZpeCIsInNlbmRDb21tYW5kIiwiYXJncyIsInB1c2giLCJlcnJvclJlc3BvbnNlTWVzc2FnZSIsInJhdGVMaW1pdCIsIndpbmRvd01zIiwibWF4IiwicmVzcG9uc2UiLCJza2lwIiwibWV0aG9kc1RvQ2hlY2siLCJTZXQiLCJfYmF0Y2hPcmlnaW5hbE1ldGhvZCIsImFkZCIsIm0iLCJoYXMiLCJyZWdFeHAiLCJSZWdFeHAiLCJrZXlHZW5lcmF0b3IiLCJTZXJ2ZXIiLCJSYXRlTGltaXRab25lIiwiZ2xvYmFsIiwidG9rZW4iLCJzZXNzaW9uIiwiaWQiLCJwdXQiLCJwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kiLCJkYXRhYmFzZSIsImFkYXB0ZXIiLCJNb25nb1N0b3JhZ2VBZGFwdGVyIiwiUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsInJlcXVlc3RJZCIsInBhdGhzIiwidHRsIiwiaWRlbXBvdGVuY3lPcHRpb25zIiwicmVxUGF0aCIsInJlcGxhY2UiLCJjaGFyQXQiLCJleHBpcnlEYXRlIiwiRGF0ZSIsInNldFNlY29uZHMiLCJnZXRTZWNvbmRzIiwicmVzdCIsIm1hc3RlciIsInJlcUlkIiwiZXhwaXJlIiwiX2VuY29kZSIsImNhdGNoIiwiRFVQTElDQVRFX1ZBTFVFIiwiRFVQTElDQVRFX1JFUVVFU1QiLCJJTlZBTElEX0pTT04iLCJhbGxvd0RvdWJsZUZvcndhcmRTbGFzaCJdLCJzb3VyY2VzIjpbIi4uL3NyYy9taWRkbGV3YXJlcy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgQXBwQ2FjaGUgZnJvbSAnLi9jYWNoZSc7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi9VdGlscyc7XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgYXV0aCBmcm9tICcuL0F1dGgnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuL0NvbmZpZyc7XG5pbXBvcnQgZGVmYXVsdExvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgcmVzdCBmcm9tICcuL3Jlc3QnO1xuaW1wb3J0IE1vbmdvU3RvcmFnZUFkYXB0ZXIgZnJvbSAnLi9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IFBvc3RncmVzU3RvcmFnZUFkYXB0ZXIgZnJvbSAnLi9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHJhdGVMaW1pdCBmcm9tICdleHByZXNzLXJhdGUtbGltaXQnO1xuaW1wb3J0IHsgUmF0ZUxpbWl0T3B0aW9ucyB9IGZyb20gJy4vT3B0aW9ucy9EZWZpbml0aW9ucyc7XG5pbXBvcnQgeyBwYXRoVG9SZWdleHAgfSBmcm9tICdwYXRoLXRvLXJlZ2V4cCc7XG5pbXBvcnQgUmVkaXNTdG9yZSBmcm9tICdyYXRlLWxpbWl0LXJlZGlzJztcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCB9IGZyb20gJ3JlZGlzJztcbmltcG9ydCB7IEJsb2NrTGlzdCwgaXNJUHY0IH0gZnJvbSAnbmV0JztcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdjcnlwdG8nO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkSHR0cEVycm9yLCBjcmVhdGVTYW5pdGl6ZWRFcnJvciB9IGZyb20gJy4vRXJyb3InO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9BTExPV0VEX0hFQURFUlMgPVxuICAnWC1QYXJzZS1NYXN0ZXItS2V5LCBYLVBhcnNlLVJFU1QtQVBJLUtleSwgWC1QYXJzZS1KYXZhc2NyaXB0LUtleSwgWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCwgWC1QYXJzZS1DbGllbnQtVmVyc2lvbiwgWC1QYXJzZS1TZXNzaW9uLVRva2VuLCBYLVJlcXVlc3RlZC1XaXRoLCBYLVBhcnNlLVJldm9jYWJsZS1TZXNzaW9uLCBYLVBhcnNlLVJlcXVlc3QtSWQsIENvbnRlbnQtVHlwZSwgUHJhZ21hLCBDYWNoZS1Db250cm9sJztcblxuY29uc3QgZ2V0TW91bnRGb3JSZXF1ZXN0ID0gZnVuY3Rpb24gKHJlcSkge1xuICBjb25zdCBtb3VudFBhdGhMZW5ndGggPSByZXEub3JpZ2luYWxVcmwubGVuZ3RoIC0gcmVxLnVybC5sZW5ndGg7XG4gIGNvbnN0IG1vdW50UGF0aCA9IHJlcS5vcmlnaW5hbFVybC5zbGljZSgwLCBtb3VudFBhdGhMZW5ndGgpO1xuICByZXR1cm4gcmVxLnByb3RvY29sICsgJzovLycgKyByZXEuZ2V0KCdob3N0JykgKyBtb3VudFBhdGg7XG59O1xuXG5jb25zdCBnZXRCbG9ja0xpc3QgPSAoaXBSYW5nZUxpc3QsIHN0b3JlKSA9PiB7XG4gIGlmIChzdG9yZS5nZXQoJ2Jsb2NrTGlzdCcpKSB7IHJldHVybiBzdG9yZS5nZXQoJ2Jsb2NrTGlzdCcpOyB9XG4gIGNvbnN0IGJsb2NrTGlzdCA9IG5ldyBCbG9ja0xpc3QoKTtcbiAgaXBSYW5nZUxpc3QuZm9yRWFjaChmdWxsSXAgPT4ge1xuICAgIGlmIChmdWxsSXAgPT09ICc6Oi8wJyB8fCBmdWxsSXAgPT09ICc6OicgfHwgZnVsbElwID09PSAnOjowJykge1xuICAgICAgc3RvcmUuc2V0KCdhbGxvd0FsbElwdjYnLCB0cnVlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGZ1bGxJcCA9PT0gJzAuMC4wLjAvMCcgfHwgZnVsbElwID09PSAnMC4wLjAuMCcpIHtcbiAgICAgIHN0b3JlLnNldCgnYWxsb3dBbGxJcHY0JywgdHJ1ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IFtpcCwgbWFza10gPSBmdWxsSXAuc3BsaXQoJy8nKTtcbiAgICBpZiAoIW1hc2spIHtcbiAgICAgIGJsb2NrTGlzdC5hZGRBZGRyZXNzKGlwLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYmxvY2tMaXN0LmFkZFN1Ym5ldChpcCwgTnVtYmVyKG1hc2spLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9XG4gIH0pO1xuICBzdG9yZS5zZXQoJ2Jsb2NrTGlzdCcsIGJsb2NrTGlzdCk7XG4gIHJldHVybiBibG9ja0xpc3Q7XG59O1xuXG5leHBvcnQgY29uc3QgY2hlY2tJcCA9IChpcCwgaXBSYW5nZUxpc3QsIHN0b3JlKSA9PiB7XG4gIGNvbnN0IGluY29taW5nSXBJc1Y0ID0gaXNJUHY0KGlwKTtcbiAgY29uc3QgYmxvY2tMaXN0ID0gZ2V0QmxvY2tMaXN0KGlwUmFuZ2VMaXN0LCBzdG9yZSk7XG5cbiAgaWYgKHN0b3JlLmdldChpcCkpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY0JykgJiYgaW5jb21pbmdJcElzVjQpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY2JykgJiYgIWluY29taW5nSXBJc1Y0KSB7IHJldHVybiB0cnVlOyB9XG4gIGNvbnN0IHJlc3VsdCA9IGJsb2NrTGlzdC5jaGVjayhpcCwgaW5jb21pbmdJcElzVjQgPyAnaXB2NCcgOiAnaXB2NicpO1xuXG4gIC8vIElmIHRoZSBpcCBpcyBpbiB0aGUgbGlzdCwgd2Ugc3RvcmUgdGhlIHJlc3VsdCBpbiB0aGUgc3RvcmVcbiAgLy8gc28gd2UgaGF2ZSBhIG9wdGltaXplZCBwYXRoIGZvciB0aGUgbmV4dCByZXF1ZXN0XG4gIGlmIChpcFJhbmdlTGlzdC5pbmNsdWRlcyhpcCkgJiYgcmVzdWx0KSB7XG4gICAgc3RvcmUuc2V0KGlwLCByZXN1bHQpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59O1xuXG4vLyBDaGVja3MgdGhhdCB0aGUgcmVxdWVzdCBpcyBhdXRob3JpemVkIGZvciB0aGlzIGFwcCBhbmQgY2hlY2tzIHVzZXJcbi8vIGF1dGggdG9vLlxuLy8gVGhlIGJvZHlwYXJzZXIgc2hvdWxkIHJ1biBiZWZvcmUgdGhpcyBtaWRkbGV3YXJlLlxuLy8gQWRkcyBpbmZvIHRvIHRoZSByZXF1ZXN0OlxuLy8gcmVxLmNvbmZpZyAtIHRoZSBDb25maWcgZm9yIHRoaXMgYXBwXG4vLyByZXEuYXV0aCAtIHRoZSBBdXRoIGZvciB0aGlzIHJlcXVlc3RcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVQYXJzZUhlYWRlcnMocmVxLCByZXMsIG5leHQpIHtcbiAgdmFyIG1vdW50ID0gZ2V0TW91bnRGb3JSZXF1ZXN0KHJlcSk7XG5cbiAgbGV0IGNvbnRleHQgPSB7fTtcbiAgaWYgKHJlcS5nZXQoJ1gtUGFyc2UtQ2xvdWQtQ29udGV4dCcpICE9IG51bGwpIHtcbiAgICB0cnkge1xuICAgICAgY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmdldCgnWC1QYXJzZS1DbG91ZC1Db250ZXh0JykpO1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChjb250ZXh0KSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgICAgdGhyb3cgJ0NvbnRleHQgaXMgbm90IGFuIG9iamVjdCc7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbWFsZm9ybWVkQ29udGV4dChyZXEsIHJlcyk7XG4gICAgfVxuICB9XG4gIHZhciBpbmZvID0ge1xuICAgIGFwcElkOiByZXEuZ2V0KCdYLVBhcnNlLUFwcGxpY2F0aW9uLUlkJyksXG4gICAgc2Vzc2lvblRva2VuOiByZXEuZ2V0KCdYLVBhcnNlLVNlc3Npb24tVG9rZW4nKSxcbiAgICBtYXN0ZXJLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtTWFzdGVyLUtleScpLFxuICAgIG1haW50ZW5hbmNlS2V5OiByZXEuZ2V0KCdYLVBhcnNlLU1haW50ZW5hbmNlLUtleScpLFxuICAgIGluc3RhbGxhdGlvbklkOiByZXEuZ2V0KCdYLVBhcnNlLUluc3RhbGxhdGlvbi1JZCcpLFxuICAgIGNsaWVudEtleTogcmVxLmdldCgnWC1QYXJzZS1DbGllbnQtS2V5JyksXG4gICAgamF2YXNjcmlwdEtleTogcmVxLmdldCgnWC1QYXJzZS1KYXZhc2NyaXB0LUtleScpLFxuICAgIGRvdE5ldEtleTogcmVxLmdldCgnWC1QYXJzZS1XaW5kb3dzLUtleScpLFxuICAgIHJlc3RBUElLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtUkVTVC1BUEktS2V5JyksXG4gICAgY29udGV4dDogY29udGV4dCxcbiAgfTtcblxuICB2YXIgYmFzaWNBdXRoID0gaHR0cEF1dGgocmVxKTtcblxuICBpZiAoYmFzaWNBdXRoKSB7XG4gICAgdmFyIGJhc2ljQXV0aEFwcElkID0gYmFzaWNBdXRoLmFwcElkO1xuICAgIGlmIChBcHBDYWNoZS5nZXQoYmFzaWNBdXRoQXBwSWQpKSB7XG4gICAgICBpbmZvLmFwcElkID0gYmFzaWNBdXRoQXBwSWQ7XG4gICAgICBpbmZvLm1hc3RlcktleSA9IGJhc2ljQXV0aC5tYXN0ZXJLZXkgfHwgaW5mby5tYXN0ZXJLZXk7XG4gICAgICBpbmZvLmphdmFzY3JpcHRLZXkgPSBiYXNpY0F1dGguamF2YXNjcmlwdEtleSB8fCBpbmZvLmphdmFzY3JpcHRLZXk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlcS5ib2R5KSB7XG4gICAgLy8gVW5pdHkgU0RLIHNlbmRzIGEgX25vQm9keSBrZXkgd2hpY2ggbmVlZHMgdG8gYmUgcmVtb3ZlZC5cbiAgICAvLyBVbmNsZWFyIGF0IHRoaXMgcG9pbnQgaWYgYWN0aW9uIG5lZWRzIHRvIGJlIHRha2VuLlxuICAgIGRlbGV0ZSByZXEuYm9keS5fbm9Cb2R5O1xuICB9XG5cbiAgdmFyIGZpbGVWaWFKU09OID0gZmFsc2U7XG5cbiAgaWYgKCFpbmZvLmFwcElkIHx8ICFBcHBDYWNoZS5nZXQoaW5mby5hcHBJZCkpIHtcbiAgICAvLyBTZWUgaWYgd2UgY2FuIGZpbmQgdGhlIGFwcCBpZCBvbiB0aGUgYm9keS5cbiAgICBpZiAoQnVmZmVyLmlzQnVmZmVyKHJlcS5ib2R5KSkge1xuICAgICAgLy8gVGhlIG9ubHkgY2hhbmNlIHRvIGZpbmQgdGhlIGFwcCBpZCBpcyBpZiB0aGlzIGlzIGEgZmlsZVxuICAgICAgLy8gdXBsb2FkIHRoYXQgYWN0dWFsbHkgaXMgYSBKU09OIGJvZHkuIFNvIHRyeSB0byBwYXJzZSBpdC5cbiAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy82NTg5XG4gICAgICAvLyBJdCBpcyBhbHNvIHBvc3NpYmxlIHRoYXQgdGhlIGNsaWVudCBpcyB0cnlpbmcgdG8gdXBsb2FkIGEgZmlsZSBidXQgZm9yZ290XG4gICAgICAvLyB0byBwcm92aWRlIHgtcGFyc2UtYXBwLWlkIGluIGhlYWRlciBhbmQgcGFyc2UgYSBiaW5hcnkgZmlsZSB3aWxsIGZhaWxcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcS5ib2R5ID0gSlNPTi5wYXJzZShyZXEuYm9keSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICAgIH1cbiAgICAgIGZpbGVWaWFKU09OID0gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAocmVxLmJvZHkpIHtcbiAgICAgIGRlbGV0ZSByZXEuYm9keS5fUmV2b2NhYmxlU2Vzc2lvbjtcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICByZXEuYm9keSAmJlxuICAgICAgcmVxLmJvZHkuX0FwcGxpY2F0aW9uSWQgJiZcbiAgICAgIEFwcENhY2hlLmdldChyZXEuYm9keS5fQXBwbGljYXRpb25JZCkgJiZcbiAgICAgICghaW5mby5tYXN0ZXJLZXkgfHwgQXBwQ2FjaGUuZ2V0KHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkKS5tYXN0ZXJLZXkgPT09IGluZm8ubWFzdGVyS2V5KVxuICAgICkge1xuICAgICAgaW5mby5hcHBJZCA9IHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkO1xuICAgICAgaW5mby5qYXZhc2NyaXB0S2V5ID0gcmVxLmJvZHkuX0phdmFTY3JpcHRLZXkgfHwgJyc7XG4gICAgICBkZWxldGUgcmVxLmJvZHkuX0FwcGxpY2F0aW9uSWQ7XG4gICAgICBkZWxldGUgcmVxLmJvZHkuX0phdmFTY3JpcHRLZXk7XG4gICAgICAvLyBUT0RPOiB0ZXN0IHRoYXQgdGhlIFJFU1QgQVBJIGZvcm1hdHMgZ2VuZXJhdGVkIGJ5IHRoZSBvdGhlclxuICAgICAgLy8gU0RLcyBhcmUgaGFuZGxlZCBva1xuICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9DbGllbnRWZXJzaW9uO1xuICAgICAgaWYgKHJlcS5ib2R5Ll9JbnN0YWxsYXRpb25JZCkge1xuICAgICAgICBpZiAodHlwZW9mIHJlcS5ib2R5Ll9JbnN0YWxsYXRpb25JZCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICAgICAgICB9XG4gICAgICAgIGluZm8uaW5zdGFsbGF0aW9uSWQgPSByZXEuYm9keS5fSW5zdGFsbGF0aW9uSWQ7XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fSW5zdGFsbGF0aW9uSWQ7XG4gICAgICB9XG4gICAgICBpZiAocmVxLmJvZHkuX1Nlc3Npb25Ub2tlbikge1xuICAgICAgICBpZiAodHlwZW9mIHJlcS5ib2R5Ll9TZXNzaW9uVG9rZW4gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICAgICAgfVxuICAgICAgICBpbmZvLnNlc3Npb25Ub2tlbiA9IHJlcS5ib2R5Ll9TZXNzaW9uVG9rZW47XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fU2Vzc2lvblRva2VuO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5ib2R5Ll9NYXN0ZXJLZXkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByZXEuYm9keS5fTWFzdGVyS2V5ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gICAgICAgIH1cbiAgICAgICAgaW5mby5tYXN0ZXJLZXkgPSByZXEuYm9keS5fTWFzdGVyS2V5O1xuICAgICAgICBkZWxldGUgcmVxLmJvZHkuX01hc3RlcktleTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuYm9keS5fY29udGV4dCkge1xuICAgICAgICBpZiAoVXRpbHMuaXNPYmplY3QocmVxLmJvZHkuX2NvbnRleHQpKSB7XG4gICAgICAgICAgaW5mby5jb250ZXh0ID0gcmVxLmJvZHkuX2NvbnRleHQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGluZm8uY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmJvZHkuX2NvbnRleHQpO1xuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChpbmZvLmNvbnRleHQpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgICAgICAgICB0aHJvdyAnQ29udGV4dCBpcyBub3QgYW4gb2JqZWN0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBtYWxmb3JtZWRDb250ZXh0KHJlcSwgcmVzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9jb250ZXh0O1xuICAgICAgfSBlbHNlIGlmIChyZXEuYm9keS5fY29udGV4dCA9PT0gbnVsbCkge1xuICAgICAgICAvLyBudWxsIGNvbnRleHQgaXMgZXF1aXZhbGVudCB0byBubyBjb250ZXh0XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fY29udGV4dDtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuYm9keS5fQ29udGVudFR5cGUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByZXEuYm9keS5fQ29udGVudFR5cGUgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICAgICAgfVxuICAgICAgICByZXEuaGVhZGVyc1snY29udGVudC10eXBlJ10gPSByZXEuYm9keS5fQ29udGVudFR5cGU7XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fQ29udGVudFR5cGU7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGluZm8uc2Vzc2lvblRva2VuICYmIHR5cGVvZiBpbmZvLnNlc3Npb25Ub2tlbiAhPT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICB9XG5cbiAgaWYgKGZpbGVWaWFKU09OICYmIHJlcS5ib2R5KSB7XG4gICAgaWYgKHJlcS5ib2R5LmJhc2U2NCAmJiB0eXBlb2YgcmVxLmJvZHkuYmFzZTY0ICE9PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICB9XG4gICAgcmVxLmZpbGVEYXRhID0gcmVxLmJvZHkuZmlsZURhdGE7XG4gICAgLy8gV2UgbmVlZCB0byByZXBvcHVsYXRlIHJlcS5ib2R5IHdpdGggYSBidWZmZXJcbiAgICB2YXIgYmFzZTY0ID0gcmVxLmJvZHkuYmFzZTY0O1xuICAgIHJlcS5ib2R5ID0gQnVmZmVyLmZyb20oYmFzZTY0LCAnYmFzZTY0Jyk7XG4gIH1cblxuICBjb25zdCBjbGllbnRJcCA9IGdldENsaWVudElwKHJlcSk7XG4gIGNvbnN0IGNvbmZpZyA9IHJlcS5jb25maWcgfHwgQ29uZmlnLmdldChpbmZvLmFwcElkLCBtb3VudCk7XG4gIGlmIChjb25maWcuc3RhdGUgJiYgY29uZmlnLnN0YXRlICE9PSAnb2snKSB7XG4gICAgcmVzLnN0YXR1cyg1MDApO1xuICAgIHJlcy5qc29uKHtcbiAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgIGVycm9yOiBgSW52YWxpZCBzZXJ2ZXIgc3RhdGU6ICR7Y29uZmlnLnN0YXRlfWAsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghcmVxLmNvbmZpZykge1xuICAgIGF3YWl0IGNvbmZpZy5sb2FkS2V5cygpO1xuICB9XG5cbiAgaW5mby5hcHAgPSBBcHBDYWNoZS5nZXQoaW5mby5hcHBJZCk7XG4gIHJlcS5jb25maWcgPSBjb25maWc7XG4gIHJlcS5jb25maWcuaGVhZGVycyA9IHJlcS5oZWFkZXJzIHx8IHt9O1xuICByZXEuY29uZmlnLmlwID0gY2xpZW50SXA7XG4gIHJlcS5pbmZvID0gaW5mbztcblxuICAvLyBTa2lwIGtleSBkZXRlY3Rpb24gaWYgYWxyZWFkeSByZXNvbHZlZCBieSBoYW5kbGVQYXJzZUF1dGggKGhlYWRlci1iYXNlZCkuXG4gIC8vIE9ubHkgcmVzb2x2ZSBoZXJlIGZvciBib2R5LWJhc2VkIF9NYXN0ZXJLZXkgKGluZm8ubWFzdGVyS2V5IG1heSBjb21lIGZyb20gYm9keSkuXG4gIGlmICghcmVxLmF1dGggfHwgKCFyZXEuYXV0aC5pc01hc3RlciAmJiAhcmVxLmF1dGguaXNNYWludGVuYW5jZSkpIHtcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVLZXlBdXRoKHtcbiAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgIGtleVZhbHVlOiBpbmZvLm1hc3RlcktleSxcbiAgICAgIG1haW50ZW5hbmNlS2V5VmFsdWU6IGluZm8ubWFpbnRlbmFuY2VLZXksXG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGNsaWVudElwLFxuICAgIH0pO1xuICAgIGlmIChyZXNvbHZlZCkge1xuICAgICAgcmVxLmF1dGggPSByZXNvbHZlZDtcbiAgICB9XG4gIH1cblxuICBpZiAocmVxLmF1dGggJiYgKHJlcS5hdXRoLmlzTWFzdGVyIHx8IHJlcS5hdXRoLmlzTWFpbnRlbmFuY2UpKSB7XG4gICAgcmV0dXJuIGhhbmRsZVJhdGVMaW1pdChyZXEsIHJlcywgbmV4dCk7XG4gIH1cblxuICAvLyBDbGllbnQga2V5cyBhcmUgbm90IHJlcXVpcmVkIGluIHBhcnNlLXNlcnZlciwgYnV0IGlmIGFueSBoYXZlIGJlZW4gY29uZmlndXJlZCBpbiB0aGUgc2VydmVyLCB2YWxpZGF0ZSB0aGVtXG4gIC8vICB0byBwcmVzZXJ2ZSBvcmlnaW5hbCBiZWhhdmlvci5cbiAgY29uc3Qga2V5cyA9IFsnY2xpZW50S2V5JywgJ2phdmFzY3JpcHRLZXknLCAnZG90TmV0S2V5JywgJ3Jlc3RBUElLZXknXTtcbiAgY29uc3Qgb25lS2V5Q29uZmlndXJlZCA9IGtleXMuc29tZShmdW5jdGlvbiAoa2V5KSB7XG4gICAgcmV0dXJuIHJlcS5jb25maWdba2V5XSAhPT0gdW5kZWZpbmVkO1xuICB9KTtcbiAgY29uc3Qgb25lS2V5TWF0Y2hlcyA9IGtleXMuc29tZShmdW5jdGlvbiAoa2V5KSB7XG4gICAgcmV0dXJuIHJlcS5jb25maWdba2V5XSAhPT0gdW5kZWZpbmVkICYmIGluZm9ba2V5XSA9PT0gcmVxLmNvbmZpZ1trZXldO1xuICB9KTtcblxuICBpZiAob25lS2V5Q29uZmlndXJlZCAmJiAhb25lS2V5TWF0Y2hlcykge1xuICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gIH1cblxuICBpZiAobWF0Y2hlc0V4YWN0Um91dGUocmVxLnBhdGgsICcvbG9naW4nKSkge1xuICAgIGRlbGV0ZSBpbmZvLnNlc3Npb25Ub2tlbjtcbiAgfVxuXG4gIGlmIChyZXEudXNlckZyb21KV1QpIHtcbiAgICByZXEuYXV0aCA9IG5ldyBhdXRoLkF1dGgoe1xuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBpc01hc3RlcjogZmFsc2UsXG4gICAgICB1c2VyOiByZXEudXNlckZyb21KV1QsXG4gICAgfSk7XG4gICAgcmV0dXJuIGhhbmRsZVJhdGVMaW1pdChyZXEsIHJlcywgbmV4dCk7XG4gIH1cblxuICBpZiAoIWluZm8uc2Vzc2lvblRva2VuKSB7XG4gICAgcmVxLmF1dGggPSBuZXcgYXV0aC5BdXRoKHtcbiAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgIGluc3RhbGxhdGlvbklkOiBpbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgIH0pO1xuICB9XG4gIGhhbmRsZVJhdGVMaW1pdChyZXEsIHJlcywgbmV4dCk7XG59XG5cbmNvbnN0IGhhbmRsZVJhdGVMaW1pdCA9IGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICBjb25zdCByYXRlTGltaXRzID0gcmVxLmNvbmZpZy5yYXRlTGltaXRzIHx8IFtdO1xuICB0cnkge1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgcmF0ZUxpbWl0cy5tYXAoYXN5bmMgbGltaXQgPT4ge1xuICAgICAgICBjb25zdCBwYXRoRXhwID0gbGltaXQucGF0aC5yZWdleHAgfHwgbGltaXQucGF0aDtcbiAgICAgICAgaWYgKHBhdGhFeHAudGVzdChyZXEucGF0aCkgfHwgKHJlcS5fZ3JhcGhRTFBhdGggJiYgcGF0aEV4cC50ZXN0KHJlcS5fZ3JhcGhRTFBhdGgpKSkge1xuICAgICAgICAgIGF3YWl0IGxpbWl0LmhhbmRsZXIocmVxLCByZXMsIGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PT0gUGFyc2UuRXJyb3IuQ09OTkVDVElPTl9GQUlMRUQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyLmVycm9yKFxuICAgICAgICAgICAgICAgICdBbiB1bmtub3duIGVycm9yIG9jY3VyZWQgd2hlbiBhdHRlbXB0aW5nIHRvIGFwcGx5IHRoZSByYXRlIGxpbWl0ZXI6ICcsXG4gICAgICAgICAgICAgICAgZXJyXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXMuc3RhdHVzKDQyOSk7XG4gICAgcmVzLmpzb24oeyBjb2RlOiBQYXJzZS5FcnJvci5DT05ORUNUSU9OX0ZBSUxFRCwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIG5leHQoKTtcbn07XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVQYXJzZVNlc3Npb24gPSBhc3luYyAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBpbmZvID0gcmVxLmluZm87XG4gICAgaWYgKHJlcS5hdXRoIHx8IChtYXRjaGVzRXhhY3RSb3V0ZShyZXEucGF0aCwgJy9zZXNzaW9ucy9tZScpICYmIHJlcS5tZXRob2QgPT09ICdHRVQnKSkge1xuICAgICAgbmV4dCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcmVxdWVzdEF1dGggPSBudWxsO1xuICAgIGlmIChcbiAgICAgIGluZm8uc2Vzc2lvblRva2VuICYmXG4gICAgICBtYXRjaGVzRXhhY3RSb3V0ZShyZXEucGF0aCwgJy91cGdyYWRlVG9SZXZvY2FibGVTZXNzaW9uJykgJiZcbiAgICAgIGluZm8uc2Vzc2lvblRva2VuLmluZGV4T2YoJ3I6JykgIT0gMFxuICAgICkge1xuICAgICAgcmVxdWVzdEF1dGggPSBhd2FpdCBhdXRoLmdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4oe1xuICAgICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICAgIGluc3RhbGxhdGlvbklkOiBpbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgICBzZXNzaW9uVG9rZW46IGluZm8uc2Vzc2lvblRva2VuLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlcXVlc3RBdXRoID0gYXdhaXQgYXV0aC5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKHtcbiAgICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgc2Vzc2lvblRva2VuOiBpbmZvLnNlc3Npb25Ub2tlbixcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXEuYXV0aCA9IHJlcXVlc3RBdXRoO1xuICAgIG5leHQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgICAgbmV4dChlcnJvcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIExvZyBmdWxsIGVycm9yIGRldGFpbHMgaW50ZXJuYWxseSwgYnV0IGRvbid0IGV4cG9zZSB0byBjbGllbnRcbiAgICByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIuZXJyb3IoJ2Vycm9yIGdldHRpbmcgYXV0aCBmb3Igc2Vzc2lvblRva2VuJywgZXJyb3IpO1xuICAgIG5leHQobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVOS05PV05fRVJST1IsICdVbmtub3duIGVycm9yJykpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBnZXRDbGllbnRJcChyZXEpIHtcbiAgcmV0dXJuIHJlcS5pcDtcbn1cblxuZnVuY3Rpb24gaHR0cEF1dGgocmVxKSB7XG4gIGlmICghKHJlcS5yZXEgfHwgcmVxKS5oZWFkZXJzLmF1dGhvcml6YXRpb24pIHsgcmV0dXJuOyB9XG5cbiAgdmFyIGhlYWRlciA9IChyZXEucmVxIHx8IHJlcSkuaGVhZGVycy5hdXRob3JpemF0aW9uO1xuICB2YXIgYXBwSWQsIG1hc3RlcktleSwgamF2YXNjcmlwdEtleTtcblxuICAvLyBwYXJzZSBoZWFkZXJcbiAgdmFyIGF1dGhQcmVmaXggPSAnYmFzaWMgJztcblxuICB2YXIgbWF0Y2ggPSBoZWFkZXIudG9Mb3dlckNhc2UoKS5pbmRleE9mKGF1dGhQcmVmaXgpO1xuXG4gIGlmIChtYXRjaCA9PSAwKSB7XG4gICAgdmFyIGVuY29kZWRBdXRoID0gaGVhZGVyLnN1YnN0cmluZyhhdXRoUHJlZml4Lmxlbmd0aCwgaGVhZGVyLmxlbmd0aCk7XG4gICAgdmFyIGNyZWRlbnRpYWxzID0gZGVjb2RlQmFzZTY0KGVuY29kZWRBdXRoKS5zcGxpdCgnOicpO1xuXG4gICAgaWYgKGNyZWRlbnRpYWxzLmxlbmd0aCA9PSAyKSB7XG4gICAgICBhcHBJZCA9IGNyZWRlbnRpYWxzWzBdO1xuICAgICAgdmFyIGtleSA9IGNyZWRlbnRpYWxzWzFdO1xuXG4gICAgICB2YXIganNLZXlQcmVmaXggPSAnamF2YXNjcmlwdC1rZXk9JztcblxuICAgICAgdmFyIG1hdGNoS2V5ID0ga2V5LmluZGV4T2YoanNLZXlQcmVmaXgpO1xuICAgICAgaWYgKG1hdGNoS2V5ID09IDApIHtcbiAgICAgICAgamF2YXNjcmlwdEtleSA9IGtleS5zdWJzdHJpbmcoanNLZXlQcmVmaXgubGVuZ3RoLCBrZXkubGVuZ3RoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1hc3RlcktleSA9IGtleTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBhcHBJZDogYXBwSWQsIG1hc3RlcktleTogbWFzdGVyS2V5LCBqYXZhc2NyaXB0S2V5OiBqYXZhc2NyaXB0S2V5IH07XG59XG5cbmZ1bmN0aW9uIGRlY29kZUJhc2U2NChzdHIpIHtcbiAgcmV0dXJuIEJ1ZmZlci5mcm9tKHN0ciwgJ2Jhc2U2NCcpLnRvU3RyaW5nKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhbGxvd0Nyb3NzRG9tYWluKGFwcElkKSB7XG4gIHJldHVybiAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGFwcElkLCBnZXRNb3VudEZvclJlcXVlc3QocmVxKSk7XG4gICAgbGV0IGFsbG93SGVhZGVycyA9IERFRkFVTFRfQUxMT1dFRF9IRUFERVJTO1xuICAgIGlmIChjb25maWcgJiYgY29uZmlnLmFsbG93SGVhZGVycykge1xuICAgICAgYWxsb3dIZWFkZXJzICs9IGAsICR7Y29uZmlnLmFsbG93SGVhZGVycy5qb2luKCcsICcpfWA7XG4gICAgfVxuXG4gICAgY29uc3QgYmFzZU9yaWdpbnMgPVxuICAgICAgdHlwZW9mIGNvbmZpZz8uYWxsb3dPcmlnaW4gPT09ICdzdHJpbmcnID8gW2NvbmZpZy5hbGxvd09yaWdpbl0gOiBjb25maWc/LmFsbG93T3JpZ2luID8/IFsnKiddO1xuICAgIGNvbnN0IHJlcXVlc3RPcmlnaW4gPSByZXEuaGVhZGVycy5vcmlnaW47XG4gICAgY29uc3QgYWxsb3dPcmlnaW5zID1cbiAgICAgIHJlcXVlc3RPcmlnaW4gJiYgYmFzZU9yaWdpbnMuaW5jbHVkZXMocmVxdWVzdE9yaWdpbikgPyByZXF1ZXN0T3JpZ2luIDogYmFzZU9yaWdpbnNbMF07XG4gICAgcmVzLmhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgYWxsb3dPcmlnaW5zKTtcbiAgICByZXMuaGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJywgJ0dFVCxQVVQsUE9TVCxERUxFVEUsT1BUSU9OUycpO1xuICAgIHJlcy5oZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnLCBhbGxvd0hlYWRlcnMpO1xuICAgIHJlcy5oZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUV4cG9zZS1IZWFkZXJzJywgJ1gtUGFyc2UtSm9iLVN0YXR1cy1JZCwgWC1QYXJzZS1QdXNoLVN0YXR1cy1JZCcpO1xuICAgIC8vIGludGVyY2VwdCBPUFRJT05TIG1ldGhvZFxuICAgIGlmICgnT1BUSU9OUycgPT0gcmVxLm1ldGhvZCkge1xuICAgICAgcmVzLnNlbmRTdGF0dXMoMjAwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV4dCgpO1xuICAgIH1cbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFsbG93TWV0aG9kT3ZlcnJpZGUocmVxLCByZXMsIG5leHQpIHtcbiAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiByZXEuYm9keT8uX21ldGhvZCkge1xuICAgIGlmICh0eXBlb2YgcmVxLmJvZHkuX21ldGhvZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJlcS5vcmlnaW5hbE1ldGhvZCA9IHJlcS5tZXRob2Q7XG4gICAgICByZXEubWV0aG9kID0gcmVxLmJvZHkuX21ldGhvZC50b1VwcGVyQ2FzZSgpO1xuICAgIH1cbiAgICBkZWxldGUgcmVxLmJvZHkuX21ldGhvZDtcbiAgfVxuICBuZXh0KCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVLZXlBdXRoKHsgY29uZmlnLCBrZXlWYWx1ZSwgbWFpbnRlbmFuY2VLZXlWYWx1ZSwgaW5zdGFsbGF0aW9uSWQsIGNsaWVudElwIH0pIHtcbiAgaWYgKG1haW50ZW5hbmNlS2V5VmFsdWUgJiYgbWFpbnRlbmFuY2VLZXlWYWx1ZSA9PT0gY29uZmlnLm1haW50ZW5hbmNlS2V5KSB7XG4gICAgaWYgKGNoZWNrSXAoY2xpZW50SXAsIGNvbmZpZy5tYWludGVuYW5jZUtleUlwcyB8fCBbXSwgY29uZmlnLm1haW50ZW5hbmNlS2V5SXBzU3RvcmUpKSB7XG4gICAgICByZXR1cm4gbmV3IGF1dGguQXV0aCh7IGNvbmZpZywgaW5zdGFsbGF0aW9uSWQsIGlzTWFpbnRlbmFuY2U6IHRydWUgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxvZyA9IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyIHx8IGRlZmF1bHRMb2dnZXI7XG4gICAgbG9nLmVycm9yKFxuICAgICAgYFJlcXVlc3QgdXNpbmcgbWFpbnRlbmFuY2Uga2V5IHJlamVjdGVkIGFzIHRoZSByZXF1ZXN0IElQIGFkZHJlc3MgJyR7Y2xpZW50SXB9JyBpcyBub3Qgc2V0IGluIFBhcnNlIFNlcnZlciBvcHRpb24gJ21haW50ZW5hbmNlS2V5SXBzJy5gXG4gICAgKTtcbiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcigpO1xuICAgIGVycm9yLnN0YXR1cyA9IDQwMztcbiAgICBlcnJvci5tZXNzYWdlID0gJ3VuYXV0aG9yaXplZCc7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgY29uc3QgbWFzdGVyS2V5ID0gYXdhaXQgY29uZmlnLmxvYWRNYXN0ZXJLZXkoKTtcbiAgaWYgKGtleVZhbHVlID09PSBtYXN0ZXJLZXkpIHtcbiAgICBpZiAoY2hlY2tJcChjbGllbnRJcCwgY29uZmlnLm1hc3RlcktleUlwcyB8fCBbXSwgY29uZmlnLm1hc3RlcktleUlwc1N0b3JlKSkge1xuICAgICAgcmV0dXJuIG5ldyBhdXRoLkF1dGgoeyBjb25maWcsIGluc3RhbGxhdGlvbklkLCBpc01hc3RlcjogdHJ1ZSB9KTtcbiAgICB9XG4gICAgY29uc3QgbG9nID0gY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIgfHwgZGVmYXVsdExvZ2dlcjtcbiAgICBsb2cuZXJyb3IoXG4gICAgICBgUmVxdWVzdCB1c2luZyBtYXN0ZXIga2V5IHJlamVjdGVkIGFzIHRoZSByZXF1ZXN0IElQIGFkZHJlc3MgJyR7Y2xpZW50SXB9JyBpcyBub3Qgc2V0IGluIFBhcnNlIFNlcnZlciBvcHRpb24gJ21hc3RlcktleUlwcycuYFxuICAgICk7XG4gICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoKTtcbiAgICBlcnJvci5zdGF0dXMgPSA0MDM7XG4gICAgZXJyb3IubWVzc2FnZSA9ICd1bmF1dGhvcml6ZWQnO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIGlmIChcbiAgICBrZXlWYWx1ZSAmJlxuICAgIHR5cGVvZiBjb25maWcucmVhZE9ubHlNYXN0ZXJLZXkgIT09ICd1bmRlZmluZWQnICYmXG4gICAgY29uZmlnLnJlYWRPbmx5TWFzdGVyS2V5ICYmXG4gICAga2V5VmFsdWUgPT09IGNvbmZpZy5yZWFkT25seU1hc3RlcktleVxuICApIHtcbiAgICBpZiAoY2hlY2tJcChjbGllbnRJcCwgY29uZmlnLnJlYWRPbmx5TWFzdGVyS2V5SXBzIHx8IFtdLCBjb25maWcucmVhZE9ubHlNYXN0ZXJLZXlJcHNTdG9yZSkpIHtcbiAgICAgIHJldHVybiBuZXcgYXV0aC5BdXRoKHsgY29uZmlnLCBpbnN0YWxsYXRpb25JZCwgaXNNYXN0ZXI6IHRydWUsIGlzUmVhZE9ubHk6IHRydWUgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxvZyA9IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyIHx8IGRlZmF1bHRMb2dnZXI7XG4gICAgbG9nLmVycm9yKFxuICAgICAgYFJlcXVlc3QgdXNpbmcgcmVhZC1vbmx5IG1hc3RlciBrZXkgcmVqZWN0ZWQgYXMgdGhlIHJlcXVlc3QgSVAgYWRkcmVzcyAnJHtjbGllbnRJcH0nIGlzIG5vdCBzZXQgaW4gUGFyc2UgU2VydmVyIG9wdGlvbiAncmVhZE9ubHlNYXN0ZXJLZXlJcHMnLmBcbiAgICApO1xuICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKCk7XG4gICAgZXJyb3Iuc3RhdHVzID0gNDAzO1xuICAgIGVycm9yLm1lc3NhZ2UgPSAndW5hdXRob3JpemVkJztcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlQXV0aChhcHBJZCkge1xuICByZXR1cm4gYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgY29uc3QgbW91bnQgPSBnZXRNb3VudEZvclJlcXVlc3QocmVxKTtcbiAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGFwcElkLCBtb3VudCk7XG4gICAgaWYgKCFjb25maWcpIHtcbiAgICAgIHJldHVybiBuZXh0KCk7XG4gICAgfVxuICAgIHJlcS5jb25maWcgPSBjb25maWc7XG4gICAgY29uc3QgY2xpZW50SXAgPSBnZXRDbGllbnRJcChyZXEpO1xuICAgIHJlcS5jb25maWcuaXAgPSBjbGllbnRJcDtcbiAgICBhd2FpdCBjb25maWcubG9hZEtleXMoKTtcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVLZXlBdXRoKHtcbiAgICAgIGNvbmZpZyxcbiAgICAgIGtleVZhbHVlOiByZXEuZ2V0KCdYLVBhcnNlLU1hc3Rlci1LZXknKSB8fCBudWxsLFxuICAgICAgbWFpbnRlbmFuY2VLZXlWYWx1ZTogcmVxLmdldCgnWC1QYXJzZS1NYWludGVuYW5jZS1LZXknKSB8fCBudWxsLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5nZXQoJ1gtUGFyc2UtSW5zdGFsbGF0aW9uLUlkJykgfHwgJ2Nsb3VkJyxcbiAgICAgIGNsaWVudElwLFxuICAgIH0pO1xuICAgIGlmIChyZXNvbHZlZCkge1xuICAgICAgcmVxLmF1dGggPSByZXNvbHZlZDtcbiAgICB9XG4gICAgcmV0dXJuIG5leHQoKTtcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlSGVhbHRoKG9wdGlvbnMpIHtcbiAgcmV0dXJuIChyZXEsIHJlcykgPT4ge1xuICAgIHJlcy5zdGF0dXMob3B0aW9ucy5zdGF0ZSA9PT0gJ29rJyA/IDIwMCA6IDUwMyk7XG4gICAgaWYgKG9wdGlvbnMuc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHJlcy5zZXQoJ1JldHJ5LUFmdGVyJywgMSk7XG4gICAgfVxuICAgIHJlcy5qc29uKHtcbiAgICAgIHN0YXR1czogb3B0aW9ucy5zdGF0ZSxcbiAgICB9KTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVBbGxvd0xpc3RQYXRoKHBhdGgsIG1vdW50KSB7XG4gIGxldCBub3JtYWxpemVkID0gcGF0aDtcbiAgaWYgKG1vdW50KSB7XG4gICAgY29uc3QgbW91bnRQYXRoID0gbmV3IFVSTChtb3VudCkucGF0aG5hbWU7XG4gICAgaWYgKG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChtb3VudFBhdGgpKSB7XG4gICAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zdWJzdHJpbmcobW91bnRQYXRoLmxlbmd0aCk7XG4gICAgfVxuICB9XG4gIGlmIChub3JtYWxpemVkLnN0YXJ0c1dpdGgoJy8nKSkge1xuICAgIG5vcm1hbGl6ZWQgPSBub3JtYWxpemVkLnN1YnN0cmluZygxKTtcbiAgfVxuICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aCgnLycpKSB7XG4gICAgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZWQuc3Vic3RyaW5nKDAsIG5vcm1hbGl6ZWQubGVuZ3RoIC0gMSk7XG4gIH1cbiAgY29uc3QgcXVlcnlJbmRleCA9IG5vcm1hbGl6ZWQuaW5kZXhPZignPycpO1xuICBpZiAocXVlcnlJbmRleCAhPT0gLTEpIHtcbiAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zdWJzdHJpbmcoMCwgcXVlcnlJbmRleCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbi8vIENhY2hlIG9mIGNvbXBpbGVkIGV4YWN0LXJvdXRlIG1hdGNoZXJzLCBrZXllZCBieSByb3V0ZS4gTWlycm9ycyBob3cgYGFkZFJhdGVMaW1pdGAgY29tcGlsZXMgYVxuLy8gcm91dGUncyBgcGF0aFRvUmVnZXhwYCBvbmNlIGFuZCByZXVzZXMgaXQsIGF2b2lkaW5nIHJlY29tcGlsYXRpb24gb24gZXZlcnkgcmVxdWVzdC5cbmNvbnN0IGV4YWN0Um91dGVSZWdleHBDYWNoZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIGBwYXRoYCByZXNvbHZlcyB0byB0aGUgZ2l2ZW4gZXhhY3Qgc3RhdGljIGByb3V0ZWAsIHVzaW5nIHRoZSBzYW1lXG4gKiBgcGF0aC10by1yZWdleHBgIG1hdGNoaW5nIHRoYXQgdGhlIEV4cHJlc3Mgcm91dGVyIGFuZCB0aGUgcmF0ZSBsaW1pdGVyIHVzZSAoY2FzZS1pbnNlbnNpdGl2ZVxuICogYW5kIHRyYWlsaW5nLXNsYXNoLXRvbGVyYW50IGJ5IGRlZmF1bHQpLiBQYXRoLWxpdGVyYWwgY2hlY2tzIOKAlCBzdWNoIGFzIGRldGVjdGluZyBgL2xvZ2luYCB0b1xuICogZHJvcCB0aGUgaW5ib3VuZCBzZXNzaW9uIHRva2VuIOKAlCBtdXN0IHVzZSB0aGlzIHNvIHRoZXkgc3RheSBjb25zaXN0ZW50IHdpdGggaG93IHRoZSByb3V0ZXJcbiAqIGFjdHVhbGx5IGRpc3BhdGNoZXMgdGhlIHJlcXVlc3QsIGluc3RlYWQgb2YgcmUtZGVyaXZpbmcgdGhlIG1hdGNoaW5nIHJ1bGVzIGJ5IGhhbmQuXG4gKiBAcGFyYW0ge3N0cmluZ30gcGF0aCBUaGUgcmVxdWVzdCBwYXRoIChlLmcuIGByZXEucGF0aGAgb3IgYSBiYXRjaCBzdWItcmVxdWVzdCByb3V0YWJsZSBwYXRoKS5cbiAqIEBwYXJhbSB7c3RyaW5nfSByb3V0ZSBUaGUgZXhhY3Qgc3RhdGljIHJvdXRlIHRvIG1hdGNoIChlLmcuIGAvbG9naW5gKS5cbiAqIEByZXR1cm5zIHtib29sZWFufVxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0V4YWN0Um91dGUocGF0aCwgcm91dGUpIHtcbiAgaWYgKHR5cGVvZiBwYXRoICE9PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoIWV4YWN0Um91dGVSZWdleHBDYWNoZVtyb3V0ZV0pIHtcbiAgICBleGFjdFJvdXRlUmVnZXhwQ2FjaGVbcm91dGVdID0gcGF0aFRvUmVnZXhwKHJvdXRlKS5yZWdleHA7XG4gIH1cbiAgcmV0dXJuIGV4YWN0Um91dGVSZWdleHBDYWNoZVtyb3V0ZV0udGVzdChwYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUm91dGVBbGxvd2VkKHBhdGgsIGNvbmZpZywgYXV0aCkge1xuICBpZiAoIWNvbmZpZyB8fCBjb25maWcucm91dGVBbGxvd0xpc3QgPT09IHVuZGVmaW5lZCB8fCBjb25maWcucm91dGVBbGxvd0xpc3QgPT09IG51bGwpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aCAmJiAoYXV0aC5pc01hc3RlciB8fCBhdXRoLmlzTWFpbnRlbmFuY2UpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJvdXRlQWxsb3dMaXN0UGF0aChwYXRoLCBjb25maWcubW91bnQpO1xuICBjb25zdCByZWdleGVzID0gY29uZmlnLl9yb3V0ZUFsbG93TGlzdFJlZ2V4IHx8IFtdO1xuICBmb3IgKGNvbnN0IHJlZ2V4IG9mIHJlZ2V4ZXMpIHtcbiAgICBpZiAocmVnZXgudGVzdChub3JtYWxpemVkKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuZm9yY2VSb3V0ZUFsbG93TGlzdChyZXEsIHJlcywgbmV4dCkge1xuICBpZiAoaXNSb3V0ZUFsbG93ZWQocmVxLm9yaWdpbmFsVXJsLCByZXEuY29uZmlnLCByZXEuYXV0aCkpIHtcbiAgICByZXR1cm4gbmV4dCgpO1xuICB9XG4gIGNvbnN0IHBhdGggPSBub3JtYWxpemVSb3V0ZUFsbG93TGlzdFBhdGgocmVxLm9yaWdpbmFsVXJsLCByZXEuY29uZmlnPy5tb3VudCk7XG4gIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgYFJvdXRlIG5vdCBhbGxvd2VkIGJ5IHJvdXRlQWxsb3dMaXN0OiAke3JlcS5tZXRob2R9ICR7cGF0aH1gLFxuICAgIHJlcS5jb25maWdcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlRXJyb3JzKGVyciwgcmVxLCByZXMsIG5leHQpIHtcbiAgY29uc3QgbG9nID0gKHJlcS5jb25maWcgJiYgcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyKSB8fCBkZWZhdWx0TG9nZ2VyO1xuICBpZiAoZXJyIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICBpZiAocmVxLmNvbmZpZyAmJiByZXEuY29uZmlnLmVuYWJsZUV4cHJlc3NFcnJvckhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBuZXh0KGVycik7XG4gICAgfVxuICAgIGNvbnN0IHNpZ251cFVzZXJuYW1lVGFrZW5MZXZlbCA9XG4gICAgICByZXEuY29uZmlnPy5sb2dMZXZlbHM/LnNpZ251cFVzZXJuYW1lVGFrZW4gfHwgJ2luZm8nO1xuICAgIGxldCBodHRwU3RhdHVzO1xuICAgIC8vIFRPRE86IGZpbGwgb3V0IHRoaXMgbWFwcGluZ1xuICAgIHN3aXRjaCAoZXJyLmNvZGUpIHtcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SOlxuICAgICAgICBodHRwU3RhdHVzID0gNTAwO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORDpcbiAgICAgICAgaHR0cFN0YXR1cyA9IDQwNDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBodHRwU3RhdHVzID0gNDAwO1xuICAgIH1cbiAgICByZXMuc3RhdHVzKGh0dHBTdGF0dXMpO1xuICAgIHJlcy5qc29uKHsgY29kZTogZXJyLmNvZGUsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICBpZiAoZXJyLmNvZGUgPT09IFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOKSB7XG4gICAgICBpZiAoc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsICE9PSAnc2lsZW50Jykge1xuICAgICAgICBjb25zdCBsb2dnZXJNZXRob2QgPVxuICAgICAgICAgIHR5cGVvZiBsb2dbc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsXSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgPyBsb2dbc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsXS5iaW5kKGxvZylcbiAgICAgICAgICAgIDogbG9nLmVycm9yLmJpbmQobG9nKTtcbiAgICAgICAgbG9nZ2VyTWV0aG9kKCdQYXJzZSBlcnJvcjogJywgZXJyKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLmVycm9yKCdQYXJzZSBlcnJvcjogJywgZXJyKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoZXJyLnN0YXR1cyAmJiBlcnIubWVzc2FnZSkge1xuICAgIHJlcy5zdGF0dXMoZXJyLnN0YXR1cyk7XG4gICAgcmVzLmpzb24oeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgaWYgKCEocHJvY2VzcyAmJiBwcm9jZXNzLmVudi5URVNUSU5HKSkge1xuICAgICAgbmV4dChlcnIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBsb2cuZXJyb3IoJ1VuY2F1Z2h0IGludGVybmFsIHNlcnZlciBlcnJvci4nLCBlcnIsIGVyci5zdGFjayk7XG4gICAgcmVzLnN0YXR1cyg1MDApO1xuICAgIHJlcy5qc29uKHtcbiAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgIG1lc3NhZ2U6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3IuJyxcbiAgICB9KTtcbiAgICBpZiAoIShwcm9jZXNzICYmIHByb2Nlc3MuZW52LlRFU1RJTkcpKSB7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbmZvcmNlTWFzdGVyS2V5QWNjZXNzKHJlcSwgcmVzLCBuZXh0KSB7XG4gIGlmICghcmVxLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBjb25zdCBlcnJvciA9IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICd1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWQnLCByZXEuY29uZmlnKTtcbiAgICByZXMuc3RhdHVzKGVycm9yLnN0YXR1cyk7XG4gICAgcmVzLmVuZChge1wiZXJyb3JcIjpcIiR7ZXJyb3IubWVzc2FnZX1cIn1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbmV4dCgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MocmVxdWVzdCkge1xuICBpZiAoIXJlcXVlc3QuYXV0aC5pc01hc3Rlcikge1xuICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICd1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWQnLCByZXF1ZXN0LmNvbmZpZyk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufVxuXG5leHBvcnQgY29uc3QgZ2V0UmF0ZUxpbWl0U3RvcmVQcmVmaXggPSByb3V0ZSA9PiB7XG4gIGNvbnN0IHJlcXVlc3RNZXRob2RzID0gQXJyYXkuaXNBcnJheShyb3V0ZS5yZXF1ZXN0TWV0aG9kcylcbiAgICA/IHJvdXRlLnJlcXVlc3RNZXRob2RzLm1hcChTdHJpbmcpLnNvcnQoKVxuICAgIDogcm91dGUucmVxdWVzdE1ldGhvZHNcbiAgICAgID8gW1N0cmluZyhyb3V0ZS5yZXF1ZXN0TWV0aG9kcyldXG4gICAgICA6IFtdO1xuICBjb25zdCBydWxlID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RQYXRoOiByb3V0ZS5yZXF1ZXN0UGF0aCxcbiAgICByZXF1ZXN0TWV0aG9kcyxcbiAgICB6b25lOiByb3V0ZS56b25lIHx8ICdpcCcsXG4gICAgcmVxdWVzdFRpbWVXaW5kb3c6IHJvdXRlLnJlcXVlc3RUaW1lV2luZG93LFxuICAgIHJlcXVlc3RDb3VudDogcm91dGUucmVxdWVzdENvdW50LFxuICAgIGluY2x1ZGVNYXN0ZXJLZXk6ICEhcm91dGUuaW5jbHVkZU1hc3RlcktleSxcbiAgICBpbmNsdWRlSW50ZXJuYWxSZXF1ZXN0czogISFyb3V0ZS5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyxcbiAgfSk7XG4gIGNvbnN0IGhhc2ggPSBjcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUocnVsZSkuZGlnZXN0KCdoZXgnKS5zbGljZSgwLCAxNik7XG4gIHJldHVybiBgcGFyc2Utc2VydmVyOnJhdGUtbGltaXQ6JHtoYXNofTpgO1xufTtcblxuLyoqXG4gKiBEZXRlcm1pbmVzIHdoZXRoZXIgYSByZXF1ZXN0IGlzIGFuIGludGVybmFsIHJlcXVlc3QsIGkuZS4gb25lIHRoYXQgb3JpZ2luYXRlcyBmcm9tIHRoZSBzYW1lIGhvc3RcbiAqIHdpdGhvdXQgcGFzc2luZyB0aHJvdWdoIGEgcHJveHksIHN1Y2ggYXMgYSBDbG91ZCBDb2RlIHJlcXVlc3QgdGhhdCBpcyByb3V0ZWQgdmlhIEhUVFAgd2hlbiB0aGVcbiAqIFBhcnNlIFNlcnZlciBvcHRpb24gYGRpcmVjdEFjY2Vzc2AgaXMgYGZhbHNlYC4gT25seSB0aGUgcmF3IHNvY2tldCBwZWVyIGFkZHJlc3MgaXMgY29uc3VsdGVkLFxuICogbmV2ZXIgYHJlcXVlc3QuaXBgOiB1bmRlciBhIHBlcm1pc3NpdmUgYHRydXN0UHJveHlgIHNldHRpbmcgRXhwcmVzcyByZXNvbHZlcyBgcmVxdWVzdC5pcGAgZnJvbVxuICogdGhlIGNsaWVudC1zdXBwbGllZCBgWC1Gb3J3YXJkZWQtRm9yYCBoZWFkZXIsIHNvIGEgcmVtb3RlIGNsaWVudCBjb3VsZCBvdGhlcndpc2UgcG9zZSBhcyBhblxuICogaW50ZXJuYWwgcmVxdWVzdC4gQSByZXF1ZXN0IHRoYXQgY2FycmllcyBhbiBgWC1Gb3J3YXJkZWQtRm9yYCBoZWFkZXIsIGV2ZW4gYW4gZW1wdHkgb25lLCBoYXMgYmVlblxuICogZm9yd2FyZGVkIGJ5IGEgcHJveHkgb3IgY3JhZnRlZCBieSBhIGNsaWVudCBhbmQgaXMgdGhlcmVmb3JlIG5ldmVyIGludGVybmFsLCBldmVuIGlmIGl0IGFycml2ZXNcbiAqIG92ZXIgYSBsb29wYmFjayBzb2NrZXQuXG4gKiBAcGFyYW0ge09iamVjdH0gcmVxdWVzdCBUaGUgcmVxdWVzdCB0byBldmFsdWF0ZS5cbiAqIEByZXR1cm5zIHtCb29sZWFufSBXaGV0aGVyIHRoZSByZXF1ZXN0IGlzIGludGVybmFsLlxuICovXG5jb25zdCBpc0ludGVybmFsUmVxdWVzdCA9IHJlcXVlc3QgPT5cbiAgcmVxdWVzdC5zb2NrZXQ/LnJlbW90ZUFkZHJlc3MgPT09ICcxMjcuMC4wLjEnICYmXG4gIHJlcXVlc3QuaGVhZGVycz8uWyd4LWZvcndhcmRlZC1mb3InXSA9PT0gdW5kZWZpbmVkO1xuXG5leHBvcnQgY29uc3QgYWRkUmF0ZUxpbWl0ID0gKHJvdXRlLCBjb25maWcsIGNsb3VkKSA9PiB7XG4gIGlmICh0eXBlb2YgY29uZmlnID09PSAnc3RyaW5nJykge1xuICAgIGNvbmZpZyA9IENvbmZpZy5nZXQoY29uZmlnKTtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByb3V0ZSkge1xuICAgIGlmICghUmF0ZUxpbWl0T3B0aW9uc1trZXldKSB7XG4gICAgICB0aHJvdyBgSW52YWxpZCByYXRlIGxpbWl0IG9wdGlvbiBcIiR7a2V5fVwiYDtcbiAgICB9XG4gIH1cbiAgaWYgKCFjb25maWcucmF0ZUxpbWl0cykge1xuICAgIGNvbmZpZy5yYXRlTGltaXRzID0gW107XG4gIH1cbiAgY29uc3QgcmVkaXNTdG9yZSA9IHtcbiAgICBjb25uZWN0aW9uUHJvbWlzZTogUHJvbWlzZS5yZXNvbHZlKCksXG4gICAgc3RvcmU6IG51bGwsXG4gIH07XG4gIGlmIChyb3V0ZS5yZWRpc1VybCkge1xuICAgIGNvbnN0IGxvZyA9IGNvbmZpZz8ubG9nZ2VyQ29udHJvbGxlciB8fCBkZWZhdWx0TG9nZ2VyO1xuICAgIGNvbnN0IGNsaWVudCA9IGNyZWF0ZUNsaWVudCh7XG4gICAgICB1cmw6IHJvdXRlLnJlZGlzVXJsLFxuICAgIH0pO1xuICAgIGNsaWVudC5vbignZXJyb3InLCBlcnIgPT4geyBsb2cuZXJyb3IoJ01pZGRsZXdhcmVzIGFkZFJhdGVMaW1pdCBSZWRpcyBjbGllbnQgZXJyb3InLCB7IGVycm9yOiBlcnIgfSkgfSk7XG4gICAgY2xpZW50Lm9uKCdjb25uZWN0JywgKCkgPT4geyB9KTtcbiAgICBjbGllbnQub24oJ3JlY29ubmVjdGluZycsICgpID0+IHsgfSk7XG4gICAgY2xpZW50Lm9uKCdyZWFkeScsICgpID0+IHsgfSk7XG4gICAgcmVkaXNTdG9yZS5jb25uZWN0aW9uUHJvbWlzZSA9IGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChjbGllbnQuaXNPcGVuKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNsaWVudC5jb25uZWN0KCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZy5lcnJvcihgQ291bGQgbm90IGNvbm5lY3QgdG8gcmVkaXNVUkwgaW4gcmF0ZSBsaW1pdDogJHtlfWApO1xuICAgICAgfVxuICAgIH07XG4gICAgcmVkaXNTdG9yZS5jb25uZWN0aW9uUHJvbWlzZSgpO1xuICAgIHJlZGlzU3RvcmUuc3RvcmUgPSBuZXcgUmVkaXNTdG9yZSh7XG4gICAgICBwcmVmaXg6IGdldFJhdGVMaW1pdFN0b3JlUHJlZml4KHJvdXRlKSxcbiAgICAgIHNlbmRDb21tYW5kOiBhc3luYyAoLi4uYXJncykgPT4ge1xuICAgICAgICBhd2FpdCByZWRpc1N0b3JlLmNvbm5lY3Rpb25Qcm9taXNlKCk7XG4gICAgICAgIHJldHVybiBjbGllbnQuc2VuZENvbW1hbmQoYXJncyk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIGNvbmZpZy5yYXRlTGltaXRzLnB1c2goe1xuICAgIHBhdGg6IHBhdGhUb1JlZ2V4cChyb3V0ZS5yZXF1ZXN0UGF0aCksXG4gICAgcmVxdWVzdENvdW50OiByb3V0ZS5yZXF1ZXN0Q291bnQsXG4gICAgcmVxdWVzdE1ldGhvZHM6IHJvdXRlLnJlcXVlc3RNZXRob2RzLFxuICAgIGluY2x1ZGVNYXN0ZXJLZXk6IHJvdXRlLmluY2x1ZGVNYXN0ZXJLZXksXG4gICAgaW5jbHVkZUludGVybmFsUmVxdWVzdHM6IHJvdXRlLmluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzLFxuICAgIGVycm9yUmVzcG9uc2VNZXNzYWdlOiByb3V0ZS5lcnJvclJlc3BvbnNlTWVzc2FnZSB8fCBSYXRlTGltaXRPcHRpb25zLmVycm9yUmVzcG9uc2VNZXNzYWdlLmRlZmF1bHQsXG4gICAgaGFuZGxlcjogcmF0ZUxpbWl0KHtcbiAgICAgIHdpbmRvd01zOiByb3V0ZS5yZXF1ZXN0VGltZVdpbmRvdyxcbiAgICAgIG1heDogcm91dGUucmVxdWVzdENvdW50LFxuICAgICAgbWVzc2FnZTogcm91dGUuZXJyb3JSZXNwb25zZU1lc3NhZ2UgfHwgUmF0ZUxpbWl0T3B0aW9ucy5lcnJvclJlc3BvbnNlTWVzc2FnZS5kZWZhdWx0LFxuICAgICAgaGFuZGxlcjogKHJlcXVlc3QsIHJlc3BvbnNlLCBuZXh0LCBvcHRpb25zKSA9PiB7XG4gICAgICAgIHRocm93IHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5DT05ORUNUSU9OX0ZBSUxFRCxcbiAgICAgICAgICBtZXNzYWdlOiBvcHRpb25zLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgICAgc2tpcDogcmVxdWVzdCA9PiB7XG4gICAgICAgIGlmICghcm91dGUuaW5jbHVkZUludGVybmFsUmVxdWVzdHMgJiYgaXNJbnRlcm5hbFJlcXVlc3QocmVxdWVzdCkpIHtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocm91dGUuaW5jbHVkZU1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocm91dGUucmVxdWVzdE1ldGhvZHMpIHtcbiAgICAgICAgICBjb25zdCBtZXRob2RzVG9DaGVjayA9IG5ldyBTZXQoW3JlcXVlc3QubWV0aG9kXSk7XG4gICAgICAgICAgaWYgKHJlcXVlc3QuX2JhdGNoT3JpZ2luYWxNZXRob2QpIHtcbiAgICAgICAgICAgIG1ldGhvZHNUb0NoZWNrLmFkZChyZXF1ZXN0Ll9iYXRjaE9yaWdpbmFsTWV0aG9kKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocm91dGUucmVxdWVzdE1ldGhvZHMpKSB7XG4gICAgICAgICAgICBpZiAoIXJvdXRlLnJlcXVlc3RNZXRob2RzLnNvbWUobSA9PiBtZXRob2RzVG9DaGVjay5oYXMobSkpKSB7XG4gICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCByZWdFeHAgPSBuZXcgUmVnRXhwKHJvdXRlLnJlcXVlc3RNZXRob2RzKTtcbiAgICAgICAgICAgIGlmICghWy4uLm1ldGhvZHNUb0NoZWNrXS5zb21lKG0gPT4gcmVnRXhwLnRlc3QobSkpKSB7XG4gICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVxdWVzdC5hdXRoPy5pc01hc3RlcjtcbiAgICAgIH0sXG4gICAgICBrZXlHZW5lcmF0b3I6IGFzeW5jIHJlcXVlc3QgPT4ge1xuICAgICAgICBpZiAocm91dGUuem9uZSA9PT0gUGFyc2UuU2VydmVyLlJhdGVMaW1pdFpvbmUuZ2xvYmFsKSB7XG4gICAgICAgICAgcmV0dXJuIHJlcXVlc3QuY29uZmlnLmFwcElkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHRva2VuID0gcmVxdWVzdC5pbmZvLnNlc3Npb25Ub2tlbjtcbiAgICAgICAgaWYgKHJvdXRlLnpvbmUgPT09IFBhcnNlLlNlcnZlci5SYXRlTGltaXRab25lLnNlc3Npb24gJiYgdG9rZW4pIHtcbiAgICAgICAgICByZXR1cm4gdG9rZW47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvdXRlLnpvbmUgPT09IFBhcnNlLlNlcnZlci5SYXRlTGltaXRab25lLnVzZXIgJiYgdG9rZW4pIHtcbiAgICAgICAgICBpZiAoIXJlcXVlc3QuYXV0aCkge1xuICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBoYW5kbGVQYXJzZVNlc3Npb24ocmVxdWVzdCwgbnVsbCwgcmVzb2x2ZSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxdWVzdC5hdXRoPy51c2VyPy5pZCAmJiByb3V0ZS56b25lID09PSAndXNlcicpIHtcbiAgICAgICAgICAgIHJldHVybiByZXF1ZXN0LmF1dGgudXNlci5pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlcXVlc3QuY29uZmlnLmlwO1xuICAgICAgfSxcbiAgICAgIHN0b3JlOiByZWRpc1N0b3JlLnN0b3JlLFxuICAgIH0pLFxuICAgIGNsb3VkLFxuICB9KTtcbiAgQ29uZmlnLnB1dChjb25maWcpO1xufTtcblxuLyoqXG4gKiBEZWR1cGxpY2F0ZXMgYSByZXF1ZXN0IHRvIGVuc3VyZSBpZGVtcG90ZW5jeS4gRHVwbGljYXRlcyBhcmUgZGV0ZXJtaW5lZCBieSB0aGUgcmVxdWVzdCBJRFxuICogaW4gdGhlIHJlcXVlc3QgaGVhZGVyLiBJZiBhIHJlcXVlc3QgaGFzIG5vIHJlcXVlc3QgSUQsIGl0IGlzIGV4ZWN1dGVkIGFueXdheS5cbiAqIEBwYXJhbSB7Kn0gcmVxIFRoZSByZXF1ZXN0IHRvIGV2YWx1YXRlLlxuICogQHJldHVybnMgUHJvbWlzZTx7fT5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeShyZXEpIHtcbiAgLy8gRW5hYmxlIGZlYXR1cmUgb25seSBmb3IgTW9uZ29EQlxuICBpZiAoXG4gICAgIShcbiAgICAgIHJlcS5jb25maWcuZGF0YWJhc2UuYWRhcHRlciBpbnN0YW5jZW9mIE1vbmdvU3RvcmFnZUFkYXB0ZXIgfHxcbiAgICAgIHJlcS5jb25maWcuZGF0YWJhc2UuYWRhcHRlciBpbnN0YW5jZW9mIFBvc3RncmVzU3RvcmFnZUFkYXB0ZXJcbiAgICApXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBHZXQgcGFyYW1ldGVyc1xuICBjb25zdCBjb25maWcgPSByZXEuY29uZmlnO1xuICBjb25zdCByZXF1ZXN0SWQgPSAoKHJlcSB8fCB7fSkuaGVhZGVycyB8fCB7fSlbJ3gtcGFyc2UtcmVxdWVzdC1pZCddO1xuICBjb25zdCB7IHBhdGhzLCB0dGwgfSA9IGNvbmZpZy5pZGVtcG90ZW5jeU9wdGlvbnM7XG4gIGlmICghcmVxdWVzdElkIHx8ICFjb25maWcuaWRlbXBvdGVuY3lPcHRpb25zKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJlcXVlc3QgcGF0aCBtYXkgY29udGFpbiB0cmFpbGluZyBzbGFzaGVzLCBkZXBlbmRpbmcgb24gdGhlIG9yaWdpbmFsIHJlcXVlc3QsIHNvIHJlbW92ZVxuICAvLyBsZWFkaW5nIGFuZCB0cmFpbGluZyBzbGFzaGVzIHRvIG1ha2UgaXQgZWFzaWVyIHRvIHNwZWNpZnkgcGF0aHMgaW4gdGhlIGNvbmZpZ3VyYXRpb25cbiAgY29uc3QgcmVxUGF0aCA9IHJlcS5wYXRoLnJlcGxhY2UoL15cXC98XFwvJC8sICcnKTtcbiAgLy8gRGV0ZXJtaW5lIHdoZXRoZXIgaWRlbXBvdGVuY3kgaXMgZW5hYmxlZCBmb3IgY3VycmVudCByZXF1ZXN0IHBhdGhcbiAgbGV0IG1hdGNoID0gZmFsc2U7XG4gIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgIC8vIEFzc3VtZSBvbmUgd2FudHMgYSBwYXRoIHRvIGFsd2F5cyBtYXRjaCBmcm9tIHRoZSBiZWdpbm5pbmcgdG8gcHJldmVudCBhbnkgbWlzdGFrZXNcbiAgICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAocGF0aC5jaGFyQXQoMCkgPT09ICdeJyA/IHBhdGggOiAnXicgKyBwYXRoKTtcbiAgICBpZiAocmVxUGF0aC5tYXRjaChyZWdleCkpIHtcbiAgICAgIG1hdGNoID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICBpZiAoIW1hdGNoKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFRyeSB0byBzdG9yZSByZXF1ZXN0XG4gIGNvbnN0IGV4cGlyeURhdGUgPSBuZXcgRGF0ZShuZXcgRGF0ZSgpLnNldFNlY29uZHMobmV3IERhdGUoKS5nZXRTZWNvbmRzKCkgKyB0dGwpKTtcbiAgcmV0dXJuIHJlc3RcbiAgICAuY3JlYXRlKGNvbmZpZywgYXV0aC5tYXN0ZXIoY29uZmlnKSwgJ19JZGVtcG90ZW5jeScsIHtcbiAgICAgIHJlcUlkOiByZXF1ZXN0SWQsXG4gICAgICBleHBpcmU6IFBhcnNlLl9lbmNvZGUoZXhwaXJ5RGF0ZSksXG4gICAgfSlcbiAgICAuY2F0Y2goZSA9PiB7XG4gICAgICBpZiAoZS5jb2RlID09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRFVQTElDQVRFX1JFUVVFU1QsICdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpIHtcbiAgcmVzLnN0YXR1cyg0MDMpO1xuICByZXMuZW5kKCd7XCJlcnJvclwiOlwidW5hdXRob3JpemVkXCJ9Jyk7XG59XG5cbmZ1bmN0aW9uIG1hbGZvcm1lZENvbnRleHQocmVxLCByZXMpIHtcbiAgcmVzLnN0YXR1cyg0MDApO1xuICByZXMuanNvbih7IGNvZGU6IFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgZXJyb3I6ICdJbnZhbGlkIG9iamVjdCBmb3IgY29udGV4dC4nIH0pO1xufVxuXG4vKipcbiAqIEV4cHJlc3MgNCBhbGxvd2VkIGEgZG91YmxlIGZvcndhcmQgc2xhc2ggYmV0d2VlbiBhIHJvdXRlIGFuZCByb3V0ZXIuIEFsdGhvdWdoXG4gKiB0aGlzIHNob3VsZCBiZSBjb25zaWRlcmVkIGFuIGFudGktcGF0dGVybiwgd2UgbmVlZCB0byBzdXBwb3J0IGl0IGZvciBiYWNrd2FyZHNcbiAqIGNvbXBhdGliaWxpdHkuXG4gKlxuICogVGVjaG5pY2FsbHkgdmFsaWQgVVJMIHdpdGggZG91YmxlIGZvcm93YXJkIHNsYXNoOlxuICogaHR0cDovL2xvY2FsaG9zdDoxMzM3L3BhcnNlLy9mdW5jdGlvbnMvdGVzdEZ1bmN0aW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbGxvd0RvdWJsZUZvcndhcmRTbGFzaChyZXEsIHJlcywgbmV4dCkge1xuICByZXEudXJsID0gcmVxLnVybC5zdGFydHNXaXRoKCcvLycpID8gcmVxLnVybC5zdWJzdHJpbmcoMSkgOiByZXEudXJsO1xuICBuZXh0KCk7XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxJQUFBQSxNQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxNQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxLQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxLQUFBLEdBQUFKLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSSxPQUFBLEdBQUFMLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSyxPQUFBLEdBQUFOLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBTSxLQUFBLEdBQUFQLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBTyxvQkFBQSxHQUFBUixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVEsdUJBQUEsR0FBQVQs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