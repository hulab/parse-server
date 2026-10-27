"use strict";

var _util = require("util");
var _triggers = require("./triggers");
var _logger = require("./logger");
var _lruCache = require("lru-cache");
var _RestQuery = _interopRequireDefault(require("./RestQuery"));
var _RestWrite = _interopRequireDefault(require("./RestWrite"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const Parse = require('parse/node');
// An Auth object tells you who is requesting something and whether
// the master key was used.
// userObject is a Parse.User and can be null if there's no user.
function Auth({
  config,
  cacheController = undefined,
  isMaster = false,
  isMaintenance = false,
  isReadOnly = false,
  isLegacySession = false,
  user,
  installationId
}) {
  this.config = config;
  this.cacheController = cacheController || config && config.cacheController;
  this.installationId = installationId;
  this.isMaster = isMaster;
  this.isMaintenance = isMaintenance;
  this.user = user;
  this.isReadOnly = isReadOnly;
  this.isLegacySession = isLegacySession;

  // Assuming a users roles won't change during a single request, we'll
  // only load them once.
  this.userRoles = [];
  this.fetchedRoles = false;
  this.rolePromise = null;
}

// Whether this auth could possibly modify the given user id.
// It still could be forbidden via ACLs even if this returns true.
Auth.prototype.isUnauthenticated = function () {
  if (this.isMaster) {
    return false;
  }
  if (this.isMaintenance) {
    return false;
  }
  if (this.user) {
    return false;
  }
  return true;
};

// A helper to get a master-level Auth object
function master(config) {
  return new Auth({
    config,
    isMaster: true
  });
}

// A helper to get a maintenance-level Auth object
function maintenance(config) {
  return new Auth({
    config,
    isMaintenance: true
  });
}

// A helper to get a master-level Auth object
function readOnly(config) {
  return new Auth({
    config,
    isMaster: true,
    isReadOnly: true
  });
}

// A helper to get a nobody-level Auth object
function nobody(config) {
  return new Auth({
    config,
    isMaster: false
  });
}
const throttle = new _lruCache.LRUCache({
  max: 10000,
  ttl: 500
});
/**
 * Checks whether session should be updated based on last update time & session length.
 */
function shouldUpdateSessionExpiry(config, session) {
  const resetAfter = config.sessionLength / 2;
  const lastUpdated = new Date(session?.updatedAt);
  const skipRange = new Date();
  skipRange.setTime(skipRange.getTime() - resetAfter * 1000);
  return lastUpdated <= skipRange;
}
const renewSessionIfNeeded = async ({
  config,
  session,
  sessionToken
}) => {
  if (!config?.extendSessionOnUse) {
    return;
  }
  if (throttle.get(sessionToken)) {
    return;
  }
  throttle.set(sessionToken, true);
  try {
    if (!session) {
      const query = await (0, _RestQuery.default)({
        method: _RestQuery.default.Method.get,
        config,
        auth: master(config),
        runBeforeFind: false,
        className: '_Session',
        restWhere: {
          sessionToken
        },
        restOptions: {
          limit: 1
        }
      });
      const {
        results
      } = await query.execute();
      session = results[0];
    }
    if (!shouldUpdateSessionExpiry(config, session) || !session) {
      return;
    }
    const expiresAt = config.generateSessionExpiresAt();
    await new _RestWrite.default(config, master(config), '_Session', {
      objectId: session.objectId
    }, {
      expiresAt: Parse._encode(expiresAt)
    }).execute();
  } catch (e) {
    if (e?.code !== Parse.Error.OBJECT_NOT_FOUND) {
      _logger.logger.error('Could not update session expiry: ', e);
    }
  }
};

// Returns a promise that resolves to an Auth object
const getAuthForSessionToken = async function ({
  config,
  cacheController,
  sessionToken,
  installationId
}) {
  cacheController = cacheController || config && config.cacheController;
  if (cacheController) {
    const cached = await cacheController.user.get(sessionToken);
    if (cached) {
      const {
        expiresAt: cachedExpiresAt,
        ...userJSON
      } = cached;
      if (cachedExpiresAt && new Date(cachedExpiresAt) < new Date()) {
        cacheController.user.del(sessionToken);
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token is expired.');
      }
      const cachedUser = Parse.Object.fromJSON(userJSON);
      renewSessionIfNeeded({
        config,
        sessionToken
      });
      return Promise.resolve(new Auth({
        config,
        cacheController,
        isMaster: false,
        installationId,
        user: cachedUser
      }));
    }
  }
  let results;
  if (config) {
    const restOptions = {
      limit: 1,
      include: 'user'
    };
    const RestQuery = require('./RestQuery');
    const query = await RestQuery({
      method: RestQuery.Method.get,
      config,
      runBeforeFind: false,
      auth: master(config),
      className: '_Session',
      restWhere: {
        sessionToken
      },
      restOptions
    });
    results = (await query.execute()).results;
  } else {
    results = (await new Parse.Query(Parse.Session).limit(1).include('user').equalTo('sessionToken', sessionToken).find({
      useMasterKey: true
    })).map(obj => obj.toJSON());
  }
  if (results.length !== 1 || !results[0]['user']) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
  }
  const session = results[0];
  const now = new Date(),
    expiresAt = session.expiresAt ? new Date(session.expiresAt.iso) : undefined;
  if (expiresAt < now) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token is expired.');
  }
  const obj = session.user;
  if (typeof obj['objectId'] === 'string' && obj['objectId'].startsWith('role:')) {
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Invalid object ID.');
  }
  delete obj.password;
  obj['className'] = '_User';
  obj['sessionToken'] = sessionToken;
  if (cacheController) {
    cacheController.user.put(sessionToken, {
      ...obj,
      expiresAt: expiresAt?.toISOString()
    });
  }
  renewSessionIfNeeded({
    config,
    session,
    sessionToken
  });
  const userObject = Parse.Object.fromJSON(obj);
  return new Auth({
    config,
    cacheController,
    isMaster: false,
    installationId,
    user: userObject
  });
};
var getAuthForLegacySessionToken = async function ({
  config,
  sessionToken,
  installationId
}) {
  var restOptions = {
    limit: 1
  };
  const RestQuery = require('./RestQuery');
  var query = await RestQuery({
    method: RestQuery.Method.get,
    config,
    runBeforeFind: false,
    auth: master(config),
    className: '_User',
    restWhere: {
      _session_token: sessionToken
    },
    restOptions
  });
  return query.execute().then(response => {
    var results = response.results;
    if (results.length !== 1) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'invalid legacy session token');
    }
    const obj = results[0];
    if (typeof obj['objectId'] === 'string' && obj['objectId'].startsWith('role:')) {
      throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Invalid object ID.');
    }
    obj.className = '_User';
    const userObject = Parse.Object.fromJSON(obj);
    return new Auth({
      config,
      isMaster: false,
      isLegacySession: true,
      installationId,
      user: userObject
    });
  });
};

// Returns a promise that resolves to an array of role names
Auth.prototype.getUserRoles = function () {
  if (this.isMaster || this.isMaintenance || !this.user) {
    return Promise.resolve([]);
  }
  if (this.fetchedRoles) {
    return Promise.resolve(this.userRoles);
  }
  if (this.rolePromise) {
    return this.rolePromise;
  }
  this.rolePromise = this._loadRoles();
  return this.rolePromise;
};
Auth.prototype.getRolesForUser = async function () {
  //Stack all Parse.Role
  const results = [];
  if (this.config) {
    const restWhere = {
      users: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.user.id
      }
    };
    const RestQuery = require('./RestQuery');
    const query = await RestQuery({
      method: RestQuery.Method.find,
      runBeforeFind: false,
      config: this.config,
      auth: master(this.config),
      className: '_Role',
      restWhere
    });
    await query.each(result => results.push(result));
  } else {
    await new Parse.Query(Parse.Role).equalTo('users', this.user).each(result => results.push(result.toJSON()), {
      useMasterKey: true
    });
  }
  return results;
};

// Iterates through the role tree and compiles a user's roles
Auth.prototype._loadRoles = async function () {
  if (this.cacheController) {
    const cachedRoles = await this.cacheController.role.get(this.user.id);
    if (cachedRoles != null) {
      this.fetchedRoles = true;
      this.userRoles = cachedRoles;
      return cachedRoles;
    }
  }

  // First get the role ids this user is directly a member of
  const results = await this.getRolesForUser();
  if (!results.length) {
    this.userRoles = [];
    this.fetchedRoles = true;
    this.rolePromise = null;
    this.cacheRoles();
    return this.userRoles;
  }
  const rolesMap = results.reduce((m, r) => {
    m.names.push(r.name);
    m.ids.push(r.objectId);
    return m;
  }, {
    ids: [],
    names: []
  });

  // run the recursive finding
  const roleNames = await this._getAllRolesNamesForRoleIds(rolesMap.ids, rolesMap.names);
  this.userRoles = roleNames.map(r => {
    return 'role:' + r;
  });
  this.fetchedRoles = true;
  this.rolePromise = null;
  this.cacheRoles();
  return this.userRoles;
};
Auth.prototype.cacheRoles = function () {
  if (!this.cacheController) {
    return false;
  }
  this.cacheController.role.put(this.user.id, Array(...this.userRoles));
  return true;
};
Auth.prototype.clearRoleCache = function (sessionToken) {
  if (!this.cacheController) {
    return false;
  }
  this.cacheController.role.del(this.user.id);
  this.cacheController.user.del(sessionToken);
  return true;
};
Auth.prototype.getRolesByIds = async function (ins) {
  const results = [];
  // Build an OR query across all parentRoles
  if (!this.config) {
    await new Parse.Query(Parse.Role).containedIn('roles', ins.map(id => {
      const role = new Parse.Object(Parse.Role);
      role.id = id;
      return role;
    })).each(result => results.push(result.toJSON()), {
      useMasterKey: true
    });
  } else {
    const roles = ins.map(id => {
      return {
        __type: 'Pointer',
        className: '_Role',
        objectId: id
      };
    });
    const restWhere = {
      roles: {
        $in: roles
      }
    };
    const RestQuery = require('./RestQuery');
    const query = await RestQuery({
      method: RestQuery.Method.find,
      config: this.config,
      runBeforeFind: false,
      auth: master(this.config),
      className: '_Role',
      restWhere
    });
    await query.each(result => results.push(result));
  }
  return results;
};

