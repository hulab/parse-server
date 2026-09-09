"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Types = void 0;
exports._unregisterAll = _unregisterAll;
exports.addConnectTrigger = addConnectTrigger;
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.addTrigger = addTrigger;
exports.getClassName = getClassName;
exports.getFunction = getFunction;
exports.getFunctionNames = getFunctionNames;
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.getRequestFileObject = getRequestFileObject;
exports.getRequestObject = getRequestObject;
exports.getRequestQueryObject = getRequestQueryObject;
exports.getResponseObject = getResponseObject;
exports.getTrigger = getTrigger;
exports.getValidator = getValidator;
exports.inflate = inflate;
exports.maybeRunAfterFindTrigger = maybeRunAfterFindTrigger;
exports.maybeRunFileTrigger = maybeRunFileTrigger;
exports.maybeRunGlobalConfigTrigger = maybeRunGlobalConfigTrigger;
exports.maybeRunQueryTrigger = maybeRunQueryTrigger;
exports.maybeRunTrigger = maybeRunTrigger;
exports.maybeRunValidator = maybeRunValidator;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports.resolveError = resolveError;
exports.runLiveQueryEventHandlers = runLiveQueryEventHandlers;
exports.runTrigger = runTrigger;
exports.toJSONwithObjects = toJSONwithObjects;
exports.triggerExists = triggerExists;
var _node = _interopRequireDefault(require("parse/node"));
var _logger = require("./logger");
var _Utils = _interopRequireDefault(require("./Utils"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// triggers.js

const Types = exports.Types = {
  beforeLogin: 'beforeLogin',
  afterLogin: 'afterLogin',
  afterLogout: 'afterLogout',
  beforePasswordResetRequest: 'beforePasswordResetRequest',
  beforeSave: 'beforeSave',
  afterSave: 'afterSave',
  beforeDelete: 'beforeDelete',
  afterDelete: 'afterDelete',
  beforeFind: 'beforeFind',
  afterFind: 'afterFind',
  beforeConnect: 'beforeConnect',
  beforeSubscribe: 'beforeSubscribe',
  afterEvent: 'afterEvent'
};
const ConnectClassName = '@Connect';

/**
 * Creates a prototype-free object for use as a lookup store.
 * This prevents prototype chain properties (e.g. `constructor`, `toString`)
 * from being resolved as registered handlers when using bracket notation
 * for lookups. Always use this instead of `{}` for handler stores.
 */
function createStore() {
  return Object.create(null);
}
const baseStore = function () {
  const Validators = Object.keys(Types).reduce(function (base, key) {
    base[key] = createStore();
    return base;
  }, createStore());
  const Functions = createStore();
  const Jobs = createStore();
  const LiveQuery = [];
  const Triggers = Object.keys(Types).reduce(function (base, key) {
    base[key] = createStore();
    return base;
  }, createStore());
  return Object.freeze({
    Functions,
    Jobs,
    Validators,
    Triggers,
    LiveQuery
  });
};
function getClassName(parseClass) {
  if (parseClass && parseClass.className) {
    return parseClass.className;
  }
  if (parseClass && parseClass.name) {
    return parseClass.name.replace('Parse', '@');
  }
  return parseClass;
}
function validateClassNameForTriggers(className, type) {
  if (type == Types.beforeSave && className === '_PushStatus') {
    // _PushStatus uses undocumented nested key increment ops
    // allowing beforeSave would mess up the objects big time
    // TODO: Allow proper documented way of using nested increment ops
    throw 'Only afterSave is allowed on _PushStatus';
  }
  if ((type === Types.beforeLogin || type === Types.afterLogin || type === Types.beforePasswordResetRequest) && className !== '_User') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _User class is allowed for the beforeLogin, afterLogin, and beforePasswordResetRequest triggers';
  }
  if (type === Types.afterLogout && className !== '_Session') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _Session class is allowed for the afterLogout trigger.';
  }
  if (className === '_Session' && type !== Types.afterLogout) {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the afterLogout trigger is allowed for the _Session class.';
  }
  return className;
}
const _triggerStore = Object.create(null);
const Category = {
  Functions: 'Functions',
  Validators: 'Validators',
  Jobs: 'Jobs',
  Triggers: 'Triggers'
};
function getStore(category, name, applicationId) {
  const invalidNameRegex = /['"`]/;
  if (invalidNameRegex.test(name)) {
    // Prevent a malicious user from injecting properties into the store
    return createStore();
  }
  const path = name.split('.');
  path.splice(-1); // remove last component
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  let store = _triggerStore[applicationId][category];
  for (const component of path) {
    if (!Object.prototype.hasOwnProperty.call(store, component)) {
      return createStore();
    }
    store = store[component];
    if (!store || Object.getPrototypeOf(store) !== null) {
      return createStore();
    }
  }
  return store;
}
function add(category, name, handler, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  if (store[lastComponent]) {
    _logger.logger.warn(`Warning: Duplicate cloud functions exist for ${lastComponent}. Only the last one will be used and the others will be ignored.`);
  }
  store[lastComponent] = handler;
}
function remove(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  delete store[lastComponent];
}
function get(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  if (!Object.prototype.hasOwnProperty.call(store, lastComponent)) {
    return undefined;
  }
  return store[lastComponent];
}
function addFunction(functionName, handler, validationHandler, applicationId) {
  add(Category.Functions, functionName, handler, applicationId);
  add(Category.Validators, functionName, validationHandler, applicationId);
}
function addJob(jobName, handler, applicationId) {
  add(Category.Jobs, jobName, handler, applicationId);
}
function addTrigger(type, className, handler, applicationId, validationHandler) {
  validateClassNameForTriggers(className, type);
  add(Category.Triggers, `${type}.${className}`, handler, applicationId);
  add(Category.Validators, `${type}.${className}`, validationHandler, applicationId);
}
function addConnectTrigger(type, handler, applicationId, validationHandler) {
  add(Category.Triggers, `${type}.${ConnectClassName}`, handler, applicationId);
  add(Category.Validators, `${type}.${ConnectClassName}`, validationHandler, applicationId);
}
function addLiveQueryEventHandler(handler, applicationId) {
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  _triggerStore[applicationId].LiveQuery.push(handler);
}
function removeFunction(functionName, applicationId) {
  remove(Category.Functions, functionName, applicationId);
}
function removeTrigger(type, className, applicationId) {
  remove(Category.Triggers, `${type}.${className}`, applicationId);
}
function _unregisterAll() {
  Object.keys(_triggerStore).forEach(appId => delete _triggerStore[appId]);
}
function toJSONwithObjects(object, className) {
  if (!object || !object.toJSON) {
    return {};
  }
  const toJSON = object.toJSON();
  const stateController = _node.default.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(object._getStateIdentifier());
  for (const key in pending) {
    const val = object.get(key);
    if (!val || !val._toFullJSON) {
      toJSON[key] = val;
      continue;
    }
    toJSON[key] = val._toFullJSON();
  }
  // Preserve original object's className if no override className is provided
  if (className) {
    toJSON.className = className;
  } else if (object.className && !toJSON.className) {
    toJSON.className = object.className;
  }
  return toJSON;
}
function getTrigger(className, triggerType, applicationId) {
  if (!applicationId) {
    throw 'Missing ApplicationID';
  }
  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}
async function runTrigger(trigger, name, request, auth) {
  if (!trigger) {
    return;
  }
  await maybeRunValidator(request, name, auth);
  if (request.skipWithMasterKey) {
    return;
  }
  return await trigger(request);
}
function triggerExists(className, type, applicationId) {
  return getTrigger(className, type, applicationId) != undefined;
}
function getFunction(functionName, applicationId) {
  return get(Category.Functions, functionName, applicationId);
}
function getFunctionNames(applicationId) {
  const store = _triggerStore[applicationId] && _triggerStore[applicationId][Category.Functions] || {};
  const functionNames = [];
  const extractFunctionNames = (namespace, store) => {
    Object.keys(store).forEach(name => {
      const value = store[name];
      if (namespace) {
        name = `${namespace}.${name}`;
      }
      if (typeof value === 'function') {
        functionNames.push(name);
      } else {
        extractFunctionNames(name, value);
      }
    });
  };
  extractFunctionNames(null, store);
  return functionNames;
}
function getJob(jobName, applicationId) {
  return get(Category.Jobs, jobName, applicationId);
}
function getJobs(applicationId) {
  var manager = _triggerStore[applicationId];
  if (manager && manager.Jobs) {
    return manager.Jobs;
  }
  return undefined;
}
function getValidator(functionName, applicationId) {
  return get(Category.Validators, functionName, applicationId);
}
function getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context, isGet) {
  const request = {
    triggerName: triggerType,
    object: parseObject,
    master: false,
    isReadOnly: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip,
    config
  };
  if (isGet !== undefined) {
    request.isGet = !!isGet;
  }
  if (originalParseObject) {
    request.original = originalParseObject;
  }
  if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete || triggerType === Types.beforeLogin || triggerType === Types.afterLogin || triggerType === Types.beforePasswordResetRequest || triggerType === Types.afterFind) {
    // Set a copy of the context on the request object.
    request.context = Object.assign(Object.create(null), context);
  }
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.isReadOnly) {
    request['isReadOnly'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}
function getRequestQueryObject(triggerType, auth, query, count, config, context, isGet) {
  isGet = !!isGet;
  var request = {
    triggerName: triggerType,
    query,
    master: false,
    isReadOnly: false,
    count,
    log: config.loggerController,
    isGet,
    headers: config.headers,
    ip: config.ip,
    context: context || {},
    config
  };
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.isReadOnly) {
    request['isReadOnly'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}

// Creates the response object, and uses the request object to pass data
// The API will call this with REST API formatted objects, this will
// transform them to Parse.Object instances expected by Cloud Code.
// Any changes made to the object in a beforeSave will be included.
function getResponseObject(request, resolve, reject) {
  return {
    success: function (response) {
      if (request.triggerName === Types.afterFind) {
        if (!response) {
          response = request.objects;
        }
        response = response.map(object => {
          return toJSONwithObjects(object);
        });
        return resolve(response);
      }
      // Use the JSON response
      if (response && typeof response === 'object' && !request.object.equals(response) && request.triggerName === Types.beforeSave) {
        return resolve(response);
      }
      if (response && typeof response === 'object' && request.triggerName === Types.afterSave) {
        return resolve(response);
      }
      if (request.triggerName === Types.afterSave) {
        return resolve();
      }
      response = {};
      if (request.triggerName === Types.beforeSave) {
        response['object'] = request.object._getSaveJSON();
        response['object']['objectId'] = request.object.id;
      }
      return resolve(response);
    },
    error: function (error) {
      const e = resolveError(error, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: 'Script failed. Unknown error.'
      });
      reject(e);
    }
  };
}
function userIdForLog(auth) {
  return auth && auth.user ? auth.user.id : undefined;
}
function logTriggerAfterHook(triggerType, className, input, auth, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = JSON.stringify(input);
  _logger.logger[logLevel](`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}
function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = JSON.stringify(input);
  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));
  _logger.logger[logLevel](`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput} Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}
function logTriggerErrorBeforeHook(triggerType, className, input, auth, error, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = JSON.stringify(input);
  _logger.logger[logLevel](`${triggerType} failed for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput} Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}
function maybeRunAfterFindTrigger(triggerType, auth, classNameQuery, objectsInput, config, query, context, isGet) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(classNameQuery, triggerType, config.applicationId);
    if (!trigger) {
      if (objectsInput && objectsInput.length > 0 && objectsInput[0] instanceof _node.default.Object) {
        return resolve(objectsInput.map(obj => toJSONwithObjects(obj)));
      }
      return resolve(objectsInput || []);
    }
    const request = getRequestObject(triggerType, auth, null, null, config, context, isGet);
    // Convert query parameter to Parse.Query instance
    if (query instanceof _node.default.Query) {
      request.query = query;
    } else if (typeof query === 'object' && query !== null) {
      const parseQueryInstance = new _node.default.Query(classNameQuery);
      if (query.where) {
        parseQueryInstance.withJSON(query);
      }
      request.query = parseQueryInstance;
    } else {
      request.query = new _node.default.Query(classNameQuery);
    }
    const {
      success,
      error
    } = getResponseObject(request, processedObjectsJSON => {
      resolve(processedObjectsJSON);
    }, errorData => {
      reject(errorData);
    });
    logTriggerSuccessBeforeHook(triggerType, classNameQuery, 'AfterFind Input (Pre-Transform)', JSON.stringify(objectsInput.map(o => o instanceof _node.default.Object ? o.id + ':' + o.className : o)), auth, config.logLevels.triggerBeforeSuccess);

    // Convert plain objects to Parse.Object instances for trigger
    request.objects = objectsInput.map(currentObject => {
      if (currentObject instanceof _node.default.Object) {
        return currentObject;
      }
      // Preserve the original className if it exists, otherwise use the query className
      const originalClassName = currentObject.className || classNameQuery;
      const tempObjectWithClassName = {
        ...currentObject,
        className: originalClassName
      };
      return _node.default.Object.fromJSON(tempObjectWithClassName);
    });
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${classNameQuery}`, auth);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return request.objects;
      }
      const responseFromTrigger = trigger(request);
      if (responseFromTrigger && typeof responseFromTrigger.then === 'function') {
        return responseFromTrigger.then(results => {
          return results;
        });
      }
      return responseFromTrigger;
    }).then(success, error);
  }).then(resultsAsJSON => {
    logTriggerAfterHook(triggerType, classNameQuery, JSON.stringify(resultsAsJSON), auth, config.logLevels.triggerAfter);
    return resultsAsJSON;
  });
}
function maybeRunQueryTrigger(triggerType, className, restWhere, restOptions, config, auth, context, isGet) {
  const trigger = getTrigger(className, triggerType, config.applicationId);
  if (!trigger) {
    return Promise.resolve({
      restWhere,
      restOptions
    });
  }
  const json = Object.assign({}, restOptions);
  json.where = restWhere;
  const parseQuery = new _node.default.Query(className);
  parseQuery.withJSON(json);
  let count = false;
  if (restOptions) {
    count = !!restOptions.count;
  }
  const requestObject = getRequestQueryObject(triggerType, auth, parseQuery, count, config, context, isGet);
  const promise = Promise.resolve().then(() => {
    return maybeRunValidator(requestObject, `${triggerType}.${className}`, auth);
  }).then(() => {
    if (requestObject.skipWithMasterKey) {
      return requestObject.query;
    }
    return trigger(requestObject);
  }).then(result => {
    let queryResult = parseQuery;
    if (result && result instanceof _node.default.Query) {
      queryResult = result;
    }
    const jsonQuery = queryResult.toJSON();
    if (jsonQuery.where) {
      restWhere = jsonQuery.where;
    }
    if (jsonQuery.limit) {
      restOptions = restOptions || {};
      restOptions.limit = jsonQuery.limit;
    }
    if (jsonQuery.skip) {
      restOptions = restOptions || {};
      restOptions.skip = jsonQuery.skip;
    }
    if (jsonQuery.include) {
      restOptions = restOptions || {};
      restOptions.include = jsonQuery.include;
    }
    if (jsonQuery.excludeKeys) {
      restOptions = restOptions || {};
      restOptions.excludeKeys = jsonQuery.excludeKeys;
    }
    if (jsonQuery.explain) {
      restOptions = restOptions || {};
      restOptions.explain = jsonQuery.explain;
    }
    if (jsonQuery.keys) {
      restOptions = restOptions || {};
      restOptions.keys = jsonQuery.keys;
    }
    if (jsonQuery.order) {
      restOptions = restOptions || {};
      restOptions.order = jsonQuery.order;
    }
    if (jsonQuery.hint) {
      restOptions = restOptions || {};
      restOptions.hint = jsonQuery.hint;
    }
    if (jsonQuery.comment) {
      restOptions = restOptions || {};
      restOptions.comment = jsonQuery.comment;
    }
    if (requestObject.readPreference) {
      restOptions = restOptions || {};
      restOptions.readPreference = requestObject.readPreference;
    }
    if (requestObject.includeReadPreference) {
      restOptions = restOptions || {};
      restOptions.includeReadPreference = requestObject.includeReadPreference;
    }
    if (requestObject.subqueryReadPreference) {
      restOptions = restOptions || {};
      restOptions.subqueryReadPreference = requestObject.subqueryReadPreference;
    }
    let objects = undefined;
    if (result instanceof _node.default.Object) {
      objects = [result];
    } else if (Array.isArray(result) && (!result.length || result.every(obj => obj instanceof _node.default.Object))) {
      objects = result;
    }
    return {
      restWhere,
      restOptions,
      objects
    };
  }, err => {
    const error = resolveError(err, {
      code: _node.default.Error.SCRIPT_FAILED,
      message: 'Script failed. Unknown error.'
    });
    throw error;
  });
  return promise;
}
function resolveError(message, defaultOpts) {
  if (!defaultOpts) {
    defaultOpts = {};
  }
  if (!message) {
    return new _node.default.Error(defaultOpts.code || _node.default.Error.SCRIPT_FAILED, defaultOpts.message || 'Script failed.');
  }
  if (message instanceof _node.default.Error) {
    return message;
  }
  const code = defaultOpts.code || _node.default.Error.SCRIPT_FAILED;
  // If it's an error, mark it as a script failed
  if (typeof message === 'string') {
    return new _node.default.Error(code, message);
  }
  const error = new _node.default.Error(code, message.message || message);
  if (_Utils.default.isNativeError(message)) {
    error.stack = message.stack;
  }
  return error;
}
function maybeRunValidator(request, functionName, auth) {
  const theValidator = getValidator(functionName, _node.default.applicationId);
  if (!theValidator) {
    return;
  }
  if (typeof theValidator === 'object' && theValidator.skipWithMasterKey && request.master) {
    request.skipWithMasterKey = true;
  }
  return new Promise((resolve, reject) => {
    return Promise.resolve().then(() => {
      return typeof theValidator === 'object' ? builtInTriggerValidator(theValidator, request, auth) : theValidator(request);
    }).then(() => {
      resolve();
    }).catch(e => {
      const error = resolveError(e, {
        code: _node.default.Error.VALIDATION_ERROR,
        message: 'Validation failed.'
      });
      reject(error);
    });
  });
}
async function builtInTriggerValidator(options, request, auth) {
  if (request.master && !options.validateMasterKey) {
    return;
  }
  let reqUser = request.user;
  if (!reqUser && request.object && request.object.className === '_User' && !request.object.existed()) {
    reqUser = request.object;
  }
  if ((options.requireUser || options.requireAnyUserRoles || options.requireAllUserRoles) && !reqUser) {
    throw 'Validation failed. Please login to continue.';
  }
  if (options.requireMaster && !request.master) {
    throw 'Validation failed. Master key is required to complete this request.';
  }
  let params = request.params || {};
  if (request.object) {
    params = request.object.toJSON();
  }
  const requiredParam = key => {
    const value = params[key];
    if (value == null) {
      throw `Validation failed. Please specify data for ${key}.`;
    }
  };
  const validateOptions = async (opt, key, val) => {
    let opts = opt.options;
    if (typeof opts === 'function') {
      try {
        const result = await opts(val);
        if (!result && result != null) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }
      } catch (e) {
        if (!e) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }
        throw opt.error || e.message || e;
      }
      return;
    }
    if (!Array.isArray(opts)) {
      opts = [opt.options];
    }
    if (!opts.includes(val)) {
      throw opt.error || `Validation failed. Invalid option for ${key}. Expected: ${opts.join(', ')}`;
    }
  };
  const getType = fn => {
    const match = fn && fn.toString().match(/^\s*function (\w+)/);
    return (match ? match[1] : '').toLowerCase();
  };
  if (Array.isArray(options.fields)) {
    for (const key of options.fields) {
      requiredParam(key);
    }
  } else {
    const optionPromises = [];
    for (const key in options.fields) {
      const opt = options.fields[key];
      let val = params[key];
      if (typeof opt === 'string') {
        requiredParam(opt);
      }
      if (typeof opt === 'object') {
        if (opt.default != null && val == null) {
          val = opt.default;
          params[key] = val;
          if (request.object) {
            request.object.set(key, val);
          }
        }
        if (opt.constant && request.object) {
          if (request.original) {
            request.object.revert(key);
          } else if (opt.default != null) {
            request.object.set(key, opt.default);
          }
        }
        if (opt.required) {
          requiredParam(key);
        }
        const optional = !opt.required && val === undefined;
        if (!optional) {
          if (opt.type) {
            const type = getType(opt.type);
            const valType = Array.isArray(val) ? 'array' : typeof val;
            if (valType !== type) {
              throw `Validation failed. Invalid type for ${key}. Expected: ${type}`;
            }
          }
          if (opt.options) {
            optionPromises.push(validateOptions(opt, key, val));
          }
        }
      }
    }
    await Promise.all(optionPromises);
  }
  let userRoles = options.requireAnyUserRoles;
  let requireAllRoles = options.requireAllUserRoles;
  const promises = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  if (userRoles || requireAllRoles) {
    promises[0] = auth.getUserRoles();
  }
  if (typeof userRoles === 'function') {
    promises[1] = userRoles();
  }
  if (typeof requireAllRoles === 'function') {
    promises[2] = requireAllRoles();
  }
  const [roles, resolvedUserRoles, resolvedRequireAll] = await Promise.all(promises);
  if (resolvedUserRoles && Array.isArray(resolvedUserRoles)) {
    userRoles = resolvedUserRoles;
  }
  if (resolvedRequireAll && Array.isArray(resolvedRequireAll)) {
    requireAllRoles = resolvedRequireAll;
  }
  if (userRoles) {
    const hasRole = userRoles.some(requiredRole => roles.includes(`role:${requiredRole}`));
    if (!hasRole) {
      throw `Validation failed. User does not match the required roles.`;
    }
  }
  if (requireAllRoles) {
    for (const requiredRole of requireAllRoles) {
      if (!roles.includes(`role:${requiredRole}`)) {
        throw `Validation failed. User does not match all the required roles.`;
      }
    }
  }
  const userKeys = options.requireUserKeys || [];
  if (Array.isArray(userKeys)) {
    for (const key of userKeys) {
      if (!reqUser) {
        throw 'Please login to make this request.';
      }
      if (reqUser.get(key) == null) {
        throw `Validation failed. Please set data for ${key} on your account.`;
      }
    }
  } else if (typeof userKeys === 'object') {
    const optionPromises = [];
    for (const key in options.requireUserKeys) {
      const opt = options.requireUserKeys[key];
      if (opt.options) {
        optionPromises.push(validateOptions(opt, key, reqUser.get(key)));
      }
    }
    await Promise.all(optionPromises);
  }
}

