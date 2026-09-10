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
      if (pathExp.test(req.path)) {
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
exports.getRateLimitStorePrefix = getRateLimitStorePrefix;
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
        if (request.ip === '127.0.0.1' && !route.includeInternalRequests) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfY2FjaGUiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9VdGlscyIsIl9ub2RlIiwiX0F1dGgiLCJfQ29uZmlnIiwiX2xvZ2dlciIsIl9yZXN0IiwiX01vbmdvU3RvcmFnZUFkYXB0ZXIiLCJfUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsIl9leHByZXNzUmF0ZUxpbWl0IiwiX0RlZmluaXRpb25zIiwiX3BhdGhUb1JlZ2V4cCIsIl9yYXRlTGltaXRSZWRpcyIsIl9yZWRpcyIsIl9uZXQiLCJfY3J5cHRvIiwiX0Vycm9yIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiREVGQVVMVF9BTExPV0VEX0hFQURFUlMiLCJleHBvcnRzIiwiZ2V0TW91bnRGb3JSZXF1ZXN0IiwicmVxIiwibW91bnRQYXRoTGVuZ3RoIiwib3JpZ2luYWxVcmwiLCJsZW5ndGgiLCJ1cmwiLCJtb3VudFBhdGgiLCJzbGljZSIsInByb3RvY29sIiwiZ2V0IiwiZ2V0QmxvY2tMaXN0IiwiaXBSYW5nZUxpc3QiLCJzdG9yZSIsImJsb2NrTGlzdCIsIkJsb2NrTGlzdCIsImZvckVhY2giLCJmdWxsSXAiLCJzZXQiLCJpcCIsIm1hc2siLCJzcGxpdCIsImFkZEFkZHJlc3MiLCJpc0lQdjQiLCJhZGRTdWJuZXQiLCJOdW1iZXIiLCJjaGVja0lwIiwiaW5jb21pbmdJcElzVjQiLCJyZXN1bHQiLCJjaGVjayIsImluY2x1ZGVzIiwiaGFuZGxlUGFyc2VIZWFkZXJzIiwicmVzIiwibmV4dCIsIm1vdW50IiwiY29udGV4dCIsIkpTT04iLCJwYXJzZSIsIk9iamVjdCIsInByb3RvdHlwZSIsInRvU3RyaW5nIiwiY2FsbCIsIm1hbGZvcm1lZENvbnRleHQiLCJpbmZvIiwiYXBwSWQiLCJzZXNzaW9uVG9rZW4iLCJtYXN0ZXJLZXkiLCJtYWludGVuYW5jZUtleSIsImluc3RhbGxhdGlvbklkIiwiY2xpZW50S2V5IiwiamF2YXNjcmlwdEtleSIsImRvdE5ldEtleSIsInJlc3RBUElLZXkiLCJiYXNpY0F1dGgiLCJodHRwQXV0aCIsImJhc2ljQXV0aEFwcElkIiwiQXBwQ2FjaGUiLCJib2R5IiwiX25vQm9keSIsImZpbGVWaWFKU09OIiwiQnVmZmVyIiwiaXNCdWZmZXIiLCJpbnZhbGlkUmVxdWVzdCIsIl9SZXZvY2FibGVTZXNzaW9uIiwiX0FwcGxpY2F0aW9uSWQiLCJfSmF2YVNjcmlwdEtleSIsIl9DbGllbnRWZXJzaW9uIiwiX0luc3RhbGxhdGlvbklkIiwiX1Nlc3Npb25Ub2tlbiIsIl9NYXN0ZXJLZXkiLCJfY29udGV4dCIsIlV0aWxzIiwiaXNPYmplY3QiLCJfQ29udGVudFR5cGUiLCJoZWFkZXJzIiwiYmFzZTY0IiwiZmlsZURhdGEiLCJmcm9tIiwiY2xpZW50SXAiLCJnZXRDbGllbnRJcCIsImNvbmZpZyIsIkNvbmZpZyIsInN0YXRlIiwic3RhdHVzIiwianNvbiIsImNvZGUiLCJQYXJzZSIsIkVycm9yIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwiZXJyb3IiLCJsb2FkS2V5cyIsImFwcCIsImF1dGgiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJyZXNvbHZlZCIsInJlc29sdmVLZXlBdXRoIiwia2V5VmFsdWUiLCJtYWludGVuYW5jZUtleVZhbHVlIiwiaGFuZGxlUmF0ZUxpbWl0Iiwia2V5cyIsIm9uZUtleUNvbmZpZ3VyZWQiLCJzb21lIiwia2V5IiwidW5kZWZpbmVkIiwib25lS2V5TWF0Y2hlcyIsIm1hdGNoZXNFeGFjdFJvdXRlIiwicGF0aCIsInVzZXJGcm9tSldUIiwiQXV0aCIsInVzZXIiLCJyYXRlTGltaXRzIiwiUHJvbWlzZSIsImFsbCIsIm1hcCIsImxpbWl0IiwicGF0aEV4cCIsInJlZ2V4cCIsInRlc3QiLCJoYW5kbGVyIiwiZXJyIiwiQ09OTkVDVElPTl9GQUlMRUQiLCJsb2dnZXJDb250cm9sbGVyIiwibWVzc2FnZSIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsIm1ldGhvZCIsInJlcXVlc3RBdXRoIiwiaW5kZXhPZiIsImdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4iLCJnZXRBdXRoRm9yU2Vzc2lvblRva2VuIiwiVU5LTk9XTl9FUlJPUiIsImF1dGhvcml6YXRpb24iLCJoZWFkZXIiLCJhdXRoUHJlZml4IiwibWF0Y2giLCJ0b0xvd2VyQ2FzZSIsImVuY29kZWRBdXRoIiwic3Vic3RyaW5nIiwiY3JlZGVudGlhbHMiLCJkZWNvZGVCYXNlNjQiLCJqc0tleVByZWZpeCIsIm1hdGNoS2V5Iiwic3RyIiwiYWxsb3dDcm9zc0RvbWFpbiIsImFsbG93SGVhZGVycyIsImpvaW4iLCJiYXNlT3JpZ2lucyIsImFsbG93T3JpZ2luIiwicmVxdWVzdE9yaWdpbiIsIm9yaWdpbiIsImFsbG93T3JpZ2lucyIsInNlbmRTdGF0dXMiLCJhbGxvd01ldGhvZE92ZXJyaWRlIiwiX21ldGhvZCIsIm9yaWdpbmFsTWV0aG9kIiwidG9VcHBlckNhc2UiLCJtYWludGVuYW5jZUtleUlwcyIsIm1haW50ZW5hbmNlS2V5SXBzU3RvcmUiLCJsb2ciLCJkZWZhdWx0TG9nZ2VyIiwibG9hZE1hc3RlcktleSIsIm1hc3RlcktleUlwcyIsIm1hc3RlcktleUlwc1N0b3JlIiwicmVhZE9ubHlNYXN0ZXJLZXkiLCJyZWFkT25seU1hc3RlcktleUlwcyIsInJlYWRPbmx5TWFzdGVyS2V5SXBzU3RvcmUiLCJpc1JlYWRPbmx5IiwiaGFuZGxlUGFyc2VBdXRoIiwiaGFuZGxlUGFyc2VIZWFsdGgiLCJvcHRpb25zIiwibm9ybWFsaXplUm91dGVBbGxvd0xpc3RQYXRoIiwibm9ybWFsaXplZCIsIlVSTCIsInBhdGhuYW1lIiwic3RhcnRzV2l0aCIsImVuZHNXaXRoIiwicXVlcnlJbmRleCIsImV4YWN0Um91dGVSZWdleHBDYWNoZSIsImNyZWF0ZSIsInJvdXRlIiwicGF0aFRvUmVnZXhwIiwiaXNSb3V0ZUFsbG93ZWQiLCJyb3V0ZUFsbG93TGlzdCIsInJlZ2V4ZXMiLCJfcm91dGVBbGxvd0xpc3RSZWdleCIsInJlZ2V4IiwiZW5mb3JjZVJvdXRlQWxsb3dMaXN0IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiaGFuZGxlUGFyc2VFcnJvcnMiLCJlbmFibGVFeHByZXNzRXJyb3JIYW5kbGVyIiwic2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsIiwibG9nTGV2ZWxzIiwic2lnbnVwVXNlcm5hbWVUYWtlbiIsImh0dHBTdGF0dXMiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiVVNFUk5BTUVfVEFLRU4iLCJsb2dnZXJNZXRob2QiLCJiaW5kIiwicHJvY2VzcyIsImVudiIsIlRFU1RJTkciLCJzdGFjayIsImVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MiLCJjcmVhdGVTYW5pdGl6ZWRIdHRwRXJyb3IiLCJlbmQiLCJwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcyIsInJlcXVlc3QiLCJyZXNvbHZlIiwiZ2V0UmF0ZUxpbWl0U3RvcmVQcmVmaXgiLCJyZXF1ZXN0TWV0aG9kcyIsIkFycmF5IiwiaXNBcnJheSIsIlN0cmluZyIsInNvcnQiLCJydWxlIiwic3RyaW5naWZ5IiwicmVxdWVzdFBhdGgiLCJ6b25lIiwicmVxdWVzdFRpbWVXaW5kb3ciLCJyZXF1ZXN0Q291bnQiLCJpbmNsdWRlTWFzdGVyS2V5IiwiaW5jbHVkZUludGVybmFsUmVxdWVzdHMiLCJoYXNoIiwiY3JlYXRlSGFzaCIsInVwZGF0ZSIsImRpZ2VzdCIsImFkZFJhdGVMaW1pdCIsImNsb3VkIiwiUmF0ZUxpbWl0T3B0aW9ucyIsInJlZGlzU3RvcmUiLCJjb25uZWN0aW9uUHJvbWlzZSIsInJlZGlzVXJsIiwiY2xpZW50IiwiY3JlYXRlQ2xpZW50Iiwib24iLCJpc09wZW4iLCJjb25uZWN0IiwiUmVkaXNTdG9yZSIsInByZWZpeCIsInNlbmRDb21tYW5kIiwiYXJncyIsInB1c2giLCJlcnJvclJlc3BvbnNlTWVzc2FnZSIsInJhdGVMaW1pdCIsIndpbmRvd01zIiwibWF4IiwicmVzcG9uc2UiLCJza2lwIiwibWV0aG9kc1RvQ2hlY2siLCJTZXQiLCJfYmF0Y2hPcmlnaW5hbE1ldGhvZCIsImFkZCIsIm0iLCJoYXMiLCJyZWdFeHAiLCJSZWdFeHAiLCJrZXlHZW5lcmF0b3IiLCJTZXJ2ZXIiLCJSYXRlTGltaXRab25lIiwiZ2xvYmFsIiwidG9rZW4iLCJzZXNzaW9uIiwiaWQiLCJwdXQiLCJwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kiLCJkYXRhYmFzZSIsImFkYXB0ZXIiLCJNb25nb1N0b3JhZ2VBZGFwdGVyIiwiUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsInJlcXVlc3RJZCIsInBhdGhzIiwidHRsIiwiaWRlbXBvdGVuY3lPcHRpb25zIiwicmVxUGF0aCIsInJlcGxhY2UiLCJjaGFyQXQiLCJleHBpcnlEYXRlIiwiRGF0ZSIsInNldFNlY29uZHMiLCJnZXRTZWNvbmRzIiwicmVzdCIsIm1hc3RlciIsInJlcUlkIiwiZXhwaXJlIiwiX2VuY29kZSIsImNhdGNoIiwiRFVQTElDQVRFX1ZBTFVFIiwiRFVQTElDQVRFX1JFUVVFU1QiLCJJTlZBTElEX0pTT04iLCJhbGxvd0RvdWJsZUZvcndhcmRTbGFzaCJdLCJzb3VyY2VzIjpbIi4uL3NyYy9taWRkbGV3YXJlcy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgQXBwQ2FjaGUgZnJvbSAnLi9jYWNoZSc7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi9VdGlscyc7XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgYXV0aCBmcm9tICcuL0F1dGgnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuL0NvbmZpZyc7XG5pbXBvcnQgZGVmYXVsdExvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgcmVzdCBmcm9tICcuL3Jlc3QnO1xuaW1wb3J0IE1vbmdvU3RvcmFnZUFkYXB0ZXIgZnJvbSAnLi9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IFBvc3RncmVzU3RvcmFnZUFkYXB0ZXIgZnJvbSAnLi9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHJhdGVMaW1pdCBmcm9tICdleHByZXNzLXJhdGUtbGltaXQnO1xuaW1wb3J0IHsgUmF0ZUxpbWl0T3B0aW9ucyB9IGZyb20gJy4vT3B0aW9ucy9EZWZpbml0aW9ucyc7XG5pbXBvcnQgeyBwYXRoVG9SZWdleHAgfSBmcm9tICdwYXRoLXRvLXJlZ2V4cCc7XG5pbXBvcnQgUmVkaXNTdG9yZSBmcm9tICdyYXRlLWxpbWl0LXJlZGlzJztcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCB9IGZyb20gJ3JlZGlzJztcbmltcG9ydCB7IEJsb2NrTGlzdCwgaXNJUHY0IH0gZnJvbSAnbmV0JztcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdjcnlwdG8nO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkSHR0cEVycm9yLCBjcmVhdGVTYW5pdGl6ZWRFcnJvciB9IGZyb20gJy4vRXJyb3InO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9BTExPV0VEX0hFQURFUlMgPVxuICAnWC1QYXJzZS1NYXN0ZXItS2V5LCBYLVBhcnNlLVJFU1QtQVBJLUtleSwgWC1QYXJzZS1KYXZhc2NyaXB0LUtleSwgWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCwgWC1QYXJzZS1DbGllbnQtVmVyc2lvbiwgWC1QYXJzZS1TZXNzaW9uLVRva2VuLCBYLVJlcXVlc3RlZC1XaXRoLCBYLVBhcnNlLVJldm9jYWJsZS1TZXNzaW9uLCBYLVBhcnNlLVJlcXVlc3QtSWQsIENvbnRlbnQtVHlwZSwgUHJhZ21hLCBDYWNoZS1Db250cm9sJztcblxuY29uc3QgZ2V0TW91bnRGb3JSZXF1ZXN0ID0gZnVuY3Rpb24gKHJlcSkge1xuICBjb25zdCBtb3VudFBhdGhMZW5ndGggPSByZXEub3JpZ2luYWxVcmwubGVuZ3RoIC0gcmVxLnVybC5sZW5ndGg7XG4gIGNvbnN0IG1vdW50UGF0aCA9IHJlcS5vcmlnaW5hbFVybC5zbGljZSgwLCBtb3VudFBhdGhMZW5ndGgpO1xuICByZXR1cm4gcmVxLnByb3RvY29sICsgJzovLycgKyByZXEuZ2V0KCdob3N0JykgKyBtb3VudFBhdGg7XG59O1xuXG5jb25zdCBnZXRCbG9ja0xpc3QgPSAoaXBSYW5nZUxpc3QsIHN0b3JlKSA9PiB7XG4gIGlmIChzdG9yZS5nZXQoJ2Jsb2NrTGlzdCcpKSB7IHJldHVybiBzdG9yZS5nZXQoJ2Jsb2NrTGlzdCcpOyB9XG4gIGNvbnN0IGJsb2NrTGlzdCA9IG5ldyBCbG9ja0xpc3QoKTtcbiAgaXBSYW5nZUxpc3QuZm9yRWFjaChmdWxsSXAgPT4ge1xuICAgIGlmIChmdWxsSXAgPT09ICc6Oi8wJyB8fCBmdWxsSXAgPT09ICc6OicgfHwgZnVsbElwID09PSAnOjowJykge1xuICAgICAgc3RvcmUuc2V0KCdhbGxvd0FsbElwdjYnLCB0cnVlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGZ1bGxJcCA9PT0gJzAuMC4wLjAvMCcgfHwgZnVsbElwID09PSAnMC4wLjAuMCcpIHtcbiAgICAgIHN0b3JlLnNldCgnYWxsb3dBbGxJcHY0JywgdHJ1ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IFtpcCwgbWFza10gPSBmdWxsSXAuc3BsaXQoJy8nKTtcbiAgICBpZiAoIW1hc2spIHtcbiAgICAgIGJsb2NrTGlzdC5hZGRBZGRyZXNzKGlwLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYmxvY2tMaXN0LmFkZFN1Ym5ldChpcCwgTnVtYmVyKG1hc2spLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9XG4gIH0pO1xuICBzdG9yZS5zZXQoJ2Jsb2NrTGlzdCcsIGJsb2NrTGlzdCk7XG4gIHJldHVybiBibG9ja0xpc3Q7XG59O1xuXG5leHBvcnQgY29uc3QgY2hlY2tJcCA9IChpcCwgaXBSYW5nZUxpc3QsIHN0b3JlKSA9PiB7XG4gIGNvbnN0IGluY29taW5nSXBJc1Y0ID0gaXNJUHY0KGlwKTtcbiAgY29uc3QgYmxvY2tMaXN0ID0gZ2V0QmxvY2tMaXN0KGlwUmFuZ2VMaXN0LCBzdG9yZSk7XG5cbiAgaWYgKHN0b3JlLmdldChpcCkpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY0JykgJiYgaW5jb21pbmdJcElzVjQpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY2JykgJiYgIWluY29taW5nSXBJc1Y0KSB7IHJldHVybiB0cnVlOyB9XG4gIGNvbnN0IHJlc3VsdCA9IGJsb2NrTGlzdC5jaGVjayhpcCwgaW5jb21pbmdJcElzVjQgPyAnaXB2NCcgOiAnaXB2NicpO1xuXG4gIC8vIElmIHRoZSBpcCBpcyBpbiB0aGUgbGlzdCwgd2Ugc3RvcmUgdGhlIHJlc3VsdCBpbiB0aGUgc3RvcmVcbiAgLy8gc28gd2UgaGF2ZSBhIG9wdGltaXplZCBwYXRoIGZvciB0aGUgbmV4dCByZXF1ZXN0XG4gIGlmIChpcFJhbmdlTGlzdC5pbmNsdWRlcyhpcCkgJiYgcmVzdWx0KSB7XG4gICAgc3RvcmUuc2V0KGlwLCByZXN1bHQpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59O1xuXG4vLyBDaGVja3MgdGhhdCB0aGUgcmVxdWVzdCBpcyBhdXRob3JpemVkIGZvciB0aGlzIGFwcCBhbmQgY2hlY2tzIHVzZXJcbi8vIGF1dGggdG9vLlxuLy8gVGhlIGJvZHlwYXJzZXIgc2hvdWxkIHJ1biBiZWZvcmUgdGhpcyBtaWRkbGV3YXJlLlxuLy8gQWRkcyBpbmZvIHRvIHRoZSByZXF1ZXN0OlxuLy8gcmVxLmNvbmZpZyAtIHRoZSBDb25maWcgZm9yIHRoaXMgYXBwXG4vLyByZXEuYXV0aCAtIHRoZSBBdXRoIGZvciB0aGlzIHJlcXVlc3RcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVQYXJzZUhlYWRlcnMocmVxLCByZXMsIG5leHQpIHtcbiAgdmFyIG1vdW50ID0gZ2V0TW91bnRGb3JSZXF1ZXN0KHJlcSk7XG5cbiAgbGV0IGNvbnRleHQgPSB7fTtcbiAgaWYgKHJlcS5nZXQoJ1gtUGFyc2UtQ2xvdWQtQ29udGV4dCcpICE9IG51bGwpIHtcbiAgICB0cnkge1xuICAgICAgY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmdldCgnWC1QYXJzZS1DbG91ZC1Db250ZXh0JykpO1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChjb250ZXh0KSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgICAgdGhyb3cgJ0NvbnRleHQgaXMgbm90IGFuIG9iamVjdCc7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbWFsZm9ybWVkQ29udGV4dChyZXEsIHJlcyk7XG4gICAgfVxuICB9XG4gIHZhciBpbmZvID0ge1xuICAgIGFwcElkOiByZXEuZ2V0KCdYLVBhcnNlLUFwcGxpY2F0aW9uLUlkJyksXG4gICAgc2Vzc2lvblRva2VuOiByZXEuZ2V0KCdYLVBhcnNlLVNlc3Npb24tVG9rZW4nKSxcbiAgICBtYXN0ZXJLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtTWFzdGVyLUtleScpLFxuICAgIG1haW50ZW5hbmNlS2V5OiByZXEuZ2V0KCdYLVBhcnNlLU1haW50ZW5hbmNlLUtleScpLFxuICAgIGluc3RhbGxhdGlvbklkOiByZXEuZ2V0KCdYLVBhcnNlLUluc3RhbGxhdGlvbi1JZCcpLFxuICAgIGNsaWVudEtleTogcmVxLmdldCgnWC1QYXJzZS1DbGllbnQtS2V5JyksXG4gICAgamF2YXNjcmlwdEtleTogcmVxLmdldCgnWC1QYXJzZS1KYXZhc2NyaXB0LUtleScpLFxuICAgIGRvdE5ldEtleTogcmVxLmdldCgnWC1QYXJzZS1XaW5kb3dzLUtleScpLFxuICAgIHJlc3RBUElLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtUkVTVC1BUEktS2V5JyksXG4gICAgY29udGV4dDogY29udGV4dCxcbiAgfTtcblxuICB2YXIgYmFzaWNBdXRoID0gaHR0cEF1dGgocmVxKTtcblxuICBpZiAoYmFzaWNBdXRoKSB7XG4gICAgdmFyIGJhc2ljQXV0aEFwcElkID0gYmFzaWNBdXRoLmFwcElkO1xuICAgIGlmIChBcHBDYWNoZS5nZXQoYmFzaWNBdXRoQXBwSWQpKSB7XG4gICAgICBpbmZvLmFwcElkID0gYmFzaWNBdXRoQXBwSWQ7XG4gICAgICBpbmZvLm1hc3RlcktleSA9IGJhc2ljQXV0aC5tYXN0ZXJLZXkgfHwgaW5mby5tYXN0ZXJLZXk7XG4gICAgICBpbmZvLmphdmFzY3JpcHRLZXkgPSBiYXNpY0F1dGguamF2YXNjcmlwdEtleSB8fCBpbmZvLmphdmFzY3JpcHRLZXk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlcS5ib2R5KSB7XG4gICAgLy8gVW5pdHkgU0RLIHNlbmRzIGEgX25vQm9keSBrZXkgd2hpY2ggbmVlZHMgdG8gYmUgcmVtb3ZlZC5cbiAgICAvLyBVbmNsZWFyIGF0IHRoaXMgcG9pbnQgaWYgYWN0aW9uIG5lZWRzIHRvIGJlIHRha2VuLlxuICAgIGRlbGV0ZSByZXEuYm9keS5fbm9Cb2R5O1xuICB9XG5cbiAgdmFyIGZpbGVWaWFKU09OID0gZmFsc2U7XG5cbiAgaWYgKCFpbmZvLmFwcElkIHx8ICFBcHBDYWNoZS5nZXQoaW5mby5hcHBJZCkpIHtcbiAgICAvLyBTZWUgaWYgd2UgY2FuIGZpbmQgdGhlIGFwcCBpZCBvbiB0aGUgYm9keS5cbiAgICBpZiAoQnVmZmVyLmlzQnVmZmVyKHJlcS5ib2R5KSkge1xuICAgICAgLy8gVGhlIG9ubHkgY2hhbmNlIHRvIGZpbmQgdGhlIGFwcCBpZCBpcyBpZiB0aGlzIGlzIGEgZmlsZVxuICAgICAgLy8gdXBsb2FkIHRoYXQgYWN0dWFsbHkgaXMgYSBKU09OIGJvZHkuIFNvIHRyeSB0byBwYXJzZSBpdC5cbiAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy82NTg5XG4gICAgICAvLyBJdCBpcyBhbHNvIHBvc3NpYmxlIHRoYXQgdGhlIGNsaWVudCBpcyB0cnlpbmcgdG8gdXBsb2FkIGEgZmlsZSBidXQgZm9yZ290XG4gICAgICAvLyB0byBwcm92aWRlIHgtcGFyc2UtYXBwLWlkIGluIGhlYWRlciBhbmQgcGFyc2UgYSBiaW5hcnkgZmlsZSB3aWxsIGZhaWxcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcS5ib2R5ID0gSlNPTi5wYXJzZShyZXEuYm9keSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICAgIH1cbiAgICAgIGZpbGVWaWFKU09OID0gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAocmVxLmJvZHkpIHtcbiAgICAgIGRlbGV0ZSByZXEuYm9keS5fUmV2b2NhYmxlU2Vzc2lvbjtcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICByZXEuYm9keSAmJlxuICAgICAgcmVxLmJvZHkuX0FwcGxpY2F0aW9uSWQgJiZcbiAgICAgIEFwcENhY2hlLmdldChyZXEuYm9keS5fQXBwbGljYXRpb25JZCkgJiZcbiAgICAgICghaW5mby5tYXN0ZXJLZXkgfHwgQXBwQ2FjaGUuZ2V0KHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkKS5tYXN0ZXJLZXkgPT09IGluZm8ubWFzdGVyS2V5KVxuICAgICkge1xuICAgICAgaW5mby5hcHBJZCA9IHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkO1xuICAgICAgaW5mby5qYXZhc2NyaXB0S2V5ID0gcmVxLmJvZHkuX0phdmFTY3JpcHRLZXkgfHwgJyc7XG4gICAgICBkZWxldGUgcmVxLmJvZHkuX0FwcGxpY2F0aW9uSWQ7XG4gICAgICBkZWxldGUgcmVxLmJvZHkuX0phdmFTY3JpcHRLZXk7XG4gICAgICAvLyBUT0RPOiB0ZXN0IHRoYXQgdGhlIFJFU1QgQVBJIGZvcm1hdHMgZ2VuZXJhdGVkIGJ5IHRoZSBvdGhlclxuICAgICAgLy8gU0RLcyBhcmUgaGFuZGxlZCBva1xuICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9DbGllbnRWZXJzaW9uO1xuICAgICAgaWYgKHJlcS5ib2R5Ll9JbnN0YWxsYXRpb25JZCkge1xuICAgICAgICBpZiAodHlwZW9mIHJlcS5ib2R5Ll9JbnN0YWxsYXRpb25JZCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICAgICAgICB9XG4gICAgICAgIGluZm8uaW5zdGFsbGF0aW9uSWQgPSByZXEuYm9keS5fSW5zdGFsbGF0aW9uSWQ7XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fSW5zdGFsbGF0aW9uSWQ7XG4gICAgICB9XG4gICAgICBpZiAocmVxLmJvZHkuX1Nlc3Npb25Ub2tlbikge1xuICAgICAgICBpZiAodHlwZW9mIHJlcS5ib2R5Ll9TZXNzaW9uVG9rZW4gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICAgICAgfVxuICAgICAgICBpbmZvLnNlc3Npb25Ub2tlbiA9IHJlcS5ib2R5Ll9TZXNzaW9uVG9rZW47XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fU2Vzc2lvblRva2VuO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5ib2R5Ll9NYXN0ZXJLZXkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByZXEuYm9keS5fTWFzdGVyS2V5ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gICAgICAgIH1cbiAgICAgICAgaW5mby5tYXN0ZXJLZXkgPSByZXEuYm9keS5fTWFzdGVyS2V5O1xuICAgICAgICBkZWxldGUgcmVxLmJvZHkuX01hc3RlcktleTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuYm9keS5fY29udGV4dCkge1xuICAgICAgICBpZiAoVXRpbHMuaXNPYmplY3QocmVxLmJvZHkuX2NvbnRleHQpKSB7XG4gICAgICAgICAgaW5mby5jb250ZXh0ID0gcmVxLmJvZHkuX2NvbnRleHQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGluZm8uY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmJvZHkuX2NvbnRleHQpO1xuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChpbmZvLmNvbnRleHQpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgICAgICAgICB0aHJvdyAnQ29udGV4dCBpcyBub3QgYW4gb2JqZWN0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBtYWxmb3JtZWRDb250ZXh0KHJlcSwgcmVzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9jb250ZXh0O1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5ib2R5Ll9Db250ZW50VHlwZSkge1xuICAgICAgICBpZiAodHlwZW9mIHJlcS5ib2R5Ll9Db250ZW50VHlwZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICAgICAgICB9XG4gICAgICAgIHJlcS5oZWFkZXJzWydjb250ZW50LXR5cGUnXSA9IHJlcS5ib2R5Ll9Db250ZW50VHlwZTtcbiAgICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9Db250ZW50VHlwZTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgICB9XG4gIH1cblxuICBpZiAoaW5mby5zZXNzaW9uVG9rZW4gJiYgdHlwZW9mIGluZm8uc2Vzc2lvblRva2VuICE9PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gIH1cblxuICBpZiAoZmlsZVZpYUpTT04gJiYgcmVxLmJvZHkpIHtcbiAgICBpZiAocmVxLmJvZHkuYmFzZTY0ICYmIHR5cGVvZiByZXEuYm9keS5iYXNlNjQgIT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICAgIH1cbiAgICByZXEuZmlsZURhdGEgPSByZXEuYm9keS5maWxlRGF0YTtcbiAgICAvLyBXZSBuZWVkIHRvIHJlcG9wdWxhdGUgcmVxLmJvZHkgd2l0aCBhIGJ1ZmZlclxuICAgIHZhciBiYXNlNjQgPSByZXEuYm9keS5iYXNlNjQ7XG4gICAgcmVxLmJvZHkgPSBCdWZmZXIuZnJvbShiYXNlNjQsICdiYXNlNjQnKTtcbiAgfVxuXG4gIGNvbnN0IGNsaWVudElwID0gZ2V0Q2xpZW50SXAocmVxKTtcbiAgY29uc3QgY29uZmlnID0gcmVxLmNvbmZpZyB8fCBDb25maWcuZ2V0KGluZm8uYXBwSWQsIG1vdW50KTtcbiAgaWYgKGNvbmZpZy5zdGF0ZSAmJiBjb25maWcuc3RhdGUgIT09ICdvaycpIHtcbiAgICByZXMuc3RhdHVzKDUwMCk7XG4gICAgcmVzLmpzb24oe1xuICAgICAgY29kZTogUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgZXJyb3I6IGBJbnZhbGlkIHNlcnZlciBzdGF0ZTogJHtjb25maWcuc3RhdGV9YCxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFyZXEuY29uZmlnKSB7XG4gICAgYXdhaXQgY29uZmlnLmxvYWRLZXlzKCk7XG4gIH1cblxuICBpbmZvLmFwcCA9IEFwcENhY2hlLmdldChpbmZvLmFwcElkKTtcbiAgcmVxLmNvbmZpZyA9IGNvbmZpZztcbiAgcmVxLmNvbmZpZy5oZWFkZXJzID0gcmVxLmhlYWRlcnMgfHwge307XG4gIHJlcS5jb25maWcuaXAgPSBjbGllbnRJcDtcbiAgcmVxLmluZm8gPSBpbmZvO1xuXG4gIC8vIFNraXAga2V5IGRldGVjdGlvbiBpZiBhbHJlYWR5IHJlc29sdmVkIGJ5IGhhbmRsZVBhcnNlQXV0aCAoaGVhZGVyLWJhc2VkKS5cbiAgLy8gT25seSByZXNvbHZlIGhlcmUgZm9yIGJvZHktYmFzZWQgX01hc3RlcktleSAoaW5mby5tYXN0ZXJLZXkgbWF5IGNvbWUgZnJvbSBib2R5KS5cbiAgaWYgKCFyZXEuYXV0aCB8fCAoIXJlcS5hdXRoLmlzTWFzdGVyICYmICFyZXEuYXV0aC5pc01haW50ZW5hbmNlKSkge1xuICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZUtleUF1dGgoe1xuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAga2V5VmFsdWU6IGluZm8ubWFzdGVyS2V5LFxuICAgICAgbWFpbnRlbmFuY2VLZXlWYWx1ZTogaW5mby5tYWludGVuYW5jZUtleSxcbiAgICAgIGluc3RhbGxhdGlvbklkOiBpbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgY2xpZW50SXAsXG4gICAgfSk7XG4gICAgaWYgKHJlc29sdmVkKSB7XG4gICAgICByZXEuYXV0aCA9IHJlc29sdmVkO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXEuYXV0aCAmJiAocmVxLmF1dGguaXNNYXN0ZXIgfHwgcmVxLmF1dGguaXNNYWludGVuYW5jZSkpIHtcbiAgICByZXR1cm4gaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIC8vIENsaWVudCBrZXlzIGFyZSBub3QgcmVxdWlyZWQgaW4gcGFyc2Utc2VydmVyLCBidXQgaWYgYW55IGhhdmUgYmVlbiBjb25maWd1cmVkIGluIHRoZSBzZXJ2ZXIsIHZhbGlkYXRlIHRoZW1cbiAgLy8gIHRvIHByZXNlcnZlIG9yaWdpbmFsIGJlaGF2aW9yLlxuICBjb25zdCBrZXlzID0gWydjbGllbnRLZXknLCAnamF2YXNjcmlwdEtleScsICdkb3ROZXRLZXknLCAncmVzdEFQSUtleSddO1xuICBjb25zdCBvbmVLZXlDb25maWd1cmVkID0ga2V5cy5zb21lKGZ1bmN0aW9uIChrZXkpIHtcbiAgICByZXR1cm4gcmVxLmNvbmZpZ1trZXldICE9PSB1bmRlZmluZWQ7XG4gIH0pO1xuICBjb25zdCBvbmVLZXlNYXRjaGVzID0ga2V5cy5zb21lKGZ1bmN0aW9uIChrZXkpIHtcbiAgICByZXR1cm4gcmVxLmNvbmZpZ1trZXldICE9PSB1bmRlZmluZWQgJiYgaW5mb1trZXldID09PSByZXEuY29uZmlnW2tleV07XG4gIH0pO1xuXG4gIGlmIChvbmVLZXlDb25maWd1cmVkICYmICFvbmVLZXlNYXRjaGVzKSB7XG4gICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgfVxuXG4gIGlmIChtYXRjaGVzRXhhY3RSb3V0ZShyZXEucGF0aCwgJy9sb2dpbicpKSB7XG4gICAgZGVsZXRlIGluZm8uc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgaWYgKHJlcS51c2VyRnJvbUpXVCkge1xuICAgIHJlcS5hdXRoID0gbmV3IGF1dGguQXV0aCh7XG4gICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGlzTWFzdGVyOiBmYWxzZSxcbiAgICAgIHVzZXI6IHJlcS51c2VyRnJvbUpXVCxcbiAgICB9KTtcbiAgICByZXR1cm4gaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIGlmICghaW5mby5zZXNzaW9uVG9rZW4pIHtcbiAgICByZXEuYXV0aCA9IG5ldyBhdXRoLkF1dGgoe1xuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBpc01hc3RlcjogZmFsc2UsXG4gICAgfSk7XG4gIH1cbiAgaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbn1cblxuY29uc3QgaGFuZGxlUmF0ZUxpbWl0ID0gYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gIGNvbnN0IHJhdGVMaW1pdHMgPSByZXEuY29uZmlnLnJhdGVMaW1pdHMgfHwgW107XG4gIHRyeSB7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICByYXRlTGltaXRzLm1hcChhc3luYyBsaW1pdCA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGhFeHAgPSBsaW1pdC5wYXRoLnJlZ2V4cCB8fCBsaW1pdC5wYXRoO1xuICAgICAgICBpZiAocGF0aEV4cC50ZXN0KHJlcS5wYXRoKSkge1xuICAgICAgICAgIGF3YWl0IGxpbWl0LmhhbmRsZXIocmVxLCByZXMsIGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PT0gUGFyc2UuRXJyb3IuQ09OTkVDVElPTl9GQUlMRUQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyLmVycm9yKFxuICAgICAgICAgICAgICAgICdBbiB1bmtub3duIGVycm9yIG9jY3VyZWQgd2hlbiBhdHRlbXB0aW5nIHRvIGFwcGx5IHRoZSByYXRlIGxpbWl0ZXI6ICcsXG4gICAgICAgICAgICAgICAgZXJyXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXMuc3RhdHVzKDQyOSk7XG4gICAgcmVzLmpzb24oeyBjb2RlOiBQYXJzZS5FcnJvci5DT05ORUNUSU9OX0ZBSUxFRCwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIG5leHQoKTtcbn07XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVQYXJzZVNlc3Npb24gPSBhc3luYyAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBpbmZvID0gcmVxLmluZm87XG4gICAgaWYgKHJlcS5hdXRoIHx8IChtYXRjaGVzRXhhY3RSb3V0ZShyZXEucGF0aCwgJy9zZXNzaW9ucy9tZScpICYmIHJlcS5tZXRob2QgPT09ICdHRVQnKSkge1xuICAgICAgbmV4dCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcmVxdWVzdEF1dGggPSBudWxsO1xuICAgIGlmIChcbiAgICAgIGluZm8uc2Vzc2lvblRva2VuICYmXG4gICAgICBtYXRjaGVzRXhhY3RSb3V0ZShyZXEucGF0aCwgJy91cGdyYWRlVG9SZXZvY2FibGVTZXNzaW9uJykgJiZcbiAgICAgIGluZm8uc2Vzc2lvblRva2VuLmluZGV4T2YoJ3I6JykgIT0gMFxuICAgICkge1xuICAgICAgcmVxdWVzdEF1dGggPSBhd2FpdCBhdXRoLmdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4oe1xuICAgICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICAgIGluc3RhbGxhdGlvbklkOiBpbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgICBzZXNzaW9uVG9rZW46IGluZm8uc2Vzc2lvblRva2VuLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlcXVlc3RBdXRoID0gYXdhaXQgYXV0aC5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKHtcbiAgICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgc2Vzc2lvblRva2VuOiBpbmZvLnNlc3Npb25Ub2tlbixcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXEuYXV0aCA9IHJlcXVlc3RBdXRoO1xuICAgIG5leHQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgICAgbmV4dChlcnJvcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIExvZyBmdWxsIGVycm9yIGRldGFpbHMgaW50ZXJuYWxseSwgYnV0IGRvbid0IGV4cG9zZSB0byBjbGllbnRcbiAgICByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIuZXJyb3IoJ2Vycm9yIGdldHRpbmcgYXV0aCBmb3Igc2Vzc2lvblRva2VuJywgZXJyb3IpO1xuICAgIG5leHQobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVOS05PV05fRVJST1IsICdVbmtub3duIGVycm9yJykpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBnZXRDbGllbnRJcChyZXEpIHtcbiAgcmV0dXJuIHJlcS5pcDtcbn1cblxuZnVuY3Rpb24gaHR0cEF1dGgocmVxKSB7XG4gIGlmICghKHJlcS5yZXEgfHwgcmVxKS5oZWFkZXJzLmF1dGhvcml6YXRpb24pIHsgcmV0dXJuOyB9XG5cbiAgdmFyIGhlYWRlciA9IChyZXEucmVxIHx8IHJlcSkuaGVhZGVycy5hdXRob3JpemF0aW9uO1xuICB2YXIgYXBwSWQsIG1hc3RlcktleSwgamF2YXNjcmlwdEtleTtcblxuICAvLyBwYXJzZSBoZWFkZXJcbiAgdmFyIGF1dGhQcmVmaXggPSAnYmFzaWMgJztcblxuICB2YXIgbWF0Y2ggPSBoZWFkZXIudG9Mb3dlckNhc2UoKS5pbmRleE9mKGF1dGhQcmVmaXgpO1xuXG4gIGlmIChtYXRjaCA9PSAwKSB7XG4gICAgdmFyIGVuY29kZWRBdXRoID0gaGVhZGVyLnN1YnN0cmluZyhhdXRoUHJlZml4Lmxlbmd0aCwgaGVhZGVyLmxlbmd0aCk7XG4gICAgdmFyIGNyZWRlbnRpYWxzID0gZGVjb2RlQmFzZTY0KGVuY29kZWRBdXRoKS5zcGxpdCgnOicpO1xuXG4gICAgaWYgKGNyZWRlbnRpYWxzLmxlbmd0aCA9PSAyKSB7XG4gICAgICBhcHBJZCA9IGNyZWRlbnRpYWxzWzBdO1xuICAgICAgdmFyIGtleSA9IGNyZWRlbnRpYWxzWzFdO1xuXG4gICAgICB2YXIganNLZXlQcmVmaXggPSAnamF2YXNjcmlwdC1rZXk9JztcblxuICAgICAgdmFyIG1hdGNoS2V5ID0ga2V5LmluZGV4T2YoanNLZXlQcmVmaXgpO1xuICAgICAgaWYgKG1hdGNoS2V5ID09IDApIHtcbiAgICAgICAgamF2YXNjcmlwdEtleSA9IGtleS5zdWJzdHJpbmcoanNLZXlQcmVmaXgubGVuZ3RoLCBrZXkubGVuZ3RoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1hc3RlcktleSA9IGtleTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBhcHBJZDogYXBwSWQsIG1hc3RlcktleTogbWFzdGVyS2V5LCBqYXZhc2NyaXB0S2V5OiBqYXZhc2NyaXB0S2V5IH07XG59XG5cbmZ1bmN0aW9uIGRlY29kZUJhc2U2NChzdHIpIHtcbiAgcmV0dXJuIEJ1ZmZlci5mcm9tKHN0ciwgJ2Jhc2U2NCcpLnRvU3RyaW5nKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhbGxvd0Nyb3NzRG9tYWluKGFwcElkKSB7XG4gIHJldHVybiAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGFwcElkLCBnZXRNb3VudEZvclJlcXVlc3QocmVxKSk7XG4gICAgbGV0IGFsbG93SGVhZGVycyA9IERFRkFVTFRfQUxMT1dFRF9IRUFERVJTO1xuICAgIGlmIChjb25maWcgJiYgY29uZmlnLmFsbG93SGVhZGVycykge1xuICAgICAgYWxsb3dIZWFkZXJzICs9IGAsICR7Y29uZmlnLmFsbG93SGVhZGVycy5qb2luKCcsICcpfWA7XG4gICAgfVxuXG4gICAgY29uc3QgYmFzZU9yaWdpbnMgPVxuICAgICAgdHlwZW9mIGNvbmZpZz8uYWxsb3dPcmlnaW4gPT09ICdzdHJpbmcnID8gW2NvbmZpZy5hbGxvd09yaWdpbl0gOiBjb25maWc/LmFsbG93T3JpZ2luID8/IFsnKiddO1xuICAgIGNvbnN0IHJlcXVlc3RPcmlnaW4gPSByZXEuaGVhZGVycy5vcmlnaW47XG4gICAgY29uc3QgYWxsb3dPcmlnaW5zID1cbiAgICAgIHJlcXVlc3RPcmlnaW4gJiYgYmFzZU9yaWdpbnMuaW5jbHVkZXMocmVxdWVzdE9yaWdpbikgPyByZXF1ZXN0T3JpZ2luIDogYmFzZU9yaWdpbnNbMF07XG4gICAgcmVzLmhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgYWxsb3dPcmlnaW5zKTtcbiAgICByZXMuaGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJywgJ0dFVCxQVVQsUE9TVCxERUxFVEUsT1BUSU9OUycpO1xuICAgIHJlcy5oZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnLCBhbGxvd0hlYWRlcnMpO1xuICAgIHJlcy5oZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUV4cG9zZS1IZWFkZXJzJywgJ1gtUGFyc2UtSm9iLVN0YXR1cy1JZCwgWC1QYXJzZS1QdXNoLVN0YXR1cy1JZCcpO1xuICAgIC8vIGludGVyY2VwdCBPUFRJT05TIG1ldGhvZFxuICAgIGlmICgnT1BUSU9OUycgPT0gcmVxLm1ldGhvZCkge1xuICAgICAgcmVzLnNlbmRTdGF0dXMoMjAwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV4dCgpO1xuICAgIH1cbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFsbG93TWV0aG9kT3ZlcnJpZGUocmVxLCByZXMsIG5leHQpIHtcbiAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiByZXEuYm9keT8uX21ldGhvZCkge1xuICAgIGlmICh0eXBlb2YgcmVxLmJvZHkuX21ldGhvZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJlcS5vcmlnaW5hbE1ldGhvZCA9IHJlcS5tZXRob2Q7XG4gICAgICByZXEubWV0aG9kID0gcmVxLmJvZHkuX21ldGhvZC50b1VwcGVyQ2FzZSgpO1xuICAgIH1cbiAgICBkZWxldGUgcmVxLmJvZHkuX21ldGhvZDtcbiAgfVxuICBuZXh0KCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVLZXlBdXRoKHsgY29uZmlnLCBrZXlWYWx1ZSwgbWFpbnRlbmFuY2VLZXlWYWx1ZSwgaW5zdGFsbGF0aW9uSWQsIGNsaWVudElwIH0pIHtcbiAgaWYgKG1haW50ZW5hbmNlS2V5VmFsdWUgJiYgbWFpbnRlbmFuY2VLZXlWYWx1ZSA9PT0gY29uZmlnLm1haW50ZW5hbmNlS2V5KSB7XG4gICAgaWYgKGNoZWNrSXAoY2xpZW50SXAsIGNvbmZpZy5tYWludGVuYW5jZUtleUlwcyB8fCBbXSwgY29uZmlnLm1haW50ZW5hbmNlS2V5SXBzU3RvcmUpKSB7XG4gICAgICByZXR1cm4gbmV3IGF1dGguQXV0aCh7IGNvbmZpZywgaW5zdGFsbGF0aW9uSWQsIGlzTWFpbnRlbmFuY2U6IHRydWUgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxvZyA9IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyIHx8IGRlZmF1bHRMb2dnZXI7XG4gICAgbG9nLmVycm9yKFxuICAgICAgYFJlcXVlc3QgdXNpbmcgbWFpbnRlbmFuY2Uga2V5IHJlamVjdGVkIGFzIHRoZSByZXF1ZXN0IElQIGFkZHJlc3MgJyR7Y2xpZW50SXB9JyBpcyBub3Qgc2V0IGluIFBhcnNlIFNlcnZlciBvcHRpb24gJ21haW50ZW5hbmNlS2V5SXBzJy5gXG4gICAgKTtcbiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcigpO1xuICAgIGVycm9yLnN0YXR1cyA9IDQwMztcbiAgICBlcnJvci5tZXNzYWdlID0gJ3VuYXV0aG9yaXplZCc7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgY29uc3QgbWFzdGVyS2V5ID0gYXdhaXQgY29uZmlnLmxvYWRNYXN0ZXJLZXkoKTtcbiAgaWYgKGtleVZhbHVlID09PSBtYXN0ZXJLZXkpIHtcbiAgICBpZiAoY2hlY2tJcChjbGllbnRJcCwgY29uZmlnLm1hc3RlcktleUlwcyB8fCBbXSwgY29uZmlnLm1hc3RlcktleUlwc1N0b3JlKSkge1xuICAgICAgcmV0dXJuIG5ldyBhdXRoLkF1dGgoeyBjb25maWcsIGluc3RhbGxhdGlvbklkLCBpc01hc3RlcjogdHJ1ZSB9KTtcbiAgICB9XG4gICAgY29uc3QgbG9nID0gY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIgfHwgZGVmYXVsdExvZ2dlcjtcbiAgICBsb2cuZXJyb3IoXG4gICAgICBgUmVxdWVzdCB1c2luZyBtYXN0ZXIga2V5IHJlamVjdGVkIGFzIHRoZSByZXF1ZXN0IElQIGFkZHJlc3MgJyR7Y2xpZW50SXB9JyBpcyBub3Qgc2V0IGluIFBhcnNlIFNlcnZlciBvcHRpb24gJ21hc3RlcktleUlwcycuYFxuICAgICk7XG4gICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoKTtcbiAgICBlcnJvci5zdGF0dXMgPSA0MDM7XG4gICAgZXJyb3IubWVzc2FnZSA9ICd1bmF1dGhvcml6ZWQnO1xuICAgIHRocm93IGVycm9yO1xuICB9XG4gIGlmIChcbiAgICBrZXlWYWx1ZSAmJlxuICAgIHR5cGVvZiBjb25maWcucmVhZE9ubHlNYXN0ZXJLZXkgIT09ICd1bmRlZmluZWQnICYmXG4gICAgY29uZmlnLnJlYWRPbmx5TWFzdGVyS2V5ICYmXG4gICAga2V5VmFsdWUgPT09IGNvbmZpZy5yZWFkT25seU1hc3RlcktleVxuICApIHtcbiAgICBpZiAoY2hlY2tJcChjbGllbnRJcCwgY29uZmlnLnJlYWRPbmx5TWFzdGVyS2V5SXBzIHx8IFtdLCBjb25maWcucmVhZE9ubHlNYXN0ZXJLZXlJcHNTdG9yZSkpIHtcbiAgICAgIHJldHVybiBuZXcgYXV0aC5BdXRoKHsgY29uZmlnLCBpbnN0YWxsYXRpb25JZCwgaXNNYXN0ZXI6IHRydWUsIGlzUmVhZE9ubHk6IHRydWUgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxvZyA9IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyIHx8IGRlZmF1bHRMb2dnZXI7XG4gICAgbG9nLmVycm9yKFxuICAgICAgYFJlcXVlc3QgdXNpbmcgcmVhZC1vbmx5IG1hc3RlciBrZXkgcmVqZWN0ZWQgYXMgdGhlIHJlcXVlc3QgSVAgYWRkcmVzcyAnJHtjbGllbnRJcH0nIGlzIG5vdCBzZXQgaW4gUGFyc2UgU2VydmVyIG9wdGlvbiAncmVhZE9ubHlNYXN0ZXJLZXlJcHMnLmBcbiAgICApO1xuICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKCk7XG4gICAgZXJyb3Iuc3RhdHVzID0gNDAzO1xuICAgIGVycm9yLm1lc3NhZ2UgPSAndW5hdXRob3JpemVkJztcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlQXV0aChhcHBJZCkge1xuICByZXR1cm4gYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgY29uc3QgbW91bnQgPSBnZXRNb3VudEZvclJlcXVlc3QocmVxKTtcbiAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGFwcElkLCBtb3VudCk7XG4gICAgaWYgKCFjb25maWcpIHtcbiAgICAgIHJldHVybiBuZXh0KCk7XG4gICAgfVxuICAgIHJlcS5jb25maWcgPSBjb25maWc7XG4gICAgY29uc3QgY2xpZW50SXAgPSBnZXRDbGllbnRJcChyZXEpO1xuICAgIHJlcS5jb25maWcuaXAgPSBjbGllbnRJcDtcbiAgICBhd2FpdCBjb25maWcubG9hZEtleXMoKTtcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVLZXlBdXRoKHtcbiAgICAgIGNvbmZpZyxcbiAgICAgIGtleVZhbHVlOiByZXEuZ2V0KCdYLVBhcnNlLU1hc3Rlci1LZXknKSB8fCBudWxsLFxuICAgICAgbWFpbnRlbmFuY2VLZXlWYWx1ZTogcmVxLmdldCgnWC1QYXJzZS1NYWludGVuYW5jZS1LZXknKSB8fCBudWxsLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5nZXQoJ1gtUGFyc2UtSW5zdGFsbGF0aW9uLUlkJykgfHwgJ2Nsb3VkJyxcbiAgICAgIGNsaWVudElwLFxuICAgIH0pO1xuICAgIGlmIChyZXNvbHZlZCkge1xuICAgICAgcmVxLmF1dGggPSByZXNvbHZlZDtcbiAgICB9XG4gICAgcmV0dXJuIG5leHQoKTtcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlSGVhbHRoKG9wdGlvbnMpIHtcbiAgcmV0dXJuIChyZXEsIHJlcykgPT4ge1xuICAgIHJlcy5zdGF0dXMob3B0aW9ucy5zdGF0ZSA9PT0gJ29rJyA/IDIwMCA6IDUwMyk7XG4gICAgaWYgKG9wdGlvbnMuc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHJlcy5zZXQoJ1JldHJ5LUFmdGVyJywgMSk7XG4gICAgfVxuICAgIHJlcy5qc29uKHtcbiAgICAgIHN0YXR1czogb3B0aW9ucy5zdGF0ZSxcbiAgICB9KTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVBbGxvd0xpc3RQYXRoKHBhdGgsIG1vdW50KSB7XG4gIGxldCBub3JtYWxpemVkID0gcGF0aDtcbiAgaWYgKG1vdW50KSB7XG4gICAgY29uc3QgbW91bnRQYXRoID0gbmV3IFVSTChtb3VudCkucGF0aG5hbWU7XG4gICAgaWYgKG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChtb3VudFBhdGgpKSB7XG4gICAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zdWJzdHJpbmcobW91bnRQYXRoLmxlbmd0aCk7XG4gICAgfVxuICB9XG4gIGlmIChub3JtYWxpemVkLnN0YXJ0c1dpdGgoJy8nKSkge1xuICAgIG5vcm1hbGl6ZWQgPSBub3JtYWxpemVkLnN1YnN0cmluZygxKTtcbiAgfVxuICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aCgnLycpKSB7XG4gICAgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZWQuc3Vic3RyaW5nKDAsIG5vcm1hbGl6ZWQubGVuZ3RoIC0gMSk7XG4gIH1cbiAgY29uc3QgcXVlcnlJbmRleCA9IG5vcm1hbGl6ZWQuaW5kZXhPZignPycpO1xuICBpZiAocXVlcnlJbmRleCAhPT0gLTEpIHtcbiAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zdWJzdHJpbmcoMCwgcXVlcnlJbmRleCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbi8vIENhY2hlIG9mIGNvbXBpbGVkIGV4YWN0LXJvdXRlIG1hdGNoZXJzLCBrZXllZCBieSByb3V0ZS4gTWlycm9ycyBob3cgYGFkZFJhdGVMaW1pdGAgY29tcGlsZXMgYVxuLy8gcm91dGUncyBgcGF0aFRvUmVnZXhwYCBvbmNlIGFuZCByZXVzZXMgaXQsIGF2b2lkaW5nIHJlY29tcGlsYXRpb24gb24gZXZlcnkgcmVxdWVzdC5cbmNvbnN0IGV4YWN0Um91dGVSZWdleHBDYWNoZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIGBwYXRoYCByZXNvbHZlcyB0byB0aGUgZ2l2ZW4gZXhhY3Qgc3RhdGljIGByb3V0ZWAsIHVzaW5nIHRoZSBzYW1lXG4gKiBgcGF0aC10by1yZWdleHBgIG1hdGNoaW5nIHRoYXQgdGhlIEV4cHJlc3Mgcm91dGVyIGFuZCB0aGUgcmF0ZSBsaW1pdGVyIHVzZSAoY2FzZS1pbnNlbnNpdGl2ZVxuICogYW5kIHRyYWlsaW5nLXNsYXNoLXRvbGVyYW50IGJ5IGRlZmF1bHQpLiBQYXRoLWxpdGVyYWwgY2hlY2tzIOKAlCBzdWNoIGFzIGRldGVjdGluZyBgL2xvZ2luYCB0b1xuICogZHJvcCB0aGUgaW5ib3VuZCBzZXNzaW9uIHRva2VuIOKAlCBtdXN0IHVzZSB0aGlzIHNvIHRoZXkgc3RheSBjb25zaXN0ZW50IHdpdGggaG93IHRoZSByb3V0ZXJcbiAqIGFjdHVhbGx5IGRpc3BhdGNoZXMgdGhlIHJlcXVlc3QsIGluc3RlYWQgb2YgcmUtZGVyaXZpbmcgdGhlIG1hdGNoaW5nIHJ1bGVzIGJ5IGhhbmQuXG4gKiBAcGFyYW0ge3N0cmluZ30gcGF0aCBUaGUgcmVxdWVzdCBwYXRoIChlLmcuIGByZXEucGF0aGAgb3IgYSBiYXRjaCBzdWItcmVxdWVzdCByb3V0YWJsZSBwYXRoKS5cbiAqIEBwYXJhbSB7c3RyaW5nfSByb3V0ZSBUaGUgZXhhY3Qgc3RhdGljIHJvdXRlIHRvIG1hdGNoIChlLmcuIGAvbG9naW5gKS5cbiAqIEByZXR1cm5zIHtib29sZWFufVxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0V4YWN0Um91dGUocGF0aCwgcm91dGUpIHtcbiAgaWYgKHR5cGVvZiBwYXRoICE9PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoIWV4YWN0Um91dGVSZWdleHBDYWNoZVtyb3V0ZV0pIHtcbiAgICBleGFjdFJvdXRlUmVnZXhwQ2FjaGVbcm91dGVdID0gcGF0aFRvUmVnZXhwKHJvdXRlKS5yZWdleHA7XG4gIH1cbiAgcmV0dXJuIGV4YWN0Um91dGVSZWdleHBDYWNoZVtyb3V0ZV0udGVzdChwYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUm91dGVBbGxvd2VkKHBhdGgsIGNvbmZpZywgYXV0aCkge1xuICBpZiAoIWNvbmZpZyB8fCBjb25maWcucm91dGVBbGxvd0xpc3QgPT09IHVuZGVmaW5lZCB8fCBjb25maWcucm91dGVBbGxvd0xpc3QgPT09IG51bGwpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aCAmJiAoYXV0aC5pc01hc3RlciB8fCBhdXRoLmlzTWFpbnRlbmFuY2UpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJvdXRlQWxsb3dMaXN0UGF0aChwYXRoLCBjb25maWcubW91bnQpO1xuICBjb25zdCByZWdleGVzID0gY29uZmlnLl9yb3V0ZUFsbG93TGlzdFJlZ2V4IHx8IFtdO1xuICBmb3IgKGNvbnN0IHJlZ2V4IG9mIHJlZ2V4ZXMpIHtcbiAgICBpZiAocmVnZXgudGVzdChub3JtYWxpemVkKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuZm9yY2VSb3V0ZUFsbG93TGlzdChyZXEsIHJlcywgbmV4dCkge1xuICBpZiAoaXNSb3V0ZUFsbG93ZWQocmVxLm9yaWdpbmFsVXJsLCByZXEuY29uZmlnLCByZXEuYXV0aCkpIHtcbiAgICByZXR1cm4gbmV4dCgpO1xuICB9XG4gIGNvbnN0IHBhdGggPSBub3JtYWxpemVSb3V0ZUFsbG93TGlzdFBhdGgocmVxLm9yaWdpbmFsVXJsLCByZXEuY29uZmlnPy5tb3VudCk7XG4gIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgYFJvdXRlIG5vdCBhbGxvd2VkIGJ5IHJvdXRlQWxsb3dMaXN0OiAke3JlcS5tZXRob2R9ICR7cGF0aH1gLFxuICAgIHJlcS5jb25maWdcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlRXJyb3JzKGVyciwgcmVxLCByZXMsIG5leHQpIHtcbiAgY29uc3QgbG9nID0gKHJlcS5jb25maWcgJiYgcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyKSB8fCBkZWZhdWx0TG9nZ2VyO1xuICBpZiAoZXJyIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICBpZiAocmVxLmNvbmZpZyAmJiByZXEuY29uZmlnLmVuYWJsZUV4cHJlc3NFcnJvckhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBuZXh0KGVycik7XG4gICAgfVxuICAgIGNvbnN0IHNpZ251cFVzZXJuYW1lVGFrZW5MZXZlbCA9XG4gICAgICByZXEuY29uZmlnPy5sb2dMZXZlbHM/LnNpZ251cFVzZXJuYW1lVGFrZW4gfHwgJ2luZm8nO1xuICAgIGxldCBodHRwU3RhdHVzO1xuICAgIC8vIFRPRE86IGZpbGwgb3V0IHRoaXMgbWFwcGluZ1xuICAgIHN3aXRjaCAoZXJyLmNvZGUpIHtcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SOlxuICAgICAgICBodHRwU3RhdHVzID0gNTAwO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORDpcbiAgICAgICAgaHR0cFN0YXR1cyA9IDQwNDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBodHRwU3RhdHVzID0gNDAwO1xuICAgIH1cbiAgICByZXMuc3RhdHVzKGh0dHBTdGF0dXMpO1xuICAgIHJlcy5qc29uKHsgY29kZTogZXJyLmNvZGUsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICBpZiAoZXJyLmNvZGUgPT09IFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOKSB7XG4gICAgICBpZiAoc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsICE9PSAnc2lsZW50Jykge1xuICAgICAgICBjb25zdCBsb2dnZXJNZXRob2QgPVxuICAgICAgICAgIHR5cGVvZiBsb2dbc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsXSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgPyBsb2dbc2lnbnVwVXNlcm5hbWVUYWtlbkxldmVsXS5iaW5kKGxvZylcbiAgICAgICAgICAgIDogbG9nLmVycm9yLmJpbmQobG9nKTtcbiAgICAgICAgbG9nZ2VyTWV0aG9kKCdQYXJzZSBlcnJvcjogJywgZXJyKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLmVycm9yKCdQYXJzZSBlcnJvcjogJywgZXJyKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoZXJyLnN0YXR1cyAmJiBlcnIubWVzc2FnZSkge1xuICAgIHJlcy5zdGF0dXMoZXJyLnN0YXR1cyk7XG4gICAgcmVzLmpzb24oeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgaWYgKCEocHJvY2VzcyAmJiBwcm9jZXNzLmVudi5URVNUSU5HKSkge1xuICAgICAgbmV4dChlcnIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBsb2cuZXJyb3IoJ1VuY2F1Z2h0IGludGVybmFsIHNlcnZlciBlcnJvci4nLCBlcnIsIGVyci5zdGFjayk7XG4gICAgcmVzLnN0YXR1cyg1MDApO1xuICAgIHJlcy5qc29uKHtcbiAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgIG1lc3NhZ2U6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3IuJyxcbiAgICB9KTtcbiAgICBpZiAoIShwcm9jZXNzICYmIHByb2Nlc3MuZW52LlRFU1RJTkcpKSB7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbmZvcmNlTWFzdGVyS2V5QWNjZXNzKHJlcSwgcmVzLCBuZXh0KSB7XG4gIGlmICghcmVxLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBjb25zdCBlcnJvciA9IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICd1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWQnLCByZXEuY29uZmlnKTtcbiAgICByZXMuc3RhdHVzKGVycm9yLnN0YXR1cyk7XG4gICAgcmVzLmVuZChge1wiZXJyb3JcIjpcIiR7ZXJyb3IubWVzc2FnZX1cIn1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbmV4dCgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MocmVxdWVzdCkge1xuICBpZiAoIXJlcXVlc3QuYXV0aC5pc01hc3Rlcikge1xuICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEh0dHBFcnJvcig0MDMsICd1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWQnLCByZXF1ZXN0LmNvbmZpZyk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufVxuXG5leHBvcnQgY29uc3QgZ2V0UmF0ZUxpbWl0U3RvcmVQcmVmaXggPSByb3V0ZSA9PiB7XG4gIGNvbnN0IHJlcXVlc3RNZXRob2RzID0gQXJyYXkuaXNBcnJheShyb3V0ZS5yZXF1ZXN0TWV0aG9kcylcbiAgICA/IHJvdXRlLnJlcXVlc3RNZXRob2RzLm1hcChTdHJpbmcpLnNvcnQoKVxuICAgIDogcm91dGUucmVxdWVzdE1ldGhvZHNcbiAgICAgID8gW1N0cmluZyhyb3V0ZS5yZXF1ZXN0TWV0aG9kcyldXG4gICAgICA6IFtdO1xuICBjb25zdCBydWxlID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RQYXRoOiByb3V0ZS5yZXF1ZXN0UGF0aCxcbiAgICByZXF1ZXN0TWV0aG9kcyxcbiAgICB6b25lOiByb3V0ZS56b25lIHx8ICdpcCcsXG4gICAgcmVxdWVzdFRpbWVXaW5kb3c6IHJvdXRlLnJlcXVlc3RUaW1lV2luZG93LFxuICAgIHJlcXVlc3RDb3VudDogcm91dGUucmVxdWVzdENvdW50LFxuICAgIGluY2x1ZGVNYXN0ZXJLZXk6ICEhcm91dGUuaW5jbHVkZU1hc3RlcktleSxcbiAgICBpbmNsdWRlSW50ZXJuYWxSZXF1ZXN0czogISFyb3V0ZS5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyxcbiAgfSk7XG4gIGNvbnN0IGhhc2ggPSBjcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUocnVsZSkuZGlnZXN0KCdoZXgnKS5zbGljZSgwLCAxNik7XG4gIHJldHVybiBgcGFyc2Utc2VydmVyOnJhdGUtbGltaXQ6JHtoYXNofTpgO1xufTtcblxuZXhwb3J0IGNvbnN0IGFkZFJhdGVMaW1pdCA9IChyb3V0ZSwgY29uZmlnLCBjbG91ZCkgPT4ge1xuICBpZiAodHlwZW9mIGNvbmZpZyA9PT0gJ3N0cmluZycpIHtcbiAgICBjb25maWcgPSBDb25maWcuZ2V0KGNvbmZpZyk7XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgaW4gcm91dGUpIHtcbiAgICBpZiAoIVJhdGVMaW1pdE9wdGlvbnNba2V5XSkge1xuICAgICAgdGhyb3cgYEludmFsaWQgcmF0ZSBsaW1pdCBvcHRpb24gXCIke2tleX1cImA7XG4gICAgfVxuICB9XG4gIGlmICghY29uZmlnLnJhdGVMaW1pdHMpIHtcbiAgICBjb25maWcucmF0ZUxpbWl0cyA9IFtdO1xuICB9XG4gIGNvbnN0IHJlZGlzU3RvcmUgPSB7XG4gICAgY29ubmVjdGlvblByb21pc2U6IFByb21pc2UucmVzb2x2ZSgpLFxuICAgIHN0b3JlOiBudWxsLFxuICB9O1xuICBpZiAocm91dGUucmVkaXNVcmwpIHtcbiAgICBjb25zdCBsb2cgPSBjb25maWc/LmxvZ2dlckNvbnRyb2xsZXIgfHwgZGVmYXVsdExvZ2dlcjtcbiAgICBjb25zdCBjbGllbnQgPSBjcmVhdGVDbGllbnQoe1xuICAgICAgdXJsOiByb3V0ZS5yZWRpc1VybCxcbiAgICB9KTtcbiAgICBjbGllbnQub24oJ2Vycm9yJywgZXJyID0+IHsgbG9nLmVycm9yKCdNaWRkbGV3YXJlcyBhZGRSYXRlTGltaXQgUmVkaXMgY2xpZW50IGVycm9yJywgeyBlcnJvcjogZXJyIH0pIH0pO1xuICAgIGNsaWVudC5vbignY29ubmVjdCcsICgpID0+IHsgfSk7XG4gICAgY2xpZW50Lm9uKCdyZWNvbm5lY3RpbmcnLCAoKSA9PiB7IH0pO1xuICAgIGNsaWVudC5vbigncmVhZHknLCAoKSA9PiB7IH0pO1xuICAgIHJlZGlzU3RvcmUuY29ubmVjdGlvblByb21pc2UgPSBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoY2xpZW50LmlzT3Blbikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBjbGllbnQuY29ubmVjdCgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2cuZXJyb3IoYENvdWxkIG5vdCBjb25uZWN0IHRvIHJlZGlzVVJMIGluIHJhdGUgbGltaXQ6ICR7ZX1gKTtcbiAgICAgIH1cbiAgICB9O1xuICAgIHJlZGlzU3RvcmUuY29ubmVjdGlvblByb21pc2UoKTtcbiAgICByZWRpc1N0b3JlLnN0b3JlID0gbmV3IFJlZGlzU3RvcmUoe1xuICAgICAgcHJlZml4OiBnZXRSYXRlTGltaXRTdG9yZVByZWZpeChyb3V0ZSksXG4gICAgICBzZW5kQ29tbWFuZDogYXN5bmMgKC4uLmFyZ3MpID0+IHtcbiAgICAgICAgYXdhaXQgcmVkaXNTdG9yZS5jb25uZWN0aW9uUHJvbWlzZSgpO1xuICAgICAgICByZXR1cm4gY2xpZW50LnNlbmRDb21tYW5kKGFyZ3MpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuICBjb25maWcucmF0ZUxpbWl0cy5wdXNoKHtcbiAgICBwYXRoOiBwYXRoVG9SZWdleHAocm91dGUucmVxdWVzdFBhdGgpLFxuICAgIHJlcXVlc3RDb3VudDogcm91dGUucmVxdWVzdENvdW50LFxuICAgIHJlcXVlc3RNZXRob2RzOiByb3V0ZS5yZXF1ZXN0TWV0aG9kcyxcbiAgICBpbmNsdWRlTWFzdGVyS2V5OiByb3V0ZS5pbmNsdWRlTWFzdGVyS2V5LFxuICAgIGluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzOiByb3V0ZS5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyxcbiAgICBlcnJvclJlc3BvbnNlTWVzc2FnZTogcm91dGUuZXJyb3JSZXNwb25zZU1lc3NhZ2UgfHwgUmF0ZUxpbWl0T3B0aW9ucy5lcnJvclJlc3BvbnNlTWVzc2FnZS5kZWZhdWx0LFxuICAgIGhhbmRsZXI6IHJhdGVMaW1pdCh7XG4gICAgICB3aW5kb3dNczogcm91dGUucmVxdWVzdFRpbWVXaW5kb3csXG4gICAgICBtYXg6IHJvdXRlLnJlcXVlc3RDb3VudCxcbiAgICAgIG1lc3NhZ2U6IHJvdXRlLmVycm9yUmVzcG9uc2VNZXNzYWdlIHx8IFJhdGVMaW1pdE9wdGlvbnMuZXJyb3JSZXNwb25zZU1lc3NhZ2UuZGVmYXVsdCxcbiAgICAgIGhhbmRsZXI6IChyZXF1ZXN0LCByZXNwb25zZSwgbmV4dCwgb3B0aW9ucykgPT4ge1xuICAgICAgICB0aHJvdyB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuQ09OTkVDVElPTl9GQUlMRUQsXG4gICAgICAgICAgbWVzc2FnZTogb3B0aW9ucy5tZXNzYWdlLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIHNraXA6IHJlcXVlc3QgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5pcCA9PT0gJzEyNy4wLjAuMScgJiYgIXJvdXRlLmluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvdXRlLmluY2x1ZGVNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvdXRlLnJlcXVlc3RNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgbWV0aG9kc1RvQ2hlY2sgPSBuZXcgU2V0KFtyZXF1ZXN0Lm1ldGhvZF0pO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Ll9iYXRjaE9yaWdpbmFsTWV0aG9kKSB7XG4gICAgICAgICAgICBtZXRob2RzVG9DaGVjay5hZGQocmVxdWVzdC5fYmF0Y2hPcmlnaW5hbE1ldGhvZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJvdXRlLnJlcXVlc3RNZXRob2RzKSkge1xuICAgICAgICAgICAgaWYgKCFyb3V0ZS5yZXF1ZXN0TWV0aG9kcy5zb21lKG0gPT4gbWV0aG9kc1RvQ2hlY2suaGFzKG0pKSkge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcmVnRXhwID0gbmV3IFJlZ0V4cChyb3V0ZS5yZXF1ZXN0TWV0aG9kcyk7XG4gICAgICAgICAgICBpZiAoIVsuLi5tZXRob2RzVG9DaGVja10uc29tZShtID0+IHJlZ0V4cC50ZXN0KG0pKSkge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlcXVlc3QuYXV0aD8uaXNNYXN0ZXI7XG4gICAgICB9LFxuICAgICAga2V5R2VuZXJhdG9yOiBhc3luYyByZXF1ZXN0ID0+IHtcbiAgICAgICAgaWYgKHJvdXRlLnpvbmUgPT09IFBhcnNlLlNlcnZlci5SYXRlTGltaXRab25lLmdsb2JhbCkge1xuICAgICAgICAgIHJldHVybiByZXF1ZXN0LmNvbmZpZy5hcHBJZDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0b2tlbiA9IHJlcXVlc3QuaW5mby5zZXNzaW9uVG9rZW47XG4gICAgICAgIGlmIChyb3V0ZS56b25lID09PSBQYXJzZS5TZXJ2ZXIuUmF0ZUxpbWl0Wm9uZS5zZXNzaW9uICYmIHRva2VuKSB7XG4gICAgICAgICAgcmV0dXJuIHRva2VuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyb3V0ZS56b25lID09PSBQYXJzZS5TZXJ2ZXIuUmF0ZUxpbWl0Wm9uZS51c2VyICYmIHRva2VuKSB7XG4gICAgICAgICAgaWYgKCFyZXF1ZXN0LmF1dGgpIHtcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gaGFuZGxlUGFyc2VTZXNzaW9uKHJlcXVlc3QsIG51bGwsIHJlc29sdmUpKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3QuYXV0aD8udXNlcj8uaWQgJiYgcm91dGUuem9uZSA9PT0gJ3VzZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVxdWVzdC5hdXRoLnVzZXIuaWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXF1ZXN0LmNvbmZpZy5pcDtcbiAgICAgIH0sXG4gICAgICBzdG9yZTogcmVkaXNTdG9yZS5zdG9yZSxcbiAgICB9KSxcbiAgICBjbG91ZCxcbiAgfSk7XG4gIENvbmZpZy5wdXQoY29uZmlnKTtcbn07XG5cbi8qKlxuICogRGVkdXBsaWNhdGVzIGEgcmVxdWVzdCB0byBlbnN1cmUgaWRlbXBvdGVuY3kuIER1cGxpY2F0ZXMgYXJlIGRldGVybWluZWQgYnkgdGhlIHJlcXVlc3QgSURcbiAqIGluIHRoZSByZXF1ZXN0IGhlYWRlci4gSWYgYSByZXF1ZXN0IGhhcyBubyByZXF1ZXN0IElELCBpdCBpcyBleGVjdXRlZCBhbnl3YXkuXG4gKiBAcGFyYW0geyp9IHJlcSBUaGUgcmVxdWVzdCB0byBldmFsdWF0ZS5cbiAqIEByZXR1cm5zIFByb21pc2U8e30+XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kocmVxKSB7XG4gIC8vIEVuYWJsZSBmZWF0dXJlIG9ubHkgZm9yIE1vbmdvREJcbiAgaWYgKFxuICAgICEoXG4gICAgICByZXEuY29uZmlnLmRhdGFiYXNlLmFkYXB0ZXIgaW5zdGFuY2VvZiBNb25nb1N0b3JhZ2VBZGFwdGVyIHx8XG4gICAgICByZXEuY29uZmlnLmRhdGFiYXNlLmFkYXB0ZXIgaW5zdGFuY2VvZiBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyXG4gICAgKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gR2V0IHBhcmFtZXRlcnNcbiAgY29uc3QgY29uZmlnID0gcmVxLmNvbmZpZztcbiAgY29uc3QgcmVxdWVzdElkID0gKChyZXEgfHwge30pLmhlYWRlcnMgfHwge30pWyd4LXBhcnNlLXJlcXVlc3QtaWQnXTtcbiAgY29uc3QgeyBwYXRocywgdHRsIH0gPSBjb25maWcuaWRlbXBvdGVuY3lPcHRpb25zO1xuICBpZiAoIXJlcXVlc3RJZCB8fCAhY29uZmlnLmlkZW1wb3RlbmN5T3B0aW9ucykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBSZXF1ZXN0IHBhdGggbWF5IGNvbnRhaW4gdHJhaWxpbmcgc2xhc2hlcywgZGVwZW5kaW5nIG9uIHRoZSBvcmlnaW5hbCByZXF1ZXN0LCBzbyByZW1vdmVcbiAgLy8gbGVhZGluZyBhbmQgdHJhaWxpbmcgc2xhc2hlcyB0byBtYWtlIGl0IGVhc2llciB0byBzcGVjaWZ5IHBhdGhzIGluIHRoZSBjb25maWd1cmF0aW9uXG4gIGNvbnN0IHJlcVBhdGggPSByZXEucGF0aC5yZXBsYWNlKC9eXFwvfFxcLyQvLCAnJyk7XG4gIC8vIERldGVybWluZSB3aGV0aGVyIGlkZW1wb3RlbmN5IGlzIGVuYWJsZWQgZm9yIGN1cnJlbnQgcmVxdWVzdCBwYXRoXG4gIGxldCBtYXRjaCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICAvLyBBc3N1bWUgb25lIHdhbnRzIGEgcGF0aCB0byBhbHdheXMgbWF0Y2ggZnJvbSB0aGUgYmVnaW5uaW5nIHRvIHByZXZlbnQgYW55IG1pc3Rha2VzXG4gICAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKHBhdGguY2hhckF0KDApID09PSAnXicgPyBwYXRoIDogJ14nICsgcGF0aCk7XG4gICAgaWYgKHJlcVBhdGgubWF0Y2gocmVnZXgpKSB7XG4gICAgICBtYXRjaCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgaWYgKCFtYXRjaCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBUcnkgdG8gc3RvcmUgcmVxdWVzdFxuICBjb25zdCBleHBpcnlEYXRlID0gbmV3IERhdGUobmV3IERhdGUoKS5zZXRTZWNvbmRzKG5ldyBEYXRlKCkuZ2V0U2Vjb25kcygpICsgdHRsKSk7XG4gIHJldHVybiByZXN0XG4gICAgLmNyZWF0ZShjb25maWcsIGF1dGgubWFzdGVyKGNvbmZpZyksICdfSWRlbXBvdGVuY3knLCB7XG4gICAgICByZXFJZDogcmVxdWVzdElkLFxuICAgICAgZXhwaXJlOiBQYXJzZS5fZW5jb2RlKGV4cGlyeURhdGUpLFxuICAgIH0pXG4gICAgLmNhdGNoKGUgPT4ge1xuICAgICAgaWYgKGUuY29kZSA9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkRVUExJQ0FURV9SRVFVRVNULCAnRHVwbGljYXRlIHJlcXVlc3QnKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKSB7XG4gIHJlcy5zdGF0dXMoNDAzKTtcbiAgcmVzLmVuZCgne1wiZXJyb3JcIjpcInVuYXV0aG9yaXplZFwifScpO1xufVxuXG5mdW5jdGlvbiBtYWxmb3JtZWRDb250ZXh0KHJlcSwgcmVzKSB7XG4gIHJlcy5zdGF0dXMoNDAwKTtcbiAgcmVzLmpzb24oeyBjb2RlOiBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGVycm9yOiAnSW52YWxpZCBvYmplY3QgZm9yIGNvbnRleHQuJyB9KTtcbn1cblxuLyoqXG4gKiBFeHByZXNzIDQgYWxsb3dlZCBhIGRvdWJsZSBmb3J3YXJkIHNsYXNoIGJldHdlZW4gYSByb3V0ZSBhbmQgcm91dGVyLiBBbHRob3VnaFxuICogdGhpcyBzaG91bGQgYmUgY29uc2lkZXJlZCBhbiBhbnRpLXBhdHRlcm4sIHdlIG5lZWQgdG8gc3VwcG9ydCBpdCBmb3IgYmFja3dhcmRzXG4gKiBjb21wYXRpYmlsaXR5LlxuICpcbiAqIFRlY2huaWNhbGx5IHZhbGlkIFVSTCB3aXRoIGRvdWJsZSBmb3Jvd2FyZCBzbGFzaDpcbiAqIGh0dHA6Ly9sb2NhbGhvc3Q6MTMzNy9wYXJzZS8vZnVuY3Rpb25zL3Rlc3RGdW5jdGlvblxuICovXG5leHBvcnQgZnVuY3Rpb24gYWxsb3dEb3VibGVGb3J3YXJkU2xhc2gocmVxLCByZXMsIG5leHQpIHtcbiAgcmVxLnVybCA9IHJlcS51cmwuc3RhcnRzV2l0aCgnLy8nKSA/IHJlcS51cmwuc3Vic3RyaW5nKDEpIDogcmVxLnVybDtcbiAgbmV4dCgpO1xufVxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsSUFBQUEsTUFBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsTUFBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsS0FBQSxHQUFBSCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsS0FBQSxHQUFBSixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUksT0FBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssT0FBQSxHQUFBTixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU0sS0FBQSxHQUFBUCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU8sb0JBQUEsR0FBQVIsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFRLHVCQUFBLEdBQUFULHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBUyxpQkFBQSxHQUFBVixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVUsWUFBQSxHQUFBVixPQUFBO0FBQ0EsSUFBQVcsYUFBQSxHQUFBWCxPQUFBO0FBQ0EsSUFBQVksZUFBQSxHQUFBYixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQWEsTUFBQSxHQUFBYixPQUFBO0FBQ0EsSUFBQWMsSUFBQSxHQUFBZCxPQUFBO0FBQ0EsSUFBQWUsT0FBQSxHQUFBZixPQUFBO0FBQ0EsSUFBQWdCLE1BQUEsR0FBQWhCLE9BQUE7QUFBeUUsU0FBQUQsdUJBQUFrQixDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENBQUEsS0FBQUUsT0FBQSxF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QUksQ0FBQyxDQUFDLENBQUNFLFVBQVUsQ0FBQyxDQUFDLEdBQUdSLEdBQUcsQ0FBQyxDQUFDO0VBQ2pGLE9BQU9TLGFBQUksQ0FDUnZHLE1BQU0sQ0FBQ2xHLE1BQU0sRUFBRVksYUFBSSxDQUFDOEwsTUFBTSxDQUFDMU0sTUFBTSxDQUFDLEVBQUUsY0FBYyxFQUFFO0lBQ25EMk0sS0FBSyxFQUFFYixTQUFTO0lBQ2hCYyxNQUFNLEVBQUV0TSxhQUFLLENBQUN1TSxPQUFPLENBQUNSLFVBQVU7RUFDbEMsQ0FBQyxDQUFDLENBQ0RTLEtBQUssQ0FBQ2xTLENBQUMsSUFBSTtJQUNWLElBQUlBLENBQUMsQ0FBQ3lGLElBQUksSUFBSUMsYUFBSyxDQUFDQyxLQUFLLENBQUN3TSxlQUFlLEVBQUU7TUFDekMsTUFBTSxJQUFJek0sYUFBSyxDQUFDQyxLQUFLLENBQUNELGFBQUssQ0FBQ0MsS0FBSyxDQUFDeU0saUJBQWlCLEVBQUUsbUJBQW1CLENBQUM7SUFDM0U7SUFDQSxNQUFNcFMsQ0FBQztFQUNULENBQUMsQ0FBQztBQUNOO0FBRUEsU0FBU2tFLGNBQWNBLENBQUM1RCxHQUFHLEVBQUU4QixHQUFHLEVBQUU7RUFDaENBLEdBQUcsQ0FBQ21ELE1BQU0sQ0FBQyxHQUFHLENBQUM7RUFDZm5ELEdBQUcsQ0FBQzZLLEdBQUcsQ0FBQywwQkFBMEIsQ0FBQztBQUNyQztBQUVBLFNBQVNuSyxnQkFBZ0JBLENBQUN4QyxHQUFHLEVBQUU4QixHQUFHLEVBQUU7RUFDbENBLEdBQUcsQ0FBQ21ELE1BQU0sQ0FBQyxHQUFHLENBQUM7RUFDZm5ELEdBQUcsQ0FBQ29ELElBQUksQ0FBQztJQUFFQyxJQUFJLEVBQUVDLGFBQUssQ0FBQ0MsS0FBSyxDQUFDME0sWUFBWTtJQUFFeE0sS0FBSyxFQUFFO0VBQThCLENBQUMsQ0FBQztBQUNwRjs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ08sU0FBU3lNLHVCQUF1QkEsQ0FBQ2hTLEdBQUcsRUFBRThCLEdBQUcsRUFBRUMsSUFBSSxFQUFFO0VBQ3REL0IsR0FBRyxDQUFDSSxHQUFHLEdBQUdKLEdBQUcsQ0FBQ0ksR0FBRyxDQUFDd0ssVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHNUssR0FBRyxDQUFDSSxHQUFHLENBQUNtSSxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUd2SSxHQUFHLENBQUNJLEdBQUc7RUFDbkUyQixJQUFJLENBQUMsQ0FBQztBQUNSIiwiaWdub3JlTGlzdCI6W119