// Given a list of roleIds, find all the parent roles, returns a promise with all names
Auth.prototype._getAllRolesNamesForRoleIds = function (roleIDs, names = [], queriedRoles = new Set()) {
  const ins = roleIDs.filter(roleID => {
    if (queriedRoles.has(roleID)) {
      return false;
    }
    queriedRoles.add(roleID);
    return true;
  });

  // all roles are accounted for, return the names
  if (ins.length == 0) {
    return Promise.resolve([...new Set(names)]);
  }
  return this.getRolesByIds(ins).then(results => {
    // Nothing found
    if (!results.length) {
      return Promise.resolve(names);
    }
    // Map the results with all Ids and names
    const resultMap = results.reduce((memo, role) => {
      memo.names.push(role.name);
      memo.ids.push(role.objectId);
      return memo;
    }, {
      ids: [],
      names: []
    });
    // store the new found names
    names = names.concat(resultMap.names);
    // find the next ones, circular roles will be cut
    return this._getAllRolesNamesForRoleIds(resultMap.ids, names, queriedRoles);
  }).then(names => {
    return Promise.resolve([...new Set(names)]);
  });
};
const findUsersWithAuthData = async (config, authData, beforeFind, currentUserAuthData) => {
  const providers = Object.keys(authData);
  const queries = await Promise.all(providers.map(async provider => {
    const providerAuthData = authData[provider];

    // Skip providers being unlinked (null value)
    if (providerAuthData === null) {
      return null;
    }

    // Skip beforeFind only when incoming data is confirmed unchanged from stored data.
    // This handles echoed-back authData from afterFind (e.g. client sends back { id: 'x' }
    // alongside a provider unlink). On login/signup, currentUserAuthData is undefined so
    // beforeFind always runs, preserving it as the security gate for missing credentials.
    const storedProviderData = currentUserAuthData?.[provider];
    const incomingKeys = Object.keys(providerAuthData || {});
    const isUnchanged = storedProviderData && incomingKeys.length > 0 && !incomingKeys.some(key => !(0, _util.isDeepStrictEqual)(providerAuthData[key], storedProviderData[key]));
    const validatorConfig = config.authDataManager.getValidatorForProvider(provider);
    // Skip database query for unconfigured providers to avoid unindexed collection scans;
    // the provider will be rejected later in handleAuthDataValidation with UNSUPPORTED_SERVICE
    if (!validatorConfig?.validator) {
      return null;
    }
    const adapter = validatorConfig.adapter;
    if (beforeFind && typeof adapter?.beforeFind === 'function' && !isUnchanged) {
      await adapter.beforeFind(providerAuthData);
    }
    if (!providerAuthData?.id) {
      return null;
    }
    if (typeof providerAuthData.id !== 'string') {
      throw new Parse.Error(Parse.Error.INVALID_VALUE, `Invalid authData id for provider '${provider}'.`);
    }
    return {
      [`authData.${provider}.id`]: providerAuthData.id
    };
  }));

  // Filter out null queries
  const validQueries = queries.filter(query => query !== null);
  if (!validQueries.length) {
    return [];
  }

  // Perform database query
  return config.database.find('_User', {
    $or: validQueries
  }, {
    limit: 2
  });
};
const hasMutatedAuthData = (authData, userAuthData) => {
  if (!userAuthData) {
    return {
      hasMutatedAuthData: true,
      mutatedAuthData: authData
    };
  }
  const mutatedAuthData = {};
  Object.keys(authData).forEach(provider => {
    // Anonymous provider is not handled this way
    if (provider === 'anonymous') {
      return;
    }
    const providerData = authData[provider];
    const userProviderAuthData = userAuthData[provider];

    // If unlinking (setting to null), consider it mutated
    if (providerData === null) {
      mutatedAuthData[provider] = providerData;
      return;
    }

    // If provider doesn't exist in stored data, it's new
    if (!userProviderAuthData) {
      mutatedAuthData[provider] = providerData;
      return;
    }

    // Check if incoming data represents actual changes vs just echoing back
    // what afterFind returned. If incoming data is a subset of stored data
    // (all incoming fields match stored values), it's not mutated.
    // If incoming data has different values or fields not in stored data, it's mutated.
    // This handles the case where afterFind strips sensitive fields like 'code':
    // - Incoming: { id: 'x' }, Stored: { id: 'x', code: 'secret' } -> NOT mutated (subset)
    // - Incoming: { id: 'x', token: 'new' }, Stored: { id: 'x', token: 'old' } -> MUTATED
    const incomingKeys = Object.keys(providerData || {});
    const hasChanges = incomingKeys.some(key => {
      return !(0, _util.isDeepStrictEqual)(providerData[key], userProviderAuthData[key]);
    });
    if (hasChanges) {
      mutatedAuthData[provider] = providerData;
    }
  });
  const hasMutatedAuthData = Object.keys(mutatedAuthData).length !== 0;
  return {
    hasMutatedAuthData,
    mutatedAuthData
  };
};
const checkIfUserHasProvidedConfiguredProvidersForLogin = (req = {}, authData = {}, userAuthData = {}, config) => {
  const savedUserProviders = Object.keys(userAuthData).map(provider => {
    const validator = config.authDataManager.getValidatorForProvider(provider);
    if (!validator || !validator.adapter) {
      return null;
    }
    return {
      name: provider,
      adapter: validator.adapter
    };
  }).filter(Boolean);
  const hasProvidedASoloProvider = savedUserProviders.some(provider => provider && provider.adapter && provider.adapter.policy === 'solo' && authData[provider.name]);

  // Solo providers can be considered as safe, so we do not have to check if the user needs
  // to provide an additional provider to login. An auth adapter with "solo" (like webauthn) means
  // no "additional" auth needs to be provided to login (like OTP, MFA)
  if (hasProvidedASoloProvider) {
    return;
  }
  const additionProvidersNotFound = [];
  const hasProvidedAtLeastOneAdditionalProvider = savedUserProviders.some(provider => {
    let policy = provider.adapter.policy;
    if (typeof policy === 'function') {
      const requestObject = {
        ip: req.config.ip,
        user: req.auth.user,
        master: req.auth.isMaster
      };
      policy = policy.call(provider.adapter, requestObject, userAuthData[provider.name]);
    }
    if (policy === 'additional') {
      if (authData[provider.name]) {
        return true;
      } else {
        // Push missing provider for error message
        additionProvidersNotFound.push(provider.name);
      }
    }
  });
  if (hasProvidedAtLeastOneAdditionalProvider || !additionProvidersNotFound.length) {
    return;
  }
  throw new Parse.Error(Parse.Error.OTHER_CAUSE, `Missing additional authData ${additionProvidersNotFound.join(',')}`);
};

