"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addTrigger = addTrigger;
exports.addFileTrigger = addFileTrigger;
exports.addConnectTrigger = addConnectTrigger;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports._unregisterAll = _unregisterAll;
exports.getTrigger = getTrigger;
exports.getFileTrigger = getFileTrigger;
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
exports.maybeRunConnectTrigger = maybeRunConnectTrigger;
exports.maybeRunSubscribeTrigger = maybeRunSubscribeTrigger;
exports.maybeRunAfterEventTrigger = maybeRunAfterEventTrigger;
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
  beforeSaveFile: 'beforeSaveFile',
  afterSaveFile: 'afterSaveFile',
  beforeDeleteFile: 'beforeDeleteFile',
  afterDeleteFile: 'afterDeleteFile',
  beforeConnect: 'beforeConnect',
  beforeSubscribe: 'beforeSubscribe',
  afterEvent: 'afterEvent'
};
exports.Types = Types;
const FileClassName = '@File';
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

function addFileTrigger(type, handler, applicationId, validationHandler) {
  add(Category.Triggers, `${type}.${FileClassName}`, handler, applicationId);
  add(Category.Validators, `${type}.${FileClassName}`, validationHandler, applicationId);
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

function getTrigger(className, triggerType, applicationId) {
  if (!applicationId) {
    throw 'Missing ApplicationID';
  }

  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}

function getFileTrigger(type, applicationId) {
  return getTrigger(FileClassName, type, applicationId);
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

  if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
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
          return object.toJSON();
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
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerErrorBeforeHook(triggerType, className, input, auth, error) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.error(`${triggerType} failed for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}

function maybeRunAfterFindTrigger(triggerType, auth, className, objects, config, query) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(className, triggerType, config.applicationId);

    if (!trigger) {
      return resolve();
    }

    const request = getRequestObject(triggerType, auth, null, null, config);

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
      return maybeRunValidator(request, `${triggerType}.${className}`);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return request.objects;
      }

      const response = trigger(request);

      if (response && typeof response.then === 'function') {
        return response.then(results => {
          if (!results) {
            throw new _node.default.Error(_node.default.Error.SCRIPT_FAILED, 'AfterFind expect results to be returned in the promise');
          }

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
    return maybeRunValidator(requestObject, `${triggerType}.${className}`);
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

function maybeRunValidator(request, functionName) {
  const theValidator = getValidator(functionName, _node.default.applicationId);

  if (!theValidator) {
    return;
  }

  if (typeof theValidator === 'object' && theValidator.skipWithMasterKey && request.master) {
    request.skipWithMasterKey = true;
  }

  return new Promise((resolve, reject) => {
    return Promise.resolve().then(() => {
      return typeof theValidator === 'object' ? builtInTriggerValidator(theValidator, request) : theValidator(request);
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

function builtInTriggerValidator(options, request) {
  if (request.master && !options.validateMasterKey) {
    return;
  }

  let reqUser = request.user;

  if (!reqUser && request.object && request.object.className === '_User' && !request.object.existed()) {
    reqUser = request.object;
  }

  if (options.requireUser && !reqUser) {
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

  const validateOptions = (opt, key, val) => {
    let opts = opt.options;

    if (typeof opts === 'function') {
      try {
        const result = opts(val);

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
            request.object.set(key, request.original.get(key));
          } else if (opt.default != null) {
            request.object.set(key, opt.default);
          }
        }

        if (opt.required) {
          requiredParam(key);
        }

        if (opt.type) {
          const type = getType(opt.type);

          if (type == 'array' && !Array.isArray(val)) {
            throw `Validation failed. Invalid type for ${key}. Expected: array`;
          } else if (typeof val !== type) {
            throw `Validation failed. Invalid type for ${key}. Expected: ${type}`;
          }
        }

        if (opt.options) {
          validateOptions(opt, key, val);
        }
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
    for (const key in options.requireUserKeys) {
      const opt = options.requireUserKeys[key];

      if (opt.options) {
        validateOptions(opt, key, reqUser.get(key));
      }
    }
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
      return maybeRunValidator(request, `${triggerType}.${parseObject.className}`);
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
  const fileTrigger = getFileTrigger(triggerType, config.applicationId);

  if (typeof fileTrigger === 'function') {
    try {
      const request = getRequestFileObject(triggerType, auth, fileObject, config);
      await maybeRunValidator(request, `${triggerType}.${FileClassName}`);

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

async function maybeRunConnectTrigger(triggerType, request) {
  const trigger = getTrigger(ConnectClassName, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${ConnectClassName}`);

  if (request.skipWithMasterKey) {
    return;
  }

  return trigger(request);
}

async function maybeRunSubscribeTrigger(triggerType, className, request) {
  const trigger = getTrigger(className, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  const parseQuery = new _node.default.Query(className);
  parseQuery.withJSON(request.query);
  request.query = parseQuery;
  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${className}`);

  if (request.skipWithMasterKey) {
    return;
  }

  await trigger(request);
  const query = request.query.toJSON();

  if (query.keys) {
    query.fields = query.keys.split(',');
  }

  request.query = query;
}

async function maybeRunAfterEventTrigger(triggerType, className, request) {
  const trigger = getTrigger(className, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  if (request.object) {
    request.object = _node.default.Object.fromJSON(request.object);
  }

  if (request.original) {
    request.original = _node.default.Object.fromJSON(request.original);
  }

  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${className}`);

  if (request.skipWithMasterKey) {
    return;
  }

  return trigger(request);
}

async function userForSessionToken(sessionToken) {
  if (!sessionToken) {
    return;
  }

  const q = new _node.default.Query('_Session');
  q.equalTo('sessionToken', sessionToken);
  q.include('user');
  const session = await q.first({
    useMasterKey: true
  });

  if (!session) {
    return;
  }

  return session.get('user');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJBV1NYUmF5IiwicmVxdWlyZSIsIlR5cGVzIiwiYmVmb3JlTG9naW4iLCJhZnRlckxvZ2luIiwiYWZ0ZXJMb2dvdXQiLCJiZWZvcmVTYXZlIiwiYWZ0ZXJTYXZlIiwiYmVmb3JlRGVsZXRlIiwiYWZ0ZXJEZWxldGUiLCJiZWZvcmVGaW5kIiwiYWZ0ZXJGaW5kIiwiYmVmb3JlU2F2ZUZpbGUiLCJhZnRlclNhdmVGaWxlIiwiYmVmb3JlRGVsZXRlRmlsZSIsImFmdGVyRGVsZXRlRmlsZSIsImJlZm9yZUNvbm5lY3QiLCJiZWZvcmVTdWJzY3JpYmUiLCJhZnRlckV2ZW50IiwiRmlsZUNsYXNzTmFtZSIsIkNvbm5lY3RDbGFzc05hbWUiLCJiYXNlU3RvcmUiLCJWYWxpZGF0b3JzIiwiT2JqZWN0Iiwia2V5cyIsInJlZHVjZSIsImJhc2UiLCJrZXkiLCJGdW5jdGlvbnMiLCJKb2JzIiwiTGl2ZVF1ZXJ5IiwiVHJpZ2dlcnMiLCJmcmVlemUiLCJ2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzIiwiY2xhc3NOYW1lIiwidHlwZSIsIl90cmlnZ2VyU3RvcmUiLCJDYXRlZ29yeSIsImdldFN0b3JlIiwiY2F0ZWdvcnkiLCJuYW1lIiwiYXBwbGljYXRpb25JZCIsInBhdGgiLCJzcGxpdCIsInNwbGljZSIsIlBhcnNlIiwic3RvcmUiLCJjb21wb25lbnQiLCJ1bmRlZmluZWQiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRGaWxlVHJpZ2dlciIsImFkZENvbm5lY3RUcmlnZ2VyIiwiYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyIiwicHVzaCIsInJlbW92ZUZ1bmN0aW9uIiwicmVtb3ZlVHJpZ2dlciIsIl91bnJlZ2lzdGVyQWxsIiwiZm9yRWFjaCIsImFwcElkIiwiZ2V0VHJpZ2dlciIsInRyaWdnZXJUeXBlIiwiZ2V0RmlsZVRyaWdnZXIiLCJ0cmlnZ2VyRXhpc3RzIiwiZ2V0RnVuY3Rpb24iLCJnZXRGdW5jdGlvbk5hbWVzIiwiZnVuY3Rpb25OYW1lcyIsImV4dHJhY3RGdW5jdGlvbk5hbWVzIiwibmFtZXNwYWNlIiwidmFsdWUiLCJnZXRKb2IiLCJnZXRKb2JzIiwibWFuYWdlciIsImdldFZhbGlkYXRvciIsImdldFJlcXVlc3RPYmplY3QiLCJhdXRoIiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsInJlcXVlc3QiLCJ0cmlnZ2VyTmFtZSIsIm9iamVjdCIsIm1hc3RlciIsImxvZyIsImxvZ2dlckNvbnRyb2xsZXIiLCJoZWFkZXJzIiwiaXAiLCJvcmlnaW5hbCIsImFzc2lnbiIsImlzTWFzdGVyIiwidXNlciIsImluc3RhbGxhdGlvbklkIiwiZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0IiwicXVlcnkiLCJjb3VudCIsImlzR2V0IiwiZ2V0UmVzcG9uc2VPYmplY3QiLCJyZXNvbHZlIiwicmVqZWN0Iiwic3VjY2VzcyIsInJlc3BvbnNlIiwib2JqZWN0cyIsIm1hcCIsInRvSlNPTiIsImVxdWFscyIsIl9nZXRTYXZlSlNPTiIsImVycm9yIiwiZSIsInJlc29sdmVFcnJvciIsImNvZGUiLCJFcnJvciIsIlNDUklQVF9GQUlMRUQiLCJtZXNzYWdlIiwidXNlcklkRm9yTG9nIiwiaWQiLCJsb2dUcmlnZ2VyQWZ0ZXJIb29rIiwiaW5wdXQiLCJjbGVhbklucHV0IiwidHJ1bmNhdGVMb2dNZXNzYWdlIiwiSlNPTiIsInN0cmluZ2lmeSIsImluZm8iLCJsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2siLCJyZXN1bHQiLCJjbGVhblJlc3VsdCIsImxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2siLCJtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIiLCJQcm9taXNlIiwidHJpZ2dlciIsImZyb21KU09OIiwidGhlbiIsIm1heWJlUnVuVmFsaWRhdG9yIiwic2tpcFdpdGhNYXN0ZXJLZXkiLCJyZXN1bHRzIiwibWF5YmVSdW5RdWVyeVRyaWdnZXIiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImpzb24iLCJ3aGVyZSIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIndpdGhKU09OIiwicmVxdWVzdE9iamVjdCIsInRyYWNlUHJvbWlzZSIsInF1ZXJ5UmVzdWx0IiwianNvblF1ZXJ5IiwibGltaXQiLCJza2lwIiwiaW5jbHVkZSIsImV4Y2x1ZGVLZXlzIiwiZXhwbGFpbiIsIm9yZGVyIiwiaGludCIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImVyciIsImRlZmF1bHRPcHRzIiwic3RhY2siLCJ0aGVWYWxpZGF0b3IiLCJidWlsdEluVHJpZ2dlclZhbGlkYXRvciIsImNhdGNoIiwiVkFMSURBVElPTl9FUlJPUiIsIm9wdGlvbnMiLCJ2YWxpZGF0ZU1hc3RlcktleSIsInJlcVVzZXIiLCJleGlzdGVkIiwicmVxdWlyZVVzZXIiLCJyZXF1aXJlTWFzdGVyIiwicGFyYW1zIiwicmVxdWlyZWRQYXJhbSIsInZhbGlkYXRlT3B0aW9ucyIsIm9wdCIsInZhbCIsIm9wdHMiLCJBcnJheSIsImlzQXJyYXkiLCJpbmNsdWRlcyIsImpvaW4iLCJnZXRUeXBlIiwiZm4iLCJtYXRjaCIsInRvU3RyaW5nIiwidG9Mb3dlckNhc2UiLCJmaWVsZHMiLCJkZWZhdWx0Iiwic2V0IiwiY29uc3RhbnQiLCJyZXF1aXJlZCIsInVzZXJLZXlzIiwicmVxdWlyZVVzZXJLZXlzIiwibWF5YmVSdW5UcmlnZ2VyIiwicHJvbWlzZSIsImluZmxhdGUiLCJkYXRhIiwicmVzdE9iamVjdCIsImNvcHkiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZ2V0UmVxdWVzdEZpbGVPYmplY3QiLCJmaWxlT2JqZWN0IiwibWF5YmVSdW5GaWxlVHJpZ2dlciIsImZpbGVUcmlnZ2VyIiwiZmlsZSIsImZpbGVTaXplIiwibWF5YmVSdW5Db25uZWN0VHJpZ2dlciIsInVzZXJGb3JTZXNzaW9uVG9rZW4iLCJzZXNzaW9uVG9rZW4iLCJtYXliZVJ1blN1YnNjcmliZVRyaWdnZXIiLCJtYXliZVJ1bkFmdGVyRXZlbnRUcmlnZ2VyIiwicSIsImVxdWFsVG8iLCJzZXNzaW9uIiwiZmlyc3QiLCJ1c2VNYXN0ZXJLZXkiLCJwYXJlbnQiLCJnZXRTZWdtZW50IiwiY2FwdHVyZUFzeW5jRnVuYyIsInN1YnNlZ21lbnQiLCJhZGRBbm5vdGF0aW9uIiwiY2xvc2UiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUdBOztBQUNBOzs7Ozs7Ozs7O0FBSkE7QUFDQSxNQUFNQSxPQUFPLEdBQUdDLE9BQU8sQ0FBQyxnQkFBRCxDQUF2Qjs7QUFLTyxNQUFNQyxLQUFLLEdBQUc7QUFDbkJDLEVBQUFBLFdBQVcsRUFBRSxhQURNO0FBRW5CQyxFQUFBQSxVQUFVLEVBQUUsWUFGTztBQUduQkMsRUFBQUEsV0FBVyxFQUFFLGFBSE07QUFJbkJDLEVBQUFBLFVBQVUsRUFBRSxZQUpPO0FBS25CQyxFQUFBQSxTQUFTLEVBQUUsV0FMUTtBQU1uQkMsRUFBQUEsWUFBWSxFQUFFLGNBTks7QUFPbkJDLEVBQUFBLFdBQVcsRUFBRSxhQVBNO0FBUW5CQyxFQUFBQSxVQUFVLEVBQUUsWUFSTztBQVNuQkMsRUFBQUEsU0FBUyxFQUFFLFdBVFE7QUFVbkJDLEVBQUFBLGNBQWMsRUFBRSxnQkFWRztBQVduQkMsRUFBQUEsYUFBYSxFQUFFLGVBWEk7QUFZbkJDLEVBQUFBLGdCQUFnQixFQUFFLGtCQVpDO0FBYW5CQyxFQUFBQSxlQUFlLEVBQUUsaUJBYkU7QUFjbkJDLEVBQUFBLGFBQWEsRUFBRSxlQWRJO0FBZW5CQyxFQUFBQSxlQUFlLEVBQUUsaUJBZkU7QUFnQm5CQyxFQUFBQSxVQUFVLEVBQUU7QUFoQk8sQ0FBZDs7QUFtQlAs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Q0QsT0FKSCxFQUtFLFVBQVNqSCxLQUFULEVBQWdCO0FBQ2RSLFFBQUFBLE1BQU0sQ0FBQ1EsS0FBRCxDQUFOO0FBQ0ErRyxRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxDQUFpQmpILEtBQWpCLENBQWQ7QUFDRCxPQVJIO0FBVUQsS0FoQkg7QUFrQkQsR0FuQk0sQ0FBUDtBQW9CRCIsInNvdXJjZXNDb250ZW50IjpbIi8vIHRyaWdnZXJzLmpzXG5jb25zdCBBV1NYUmF5ID0gcmVxdWlyZSgnaHVsYWIteHJheS1zZGsnKTtcblxuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi9sb2dnZXInO1xuXG5leHBvcnQgY29uc3QgVHlwZXMgPSB7XG4gIGJlZm9yZUxvZ2luOiAnYmVmb3JlTG9naW4nLFxuICBhZnRlckxvZ2luOiAnYWZ0ZXJMb2dpbicsXG4gIGFmdGVyTG9nb3V0OiAnYWZ0ZXJMb2dvdXQnLFxuICBiZWZvcmVTYXZlOiAnYmVmb3JlU2F2ZScsXG4gIGFmdGVyU2F2ZTogJ2FmdGVyU2F2ZScsXG4gIGJlZm9yZURlbGV0ZTogJ2JlZm9yZURlbGV0ZScsXG4gIGFmdGVyRGVsZXRlOiAnYWZ0ZXJEZWxldGUnLFxuICBiZWZvcmVGaW5kOiAnYmVmb3JlRmluZCcsXG4gIGFmdGVyRmluZDogJ2FmdGVyRmluZCcsXG4gIGJlZm9yZVNhdmVGaWxlOiAnYmVmb3JlU2F2ZUZpbGUnLFxuICBhZnRlclNhdmVGaWxlOiAnYWZ0ZXJTYXZlRmlsZScsXG4gIGJlZm9yZURlbGV0ZUZpbGU6ICdiZWZvcmVEZWxldGVGaWxlJyxcbiAgYWZ0ZXJEZWxldGVGaWxlOiAnYWZ0ZXJEZWxldGVGaWxlJyxcbiAgYmVmb3JlQ29ubmVjdDogJ2JlZm9yZUNvbm5lY3QnLFxuICBiZWZvcmVTdWJzY3JpYmU6ICdiZWZvcmVTdWJzY3JpYmUnLFxuICBhZnRlckV2ZW50OiAnYWZ0ZXJFdmVudCcsXG59O1xuXG5jb25zdCBGaWxlQ2xhc3NOYW1lID0gJ0BGaWxlJztcbmNvbnN0IENvbm5lY3RDbGFzc05hbWUgPSAnQENvbm5lY3QnO1xuXG5jb25zdCBiYXNlU3RvcmUgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IFZhbGlkYXRvcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSB7fTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwge30pO1xuICBjb25zdCBGdW5jdGlvbnMgPSB7fTtcbiAgY29uc3QgSm9icyA9IHt9O1xuICBjb25zdCBMaXZlUXVlcnkgPSBbXTtcbiAgY29uc3QgVHJpZ2dlcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSB7fTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwge30pO1xuXG4gIHJldHVybiBPYmplY3QuZnJlZXplKHtcbiAgICBGdW5jdGlvbnMsXG4gICAgSm9icyxcbiAgICBWYWxpZGF0b3JzLFxuICAgIFRyaWdnZXJzLFxuICAgIExpdmVRdWVyeSxcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB2YWxpZGF0ZUNsYXNzTmFtZUZvclRyaWdnZXJzKGNsYXNzTmFtZSwgdHlwZSkge1xuICBpZiAodHlwZSA9PSBUeXBlcy5iZWZvcmVTYXZlICYmIGNsYXNzTmFtZSA9PT0gJ19QdXNoU3RhdHVzJykge1xuICAgIC8vIF9QdXNoU3RhdHVzIHVzZXMgdW5kb2N1bWVudGVkIG5lc3RlZCBrZXkgaW5jcmVtZW50IG9wc1xuICAgIC8vIGFsbG93aW5nIGJlZm9yZVNhdmUgd291bGQgbWVzcyB1cCB0aGUgb2JqZWN0cyBiaWcgdGltZVxuICAgIC8vIFRPRE86IEFsbG93IHByb3BlciBkb2N1bWVudGVkIHdheSBvZiB1c2luZyBuZXN0ZWQgaW5jcmVtZW50IG9wc1xuICAgIHRocm93ICdPbmx5IGFmdGVyU2F2ZSBpcyBhbGxvd2VkIG9uIF9QdXNoU3RhdHVzJztcbiAgfVxuICBpZiAoKHR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8IHR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4pICYmIGNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1VzZXIgY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGJlZm9yZUxvZ2luIGFuZCBhZnRlckxvZ2luIHRyaWdnZXJzJztcbiAgfVxuICBpZiAodHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dvdXQgJiYgY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBfU2Vzc2lvbiBjbGFzcyBpcyBhbGxvd2VkIGZvciB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlci4nO1xuICB9XG4gIGlmIChjbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgJiYgdHlwZSAhPT0gVHlwZXMuYWZ0ZXJMb2dvdXQpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIGFmdGVyTG9nb3V0IHRyaWdnZXIgaXMgYWxsb3dlZCBmb3IgdGhlIF9TZXNzaW9uIGNsYXNzLic7XG4gIH1cbiAgcmV0dXJuIGNsYXNzTmFtZTtcbn1cblxuY29uc3QgX3RyaWdnZXJTdG9yZSA9IHt9O1xuXG5jb25zdCBDYXRlZ29yeSA9IHtcbiAgRnVuY3Rpb25zOiAnRnVuY3Rpb25zJyxcbiAgVmFsaWRhdG9yczogJ1ZhbGlkYXRvcnMnLFxuICBKb2JzOiAnSm9icycsXG4gIFRyaWdnZXJzOiAnVHJpZ2dlcnMnLFxufTtcblxuZnVuY3Rpb24gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgcGF0aCA9IG5hbWUuc3BsaXQoJy4nKTtcbiAgcGF0aC5zcGxpY2UoLTEpOyAvLyByZW1vdmUgbGFzdCBjb21wb25lbnRcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIGxldCBzdG9yZSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bY2F0ZWdvcnldO1xuICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBwYXRoKSB7XG4gICAgc3RvcmUgPSBzdG9yZVtjb21wb25lbnRdO1xuICAgIGlmICghc3RvcmUpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdG9yZTtcbn1cblxuZnVuY3Rpb24gYWRkKGNhdGVnb3J5LCBuYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGlmIChzdG9yZVtsYXN0Q29tcG9uZW50XSkge1xuICAgIGxvZ2dlci53YXJuKFxuICAgICAgYFdhcm5pbmc6IER1cGxpY2F0ZSBjbG91ZCBmdW5jdGlvbnMgZXhpc3QgZm9yICR7bGFzdENvbXBvbmVudH0uIE9ubHkgdGhlIGxhc3Qgb25lIHdpbGwgYmUgdXNlZCBhbmQgdGhlIG90aGVycyB3aWxsIGJlIGlnbm9yZWQuYFxuICAgICk7XG4gIH1cbiAgc3RvcmVbbGFzdENvbXBvbmVudF0gPSBoYW5kbGVyO1xufVxuXG5mdW5jdGlvbiByZW1vdmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgZGVsZXRlIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5mdW5jdGlvbiBnZXQoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgcmV0dXJuIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRKb2Ioam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRmlsZVRyaWdnZXIodHlwZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke0ZpbGVDbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBgJHt0eXBlfS4ke0ZpbGVDbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkQ29ubmVjdFRyaWdnZXIodHlwZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LnB1c2goaGFuZGxlcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfdW5yZWdpc3RlckFsbCgpIHtcbiAgT2JqZWN0LmtleXMoX3RyaWdnZXJTdG9yZSkuZm9yRWFjaChhcHBJZCA9PiBkZWxldGUgX3RyaWdnZXJTdG9yZVthcHBJZF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIGlmICghYXBwbGljYXRpb25JZCkge1xuICAgIHRocm93ICdNaXNzaW5nIEFwcGxpY2F0aW9uSUQnO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEZpbGVUcmlnZ2VyKHR5cGUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoRmlsZUNsYXNzTmFtZSwgdHlwZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0cmlnZ2VyRXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nLCB0eXBlOiBzdHJpbmcsIGFwcGxpY2F0aW9uSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHR5cGUsIGFwcGxpY2F0aW9uSWQpICE9IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZXR1cm4gZ2V0KENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEZ1bmN0aW9uTmFtZXMoYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBzdG9yZSA9XG4gICAgKF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gJiYgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXVtDYXRlZ29yeS5GdW5jdGlvbnNdKSB8fCB7fTtcbiAgY29uc3QgZnVuY3Rpb25OYW1lcyA9IFtdO1xuICBjb25zdCBleHRyYWN0RnVuY3Rpb25OYW1lcyA9IChuYW1lc3BhY2UsIHN0b3JlKSA9PiB7XG4gICAgT2JqZWN0LmtleXMoc3RvcmUpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHN0b3JlW25hbWVdO1xuICAgICAgaWYgKG5hbWVzcGFjZSkge1xuICAgICAgICBuYW1lID0gYCR7bmFtZXNwYWNlfS4ke25hbWV9YDtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lcy5wdXNoKG5hbWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobmFtZSwgdmFsdWUpO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuICBleHRyYWN0RnVuY3Rpb25OYW1lcyhudWxsLCBzdG9yZSk7XG4gIHJldHVybiBmdW5jdGlvbk5hbWVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Sm9iKGpvYk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5Kb2JzLCBqb2JOYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYnMoYXBwbGljYXRpb25JZCkge1xuICB2YXIgbWFuYWdlciA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF07XG4gIGlmIChtYW5hZ2VyICYmIG1hbmFnZXIuSm9icykge1xuICAgIHJldHVybiBtYW5hZ2VyLkpvYnM7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFZhbGlkYXRvcihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5WYWxpZGF0b3JzLCBmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdE9iamVjdChcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBvYmplY3Q6IHBhcnNlT2JqZWN0LFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICB9O1xuXG4gIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgcmVxdWVzdC5vcmlnaW5hbCA9IG9yaWdpbmFsUGFyc2VPYmplY3Q7XG4gIH1cblxuICBpZiAoXG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZVxuICApIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKHt9LCBjb250ZXh0KTtcbiAgfVxuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RRdWVyeU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgcXVlcnksIGNvdW50LCBjb25maWcsIGNvbnRleHQsIGlzR2V0KSB7XG4gIGlzR2V0ID0gISFpc0dldDtcblxuICB2YXIgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgcXVlcnksXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBjb3VudCxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGlzR2V0LFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29udGV4dDogY29udGV4dCB8fCB7fSxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbi8vIENyZWF0ZXMgdGhlIHJlc3BvbnNlIG9iamVjdCwgYW5kIHVzZXMgdGhlIHJlcXVlc3Qgb2JqZWN0IHRvIHBhc3MgZGF0YVxuLy8gVGhlIEFQSSB3aWxsIGNhbGwgdGhpcyB3aXRoIFJFU1QgQVBJIGZvcm1hdHRlZCBvYmplY3RzLCB0aGlzIHdpbGxcbi8vIHRyYW5zZm9ybSB0aGVtIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZXhwZWN0ZWQgYnkgQ2xvdWQgQ29kZS5cbi8vIEFueSBjaGFuZ2VzIG1hZGUgdG8gdGhlIG9iamVjdCBpbiBhIGJlZm9yZVNhdmUgd2lsbCBiZSBpbmNsdWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXNwb25zZU9iamVjdChyZXF1ZXN0LCByZXNvbHZlLCByZWplY3QpIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmdW5jdGlvbiAocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlID0gcmVzcG9uc2UubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdC50b0pTT04oKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIC8vIFVzZSB0aGUgSlNPTiByZXNwb25zZVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFyZXF1ZXN0Lm9iamVjdC5lcXVhbHMocmVzcG9uc2UpICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJiByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgY29uc3QgZSA9IHJlc29sdmVFcnJvcihlcnJvciwge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgfSk7XG4gICAgICByZWplY3QoZSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXNlcklkRm9yTG9nKGF1dGgpIHtcbiAgcmV0dXJuIGF1dGggJiYgYXV0aC51c2VyID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlci5pbmZvKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgcmVzdWx0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGNvbnN0IGNsZWFuUmVzdWx0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTtcbiAgbG9nZ2VyLmluZm8oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1cXG4gIFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyLmVycm9yKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9XFxuICBFcnJvcjogJHtKU09OLnN0cmluZ2lmeShlcnJvcil9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGVycm9yLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcih0cmlnZ2VyVHlwZSwgYXV0aCwgY2xhc3NOYW1lLCBvYmplY3RzLCBjb25maWcsIHF1ZXJ5KSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikge1xuICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZyk7XG4gICAgaWYgKHF1ZXJ5KSB7XG4gICAgICByZXF1ZXN0LnF1ZXJ5ID0gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgJ0FmdGVyRmluZCcsIEpTT04uc3RyaW5naWZ5KG9iamVjdHMpLCBhdXRoKTtcbiAgICByZXF1ZXN0Lm9iamVjdHMgPSBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgLy9zZXR0aW5nIHRoZSBjbGFzcyBuYW1lIHRvIHRyYW5zZm9ybSBpbnRvIHBhcnNlIG9iamVjdFxuICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04ob2JqZWN0KTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lfWApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIHJlcXVlc3Qub2JqZWN0cztcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGlmIChyZXNwb25zZSAmJiB0eXBlb2YgcmVzcG9uc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICByZXR1cm4gcmVzcG9uc2UudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAoIXJlc3VsdHMpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgICAgICAgJ0FmdGVyRmluZCBleHBlY3QgcmVzdWx0cyB0byBiZSByZXR1cm5lZCBpbiB0aGUgcHJvbWlzZSdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICB9KVxuICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIEpTT04uc3RyaW5naWZ5KHJlc3VsdHMpLCBhdXRoKTtcbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlLFxuICByZXN0T3B0aW9ucyxcbiAgY29uZmlnLFxuICBhdXRoLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBqc29uID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdE9wdGlvbnMpO1xuICBqc29uLndoZXJlID0gcmVzdFdoZXJlO1xuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgcGFyc2VRdWVyeS53aXRoSlNPTihqc29uKTtcblxuICBsZXQgY291bnQgPSBmYWxzZTtcbiAgaWYgKHJlc3RPcHRpb25zKSB7XG4gICAgY291bnQgPSAhIXJlc3RPcHRpb25zLmNvdW50O1xuICB9XG4gIGNvbnN0IHJlcXVlc3RPYmplY3QgPSBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgYXV0aCxcbiAgICBwYXJzZVF1ZXJ5LFxuICAgIGNvdW50LFxuICAgIGNvbmZpZyxcbiAgICBjb250ZXh0LFxuICAgIGlzR2V0XG4gICk7XG5cbiAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBjbGFzc05hbWUsXG4gICAgUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3RPYmplY3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIHJlcXVlc3RPYmplY3QucXVlcnk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdE9iamVjdCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oXG4gICAgICAgIHJlc3VsdCA9PiB7XG4gICAgICAgICAgbGV0IHF1ZXJ5UmVzdWx0ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgICBpZiAocmVzdWx0ICYmIHJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgICAgICAgICBxdWVyeVJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QganNvblF1ZXJ5ID0gcXVlcnlSZXN1bHQudG9KU09OKCk7XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS53aGVyZSkge1xuICAgICAgICAgICAgcmVzdFdoZXJlID0ganNvblF1ZXJ5LndoZXJlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmxpbWl0KSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMubGltaXQgPSBqc29uUXVlcnkubGltaXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuc2tpcCkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLnNraXAgPSBqc29uUXVlcnkuc2tpcDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5pbmNsdWRlKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGpzb25RdWVyeS5pbmNsdWRlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5LmV4Y2x1ZGVLZXlzKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMuZXhjbHVkZUtleXMgPSBqc29uUXVlcnkuZXhjbHVkZUtleXM7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuZXhwbGFpbikge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmV4cGxhaW4gPSBqc29uUXVlcnkuZXhwbGFpbjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGpzb25RdWVyeS5rZXlzKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMua2V5cyA9IGpzb25RdWVyeS5rZXlzO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoanNvblF1ZXJ5Lm9yZGVyKSB7XG4gICAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMub3JkZXIgPSBqc29uUXVlcnkub3JkZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChqc29uUXVlcnkuaGludCkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zLmhpbnQgPSBqc29uUXVlcnkuaGludDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgICByZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSxcbiAgICAgICAgZXJyID0+IHtcbiAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICApXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRXJyb3IobWVzc2FnZSwgZGVmYXVsdE9wdHMpIHtcbiAgaWYgKCFkZWZhdWx0T3B0cykge1xuICAgIGRlZmF1bHRPcHRzID0ge307XG4gIH1cbiAgaWYgKCFtZXNzYWdlKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgIGRlZmF1bHRPcHRzLm1lc3NhZ2UgfHwgJ1NjcmlwdCBmYWlsZWQuJ1xuICAgICk7XG4gIH1cbiAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgIHJldHVybiBtZXNzYWdlO1xuICB9XG5cbiAgY29uc3QgY29kZSA9IGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRDtcbiAgLy8gSWYgaXQncyBhbiBlcnJvciwgbWFyayBpdCBhcyBhIHNjcmlwdCBmYWlsZWRcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gIH1cbiAgY29uc3QgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZS5tZXNzYWdlIHx8IG1lc3NhZ2UpO1xuICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgZXJyb3Iuc3RhY2sgPSBtZXNzYWdlLnN0YWNrO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBmdW5jdGlvbk5hbWUpIHtcbiAgY29uc3QgdGhlVmFsaWRhdG9yID0gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdGhlVmFsaWRhdG9yKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0JyAmJiB0aGVWYWxpZGF0b3Iuc2tpcFdpdGhNYXN0ZXJLZXkgJiYgcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICByZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5ID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCdcbiAgICAgICAgICA/IGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKHRoZVZhbGlkYXRvciwgcmVxdWVzdClcbiAgICAgICAgICA6IHRoZVZhbGlkYXRvcihyZXF1ZXN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6ICdWYWxpZGF0aW9uIGZhaWxlZC4nLFxuICAgICAgICB9KTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cbmZ1bmN0aW9uIGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKG9wdGlvbnMsIHJlcXVlc3QpIHtcbiAgaWYgKHJlcXVlc3QubWFzdGVyICYmICFvcHRpb25zLnZhbGlkYXRlTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZXFVc2VyID0gcmVxdWVzdC51c2VyO1xuICBpZiAoXG4gICAgIXJlcVVzZXIgJiZcbiAgICByZXF1ZXN0Lm9iamVjdCAmJlxuICAgIHJlcXVlc3Qub2JqZWN0LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICFyZXF1ZXN0Lm9iamVjdC5leGlzdGVkKClcbiAgKSB7XG4gICAgcmVxVXNlciA9IHJlcXVlc3Qub2JqZWN0O1xuICB9XG4gIGlmIChvcHRpb25zLnJlcXVpcmVVc2VyICYmICFyZXFVc2VyKSB7XG4gICAgdGhyb3cgJ1ZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2UgbG9naW4gdG8gY29udGludWUuJztcbiAgfVxuICBpZiAob3B0aW9ucy5yZXF1aXJlTWFzdGVyICYmICFyZXF1ZXN0Lm1hc3Rlcikge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gTWFzdGVyIGtleSBpcyByZXF1aXJlZCB0byBjb21wbGV0ZSB0aGlzIHJlcXVlc3QuJztcbiAgfVxuICBsZXQgcGFyYW1zID0gcmVxdWVzdC5wYXJhbXMgfHwge307XG4gIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgIHBhcmFtcyA9IHJlcXVlc3Qub2JqZWN0LnRvSlNPTigpO1xuICB9XG4gIGNvbnN0IHJlcXVpcmVkUGFyYW0gPSBrZXkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gcGFyYW1zW2tleV07XG4gICAgaWYgKHZhbHVlID09IG51bGwpIHtcbiAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIHNwZWNpZnkgZGF0YSBmb3IgJHtrZXl9LmA7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZhbGlkYXRlT3B0aW9ucyA9IChvcHQsIGtleSwgdmFsKSA9PiB7XG4gICAgbGV0IG9wdHMgPSBvcHQub3B0aW9ucztcbiAgICBpZiAodHlwZW9mIG9wdHMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IG9wdHModmFsKTtcbiAgICAgICAgaWYgKCFyZXN1bHQgJiYgcmVzdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHZhbHVlIGZvciAke2tleX0uYDtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoIWUpIHtcbiAgICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHZhbHVlIGZvciAke2tleX0uYDtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG9wdC5lcnJvciB8fCBlLm1lc3NhZ2UgfHwgZTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG9wdHMpKSB7XG4gICAgICBvcHRzID0gW29wdC5vcHRpb25zXTtcbiAgICB9XG5cbiAgICBpZiAoIW9wdHMuaW5jbHVkZXModmFsKSkge1xuICAgICAgdGhyb3cgKFxuICAgICAgICBvcHQuZXJyb3IgfHwgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIG9wdGlvbiBmb3IgJHtrZXl9LiBFeHBlY3RlZDogJHtvcHRzLmpvaW4oJywgJyl9YFxuICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgZ2V0VHlwZSA9IGZuID0+IHtcbiAgICBjb25zdCBtYXRjaCA9IGZuICYmIGZuLnRvU3RyaW5nKCkubWF0Y2goL15cXHMqZnVuY3Rpb24gKFxcdyspLyk7XG4gICAgcmV0dXJuIChtYXRjaCA/IG1hdGNoWzFdIDogJycpLnRvTG93ZXJDYXNlKCk7XG4gIH07XG4gIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuZmllbGRzKSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICByZXF1aXJlZFBhcmFtKGtleSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLmZpZWxkc1trZXldO1xuICAgICAgbGV0IHZhbCA9IHBhcmFtc1trZXldO1xuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmVkUGFyYW0ob3B0KTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCAmJiB2YWwgPT0gbnVsbCkge1xuICAgICAgICAgIHZhbCA9IG9wdC5kZWZhdWx0O1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgdmFsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5jb25zdGFudCAmJiByZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9yaWdpbmFsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5zZXQoa2V5LCByZXF1ZXN0Lm9yaWdpbmFsLmdldChrZXkpKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIG9wdC5kZWZhdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5yZXF1aXJlZCkge1xuICAgICAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0LnR5cGUpIHtcbiAgICAgICAgICBjb25zdCB0eXBlID0gZ2V0VHlwZShvcHQudHlwZSk7XG4gICAgICAgICAgaWYgKHR5cGUgPT0gJ2FycmF5JyAmJiAhQXJyYXkuaXNBcnJheSh2YWwpKSB7XG4gICAgICAgICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIEludmFsaWQgdHlwZSBmb3IgJHtrZXl9LiBFeHBlY3RlZDogYXJyYXlgO1xuICAgICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIHZhbCAhPT0gdHlwZSkge1xuICAgICAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHR5cGUgZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7dHlwZX1gO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgICB2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHZhbCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3QgdXNlcktleXMgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cyB8fCBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodXNlcktleXMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdXNlcktleXMpIHtcbiAgICAgIGlmICghcmVxVXNlcikge1xuICAgICAgICB0aHJvdyAnUGxlYXNlIGxvZ2luIHRvIG1ha2UgdGhpcyByZXF1ZXN0Lic7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXFVc2VyLmdldChrZXkpID09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc2V0IGRhdGEgZm9yICR7a2V5fSBvbiB5b3VyIGFjY291bnQuYDtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIHVzZXJLZXlzID09PSAnb2JqZWN0Jykge1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5c1trZXldO1xuICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgIHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgcmVxVXNlci5nZXQoa2V5KSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIocGFyc2VPYmplY3QuY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB2YXIgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QoXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGF1dGgsXG4gICAgICBwYXJzZU9iamVjdCxcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICBjb25maWcsXG4gICAgICBjb250ZXh0XG4gICAgKTtcbiAgICB2YXIgeyBzdWNjZXNzLCBlcnJvciB9ID0gZ2V0UmVzcG9uc2VPYmplY3QoXG4gICAgICByZXF1ZXN0LFxuICAgICAgb2JqZWN0ID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgYXV0aFxuICAgICAgICApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZURlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZVxuICAgICAgICApIHtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGNvbnRleHQsIHJlcXVlc3QuY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShvYmplY3QpO1xuICAgICAgfSxcbiAgICAgIGVycm9yID0+IHtcbiAgICAgICAgbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgYXV0aCxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBBZnRlclNhdmUgYW5kIGFmdGVyRGVsZXRlIHRyaWdnZXJzIGNhbiByZXR1cm4gYSBwcm9taXNlLCB3aGljaCBpZiB0aGV5XG4gICAgLy8gZG8sIG5lZWRzIHRvIGJlIHJlc29sdmVkIGJlZm9yZSB0aGlzIHByb21pc2UgaXMgcmVzb2x2ZWQsXG4gICAgLy8gc28gdHJpZ2dlciBleGVjdXRpb24gaXMgc3luY2VkIHdpdGggUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIC8vIElmIHRyaWdnZXJzIGRvIG5vdCByZXR1cm4gYSBwcm9taXNlLCB0aGV5IGNhbiBydW4gYXN5bmMgY29kZSBwYXJhbGxlbFxuICAgIC8vIHRvIHRoZSBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtwYXJzZU9iamVjdC5jbGFzc05hbWV9YCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwcm9taXNlID0gdHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dpblxuICAgICAgICApIHtcbiAgICAgICAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBwYXJzZU9iamVjdC5jbGFzc05hbWUsIHBhcnNlT2JqZWN0LnRvSlNPTigpLCBhdXRoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKGRhdGEsIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkKSB7XG4gIGlmICghX3RyaWdnZXJTdG9yZSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZykge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIC4uLmZpbGVPYmplY3QsXG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICB9O1xuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuRmlsZVRyaWdnZXIodHJpZ2dlclR5cGUsIGZpbGVPYmplY3QsIGNvbmZpZywgYXV0aCkge1xuICBjb25zdCBmaWxlVHJpZ2dlciA9IGdldEZpbGVUcmlnZ2VyKHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgZmlsZVRyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpO1xuICAgICAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7RmlsZUNsYXNzTmFtZX1gKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBmaWxlT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmlsZVRyaWdnZXIocmVxdWVzdCk7XG4gICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIGF1dGhcbiAgICAgICk7XG4gICAgICByZXR1cm4gcmVzdWx0IHx8IGZpbGVPYmplY3Q7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICBhdXRoLFxuICAgICAgICBlcnJvclxuICAgICAgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmlsZU9iamVjdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuQ29ubmVjdFRyaWdnZXIodHJpZ2dlclR5cGUsIHJlcXVlc3QpIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoQ29ubmVjdENsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmVxdWVzdC51c2VyID0gYXdhaXQgdXNlckZvclNlc3Npb25Ub2tlbihyZXF1ZXN0LnNlc3Npb25Ub2tlbik7XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCk7XG4gIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0cmlnZ2VyKHJlcXVlc3QpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWF5YmVSdW5TdWJzY3JpYmVUcmlnZ2VyKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIHJlcXVlc3QpIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwYXJzZVF1ZXJ5ID0gbmV3IFBhcnNlLlF1ZXJ5KGNsYXNzTmFtZSk7XG4gIHBhcnNlUXVlcnkud2l0aEpTT04ocmVxdWVzdC5xdWVyeSk7XG4gIHJlcXVlc3QucXVlcnkgPSBwYXJzZVF1ZXJ5O1xuICByZXF1ZXN0LnVzZXIgPSBhd2FpdCB1c2VyRm9yU2Vzc2lvblRva2VuKHJlcXVlc3Quc2Vzc2lvblRva2VuKTtcbiAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7Y2xhc3NOYW1lfWApO1xuICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCB0cmlnZ2VyKHJlcXVlc3QpO1xuICBjb25zdCBxdWVyeSA9IHJlcXVlc3QucXVlcnkudG9KU09OKCk7XG4gIGlmIChxdWVyeS5rZXlzKSB7XG4gICAgcXVlcnkuZmllbGRzID0gcXVlcnkua2V5cy5zcGxpdCgnLCcpO1xuICB9XG4gIHJlcXVlc3QucXVlcnkgPSBxdWVyeTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuQWZ0ZXJFdmVudFRyaWdnZXIodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgcmVxdWVzdCkge1xuICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgIHJlcXVlc3Qub2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcXVlc3Qub2JqZWN0KTtcbiAgfVxuICBpZiAocmVxdWVzdC5vcmlnaW5hbCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04ocmVxdWVzdC5vcmlnaW5hbCk7XG4gIH1cbiAgcmVxdWVzdC51c2VyID0gYXdhaXQgdXNlckZvclNlc3Npb25Ub2tlbihyZXF1ZXN0LnNlc3Npb25Ub2tlbik7XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gKTtcbiAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVzZXJGb3JTZXNzaW9uVG9rZW4oc2Vzc2lvblRva2VuKSB7XG4gIGlmICghc2Vzc2lvblRva2VuKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHEgPSBuZXcgUGFyc2UuUXVlcnkoJ19TZXNzaW9uJyk7XG4gIHEuZXF1YWxUbygnc2Vzc2lvblRva2VuJywgc2Vzc2lvblRva2VuKTtcbiAgcS5pbmNsdWRlKCd1c2VyJyk7XG4gIGNvbnN0IHNlc3Npb24gPSBhd2FpdCBxLmZpcnN0KHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pO1xuICBpZiAoIXNlc3Npb24pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHNlc3Npb24uZ2V0KCd1c2VyJyk7XG59XG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZSh0eXBlLCBjbGFzc05hbWUsIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKSkge1xuICBjb25zdCBwYXJlbnQgPSBBV1NYUmF5LmdldFNlZ21lbnQoKTtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIEFXU1hSYXkuY2FwdHVyZUFzeW5jRnVuYyhcbiAgICAgIGBQYXJzZS1TZXJ2ZXJfdHJpZ2dlcnNfJHt0eXBlfV8ke2NsYXNzTmFtZX1gLFxuICAgICAgc3Vic2VnbWVudCA9PiB7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDb250cm9sbGVyJywgJ3RyaWdnZXJzJyk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdUeXBlJywgdHlwZSk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgICAocHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UgPyBwcm9taXNlIDogUHJvbWlzZS5yZXNvbHZlKHByb21pc2UpKS50aGVuKFxuICAgICAgICAgIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuIl19