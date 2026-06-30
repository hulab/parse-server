"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getClassName = getClassName;
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addTrigger = addTrigger;
exports.addConnectTrigger = addConnectTrigger;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports._unregisterAll = _unregisterAll;
exports.toJSONwithObjects = toJSONwithObjects;
exports.getTrigger = getTrigger;
exports.runTrigger = runTrigger;
exports.triggerExists = triggerExists;
exports.getFunction = getFunction;
exports.getFunctionNames = getFunctionNames;
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.getValidator = getValidator;
exports.getRequestObject = getRequestObject;
exports.getRequestQueryObject = getRequestQueryObject;
exports.getResponseObject = getResponseObject;
exports.maybeRunAfterFindTrigger = maybeRunAfterFindTrigger;
exports.maybeRunQueryTrigger = maybeRunQueryTrigger;
exports.resolveError = resolveError;
exports.maybeRunValidator = maybeRunValidator;
exports.maybeRunTrigger = maybeRunTrigger;
exports.inflate = inflate;
exports.runLiveQueryEventHandlers = runLiveQueryEventHandlers;
exports.getRequestFileObject = getRequestFileObject;
exports.maybeRunFileTrigger = maybeRunFileTrigger;
exports.Types = void 0;

var _node = _interopRequireDefault(require("parse/node"));

var _logger = require("./logger");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

// triggers.js
const AWSXRay = require('hulab-xray-sdk');