// Validate each authData step-by-step and return the provider responses
const handleAuthDataValidation = async (authData, req, foundUser, {
  isLogin = true
} = {}) => {
  let user;
  if (foundUser) {
    user = Parse.User.fromJSON({
      className: '_User',
      ...foundUser
    });
    // Find user by session and current objectId; only pass user if it's the current user or master key is provided
  } else if (req.auth && req.auth.user && typeof req.getUserId === 'function' && req.getUserId() === req.auth.user.id || req.auth && req.auth.isMaster && typeof req.getUserId === 'function' && req.getUserId()) {
    user = new Parse.User();
    user.id = req.auth.isMaster ? req.getUserId() : req.auth.user.id;
    await user.fetch({
      useMasterKey: true
    });
  }
  const {
    updatedObject
  } = req.buildParseObjects();
  const requestObject = (0, _triggers.getRequestObject)(undefined, req.auth, updatedObject, user, req.config);
  // Perform validation as step-by-step pipeline for better error consistency
  // and also to avoid to trigger a provider (like OTP SMS) if another one fails
  const acc = {
    authData: {},
    authDataResponse: {}
  };
  const authKeys = Object.keys(authData).sort();
  for (const provider of authKeys) {
    let method = '';
    try {
      if (authData[provider] === null) {
        acc.authData[provider] = null;
        continue;
      }
      const {
        validator
      } = req.config.authDataManager.getValidatorForProvider(provider) || {};
      const authProvider = (req.config.auth || {})[provider] || {};
      if (!validator || authProvider.enabled === false) {
        throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
      }
      let validationResult = await validator(authData[provider], req, user, requestObject, {
        isLogin
      });
      method = validationResult && validationResult.method;
      requestObject.triggerName = method;
      if (validationResult && validationResult.validator) {
        validationResult = await validationResult.validator();
      }
      if (!validationResult) {
        acc.authData[provider] = authData[provider];
        continue;
      }
      if (!Object.keys(validationResult).length) {
        acc.authData[provider] = authData[provider];
        continue;
      }
      if (validationResult.response) {
        acc.authDataResponse[provider] = validationResult.response;
      }
      // Some auth providers after initialization will avoid to replace authData already stored
      if (!validationResult.doNotSave) {
        acc.authData[provider] = validationResult.save || authData[provider];
      }
    } catch (err) {
      const e = (0, _triggers.resolveError)(err, {
        code: Parse.Error.SCRIPT_FAILED,
        message: 'Auth failed. Unknown error.'
      });
      const userString = req.auth && req.auth.user ? req.auth.user.id : req.data.objectId || undefined;
      _logger.logger.error(`Failed running auth step ${method} for ${provider} for user ${userString} with Error: ` + JSON.stringify(e), {
        authenticationStep: method,
        error: e,
        user: userString,
        provider
      });
      throw e;
    }
  }
  return acc;
};
module.exports = {
  Auth,
  master,
  maintenance,
  nobody,
  readOnly,
  shouldUpdateSessionExpiry,
  getAuthForSessionToken,
  getAuthForLegacySessionToken,
  findUsersWithAuthData,
  hasMutatedAuthData,
  checkIfUserHasProvidedConfiguredProvidersForLogin,
  handleAuthDataValidation
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfdXRpbCIsInJlcXVpcmUiLCJfdHJpZ2dlcnMiLCJfbG9nZ2VyIiwiX2xydUNhY2hlIiwiX1Jlc3RRdWVyeSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJfUmVzdFdyaXRlIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUGFyc2UiLCJBdXRoIiwiY29uZmlnIiwiY2FjaGVDb250cm9sbGVyIiwidW5kZWZpbmVkIiwiaXNNYXN0ZXIiLCJpc01haW50ZW5hbmNlIiwiaXNSZWFkT25seSIsImlzTGVnYWN5U2Vzc2lvbiIsInVzZXIiLCJpbnN0YWxsYXRpb25JZCIsInVzZXJSb2xlcyIsImZldGNoZWRSb2xlcyIsInJvbGVQcm9taXNlIiwicHJvdG90eXBlIiwiaXNVbmF1dGhlbnRpY2F0ZWQiLCJtYXN0ZXIiLCJtYWludGVuYW5jZSIsInJlYWRPbmx5Iiwibm9ib2R5IiwidGhyb3R0bGUiLCJMUlUiLCJtYXgiLCJ0dGwiLCJzaG91bGRVcGRhdGVTZXNzaW9uRXhwaXJ5Iiwic2Vzc2lvbiIsInJlc2V0QWZ0ZXIiLCJzZXNzaW9uTGVuZ3RoIiwibGFzdFVwZGF0ZWQiLCJEYXRlIiwidXBkYXRlZEF0Iiwic2tpcFJhbmdlIiwic2V0VGltZSIsImdldFRpbWUiLCJyZW5ld1Nlc3Npb25JZk5lZWRlZCIsInNlc3Npb25Ub2tlbiIsImV4dGVuZFNlc3Npb25PblVzZSIsImdldCIsInNldCIsInF1ZXJ5IiwiUmVzdFF1ZXJ5IiwibWV0aG9kIiwiTWV0aG9kIiwiYXV0aCIsInJ1bkJlZm9yZUZpbmQiLCJjbGFzc05hbWUiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImxpbWl0IiwicmVzdWx0cyIsImV4ZWN1dGUiLCJleHBpcmVzQXQiLCJnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQiLCJSZXN0V3JpdGUiLCJvYmplY3RJZCIsIl9lbmNvZGUiLCJjb2RlIiwiRXJyb3IiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwibG9nZ2VyIiwiZXJyb3IiLCJnZXRBdXRoRm9yU2Vzc2lvblRva2VuIiwiY2FjaGVkIiwiY2FjaGVkRXhwaXJlc0F0IiwidXNlckpTT04iLCJkZWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJjYWNoZWRVc2VyIiwiT2JqZWN0IiwiZnJvbUpTT04iLCJQcm9taXNlIiwicmVzb2x2ZSIsImluY2x1ZGUiLCJRdWVyeSIsIlNlc3Npb24iLCJlcXVhbFRvIiwiZmluZCIsInVzZU1hc3RlcktleSIsIm1hcCIsIm9iaiIsInRvSlNPTiIsImxlbmd0aCIsIm5vdyIsImlzbyIsInN0YXJ0c1dpdGgiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJwYXNzd29yZCIsInB1dCIsInRvSVNPU3RyaW5nIiwidXNlck9iamVjdCIsImdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4iLCJfc2Vzc2lvbl90b2tlbiIsInRoZW4iLCJyZXNwb25zZSIsImdldFVzZXJSb2xlcyIsIl9sb2FkUm9sZXMiLCJnZXRSb2xlc0ZvclVzZXIiLCJ1c2VycyIsIl9fdHlwZSIsImlkIiwiZWFjaCIsInJlc3VsdCIsInB1c2giLCJSb2xlIiwiY2FjaGVkUm9sZXMiLCJyb2xlIiwiY2FjaGVSb2xlcyIsInJvbGVzTWFwIiwicmVkdWNlIiwibSIsInIiLCJuYW1lcyIsIm5hbWUiLCJpZHMiLCJyb2xlTmFtZXMiLCJfZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMiLCJBcnJheSIsImNsZWFyUm9sZUNhY2hlIiwiZ2V0Um9sZXNCeUlkcyIsImlucyIsImNvbnRhaW5lZEluIiwicm9sZXMiLCIkaW4iLCJyb2xlSURzIiwicXVlcmllZFJvbGVzIiwiU2V0IiwiZmlsdGVyIiwicm9sZUlEIiwiaGFzIiwiYWRkIiwicmVzdWx0TWFwIiwibWVtbyIsImNvbmNhdCIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsImF1dGhEYXRhIiwiYmVmb3JlRmluZCIsImN1cnJlbnRVc2VyQXV0aERhdGEiLCJwcm92aWRlcnMiLCJrZXlzIiwicXVlcmllcyIsImFsbCIsInByb3ZpZGVyIiwicHJvdmlkZXJBdXRoRGF0YSIsInN0b3JlZFByb3ZpZGVyRGF0YSIsImluY29taW5nS2V5cyIsImlzVW5jaGFuZ2VkIiwic29tZSIsImtleSIsImlzRGVlcFN0cmljdEVxdWFsIiwidmFsaWRhdG9yQ29uZmlnIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIiLCJ2YWxpZGF0b3IiLCJhZGFwdGVyIiwiSU5WQUxJRF9WQUxVRSIsInZhbGlkUXVlcmllcyIsImRhdGFiYXNlIiwiJG9yIiwiaGFzTXV0YXRlZEF1dGhEYXRhIiwidXNlckF1dGhEYXRhIiwibXV0YXRlZEF1dGhEYXRhIiwiZm9yRWFjaCIsInByb3ZpZGVyRGF0YSIsInVzZXJQcm92aWRlckF1dGhEYXRhIiwiaGFzQ2hhbmdlcyIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJyZXEiLCJzYXZlZFVzZXJQcm92aWRlcnMiLCJCb29sZWFuIiwiaGFzUHJvdmlkZWRBU29sb1Byb3ZpZGVyIiwicG9saWN5IiwiYWRkaXRpb25Qcm92aWRlcnNOb3RGb3VuZCIsImhhc1Byb3ZpZGVkQXRMZWFzdE9uZUFkZGl0aW9uYWxQcm92aWRlciIsInJlcXVlc3RPYmplY3QiLCJpcCIsImNhbGwiLCJPVEhFUl9DQVVTRSIsImpvaW4iLCJoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24iLCJmb3VuZFVzZXIiLCJpc0xvZ2luIiwiVXNlciIsImdldFVzZXJJZCIsImZldGNoIiwidXBkYXRlZE9iamVjdCIsImJ1aWxkUGFyc2VPYmplY3RzIiwiZ2V0UmVxdWVzdE9iamVjdCIsImFjYyIsImF1dGhEYXRhUmVzcG9uc2UiLCJhdXRoS2V5cyIsInNvcnQiLCJhdXRoUHJvdmlkZXIiLCJlbmFibGVkIiwiVU5TVVBQT1JURURfU0VSVklDRSIsInZhbGlkYXRpb25SZXN1bHQiLCJ0cmlnZ2VyTmFtZSIsImRvTm90U2F2ZSIsInNhdmUiLCJlcnIiLCJyZXNvbHZlRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJTdHJpbmciLCJkYXRhIiwiSlNPTiIsInN0cmluZ2lmeSIsImF1dGhlbnRpY2F0aW9uU3RlcCIsIm1vZHVsZSIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi9zcmMvQXV0aC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbmltcG9ydCB7IGlzRGVlcFN0cmljdEVxdWFsIH0gZnJvbSAndXRpbCc7XG5pbXBvcnQgeyBnZXRSZXF1ZXN0T2JqZWN0LCByZXNvbHZlRXJyb3IgfSBmcm9tICcuL3RyaWdnZXJzJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IExSVUNhY2hlIGFzIExSVSB9IGZyb20gJ2xydS1jYWNoZSc7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBSZXN0V3JpdGUgZnJvbSAnLi9SZXN0V3JpdGUnO1xuXG4vLyBBbiBBdXRoIG9iamVjdCB0ZWxscyB5b3Ugd2hvIGlzIHJlcXVlc3Rpbmcgc29tZXRoaW5nIGFuZCB3aGV0aGVyXG4vLyB0aGUgbWFzdGVyIGtleSB3YXMgdXNlZC5cbi8vIHVzZXJPYmplY3QgaXMgYSBQYXJzZS5Vc2VyIGFuZCBjYW4gYmUgbnVsbCBpZiB0aGVyZSdzIG5vIHVzZXIuXG5mdW5jdGlvbiBBdXRoKHtcbiAgY29uZmlnLFxuICBjYWNoZUNvbnRyb2xsZXIgPSB1bmRlZmluZWQsXG4gIGlzTWFzdGVyID0gZmFsc2UsXG4gIGlzTWFpbnRlbmFuY2UgPSBmYWxzZSxcbiAgaXNSZWFkT25seSA9IGZhbHNlLFxuICBpc0xlZ2FjeVNlc3Npb24gPSBmYWxzZSxcbiAgdXNlcixcbiAgaW5zdGFsbGF0aW9uSWQsXG59KSB7XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGNhY2hlQ29udHJvbGxlciB8fCAoY29uZmlnICYmIGNvbmZpZy5jYWNoZUNvbnRyb2xsZXIpO1xuICB0aGlzLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIHRoaXMuaXNNYXN0ZXIgPSBpc01hc3RlcjtcbiAgdGhpcy5pc01haW50ZW5hbmNlID0gaXNNYWludGVuYW5jZTtcbiAgdGhpcy51c2VyID0gdXNlcjtcbiAgdGhpcy5pc1JlYWRPbmx5ID0gaXNSZWFkT25seTtcbiAgdGhpcy5pc0xlZ2FjeVNlc3Npb24gPSBpc0xlZ2FjeVNlc3Npb247XG5cbiAgLy8gQXNzdW1pbmcgYSB1c2VycyByb2xlcyB3b24ndCBjaGFuZ2UgZHVyaW5nIGEgc2luZ2xlIHJlcXVlc3QsIHdlJ2xsXG4gIC8vIG9ubHkgbG9hZCB0aGVtIG9uY2UuXG4gIHRoaXMudXNlclJvbGVzID0gW107XG4gIHRoaXMuZmV0Y2hlZFJvbGVzID0gZmFsc2U7XG4gIHRoaXMucm9sZVByb21pc2UgPSBudWxsO1xufVxuXG4vLyBXaGV0aGVyIHRoaXMgYXV0aCBjb3VsZCBwb3NzaWJseSBtb2RpZnkgdGhlIGdpdmVuIHVzZXIgaWQuXG4vLyBJdCBzdGlsbCBjb3VsZCBiZSBmb3JiaWRkZW4gdmlhIEFDTHMgZXZlbiBpZiB0aGlzIHJldHVybnMgdHJ1ZS5cbkF1dGgucHJvdG90eXBlLmlzVW5hdXRoZW50aWNhdGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5pc01hc3Rlcikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAodGhpcy5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0aGlzLnVzZXIpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgYSBtYXN0ZXItbGV2ZWwgQXV0aCBvYmplY3RcbmZ1bmN0aW9uIG1hc3Rlcihjb25maWcpIHtcbiAgcmV0dXJuIG5ldyBBdXRoKHsgY29uZmlnLCBpc01hc3RlcjogdHJ1ZSB9KTtcbn1cblxuLy8gQSBoZWxwZXIgdG8gZ2V0IGEgbWFpbnRlbmFuY2UtbGV2ZWwgQXV0aCBvYmplY3RcbmZ1bmN0aW9uIG1haW50ZW5hbmNlKGNvbmZpZykge1xuICByZXR1cm4gbmV3IEF1dGgoeyBjb25maWcsIGlzTWFpbnRlbmFuY2U6IHRydWUgfSk7XG59XG5cbi8vIEEgaGVscGVyIHRvIGdldCBhIG1hc3Rlci1sZXZlbCBBdXRoIG9iamVjdFxuZnVuY3Rpb24gcmVhZE9ubHkoY29uZmlnKSB7XG4gIHJldHVybiBuZXcgQXV0aCh7IGNvbmZpZywgaXNNYXN0ZXI6IHRydWUsIGlzUmVhZE9ubHk6IHRydWUgfSk7XG59XG5cbi8vIEEgaGVscGVyIHRvIGdldCBhIG5vYm9keS1sZXZlbCBBdXRoIG9iamVjdFxuZnVuY3Rpb24gbm9ib2R5KGNvbmZpZykge1xuICByZXR1cm4gbmV3IEF1dGgoeyBjb25maWcsIGlzTWFzdGVyOiBmYWxzZSB9KTtcbn1cblxuY29uc3QgdGhyb3R0bGUgPSBuZXcgTFJVKHtcbiAgbWF4OiAxMDAwMCxcbiAgdHRsOiA1MDAsXG59KTtcbi8qKlxuICogQ2hlY2tzIHdoZXRoZXIgc2Vzc2lvbiBzaG91bGQgYmUgdXBkYXRlZCBiYXNlZCBvbiBsYXN0IHVwZGF0ZSB0aW1lICYgc2Vzc2lvbiBsZW5ndGguXG4gKi9cbmZ1bmN0aW9uIHNob3VsZFVwZGF0ZVNlc3Npb25FeHBpcnkoY29uZmlnLCBzZXNzaW9uKSB7XG4gIGNvbnN0IHJlc2V0QWZ0ZXIgPSBjb25maWcuc2Vzc2lvbkxlbmd0aCAvIDI7XG4gIGNvbnN0IGxhc3RVcGRhdGVkID0gbmV3IERhdGUoc2Vzc2lvbj8udXBkYXRlZEF0KTtcbiAgY29uc3Qgc2tpcFJhbmdlID0gbmV3IERhdGUoKTtcbiAgc2tpcFJhbmdlLnNldFRpbWUoc2tpcFJhbmdlLmdldFRpbWUoKSAtIHJlc2V0QWZ0ZXIgKiAxMDAwKTtcbiAgcmV0dXJuIGxhc3RVcGRhdGVkIDw9IHNraXBSYW5nZTtcbn1cblxuY29uc3QgcmVuZXdTZXNzaW9uSWZOZWVkZWQgPSBhc3luYyAoeyBjb25maWcsIHNlc3Npb24sIHNlc3Npb25Ub2tlbiB9KSA9PiB7XG4gIGlmICghY29uZmlnPy5leHRlbmRTZXNzaW9uT25Vc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRocm90dGxlLmdldChzZXNzaW9uVG9rZW4pKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRocm90dGxlLnNldChzZXNzaW9uVG9rZW4sIHRydWUpO1xuICB0cnkge1xuICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgY29uc3QgcXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZ2V0LFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGg6IG1hc3Rlcihjb25maWcpLFxuICAgICAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICAgICAgY2xhc3NOYW1lOiAnX1Nlc3Npb24nLFxuICAgICAgICByZXN0V2hlcmU6IHsgc2Vzc2lvblRva2VuIH0sXG4gICAgICAgIHJlc3RPcHRpb25zOiB7IGxpbWl0OiAxIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHsgcmVzdWx0cyB9ID0gYXdhaXQgcXVlcnkuZXhlY3V0ZSgpO1xuICAgICAgc2Vzc2lvbiA9IHJlc3VsdHNbMF07XG4gICAgfVxuXG4gICAgaWYgKCFzaG91bGRVcGRhdGVTZXNzaW9uRXhwaXJ5KGNvbmZpZywgc2Vzc2lvbikgfHwgIXNlc3Npb24pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpO1xuICAgIGF3YWl0IG5ldyBSZXN0V3JpdGUoXG4gICAgICBjb25maWcsXG4gICAgICBtYXN0ZXIoY29uZmlnKSxcbiAgICAgICdfU2Vzc2lvbicsXG4gICAgICB7IG9iamVjdElkOiBzZXNzaW9uLm9iamVjdElkIH0sXG4gICAgICB7IGV4cGlyZXNBdDogUGFyc2UuX2VuY29kZShleHBpcmVzQXQpIH1cbiAgICApLmV4ZWN1dGUoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlPy5jb2RlICE9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0NvdWxkIG5vdCB1cGRhdGUgc2Vzc2lvbiBleHBpcnk6ICcsIGUpO1xuICAgIH1cbiAgfVxufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhbiBBdXRoIG9iamVjdFxuY29uc3QgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uICh7XG4gIGNvbmZpZyxcbiAgY2FjaGVDb250cm9sbGVyLFxuICBzZXNzaW9uVG9rZW4sXG4gIGluc3RhbGxhdGlvbklkLFxufSkge1xuICBjYWNoZUNvbnRyb2xsZXIgPSBjYWNoZUNvbnRyb2xsZXIgfHwgKGNvbmZpZyAmJiBjb25maWcuY2FjaGVDb250cm9sbGVyKTtcbiAgaWYgKGNhY2hlQ29udHJvbGxlcikge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlQ29udHJvbGxlci51c2VyLmdldChzZXNzaW9uVG9rZW4pO1xuICAgIGlmIChjYWNoZWQpIHtcbiAgICAgIGNvbnN0IHsgZXhwaXJlc0F0OiBjYWNoZWRFeHBpcmVzQXQsIC4uLnVzZXJKU09OIH0gPSBjYWNoZWQ7XG4gICAgICBpZiAoY2FjaGVkRXhwaXJlc0F0ICYmIG5ldyBEYXRlKGNhY2hlZEV4cGlyZXNBdCkgPCBuZXcgRGF0ZSgpKSB7XG4gICAgICAgIGNhY2hlQ29udHJvbGxlci51c2VyLmRlbChzZXNzaW9uVG9rZW4pO1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnU2Vzc2lvbiB0b2tlbiBpcyBleHBpcmVkLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgY2FjaGVkVXNlciA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTih1c2VySlNPTik7XG4gICAgICByZW5ld1Nlc3Npb25JZk5lZWRlZCh7IGNvbmZpZywgc2Vzc2lvblRva2VuIH0pO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShcbiAgICAgICAgbmV3IEF1dGgoe1xuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICBjYWNoZUNvbnRyb2xsZXIsXG4gICAgICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkLFxuICAgICAgICAgIHVzZXI6IGNhY2hlZFVzZXIsXG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGxldCByZXN1bHRzO1xuICBpZiAoY29uZmlnKSB7XG4gICAgY29uc3QgcmVzdE9wdGlvbnMgPSB7XG4gICAgICBsaW1pdDogMSxcbiAgICAgIGluY2x1ZGU6ICd1c2VyJyxcbiAgICB9O1xuICAgIGNvbnN0IFJlc3RRdWVyeSA9IHJlcXVpcmUoJy4vUmVzdFF1ZXJ5Jyk7XG4gICAgY29uc3QgcXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmdldCxcbiAgICAgIGNvbmZpZyxcbiAgICAgIHJ1bkJlZm9yZUZpbmQ6IGZhbHNlLFxuICAgICAgYXV0aDogbWFzdGVyKGNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfU2Vzc2lvbicsXG4gICAgICByZXN0V2hlcmU6IHsgc2Vzc2lvblRva2VuIH0sXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgICByZXN1bHRzID0gKGF3YWl0IHF1ZXJ5LmV4ZWN1dGUoKSkucmVzdWx0cztcbiAgfSBlbHNlIHtcbiAgICByZXN1bHRzID0gKFxuICAgICAgYXdhaXQgbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlNlc3Npb24pXG4gICAgICAgIC5saW1pdCgxKVxuICAgICAgICAuaW5jbHVkZSgndXNlcicpXG4gICAgICAgIC5lcXVhbFRvKCdzZXNzaW9uVG9rZW4nLCBzZXNzaW9uVG9rZW4pXG4gICAgICAgIC5maW5kKHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pXG4gICAgKS5tYXAob2JqID0+IG9iai50b0pTT04oKSk7XG4gIH1cblxuICBpZiAocmVzdWx0cy5sZW5ndGggIT09IDEgfHwgIXJlc3VsdHNbMF1bJ3VzZXInXSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nKTtcbiAgfVxuICBjb25zdCBzZXNzaW9uID0gcmVzdWx0c1swXTtcbiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKSxcbiAgICBleHBpcmVzQXQgPSBzZXNzaW9uLmV4cGlyZXNBdCA/IG5ldyBEYXRlKHNlc3Npb24uZXhwaXJlc0F0LmlzbykgOiB1bmRlZmluZWQ7XG4gIGlmIChleHBpcmVzQXQgPCBub3cpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnU2Vzc2lvbiB0b2tlbiBpcyBleHBpcmVkLicpO1xuICB9XG4gIGNvbnN0IG9iaiA9IHNlc3Npb24udXNlcjtcblxuICBpZiAodHlwZW9mIG9ialsnb2JqZWN0SWQnXSA9PT0gJ3N0cmluZycgJiYgb2JqWydvYmplY3RJZCddLnN0YXJ0c1dpdGgoJ3JvbGU6JykpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnSW52YWxpZCBvYmplY3QgSUQuJyk7XG4gIH1cblxuICBkZWxldGUgb2JqLnBhc3N3b3JkO1xuICBvYmpbJ2NsYXNzTmFtZSddID0gJ19Vc2VyJztcbiAgb2JqWydzZXNzaW9uVG9rZW4nXSA9IHNlc3Npb25Ub2tlbjtcbiAgaWYgKGNhY2hlQ29udHJvbGxlcikge1xuICAgIGNhY2hlQ29udHJvbGxlci51c2VyLnB1dChzZXNzaW9uVG9rZW4sIHsgLi4ub2JqLCBleHBpcmVzQXQ6IGV4cGlyZXNBdD8udG9JU09TdHJpbmcoKSB9KTtcbiAgfVxuICByZW5ld1Nlc3Npb25JZk5lZWRlZCh7IGNvbmZpZywgc2Vzc2lvbiwgc2Vzc2lvblRva2VuIH0pO1xuICBjb25zdCB1c2VyT2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKG9iaik7XG4gIHJldHVybiBuZXcgQXV0aCh7XG4gICAgY29uZmlnLFxuICAgIGNhY2hlQ29udHJvbGxlcixcbiAgICBpc01hc3RlcjogZmFsc2UsXG4gICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgdXNlcjogdXNlck9iamVjdCxcbiAgfSk7XG59O1xuXG52YXIgZ2V0QXV0aEZvckxlZ2FjeVNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uICh7IGNvbmZpZywgc2Vzc2lvblRva2VuLCBpbnN0YWxsYXRpb25JZCB9KSB7XG4gIHZhciByZXN0T3B0aW9ucyA9IHtcbiAgICBsaW1pdDogMSxcbiAgfTtcbiAgY29uc3QgUmVzdFF1ZXJ5ID0gcmVxdWlyZSgnLi9SZXN0UXVlcnknKTtcbiAgdmFyIHF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZ2V0LFxuICAgIGNvbmZpZyxcbiAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICBhdXRoOiBtYXN0ZXIoY29uZmlnKSxcbiAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgcmVzdFdoZXJlOiB7IF9zZXNzaW9uX3Rva2VuOiBzZXNzaW9uVG9rZW4gfSxcbiAgICByZXN0T3B0aW9ucyxcbiAgfSk7XG4gIHJldHVybiBxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdmFyIHJlc3VsdHMgPSByZXNwb25zZS5yZXN1bHRzO1xuICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ2ludmFsaWQgbGVnYWN5IHNlc3Npb24gdG9rZW4nKTtcbiAgICB9XG4gICAgY29uc3Qgb2JqID0gcmVzdWx0c1swXTtcblxuICAgIGlmICh0eXBlb2Ygb2JqWydvYmplY3RJZCddID09PSAnc3RyaW5nJyAmJiBvYmpbJ29iamVjdElkJ10uc3RhcnRzV2l0aCgncm9sZTonKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgJ0ludmFsaWQgb2JqZWN0IElELicpO1xuICAgIH1cblxuICAgIG9iai5jbGFzc05hbWUgPSAnX1VzZXInO1xuICAgIGNvbnN0IHVzZXJPYmplY3QgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04ob2JqKTtcbiAgICByZXR1cm4gbmV3IEF1dGgoe1xuICAgICAgY29uZmlnLFxuICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgICAgaXNMZWdhY3lTZXNzaW9uOiB0cnVlLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICB1c2VyOiB1c2VyT2JqZWN0LFxuICAgIH0pO1xuICB9KTtcbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gYW4gYXJyYXkgb2Ygcm9sZSBuYW1lc1xuQXV0aC5wcm90b3R5cGUuZ2V0VXNlclJvbGVzID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5pc01hc3RlciB8fCB0aGlzLmlzTWFpbnRlbmFuY2UgfHwgIXRoaXMudXNlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICB9XG4gIGlmICh0aGlzLmZldGNoZWRSb2xlcykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodGhpcy51c2VyUm9sZXMpO1xuICB9XG4gIGlmICh0aGlzLnJvbGVQcm9taXNlKSB7XG4gICAgcmV0dXJuIHRoaXMucm9sZVByb21pc2U7XG4gIH1cbiAgdGhpcy5yb2xlUHJvbWlzZSA9IHRoaXMuX2xvYWRSb2xlcygpO1xuICByZXR1cm4gdGhpcy5yb2xlUHJvbWlzZTtcbn07XG5cbkF1dGgucHJvdG90eXBlLmdldFJvbGVzRm9yVXNlciA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy9TdGFjayBhbGwgUGFyc2UuUm9sZVxuICBjb25zdCByZXN1bHRzID0gW107XG4gIGlmICh0aGlzLmNvbmZpZykge1xuICAgIGNvbnN0IHJlc3RXaGVyZSA9IHtcbiAgICAgIHVzZXJzOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLnVzZXIuaWQsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgUmVzdFF1ZXJ5ID0gcmVxdWlyZSgnLi9SZXN0UXVlcnknKTtcbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIHJ1bkJlZm9yZUZpbmQ6IGZhbHNlLFxuICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgIGF1dGg6IG1hc3Rlcih0aGlzLmNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfUm9sZScsXG4gICAgICByZXN0V2hlcmUsXG4gICAgfSk7XG4gICAgYXdhaXQgcXVlcnkuZWFjaChyZXN1bHQgPT4gcmVzdWx0cy5wdXNoKHJlc3VsdCkpO1xuICB9IGVsc2Uge1xuICAgIGF3YWl0IG5ldyBQYXJzZS5RdWVyeShQYXJzZS5Sb2xlKVxuICAgICAgLmVxdWFsVG8oJ3VzZXJzJywgdGhpcy51c2VyKVxuICAgICAgLmVhY2gocmVzdWx0ID0+IHJlc3VsdHMucHVzaChyZXN1bHQudG9KU09OKCkpLCB7IHVzZU1hc3RlcktleTogdHJ1ZSB9KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0cztcbn07XG5cbi8vIEl0ZXJhdGVzIHRocm91Z2ggdGhlIHJvbGUgdHJlZSBhbmQgY29tcGlsZXMgYSB1c2VyJ3Mgcm9sZXNcbkF1dGgucHJvdG90eXBlLl9sb2FkUm9sZXMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNhY2hlQ29udHJvbGxlcikge1xuICAgIGNvbnN0IGNhY2hlZFJvbGVzID0gYXdhaXQgdGhpcy5jYWNoZUNvbnRyb2xsZXIucm9sZS5nZXQodGhpcy51c2VyLmlkKTtcbiAgICBpZiAoY2FjaGVkUm9sZXMgIT0gbnVsbCkge1xuICAgICAgdGhpcy5mZXRjaGVkUm9sZXMgPSB0cnVlO1xuICAgICAgdGhpcy51c2VyUm9sZXMgPSBjYWNoZWRSb2xlcztcbiAgICAgIHJldHVybiBjYWNoZWRSb2xlcztcbiAgICB9XG4gIH1cblxuICAvLyBGaXJzdCBnZXQgdGhlIHJvbGUgaWRzIHRoaXMgdXNlciBpcyBkaXJlY3RseSBhIG1lbWJlciBvZlxuICBjb25zdCByZXN1bHRzID0gYXdhaXQgdGhpcy5nZXRSb2xlc0ZvclVzZXIoKTtcbiAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgIHRoaXMudXNlclJvbGVzID0gW107XG4gICAgdGhpcy5mZXRjaGVkUm9sZXMgPSB0cnVlO1xuICAgIHRoaXMucm9sZVByb21pc2UgPSBudWxsO1xuXG4gICAgdGhpcy5jYWNoZVJvbGVzKCk7XG4gICAgcmV0dXJuIHRoaXMudXNlclJvbGVzO1xuICB9XG5cbiAgY29uc3Qgcm9sZXNNYXAgPSByZXN1bHRzLnJlZHVjZShcbiAgICAobSwgcikgPT4ge1xuICAgICAgbS5uYW1lcy5wdXNoKHIubmFtZSk7XG4gICAgICBtLmlkcy5wdXNoKHIub2JqZWN0SWQpO1xuICAgICAgcmV0dXJuIG07XG4gICAgfSxcbiAgICB7IGlkczogW10sIG5hbWVzOiBbXSB9XG4gICk7XG5cbiAgLy8gcnVuIHRoZSByZWN1cnNpdmUgZmluZGluZ1xuICBjb25zdCByb2xlTmFtZXMgPSBhd2FpdCB0aGlzLl9nZXRBbGxSb2xlc05hbWVzRm9yUm9sZUlkcyhyb2xlc01hcC5pZHMsIHJvbGVzTWFwLm5hbWVzKTtcbiAgdGhpcy51c2VyUm9sZXMgPSByb2xlTmFtZXMubWFwKHIgPT4ge1xuICAgIHJldHVybiAncm9sZTonICsgcjtcbiAgfSk7XG4gIHRoaXMuZmV0Y2hlZFJvbGVzID0gdHJ1ZTtcbiAgdGhpcy5yb2xlUHJvbWlzZSA9IG51bGw7XG4gIHRoaXMuY2FjaGVSb2xlcygpO1xuICByZXR1cm4gdGhpcy51c2VyUm9sZXM7XG59O1xuXG5BdXRoLnByb3RvdHlwZS5jYWNoZVJvbGVzID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuY2FjaGVDb250cm9sbGVyKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHRoaXMuY2FjaGVDb250cm9sbGVyLnJvbGUucHV0KHRoaXMudXNlci5pZCwgQXJyYXkoLi4udGhpcy51c2VyUm9sZXMpKTtcbiAgcmV0dXJuIHRydWU7XG59O1xuXG5BdXRoLnByb3RvdHlwZS5jbGVhclJvbGVDYWNoZSA9IGZ1bmN0aW9uIChzZXNzaW9uVG9rZW4pIHtcbiAgaWYgKCF0aGlzLmNhY2hlQ29udHJvbGxlcikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICB0aGlzLmNhY2hlQ29udHJvbGxlci5yb2xlLmRlbCh0aGlzLnVzZXIuaWQpO1xuICB0aGlzLmNhY2hlQ29udHJvbGxlci51c2VyLmRlbChzZXNzaW9uVG9rZW4pO1xuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkF1dGgucHJvdG90eXBlLmdldFJvbGVzQnlJZHMgPSBhc3luYyBmdW5jdGlvbiAoaW5zKSB7XG4gIGNvbnN0IHJlc3VsdHMgPSBbXTtcbiAgLy8gQnVpbGQgYW4gT1IgcXVlcnkgYWNyb3NzIGFsbCBwYXJlbnRSb2xlc1xuICBpZiAoIXRoaXMuY29uZmlnKSB7XG4gICAgYXdhaXQgbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlJvbGUpXG4gICAgICAuY29udGFpbmVkSW4oXG4gICAgICAgICdyb2xlcycsXG4gICAgICAgIGlucy5tYXAoaWQgPT4ge1xuICAgICAgICAgIGNvbnN0IHJvbGUgPSBuZXcgUGFyc2UuT2JqZWN0KFBhcnNlLlJvbGUpO1xuICAgICAgICAgIHJvbGUuaWQgPSBpZDtcbiAgICAgICAgICByZXR1cm4gcm9sZTtcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5lYWNoKHJlc3VsdCA9PiByZXN1bHRzLnB1c2gocmVzdWx0LnRvSlNPTigpKSwgeyB1c2VNYXN0ZXJLZXk6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgcm9sZXMgPSBpbnMubWFwKGlkID0+IHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfUm9sZScsXG4gICAgICAgIG9iamVjdElkOiBpZCxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgY29uc3QgcmVzdFdoZXJlID0geyByb2xlczogeyAkaW46IHJvbGVzIH0gfTtcbiAgICBjb25zdCBSZXN0UXVlcnkgPSByZXF1aXJlKCcuL1Jlc3RRdWVyeScpO1xuICAgIGNvbnN0IHF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICAgIG1ldGhvZDogUmVzdFF1ZXJ5Lk1ldGhvZC5maW5kLFxuICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgIHJ1bkJlZm9yZUZpbmQ6IGZhbHNlLFxuICAgICAgYXV0aDogbWFzdGVyKHRoaXMuY29uZmlnKSxcbiAgICAgIGNsYXNzTmFtZTogJ19Sb2xlJyxcbiAgICAgIHJlc3RXaGVyZSxcbiAgICB9KTtcbiAgICBhd2FpdCBxdWVyeS5lYWNoKHJlc3VsdCA9PiByZXN1bHRzLnB1c2gocmVzdWx0KSk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdHM7XG59O1xuXG4vLyBHaXZlbiBhIGxpc3Qgb2Ygcm9sZUlkcywgZmluZCBhbGwgdGhlIHBhcmVudCByb2xlcywgcmV0dXJucyBhIHByb21pc2Ugd2l0aCBhbGwgbmFtZXNcbkF1dGgucHJvdG90eXBlLl9nZXRBbGxSb2xlc05hbWVzRm9yUm9sZUlkcyA9IGZ1bmN0aW9uIChcbiAgcm9sZUlEcyxcbiAgbmFtZXMgPSBbXSxcbiAgcXVlcmllZFJvbGVzID0gbmV3IFNldCgpXG4pIHtcbiAgY29uc3QgaW5zID0gcm9sZUlEcy5maWx0ZXIocm9sZUlEID0+IHtcbiAgICBpZiAocXVlcmllZFJvbGVzLmhhcyhyb2xlSUQpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHF1ZXJpZWRSb2xlcy5hZGQocm9sZUlEKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSk7XG5cbiAgLy8gYWxsIHJvbGVzIGFyZSBhY2NvdW50ZWQgZm9yLCByZXR1cm4gdGhlIG5hbWVzXG4gIGlmIChpbnMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFsuLi5uZXcgU2V0KG5hbWVzKV0pO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMuZ2V0Um9sZXNCeUlkcyhpbnMpXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAvLyBOb3RoaW5nIGZvdW5kXG4gICAgICBpZiAoIXJlc3VsdHMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUobmFtZXMpO1xuICAgICAgfVxuICAgICAgLy8gTWFwIHRoZSByZXN1bHRzIHdpdGggYWxsIElkcyBhbmQgbmFtZXNcbiAgICAgIGNvbnN0IHJlc3VsdE1hcCA9IHJlc3VsdHMucmVkdWNlKFxuICAgICAgICAobWVtbywgcm9sZSkgPT4ge1xuICAgICAgICAgIG1lbW8ubmFtZXMucHVzaChyb2xlLm5hbWUpO1xuICAgICAgICAgIG1lbW8uaWRzLnB1c2gocm9sZS5vYmplY3RJZCk7XG4gICAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICAgIH0sXG4gICAgICAgIHsgaWRzOiBbXSwgbmFtZXM6IFtdIH1cbiAgICAgICk7XG4gICAgICAvLyBzdG9yZSB0aGUgbmV3IGZvdW5kIG5hbWVzXG4gICAgICBuYW1lcyA9IG5hbWVzLmNvbmNhdChyZXN1bHRNYXAubmFtZXMpO1xuICAgICAgLy8gZmluZCB0aGUgbmV4dCBvbmVzLCBjaXJjdWxhciByb2xlcyB3aWxsIGJlIGN1dFxuICAgICAgcmV0dXJuIHRoaXMuX2dldEFsbFJvbGVzTmFtZXNGb3JSb2xlSWRzKHJlc3VsdE1hcC5pZHMsIG5hbWVzLCBxdWVyaWVkUm9sZXMpO1xuICAgIH0pXG4gICAgLnRoZW4obmFtZXMgPT4ge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbLi4ubmV3IFNldChuYW1lcyldKTtcbiAgICB9KTtcbn07XG5cbmNvbnN0IGZpbmRVc2Vyc1dpdGhBdXRoRGF0YSA9IGFzeW5jIChjb25maWcsIGF1dGhEYXRhLCBiZWZvcmVGaW5kLCBjdXJyZW50VXNlckF1dGhEYXRhKSA9PiB7XG4gIGNvbnN0IHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcblxuICBjb25zdCBxdWVyaWVzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgcHJvdmlkZXJzLm1hcChhc3luYyBwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckF1dGhEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdO1xuXG4gICAgICAvLyBTa2lwIHByb3ZpZGVycyBiZWluZyB1bmxpbmtlZCAobnVsbCB2YWx1ZSlcbiAgICAgIGlmIChwcm92aWRlckF1dGhEYXRhID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuXG4gICAgICAvLyBTa2lwIGJlZm9yZUZpbmQgb25seSB3aGVuIGluY29taW5nIGRhdGEgaXMgY29uZmlybWVkIHVuY2hhbmdlZCBmcm9tIHN0b3JlZCBkYXRhLlxuICAgICAgLy8gVGhpcyBoYW5kbGVzIGVjaG9lZC1iYWNrIGF1dGhEYXRhIGZyb20gYWZ0ZXJGaW5kIChlLmcuIGNsaWVudCBzZW5kcyBiYWNrIHsgaWQ6ICd4JyB9XG4gICAgICAvLyBhbG9uZ3NpZGUgYSBwcm92aWRlciB1bmxpbmspLiBPbiBsb2dpbi9zaWdudXAsIGN1cnJlbnRVc2VyQXV0aERhdGEgaXMgdW5kZWZpbmVkIHNvXG4gICAgICAvLyBiZWZvcmVGaW5kIGFsd2F5cyBydW5zLCBwcmVzZXJ2aW5nIGl0IGFzIHRoZSBzZWN1cml0eSBnYXRlIGZvciBtaXNzaW5nIGNyZWRlbnRpYWxzLlxuICAgICAgY29uc3Qgc3RvcmVkUHJvdmlkZXJEYXRhID0gY3VycmVudFVzZXJBdXRoRGF0YT8uW3Byb3ZpZGVyXTtcbiAgICAgIGNvbnN0IGluY29taW5nS2V5cyA9IE9iamVjdC5rZXlzKHByb3ZpZGVyQXV0aERhdGEgfHwge30pO1xuICAgICAgY29uc3QgaXNVbmNoYW5nZWQgPSBzdG9yZWRQcm92aWRlckRhdGEgJiYgaW5jb21pbmdLZXlzLmxlbmd0aCA+IDAgJiZcbiAgICAgICAgIWluY29taW5nS2V5cy5zb21lKGtleSA9PiAhaXNEZWVwU3RyaWN0RXF1YWwocHJvdmlkZXJBdXRoRGF0YVtrZXldLCBzdG9yZWRQcm92aWRlckRhdGFba2V5XSkpO1xuXG4gICAgICBjb25zdCB2YWxpZGF0b3JDb25maWcgPSBjb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKHByb3ZpZGVyKTtcbiAgICAgIC8vIFNraXAgZGF0YWJhc2UgcXVlcnkgZm9yIHVuY29uZmlndXJlZCBwcm92aWRlcnMgdG8gYXZvaWQgdW5pbmRleGVkIGNvbGxlY3Rpb24gc2NhbnM7XG4gICAgICAvLyB0aGUgcHJvdmlkZXIgd2lsbCBiZSByZWplY3RlZCBsYXRlciBpbiBoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24gd2l0aCBVTlNVUFBPUlRFRF9TRVJWSUNFXG4gICAgICBpZiAoIXZhbGlkYXRvckNvbmZpZz8udmFsaWRhdG9yKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgYWRhcHRlciA9IHZhbGlkYXRvckNvbmZpZy5hZGFwdGVyO1xuICAgICAgaWYgKGJlZm9yZUZpbmQgJiYgdHlwZW9mIGFkYXB0ZXI/LmJlZm9yZUZpbmQgPT09ICdmdW5jdGlvbicgJiYgIWlzVW5jaGFuZ2VkKSB7XG4gICAgICAgIGF3YWl0IGFkYXB0ZXIuYmVmb3JlRmluZChwcm92aWRlckF1dGhEYXRhKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFwcm92aWRlckF1dGhEYXRhPy5pZCkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHR5cGVvZiBwcm92aWRlckF1dGhEYXRhLmlkICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9WQUxVRSwgYEludmFsaWQgYXV0aERhdGEgaWQgZm9yIHByb3ZpZGVyICcke3Byb3ZpZGVyfScuYCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IFtgYXV0aERhdGEuJHtwcm92aWRlcn0uaWRgXTogcHJvdmlkZXJBdXRoRGF0YS5pZCB9O1xuICAgIH0pXG4gICk7XG5cbiAgLy8gRmlsdGVyIG91dCBudWxsIHF1ZXJpZXNcbiAgY29uc3QgdmFsaWRRdWVyaWVzID0gcXVlcmllcy5maWx0ZXIocXVlcnkgPT4gcXVlcnkgIT09IG51bGwpO1xuXG4gIGlmICghdmFsaWRRdWVyaWVzLmxlbmd0aCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIC8vIFBlcmZvcm0gZGF0YWJhc2UgcXVlcnlcbiAgcmV0dXJuIGNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHsgJG9yOiB2YWxpZFF1ZXJpZXMgfSwgeyBsaW1pdDogMiB9KTtcbn07XG5cbmNvbnN0IGhhc011dGF0ZWRBdXRoRGF0YSA9IChhdXRoRGF0YSwgdXNlckF1dGhEYXRhKSA9PiB7XG4gIGlmICghdXNlckF1dGhEYXRhKSB7IHJldHVybiB7IGhhc011dGF0ZWRBdXRoRGF0YTogdHJ1ZSwgbXV0YXRlZEF1dGhEYXRhOiBhdXRoRGF0YSB9OyB9XG4gIGNvbnN0IG11dGF0ZWRBdXRoRGF0YSA9IHt9O1xuICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgLy8gQW5vbnltb3VzIHByb3ZpZGVyIGlzIG5vdCBoYW5kbGVkIHRoaXMgd2F5XG4gICAgaWYgKHByb3ZpZGVyID09PSAnYW5vbnltb3VzJykgeyByZXR1cm47IH1cbiAgICBjb25zdCBwcm92aWRlckRhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl07XG4gICAgY29uc3QgdXNlclByb3ZpZGVyQXV0aERhdGEgPSB1c2VyQXV0aERhdGFbcHJvdmlkZXJdO1xuXG4gICAgLy8gSWYgdW5saW5raW5nIChzZXR0aW5nIHRvIG51bGwpLCBjb25zaWRlciBpdCBtdXRhdGVkXG4gICAgaWYgKHByb3ZpZGVyRGF0YSA9PT0gbnVsbCkge1xuICAgICAgbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXSA9IHByb3ZpZGVyRGF0YTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBJZiBwcm92aWRlciBkb2Vzbid0IGV4aXN0IGluIHN0b3JlZCBkYXRhLCBpdCdzIG5ld1xuICAgIGlmICghdXNlclByb3ZpZGVyQXV0aERhdGEpIHtcbiAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl0gPSBwcm92aWRlckRhdGE7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgaW5jb21pbmcgZGF0YSByZXByZXNlbnRzIGFjdHVhbCBjaGFuZ2VzIHZzIGp1c3QgZWNob2luZyBiYWNrXG4gICAgLy8gd2hhdCBhZnRlckZpbmQgcmV0dXJuZWQuIElmIGluY29taW5nIGRhdGEgaXMgYSBzdWJzZXQgb2Ygc3RvcmVkIGRhdGFcbiAgICAvLyAoYWxsIGluY29taW5nIGZpZWxkcyBtYXRjaCBzdG9yZWQgdmFsdWVzKSwgaXQncyBub3QgbXV0YXRlZC5cbiAgICAvLyBJZiBpbmNvbWluZyBkYXRhIGhhcyBkaWZmZXJlbnQgdmFsdWVzIG9yIGZpZWxkcyBub3QgaW4gc3RvcmVkIGRhdGEsIGl0J3MgbXV0YXRlZC5cbiAgICAvLyBUaGlzIGhhbmRsZXMgdGhlIGNhc2Ugd2hlcmUgYWZ0ZXJGaW5kIHN0cmlwcyBzZW5zaXRpdmUgZmllbGRzIGxpa2UgJ2NvZGUnOlxuICAgIC8vIC0gSW5jb21pbmc6IHsgaWQ6ICd4JyB9LCBTdG9yZWQ6IHsgaWQ6ICd4JywgY29kZTogJ3NlY3JldCcgfSAtPiBOT1QgbXV0YXRlZCAoc3Vic2V0KVxuICAgIC8vIC0gSW5jb21pbmc6IHsgaWQ6ICd4JywgdG9rZW46ICduZXcnIH0sIFN0b3JlZDogeyBpZDogJ3gnLCB0b2tlbjogJ29sZCcgfSAtPiBNVVRBVEVEXG4gICAgY29uc3QgaW5jb21pbmdLZXlzID0gT2JqZWN0LmtleXMocHJvdmlkZXJEYXRhIHx8IHt9KTtcbiAgICBjb25zdCBoYXNDaGFuZ2VzID0gaW5jb21pbmdLZXlzLnNvbWUoa2V5ID0+IHtcbiAgICAgIHJldHVybiAhaXNEZWVwU3RyaWN0RXF1YWwocHJvdmlkZXJEYXRhW2tleV0sIHVzZXJQcm92aWRlckF1dGhEYXRhW2tleV0pO1xuICAgIH0pO1xuXG4gICAgaWYgKGhhc0NoYW5nZXMpIHtcbiAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl0gPSBwcm92aWRlckRhdGE7XG4gICAgfVxuICB9KTtcbiAgY29uc3QgaGFzTXV0YXRlZEF1dGhEYXRhID0gT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5sZW5ndGggIT09IDA7XG4gIHJldHVybiB7IGhhc011dGF0ZWRBdXRoRGF0YSwgbXV0YXRlZEF1dGhEYXRhIH07XG59O1xuXG5jb25zdCBjaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luID0gKFxuICByZXEgPSB7fSxcbiAgYXV0aERhdGEgPSB7fSxcbiAgdXNlckF1dGhEYXRhID0ge30sXG4gIGNvbmZpZ1xuKSA9PiB7XG4gIGNvbnN0IHNhdmVkVXNlclByb3ZpZGVycyA9IE9iamVjdC5rZXlzKHVzZXJBdXRoRGF0YSlcbiAgICAubWFwKHByb3ZpZGVyID0+IHtcbiAgICAgIGNvbnN0IHZhbGlkYXRvciA9IGNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuICAgICAgaWYgKCF2YWxpZGF0b3IgfHwgIXZhbGlkYXRvci5hZGFwdGVyKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgbmFtZTogcHJvdmlkZXIsIGFkYXB0ZXI6IHZhbGlkYXRvci5hZGFwdGVyIH07XG4gICAgfSlcbiAgICAuZmlsdGVyKEJvb2xlYW4pO1xuXG4gIGNvbnN0IGhhc1Byb3ZpZGVkQVNvbG9Qcm92aWRlciA9IHNhdmVkVXNlclByb3ZpZGVycy5zb21lKFxuICAgIHByb3ZpZGVyID0+XG4gICAgICBwcm92aWRlciAmJiBwcm92aWRlci5hZGFwdGVyICYmIHByb3ZpZGVyLmFkYXB0ZXIucG9saWN5ID09PSAnc29sbycgJiYgYXV0aERhdGFbcHJvdmlkZXIubmFtZV1cbiAgKTtcblxuICAvLyBTb2xvIHByb3ZpZGVycyBjYW4gYmUgY29uc2lkZXJlZCBhcyBzYWZlLCBzbyB3ZSBkbyBub3QgaGF2ZSB0byBjaGVjayBpZiB0aGUgdXNlciBuZWVkc1xuICAvLyB0byBwcm92aWRlIGFuIGFkZGl0aW9uYWwgcHJvdmlkZXIgdG8gbG9naW4uIEFuIGF1dGggYWRhcHRlciB3aXRoIFwic29sb1wiIChsaWtlIHdlYmF1dGhuKSBtZWFuc1xuICAvLyBubyBcImFkZGl0aW9uYWxcIiBhdXRoIG5lZWRzIHRvIGJlIHByb3ZpZGVkIHRvIGxvZ2luIChsaWtlIE9UUCwgTUZBKVxuICBpZiAoaGFzUHJvdmlkZWRBU29sb1Byb3ZpZGVyKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25Qcm92aWRlcnNOb3RGb3VuZCA9IFtdO1xuICBjb25zdCBoYXNQcm92aWRlZEF0TGVhc3RPbmVBZGRpdGlvbmFsUHJvdmlkZXIgPSBzYXZlZFVzZXJQcm92aWRlcnMuc29tZShwcm92aWRlciA9PiB7XG4gICAgbGV0IHBvbGljeSA9IHByb3ZpZGVyLmFkYXB0ZXIucG9saWN5O1xuICAgIGlmICh0eXBlb2YgcG9saWN5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjb25zdCByZXF1ZXN0T2JqZWN0ID0ge1xuICAgICAgICBpcDogcmVxLmNvbmZpZy5pcCxcbiAgICAgICAgdXNlcjogcmVxLmF1dGgudXNlcixcbiAgICAgICAgbWFzdGVyOiByZXEuYXV0aC5pc01hc3RlcixcbiAgICAgIH07XG4gICAgICBwb2xpY3kgPSBwb2xpY3kuY2FsbChwcm92aWRlci5hZGFwdGVyLCByZXF1ZXN0T2JqZWN0LCB1c2VyQXV0aERhdGFbcHJvdmlkZXIubmFtZV0pO1xuICAgIH1cbiAgICBpZiAocG9saWN5ID09PSAnYWRkaXRpb25hbCcpIHtcbiAgICAgIGlmIChhdXRoRGF0YVtwcm92aWRlci5uYW1lXSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFB1c2ggbWlzc2luZyBwcm92aWRlciBmb3IgZXJyb3IgbWVzc2FnZVxuICAgICAgICBhZGRpdGlvblByb3ZpZGVyc05vdEZvdW5kLnB1c2gocHJvdmlkZXIubmFtZSk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgaWYgKGhhc1Byb3ZpZGVkQXRMZWFzdE9uZUFkZGl0aW9uYWxQcm92aWRlciB8fCAhYWRkaXRpb25Qcm92aWRlcnNOb3RGb3VuZC5sZW5ndGgpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsXG4gICAgYE1pc3NpbmcgYWRkaXRpb25hbCBhdXRoRGF0YSAke2FkZGl0aW9uUHJvdmlkZXJzTm90Rm91bmQuam9pbignLCcpfWBcbiAgKTtcbn07XG5cbi8vIFZhbGlkYXRlIGVhY2ggYXV0aERhdGEgc3RlcC1ieS1zdGVwIGFuZCByZXR1cm4gdGhlIHByb3ZpZGVyIHJlc3BvbnNlc1xuY29uc3QgaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uID0gYXN5bmMgKGF1dGhEYXRhLCByZXEsIGZvdW5kVXNlciwgeyBpc0xvZ2luID0gdHJ1ZSB9ID0ge30pID0+IHtcbiAgbGV0IHVzZXI7XG4gIGlmIChmb3VuZFVzZXIpIHtcbiAgICB1c2VyID0gUGFyc2UuVXNlci5mcm9tSlNPTih7IGNsYXNzTmFtZTogJ19Vc2VyJywgLi4uZm91bmRVc2VyIH0pO1xuICAgIC8vIEZpbmQgdXNlciBieSBzZXNzaW9uIGFuZCBjdXJyZW50IG9iamVjdElkOyBvbmx5IHBhc3MgdXNlciBpZiBpdCdzIHRoZSBjdXJyZW50IHVzZXIgb3IgbWFzdGVyIGtleSBpcyBwcm92aWRlZFxuICB9IGVsc2UgaWYgKFxuICAgIChyZXEuYXV0aCAmJlxuICAgICAgcmVxLmF1dGgudXNlciAmJlxuICAgICAgdHlwZW9mIHJlcS5nZXRVc2VySWQgPT09ICdmdW5jdGlvbicgJiZcbiAgICAgIHJlcS5nZXRVc2VySWQoKSA9PT0gcmVxLmF1dGgudXNlci5pZCkgfHxcbiAgICAocmVxLmF1dGggJiYgcmVxLmF1dGguaXNNYXN0ZXIgJiYgdHlwZW9mIHJlcS5nZXRVc2VySWQgPT09ICdmdW5jdGlvbicgJiYgcmVxLmdldFVzZXJJZCgpKVxuICApIHtcbiAgICB1c2VyID0gbmV3IFBhcnNlLlVzZXIoKTtcbiAgICB1c2VyLmlkID0gcmVxLmF1dGguaXNNYXN0ZXIgPyByZXEuZ2V0VXNlcklkKCkgOiByZXEuYXV0aC51c2VyLmlkO1xuICAgIGF3YWl0IHVzZXIuZmV0Y2goeyB1c2VNYXN0ZXJLZXk6IHRydWUgfSk7XG4gIH1cblxuICBjb25zdCB7IHVwZGF0ZWRPYmplY3QgfSA9IHJlcS5idWlsZFBhcnNlT2JqZWN0cygpO1xuICBjb25zdCByZXF1ZXN0T2JqZWN0ID0gZ2V0UmVxdWVzdE9iamVjdCh1bmRlZmluZWQsIHJlcS5hdXRoLCB1cGRhdGVkT2JqZWN0LCB1c2VyLCByZXEuY29uZmlnKTtcbiAgLy8gUGVyZm9ybSB2YWxpZGF0aW9uIGFzIHN0ZXAtYnktc3RlcCBwaXBlbGluZSBmb3IgYmV0dGVyIGVycm9yIGNvbnNpc3RlbmN5XG4gIC8vIGFuZCBhbHNvIHRvIGF2b2lkIHRvIHRyaWdnZXIgYSBwcm92aWRlciAobGlrZSBPVFAgU01TKSBpZiBhbm90aGVyIG9uZSBmYWlsc1xuICBjb25zdCBhY2MgPSB7IGF1dGhEYXRhOiB7fSwgYXV0aERhdGFSZXNwb25zZToge30gfTtcbiAgY29uc3QgYXV0aEtleXMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkuc29ydCgpO1xuICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIGF1dGhLZXlzKSB7XG4gICAgbGV0IG1ldGhvZCA9ICcnO1xuICAgIHRyeSB7XG4gICAgICBpZiAoYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgIGFjYy5hdXRoRGF0YVtwcm92aWRlcl0gPSBudWxsO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHsgdmFsaWRhdG9yIH0gPSByZXEuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5nZXRWYWxpZGF0b3JGb3JQcm92aWRlcihwcm92aWRlcikgfHwge307XG4gICAgICBjb25zdCBhdXRoUHJvdmlkZXIgPSAocmVxLmNvbmZpZy5hdXRoIHx8IHt9KVtwcm92aWRlcl0gfHwge307XG4gICAgICBpZiAoIXZhbGlkYXRvciB8fCBhdXRoUHJvdmlkZXIuZW5hYmxlZCA9PT0gZmFsc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGxldCB2YWxpZGF0aW9uUmVzdWx0ID0gYXdhaXQgdmFsaWRhdG9yKGF1dGhEYXRhW3Byb3ZpZGVyXSwgcmVxLCB1c2VyLCByZXF1ZXN0T2JqZWN0LCB7XG4gICAgICAgIGlzTG9naW4sXG4gICAgICB9KTtcbiAgICAgIG1ldGhvZCA9IHZhbGlkYXRpb25SZXN1bHQgJiYgdmFsaWRhdGlvblJlc3VsdC5tZXRob2Q7XG4gICAgICByZXF1ZXN0T2JqZWN0LnRyaWdnZXJOYW1lID0gbWV0aG9kO1xuICAgICAgaWYgKHZhbGlkYXRpb25SZXN1bHQgJiYgdmFsaWRhdGlvblJlc3VsdC52YWxpZGF0b3IpIHtcbiAgICAgICAgdmFsaWRhdGlvblJlc3VsdCA9IGF3YWl0IHZhbGlkYXRpb25SZXN1bHQudmFsaWRhdG9yKCk7XG4gICAgICB9XG4gICAgICBpZiAoIXZhbGlkYXRpb25SZXN1bHQpIHtcbiAgICAgICAgYWNjLmF1dGhEYXRhW3Byb3ZpZGVyXSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoIU9iamVjdC5rZXlzKHZhbGlkYXRpb25SZXN1bHQpLmxlbmd0aCkge1xuICAgICAgICBhY2MuYXV0aERhdGFbcHJvdmlkZXJdID0gYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKHZhbGlkYXRpb25SZXN1bHQucmVzcG9uc2UpIHtcbiAgICAgICAgYWNjLmF1dGhEYXRhUmVzcG9uc2VbcHJvdmlkZXJdID0gdmFsaWRhdGlvblJlc3VsdC5yZXNwb25zZTtcbiAgICAgIH1cbiAgICAgIC8vIFNvbWUgYXV0aCBwcm92aWRlcnMgYWZ0ZXIgaW5pdGlhbGl6YXRpb24gd2lsbCBhdm9pZCB0byByZXBsYWNlIGF1dGhEYXRhIGFscmVhZHkgc3RvcmVkXG4gICAgICBpZiAoIXZhbGlkYXRpb25SZXN1bHQuZG9Ob3RTYXZlKSB7XG4gICAgICAgIGFjYy5hdXRoRGF0YVtwcm92aWRlcl0gPSB2YWxpZGF0aW9uUmVzdWx0LnNhdmUgfHwgYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZSA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgbWVzc2FnZTogJ0F1dGggZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHVzZXJTdHJpbmcgPVxuICAgICAgICByZXEuYXV0aCAmJiByZXEuYXV0aC51c2VyID8gcmVxLmF1dGgudXNlci5pZCA6IHJlcS5kYXRhLm9iamVjdElkIHx8IHVuZGVmaW5lZDtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgYEZhaWxlZCBydW5uaW5nIGF1dGggc3RlcCAke21ldGhvZH0gZm9yICR7cHJvdmlkZXJ9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aCBFcnJvcjogYCArXG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZSksXG4gICAgICAgIHtcbiAgICAgICAgICBhdXRoZW50aWNhdGlvblN0ZXA6IG1ldGhvZCxcbiAgICAgICAgICBlcnJvcjogZSxcbiAgICAgICAgICB1c2VyOiB1c2VyU3RyaW5nLFxuICAgICAgICAgIHByb3ZpZGVyLFxuICAgICAgICB9XG4gICAgICApO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFjYztcbn07XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBBdXRoLFxuICBtYXN0ZXIsXG4gIG1haW50ZW5hbmNlLFxuICBub2JvZHksXG4gIHJlYWRPbmx5LFxuICBzaG91bGRVcGRhdGVTZXNzaW9uRXhwaXJ5LFxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuLFxuICBnZXRBdXRoRm9yTGVnYWN5U2Vzc2lvblRva2VuLFxuICBmaW5kVXNlcnNXaXRoQXV0aERhdGEsXG4gIGhhc011dGF0ZWRBdXRoRGF0YSxcbiAgY2hlY2tJZlVzZXJIYXNQcm92aWRlZENvbmZpZ3VyZWRQcm92aWRlcnNGb3JMb2dpbixcbiAgaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uLFxufTtcbiJdLCJtYXBwaW5ncyI6Ijs7QUFDQSxJQUFBQSxLQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxTQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxTQUFBLEdBQUFILE9BQUE7QUFDQSxJQUFBSSxVQUFBLEdBQUFDLHNCQUFBLENBQUFMLE9BQUE7QUFDQSxJQUFBTSxVQUFBLEdBQUFELHNCQUFBLENBQUFMLE9BQUE7QUFBb0MsU0FBQUssdUJBQUFFLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFO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