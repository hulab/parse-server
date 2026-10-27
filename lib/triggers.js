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
    const optionValidations = [];
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
            optionValidations.push([opt, key, val]);
          }
        }
      }
    }
    await Promise.all(optionValidations.map(([o, k, v]) => validateOptions(o, k, v)));
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
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, _Utils.default.safeToJSON(parseObject), object, auth, triggerType.startsWith('after') ? config.logLevels.triggerAfter : config.logLevels.triggerBeforeSuccess);
      if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
        Object.assign(context, request.context);
      }
      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, _Utils.default.safeToJSON(parseObject), auth, error, config.logLevels.triggerBeforeError);
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
        logTriggerAfterHook(triggerType, parseObject.className, _Utils.default.safeToJSON(parseObject), auth, config.logLevels.triggerAfter);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2xvZ2dlciIsIl9VdGlscyIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlR5cGVzIiwiZXhwb3J0cyIsImJlZm9yZUxvZ2luIiwiYWZ0ZXJMb2dpbiIsImFmdGVyTG9nb3V0IiwiYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QiLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmVmb3JlQ29ubmVjdCIsImJlZm9yZVN1YnNjcmliZSIsImFmdGVyRXZlbnQiLCJDb25uZWN0Q2xhc3NOYW1lIiwiY3JlYXRlU3RvcmUiLCJPYmplY3QiLCJjcmVhdGUiLCJiYXNlU3RvcmUiLCJWYWxpZGF0b3JzIiwia2V5cyIsInJlZHVjZSIsImJhc2UiLCJrZXkiLCJGdW5jdGlvbnMiLCJKb2JzIiwiTGl2ZVF1ZXJ5IiwiVHJpZ2dlcnMiLCJmcmVlemUiLCJnZXRDbGFzc05hbWUiLCJwYXJzZUNsYXNzIiwiY2xhc3NOYW1lIiwibmFtZSIsInJlcGxhY2UiLCJ2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzIiwidHlwZSIsIl90cmlnZ2VyU3RvcmUiLCJDYXRlZ29yeSIsImdldFN0b3JlIiwiY2F0ZWdvcnkiLCJhcHBsaWNhdGlvbklkIiwiaW52YWxpZE5hbWVSZWdleCIsInRlc3QiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiZ2V0UHJvdG90eXBlT2YiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJ1bmRlZmluZWQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsInRvSlNPTndpdGhPYmplY3RzIiwib2JqZWN0IiwidG9KU09OIiwic3RhdGVDb250cm9sbGVyIiwiQ29yZU1hbmFnZXIiLCJnZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIiLCJwZW5kaW5nIiwiZ2V0UGVuZGluZ09wcyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJ2YWwiLCJfdG9GdWxsSlNPTiIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsInJ1blRyaWdnZXIiLCJ0cmlnZ2VyIiwicmVxdWVzdCIsImF1dGgiLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwidHJpZ2dlckV4aXN0cyIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsImlzR2V0IiwidHJpZ2dlck5hbWUiLCJtYXN0ZXIiLCJpc1JlYWRPbmx5IiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImhlYWRlcnMiLCJpcCIsIm9yaWdpbmFsIiwiYXNzaWduIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJnZXRSZXF1ZXN0UXVlcnlPYmplY3QiLCJxdWVyeSIsImNvdW50IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImlkIiwiZXJyb3IiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImxvZ1RyaWdnZXJBZnRlckhvb2siLCJpbnB1dCIsImxvZ0xldmVsIiwiY2xlYW5JbnB1dCIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2siLCJyZXN1bHQiLCJjbGVhblJlc3VsdCIsImxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2siLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJjbGFzc05hbWVRdWVyeSIsIm9iamVjdHNJbnB1dCIsIlByb21pc2UiLCJsZW5ndGgiLCJvYmoiLCJRdWVyeSIsInBhcnNlUXVlcnlJbnN0YW5jZSIsIndoZXJlIiwid2l0aEpTT04iLCJwcm9jZXNzZWRPYmplY3RzSlNPTiIsImVycm9yRGF0YSIsIm8iLCJsb2dMZXZlbHMiLCJ0cmlnZ2VyQmVmb3JlU3VjY2VzcyIsImN1cnJlbnRPYmplY3QiLCJvcmlnaW5hbENsYXNzTmFtZSIsInRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lIiwiZnJvbUpTT04iLCJ0aGVuIiwicmVzcG9uc2VGcm9tVHJpZ2dlciIsInJlc3VsdHMiLCJyZXN1bHRzQXNKU09OIiwidHJpZ2dlckFmdGVyIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImpzb24iLCJwYXJzZVF1ZXJ5IiwicmVxdWVzdE9iamVjdCIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5IiwibGltaXQiLCJza2lwIiwiaW5jbHVkZSIsImV4Y2x1ZGVLZXlzIiwiZXhwbGFpbiIsIm9yZGVyIiwiaGludCIsImNvbW1lbnQiLCJyZWFkUHJlZmVyZW5jZSIsImluY2x1ZGVSZWFkUHJlZmVyZW5jZSIsInN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UiLCJBcnJheSIsImlzQXJyYXkiLCJldmVyeSIsImVyciIsImRlZmF1bHRPcHRzIiwiVXRpbHMiLCJpc05hdGl2ZUVycm9yIiwic3RhY2siLCJ0aGVWYWxpZGF0b3IiLCJidWlsdEluVHJpZ2dlclZhbGlkYXRvciIsImNhdGNoIiwiVkFMSURBVElPTl9FUlJPUiIsIm9wdGlvbnMiLCJ2YWxpZGF0ZU1hc3RlcktleSIsInJlcVVzZXIiLCJleGlzdGVkIiwicmVxdWlyZVVzZXIiLCJyZXF1aXJlQW55VXNlclJvbGVzIiwicmVxdWlyZUFsbFVzZXJSb2xlcyIsInJlcXVpcmVNYXN0ZXIiLCJwYXJhbXMiLCJyZXF1aXJlZFBhcmFtIiwidmFsaWRhdGVPcHRpb25zIiwib3B0Iiwib3B0cyIsImluY2x1ZGVzIiwiam9pbiIsImdldFR5cGUiLCJmbiIsIm1hdGNoIiwidG9TdHJpbmciLCJ0b0xvd2VyQ2FzZSIsImZpZWxkcyIsIm9wdGlvblZhbGlkYXRpb25zIiwic2V0IiwiY29uc3RhbnQiLCJyZXZlcnQiLCJyZXF1aXJlZCIsIm9wdGlvbmFsIiwidmFsVHlwZSIsImFsbCIsImsiLCJ2IiwidXNlclJvbGVzIiwicmVxdWlyZUFsbFJvbGVzIiwicHJvbWlzZXMiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsInJlc29sdmVkVXNlclJvbGVzIiwicmVzb2x2ZWRSZXF1aXJlQWxsIiwiaGFzUm9sZSIsInNvbWUiLCJyZXF1aXJlZFJvbGUiLCJ1c2VyS2V5cyIsInJlcXVpcmVVc2VyS2V5cyIsIm9wdGlvblByb21pc2VzIiwibWF5YmVSdW5UcmlnZ2VyIiwic2FmZVRvSlNPTiIsInN0YXJ0c1dpdGgiLCJ0cmlnZ2VyQmVmb3JlRXJyb3IiLCJwcm9taXNlIiwiaW5mbGF0ZSIsImRhdGEiLCJyZXN0T2JqZWN0IiwiY29weSIsInJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMiLCJnZXRSZXF1ZXN0RmlsZU9iamVjdCIsImZpbGVPYmplY3QiLCJtYXliZVJ1bkZpbGVUcmlnZ2VyIiwiRmlsZUNsYXNzTmFtZSIsIkZpbGUiLCJmaWxlVHJpZ2dlciIsImZvcmNlRG93bmxvYWQiLCJyZXNwb25zZUhlYWRlcnMiLCJmaWxlIiwiZmlsZVNpemUiLCJtYXliZVJ1bkdsb2JhbENvbmZpZ1RyaWdnZXIiLCJjb25maWdPYmplY3QiLCJvcmlnaW5hbENvbmZpZ09iamVjdCIsIkdsb2JhbENvbmZpZ0NsYXNzTmFtZSIsIkNvbmZpZyIsImNvbmZpZ1RyaWdnZXIiXSwic291cmNlcyI6WyIuLi9zcmMvdHJpZ2dlcnMuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gdHJpZ2dlcnMuanNcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCBVdGlscyBmcm9tICcuL1V0aWxzJztcblxuZXhwb3J0IGNvbnN0IFR5cGVzID0ge1xuICBiZWZvcmVMb2dpbjogJ2JlZm9yZUxvZ2luJyxcbiAgYWZ0ZXJMb2dpbjogJ2FmdGVyTG9naW4nLFxuICBhZnRlckxvZ291dDogJ2FmdGVyTG9nb3V0JyxcbiAgYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3Q6ICdiZWZvcmVQYXNzd29yZFJlc2V0UmVxdWVzdCcsXG4gIGJlZm9yZVNhdmU6ICdiZWZvcmVTYXZlJyxcbiAgYWZ0ZXJTYXZlOiAnYWZ0ZXJTYXZlJyxcbiAgYmVmb3JlRGVsZXRlOiAnYmVmb3JlRGVsZXRlJyxcbiAgYWZ0ZXJEZWxldGU6ICdhZnRlckRlbGV0ZScsXG4gIGJlZm9yZUZpbmQ6ICdiZWZvcmVGaW5kJyxcbiAgYWZ0ZXJGaW5kOiAnYWZ0ZXJGaW5kJyxcbiAgYmVmb3JlQ29ubmVjdDogJ2JlZm9yZUNvbm5lY3QnLFxuICBiZWZvcmVTdWJzY3JpYmU6ICdiZWZvcmVTdWJzY3JpYmUnLFxuICBhZnRlckV2ZW50OiAnYWZ0ZXJFdmVudCcsXG59O1xuXG5jb25zdCBDb25uZWN0Q2xhc3NOYW1lID0gJ0BDb25uZWN0JztcblxuLyoqXG4gKiBDcmVhdGVzIGEgcHJvdG90eXBlLWZyZWUgb2JqZWN0IGZvciB1c2UgYXMgYSBsb29rdXAgc3RvcmUuXG4gKiBUaGlzIHByZXZlbnRzIHByb3RvdHlwZSBjaGFpbiBwcm9wZXJ0aWVzIChlLmcuIGBjb25zdHJ1Y3RvcmAsIGB0b1N0cmluZ2ApXG4gKiBmcm9tIGJlaW5nIHJlc29sdmVkIGFzIHJlZ2lzdGVyZWQgaGFuZGxlcnMgd2hlbiB1c2luZyBicmFja2V0IG5vdGF0aW9uXG4gKiBmb3IgbG9va3Vwcy4gQWx3YXlzIHVzZSB0aGlzIGluc3RlYWQgb2YgYHt9YCBmb3IgaGFuZGxlciBzdG9yZXMuXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVN0b3JlKCkge1xuICByZXR1cm4gT2JqZWN0LmNyZWF0ZShudWxsKTtcbn1cblxuY29uc3QgYmFzZVN0b3JlID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBWYWxpZGF0b3JzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0gY3JlYXRlU3RvcmUoKTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwgY3JlYXRlU3RvcmUoKSk7XG4gIGNvbnN0IEZ1bmN0aW9ucyA9IGNyZWF0ZVN0b3JlKCk7XG4gIGNvbnN0IEpvYnMgPSBjcmVhdGVTdG9yZSgpO1xuICBjb25zdCBMaXZlUXVlcnkgPSBbXTtcbiAgY29uc3QgVHJpZ2dlcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSBjcmVhdGVTdG9yZSgpO1xuICAgIHJldHVybiBiYXNlO1xuICB9LCBjcmVhdGVTdG9yZSgpKTtcblxuICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgRnVuY3Rpb25zLFxuICAgIEpvYnMsXG4gICAgVmFsaWRhdG9ycyxcbiAgICBUcmlnZ2VycyxcbiAgICBMaXZlUXVlcnksXG4gIH0pO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldENsYXNzTmFtZShwYXJzZUNsYXNzKSB7XG4gIGlmIChwYXJzZUNsYXNzICYmIHBhcnNlQ2xhc3MuY2xhc3NOYW1lKSB7XG4gICAgcmV0dXJuIHBhcnNlQ2xhc3MuY2xhc3NOYW1lO1xuICB9XG4gIGlmIChwYXJzZUNsYXNzICYmIHBhcnNlQ2xhc3MubmFtZSkge1xuICAgIHJldHVybiBwYXJzZUNsYXNzLm5hbWUucmVwbGFjZSgnUGFyc2UnLCAnQCcpO1xuICB9XG4gIHJldHVybiBwYXJzZUNsYXNzO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzKGNsYXNzTmFtZSwgdHlwZSkge1xuICBpZiAodHlwZSA9PSBUeXBlcy5iZWZvcmVTYXZlICYmIGNsYXNzTmFtZSA9PT0gJ19QdXNoU3RhdHVzJykge1xuICAgIC8vIF9QdXNoU3RhdHVzIHVzZXMgdW5kb2N1bWVudGVkIG5lc3RlZCBrZXkgaW5jcmVtZW50IG9wc1xuICAgIC8vIGFsbG93aW5nIGJlZm9yZVNhdmUgd291bGQgbWVzcyB1cCB0aGUgb2JqZWN0cyBiaWcgdGltZVxuICAgIC8vIFRPRE86IEFsbG93IHByb3BlciBkb2N1bWVudGVkIHdheSBvZiB1c2luZyBuZXN0ZWQgaW5jcmVtZW50IG9wc1xuICAgIHRocm93ICdPbmx5IGFmdGVyU2F2ZSBpcyBhbGxvd2VkIG9uIF9QdXNoU3RhdHVzJztcbiAgfVxuICBpZiAoKHR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8IHR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4gfHwgdHlwZSA9PT0gVHlwZXMuYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QpICYmIGNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1VzZXIgY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGJlZm9yZUxvZ2luLCBhZnRlckxvZ2luLCBhbmQgYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QgdHJpZ2dlcnMnO1xuICB9XG4gIGlmICh0eXBlID09PSBUeXBlcy5hZnRlckxvZ291dCAmJiBjbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9TZXNzaW9uIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBhZnRlckxvZ291dCB0cmlnZ2VyLic7XG4gIH1cbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJyAmJiB0eXBlICE9PSBUeXBlcy5hZnRlckxvZ291dCkge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlciBpcyBhbGxvd2VkIGZvciB0aGUgX1Nlc3Npb24gY2xhc3MuJztcbiAgfVxuICByZXR1cm4gY2xhc3NOYW1lO1xufVxuXG5jb25zdCBfdHJpZ2dlclN0b3JlID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJyxcbn07XG5cbmZ1bmN0aW9uIGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGludmFsaWROYW1lUmVnZXggPSAvWydcImBdLztcbiAgaWYgKGludmFsaWROYW1lUmVnZXgudGVzdChuYW1lKSkge1xuICAgIC8vIFByZXZlbnQgYSBtYWxpY2lvdXMgdXNlciBmcm9tIGluamVjdGluZyBwcm9wZXJ0aWVzIGludG8gdGhlIHN0b3JlXG4gICAgcmV0dXJuIGNyZWF0ZVN0b3JlKCk7XG4gIH1cblxuICBjb25zdCBwYXRoID0gbmFtZS5zcGxpdCgnLicpO1xuICBwYXRoLnNwbGljZSgtMSk7IC8vIHJlbW92ZSBsYXN0IGNvbXBvbmVudFxuICBhcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCBiYXNlU3RvcmUoKTtcbiAgbGV0IHN0b3JlID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXVtjYXRlZ29yeV07XG4gIGZvciAoY29uc3QgY29tcG9uZW50IG9mIHBhdGgpIHtcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdG9yZSwgY29tcG9uZW50KSkge1xuICAgICAgcmV0dXJuIGNyZWF0ZVN0b3JlKCk7XG4gICAgfVxuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlIHx8IE9iamVjdC5nZXRQcm90b3R5cGVPZihzdG9yZSkgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RvcmU7XG59XG5cbmZ1bmN0aW9uIGFkZChjYXRlZ29yeSwgbmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoc3RvcmVbbGFzdENvbXBvbmVudF0pIHtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGBXYXJuaW5nOiBEdXBsaWNhdGUgY2xvdWQgZnVuY3Rpb25zIGV4aXN0IGZvciAke2xhc3RDb21wb25lbnR9LiBPbmx5IHRoZSBsYXN0IG9uZSB3aWxsIGJlIHVzZWQgYW5kIHRoZSBvdGhlcnMgd2lsbCBiZSBpZ25vcmVkLmBcbiAgICApO1xuICB9XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHN0b3JlLCBsYXN0Q29tcG9uZW50KSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRKb2Ioam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkQ29ubmVjdFRyaWdnZXIodHlwZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LnB1c2goaGFuZGxlcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfdW5yZWdpc3RlckFsbCgpIHtcbiAgT2JqZWN0LmtleXMoX3RyaWdnZXJTdG9yZSkuZm9yRWFjaChhcHBJZCA9PiBkZWxldGUgX3RyaWdnZXJTdG9yZVthcHBJZF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9KU09Od2l0aE9iamVjdHMob2JqZWN0LCBjbGFzc05hbWUpIHtcbiAgaWYgKCFvYmplY3QgfHwgIW9iamVjdC50b0pTT04pIHtcbiAgICByZXR1cm4ge307XG4gIH1cbiAgY29uc3QgdG9KU09OID0gb2JqZWN0LnRvSlNPTigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMob2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKSk7XG4gIGZvciAoY29uc3Qga2V5IGluIHBlbmRpbmcpIHtcbiAgICBjb25zdCB2YWwgPSBvYmplY3QuZ2V0KGtleSk7XG4gICAgaWYgKCF2YWwgfHwgIXZhbC5fdG9GdWxsSlNPTikge1xuICAgICAgdG9KU09OW2tleV0gPSB2YWw7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdG9KU09OW2tleV0gPSB2YWwuX3RvRnVsbEpTT04oKTtcbiAgfVxuICAvLyBQcmVzZXJ2ZSBvcmlnaW5hbCBvYmplY3QncyBjbGFzc05hbWUgaWYgbm8gb3ZlcnJpZGUgY2xhc3NOYW1lIGlzIHByb3ZpZGVkXG4gIGlmIChjbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB9IGVsc2UgaWYgKG9iamVjdC5jbGFzc05hbWUgJiYgIXRvSlNPTi5jbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gb2JqZWN0LmNsYXNzTmFtZTtcbiAgfVxuICByZXR1cm4gdG9KU09OO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIGlmICghYXBwbGljYXRpb25JZCkge1xuICAgIHRocm93ICdNaXNzaW5nIEFwcGxpY2F0aW9uSUQnO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blRyaWdnZXIodHJpZ2dlciwgbmFtZSwgcmVxdWVzdCwgYXV0aCkge1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgbmFtZSwgYXV0aCk7XG4gIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiBhd2FpdCB0cmlnZ2VyKHJlcXVlc3QpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJpZ2dlckV4aXN0cyhjbGFzc05hbWU6IHN0cmluZywgdHlwZTogc3RyaW5nLCBhcHBsaWNhdGlvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0eXBlLCBhcHBsaWNhdGlvbklkKSAhPSB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbk5hbWVzKGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3Qgc3RvcmUgPVxuICAgIChfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdICYmIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bQ2F0ZWdvcnkuRnVuY3Rpb25zXSkgfHwge307XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXMgPSBbXTtcbiAgY29uc3QgZXh0cmFjdEZ1bmN0aW9uTmFtZXMgPSAobmFtZXNwYWNlLCBzdG9yZSkgPT4ge1xuICAgIE9iamVjdC5rZXlzKHN0b3JlKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdG9yZVtuYW1lXTtcbiAgICAgIGlmIChuYW1lc3BhY2UpIHtcbiAgICAgICAgbmFtZSA9IGAke25hbWVzcGFjZX0uJHtuYW1lfWA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZXMucHVzaChuYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG5hbWUsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobnVsbCwgc3RvcmUpO1xuICByZXR1cm4gZnVuY3Rpb25OYW1lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2JzKGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFyIG1hbmFnZXIgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdO1xuICBpZiAobWFuYWdlciAmJiBtYW5hZ2VyLkpvYnMpIHtcbiAgICByZXR1cm4gbWFuYWdlci5Kb2JzO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG9iamVjdDogcGFyc2VPYmplY3QsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBpc1JlYWRPbmx5OiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmIChpc0dldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVxdWVzdC5pc0dldCA9ICEhaXNHZXQ7XG4gIH1cblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4gfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kXG4gICkge1xuICAgIC8vIFNldCBhIGNvcHkgb2YgdGhlIGNvbnRleHQgb24gdGhlIHJlcXVlc3Qgb2JqZWN0LlxuICAgIHJlcXVlc3QuY29udGV4dCA9IE9iamVjdC5hc3NpZ24oT2JqZWN0LmNyZWF0ZShudWxsKSwgY29udGV4dCk7XG4gIH1cblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgcmVxdWVzdFsnaXNSZWFkT25seSddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0UXVlcnlPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIHF1ZXJ5LCBjb3VudCwgY29uZmlnLCBjb250ZXh0LCBpc0dldCkge1xuICBpc0dldCA9ICEhaXNHZXQ7XG5cbiAgdmFyIHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIHF1ZXJ5LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgY291bnQsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBpc0dldCxcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIC8vIFNldCBhIGNvcHkgb2YgdGhlIGNvbnRleHQgb24gdGhlIHJlcXVlc3Qgb2JqZWN0LCB3aXRoIGEgbnVsbCBwcm90b3R5cGUgc28gYVxuICAgIC8vIHBvbGx1dGVkIE9iamVjdC5wcm90b3R5cGUgY2Fubm90IGxlYWsgaW50byB0aGUgdHJpZ2dlciBjb250ZXh0XG4gICAgY29udGV4dDogT2JqZWN0LmFzc2lnbihPYmplY3QuY3JlYXRlKG51bGwpLCBjb250ZXh0IHx8IHt9KSxcbiAgICBjb25maWcsXG4gIH07XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHJlcXVlc3RbJ2lzUmVhZE9ubHknXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG4vLyBDcmVhdGVzIHRoZSByZXNwb25zZSBvYmplY3QsIGFuZCB1c2VzIHRoZSByZXF1ZXN0IG9iamVjdCB0byBwYXNzIGRhdGFcbi8vIFRoZSBBUEkgd2lsbCBjYWxsIHRoaXMgd2l0aCBSRVNUIEFQSSBmb3JtYXR0ZWQgb2JqZWN0cywgdGhpcyB3aWxsXG4vLyB0cmFuc2Zvcm0gdGhlbSB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGV4cGVjdGVkIGJ5IENsb3VkIENvZGUuXG4vLyBBbnkgY2hhbmdlcyBtYWRlIHRvIHRoZSBvYmplY3QgaW4gYSBiZWZvcmVTYXZlIHdpbGwgYmUgaW5jbHVkZWQuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVzcG9uc2VPYmplY3QocmVxdWVzdCwgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogZnVuY3Rpb24gKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kKSB7XG4gICAgICAgIGlmICghcmVzcG9uc2UpIHtcbiAgICAgICAgICByZXNwb25zZSA9IHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZSA9IHJlc3BvbnNlLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIHJldHVybiB0b0pTT053aXRoT2JqZWN0cyhvYmplY3QpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgLy8gVXNlIHRoZSBKU09OIHJlc3BvbnNlXG4gICAgICBpZiAoXG4gICAgICAgIHJlc3BvbnNlICYmXG4gICAgICAgIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgIXJlcXVlc3Qub2JqZWN0LmVxdWFscyhyZXNwb25zZSkgJiZcbiAgICAgICAgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXNwb25zZSAmJiB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKCk7XG4gICAgICB9XG4gICAgICByZXNwb25zZSA9IHt9O1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgcmVzcG9uc2VbJ29iamVjdCddID0gcmVxdWVzdC5vYmplY3QuX2dldFNhdmVKU09OKCk7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXVsnb2JqZWN0SWQnXSA9IHJlcXVlc3Qub2JqZWN0LmlkO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgY29uc3QgZSA9IHJlc29sdmVFcnJvcihlcnJvciwge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgfSk7XG4gICAgICByZWplY3QoZSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXNlcklkRm9yTG9nKGF1dGgpIHtcbiAgcmV0dXJuIGF1dGggJiYgYXV0aC51c2VyID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoLCBsb2dMZXZlbCkge1xuICBpZiAobG9nTGV2ZWwgPT09ICdzaWxlbnQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlcltsb2dMZXZlbF0oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OiBJbnB1dDogJHtjbGVhbklucHV0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIHJlc3VsdCwgYXV0aCwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gIGxvZ2dlcltsb2dMZXZlbF0oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OiBJbnB1dDogJHtjbGVhbklucHV0fSBSZXN1bHQ6ICR7Y2xlYW5SZXN1bHR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIGF1dGgsIGVycm9yLCBsb2dMZXZlbCkge1xuICBpZiAobG9nTGV2ZWwgPT09ICdzaWxlbnQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlcltsb2dMZXZlbF0oXG4gICAgYCR7dHJpZ2dlclR5cGV9IGZhaWxlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OiBJbnB1dDogJHtjbGVhbklucHV0fSBFcnJvcjogJHtKU09OLnN0cmluZ2lmeShlcnJvcil9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGVycm9yLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZVF1ZXJ5LFxuICBvYmplY3RzSW5wdXQsXG4gIGNvbmZpZyxcbiAgcXVlcnksXG4gIGNvbnRleHQsXG4gIGlzR2V0XG4pIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWVRdWVyeSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcblxuICAgIGlmICghdHJpZ2dlcikge1xuICAgICAgaWYgKG9iamVjdHNJbnB1dCAmJiBvYmplY3RzSW5wdXQubGVuZ3RoID4gMCAmJiBvYmplY3RzSW5wdXRbMF0gaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUob2JqZWN0c0lucHV0Lm1hcChvYmogPT4gdG9KU09Od2l0aE9iamVjdHMob2JqKSkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUob2JqZWN0c0lucHV0IHx8IFtdKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgbnVsbCwgbnVsbCwgY29uZmlnLCBjb250ZXh0LCBpc0dldCk7XG4gICAgLy8gQ29udmVydCBxdWVyeSBwYXJhbWV0ZXIgdG8gUGFyc2UuUXVlcnkgaW5zdGFuY2VcbiAgICBpZiAocXVlcnkgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgICAgcmVxdWVzdC5xdWVyeSA9IHF1ZXJ5O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5ID09PSAnb2JqZWN0JyAmJiBxdWVyeSAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgcGFyc2VRdWVyeUluc3RhbmNlID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZVF1ZXJ5KTtcbiAgICAgIGlmIChxdWVyeS53aGVyZSkge1xuICAgICAgICBwYXJzZVF1ZXJ5SW5zdGFuY2Uud2l0aEpTT04ocXVlcnkpO1xuICAgICAgfVxuICAgICAgcmVxdWVzdC5xdWVyeSA9IHBhcnNlUXVlcnlJbnN0YW5jZTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVxdWVzdC5xdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWVRdWVyeSk7XG4gICAgfVxuXG4gICAgY29uc3QgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgcHJvY2Vzc2VkT2JqZWN0c0pTT04gPT4ge1xuICAgICAgICByZXNvbHZlKHByb2Nlc3NlZE9iamVjdHNKU09OKTtcbiAgICAgIH0sXG4gICAgICBlcnJvckRhdGEgPT4ge1xuICAgICAgICByZWplY3QoZXJyb3JEYXRhKTtcbiAgICAgIH1cbiAgICApO1xuICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgY2xhc3NOYW1lUXVlcnksXG4gICAgICAnQWZ0ZXJGaW5kIElucHV0IChQcmUtVHJhbnNmb3JtKScsXG4gICAgICBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgb2JqZWN0c0lucHV0Lm1hcChvID0+IChvIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0ID8gby5pZCArICc6JyArIG8uY2xhc3NOYW1lIDogbykpXG4gICAgICApLFxuICAgICAgYXV0aCxcbiAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZVN1Y2Nlc3NcbiAgICApO1xuXG4gICAgLy8gQ29udmVydCBwbGFpbiBvYmplY3RzIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZm9yIHRyaWdnZXJcbiAgICByZXF1ZXN0Lm9iamVjdHMgPSBvYmplY3RzSW5wdXQubWFwKGN1cnJlbnRPYmplY3QgPT4ge1xuICAgICAgaWYgKGN1cnJlbnRPYmplY3QgaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnRPYmplY3Q7XG4gICAgICB9XG4gICAgICAvLyBQcmVzZXJ2ZSB0aGUgb3JpZ2luYWwgY2xhc3NOYW1lIGlmIGl0IGV4aXN0cywgb3RoZXJ3aXNlIHVzZSB0aGUgcXVlcnkgY2xhc3NOYW1lXG4gICAgICBjb25zdCBvcmlnaW5hbENsYXNzTmFtZSA9IGN1cnJlbnRPYmplY3QuY2xhc3NOYW1lIHx8IGNsYXNzTmFtZVF1ZXJ5O1xuICAgICAgY29uc3QgdGVtcE9iamVjdFdpdGhDbGFzc05hbWUgPSB7IC4uLmN1cnJlbnRPYmplY3QsIGNsYXNzTmFtZTogb3JpZ2luYWxDbGFzc05hbWUgfTtcbiAgICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04odGVtcE9iamVjdFdpdGhDbGFzc05hbWUpO1xuICAgIH0pO1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lUXVlcnl9YCwgYXV0aCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiByZXF1ZXN0Lm9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzcG9uc2VGcm9tVHJpZ2dlciA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgIGlmIChyZXNwb25zZUZyb21UcmlnZ2VyICYmIHR5cGVvZiByZXNwb25zZUZyb21UcmlnZ2VyLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICByZXR1cm4gcmVzcG9uc2VGcm9tVHJpZ2dlci50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlRnJvbVRyaWdnZXI7XG4gICAgICB9KVxuICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KS50aGVuKHJlc3VsdHNBc0pTT04gPT4ge1xuICAgIGxvZ1RyaWdnZXJBZnRlckhvb2soXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZVF1ZXJ5LFxuICAgICAgSlNPTi5zdHJpbmdpZnkocmVzdWx0c0FzSlNPTiksXG4gICAgICBhdXRoLFxuICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQWZ0ZXJcbiAgICApO1xuICAgIHJldHVybiByZXN1bHRzQXNKU09OO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuUXVlcnlUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUsXG4gIHJlc3RPcHRpb25zLFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNvbnRleHQsXG4gIGlzR2V0XG4pIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHtcbiAgICAgIHJlc3RXaGVyZSxcbiAgICAgIHJlc3RPcHRpb25zLFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IGpzb24gPSBPYmplY3QuYXNzaWduKHt9LCByZXN0T3B0aW9ucyk7XG4gIGpzb24ud2hlcmUgPSByZXN0V2hlcmU7XG5cbiAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICBwYXJzZVF1ZXJ5LndpdGhKU09OKGpzb24pO1xuXG4gIGxldCBjb3VudCA9IGZhbHNlO1xuICBpZiAocmVzdE9wdGlvbnMpIHtcbiAgICBjb3VudCA9ICEhcmVzdE9wdGlvbnMuY291bnQ7XG4gIH1cbiAgY29uc3QgcmVxdWVzdE9iamVjdCA9IGdldFJlcXVlc3RRdWVyeU9iamVjdChcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBhdXRoLFxuICAgIHBhcnNlUXVlcnksXG4gICAgY291bnQsXG4gICAgY29uZmlnLFxuICAgIGNvbnRleHQsXG4gICAgaXNHZXRcbiAgKTtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3RPYmplY3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiByZXF1ZXN0T2JqZWN0LnF1ZXJ5O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdE9iamVjdCk7XG4gICAgfSlcbiAgICAudGhlbihcbiAgICAgIHJlc3VsdCA9PiB7XG4gICAgICAgIC8vIFByb3BhZ2F0ZSBhbnkgY29udGV4dCBtdXRhdGlvbnMgbWFkZSBieSB0aGUgdHJpZ2dlciBiYWNrIHRvIHRoZSBzaGFyZWQgY29udGV4dCxcbiAgICAgICAgLy8gbWlycm9yaW5nIHRoZSB3cml0ZS1iYWNrIGZvciBvdGhlciB0cmlnZ2VyIHR5cGVzIGluIG1heWJlUnVuVHJpZ2dlci4gVGhpcyBwcmVzZXJ2ZXNcbiAgICAgICAgLy8gYmVmb3JlRmluZCAtPiBhZnRlckZpbmQgY29udGV4dCBwcm9wYWdhdGlvbiBub3cgdGhhdCB0aGUgcmVxdWVzdCBjb250ZXh0IGlzIGEgY29weS5cbiAgICAgICAgaWYgKGNvbnRleHQpIHtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3RPYmplY3QuY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgICAgbGV0IHF1ZXJ5UmVzdWx0ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgaWYgKHJlc3VsdCAmJiByZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5RdWVyeSkge1xuICAgICAgICAgIHF1ZXJ5UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGpzb25RdWVyeSA9IHF1ZXJ5UmVzdWx0LnRvSlNPTigpO1xuICAgICAgICBpZiAoanNvblF1ZXJ5LndoZXJlKSB7XG4gICAgICAgICAgcmVzdFdoZXJlID0ganNvblF1ZXJ5LndoZXJlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkubGltaXQpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmxpbWl0ID0ganNvblF1ZXJ5LmxpbWl0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuc2tpcCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuc2tpcCA9IGpzb25RdWVyeS5za2lwO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuaW5jbHVkZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGpzb25RdWVyeS5pbmNsdWRlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuZXhjbHVkZUtleXMpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzID0ganNvblF1ZXJ5LmV4Y2x1ZGVLZXlzO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuZXhwbGFpbikge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuZXhwbGFpbiA9IGpzb25RdWVyeS5leHBsYWluO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkua2V5cykge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMua2V5cyA9IGpzb25RdWVyeS5rZXlzO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkub3JkZXIpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLm9yZGVyID0ganNvblF1ZXJ5Lm9yZGVyO1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuaGludCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaGludCA9IGpzb25RdWVyeS5oaW50O1xuICAgICAgICB9XG4gICAgICAgIGlmIChqc29uUXVlcnkuY29tbWVudCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuY29tbWVudCA9IGpzb25RdWVyeS5jb21tZW50O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGxldCBvYmplY3RzID0gdW5kZWZpbmVkO1xuICAgICAgICBpZiAocmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgICAgb2JqZWN0cyA9IFtyZXN1bHRdO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIEFycmF5LmlzQXJyYXkocmVzdWx0KSAmJlxuICAgICAgICAgICghcmVzdWx0Lmxlbmd0aCB8fCByZXN1bHQuZXZlcnkob2JqID0+IG9iaiBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkpXG4gICAgICAgICkge1xuICAgICAgICAgIG9iamVjdHMgPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICByZXN0V2hlcmUsXG4gICAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgICAgb2JqZWN0cyxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBlcnIgPT4ge1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICAgIG1lc3NhZ2U6ICdTY3JpcHQgZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICAgIH0pO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUVycm9yKG1lc3NhZ2UsIGRlZmF1bHRPcHRzKSB7XG4gIGlmICghZGVmYXVsdE9wdHMpIHtcbiAgICBkZWZhdWx0T3B0cyA9IHt9O1xuICB9XG4gIGlmICghbWVzc2FnZSkge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBkZWZhdWx0T3B0cy5jb2RlIHx8IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICBkZWZhdWx0T3B0cy5tZXNzYWdlIHx8ICdTY3JpcHQgZmFpbGVkLidcbiAgICApO1xuICB9XG4gIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICByZXR1cm4gbWVzc2FnZTtcbiAgfVxuXG4gIGNvbnN0IGNvZGUgPSBkZWZhdWx0T3B0cy5jb2RlIHx8IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQ7XG4gIC8vIElmIGl0J3MgYW4gZXJyb3IsIG1hcmsgaXQgYXMgYSBzY3JpcHQgZmFpbGVkXG4gIGlmICh0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UpO1xuICB9XG4gIGNvbnN0IGVycm9yID0gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UubWVzc2FnZSB8fCBtZXNzYWdlKTtcbiAgaWYgKFV0aWxzLmlzTmF0aXZlRXJyb3IobWVzc2FnZSkpIHtcbiAgICBlcnJvci5zdGFjayA9IG1lc3NhZ2Uuc3RhY2s7XG4gIH1cbiAgcmV0dXJuIGVycm9yO1xufVxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGZ1bmN0aW9uTmFtZSwgYXV0aCkge1xuICBjb25zdCB0aGVWYWxpZGF0b3IgPSBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0aGVWYWxpZGF0b3IpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHR5cGVvZiB0aGVWYWxpZGF0b3IgPT09ICdvYmplY3QnICYmIHRoZVZhbGlkYXRvci5za2lwV2l0aE1hc3RlcktleSAmJiByZXF1ZXN0Lm1hc3Rlcikge1xuICAgIHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkgPSB0cnVlO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiB0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0J1xuICAgICAgICAgID8gYnVpbHRJblRyaWdnZXJWYWxpZGF0b3IodGhlVmFsaWRhdG9yLCByZXF1ZXN0LCBhdXRoKVxuICAgICAgICAgIDogdGhlVmFsaWRhdG9yKHJlcXVlc3QpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlID0+IHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSByZXNvbHZlRXJyb3IoZSwge1xuICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgbWVzc2FnZTogJ1ZhbGlkYXRpb24gZmFpbGVkLicsXG4gICAgICAgIH0pO1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfSk7XG4gIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gYnVpbHRJblRyaWdnZXJWYWxpZGF0b3Iob3B0aW9ucywgcmVxdWVzdCwgYXV0aCkge1xuICBpZiAocmVxdWVzdC5tYXN0ZXIgJiYgIW9wdGlvbnMudmFsaWRhdGVNYXN0ZXJLZXkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgbGV0IHJlcVVzZXIgPSByZXF1ZXN0LnVzZXI7XG4gIGlmIChcbiAgICAhcmVxVXNlciAmJlxuICAgIHJlcXVlc3Qub2JqZWN0ICYmXG4gICAgcmVxdWVzdC5vYmplY3QuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgIXJlcXVlc3Qub2JqZWN0LmV4aXN0ZWQoKVxuICApIHtcbiAgICByZXFVc2VyID0gcmVxdWVzdC5vYmplY3Q7XG4gIH1cbiAgaWYgKFxuICAgIChvcHRpb25zLnJlcXVpcmVVc2VyIHx8IG9wdGlvbnMucmVxdWlyZUFueVVzZXJSb2xlcyB8fCBvcHRpb25zLnJlcXVpcmVBbGxVc2VyUm9sZXMpICYmXG4gICAgIXJlcVVzZXJcbiAgKSB7XG4gICAgdGhyb3cgJ1ZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2UgbG9naW4gdG8gY29udGludWUuJztcbiAgfVxuICBpZiAob3B0aW9ucy5yZXF1aXJlTWFzdGVyICYmICFyZXF1ZXN0Lm1hc3Rlcikge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gTWFzdGVyIGtleSBpcyByZXF1aXJlZCB0byBjb21wbGV0ZSB0aGlzIHJlcXVlc3QuJztcbiAgfVxuICBsZXQgcGFyYW1zID0gcmVxdWVzdC5wYXJhbXMgfHwge307XG4gIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgIHBhcmFtcyA9IHJlcXVlc3Qub2JqZWN0LnRvSlNPTigpO1xuICB9XG4gIGNvbnN0IHJlcXVpcmVkUGFyYW0gPSBrZXkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gcGFyYW1zW2tleV07XG4gICAgaWYgKHZhbHVlID09IG51bGwpIHtcbiAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIHNwZWNpZnkgZGF0YSBmb3IgJHtrZXl9LmA7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZhbGlkYXRlT3B0aW9ucyA9IGFzeW5jIChvcHQsIGtleSwgdmFsKSA9PiB7XG4gICAgbGV0IG9wdHMgPSBvcHQub3B0aW9ucztcbiAgICBpZiAodHlwZW9mIG9wdHMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9wdHModmFsKTtcbiAgICAgICAgaWYgKCFyZXN1bHQgJiYgcmVzdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHZhbHVlIGZvciAke2tleX0uYDtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoIWUpIHtcbiAgICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHZhbHVlIGZvciAke2tleX0uYDtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG9wdC5lcnJvciB8fCBlLm1lc3NhZ2UgfHwgZTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG9wdHMpKSB7XG4gICAgICBvcHRzID0gW29wdC5vcHRpb25zXTtcbiAgICB9XG5cbiAgICBpZiAoIW9wdHMuaW5jbHVkZXModmFsKSkge1xuICAgICAgdGhyb3cgKFxuICAgICAgICBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIG9wdGlvbiBmb3IgJHtrZXl9LiBFeHBlY3RlZDogJHtvcHRzLmpvaW4oJywgJyl9YFxuICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgZ2V0VHlwZSA9IGZuID0+IHtcbiAgICBjb25zdCBtYXRjaCA9IGZuICYmIGZuLnRvU3RyaW5nKCkubWF0Y2goL15cXHMqZnVuY3Rpb24gKFxcdyspLyk7XG4gICAgcmV0dXJuIChtYXRjaCA/IG1hdGNoWzFdIDogJycpLnRvTG93ZXJDYXNlKCk7XG4gIH07XG4gIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuZmllbGRzKSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICByZXF1aXJlZFBhcmFtKGtleSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IG9wdGlvblZhbGlkYXRpb25zID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucy5maWVsZHMpIHtcbiAgICAgIGNvbnN0IG9wdCA9IG9wdGlvbnMuZmllbGRzW2tleV07XG4gICAgICBsZXQgdmFsID0gcGFyYW1zW2tleV07XG4gICAgICBpZiAodHlwZW9mIG9wdCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgcmVxdWlyZWRQYXJhbShvcHQpO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGlmIChvcHQuZGVmYXVsdCAhPSBudWxsICYmIHZhbCA9PSBudWxsKSB7XG4gICAgICAgICAgdmFsID0gb3B0LmRlZmF1bHQ7XG4gICAgICAgICAgcGFyYW1zW2tleV0gPSB2YWw7XG4gICAgICAgICAgaWYgKHJlcXVlc3Qub2JqZWN0KSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5zZXQoa2V5LCB2YWwpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0LmNvbnN0YW50ICYmIHJlcXVlc3Qub2JqZWN0KSB7XG4gICAgICAgICAgaWYgKHJlcXVlc3Qub3JpZ2luYWwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnJldmVydChrZXkpO1xuICAgICAgICAgIH0gZWxzZSBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgb3B0LmRlZmF1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0LnJlcXVpcmVkKSB7XG4gICAgICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG9wdGlvbmFsID0gIW9wdC5yZXF1aXJlZCAmJiB2YWwgPT09IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKCFvcHRpb25hbCkge1xuICAgICAgICAgIGlmIChvcHQudHlwZSkge1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGdldFR5cGUob3B0LnR5cGUpO1xuICAgICAgICAgICAgY29uc3QgdmFsVHlwZSA9IEFycmF5LmlzQXJyYXkodmFsKSA/ICdhcnJheScgOiB0eXBlb2YgdmFsO1xuICAgICAgICAgICAgaWYgKHZhbFR5cGUgIT09IHR5cGUpIHtcbiAgICAgICAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHR5cGUgZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7dHlwZX1gO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgICAgIG9wdGlvblZhbGlkYXRpb25zLnB1c2goW29wdCwga2V5LCB2YWxdKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwob3B0aW9uVmFsaWRhdGlvbnMubWFwKChbbywgaywgdl0pID0+IHZhbGlkYXRlT3B0aW9ucyhvLCBrLCB2KSkpO1xuICB9XG4gIGxldCB1c2VyUm9sZXMgPSBvcHRpb25zLnJlcXVpcmVBbnlVc2VyUm9sZXM7XG4gIGxldCByZXF1aXJlQWxsUm9sZXMgPSBvcHRpb25zLnJlcXVpcmVBbGxVc2VyUm9sZXM7XG4gIGNvbnN0IHByb21pc2VzID0gW1Byb21pc2UucmVzb2x2ZSgpLCBQcm9taXNlLnJlc29sdmUoKSwgUHJvbWlzZS5yZXNvbHZlKCldO1xuICBpZiAodXNlclJvbGVzIHx8IHJlcXVpcmVBbGxSb2xlcykge1xuICAgIHByb21pc2VzWzBdID0gYXV0aC5nZXRVc2VyUm9sZXMoKTtcbiAgfVxuICBpZiAodHlwZW9mIHVzZXJSb2xlcyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHByb21pc2VzWzFdID0gdXNlclJvbGVzKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiByZXF1aXJlQWxsUm9sZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBwcm9taXNlc1syXSA9IHJlcXVpcmVBbGxSb2xlcygpO1xuICB9XG4gIGNvbnN0IFtyb2xlcywgcmVzb2x2ZWRVc2VyUm9sZXMsIHJlc29sdmVkUmVxdWlyZUFsbF0gPSBhd2FpdCBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gIGlmIChyZXNvbHZlZFVzZXJSb2xlcyAmJiBBcnJheS5pc0FycmF5KHJlc29sdmVkVXNlclJvbGVzKSkge1xuICAgIHVzZXJSb2xlcyA9IHJlc29sdmVkVXNlclJvbGVzO1xuICB9XG4gIGlmIChyZXNvbHZlZFJlcXVpcmVBbGwgJiYgQXJyYXkuaXNBcnJheShyZXNvbHZlZFJlcXVpcmVBbGwpKSB7XG4gICAgcmVxdWlyZUFsbFJvbGVzID0gcmVzb2x2ZWRSZXF1aXJlQWxsO1xuICB9XG4gIGlmICh1c2VyUm9sZXMpIHtcbiAgICBjb25zdCBoYXNSb2xlID0gdXNlclJvbGVzLnNvbWUocmVxdWlyZWRSb2xlID0+IHJvbGVzLmluY2x1ZGVzKGByb2xlOiR7cmVxdWlyZWRSb2xlfWApKTtcbiAgICBpZiAoIWhhc1JvbGUpIHtcbiAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gVXNlciBkb2VzIG5vdCBtYXRjaCB0aGUgcmVxdWlyZWQgcm9sZXMuYDtcbiAgICB9XG4gIH1cbiAgaWYgKHJlcXVpcmVBbGxSb2xlcykge1xuICAgIGZvciAoY29uc3QgcmVxdWlyZWRSb2xlIG9mIHJlcXVpcmVBbGxSb2xlcykge1xuICAgICAgaWYgKCFyb2xlcy5pbmNsdWRlcyhgcm9sZToke3JlcXVpcmVkUm9sZX1gKSkge1xuICAgICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFVzZXIgZG9lcyBub3QgbWF0Y2ggYWxsIHRoZSByZXF1aXJlZCByb2xlcy5gO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBjb25zdCB1c2VyS2V5cyA9IG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzIHx8IFtdO1xuICBpZiAoQXJyYXkuaXNBcnJheSh1c2VyS2V5cykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiB1c2VyS2V5cykge1xuICAgICAgaWYgKCFyZXFVc2VyKSB7XG4gICAgICAgIHRocm93ICdQbGVhc2UgbG9naW4gdG8gbWFrZSB0aGlzIHJlcXVlc3QuJztcbiAgICAgIH1cblxuICAgICAgaWYgKHJlcVVzZXIuZ2V0KGtleSkgPT0gbnVsbCkge1xuICAgICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzZXQgZGF0YSBmb3IgJHtrZXl9IG9uIHlvdXIgYWNjb3VudC5gO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIGlmICh0eXBlb2YgdXNlcktleXMgPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3Qgb3B0aW9uUHJvbWlzZXMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cykge1xuICAgICAgY29uc3Qgb3B0ID0gb3B0aW9ucy5yZXF1aXJlVXNlcktleXNba2V5XTtcbiAgICAgIGlmIChvcHQub3B0aW9ucykge1xuICAgICAgICBvcHRpb25Qcm9taXNlcy5wdXNoKHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgcmVxVXNlci5nZXQoa2V5KSkpO1xuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBQcm9taXNlLmFsbChvcHRpb25Qcm9taXNlcyk7XG4gIH1cbn1cblxuLy8gVG8gYmUgdXNlZCBhcyBwYXJ0IG9mIHRoZSBwcm9taXNlIGNoYWluIHdoZW4gc2F2aW5nL2RlbGV0aW5nIGFuIG9iamVjdFxuLy8gV2lsbCByZXNvbHZlIHN1Y2Nlc3NmdWxseSBpZiBubyB0cmlnZ2VyIGlzIGNvbmZpZ3VyZWRcbi8vIFJlc29sdmVzIHRvIGFuIG9iamVjdCwgZW1wdHkgb3IgY29udGFpbmluZyBhbiBvYmplY3Qga2V5LiBBIGJlZm9yZVNhdmVcbi8vIHRyaWdnZXIgd2lsbCBzZXQgdGhlIG9iamVjdCBrZXkgdG8gdGhlIHJlc3QgZm9ybWF0IG9iamVjdCB0byBzYXZlLlxuLy8gb3JpZ2luYWxQYXJzZU9iamVjdCBpcyBvcHRpb25hbCwgd2Ugb25seSBuZWVkIHRoYXQgZm9yIGJlZm9yZS9hZnRlclNhdmUgZnVuY3Rpb25zXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5UcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dFxuKSB7XG4gIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihwYXJzZU9iamVjdC5jbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gICAgaWYgKCF0cmlnZ2VyKSB7IHJldHVybiByZXNvbHZlKCk7IH1cbiAgICB2YXIgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QoXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGF1dGgsXG4gICAgICBwYXJzZU9iamVjdCxcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICBjb25maWcsXG4gICAgICBjb250ZXh0XG4gICAgKTtcbiAgICB2YXIgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgb2JqZWN0ID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBVdGlscy5zYWZlVG9KU09OKHBhcnNlT2JqZWN0KSxcbiAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgYXV0aCxcbiAgICAgICAgICB0cmlnZ2VyVHlwZS5zdGFydHNXaXRoKCdhZnRlcicpXG4gICAgICAgICAgICA/IGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgICAgICAgICA6IGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZVN1Y2Nlc3NcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVEZWxldGUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihjb250ZXh0LCByZXF1ZXN0LmNvbnRleHQpO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgIFV0aWxzLnNhZmVUb0pTT04ocGFyc2VPYmplY3QpLFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgZXJyb3IsXG4gICAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlRXJyb3JcbiAgICAgICAgKTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQWZ0ZXJTYXZlIGFuZCBhZnRlckRlbGV0ZSB0cmlnZ2VycyBjYW4gcmV0dXJuIGEgcHJvbWlzZSwgd2hpY2ggaWYgdGhleVxuICAgIC8vIGRvLCBuZWVkcyB0byBiZSByZXNvbHZlZCBiZWZvcmUgdGhpcyBwcm9taXNlIGlzIHJlc29sdmVkLFxuICAgIC8vIHNvIHRyaWdnZXIgZXhlY3V0aW9uIGlzIHN5bmNlZCB3aXRoIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICAvLyBJZiB0cmlnZ2VycyBkbyBub3QgcmV0dXJuIGEgcHJvbWlzZSwgdGhleSBjYW4gcnVuIGFzeW5jIGNvZGUgcGFyYWxsZWxcbiAgICAvLyB0byB0aGUgUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7cGFyc2VPYmplY3QuY2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW5cbiAgICAgICAgKSB7XG4gICAgICAgICAgbG9nVHJpZ2dlckFmdGVySG9vayhcbiAgICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgICAgVXRpbHMuc2FmZVRvSlNPTihwYXJzZU9iamVjdCksXG4gICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQWZ0ZXJcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJlZm9yZVNhdmUgaXMgZXhwZWN0ZWQgdG8gcmV0dXJuIG51bGwgKG5vdGhpbmcpXG4gICAgICAgIGlmICh0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSkge1xuICAgICAgICAgIGlmIChwcm9taXNlICYmIHR5cGVvZiBwcm9taXNlLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBwcm9taXNlLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgICAvLyByZXNwb25zZS5vYmplY3QgbWF5IGNvbWUgZnJvbSBleHByZXNzIHJvdXRpbmcgYmVmb3JlIGhvb2tcbiAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSk7XG59XG5cbi8vIENvbnZlcnRzIGEgUkVTVC1mb3JtYXQgb2JqZWN0IHRvIGEgUGFyc2UuT2JqZWN0XG4vLyBkYXRhIGlzIGVpdGhlciBjbGFzc05hbWUgb3IgYW4gb2JqZWN0XG5leHBvcnQgZnVuY3Rpb24gaW5mbGF0ZShkYXRhLCByZXN0T2JqZWN0KSB7XG4gIHZhciBjb3B5ID0gdHlwZW9mIGRhdGEgPT0gJ29iamVjdCcgPyBkYXRhIDogeyBjbGFzc05hbWU6IGRhdGEgfTtcbiAgZm9yICh2YXIga2V5IGluIHJlc3RPYmplY3QpIHtcbiAgICBjb3B5W2tleV0gPSByZXN0T2JqZWN0W2tleV07XG4gIH1cbiAgcmV0dXJuIFBhcnNlLk9iamVjdC5mcm9tSlNPTihjb3B5KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoZGF0YSwgYXBwbGljYXRpb25JZCA9IFBhcnNlLmFwcGxpY2F0aW9uSWQpIHtcbiAgaWYgKCFfdHJpZ2dlclN0b3JlIHx8ICFfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8ICFfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5mb3JFYWNoKGhhbmRsZXIgPT4gaGFuZGxlcihkYXRhKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0RmlsZU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgZmlsZU9iamVjdCwgY29uZmlnKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgLi4uZmlsZU9iamVjdCxcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBpc1JlYWRPbmx5OiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICByZXF1ZXN0Wydpc1JlYWRPbmx5J10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuRmlsZVRyaWdnZXIodHJpZ2dlclR5cGUsIGZpbGVPYmplY3QsIGNvbmZpZywgYXV0aCkge1xuICBjb25zdCBGaWxlQ2xhc3NOYW1lID0gZ2V0Q2xhc3NOYW1lKFBhcnNlLkZpbGUpO1xuICBjb25zdCBmaWxlVHJpZ2dlciA9IGdldFRyaWdnZXIoRmlsZUNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKHR5cGVvZiBmaWxlVHJpZ2dlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZyk7XG4gICAgICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtGaWxlQ2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIGZpbGVPYmplY3Q7XG4gICAgICB9XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmaWxlVHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGlmIChyZXF1ZXN0LmZvcmNlRG93bmxvYWQpIHtcbiAgICAgICAgZmlsZU9iamVjdC5mb3JjZURvd25sb2FkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlSGVhZGVycykge1xuICAgICAgICBmaWxlT2JqZWN0LnJlc3BvbnNlSGVhZGVycyA9IHJlcXVlc3QucmVzcG9uc2VIZWFkZXJzO1xuICAgICAgfVxuICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkZpbGUnLFxuICAgICAgICB7IC4uLmZpbGVPYmplY3QuZmlsZS50b0pTT04oKSwgZmlsZVNpemU6IGZpbGVPYmplY3QuZmlsZVNpemUgfSxcbiAgICAgICAgcmVzdWx0LFxuICAgICAgICBhdXRoLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJlc3VsdCB8fCBmaWxlT2JqZWN0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkZpbGUnLFxuICAgICAgICB7IC4uLmZpbGVPYmplY3QuZmlsZS50b0pTT04oKSwgZmlsZVNpemU6IGZpbGVPYmplY3QuZmlsZVNpemUgfSxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIHJldHVybiBmaWxlT2JqZWN0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWF5YmVSdW5HbG9iYWxDb25maWdUcmlnZ2VyKHRyaWdnZXJUeXBlLCBhdXRoLCBjb25maWdPYmplY3QsIG9yaWdpbmFsQ29uZmlnT2JqZWN0LCBjb25maWcsIGNvbnRleHQpIHtcbiAgY29uc3QgR2xvYmFsQ29uZmlnQ2xhc3NOYW1lID0gZ2V0Q2xhc3NOYW1lKFBhcnNlLkNvbmZpZyk7XG4gIGNvbnN0IGNvbmZpZ1RyaWdnZXIgPSBnZXRUcmlnZ2VyKEdsb2JhbENvbmZpZ0NsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKHR5cGVvZiBjb25maWdUcmlnZ2VyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBjb25maWdPYmplY3QsIG9yaWdpbmFsQ29uZmlnT2JqZWN0LCBjb25maWcsIGNvbnRleHQpO1xuICAgICAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7R2xvYmFsQ29uZmlnQ2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIGNvbmZpZ09iamVjdDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbmZpZ1RyaWdnZXIocmVxdWVzdCk7XG4gICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuQ29uZmlnJyxcbiAgICAgICAgY29uZmlnT2JqZWN0LFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZVN1Y2Nlc3NcbiAgICAgICk7XG4gICAgICByZXR1cm4gcmVzdWx0IHx8IGNvbmZpZ09iamVjdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5Db25maWcnLFxuICAgICAgICBjb25maWdPYmplY3QsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGVycm9yLFxuICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVFcnJvclxuICAgICAgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY29uZmlnT2JqZWN0O1xufVxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0EsSUFBQUEs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