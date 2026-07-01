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
const AWSXRay = require('hulab-xray-sdk');
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
  return tracePromise(triggerType, className, promise);
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
function tracePromise(type, className, promise = Promise.resolve()) {
  const parent = AWSXRay.getSegment();
  if (!parent) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    AWSXRay.captureAsyncFunc(`Parse-Server_triggers_${type}_${className}`, subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'triggers');
      subsegment && subsegment.addAnnotation('Type', type);
      subsegment && subsegment.addAnnotation('ClassName', className);
      (_Utils.default.isPromise(promise) ? promise : Promise.resolve(promise)).then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2xvZ2dlciIsIl9VdGlscyIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIkFXU1hSYXkiLCJUeXBlcyIsImV4cG9ydHMiLCJiZWZvcmVMb2dpbiIsImFmdGVyTG9naW4iLCJhZnRlckxvZ291dCIsImJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0IiwiYmVmb3JlU2F2ZSIsImFmdGVyU2F2ZSIsImJlZm9yZURlbGV0ZSIsImFmdGVyRGVsZXRlIiwiYmVmb3JlRmluZCIsImFmdGVyRmluZCIsImJlZm9yZUNvbm5lY3QiLCJiZWZvcmVTdWJzY3JpYmUiLCJhZnRlckV2ZW50IiwiQ29ubmVjdENsYXNzTmFtZSIsImNyZWF0ZVN0b3JlIiwiT2JqZWN0IiwiY3JlYXRlIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiRnVuY3Rpb25zIiwiSm9icyIsIkxpdmVRdWVyeSIsIlRyaWdnZXJzIiwiZnJlZXplIiwiZ2V0Q2xhc3NOYW1lIiwicGFyc2VDbGFzcyIsImNsYXNzTmFtZSIsIm5hbWUiLCJyZXBsYWNlIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsInR5cGUiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwiYXBwbGljYXRpb25JZCIsImludmFsaWROYW1lUmVnZXgiLCJ0ZXN0IiwicGF0aCIsInNwbGl0Iiwic3BsaWNlIiwiUGFyc2UiLCJzdG9yZSIsImNvbXBvbmVudCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImdldFByb3RvdHlwZU9mIiwiYWRkIiwiaGFuZGxlciIsImxhc3RDb21wb25lbnQiLCJsb2dnZXIiLCJ3YXJuIiwicmVtb3ZlIiwiZ2V0IiwidW5kZWZpbmVkIiwiYWRkRnVuY3Rpb24iLCJmdW5jdGlvbk5hbWUiLCJ2YWxpZGF0aW9uSGFuZGxlciIsImFkZEpvYiIsImpvYk5hbWUiLCJhZGRUcmlnZ2VyIiwiYWRkQ29ubmVjdFRyaWdnZXIiLCJhZGRMaXZlUXVlcnlFdmVudEhhbmRsZXIiLCJwdXNoIiwicmVtb3ZlRnVuY3Rpb24iLCJyZW1vdmVUcmlnZ2VyIiwiX3VucmVnaXN0ZXJBbGwiLCJmb3JFYWNoIiwiYXBwSWQiLCJ0b0pTT053aXRoT2JqZWN0cyIsIm9iamVjdCIsInRvSlNPTiIsInN0YXRlQ29udHJvbGxlciIsIkNvcmVNYW5hZ2VyIiwiZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyIiwicGVuZGluZyIsImdldFBlbmRpbmdPcHMiLCJfZ2V0U3RhdGVJZGVudGlmaWVyIiwidmFsIiwiX3RvRnVsbEpTT04iLCJnZXRUcmlnZ2VyIiwidHJpZ2dlclR5cGUiLCJydW5UcmlnZ2VyIiwidHJpZ2dlciIsInJlcXVlc3QiLCJhdXRoIiwibWF5YmVSdW5WYWxpZGF0b3IiLCJza2lwV2l0aE1hc3RlcktleSIsInRyaWdnZXJFeGlzdHMiLCJnZXRGdW5jdGlvbiIsImdldEZ1bmN0aW9uTmFtZXMiLCJmdW5jdGlvbk5hbWVzIiwiZXh0cmFjdEZ1bmN0aW9uTmFtZXMiLCJuYW1lc3BhY2UiLCJ2YWx1ZSIsImdldEpvYiIsImdldEpvYnMiLCJtYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yIiwiZ2V0UmVxdWVzdE9iamVjdCIsInBhcnNlT2JqZWN0Iiwib3JpZ2luYWxQYXJzZU9iamVjdCIsImNvbmZpZyIsImNvbnRleHQiLCJpc0dldCIsInRyaWdnZXJOYW1lIiwibWFzdGVyIiwiaXNSZWFkT25seSIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJvcmlnaW5hbCIsImFzc2lnbiIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0IiwicXVlcnkiLCJjb3VudCIsImdldFJlc3BvbnNlT2JqZWN0IiwicmVzb2x2ZSIsInJlamVjdCIsInN1Y2Nlc3MiLCJyZXNwb25zZSIsIm9iamVjdHMiLCJtYXAiLCJlcXVhbHMiLCJfZ2V0U2F2ZUpTT04iLCJpZCIsImVycm9yIiwicmVzb2x2ZUVycm9yIiwiY29kZSIsIkVycm9yIiwiU0NSSVBUX0ZBSUxFRCIsIm1lc3NhZ2UiLCJ1c2VySWRGb3JMb2ciLCJsb2dUcmlnZ2VyQWZ0ZXJIb29rIiwiaW5wdXQiLCJsb2dMZXZlbCIsImNsZWFuSW5wdXQiLCJKU09OIiwic3RyaW5naWZ5IiwibG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rIiwicmVzdWx0IiwiY2xlYW5SZXN1bHQiLCJ0cnVuY2F0ZUxvZ01lc3NhZ2UiLCJsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwiY2xhc3NOYW1lUXVlcnkiLCJvYmplY3RzSW5wdXQiLCJQcm9taXNlIiwibGVuZ3RoIiwib2JqIiwiUXVlcnkiLCJwYXJzZVF1ZXJ5SW5zdGFuY2UiLCJ3aGVyZSIsIndpdGhKU09OIiwicHJvY2Vzc2VkT2JqZWN0c0pTT04iLCJlcnJvckRhdGEiLCJvIiwibG9nTGV2ZWxzIiwidHJpZ2dlckJlZm9yZVN1Y2Nlc3MiLCJjdXJyZW50T2JqZWN0Iiwib3JpZ2luYWxDbGFzc05hbWUiLCJ0ZW1wT2JqZWN0V2l0aENsYXNzTmFtZSIsImZyb21KU09OIiwidGhlbiIsInJlc3BvbnNlRnJvbVRyaWdnZXIiLCJyZXN1bHRzIiwicmVzdWx0c0FzSlNPTiIsInRyaWdnZXJBZnRlciIsIm1heWJlUnVuUXVlcnlUcmlnZ2VyIiwicmVzdFdoZXJlIiwicmVzdE9wdGlvbnMiLCJqc29uIiwicGFyc2VRdWVyeSIsInJlcXVlc3RPYmplY3QiLCJwcm9taXNlIiwicXVlcnlSZXN1bHQiLCJqc29uUXVlcnkiLCJsaW1pdCIsInNraXAiLCJpbmNsdWRlIiwiZXhjbHVkZUtleXMiLCJleHBsYWluIiwib3JkZXIiLCJoaW50IiwiY29tbWVudCIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsIkFycmF5IiwiaXNBcnJheSIsImV2ZXJ5IiwiZXJyIiwidHJhY2VQcm9taXNlIiwiZGVmYXVsdE9wdHMiLCJVdGlscyIsImlzTmF0aXZlRXJyb3IiLCJzdGFjayIsInRoZVZhbGlkYXRvciIsImJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yIiwiY2F0Y2giLCJWQUxJREFUSU9OX0VSUk9SIiwib3B0aW9ucyIsInZhbGlkYXRlTWFzdGVyS2V5IiwicmVxVXNlciIsImV4aXN0ZWQiLCJyZXF1aXJlVXNlciIsInJlcXVpcmVBbnlVc2VyUm9sZXMiLCJyZXF1aXJlQWxsVXNlclJvbGVzIiwicmVxdWlyZU1hc3RlciIsInBhcmFtcyIsInJlcXVpcmVkUGFyYW0iLCJ2YWxpZGF0ZU9wdGlvbnMiLCJvcHQiLCJvcHRzIiwiaW5jbHVkZXMiLCJqb2luIiwiZ2V0VHlwZSIsImZuIiwibWF0Y2giLCJ0b1N0cmluZyIsInRvTG93ZXJDYXNlIiwiZmllbGRzIiwib3B0aW9uUHJvbWlzZXMiLCJzZXQiLCJjb25zdGFudCIsInJldmVydCIsInJlcXVpcmVkIiwib3B0aW9uYWwiLCJ2YWxUeXBlIiwiYWxsIiwidXNlclJvbGVzIiwicmVxdWlyZUFsbFJvbGVzIiwicHJvbWlzZXMiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsInJlc29sdmVkVXNlclJvbGVzIiwicmVzb2x2ZWRSZXF1aXJlQWxsIiwiaGFzUm9sZSIsInNvbWUiLCJyZXF1aXJlZFJvbGUiLCJ1c2VyS2V5cyIsInJlcXVpcmVVc2VyS2V5cyIsIm1heWJlUnVuVHJpZ2dlciIsInN0YXJ0c1dpdGgiLCJ0cmlnZ2VyQmVmb3JlRXJyb3IiLCJpbmZsYXRlIiwiZGF0YSIsInJlc3RPYmplY3QiLCJjb3B5IiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsImdldFJlcXVlc3RGaWxlT2JqZWN0IiwiZmlsZU9iamVjdCIsIm1heWJlUnVuRmlsZVRyaWdnZXIiLCJGaWxlQ2xhc3NOYW1lIiwiRmlsZSIsImZpbGVUcmlnZ2VyIiwiZm9yY2VEb3dubG9hZCIsInJlc3BvbnNlSGVhZGVycyIsImZpbGUiLCJmaWxlU2l6ZSIsIm1heWJlUnVuR2xvYmFsQ29uZmlnVHJpZ2dlciIsImNvbmZpZ09iamVjdCIsIm9yaWdpbmFsQ29uZmlnT2JqZWN0IiwiR2xvYmFsQ29uZmlnQ2xhc3NOYW1lIiwiQ29uZmlnIiwiY29uZmlnVHJpZ2dlciIsInBhcmVudCIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJpc1Byb21pc2UiLCJjbG9zZSJdLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyB0cmlnZ2Vycy5qc1xuY29uc3QgQVdTWFJheSA9IHJlcXVpcmUoJ2h1bGFiLXhyYXktc2RrJyk7XG5cbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCBVdGlscyBmcm9tICcuL1V0aWxzJztcblxuZXhwb3J0IGNvbnN0IFR5cGVzID0ge1xuICBiZWZvcmVMb2dpbjogJ2JlZm9yZUxvZ2luJyxcbiAgYWZ0ZXJMb2dpbjogJ2FmdGVyTG9naW4nLFxuICBhZnRlckxvZ291dDogJ2FmdGVyTG9nb3V0JyxcbiAgYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3Q6ICdiZWZvcmVQYXNzd29yZFJlc2V0UmVxdWVzdCcsXG4gIGJlZm9yZVNhdmU6ICdiZWZvcmVTYXZlJyxcbiAgYWZ0ZXJTYXZlOiAnYWZ0ZXJTYXZlJyxcbiAgYmVmb3JlRGVsZXRlOiAnYmVmb3JlRGVsZXRlJyxcbiAgYWZ0ZXJEZWxldGU6ICdhZnRlckRlbGV0ZScsXG4gIGJlZm9yZUZpbmQ6ICdiZWZvcmVGaW5kJyxcbiAgYWZ0ZXJGaW5kOiAnYWZ0ZXJGaW5kJyxcbiAgYmVmb3JlQ29ubmVjdDogJ2JlZm9yZUNvbm5lY3QnLFxuICBiZWZvcmVTdWJzY3JpYmU6ICdiZWZvcmVTdWJzY3JpYmUnLFxuICBhZnRlckV2ZW50OiAnYWZ0ZXJFdmVudCcsXG59O1xuXG5jb25zdCBDb25uZWN0Q2xhc3NOYW1lID0gJ0BDb25uZWN0JztcblxuLyoqXG4gKiBDcmVhdGVzIGEgcHJvdG90eXBlLWZyZWUgb2JqZWN0IGZvciB1c2UgYXMgYSBsb29rdXAgc3RvcmUuXG4gKiBUaGlzIHByZXZlbnRzIHByb3RvdHlwZSBjaGFpbiBwcm9wZXJ0aWVzIChlLmcuIGBjb25zdHJ1Y3RvcmAsIGB0b1N0cmluZ2ApXG4gKiBmcm9tIGJlaW5nIHJlc29sdmVkIGFzIHJlZ2lzdGVyZWQgaGFuZGxlcnMgd2hlbiB1c2luZyBicmFja2V0IG5vdGF0aW9uXG4gKiBmb3IgbG9va3Vwcy4gQWx3YXlzIHVzZSB0aGlzIGluc3RlYWQgb2YgYHt9YCBmb3IgaGFuZGxlciBzdG9yZXMuXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVN0b3JlKCkge1xuICByZXR1cm4gT2JqZWN0LmNyZWF0ZShudWxsKTtcbn1cblxuY29uc3QgYmFzZVN0b3JlID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBWYWxpZGF0b3JzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0gY3JlYXRlU3RvcmUoKTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwgY3JlYXRlU3RvcmUoKSk7XG4gIGNvbnN0IEZ1bmN0aW9ucyA9IGNyZWF0ZVN0b3JlKCk7XG4gIGNvbnN0IEpvYnMgPSBjcmVhdGVTdG9yZSgpO1xuICBjb25zdCBMaXZlUXVlcnkgPSBbXTtcbiAgY29uc3QgVHJpZ2dlcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSBjcmVhdGVTdG9yZSgpO1xuICAgIHJldHVybiBiYXNlO1xuICB9LCBjcmVhdGVTdG9yZSgpKTtcblxuICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgRnVuY3Rpb25zLFxuICAgIEpvYnMsXG4gICAgVmFsaWRhdG9ycyxcbiAgICBUcmlnZ2VycyxcbiAgICBMaXZlUXVlcnksXG4gIH0pO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldENsYXNzTmFtZShwYXJzZUNsYXNzKSB7XG4gIGlmIChwYXJzZUNsYXNzICYmIHBhcnNlQ2xhc3MuY2xhc3NOYW1lKSB7XG4gICAgcmV0dXJuIHBhcnNlQ2xhc3MuY2xhc3NOYW1lO1xuICB9XG4gIGlmIChwYXJzZUNsYXNzICYmIHBhcnNlQ2xhc3MubmFtZSkge1xuICAgIHJldHVybiBwYXJzZUNsYXNzLm5hbWUucmVwbGFjZSgnUGFyc2UnLCAnQCcpO1xuICB9XG4gIHJldHVybiBwYXJzZUNsYXNzO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzKGNsYXNzTmFtZSwgdHlwZSkge1xuICBpZiAodHlwZSA9PSBUeXBlcy5iZWZvcmVTYXZlICYmIGNsYXNzTmFtZSA9PT0gJ19QdXNoU3RhdHVzJykge1xuICAgIC8vIF9QdXNoU3RhdHVzIHVzZXMgdW5kb2N1bWVudGVkIG5lc3RlZCBrZXkgaW5jcmVtZW50IG9wc1xuICAgIC8vIGFsbG93aW5nIGJlZm9yZVNhdmUgd291bGQgbWVzcyB1cCB0aGUgb2JqZWN0cyBiaWcgdGltZVxuICAgIC8vIFRPRE86IEFsbG93IHByb3BlciBkb2N1bWVudGVkIHdheSBvZiB1c2luZyBuZXN0ZWQgaW5jcmVtZW50IG9wc1xuICAgIHRocm93ICdPbmx5IGFmdGVyU2F2ZSBpcyBhbGxvd2VkIG9uIF9QdXNoU3RhdHVzJztcbiAgfVxuICBpZiAoKHR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8IHR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4gfHwgdHlwZSA9PT0gVHlwZXMuYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QpICYmIGNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1VzZXIgY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGJlZm9yZUxvZ2luLCBhZnRlckxvZ2luLCBhbmQgYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QgdHJpZ2dlcnMnO1xuICB9XG4gIGlmICh0eXBlID09PSBUeXBlcy5hZnRlckxvZ291dCAmJiBjbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9TZXNzaW9uIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBhZnRlckxvZ291dCB0cmlnZ2VyLic7XG4gIH1cbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJyAmJiB0eXBlICE9PSBUeXBlcy5hZnRlckxvZ291dCkge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlciBpcyBhbGxvd2VkIGZvciB0aGUgX1Nlc3Npb24gY2xhc3MuJztcbiAgfVxuICByZXR1cm4gY2xhc3NOYW1lO1xufVxuXG5jb25zdCBfdHJpZ2dlclN0b3JlID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJyxcbn07XG5cbmZ1bmN0aW9uIGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGludmFsaWROYW1lUmVnZXggPSAvWydcImBdLztcbiAgaWYgKGludmFsaWROYW1lUmVnZXgudGVzdChuYW1lKSkge1xuICAgIC8vIFByZXZlbnQgYSBtYWxpY2lvdXMgdXNlciBmcm9tIGluamVjdGluZyBwcm9wZXJ0aWVzIGludG8gdGhlIHN0b3JlXG4gICAgcmV0dXJuIGNyZWF0ZVN0b3JlKCk7XG4gIH1cblxuICBjb25zdCBwYXRoID0gbmFtZS5zcGxpdCgnLicpO1xuICBwYXRoLnNwbGljZSgtMSk7IC8vIHJlbW92ZSBsYXN0IGNvbXBvbmVudFxuICBhcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCBiYXNlU3RvcmUoKTtcbiAgbGV0IHN0b3JlID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXVtjYXRlZ29yeV07XG4gIGZvciAoY29uc3QgY29tcG9uZW50IG9mIHBhdGgpIHtcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdG9yZSwgY29tcG9uZW50KSkge1xuICAgICAgcmV0dXJuIGNyZWF0ZVN0b3JlKCk7XG4gICAgfVxuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlIHx8IE9iamVjdC5nZXRQcm90b3R5cGVPZihzdG9yZSkgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiBjcmVhdGVTdG9yZSgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RvcmU7XG59XG5cbmZ1bmN0aW9uIGFkZChjYXRlZ29yeSwgbmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoc3RvcmVbbGFzdENvbXBvbmVudF0pIHtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGBXYXJuaW5nOiBEdXBsaWNhdGUgY2xvdWQgZnVuY3Rpb25zIGV4aXN0IGZvciAke2xhc3RDb21wb25lbnR9LiBPbmx5IHRoZSBsYXN0IG9uZSB3aWxsIGJlIHVzZWQgYW5kIHRoZSBvdGhlcnMgd2lsbCBiZSBpZ25vcmVkLmBcbiAgICApO1xuICB9XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHN0b3JlLCBsYXN0Q29tcG9uZW50KSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRKb2Ioam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkQ29ubmVjdFRyaWdnZXIodHlwZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LnB1c2goaGFuZGxlcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfdW5yZWdpc3RlckFsbCgpIHtcbiAgT2JqZWN0LmtleXMoX3RyaWdnZXJTdG9yZSkuZm9yRWFjaChhcHBJZCA9PiBkZWxldGUgX3RyaWdnZXJTdG9yZVthcHBJZF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9KU09Od2l0aE9iamVjdHMob2JqZWN0LCBjbGFzc05hbWUpIHtcbiAgaWYgKCFvYmplY3QgfHwgIW9iamVjdC50b0pTT04pIHtcbiAgICByZXR1cm4ge307XG4gIH1cbiAgY29uc3QgdG9KU09OID0gb2JqZWN0LnRvSlNPTigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMob2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKSk7XG4gIGZvciAoY29uc3Qga2V5IGluIHBlbmRpbmcpIHtcbiAgICBjb25zdCB2YWwgPSBvYmplY3QuZ2V0KGtleSk7XG4gICAgaWYgKCF2YWwgfHwgIXZhbC5fdG9GdWxsSlNPTikge1xuICAgICAgdG9KU09OW2tleV0gPSB2YWw7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdG9KU09OW2tleV0gPSB2YWwuX3RvRnVsbEpTT04oKTtcbiAgfVxuICAvLyBQcmVzZXJ2ZSBvcmlnaW5hbCBvYmplY3QncyBjbGFzc05hbWUgaWYgbm8gb3ZlcnJpZGUgY2xhc3NOYW1lIGlzIHByb3ZpZGVkXG4gIGlmIChjbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB9IGVsc2UgaWYgKG9iamVjdC5jbGFzc05hbWUgJiYgIXRvSlNPTi5jbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gb2JqZWN0LmNsYXNzTmFtZTtcbiAgfVxuICByZXR1cm4gdG9KU09OO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIGlmICghYXBwbGljYXRpb25JZCkge1xuICAgIHRocm93ICdNaXNzaW5nIEFwcGxpY2F0aW9uSUQnO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blRyaWdnZXIodHJpZ2dlciwgbmFtZSwgcmVxdWVzdCwgYXV0aCkge1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgbmFtZSwgYXV0aCk7XG4gIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiBhd2FpdCB0cmlnZ2VyKHJlcXVlc3QpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJpZ2dlckV4aXN0cyhjbGFzc05hbWU6IHN0cmluZywgdHlwZTogc3RyaW5nLCBhcHBsaWNhdGlvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0eXBlLCBhcHBsaWNhdGlvbklkKSAhPSB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbk5hbWVzKGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3Qgc3RvcmUgPVxuICAgIChfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdICYmIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bQ2F0ZWdvcnkuRnVuY3Rpb25zXSkgfHwge307XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXMgPSBbXTtcbiAgY29uc3QgZXh0cmFjdEZ1bmN0aW9uTmFtZXMgPSAobmFtZXNwYWNlLCBzdG9yZSkgPT4ge1xuICAgIE9iamVjdC5rZXlzKHN0b3JlKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdG9yZVtuYW1lXTtcbiAgICAgIGlmIChuYW1lc3BhY2UpIHtcbiAgICAgICAgbmFtZSA9IGAke25hbWVzcGFjZX0uJHtuYW1lfWA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZXMucHVzaChuYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG5hbWUsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobnVsbCwgc3RvcmUpO1xuICByZXR1cm4gZnVuY3Rpb25OYW1lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2JzKGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFyIG1hbmFnZXIgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdO1xuICBpZiAobWFuYWdlciAmJiBtYW5hZ2VyLkpvYnMpIHtcbiAgICByZXR1cm4gbWFuYWdlci5Kb2JzO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG9iamVjdDogcGFyc2VPYmplY3QsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBpc1JlYWRPbmx5OiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmIChpc0dldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVxdWVzdC5pc0dldCA9ICEhaXNHZXQ7XG4gIH1cblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4gfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlUGFzc3dvcmRSZXNldFJlcXVlc3QgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kXG4gICkge1xuICAgIC8vIFNldCBhIGNvcHkgb2YgdGhlIGNvbnRleHQgb24gdGhlIHJlcXVlc3Qgb2JqZWN0LlxuICAgIHJlcXVlc3QuY29udGV4dCA9IE9iamVjdC5hc3NpZ24oT2JqZWN0LmNyZWF0ZShudWxsKSwgY29udGV4dCk7XG4gIH1cblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgcmVxdWVzdFsnaXNSZWFkT25seSddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0UXVlcnlPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIHF1ZXJ5LCBjb3VudCwgY29uZmlnLCBjb250ZXh0LCBpc0dldCkge1xuICBpc0dldCA9ICEhaXNHZXQ7XG5cbiAgdmFyIHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIHF1ZXJ5LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgaXNSZWFkT25seTogZmFsc2UsXG4gICAgY291bnQsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBpc0dldCxcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbnRleHQ6IGNvbnRleHQgfHwge30sXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICByZXF1ZXN0Wydpc1JlYWRPbmx5J10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuLy8gQ3JlYXRlcyB0aGUgcmVzcG9uc2Ugb2JqZWN0LCBhbmQgdXNlcyB0aGUgcmVxdWVzdCBvYmplY3QgdG8gcGFzcyBkYXRhXG4vLyBUaGUgQVBJIHdpbGwgY2FsbCB0aGlzIHdpdGggUkVTVCBBUEkgZm9ybWF0dGVkIG9iamVjdHMsIHRoaXMgd2lsbFxuLy8gdHJhbnNmb3JtIHRoZW0gdG8gUGFyc2UuT2JqZWN0IGluc3RhbmNlcyBleHBlY3RlZCBieSBDbG91ZCBDb2RlLlxuLy8gQW55IGNoYW5nZXMgbWFkZSB0byB0aGUgb2JqZWN0IGluIGEgYmVmb3JlU2F2ZSB3aWxsIGJlIGluY2x1ZGVkLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlc3BvbnNlT2JqZWN0KHJlcXVlc3QsIHJlc29sdmUsIHJlamVjdCkge1xuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IGZ1bmN0aW9uIChyZXNwb25zZSkge1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyRmluZCkge1xuICAgICAgICBpZiAoIXJlc3BvbnNlKSB7XG4gICAgICAgICAgcmVzcG9uc2UgPSByZXF1ZXN0Lm9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2UgPSByZXNwb25zZS5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICByZXR1cm4gdG9KU09Od2l0aE9iamVjdHMob2JqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIC8vIFVzZSB0aGUgSlNPTiByZXNwb25zZVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFyZXF1ZXN0Lm9iamVjdC5lcXVhbHMocmVzcG9uc2UpICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJiByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgICByZXNwb25zZVsnb2JqZWN0J11bJ29iamVjdElkJ10gPSByZXF1ZXN0Lm9iamVjdC5pZDtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICB9LFxuICAgIGVycm9yOiBmdW5jdGlvbiAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGUgPSByZXNvbHZlRXJyb3IoZXJyb3IsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgbWVzc2FnZTogJ1NjcmlwdCBmYWlsZWQuIFVua25vd24gZXJyb3IuJyxcbiAgICAgIH0pO1xuICAgICAgcmVqZWN0KGUpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHVzZXJJZEZvckxvZyhhdXRoKSB7XG4gIHJldHVybiBhdXRoICYmIGF1dGgudXNlciA/IGF1dGgudXNlci5pZCA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gSlNPTi5zdHJpbmdpZnkoaW5wdXQpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCByZXN1bHQsIGF1dGgsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KGlucHV0KTtcbiAgY29uc3QgY2xlYW5SZXN1bHQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gUmVzdWx0OiAke2NsZWFuUmVzdWx0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoLCBlcnJvciwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gSlNPTi5zdHJpbmdpZnkoaW5wdXQpO1xuICBsb2dnZXJbbG9nTGV2ZWxdKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6ICR7SlNPTi5zdHJpbmdpZnkoZXJyb3IpfWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBlcnJvcixcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBjbGFzc05hbWVRdWVyeSxcbiAgb2JqZWN0c0lucHV0LFxuICBjb25maWcsXG4gIHF1ZXJ5LFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lUXVlcnksIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG5cbiAgICBpZiAoIXRyaWdnZXIpIHtcbiAgICAgIGlmIChvYmplY3RzSW5wdXQgJiYgb2JqZWN0c0lucHV0Lmxlbmd0aCA+IDAgJiYgb2JqZWN0c0lucHV0WzBdIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dC5tYXAob2JqID0+IHRvSlNPTndpdGhPYmplY3RzKG9iaikpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dCB8fCBbXSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpO1xuICAgIC8vIENvbnZlcnQgcXVlcnkgcGFyYW1ldGVyIHRvIFBhcnNlLlF1ZXJ5IGluc3RhbmNlXG4gICAgaWYgKHF1ZXJ5IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBxdWVyeTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeSA9PT0gJ29iamVjdCcgJiYgcXVlcnkgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IHBhcnNlUXVlcnlJbnN0YW5jZSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWVRdWVyeSk7XG4gICAgICBpZiAocXVlcnkud2hlcmUpIHtcbiAgICAgICAgcGFyc2VRdWVyeUluc3RhbmNlLndpdGhKU09OKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIHJlcXVlc3QucXVlcnkgPSBwYXJzZVF1ZXJ5SW5zdGFuY2U7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lUXVlcnkpO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIHByb2Nlc3NlZE9iamVjdHNKU09OID0+IHtcbiAgICAgICAgcmVzb2x2ZShwcm9jZXNzZWRPYmplY3RzSlNPTik7XG4gICAgICB9LFxuICAgICAgZXJyb3JEYXRhID0+IHtcbiAgICAgICAgcmVqZWN0KGVycm9yRGF0YSk7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZVF1ZXJ5LFxuICAgICAgJ0FmdGVyRmluZCBJbnB1dCAoUHJlLVRyYW5zZm9ybSknLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIG9iamVjdHNJbnB1dC5tYXAobyA9PiAobyBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCA/IG8uaWQgKyAnOicgKyBvLmNsYXNzTmFtZSA6IG8pKVxuICAgICAgKSxcbiAgICAgIGF1dGgsXG4gICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgKTtcblxuICAgIC8vIENvbnZlcnQgcGxhaW4gb2JqZWN0cyB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGZvciB0cmlnZ2VyXG4gICAgcmVxdWVzdC5vYmplY3RzID0gb2JqZWN0c0lucHV0Lm1hcChjdXJyZW50T2JqZWN0ID0+IHtcbiAgICAgIGlmIChjdXJyZW50T2JqZWN0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiBjdXJyZW50T2JqZWN0O1xuICAgICAgfVxuICAgICAgLy8gUHJlc2VydmUgdGhlIG9yaWdpbmFsIGNsYXNzTmFtZSBpZiBpdCBleGlzdHMsIG90aGVyd2lzZSB1c2UgdGhlIHF1ZXJ5IGNsYXNzTmFtZVxuICAgICAgY29uc3Qgb3JpZ2luYWxDbGFzc05hbWUgPSBjdXJyZW50T2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWVRdWVyeTtcbiAgICAgIGNvbnN0IHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lID0geyAuLi5jdXJyZW50T2JqZWN0LCBjbGFzc05hbWU6IG9yaWdpbmFsQ2xhc3NOYW1lIH07XG4gICAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lKTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZVF1ZXJ5fWAsIGF1dGgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlRnJvbVRyaWdnZXIgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAocmVzcG9uc2VGcm9tVHJpZ2dlciAmJiB0eXBlb2YgcmVzcG9uc2VGcm9tVHJpZ2dlci50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlRnJvbVRyaWdnZXIudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNwb25zZUZyb21UcmlnZ2VyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSkudGhlbihyZXN1bHRzQXNKU09OID0+IHtcbiAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWVRdWVyeSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHJlc3VsdHNBc0pTT04pLFxuICAgICAgYXV0aCxcbiAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0c0FzSlNPTjtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlLFxuICByZXN0T3B0aW9ucyxcbiAgY29uZmlnLFxuICBhdXRoLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBqc29uID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdE9wdGlvbnMpO1xuICBqc29uLndoZXJlID0gcmVzdFdoZXJlO1xuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgcGFyc2VRdWVyeS53aXRoSlNPTihqc29uKTtcblxuICBsZXQgY291bnQgPSBmYWxzZTtcbiAgaWYgKHJlc3RPcHRpb25zKSB7XG4gICAgY291bnQgPSAhIXJlc3RPcHRpb25zLmNvdW50O1xuICB9XG4gIGNvbnN0IHJlcXVlc3RPYmplY3QgPSBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgYXV0aCxcbiAgICBwYXJzZVF1ZXJ5LFxuICAgIGNvdW50LFxuICAgIGNvbmZpZyxcbiAgICBjb250ZXh0LFxuICAgIGlzR2V0XG4gICk7XG4gIGNvbnN0IHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0T2JqZWN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAocmVxdWVzdE9iamVjdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gcmVxdWVzdE9iamVjdC5xdWVyeTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cmlnZ2VyKHJlcXVlc3RPYmplY3QpO1xuICAgIH0pXG4gICAgLnRoZW4oXG4gICAgICByZXN1bHQgPT4ge1xuICAgICAgICBsZXQgcXVlcnlSZXN1bHQgPSBwYXJzZVF1ZXJ5O1xuICAgICAgICBpZiAocmVzdWx0ICYmIHJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgICAgICAgcXVlcnlSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QganNvblF1ZXJ5ID0gcXVlcnlSZXN1bHQudG9KU09OKCk7XG4gICAgICAgIGlmIChqc29uUXVlcnkud2hlcmUpIHtcbiAgICAgICAgICByZXN0V2hlcmUgPSBqc29uUXVlcnkud2hlcmU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5saW1pdCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMubGltaXQgPSBqc29uUXVlcnkubGltaXQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5za2lwKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5za2lwID0ganNvblF1ZXJ5LnNraXA7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5pbmNsdWRlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ganNvblF1ZXJ5LmluY2x1ZGU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5leGNsdWRlS2V5cykge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuZXhjbHVkZUtleXMgPSBqc29uUXVlcnkuZXhjbHVkZUtleXM7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5leHBsYWluKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5leHBsYWluID0ganNvblF1ZXJ5LmV4cGxhaW47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5rZXlzKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5rZXlzID0ganNvblF1ZXJ5LmtleXM7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5vcmRlcikge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMub3JkZXIgPSBqc29uUXVlcnkub3JkZXI7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5oaW50KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5oaW50ID0ganNvblF1ZXJ5LmhpbnQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5jb21tZW50KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5jb21tZW50ID0ganNvblF1ZXJ5LmNvbW1lbnQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgbGV0IG9iamVjdHMgPSB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChyZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgICBvYmplY3RzID0gW3Jlc3VsdF07XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgQXJyYXkuaXNBcnJheShyZXN1bHQpICYmXG4gICAgICAgICAgKCFyZXN1bHQubGVuZ3RoIHx8IHJlc3VsdC5ldmVyeShvYmogPT4gb2JqIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgb2JqZWN0cyA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlc3RXaGVyZSxcbiAgICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgICBvYmplY3RzLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIGVyciA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGVyciwge1xuICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgbWVzc2FnZTogJ1NjcmlwdCBmYWlsZWQuIFVua25vd24gZXJyb3IuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICk7XG4gIHJldHVybiB0cmFjZVByb21pc2UodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgcHJvbWlzZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRXJyb3IobWVzc2FnZSwgZGVmYXVsdE9wdHMpIHtcbiAgaWYgKCFkZWZhdWx0T3B0cykge1xuICAgIGRlZmF1bHRPcHRzID0ge307XG4gIH1cbiAgaWYgKCFtZXNzYWdlKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgIGRlZmF1bHRPcHRzLm1lc3NhZ2UgfHwgJ1NjcmlwdCBmYWlsZWQuJ1xuICAgICk7XG4gIH1cbiAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgIHJldHVybiBtZXNzYWdlO1xuICB9XG5cbiAgY29uc3QgY29kZSA9IGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRDtcbiAgLy8gSWYgaXQncyBhbiBlcnJvciwgbWFyayBpdCBhcyBhIHNjcmlwdCBmYWlsZWRcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gIH1cbiAgY29uc3QgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZS5tZXNzYWdlIHx8IG1lc3NhZ2UpO1xuICBpZiAoVXRpbHMuaXNOYXRpdmVFcnJvcihtZXNzYWdlKSkge1xuICAgIGVycm9yLnN0YWNrID0gbWVzc2FnZS5zdGFjaztcbiAgfVxuICByZXR1cm4gZXJyb3I7XG59XG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgZnVuY3Rpb25OYW1lLCBhdXRoKSB7XG4gIGNvbnN0IHRoZVZhbGlkYXRvciA9IGdldFZhbGlkYXRvcihmdW5jdGlvbk5hbWUsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRoZVZhbGlkYXRvcikge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCcgJiYgdGhlVmFsaWRhdG9yLnNraXBXaXRoTWFzdGVyS2V5ICYmIHJlcXVlc3QubWFzdGVyKSB7XG4gICAgcmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSA9IHRydWU7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiB0aGVWYWxpZGF0b3IgPT09ICdvYmplY3QnXG4gICAgICAgICAgPyBidWlsdEluVHJpZ2dlclZhbGlkYXRvcih0aGVWYWxpZGF0b3IsIHJlcXVlc3QsIGF1dGgpXG4gICAgICAgICAgOiB0aGVWYWxpZGF0b3IocmVxdWVzdCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGUgPT4ge1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlLCB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICBtZXNzYWdlOiAnVmFsaWRhdGlvbiBmYWlsZWQuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9KTtcbiAgfSk7XG59XG5hc3luYyBmdW5jdGlvbiBidWlsdEluVHJpZ2dlclZhbGlkYXRvcihvcHRpb25zLCByZXF1ZXN0LCBhdXRoKSB7XG4gIGlmIChyZXF1ZXN0Lm1hc3RlciAmJiAhb3B0aW9ucy52YWxpZGF0ZU1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgcmVxVXNlciA9IHJlcXVlc3QudXNlcjtcbiAgaWYgKFxuICAgICFyZXFVc2VyICYmXG4gICAgcmVxdWVzdC5vYmplY3QgJiZcbiAgICByZXF1ZXN0Lm9iamVjdC5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAhcmVxdWVzdC5vYmplY3QuZXhpc3RlZCgpXG4gICkge1xuICAgIHJlcVVzZXIgPSByZXF1ZXN0Lm9iamVjdDtcbiAgfVxuICBpZiAoXG4gICAgKG9wdGlvbnMucmVxdWlyZVVzZXIgfHwgb3B0aW9ucy5yZXF1aXJlQW55VXNlclJvbGVzIHx8IG9wdGlvbnMucmVxdWlyZUFsbFVzZXJSb2xlcykgJiZcbiAgICAhcmVxVXNlclxuICApIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBsb2dpbiB0byBjb250aW51ZS4nO1xuICB9XG4gIGlmIChvcHRpb25zLnJlcXVpcmVNYXN0ZXIgJiYgIXJlcXVlc3QubWFzdGVyKSB7XG4gICAgdGhyb3cgJ1ZhbGlkYXRpb24gZmFpbGVkLiBNYXN0ZXIga2V5IGlzIHJlcXVpcmVkIHRvIGNvbXBsZXRlIHRoaXMgcmVxdWVzdC4nO1xuICB9XG4gIGxldCBwYXJhbXMgPSByZXF1ZXN0LnBhcmFtcyB8fCB7fTtcbiAgaWYgKHJlcXVlc3Qub2JqZWN0KSB7XG4gICAgcGFyYW1zID0gcmVxdWVzdC5vYmplY3QudG9KU09OKCk7XG4gIH1cbiAgY29uc3QgcmVxdWlyZWRQYXJhbSA9IGtleSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBwYXJhbXNba2V5XTtcbiAgICBpZiAodmFsdWUgPT0gbnVsbCkge1xuICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc3BlY2lmeSBkYXRhIGZvciAke2tleX0uYDtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgdmFsaWRhdGVPcHRpb25zID0gYXN5bmMgKG9wdCwga2V5LCB2YWwpID0+IHtcbiAgICBsZXQgb3B0cyA9IG9wdC5vcHRpb25zO1xuICAgIGlmICh0eXBlb2Ygb3B0cyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3B0cyh2YWwpO1xuICAgICAgICBpZiAoIXJlc3VsdCAmJiByZXN1bHQgIT0gbnVsbCkge1xuICAgICAgICAgIHRocm93IG9wdC5lcnJvciB8fCBgVmFsaWRhdGlvbiBmYWlsZWQuIEludmFsaWQgdmFsdWUgZm9yICR7a2V5fS5gO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICghZSkge1xuICAgICAgICAgIHRocm93IG9wdC5lcnJvciB8fCBgVmFsaWRhdGlvbiBmYWlsZWQuIEludmFsaWQgdmFsdWUgZm9yICR7a2V5fS5gO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGUubWVzc2FnZSB8fCBlO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkob3B0cykpIHtcbiAgICAgIG9wdHMgPSBbb3B0Lm9wdGlvbnNdO1xuICAgIH1cblxuICAgIGlmICghb3B0cy5pbmNsdWRlcyh2YWwpKSB7XG4gICAgICB0aHJvdyAoXG4gICAgICAgIG9wdC5lcnJvciB8fCBgVmFsaWRhdGlvbiBmYWlsZWQuIEludmFsaWQgb3B0aW9uIGZvciAke2tleX0uIEV4cGVjdGVkOiAke29wdHMuam9pbignLCAnKX1gXG4gICAgICApO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBnZXRUeXBlID0gZm4gPT4ge1xuICAgIGNvbnN0IG1hdGNoID0gZm4gJiYgZm4udG9TdHJpbmcoKS5tYXRjaCgvXlxccypmdW5jdGlvbiAoXFx3KykvKTtcbiAgICByZXR1cm4gKG1hdGNoID8gbWF0Y2hbMV0gOiAnJykudG9Mb3dlckNhc2UoKTtcbiAgfTtcbiAgaWYgKEFycmF5LmlzQXJyYXkob3B0aW9ucy5maWVsZHMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2Ygb3B0aW9ucy5maWVsZHMpIHtcbiAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgb3B0aW9uUHJvbWlzZXMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgY29uc3Qgb3B0ID0gb3B0aW9ucy5maWVsZHNba2V5XTtcbiAgICAgIGxldCB2YWwgPSBwYXJhbXNba2V5XTtcbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnc3RyaW5nJykge1xuICAgICAgICByZXF1aXJlZFBhcmFtKG9wdCk7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG9wdCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwgJiYgdmFsID09IG51bGwpIHtcbiAgICAgICAgICB2YWwgPSBvcHQuZGVmYXVsdDtcbiAgICAgICAgICBwYXJhbXNba2V5XSA9IHZhbDtcbiAgICAgICAgICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIHZhbCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChvcHQuY29uc3RhbnQgJiYgcmVxdWVzdC5vYmplY3QpIHtcbiAgICAgICAgICBpZiAocmVxdWVzdC5vcmlnaW5hbCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3QucmV2ZXJ0KGtleSk7XG4gICAgICAgICAgfSBlbHNlIGlmIChvcHQuZGVmYXVsdCAhPSBudWxsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5zZXQoa2V5LCBvcHQuZGVmYXVsdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChvcHQucmVxdWlyZWQpIHtcbiAgICAgICAgICByZXF1aXJlZFBhcmFtKGtleSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb3B0aW9uYWwgPSAhb3B0LnJlcXVpcmVkICYmIHZhbCA9PT0gdW5kZWZpbmVkO1xuICAgICAgICBpZiAoIW9wdGlvbmFsKSB7XG4gICAgICAgICAgaWYgKG9wdC50eXBlKSB7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gZ2V0VHlwZShvcHQudHlwZSk7XG4gICAgICAgICAgICBjb25zdCB2YWxUeXBlID0gQXJyYXkuaXNBcnJheSh2YWwpID8gJ2FycmF5JyA6IHR5cGVvZiB2YWw7XG4gICAgICAgICAgICBpZiAodmFsVHlwZSAhPT0gdHlwZSkge1xuICAgICAgICAgICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIEludmFsaWQgdHlwZSBmb3IgJHtrZXl9LiBFeHBlY3RlZDogJHt0eXBlfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChvcHQub3B0aW9ucykge1xuICAgICAgICAgICAgb3B0aW9uUHJvbWlzZXMucHVzaCh2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHZhbCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBQcm9taXNlLmFsbChvcHRpb25Qcm9taXNlcyk7XG4gIH1cbiAgbGV0IHVzZXJSb2xlcyA9IG9wdGlvbnMucmVxdWlyZUFueVVzZXJSb2xlcztcbiAgbGV0IHJlcXVpcmVBbGxSb2xlcyA9IG9wdGlvbnMucmVxdWlyZUFsbFVzZXJSb2xlcztcbiAgY29uc3QgcHJvbWlzZXMgPSBbUHJvbWlzZS5yZXNvbHZlKCksIFByb21pc2UucmVzb2x2ZSgpLCBQcm9taXNlLnJlc29sdmUoKV07XG4gIGlmICh1c2VyUm9sZXMgfHwgcmVxdWlyZUFsbFJvbGVzKSB7XG4gICAgcHJvbWlzZXNbMF0gPSBhdXRoLmdldFVzZXJSb2xlcygpO1xuICB9XG4gIGlmICh0eXBlb2YgdXNlclJvbGVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcHJvbWlzZXNbMV0gPSB1c2VyUm9sZXMoKTtcbiAgfVxuICBpZiAodHlwZW9mIHJlcXVpcmVBbGxSb2xlcyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHByb21pc2VzWzJdID0gcmVxdWlyZUFsbFJvbGVzKCk7XG4gIH1cbiAgY29uc3QgW3JvbGVzLCByZXNvbHZlZFVzZXJSb2xlcywgcmVzb2x2ZWRSZXF1aXJlQWxsXSA9IGF3YWl0IFByb21pc2UuYWxsKHByb21pc2VzKTtcbiAgaWYgKHJlc29sdmVkVXNlclJvbGVzICYmIEFycmF5LmlzQXJyYXkocmVzb2x2ZWRVc2VyUm9sZXMpKSB7XG4gICAgdXNlclJvbGVzID0gcmVzb2x2ZWRVc2VyUm9sZXM7XG4gIH1cbiAgaWYgKHJlc29sdmVkUmVxdWlyZUFsbCAmJiBBcnJheS5pc0FycmF5KHJlc29sdmVkUmVxdWlyZUFsbCkpIHtcbiAgICByZXF1aXJlQWxsUm9sZXMgPSByZXNvbHZlZFJlcXVpcmVBbGw7XG4gIH1cbiAgaWYgKHVzZXJSb2xlcykge1xuICAgIGNvbnN0IGhhc1JvbGUgPSB1c2VyUm9sZXMuc29tZShyZXF1aXJlZFJvbGUgPT4gcm9sZXMuaW5jbHVkZXMoYHJvbGU6JHtyZXF1aXJlZFJvbGV9YCkpO1xuICAgIGlmICghaGFzUm9sZSkge1xuICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBVc2VyIGRvZXMgbm90IG1hdGNoIHRoZSByZXF1aXJlZCByb2xlcy5gO1xuICAgIH1cbiAgfVxuICBpZiAocmVxdWlyZUFsbFJvbGVzKSB7XG4gICAgZm9yIChjb25zdCByZXF1aXJlZFJvbGUgb2YgcmVxdWlyZUFsbFJvbGVzKSB7XG4gICAgICBpZiAoIXJvbGVzLmluY2x1ZGVzKGByb2xlOiR7cmVxdWlyZWRSb2xlfWApKSB7XG4gICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gVXNlciBkb2VzIG5vdCBtYXRjaCBhbGwgdGhlIHJlcXVpcmVkIHJvbGVzLmA7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGNvbnN0IHVzZXJLZXlzID0gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMgfHwgW107XG4gIGlmIChBcnJheS5pc0FycmF5KHVzZXJLZXlzKSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIHVzZXJLZXlzKSB7XG4gICAgICBpZiAoIXJlcVVzZXIpIHtcbiAgICAgICAgdGhyb3cgJ1BsZWFzZSBsb2dpbiB0byBtYWtlIHRoaXMgcmVxdWVzdC4nO1xuICAgICAgfVxuXG4gICAgICBpZiAocmVxVXNlci5nZXQoa2V5KSA9PSBudWxsKSB7XG4gICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIHNldCBkYXRhIGZvciAke2tleX0gb24geW91ciBhY2NvdW50LmA7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2UgaWYgKHR5cGVvZiB1c2VyS2V5cyA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCBvcHRpb25Qcm9taXNlcyA9IFtdO1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5c1trZXldO1xuICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgIG9wdGlvblByb21pc2VzLnB1c2godmFsaWRhdGVPcHRpb25zKG9wdCwga2V5LCByZXFVc2VyLmdldChrZXkpKSk7XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKG9wdGlvblByb21pc2VzKTtcbiAgfVxufVxuXG4vLyBUbyBiZSB1c2VkIGFzIHBhcnQgb2YgdGhlIHByb21pc2UgY2hhaW4gd2hlbiBzYXZpbmcvZGVsZXRpbmcgYW4gb2JqZWN0XG4vLyBXaWxsIHJlc29sdmUgc3VjY2Vzc2Z1bGx5IGlmIG5vIHRyaWdnZXIgaXMgY29uZmlndXJlZFxuLy8gUmVzb2x2ZXMgdG8gYW4gb2JqZWN0LCBlbXB0eSBvciBjb250YWluaW5nIGFuIG9iamVjdCBrZXkuIEEgYmVmb3JlU2F2ZVxuLy8gdHJpZ2dlciB3aWxsIHNldCB0aGUgb2JqZWN0IGtleSB0byB0aGUgcmVzdCBmb3JtYXQgb2JqZWN0IHRvIHNhdmUuXG4vLyBvcmlnaW5hbFBhcnNlT2JqZWN0IGlzIG9wdGlvbmFsLCB3ZSBvbmx5IG5lZWQgdGhhdCBmb3IgYmVmb3JlL2FmdGVyU2F2ZSBmdW5jdGlvbnNcbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0XG4pIHtcbiAgaWYgKCFwYXJzZU9iamVjdCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHRyaWdnZXIgPSBnZXRUcmlnZ2VyKHBhcnNlT2JqZWN0LmNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIXRyaWdnZXIpIHsgcmV0dXJuIHJlc29sdmUoKTsgfVxuICAgIHZhciByZXF1ZXN0ID0gZ2V0UmVxdWVzdE9iamVjdChcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgYXV0aCxcbiAgICAgIHBhcnNlT2JqZWN0LFxuICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgICAgIGNvbmZpZyxcbiAgICAgIGNvbnRleHRcbiAgICApO1xuICAgIHZhciB7IHN1Y2Nlc3MsIGVycm9yIH0gPSBnZXRSZXNwb25zZU9iamVjdChcbiAgICAgIHJlcXVlc3QsXG4gICAgICBvYmplY3QgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIHRyaWdnZXJUeXBlLnN0YXJ0c1dpdGgoJ2FmdGVyJylcbiAgICAgICAgICAgID8gY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQWZ0ZXJcbiAgICAgICAgICAgIDogY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICAgICApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZVxuICAgICAgICApIHtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3QuY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShvYmplY3QpO1xuICAgICAgfSxcbiAgICAgIGVycm9yID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgYXV0aCxcbiAgICAgICAgICBlcnJvcixcbiAgICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVFcnJvclxuICAgICAgICApO1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBBZnRlclNhdmUgYW5kIGFmdGVyRGVsZXRlIHRyaWdnZXJzIGNhbiByZXR1cm4gYSBwcm9taXNlLCB3aGljaCBpZiB0aGV5XG4gICAgLy8gZG8sIG5lZWRzIHRvIGJlIHJlc29sdmVkIGJlZm9yZSB0aGlzIHByb21pc2UgaXMgcmVzb2x2ZWQsXG4gICAgLy8gc28gdHJpZ2dlciBleGVjdXRpb24gaXMgc3luY2VkIHdpdGggUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIC8vIElmIHRyaWdnZXJzIGRvIG5vdCByZXR1cm4gYSBwcm9taXNlLCB0aGV5IGNhbiBydW4gYXN5bmMgY29kZSBwYXJhbGxlbFxuICAgIC8vIHRvIHRoZSBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtwYXJzZU9iamVjdC5jbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwcm9taXNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dpblxuICAgICAgICApIHtcbiAgICAgICAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKFxuICAgICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJBZnRlclxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gYmVmb3JlU2F2ZSBpcyBleHBlY3RlZCB0byByZXR1cm4gbnVsbCAobm90aGluZylcbiAgICAgICAgaWYgKHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgICAgaWYgKHByb21pc2UgJiYgdHlwZW9mIHByb21pc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHByb21pc2UudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgIC8vIHJlc3BvbnNlLm9iamVjdCBtYXkgY29tZSBmcm9tIGV4cHJlc3Mgcm91dGluZyBiZWZvcmUgaG9va1xuICAgICAgICAgICAgICBpZiAocmVzcG9uc2UgJiYgcmVzcG9uc2Uub2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICB9KVxuICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KTtcbn1cblxuLy8gQ29udmVydHMgYSBSRVNULWZvcm1hdCBvYmplY3QgdG8gYSBQYXJzZS5PYmplY3Rcbi8vIGRhdGEgaXMgZWl0aGVyIGNsYXNzTmFtZSBvciBhbiBvYmplY3RcbmV4cG9ydCBmdW5jdGlvbiBpbmZsYXRlKGRhdGEsIHJlc3RPYmplY3QpIHtcbiAgdmFyIGNvcHkgPSB0eXBlb2YgZGF0YSA9PSAnb2JqZWN0JyA/IGRhdGEgOiB7IGNsYXNzTmFtZTogZGF0YSB9O1xuICBmb3IgKHZhciBrZXkgaW4gcmVzdE9iamVjdCkge1xuICAgIGNvcHlba2V5XSA9IHJlc3RPYmplY3Rba2V5XTtcbiAgfVxuICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKGNvcHkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyhkYXRhLCBhcHBsaWNhdGlvbklkID0gUGFyc2UuYXBwbGljYXRpb25JZCkge1xuICBpZiAoIV90cmlnZ2VyU3RvcmUgfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LmZvckVhY2goaGFuZGxlciA9PiBoYW5kbGVyKGRhdGEpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpIHtcbiAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAuLi5maWxlT2JqZWN0LFxuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGlzUmVhZE9ubHk6IGZhbHNlLFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgICBjb25maWcsXG4gIH07XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHJlcXVlc3RbJ2lzUmVhZE9ubHknXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWF5YmVSdW5GaWxlVHJpZ2dlcih0cmlnZ2VyVHlwZSwgZmlsZU9iamVjdCwgY29uZmlnLCBhdXRoKSB7XG4gIGNvbnN0IEZpbGVDbGFzc05hbWUgPSBnZXRDbGFzc05hbWUoUGFyc2UuRmlsZSk7XG4gIGNvbnN0IGZpbGVUcmlnZ2VyID0gZ2V0VHJpZ2dlcihGaWxlQ2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAodHlwZW9mIGZpbGVUcmlnZ2VyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0RmlsZU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgZmlsZU9iamVjdCwgY29uZmlnKTtcbiAgICAgIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke0ZpbGVDbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gZmlsZU9iamVjdDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZpbGVUcmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgaWYgKHJlcXVlc3QuZm9yY2VEb3dubG9hZCkge1xuICAgICAgICBmaWxlT2JqZWN0LmZvcmNlRG93bmxvYWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QucmVzcG9uc2VIZWFkZXJzKSB7XG4gICAgICAgIGZpbGVPYmplY3QucmVzcG9uc2VIZWFkZXJzID0gcmVxdWVzdC5yZXNwb25zZUhlYWRlcnM7XG4gICAgICB9XG4gICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZVN1Y2Nlc3NcbiAgICAgICk7XG4gICAgICByZXR1cm4gcmVzdWx0IHx8IGZpbGVPYmplY3Q7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICBhdXRoLFxuICAgICAgICBlcnJvcixcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlRXJyb3JcbiAgICAgICk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZpbGVPYmplY3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkdsb2JhbENvbmZpZ1RyaWdnZXIodHJpZ2dlclR5cGUsIGF1dGgsIGNvbmZpZ09iamVjdCwgb3JpZ2luYWxDb25maWdPYmplY3QsIGNvbmZpZywgY29udGV4dCkge1xuICBjb25zdCBHbG9iYWxDb25maWdDbGFzc05hbWUgPSBnZXRDbGFzc05hbWUoUGFyc2UuQ29uZmlnKTtcbiAgY29uc3QgY29uZmlnVHJpZ2dlciA9IGdldFRyaWdnZXIoR2xvYmFsQ29uZmlnQ2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAodHlwZW9mIGNvbmZpZ1RyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGNvbmZpZ09iamVjdCwgb3JpZ2luYWxDb25maWdPYmplY3QsIGNvbmZpZywgY29udGV4dCk7XG4gICAgICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtHbG9iYWxDb25maWdDbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gY29uZmlnT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29uZmlnVHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5Db25maWcnLFxuICAgICAgICBjb25maWdPYmplY3QsXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgfHwgY29uZmlnT2JqZWN0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkNvbmZpZycsXG4gICAgICAgIGNvbmZpZ09iamVjdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIHJldHVybiBjb25maWdPYmplY3Q7XG59XG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZSh0eXBlLCBjbGFzc05hbWUsIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKSkge1xuICBjb25zdCBwYXJlbnQgPSBBV1NYUmF5LmdldFNlZ21lbnQoKTtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIEFXU1hSYXkuY2FwdHVyZUFzeW5jRnVuYyhgUGFyc2UtU2VydmVyX3RyaWdnZXJzXyR7dHlwZX1fJHtjbGFzc05hbWV9YCwgc3Vic2VnbWVudCA9PiB7XG4gICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICd0cmlnZ2VycycpO1xuICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ1R5cGUnLCB0eXBlKTtcbiAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgKFV0aWxzLmlzUHJvbWlzZShwcm9taXNlKSA/IHByb21pc2UgOiBQcm9taXNlLnJlc29sdmUocHJvbWlzZSkpLnRoZW4oXG4gICAgICAgIGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgIH0sXG4gICAgICAgIGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKGVycm9yKTtcbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9KTtcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFHQSxJQUFBQSxLQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxNQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFBNEIsU0FBQUQsdUJBQUFJLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFMNUI7QUFDQSxNQUFNRyxPQUFPLEdBQUdOLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQztBQU1sQyxNQUFNTyxLQUFLLEdBQUFDLE9BQUEsQ0FBQUQsS0FBQSxHQUFHO0VBQ25CRSxXQUFXLEVBQUUsYUFBYTtFQUMxQkMsVUFBVSxFQUFFLFlBQVk7RUFDeEJDLFdBQVcsRUFBRSxhQUFhO0VBQzFCQywwQkFBMEIsRUFBRSw0QkFBNEI7RUFDeERDLFVBQVUsRUFBRSxZQUFZO0VBQ3hCQyxTQUFTLEVBQUUsV0FBVztFQUN0QkMsWUFBWSxFQUFFLGNBQWM7RUFDNUJDLFdBQVcsRUFBRSxhQUFhO0VBQzFCQyxVQUFVLEVBQUUsWUFBWTtFQUN4QkMsU0FBUyxFQUFFLFdBQVc7RUFDdEJDLGFBQWEsRUFBRSxlQUFlO0VBQzlCQyxlQUFlLEVBQUUsaUJBQWlCO0VBQ2xDQyxVQUFVLEVBQUU7QUFDZCxDQUFDO0FBRUQsTUFBTUMsZ0JBQWdCLEdB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