const Types = {
  beforeLogin: 'beforeLogin',
  afterLogin: 'afterLogin',
  afterLogout: 'afterLogout',
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
exports.Types = Types;
const ConnectClassName = '@Connect';

const baseStore = function () {
  const Validators = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  const Functions = {};
  const Jobs = {};
  const LiveQuery = [];
  const Triggers = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
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

  if ((type === Types.beforeLogin || type === Types.afterLogin) && className !== '_User') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _User class is allowed for the beforeLogin and afterLogin triggers';
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

const _triggerStore = {};
const Category = {
  Functions: 'Functions',
  Validators: 'Validators',
  Jobs: 'Jobs',
  Triggers: 'Triggers'
};

function getStore(category, name, applicationId) {
  const path = name.split('.');
  path.splice(-1); // remove last component

  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  let store = _triggerStore[applicationId][category];

  for (const component of path) {
    store = store[component];

    if (!store) {
      return undefined;
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

  if (className) {
    toJSON.className = className;
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

function getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context) {
  const request = {
    triggerName: triggerType,
    object: parseObject,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip
  };

  if (originalParseObject) {
    request.original = originalParseObject;
  }

  if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete || triggerType === Types.afterFind) {
    // Set a copy of the context on the request object.
    request.context = Object.assign({}, context);
  }

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
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
    count,
    log: config.loggerController,
    isGet,
    headers: config.headers,
    ip: config.ip,
    context: context || {}
  };

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
} // Creates the response object, and uses the request object to pass data
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
      } // Use the JSON response


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

function logTriggerAfterHook(triggerType, className, input, auth) {
  const cleanInput = JSON.stringify(input);

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth) {
  const cleanInput = JSON.stringify(input);

  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput} Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerErrorBeforeHook(triggerType, className, input, auth, error) {
  const cleanInput = JSON.stringify(input);

  _logger.logger.error(`${triggerType} failed for ${className} for user ${userIdForLog(auth)}: Input: ${cleanInput} Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}

function maybeRunAfterFindTrigger(triggerType, auth, className, objects, config, query, context) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(className, triggerType, config.applicationId);

    if (!trigger) {
      return resolve();
    }

    const request = getRequestObject(triggerType, auth, null, null, config, context);

    if (query) {
      request.query = query;
    }

    const {
      success,
      error
    } = getResponseObject(request, object => {
      resolve(object);
    }, error => {
      reject(error);
    });
    logTriggerSuccessBeforeHook(triggerType, className, 'AfterFind', JSON.stringify(objects), auth);
    request.objects = objects.map(object => {
      //setting the class name to transform into parse object
      object.className = className;
      return _node.default.Object.fromJSON(object);
    });
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${className}`, auth);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return request.objects;
      }

      const response = trigger(request);

      if (response && typeof response.then === 'function') {
        return response.then(results => {
          return results;
        });
      }

      return response;
    }).then(success, error);
  }).then(results => {
    logTriggerAfterHook(triggerType, className, JSON.stringify(results), auth);
    return results;
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
  return tracePromise(triggerType, className, Promise.resolve().then(() => {
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

    return {
      restWhere,
      restOptions
    };
  }, err => {
    const error = resolveError(err, {
      code: _node.default.Error.SCRIPT_FAILED,
      message: 'Script failed. Unknown error.'
    });
    throw error;
  }));
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

  const code = defaultOpts.code || _node.default.Error.SCRIPT_FAILED; // If it's an error, mark it as a script failed

  if (typeof message === 'string') {
    return new _node.default.Error(code, message);
  }

  const error = new _node.default.Error(code, message.message || message);

  if (message instanceof Error) {
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
} // To be used as part of the promise chain when saving/deleting an object
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
    if (!trigger) return resolve();
    var request = getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context);
    var {
      success,
      error
    } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth);

      if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
        Object.assign(context, request.context);
      }

      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error);
      reject(error);
    }); // AfterSave and afterDelete triggers can return a promise, which if they
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
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth);
      } // beforeSave is expected to return null (nothing)


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
} // Converts a REST-format object to a Parse.Object
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
  const request = _objectSpread(_objectSpread({}, fileObject), {}, {
    triggerName: triggerType,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip
  });

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
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
      logTriggerSuccessBeforeHook(triggerType, 'Parse.File', _objectSpread(_objectSpread({}, fileObject.file.toJSON()), {}, {
        fileSize: fileObject.fileSize
      }), result, auth);
      return result || fileObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.File', _objectSpread(_objectSpread({}, fileObject.file.toJSON()), {}, {
        fileSize: fileObject.fileSize
      }), auth, error);
      throw error;
    }
  }

  return fileObject;
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
      (promise instanceof Promise ? promise : Promise.resolve(promise)).then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJBV1NYUmF5IiwicmVxdWlyZSIsIlR5cGVzIiwiYmVmb3JlTG9naW4iLCJhZnRlckxvZ2luIiwiYWZ0ZXJMb2dvdXQiLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmVmb3JlQ29ubmVjdCIsImJlZm9yZVN1YnNjcmliZSIsImFmdGVyRXZlbnQiLCJDb25uZWN0Q2xhc3NOYW1lIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiRnVuY3Rpb25zIiwiSm9icyIsIkxpdmVRdWVyeSIsIlRyaWdnZXJzIiwiZnJlZXplIiwiZ2V0Q2xhc3NOYW1lIiwicGFyc2VDbGFzcyIsImNsYXNzTmFtZSIsIm5hbWUiLCJyZXBsYWNlIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsInR5cGUiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwiYXBwbGljYXRpb25JZCIsInBhdGgiLCJzcGxpdCIsInNwbGljZSIsIlBhcnNlIiwic3RvcmUiLCJjb21wb25lbnQiLCJ1bmRlZmluZWQiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsInRvSlNPTndpdGhPYmplY3RzIiwib2JqZWN0IiwidG9KU09OIiwic3RhdGVDb250cm9sbGVyIiwiQ29yZU1hbmFnZXIiLCJnZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIiLCJwZW5kaW5nIiwiZ2V0UGVuZGluZ09wcyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJ2YWwiLCJfdG9GdWxsSlNPTiIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsInJ1blRyaWdnZXIiLCJ0cmlnZ2VyIiwicmVxdWVzdCIsImF1dGgiLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwidHJpZ2dlckV4aXN0cyIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsInRyaWdnZXJOYW1lIiwibWFzdGVyIiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImhlYWRlcnMiLCJpcCIsIm9yaWdpbmFsIiwiYXNzaWduIiwiaXNNYXN0ZXIiLCJ1c2VyIiwiaW5zdGFsbGF0aW9uSWQiLCJnZXRSZXF1ZXN0UXVlcnlPYmplY3QiLCJxdWVyeSIsImNvdW50IiwiaXNHZXQiLCJnZXRSZXNwb25zZU9iamVjdCIsInJlc29sdmUiLCJyZWplY3QiLCJzdWNjZXNzIiwicmVzcG9uc2UiLCJvYmplY3RzIiwibWFwIiwiZXF1YWxzIiwiX2dldFNhdmVKU09OIiwiaWQiLCJlcnJvciIsImUiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImxvZ1RyaWdnZXJBZnRlckhvb2siLCJpbnB1dCIsImNsZWFuSW5wdXQiLCJKU09OIiwic3RyaW5naWZ5IiwiaW5mbyIsImxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayIsInJlc3VsdCIsImNsZWFuUmVzdWx0IiwidHJ1bmNhdGVMb2dNZXNzYWdlIiwibG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayIsIm1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlciIsIlByb21pc2UiLCJmcm9tSlNPTiIsInRoZW4iLCJyZXN1bHRzIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImpzb24iLCJ3aGVyZSIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIndpdGhKU09OIiwicmVxdWVzdE9iamVjdCIsInRyYWNlUHJvbWlzZSIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5IiwibGltaXQiLCJza2lwIiwiaW5jbHVkZSIsImV4Y2x1ZGVLZXlzIiwiZXhwbGFpbiIsIm9yZGVyIiwiaGludCIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImVyciIsImRlZmF1bHRPcHRzIiwic3RhY2siLCJ0aGVWYWxpZGF0b3IiLCJidWlsdEluVHJpZ2dlclZhbGlkYXRvciIsImNhdGNoIiwiVkFMSURBVElPTl9FUlJPUiIsIm9wdGlvbnMiLCJ2YWxpZGF0ZU1hc3RlcktleSIsInJlcVVzZXIiLCJleGlzdGVkIiwicmVxdWlyZVVzZXIiLCJyZXF1aXJlQW55VXNlclJvbGVzIiwicmVxdWlyZUFsbFVzZXJSb2xlcyIsInJlcXVpcmVNYXN0ZXIiLCJwYXJhbXMiLCJyZXF1aXJlZFBhcmFtIiwidmFsaWRhdGVPcHRpb25zIiwib3B0Iiwib3B0cyIsIkFycmF5IiwiaXNBcnJheSIsImluY2x1ZGVzIiwiam9pbiIsImdldFR5cGUiLCJmbiIsIm1hdGNoIiwidG9TdHJpbmciLCJ0b0xvd2VyQ2FzZSIsImZpZWxkcyIsIm9wdGlvblByb21pc2VzIiwiZGVmYXVsdCIsInNldCIsImNvbnN0YW50IiwicmV2ZXJ0IiwicmVxdWlyZWQiLCJvcHRpb25hbCIsInZhbFR5cGUiLCJhbGwiLCJ1c2VyUm9sZXMiLCJyZXF1aXJlQWxsUm9sZXMiLCJwcm9taXNlcyIsImdldFVzZXJSb2xlcyIsInJvbGVzIiwicmVzb2x2ZWRVc2VyUm9sZXMiLCJyZXNvbHZlZFJlcXVpcmVBbGwiLCJoYXNSb2xlIiwic29tZSIsInJlcXVpcmVkUm9sZSIsInVzZXJLZXlzIiwicmVxdWlyZVVzZXJLZXlzIiwibWF5YmVSdW5UcmlnZ2VyIiwicHJvbWlzZSIsImluZmxhdGUiLCJkYXRhIiwicmVzdE9iamVjdCIsImNvcHkiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZ2V0UmVxdWVzdEZpbGVPYmplY3QiLCJmaWxlT2JqZWN0IiwibWF5YmVSdW5GaWxlVHJpZ2dlciIsIkZpbGVDbGFzc05hbWUiLCJGaWxlIiwiZmlsZVRyaWdnZXIiLCJmaWxlIiwiZmlsZVNpemUiLCJwYXJlbnQiLCJnZXRTZWdtZW50IiwiY2FwdHVyZUFzeW5jRnVuYyIsInN1YnNlZ21lbnQiLCJhZGRBbm5vdGF0aW9uIiwiY2xvc2UiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFHQTs7QUFDQTs7Ozs7Ozs7OztBQUpBO0FBQ0EsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsZ0JBQUQsQ0FBdkI7O0FBS08sTUFBTUMsS0FBSyxHQUFHO0FBQ25CQyxFQUFBQSxXQUFXLEVBQUUsYUFETTtBQUVuQkMsRUFBQUEsVUFBVSxFQUFFLFlBRk87QUFHbkJDLEVBQUFBLFdBQVcsRUFBRSxhQUhNO0FBSW5CQyxFQUFBQSxVQUFVLEVBQUUsWUFKTztBQUtuQkMsRUFBQUEsU0FBUyxFQUFFLFdBTFE7QUFNbkJDLEVBQUFBLFlBQVksRUFBRSxjQU5LO0FBT25CQyxFQUFBQSxXQUFXLEVBQUUsYUFQTTtBQVFuQkMsRUFBQUEsVUFBVSxFQUFFLFlBUk87QUFTbkJDLEVBQUFBLFNBQVMsRUFBRSxXQVRRO0FBVW5CQyxFQUFBQSxhQUFhLEVBQUUsZUFWSTtBQVduQkMsRUFBQUEsZUFBZSxFQUFFLGlC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UUFBQUEsT0FBTyxDQUFDd0IsTUFBRCxDQUFQO0FBQ0FvRyxRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxFQUFkO0FBQ0QsT0FKSCxFQUtFLFVBQVNySCxLQUFULEVBQWdCO0FBQ2RSLFFBQUFBLE1BQU0sQ0FBQ1EsS0FBRCxDQUFOO0FBQ0FtSCxRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxDQUFpQnJILEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FoQkg7QUFrQkQsR0FuQk0sQ0FBUDtBQW9CRCIsInNvdXJjZXNDb250ZW50IjpbIi8vIHRyaWdnZXJzLmpzXG5jb25zdCBBV1NYUmF5ID0gcmVxdWlyZSgnaHVsYWIteHJheS1zZGsnKTtcblxuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi9sb2dnZXInO1xuXG5leHBvcnQgY29uc3QgVHlwZXMgPSB7XG4gIGJlZm9yZUxvZ2luOiAnYmVmb3JlTG9naW4nLFxuICBhZnRlckxvZ2luOiAnYWZ0ZXJMb2dpbicsXG4gIGFmdGVyTG9nb3V0OiAnYWZ0ZXJMb2dvdXQnLFxuICBiZWZvcmVTYXZlOiAnYmVmb3JlU2F2ZScsXG4gIGFmdGVyU2F2ZTogJ2FmdGVyU2F2ZScsXG4gIGJlZm9yZURlbGV0ZTogJ2JlZm9yZURlbGV0ZScsXG4gIGFmdGVyRGVsZXRlOiAnYWZ0ZXJEZWxldGUnLFxuICBiZWZvcmVGaW5kOiAnYmVmb3JlRmluZCcsXG4gIGFmdGVyRmluZDogJ2FmdGVyRmluZCcsXG4gIGJlZm9yZUNvbm5lY3Q6ICdiZWZvcmVDb25uZWN0JyxcbiAgYmVmb3JlU3Vic2NyaWJlOiAnYmVmb3JlU3Vic2NyaWJlJyxcbiAgYWZ0ZXJFdmVudDogJ2FmdGVyRXZlbnQnLFxufTtcblxuY29uc3QgQ29ubmVjdENsYXNzTmFtZSA9ICdAQ29ubmVjdCc7XG5cbmNvbnN0IGJhc2VTdG9yZSA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgVmFsaWRhdG9ycyA9IE9iamVjdC5rZXlzKFR5cGVzKS5yZWR1Y2UoZnVuY3Rpb24gKGJhc2UsIGtleSkge1xuICAgIGJhc2Vba2V5XSA9IHt9O1xuICAgIHJldHVybiBiYXNlO1xuICB9LCB7fSk7XG4gIGNvbnN0IEZ1bmN0aW9ucyA9IHt9O1xuICBjb25zdCBKb2JzID0ge307XG4gIGNvbnN0IExpdmVRdWVyeSA9IFtdO1xuICBjb25zdCBUcmlnZ2VycyA9IE9iamVjdC5rZXlzKFR5cGVzKS5yZWR1Y2UoZnVuY3Rpb24gKGJhc2UsIGtleSkge1xuICAgIGJhc2Vba2V5XSA9IHt9O1xuICAgIHJldHVybiBiYXNlO1xuICB9LCB7fSk7XG5cbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIEZ1bmN0aW9ucyxcbiAgICBKb2JzLFxuICAgIFZhbGlkYXRvcnMsXG4gICAgVHJpZ2dlcnMsXG4gICAgTGl2ZVF1ZXJ5LFxuICB9KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDbGFzc05hbWUocGFyc2VDbGFzcykge1xuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLmNsYXNzTmFtZSkge1xuICAgIHJldHVybiBwYXJzZUNsYXNzLmNsYXNzTmFtZTtcbiAgfVxuICBpZiAocGFyc2VDbGFzcyAmJiBwYXJzZUNsYXNzLm5hbWUpIHtcbiAgICByZXR1cm4gcGFyc2VDbGFzcy5uYW1lLnJlcGxhY2UoJ1BhcnNlJywgJ0AnKTtcbiAgfVxuICByZXR1cm4gcGFyc2VDbGFzcztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpIHtcbiAgaWYgKHR5cGUgPT0gVHlwZXMuYmVmb3JlU2F2ZSAmJiBjbGFzc05hbWUgPT09ICdfUHVzaFN0YXR1cycpIHtcbiAgICAvLyBfUHVzaFN0YXR1cyB1c2VzIHVuZG9jdW1lbnRlZCBuZXN0ZWQga2V5IGluY3JlbWVudCBvcHNcbiAgICAvLyBhbGxvd2luZyBiZWZvcmVTYXZlIHdvdWxkIG1lc3MgdXAgdGhlIG9iamVjdHMgYmlnIHRpbWVcbiAgICAvLyBUT0RPOiBBbGxvdyBwcm9wZXIgZG9jdW1lbnRlZCB3YXkgb2YgdXNpbmcgbmVzdGVkIGluY3JlbWVudCBvcHNcbiAgICB0aHJvdyAnT25seSBhZnRlclNhdmUgaXMgYWxsb3dlZCBvbiBfUHVzaFN0YXR1cyc7XG4gIH1cbiAgaWYgKCh0eXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fCB0eXBlID09PSBUeXBlcy5hZnRlckxvZ2luKSAmJiBjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9Vc2VyIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBiZWZvcmVMb2dpbiBhbmQgYWZ0ZXJMb2dpbiB0cmlnZ2Vycyc7XG4gIH1cbiAgaWYgKHR5cGUgPT09IFR5cGVzLmFmdGVyTG9nb3V0ICYmIGNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1Nlc3Npb24gY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGFmdGVyTG9nb3V0IHRyaWdnZXIuJztcbiAgfVxuICBpZiAoY2xhc3NOYW1lID09PSAnX1Nlc3Npb24nICYmIHR5cGUgIT09IFR5cGVzLmFmdGVyTG9nb3V0KSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBhZnRlckxvZ291dCB0cmlnZ2VyIGlzIGFsbG93ZWQgZm9yIHRoZSBfU2Vzc2lvbiBjbGFzcy4nO1xuICB9XG4gIHJldHVybiBjbGFzc05hbWU7XG59XG5cbmNvbnN0IF90cmlnZ2VyU3RvcmUgPSB7fTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJyxcbn07XG5cbmZ1bmN0aW9uIGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHBhdGggPSBuYW1lLnNwbGl0KCcuJyk7XG4gIHBhdGguc3BsaWNlKC0xKTsgLy8gcmVtb3ZlIGxhc3QgY29tcG9uZW50XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBsZXQgc3RvcmUgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW2NhdGVnb3J5XTtcbiAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgcGF0aCkge1xuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RvcmU7XG59XG5cbmZ1bmN0aW9uIGFkZChjYXRlZ29yeSwgbmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoc3RvcmVbbGFzdENvbXBvbmVudF0pIHtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGBXYXJuaW5nOiBEdXBsaWNhdGUgY2xvdWQgZnVuY3Rpb25zIGV4aXN0IGZvciAke2xhc3RDb21wb25lbnR9LiBPbmx5IHRoZSBsYXN0IG9uZSB3aWxsIGJlIHVzZWQgYW5kIHRoZSBvdGhlcnMgd2lsbCBiZSBpZ25vcmVkLmBcbiAgICApO1xuICB9XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKTtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbm5lY3RUcmlnZ2VyKHR5cGUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZExpdmVRdWVyeUV2ZW50SGFuZGxlcihoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvSlNPTndpdGhPYmplY3RzKG9iamVjdCwgY2xhc3NOYW1lKSB7XG4gIGlmICghb2JqZWN0IHx8ICFvYmplY3QudG9KU09OKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGNvbnN0IHRvSlNPTiA9IG9iamVjdC50b0pTT04oKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKG9iamVjdC5fZ2V0U3RhdGVJZGVudGlmaWVyKCkpO1xuICBmb3IgKGNvbnN0IGtleSBpbiBwZW5kaW5nKSB7XG4gICAgY29uc3QgdmFsID0gb2JqZWN0LmdldChrZXkpO1xuICAgIGlmICghdmFsIHx8ICF2YWwuX3RvRnVsbEpTT04pIHtcbiAgICAgIHRvSlNPTltrZXldID0gdmFsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRvSlNPTltrZXldID0gdmFsLl90b0Z1bGxKU09OKCk7XG4gIH1cbiAgaWYgKGNsYXNzTmFtZSkge1xuICAgIHRvSlNPTi5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIH1cbiAgcmV0dXJuIHRvSlNPTjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyAnTWlzc2luZyBBcHBsaWNhdGlvbklEJztcbiAgfVxuICByZXR1cm4gZ2V0KENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5UcmlnZ2VyKHRyaWdnZXIsIG5hbWUsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIG5hbWUsIGF1dGgpO1xuICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gYXdhaXQgdHJpZ2dlcihyZXF1ZXN0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRyaWdnZXJFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIHR5cGU6IHN0cmluZywgYXBwbGljYXRpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHlwZSwgYXBwbGljYXRpb25JZCkgIT0gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RnVuY3Rpb25OYW1lcyhhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHN0b3JlID1cbiAgICAoX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSAmJiBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW0NhdGVnb3J5LkZ1bmN0aW9uc10pIHx8IHt9O1xuICBjb25zdCBmdW5jdGlvbk5hbWVzID0gW107XG4gIGNvbnN0IGV4dHJhY3RGdW5jdGlvbk5hbWVzID0gKG5hbWVzcGFjZSwgc3RvcmUpID0+IHtcbiAgICBPYmplY3Qua2V5cyhzdG9yZSkuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3RvcmVbbmFtZV07XG4gICAgICBpZiAobmFtZXNwYWNlKSB7XG4gICAgICAgIG5hbWUgPSBgJHtuYW1lc3BhY2V9LiR7bmFtZX1gO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBmdW5jdGlvbk5hbWVzLnB1c2gobmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBleHRyYWN0RnVuY3Rpb25OYW1lcyhuYW1lLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG4gIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG51bGwsIHN0b3JlKTtcbiAgcmV0dXJuIGZ1bmN0aW9uTmFtZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2Ioam9iTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9icyhhcHBsaWNhdGlvbklkKSB7XG4gIHZhciBtYW5hZ2VyID0gX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXTtcbiAgaWYgKG1hbmFnZXIgJiYgbWFuYWdlci5Kb2JzKSB7XG4gICAgcmV0dXJuIG1hbmFnZXIuSm9icztcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0T2JqZWN0KFxuICB0cmlnZ2VyVHlwZSxcbiAgYXV0aCxcbiAgcGFyc2VPYmplY3QsXG4gIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gIGNvbmZpZyxcbiAgY29udGV4dFxuKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG9iamVjdDogcGFyc2VPYmplY3QsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gIH07XG5cbiAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICByZXF1ZXN0Lm9yaWdpbmFsID0gb3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgfVxuICBpZiAoXG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckZpbmRcbiAgKSB7XG4gICAgLy8gU2V0IGEgY29weSBvZiB0aGUgY29udGV4dCBvbiB0aGUgcmVxdWVzdCBvYmplY3QuXG4gICAgcmVxdWVzdC5jb250ZXh0ID0gT2JqZWN0LmFzc2lnbih7fSwgY29udGV4dCk7XG4gIH1cblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXF1ZXN0UXVlcnlPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIHF1ZXJ5LCBjb3VudCwgY29uZmlnLCBjb250ZXh0LCBpc0dldCkge1xuICBpc0dldCA9ICEhaXNHZXQ7XG5cbiAgdmFyIHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIHF1ZXJ5LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgY291bnQsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBpc0dldCxcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbnRleHQ6IGNvbnRleHQgfHwge30sXG4gIH07XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG4vLyBDcmVhdGVzIHRoZSByZXNwb25zZSBvYmplY3QsIGFuZCB1c2VzIHRoZSByZXF1ZXN0IG9iamVjdCB0byBwYXNzIGRhdGFcbi8vIFRoZSBBUEkgd2lsbCBjYWxsIHRoaXMgd2l0aCBSRVNUIEFQSSBmb3JtYXR0ZWQgb2JqZWN0cywgdGhpcyB3aWxsXG4vLyB0cmFuc2Zvcm0gdGhlbSB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGV4cGVjdGVkIGJ5IENsb3VkIENvZGUuXG4vLyBBbnkgY2hhbmdlcyBtYWRlIHRvIHRoZSBvYmplY3QgaW4gYSBiZWZvcmVTYXZlIHdpbGwgYmUgaW5jbHVkZWQuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVzcG9uc2VPYmplY3QocmVxdWVzdCwgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogZnVuY3Rpb24gKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kKSB7XG4gICAgICAgIGlmICghcmVzcG9uc2UpIHtcbiAgICAgICAgICByZXNwb25zZSA9IHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXNwb25zZSA9IHJlc3BvbnNlLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIHJldHVybiB0b0pTT053aXRoT2JqZWN0cyhvYmplY3QpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgLy8gVXNlIHRoZSBKU09OIHJlc3BvbnNlXG4gICAgICBpZiAoXG4gICAgICAgIHJlc3BvbnNlICYmXG4gICAgICAgIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgIXJlcXVlc3Qub2JqZWN0LmVxdWFscyhyZXNwb25zZSkgJiZcbiAgICAgICAgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXNwb25zZSAmJiB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKCk7XG4gICAgICB9XG4gICAgICByZXNwb25zZSA9IHt9O1xuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgcmVzcG9uc2VbJ29iamVjdCddID0gcmVxdWVzdC5vYmplY3QuX2dldFNhdmVKU09OKCk7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXVsnb2JqZWN0SWQnXSA9IHJlcXVlc3Qub2JqZWN0LmlkO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgY29uc3QgZSA9IHJlc29sdmVFcnJvcihlcnJvciwge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgfSk7XG4gICAgICByZWplY3QoZSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXNlcklkRm9yTG9nKGF1dGgpIHtcbiAgcmV0dXJuIGF1dGggJiYgYXV0aC51c2VyID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBKU09OLnN0cmluZ2lmeShpbnB1dCk7XG4gIGxvZ2dlci5pbmZvKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCByZXN1bHQsIGF1dGgpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KGlucHV0KTtcbiAgY29uc3QgY2xlYW5SZXN1bHQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICBsb2dnZXIuaW5mbyhcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06IElucHV0OiAke2NsZWFuSW5wdXR9IFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IEpTT04uc3RyaW5naWZ5KGlucHV0KTtcbiAgbG9nZ2VyLmVycm9yKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTogSW5wdXQ6ICR7Y2xlYW5JbnB1dH0gRXJyb3I6ICR7SlNPTi5zdHJpbmdpZnkoZXJyb3IpfWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBlcnJvcixcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBjbGFzc05hbWUsXG4gIG9iamVjdHMsXG4gIGNvbmZpZyxcbiAgcXVlcnksXG4gIGNvbnRleHRcbikge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIXRyaWdnZXIpIHtcbiAgICAgIHJldHVybiByZXNvbHZlKCk7XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBudWxsLCBudWxsLCBjb25maWcsIGNvbnRleHQpO1xuICAgIGlmIChxdWVyeSkge1xuICAgICAgcmVxdWVzdC5xdWVyeSA9IHF1ZXJ5O1xuICAgIH1cbiAgICBjb25zdCB7IHN1Y2Nlc3MsIGVycm9yIH0gPSBnZXRSZXNwb25zZU9iamVjdChcbiAgICAgIHJlcXVlc3QsXG4gICAgICBvYmplY3QgPT4ge1xuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG4gICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsICdBZnRlckZpbmQnLCBKU09OLnN0cmluZ2lmeShvYmplY3RzKSwgYXV0aCk7XG4gICAgcmVxdWVzdC5vYmplY3RzID0gb2JqZWN0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgIC8vc2V0dGluZyB0aGUgY2xhc3MgbmFtZSB0byB0cmFuc2Zvcm0gaW50byBwYXJzZSBvYmplY3RcbiAgICAgIG9iamVjdC5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gICAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKG9iamVjdCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiByZXF1ZXN0Lm9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlLnRoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICByZXR1cm4gcmVzcG9uc2UudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBKU09OLnN0cmluZ2lmeShyZXN1bHRzKSwgYXV0aCk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5RdWVyeVRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBjbGFzc05hbWUsXG4gIHJlc3RXaGVyZSxcbiAgcmVzdE9wdGlvbnMsXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe1xuICAgICAgcmVzdFdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnMsXG4gICAgfSk7XG4gIH1cbiAgY29uc3QganNvbiA9IE9iamVjdC5hc3NpZ24oe30sIHJlc3RPcHRpb25zKTtcbiAganNvbi53aGVyZSA9IHJlc3RXaGVyZTtcblxuICBjb25zdCBwYXJzZVF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZSk7XG4gIHBhcnNlUXVlcnkud2l0aEpTT04oanNvbik7XG5cbiAgbGV0IGNvdW50ID0gZmFsc2U7XG4gIGlmIChyZXN0T3B0aW9ucykge1xuICAgIGNvdW50ID0gISFyZXN0T3B0aW9ucy5jb3VudDtcbiAgfVxuICBjb25zdCByZXF1ZXN0T2JqZWN0ID0gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KFxuICAgIHRyaWdnZXJUeXBlLFxuICAgIGF1dGgsXG4gICAgcGFyc2VRdWVyeSxcbiAgICBjb3VudCxcbiAgICBjb25maWcsXG4gICAgY29udGV4dCxcbiAgICBpc0dldFxuICApO1xuICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgIHRyaWdnZXJUeXBlLFxuICAgIGNsYXNzTmFtZSxcbiAgICBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdE9iamVjdCwgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdE9iamVjdC5xdWVyeTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHJpZ2dlcihyZXF1ZXN0T2JqZWN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihcbiAgICAgICAgcmVzdWx0ID0+IHtcbiAgICAgICAgICBsZXQgcXVlcnlSZXN1bHQgPSBwYXJzZVF1ZXJ5O1xuICAgICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgICAgICAgIHF1ZXJ5UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBqc29uUXVlcnkgPSBxdWVyeVJlc3VsdC50b0pTT04oKTtcbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LndoZXJlKSB7XG4gICAgICAgICAgICByZXN0V2hlcmUgPSBqc29uUXVlcnkud2hlcmU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkubGltaXQpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5saW1pdCA9IGpzb25RdWVyeS5saW1pdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5za2lwKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuc2tpcCA9IGpzb25RdWVyeS5za2lwO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmluY2x1ZGUpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ganNvblF1ZXJ5LmluY2x1ZGU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuZXhjbHVkZUtleXMpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5leGNsdWRlS2V5cyA9IGpzb25RdWVyeS5leGNsdWRlS2V5cztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5leHBsYWluKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuZXhwbGFpbiA9IGpzb25RdWVyeS5leHBsYWluO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmtleXMpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5rZXlzID0ganNvblF1ZXJ5LmtleXM7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkub3JkZXIpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5vcmRlciA9IGpzb25RdWVyeS5vcmRlcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5oaW50KSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuaGludCA9IGpzb25RdWVyeS5oaW50O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSxcbiAgICAgICAgZXJyID0+IHtcbiAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICApXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRXJyb3IobWVzc2FnZSwgZGVmYXVsdE9wdHMpIHtcbiAgaWYgKCFkZWZhdWx0T3B0cykge1xuICAgIGRlZmF1bHRPcHRzID0ge307XG4gIH1cbiAgaWYgKCFtZXNzYWdlKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgIGRlZmF1bHRPcHRzLm1lc3NhZ2UgfHwgJ1NjcmlwdCBmYWlsZWQuJ1xuICAgICk7XG4gIH1cbiAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgIHJldHVybiBtZXNzYWdlO1xuICB9XG5cbiAgY29uc3QgY29kZSA9IGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRDtcbiAgLy8gSWYgaXQncyBhbiBlcnJvciwgbWFyayBpdCBhcyBhIHNjcmlwdCBmYWlsZWRcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gIH1cbiAgY29uc3QgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZS5tZXNzYWdlIHx8IG1lc3NhZ2UpO1xuICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgZXJyb3Iuc3RhY2sgPSBtZXNzYWdlLnN0YWNrO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBmdW5jdGlvbk5hbWUsIGF1dGgpIHtcbiAgY29uc3QgdGhlVmFsaWRhdG9yID0gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdGhlVmFsaWRhdG9yKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0JyAmJiB0aGVWYWxpZGF0b3Iuc2tpcFdpdGhNYXN0ZXJLZXkgJiYgcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICByZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5ID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCdcbiAgICAgICAgICA/IGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKHRoZVZhbGlkYXRvciwgcmVxdWVzdCwgYXV0aClcbiAgICAgICAgICA6IHRoZVZhbGlkYXRvcihyZXF1ZXN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6ICdWYWxpZGF0aW9uIGZhaWxlZC4nLFxuICAgICAgICB9KTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKG9wdGlvbnMsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKHJlcXVlc3QubWFzdGVyICYmICFvcHRpb25zLnZhbGlkYXRlTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZXFVc2VyID0gcmVxdWVzdC51c2VyO1xuICBpZiAoXG4gICAgIXJlcVVzZXIgJiZcbiAgICByZXF1ZXN0Lm9iamVjdCAmJlxuICAgIHJlcXVlc3Qub2JqZWN0LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICFyZXF1ZXN0Lm9iamVjdC5leGlzdGVkKClcbiAgKSB7XG4gICAgcmVxVXNlciA9IHJlcXVlc3Qub2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICAob3B0aW9ucy5yZXF1aXJlVXNlciB8fCBvcHRpb25zLnJlcXVpcmVBbnlVc2VyUm9sZXMgfHwgb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzKSAmJlxuICAgICFyZXFVc2VyXG4gICkge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIGxvZ2luIHRvIGNvbnRpbnVlLic7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmVxdWlyZU1hc3RlciAmJiAhcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIE1hc3RlciBrZXkgaXMgcmVxdWlyZWQgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0Lic7XG4gIH1cbiAgbGV0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zIHx8IHt9O1xuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICBwYXJhbXMgPSByZXF1ZXN0Lm9iamVjdC50b0pTT04oKTtcbiAgfVxuICBjb25zdCByZXF1aXJlZFBhcmFtID0ga2V5ID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtc1trZXldO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzcGVjaWZ5IGRhdGEgZm9yICR7a2V5fS5gO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2YWxpZGF0ZU9wdGlvbnMgPSBhc3luYyAob3B0LCBrZXksIHZhbCkgPT4ge1xuICAgIGxldCBvcHRzID0gb3B0Lm9wdGlvbnM7XG4gICAgaWYgKHR5cGVvZiBvcHRzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcHRzKHZhbCk7XG4gICAgICAgIGlmICghcmVzdWx0ICYmIHJlc3VsdCAhPSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFlKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgZS5tZXNzYWdlIHx8IGU7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShvcHRzKSkge1xuICAgICAgb3B0cyA9IFtvcHQub3B0aW9uc107XG4gICAgfVxuXG4gICAgaWYgKCFvcHRzLmluY2x1ZGVzKHZhbCkpIHtcbiAgICAgIHRocm93IChcbiAgICAgICAgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCBvcHRpb24gZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7b3B0cy5qb2luKCcsICcpfWBcbiAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdldFR5cGUgPSBmbiA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSBmbiAmJiBmbi50b1N0cmluZygpLm1hdGNoKC9eXFxzKmZ1bmN0aW9uIChcXHcrKS8pO1xuICAgIHJldHVybiAobWF0Y2ggPyBtYXRjaFsxXSA6ICcnKS50b0xvd2VyQ2FzZSgpO1xuICB9O1xuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpZWxkcykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBvcHRpb25Qcm9taXNlcyA9IFtdO1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLmZpZWxkc1trZXldO1xuICAgICAgbGV0IHZhbCA9IHBhcmFtc1trZXldO1xuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmVkUGFyYW0ob3B0KTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCAmJiB2YWwgPT0gbnVsbCkge1xuICAgICAgICAgIHZhbCA9IG9wdC5kZWZhdWx0O1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgdmFsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5jb25zdGFudCAmJiByZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9yaWdpbmFsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5yZXZlcnQoa2V5KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIG9wdC5kZWZhdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5yZXF1aXJlZCkge1xuICAgICAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcHRpb25hbCA9ICFvcHQucmVxdWlyZWQgJiYgdmFsID09PSB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghb3B0aW9uYWwpIHtcbiAgICAgICAgICBpZiAob3B0LnR5cGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBnZXRUeXBlKG9wdC50eXBlKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbFR5cGUgPSBBcnJheS5pc0FycmF5KHZhbCkgPyAnYXJyYXknIDogdHlwZW9mIHZhbDtcbiAgICAgICAgICAgIGlmICh2YWxUeXBlICE9PSB0eXBlKSB7XG4gICAgICAgICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB0eXBlIGZvciAke2tleX0uIEV4cGVjdGVkOiAke3R5cGV9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgICAgICBvcHRpb25Qcm9taXNlcy5wdXNoKHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgdmFsKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKG9wdGlvblByb21pc2VzKTtcbiAgfVxuICBsZXQgdXNlclJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQW55VXNlclJvbGVzO1xuICBsZXQgcmVxdWlyZUFsbFJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzO1xuICBjb25zdCBwcm9taXNlcyA9IFtQcm9taXNlLnJlc29sdmUoKSwgUHJvbWlzZS5yZXNvbHZlKCksIFByb21pc2UucmVzb2x2ZSgpXTtcbiAgaWYgKHVzZXJSb2xlcyB8fCByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBwcm9taXNlc1swXSA9IGF1dGguZ2V0VXNlclJvbGVzKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB1c2VyUm9sZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBwcm9taXNlc1sxXSA9IHVzZXJSb2xlcygpO1xuICB9XG4gIGlmICh0eXBlb2YgcmVxdWlyZUFsbFJvbGVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcHJvbWlzZXNbMl0gPSByZXF1aXJlQWxsUm9sZXMoKTtcbiAgfVxuICBjb25zdCBbcm9sZXMsIHJlc29sdmVkVXNlclJvbGVzLCByZXNvbHZlZFJlcXVpcmVBbGxdID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICBpZiAocmVzb2x2ZWRVc2VyUm9sZXMgJiYgQXJyYXkuaXNBcnJheShyZXNvbHZlZFVzZXJSb2xlcykpIHtcbiAgICB1c2VyUm9sZXMgPSByZXNvbHZlZFVzZXJSb2xlcztcbiAgfVxuICBpZiAocmVzb2x2ZWRSZXF1aXJlQWxsICYmIEFycmF5LmlzQXJyYXkocmVzb2x2ZWRSZXF1aXJlQWxsKSkge1xuICAgIHJlcXVpcmVBbGxSb2xlcyA9IHJlc29sdmVkUmVxdWlyZUFsbDtcbiAgfVxuICBpZiAodXNlclJvbGVzKSB7XG4gICAgY29uc3QgaGFzUm9sZSA9IHVzZXJSb2xlcy5zb21lKHJlcXVpcmVkUm9sZSA9PiByb2xlcy5pbmNsdWRlcyhgcm9sZToke3JlcXVpcmVkUm9sZX1gKSk7XG4gICAgaWYgKCFoYXNSb2xlKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFVzZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJlcXVpcmVkIHJvbGVzLmA7XG4gICAgfVxuICB9XG4gIGlmIChyZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlcXVpcmVkUm9sZSBvZiByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICAgIGlmICghcm9sZXMuaW5jbHVkZXMoYHJvbGU6JHtyZXF1aXJlZFJvbGV9YCkpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBVc2VyIGRvZXMgbm90IG1hdGNoIGFsbCB0aGUgcmVxdWlyZWQgcm9sZXMuYDtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3QgdXNlcktleXMgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cyB8fCBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodXNlcktleXMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdXNlcktleXMpIHtcbiAgICAgIGlmICghcmVxVXNlcikge1xuICAgICAgICB0aHJvdyAnUGxlYXNlIGxvZ2luIHRvIG1ha2UgdGhpcyByZXF1ZXN0Lic7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXFVc2VyLmdldChrZXkpID09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc2V0IGRhdGEgZm9yICR7a2V5fSBvbiB5b3VyIGFjY291bnQuYDtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIHVzZXJLZXlzID09PSAnb2JqZWN0Jykge1xuICAgIGNvbnN0IG9wdGlvblByb21pc2VzID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMpIHtcbiAgICAgIGNvbnN0IG9wdCA9IG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzW2tleV07XG4gICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgb3B0aW9uUHJvbWlzZXMucHVzaCh2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHJlcVVzZXIuZ2V0KGtleSkpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwob3B0aW9uUHJvbWlzZXMpO1xuICB9XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIocGFyc2VPYmplY3QuY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB2YXIgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QoXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGF1dGgsXG4gICAgICBwYXJzZU9iamVjdCxcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICBjb25maWcsXG4gICAgICBjb250ZXh0XG4gICAgKTtcbiAgICB2YXIgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgb2JqZWN0ID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgYXV0aFxuICAgICAgICApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZVxuICAgICAgICApIHtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3QuY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShvYmplY3QpO1xuICAgICAgfSxcbiAgICAgIGVycm9yID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgYXV0aCxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBBZnRlclNhdmUgYW5kIGFmdGVyRGVsZXRlIHRyaWdnZXJzIGNhbiByZXR1cm4gYSBwcm9taXNlLCB3aGljaCBpZiB0aGV5XG4gICAgLy8gZG8sIG5lZWRzIHRvIGJlIHJlc29sdmVkIGJlZm9yZSB0aGlzIHByb21pc2UgaXMgcmVzb2x2ZWQsXG4gICAgLy8gc28gdHJpZ2dlciBleGVjdXRpb24gaXMgc3luY2VkIHdpdGggUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIC8vIElmIHRyaWdnZXJzIGRvIG5vdCByZXR1cm4gYSBwcm9taXNlLCB0aGV5IGNhbiBydW4gYXN5bmMgY29kZSBwYXJhbGxlbFxuICAgIC8vIHRvIHRoZSBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtwYXJzZU9iamVjdC5jbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwcm9taXNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dpblxuICAgICAgICApIHtcbiAgICAgICAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBwYXJzZU9iamVjdC5jbGFzc05hbWUsIHBhcnNlT2JqZWN0LnRvSlNPTigpLCBhdXRoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKGRhdGEsIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkKSB7XG4gIGlmICghX3RyaWdnZXJTdG9yZSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZykge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIC4uLmZpbGVPYmplY3QsXG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuRmlsZVRyaWdnZXIodHJpZ2dlclR5cGUsIGZpbGVPYmplY3QsIGNvbmZpZywgYXV0aCkge1xuICBjb25zdCBGaWxlQ2xhc3NOYW1lID0gZ2V0Q2xhc3NOYW1lKFBhcnNlLkZpbGUpO1xuICBjb25zdCBmaWxlVHJpZ2dlciA9IGdldFRyaWdnZXIoRmlsZUNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKHR5cGVvZiBmaWxlVHJpZ2dlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZyk7XG4gICAgICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtGaWxlQ2xhc3NOYW1lfWAsIGF1dGgpO1xuICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIGZpbGVPYmplY3Q7XG4gICAgICB9XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmaWxlVHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgYXV0aFxuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgfHwgZmlsZU9iamVjdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5GaWxlJyxcbiAgICAgICAgeyAuLi5maWxlT2JqZWN0LmZpbGUudG9KU09OKCksIGZpbGVTaXplOiBmaWxlT2JqZWN0LmZpbGVTaXplIH0sXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGVycm9yXG4gICAgICApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIHJldHVybiBmaWxlT2JqZWN0O1xufVxuXG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZSh0eXBlLCBjbGFzc05hbWUsIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKSkge1xuICBjb25zdCBwYXJlbnQgPSBBV1NYUmF5LmdldFNlZ21lbnQoKTtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIEFXU1hSYXkuY2FwdHVyZUFzeW5jRnVuYyhcbiAgICAgIGBQYXJzZS1TZXJ2ZXJfdHJpZ2dlcnNfJHt0eXBlfV8ke2NsYXNzTmFtZX1gLFxuICAgICAgc3Vic2VnbWVudCA9PiB7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDb250cm9sbGVyJywgJ3RyaWdnZXJzJyk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdUeXBlJywgdHlwZSk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgICAocHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UgPyBwcm9taXNlIDogUHJvbWlzZS5yZXNvbHZlKHByb21pc2UpKS50aGVuKFxuICAgICAgICAgIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuIl19