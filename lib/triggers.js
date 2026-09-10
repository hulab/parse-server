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
    // Set a copy of the context on the request object, with a null prototype so a
    // polluted Object.prototype cannot leak into the trigger context
    context: Object.assign(Object.create(null), context || {}),
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
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
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
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
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
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
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
  return Promise.resolve().then(() => {
    return maybeRunValidator(requestObject, `${triggerType}.${className}`, auth);
  }).then(() => {
    if (requestObject.skipWithMasterKey) {
      return requestObject.query;
    }
    return trigger(requestObject);
  }).then(result => {
    // Propagate any context mutations made by the trigger back to the shared context,
    // mirroring the write-back for other trigger types in maybeRunTrigger. This preserves
    // beforeFind -> afterFind context propagation now that the request context is a copy.
    if (context) {
      Object.assign(context, requestObject.context);
    }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2xvZ2dlciIsIl9VdGlscyIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlR5cGVzIiwiZXhwb3J0cyIsImJlZm9yZUxvZ2luIiwiYWZ0ZXJMb2dpbiIsImFmdGVyTG9nb3V0IiwiYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QiLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmVmb3JlQ29ubmVjdCIsImJlZm9yZVN1YnNjcmliZSIsImFmdGVyRXZlbnQiLCJDb25uZWN0Q2xhc3NOYW1lIiwiY3JlYXRlU3RvcmUiLCJPYmplY3QiLCJjcmVhdGUiLCJiYXNlU3RvcmUiLCJWYWxpZGF0b3JzIiwia2V5cyIsInJlZHVjZSIsImJhc2UiLCJrZXkiLCJGdW5jdGlvbnMiLCJKb2JzIiwiTGl2ZVF1ZXJ5IiwiVHJpZ2dlcnMiLCJmcmVlemUiLCJnZXRDbGFzc05hbWUiLCJwYXJzZUNsYXNzIiwiY2xhc3NOYW1lIiwibmFtZSIsInJlcGxhY2UiLCJ2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzIiwidHlwZSIsIl90cmlnZ2VyU3RvcmUiLCJDYXRlZ29yeSIsImdldFN0b3JlIiwiY2F0ZWdvcnkiLCJhcHBsaWNhdGlvbklkIiwiaW52YWxpZE5hbWVSZWdleCIsInRlc3QiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiZ2V0UHJvdG90eXBlT2YiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJ1bmRlZmluZWQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsInRvSlNPTndpdGhPYmplY3RzIiwib2JqZWN0IiwidG9KU09OIiwic3RhdGVDb250cm9sbGVyIiwiQ29yZU1hbmFnZXIiLCJnZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIiLCJwZW5kaW5nIiwiZ2V0UGVuZGluZ09wcyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJ2YWwiLCJfdG9GdWxsSlNPTiIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsInJ1blRyaWdnZXIiLCJ0cmlnZ2VyIiwicmVxdWVzdCIsImF1dGgiLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwidHJpZ2dlckV4aXN0cyIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsImlzR2V0IiwidHJpZ2dlck5hbWUiLCJtYXN0ZXIiLCJpc1JlYWRPbmx5IiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImhlYWRlcnMiLCJpcCIsIm9yaWdpbmFsIiwiYXNzaWduIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJnZXRSZXF1ZXN0UXVlcnlPYmplY3QiLCJxdWVyeSIsImNvdW50IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImlkIiwiZXJyb3IiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImxvZ1RyaWdnZXJBZnRlckhvb2siLCJpbnB1dCIsImxvZ0xldmVsIiwiY2xlYW5JbnB1dCIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2siLCJyZXN1bHQiLCJjbGVhblJlc3VsdCIsImxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2siLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJjbGFzc05hbWVRdWVyeSIsIm9iamVjdHNJbnB1dCIsIlByb21pc2UiLCJsZW5ndGgiLCJvYmoiLCJRdWVyeSIsInBhcnNlUXVlcnlJbnN0YW5jZSIsIndoZXJlIiwid2l0aEpTT04iLCJwcm9jZXNzZWRPYmplY3RzSlNPTiIsImVycm9yRGF0YSIsIm8iLCJsb2dMZXZlbHMiLCJ0cmlnZ2VyQmVmb3JlU3VjY2VzcyIsImN1cnJlbnRPYmplY3QiLCJvcmlnaW5hbENsYXNzTmFtZSIsInRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lIiwiZnJvbUpTT04iLCJ0aGVuIiwicmVzcG9uc2VGcm9tVHJpZ2dlciIsInJlc3VsdHMiLCJyZXN1bHRzQXNKU09OIiwidHJpZ2dlckFmdGVyIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImpzb24iLCJwYXJzZVF1ZXJ5IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5IiwibGltaXQiLCJza2lwIiwiaW5jbHVkZSIsImV4Y2x1ZGVLZXlzIiwiZXhwbGFpbiIsIm9yZGVyIiwiaGludCIsImNvbW1lbnQiLCJyZWFkUHJlZmVyZW5jZSIsImluY2x1ZGVSZWFkUHJlZmVyZW5jZSIsInN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UiLCJBcnJheSIsImlzQXJyYXkiLCJldmVyeSIsImVyciIsImRlZmF1bHRPcHRzIiwiVXRpbHMiLCJpc05hdGl2ZUVycm9yIiwic3RhY2siLCJ0aGVWYWxpZGF0b3IiLCJidWlsdEluVHJpZ2dlclZhbGlkYXRvciIsImNhdGNoIiwiVkFMSURBVElPTl9FUlJPUiIsIm9wdGlvbnMiLCJ2YWxpZGF0ZU1hc3RlcktleSIsInJlcVVzZXIiLCJleGlzdGVkIiwicmVxdWlyZVVzZXIiLCJyZXF1aXJlQW55VXNlclJvbGVzIiwicmVxdWlyZUFsbFVzZXJSb2xlcyIsInJlcXVpcmVNYXN0ZXIiLCJwYXJhbXMiLCJyZXF1aXJlZFBhcmFtIiwidmFsaWRhdGVPcHRpb25zIiwib3B0Iiwib3B0cyIsImluY2x1ZGVzIiwiam9pbiIsImdldFR5cGUiLCJmbiIsIm1hdGNoIiwidG9TdHJpbmciLCJ0b0xvd2VyQ2FzZSIsImZpZWxkcyIsIm9wdGlvblByb21pc2VzIiwic2V0IiwiY29uc3RhbnQiLCJyZXZlcnQiLCJyZXF1aXJlZCIsIm9wdGlvbmFsIiwidmFsVHlwZSIsImFsbCIsInVzZXJSb2xlcyIsInJlcXVpcmVBbGxSb2xlcyIsInByb21pc2VzIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJyZXNvbHZlZFVzZXJSb2xlcyIsInJlc29sdmVkUmVxdWlyZUFsbCIsImhhc1JvbGUiLCJzb21lIiwicmVxdWlyZWRSb2xlIiwidXNlcktleXMiLCJyZXF1aXJlVXNlcktleXMiLCJtYXliZVJ1blRyaWdnZXIiLCJzdGFydHNXaXRoIiwidHJpZ2dlckJlZm9yZUVycm9yIiwicHJvbWlzZSIsImluZmxhdGUiLCJkYXRhIiwicmVzdE9iamVjdCIsImNvcHkiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZ2V0UmVxdWVzdEZpbGVPYmplY3QiLCJmaWxlT2JqZWN0IiwibWF5YmVSdW5GaWxlVHJpZ2dlciIsIkZpbGVDbGFzc05hbWUiLCJGaWxlIiwiZmlsZVRyaWdnZXIiLCJmb3JjZURvd25sb2FkIiwicmVzcG9uc2VIZWFkZXJzIiwiZmlsZSIsImZpbGVTaXplIiwibWF5YmVSdW5HbG9iYWxDb25maWdUcmlnZ2VyIiwiY29uZmlnT2JqZWN0Iiwib3JpZ2luYWxDb25maWdPYmplY3QiLCJHbG9iYWxDb25maWdDbGFzc05hbWUiLCJDb25maWciLCJjb25maWdUcmlnZ2VyIl0sInNvdXJjZXMiOlsiLi4vc3JjL3RyaWdnZXJzLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIHRyaWdnZXJzLmpzXG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi9VdGlscyc7XG5cbmV4cG9ydCBjb25zdCBUeXBlcyA9IHtcbiAgYmVmb3JlTG9naW46ICdiZWZvcmVMb2dpbicsXG4gIGFmdGVyTG9naW46ICdhZnRlckxvZ2luJyxcbiAgYWZ0ZXJMb2dvdXQ6ICdhZnRlckxvZ291dCcsXG4gIGJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0OiAnYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QnLFxuICBiZWZvcmVTYXZlOiAnYmVmb3JlU2F2ZScsXG4gIGFmdGVyU2F2ZTogJ2FmdGVyU2F2ZScsXG4gIGJlZm9yZURlbGV0ZTogJ2JlZm9yZURlbGV0ZScsXG4gIGFmdGVyRGVsZXRlOiAnYWZ0ZXJEZWxldGUnLFxuICBiZWZvcmVGaW5kOiAnYmVmb3JlRmluZCcsXG4gIGFmdGVyRmluZDogJ2FmdGVyRmluZCcsXG4gIGJlZm9yZUNvbm5lY3Q6ICdiZWZvcmVDb25uZWN0JyxcbiAgYmVmb3JlU3Vic2NyaWJlOiAnYmVmb3JlU3Vic2NyaWJlJyxcbiAgYWZ0ZXJFdmVudDogJ2FmdGVyRXZlbnQnLFxufTtcblxuY29uc3QgQ29ubmVjdENsYXNzTmFtZSA9ICdAQ29ubmVjdCc7XG5cbi8qKlxuICogQ3JlYXRlcyBhIHByb3RvdHlwZS1mcmVlIG9iamVjdCBmb3IgdXNlIGFzIGEgbG9va3VwIHN0b3JlLlxuICogVGhpcyBwcmV2ZW50cyBwcm90b3R5cGUgY2hhaW4gcHJvcGVydGllcyAoZS5nLiBgY29uc3RydWN0b3JgLCBgdG9TdHJpbmdgKVxuICogZnJvbSBiZWluZyByZXNvbHZlZCBhcyByZWdpc3RlcmVkIGhhbmRsZXJzIHdoZW4gdXNpbmcgYnJhY2tldCBub3RhdGlvblxuICogZm9yIGxvb2t1cHMuIEFsd2F5cyB1c2UgdGhpcyBpbnN0ZWFkIG9mIGB7fWAgZm9yIGhhbmRsZXIgc3RvcmVzLlxuICovXG5mdW5jdGlvbiBjcmVhdGVTdG9yZSgpIHtcbiAgcmV0dXJuIE9iamVjdC5jcmVhdGUobnVsbCk7XG59XG5cbmNvbnN0IGJhc2VTdG9yZSA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgVmFsaWRhdG9ycyA9IE9iamVjdC5rZXlzKFR5cGVzKS5yZWR1Y2UoZnVuY3Rpb24gKGJhc2UsIGtleSkge1xuICAgIGJhc2Vba2V5XSA9IGNyZWF0ZVN0b3JlKCk7XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sIGNyZWF0ZVN0b3JlKCkpO1xuICBjb25zdCBGdW5jdGlvbnMgPSBjcmVhdGVTdG9yZSgpO1xuICBjb25zdCBKb2JzID0gY3JlYXRlU3RvcmUoKTtcbiAgY29uc3QgTGl2ZVF1ZXJ5ID0gW107XG4gIGNvbnN0IFRyaWdnZXJzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0gY3JlYXRlU3RvcmUoKTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwgY3JlYXRlU3RvcmUoKSk7XG5cbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIEZ1bmN0aW9ucyxcbiAgICBKb2JzLFxuICAgIFZhbGlkYXRvcnMsXG4gICAgVHJpZ2dlcnMsXG4gICAgTGl2ZVF1ZXJ5LFxuICB9KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDbGFzc05hbWUocGFyc2VDbGFzcykge1xuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLmNsYXNzTmFtZSkge1xuICAgIHJldHVybiBwYXJzZUNsYXNzLmNsYXNzTmFtZTtcbiAgfVxuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLm5hbWUpIHtcbiAgICByZXR1cm4gcGFyc2VDbGFzcy5uYW1lLnJlcGxhY2UoJ1BhcnNlJywgJ0AnKTtcbiAgfVxuICByZXR1cm4gcGFyc2VDbGFzcztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpIHtcbiAgaWYgKHR5cGUgPT0gVHlwZXMuYmVmb3JlU2F2ZSAmJiBjbGFzc05hbWUgPT09ICdfUHVzaFN0YXR1cycpIHtcbiAgICAvLyBfUHVzaFN0YXR1cyB1c2VzIHVuZG9jdW1lbnRlZCBuZXN0ZWQga2V5IGluY3JlbWVudCBvcHNcbiAgICAvLyBhbGxvd2luZyBiZWZvcmVTYXZlIHdvdWxkIG1lc3MgdXAgdGhlIG9iamVjdHMgYmlnIHRpbWVcbiAgICAvLyBUT0RPOiBBbGxvdyBwcm9wZXIgZG9jdW1lbnRlZCB3YXkgb2YgdXNpbmcgbmVzdGVkIGluY3JlbWVudCBvcHNcbiAgICB0aHJvdyAnT25seSBhZnRlclNhdmUgaXMgYWxsb3dlZCBvbiBfUHVzaFN0YXR1cyc7XG4gIH1cbiAgaWYgKCh0eXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fCB0eXBlID09PSBUeXBlcy5hZnRlckxvZ2luIHx8IHR5cGUgPT09IFR5cGVzLmJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0KSAmJiBjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9Vc2VyIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBiZWZvcmVMb2dpbiwgYWZ0ZXJMb2dpbiwgYW5kIGJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0IHRyaWdnZXJzJztcbiAgfVxuICBpZiAodHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dvdXQgJiYgY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBfU2Vzc2lvbiBjbGFzcyBpcyBhbGxvd2VkIGZvciB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlci4nO1xuICB9XG4gIGlmIChjbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgJiYgdHlwZSAhPT0gVHlwZXMuYWZ0ZXJMb2dvdXQpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIGFmdGVyTG9nb3V0IHRyaWdnZXIgaXMgYWxsb3dlZCBmb3IgdGhlIF9TZXNzaW9uIGNsYXNzLic7XG4gIH1cbiAgcmV0dXJuIGNsYXNzTmFtZTtcbn1cblxuY29uc3QgX3RyaWdnZXJTdG9yZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbmNvbnN0IENhdGVnb3J5ID0ge1xuICBGdW5jdGlvbnM6ICdGdW5jdGlvbnMnLFxuICBWYWxpZGF0b3JzOiAnVmFsaWRhdG9ycycsXG4gIEpvYnM6ICdKb2JzJyxcbiAgVHJpZ2dlcnM6ICdUcmlnZ2VycycsXG59O1xuXG5mdW5jdGlvbiBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBpbnZhbGlkTmFtZVJlZ2V4ID0gL1snXCJgXS87XG4gIGlmIChpbnZhbGlkTmFtZVJlZ2V4LnRlc3QobmFtZSkpIHtcbiAgICAvLyBQcmV2ZW50IGEgbWFsaWNpb3VzIHVzZXIgZnJvbSBpbmplY3RpbmcgcHJvcGVydGllcyBpbnRvIHRoZSBzdG9yZVxuICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICB9XG5cbiAgY29uc3QgcGF0aCA9IG5hbWUuc3BsaXQoJy4nKTtcbiAgcGF0aC5zcGxpY2UoLTEpOyAvLyByZW1vdmUgbGFzdCBjb21wb25lbnRcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIGxldCBzdG9yZSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bY2F0ZWdvcnldO1xuICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBwYXRoKSB7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoc3RvcmUsIGNvbXBvbmVudCkpIHtcbiAgICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICAgIH1cbiAgICBzdG9yZSA9IHN0b3JlW2NvbXBvbmVudF07XG4gICAgaWYgKCFzdG9yZSB8fCBPYmplY3QuZ2V0UHJvdG90eXBlT2Yoc3RvcmUpICE9PSBudWxsKSB7XG4gICAgICByZXR1cm4gY3JlYXRlU3RvcmUoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHN0b3JlO1xufVxuXG5mdW5jdGlvbiBhZGQoY2F0ZWdvcnksIG5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgaWYgKHN0b3JlW2xhc3RDb21wb25lbnRdKSB7XG4gICAgbG9nZ2VyLndhcm4oXG4gICAgICBgV2FybmluZzogRHVwbGljYXRlIGNsb3VkIGZ1bmN0aW9ucyBleGlzdCBmb3IgJHtsYXN0Q29tcG9uZW50fS4gT25seSB0aGUgbGFzdCBvbmUgd2lsbCBiZSB1c2VkIGFuZCB0aGUgb3RoZXJzIHdpbGwgYmUgaWdub3JlZC5gXG4gICAgKTtcbiAgfVxuICBzdG9yZVtsYXN0Q29tcG9uZW50XSA9IGhhbmRsZXI7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBkZWxldGUgc3RvcmVbbGFzdENvbXBvbmVudF07XG59XG5cbmZ1bmN0aW9uIGdldChjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdG9yZSwgbGFzdENvbXBvbmVudCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKTtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbm5lY3RUcmlnZ2VyKHR5cGUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZExpdmVRdWVyeUV2ZW50SGFuZGxlcihoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvSlNPTndpdGhPYmplY3RzKG9iamVjdCwgY2xhc3NOYW1lKSB7XG4gIGlmICghb2JqZWN0IHx8ICFvYmplY3QudG9KU09OKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGNvbnN0IHRvSlNPTiA9IG9iamVjdC50b0pTT04oKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKG9iamVjdC5fZ2V0U3RhdGVJZGVudGlmaWVyKCkpO1xuICBmb3IgKGNvbnN0IGtleSBpbiBwZW5kaW5nKSB7XG4gICAgY29uc3QgdmFsID0gb2JqZWN0LmdldChrZXkpO1xuICAgIGlmICghdmFsIHx8ICF2YWwuX3RvRnVsbEpTT04pIHtcbiAgICAgIHRvSlNPTltrZXldID0gdmFsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRvSlNPTltrZXldID0gdmFsLl90b0Z1bGxKU09OKCk7XG4gIH1cbiAgLy8gUHJlc2VydmUgb3JpZ2luYWwgb2JqZWN0J3MgY2xhc3NOYW1lIGlmIG5vIG92ZXJyaWRlIGNsYXNzTmFtZSBpcyBwcm92aWRlZFxuICBpZiAoY2xhc3NOYW1lKSB7XG4gICAgdG9KU09OLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgfSBlbHNlIGlmIChvYmplY3QuY2xhc3NOYW1lICYmICF0b0pTT04uY2xhc3NOYW1lKSB7XG4gICAgdG9KU09OLmNsYXNzTmFtZSA9IG9iamVjdC5jbGFzc05hbWU7XG4gIH1cbiAgcmV0dXJuIHRvSlNPTjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyAnTWlzc2luZyBBcHBsaWNhdGlvbklEJztcbiAgfVxuICByZXR1cm4gZ2V0KENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5UcmlnZ2VyKHRyaWdnZXIsIG5hbWUsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIG5hbWUsIGF1dGgpO1xuICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gYXdhaXQgdHJpZ2dlcihyZXF1ZXN0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIHR5cGU6IHN0cmluZywgYXBwbGljYXRpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHlwZSwgYXBwbGljYXRpb25JZCkgIT0gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb25OYW1lcyhhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHN0b3JlID1cbiAgICAoX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSAmJiBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW0NhdGVnb3J5LkZ1bmN0aW9uc10pIHx8IHt9O1xuICBjb25zdCBmdW5jdGlvbk5hbWVzID0gW107XG4gIGNvbnN0IGV4dHJhY3RGdW5jdGlvbk5hbWVzID0gKG5hbWVzcGFjZSwgc3RvcmUpID0+IHtcbiAgICBPYmplY3Qua2V5cyhzdG9yZSkuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3RvcmVbbmFtZV07XG4gICAgICBpZiAobmFtZXNwYWNlKSB7XG4gICAgICAgIG5hbWUgPSBgJHtuYW1lc3BhY2V9LiR7bmFtZX1gO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBmdW5jdGlvbk5hbWVzLnB1c2gobmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBleHRyYWN0RnVuY3Rpb25OYW1lcyhuYW1lLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG4gIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG51bGwsIHN0b3JlKTtcbiAgcmV0dXJuIGZ1bmN0aW9uTmFtZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9icyhhcHBsaWNhdGlvbklkKSB7XG4gIHZhciBtYW5hZ2VyID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXTtcbiAgaWYgKG1hbmFnZXIgJiYgbWFuYWdlci5Kb2JzKSB7XG4gICAgcmV0dXJuIG1hbmFnZXIuSm9icztcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0T2JqZWN0KFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBvYmplY3Q6IHBhcnNlT2JqZWN0LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoaXNHZXQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlcXVlc3QuaXNHZXQgPSAhIWlzR2V0O1xuICB9XG5cbiAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICByZXF1ZXN0Lm9yaWdpbmFsID0gb3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgfVxuICBpZiAoXG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckxvZ2luIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0IHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRmluZFxuICApIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKE9iamVjdC5jcmVhdGUobnVsbCksIGNvbnRleHQpO1xuICB9XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHJlcXVlc3RbJ2lzUmVhZE9ubHknXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBxdWVyeSwgY291bnQsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpIHtcbiAgaXNHZXQgPSAhIWlzR2V0O1xuXG4gIHZhciByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBxdWVyeSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGlzUmVhZE9ubHk6IGZhbHNlLFxuICAgIGNvdW50LFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaXNHZXQsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdCwgd2l0aCBhIG51bGwgcHJvdG90eXBlIHNvIGFcbiAgICAvLyBwb2xsdXRlZCBPYmplY3QucHJvdG90eXBlIGNhbm5vdCBsZWFrIGludG8gdGhlIHRyaWdnZXIgY29udGV4dFxuICAgIGNvbnRleHQ6IE9iamVjdC5hc3NpZ24oT2JqZWN0LmNyZWF0ZShudWxsKSwgY29udGV4dCB8fCB7fSksXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICByZXF1ZXN0Wydpc1JlYWRPbmx5J10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuLy8gQ3JlYXRlcyB0aGUgcmVzcG9uc2Ugb2JqZWN0LCBhbmQgdXNlcyB0aGUgcmVxdWVzdCBvYmplY3QgdG8gcGFzcyBkYXRhXG4vLyBUaGUgQVBJIHdpbGwgY2FsbCB0aGlzIHdpdGggUkVTVCBBUEkgZm9ybWF0dGVkIG9iamVjdHMsIHRoaXMgd2lsbFxuLy8gdHJhbnNmb3JtIHRoZW0gdG8gUGFyc2UuT2JqZWN0IGluc3RhbmNlcyBleHBlY3RlZCBieSBDbG91ZCBDb2RlLlxuLy8gQW55IGNoYW5nZXMgbWFkZSB0byB0aGUgb2JqZWN0IGluIGEgYmVmb3JlU2F2ZSB3aWxsIGJlIGluY2x1ZGVkLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlc3BvbnNlT2JqZWN0KHJlcXVlc3QsIHJlc29sdmUsIHJlamVjdCkge1xuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IGZ1bmN0aW9uIChyZXNwb25zZSkge1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyRmluZCkge1xuICAgICAgICBpZiAoIXJlc3BvbnNlKSB7XG4gICAgICAgICAgcmVzcG9uc2UgPSByZXF1ZXN0Lm9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2UgPSByZXNwb25zZS5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICByZXR1cm4gdG9KU09Od2l0aE9iamVjdHMob2JqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIC8vIFVzZSB0aGUgSlNPTiByZXNwb25zZVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFyZXF1ZXN0Lm9iamVjdC5lcXVhbHMocmVzcG9uc2UpICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJiByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgICByZXNwb25zZVsnb2JqZWN0J11bJ29iamVjdElkJ10gPSByZXF1ZXN0Lm9iamVjdC5pZDtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICB9LFxuICAgIGVycm9yOiBmdW5jdGlvbiAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGUgPSByZXNvbHZlRXJyb3IoZXJyb3IsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgbWVzc2FnZTogJ1NjcmlwdCBmYWlsZWQuIFVua25vd24gZXJyb3IuJyxcbiAgICAgIH0pO1xuICAgICAgcmVqZWN0KGUpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHVzZXJJZEZvckxvZyhhdXRoKSB7XG4gIHJldHVybiBhdXRoICYmIGF1dGgudXNlciA/IGF1dGgudXNlci5pZCA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCByZXN1bHQsIGF1dGgsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgY29uc3QgY2xlYW5SZXN1bHQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoLCBlcnJvciwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6ICR7SlNPTi5zdHJpbmdpZnkoZXJyb3IpfWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBlcnJvcixcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBjbGFzc05hbWVRdWVyeSxcbiAgb2JqZWN0c0lucHV0LFxuICBjb25maWcsXG4gIHF1ZXJ5LFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lUXVlcnksIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG5cbiAgICBpZiAoIXRyaWdnZXIpIHtcbiAgICAgIGlmIChvYmplY3RzSW5wdXQgJiYgb2JqZWN0c0lucHV0Lmxlbmd0aCA+IDAgJiYgb2JqZWN0c0lucHV0WzBdIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dC5tYXAob2JqID0+IHRvSlNPTndpdGhPYmplY3RzKG9iaikpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dCB8fCBbXSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpO1xuICAgIC8vIENvbnZlcnQgcXVlcnkgcGFyYW1ldGVyIHRvIFBhcnNlLlF1ZXJ5IGluc3RhbmNlXG4gICAgaWYgKHF1ZXJ5IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBxdWVyeTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeSA9PT0gJ29iamVjdCcgJiYgcXVlcnkgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IHBhcnNlUXVlcnlJbnN0YW5jZSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWVRdWVyeSk7XG4gICAgICBpZiAocXVlcnkud2hlcmUpIHtcbiAgICAgICAgcGFyc2VRdWVyeUluc3RhbmNlLndpdGhKU09OKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIHJlcXVlc3QucXVlcnkgPSBwYXJzZVF1ZXJ5SW5zdGFuY2U7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lUXVlcnkpO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIHByb2Nlc3NlZE9iamVjdHNKU09OID0+IHtcbiAgICAgICAgcmVzb2x2ZShwcm9jZXNzZWRPYmplY3RzSlNPTik7XG4gICAgICB9LFxuICAgICAgZXJyb3JEYXRhID0+IHtcbiAgICAgICAgcmVqZWN0KGVycm9yRGF0YSk7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZVF1ZXJ5LFxuICAgICAgJ0FmdGVyRmluZCBJbnB1dCAoUHJlLVRyYW5zZm9ybSknLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIG9iamVjdHNJbnB1dC5tYXAobyA9PiAobyBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCA/IG8uaWQgKyAnOicgKyBvLmNsYXNzTmFtZSA6IG8pKVxuICAgICAgKSxcbiAgICAgIGF1dGgsXG4gICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgKTtcblxuICAgIC8vIENvbnZlcnQgcGxhaW4gb2JqZWN0cyB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGZvciB0cmlnZ2VyXG4gICAgcmVxdWVzdC5vYmplY3RzID0gb2JqZWN0c0lucHV0Lm1hcChjdXJyZW50T2JqZWN0ID0+IHtcbiAgICAgIGlmIChjdXJyZW50T2JqZWN0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiBjdXJyZW50T2JqZWN0O1xuICAgICAgfVxuICAgICAgLy8gUHJlc2VydmUgdGhlIG9yaWdpbmFsIGNsYXNzTmFtZSBpZiBpdCBleGlzdHMsIG90aGVyd2lzZSB1c2UgdGhlIHF1ZXJ5IGNsYXNzTmFtZVxuICAgICAgY29uc3Qgb3JpZ2luYWxDbGFzc05hbWUgPSBjdXJyZW50T2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWVRdWVyeTtcbiAgICAgIGNvbnN0IHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lID0geyAuLi5jdXJyZW50T2JqZWN0LCBjbGFzc05hbWU6IG9yaWdpbmFsQ2xhc3NOYW1lIH07XG4gICAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lKTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZVF1ZXJ5fWAsIGF1dGgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlRnJvbVRyaWdnZXIgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAocmVzcG9uc2VGcm9tVHJpZ2dlciAmJiB0eXBlb2YgcmVzcG9uc2VGcm9tVHJpZ2dlci50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlRnJvbVRyaWdnZXIudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNwb25zZUZyb21UcmlnZ2VyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSkudGhlbihyZXN1bHRzQXNKU09OID0+IHtcbiAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWVRdWVyeSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHJlc3VsdHNBc0pTT04pLFxuICAgICAgYXV0aCxcbiAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0c0FzSlNPTjtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlLFxuICByZXN0T3B0aW9ucyxcbiAgY29uZmlnLFxuICBhdXRoLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBqc29uID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdE9wdGlvbnMpO1xuICBqc29uLndoZXJlID0gcmVzdFdoZXJlO1xuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgcGFyc2VRdWVyeS53aXRoSlNPTihqc29uKTtcblxuICBsZXQgY291bnQgPSBmYWxzZTtcbiAgaWYgKHJlc3RPcHRpb25zKSB7XG4gICAgY291bnQgPSAhIXJlc3RPcHRpb25zLmNvdW50O1xuICB9XG4gIGNvbnN0IHJlcXVlc3RPYmplY3QgPSBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgYXV0aCxcbiAgICBwYXJzZVF1ZXJ5LFxuICAgIGNvdW50LFxuICAgIGNvbmZpZyxcbiAgICBjb250ZXh0LFxuICAgIGlzR2V0XG4gICk7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0T2JqZWN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAocmVxdWVzdE9iamVjdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gcmVxdWVzdE9iamVjdC5xdWVyeTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cmlnZ2VyKHJlcXVlc3RPYmplY3QpO1xuICAgIH0pXG4gICAgLnRoZW4oXG4gICAgICByZXN1bHQgPT4ge1xuICAgICAgICAvLyBQcm9wYWdhdGUgYW55IGNvbnRleHQgbXV0YXRpb25zIG1hZGUgYnkgdGhlIHRyaWdnZXIgYmFjayB0byB0aGUgc2hhcmVkIGNvbnRleHQsXG4gICAgICAgIC8vIG1pcnJvcmluZyB0aGUgd3JpdGUtYmFjayBmb3Igb3RoZXIgdHJpZ2dlciB0eXBlcyBpbiBtYXliZVJ1blRyaWdnZXIuIFRoaXMgcHJlc2VydmVzXG4gICAgICAgIC8vIGJlZm9yZUZpbmQgLT4gYWZ0ZXJGaW5kIGNvbnRleHQgcHJvcGFnYXRpb24gbm93IHRoYXQgdGhlIHJlcXVlc3QgY29udGV4dCBpcyBhIGNvcHkuXG4gICAgICAgIGlmIChjb250ZXh0KSB7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihjb250ZXh0LCByZXF1ZXN0T2JqZWN0LmNvbnRleHQpO1xuICAgICAgICB9XG4gICAgICAgIGxldCBxdWVyeVJlc3VsdCA9IHBhcnNlUXVlcnk7XG4gICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgICAgICBxdWVyeVJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBqc29uUXVlcnkgPSBxdWVyeVJlc3VsdC50b0pTT04oKTtcbiAgICAgICAgaWYgKGpzb25RdWVyeS53aGVyZSkge1xuICAgICAgICAgIHJlc3RXaGVyZSA9IGpzb25RdWVyeS53aGVyZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmxpbWl0KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5saW1pdCA9IGpzb25RdWVyeS5saW1pdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LnNraXApIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnNraXAgPSBqc29uUXVlcnkuc2tpcDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmluY2x1ZGUpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBqc29uUXVlcnkuaW5jbHVkZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmV4Y2x1ZGVLZXlzKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5leGNsdWRlS2V5cyA9IGpzb25RdWVyeS5leGNsdWRlS2V5cztcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmV4cGxhaW4pIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmV4cGxhaW4gPSBqc29uUXVlcnkuZXhwbGFpbjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmtleXMpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmtleXMgPSBqc29uUXVlcnkua2V5cztcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5Lm9yZGVyKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5vcmRlciA9IGpzb25RdWVyeS5vcmRlcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmhpbnQpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmhpbnQgPSBqc29uUXVlcnkuaGludDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmNvbW1lbnQpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmNvbW1lbnQgPSBqc29uUXVlcnkuY29tbWVudDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgb2JqZWN0cyA9IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICAgIG9iamVjdHMgPSBbcmVzdWx0XTtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBBcnJheS5pc0FycmF5KHJlc3VsdCkgJiZcbiAgICAgICAgICAoIXJlc3VsdC5sZW5ndGggfHwgcmVzdWx0LmV2ZXJ5KG9iaiA9PiBvYmogaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpKVxuICAgICAgICApIHtcbiAgICAgICAgICBvYmplY3RzID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICAgIHJlc3RPcHRpb25zLFxuICAgICAgICAgIG9iamVjdHMsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgICAgZXJyID0+IHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSByZXNvbHZlRXJyb3IoZXJyLCB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgICB9KTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVFcnJvcihtZXNzYWdlLCBkZWZhdWx0T3B0cykge1xuICBpZiAoIWRlZmF1bHRPcHRzKSB7XG4gICAgZGVmYXVsdE9wdHMgPSB7fTtcbiAgfVxuICBpZiAoIW1lc3NhZ2UpIHtcbiAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgZGVmYXVsdE9wdHMuY29kZSB8fCBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgZGVmYXVsdE9wdHMubWVzc2FnZSB8fCAnU2NyaXB0IGZhaWxlZC4nXG4gICAgKTtcbiAgfVxuICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgcmV0dXJuIG1lc3NhZ2U7XG4gIH1cblxuICBjb25zdCBjb2RlID0gZGVmYXVsdE9wdHMuY29kZSB8fCBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVEO1xuICAvLyBJZiBpdCdzIGFuIGVycm9yLCBtYXJrIGl0IGFzIGEgc2NyaXB0IGZhaWxlZFxuICBpZiAodHlwZW9mIG1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlKTtcbiAgfVxuICBjb25zdCBlcnJvciA9IG5ldyBQYXJzZS5FcnJvcihjb2RlLCBtZXNzYWdlLm1lc3NhZ2UgfHwgbWVzc2FnZSk7XG4gIGlmIChVdGlscy5pc05hdGl2ZUVycm9yKG1lc3NhZ2UpKSB7XG4gICAgZXJyb3Iuc3RhY2sgPSBtZXNzYWdlLnN0YWNrO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBmdW5jdGlvbk5hbWUsIGF1dGgpIHtcbiAgY29uc3QgdGhlVmFsaWRhdG9yID0gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdGhlVmFsaWRhdG9yKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0JyAmJiB0aGVWYWxpZGF0b3Iuc2tpcFdpdGhNYXN0ZXJLZXkgJiYgcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICByZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5ID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCdcbiAgICAgICAgICA/IGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKHRoZVZhbGlkYXRvciwgcmVxdWVzdCwgYXV0aClcbiAgICAgICAgICA6IHRoZVZhbGlkYXRvcihyZXF1ZXN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6ICdWYWxpZGF0aW9uIGZhaWxlZC4nLFxuICAgICAgICB9KTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKG9wdGlvbnMsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKHJlcXVlc3QubWFzdGVyICYmICFvcHRpb25zLnZhbGlkYXRlTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZXFVc2VyID0gcmVxdWVzdC51c2VyO1xuICBpZiAoXG4gICAgIXJlcVVzZXIgJiZcbiAgICByZXF1ZXN0Lm9iamVjdCAmJlxuICAgIHJlcXVlc3Qub2JqZWN0LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICFyZXF1ZXN0Lm9iamVjdC5leGlzdGVkKClcbiAgKSB7XG4gICAgcmVxVXNlciA9IHJlcXVlc3Qub2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICAob3B0aW9ucy5yZXF1aXJlVXNlciB8fCBvcHRpb25zLnJlcXVpcmVBbnlVc2VyUm9sZXMgfHwgb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzKSAmJlxuICAgICFyZXFVc2VyXG4gICkge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIGxvZ2luIHRvIGNvbnRpbnVlLic7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmVxdWlyZU1hc3RlciAmJiAhcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIE1hc3RlciBrZXkgaXMgcmVxdWlyZWQgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0Lic7XG4gIH1cbiAgbGV0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zIHx8IHt9O1xuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICBwYXJhbXMgPSByZXF1ZXN0Lm9iamVjdC50b0pTT04oKTtcbiAgfVxuICBjb25zdCByZXF1aXJlZFBhcmFtID0ga2V5ID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtc1trZXldO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzcGVjaWZ5IGRhdGEgZm9yICR7a2V5fS5gO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2YWxpZGF0ZU9wdGlvbnMgPSBhc3luYyAob3B0LCBrZXksIHZhbCkgPT4ge1xuICAgIGxldCBvcHRzID0gb3B0Lm9wdGlvbnM7XG4gICAgaWYgKHR5cGVvZiBvcHRzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcHRzKHZhbCk7XG4gICAgICAgIGlmICghcmVzdWx0ICYmIHJlc3VsdCAhPSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFlKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgZS5tZXNzYWdlIHx8IGU7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShvcHRzKSkge1xuICAgICAgb3B0cyA9IFtvcHQub3B0aW9uc107XG4gICAgfVxuXG4gICAgaWYgKCFvcHRzLmluY2x1ZGVzKHZhbCkpIHtcbiAgICAgIHRocm93IChcbiAgICAgICAgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCBvcHRpb24gZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7b3B0cy5qb2luKCcsICcpfWBcbiAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdldFR5cGUgPSBmbiA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSBmbiAmJiBmbi50b1N0cmluZygpLm1hdGNoKC9eXFxzKmZ1bmN0aW9uIChcXHcrKS8pO1xuICAgIHJldHVybiAobWF0Y2ggPyBtYXRjaFsxXSA6ICcnKS50b0xvd2VyQ2FzZSgpO1xuICB9O1xuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpZWxkcykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBvcHRpb25Qcm9taXNlcyA9IFtdO1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLmZpZWxkc1trZXldO1xuICAgICAgbGV0IHZhbCA9IHBhcmFtc1trZXldO1xuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmVkUGFyYW0ob3B0KTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCAmJiB2YWwgPT0gbnVsbCkge1xuICAgICAgICAgIHZhbCA9IG9wdC5kZWZhdWx0O1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgdmFsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5jb25zdGFudCAmJiByZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9yaWdpbmFsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5yZXZlcnQoa2V5KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIG9wdC5kZWZhdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5yZXF1aXJlZCkge1xuICAgICAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcHRpb25hbCA9ICFvcHQucmVxdWlyZWQgJiYgdmFsID09PSB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghb3B0aW9uYWwpIHtcbiAgICAgICAgICBpZiAob3B0LnR5cGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBnZXRUeXBlKG9wdC50eXBlKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbFR5cGUgPSBBcnJheS5pc0FycmF5KHZhbCkgPyAnYXJyYXknIDogdHlwZW9mIHZhbDtcbiAgICAgICAgICAgIGlmICh2YWxUeXBlICE9PSB0eXBlKSB7XG4gICAgICAgICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB0eXBlIGZvciAke2tleX0uIEV4cGVjdGVkOiAke3R5cGV9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgICAgICBvcHRpb25Qcm9taXNlcy5wdXNoKHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgdmFsKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKG9wdGlvblByb21pc2VzKTtcbiAgfVxuICBsZXQgdXNlclJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQW55VXNlclJvbGVzO1xuICBsZXQgcmVxdWlyZUFsbFJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzO1xuICBjb25zdCBwcm9taXNlcyA9IFtQcm9taXNlLnJlc29sdmUoKSwgUHJvbWlzZS5yZXNvbHZlKCksIFByb21pc2UucmVzb2x2ZSgpXTtcbiAgaWYgKHVzZXJSb2xlcyB8fCByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBwcm9taXNlc1swXSA9IGF1dGguZ2V0VXNlclJvbGVzKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB1c2VyUm9sZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBwcm9taXNlc1sxXSA9IHVzZXJSb2xlcygpO1xuICB9XG4gIGlmICh0eXBlb2YgcmVxdWlyZUFsbFJvbGVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcHJvbWlzZXNbMl0gPSByZXF1aXJlQWxsUm9sZXMoKTtcbiAgfVxuICBjb25zdCBbcm9sZXMsIHJlc29sdmVkVXNlclJvbGVzLCByZXNvbHZlZFJlcXVpcmVBbGxdID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICBpZiAocmVzb2x2ZWRVc2VyUm9sZXMgJiYgQXJyYXkuaXNBcnJheShyZXNvbHZlZFVzZXJSb2xlcykpIHtcbiAgICB1c2VyUm9sZXMgPSByZXNvbHZlZFVzZXJSb2xlcztcbiAgfVxuICBpZiAocmVzb2x2ZWRSZXF1aXJlQWxsICYmIEFycmF5LmlzQXJyYXkocmVzb2x2ZWRSZXF1aXJlQWxsKSkge1xuICAgIHJlcXVpcmVBbGxSb2xlcyA9IHJlc29sdmVkUmVxdWlyZUFsbDtcbiAgfVxuICBpZiAodXNlclJvbGVzKSB7XG4gICAgY29uc3QgaGFzUm9sZSA9IHVzZXJSb2xlcy5zb21lKHJlcXVpcmVkUm9sZSA9PiByb2xlcy5pbmNsdWRlcyhgcm9sZToke3JlcXVpcmVkUm9sZX1gKSk7XG4gICAgaWYgKCFoYXNSb2xlKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFVzZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJlcXVpcmVkIHJvbGVzLmA7XG4gICAgfVxuICB9XG4gIGlmIChyZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlcXVpcmVkUm9sZSBvZiByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICAgIGlmICghcm9sZXMuaW5jbHVkZXMoYHJvbGU6JHtyZXF1aXJlZFJvbGV9YCkpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBVc2VyIGRvZXMgbm90IG1hdGNoIGFsbCB0aGUgcmVxdWlyZWQgcm9sZXMuYDtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3QgdXNlcktleXMgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cyB8fCBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodXNlcktleXMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdXNlcktleXMpIHtcbiAgICAgIGlmICghcmVxVXNlcikge1xuICAgICAgICB0aHJvdyAnUGxlYXNlIGxvZ2luIHRvIG1ha2UgdGhpcyByZXF1ZXN0Lic7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXFVc2VyLmdldChrZXkpID09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc2V0IGRhdGEgZm9yICR7a2V5fSBvbiB5b3VyIGFjY291bnQuYDtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIHVzZXJLZXlzID09PSAnb2JqZWN0Jykge1xuICAgIGNvbnN0IG9wdGlvblByb21pc2VzID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMpIHtcbiAgICAgIGNvbnN0IG9wdCA9IG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzW2tleV07XG4gICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgb3B0aW9uUHJvbWlzZXMucHVzaCh2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHJlcVVzZXIuZ2V0KGtleSkpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwob3B0aW9uUHJvbWlzZXMpO1xuICB9XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIocGFyc2VPYmplY3QuY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikgeyByZXR1cm4gcmVzb2x2ZSgpOyB9XG4gICAgdmFyIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBhdXRoLFxuICAgICAgcGFyc2VPYmplY3QsXG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgY29uZmlnLFxuICAgICAgY29udGV4dFxuICAgICk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgdHJpZ2dlclR5cGUuc3RhcnRzV2l0aCgnYWZ0ZXInKVxuICAgICAgICAgICAgPyBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJBZnRlclxuICAgICAgICAgICAgOiBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICAgICk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlXG4gICAgICAgICkge1xuICAgICAgICAgIE9iamVjdC5hc3NpZ24oY29udGV4dCwgcmVxdWVzdC5jb250ZXh0KTtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGVycm9yLFxuICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICAgICk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEFmdGVyU2F2ZSBhbmQgYWZ0ZXJEZWxldGUgdHJpZ2dlcnMgY2FuIHJldHVybiBhIHByb21pc2UsIHdoaWNoIGlmIHRoZXlcbiAgICAvLyBkbywgbmVlZHMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHRoaXMgcHJvbWlzZSBpcyByZXNvbHZlZCxcbiAgICAvLyBzbyB0cmlnZ2VyIGV4ZWN1dGlvbiBpcyBzeW5jZWQgd2l0aCBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgLy8gSWYgdHJpZ2dlcnMgZG8gbm90IHJldHVybiBhIHByb21pc2UsIHRoZXkgY2FuIHJ1biBhc3luYyBjb2RlIHBhcmFsbGVsXG4gICAgLy8gdG8gdGhlIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke3BhcnNlT2JqZWN0LmNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckxvZ2luXG4gICAgICAgICkge1xuICAgICAgICAgIGxvZ1RyaWdnZXJBZnRlckhvb2soXG4gICAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKGRhdGEsIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkKSB7XG4gIGlmICghX3RyaWdnZXJTdG9yZSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZykge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIC4uLmZpbGVPYmplY3QsXG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgcmVxdWVzdFsnaXNSZWFkT25seSddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkZpbGVUcmlnZ2VyKHRyaWdnZXJUeXBlLCBmaWxlT2JqZWN0LCBjb25maWcsIGF1dGgpIHtcbiAgY29uc3QgRmlsZUNsYXNzTmFtZSA9IGdldENsYXNzTmFtZShQYXJzZS5GaWxlKTtcbiAgY29uc3QgZmlsZVRyaWdnZXIgPSBnZXRUcmlnZ2VyKEZpbGVDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgZmlsZVRyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpO1xuICAgICAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7RmlsZUNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBmaWxlT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmlsZVRyaWdnZXIocmVxdWVzdCk7XG4gICAgICBpZiAocmVxdWVzdC5mb3JjZURvd25sb2FkKSB7XG4gICAgICAgIGZpbGVPYmplY3QuZm9yY2VEb3dubG9hZCA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC5yZXNwb25zZUhlYWRlcnMpIHtcbiAgICAgICAgZmlsZU9iamVjdC5yZXNwb25zZUhlYWRlcnMgPSByZXF1ZXN0LnJlc3BvbnNlSGVhZGVycztcbiAgICAgIH1cbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgfHwgZmlsZU9iamVjdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGVycm9yLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVFcnJvclxuICAgICAgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmlsZU9iamVjdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuR2xvYmFsQ29uZmlnVHJpZ2dlcih0cmlnZ2VyVHlwZSwgYXV0aCwgY29uZmlnT2JqZWN0LCBvcmlnaW5hbENvbmZpZ09iamVjdCwgY29uZmlnLCBjb250ZXh0KSB7XG4gIGNvbnN0IEdsb2JhbENvbmZpZ0NsYXNzTmFtZSA9IGdldENsYXNzTmFtZShQYXJzZS5Db25maWcpO1xuICBjb25zdCBjb25maWdUcmlnZ2VyID0gZ2V0VHJpZ2dlcihHbG9iYWxDb25maWdDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgY29uZmlnVHJpZ2dlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgY29uZmlnT2JqZWN0LCBvcmlnaW5hbENvbmZpZ09iamVjdCwgY29uZmlnLCBjb250ZXh0KTtcbiAgICAgIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke0dsb2JhbENvbmZpZ0NsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBjb25maWdPYmplY3Q7XG4gICAgICB9XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjb25maWdUcmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkNvbmZpZycsXG4gICAgICAgIGNvbmZpZ09iamVjdCxcbiAgICAgICAgcmVzdWx0LFxuICAgICAgICBhdXRoLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJlc3VsdCB8fCBjb25maWdPYmplY3Q7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuQ29uZmlnJyxcbiAgICAgICAgY29uZmlnT2JqZWN0LFxuICAgICAgICBhdXRoLFxuICAgICAgICBlcnJvcixcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlRXJyb3JcbiAgICAgICk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZ09iamVjdDtcbn1cbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLElBQUFBLEtBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE9BQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLE1BQUEsR0FBQUgsc0JBQUEsQ0FBQUMsT0FBQTtBQUE0QixTQUFBRCx1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