// To be used as part of the promise chain when saving/deleting an object
// Will resolve successfully if no trigger is configured
// Resolves to an object, empty or containing an object key. A beforeSave
// trigger will set the object key to the rest format object to save.
// originalParseObject is optional, we only need that for before/afterSave functions
function maybeRunTrigger(triggerType, auth, parseObject, originalParseObject, config, context) {
  if (!parseObject) {
    return Promise.resolve({});
  }
  return new Promise(function (resolve, reject) {
    var trigger = getTrigger(parseObject.className, triggerType, config.applicationId);
    if (!trigger) {
      return resolve();
    }
    var request = getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context);
    var {
      success,
      error
    } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth, triggerType.startsWith('after') ? config.logLevels.triggerAfter : config.logLevels.triggerBeforeSuccess);
      if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
        Object.assign(context, request.context);
      }
      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error, config.logLevels.triggerBeforeError);
      reject(error);
    });

    // AfterSave and afterDelete triggers can return a promise, which if they
    // do, needs to be resolved before this promise is resolved,
    // so trigger execution is synced with RestWrite.execute() call.
    // If triggers do not return a promise, they can run async code parallel
    // to the RestWrite.execute() call.
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${parseObject.className}`, auth);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return Promise.resolve();
      }
      const promise = trigger(request);
      if (triggerType === Types.afterSave || triggerType === Types.afterDelete || triggerType === Types.afterLogin) {
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth, config.logLevels.triggerAfter);
      }
      // beforeSave is expected to return null (nothing)
      if (triggerType === Types.beforeSave) {
        if (promise && typeof promise.then === 'function') {
          return promise.then(response => {
            // response.object may come from express routing before hook
            if (response && response.object) {
              return response;
            }
            return null;
          });
        }
        return null;
      }
      return promise;
    }).then(success, error);
  });
}

// Converts a REST-format object to a Parse.Object
// data is either className or an object
function inflate(data, restObject) {
  var copy = typeof data == 'object' ? data : {
    className: data
  };
  for (var key in restObject) {
    copy[key] = restObject[key];
  }
  return _node.default.Object.fromJSON(copy);
}
function runLiveQueryEventHandlers(data, applicationId = _node.default.applicationId) {
  if (!_triggerStore || !_triggerStore[applicationId] || !_triggerStore[applicationId].LiveQuery) {
    return;
  }
  _triggerStore[applicationId].LiveQuery.forEach(handler => handler(data));
}
function getRequestFileObject(triggerType, auth, fileObject, config) {
  const request = {
    ...fileObject,
    triggerName: triggerType,
    master: false,
    isReadOnly: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip,
    config
  };
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.isReadOnly) {
    request['isReadOnly'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}
async function maybeRunFileTrigger(triggerType, fileObject, config, auth) {
  const FileClassName = getClassName(_node.default.File);
  const fileTrigger = getTrigger(FileClassName, triggerType, config.applicationId);
  if (typeof fileTrigger === 'function') {
    try {
      const request = getRequestFileObject(triggerType, auth, fileObject, config);
      await maybeRunValidator(request, `${triggerType}.${FileClassName}`, auth);
      if (request.skipWithMasterKey) {
        return fileObject;
      }
      const result = await fileTrigger(request);
      if (request.forceDownload) {
        fileObject.forceDownload = true;
      }
      if (request.responseHeaders) {
        fileObject.responseHeaders = request.responseHeaders;
      }
      logTriggerSuccessBeforeHook(triggerType, 'Parse.File', {
        ...fileObject.file.toJSON(),
        fileSize: fileObject.fileSize
      }, result, auth, config.logLevels.triggerBeforeSuccess);
      return result || fileObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.File', {
        ...fileObject.file.toJSON(),
        fileSize: fileObject.fileSize
      }, auth, error, config.logLevels.triggerBeforeError);
      throw error;
    }
  }
  return fileObject;
}
async function maybeRunGlobalConfigTrigger(triggerType, auth, configObject, originalConfigObject, config, context) {
  const GlobalConfigClassName = getClassName(_node.default.Config);
  const configTrigger = getTrigger(GlobalConfigClassName, triggerType, config.applicationId);
  if (typeof configTrigger === 'function') {
    try {
      const request = getRequestObject(triggerType, auth, configObject, originalConfigObject, config, context);
      await maybeRunValidator(request, `${triggerType}.${GlobalConfigClassName}`, auth);
      if (request.skipWithMasterKey) {
        return configObject;
      }
      const result = await configTrigger(request);
      logTriggerSuccessBeforeHook(triggerType, 'Parse.Config', configObject, result, auth, config.logLevels.triggerBeforeSuccess);
      return result || configObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.Config', configObject, auth, error, config.logLevels.triggerBeforeError);
      throw error;
    }
  }
  return configObject;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2xvZ2dlciIsIl9VdGlscyIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlR5cGVzIiwiZXhwb3J0cyIsImJlZm9yZUxvZ2luIiwiYWZ0ZXJMb2dpbiIsImFmdGVyTG9nb3V0IiwiYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QiLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmVmb3JlQ29ubmVjdCIsImJlZm9yZVN1YnNjcmliZSIsImFmdGVyRXZlbnQiLCJDb25uZWN0Q2xhc3NOYW1lIiwiY3JlYXRlU3RvcmUiLCJPYmplY3QiLCJjcmVhdGUiLCJiYXNlU3RvcmUiLCJWYWxpZGF0b3JzIiwia2V5cyIsInJlZHVjZSIsImJhc2UiLCJrZXkiLCJGdW5jdGlvbnMiLCJKb2JzIiwiTGl2ZVF1ZXJ5IiwiVHJpZ2dlcnMiLCJmcmVlemUiLCJnZXRDbGFzc05hbWUiLCJwYXJzZUNsYXNzIiwiY2xhc3NOYW1lIiwibmFtZSIsInJlcGxhY2UiLCJ2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzIiwidHlwZSIsIl90cmlnZ2VyU3RvcmUiLCJDYXRlZ29yeSIsImdldFN0b3JlIiwiY2F0ZWdvcnkiLCJhcHBsaWNhdGlvbklkIiwiaW52YWxpZE5hbWVSZWdleCIsInRlc3QiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiZ2V0UHJvdG90eXBlT2YiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJ1bmRlZmluZWQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsInRvSlNPTndpdGhPYmplY3RzIiwib2JqZWN0IiwidG9KU09OIiwic3RhdGVDb250cm9sbGVyIiwiQ29yZU1hbmFnZXIiLCJnZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIiLCJwZW5kaW5nIiwiZ2V0UGVuZGluZ09wcyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJ2YWwiLCJfdG9GdWxsSlNPTiIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsInJ1blRyaWdnZXIiLCJ0cmlnZ2VyIiwicmVxdWVzdCIsImF1dGgiLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwidHJpZ2dlckV4aXN0cyIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsImlzR2V0IiwidHJpZ2dlck5hbWUiLCJtYXN0ZXIiLCJpc1JlYWRPbmx5IiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImhlYWRlcnMiLCJpcCIsIm9yaWdpbmFsIiwiYXNzaWduIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJnZXRSZXF1ZXN0UXVlcnlPYmplY3QiLCJxdWVyeSIsImNvdW50IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImlkIiwiZXJyb3IiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImxvZ1RyaWdnZXJBZnRlckhvb2siLCJpbnB1dCIsImxvZ0xldmVsIiwiY2xlYW5JbnB1dCIsIkpTT04iLCJzdHJpbmdpZnkiLCJsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2siLCJyZXN1bHQiLCJjbGVhblJlc3VsdCIsInRydW5jYXRlTG9nTWVzc2FnZSIsImxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2siLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJjbGFzc05hbWVRdWVyeSIsIm9iamVjdHNJbnB1dCIsIlByb21pc2UiLCJsZW5ndGgiLCJvYmoiLCJRdWVyeSIsInBhcnNlUXVlcnlJbnN0YW5jZSIsIndoZXJlIiwid2l0aEpTT04iLCJwcm9jZXNzZWRPYmplY3RzSlNPTiIsImVycm9yRGF0YSIsIm8iLCJsb2dMZXZlbHMiLCJ0cmlnZ2VyQmVmb3JlU3VjY2VzcyIsImN1cnJlbnRPYmplY3QiLCJvcmlnaW5hbENsYXNzTmFtZSIsInRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lIiwiZnJvbUpTT04iLCJ0aGVuIiwicmVzcG9uc2VGcm9tVHJpZ2dlciIsInJlc3VsdHMiLCJyZXN1bHRzQXNKU09OIiwidHJpZ2dlckFmdGVyIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImpzb24iLCJwYXJzZVF1ZXJ5IiwicmVxdWVzdE9iamVjdCIsInByb21pc2UiLCJxdWVyeVJlc3VsdCIsImpzb25RdWVyeSIsImxpbWl0Iiwic2tpcCIsImluY2x1ZGUiLCJleGNsdWRlS2V5cyIsImV4cGxhaW4iLCJvcmRlciIsImhpbnQiLCJjb21tZW50IiwicmVhZFByZWZlcmVuY2UiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwiQXJyYXkiLCJpc0FycmF5IiwiZXZlcnkiLCJlcnIiLCJkZWZhdWx0T3B0cyIsIlV0aWxzIiwiaXNOYXRpdmVFcnJvciIsInN0YWNrIiwidGhlVmFsaWRhdG9yIiwiYnVpbHRJblRyaWdnZXJWYWxpZGF0b3IiLCJjYXRjaCIsIlZBTElEQVRJT05fRVJST1IiLCJvcHRpb25zIiwidmFsaWRhdGVNYXN0ZXJLZXkiLCJyZXFVc2VyIiwiZXhpc3RlZCIsInJlcXVpcmVVc2VyIiwicmVxdWlyZUFueVVzZXJSb2xlcyIsInJlcXVpcmVBbGxVc2VyUm9sZXMiLCJyZXF1aXJlTWFzdGVyIiwicGFyYW1zIiwicmVxdWlyZWRQYXJhbSIsInZhbGlkYXRlT3B0aW9ucyIsIm9wdCIsIm9wdHMiLCJpbmNsdWRlcyIsImpvaW4iLCJnZXRUeXBlIiwiZm4iLCJtYXRjaCIsInRvU3RyaW5nIiwidG9Mb3dlckNhc2UiLCJmaWVsZHMiLCJvcHRpb25Qcm9taXNlcyIsInNldCIsImNvbnN0YW50IiwicmV2ZXJ0IiwicmVxdWlyZWQiLCJvcHRpb25hbCIsInZhbFR5cGUiLCJhbGwiLCJ1c2VyUm9sZXMiLCJyZXF1aXJlQWxsUm9sZXMiLCJwcm9taXNlcyIsImdldFVzZXJSb2xlcyIsInJvbGVzIiwicmVzb2x2ZWRVc2VyUm9sZXMiLCJyZXNvbHZlZFJlcXVpcmVBbGwiLCJoYXNSb2xlIiwic29tZSIsInJlcXVpcmVkUm9sZSIsInVzZXJLZXlzIiwicmVxdWlyZVVzZXJLZXlzIiwibWF5YmVSdW5UcmlnZ2VyIiwic3RhcnRzV2l0aCIsInRyaWdnZXJCZWZvcmVFcnJvciIsImluZmxhdGUiLCJkYXRhIiwicmVzdE9iamVjdCIsImNvcHkiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZ2V0UmVxdWVzdEZpbGVPYmplY3QiLCJmaWxlT2JqZWN0IiwibWF5YmVSdW5GaWxlVHJpZ2dlciIsIkZpbGVDbGFzc05hbWUiLCJGaWxlIiwiZmlsZVRyaWdnZXIiLCJmb3JjZURvd25sb2FkIiwicmVzcG9uc2VIZWFkZXJzIiwiZmlsZSIsImZpbGVTaXplIiwibWF5YmVSdW5HbG9iYWxDb25maWdUcmlnZ2VyIiwiY29uZmlnT2JqZWN0Iiwib3JpZ2luYWxDb25maWdPYmplY3QiLCJHbG9iYWxDb25maWdDbGFzc05hbWUiLCJDb25maWciLCJjb25maWdUcmlnZ2VyIl0sInNvdXJjZXMiOlsiLi4vc3JjL3RyaWdnZXJzLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIHRyaWdnZXJzLmpzXG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi9VdGlscyc7XG5cbmV4cG9ydCBjb25zdCBUeXBlcyA9IHtcbiAgYmVmb3JlTG9naW46ICdiZWZvcmVMb2dpbicsXG4gIGFmdGVyTG9naW46ICdhZnRlckxvZ2luJyxcbiAgYWZ0ZXJMb2dvdXQ6ICdhZnRlckxvZ291dCcsXG4gIGJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0OiAnYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QnLFxuICBiZWZvcmVTYXZlOiAnYmVmb3JlU2F2ZScsXG4gIGFmdGVyU2F2ZTogJ2FmdGVyU2F2ZScsXG4gIGJlZm9yZURlbGV0ZTogJ2JlZm9yZURlbGV0ZScsXG4gIGFmdGVyRGVsZXRlOiAnYWZ0ZXJEZWxldGUnLFxuICBiZWZvcmVGaW5kOiAnYmVmb3JlRmluZCcsXG4gIGFmdGVyRmluZDogJ2FmdGVyRmluZCcsXG4gIGJlZm9yZUNvbm5lY3Q6ICdiZWZvcmVDb25uZWN0JyxcbiAgYmVmb3JlU3Vic2NyaWJlOiAnYmVmb3JlU3Vic2NyaWJlJyxcbiAgYWZ0ZXJFdmVudDogJ2FmdGVyRXZlbnQnLFxufTtcblxuY29uc3QgQ29ubmVjdENsYXNzTmFtZSA9ICdAQ29ubmVjdCc7XG5cbi8qKlxuICogQ3JlYXRlcyBhIHByb3RvdHlwZS1mcmVlIG9iamVjdCBmb3IgdXNlIGFzIGEgbG9va3VwIHN0b3JlLlxuICogVGhpcyBwcmV2ZW50cyBwcm90b3R5cGUgY2hhaW4gcHJvcGVydGllcyAoZS5nLiBgY29uc3RydWN0b3JgLCBgdG9TdHJpbmdgKVxuICogZnJvbSBiZWluZyByZXNvbHZlZCBhcyByZWdpc3RlcmVkIGhhbmRsZXJzIHdoZW4gdXNpbmcgYnJhY2tldCBub3RhdGlvblxuICogZm9yIGxvb2t1cHMuIEFsd2F5cyB1c2UgdGhpcyBpbnN0ZWFkIG9mIGB7fWAgZm9yIGhhbmRsZXIgc3RvcmVzLlxuICovXG5mdW5jdGlvbiBjcmVhdGVTdG9yZSgpIHtcbiAgcmV0dXJuIE9iamVjdC5jcmVhdGUobnVsbCk7XG59XG5cbmNvbnN0IGJhc2VTdG9yZSA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgVmFsaWRhdG9ycyA9IE9iamVjdC5rZXlzKFR5cGVzKS5yZWR1Y2UoZnVuY3Rpb24gKGJhc2UsIGtleSkge1xuICAgIGJhc2Vba2V5XSA9IGNyZWF0ZVN0b3JlKCk7XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sIGNyZWF0ZVN0b3JlKCkpO1xuICBjb25zdCBGdW5jdGlvbnMgPSBjcmVhdGVTdG9yZSgpO1xuICBjb25zdCBKb2JzID0gY3JlYXRlU3RvcmUoKTtcbiAgY29uc3QgTGl2ZVF1ZXJ5ID0gW107XG4gIGNvbnN0IFRyaWdnZXJzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0gY3JlYXRlU3RvcmUoKTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwgY3JlYXRlU3RvcmUoKSk7XG5cbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIEZ1bmN0aW9ucyxcbiAgICBKb2JzLFxuICAgIFZhbGlkYXRvcnMsXG4gICAgVHJpZ2dlcnMsXG4gICAgTGl2ZVF1ZXJ5LFxuICB9KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDbGFzc05hbWUocGFyc2VDbGFzcykge1xuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLmNsYXNzTmFtZSkge1xuICAgIHJldHVybiBwYXJzZUNsYXNzLmNsYXNzTmFtZTtcbiAgfVxuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLm5hbWUpIHtcbiAgICByZXR1cm4gcGFyc2VDbGFzcy5uYW1lLnJlcGxhY2UoJ1BhcnNlJywgJ0AnKTtcbiAgfVxuICByZXR1cm4gcGFyc2VDbGFzcztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpIHtcbiAgaWYgKHR5cGUgPT0gVHlwZXMuYmVmb3JlU2F2ZSAmJiBjbGFzc05hbWUgPT09ICdfUHVzaFN0YXR1cycpIHtcbiAgICAvLyBfUHVzaFN0YXR1cyB1c2VzIHVuZG9jdW1lbnRlZCBuZXN0ZWQga2V5IGluY3JlbWVudCBvcHNcbiAgICAvLyBhbGxvd2luZyBiZWZvcmVTYXZlIHdvdWxkIG1lc3MgdXAgdGhlIG9iamVjdHMgYmlnIHRpbWVcbiAgICAvLyBUT0RPOiBBbGxvdyBwcm9wZXIgZG9jdW1lbnRlZCB3YXkgb2YgdXNpbmcgbmVzdGVkIGluY3JlbWVudCBvcHNcbiAgICB0aHJvdyAnT25seSBhZnRlclNhdmUgaXMgYWxsb3dlZCBvbiBfUHVzaFN0YXR1cyc7XG4gIH1cbiAgaWYgKCh0eXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fCB0eXBlID09PSBUeXBlcy5hZnRlckxvZ2luIHx8IHR5cGUgPT09IFR5cGVzLmJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0KSAmJiBjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9Vc2VyIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBiZWZvcmVMb2dpbiwgYWZ0ZXJMb2dpbiwgYW5kIGJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0IHRyaWdnZXJzJztcbiAgfVxuICBpZiAodHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dvdXQgJiYgY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBfU2Vzc2lvbiBjbGFzcyBpcyBhbGxvd2VkIGZvciB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlci4nO1xuICB9XG4gIGlmIChjbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgJiYgdHlwZSAhPT0gVHlwZXMuYWZ0ZXJMb2dvdXQpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIGFmdGVyTG9nb3V0IHRyaWdnZXIgaXMgYWxsb3dlZCBmb3IgdGhlIF9TZXNzaW9uIGNsYXNzLic7XG4gIH1cbiAgcmV0dXJuIGNsYXNzTmFtZTtcbn1cblxuY29uc3QgX3RyaWdnZXJTdG9yZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbmNvbnN0IENhdGVnb3J5ID0ge1xuICBGdW5jdGlvbnM6ICdGdW5jdGlvbnMnLFxuICBWYWxpZGF0b3JzOiAnVmFsaWRhdG9ycycsXG4gIEpvYnM6ICdKb2JzJyxcbiAgVHJpZ2dlcnM6ICdUcmlnZ2VycycsXG59O1xuXG5mdW5jdGlvbiBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBpbnZhbGlkTmFtZVJlZ2V4ID0gL1snXCJgXS87XG4gIGlmIChpbnZhbGlkTmFtZVJlZ2V4LnRlc3QobmFtZSkpIHtcbiAgICAvLyBQcmV2ZW50IGEgbWFsaWNpb3VzIHVzZXIgZnJvbSBpbmplY3RpbmcgcHJvcGVydGllcyBpbnRvIHRoZSBzdG9yZVxuICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICB9XG5cbiAgY29uc3QgcGF0aCA9IG5hbWUuc3BsaXQoJy4nKTtcbiAgcGF0aC5zcGxpY2UoLTEpOyAvLyByZW1vdmUgbGFzdCBjb21wb25lbnRcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIGxldCBzdG9yZSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bY2F0ZWdvcnldO1xuICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBwYXRoKSB7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoc3RvcmUsIGNvbXBvbmVudCkpIHtcbiAgICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICAgIH1cbiAgICBzdG9yZSA9IHN0b3JlW2NvbXBvbmVudF07XG4gICAgaWYgKCFzdG9yZSB8fCBPYmplY3QuZ2V0UHJvdG90eXBlT2Yoc3RvcmUpICE9PSBudWxsKSB7XG4gICAgICByZXR1cm4gY3JlYXRlU3RvcmUoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHN0b3JlO1xufVxuXG5mdW5jdGlvbiBhZGQoY2F0ZWdvcnksIG5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgaWYgKHN0b3JlW2xhc3RDb21wb25lbnRdKSB7XG4gICAgbG9nZ2VyLndhcm4oXG4gICAgICBgV2FybmluZzogRHVwbGljYXRlIGNsb3VkIGZ1bmN0aW9ucyBleGlzdCBmb3IgJHtsYXN0Q29tcG9uZW50fS4gT25seSB0aGUgbGFzdCBvbmUgd2lsbCBiZSB1c2VkIGFuZCB0aGUgb3RoZXJzIHdpbGwgYmUgaWdub3JlZC5gXG4gICAgKTtcbiAgfVxuICBzdG9yZVtsYXN0Q29tcG9uZW50XSA9IGhhbmRsZXI7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBkZWxldGUgc3RvcmVbbGFzdENvbXBvbmVudF07XG59XG5cbmZ1bmN0aW9uIGdldChjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdG9yZSwgbGFzdENvbXBvbmVudCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKTtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbm5lY3RUcmlnZ2VyKHR5cGUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZExpdmVRdWVyeUV2ZW50SGFuZGxlcihoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvSlNPTndpdGhPYmplY3RzKG9iamVjdCwgY2xhc3NOYW1lKSB7XG4gIGlmICghb2JqZWN0IHx8ICFvYmplY3QudG9KU09OKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGNvbnN0IHRvSlNPTiA9IG9iamVjdC50b0pTT04oKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKG9iamVjdC5fZ2V0U3RhdGVJZGVudGlmaWVyKCkpO1xuICBmb3IgKGNvbnN0IGtleSBpbiBwZW5kaW5nKSB7XG4gICAgY29uc3QgdmFsID0gb2JqZWN0LmdldChrZXkpO1xuICAgIGlmICghdmFsIHx8ICF2YWwuX3RvRnVsbEpTT04pIHtcbiAgICAgIHRvSlNPTltrZXldID0gdmFsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRvSlNPTltrZXldID0gdmFsLl90b0Z1bGxKU09OKCk7XG4gIH1cbiAgLy8gUHJlc2VydmUgb3JpZ2luYWwgb2JqZWN0J3MgY2xhc3NOYW1lIGlmIG5vIG92ZXJyaWRlIGNsYXNzTmFtZSBpcyBwcm92aWRlZFxuICBpZiAoY2xhc3NOYW1lKSB7XG4gICAgdG9KU09OLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgfSBlbHNlIGlmIChvYmplY3QuY2xhc3NOYW1lICYmICF0b0pTT04uY2xhc3NOYW1lKSB7XG4gICAgdG9KU09OLmNsYXNzTmFtZSA9IG9iamVjdC5jbGFzc05hbWU7XG4gIH1cbiAgcmV0dXJuIHRvSlNPTjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyAnTWlzc2luZyBBcHBsaWNhdGlvbklEJztcbiAgfVxuICByZXR1cm4gZ2V0KENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5UcmlnZ2VyKHRyaWdnZXIsIG5hbWUsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIG5hbWUsIGF1dGgpO1xuICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gYXdhaXQgdHJpZ2dlcihyZXF1ZXN0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIHR5cGU6IHN0cmluZywgYXBwbGljYXRpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHlwZSwgYXBwbGljYXRpb25JZCkgIT0gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb25OYW1lcyhhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHN0b3JlID1cbiAgICAoX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSAmJiBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW0NhdGVnb3J5LkZ1bmN0aW9uc10pIHx8IHt9O1xuICBjb25zdCBmdW5jdGlvbk5hbWVzID0gW107XG4gIGNvbnN0IGV4dHJhY3RGdW5jdGlvbk5hbWVzID0gKG5hbWVzcGFjZSwgc3RvcmUpID0+IHtcbiAgICBPYmplY3Qua2V5cyhzdG9yZSkuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3RvcmVbbmFtZV07XG4gICAgICBpZiAobmFtZXNwYWNlKSB7XG4gICAgICAgIG5hbWUgPSBgJHtuYW1lc3BhY2V9LiR7bmFtZX1gO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBmdW5jdGlvbk5hbWVzLnB1c2gobmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBleHRyYWN0RnVuY3Rpb25OYW1lcyhuYW1lLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG4gIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG51bGwsIHN0b3JlKTtcbiAgcmV0dXJuIGZ1bmN0aW9uTmFtZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9icyhhcHBsaWNhdGlvbklkKSB7XG4gIHZhciBtYW5hZ2VyID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXTtcbiAgaWYgKG1hbmFnZXIgJiYgbWFuYWdlci5Kb2JzKSB7XG4gICAgcmV0dXJuIG1hbmFnZXIuSm9icztcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0T2JqZWN0KFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBvYmplY3Q6IHBhcnNlT2JqZWN0LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoaXNHZXQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlcXVlc3QuaXNHZXQgPSAhIWlzR2V0O1xuICB9XG5cbiAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICByZXF1ZXN0Lm9yaWdpbmFsID0gb3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgfVxuICBpZiAoXG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckxvZ2luIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0IHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRmluZFxuICApIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKE9iamVjdC5jcmVhdGUobnVsbCksIGNvbnRleHQpO1xuICB9XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHJlcXVlc3RbJ2lzUmVhZE9ubHknXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBxdWVyeSwgY291bnQsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpIHtcbiAgaXNHZXQgPSAhIWlzR2V0O1xuXG4gIHZhciByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBxdWVyeSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGlzUmVhZE9ubHk6IGZhbHNlLFxuICAgIGNvdW50LFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaXNHZXQsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgICBjb250ZXh0OiBjb250ZXh0IHx8IHt9LFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgcmVxdWVzdFsnaXNSZWFkT25seSddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbi8vIENyZWF0ZXMgdGhlIHJlc3BvbnNlIG9iamVjdCwgYW5kIHVzZXMgdGhlIHJlcXVlc3Qgb2JqZWN0IHRvIHBhc3MgZGF0YVxuLy8gVGhlIEFQSSB3aWxsIGNhbGwgdGhpcyB3aXRoIFJFU1QgQVBJIGZvcm1hdHRlZCBvYmplY3RzLCB0aGlzIHdpbGxcbi8vIHRyYW5zZm9ybSB0aGVtIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZXhwZWN0ZWQgYnkgQ2xvdWQgQ29kZS5cbi8vIEFueSBjaGFuZ2VzIG1hZGUgdG8gdGhlIG9iamVjdCBpbiBhIGJlZm9yZVNhdmUgd2lsbCBiZSBpbmNsdWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXNwb25zZU9iamVjdChyZXF1ZXN0LCByZXNvbHZlLCByZWplY3QpIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmdW5jdGlvbiAocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlID0gcmVzcG9uc2UubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRvSlNPTndpdGhPYmplY3RzKG9iamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICAvLyBVc2UgdGhlIEpTT04gcmVzcG9uc2VcbiAgICAgIGlmIChcbiAgICAgICAgcmVzcG9uc2UgJiZcbiAgICAgICAgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAhcmVxdWVzdC5vYmplY3QuZXF1YWxzKHJlc3BvbnNlKSAmJlxuICAgICAgICByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc3BvbnNlICYmIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiYgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICAgIH1cbiAgICAgIHJlc3BvbnNlID0ge307XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSkge1xuICAgICAgICByZXNwb25zZVsnb2JqZWN0J10gPSByZXF1ZXN0Lm9iamVjdC5fZ2V0U2F2ZUpTT04oKTtcbiAgICAgICAgcmVzcG9uc2VbJ29iamVjdCddWydvYmplY3RJZCddID0gcmVxdWVzdC5vYmplY3QuaWQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgfSxcbiAgICBlcnJvcjogZnVuY3Rpb24gKGVycm9yKSB7XG4gICAgICBjb25zdCBlID0gcmVzb2x2ZUVycm9yKGVycm9yLCB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgIG1lc3NhZ2U6ICdTY3JpcHQgZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICB9KTtcbiAgICAgIHJlamVjdChlKTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiB1c2VySWRGb3JMb2coYXV0aCkge1xuICByZXR1cm4gYXV0aCAmJiBhdXRoLnVzZXIgPyBhdXRoLnVzZXIuaWQgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIGF1dGgsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KGlucHV0KTtcbiAgbG9nZ2VyW2xvZ0xldmVsXShcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06IElucHV0OiAke2NsZWFuSW5wdXR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgcmVzdWx0LCBhdXRoLCBsb2dMZXZlbCkge1xuICBpZiAobG9nTGV2ZWwgPT09ICdzaWxlbnQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBKU09OLnN0cmluZ2lmeShpbnB1dCk7XG4gIGNvbnN0IGNsZWFuUmVzdWx0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTtcbiAgbG9nZ2VyW2xvZ0xldmVsXShcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06IElucHV0OiAke2NsZWFuSW5wdXR9IFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KGlucHV0KTtcbiAgbG9nZ2VyW2xvZ0xldmVsXShcbiAgICBgJHt0cmlnZ2VyVHlwZX0gZmFpbGVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06IElucHV0OiAke2NsZWFuSW5wdXR9IEVycm9yOiAke0pTT04uc3RyaW5naWZ5KGVycm9yKX1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgZXJyb3IsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lUXVlcnksXG4gIG9iamVjdHNJbnB1dCxcbiAgY29uZmlnLFxuICBxdWVyeSxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZVF1ZXJ5LCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuXG4gICAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgICBpZiAob2JqZWN0c0lucHV0ICYmIG9iamVjdHNJbnB1dC5sZW5ndGggPiAwICYmIG9iamVjdHNJbnB1dFswXSBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShvYmplY3RzSW5wdXQubWFwKG9iaiA9PiB0b0pTT053aXRoT2JqZWN0cyhvYmopKSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzb2x2ZShvYmplY3RzSW5wdXQgfHwgW10pO1xuICAgIH1cblxuICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBudWxsLCBudWxsLCBjb25maWcsIGNvbnRleHQsIGlzR2V0KTtcbiAgICAvLyBDb252ZXJ0IHF1ZXJ5IHBhcmFtZXRlciB0byBQYXJzZS5RdWVyeSBpbnN0YW5jZVxuICAgIGlmIChxdWVyeSBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgICByZXF1ZXN0LnF1ZXJ5ID0gcXVlcnk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcXVlcnkgPT09ICdvYmplY3QnICYmIHF1ZXJ5ICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBwYXJzZVF1ZXJ5SW5zdGFuY2UgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lUXVlcnkpO1xuICAgICAgaWYgKHF1ZXJ5LndoZXJlKSB7XG4gICAgICAgIHBhcnNlUXVlcnlJbnN0YW5jZS53aXRoSlNPTihxdWVyeSk7XG4gICAgICB9XG4gICAgICByZXF1ZXN0LnF1ZXJ5ID0gcGFyc2VRdWVyeUluc3RhbmNlO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXF1ZXN0LnF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZVF1ZXJ5KTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSBnZXRSZXNwb25zZU9iamVjdChcbiAgICAgIHJlcXVlc3QsXG4gICAgICBwcm9jZXNzZWRPYmplY3RzSlNPTiA9PiB7XG4gICAgICAgIHJlc29sdmUocHJvY2Vzc2VkT2JqZWN0c0pTT04pO1xuICAgICAgfSxcbiAgICAgIGVycm9yRGF0YSA9PiB7XG4gICAgICAgIHJlamVjdChlcnJvckRhdGEpO1xuICAgICAgfVxuICAgICk7XG4gICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWVRdWVyeSxcbiAgICAgICdBZnRlckZpbmQgSW5wdXQgKFByZS1UcmFuc2Zvcm0pJyxcbiAgICAgIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICBvYmplY3RzSW5wdXQubWFwKG8gPT4gKG8gaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QgPyBvLmlkICsgJzonICsgby5jbGFzc05hbWUgOiBvKSlcbiAgICAgICksXG4gICAgICBhdXRoLFxuICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICk7XG5cbiAgICAvLyBDb252ZXJ0IHBsYWluIG9iamVjdHMgdG8gUGFyc2UuT2JqZWN0IGluc3RhbmNlcyBmb3IgdHJpZ2dlclxuICAgIHJlcXVlc3Qub2JqZWN0cyA9IG9iamVjdHNJbnB1dC5tYXAoY3VycmVudE9iamVjdCA9PiB7XG4gICAgICBpZiAoY3VycmVudE9iamVjdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICByZXR1cm4gY3VycmVudE9iamVjdDtcbiAgICAgIH1cbiAgICAgIC8vIFByZXNlcnZlIHRoZSBvcmlnaW5hbCBjbGFzc05hbWUgaWYgaXQgZXhpc3RzLCBvdGhlcndpc2UgdXNlIHRoZSBxdWVyeSBjbGFzc05hbWVcbiAgICAgIGNvbnN0IG9yaWdpbmFsQ2xhc3NOYW1lID0gY3VycmVudE9iamVjdC5jbGFzc05hbWUgfHwgY2xhc3NOYW1lUXVlcnk7XG4gICAgICBjb25zdCB0ZW1wT2JqZWN0V2l0aENsYXNzTmFtZSA9IHsgLi4uY3VycmVudE9iamVjdCwgY2xhc3NOYW1lOiBvcmlnaW5hbENsYXNzTmFtZSB9O1xuICAgICAgcmV0dXJuIFBhcnNlLk9iamVjdC5mcm9tSlNPTih0ZW1wT2JqZWN0V2l0aENsYXNzTmFtZSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWVRdWVyeX1gLCBhdXRoKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXNwb25zZUZyb21UcmlnZ2VyID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgaWYgKHJlc3BvbnNlRnJvbVRyaWdnZXIgJiYgdHlwZW9mIHJlc3BvbnNlRnJvbVRyaWdnZXIudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIHJldHVybiByZXNwb25zZUZyb21UcmlnZ2VyLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzcG9uc2VGcm9tVHJpZ2dlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pLnRoZW4ocmVzdWx0c0FzSlNPTiA9PiB7XG4gICAgbG9nVHJpZ2dlckFmdGVySG9vayhcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgY2xhc3NOYW1lUXVlcnksXG4gICAgICBKU09OLnN0cmluZ2lmeShyZXN1bHRzQXNKU09OKSxcbiAgICAgIGF1dGgsXG4gICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJBZnRlclxuICAgICk7XG4gICAgcmV0dXJuIHJlc3VsdHNBc0pTT047XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5RdWVyeVRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBjbGFzc05hbWUsXG4gIHJlc3RXaGVyZSxcbiAgcmVzdE9wdGlvbnMsXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe1xuICAgICAgcmVzdFdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnMsXG4gICAgfSk7XG4gIH1cbiAgY29uc3QganNvbiA9IE9iamVjdC5hc3NpZ24oe30sIHJlc3RPcHRpb25zKTtcbiAganNvbi53aGVyZSA9IHJlc3RXaGVyZTtcblxuICBjb25zdCBwYXJzZVF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZSk7XG4gIHBhcnNlUXVlcnkud2l0aEpTT04oanNvbik7XG5cbiAgbGV0IGNvdW50ID0gZmFsc2U7XG4gIGlmIChyZXN0T3B0aW9ucykge1xuICAgIGNvdW50ID0gISFyZXN0T3B0aW9ucy5jb3VudDtcbiAgfVxuICBjb25zdCByZXF1ZXN0T2JqZWN0ID0gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KFxuICAgIHRyaWdnZXJUeXBlLFxuICAgIGF1dGgsXG4gICAgcGFyc2VRdWVyeSxcbiAgICBjb3VudCxcbiAgICBjb25maWcsXG4gICAgY29udGV4dCxcbiAgICBpc0dldFxuICApO1xuICBjb25zdCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdE9iamVjdCwgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIHJlcXVlc3RPYmplY3QucXVlcnk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJpZ2dlcihyZXF1ZXN0T2JqZWN0KTtcbiAgICB9KVxuICAgIC50aGVuKFxuICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgbGV0IHF1ZXJ5UmVzdWx0ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgaWYgKHJlc3VsdCAmJiByZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgICAgICAgIHF1ZXJ5UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGpzb25RdWVyeSA9IHF1ZXJ5UmVzdWx0LnRvSlNPTigpO1xuICAgICAgICBpZiAoanNvblF1ZXJ5LndoZXJlKSB7XG4gICAgICAgICAgcmVzdFdoZXJlID0ganNvblF1ZXJ5LndoZXJlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkubGltaXQpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmxpbWl0ID0ganNvblF1ZXJ5LmxpbWl0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuc2tpcCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuc2tpcCA9IGpzb25RdWVyeS5za2lwO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuaW5jbHVkZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGpzb25RdWVyeS5pbmNsdWRlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuZXhjbHVkZUtleXMpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzID0ganNvblF1ZXJ5LmV4Y2x1ZGVLZXlzO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuZXhwbGFpbikge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuZXhwbGFpbiA9IGpzb25RdWVyeS5leHBsYWluO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkua2V5cykge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMua2V5cyA9IGpzb25RdWVyeS5rZXlzO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkub3JkZXIpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLm9yZGVyID0ganNvblF1ZXJ5Lm9yZGVyO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuaGludCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaGludCA9IGpzb25RdWVyeS5oaW50O1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuY29tbWVudCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuY29tbWVudCA9IGpzb25RdWVyeS5jb21tZW50O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGxldCBvYmplY3RzID0gdW5kZWZpbmVkO1xuICAgICAgICBpZiAocmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgICAgb2JqZWN0cyA9IFtyZXN1bHRdO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIEFycmF5LmlzQXJyYXkocmVzdWx0KSAmJlxuICAgICAgICAgICghcmVzdWx0Lmxlbmd0aCB8fCByZXN1bHQuZXZlcnkob2JqID0+IG9iaiBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkpXG4gICAgICAgICkge1xuICAgICAgICAgIG9iamVjdHMgPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICByZXN0V2hlcmUsXG4gICAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgICAgb2JqZWN0cyxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBlcnIgPT4ge1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICAgIG1lc3NhZ2U6ICdTY3JpcHQgZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICAgIH0pO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICApO1xuICByZXR1cm4gcHJvbWlzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVFcnJvcihtZXNzYWdlLCBkZWZhdWx0T3B0cykge1xuICBpZiAoIWRlZmF1bHRPcHRzKSB7XG4gICAgZGVmYXVsdE9wdHMgPSB7fTtcbiAgfVxuICBpZiAoIW1lc3NhZ2UpIHtcbiAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgZGVmYXVsdE9wdHMuY29kZSB8fCBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgZGVmYXVsdE9wdHMubWVzc2FnZSB8fCAnU2NyaXB0IGZhaWxlZC4nXG4gICAgKTtcbiAgfVxuICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgcmV0dXJuIG1lc3NhZ2U7XG4gIH1cblxuICBjb25zdCBjb2RlID0gZGVmYXVsdE9wdHMuY29kZSB8fCBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVEO1xuICAvLyBJZiBpdCdzIGFuIGVycm9yLCBtYXJrIGl0IGFzIGEgc2NyaXB0IGZhaWxlZFxuICBpZiAodHlwZW9mIG1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlKTtcbiAgfVxuICBjb25zdCBlcnJvciA9IG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlLm1lc3NhZ2UgfHwgbWVzc2FnZSk7XG4gIGlmIChVdGlscy5pc05hdGl2ZUVycm9yKG1lc3NhZ2UpKSB7XG4gICAgZXJyb3Iuc3RhY2sgPSBtZXNzYWdlLnN0YWNrO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBmdW5jdGlvbk5hbWUsIGF1dGgpIHtcbiAgY29uc3QgdGhlVmFsaWRhdG9yID0gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdGhlVmFsaWRhdG9yKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0JyAmJiB0aGVWYWxpZGF0b3Iuc2tpcFdpdGhNYXN0ZXJLZXkgJiYgcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICByZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5ID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCdcbiAgICAgICAgICA/IGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKHRoZVZhbGlkYXRvciwgcmVxdWVzdCwgYXV0aClcbiAgICAgICAgICA6IHRoZVZhbGlkYXRvcihyZXF1ZXN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6ICdWYWxpZGF0aW9uIGZhaWxlZC4nLFxuICAgICAgICB9KTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKG9wdGlvbnMsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKHJlcXVlc3QubWFzdGVyICYmICFvcHRpb25zLnZhbGlkYXRlTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZXFVc2VyID0gcmVxdWVzdC51c2VyO1xuICBpZiAoXG4gICAgIXJlcVVzZXIgJiZcbiAgICByZXF1ZXN0Lm9iamVjdCAmJlxuICAgIHJlcXVlc3Qub2JqZWN0LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICFyZXF1ZXN0Lm9iamVjdC5leGlzdGVkKClcbiAgKSB7XG4gICAgcmVxVXNlciA9IHJlcXVlc3Qub2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICAob3B0aW9ucy5yZXF1aXJlVXNlciB8fCBvcHRpb25zLnJlcXVpcmVBbnlVc2VyUm9sZXMgfHwgb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzKSAmJlxuICAgICFyZXFVc2VyXG4gICkge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIGxvZ2luIHRvIGNvbnRpbnVlLic7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmVxdWlyZU1hc3RlciAmJiAhcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIE1hc3RlciBrZXkgaXMgcmVxdWlyZWQgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0Lic7XG4gIH1cbiAgbGV0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zIHx8IHt9O1xuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICBwYXJhbXMgPSByZXF1ZXN0Lm9iamVjdC50b0pTT04oKTtcbiAgfVxuICBjb25zdCByZXF1aXJlZFBhcmFtID0ga2V5ID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtc1trZXldO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzcGVjaWZ5IGRhdGEgZm9yICR7a2V5fS5gO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2YWxpZGF0ZU9wdGlvbnMgPSBhc3luYyAob3B0LCBrZXksIHZhbCkgPT4ge1xuICAgIGxldCBvcHRzID0gb3B0Lm9wdGlvbnM7XG4gICAgaWYgKHR5cGVvZiBvcHRzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcHRzKHZhbCk7XG4gICAgICAgIGlmICghcmVzdWx0ICYmIHJlc3VsdCAhPSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFlKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgZS5tZXNzYWdlIHx8IGU7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShvcHRzKSkge1xuICAgICAgb3B0cyA9IFtvcHQub3B0aW9uc107XG4gICAgfVxuXG4gICAgaWYgKCFvcHRzLmluY2x1ZGVzKHZhbCkpIHtcbiAgICAgIHRocm93IChcbiAgICAgICAgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCBvcHRpb24gZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7b3B0cy5qb2luKCcsICcpfWBcbiAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdldFR5cGUgPSBmbiA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSBmbiAmJiBmbi50b1N0cmluZygpLm1hdGNoKC9eXFxzKmZ1bmN0aW9uIChcXHcrKS8pO1xuICAgIHJldHVybiAobWF0Y2ggPyBtYXRjaFsxXSA6ICcnKS50b0xvd2VyQ2FzZSgpO1xuICB9O1xuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpZWxkcykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBvcHRpb25Qcm9taXNlcyA9IFtdO1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLmZpZWxkc1trZXldO1xuICAgICAgbGV0IHZhbCA9IHBhcmFtc1trZXldO1xuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmVkUGFyYW0ob3B0KTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCAmJiB2YWwgPT0gbnVsbCkge1xuICAgICAgICAgIHZhbCA9IG9wdC5kZWZhdWx0O1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgdmFsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5jb25zdGFudCAmJiByZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9yaWdpbmFsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5yZXZlcnQoa2V5KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIG9wdC5kZWZhdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5yZXF1aXJlZCkge1xuICAgICAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcHRpb25hbCA9ICFvcHQucmVxdWlyZWQgJiYgdmFsID09PSB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghb3B0aW9uYWwpIHtcbiAgICAgICAgICBpZiAob3B0LnR5cGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBnZXRUeXBlKG9wdC50eXBlKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbFR5cGUgPSBBcnJheS5pc0FycmF5KHZhbCkgPyAnYXJyYXknIDogdHlwZW9mIHZhbDtcbiAgICAgICAgICAgIGlmICh2YWxUeXBlICE9PSB0eXBlKSB7XG4gICAgICAgICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB0eXBlIGZvciAke2tleX0uIEV4cGVjdGVkOiAke3R5cGV9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgICAgICBvcHRpb25Qcm9taXNlcy5wdXNoKHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgdmFsKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKG9wdGlvblByb21pc2VzKTtcbiAgfVxuICBsZXQgdXNlclJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQW55VXNlclJvbGVzO1xuICBsZXQgcmVxdWlyZUFsbFJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzO1xuICBjb25zdCBwcm9taXNlcyA9IFtQcm9taXNlLnJlc29sdmUoKSwgUHJvbWlzZS5yZXNvbHZlKCksIFByb21pc2UucmVzb2x2ZSgpXTtcbiAgaWYgKHVzZXJSb2xlcyB8fCByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBwcm9taXNlc1swXSA9IGF1dGguZ2V0VXNlclJvbGVzKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB1c2VyUm9sZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBwcm9taXNlc1sxXSA9IHVzZXJSb2xlcygpO1xuICB9XG4gIGlmICh0eXBlb2YgcmVxdWlyZUFsbFJvbGVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcHJvbWlzZXNbMl0gPSByZXF1aXJlQWxsUm9sZXMoKTtcbiAgfVxuICBjb25zdCBbcm9sZXMsIHJlc29sdmVkVXNlclJvbGVzLCByZXNvbHZlZFJlcXVpcmVBbGxdID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICBpZiAocmVzb2x2ZWRVc2VyUm9sZXMgJiYgQXJyYXkuaXNBcnJheShyZXNvbHZlZFVzZXJSb2xlcykpIHtcbiAgICB1c2VyUm9sZXMgPSByZXNvbHZlZFVzZXJSb2xlcztcbiAgfVxuICBpZiAocmVzb2x2ZWRSZXF1aXJlQWxsICYmIEFycmF5LmlzQXJyYXkocmVzb2x2ZWRSZXF1aXJlQWxsKSkge1xuICAgIHJlcXVpcmVBbGxSb2xlcyA9IHJlc29sdmVkUmVxdWlyZUFsbDtcbiAgfVxuICBpZiAodXNlclJvbGVzKSB7XG4gICAgY29uc3QgaGFzUm9sZSA9IHVzZXJSb2xlcy5zb21lKHJlcXVpcmVkUm9sZSA9PiByb2xlcy5pbmNsdWRlcyhgcm9sZToke3JlcXVpcmVkUm9sZX1gKSk7XG4gICAgaWYgKCFoYXNSb2xlKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFVzZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJlcXVpcmVkIHJvbGVzLmA7XG4gICAgfVxuICB9XG4gIGlmIChyZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlcXVpcmVkUm9sZSBvZiByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICAgIGlmICghcm9sZXMuaW5jbHVkZXMoYHJvbGU6JHtyZXF1aXJlZFJvbGV9YCkpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBVc2VyIGRvZXMgbm90IG1hdGNoIGFsbCB0aGUgcmVxdWlyZWQgcm9sZXMuYDtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3QgdXNlcktleXMgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cyB8fCBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodXNlcktleXMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdXNlcktleXMpIHtcbiAgICAgIGlmICghcmVxVXNlcikge1xuICAgICAgICB0aHJvdyAnUGxlYXNlIGxvZ2luIHRvIG1ha2UgdGhpcyByZXF1ZXN0Lic7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXFVc2VyLmdldChrZXkpID09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc2V0IGRhdGEgZm9yICR7a2V5fSBvbiB5b3VyIGFjY291bnQuYDtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIHVzZXJLZXlzID09PSAnb2JqZWN0Jykge1xuICAgIGNvbnN0IG9wdGlvblByb21pc2VzID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMpIHtcbiAgICAgIGNvbnN0IG9wdCA9IG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzW2tleV07XG4gICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgb3B0aW9uUHJvbWlzZXMucHVzaCh2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHJlcVVzZXIuZ2V0KGtleSkpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwob3B0aW9uUHJvbWlzZXMpO1xuICB9XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIocGFyc2VPYmplY3QuY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikgeyByZXR1cm4gcmVzb2x2ZSgpOyB9XG4gICAgdmFyIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBhdXRoLFxuICAgICAgcGFyc2VPYmplY3QsXG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgY29uZmlnLFxuICAgICAgY29udGV4dFxuICAgICk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgdHJpZ2dlclR5cGUuc3RhcnRzV2l0aCgnYWZ0ZXInKVxuICAgICAgICAgICAgPyBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJBZnRlclxuICAgICAgICAgICAgOiBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICAgICk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlXG4gICAgICAgICkge1xuICAgICAgICAgIE9iamVjdC5hc3NpZ24oY29udGV4dCwgcmVxdWVzdC5jb250ZXh0KTtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGVycm9yLFxuICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICAgICk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEFmdGVyU2F2ZSBhbmQgYWZ0ZXJEZWxldGUgdHJpZ2dlcnMgY2FuIHJldHVybiBhIHByb21pc2UsIHdoaWNoIGlmIHRoZXlcbiAgICAvLyBkbywgbmVlZHMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHRoaXMgcHJvbWlzZSBpcyByZXNvbHZlZCxcbiAgICAvLyBzbyB0cmlnZ2VyIGV4ZWN1dGlvbiBpcyBzeW5jZWQgd2l0aCBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgLy8gSWYgdHJpZ2dlcnMgZG8gbm90IHJldHVybiBhIHByb21pc2UsIHRoZXkgY2FuIHJ1biBhc3luYyBjb2RlIHBhcmFsbGVsXG4gICAgLy8gdG8gdGhlIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke3BhcnNlT2JqZWN0LmNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckxvZ2luXG4gICAgICAgICkge1xuICAgICAgICAgIGxvZ1RyaWdnZXJBZnRlckhvb2soXG4gICAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKGRhdGEsIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkKSB7XG4gIGlmICghX3RyaWdnZXJTdG9yZSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZykge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIC4uLmZpbGVPYmplY3QsXG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgcmVxdWVzdFsnaXNSZWFkT25seSddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkZpbGVUcmlnZ2VyKHRyaWdnZXJUeXBlLCBmaWxlT2JqZWN0LCBjb25maWcsIGF1dGgpIHtcbiAgY29uc3QgRmlsZUNsYXNzTmFtZSA9IGdldENsYXNzTmFtZShQYXJzZS5GaWxlKTtcbiAgY29uc3QgZmlsZVRyaWdnZXIgPSBnZXRUcmlnZ2VyKEZpbGVDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgZmlsZVRyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpO1xuICAgICAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7RmlsZUNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBmaWxlT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmlsZVRyaWdnZXIocmVxdWVzdCk7XG4gICAgICBpZiAocmVxdWVzdC5mb3JjZURvd25sb2FkKSB7XG4gICAgICAgIGZpbGVPYmplY3QuZm9yY2VEb3dubG9hZCA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC5yZXNwb25zZUhlYWRlcnMpIHtcbiAgICAgICAgZmlsZU9iamVjdC5yZXNwb25zZUhlYWRlcnMgPSByZXF1ZXN0LnJlc3BvbnNlSGVhZGVycztcbiAgICAgIH1cbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgfHwgZmlsZU9iamVjdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGVycm9yLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVFcnJvclxuICAgICAgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmlsZU9iamVjdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuR2xvYmFsQ29uZmlnVHJpZ2dlcih0cmlnZ2VyVHlwZSwgYXV0aCwgY29uZmlnT2JqZWN0LCBvcmlnaW5hbENvbmZpZ09iamVjdCwgY29uZmlnLCBjb250ZXh0KSB7XG4gIGNvbnN0IEdsb2JhbENvbmZpZ0NsYXNzTmFtZSA9IGdldENsYXNzTmFtZShQYXJzZS5Db25maWcpO1xuICBjb25zdCBjb25maWdUcmlnZ2VyID0gZ2V0VHJpZ2dlcihHbG9iYWxDb25maWdDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgY29uZmlnVHJpZ2dlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgY29uZmlnT2JqZWN0LCBvcmlnaW5hbENvbmZpZ09iamVjdCwgY29uZmlnLCBjb250ZXh0KTtcbiAgICAgIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke0dsb2JhbENvbmZpZ0NsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBjb25maWdPYmplY3Q7XG4gICAgICB9XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjb25maWdUcmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkNvbmZpZycsXG4gICAgICAgIGNvbmZpZ09iamVjdCxcbiAgICAgICAgcmVzdWx0LFxuICAgICAgICBhdXRoLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJlc3VsdCB8fCBjb25maWdPYmplY3Q7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuQ29uZmlnJyxcbiAgICAgICAgY29uZmlnT2JqZWN0LFxuICAgICAgICBhdXRoLFxuICAgICAgICBlcnJvcixcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlRXJyb3JcbiAgICAgICk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZ09iamVjdDtcbn1cbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLElBQUFBLEtBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE9BQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLE1BQUEsR0FBQUgsc0JBQUEsQ0FBQUMsT0FBQTtBQUE0QixTQUFBRCx1QkFBQUksQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQUg1Qjs7QUFLTyxNQUFNRyxLQUFLLEdBQUFDLE9BQUEsQ0FBQUQsS0FBQSxHQUFHO0VBQ25CRSxXQUFXLEVBQUUsYUFBYTtFQUMxQkMsVUFBVSxFQUFFLFlBQVk7RUFDeEJDLFdBQVcsRUFBRSxhQUFhO0VBQzFCQywwQkFBMEIsRUFBRSw0QkFBNEI7RUFDeERDLFVBQVUsRUFBRSxZQUFZO0VBQ3hCQyxTQUFTLEVBQUUsV0FBVztFQUN0QkMsWUFBWSxFQUFFLGNBQWM7RUFDNUJDLFdBQVcsRUFBRSxhQUFhO0VBQzFCQyxVQUFVLEVBQUUsWUFBWTtFQUN4QkMsU0FBUyxFQUFFLFdBQVc7RUFDdEJDLGFBQWEsRUFBRSxlQUFlO0VBQzlCQyxlQUFlLEVBQUUsaUJBQWlCO0VBQ2xDQyxVQUFVLEVBQUU7QUFDZCxDQUFDO0FBRUQsTUFBTUMsZ0JBQWdCLEdBQUcsVUFBVTs7QUFFbkM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBU0MsV0FBV0EsQ0FBQSxFQUFHO0VBQ3JCLE9BQU9DLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDLElBQUksQ0FBQztBQUM1QjtBQUVBLE1BQU1DLFNBQVMsR0FBRyxTQUFBQSxDQUFBLEVBQVk7RUFDNUIsTUFBTUMsVUFBVSxHQUFHSCxN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
